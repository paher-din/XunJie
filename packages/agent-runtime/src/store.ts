import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import {
  agentEventSchema, agentInputReceiptSchema, agentInputSchema, agentRunSchema, agentRuntimeSessionSchema,
  agentDispatchPermitSchema, agentOperationSchema, agentWaitSchema, agentWaitResponseSchema,
  type AgentDispatchPermit, type AgentEvent, type AgentInput, type AgentInputReceipt, type AgentRun, type AgentRuntimeSession,
  type AgentWait, type AgentWaitResponse,
} from '@xunjie/contracts/agent-runtime';
import type { AgentAcceptedRequest, AgentDecision, AgentExecutionSnapshot, AgentInputControl, AgentInputControlReceipt, AgentModelProgress, AgentOperationResult, AgentPipeline, AgentRunBudget, AgentRunBudgetOptions, AgentSessionInput, AgentSessionSnapshot, AgentSettlement, AgentStep, Facts } from './ports.js';

export const agentRuntimeMigrations: readonly Migration[] = [{ version: 1, name: 'independent-agent-sessions', sql: `
  CREATE TABLE agent_runtime_sessions(session_id uuid PRIMARY KEY,body jsonb NOT NULL,next_seq bigint NOT NULL DEFAULT 1);
  CREATE TABLE agent_runs(run_id uuid PRIMARY KEY,session_id uuid NOT NULL REFERENCES agent_runtime_sessions(session_id),
    request_id uuid NOT NULL,input_id uuid NOT NULL,state text NOT NULL,reason text NOT NULL DEFAULT '',
    generation integer NOT NULL DEFAULT 0,revision bigint NOT NULL DEFAULT 0,stop_requested boolean NOT NULL DEFAULT false,
    needs_continue boolean NOT NULL DEFAULT false,previous_run_id uuid REFERENCES agent_runs(run_id),
    context jsonb NOT NULL DEFAULT '{}',created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz);
  CREATE INDEX agent_runs_session ON agent_runs(session_id,created_at,run_id);
  CREATE TABLE agent_inputs(input_id uuid PRIMARY KEY,request_id uuid NOT NULL UNIQUE,
    session_id uuid NOT NULL REFERENCES agent_runtime_sessions(session_id),run_id uuid NOT NULL REFERENCES agent_runs(run_id),
    seq bigint NOT NULL,version integer NOT NULL DEFAULT 1,mode text NOT NULL,
    state text NOT NULL DEFAULT 'pending',body jsonb NOT NULL,input_digest text NOT NULL,
    adopted_step_id uuid,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(session_id,seq));
  CREATE TABLE agent_events(session_id uuid NOT NULL REFERENCES agent_runtime_sessions(session_id),seq bigint NOT NULL,
    event_id uuid NOT NULL UNIQUE,kind text NOT NULL,body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(session_id,seq));
  CREATE TABLE agent_controls(request_id uuid PRIMARY KEY,session_id uuid NOT NULL,
    run_id uuid NOT NULL,operation text NOT NULL,input_digest text NOT NULL,body jsonb NOT NULL);
` }, { version: 2, name: 'fixed-agent-operations-and-waits', sql: `
  CREATE TABLE agent_steps(step_id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES agent_runs(run_id),
    step_no integer NOT NULL,operation_id uuid NOT NULL UNIQUE,operation jsonb NOT NULL,snapshot jsonb NOT NULL,
    state text NOT NULL CHECK(state IN ('prepared','dispatching','waiting','unknown','completed')),
    result jsonb,dispatch_generation integer,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(run_id,step_no));
  CREATE TABLE agent_waits(wait_id uuid PRIMARY KEY,run_id uuid NOT NULL REFERENCES agent_runs(run_id),
    operation_id uuid NOT NULL REFERENCES agent_steps(operation_id),version integer NOT NULL,
    kind text NOT NULL,state text NOT NULL,presentation jsonb NOT NULL,response jsonb,deadline timestamptz,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX agent_waits_run ON agent_waits(run_id,state);
` }, { version: 3, name: 'agent-session-state', sql: `
  ALTER TABLE agent_runtime_sessions ADD COLUMN state jsonb NOT NULL DEFAULT '{}';
` }, { version: 4, name: 'original-agent-inputs', sql: `
  ALTER TABLE agent_inputs ADD COLUMN original_body jsonb;
  UPDATE agent_inputs SET original_body=body;
  ALTER TABLE agent_inputs ALTER COLUMN original_body SET NOT NULL;
` }, { version: 5, name: 'agent-model-progress', sql: `
  CREATE TABLE agent_progress(operation_id uuid NOT NULL REFERENCES agent_steps(operation_id),revision bigint NOT NULL CHECK(revision>0),
    generation integer NOT NULL,body jsonb NOT NULL,event_id uuid NOT NULL UNIQUE REFERENCES agent_events(event_id),
    PRIMARY KEY(operation_id,revision));
` }, { version: 6, name: 'frozen-agent-run-budgets', sql: `
  ALTER TABLE agent_runs ADD COLUMN budget jsonb NOT NULL DEFAULT '{"maxSteps":128,"maxDispatches":128,"deadline":null}';
  ALTER TABLE agent_runs ADD COLUMN dispatch_count integer NOT NULL DEFAULT 0 CHECK(dispatch_count>=0);
  UPDATE agent_runs r SET dispatch_count=(SELECT count(*) FROM agent_steps s WHERE s.run_id=r.run_id AND s.dispatch_generation IS NOT NULL);
` }, { version: 7, name: 'explicit-operation-continuations', sql: `
  ALTER TABLE agent_steps ADD COLUMN continuation_open boolean NOT NULL DEFAULT false;
  ALTER TABLE agent_waits ADD COLUMN continuation_operation_id uuid REFERENCES agent_steps(operation_id);
` }, { version: 8, name: 'interruptible-agent-waits', sql: `
  ALTER TABLE agent_waits ADD COLUMN interruptible boolean NOT NULL DEFAULT false;
` }];

type Row = Record<string, unknown>;
export const cancellationControlSchema = z.object({ requestId: z.uuid(), sessionId: z.uuid(), runId: z.uuid(),
  operation: z.literal('cancel'), stepId: z.uuid(), stopRequestId: z.uuid(), state: z.enum(['pending', 'delivered']) }).strict();
