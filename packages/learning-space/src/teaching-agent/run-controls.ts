import { StorageError, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import { teachingContinueSelectionSchema, teachingRunControlReceiptSchema,
  teachingStopInputSchema, isRecoverableTeachingPause, type TeachingRunControlReceipt, type TeachingEventKind } from '@xunjie/contracts/teaching-agent';
import type { LearningModelPort } from '../model-connections/service.js';
import { canonicalDigest, operationId } from './identity.js';

/** Explicit controls use the same durable order and original-identity ledger as input revision. */
export function createTeachingRunControls(storage: OwnedStorage, owner: {
  models: LearningModelPort;
  appendEvent(tx: OwnedTransaction, activityId: string, kind: TeachingEventKind, body: Record<string, unknown>): Promise<unknown>;
  freezeBudget(tx: OwnedTransaction, runId: string): Promise<void>;
}) {
  async function stop(activityId: string, runId: string, value: unknown) {
    const input = teachingStopInputSchema.parse(value), fingerprint = canonicalDigest({ activityId, runId, operation: 'stop', input });
    const result = await storage.request({ requestId: 'teaching-run-control:' + input.requestId, fingerprint }, async tx => {
      const { rows: [run] } = await tx.query('SELECT state,stop_requested FROM teaching_runs WHERE activity_id=$1 AND run_id=$2 FOR UPDATE', [activityId, runId]);
      if (!run) throw new StorageError('missing');
      const terminal = ['completed', 'failed', 'stopped', 'paused'].includes(String(run.state));
      const reason = terminal ? 'already-terminated' : run.stop_requested ? 'already-requested' : 'stop-requested';
      if (!terminal && !run.stop_requested) {
        await tx.query('UPDATE teaching_runs SET stop_requested=true,updated_at=clock_timestamp() WHERE run_id=$1', [runId]);
        await owner.appendEvent(tx, activityId, 'stop-requested', { runId, requestId: input.requestId, source: 'student' });
      }
      const receipt: TeachingRunControlReceipt = { version: 1, requestId: input.requestId, operation: 'stop',
        status: 'accepted', reason, runId, continuedRunId: null };
      await tx.query('INSERT INTO teaching_controls VALUES($1,$2,$3,$4,$5,$6)',
        [input.requestId, activityId, runId, fingerprint, JSON.stringify({ ...input, operation: 'stop' }), JSON.stringify(receipt)]);
      return receipt;
    });
    return teachingRunControlReceiptSchema.parse(result.result);
  }
  async function continueSelected(identity: SpaceIdentity, activityId: string, runId: string, value: unknown) {
    const input = teachingContinueSelectionSchema.parse(value), fingerprint = canonicalDigest({ activityId, runId, input });
    const requestId = 'teaching-run-control:' + input.requestId;
    const prior = await storage.receipt(requestId, fingerprint);
    if (prior) return teachingRunControlReceiptSchema.parse(prior.result);
    const { rows: [before] } = await storage.read('SELECT * FROM teaching_runs WHERE activity_id=$1 AND run_id=$2', [activityId, runId]);
    if (!before) throw new StorageError('missing');
    const native = before.attempt_id ? await owner.models.checks.read(identity, String(before.attempt_id)) : null;
    const committed = await storage.request({ requestId, fingerprint }, async tx => {
      const { rows: [previous] } = await tx.query('SELECT * FROM teaching_runs WHERE activity_id=$1 AND run_id=$2 FOR UPDATE', [activityId, runId]);
      if (!previous) throw new StorageError('missing');
      const { rows: active } = await tx.query(`SELECT run_id FROM teaching_runs WHERE activity_id=$1
        AND state IN ('received','running','dispatching','waiting') LIMIT 1`, [activityId]);
      const { rows: switches } = await tx.query(`SELECT request_id FROM teaching_model_switches WHERE activity_id=$1 AND state IN ('accepted','paused') LIMIT 1`, [activityId]);
      const { rows: unknown } = await tx.query(`SELECT command_id FROM teaching_commands WHERE run_id=$1
        AND (state='dispatching' OR outcome->>'state'='unknown') LIMIT 1`, [runId]);
      const { rows: selected } = await tx.query(`SELECT i.* FROM teaching_inputs i WHERE activity_id=$1
        AND input_id=ANY($2::uuid[]) ORDER BY seq`, [activityId, input.inputs.map(item => item.inputId)]);
      const resuming = !previous.stop_requested && isRecoverableTeachingPause({ state: String(previous.state),
        reason: String(previous.reason), completedAt: previous.completed_at ? new Date(previous.completed_at as string).toISOString() : null });
      let reason = active.length ? 'run-active' : switches.length ? 'model-switch-pending' : !resuming && (native && !native.physicalRequestEnded || unknown.length) ? 'original-effects-unconfirmed'
        : !resuming && !input.inputs.length ? 'select-inputs' : selected.length !== input.inputs.length ? 'input-missing' : '';
      if (!reason) for (const selectedInput of selected) {
        const expected = input.inputs.find(item => item.inputId === selectedInput.input_id)!;
        if (selectedInput.version !== expected.expectedVersion) { reason = 'version-mismatch'; break; }
        if (!['pending', 'paused'].includes(String(selectedInput.state))) { reason = 'input-consumed'; break; }
      }
      const nextRunId = reason ? null : resuming ? runId : operationId('teaching-run:' + input.requestId);
      if (nextRunId && resuming) {
        await tx.query(`UPDATE teaching_runs SET state='received',reason='',completed_at=NULL,lease_owner=NULL,
          lease_expires_at=NULL,updated_at=clock_timestamp() WHERE run_id=$1`, [runId]);
        if (input.inputs.length) {
          for (const item of selected) {
            await tx.query("UPDATE teaching_inputs SET state='pending',reason='' WHERE input_id=$1", [item.input_id]);
            await tx.query('INSERT INTO teaching_run_input_selections VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [runId, item.input_id, item.version]);
          }
          await tx.query("UPDATE teaching_inputs SET state='pending',reason='' WHERE input_id=$1 AND state='paused'", [previous.input_id]);
        } else await tx.query("UPDATE teaching_inputs SET state='pending',reason='' WHERE waiting_on_run_id=$1 AND state='paused'", [runId]);
        await owner.appendEvent(tx, activityId, 'run-resumed', { runId, requestId: input.requestId, inputs: input.inputs,
          source: 'student-explicit', originalBudgetPreserved: true });
      } else if (nextRunId) {
        const root = selected[0]!;
        await tx.query(`INSERT INTO teaching_runs(run_id,activity_id,request_id,input_id,identity,state,previous_run_id,usage)
          VALUES($1,$2,$3,$4,$5,'received',$6,$7)`, [nextRunId, activityId, root.request_id, root.input_id,
          JSON.stringify(identity), runId, JSON.stringify({ state: 'unknown' })]);
        await owner.freezeBudget(tx, nextRunId);
        for (const item of selected) {
          await tx.query("UPDATE teaching_inputs SET state='pending',reason='',waiting_on_run_id=$2 WHERE input_id=$1", [item.input_id, nextRunId]);
          await tx.query('INSERT INTO teaching_run_input_selections VALUES($1,$2,$3)', [nextRunId, item.input_id, item.version]);
        }
        await owner.appendEvent(tx, activityId, 'run-continued', { runId: nextRunId, previousRunId: runId,
          requestId: input.requestId, source: 'explicit-selection', inputs: input.inputs });
        await owner.appendEvent(tx, activityId, 'run-received', { runId: nextRunId, previousRunId: runId,
          requestId: root.request_id, inputId: root.input_id, source: 'explicit-selection' });
      }
      const receipt: TeachingRunControlReceipt = { version: 1, requestId: input.requestId, operation: 'continue',
        status: reason ? 'rejected' : 'accepted', reason: reason || (resuming ? 'resumed-original' : 'linked-successor'), runId, continuedRunId: nextRunId };
      await tx.query('INSERT INTO teaching_controls VALUES($1,$2,$3,$4,$5,$6)',
        [input.requestId, activityId, runId, fingerprint, JSON.stringify({ ...input, operation: 'continue' }), JSON.stringify(receipt)]);
      return receipt;
    });
    return teachingRunControlReceiptSchema.parse(committed.result);
  }
  return { continueSelected, stop };
}
