import { z } from 'zod';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { canonicalDigest } from '@xunjie/storage/identity';
import { ownerSourceClosureSchema } from '@xunjie/storage/source-closure';
import { storageOwnerSchema } from '@xunjie/contracts/storage';
import { collectAgentRuntimeSources, validateAgentRuntime } from './source-closure.js';

export const agentRuntimeMaintenanceKind = 'xunjie.agent-runtime.boundary/2' as const;
export const agentRuntimeReceiverMaintenanceKind = 'xunjie.agent-runtime.receiver-boundary/2' as const;
/** Only kernel tables. Application transports attest their own additional tables separately. */
const tables = ['agent_runtime_sessions', 'agent_runs', 'agent_inputs', 'agent_steps', 'agent_waits',
  'agent_events', 'agent_controls', 'agent_progress', '_storage_references'] as const;
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
  // This owner read also verifies original inputs/receipts, relationships and every retained resource.
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
  const steps = records.get('agent_steps')!, waits = records.get('agent_waits')!, runs = records.get('agent_runs')!;
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
  const grouped = (rows: Row[]) => {
    const result = new Map<string, Row[]>();
    for (const row of rows) {
      const id = String(row.run_id), group = result.get(id) ?? [];
      group.push(row); result.set(id, group);
    }
    return result;
  };
  const stepsByRun = grouped(steps), waitsByRun = grouped(waits);
  const cancellationRuns = new Set(records.get('agent_controls')!.filter(control => control.operation === 'cancel'
    && (control.body as Row).state === 'pending').map(control => String(control.run_id)));
  const unresolved: AgentRuntimeBoundaryUnresolved[] = [];
  for (const run of runs) {
    const operations = stepsByRun.get(String(run.run_id)) ?? [], logicalWaits = waitsByRun.get(String(run.run_id)) ?? [];
    // Acknowledged asynchronous work and a cancelled continuation have not proved physical settlement.
    const unknown = cancellationRuns.has(String(run.run_id))
      || operations.some(step => ['dispatching', 'waiting', 'unknown'].includes(String(step.state)) || step.continuation_open === true)
      || logicalWaits.some(wait => wait.continuation_operation_id != null && ['pending', 'cancelled'].includes(String(wait.state)));
    if (['completed', 'failed', 'stopped'].includes(String(run.state)) && !unknown) continue;
    const input = inputs.get(String(run.input_id));
    if (!input) throw new StorageError('corrupt');
    unresolved.push({ requestId: String(run.request_id), inputDigest: String(input.input_digest), executionRef: String(run.run_id),
      sessionId: String(run.session_id), location: 'agent-runtime', state: String(run.state),
      statusKnowledge: unknown ? 'unknown' : 'confirmed', stopRequested: run.stop_requested === true,
      disposition: run.stop_requested ? 'stop-pending' : unknown ? 'unknown' : run.state === 'received' ? 'accepted-not-started'
        : run.state === 'running' && !logicalWaits.some(wait => wait.state === 'pending') ? 'running' : 'paused' });
  }
  unresolved.sort((a, b) => a.executionRef.localeCompare(b.executionRef));
  return { kind: agentRuntimeMaintenanceKind, unresolved, settled: runs.length - unresolved.length,
    retained: { resources: resources.size, checkpoints: steps.length }, blocking: [],
    evidence: { formatVersion: 2, owner: storage.owner, tables: inventory, sources, inputReceipts,
      resources: [...resources.values()].sort((a, b) => a.resourceId.localeCompare(b.resourceId)),
      pending: { inputs: records.get('agent_inputs')!.filter(input => input.state === 'pending').length,
        waits: waits.filter(wait => wait.state === 'pending').length, operations: steps.filter(step => step.state !== 'completed').length,
        continuations: steps.filter(step => step.continuation_open === true).length } } };
}

export async function collectAgentRuntimeReceiverBoundary(storage: OwnedStorage): Promise<AgentRuntimeBoundary> {
  const boundary = await collectAgentRuntimeBoundary(storage);
  const unresolved = boundary.unresolved.filter(run => run.statusKnowledge === 'unknown' || run.stopRequested);
  return { ...boundary, kind: agentRuntimeReceiverMaintenanceKind, unresolved,
    evidence: { ...boundary.evidence, dormantRuns: boundary.unresolved.length - unresolved.length } };
}

/** A v2 backup must match current original bytes and complete source evidence; no Teaching compatibility. */
export async function validateAgentRuntimeBoundary(storage: OwnedStorage, material: unknown): Promise<void> {
  if (!material || typeof material !== 'object' || Array.isArray(material)) throw new StorageError('corrupt');
  const value = material as Record<string, unknown>;
  if (value.kind !== agentRuntimeMaintenanceKind || (value.evidence as { formatVersion?: unknown } | undefined)?.formatVersion !== 2)
    throw new StorageError('incompatible');
  // Product recovery adds its own owner envelope and full application source closure outside these fields.
  const { kind, unresolved, settled, retained, blocking, evidence } = value;
  const parsed = boundarySchema.safeParse({ kind, unresolved, settled, retained, blocking, evidence });
  if (!parsed.success) throw new StorageError('corrupt');
  await closed(storage);
  await validateAgentRuntime(storage);
  const actual = await collectAgentRuntimeBoundary(storage);
  if (canonicalDigest(parsed.data) !== canonicalDigest(actual)) throw new StorageError('corrupt');
}