type CancellationControl = z.infer<typeof cancellationControlSchema>;
export function cancellationDigest({ state: _state, ...identity }: CancellationControl): string { return canonicalDigest(identity); }
const iso = (value: unknown) => new Date(value as string).toISOString();
export function runFromRow(row: Row): AgentRun {
  return agentRunSchema.parse({ runId: row.run_id, sessionId: row.session_id, requestId: row.request_id,
    inputId: row.input_id, state: row.state, reason: row.reason, generation: Number(row.generation),
    stopRequested: row.stop_requested, needsContinue: row.needs_continue,
    previousRunId: row.previous_run_id ?? null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null });
}
function stepFromRow(row: Row): AgentStep {
  return { stepId: String(row.step_id), number: Number(row.step_no), operation: agentOperationSchema.parse(row.operation),
    snapshot: row.snapshot as Facts, state: row.state as AgentStep['state'], result: row.result as AgentOperationResult | null,
    continuationOpen: row.continuation_open === true };
}
function waitFromRow(row: Row): AgentWait {
  return agentWaitSchema.parse({ waitId: row.wait_id, runId: row.run_id, operationId: row.operation_id,
    version: Number(row.version), kind: row.kind, state: row.state, presentation: row.presentation,
    response: row.response, deadline: row.deadline ? iso(row.deadline) : null, interruptible: row.interruptible === true,
    ...(row.continuation_operation_id ? { continuationOperationId: row.continuation_operation_id } : {}) });
}
function inputFromRow(row: Row): AgentSessionInput {
  return { inputId: String(row.input_id), runId: String(row.run_id), version: Number(row.version),
    mode: row.mode as AgentInput['mode'], state: row.state as AgentSessionInput['state'],
    input: agentInputSchema.parse(row.body), createdAt: iso(row.created_at) };
}

