import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { collectSources, validateSources, type OwnerSourceClosure, type SourceSpec } from '@xunjie/storage/source-closure';
import { canonicalDigest, operationId } from '@xunjie/storage/identity';
import { agentEventSchema, agentInputReceiptSchema, agentInputSchema, agentOperationSchema, agentRuntimeSessionSchema, agentWaitSchema } from '@xunjie/contracts/agent-runtime';
import { agentInputControlReceiptSchema, agentInputControlSchema, agentOperationResultSchema, agentRunBudgetSchema } from '@xunjie/contracts/agent-service';
import { z } from 'zod';
import { cancellationControlSchema, cancellationDigest, runFromRow } from './store.js';

type Row = Record<string, unknown>;
function valid(condition: unknown): asserts condition { if (!condition) throw new StorageError('corrupt'); }
function record(value: unknown): Row {
  valid(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Row;
}
function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  valid(result.success);
  return result.data;
}
const factsSchema = z.record(z.string(), z.json());
const integer = (value: unknown, minimum = 0) => value !== null && value !== undefined && Number.isSafeInteger(Number(value)) && Number(value) >= minimum;
const iso = (value: unknown) => new Date(value as string).toISOString();

export const agentRuntimeSourceOwner = 'xunjie.agent-runtime';
const specs: readonly SourceSpec[] = [
  { table: 'agent_runtime_sessions', kind: 'agent_runtime_sessions', id: ['session_id'], version: ['next_seq'] },
  { table: 'agent_runs', kind: 'agent_runs', id: ['run_id'], version: ['generation', 'revision'] },
  { table: 'agent_inputs', kind: 'agent_inputs', id: ['input_id'], version: ['version', 'state'] },
  { table: 'agent_steps', kind: 'agent_steps', id: ['step_id'], version: ['state', 'dispatch_generation'] },
  { table: 'agent_waits', kind: 'agent_waits', id: ['wait_id'], version: ['version', 'state'] },
  { table: 'agent_events', kind: 'agent_events', id: ['session_id', 'seq'], version: ['event_id'] },
  { table: 'agent_controls', kind: 'agent_controls', id: ['request_id'] },
  { table: 'agent_progress', kind: 'agent_progress', id: ['operation_id', 'revision'] },
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
  const runs = index('agent_runs', 'run_id'), inputs = index('agent_inputs', 'input_id');
  const operations = index('agent_steps', 'operation_id'), events = index('agent_events', 'event_id');
  const steps = index('agent_steps', 'step_id'), controls = index('agent_controls', 'request_id');
  const terminal = (state: unknown) => ['completed', 'failed', 'stopped'].includes(String(state));
  for (const session of sessions.values()) {
    valid(parsed(agentRuntimeSessionSchema, session.body).sessionId === session.session_id);
    parsed(factsSchema, session.state);
    valid(integer(session.next_seq, 1));
    const sequence = [...events.values()].filter(event => event.session_id === session.session_id).map(event => Number(event.seq)).sort((a, b) => a - b);
    valid(sequence.every((seq, i) => seq === i + 1) && Number(session.next_seq) === sequence.length + 1);
  }
  for (const run of runs.values()) {
    try { runFromRow(run); } catch { throw new StorageError('corrupt'); }
    parsed(factsSchema, run.context);
    valid(integer(run.revision) && integer(run.generation));
    valid(terminal(run.state) ? run.completed_at !== null && run.needs_continue === false : run.completed_at === null);
    valid(run.stop_requested === (run.state === 'stopped'));
    if (run.state === 'paused') valid(run.needs_continue === true);
    const budget = parsed(agentRunBudgetSchema.omit({ steps: true, dispatches: true }), run.budget);
    const ordered = [...steps.values()].filter(step => step.run_id === run.run_id).sort((a, b) => Number(a.step_no) - Number(b.step_no));
    valid(ordered.every((step, i) => Number(step.step_no) === i + 1));
    valid(ordered.filter(step => step.state !== 'completed').length <= 1);
    valid(ordered.length <= budget.maxSteps && integer(run.dispatch_count) && Number(run.dispatch_count) <= budget.maxDispatches);
    valid(Number(run.dispatch_count) >= ordered.filter(step => step.dispatch_generation !== null).length);
    valid(sessions.has(String(run.session_id)));
    const input = inputs.get(String(run.input_id));
    valid(input && input.session_id === run.session_id && input.request_id === run.request_id);
    const visited = new Set([String(run.run_id)]);
    let previous = run.previous_run_id;
    while (previous) {
      valid(!visited.has(String(previous)));
      visited.add(String(previous));
      const parent = runs.get(String(previous));
      valid(parent && parent.session_id === run.session_id);
      previous = parent.previous_run_id;
    }
  }
  for (const input of inputs.values()) {
    valid(runs.get(String(input.run_id))?.session_id === input.session_id);
    const current = parsed(agentInputSchema, input.body), original = parsed(agentInputSchema, input.original_body);
    valid(input.input_id === operationId('agent-input:' + original.requestId) && input.request_id === original.requestId);
    valid(current.requestId === original.requestId && current.sessionId === input.session_id && original.sessionId === input.session_id);
    valid(current.mode === input.mode && canonicalDigest(original) === input.input_digest);
    valid(integer(input.version, 1) && integer(input.seq, 1));
    valid(['pending', 'adopted', 'removed'].includes(String(input.state)));
    if (input.state === 'adopted') valid(steps.get(String(input.adopted_step_id))?.run_id === input.run_id);
    else valid(input.adopted_step_id === null);
    const received = [...events.values()].find(event => event.session_id === input.session_id && Number(event.seq) === Number(input.seq));
    valid(received?.kind === 'input-received' && record(received.body).inputId === input.input_id
      && canonicalDigest(record(received.body).input) === canonicalDigest(original));
    const receipt = await storage.receipt('agent-input:' + original.requestId);
    valid(receipt);
    const fixed = parsed(agentInputReceiptSchema, receipt.result);
    valid(fixed.inputId === input.input_id && fixed.requestId === input.request_id && fixed.sessionId === input.session_id
      && fixed.inputDigest === input.input_digest && runs.get(fixed.runId)?.session_id === input.session_id);
  }
  for (const step of operations.values()) {
    valid(runs.has(String(step.run_id)) && parsed(agentOperationSchema, step.operation).operationId === step.operation_id);
    parsed(factsSchema, step.snapshot);
    valid(integer(step.step_no, 1) && step.step_id === operationId('agent-step:' + step.run_id + ':' + step.step_no));
    valid(['prepared', 'dispatching', 'waiting', 'unknown', 'completed'].includes(String(step.state)));
    const result = step.result === null ? null : parsed(agentOperationResultSchema, step.result);
    valid(typeof step.continuation_open === 'boolean');
    if (step.continuation_open) valid(!terminal(runs.get(String(step.run_id))!.state)
      && ['completed', 'waiting'].includes(String(step.state)) && result && ['completed', 'accepted'].includes(result.state));
    if (step.state === 'completed') valid(result && ['completed', 'failed'].includes(result.state));
    if (step.state === 'waiting') valid(result?.state === 'accepted');
    if (step.state === 'unknown') valid(result?.state === 'unknown');
    if (step.state === 'prepared' || step.state === 'dispatching') valid(result === null || result.state === 'not-dispatched');
    if (step.dispatch_generation !== null) valid(integer(step.dispatch_generation, 1)
      && Number(step.dispatch_generation) <= Number(runs.get(String(step.run_id))!.generation));
    else valid(step.state === 'prepared');
  }
  for (const wait of tables.get('agent_waits')!) {
    valid(typeof wait.interruptible === 'boolean');
    try { parsed(agentWaitSchema, { waitId: wait.wait_id, runId: wait.run_id, operationId: wait.operation_id,
      version: Number(wait.version), kind: wait.kind, state: wait.state, presentation: wait.presentation,
      response: wait.response, deadline: wait.deadline ? iso(wait.deadline) : null, interruptible: wait.interruptible,
      ...(wait.continuation_operation_id ? { continuationOperationId: wait.continuation_operation_id } : {}) }); }
    catch { throw new StorageError('corrupt'); }
    valid(runs.has(String(wait.run_id)) && operations.get(String(wait.operation_id))?.run_id === wait.run_id);
    if (wait.continuation_operation_id) valid(operations.get(String(wait.continuation_operation_id))?.run_id === wait.run_id);
    valid(wait.wait_id === operationId('agent-wait:' + wait.operation_id + ':' + wait.kind));
    if (wait.state === 'pending') valid(wait.response === null && !terminal(runs.get(String(wait.run_id))!.state));
    if (wait.state === 'consumed') { parsed(factsSchema, wait.response); valid(Number(wait.version) >= 2); }
    if (wait.state === 'cancelled') valid(wait.response === null && Number(wait.version) >= 2);
  }
  for (const event of events.values()) {
    try { parsed(agentEventSchema, { sessionId: event.session_id, seq: Number(event.seq), eventId: event.event_id,
      kind: event.kind, version: 1, body: event.body, createdAt: iso(event.created_at) }); }
    catch { throw new StorageError('corrupt'); }
    valid(sessions.has(String(event.session_id)));
    const body = record(event.body);
    if (body.runId !== undefined) valid(runs.get(String(body.runId))?.session_id === event.session_id);
  }
  for (const control of controls.values()) {
    valid(runs.get(String(control.run_id))?.session_id === control.session_id);
    const body = record(control.body);
    if (control.operation === 'cancel') {
      const cancellation = parsed(cancellationControlSchema, body), step = steps.get(cancellation.stepId);
      const stop = controls.get(cancellation.stopRequestId);
      valid(cancellation.requestId === control.request_id && cancellation.sessionId === control.session_id && cancellation.runId === control.run_id
        && cancellation.requestId === operationId('agent-cancel:' + cancellation.stepId)
        && cancellationDigest(cancellation) === control.input_digest);
      valid(runs.get(cancellation.runId)?.state === 'stopped' && step?.run_id === cancellation.runId && step.dispatch_generation !== null);
      valid(stop?.operation === 'stop' && stop.run_id === control.run_id && stop.session_id === control.session_id);
      let acknowledgement;
      try { acknowledgement = await storage.receipt('agent-cancel-delivered:' + cancellation.requestId, String(control.input_digest)); }
      catch (error) { if (error instanceof StorageError && error.code === 'identity-conflict') throw new StorageError('corrupt'); throw error; }
      valid((acknowledgement !== null) === (cancellation.state === 'delivered'));
      if (acknowledgement) valid(canonicalDigest(acknowledgement.result) === canonicalDigest({ requestId: cancellation.requestId }));
      continue;
    }
    valid(body.sessionId === control.session_id && canonicalDigest(body) === control.input_digest);
    const command = body.inputId === undefined ? body : record(body.control);
    valid(command.requestId === control.request_id && command.operation === control.operation);
    const receipt = await storage.receipt('agent-control:' + control.request_id);
    valid(receipt);
    if (body.inputId !== undefined) {
      const input = inputs.get(String(body.inputId));
      valid(input && input.session_id === control.session_id);
      const parsedControl = parsed(agentInputControlSchema, command), result = parsed(agentInputControlReceiptSchema, receipt.result);
      valid(result.requestId === control.request_id && result.input.inputId === body.inputId && result.input.runId === control.run_id
        && result.input.input.sessionId === control.session_id && result.input.version === parsedControl.expectedVersion + 1
        && result.input.version <= Number(input.version));
    } else valid(['stop', 'continue'].includes(String(control.operation)) && body.runId === control.run_id);
  }
  for (const progress of tables.get('agent_progress')!) {
    const step = operations.get(String(progress.operation_id)), event = events.get(String(progress.event_id));
    valid(step && event && event.kind === 'model-progress');
    const body = record(event.body);
    valid(body.operationId === progress.operation_id && body.stepId === step.step_id && body.runId === step.run_id);
    valid(runs.get(String(step.run_id))?.session_id === event.session_id);
    const stored = record(progress.body);
    valid(integer(progress.revision, 1) && stored.revision === Number(progress.revision));
    valid(integer(progress.generation, 1) && Number(progress.generation) <= Number(runs.get(String(step.run_id))!.generation));
    valid(progress.event_id === operationId('agent-progress:' + progress.operation_id + ':' + progress.revision));
    const { runId: _run, stepId: _step, operationId: _operation, ...payload } = body;
    valid(canonicalDigest(payload) === canonicalDigest(stored));
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
