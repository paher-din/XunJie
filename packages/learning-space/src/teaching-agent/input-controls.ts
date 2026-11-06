import { StorageError, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import { actionInputSchema, actionReceiptSchema } from '@xunjie/contracts/action-intents';
import { teachingInputControlSchema, teachingInputControlReceiptSchema, type TeachingEventKind,
  teachingControlReceiptSchema, type TeachingInputControlReceipt } from '@xunjie/contracts/teaching-agent';
import { canonicalDigest, operationId } from './identity.js';
import { teachingInputDigest, teachingInputFromRow, type createTeachingInputs } from './inputs.js';

export function createTeachingInputControls(storage: OwnedStorage, owner: {
  inputs: ReturnType<typeof createTeachingInputs>;
  appendEvent(tx: OwnedTransaction, activityId: string, kind: TeachingEventKind, body: Record<string, unknown>): Promise<{ seq: number }>;
}) {
  async function read(tx: OwnedTransaction, activityId: string, inputId: string) {
    const { rows: [row] } = await tx.query(`SELECT i.*,v.body FROM teaching_inputs i JOIN teaching_input_revisions v
      ON v.input_id=i.input_id AND v.version=i.version WHERE i.activity_id=$1 AND i.input_id=$2`, [activityId, inputId]);
    return row;
  }
  async function control(activityId: string, inputId: string, value: unknown) {
    const input = teachingInputControlSchema.parse(value), fingerprint = canonicalDigest({ activityId, inputId, input });
    const committed = await storage.request({ requestId: 'teaching-input-control:' + input.requestId, fingerprint }, async tx => {
      const row = await read(tx, activityId, inputId);
      const reason = !row ? 'input-missing' : row.version !== input.expectedVersion ? 'version-mismatch'
        : row.state === 'adopted' ? 'input-consumed' : !['pending', 'paused'].includes(String(row.state)) ? 'input-closed' : '';
      let replacementInputId: string | null = null;
      if (!reason && row) {
        const fixed = actionInputSchema.parse(row.body);
        if (input.operation === 'revise') {
          const revised = actionInputSchema.parse({ ...fixed, draft: { ...fixed.draft, question: input.text } });
          await tx.query('INSERT INTO teaching_input_revisions(input_id,version,body,input_digest) VALUES($1,$2,$3,$4)',
            [inputId, input.expectedVersion + 1, JSON.stringify(revised), teachingInputDigest(revised)]);
          await tx.query('UPDATE teaching_inputs SET version=version+1 WHERE input_id=$1', [inputId]);
          await owner.appendEvent(tx, activityId, 'input-revised', { inputId, version: input.expectedVersion + 1,
            previousVersion: input.expectedVersion, requestId: input.requestId, question: revised.draft.question });
        } else if (input.operation === 'remove') {
          await tx.query("UPDATE teaching_inputs SET state='removed',reason='student-removed' WHERE input_id=$1", [inputId]);
          await owner.appendEvent(tx, activityId, 'input-removed', { inputId, version: input.expectedVersion, requestId: input.requestId });
        } else {
          const requestId = operationId('teaching-promoted-request:' + input.requestId);
          const promoted = actionInputSchema.parse({ ...fixed, requestId, delivery: { version: 1, mode: 'steering',
            basis: { source: 'explicit', preferenceVersion: fixed.delivery?.basis.preferenceVersion ?? 0 } } });
          const { rows: [latest] } = await tx.query('SELECT * FROM teaching_runs WHERE activity_id=$1 ORDER BY created_at DESC LIMIT 1', [activityId]);
          if (!latest) throw new StorageError('corrupt');
          const active = ['received', 'running', 'dispatching', 'waiting'].includes(String(latest.state));
          const runId = active ? String(latest.run_id) : operationId('teaching-run:' + requestId);
          replacementInputId = operationId('teaching-input:' + requestId);
          const receipt = actionReceiptSchema.parse({ requestId, receiver: fixed.receiver, inputDigest: teachingInputDigest(promoted),
            state: 'accepted', receiptId: runId, detail: JSON.stringify({ version: 1, runId, inputId: replacementInputId }) });
          await tx.query(`INSERT INTO teaching_requests(request_id,activity_id,input_digest,body,state,run_id,input_id,receipt)
            VALUES($1,$2,$3,$4,'accepted',$5,$6,$7)`, [requestId, activityId, receipt.inputDigest, JSON.stringify(promoted), runId,
            replacementInputId, JSON.stringify(receipt)]);
          if (!active) await tx.query(`INSERT INTO teaching_runs(run_id,activity_id,request_id,input_id,identity,state,previous_run_id,usage)
            VALUES($1,$2,$3,$4,$5,'received',$6,$7)`, [runId, activityId, requestId, replacementInputId, JSON.stringify(latest.identity),
            latest.run_id, JSON.stringify({ state: 'unknown' })]);
          await tx.query("UPDATE teaching_inputs SET state='superseded',reason='promoted-to-new-input' WHERE input_id=$1", [inputId]);
          const event = await owner.appendEvent(tx, activityId, 'input-promoted', { inputId: replacementInputId, runId,
            fromInputId: inputId, fromVersion: input.expectedVersion, requestId: input.requestId, question: fixed.draft.question });
          await owner.inputs.register(tx, promoted, runId, event.seq);
          await tx.query('UPDATE teaching_inputs SET basis=$2 WHERE input_id=$1', [replacementInputId,
            JSON.stringify({ source: 'promoted', fromInputId: inputId, fromVersion: input.expectedVersion, originalBasis: row.basis })]);
          if (!active) await owner.appendEvent(tx, activityId, 'run-received', { runId, previousRunId: latest.run_id,
            requestId, inputId: replacementInputId, source: 'student-promoted' });
        }
      }
      const current = await read(tx, activityId, inputId);
      const receipt: TeachingInputControlReceipt = { version: 1, requestId: input.requestId, inputId,
        status: reason ? 'rejected' : 'accepted', reason: reason || input.operation,
        input: current ? teachingInputFromRow(current) : null, replacementInputId };
      await tx.query('INSERT INTO teaching_controls VALUES($1,$2,$3,$4,$5,$6)',
        [input.requestId, activityId, inputId, fingerprint, JSON.stringify(input), JSON.stringify(receipt)]);
      return receipt;
    });
    return teachingInputControlReceiptSchema.parse(committed.result);
  }
  async function receipt(activityId: string, requestId: string) {
    const { rows: [row] } = await storage.read('SELECT receipt FROM teaching_controls WHERE activity_id=$1 AND request_id=$2', [activityId, requestId]);
    return row ? teachingControlReceiptSchema.parse(row.receipt) : null;
  }
  return { control, receipt };
}
