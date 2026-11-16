import { z } from 'zod';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { canonicalDigest } from '@xunjie/storage/identity';
import { ownerSourceClosureSchema } from '@xunjie/storage/source-closure';
import { storageOwnerSchema } from '@xunjie/contracts/storage';
import { collectAgentRuntimeSources, validateAgentRuntime } from './source-closure.js';

export const agentRuntimeMaintenanceKind = 'xunjie.agent-runtime.boundary/2' as const;
export const agentRuntimeReceiverMaintenanceKind = 'xunjie.agent-runtime.receiver-boundary/2' as const;
/** Only kernel tables. Application transports attest their own additional tables separately. */
const tables = ['agent_runtime_sessions', 'agent_turns', 'agent_inputs', 'agent_steps', 'agent_attempts',
  'agent_tool_calls', 'agent_questions', 'agent_notifications', 'agent_events', 'agent_controls', 'agent_progress', '_storage_references'] as const;
type Row = Record<string, unknown>;
const count = z.number().int().nonnegative();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const resourceSchema = z.object({ resourceId: z.string().min(1), sha256: digest, byteLength: count }).strict();
const unresolvedSchema = z.object({ requestId: z.uuid(), inputDigest: digest, executionRef: z.uuid(), sessionId: z.uuid(),
  location: z.literal('agent-runtime'), state: z.string().min(1), statusKnowledge: z.enum(['confirmed', 'unknown']),
  stopRequested: z.boolean(), disposition: z.enum(['accepted-not-started', 'running', 'paused', 'stop-pending', 'unknown']) }).strict();
const boundarySchema = z.object({ kind: z.enum([agentRuntimeMaintenanceKind, agentRuntimeReceiverMaintenanceKind]),
  unresolved: z.array(unresolvedSchema), settled: count, retained: z.object({ resources: count, checkpoints: count }).strict(),
  blocking: z.array(z.object({ code: z.string(), detail: z.string() }).strict()),
  evidence: z.object({ formatVersion: z.literal(2), owner: storageOwnerSchema,
    tables: z.record(z.string(), z.object({ count, sha256: digest }).strict()), resources: z.array(resourceSchema),
    sources: ownerSourceClosureSchema,
    inputReceipts: z.array(z.object({ requestId: z.string().min(1), sha256: digest }).strict()),
    pending: z.object({ inputs: count, waits: count, operations: count, continuations: count }).strict(),
    dormantRuns: count.optional(),
  }).strict(),
}).strict();
export type AgentRuntimeBoundaryUnresolved = z.infer<typeof unresolvedSchema>;
export type AgentRuntimeBoundary = z.infer<typeof boundarySchema>;

async function closed(storage: OwnedStorage) {
  const { rows: [state] } = await storage.read('SELECT writes_open,dispatch_open FROM _storage_identity');
  if (!state || state.writes_open !== false || state.dispatch_open !== false) throw new StorageError('maintenance');
}

