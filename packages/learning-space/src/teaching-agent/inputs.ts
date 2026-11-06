import { createHash } from 'node:crypto';
import { StorageError, type Migration, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import { actionInputSchema, type ActionInput } from '@xunjie/contracts/action-intents';
import { teachingInputSchema, type TeachingEventKind, type TeachingRun } from '@xunjie/contracts/teaching-agent';
import { operationId } from './identity.js';

export const teachingInputMigration: Migration = { version: 8, name: 'ordered-durable-agent-inputs', sql: `
  ALTER TABLE teaching_waits ADD COLUMN observed_step_id uuid REFERENCES teaching_steps(step_id);
  -- Before steering could wake a Wait, a later model step necessarily included the settled result.
  UPDATE teaching_waits w SET observed_step_id=(SELECT next.step_id FROM teaching_steps original
    JOIN teaching_steps next ON next.run_id=original.run_id AND next.step_no>original.step_no
    WHERE original.step_id=w.step_id ORDER BY next.step_no LIMIT 1) WHERE w.purpose='result' AND w.state='consumed';
  ALTER TABLE teaching_student_questions DROP CONSTRAINT teaching_student_questions_state_check;
  ALTER TABLE teaching_student_questions ADD CHECK(state IN ('pending','answered','skipped','expired','cancelled','superseded'));
  CREATE TABLE teaching_inputs(input_id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,activity_id uuid NOT NULL,
    seq bigint NOT NULL,version integer NOT NULL CHECK(version>0),mode text NOT NULL CHECK(mode IN ('steering','queue')),
    state text NOT NULL CHECK(state IN ('pending','adopted','removed','paused','superseded')),
    received_run_id uuid NOT NULL REFERENCES teaching_runs(run_id),waiting_on_run_id uuid NOT NULL REFERENCES teaching_runs(run_id),
    adopted_run_id uuid REFERENCES teaching_runs(run_id),adopted_step_id uuid REFERENCES teaching_steps(step_id),
    reason text NOT NULL DEFAULT '',basis jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(activity_id,seq));
  CREATE TABLE teaching_input_revisions(input_id uuid NOT NULL REFERENCES teaching_inputs(input_id),version integer NOT NULL,
    body jsonb NOT NULL,input_digest text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(input_id,version));
  CREATE TABLE teaching_controls(request_id uuid PRIMARY KEY,activity_id uuid NOT NULL,target_id uuid NOT NULL,
    input_digest text NOT NULL,body jsonb NOT NULL,receipt jsonb NOT NULL);
  CREATE TABLE teaching_run_input_selections(run_id uuid NOT NULL REFERENCES teaching_runs(run_id),
    input_id uuid NOT NULL REFERENCES teaching_inputs(input_id),selected_version integer NOT NULL,
    PRIMARY KEY(run_id,input_id));
  INSERT INTO teaching_inputs(input_id,request_id,activity_id,seq,version,mode,state,received_run_id,waiting_on_run_id,
    adopted_run_id,basis,created_at)
    SELECT r.input_id,r.request_id,r.activity_id,e.seq,1,'steering',
      CASE WHEN EXISTS(SELECT 1 FROM teaching_steps s WHERE s.run_id=r.run_id) THEN 'adopted' ELSE 'pending' END,
      r.run_id,r.run_id,CASE WHEN EXISTS(SELECT 1 FROM teaching_steps s WHERE s.run_id=r.run_id) THEN r.run_id END,
      '{"source":"legacy-default"}'::jsonb,r.created_at
    FROM teaching_requests r JOIN teaching_events e ON e.activity_id=r.activity_id AND e.kind='input'
      AND e.body->>'inputId'=r.input_id::text WHERE r.state='accepted' AND r.body IS NOT NULL;
  INSERT INTO teaching_input_revisions(input_id,version,body,input_digest)
    SELECT i.input_id,1,r.body,r.input_digest FROM teaching_inputs i JOIN teaching_requests r USING(request_id);
` };
export const teachingInputDigest = (input: ActionInput) => createHash('sha256').update(JSON.stringify(input)).digest('hex');
export function teachingInputFromRow(row: Record<string, unknown>) {
  return teachingInputSchema.parse({ inputId: row.input_id, requestId: row.request_id,
    sequence: Number(row.seq), version: row.version, mode: row.mode, state: row.state, receivedRunId: row.received_run_id,
    adoptedRunId: row.adopted_run_id ?? null, adoptedStepId: row.adopted_step_id ?? null,
    reason: row.reason, input: row.body, basis: row.basis, createdAt: new Date(row.created_at as string).toISOString() });
}
export interface FixedTeachingInput {
  inputId: string; version: number; sequence: number; input: ActionInput; inputDigest: string;
}

export function createTeachingInputs(storage: OwnedStorage, owner: {
  appendEvent(tx: OwnedTransaction, activityId: string, kind: TeachingEventKind, body: Record<string, unknown>): Promise<unknown>;
  supersedeQuestion(tx: OwnedTransaction, activityId: string, runId: string, inputId: string): Promise<void>;
}) {
  async function register(tx: OwnedTransaction, input: ActionInput, runId: string, sequence: number) {
    const inputId = operationId('teaching-input:' + input.requestId);
    await tx.query(`INSERT INTO teaching_inputs(input_id,request_id,activity_id,seq,version,mode,state,
      received_run_id,waiting_on_run_id,basis) VALUES($1,$2,$3,$4,1,$5,'pending',$6,$6,$7)`,
      [inputId, input.requestId, input.scope.activityId, sequence, input.delivery?.mode ?? 'steering', runId,
        JSON.stringify(input.delivery?.basis ?? { source: 'legacy-default' })]);
    await tx.query('INSERT INTO teaching_input_revisions(input_id,version,body,input_digest) VALUES($1,1,$2,$3)',
      [inputId, JSON.stringify(input), teachingInputDigest(input)]);
    if (input.delivery?.mode !== 'queue') await owner.supersedeQuestion(tx, input.scope.activityId, runId, inputId);
  }
  async function list(activityId: string) {
    const { rows } = await storage.read(`SELECT i.*,v.body FROM teaching_inputs i JOIN teaching_input_revisions v
      ON v.input_id=i.input_id AND v.version=i.version WHERE i.activity_id=$1 ORDER BY i.seq`, [activityId]);
    return rows.map(teachingInputFromRow);
  }
  async function pending(run: TeachingRun, tx?: OwnedTransaction): Promise<FixedTeachingInput[]> {
    const read = tx ? tx.query.bind(tx) : storage.read.bind(storage);
    const { rows } = await read(`SELECT i.*,v.body,v.input_digest FROM teaching_inputs i JOIN teaching_input_revisions v
      ON v.input_id=i.input_id AND v.version=i.version WHERE i.state='pending' AND
      (i.input_id=$2 OR (i.waiting_on_run_id=$1 AND i.mode='steering') OR EXISTS
        (SELECT 1 FROM teaching_run_input_selections s WHERE s.run_id=$1 AND s.input_id=i.input_id)) ORDER BY i.seq`, [run.runId, run.inputId]);
    return rows.map(row => ({ inputId: String(row.input_id), version: Number(row.version), sequence: Number(row.seq),
      input: actionInputSchema.parse(row.body), inputDigest: String(row.input_digest) }));
  }
  async function matches(tx: OwnedTransaction, run: TeachingRun, fixed: FixedTeachingInput[]) {
    const current = await pending(run, tx);
    return JSON.stringify(current.map(item => [item.inputId, item.version, item.inputDigest]))
      === JSON.stringify(fixed.map(item => [item.inputId, item.version, item.inputDigest]));
  }
  async function adopt(tx: OwnedTransaction, run: TeachingRun, stepId: string, fixed: FixedTeachingInput[]) {
    for (const item of fixed) {
      const { rows } = await tx.query(`UPDATE teaching_inputs SET state='adopted',adopted_run_id=$2,adopted_step_id=$3
        WHERE input_id=$1 AND state='pending' AND version=$4 RETURNING input_id`, [item.inputId, run.runId, stepId, item.version]);
      if (!rows.length) throw new StorageError('conflict');
      await owner.appendEvent(tx, run.activityId, 'input-adopted', {
        runId: run.runId, stepId, inputId: item.inputId, version: item.version,
        question: item.input.draft.question, inputDigest: item.inputDigest,
      });
    }
  }
  async function hasSteering(tx: OwnedTransaction, run: TeachingRun) {
    const { rows } = await tx.query(`SELECT input_id FROM teaching_inputs
      WHERE waiting_on_run_id=$1 AND mode='steering' AND state='pending' LIMIT 1`, [run.runId]);
    return rows.length > 0;
  }
  async function newerDirection(tx: OwnedTransaction, run: TeachingRun, sequence?: number) {
    const { rows: [row] } = await tx.query(`SELECT input_id,seq FROM teaching_inputs WHERE waiting_on_run_id=$1
      AND mode='steering' AND state IN ('pending','adopted') AND seq>COALESCE($2,
        (SELECT seq FROM teaching_inputs WHERE input_id=$3),0) ORDER BY seq LIMIT 1`, [run.runId, sequence ?? null, run.inputId]);
    return row ? { inputId: String(row.input_id), sequence: Number(row.seq) } : null;
  }
  async function afterFinish(tx: OwnedTransaction, run: TeachingRun, state: TeachingRun['state'], reason: string) {
    if (state !== 'completed') {
      const { rows } = await tx.query(`UPDATE teaching_inputs SET state='paused',reason=$2
        WHERE waiting_on_run_id=$1 AND state='pending' RETURNING input_id`, [run.runId, reason || state]);
      if (rows.length) await owner.appendEvent(tx, run.activityId, 'inputs-paused', {
        runId: run.runId, reason: reason || state, inputIds: rows.map(row => row.input_id),
      });
      return null;
    }
    const { rows: [next] } = await tx.query(`SELECT i.*,v.body FROM teaching_inputs i JOIN teaching_input_revisions v
      ON v.input_id=i.input_id AND v.version=i.version WHERE i.waiting_on_run_id=$1 AND i.mode='queue'
      AND i.state='pending' ORDER BY i.seq LIMIT 1`, [run.runId]);
    if (!next) return null;
    const nextRunId = operationId('teaching-queued-run:' + next.input_id), input = actionInputSchema.parse(next.body);
    const { rows: [previous] } = await tx.query('SELECT identity FROM teaching_runs WHERE run_id=$1', [run.runId]);
    if (!previous) throw new StorageError('corrupt');
    await tx.query(`INSERT INTO teaching_runs(run_id,activity_id,request_id,input_id,identity,state,previous_run_id,usage)
      VALUES($1,$2,$3,$4,$5,'received',$6,$7)`, [nextRunId, run.activityId, input.requestId, next.input_id,
      JSON.stringify(previous.identity), run.runId, JSON.stringify({ state: 'unknown' })]);
    await tx.query(`UPDATE teaching_inputs SET waiting_on_run_id=$2 WHERE waiting_on_run_id=$1 AND state='pending'`, [run.runId, nextRunId]);
    await owner.appendEvent(tx, run.activityId, 'run-received', {
      runId: nextRunId, previousRunId: run.runId, requestId: input.requestId, inputId: next.input_id, source: 'explicit-queue',
    });
    return nextRunId;
  }
  return { register, list, pending, matches, adopt, hasSteering, newerDirection, afterFinish };
}