/** One owner retains both the ordered facts and the generation that authorizes new effects. */
export function createRunStore(storage: OwnedStorage, options: { runBudget?: AgentRunBudgetOptions; now?: () => number } = {}) {
  const limits = z.object({ maxSteps: z.number().int().positive().max(2_147_483_647).default(128),
    maxDispatches: z.number().int().positive().max(2_147_483_647).default(128),
    timeoutMs: z.number().int().nonnegative().max(2_147_483_647).nullable().default(null) }).strict().parse(options.runBudget ?? {});
  const now = options.now ?? Date.now;
  async function insertRun(tx: OwnedTransaction, runId: string, sessionId: string, requestId: string, inputId: string, previousRunId: unknown) {
    const budget = { maxSteps: limits.maxSteps, maxDispatches: limits.maxDispatches,
      deadline: limits.timeoutMs === null ? null : new Date(now() + limits.timeoutMs).toISOString() };
    await tx.query(`INSERT INTO agent_runs(run_id,session_id,request_id,input_id,state,previous_run_id,budget)
      VALUES($1,$2,$3,$4,'received',$5,$6)`, [runId, sessionId, requestId, inputId, previousRunId, budget]);
  }
  async function session(sessionId: string, query: OwnedTransaction['query'] = storage.read.bind(storage)): Promise<AgentRuntimeSession> {
    const { rows: [row] } = await query('SELECT body FROM agent_runtime_sessions WHERE session_id=$1', [sessionId]);
    if (!row) throw new StorageError('missing');
    return agentRuntimeSessionSchema.parse(row.body);
  }
  async function initialize(value: AgentRuntimeSession) {
    const input = agentRuntimeSessionSchema.parse(value);
    const saved = await storage.request({ requestId: 'agent-session:' + input.sessionId, fingerprint: canonicalDigest(input) }, async tx => {
      await tx.query('INSERT INTO agent_runtime_sessions(session_id,body) VALUES($1,$2)', [input.sessionId, input]);
      return input;
    });
    return agentRuntimeSessionSchema.parse(saved.result);
  }
  async function run(sessionId: string, runId: string): Promise<AgentRun> {
    const { rows: [row] } = await storage.read('SELECT * FROM agent_runs WHERE session_id=$1 AND run_id=$2', [sessionId, runId]);
    if (!row) throw new StorageError('missing');
    return runFromRow(row);
  }
  async function appendEvent(tx: OwnedTransaction, sessionId: string, kind: string, body: Record<string, unknown>, eventId: string = randomUUID()) {
    const { rows: [row] } = await tx.query('UPDATE agent_runtime_sessions SET next_seq=next_seq+1 WHERE session_id=$1 RETURNING next_seq-1 AS seq', [sessionId]);
    if (!row) throw new StorageError('missing');
    const seq = Number(row.seq);
    await tx.query('INSERT INTO agent_events(session_id,seq,event_id,kind,body) VALUES($1,$2,$3,$4,$5)',
      [sessionId, seq, eventId, kind, JSON.stringify(body)]);
    return { seq, eventId };
  }
  async function interruptSteeringWaits(tx: OwnedTransaction, sessionId: string, runId: string, requestId: string, inputId: string) {
    const { rows: cancelled } = await tx.query(`UPDATE agent_waits SET state='cancelled',version=version+1
      WHERE run_id=$1 AND state='pending' AND interruptible RETURNING wait_id,operation_id,continuation_operation_id`, [runId]);
    if (!cancelled.length) return;
    await tx.query(`UPDATE agent_steps SET continuation_open=false WHERE run_id=$1 AND operation_id=ANY($2::uuid[])`,
      [runId, cancelled.flatMap(wait => [wait.operation_id, wait.continuation_operation_id].filter(Boolean))]);
    await tx.query(`UPDATE agent_runs SET generation=generation+1,
      state=CASE WHEN needs_continue THEN 'paused'
        WHEN EXISTS(SELECT 1 FROM agent_waits WHERE run_id=$1 AND state='pending') THEN 'waiting' ELSE 'received' END
      WHERE run_id=$1`, [runId]);
    for (const wait of cancelled) await appendEvent(tx, sessionId, 'wait-cancelled', {
      runId, waitId: wait.wait_id, requestId, inputId, reason: 'steering' });
  }
  async function accept(value: AgentInput): Promise<AgentInputReceipt> {
    const input = agentInputSchema.parse(value), inputDigest = canonicalDigest(input);
    const accepted = await storage.request({ requestId: 'agent-input:' + input.requestId, fingerprint: inputDigest }, async tx => {
      const { rows: [locked] } = await tx.query('SELECT body FROM agent_runtime_sessions WHERE session_id=$1 FOR UPDATE', [input.sessionId]);
      if (!locked) throw new StorageError('missing');
      const inputId = operationId('agent-input:' + input.requestId);
      const { rows: [active] } = await tx.query(`SELECT run_id FROM agent_runs WHERE session_id=$1
        AND (state IN ('received','running','waiting') OR needs_continue) ORDER BY created_at,run_id LIMIT 1`, [input.sessionId]);
      const runId = active && input.mode === 'steering' ? String(active.run_id) : operationId('agent-run:' + input.requestId);
      if (!active || input.mode === 'queue') {
        const { rows: [previous] } = await tx.query('SELECT run_id FROM agent_runs WHERE session_id=$1 ORDER BY created_at DESC,run_id DESC LIMIT 1', [input.sessionId]);
        await insertRun(tx, runId, input.sessionId, input.requestId, inputId, previous?.run_id ?? null);
      } else if (input.mode === 'steering') {
        await interruptSteeringWaits(tx, input.sessionId, runId, input.requestId, inputId);
        await tx.query('UPDATE agent_runs SET revision=revision+1,updated_at=clock_timestamp() WHERE run_id=$1', [runId]);
      }
      const received = await appendEvent(tx, input.sessionId, 'input-received', { runId, inputId, input });
      await tx.query(`INSERT INTO agent_inputs(input_id,request_id,session_id,run_id,seq,mode,body,input_digest,original_body)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$7)`, [inputId, input.requestId, input.sessionId, runId, received.seq, input.mode, input, inputDigest]);
      return { requestId: input.requestId, sessionId: input.sessionId, inputId, runId, inputDigest };
    });
    return agentInputReceiptSchema.parse(accepted.result);
  }
  async function request(sessionId: string, requestId: string): Promise<AgentAcceptedRequest | null> {
    const { rows: [row] } = await storage.read('SELECT original_body,input_digest FROM agent_inputs WHERE session_id=$1 AND request_id=$2', [sessionId, requestId]);
    if (!row) return null;
    const saved = await storage.receipt('agent-input:' + requestId, String(row.input_digest));
    if (!saved) throw new StorageError('corrupt');
    return { receipt: agentInputReceiptSchema.parse(saved.result), input: agentInputSchema.parse(row.original_body) };
  }
  async function inputControl(sessionId: string, inputId: string, control: AgentInputControl): Promise<AgentInputControlReceipt> {
    const body = { sessionId, inputId, control }, fingerprint = canonicalDigest(body);
    const receipt = await storage.request({ requestId: 'agent-control:' + control.requestId, fingerprint }, async tx => {
      await tx.query('SELECT session_id FROM agent_runtime_sessions WHERE session_id=$1 FOR UPDATE', [sessionId]);
      const { rows: [row] } = await tx.query(`SELECT i.*,r.state AS run_state FROM agent_inputs i JOIN agent_runs r USING(run_id)
        WHERE i.session_id=$1 AND i.input_id=$2 FOR UPDATE`, [sessionId, inputId]);
      if (!row) throw new StorageError('missing');
      if (row.state !== 'pending' || Number(row.version) !== control.expectedVersion
        || ['completed', 'failed', 'stopped'].includes(String(row.run_state))) throw new StorageError('conflict');
      const original = agentInputSchema.parse(row.body);
      const mode = control.operation === 'remove' ? original.mode : control.mode ?? original.mode;
      let runId = String(row.run_id);
      if (mode !== original.mode) {
        if (mode === 'steering') {
          const { rows: [active] } = await tx.query(`SELECT run_id FROM agent_runs WHERE session_id=$1
            AND (state IN ('received','running','waiting') OR needs_continue) ORDER BY created_at,run_id LIMIT 1`, [sessionId]);
          if (active) runId = String(active.run_id);
        } else {
          runId = operationId('agent-run:input-control:' + control.requestId);
          const { rows: [previous] } = await tx.query('SELECT run_id FROM agent_runs WHERE session_id=$1 ORDER BY created_at DESC,run_id DESC LIMIT 1', [sessionId]);
          await insertRun(tx, runId, sessionId, original.requestId, inputId, previous?.run_id ?? null);
        }
      }
      const input = control.operation === 'remove' ? original : agentInputSchema.parse({ ...original,
        mode, ...(control.operation === 'edit' && control.text !== undefined ? { text: control.text } : {}),
        ...(control.operation === 'edit' && control.context !== undefined ? { context: control.context } : {}) });
      const { rows: [updated] } = await tx.query(`UPDATE agent_inputs SET body=$2,version=version+1,run_id=$4,mode=$5,
        state=CASE WHEN $3 THEN 'removed' ELSE state END WHERE input_id=$1 RETURNING *`, [inputId, input, control.operation === 'remove', runId, mode]);
      if (mode === 'steering' && original.mode !== 'steering') await interruptSteeringWaits(tx, sessionId, runId, control.requestId, inputId);
      await tx.query('UPDATE agent_runs SET revision=revision+1,updated_at=clock_timestamp() WHERE run_id=$1', [row.run_id]);
      if (runId !== row.run_id) await tx.query('UPDATE agent_runs SET revision=revision+1,updated_at=clock_timestamp() WHERE run_id=$1', [runId]);
      if (control.operation === 'remove' || runId !== row.run_id) await retireEmptyRun(tx, sessionId, String(row.run_id));
      await tx.query('INSERT INTO agent_controls VALUES($1,$2,$3,$4,$5,$6)', [control.requestId, sessionId, runId, control.operation, fingerprint, body]);
      await appendEvent(tx, sessionId, 'input-' + (control.operation === 'remove' ? 'removed' : control.operation === 'move' ? 'moved' : 'edited'), {
        runId, inputId, version: Number(updated!.version), requestId: control.requestId,
      });
      return { requestId: control.requestId, input: inputFromRow(updated!), ...(runId !== row.run_id ? { previousRunId: row.run_id } : {}) };
    });
    return receipt.result as AgentInputControlReceipt;
  }
  async function retireEmptyRun(tx: OwnedTransaction, sessionId: string, runId: string) {
    const { rows: [row] } = await tx.query(`SELECT
      (SELECT count(*) FROM agent_inputs WHERE run_id=$1 AND state<>'removed') AS inputs,
      (SELECT count(*) FROM agent_steps WHERE run_id=$1) AS steps`, [runId]);
    if (Number(row!.inputs) || Number(row!.steps)) return;
    await tx.query(`UPDATE agent_runs SET state='stopped',reason='input-removed',stop_requested=true,needs_continue=false,
      generation=generation+1,revision=revision+1,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE run_id=$1`, [runId]);
    await appendEvent(tx, sessionId, 'run-stopped', { runId, reason: 'input-removed' });
  }
  async function sessionSnapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    // One SQL statement gives all aggregates the same MVCC snapshot without a write receipt.
    const { rows: [row] } = await storage.read(`SELECT s.body,
      COALESCE((SELECT jsonb_agg(to_jsonb(r) ORDER BY r.created_at,r.run_id) FROM (
        SELECT run_id,session_id,request_id,input_id,state,reason,generation,stop_requested,needs_continue,
          previous_run_id,created_at,updated_at,completed_at FROM agent_runs WHERE session_id=s.session_id
      ) r),'[]'::jsonb) AS runs,
      COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.seq) FROM (
        SELECT input_id,run_id,version,mode,state,body,created_at,seq FROM agent_inputs WHERE session_id=s.session_id
      ) i),'[]'::jsonb) AS inputs,
      COALESCE((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.created_at,w.wait_id) FROM agent_waits w
        JOIN agent_runs r USING(run_id) WHERE r.session_id=s.session_id),'[]'::jsonb) AS waits
      FROM agent_runtime_sessions s WHERE s.session_id=$1`, [sessionId]);
    if (!row) throw new StorageError('missing');
    return { session: agentRuntimeSessionSchema.parse(row.body), runs: (row.runs as Row[]).map(runFromRow),
      inputs: (row.inputs as Row[]).map(inputFromRow), waits: (row.waits as Row[]).map(waitFromRow) };
  }
  async function events(sessionId: string, after = 0): Promise<AgentEvent[]> {
    if (!Number.isSafeInteger(after) || after < 0) throw new StorageError('invalid');
    await session(sessionId);
    const { rows } = await storage.read('SELECT * FROM agent_events WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT 1000', [sessionId, after]);
    return rows.map(row => agentEventSchema.parse({ sessionId, seq: Number(row.seq), eventId: row.event_id,
      kind: row.kind, version: 1, body: row.body, createdAt: iso(row.created_at) }));
  }
  async function control(sessionId: string, runId: string, operation: 'stop' | 'continue', requestId: string) {
    const body = { sessionId, runId, operation, requestId }, fingerprint = canonicalDigest(body);
    await storage.request({ requestId: 'agent-control:' + requestId, fingerprint }, async tx => {
      await tx.query('SELECT session_id FROM agent_runtime_sessions WHERE session_id=$1 FOR UPDATE', [sessionId]);
      const { rows: [row] } = await tx.query('SELECT * FROM agent_runs WHERE session_id=$1 AND run_id=$2 FOR UPDATE', [sessionId, runId]);
      if (!row) throw new StorageError('missing');
      const current = runFromRow(row);
      if (operation === 'stop' && !['completed', 'failed', 'stopped'].includes(current.state)) {
        await tx.query(`UPDATE agent_runs SET state='stopped',reason='student-stop',stop_requested=true,
          needs_continue=false,generation=generation+1,revision=revision+1,completed_at=clock_timestamp(),updated_at=clock_timestamp() WHERE run_id=$1`, [runId]);
        const { rows: waits } = await tx.query("UPDATE agent_waits SET state='cancelled',version=version+1 WHERE run_id=$1 AND state='pending' RETURNING wait_id", [runId]);
        await tx.query('UPDATE agent_steps SET continuation_open=false WHERE run_id=$1 AND continuation_open', [runId]);
        for (const wait of waits) await appendEvent(tx, sessionId, 'wait-cancelled', { runId, waitId: wait.wait_id, requestId });
        await appendEvent(tx, sessionId, 'run-stopped', { runId, requestId });
        // Record delivery intent with the stop, before any external cancellation can be lost.
        const { rows: steps } = await tx.query(`SELECT step_id FROM agent_steps WHERE run_id=$1
          AND state IN ('completed','dispatching','waiting','unknown')`, [runId]);
        for (const step of steps) {
          const cancellation = cancellationControlSchema.parse({ requestId: operationId('agent-cancel:' + step.step_id),
            sessionId, runId, operation: 'cancel', stepId: step.step_id, stopRequestId: requestId, state: 'pending' });
          await tx.query('INSERT INTO agent_controls VALUES($1,$2,$3,$4,$5,$6)',
            [cancellation.requestId, sessionId, runId, 'cancel', cancellationDigest(cancellation), cancellation]);
        }
      }
      if (operation === 'continue') {
        if (current.stopRequested || ['completed', 'failed', 'stopped'].includes(current.state)) throw new StorageError('conflict');
        if (current.needsContinue || current.state === 'paused') {
          await tx.query(`UPDATE agent_runs SET state=CASE WHEN EXISTS(SELECT 1 FROM agent_waits WHERE run_id=$1 AND state='pending')
            THEN 'waiting' ELSE 'received' END,reason='',needs_continue=false,
            revision=revision+1,updated_at=clock_timestamp() WHERE run_id=$1`, [runId]);
          await appendEvent(tx, sessionId, 'run-continued', { runId, requestId });
        }
      }
      await tx.query('INSERT INTO agent_controls VALUES($1,$2,$3,$4,$5,$6)', [requestId, sessionId, runId, operation, fingerprint, body]);
      return null;
    });
    return run(sessionId, runId);
  }
  async function pendingCancellations(runId?: string): Promise<CancellationControl[]> {
    const { rows } = await storage.read(`SELECT body FROM agent_controls WHERE operation='cancel'
      AND body->>'state'='pending' AND ($1::uuid IS NULL OR run_id=$1) ORDER BY run_id,request_id`, [runId ?? null]);
    return rows.map(row => cancellationControlSchema.parse(row.body));
  }
  async function acknowledgeCancellation(cancellation: CancellationControl) {
    const fingerprint = cancellationDigest(cancellation);
    await storage.request({ requestId: 'agent-cancel-delivered:' + cancellation.requestId, fingerprint }, async tx => {
      const { rows: [row] } = await tx.query('SELECT * FROM agent_controls WHERE request_id=$1 FOR UPDATE', [cancellation.requestId]);
      if (!row || row.operation !== 'cancel' || row.input_digest !== fingerprint
        || cancellationDigest(cancellationControlSchema.parse(row.body)) !== fingerprint) throw new StorageError('identity-conflict');
      await tx.query('UPDATE agent_controls SET body=$2 WHERE request_id=$1',
        [cancellation.requestId, { ...cancellation, state: 'delivered' }]);
      return { requestId: cancellation.requestId };
    });
  }
  async function snapshot(runId: string, query: OwnedTransaction['query'] = storage.read.bind(storage)): Promise<AgentExecutionSnapshot> {
    const { rows: [row] } = await query('SELECT * FROM agent_runs WHERE run_id=$1', [runId]);
    if (!row) throw new StorageError('missing');
    const current = runFromRow(row);
    const { rows: inputs } = await query(`SELECT * FROM agent_inputs WHERE run_id=$1 AND state IN ('pending','adopted') ORDER BY seq`, [runId]);
    const { rows: steps } = await query('SELECT * FROM agent_steps WHERE run_id=$1 ORDER BY step_no', [runId]);
    const { rows: waits } = await query('SELECT * FROM agent_waits WHERE run_id=$1 ORDER BY created_at,wait_id', [runId]);
    const { rows: [sessionState] } = await query('SELECT state FROM agent_runtime_sessions WHERE session_id=$1', [current.sessionId]);
    return { session: await session(current.sessionId, query), run: current, revision: Number(row.revision), state: row.context as Facts,
      sessionState: sessionState!.state as Facts,
      budget: { ...(row.budget as Pick<AgentRunBudget, 'maxSteps' | 'maxDispatches' | 'deadline'>), steps: steps.length, dispatches: Number(row.dispatch_count) },
      inputs: inputs.map(input => ({ inputId: String(input.input_id), version: Number(input.version), sequence: Number(input.seq),
        input: agentInputSchema.parse(input.body) })), steps: steps.map(stepFromRow),
      waits: waits.map(waitFromRow) };
  }
  async function transition<T>(runId: string, work: (tx: OwnedTransaction, current: AgentRun) => Promise<T>): Promise<T> {
    const nonce = randomUUID();
    const result = await storage.request({ requestId: 'agent-transition:' + nonce, fingerprint: nonce }, async tx => {
      // Session first is the same lock order used by input and user control commits.
      const { rows: [route] } = await tx.query('SELECT session_id FROM agent_runs WHERE run_id=$1', [runId]);
      if (!route) throw new StorageError('missing');
      await tx.query('SELECT session_id FROM agent_runtime_sessions WHERE session_id=$1 FOR UPDATE', [route.session_id]);
      const { rows: [row] } = await tx.query('SELECT * FROM agent_runs WHERE run_id=$1 FOR UPDATE', [runId]);
      if (!row) throw new StorageError('missing');
      return work(tx, runFromRow(row));
    });
    return result.result as T;
  }
  async function begin(runId: string): Promise<number | null> {
    return transition(runId, async (tx, current) => {
      if (current.stopRequested || ['completed', 'failed', 'stopped'].includes(current.state)) return null;
      if (current.previousRunId) {
        const { rows: previous } = await tx.query(`WITH RECURSIVE prior AS (
          SELECT run_id,previous_run_id,state FROM agent_runs WHERE run_id=$1 UNION
          SELECT r.run_id,r.previous_run_id,r.state FROM agent_runs r JOIN prior p ON r.run_id=p.previous_run_id
        ) SELECT run_id FROM prior WHERE state NOT IN ('completed','failed','stopped') LIMIT 1`, [current.previousRunId]);
        if (previous.length) return null;
      }
      const { rows: expired } = await tx.query(`UPDATE agent_waits SET state='expired',version=version+1
        WHERE run_id=$1 AND state='pending' AND deadline<=$2 RETURNING wait_id`, [runId, new Date(now()).toISOString()]);
      if (expired.length) {
        await tx.query(`UPDATE agent_runs SET state='paused',reason='wait-expired',needs_continue=true,
          generation=generation+1,revision=revision+1,updated_at=clock_timestamp() WHERE run_id=$1`, [runId]);
        await tx.query('UPDATE agent_steps SET continuation_open=false WHERE run_id=$1 AND continuation_open', [runId]);
        for (const wait of expired) await appendEvent(tx, current.sessionId, 'wait-expired', { runId, waitId: wait.wait_id });
        await appendEvent(tx, current.sessionId, 'run-paused', { runId, reason: 'wait-expired' });
        return null;
      }
      const { rows: waits } = await tx.query("SELECT wait_id FROM agent_waits WHERE run_id=$1 AND state='pending' LIMIT 1", [runId]);
      if (waits.length) return null;
      if (current.needsContinue || current.state === 'paused') {
        const { rows: original } = await tx.query("SELECT step_id FROM agent_steps WHERE run_id=$1 AND state IN ('dispatching','waiting','unknown') LIMIT 1", [runId]);
        return original.length ? current.generation : null;
      }
      const { rows: [row] } = await tx.query(`UPDATE agent_runs SET generation=generation+1,state='running',
        updated_at=clock_timestamp() WHERE run_id=$1 RETURNING generation`, [runId]);
      return Number(row!.generation);
    });
  }
  async function successor(runId: string): Promise<string | null> {
    const { rows: [row] } = await storage.read(`SELECT next.run_id FROM agent_runs previous
      JOIN agent_runs next ON next.previous_run_id=previous.run_id
      WHERE previous.run_id=$1 AND previous.state IN ('completed','failed','stopped')
      ORDER BY next.created_at,next.run_id LIMIT 1`, [runId]);
    return row ? String(row.run_id) : null;
  }
  async function budgetAllows(tx: OwnedTransaction, current: AgentRun, stage: 'plan' | 'step' | 'dispatch'): Promise<boolean> {
    const { rows: [row] } = await tx.query(`SELECT budget,dispatch_count,
      (SELECT count(*) FROM agent_steps WHERE run_id=$1) AS steps FROM agent_runs WHERE run_id=$1`, [current.runId]);
    const budget = row!.budget as AgentRunBudget;
    const reason = budget.deadline && now() >= Date.parse(budget.deadline) ? 'deadline-exceeded'
      : stage === 'step' && Number(row!.steps) >= budget.maxSteps ? 'step-budget-exhausted'
      : stage === 'dispatch' && Number(row!.dispatch_count) >= budget.maxDispatches ? 'dispatch-budget-exhausted' : null;
    if (!reason) return true;
    await tx.query(`UPDATE agent_runs SET state='paused',reason=$2,needs_continue=true,generation=generation+1,
      revision=revision+1,updated_at=clock_timestamp() WHERE run_id=$1`, [current.runId, reason]);
    await tx.query('UPDATE agent_steps SET continuation_open=false WHERE run_id=$1 AND continuation_open', [current.runId]);
    await appendEvent(tx, current.sessionId, 'run-paused', { runId: current.runId, reason });
    return false;
  }
  async function allowPlan(runId: string, generation: number): Promise<boolean> {
    return transition(runId, async (tx, current) => {
      if (current.generation !== generation || current.stopRequested || current.needsContinue || current.state !== 'running') return false;
      return budgetAllows(tx, current, 'plan');
    });
  }
  async function prepare(basis: AgentExecutionSnapshot, generation: number, decision: Extract<AgentDecision, { kind: 'operation' }>) {
    const operation = agentOperationSchema.parse(decision.operation);
    const number = basis.steps.length + 1, stepId = operationId('agent-step:' + basis.run.runId + ':' + number);
    return transition(basis.run.runId, async (tx, current) => {
      if (current.stopRequested || current.needsContinue || current.generation !== generation) return false;
      const { rows: [row] } = await tx.query('SELECT revision FROM agent_runs WHERE run_id=$1', [current.runId]);
      if (Number(row!.revision) !== basis.revision) return false;
      const { rows: pending } = await tx.query("SELECT step_id FROM agent_steps WHERE run_id=$1 AND state<>'completed' LIMIT 1", [current.runId]);
      if (pending.length) return false;
      if (!await budgetAllows(tx, current, 'step')) return false;
      await tx.query(`INSERT INTO agent_steps(step_id,run_id,step_no,operation_id,operation,snapshot,state)
        VALUES($1,$2,$3,$4,$5,$6,'prepared')`, [stepId, current.runId, number, operation.operationId, operation, decision.snapshot]);
      const selected = basis.inputs.filter(input => input.input.mode === 'steering' || input.inputId === current.inputId);
      for (const input of selected) await tx.query("UPDATE agent_inputs SET state='adopted',adopted_step_id=$2 WHERE input_id=$1 AND state='pending' AND version=$3",
        [input.inputId, stepId, input.version]);
      await appendEvent(tx, current.sessionId, 'operation-prepared', { runId: current.runId, stepId, operationId: operation.operationId, kind: operation.kind });
      return true;
    });
  }
  async function permit(runId: string, generation: number, stepId: string): Promise<AgentDispatchPermit | null> {
    return transition(runId, async (tx, current) => {
      if (current.generation !== generation || current.stopRequested || current.needsContinue || current.state !== 'running') return null;
      if (!await budgetAllows(tx, current, 'dispatch')) return null;
      const { rows: [row] } = await tx.query(`UPDATE agent_steps SET state='dispatching',dispatch_generation=$3,updated_at=clock_timestamp()
        WHERE run_id=$1 AND step_id=$2 AND state='prepared' RETURNING operation_id`, [runId, stepId, generation]);
      if (!row) return null;
      await tx.query('UPDATE agent_runs SET dispatch_count=dispatch_count+1 WHERE run_id=$1', [runId]);
      return { sessionId: current.sessionId, runId, stepId, operationId: String(row.operation_id), generation };
    });
  }
  async function assertDispatch(value: AgentDispatchPermit) {
    const input = agentDispatchPermitSchema.parse(value);
    const { rows: [row] } = await storage.read(`SELECT r.generation,r.state,r.stop_requested,r.needs_continue,r.budget,s.dispatch_generation,
      s.state AS step_state,s.continuation_open
      FROM agent_runs r JOIN agent_steps s ON s.run_id=r.run_id
      WHERE r.session_id=$1 AND r.run_id=$2 AND s.step_id=$3 AND s.operation_id=$4`,
    [input.sessionId, input.runId, input.stepId, input.operationId]);
    const ordinary = row?.state === 'running' && row.step_state === 'dispatching' && Number(row.dispatch_generation) === input.generation;
    const continuation = row?.continuation_open === true && ['waiting', 'running'].includes(String(row.state))
      && ['waiting', 'completed'].includes(String(row.step_state));
    if (!row || Number(row.generation) !== input.generation || row.stop_requested || row.needs_continue || (!ordinary && !continuation)
      || ((row.budget as AgentRunBudget).deadline !== null && now() >= Date.parse((row.budget as AgentRunBudget).deadline!))) throw new StorageError('stale-generation');
  }
  async function recordProgress(permit: AgentDispatchPermit, progress: AgentModelProgress): Promise<boolean> {
    return transition(permit.runId, async (tx, current) => {
      if (current.sessionId !== permit.sessionId || current.generation !== permit.generation || current.state !== 'running'
        || current.stopRequested || current.needsContinue) return false;
      const { rows: [step] } = await tx.query(`SELECT s.state,s.dispatch_generation,r.budget FROM agent_steps s JOIN agent_runs r USING(run_id)
        WHERE s.run_id=$1 AND s.step_id=$2 AND s.operation_id=$3`, [permit.runId, permit.stepId, permit.operationId]);
      if (!step || step.state !== 'dispatching' || Number(step.dispatch_generation) !== permit.generation) return false;
      const deadline = (step.budget as AgentRunBudget).deadline;
      if (deadline && now() >= Date.parse(deadline)) return false;
      const { rows: [same] } = await tx.query('SELECT body FROM agent_progress WHERE operation_id=$1 AND revision=$2', [permit.operationId, progress.revision]);
      if (same) {
        if (canonicalDigest(same.body) !== canonicalDigest(progress)) throw new StorageError('identity-conflict');
        return false;
      }
      const { rows: [last] } = await tx.query('SELECT max(revision) AS revision FROM agent_progress WHERE operation_id=$1', [permit.operationId]);
      if (Number(last!.revision ?? 0) >= progress.revision) return false;
      const eventId = operationId('agent-progress:' + permit.operationId + ':' + progress.revision);
      await appendEvent(tx, current.sessionId, 'model-progress', {
        runId: current.runId, stepId: permit.stepId, operationId: permit.operationId, ...progress,
      }, eventId);
      await tx.query('INSERT INTO agent_progress(operation_id,revision,generation,body,event_id) VALUES($1,$2,$3,$4,$5)',
        [permit.operationId, progress.revision, permit.generation, progress, eventId]);
      return true;
    });
  }
  async function settle(basis: AgentExecutionSnapshot, step: AgentStep, result: AgentOperationResult, applied: AgentSettlement) {
    return transition(basis.run.runId, async (tx, current) => {
      const { rows: [saved] } = await tx.query('SELECT state,result FROM agent_steps WHERE run_id=$1 AND step_id=$2 FOR UPDATE', [current.runId, step.stepId]);
      if (!saved) throw new StorageError('missing');
      if (saved.state === 'completed') {
        if (canonicalDigest(saved.result) !== canonicalDigest(result)) throw new StorageError('identity-conflict');
        return false;
      }
      const same = canonicalDigest(saved.result) === canonicalDigest(result);
      const next = result.state === 'accepted' ? 'waiting' : result.state === 'unknown' ? 'unknown'
        : result.state === 'not-dispatched' ? 'prepared' : 'completed';
      const active = !current.stopRequested && !['completed', 'failed', 'stopped'].includes(current.state);
      if (same) {
        // Each admission can enter dispatching again even when the original owner
        // returns the same receipt. Deduplication must still restore its execution state.
        if (saved.state !== next) await tx.query('UPDATE agent_steps SET state=$2,updated_at=clock_timestamp() WHERE step_id=$1', [step.stepId, next]);
        // Continue clears the pause independently of the immutable owner result.
        // An unchanged unknown must pause again without publishing another result.
        if (next === 'unknown' && active) {
          await tx.query("UPDATE agent_runs SET state='paused',reason=$2,needs_continue=true,updated_at=clock_timestamp() WHERE run_id=$1",
            [current.runId, applied.pause ?? 'result-unknown']);
        } else if (next === 'waiting' && current.state === 'running' && !current.stopRequested) {
          await tx.query("UPDATE agent_runs SET state='waiting',updated_at=clock_timestamp() WHERE run_id=$1", [current.runId]);
        }
        return false;
      }
      // A stopped run may retain its original result, but can never regain dispatch authority here.
      if (applied.keepDispatch && !['completed', 'accepted'].includes(result.state)) throw new StorageError('invalid');
      await tx.query('UPDATE agent_steps SET state=$2,result=$3,continuation_open=$4,updated_at=clock_timestamp() WHERE step_id=$1',
        [step.stepId, next, result, active && applied.keepDispatch === true]);
      await appendEvent(tx, current.sessionId, 'operation-result', { runId: current.runId, stepId: step.stepId,
        operationId: step.operation.operationId, result });
      if (!active) return true;
      await tx.query(`UPDATE agent_runs SET context=$2,revision=revision+1,updated_at=clock_timestamp() WHERE run_id=$1`, [current.runId, applied.state]);
      if (applied.sessionState !== undefined) await tx.query('UPDATE agent_runtime_sessions SET state=$2 WHERE session_id=$1', [current.sessionId, applied.sessionState]);
      for (const event of applied.events ?? []) await appendEvent(tx, current.sessionId, event.kind, { ...event.body, runId: current.runId });
      if (applied.wait && active) {
        const waitId = operationId('agent-wait:' + step.operation.operationId + ':' + applied.wait.kind);
        const continuationId = applied.wait.continuationOperationId;
        if (continuationId !== undefined) {
          const { rows: original } = await tx.query('SELECT operation_id FROM agent_steps WHERE run_id=$1 AND operation_id=$2 AND continuation_open', [current.runId, continuationId]);
          if (!original.length) throw new StorageError('conflict');
        }
        await tx.query(`INSERT INTO agent_waits(wait_id,run_id,operation_id,version,kind,state,presentation,deadline,continuation_operation_id,interruptible)
          VALUES($1,$2,$3,1,$4,'pending',$5,$6,$7,$8) ON CONFLICT(wait_id) DO NOTHING`,
        [waitId, current.runId, step.operation.operationId, applied.wait.kind, applied.wait.presentation, applied.wait.deadline, continuationId ?? null,
          applied.wait.interruptible === true]);
        await tx.query("UPDATE agent_runs SET state='waiting' WHERE run_id=$1", [current.runId]);
        await appendEvent(tx, current.sessionId, 'wait-opened', { runId: current.runId, waitId, operationId: step.operation.operationId,
          kind: applied.wait.kind, presentation: applied.wait.presentation, interruptible: applied.wait.interruptible === true,
          ...(continuationId ? { continuationOperationId: continuationId } : {}) });
      } else if (active && (result.state === 'unknown' || applied.pause)) {
        await tx.query("UPDATE agent_runs SET state='paused',reason=$2,needs_continue=true WHERE run_id=$1", [current.runId, applied.pause ?? 'result-unknown']);
      } else if (active && result.state === 'accepted') {
        await tx.query("UPDATE agent_runs SET state='waiting' WHERE run_id=$1", [current.runId]);
      } else if (active && applied.complete) {
        await finish(tx, current, 'completed');
      }
      return true;
    });
  }
  async function finish(tx: OwnedTransaction, current: AgentRun, state: 'completed' | 'failed') {
    await tx.query('UPDATE agent_steps SET continuation_open=false WHERE run_id=$1 AND continuation_open', [current.runId]);
    await tx.query(`UPDATE agent_runs SET state=$2,needs_continue=false,completed_at=clock_timestamp(),
      revision=revision+1,updated_at=clock_timestamp() WHERE run_id=$1`, [current.runId, state]);
    await appendEvent(tx, current.sessionId, 'run-' + state, { runId: current.runId });
  }
  async function decide(basis: AgentExecutionSnapshot, generation: number, decision: Exclude<AgentDecision, { kind: 'operation' }>) {
    return transition(basis.run.runId, async (tx, current) => {
      if (current.generation !== generation || current.stopRequested || current.needsContinue) return false;
      const { rows: [row] } = await tx.query('SELECT revision FROM agent_runs WHERE run_id=$1', [current.runId]);
      if (Number(row!.revision) !== basis.revision) return false;
      if (decision.kind === 'complete') {
        for (const event of decision.events ?? []) await appendEvent(tx, current.sessionId, event.kind, { ...event.body, runId: current.runId });
        await finish(tx, current, 'completed');
      } else {
        await tx.query("UPDATE agent_runs SET state='paused',reason=$2,needs_continue=true,updated_at=clock_timestamp() WHERE run_id=$1", [current.runId, decision.reason]);
        await tx.query('UPDATE agent_steps SET continuation_open=false WHERE run_id=$1 AND continuation_open', [current.runId]);
      }
      return true;
    });
  }
  async function consumeWait(sessionId: string, value: AgentWaitResponse, source: 'response' | 'result', validate?: AgentPipeline['validateResponse']) {
    const input = agentWaitResponseSchema.parse(value), fingerprint = canonicalDigest({ sessionId, input });
    let validationFailure: { error: unknown } | undefined;
    const receipt = await storage.request({ requestId: (source === 'response' ? 'agent-response:' : 'agent-wait-result:') + input.requestId, fingerprint }, async tx => {
      await tx.query('SELECT session_id FROM agent_runtime_sessions WHERE session_id=$1 FOR UPDATE', [sessionId]);
      const { rows: [row] } = await tx.query(`SELECT w.*,r.state AS run_state,r.stop_requested FROM agent_waits w JOIN agent_runs r USING(run_id)
        WHERE w.wait_id=$1 AND r.session_id=$2 FOR UPDATE`, [input.waitId, sessionId]);
      if (!row) throw new StorageError('missing');
      if (row.state !== 'pending' || row.version !== input.expectedVersion) throw new StorageError('conflict');
      if (row.stop_requested || ['completed', 'failed', 'stopped'].includes(String(row.run_state))) throw new StorageError('conflict');
      if (row.deadline && new Date(row.deadline as string).getTime() <= Date.now()) throw new StorageError('conflict');
      if (validate) {
        const basis = await snapshot(String(row.run_id), tx.query.bind(tx));
        try { await validate(basis, basis.waits.find(wait => wait.waitId === input.waitId)!, input.answer as Facts); }
        catch (error) { validationFailure = { error }; throw error; }
      }
      await tx.query("UPDATE agent_waits SET state='consumed',version=version+1,response=$2 WHERE wait_id=$1", [input.waitId, input.answer]);
      if (row.continuation_operation_id) await tx.query('UPDATE agent_steps SET continuation_open=false WHERE run_id=$1 AND operation_id=$2', [row.run_id, row.continuation_operation_id]);
      await tx.query(`UPDATE agent_runs SET state=CASE WHEN $2 AND needs_continue THEN 'paused' ELSE 'received' END,
        needs_continue=CASE WHEN $2 THEN needs_continue ELSE false END,
        reason=CASE WHEN $2 AND needs_continue THEN reason ELSE '' END,
        revision=revision+1,updated_at=clock_timestamp() WHERE run_id=$1`, [row.run_id, source === 'result']);
      await appendEvent(tx, sessionId, source === 'response' ? 'wait-consumed' : 'wait-resolved', {
        runId: row.run_id, waitId: input.waitId, requestId: input.requestId,
        ...(source === 'response' ? { answer: input.answer } : { result: input.answer }),
      });
      return { runId: row.run_id as string, waitId: input.waitId };
    }).catch(error => { throw validationFailure ? validationFailure.error : error; });
    return receipt.result as { runId: string; waitId: string };
  }
  const respond = (sessionId: string, value: AgentWaitResponse, validate?: AgentPipeline['validateResponse']) => consumeWait(sessionId, value, 'response', validate);
  const resolveWait = (sessionId: string, value: AgentWaitResponse) => consumeWait(sessionId, value, 'result');
  /** Opening a process fences old dispatch, but does not discard any original operation. */
  async function recover(): Promise<AgentRun[]> {
    const recovered = await storage.request({ requestId: 'agent-recover:' + randomUUID(), fingerprint: 'recover-dispatch-generation' }, async tx => {
      const { rows } = await tx.query(`UPDATE agent_runs r SET generation=generation+1,
        needs_continue=(s.body->>'restartPolicy'='explicit'),updated_at=clock_timestamp()
        FROM agent_runtime_sessions s WHERE r.session_id=s.session_id
          AND r.state IN ('received','running','waiting') RETURNING r.run_id,r.session_id,r.needs_continue`);
      for (const row of rows) await appendEvent(tx, String(row.session_id), 'run-recovered', {
        runId: row.run_id, needsContinue: row.needs_continue,
      });
      // Include automatic pending waits for one host observation after boot. begin()
      // keeps them waiting; only the host's registered external waits schedule a wake.
      const { rows: candidates } = await tx.query(`SELECT r.* FROM agent_runs r JOIN agent_runtime_sessions s USING(session_id)
        WHERE s.body->>'restartPolicy'='automatic' AND NOT r.needs_continue AND NOT r.stop_requested
          AND r.state IN ('received','running','waiting')
          AND NOT EXISTS(SELECT 1 FROM agent_runs prior WHERE prior.session_id=r.session_id
            AND (prior.created_at,prior.run_id)<(r.created_at,r.run_id) AND prior.state NOT IN ('completed','failed','stopped'))
        ORDER BY r.created_at,r.run_id`);
      return candidates.map(runFromRow);
    });
    return (recovered.result as unknown[]).map(value => agentRunSchema.parse(value));
  }
  return { storage, session, initialize, run, accept, request, inputControl, sessionSnapshot, events, control, recover, appendEvent,
    pendingCancellations, acknowledgeCancellation,
    snapshot, begin, successor, allowPlan, prepare, permit, assertDispatch, recordProgress, settle, decide, respond, resolveWait };
}
export type RunStore = ReturnType<typeof createRunStore>;
