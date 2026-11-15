import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { collectSources, validateSources, type OwnerSourceClosure, type SourceSpec } from '@xunjie/storage/source-closure';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { agentEventSchema, agentInputReceiptSchema, agentInputSchema, agentRuntimeSessionSchema, agentTurnSchema,
  agentToolResultSchema } from '@xunjie/contracts/agent-runtime';
import { z } from 'zod';
import { turnFromRow } from './store.js';

type Row = Record<string, unknown>;
function valid(condition: unknown): asserts condition { if (!condition) throw new StorageError('corrupt'); }
function record(value: unknown): Row { valid(value !== null && typeof value === 'object' && !Array.isArray(value)); return value as Row; }
function parsed<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); valid(result.success); return result.data; }
const factsSchema = z.record(z.string(), z.json());
const integer = (value: unknown, minimum = 0) => value !== null && value !== undefined && Number.isSafeInteger(Number(value)) && Number(value) >= minimum;
const iso = (value: unknown) => new Date(value as string).toISOString();

export const agentRuntimeSourceOwner = 'xunjie.agent-runtime';
const specs: readonly SourceSpec[] = [
  { table: 'agent_runtime_sessions', kind: 'agent_runtime_sessions', id: ['session_id'], version: ['next_seq'] },
  { table: 'agent_turns', kind: 'agent_turns', id: ['turn_id'], version: ['state', 'updated_at'] },
  { table: 'agent_inputs', kind: 'agent_inputs', id: ['input_id'], version: ['version', 'state'] },
  { table: 'agent_steps', kind: 'agent_steps', id: ['step_id'], version: ['state'] },
  { table: 'agent_attempts', kind: 'agent_attempts', id: ['attempt_id'], version: ['state'] },
  { table: 'agent_tool_calls', kind: 'agent_tool_calls', id: ['tool_call_id'], version: ['state'] },
  { table: 'agent_questions', kind: 'agent_questions', id: ['question_id'], version: ['version', 'state'] },
  { table: 'agent_notifications', kind: 'agent_notifications', id: ['notification_id'], version: ['state'] },
  { table: 'agent_events', kind: 'agent_events', id: ['session_id', 'seq'], version: ['event_id'] },
  { table: 'agent_controls', kind: 'agent_controls', id: ['request_id'] },
  { table: 'agent_progress', kind: 'agent_progress', id: ['attempt_id', 'revision'] },
  { table: '_storage_references', kind: 'agent_resource_references', id: ['reference_id'] },
];

