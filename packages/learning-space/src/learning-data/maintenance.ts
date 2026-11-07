import { StorageError } from '@xunjie/storage';
import { agentBrowserBoundary } from './agent-executions.js';
import type { OwnedStorage } from '@xunjie/storage';
import { canonicalValue, type ExecutionQuery } from '@xunjie/contracts/execution';
import { readNativeChannelSettlement } from './native-channel.js';

/**
 * The execution owner writes the maintenance boundary it really observed: which commands it had
 * accepted, how far each one got, and which ones cannot be proven finished. Backup orchestration
 * only reads this material; it never inspects these tables itself.
 *
 * A boundary is complete only when every unresolved command is either confirmed not started or
 * already terminal. An unknown outcome, a stop that no process confirmed, or a live session makes
 * the material blocking, so a maintenance run cannot report unqualified success.
 */
export const executionMaintenanceKind = 'xunjie.learning-data.boundary';
export const executionMaintenanceFormatVersion = 1 as const;
export type UnresolvedDisposition = 'accepted-not-started' | 'running' | 'paused' | 'stop-pending' | 'unknown';
export interface UnresolvedCommand {
  requestId: string;
  inputDigest: string;
  executionRef: string;
  activityId: string;
  location: 'browser' | 'native' | 'channel';
  state: string;
  statusKnowledge: 'confirmed' | 'unknown';
  stopRequested: boolean;
  confirmedSeq: number;
  appliedSeq: number;
  checkpoints: number;
  stopIds: string[];
  disposition: UnresolvedDisposition;
  node?: { nodeId?: string; installGeneration?: string; supervisorEpoch?: string; executorInstanceId?: string };
}
export interface ExecutionBoundaryMaterial {
  formatVersion: typeof executionMaintenanceFormatVersion;
  kind: typeof executionMaintenanceKind;
  commands: { total: number; settled: number; unresolved: number };
  checkpoints: number;
  results: number;
  stops: number;
  unresolved: UnresolvedCommand[];
  blocking: { code: string; detail: string }[];
  agentPendingBrowser?: Awaited<ReturnType<typeof agentBrowserBoundary>>;
}

const terminal = (state: string) => ['succeeded', 'failed', 'cancelled'].includes(state);
const dispositionOf = (state: string, statusKnowledge: string, stopRequested: boolean): UnresolvedDisposition =>
  statusKnowledge === 'unknown' ? 'unknown'
    : stopRequested ? 'stop-pending'
      : state === 'queued' ? 'accepted-not-started'
        : state === 'paused' ? 'paused' : 'running';
const count = (value: unknown): number => Array.isArray(value) ? value.length : 0;
const ids = (result: { rows: Record<string, unknown>[] }, column: string): string[] =>
  result.rows.map(row => String(row[column])).sort();

