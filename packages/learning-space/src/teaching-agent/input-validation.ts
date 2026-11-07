import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { actionInputSchema } from '@xunjie/contracts/action-intents';
import { teachingInputControlSchema, teachingControlReceiptSchema, teachingContinueSelectionSchema,
  teachingStopInputSchema } from '@xunjie/contracts/teaching-agent';
import { canonicalDigest, operationId } from './identity.js';
import { teachingInputDigest, teachingInputFromRow } from './inputs.js';

/** Maintenance verifies new facts against their immutable sources without invoking models or tools. */
export async function validateTeachingInputs(storage: OwnedStorage) {
  const { rows: inputs } = await storage.read(`SELECT i.*,v.body FROM teaching_inputs i
    LEFT JOIN teaching_input_revisions v ON v.input_id=i.input_id AND v.version=i.version`);
  const { rows: requests } = await storage.read('SELECT * FROM teaching_requests');
  const { rows: runs } = await storage.read('SELECT * FROM teaching_runs');
  const { rows: steps } = await storage.read('SELECT * FROM teaching_steps');
  const { rows: events } = await storage.read('SELECT * FROM teaching_events');
  for (const row of inputs) {
    const input = teachingInputFromRow(row), original = requests.find(request => request.request_id === input.requestId);
    const received = runs.find(run => run.run_id === input.receivedRunId), waiting = runs.find(run => run.run_id === row.waiting_on_run_id);
    const reception = events.find(event => event.activity_id === row.activity_id && Number(event.seq) === input.sequence);
    if (!original || original.activity_id !== row.activity_id || original.input_id !== input.inputId
      || !received || !waiting || received.activity_id !== row.activity_id || waiting.activity_id !== row.activity_id
      || input.inputId !== operationId('teaching-input:' + input.requestId)
      || !reception || !['input', 'input-promoted'].includes(String(reception.kind))
      || (reception.body as { inputId?: string }).inputId !== input.inputId) throw new StorageError('corrupt');
    const { rows: revisions } = await storage.read('SELECT * FROM teaching_input_revisions WHERE input_id=$1 ORDER BY version', [input.inputId]);
    if (revisions.length !== input.version || canonicalDigest(revisions[0]?.body) !== canonicalDigest(original.body)) throw new StorageError('corrupt');
    for (const [index, revision] of revisions.entries()) {
      const body = actionInputSchema.parse(revision.body);
      if (revision.version !== index + 1 || teachingInputDigest(body) !== revision.input_digest
        || body.requestId !== input.requestId || body.scope.activityId !== row.activity_id
        || (body.delivery?.mode ?? 'steering') !== input.mode) throw new StorageError('corrupt');
      const originalBody = actionInputSchema.parse(original.body);
      if (canonicalDigest({ ...body, draft: { ...body.draft, question: originalBody.draft.question } }) !== canonicalDigest(originalBody))
        throw new StorageError('corrupt');
    }
    if (input.state === 'adopted') {
      const adopted = runs.find(run => run.run_id === input.adoptedRunId);
      if (!adopted || adopted.activity_id !== row.activity_id) throw new StorageError('corrupt');
      if (input.adoptedStepId) {
        const step = steps.find(step => step.step_id === input.adoptedStepId);
        const plan = step?.plan as { inputVersions?: { inputId: string; version: number; inputDigest: string }[] } | undefined;
        if (!step || step.run_id !== input.adoptedRunId || !plan?.inputVersions?.some(fixed => fixed.inputId === input.inputId
          && fixed.version === input.version && fixed.inputDigest === revisions.at(-1)!.input_digest)) throw new StorageError('corrupt');
      } else if (events.some(event => event.kind === 'input-adopted' && (event.body as { inputId?: string }).inputId === input.inputId))
        throw new StorageError('corrupt');
    } else if (input.adoptedRunId || input.adoptedStepId) throw new StorageError('corrupt');
  }
  const { rows: controls } = await storage.read('SELECT * FROM teaching_controls');
  for (const row of controls) {
    const receipt = teachingControlReceiptSchema.parse(row.receipt);
    let fingerprint: string;
    if ('inputId' in receipt) {
      const input = teachingInputControlSchema.parse(row.body);
      fingerprint = canonicalDigest({ activityId: row.activity_id, inputId: row.target_id, input });
      if (receipt.inputId !== row.target_id || input.requestId !== row.request_id) throw new StorageError('corrupt');
    } else if (receipt.operation === 'stop') {
      const input = teachingStopInputSchema.parse({ requestId: (row.body as { requestId: string }).requestId });
      fingerprint = canonicalDigest({ activityId: row.activity_id, runId: row.target_id, operation: 'stop', input });
      if (receipt.runId !== row.target_id) throw new StorageError('corrupt');
    } else {
      const { operation: _operation, ...body } = row.body as Record<string, unknown>;
      const input = teachingContinueSelectionSchema.parse(body);
      fingerprint = canonicalDigest({ activityId: row.activity_id, runId: row.target_id, input });
      if (receipt.runId !== row.target_id) throw new StorageError('corrupt');
      if (receipt.continuedRunId) {
        const run = runs.find(run => run.run_id === receipt.continuedRunId);
        if (!run || run.activity_id !== row.activity_id || (run.run_id !== row.target_id && run.previous_run_id !== row.target_id))
          throw new StorageError('corrupt');
      }
    }
    if (receipt.requestId !== row.request_id || fingerprint !== row.input_digest) throw new StorageError('corrupt');
  }
  const { rows: selections } = await storage.read('SELECT * FROM teaching_run_input_selections');
  for (const selection of selections) {
    const input = inputs.find(input => input.input_id === selection.input_id), run = runs.find(run => run.run_id === selection.run_id);
    if (!input || !run || input.activity_id !== run.activity_id || Number(selection.selected_version) < 1
      || Number(selection.selected_version) > Number(input.version)) throw new StorageError('corrupt');
  }
}
