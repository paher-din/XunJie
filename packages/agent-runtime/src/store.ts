import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError, type Migration, type OwnedStorage, type OwnedTransaction } from '@xunjie/storage';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import {
  agentEventSchema, agentInputReceiptSchema, agentInputSchema, agentRuntimeSessionSchema, agentTurnSchema,
  agentStepSchema, agentAttemptSchema, agentToolCallSchema, agentQuestionSchema, agentNotificationSchema,
  agentToolResultSchema, agentTurnBudgetSchema, defaultAgentTurnBudget, agentDispatchPermitSchema,
  type AgentEvent, type AgentInput, type AgentInputReceipt, type AgentRuntimeSession, type AgentTurn,
  type AgentStep, type AgentAttempt, type AgentToolCall, type AgentQuestion, type AgentNotification,
  type AgentToolResult, type AgentTurnBudget, type AgentQuestionResponse, type AgentDispatchPermit,
} from '@xunjie/contracts/agent-runtime';
import type { Facts, HistoryEntry, TaskTerminalFact, ToolEffectReference } from './ports.js';
import { AgentError } from './errors.js';

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
` }, { version: 9, name: 'agent-turn-loop', sql: `
  DROP TABLE IF EXISTS agent_progress;
  DROP TABLE IF EXISTS agent_waits;
  DROP TABLE IF EXISTS agent_steps;
  DROP TABLE IF EXISTS agent_controls;
  DROP TABLE IF EXISTS agent_inputs;
  DROP TABLE IF EXISTS agent_runs;
  DROP TABLE IF EXISTS agent_events;
  ALTER TABLE agent_runtime_sessions ADD COLUMN IF NOT EXISTS automatic_wake_blocked text;
  UPDATE agent_runtime_sessions SET state='{}', next_seq=1, automatic_wake_blocked=NULL, body=body-'restartPolicy';
  CREATE TABLE agent_turns(turn_id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES agent_runtime_sessions(session_id),
    request_id uuid NOT NULL, trigger text NOT NULL CHECK(trigger IN ('user','task-notification','continue')),
    origin_notification_id uuid, state text NOT NULL CHECK(state IN ('active','completed','stopped','interrupted','failed')),
    reason text NOT NULL DEFAULT '', owner_instance_id text NOT NULL, budget jsonb NOT NULL,
    usage jsonb NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0,"inputReserved":0,"outputReserved":0}',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    completed_at timestamptz);
  CREATE UNIQUE INDEX agent_turns_active ON agent_turns(session_id) WHERE state='active';
  CREATE INDEX agent_turns_session ON agent_turns(session_id,created_at,turn_id);
  CREATE TABLE agent_inputs(input_id uuid PRIMARY KEY, request_id uuid NOT NULL UNIQUE,
    session_id uuid NOT NULL REFERENCES agent_runtime_sessions(session_id), turn_id uuid NOT NULL REFERENCES agent_turns(turn_id),
    seq bigint NOT NULL, version integer NOT NULL DEFAULT 1,
    state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','adopted','removed','deferred')),
    body jsonb NOT NULL, original_body jsonb NOT NULL, input_digest text NOT NULL, adopted_step_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(session_id,seq));
  CREATE TABLE agent_steps(step_id uuid PRIMARY KEY, turn_id uuid NOT NULL REFERENCES agent_turns(turn_id),
    step_no integer NOT NULL, state text NOT NULL CHECK(state IN ('generating','executing','completed','interrupted','failed')),
    snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), completed_at timestamptz, UNIQUE(turn_id,step_no));
  CREATE TABLE agent_attempts(attempt_id uuid PRIMARY KEY, step_id uuid NOT NULL REFERENCES agent_steps(step_id),
    attempt_no integer NOT NULL, state text NOT NULL CHECK(state IN ('pending','completed','failed','interrupted')),
    request_ref uuid, response_ref uuid, usage jsonb NOT NULL DEFAULT '{"state":"unknown"}',
    reserved jsonb NOT NULL DEFAULT '{"inputTokens":0,"outputTokens":0}', error text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(step_id,attempt_no));
  CREATE TABLE agent_tool_calls(tool_call_id uuid PRIMARY KEY, step_id uuid NOT NULL REFERENCES agent_steps(step_id),
    call_index integer NOT NULL, native_call_id text NOT NULL, name text NOT NULL, input jsonb NOT NULL,
    execution_mode text NOT NULL CHECK(execution_mode IN ('foreground','background')),
    state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','started','closed')), result jsonb, task_id text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    UNIQUE(step_id,call_index));
  CREATE TABLE agent_questions(question_id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES agent_runtime_sessions(session_id),
    turn_id uuid NOT NULL REFERENCES agent_turns(turn_id), step_id uuid NOT NULL REFERENCES agent_steps(step_id),
    tool_call_id uuid NOT NULL UNIQUE REFERENCES agent_tool_calls(tool_call_id), version integer NOT NULL DEFAULT 1,
    state text NOT NULL CHECK(state IN ('pending','answered','skipped','closed','expired')),
    presentation jsonb NOT NULL, answer jsonb, answer_request_id uuid, deadline timestamptz,
    proposal_key text, content_digest text,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE UNIQUE INDEX agent_questions_proposal ON agent_questions(session_id,proposal_key) WHERE proposal_key IS NOT NULL;
  CREATE TABLE agent_notifications(notification_id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES agent_runtime_sessions(session_id),
    origin_turn_id uuid NOT NULL, task_id text NOT NULL, task_version text NOT NULL,
    terminal_status text NOT NULL CHECK(terminal_status IN ('success','failed','cancelled')),
    summary text NOT NULL, result_ref text, state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','adopted','suppressed')),
    consumed_by_step_id uuid, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(task_id,task_version));
  CREATE TABLE agent_events(session_id uuid NOT NULL REFERENCES agent_runtime_sessions(session_id), seq bigint NOT NULL,
    event_id uuid NOT NULL UNIQUE, kind text NOT NULL, body jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(session_id,seq));
  CREATE TABLE agent_controls(request_id uuid PRIMARY KEY, session_id uuid NOT NULL, turn_id uuid,
    operation text NOT NULL, input_digest text NOT NULL, body jsonb NOT NULL);
  CREATE TABLE agent_progress(attempt_id uuid NOT NULL REFERENCES agent_attempts(attempt_id), revision bigint NOT NULL CHECK(revision>0),
    body jsonb NOT NULL, event_id uuid NOT NULL UNIQUE REFERENCES agent_events(event_id), PRIMARY KEY(attempt_id,revision));
` }];

type Row = Record<string, unknown>;
const iso = (value: unknown) => new Date(value as string).toISOString();
const facts = (value: unknown): Facts => value as Facts;

export function turnFromRow(row: Row): AgentTurn {
  return agentTurnSchema.parse({ turnId: row.turn_id, sessionId: row.session_id, requestId: row.request_id,
    trigger: row.trigger, originNotificationId: row.origin_notification_id ?? null, state: row.state, reason: row.reason,
    ownerInstanceId: row.owner_instance_id, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null });
}
function stepFromRow(row: Row): AgentStep {
  return agentStepSchema.parse({ stepId: row.step_id, turnId: row.turn_id, stepNo: Number(row.step_no), state: row.state,
    snapshot: facts(row.snapshot), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at),
    completedAt: row.completed_at ? iso(row.completed_at) : null });
}
function attemptFromRow(row: Row): AgentAttempt {
  return agentAttemptSchema.parse({ attemptId: row.attempt_id, stepId: row.step_id, attemptNo: Number(row.attempt_no),
    state: row.state, requestRef: row.request_ref ?? null, responseRef: row.response_ref ?? null, usage: row.usage,
    reserved: row.reserved, error: row.error ?? null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
function toolCallFromRow(row: Row): AgentToolCall {
  return agentToolCallSchema.parse({ toolCallId: row.tool_call_id, stepId: row.step_id, callIndex: Number(row.call_index),
    nativeCallId: row.native_call_id, name: row.name, input: facts(row.input), executionMode: row.execution_mode,
    state: row.state, result: row.result ?? null, taskId: row.task_id ?? null,
    createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
function questionFromRow(row: Row): AgentQuestion {
  return agentQuestionSchema.parse({ questionId: row.question_id, sessionId: row.session_id, turnId: row.turn_id,
    stepId: row.step_id, toolCallId: row.tool_call_id, version: Number(row.version), state: row.state,
    presentation: facts(row.presentation), answer: row.answer ?? null, answerRequestId: row.answer_request_id ?? null,
    deadline: row.deadline ? iso(row.deadline) : null, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
}
function notificationFromRow(row: Row): AgentNotification {
  return agentNotificationSchema.parse({ notificationId: row.notification_id, sessionId: row.session_id,
    originTurnId: row.origin_turn_id, taskId: row.task_id, taskVersion: row.task_version, terminalStatus: row.terminal_status,
    summary: row.summary, resultRef: row.result_ref ?? null, state: row.state,
    consumedByStepId: row.consumed_by_step_id ?? null, createdAt: iso(row.created_at) });
}
export interface AgentSessionInput {
  inputId: string; turnId: string; version: number; state: 'pending' | 'adopted' | 'removed' | 'deferred';
  input: AgentInput; createdAt: string;
}
function inputFromRow(row: Row): AgentSessionInput {
  return { inputId: String(row.input_id), turnId: String(row.turn_id), version: Number(row.version),
    state: row.state as AgentSessionInput['state'], input: agentInputSchema.parse(row.body), createdAt: iso(row.created_at) };
}
export interface AgentSessionSnapshot {
  session: AgentRuntimeSession; automaticWakeBlocked: string | null; turns: AgentTurn[]; inputs: AgentSessionInput[];
  steps: AgentStep[]; attempts: AgentAttempt[]; toolCalls: AgentToolCall[]; questions: AgentQuestion[]; notifications: AgentNotification[];
}
export interface TurnUsage { inputTokens: number; outputTokens: number; inputReserved: number; outputReserved: number; }
const emptyUsage: TurnUsage = { inputTokens: 0, outputTokens: 0, inputReserved: 0, outputReserved: 0 };
const codePointLength = (value: string) => Array.from(value).length;
/** The exact text a notification contributes to the model prompt, so its budget matches the prompt budget. */
const factLineChars = (n: AgentNotification) => JSON.stringify({ taskId: n.taskId, taskVersion: n.taskVersion,
  status: n.terminalStatus, summary: n.summary, ...(n.resultRef ? { resultRef: n.resultRef } : {}) });
/** One Attempt's single contribution: provider-final when settled, otherwise its full reservation. */
function usageContribution(usage: AgentAttempt['usage'], reserved: { inputTokens: number; outputTokens: number }) {
  const exact = usage.state === 'final';
  return { inputTokens: exact ? usage.inputTokens ?? reserved.inputTokens : Math.max(reserved.inputTokens, usage.inputTokens ?? 0),
    outputTokens: exact ? usage.outputTokens ?? reserved.outputTokens : Math.max(reserved.outputTokens, usage.outputTokens ?? 0) };
}

export interface StoreOptions { budget?: { maxSteps?: number | undefined; maxToolCalls?: number | undefined; maxInputTokens?: number | undefined; maxOutputTokens?: number | undefined; maxCallMs?: number | undefined; hardDeadlineMs?: number | undefined } | undefined; now?: (() => number) | undefined; ownerInstanceId: string;
  /** The host's live lock fence; a closed/released host can never commit a late fact. */
  assertOwner?: (() => boolean) | undefined; }

export function createAgentStore(storage: OwnedStorage, options: StoreOptions) {
  const now = options.now ?? Date.now;
  const ownerInstanceId = options.ownerInstanceId;
  const limits = { ...defaultAgentTurnBudget };
  for (const [key, value] of Object.entries(options.budget ?? {})) if (value !== undefined) (limits as Record<string, number>)[key] = value;
  if (Object.values(limits).some(value => !Number.isSafeInteger(value) || value < 1)) throw new StorageError('invalid');

  async function session(sessionId: string, query: OwnedTransaction['query'] = storage.read.bind(storage)): Promise<AgentRuntimeSession> {
    const { rows: [row] } = await query('SELECT body FROM agent_runtime_sessions WHERE session_id=$1', [sessionId]);
    if (!row) throw new StorageError('missing');
    return agentRuntimeSessionSchema.parse(row.body);
  }
  async function initialize(value: AgentRuntimeSession) {
    const input = agentRuntimeSessionSchema.parse(value);
    const saved = await storage.request({ requestId: 'agent-session:' + input.sessionId, fingerprint: canonicalDigest(input) }, async tx => {
      await tx.query('INSERT INTO agent_runtime_sessions(session_id,body) VALUES($1,$2) ON CONFLICT(session_id) DO NOTHING', [input.sessionId, input]);
      return input;
    });
    return agentRuntimeSessionSchema.parse(saved.result);
  }
  async function appendEvent(tx: OwnedTransaction, sessionId: string, kind: string, body: Record<string, unknown>, eventId: string = randomUUID()) {
    const { rows: [row] } = await tx.query('UPDATE agent_runtime_sessions SET next_seq=next_seq+1 WHERE session_id=$1 RETURNING next_seq-1 AS seq', [sessionId]);
    if (!row) throw new StorageError('missing');
    const seq = Number(row.seq);
    await tx.query('INSERT INTO agent_events(session_id,seq,event_id,kind,body) VALUES($1,$2,$3,$4,$5)', [sessionId, seq, eventId, kind, JSON.stringify(body)]);
    return { seq, eventId };
  }
  function freezeBudget(): AgentTurnBudget {
    return agentTurnBudgetSchema.parse({ maxSteps: limits.maxSteps, maxToolCalls: limits.maxToolCalls,
      maxInputTokens: limits.maxInputTokens, maxOutputTokens: limits.maxOutputTokens, maxCallMs: limits.maxCallMs,
      deadline: new Date(now() + limits.hardDeadlineMs).toISOString() });
  }
  async function insertTurn(tx: OwnedTransaction, sessionId: string, requestId: string, trigger: AgentTurn['trigger'], originNotificationId: string | null) {
    const turnId = operationId('agent-turn:' + requestId);
    await tx.query(`INSERT INTO agent_turns(turn_id,session_id,request_id,trigger,origin_notification_id,state,owner_instance_id,budget)
      VALUES($1,$2,$3,$4,$5,'active',$6,$7)`, [turnId, sessionId, requestId, trigger, originNotificationId, ownerInstanceId, freezeBudget()]);
    return turnId;
  }
  async function activeTurn(tx: OwnedTransaction, sessionId: string): Promise<AgentTurn | null> {
    const { rows: [row] } = await tx.query("SELECT * FROM agent_turns WHERE session_id=$1 AND state='active' LIMIT 1", [sessionId]);
    return row ? turnFromRow(row) : null;
  }
  /**
   * The one idle rule: a pending notification whose origin completed normally may open a task notification
   * Turn when the Session is idle. Called by registration and by every explicit idle boundary (Stop etc.).
   */
  async function maybeOpenPendingTurn(tx: OwnedTransaction, sessionId: string): Promise<string | null> {
    const { rows: [sessionRow] } = await tx.query('SELECT automatic_wake_blocked FROM agent_runtime_sessions WHERE session_id=$1', [sessionId]);
    if (!sessionRow || sessionRow.automatic_wake_blocked) return null;
    if (await activeTurn(tx, sessionId)) return null;
    const { rows: [n] } = await tx.query("SELECT notification_id, origin_turn_id FROM agent_notifications WHERE session_id=$1 AND state='pending' ORDER BY created_at,notification_id LIMIT 1", [sessionId]);
    if (!n) return null;
    const { rows: [origin] } = await tx.query('SELECT state FROM agent_turns WHERE turn_id=$1', [n.origin_turn_id]);
    if (String(origin?.state) !== 'completed') return null;
    const turnId = await insertTurn(tx, sessionId, String(n.notification_id), 'task-notification', String(n.notification_id));
    await appendEvent(tx, sessionId, 'turn-started', { turnId, trigger: 'task-notification', notificationId: n.notification_id });
    return turnId;
  }
  async function openPendingTurn(sessionId: string): Promise<string | null> {
    return transition(sessionId, tx => maybeOpenPendingTurn(tx, sessionId));
  }
  /** Adopt deferred user messages into a freshly opened user/continue Turn, in original order. */
  async function adoptDeferred(tx: OwnedTransaction, sessionId: string, turnId: string) {
    const { rows } = await tx.query("SELECT input_id, version, turn_id FROM agent_inputs WHERE session_id=$1 AND state='deferred' ORDER BY seq", [sessionId]);
    await tx.query("UPDATE agent_inputs SET turn_id=$2, state='pending' WHERE session_id=$1 AND state='deferred'", [sessionId, turnId]);
    // Content origin stays the original event; this records the legitimate consumption move for
    // facts/closure readers without rewriting the input-received event or bumping the version.
    for (const row of rows) await appendEvent(tx, sessionId, 'input-adopted', {
      turnId, previousTurnId: row.turn_id, inputId: row.input_id, version: Number(row.version) });
  }
  async function submitInput(value: AgentInput): Promise<AgentInputReceipt> {
    const input = agentInputSchema.parse(value), inputDigest = canonicalDigest(input);
    const accepted = await storage.request({ requestId: 'agent-input:' + input.requestId, fingerprint: inputDigest }, async tx => {
      const { rows: [locked] } = await tx.query('SELECT body FROM agent_runtime_sessions WHERE session_id=$1 FOR UPDATE', [input.sessionId]);
      if (!locked) throw new StorageError('missing');
      const active = await activeTurn(tx, input.sessionId);
      let turnId: string;
      if (active) turnId = active.turnId;
      else {
        turnId = await insertTurn(tx, input.sessionId, input.requestId, 'user', null);
        await adoptDeferred(tx, input.sessionId, turnId);
        await tx.query('UPDATE agent_runtime_sessions SET automatic_wake_blocked=NULL WHERE session_id=$1', [input.sessionId]);
        await appendEvent(tx, input.sessionId, 'turn-started', { turnId, trigger: 'user' });
      }
      const inputId = operationId('agent-input:' + input.requestId);
      const received = await appendEvent(tx, input.sessionId, 'input-received', { turnId, inputId, input });
      await tx.query(`INSERT INTO agent_inputs(input_id,request_id,session_id,turn_id,seq,body,input_digest,original_body)
        VALUES($1,$2,$3,$4,$5,$6,$7,$6)`, [inputId, input.requestId, input.sessionId, turnId, received.seq, input, inputDigest]);
      return { requestId: input.requestId, sessionId: input.sessionId, inputId, turnId, inputDigest };
    });
    const receipt = agentInputReceiptSchema.parse(accepted.result);
    const { rows: [row] } = await storage.read('SELECT state, turn_id FROM agent_inputs WHERE input_id=$1', [receipt.inputId]);
    return agentInputReceiptSchema.parse({ ...receipt, state: row ? String(row.state) : 'pending',
      currentTurnId: row?.turn_id ? String(row.turn_id) : null });
  }
  async function request(sessionId: string, requestId: string) {
    const { rows: [row] } = await storage.read('SELECT input_id, turn_id, original_body, input_digest, state FROM agent_inputs WHERE session_id=$1 AND request_id=$2', [sessionId, requestId]);
    if (!row) return null;
    const saved = await storage.receipt('agent-input:' + requestId);
    if (saved) return { receipt: agentInputReceiptSchema.parse({ ...(saved.result as Record<string, unknown>),
      state: String(row.state), currentTurnId: row.turn_id ? String(row.turn_id) : null }), input: agentInputSchema.parse(row.original_body) };
    // A real answer is persisted as a SessionInput under the answer's own immutable receipt. Return the
    // same input receipt shape for it instead of failing a legitimate row as corrupt.
    const answer = await storage.receipt('agent-answer:' + requestId);
    if (!answer) throw new StorageError('corrupt');
    const input = agentInputSchema.parse(row.original_body);
    return { receipt: agentInputReceiptSchema.parse({ requestId: input.requestId, sessionId: input.sessionId,
      inputId: String(row.input_id), turnId: String(row.turn_id), inputDigest: String(row.input_digest),
      state: String(row.state), currentTurnId: row.turn_id ? String(row.turn_id) : null }), input };
  }
  async function continueSession(sessionId: string, requestId: string): Promise<AgentTurn> {
    const body = { sessionId, requestId }, fingerprint = canonicalDigest(body);
    const result = await storage.request({ requestId: 'agent-continue:' + requestId, fingerprint }, async tx => {
      const { rows: [locked] } = await tx.query('SELECT body FROM agent_runtime_sessions WHERE session_id=$1 FOR UPDATE', [sessionId]);
      if (!locked) throw new StorageError('missing');
      if (await activeTurn(tx, sessionId)) throw new StorageError('conflict');
      const turnId = await insertTurn(tx, sessionId, requestId, 'continue', null);
      await adoptDeferred(tx, sessionId, turnId);
      await tx.query('UPDATE agent_runtime_sessions SET automatic_wake_blocked=NULL WHERE session_id=$1', [sessionId]);
      await appendEvent(tx, sessionId, 'turn-started', { turnId, trigger: 'continue' });
      return turnId;
    });
    return turn(sessionId, result.result as string);
  }
  async function inputControl(sessionId: string, inputId: string, control: { requestId: string; expectedVersion: number; operation: 'edit' | 'remove'; text?: string; context?: Facts }) {
    const body = { sessionId, inputId, control }, fingerprint = canonicalDigest(body);
    const receipt = await storage.request({ requestId: 'agent-control:' + control.requestId, fingerprint }, async tx => {
      await tx.query('SELECT session_id FROM agent_runtime_sessions WHERE session_id=$1 FOR UPDATE', [sessionId]);
      const { rows: [row] } = await tx.query('SELECT * FROM agent_inputs WHERE session_id=$1 AND input_id=$2 FOR UPDATE', [sessionId, inputId]);
      if (!row) throw new StorageError('missing');
      if (row.state !== 'pending' || Number(row.version) !== control.expectedVersion) throw new StorageError('conflict');
      const original = agentInputSchema.parse(row.body);
      const input = control.operation === 'remove' ? original : agentInputSchema.parse({ ...original,
        ...(control.text !== undefined ? { text: control.text } : {}), ...(control.context !== undefined ? { context: control.context } : {}) });
      const { rows: [updated] } = await tx.query(`UPDATE agent_inputs SET body=$2, version=version+1,
        state=CASE WHEN $3 THEN 'removed' ELSE state END WHERE input_id=$1 RETURNING *`, [inputId, input, control.operation === 'remove']);
      await appendEvent(tx, sessionId, 'input-' + (control.operation === 'remove' ? 'removed' : 'edited'), {
        turnId: row.turn_id, inputId, version: Number(updated!.version), requestId: control.requestId });
      return { requestId: control.requestId, input: inputFromRow(updated!) };
    });
    return receipt.result as { requestId: string; input: AgentSessionInput };
  }
  async function turn(sessionId: string, turnId: string): Promise<AgentTurn> {
    const { rows: [row] } = await storage.read('SELECT * FROM agent_turns WHERE session_id=$1 AND turn_id=$2', [sessionId, turnId]);
    if (!row) throw new StorageError('missing');
    return turnFromRow(row);
  }
  async function activeTurnOf(sessionId: string): Promise<AgentTurn | null> {
    const { rows: [row] } = await storage.read("SELECT * FROM agent_turns WHERE session_id=$1 AND state='active' LIMIT 1", [sessionId]);
    return row ? turnFromRow(row) : null;
  }
  async function events(sessionId: string, after = 0): Promise<AgentEvent[]> {
    if (!Number.isSafeInteger(after) || after < 0) throw new StorageError('invalid');
    await session(sessionId);
    const { rows } = await storage.read('SELECT * FROM agent_events WHERE session_id=$1 AND seq>$2 ORDER BY seq LIMIT 1000', [sessionId, after]);
    return rows.map(row => agentEventSchema.parse({ sessionId, seq: Number(row.seq), eventId: row.event_id, kind: row.kind, version: 1, body: row.body, createdAt: iso(row.created_at) }));
  }
  async function sessionSnapshot(sessionId: string): Promise<AgentSessionSnapshot> {
    const { rows: [row] } = await storage.read(`SELECT s.body, s.automatic_wake_blocked,
      COALESCE((SELECT jsonb_agg(to_jsonb(t) ORDER BY t.created_at,t.turn_id) FROM agent_turns t WHERE t.session_id=s.session_id),'[]'::jsonb) AS turns,
      COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.seq) FROM agent_inputs i WHERE i.session_id=s.session_id),'[]'::jsonb) AS inputs,
      COALESCE((SELECT jsonb_agg(to_jsonb(st) ORDER BY st.created_at,st.step_id) FROM agent_steps st JOIN agent_turns t USING(turn_id) WHERE t.session_id=s.session_id),'[]'::jsonb) AS steps,
      COALESCE((SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at,a.attempt_id) FROM agent_attempts a JOIN agent_steps st USING(step_id) JOIN agent_turns t USING(turn_id) WHERE t.session_id=s.session_id),'[]'::jsonb) AS attempts,
      COALESCE((SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at,c.tool_call_id) FROM agent_tool_calls c JOIN agent_steps st USING(step_id) JOIN agent_turns t USING(turn_id) WHERE t.session_id=s.session_id),'[]'::jsonb) AS tool_calls,
      COALESCE((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.created_at,q.question_id) FROM agent_questions q WHERE q.session_id=s.session_id),'[]'::jsonb) AS questions,
      COALESCE((SELECT jsonb_agg(to_jsonb(n) ORDER BY n.created_at,n.notification_id) FROM agent_notifications n WHERE n.session_id=s.session_id),'[]'::jsonb) AS notifications
      FROM agent_runtime_sessions s WHERE s.session_id=$1`, [sessionId]);
    if (!row) throw new StorageError('missing');
    return { session: agentRuntimeSessionSchema.parse(row.body), automaticWakeBlocked: (row.automatic_wake_blocked as string) ?? null,
      turns: (row.turns as Row[]).map(turnFromRow), inputs: (row.inputs as Row[]).map(inputFromRow),
      steps: (row.steps as Row[]).map(stepFromRow), attempts: (row.attempts as Row[]).map(attemptFromRow),
      toolCalls: (row.tool_calls as Row[]).map(toolCallFromRow), questions: (row.questions as Row[]).map(questionFromRow),
      notifications: (row.notifications as Row[]).map(notificationFromRow) };
  }
  async function transition<T>(sessionId: string, work: (tx: OwnedTransaction) => Promise<T>): Promise<T> {
    const nonce = randomUUID();
    const result = await storage.request({ requestId: 'agent-transition:' + nonce, fingerprint: nonce }, async tx => {
      await tx.query('SELECT session_id FROM agent_runtime_sessions WHERE session_id=$1 FOR UPDATE', [sessionId]);
      return (await work(tx)) ?? null;
    });
    return result.result as T;
  }
  async function appendEventPublic(sessionId: string, kind: string, body: Record<string, unknown>) {
    return transition(sessionId, tx => appendEvent(tx, sessionId, kind, body));
  }

  // ---- loop persistence ----
  async function turnRow(tx: OwnedTransaction, turnId: string): Promise<Row> {
    const { rows: [row] } = await tx.query('SELECT * FROM agent_turns WHERE turn_id=$1 FOR UPDATE', [turnId]);
    if (!row) throw new StorageError('missing');
    return row;
  }
  function assertActive(row: Row) {
    if (options.assertOwner && !options.assertOwner()) throw new StorageError('stale-generation');
    if (row.state !== 'active' || row.owner_instance_id !== ownerInstanceId) throw new StorageError('stale-generation');
  }
  /** A stopped/lost Turn cannot accept new execution facts; only its successor may repair it. */
  async function ownedTurn(tx: OwnedTransaction, turnId: string): Promise<Row> {
    const row = await turnRow(tx, turnId);
    assertActive(row);
    return row;
  }
  /** The same result construction the real question tool uses, so recovery never invents a second shape. */
  function answeredResult(row: Row): AgentToolResult {
    const answerState = row.question_state === 'skipped' ? 'skipped' : 'answered';
    const payload = { questionId: row.question_id, answerState, version: Number(row.version), answer: row.answer ?? null };
    return { kind: 'completed', outcome: 'success', summary: JSON.stringify({ questionId: row.question_id, answerState, answer: row.answer ?? null }).slice(0, 8192),
      data: payload as Facts };
  }
  function closeCallResult(callState: unknown, reason: string): AgentToolResult {
    return callState === 'pending' ? { kind: 'not_started', reason } : { kind: 'outcome_unknown', reason };
  }
  /**
   * Close every open child record of a Turn that can no longer execute. A persisted real answer becomes
   * its final tool result; an unanswered question is closed, never turned into a fake answer or unknown effect.
   */
  async function closeTurnCalls(tx: OwnedTransaction, sessionId: string, turnId: string, reason: string, stepState: 'interrupted' | 'failed') {
    const { rows: calls } = await tx.query(`SELECT c.tool_call_id, c.state, q.question_id, q.state AS question_state, q.answer, q.version
      FROM agent_tool_calls c JOIN agent_steps s USING(step_id) LEFT JOIN agent_questions q USING(tool_call_id)
      WHERE s.turn_id=$1 AND c.state<>'closed' ORDER BY c.call_index`, [turnId]);
    for (const call of calls) {
      let result: AgentToolResult;
      if (call.question_id && ['answered', 'skipped'].includes(String(call.question_state)))
        result = answeredResult(call);
      else if (call.question_id) {
        await tx.query("UPDATE agent_questions SET state='closed', version=version+1, updated_at=clock_timestamp() WHERE question_id=$1 AND state='pending'", [call.question_id]);
        result = { kind: 'interrupted', reason: 'question-closed' };
      } else result = closeCallResult(call.state, reason);
      await tx.query("UPDATE agent_tool_calls SET state='closed', result=$2, updated_at=clock_timestamp() WHERE tool_call_id=$1 AND state<>'closed'", [call.tool_call_id, result]);
    }
    await tx.query("UPDATE agent_questions SET state='closed', version=version+1, updated_at=clock_timestamp() WHERE turn_id=$1 AND state='pending'", [turnId]);
    await tx.query("UPDATE agent_attempts SET state='interrupted', updated_at=clock_timestamp() WHERE state='pending' AND step_id IN (SELECT step_id FROM agent_steps WHERE turn_id=$1)", [turnId]);
    await tx.query("UPDATE agent_steps SET state=$2, completed_at=clock_timestamp(), updated_at=clock_timestamp() WHERE turn_id=$1 AND state IN ('generating','executing')", [turnId, stepState]);
    await tx.query("UPDATE agent_inputs SET state='deferred' WHERE turn_id=$1 AND state='pending'", [turnId]);
  }
  async function usageOf(tx: OwnedTransaction, turnId: string): Promise<TurnUsage> {
    const { rows: [row] } = await tx.query('SELECT usage FROM agent_turns WHERE turn_id=$1', [turnId]);
    return { ...emptyUsage, ...(row!.usage as TurnUsage) };
  }
  async function countsOf(tx: OwnedTransaction, turnId: string) {
    const { rows: [row] } = await tx.query(`SELECT
      (SELECT count(*) FROM agent_steps WHERE turn_id=$1) AS steps,
      (SELECT count(*) FROM agent_tool_calls c JOIN agent_steps s USING(step_id) WHERE s.turn_id=$1) AS tool_calls`, [turnId]);
    return { steps: Number(row!.steps), toolCalls: Number(row!.tool_calls) };
  }
  /** Open a Step adopting inputs/notifications arrived before this boundary. force opens a Step to interpret a tool batch. */
  async function openStep(turnId: string, snapshotBase: Facts, force = false): Promise<{ kind: 'step'; step: AgentStep; inputs: AgentSessionInput[]; notifications: AgentNotification[] } | { kind: 'none' }> {
    const sessionId = (await storage.read('SELECT session_id FROM agent_turns WHERE turn_id=$1', [turnId])).rows[0]?.session_id as string;
    if (!sessionId) throw new StorageError('missing');
    return transition(sessionId, async tx => {
      const row = await turnRow(tx, turnId);
      if (row.state !== 'active') return { kind: 'none' as const };
      if (row.owner_instance_id !== ownerInstanceId) throw new StorageError('stale-generation');
      const { rows: pendingInputs } = await tx.query("SELECT * FROM agent_inputs WHERE turn_id=$1 AND state='pending' ORDER BY seq", [turnId]);
      const { rows: pendingNotifications } = await tx.query("SELECT * FROM agent_notifications WHERE session_id=$1 AND state='pending' ORDER BY created_at,notification_id", [sessionId]);
      // Recheck origin Turn at adoption: a source that became stopped/interrupted/failed is suppressed.
      const notifications: AgentNotification[] = [];
      const latestByTask = new Map<string, number>();
      let notificationChars = 0;
      for (const n of pendingNotifications) {
        const { rows: [origin] } = await tx.query('SELECT session_id, state FROM agent_turns WHERE turn_id=$1', [n.origin_turn_id]);
        // Whitelist at adoption too: a legacy/missing/foreign/terminal origin can never enter a model context.
        if (!origin || String(origin.session_id) !== sessionId || !['active', 'completed'].includes(String(origin.state))) {
          await tx.query("UPDATE agent_notifications SET state='suppressed' WHERE notification_id=$1", [n.notification_id]);
          continue;
        }
        const candidate = notificationFromRow(n);
        const lineChars = codePointLength(factLineChars(candidate));
        const prior = latestByTask.get(candidate.taskId);
        // A newer terminal version supersedes the older one within the same selection; never show stale state.
        if (prior !== undefined) {
          const kept = notifications[prior]!;
          const newer = String(candidate.taskVersion) > String(kept.taskVersion);
          if (newer) {
            notifications.splice(prior, 1);
            notificationChars -= codePointLength(factLineChars(kept));
            latestByTask.clear();
            notifications.forEach((item, index) => latestByTask.set(item.taskId, index));
            await tx.query("UPDATE agent_notifications SET state='suppressed' WHERE notification_id=$1", [kept.notificationId]);
          } else {
            await tx.query("UPDATE agent_notifications SET state='suppressed' WHERE notification_id=$1", [candidate.notificationId]);
            continue;
          }
        }
        // All selected notifications are unconditionally visible in the prompt; only overflow stays pending.
        if (notifications.length >= 8 || notificationChars + lineChars > 8192) continue;
        latestByTask.set(candidate.taskId, notifications.length);
        notificationChars += lineChars;
        notifications.push(candidate);
      }
      if (!force && !pendingInputs.length && !notifications.length) return { kind: 'none' as const };
      const budget = agentTurnBudgetSchema.parse(row.budget);
      const counts = await countsOf(tx, turnId);
      if (counts.steps >= budget.maxSteps) throw new AgentError('budget-exhausted');
      const stepId = operationId('agent-step:' + turnId + ':' + (counts.steps + 1));
      const inputs = pendingInputs.map(inputFromRow);
      const snapshot = { ...snapshotBase, inputIds: inputs.map(i => i.inputId), notificationIds: notifications.map(n => n.notificationId) };
      await tx.query(`INSERT INTO agent_steps(step_id,turn_id,step_no,state,snapshot) VALUES($1,$2,$3,'generating',$4)`,
        [stepId, turnId, counts.steps + 1, snapshot]);
      for (const input of inputs) await tx.query("UPDATE agent_inputs SET state='adopted', adopted_step_id=$2 WHERE input_id=$1 AND state='pending'", [input.inputId, stepId]);
      // Persist which real answers this Session's model has actually been shown, across Steps and Turns.
      const answerInputs = inputs.filter(input => input.input.context && typeof input.input.context === 'object'
        && 'questionId' in (input.input.context as object));
      if (answerInputs.length) {
        const { rows: [sessionRow] } = await tx.query('SELECT state FROM agent_runtime_sessions WHERE session_id=$1 FOR UPDATE', [sessionId]);
        const current = (sessionRow?.state ?? {}) as Facts;
        const inbox = Array.isArray(current.answerInbox) ? current.answerInbox as Facts[] : [];
        const additions = answerInputs.map(input => ({ questionId: (input.input.context as Facts).questionId,
          inputId: input.inputId, version: (input.input.context as { questionVersion?: number }).questionVersion ?? 1 }));
        const merged = [...inbox.filter(item => !additions.some(next => next.questionId === item.questionId)), ...additions];
        await tx.query('UPDATE agent_runtime_sessions SET state=$2 WHERE session_id=$1', [sessionId, { ...current, answerInbox: merged }]);
      }
      for (const n of notifications) await tx.query("UPDATE agent_notifications SET state='adopted', consumed_by_step_id=$2 WHERE notification_id=$1 AND state='pending'", [n.notificationId, stepId]);
      await appendEvent(tx, sessionId, 'step-started', { turnId, stepId, stepNo: counts.steps + 1, inputIds: snapshot.inputIds, notificationIds: snapshot.notificationIds });
      const { rows: [stepRow] } = await tx.query('SELECT * FROM agent_steps WHERE step_id=$1', [stepId]);
      return { kind: 'step' as const, step: stepFromRow(stepRow!), inputs, notifications };
    });
  }
  async function saveAttempt(stepId: string, attempt: { attemptId: string; attemptNo: number; requestRef: string | null; reserved: { inputTokens: number; outputTokens: number } }) {
    const sessionId = (await storage.read('SELECT t.session_id FROM agent_steps s JOIN agent_turns t USING(turn_id) WHERE s.step_id=$1', [stepId])).rows[0]?.session_id as string;
    return transition(sessionId, async tx => {
      const { rows: [step] } = await tx.query('SELECT turn_id FROM agent_steps WHERE step_id=$1', [stepId]);
      if (!step) throw new StorageError('missing');
      await ownedTurn(tx, String(step.turn_id));
      const { rows: [inserted] } = await tx.query(`INSERT INTO agent_attempts(attempt_id,step_id,attempt_no,state,request_ref,reserved,usage) VALUES($1,$2,$3,'pending',$4,$5,$6)
        ON CONFLICT(attempt_id) DO NOTHING RETURNING attempt_id`,
        [attempt.attemptId, stepId, attempt.attemptNo, attempt.requestRef, attempt.reserved,
          { state: 'unknown', inputTokens: attempt.reserved.inputTokens, outputTokens: attempt.reserved.outputTokens }]);
      if (!inserted) return;
      // The reservation enters the ledger atomically with the Attempt; no later deduction of an unbooked reserve.
      const turnId = String(step.turn_id);
      const usage = await usageOf(tx, turnId);
      const budget = await budgetRow(tx, turnId);
      const next: TurnUsage = { inputTokens: usage.inputTokens + attempt.reserved.inputTokens,
        outputTokens: usage.outputTokens + attempt.reserved.outputTokens, inputReserved: 0, outputReserved: 0 };
      if (next.inputTokens > budget.maxInputTokens) throw new AgentError('input-budget-exhausted');
      if (next.outputTokens > budget.maxOutputTokens) throw new AgentError('output-budget-exhausted');
      await tx.query('UPDATE agent_turns SET usage=$2, updated_at=clock_timestamp() WHERE turn_id=$1', [turnId, next]);
    });
  }
  async function finishAttempt(stepId: string, attemptId: string, value: { state: AgentAttempt['state']; usage: AgentAttempt['usage']; responseRef: string | null; error: string | null }) {
    const sessionId = (await storage.read('SELECT t.session_id FROM agent_steps s JOIN agent_turns t USING(turn_id) WHERE s.step_id=$1', [stepId])).rows[0]?.session_id as string;
    return transition(sessionId, async tx => {
      const { rows: [a] } = await tx.query('SELECT * FROM agent_attempts WHERE attempt_id=$1 FOR UPDATE', [attemptId]);
      if (!a) throw new StorageError('missing');
      const { rows: [step] } = await tx.query('SELECT turn_id FROM agent_steps WHERE step_id=$1', [stepId]);
      await ownedTurn(tx, String(step!.turn_id));
      await tx.query('UPDATE agent_attempts SET state=$2, usage=$3, response_ref=$4, error=$5, updated_at=clock_timestamp() WHERE attempt_id=$1',
        [attemptId, value.state, value.usage, value.responseRef, value.error]);
      // Replace this Attempt's recorded contribution exactly once; duplicate settlements contribute zero.
      const turnId = String(step!.turn_id);
      const usage = await usageOf(tx, turnId);
      const reserved = a.reserved as { inputTokens: number; outputTokens: number };
      const prior = usageContribution(a.usage as AgentAttempt['usage'], reserved);
      const current = usageContribution(value.usage, reserved);
      const next: TurnUsage = { inputTokens: usage.inputTokens - prior.inputTokens + current.inputTokens,
        outputTokens: usage.outputTokens - prior.outputTokens + current.outputTokens, inputReserved: 0, outputReserved: 0 };
      if (next.inputTokens < 0 || next.outputTokens < 0) throw new StorageError('corrupt');
      await tx.query('UPDATE agent_turns SET usage=$2, updated_at=clock_timestamp() WHERE turn_id=$1', [turnId, next]);
    });
  }
  /** Save the unique selected response and its whole tool batch (≤8). >8 is a protocol error handled by the loop. */
  async function saveResponse(stepId: string, attemptId: string, response: { text: string; toolIntents: readonly { callId: string; name: string; arguments: Facts }[]; resultRef: string | null }, toolCalls: { toolCallId: string; nativeCallId: string; name: string; input: Facts; executionMode: 'foreground' | 'background' }[]) {
    const sessionId = (await storage.read('SELECT t.session_id FROM agent_steps s JOIN agent_turns t USING(turn_id) WHERE s.step_id=$1', [stepId])).rows[0]?.session_id as string;
    return transition(sessionId, async tx => {
      const { rows: [step] } = await tx.query('SELECT * FROM agent_steps WHERE step_id=$1 FOR UPDATE', [stepId]);
      if (!step) throw new StorageError('missing');
      await ownedTurn(tx, String(step.turn_id));
      // A response may only fill a Step that is still generating; a closed Step is never reopened.
      if (String(step.state) !== 'generating') throw new StorageError('conflict');
      await tx.query("UPDATE agent_steps SET state='executing', updated_at=clock_timestamp() WHERE step_id=$1", [stepId]);
      for (let index = 0; index < toolCalls.length; index++) {
        const call = toolCalls[index]!;
        await tx.query(`INSERT INTO agent_tool_calls(tool_call_id,step_id,call_index,native_call_id,name,input,execution_mode,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,'pending') ON CONFLICT(tool_call_id) DO NOTHING`,
          [call.toolCallId, stepId, index, call.nativeCallId, call.name, call.input, call.executionMode]);
      }
      await appendEvent(tx, sessionId, 'assistant', { turnId: step.turn_id, stepId, attemptId, text: response.text, resultRef: response.resultRef });
      for (const call of toolCalls) await appendEvent(tx, sessionId, 'tool-prepared', { turnId: step.turn_id, stepId, toolCallId: call.toolCallId, name: call.name, callId: call.nativeCallId });
    });
  }
  async function startToolCall(toolCallId: string): Promise<boolean> {
    const { rows: [row] } = await storage.read(`SELECT t.session_id, t.turn_id, t.state AS turn_state, t.owner_instance_id, c.state FROM agent_tool_calls c
      JOIN agent_steps s USING(step_id) JOIN agent_turns t USING(turn_id) WHERE c.tool_call_id=$1`, [toolCallId]);
    if (!row) throw new StorageError('missing');
    if (row.turn_state !== 'active' || row.owner_instance_id !== ownerInstanceId) return false;
    return transition(String(row.session_id), async tx => {
      await ownedTurn(tx, String(row.turn_id));
      const { rows: [updated] } = await tx.query("UPDATE agent_tool_calls SET state='started', updated_at=clock_timestamp() WHERE tool_call_id=$1 AND state='pending' RETURNING tool_call_id", [toolCallId]);
      return !!updated;
    });
  }
  async function saveToolResult(toolCallId: string, result: AgentToolResult, taskId: string | null): Promise<boolean> {
    const parsed = agentToolResultSchema.parse(result);
    const { rows: [row] } = await storage.read(`SELECT t.session_id, t.turn_id, t.state AS turn_state, t.owner_instance_id, c.step_id FROM agent_tool_calls c
      JOIN agent_steps s USING(step_id) JOIN agent_turns t USING(turn_id) WHERE c.tool_call_id=$1`, [toolCallId]);
    if (!row) throw new StorageError('missing');
    return transition(String(row.session_id), async tx => {
      const turn = await turnRow(tx, String(row.turn_id));
      // A background task accepted after Stop is a real fact that must be registered for cancellation.
      const lateAcceptance = parsed.kind === 'accepted' && String(turn.state) === 'stopped' && String(turn.owner_instance_id) === ownerInstanceId;
      if (lateAcceptance && options.assertOwner && !options.assertOwner()) throw new StorageError('stale-generation');
      if (!lateAcceptance) assertActive(turn);
      const { rows: [saved] } = await tx.query('SELECT state,result FROM agent_tool_calls WHERE tool_call_id=$1 FOR UPDATE', [toolCallId]);
      if (saved!.state === 'closed') {
        if (canonicalDigest(saved!.result) === canonicalDigest(parsed)) return false;
        // A late real acceptance replaces the placeholder Stop wrote; any other rewrite is a conflict.
        if (!lateAcceptance) throw new StorageError('identity-conflict');
      }
      await tx.query("UPDATE agent_tool_calls SET state='closed', result=$2, task_id=$3, updated_at=clock_timestamp() WHERE tool_call_id=$1", [toolCallId, parsed, taskId]);
      await appendEvent(tx, String(row.session_id), 'tool-result', { turnId: row.turn_id, stepId: row.step_id, toolCallId, result: parsed });
      if (lateAcceptance) {
        // Re-arm the durable intent so the runner (or a successor after restart) cancels the real task.
        const requestId = operationId('agent-cancel-turn:' + row.turn_id);
        await tx.query(`UPDATE agent_controls SET body=jsonb_set(body,'{state}','"pending"')
          WHERE request_id=$1 AND operation='cancel-turn' AND body->>'state'<>'pending'`, [requestId]);
        return true;
      }
      return false;
    });
  }
  async function completeStep(stepId: string): Promise<void> {
    const { rows: [row] } = await storage.read(`SELECT t.session_id, s.turn_id FROM agent_steps s JOIN agent_turns t USING(turn_id) WHERE s.step_id=$1`, [stepId]);
    if (!row) throw new StorageError('missing');
    return transition(String(row.session_id), async tx => {
      await ownedTurn(tx, String(row.turn_id));
      const { rows: [step] } = await tx.query('SELECT state FROM agent_steps WHERE step_id=$1 FOR UPDATE', [stepId]);
      if (!step) throw new StorageError('missing');
      if (String(step.state) === 'completed') return;
      if (!['generating', 'executing'].includes(String(step.state))) throw new StorageError('conflict');
      const { rows: [open] } = await tx.query("SELECT tool_call_id FROM agent_tool_calls WHERE step_id=$1 AND state<>'closed' LIMIT 1", [stepId]);
      if (open) throw new StorageError('conflict');
      await tx.query("UPDATE agent_steps SET state='completed', completed_at=clock_timestamp(), updated_at=clock_timestamp() WHERE step_id=$1", [stepId]);
      await appendEvent(tx, String(row.session_id), 'step-completed', { turnId: row.turn_id, stepId });
    });
  }
  /** Atomic finish: a notification/input arriving before this commit keeps the Turn alive. */
  async function finishTurn(turnId: string, state: 'completed' | 'failed', reason: string): Promise<boolean> {
    const { rows: [row] } = await storage.read('SELECT session_id FROM agent_turns WHERE turn_id=$1', [turnId]);
    if (!row) throw new StorageError('missing');
    const sessionId = String(row.session_id);
    return transition(sessionId, async tx => {
      const current = await turnRow(tx, turnId);
      if (current.state !== 'active') return false;
      // A host that lost ownership never closes the Turn; its successor repairs the open facts.
      if (String(current.owner_instance_id) !== ownerInstanceId || (options.assertOwner && !options.assertOwner())) return false;
      if (state === 'completed') {
        const { rows: [pending] } = await tx.query("SELECT input_id FROM agent_inputs WHERE turn_id=$1 AND state='pending' LIMIT 1", [turnId]);
        const { rows: [notif] } = await tx.query("SELECT notification_id FROM agent_notifications WHERE session_id=$1 AND state='pending' LIMIT 1", [sessionId]);
        if (pending || notif) return false;
      }
      if (options.assertOwner && !options.assertOwner()) return false;
      await tx.query('UPDATE agent_turns SET state=$2, reason=$3, completed_at=clock_timestamp(), updated_at=clock_timestamp() WHERE turn_id=$1', [turnId, state, reason]);
      if (state === 'failed' && reason === 'budget_exhausted')
        await tx.query("UPDATE agent_runtime_sessions SET automatic_wake_blocked='budget_exhausted' WHERE session_id=$1", [sessionId]);
      // A failed Turn closes its own Step/Attempt/ToolCall/Question facts in the same commit.
      if (state === 'failed') await closeTurnCalls(tx, sessionId, turnId, reason, 'failed');
      await appendEvent(tx, sessionId, 'turn-' + state, { turnId, reason });
      // Roll back the whole transition if ownership disappeared while closing child facts.
      if (options.assertOwner && !options.assertOwner()) throw new StorageError('stale-generation');
      return true;
    });
  }
  async function budgetRow(tx: OwnedTransaction, turnId: string): Promise<AgentTurnBudget> {
    const { rows: [row] } = await tx.query('SELECT budget FROM agent_turns WHERE turn_id=$1', [turnId]);
    if (!row) throw new StorageError('missing');
    return agentTurnBudgetSchema.parse(row.budget);
  }
  async function budgetOf(turnId: string): Promise<{ budget: AgentTurnBudget; usage: TurnUsage; counts: { steps: number; toolCalls: number } }> {
    const { rows: [row] } = await storage.read('SELECT budget, usage FROM agent_turns WHERE turn_id=$1', [turnId]);
    if (!row) throw new StorageError('missing');
    const { rows: [counts] } = await storage.read(`SELECT
      (SELECT count(*) FROM agent_steps WHERE turn_id=$1) AS steps,
      (SELECT count(*) FROM agent_tool_calls c JOIN agent_steps s USING(step_id) WHERE s.turn_id=$1) AS tool_calls`, [turnId]);
    return { budget: agentTurnBudgetSchema.parse(row.budget), usage: { ...emptyUsage, ...(row.usage as TurnUsage) },
      counts: { steps: Number(counts!.steps), toolCalls: Number(counts!.tool_calls) } };
  }
  /** Compaction attempts are recorded with attempt_no >= 100 on the current Step, so this count survives restart. */
  async function compactionCount(turnId: string): Promise<number> {
    const { rows: [row] } = await storage.read(`SELECT count(*) AS n FROM agent_attempts a JOIN agent_steps s USING(step_id)
      WHERE s.turn_id=$1 AND a.attempt_no>=100`, [turnId]);
    return Number(row!.n);
  }
  async function stepsOf(turnId: string): Promise<AgentStep[]> {
    const { rows } = await storage.read('SELECT * FROM agent_steps WHERE turn_id=$1 ORDER BY step_no', [turnId]);
    return rows.map(stepFromRow);
  }
  /** Adopted real inputs whose text the model has never seen in history (e.g. a failed first generate). */
  async function visibleInputs(sessionId: string, exclude: readonly string[]): Promise<{ id: string; version: number; text: string }[]> {
    const { rows } = await storage.read(`SELECT input_id, version, body FROM agent_inputs
      WHERE session_id=$1 AND state='adopted' ORDER BY seq`, [sessionId]);
    return rows.filter(row => !exclude.includes(String(row.input_id)))
      .map(row => ({ id: String(row.input_id), version: Number(row.version), text: String((row.body as { text?: string }).text ?? '') }));
  }
  /** The stable real user request of this Turn: the latest non-answer input, never a system answer. */
  async function turnOriginInput(turnId: string): Promise<string | null> {
    const { rows } = await storage.read(`SELECT input_id, body FROM agent_inputs
      WHERE turn_id=$1 AND state='adopted' ORDER BY seq`, [turnId]);
    let origin: string | null = null;
    for (const row of rows) if (!row.body || typeof row.body !== 'object' || !('questionId' in ((row.body as { context?: object }).context ?? {}))) origin = String(row.input_id);
    return origin;
  }
  /** Every adopted input of this Session that carries a trusted workspace action, in original order. */
  async function workspaceInputs(sessionId: string): Promise<{ inputId: string; action: Facts }[]> {
    const { rows } = await storage.read(`SELECT input_id, version, body FROM agent_inputs
      WHERE session_id=$1 AND state='adopted' AND body->'context'->'action' IS NOT NULL ORDER BY seq`, [sessionId]);
    return rows.map(row => ({ inputId: String(row.input_id), action: (row.body as { context: { action: Facts } }).context.action }));
  }
  /** Real persisted results for a recovered native batch, keyed by the original native call id. */
  async function toolResultsByNative(sessionId: string, nativeCallIds: readonly string[]): Promise<Map<string, AgentToolResult | null>> {
    const found = new Map<string, AgentToolResult | null>();
    for (const nativeCallId of nativeCallIds) {
      const { rows: [row] } = await storage.read(`SELECT c.result FROM agent_tool_calls c
        JOIN agent_steps s USING(step_id) JOIN agent_turns t USING(turn_id)
        WHERE t.session_id=$1 AND c.native_call_id=$2 ORDER BY c.updated_at DESC LIMIT 1`, [sessionId, nativeCallId]);
      if (row) found.set(nativeCallId, row.result ? agentToolResultSchema.parse(row.result) : null);
    }
    return found;
  }
  async function toolCallsOf(stepId: string): Promise<AgentToolCall[]> {
    const { rows } = await storage.read('SELECT * FROM agent_tool_calls WHERE step_id=$1 ORDER BY call_index', [stepId]);
    return rows.map(toolCallFromRow);
  }
  async function attemptsOf(stepId: string): Promise<AgentAttempt[]> {
    const { rows } = await storage.read('SELECT * FROM agent_attempts WHERE step_id=$1 ORDER BY attempt_no', [stepId]);
    return rows.map(attemptFromRow);
  }
  async function sessionState(sessionId: string): Promise<Facts> {
    const { rows: [row] } = await storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1', [sessionId]);
    if (!row) throw new StorageError('missing');
    return facts(row.state);
  }
  async function setSessionState(sessionId: string, state: Facts, turnId?: string): Promise<void> {
    return transition(sessionId, async tx => {
      if (turnId) await ownedTurn(tx, turnId);
      await tx.query('UPDATE agent_runtime_sessions SET state=$2 WHERE session_id=$1', [sessionId, state]);
    });
  }
  async function recordProgress(sessionId: string, attemptId: string, progress: { revision: number; text: string; tools?: readonly unknown[] | undefined }) {
    return transition(sessionId, async tx => {
      const { rows: [step] } = await tx.query('SELECT s.step_id, s.turn_id FROM agent_attempts a JOIN agent_steps s USING(step_id) WHERE a.attempt_id=$1', [attemptId]);
      if (!step) throw new StorageError('missing');
      await ownedTurn(tx, String(step.turn_id));
      const { rows: [same] } = await tx.query('SELECT body FROM agent_progress WHERE attempt_id=$1 AND revision=$2', [attemptId, progress.revision]);
      if (same) return false;
      const { rows: [last] } = await tx.query('SELECT max(revision) AS revision FROM agent_progress WHERE attempt_id=$1', [attemptId]);
      if (Number(last!.revision ?? 0) >= progress.revision) return false;
      const eventId = operationId('agent-progress:' + attemptId + ':' + progress.revision);
      await appendEvent(tx, sessionId, 'model-progress', { turnId: step.turn_id, stepId: step.step_id, attemptId, ...progress }, eventId);
      await tx.query('INSERT INTO agent_progress(attempt_id,revision,body,event_id) VALUES($1,$2,$3,$4)', [attemptId, progress.revision, progress, eventId]);
      return true;
    });
  }

  // ---- questions ----
  async function saveQuestion(value: { questionId: string; sessionId: string; turnId: string; stepId: string; toolCallId: string; presentation: Facts; deadline: string | null }) {
    return transition(value.sessionId, async tx => {
      await ownedTurn(tx, value.turnId);
      const proposalKey = typeof value.presentation.proposalKey === 'string' ? value.presentation.proposalKey : null;
      const contentDigest = value.presentation.personalProjectContent ? canonicalDigest(value.presentation.personalProjectContent) : null;
      await tx.query(`INSERT INTO agent_questions(question_id,session_id,turn_id,step_id,tool_call_id,version,state,presentation,deadline,proposal_key,content_digest)
        VALUES($1,$2,$3,$4,$5,1,'pending',$6,$7,$8,$9) ON CONFLICT(question_id) DO NOTHING`,
        [value.questionId, value.sessionId, value.turnId, value.stepId, value.toolCallId, value.presentation, value.deadline, proposalKey, contentDigest]);
      await appendEvent(tx, value.sessionId, 'question-opened', { turnId: value.turnId, stepId: value.stepId, toolCallId: value.toolCallId, questionId: value.questionId, presentation: value.presentation, deadline: value.deadline });
    });
  }
  async function question(questionId: string): Promise<AgentQuestion | null> {
    const { rows: [row] } = await storage.read('SELECT * FROM agent_questions WHERE question_id=$1', [questionId]);
    return row ? questionFromRow(row) : null;
  }
function answerText(presentation: Facts, answer: Facts): string {
  if (answer.kind === 'text' && typeof answer.text === 'string') return answer.text;
  if (answer.kind === 'choice' && typeof answer.optionId === 'string') {
    const options = Array.isArray(presentation.options) ? presentation.options as { id?: unknown; label?: unknown }[] : [];
    const option = options.find(item => item.id === answer.optionId);
    return typeof option?.label === 'string' ? option.label : answer.optionId;
  }
  return '（跳过）';
}

  async function answerQuestion(sessionId: string, value: AgentQuestionResponse, validate?: (presentation: Facts, answer: Facts) => Promise<void>) {
    const fingerprint = canonicalDigest({ sessionId, value });
    let validationFailure: { error: unknown } | undefined;
    const receipt = await storage.request({ requestId: 'agent-answer:' + value.requestId, fingerprint }, async tx => {
      await tx.query('SELECT session_id FROM agent_runtime_sessions WHERE session_id=$1 FOR UPDATE', [sessionId]);
      const { rows: [row] } = await tx.query('SELECT * FROM agent_questions WHERE question_id=$1 AND session_id=$2 FOR UPDATE', [value.questionId, sessionId]);
      if (!row) throw new StorageError('missing');
      const q = questionFromRow(row);
      await ownedTurn(tx, q.turnId);
      if (q.state !== 'pending' || q.version !== value.expectedVersion) throw new StorageError('conflict');
      if (q.deadline && Date.parse(q.deadline) <= now()) throw new StorageError('conflict');
      if (validate) { try { await validate(q.presentation, value.answer as Facts); } catch (error) { validationFailure = { error }; throw error; } }
      const answer = value.answer as Facts;
      const skipped = (answer as { kind?: string }).kind === 'skip';
      await tx.query("UPDATE agent_questions SET state=$2, version=version+1, answer=$3, answer_request_id=$4, updated_at=clock_timestamp() WHERE question_id=$1",
        [value.questionId, skipped ? 'skipped' : 'answered', answer, value.requestId]);
      await appendEvent(tx, sessionId, skipped ? 'question-skipped' : 'question-answered', { turnId: q.turnId, questionId: value.questionId, questionVersion: q.version + 1, answer, requestId: value.requestId });
      // The real answer enters the Turn as a SessionInput so a later Step has it in its model-visible input range.
      const version = q.version + 1;
      const input = agentInputSchema.parse({ requestId: value.requestId, sessionId,
        text: answerText(q.presentation, answer),
        context: { questionId: value.questionId, questionVersion: version, kind: typeof answer.kind === 'string' ? answer.kind : 'skip' } });
      const inputId = operationId('agent-answer-input:' + value.questionId + ':' + version);
      const received = await appendEvent(tx, sessionId, 'input-received', { turnId: q.turnId, inputId, input });
      await tx.query(`INSERT INTO agent_inputs(input_id,request_id,session_id,turn_id,seq,body,input_digest,original_body)
        VALUES($1,$2,$3,$4,$5,$6,$7,$6) ON CONFLICT(request_id) DO NOTHING`,
      [inputId, value.requestId, sessionId, q.turnId, received.seq, input, canonicalDigest(input)]);
      return { requestId: value.requestId, questionId: value.questionId, questionVersion: version, turnId: q.turnId, status: 'accepted' as const, reason: '' };
    }).catch(error => { throw validationFailure ? validationFailure.error : error; });
    return receipt.result as { requestId: string; questionId: string; questionVersion: number; turnId: string; status: 'accepted'; reason: string };
  }
  async function closeQuestion(questionId: string, state: 'closed' | 'expired') {
    const { rows: [row] } = await storage.read('SELECT session_id, turn_id FROM agent_questions WHERE question_id=$1', [questionId]);
    if (!row) return;
    return transition(String(row.session_id), async tx => {
      const { rows: [updated] } = await tx.query("UPDATE agent_questions SET state=$2, version=version+1, updated_at=clock_timestamp() WHERE question_id=$1 AND state='pending' RETURNING question_id", [questionId, state]);
      if (updated) await appendEvent(tx, String(row.session_id), 'question-' + state, { turnId: row.turn_id, questionId });
    });
  }

  // ---- notifications ----
  async function registerNotification(sessionId: string, originTurnId: string, fact: TaskTerminalFact): Promise<{ notificationId: string; turnId: string | null }> {
    const notificationId = operationId('agent-notification:' + fact.taskId + ':' + fact.taskVersion);
    const body = { sessionId, originTurnId, fact }, fingerprint = canonicalDigest(body);
    const result = await storage.request({ requestId: 'agent-notification:' + notificationId, fingerprint }, async tx => {
      const { rows: [locked] } = await tx.query('SELECT body, automatic_wake_blocked FROM agent_runtime_sessions WHERE session_id=$1 FOR UPDATE', [sessionId]);
      if (!locked) throw new StorageError('missing');
      await tx.query(`INSERT INTO agent_notifications(notification_id,session_id,origin_turn_id,task_id,task_version,terminal_status,summary,result_ref,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending') ON CONFLICT(task_id,task_version) DO NOTHING`,
        [notificationId, sessionId, originTurnId, fact.taskId, fact.taskVersion, fact.terminalStatus, fact.summary, fact.resultRef]);
      // Only the newest pending terminal fact per task may wait; an older pending version is superseded.
      await tx.query("UPDATE agent_notifications SET state='suppressed' WHERE session_id=$1 AND task_id=$2 AND state='pending' AND notification_id<>$3",
        [sessionId, fact.taskId, notificationId]);
      const { rows: [existing] } = await tx.query('SELECT state FROM agent_notifications WHERE notification_id=$1', [notificationId]);
      if (existing!.state !== 'pending') return { notificationId, turnId: null };
      const { rows: [origin] } = await tx.query('SELECT session_id, state FROM agent_turns WHERE turn_id=$1', [originTurnId]);
      const originState = origin && String(origin.session_id) === sessionId ? String(origin.state) : 'missing';
      // Only a same-Session active/completed Turn can feed a model context or auto-wake. A stopped
      // origin still leaves the fact pending for its durable record; adoption rechecks and suppresses it.
      if (!['active', 'completed'].includes(originState)) return { notificationId, turnId: null };
      const active = await activeTurn(tx, sessionId);
      // Only a normally completed origin may auto-open a new Turn when idle; stopped/interrupted/failed never wake.
      if (!active && originState === 'completed' && !locked.automatic_wake_blocked) {
        const turnId = await insertTurn(tx, sessionId, notificationId, 'task-notification', notificationId);
        await appendEvent(tx, sessionId, 'turn-started', { turnId, trigger: 'task-notification', notificationId });
        return { notificationId, turnId };
      }
      return { notificationId, turnId: null };
    });
    const outcome = result.result as { notificationId: string; turnId: string | null };
    if (outcome.turnId) return outcome;
    // A retried delivery still evaluates the current idle state instead of replaying a stale null.
    const turnId = await transition(sessionId, tx => maybeOpenPendingTurn(tx, sessionId));
    return { notificationId: outcome.notificationId, turnId };
  }
  async function notificationsOf(sessionId: string): Promise<AgentNotification[]> {
    const { rows } = await storage.read('SELECT * FROM agent_notifications WHERE session_id=$1 ORDER BY created_at,notification_id', [sessionId]);
    return rows.map(notificationFromRow);
  }

  // ---- stop / interruption ----
  async function stopTurn(sessionId: string, turnId: string, requestId: string): Promise<{ turn: AgentTurn; stopped: boolean }> {
    const body = { sessionId, turnId, requestId }, fingerprint = canonicalDigest(body);
    const outcome = await storage.request({ requestId: 'agent-stop:' + requestId, fingerprint }, async tx => {
      await tx.query('SELECT session_id FROM agent_runtime_sessions WHERE session_id=$1 FOR UPDATE', [sessionId]);
      const row = await turnRow(tx, turnId);
      if (String(row.session_id) !== sessionId) throw new StorageError('missing');
      const stopped = row.state === 'active';
      if (stopped) {
        // stopped and the durable cancellation intent commit together.
        await tx.query("UPDATE agent_turns SET state='stopped', reason='student-stop', completed_at=clock_timestamp(), updated_at=clock_timestamp() WHERE turn_id=$1", [turnId]);
        await tx.query(`INSERT INTO agent_controls(request_id,session_id,turn_id,operation,input_digest,body)
          VALUES($1,$2,$3,'cancel-turn',$4,$5) ON CONFLICT(request_id) DO NOTHING`,
          [operationId('agent-cancel-turn:' + turnId), sessionId, turnId, fingerprint, { turnId, sessionId, state: 'pending', delivered: [] }]);
        // Stop quiesces the Turn's own open facts; an in-flight tool becomes a real unknown, never a late success.
        await closeTurnCalls(tx, sessionId, turnId, 'turn-stopped', 'interrupted');
        await appendEvent(tx, sessionId, 'turn-stopped', { turnId, requestId });
        // An already-pending notification from a normally completed origin wakes now that the Session is idle.
        await maybeOpenPendingTurn(tx, sessionId);
      }
      await tx.query("INSERT INTO agent_controls(request_id,session_id,turn_id,operation,input_digest,body) VALUES($1,$2,$3,'stop',$4,$5) ON CONFLICT(request_id) DO NOTHING",
        [requestId, sessionId, turnId, fingerprint, body]);
      return stopped;
    });
    return { turn: await turn(sessionId, turnId), stopped: outcome.result === true };
  }
  async function pendingCancellations(): Promise<{ turnId: string; sessionId: string; delivered: string[] }[]> {
    const { rows } = await storage.read("SELECT body FROM agent_controls WHERE operation='cancel-turn' AND body->>'state'='pending' ORDER BY turn_id");
    return rows.map(row => { const b = row.body as { turnId: string; sessionId: string; delivered?: string[] }; return { turnId: b.turnId, sessionId: b.sessionId, delivered: b.delivered ?? [] }; });
  }
  /** A timeout cancels one call, never its sibling tasks or the entire Turn. */
  async function requestCallCancellation(turnId: string, toolCallId: string, reference: ToolEffectReference) {
    const { rows: [row] } = await storage.read('SELECT session_id FROM agent_turns WHERE turn_id=$1', [turnId]);
    if (!row) throw new StorageError('missing');
    const sessionId = String(row.session_id);
    const requestId = operationId('agent-cancel-call:' + toolCallId + ':' + canonicalDigest(reference));
    const body = { requestId, sessionId, turnId, toolCallId, reference, state: 'pending' };
    return transition(sessionId, async tx => {
      const current = await turnRow(tx, turnId);
      if (current.owner_instance_id !== ownerInstanceId || (options.assertOwner && !options.assertOwner()))
        throw new StorageError('stale-generation');
      const { rows: [call] } = await tx.query('SELECT c.tool_call_id FROM agent_tool_calls c JOIN agent_steps s USING(step_id) WHERE s.turn_id=$1 AND c.tool_call_id=$2', [turnId, toolCallId]);
      if (!call) throw new StorageError('missing');
      await tx.query(`INSERT INTO agent_controls(request_id,session_id,turn_id,operation,input_digest,body)
        VALUES($1,$2,$3,'cancel-call',$4,$5) ON CONFLICT(request_id) DO NOTHING`,
        [requestId, sessionId, turnId, canonicalDigest(reference), body]);
      if (options.assertOwner && !options.assertOwner()) throw new StorageError('stale-generation');
      return body;
    });
  }
  async function pendingCallCancellations(): Promise<{ requestId: string; sessionId: string; turnId: string; toolCallId: string; reference: ToolEffectReference }[]> {
    const { rows } = await storage.read("SELECT body FROM agent_controls WHERE operation='cancel-call' AND body->>'state'='pending' ORDER BY request_id");
    return rows.map(row => row.body as { requestId: string; sessionId: string; turnId: string; toolCallId: string; reference: ToolEffectReference });
  }
  async function acknowledgeCallCancellation(requestId: string) {
    const nonce = randomUUID();
    await storage.request({ requestId: 'agent-call-cancel-ack:' + nonce, fingerprint: nonce }, async tx => {
      await tx.query("UPDATE agent_controls SET body=jsonb_set(body,'{state}','\"delivered\"') WHERE request_id=$1 AND operation='cancel-call'", [requestId]);
      return null;
    });
  }
  async function acknowledgeCancellation(turnId: string, delivered: string[], done: boolean) {
    const requestId = operationId('agent-cancel-turn:' + turnId);
    await storage.request({ requestId: 'agent-cancel-ack:' + requestId + ':' + canonicalDigest(delivered) + ':' + done, fingerprint: requestId }, async tx => {
      const { rows: [row] } = await tx.query('SELECT body FROM agent_controls WHERE request_id=$1 FOR UPDATE', [requestId]);
      if (!row) return null;
      const body = row.body as { turnId: string; sessionId: string; state: string; delivered: string[] };
      await tx.query('UPDATE agent_controls SET body=$2 WHERE request_id=$1', [requestId, { ...body, delivered, state: done ? 'delivered' : 'pending' }]);
      return null;
    });
  }
  /** Cross-machine adapters verify a live Step before executing the real call; no loop phase owns a permit. */
  async function assertDispatch(value: AgentDispatchPermit): Promise<null> {
    const permit = agentDispatchPermitSchema.parse(value);
    const { rows: [row] } = await storage.read(`SELECT t.state AS turn_state, t.budget, s.state AS step_state
      FROM agent_turns t JOIN agent_steps s USING(turn_id) WHERE t.session_id=$1 AND t.turn_id=$2 AND s.step_id=$3`,
    [permit.sessionId, permit.runId, permit.stepId]);
    const deadline = row ? (row.budget as AgentTurnBudget).deadline : null;
    if (!row || row.turn_state !== 'active' || !['generating', 'executing'].includes(String(row.step_state))
      || (deadline !== null && now() >= Date.parse(deadline))) throw new StorageError('stale-generation');
    return null;
  }
  /** Startup repair: only the lock holder closes a previous owner's active Turns to interrupted. */
  async function recoverInterrupted(allActive = false): Promise<string[]> {
    const result = await storage.request({ requestId: 'agent-recover:' + randomUUID(), fingerprint: 'interrupt-old-owner:' + randomUUID() }, async tx => {
      const { rows } = allActive
        ? await tx.query("UPDATE agent_turns SET state='interrupted', reason='host-restart', completed_at=clock_timestamp(), updated_at=clock_timestamp() WHERE state='active' RETURNING turn_id, session_id")
        : await tx.query("UPDATE agent_turns SET state='interrupted', reason='host-restart', completed_at=clock_timestamp(), updated_at=clock_timestamp() WHERE state='active' AND owner_instance_id<>$1 RETURNING turn_id, session_id", [ownerInstanceId]);
      for (const row of rows) {
        const turnId = String(row.turn_id), sessionId = String(row.session_id);
        // Question-aware close: a persistent real answer becomes the tool's final result exactly once;
        // an unanswered question is closed; only truly unknown started calls become outcome_unknown.
        await closeTurnCalls(tx, sessionId, turnId, 'host-restart', 'interrupted');
        await appendEvent(tx, sessionId, 'turn-interrupted', { turnId, reason: 'host-restart' });
        await maybeOpenPendingTurn(tx, sessionId);
      }
      // A crash between a terminal Turn commit and its child cleanup leaves open children under terminal
      // Turns. Repair those facts without replaying any model or tool call.
      const { rows: orphaned } = await tx.query(`SELECT t.turn_id, t.session_id FROM agent_turns t
        WHERE t.state IN ('completed','failed','stopped','interrupted') AND (
          EXISTS(SELECT 1 FROM agent_steps s WHERE s.turn_id=t.turn_id AND s.state IN ('generating','executing'))
          OR EXISTS(SELECT 1 FROM agent_tool_calls c JOIN agent_steps s USING(step_id) WHERE s.turn_id=t.turn_id AND c.state<>'closed')
          OR EXISTS(SELECT 1 FROM agent_attempts a JOIN agent_steps s USING(step_id) WHERE s.turn_id=t.turn_id AND a.state='pending')
          OR EXISTS(SELECT 1 FROM agent_questions q WHERE q.turn_id=t.turn_id AND q.state='pending'))`);
      for (const row of orphaned) {
        const turnId = String(row.turn_id), sessionId = String(row.session_id);
        await closeTurnCalls(tx, sessionId, turnId, 'host-restart', 'interrupted');
        await appendEvent(tx, sessionId, 'turn-children-repaired', { turnId, reason: 'host-restart' });
      }
      return rows.map(row => String(row.turn_id));
    });
    return result.result as string[];
  }
  return { storage, session, initialize, submitInput, request, continueSession, inputControl, turn, activeTurnOf, openPendingTurn, events, sessionSnapshot,
    appendEvent: appendEventPublic, openStep, saveAttempt, finishAttempt, saveResponse, startToolCall, saveToolResult,
    completeStep, finishTurn, budgetOf, stepsOf, compactionCount, workspaceInputs, visibleInputs, turnOriginInput, toolCallsOf, toolResultsByNative, attemptsOf, sessionState, setSessionState, recordProgress,
    saveQuestion, question, answerQuestion, closeQuestion, registerNotification, notificationsOf,
    stopTurn, pendingCancellations, acknowledgeCancellation, requestCallCancellation, pendingCallCancellations,
    acknowledgeCallCancellation, recoverInterrupted, assertDispatch, ownerInstanceId };
}
export type AgentStore = ReturnType<typeof createAgentStore>;
