import { createHash } from 'node:crypto';
import { StorageError, type OwnedStorage } from '@xunjie/storage';
import { canonicalDigest } from './identity.js';

export const teachingMaintenanceKind = 'xunjie.teaching-agent.boundary';
// This list belongs to the domain owner. The runtime never enumerates its tables.
const commonTables = ['teaching_sessions', 'teaching_requests', 'teaching_runs', 'teaching_events',
  'teaching_snapshots', 'teaching_steps', 'teaching_commands', 'teaching_waits', 'teaching_budgets',
  'teaching_student_questions', 'teaching_student_responses', 'teaching_student_presentations',
  'teaching_dependency_bindings', 'teaching_model_switches', 'teaching_inputs',
  'teaching_input_revisions', 'teaching_controls', 'teaching_run_input_selections',
  'teaching_agent_definitions', 'teaching_resolved_agents', 'teaching_segment_transitions',
  'agent_chunk_transfers', 'agent_chunk_parts'] as const;
const skillTables = ['teaching_skills', 'teaching_skill_versions', 'teaching_skill_selections', 'teaching_skill_loads'] as const;
const compactionTables = ['teaching_compactions'] as const;
const tables = [...commonTables, ...skillTables, ...compactionTables] as const;
interface BoundaryProfile {
  formatVersion: 1 | 2 | 3;
  tables: readonly (typeof tables)[number][];
  historicalResults: boolean;
}
const currentProfile: BoundaryProfile = { formatVersion: 3, tables, historicalResults: true };
// These are the exact published inventories, not permission to omit arbitrary tables.
const profiles: readonly BoundaryProfile[] = [
  { formatVersion: 1, tables: commonTables, historicalResults: false },
  { formatVersion: 1, tables: [...commonTables, ...compactionTables], historicalResults: false },
  { formatVersion: 2, tables: commonTables, historicalResults: true },
  { formatVersion: 2, tables: [...commonTables, ...skillTables], historicalResults: false },
  currentProfile,
];
const terminal = new Set(['completed', 'failed', 'stopped']);
type Row = Record<string, unknown>;