/** Reads only this owner's own tables. Callers run it while the owner's gates are closed. */
export async function collectExecutionBoundary(storage: OwnedStorage): Promise<ExecutionBoundaryMaterial> {
  const unresolved: UnresolvedCommand[] = [];
  let settled = 0;
  async function browserCommands() {
    const { rows } = await storage.read(`SELECT request_id,activity_id,input_digest,execution_ref,state,status_knowledge,
      stop_requested,confirmed_seq FROM execution_commands ORDER BY request_id`);
    for (const row of rows) {
      if (terminal(String(row.state)) && row.status_knowledge === 'confirmed') { settled += 1; continue; }
      const stops = ids(await storage.read('SELECT stop_id FROM execution_stops WHERE request_id=$1 ORDER BY stop_id', [row.request_id]), 'stop_id');
      unresolved.push({ requestId: String(row.request_id), inputDigest: String(row.input_digest),
        executionRef: String(row.execution_ref), activityId: String(row.activity_id), location: 'browser',
        state: String(row.state), statusKnowledge: row.status_knowledge === 'unknown' ? 'unknown' : 'confirmed',
        stopRequested: Boolean(row.stop_requested), confirmedSeq: Number(row.confirmed_seq), appliedSeq: 0,
        checkpoints: 0, stopIds: stops,
        disposition: dispositionOf(String(row.state), String(row.status_knowledge), Boolean(row.stop_requested)) });
    }
  }
  async function nativeCommands() {
    const { rows } = await storage.read(`SELECT session_ref,activity_id,request_id,input_digest,state,status_knowledge,
      stop_requested,confirmed_seq,applied_seq,node_id,install_generation,supervisor_epoch,executor_instance_id,checkpoints
      FROM native_sessions ORDER BY session_ref`);
    for (const row of rows) {
      if (terminal(String(row.state)) && row.status_knowledge === 'confirmed') { settled += 1; continue; }
      const stops = ids(await storage.read('SELECT stop_id FROM native_session_stops WHERE session_ref=$1 ORDER BY stop_id', [row.session_ref]), 'stop_id');
      const checkpoints = ids(await storage.read('SELECT checkpoint_id FROM native_session_checkpoints WHERE session_ref=$1 ORDER BY checkpoint_id',
        [row.session_ref]), 'checkpoint_id');
      unresolved.push({ requestId: String(row.request_id), inputDigest: String(row.input_digest),
        executionRef: String(row.session_ref), activityId: String(row.activity_id), location: 'native',
        state: String(row.state), statusKnowledge: row.status_knowledge === 'unknown' ? 'unknown' : 'confirmed',
        stopRequested: Boolean(row.stop_requested), confirmedSeq: Number(row.confirmed_seq), appliedSeq: Number(row.applied_seq),
        checkpoints: Math.max(checkpoints.length, count(row.checkpoints)), stopIds: stops,
        disposition: dispositionOf(String(row.state), String(row.status_knowledge), Boolean(row.stop_requested)),
        node: { nodeId: String(row.node_id), installGeneration: String(row.install_generation),
          supervisorEpoch: String(row.supervisor_epoch), executorInstanceId: String(row.executor_instance_id) } });
    }
  }
  async function channelCommands() {
    const channelSettlement = await readNativeChannelSettlement(storage);
    const { rows } = await storage.read('SELECT request_id,activity_id,input_digest,execution_ref,execution FROM channel_executions ORDER BY request_id');
    for (const row of rows) {
      // The school ledger keeps the original accepted query. A non-terminal query here is the
      // accepted-but-unsettled window; a missing session means the submit never got a claim.
      const query = row.execution as ExecutionQuery | null;
      if (!query || typeof query !== 'object') throw new StorageError('corrupt');
      const state = String(query.state);
      const knowledge = query.statusKnowledge === 'unknown' ? 'unknown' : 'confirmed';
      if (terminal(state) && knowledge === 'confirmed' || channelSettlement.confirms(query)) { settled += 1; continue; }
      const stops = ids(await storage.read(`SELECT command_id FROM channel_execution_intents
        WHERE request_id=$1 AND command->>'operation'='stop' ORDER BY command_id`, [row.request_id]), 'command_id');
      const checkpoints = ids(await storage.read('SELECT checkpoint_id FROM channel_session_checkpoints WHERE session_ref=$1 ORDER BY checkpoint_id',
        [row.execution_ref]), 'checkpoint_id');
      const session = query.session;
      unresolved.push({ requestId: String(row.request_id), inputDigest: String(row.input_digest),
        executionRef: String(row.execution_ref), activityId: String(row.activity_id), location: 'channel',
        state, statusKnowledge: knowledge, stopRequested: Boolean(query.stopRequested),
        confirmedSeq: Number(query.confirmedSeq ?? 0), appliedSeq: Number(session?.appliedSeq ?? 0),
        checkpoints: checkpoints.length, stopIds: stops,
        disposition: dispositionOf(state, knowledge, Boolean(query.stopRequested)),
        ...(session?.nodeId ? { node: { nodeId: session.nodeId, installGeneration: session.installGeneration,
          supervisorEpoch: session.supervisorEpoch, executorInstanceId: session.executorInstanceId } } : {}) });
    }
  }
  const total = async (table: string) => Number((await storage.read(`SELECT count(*) AS total FROM ${table}`)).rows[0]!.total);
  await browserCommands();
  await nativeCommands();
  await channelCommands();
  const pendingBrowser = await agentBrowserBoundary(storage);
  const blocking: ExecutionBoundaryMaterial['blocking'] = pendingBrowser.filter(item => item.claimed).map(item => ({
    code: 'unconfirmed-agent-browser-acceptance',
    detail: `Agent command ${item.requestId} was claimed by browser ${item.browserId}; its original receipt is not confirmed.`,
  }));
  for (const command of unresolved) if (command.disposition !== 'accepted-not-started' || command.location === 'browser') blocking.push({
    // A service-side queued projection cannot prove that a browser Worker did not claim it
    // while disconnected. Without the browser owner's freeze/exit fact, fail closed.
    code: command.location === 'browser' && command.disposition === 'accepted-not-started'
      ? 'unconfirmed-browser-boundary' : `unresolved-${command.disposition}`,
    detail: `${command.location} command ${command.requestId} (${command.state}) has no confirmed boundary.`,
  });
  return { formatVersion: executionMaintenanceFormatVersion, kind: executionMaintenanceKind,
    commands: { total: settled + unresolved.length, settled, unresolved: unresolved.length },
    checkpoints: await total('native_session_checkpoints') + await total('channel_session_checkpoints'),
    results: await total('execution_results'), stops: await total('execution_stops') + await total('native_session_stops'),
    unresolved, blocking, ...(pendingBrowser.length ? { agentPendingBrowser: pendingBrowser } : {}) };
}

/**
 * Restore validation: the material must describe the commands the restored owner really holds,
 * under their original identity. Missing evidence is a corruption, never a default.
 */
export async function validateExecutionBoundary(storage: OwnedStorage, material: unknown): Promise<void> {
  const value = material as ExecutionBoundaryMaterial | null | undefined;
  if (!value || value.formatVersion !== executionMaintenanceFormatVersion || value.kind !== executionMaintenanceKind
    || !Array.isArray(value.unresolved) || !Array.isArray(value.blocking)) throw new StorageError('corrupt');
  const actual = await collectExecutionBoundary(storage);
  // Preserve every node/instance, operation position, stop identity and blocking fact, even
  // though PostgreSQL JSONB may reorder object keys. Counts and dispositions alone are weaker.
  if (JSON.stringify(canonicalValue(value)) !== JSON.stringify(canonicalValue(actual))) throw new StorageError('corrupt');
  const identity = (command: UnresolvedCommand) => [command.requestId, command.inputDigest, command.executionRef,
    command.activityId, command.location].join('/');
  const expected = [...value.unresolved].map(identity).sort();
  const observed = [...actual.unresolved].map(identity).sort();
  if (JSON.stringify(expected) !== JSON.stringify(observed)) throw new StorageError('corrupt');
  const disposition = new Map(actual.unresolved.map(command => [identity(command), command.disposition]));
  for (const command of value.unresolved) {
    if (disposition.get(identity(command)) !== command.disposition) throw new StorageError('corrupt');
  }
  if (value.commands?.total !== actual.commands.total || value.commands.settled !== actual.commands.settled
    || value.commands.unresolved !== actual.commands.unresolved || value.stops !== actual.stops
    || value.results !== actual.results || value.checkpoints !== actual.checkpoints) {
    throw new StorageError('corrupt');
  }
}