/** Pure inventory at a host-closed, drained boundary. This never recovers or dispatches work. */
export async function collectAgentRuntimeBoundary(storage: OwnedStorage): Promise<AgentRuntimeBoundary> {
  await closed(storage);
  const sources = await collectAgentRuntimeSources(storage);
  const records = new Map<string, Row[]>(), inventory: AgentRuntimeBoundary['evidence']['tables'] = {};
  for (const table of tables) {
    const { rows } = await storage.read(`SELECT * FROM ${table}`);
    const facts = JSON.parse(JSON.stringify(rows)) as Row[];
    records.set(table, facts);
    inventory[table] = { count: facts.length, sha256: canonicalDigest(facts.map(canonicalDigest).sort()) };
  }
  const resources = new Map<string, z.infer<typeof resourceSchema>>();
  for (const entry of sources.entries) for (const resource of entry.resources) {
    const previous = resources.get(resource.resourceId);
    if (previous && canonicalDigest(previous) !== canonicalDigest(resource)) throw new StorageError('corrupt');
    resources.set(resource.resourceId, resource);
  }
  const turns = records.get('agent_turns')!, steps = records.get('agent_steps')!;
  const toolCalls = records.get('agent_tool_calls')!, questions = records.get('agent_questions')!;
  const inputs = new Map(records.get('agent_inputs')!.map(input => [String(input.input_id), input]));
  const inputReceipts: AgentRuntimeBoundary['evidence']['inputReceipts'] = [];
  for (const input of inputs.values()) {
    const requestId = 'agent-input:' + input.request_id;
    let receipt;
    try { receipt = await storage.receipt(requestId, String(input.input_digest)); }
    catch (error) { if (error instanceof StorageError && error.code === 'identity-conflict') throw new StorageError('corrupt'); throw error; }
    if (!receipt) throw new StorageError('corrupt');
    inputReceipts.push({ requestId, sha256: canonicalDigest(receipt) });
  }
  inputReceipts.sort((a, b) => a.requestId.localeCompare(b.requestId));
  const stepsByTurn = new Map<string, Row[]>();
  for (const step of steps) { const group = stepsByTurn.get(String(step.turn_id)) ?? []; group.push(step); stepsByTurn.set(String(step.turn_id), group); }
  const callsByStep = new Map<string, Row[]>();
  for (const call of toolCalls) { const group = callsByStep.get(String(call.step_id)) ?? []; group.push(call); callsByStep.set(String(call.step_id), group); }
  const cancelTurns = new Set(records.get('agent_controls')!.filter(control => ['cancel-turn', 'cancel-call'].includes(String(control.operation))
    && (control.body as Row).state === 'pending').map(control => String(control.turn_id)));
  const unresolved: AgentRuntimeBoundaryUnresolved[] = [];
  for (const turn of turns) {
    const turnSteps = stepsByTurn.get(String(turn.turn_id)) ?? [];
    const unknown = cancelTurns.has(String(turn.turn_id))
      || turnSteps.some(step => ['generating', 'executing'].includes(String(step.state))
        || (callsByStep.get(String(step.step_id)) ?? []).some(call => call.state === 'started' || (call.state === 'closed' && (call.result as Row)?.kind === 'outcome_unknown')));
    if (['completed', 'failed', 'stopped', 'interrupted'].includes(String(turn.state)) && !unknown) continue;
    const triggerInput = [...inputs.values()].find(input => input.turn_id === turn.turn_id);
    const inputDigest = triggerInput ? String(triggerInput.input_digest) : canonicalDigest({ turnId: turn.turn_id });
    unresolved.push({ requestId: String(turn.request_id), inputDigest, executionRef: String(turn.turn_id),
      sessionId: String(turn.session_id), location: 'agent-runtime', state: String(turn.state),
      statusKnowledge: unknown ? 'unknown' : 'confirmed', stopRequested: turn.state === 'stopped',
      disposition: turn.state === 'stopped' ? 'stop-pending' : unknown ? 'unknown' : turn.state === 'active' ? 'running' : 'paused' });
  }
  unresolved.sort((a, b) => a.executionRef.localeCompare(b.executionRef));
  return { kind: agentRuntimeMaintenanceKind, unresolved, settled: turns.length - unresolved.length,
    retained: { resources: resources.size, checkpoints: steps.length }, blocking: [],
    evidence: { formatVersion: 2, owner: storage.owner, tables: inventory, sources, inputReceipts,
      resources: [...resources.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
      pending: { inputs: records.get('agent_inputs')!.filter(input => input.state === 'pending').length,
        waits: questions.filter(question => question.state === 'pending').length,
        operations: steps.filter(step => step.state !== 'completed').length, continuations: 0 } } };
}

export async function collectAgentRuntimeReceiverBoundary(storage: OwnedStorage): Promise<AgentRuntimeBoundary> {
  const boundary = await collectAgentRuntimeBoundary(storage);
  const unresolved = boundary.unresolved.filter(turn => turn.statusKnowledge === 'unknown' || turn.stopRequested);
  return { ...boundary, kind: agentRuntimeReceiverMaintenanceKind, unresolved,
    evidence: { ...boundary.evidence, dormantRuns: boundary.unresolved.length - unresolved.length } };
}

/** A v2 backup must match current original bytes and complete source evidence; no Teaching compatibility. */
export async function validateAgentRuntimeBoundary(storage: OwnedStorage, material: unknown): Promise<void> {
  if (!material || typeof material !== 'object' || Array.isArray(material)) throw new StorageError('corrupt');
  const value = material as Record<string, unknown>;
  if (value.kind !== agentRuntimeMaintenanceKind || (value.evidence as { formatVersion?: unknown } | undefined)?.formatVersion !== 2)
    throw new StorageError('incompatible');
  const { kind, unresolved, settled, retained, blocking, evidence } = value;
  const parsed = boundarySchema.safeParse({ kind, unresolved, settled, retained, blocking, evidence });
  if (!parsed.success) throw new StorageError('corrupt');
  await closed(storage);
  await validateAgentRuntime(storage);
  const actual = await collectAgentRuntimeBoundary(storage);
  if (canonicalDigest(parsed.data) !== canonicalDigest(actual)) throw new StorageError('corrupt');
}