/** Called only at a closed, drained owner boundary. No models, tools or remote owners are invoked. */
export async function collectTeachingBoundary(storage: OwnedStorage) { return collectBoundary(storage, currentProfile); }
async function collectBoundary(storage: OwnedStorage, profile: BoundaryProfile) {
  const records = new Map<string, Row[]>();
  const inventory: Record<string, { count: number; sha256: string }> = {};
  for (const table of tables) {
    const included = profile.tables.includes(table);
    if (!included) {
      const { rows: [existing] } = await storage.read('SELECT to_regclass($1) AS relation', [table]);
      if (!existing?.relation) { records.set(table, []); continue; }
    }
    const { rows } = await storage.read(`SELECT * FROM ${table}`);
    // pg Dates must be ISO values, not empty objects; JSONB object order is immaterial.
    const facts = JSON.parse(JSON.stringify(rows)) as Row[];
    records.set(table, facts);
    if (!included && facts.length) throw new StorageError('corrupt');
    if (included) inventory[table] = { count: facts.length, sha256: canonicalDigest(facts.map(canonicalDigest).sort()) };
  }
  const rows = (table: typeof tables[number]) => records.get(table)!;
  const commands = rows('teaching_commands').filter(row => row.state !== 'settled');
  const waits = rows('teaching_waits').filter(row => row.state !== 'consumed');
  const runs = rows('teaching_runs');
  const unresolved = runs.filter(run => !terminal.has(String(run.state))
    || commands.some(command => command.run_id === run.run_id) || waits.some(wait => wait.run_id === run.run_id)).map(run => {
    const request = rows('teaching_requests').find(request => request.request_id === run.request_id);
    if (!request) throw new StorageError('corrupt');
    const unknown = run.state === 'dispatching' || run.reason === 'result-unknown'
      || rows('teaching_steps').some(step => step.run_id === run.run_id && step.dispatch_permitted === true && step.call_settled_ms == null)
      || commands.some(command => command.run_id === run.run_id
        && (command.state === 'dispatching' || (command.outcome as { state?: unknown } | null)?.state === 'unknown'))
      || waits.some(wait => wait.run_id === run.run_id && wait.reason === 'unknown');
    return { requestId: String(run.request_id), inputDigest: String(request.input_digest), executionRef: String(run.run_id),
      activityId: String(run.activity_id), location: 'teaching-agent', state: String(run.state),
      statusKnowledge: unknown ? 'unknown' as const : 'confirmed' as const, stopRequested: run.stop_requested === true,
      disposition: run.stop_requested ? 'stop-pending' as const : unknown ? 'unknown' as const
        : run.state === 'received' ? 'accepted-not-started' as const : 'paused' as const };
  }).sort((a, b) => a.executionRef.localeCompare(b.executionRef));
  const resourceIds = new Set<string>();
  for (const row of [...rows('teaching_snapshots'), ...rows('teaching_commands'), ...rows('agent_chunk_parts')]) {
    if (row.resource_id) resourceIds.add(String(row.resource_id));
  }
  const allResourceIds = new Set(resourceIds);
  for (const event of rows('teaching_events')) {
    const body = event.body as { resourceId?: unknown };
    if (event.kind === 'tool-result' && typeof body.resourceId === 'string') allResourceIds.add(body.resourceId);
  }
  const resources = [];
  for (const resourceId of [...allResourceIds].sort()) {
    const reference = await storage.resource(resourceId), bytes = await storage.readResource(resourceId);
    // Even an old inventory must retain readable bytes for every historical result.
    if (profile.historicalResults || resourceIds.has(resourceId)) resources.push({ resourceId, reference, byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { kind: teachingMaintenanceKind, unresolved, settled: runs.length - unresolved.length,
    // Physical model calls and executions are attested by their own owners. These are Agent facts.
    blocking: [] as { code: string; detail: string }[], retained: { resources: resources.length, checkpoints: 0 },
    evidence: { formatVersion: profile.formatVersion, owner: storage.owner, tables: inventory, resources,
      pending: { commands: commands.length, waits: waits.length,
        inputs: rows('teaching_inputs').filter(row => ['pending', 'paused'].includes(String(row.state))).length,
        studentQuestions: rows('teaching_student_questions').filter(row => row.state === 'pending').length } } };
}

/** Dormant logical Waits may remain; uncertain dispatches and stop confirmations still block fencing. */
export async function collectTeachingReceiverBoundary(storage: OwnedStorage) {
  const boundary = await collectTeachingBoundary(storage);
  return { ...boundary, kind: 'xunjie.teaching-agent.receiver-boundary',
    unresolved: boundary.unresolved.filter(run => run.statusKnowledge === 'unknown' || run.stopRequested),
    evidence: { ...boundary.evidence, dormantRuns: boundary.unresolved.filter(run => run.statusKnowledge === 'confirmed' && !run.stopRequested).length } };
}

/** Re-derive restored facts, including resource bytes, rather than trusting the encrypted inventory. */
export async function validateTeachingBoundary(storage: OwnedStorage, material: {
  kind: string; unresolved: unknown; settled: number; retained: unknown; blocking: unknown; evidence?: unknown;
}) {
  // Published pre-#204 backups have no domain inventory. Normal service/resource validation still runs.
  if (material.kind === 'xunjie.storage.boundary' && material.evidence === undefined) return;
  if (material.kind !== teachingMaintenanceKind) throw new StorageError('incompatible');
  const version = (material.evidence as { formatVersion?: unknown } | undefined)?.formatVersion;
  if (!material.evidence || typeof material.evidence !== 'object' || typeof version !== 'number' || ![1, 2, 3].includes(version)) throw new StorageError('incompatible');
  const listed = (material.evidence as { tables?: unknown }).tables;
  if (!listed || typeof listed !== 'object' || Array.isArray(listed)) throw new StorageError('corrupt');
  const names = Object.keys(listed).sort();
  const profile = profiles.find(item => item.formatVersion === version
    && canonicalDigest([...item.tables].sort()) === canonicalDigest(names));
  if (!profile) throw new StorageError('corrupt');
  const actual = await collectBoundary(storage, profile);
  const { kind, unresolved, settled, retained, blocking, evidence } = material;
  if (canonicalDigest({ kind, unresolved, settled, retained, blocking, evidence }) !== canonicalDigest(actual))
    throw new StorageError('corrupt');
}