async function inspect(storage: OwnedStorage): Promise<OwnerSourceClosure> {
  const { rows } = await storage.read('SELECT name,to_regclass(name) AS relation FROM unnest($1::text[]) AS name', [specs.map(spec => spec.table)]);
  if (rows.some(row => !row.relation)) throw new StorageError('corrupt');
  const tables = new Map(await Promise.all(specs.slice(0, -1).map(async spec =>
    [spec.table, (await storage.read('SELECT * FROM ' + spec.table)).rows] as const)));
  const index = (table: string, key: string) => {
    const rows = tables.get(table)!, result = new Map(rows.map(row => [String(row[key]), row]));
    valid(result.size === rows.length);
    return result;
  };
  const sessions = index('agent_runtime_sessions', 'session_id');
  const turns = index('agent_turns', 'turn_id'), inputs = index('agent_inputs', 'input_id');
  const steps = index('agent_steps', 'step_id'), events = index('agent_events', 'event_id');
  const toolCalls = index('agent_tool_calls', 'tool_call_id');
  const questions = index('agent_questions', 'question_id');
  const terminal = (state: unknown) => ['completed', 'failed', 'stopped', 'interrupted'].includes(String(state));
  const activeBySession = new Map<string, number>();
  for (const turn of turns.values()) {
    try { turnFromRow(turn); } catch { throw new StorageError('corrupt'); }
    valid(sessions.has(String(turn.session_id)));
    valid(terminal(turn.state) ? turn.completed_at !== null : turn.completed_at === null);
    if (turn.state === 'active') activeBySession.set(String(turn.session_id), (activeBySession.get(String(turn.session_id)) ?? 0) + 1);
    const ordered = [...steps.values()].filter(step => step.turn_id === turn.turn_id).sort((a, b) => Number(a.step_no) - Number(b.step_no));
    valid(ordered.every((step, i) => Number(step.step_no) === i + 1));
    valid(ordered.filter(step => ['generating', 'executing'].includes(String(step.state))).length <= 1);
  }
  for (const count of activeBySession.values()) valid(count <= 1);
  for (const session of sessions.values()) {
    valid(parsed(agentRuntimeSessionSchema, session.body).sessionId === session.session_id);
    parsed(factsSchema, session.state);
    valid(integer(session.next_seq, 1));
    const sequence = [...events.values()].filter(event => event.session_id === session.session_id).map(event => Number(event.seq)).sort((a, b) => a - b);
    valid(sequence.every((seq, i) => seq === i + 1) && Number(session.next_seq) === sequence.length + 1);
  }
  for (const input of inputs.values()) {
    valid(turns.get(String(input.turn_id))?.session_id === input.session_id);
    const current = parsed(agentInputSchema, input.body), original = parsed(agentInputSchema, input.original_body);
    const questionId = original.context && typeof original.context.questionId === 'string' ? original.context.questionId : null;
    if (questionId === null) {
      valid(input.input_id === operationId('agent-input:' + original.requestId) && input.request_id === original.requestId);
      valid(current.requestId === original.requestId && current.sessionId === input.session_id && original.sessionId === input.session_id);
      valid(canonicalDigest(original) === input.input_digest);
      valid(integer(input.version, 1) && integer(input.seq, 1));
      valid(['pending', 'adopted', 'removed', 'deferred'].includes(String(input.state)));
      if (input.state === 'adopted') valid(steps.get(String(input.adopted_step_id))?.turn_id === input.turn_id);
      else valid(input.adopted_step_id === null);
      const receipt = await storage.receipt('agent-input:' + original.requestId);
      valid(receipt);
      const fixed = parsed(agentInputReceiptSchema, receipt.result);
      valid(fixed.inputId === input.input_id && fixed.requestId === input.request_id && fixed.sessionId === input.session_id
        && fixed.inputDigest === input.input_digest && turns.get(fixed.turnId)?.session_id === input.session_id);
    } else {
      // A real answer is persisted as a SessionInput under its own immutable answer receipt; it has no
      // agent-input receipt and its id derives from the question version, not the request id.
      const question = questions.get(questionId);
      valid(question && question.session_id === input.session_id);
      const version = Number(original.context?.questionVersion);
      valid(Number.isSafeInteger(version) && version >= 1 && version === Number(question.version));
      valid(['answered', 'skipped'].includes(String(question.state)));
      valid(question.answer_request_id === original.requestId);
      valid(input.input_id === operationId('agent-answer-input:' + questionId + ':' + version) && input.request_id === original.requestId);
      valid(current.requestId === original.requestId && current.sessionId === input.session_id && original.sessionId === input.session_id);
      valid(canonicalDigest(original) === input.input_digest);
      valid(integer(input.version, 1) && integer(input.seq, 1));
      valid(['pending', 'adopted', 'removed', 'deferred'].includes(String(input.state)));
      if (input.state === 'adopted') valid(steps.get(String(input.adopted_step_id))?.turn_id === input.turn_id);
      else valid(input.adopted_step_id === null);
      const receipt = await storage.receipt('agent-answer:' + original.requestId);
      valid(receipt);
      const fixed = record(receipt.result);
      valid(fixed.questionId === questionId && Number(fixed.questionVersion) === version && fixed.requestId === input.request_id);
    }
  }
  for (const step of steps.values()) {
    valid(turns.has(String(step.turn_id)));
    parsed(factsSchema, step.snapshot);
    valid(integer(step.step_no, 1) && step.step_id === operationId('agent-step:' + step.turn_id + ':' + step.step_no));
    valid(['generating', 'executing', 'completed', 'interrupted', 'failed'].includes(String(step.state)));
    const calls = [...toolCalls.values()].filter(call => call.step_id === step.step_id).sort((a, b) => Number(a.call_index) - Number(b.call_index));
    valid(calls.every((call, i) => Number(call.call_index) === i));
    if (step.state === 'completed') valid(calls.every(call => call.state === 'closed'));
  }
  for (const call of toolCalls.values()) {
    valid(steps.has(String(call.step_id)));
    valid(['pending', 'started', 'closed'].includes(String(call.state)));
    valid(['foreground', 'background'].includes(String(call.execution_mode)));
    if (call.state === 'closed') { parsed(agentToolResultSchema, call.result); }
    else valid(call.result === null);
  }
  for (const question of tables.get('agent_questions')!) {
    valid(sessions.has(String(question.session_id)) && turns.has(String(question.turn_id)) && toolCalls.has(String(question.tool_call_id)));
    valid(['pending', 'answered', 'skipped', 'closed', 'expired'].includes(String(question.state)));
    if (question.state === 'answered' || question.state === 'skipped') parsed(factsSchema, question.answer);
  }
  for (const notification of tables.get('agent_notifications')!) {
    valid(sessions.has(String(notification.session_id)));
    valid(['pending', 'adopted', 'suppressed'].includes(String(notification.state)));
    valid(notification.notification_id === operationId('agent-notification:' + notification.task_id + ':' + notification.task_version));
  }
  for (const event of events.values()) {
    try { parsed(agentEventSchema, { sessionId: event.session_id, seq: Number(event.seq), eventId: event.event_id,
      kind: event.kind, version: 1, body: event.body, createdAt: iso(event.created_at) }); }
    catch { throw new StorageError('corrupt'); }
    valid(sessions.has(String(event.session_id)));
    const body = record(event.body);
    if (body.turnId !== undefined) valid(turns.get(String(body.turnId))?.session_id === event.session_id);
  }
  for (const progress of tables.get('agent_progress')!) {
    const event = events.get(String(progress.event_id));
    valid(event && event.kind === 'model-progress');
    valid(integer(progress.revision, 1) && record(progress.body).revision === Number(progress.revision));
    valid(progress.event_id === operationId('agent-progress:' + progress.attempt_id + ':' + progress.revision));
  }
  try { return await collectSources(storage, agentRuntimeSourceOwner, specs); }
  catch (error) {
    if (error instanceof StorageError && ['missing', 'resource-gone', 'corrupt'].includes(error.code)) throw new StorageError('corrupt');
    throw error;
  }
}

/** The host quiesces writes before backup/restore validation. This never dispatches or repairs data. */
export async function validateAgentRuntime(storage: OwnedStorage): Promise<void> { await inspect(storage); }
export function collectAgentRuntimeSources(storage: OwnedStorage): Promise<OwnerSourceClosure> { return inspect(storage); }
export async function validateAgentRuntimeSources(storage: OwnedStorage, material: unknown): Promise<void> {
  await validateAgentRuntime(storage);
  await validateSources(storage, material, agentRuntimeSourceOwner, specs);
}
