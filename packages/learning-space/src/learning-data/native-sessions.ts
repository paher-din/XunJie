import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import type { Migration, OwnedStorage } from '@xunjie/storage';
import type { SpaceIdentity } from '@xunjie/contracts/spaces';
import type { LearningActivity } from '@xunjie/contracts/learning-data';
import { acceptsState, componentInstanceId, componentStateName } from '@xunjie/contracts/components';
import type { StateShape } from '@xunjie/contracts/components';
import { canonicalValue, decideExecutionPlacement, executionActionSchema, executionControlSchema,
  executionQuerySchema, executionStopSchema } from '@xunjie/contracts/execution';
import type { ExecutionAction, ExecutionControl, ExecutionObservation, ExecutionQuery } from '@xunjie/contracts/execution';
import { productNativeAdapters, SupervisedSession } from './native-process.js';
import type { NativeAdapter, NativeSessionExit } from './native-process.js';
import { linuxSessionUnit, probeLinuxIsolation, stopUnit, unitStopped } from './linux-isolation.js';
import type { LinuxSessionEntry } from './linux-isolation.js';
import type { NativeSessionIsolation } from './native-sandbox.js';
import { verifyPlannedExecution } from './plan.js';
import type { createWorks } from './works.js';

/**
 * The native execution owner keeps its own session facts. A command is only accepted after the
 * adapter is known, and an input is persisted as dispatching before the child process sees it.
 */
export const nativeSessionMigration: Migration = { version: 7, name: 'native-stateful-sessions', sql: `
  CREATE TABLE native_sessions(session_ref uuid PRIMARY KEY,activity_id uuid NOT NULL REFERENCES activities(id),
    request_id uuid NOT NULL UNIQUE,input_digest text NOT NULL,action jsonb NOT NULL,
    adapter_id text NOT NULL,adapter_version integer NOT NULL,node_id text NOT NULL,install_generation text NOT NULL,
    supervisor_epoch uuid NOT NULL,executor_instance_id uuid NOT NULL,
    state text NOT NULL CHECK(state IN ('queued','running','paused','succeeded','failed','cancelled')),
    status_knowledge text NOT NULL CHECK(status_knowledge IN ('confirmed','unknown')),
    stop_requested boolean NOT NULL DEFAULT false,confirmed_seq integer NOT NULL,applied_seq integer NOT NULL DEFAULT 0,
    last_control_id uuid,observation jsonb,observations jsonb NOT NULL DEFAULT '[]'::jsonb,reason jsonb,
    stopped_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX native_sessions_activity ON native_sessions(activity_id,created_at DESC);
  CREATE TABLE native_session_operations(control_id uuid PRIMARY KEY,
    session_ref uuid NOT NULL REFERENCES native_sessions(session_ref),seq integer NOT NULL,operation_id text NOT NULL,
    input_digest text NOT NULL,parameters jsonb NOT NULL,
    status text NOT NULL CHECK(status IN ('dispatching','applied','unknown','rejected')),
    observation jsonb,reason jsonb,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE INDEX native_session_operations_session ON native_session_operations(session_ref,seq);
  CREATE TABLE native_session_stops(stop_id uuid PRIMARY KEY,
    session_ref uuid NOT NULL REFERENCES native_sessions(session_ref),request_id uuid NOT NULL,reason text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp());
` };

export interface NativeSessionOptions {
  activity(identity: SpaceIdentity, activityId: string): Promise<LearningActivity>;
  works: ReturnType<typeof createWorks>;
  adapters?: readonly NativeAdapter[];
  nodePath?: string;
  windowsHelper?: string;
  sessionRoot?: string;
  /** Linux only. Without a passing probe the owner refuses to start a session instead of running it unconfined. */
  linuxEntry?: LinuxSessionEntry;
  /** A measurement already taken by the host; otherwise the owner probes once on first use. */
  linuxIsolation?: NativeSessionIsolation;
  nodeId?: string;
  supervisorEpoch?: string;
  /** The host fixes its own role and transport; neither is taken from an execution command. */
  placement?: { nodeClass: 'device' | 'school-execution-node'; secureTransport: boolean };
}
/** What a host configures; the activity and work owner stay inside the learning-data module. */
export type NativeSessionHostOptions = Omit<NativeSessionOptions, 'activity' | 'works'>;

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const canonicalDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
const componentStateMediaType = 'application/vnd.xunjie.component-state+json';
const delay = (milliseconds: number) => new Promise<void>(resolve => { setTimeout(resolve, milliseconds) });
function fail(code: 'missing' | 'forbidden' | 'invalid' | 'corrupt' | 'conflict' | 'identity-conflict'): never {
  throw new StorageError(code);
}
const reasonOf = (code: 'invalid-input' | 'output-too-large' | 'budget-exceeded' | 'resource-unavailable'
  | 'worker-terminated' | 'algorithm-error', detail: string) => ({ code, detail: detail.slice(0, 500) });

interface LiveSession { process: SupervisedSession; result: StateShape }

function queryOf(row: Record<string, unknown>): ExecutionQuery {
  const action = executionActionSchema.parse(row.action);
  const session = action.execution.session;
  if (!session) throw new StorageError('corrupt');
  return executionQuerySchema.parse({
    requestId: row.request_id, inputDigest: row.input_digest, scope: action.scope, executionRef: row.session_ref,
    state: row.state, statusKnowledge: row.status_knowledge, stopRequested: row.stop_requested,
    confirmedSeq: Number(row.confirmed_seq), reason: row.reason ?? null, output: null,
    session: { adapterId: row.adapter_id, adapterVersion: Number(row.adapter_version),
      instanceId: action.execution.instance.instanceId, instanceKey: action.execution.instance.key,
      nodeId: row.node_id, installGeneration: row.install_generation, supervisorEpoch: row.supervisor_epoch,
      executorInstanceId: row.executor_instance_id, appliedSeq: Number(row.applied_seq),
      lastControlId: row.last_control_id ?? null, observation: row.observation ?? null,
      observations: row.observations ?? [] },
  });
}

export function createNativeSessions(storage: OwnedStorage, options: NativeSessionOptions) {
  const adapters = new Map((options.adapters ?? productNativeAdapters).map(adapter =>
    [`${adapter.adapterId}@${adapter.adapterVersion}`, adapter] as const));
  const supervisorEpoch = options.supervisorEpoch ?? randomUUID();
  const nodeId = options.nodeId ?? `local-${process.platform}`;
  const live = new Map<string, LiveSession>();
  const starting = new Map<string, Promise<ExecutionQuery>>();
  const settling = new Set<Promise<void>>();
  /** The storage generation is live: a maintenance resume changes it without replacing this owner. */
  const currentGeneration = () => String(storage.generation);
  /** An exit fact is written after the OS event; shutdown waits for those writes before storage drains. */
  function noteExit(sessionRef: string, exit: NativeSessionExit) {
    const task = settleExit(sessionRef, exit);
    settling.add(task);
    void task.finally(() => { settling.delete(task); });
  }

  async function find(activityId: string, requestId: string) {
    const { rows: [row] } = await storage.read('SELECT * FROM native_sessions WHERE activity_id=$1 AND request_id=$2',
      [activityId, requestId]);
    return row ?? null;
  }
  async function findRef(sessionRef: string) {
    const { rows: [row] } = await storage.read('SELECT * FROM native_sessions WHERE session_ref=$1', [sessionRef]);
    return row ?? null;
  }
  async function owns(activityId: string, requestId: string) {
    z.uuid().parse(requestId);
    return (await find(activityId, requestId)) !== null;
  }

  function bindingFor(activity: LearningActivity, action: ExecutionAction) {
    const instance = action.execution.instance;
    const binding = activity.course?.components?.find(item => item.key === instance.key);
    if (!binding) fail('forbidden');
    const manifest = binding.definition.manifest;
    if (componentInstanceId(activity.activityId, instance.key) !== instance.instanceId
      || manifest.componentId !== instance.componentId || manifest.version !== instance.componentVersion
      || manifest.stateVersion !== instance.stateVersion || manifest.hostApiVersion !== instance.hostApiVersion
      || binding.definition.digest !== instance.definitionDigest) fail('identity-conflict');
    return { binding, manifest };
  }

  /** The manifest, not the request, fixes the adapter, the input shape and every budget. */
  function verifyAction(activity: LearningActivity, action: ExecutionAction) {
    const execution = action.execution, session = execution.session;
    if (!session || execution.plan.location !== 'native' || execution.plan.kind !== 'session'
      || execution.operation.effect !== 'input') fail('invalid');
    const { manifest } = bindingFor(activity, action);
    if (manifest.formatVersion !== 1) fail('missing');
    if (!manifest.session) fail('missing');
    // A course plan may allow only a browser job, or only this one session operation.
    verifyPlannedExecution(activity, { key: action.execution.instance.key,
      definitionDigest: action.execution.instance.definitionDigest,
      operationId: execution.operation.operationId, location: 'native' });
    const declared = manifest.session;
    if (declared.adapterId !== session.adapterId || declared.adapterVersion !== session.adapterVersion
      || declared.operation.operationId !== execution.operation.operationId) fail('identity-conflict');
    if (!acceptsState(declared.parameters, execution.parameters)) fail('invalid');
    const limits = execution.limits, budgets = declared.budgets;
    if (limits.timeMs > budgets.operationTimeoutMs || limits.inputBytes > budgets.inputBytes
      || limits.outputBytes > budgets.outputBytes || limits.concurrentJobs > budgets.concurrentSessions
      || limits.queuedJobs > budgets.queuedSessions) fail('invalid');
    if (session.limits.operationTimeoutMs !== budgets.operationTimeoutMs
      || session.limits.idleMs !== budgets.idleMs || session.limits.maxMs !== budgets.maxMs
      || session.limits.memoryMiB !== budgets.memoryMiB
      || session.limits.concurrentSessions !== budgets.concurrentSessions
      || session.limits.queuedSessions !== budgets.queuedSessions) fail('invalid');
    const plan = execution.plan;
    if (plan.planId !== 'native-session' || plan.planVersion !== 1
      || plan.planDigest !== canonicalDigest({ planId: plan.planId, planVersion: plan.planVersion,
        componentId: manifest.componentId, componentVersion: manifest.version,
        operationId: execution.operation.operationId })) fail('invalid');
    if (execution.basis.resources.length !== 0) fail('invalid');
    return { manifest, session: declared };
  }

  async function verifyPlacement(_identity: SpaceIdentity, activity: LearningActivity, action: ExecutionAction) {
    const plan = activity.course?.executionPlan, placement = options.placement;
    const school = placement?.nodeClass === 'school-execution-node' || nodeId.startsWith('school-');
    if (!plan) { if (school) fail('forbidden'); return; }
    const device = action.execution.device;
    if (!device) fail('forbidden');
    const session = action.execution.session!;
    const adapter = adapters.get(`${session.adapterId}@${session.adapterVersion}`);
    // The product registry corroborates a platform limitation. A missing install, permission or
    // preparation can never turn a supported adapter into a remote-only operation.
    if (school && (!placement?.secureTransport || !plan.remote || !device.platform
      || !adapter?.platforms || adapter.platforms.includes(device.platform))) fail('forbidden');
    const decision = decideExecutionPlacement({ operationId: action.execution.operation.operationId, kind: 'session',
      adapter: { adapterId: session.adapterId, adapterVersion: session.adapterVersion }, plan, device,
      remoteAvailable: school && placement?.secureTransport === true });
    if (decision.location !== 'native' || decision.owner !== (school ? 'school-node' : 'device')) fail('forbidden');
    if (action.receiver.location !== (school ? 'remote' : 'local')) fail('forbidden');
  }

  function verifyState(action: ExecutionAction) {
    const state = action.execution.basis.state, expected = action.execution.basis.expected.stateContentId;
    if ((state?.contentId ?? null) !== expected) fail('invalid');
    if (!state) return;
    if (state.name !== componentStateName(action.execution.instance.key)) fail('invalid');
    const file = action.execution.basis.works.find(item => item.name === state.name);
    if (!file || file.contentId !== state.contentId || file.kind !== 'state' || file.encoding !== 'json'
      || file.mediaType !== componentStateMediaType) fail('invalid');
    let value: unknown;
    try { value = JSON.parse(file.value); }
    catch { throw new StorageError('corrupt'); }
    if (canonicalDigest(value) !== state.sha256) fail('corrupt');
  }

  async function accept(identity: SpaceIdentity, activityId: string, value: unknown): Promise<ExecutionQuery> {
    const input = z.object({ action: executionActionSchema, acceptance: z.unknown().optional() }).strict().parse(value);
    const action = input.action;
    const key = digest({ identity, activityId, action });
    const running = starting.get(key);
    if (running) return running;
    const attempt = beginAccept(identity, activityId, action);
    starting.set(key, attempt);
    try { return await attempt; }
    finally { starting.delete(key); }
  }

  async function beginAccept(identity: SpaceIdentity, activityId: string, action: ExecutionAction): Promise<ExecutionQuery> {
    await ensureReady();
    const activity = await options.activity(identity, activityId);
    const scope = action.scope;
    if (scope.activityId !== activityId || scope.environmentId !== identity.environmentId
      || scope.spaceId !== identity.spaceId || scope.principalId !== identity.principalId) fail('forbidden');
    const inputDigest = digest(action);
    // A recovered identity is answered before input validation: changed input under the same
    // request is an identity conflict, not a fresh bad request.
    const existing = await find(activityId, action.requestId);
    if (existing) {
      if (existing.input_digest !== inputDigest) fail('identity-conflict');
      await verifyPlacement(identity, activity, action);
      return queryOf(existing);
    }
    const { session: declared } = verifyAction(activity, action);
    await verifyPlacement(identity, activity, action);
    const adapter = adapters.get(`${declared.adapterId}@${declared.adapterVersion}`);
    if (!adapter) fail('invalid');
    const sessionLimits = action.execution.session!.limits;
    // This acceptance is already in `starting`; count the other sessions, not itself.
    const busy = live.size + Math.max(0, starting.size - 1);
    if (busy >= sessionLimits.concurrentSessions) fail('invalid');
    verifyState(action);
    const installationGeneration = currentGeneration();
    const sessionRef = randomUUID(), executorInstanceId = randomUUID();
    const begun = executionQuerySchema.parse({
      requestId: action.requestId, inputDigest, scope, executionRef: sessionRef, state: 'queued',
      statusKnowledge: 'confirmed', stopRequested: false, confirmedSeq: 1, reason: null, output: null,
      session: { adapterId: declared.adapterId, adapterVersion: declared.adapterVersion,
        instanceId: action.execution.instance.instanceId, instanceKey: action.execution.instance.key,
        nodeId, installGeneration: installationGeneration, supervisorEpoch, executorInstanceId, appliedSeq: 0, lastControlId: null,
        observation: null, observations: [] },
    });
    const reservation = await storage.request({ requestId: 'native-session:' + action.requestId,
      fingerprint: digest({ identity, activityId, inputDigest }) }, async tx => {
      const inserted = await tx.query(`INSERT INTO native_sessions(session_ref,activity_id,request_id,input_digest,action,adapter_id,
        adapter_version,node_id,install_generation,supervisor_epoch,executor_instance_id,state,status_knowledge,
        stop_requested,confirmed_seq,applied_seq,last_control_id,observation,observations,action_text)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued','confirmed',false,1,0,NULL,NULL,'[]'::jsonb,$12)
        ON CONFLICT(request_id) DO NOTHING RETURNING session_ref`, [sessionRef, activityId, action.requestId, inputDigest,
        JSON.stringify(action), declared.adapterId, declared.adapterVersion, nodeId, installationGeneration,
        supervisorEpoch, executorInstanceId, JSON.stringify(action)]);
      const { rows: [row] } = await tx.query('SELECT * FROM native_sessions WHERE request_id=$1 FOR UPDATE',
        [action.requestId]);
      if (!row || row.activity_id !== activityId || row.input_digest !== inputDigest) fail('identity-conflict');
      for (const file of action.execution.basis.works)
        await tx.reference(`native/${action.requestId}/work/${file.contentId}`, file.contentId);
      const state = action.execution.basis.state;
      if (state) await tx.reference(`native/${action.requestId}/state`, state.contentId);
      return { created: inserted.rowCount === 1, query: queryOf(row) };
    });
    const reserved = reservation.result as { created: boolean; query: ExecutionQuery };
    // Another acceptance already owns this identity and its process; never spawn a second one.
    if (!reserved.created) return reserved.query;
    let isolation: NativeSessionIsolation | undefined;
    if (options.linuxEntry) {
      const measured = await linuxFact();
      if (!measured) {
        return refuseStart(activityId, action.requestId, Object.assign(
          new Error('本机受限会话入口未通过自检，原生会话没有启动。'), { code: 'resource-unavailable' }));
      }
      isolation = measured;
    }
    let spawned: SupervisedSession;
    try {
      spawned = await SupervisedSession.create({
        adapter, instanceId: executorInstanceId,
        ...(options.nodePath ? { nodePath: options.nodePath } : {}),
        ...(options.windowsHelper ? { windowsHelper: options.windowsHelper } : {}),
        ...(options.sessionRoot ? { sessionRoot: options.sessionRoot } : {}),
        ...(options.linuxEntry ? { linuxEntry: options.linuxEntry } : {}),
        ...(isolation ? { linuxIsolation: isolation } : {}),
        limits: { operationTimeoutMs: action.execution.limits.timeMs, idleMs: sessionLimits.idleMs,
          maxMs: sessionLimits.maxMs, memoryMiB: sessionLimits.memoryMiB,
          outputBytes: action.execution.limits.outputBytes },
        events: { onExit: exit => { live.delete(sessionRef); noteExit(sessionRef, exit); } },
      });
    } catch (error) {
      return refuseStart(activityId, action.requestId, error);
    }
    if (installationGeneration !== currentGeneration()) {
      await spawned.dispose();
      await assertGeneration((await findRef(sessionRef))!);
    }
    try {
      const current = await options.activity(identity, activityId);
      await verifyPlacement(identity, current, action);
    } catch (error) { await spawned.dispose(); throw error; }
    if (spawned.exitFact) {
      await settleExit(sessionRef, spawned.exitFact);
      const stopped = await findRef(sessionRef);
      return stopped ? queryOf(stopped) : executionQuerySchema.parse(begun);
    }
    const reservedRow = await findRef(sessionRef);
    if (!reservedRow || reservedRow.stop_requested || reservedRow.state !== 'queued'
      || reservedRow.status_knowledge !== 'confirmed') {
      await spawned.dispose();
      if (spawned.exitFact) await settleExit(sessionRef, spawned.exitFact);
      return queryOf((await findRef(sessionRef))!);
    }
    const resultShape = declared.operation.result;
    if (!acceptsState(resultShape, spawned.initialObservation)) {
      await spawned.dispose();
      return refuseStart(activityId, action.requestId,
        Object.assign(new Error('本机会话的初始观察与组件声明的结果结构不一致。'), { code: 'algorithm-error' }));
    }
    live.set(sessionRef, { process: spawned, result: resultShape });
    const confirmed = await storage.request({ requestId: 'native-start:' + action.requestId,
      fingerprint: digest({ sessionRef, executorInstanceId }) }, async tx => {
      const { rows: [row] } = await tx.query('SELECT * FROM native_sessions WHERE session_ref=$1 FOR UPDATE', [sessionRef]);
      if (!row || row.state !== 'queued' || row.stop_requested || row.status_knowledge !== 'confirmed'
        || String(row.install_generation) !== currentGeneration()) return queryOf(row ?? fail('corrupt'));
      await tx.query(`UPDATE native_sessions SET state='running',confirmed_seq=2,observation=$2,updated_at=clock_timestamp()
        WHERE session_ref=$1`, [sessionRef, JSON.stringify(spawned.initialObservation)]);
      const { rows: [updated] } = await tx.query('SELECT * FROM native_sessions WHERE session_ref=$1', [sessionRef]);
      return queryOf(updated!);
    });
    const registered = executionQuerySchema.parse(confirmed.result);
    if (registered.state !== 'running' || registered.statusKnowledge !== 'confirmed' || registered.stopRequested)
      await spawned.dispose();
    // A process can exit between readiness and registration; the exit fact must win over `running`.
    if (spawned.exitFact) await settleExit(sessionRef, spawned.exitFact);
    const current = await findRef(sessionRef);
    return current ? queryOf(current) : executionQuerySchema.parse(confirmed.result);
  }

  async function refuseStart(activityId: string, requestId: string, error: unknown): Promise<ExecutionQuery> {
    const code = (error as { code?: string })?.code;
    const failure = reasonOf(code === 'budget-exceeded' ? 'budget-exceeded' : 'resource-unavailable',
      error instanceof Error ? error.message : '本机会话未能启动。');
    const receipt = await storage.request({ requestId: 'native-start-failed:' + requestId,
      fingerprint: digest({ requestId, failure }) }, async tx => {
      const { rows: [row] } = await tx.query(`SELECT * FROM native_sessions WHERE activity_id=$1 AND request_id=$2 FOR UPDATE`,
        [activityId, requestId]);
      if (!row) fail('missing');
      if (row.state === 'queued' && (code === 'termination-unconfirmed'
        || String(row.install_generation) !== currentGeneration())) {
        await tx.query(`UPDATE native_sessions SET status_knowledge='unknown',reason=$2,updated_at=clock_timestamp()
          WHERE session_ref=$1`, [row.session_ref, JSON.stringify(failure)]);
      } else if (row.state === 'queued') {
        await tx.query(`UPDATE native_sessions SET state='failed',status_knowledge='confirmed',confirmed_seq=2,
          reason=$2,updated_at=clock_timestamp() WHERE session_ref=$1`, [row.session_ref, JSON.stringify(failure)]);
      }
      const { rows: [updated] } = await tx.query('SELECT * FROM native_sessions WHERE session_ref=$1', [row.session_ref]);
      return queryOf(updated!);
    });
    return executionQuerySchema.parse(receipt.result);
  }

  /** A real process exit is the only place an execution owner may record a terminal session state. */
  async function settleExit(sessionRef: string, exit: NativeSessionExit) {
    try {
      await storage.request({ requestId: 'native-exit:' + randomUUID(), fingerprint: digest({ sessionRef, exit }) },
        async tx => {
          const { rows: [row] } = await tx.query('SELECT * FROM native_sessions WHERE session_ref=$1 FOR UPDATE', [sessionRef]);
          if (!row || ['succeeded', 'failed', 'cancelled'].includes(String(row.state))) return row ?? null;
          if (!exit.confirmed) {
            await tx.query(`UPDATE native_sessions SET status_knowledge='unknown', updated_at=clock_timestamp()
              WHERE session_ref=$1`, [sessionRef]);
            return null;
          }
          const expired = exit.expired;
          const state = expired ? 'failed' : exit.requested ? 'cancelled' : 'failed';
          const failure = expired === 'idle'
            ? reasonOf('budget-exceeded', '会话超过声明的空闲时限没有输入，已结束。')
            : expired === 'max'
              ? reasonOf('budget-exceeded', '会话达到最长持续时间，已结束。')
              : expired === 'output'
                ? reasonOf('output-too-large', '会话输出超过声明上限，已结束。')
                : expired === 'memory'
                  ? reasonOf('budget-exceeded', '会话工作集超过声明的内存预算，已结束。')
                  : exit.requested
                  ? reasonOf('worker-terminated', '本机会话已按请求停止。')
                  : reasonOf('resource-unavailable', '本机会话进程意外结束，原内部状态不可继续。');
          await tx.query(`UPDATE native_sessions SET state=$2,status_knowledge='confirmed',confirmed_seq=confirmed_seq+1,
            reason=$3,stopped_at=CASE WHEN $2='cancelled' THEN clock_timestamp() ELSE stopped_at END,
            updated_at=clock_timestamp() WHERE session_ref=$1`, [sessionRef, state, JSON.stringify(failure)]);
          const { rows: [updated] } = await tx.query('SELECT * FROM native_sessions WHERE session_ref=$1', [sessionRef]);
          return updated ?? null;
        });
    } catch { /* The stored unknown fact stays; a later query still reports what was confirmed. */ }
  }

  async function read(identity: SpaceIdentity, activityId: string, requestId: string): Promise<ExecutionQuery | null> {
    await ensureReady();
    const activity = await options.activity(identity, activityId);
    const row = await find(activityId, requestId);
    if (!row) return null;
    const query = queryOf(row);
    if (JSON.stringify(query.scope) !== JSON.stringify({
      environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId,
      activityId: activity.activityId })) fail('forbidden');
    return query;
  }

  async function list(identity: SpaceIdentity, activityId: string): Promise<ExecutionQuery[]> {
    await ensureReady();
    const activity = await options.activity(identity, activityId);
    const { rows } = await storage.read('SELECT * FROM native_sessions WHERE activity_id=$1 ORDER BY created_at DESC LIMIT 16',
      [activityId]);
    return rows.filter(row => row.action).map(queryOf).filter(query =>
      query.scope.environmentId === identity.environmentId && query.scope.spaceId === identity.spaceId
      && query.scope.principalId === identity.principalId && query.scope.activityId === activity.activityId);
  }

  function verifyOperation(activity: LearningActivity, action: ExecutionAction, control: ExecutionControl) {
    const { manifest } = bindingFor(activity, action);
    if (manifest.formatVersion !== 1) fail('missing');
    if (!manifest.session) fail('missing');
    const declared = manifest.session;
    verifyPlannedExecution(activity, { key: action.execution.instance.key,
      definitionDigest: action.execution.instance.definitionDigest, operationId: control.operationId, location: 'native' });
    if (control.operationId !== declared.operation.operationId) fail('identity-conflict');
    if (!acceptsState(declared.operation.parameters, control.parameters)) fail('invalid');
    const encoded = JSON.stringify(control.parameters);
    if (Buffer.byteLength(encoded, 'utf8') > action.execution.limits.inputBytes) fail('invalid');
  }

  /** A run reserved by an older installation may be read, but it must never advance again. */
  async function assertGeneration(row: Record<string, unknown>) {
    if (String(row.install_generation) === currentGeneration()) return;
    const sessionRef = String(row.session_ref);
    const reason = JSON.stringify(reasonOf('resource-unavailable',
      '安装代际已变化，旧安装不能再推进这条运行。'));
    await storage.request({ requestId: 'native-generation-fence:' + randomUUID(),
      fingerprint: digest({ sessionRef }) }, async tx => {
      await tx.query(`UPDATE native_sessions SET status_knowledge='unknown',reason=$2,updated_at=clock_timestamp()
        WHERE session_ref=$1 AND state NOT IN ('succeeded','failed','cancelled')`, [sessionRef, reason]);
      return true;
    }).catch(() => { /* An unwritable store cannot make the old authority valid again. */ });
    fail('forbidden');
  }

  async function control(identity: SpaceIdentity, activityId: string, requestId: string,
    value: unknown): Promise<ExecutionQuery> {
    await ensureReady();
    const activity = await options.activity(identity, activityId);
    const input = executionControlSchema.parse(value);
    const row = await find(activityId, requestId);
    if (!row) fail('missing');
    await assertGeneration(row);
    const action = executionActionSchema.parse(row.action);
    const scope = action.scope;
    if (scope.activityId !== activityId || scope.environmentId !== identity.environmentId
      || scope.spaceId !== identity.spaceId || scope.principalId !== identity.principalId) fail('forbidden');
    verifyOperation(activity, action, input);
    await verifyPlacement(identity, activity, action);
    const inputDigest = digest(input);
    const sessionRef = String(row.session_ref);
    const { rows: [previous] } = await storage.read('SELECT * FROM native_session_operations WHERE control_id=$1',
      [input.controlId]);
    if (previous) {
      if (previous.input_digest !== inputDigest || previous.session_ref !== sessionRef) fail('identity-conflict');
      if (previous.status === 'applied') return queryOf((await findRef(sessionRef))!);
      if (previous.status === 'rejected') fail('invalid');
    }
    if (['succeeded', 'failed', 'cancelled'].includes(String(row.state)) || row.stop_requested
      || row.status_knowledge !== 'confirmed' || row.state !== 'running') fail('invalid');
    const entry = live.get(sessionRef);
    if (!entry || entry.process.instanceId !== row.executor_instance_id) {
      await markUnknown(sessionRef, input.controlId, reasonOf('resource-unavailable',
        '原执行器实例已不可用，这次输入没有推进的新依据。'));
      throw new StorageError('unavailable');
    }
    if (previous && previous.status !== 'applied') {
      // The dispatch marker survived a lost reply; the original process is authoritative.
      const reconciled = await entry.process.reconcile(input.controlId).catch(() => null);
      if (reconciled) {
        if (!acceptsState(entry.result, reconciled.state)) {
          await markUnknown(sessionRef, input.controlId, reasonOf('algorithm-error', '原输入的观察与声明结构不一致。'));
          throw new StorageError('unavailable');
        }
        return confirmObservation(sessionRef, input.controlId, reconciled.seq, reconciled.state, reconciled.at);
      }
    }
    if (Number(row.applied_seq) !== input.expectedSeq) fail('identity-conflict');
    const seq = Number(row.applied_seq) + 1;
    const reserved = await storage.request({ requestId: 'native-control:' + input.controlId,
      fingerprint: digest({ sessionRef, inputDigest, seq }) }, async tx => {
      const { rows: [current] } = await tx.query('SELECT * FROM native_sessions WHERE session_ref=$1 FOR UPDATE', [sessionRef]);
      if (!current) fail('missing');
      if (String(current.install_generation) !== currentGeneration()
        || current.supervisor_epoch !== supervisorEpoch || current.executor_instance_id !== entry.process.instanceId) fail('forbidden');
      if (['succeeded', 'failed', 'cancelled'].includes(String(current.state)) || current.stop_requested
        || current.status_knowledge !== 'confirmed' || current.state !== 'running') fail('invalid');
      if (Number(current.applied_seq) !== input.expectedSeq) fail('identity-conflict');
      const { rows: [clash] } = await tx.query(`SELECT control_id FROM native_session_operations
        WHERE session_ref=$1 AND seq=$2 AND status='dispatching'`, [sessionRef, seq]);
      if (clash) fail('identity-conflict');
      const inserted = await tx.query(`INSERT INTO native_session_operations(control_id,session_ref,seq,operation_id,
        input_digest,parameters,status) VALUES($1,$2,$3,$4,$5,$6,'dispatching') ON CONFLICT(control_id) DO NOTHING RETURNING control_id`,
        [input.controlId, sessionRef, seq, input.operationId, inputDigest, JSON.stringify(input.parameters)]);
      if (!inserted.rowCount) {
        const { rows: [known] } = await tx.query('SELECT * FROM native_session_operations WHERE control_id=$1',
          [input.controlId]);
        if (!known || known.input_digest !== inputDigest) fail('identity-conflict');
        return { seq: Number(known.seq), applied: known.status === 'applied' };
      }
      return { seq, applied: false };
    });
    const booked = reserved.result as { seq: number; applied: boolean };
    if (booked.applied) return queryOf((await findRef(sessionRef))!);
    await verifyPlacement(identity, await options.activity(identity, activityId), action);
    await assertGeneration((await findRef(sessionRef))!);
    let observation;
    try {
      observation = await entry.process.input(input.controlId, booked.seq, input.parameters);
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code === 'algorithm-error') {
        await storage.request({ requestId: 'native-reject:' + input.controlId,
          fingerprint: digest({ sessionRef, inputDigest }) }, async tx => {
          await tx.query(`UPDATE native_session_operations SET status='rejected',reason=$2,updated_at=clock_timestamp()
            WHERE control_id=$1 AND status='dispatching'`, [input.controlId,
            JSON.stringify(reasonOf('invalid-input', error instanceof Error ? error.message : '输入未被会话接受。'))]);
          return true;
        });
        fail('invalid');
      }
      await markUnknown(sessionRef, input.controlId, reasonOf('resource-unavailable',
        '本机会话没有在时限内确认这次输入；结果未知，后续输入已冻结。'));
      throw new StorageError('unavailable');
    }
    if (observation.seq !== booked.seq || !acceptsState(entry.result, observation.state)) {
      await markUnknown(sessionRef, input.controlId, reasonOf('algorithm-error',
        '本机会话返回的观察与声明结构或顺序不一致。'));
      throw new StorageError('unavailable');
    }
    return confirmObservation(sessionRef, input.controlId, observation.seq, observation.state, observation.at);
  }

  async function confirmObservation(sessionRef: string, controlId: string, seq: number,
    state: unknown, at: string): Promise<ExecutionQuery> {
    const receipt = await storage.request({ requestId: 'native-observe:' + controlId,
      fingerprint: digest({ sessionRef, controlId, seq, state, at }) }, async tx => {
      const { rows: [current] } = await tx.query('SELECT * FROM native_sessions WHERE session_ref=$1 FOR UPDATE', [sessionRef]);
      if (!current) fail('missing');
      const { rows: [operation] } = await tx.query('SELECT * FROM native_session_operations WHERE control_id=$1', [controlId]);
      if (!operation) fail('missing');
      if (operation.session_ref !== sessionRef || Number(operation.seq) !== seq) fail('identity-conflict');
      if (operation.status === 'applied') return queryOf(current);
      if (typeof operation.input_digest !== 'string' || operation.input_digest.length !== 64) fail('corrupt');
      const observations = Array.isArray(current.observations) ? current.observations : [];
      const entry: ExecutionObservation = { seq, controlId, state, at };
      const next = [...observations.filter((item: ExecutionObservation) => item.controlId !== controlId), entry].slice(-64);
      await tx.query(`UPDATE native_session_operations SET status='applied',observation=$2,updated_at=clock_timestamp()
        WHERE control_id=$1`, [controlId, JSON.stringify(entry)]);
      if (['succeeded', 'failed', 'cancelled'].includes(String(current.state)) || current.stop_requested) return queryOf(current);
      if (String(current.install_generation) !== currentGeneration() || current.supervisor_epoch !== supervisorEpoch) {
        await tx.query(`UPDATE native_sessions SET status_knowledge='unknown',reason=$2,updated_at=clock_timestamp()
          WHERE session_ref=$1`, [sessionRef, JSON.stringify(reasonOf('resource-unavailable', '原执行代际已失权，迟到观察仅保存归档。'))]);
        const { rows: [fenced] } = await tx.query('SELECT * FROM native_sessions WHERE session_ref=$1', [sessionRef]);
        return queryOf(fenced!);
      }
      await tx.query(`UPDATE native_sessions SET applied_seq=$2,last_control_id=$3,observation=$4,observations=$5,
        status_knowledge='confirmed',confirmed_seq=confirmed_seq+1,updated_at=clock_timestamp() WHERE session_ref=$1`,
        [sessionRef, seq, controlId, JSON.stringify(state), JSON.stringify(next)]);
      const { rows: [updated] } = await tx.query('SELECT * FROM native_sessions WHERE session_ref=$1', [sessionRef]);
      return queryOf(updated!);
    });
    return executionQuerySchema.parse(receipt.result);
  }

  async function markUnknown(sessionRef: string, controlId: string, reason: { code: string; detail: string }) {
    try {
      await storage.request({ requestId: 'native-unknown:' + controlId,
        fingerprint: digest({ sessionRef, controlId }) }, async tx => {
        await tx.query(`UPDATE native_session_operations SET status='unknown',reason=$2,updated_at=clock_timestamp()
          WHERE control_id=$1 AND status='dispatching'`, [controlId, JSON.stringify(reason)]);
        await tx.query(`UPDATE native_sessions SET status_knowledge='unknown',reason=$2,updated_at=clock_timestamp()
          WHERE session_ref=$1 AND state NOT IN ('succeeded','failed','cancelled')`, [sessionRef, JSON.stringify(reason)]);
        return true;
      });
    } catch { /* The dispatching fact stays; an unreadable store must not fabricate an outcome. */ }
  }

  async function stop(identity: SpaceIdentity, activityId: string, requestId: string, value: unknown) {
    await ensureReady();
    const activity = await options.activity(identity, activityId);
    const input = executionStopSchema.parse(value);
    const row = await find(activityId, requestId);
    if (!row) fail('missing');
    const query = queryOf(row);
    if (query.scope.environmentId !== identity.environmentId || query.scope.spaceId !== identity.spaceId
      || query.scope.principalId !== identity.principalId || query.scope.activityId !== activity.activityId) fail('forbidden');
    const sessionRef = String(row.session_ref);
    await storage.request({ requestId: 'native-stop:' + input.stopId,
      fingerprint: digest({ activityId, requestId, stopId: input.stopId }) }, async tx => {
      await tx.query(`INSERT INTO native_session_stops(stop_id,session_ref,request_id,reason) VALUES($1,$2,$3,$4)
        ON CONFLICT(stop_id) DO NOTHING`, [input.stopId, sessionRef, requestId, input.reason]);
      await tx.query(`UPDATE native_sessions SET stop_requested=true,updated_at=clock_timestamp()
        WHERE session_ref=$1`, [sessionRef]);
      return true;
    });
    const latest = (await findRef(sessionRef))!;
    if (['succeeded', 'failed', 'cancelled'].includes(String(latest.state))) return queryOf(latest);
    const entry = live.get(sessionRef);
    if (!entry || entry.process.instanceId !== latest.executor_instance_id) {
      await storage.request({ requestId: 'native-stop-unknown:' + input.stopId,
        fingerprint: digest({ sessionRef, stopId: input.stopId }) }, async tx => {
        await tx.query(`UPDATE native_sessions SET status_knowledge='unknown',reason=$2,updated_at=clock_timestamp()
          WHERE session_ref=$1 AND state NOT IN ('succeeded','failed','cancelled')`, [sessionRef,
          JSON.stringify(reasonOf('resource-unavailable', '原执行器实例已不在本进程，无法确认停止是否已经生效。'))]);
        return true;
      });
      return queryOf((await findRef(sessionRef))!);
    }
    const stopped = await entry.process.stop(3000);
    const receipt = await storage.request({ requestId: 'native-stop-confirm:' + input.stopId,
      fingerprint: digest({ sessionRef, stopId: input.stopId, stopped }) }, async tx => {
      const { rows: [current] } = await tx.query('SELECT * FROM native_sessions WHERE session_ref=$1 FOR UPDATE', [sessionRef]);
      if (!current) fail('missing');
      if (['succeeded', 'failed', 'cancelled'].includes(String(current.state))) return queryOf(current);
      if (stopped) {
        await tx.query(`UPDATE native_sessions SET state='cancelled',status_knowledge='confirmed',
          confirmed_seq=confirmed_seq+1,reason=$2,stopped_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE session_ref=$1`, [sessionRef, JSON.stringify(reasonOf('worker-terminated', input.reason))]);
      } else {
        await tx.query(`UPDATE native_sessions SET status_knowledge='unknown',reason=$2,updated_at=clock_timestamp()
          WHERE session_ref=$1`, [sessionRef,
          JSON.stringify(reasonOf('resource-unavailable', '停止请求已受理，但受管进程尚未确认退出。'))]);
      }
      const { rows: [updated] } = await tx.query('SELECT * FROM native_sessions WHERE session_ref=$1', [sessionRef]);
      return queryOf(updated!);
    });
    live.delete(sessionRef);
    return executionQuerySchema.parse(receipt.result);
  }

  /**
   * The execution owner reclaims a process it already owns. It names the original executor
   * instance, so a student whose membership was revoked does not need to be the caller; the
   * confirmed terminal state is written only after the unit's cgroup is really gone.
   */
  async function reclaim(sessionRef: string): Promise<ExecutionQuery> {
    z.uuid().parse(sessionRef);
    const row = await findRef(sessionRef);
    if (!row) fail('missing');
    if (['succeeded', 'failed', 'cancelled'].includes(String(row.state))) return queryOf(row);
    const instanceId = String(row.executor_instance_id);
    await storage.request({ requestId: 'native-reclaim-request:' + randomUUID(),
      fingerprint: digest({ sessionRef, instanceId }) }, async tx => {
      await tx.query(`UPDATE native_sessions SET stop_requested=true,updated_at=clock_timestamp()
        WHERE session_ref=$1 AND executor_instance_id=$2`, [sessionRef, instanceId]);
      return true;
    });
    const active = live.get(sessionRef);
    let confirmed = active && active.process.instanceId === instanceId ? await active.process.stop(3000) : false;
    if (options.linuxEntry && !confirmed) {
      const unit = linuxSessionUnit(instanceId);
      await stopUnit(options.linuxEntry, unit, instanceId);
      const deadline = Date.now() + 3000;
      do {
        confirmed = await unitStopped(options.linuxEntry, unit, instanceId);
        if (confirmed) break;
        await delay(50);
      } while (Date.now() < deadline);
    }
    const receipt = await storage.request({ requestId: 'native-reclaim:' + randomUUID(),
      fingerprint: digest({ sessionRef, instanceId, confirmed }) }, async tx => {
      const { rows: [current] } = await tx.query('SELECT * FROM native_sessions WHERE session_ref=$1 FOR UPDATE', [sessionRef]);
      if (!current) fail('missing');
      if (['succeeded', 'failed', 'cancelled'].includes(String(current.state))) return queryOf(current);
      if (confirmed) {
        await tx.query(`UPDATE native_sessions SET stop_requested=true,state='cancelled',status_knowledge='confirmed',
          confirmed_seq=confirmed_seq+1,reason=$2,stopped_at=clock_timestamp(),updated_at=clock_timestamp()
          WHERE session_ref=$1`, [sessionRef,
          JSON.stringify(reasonOf('worker-terminated', '执行所有者已回收原进程。'))]);
      } else {
        await tx.query(`UPDATE native_sessions SET stop_requested=true,status_knowledge='unknown',reason=$2,
          updated_at=clock_timestamp() WHERE session_ref=$1`, [sessionRef,
          JSON.stringify(reasonOf('resource-unavailable', '执行所有者请求回收，但进程组退出尚未确认。'))]);
      }
      const { rows: [updated] } = await tx.query('SELECT * FROM native_sessions WHERE session_ref=$1', [sessionRef]);
      return queryOf(updated!);
    });
    live.delete(sessionRef);
    return executionQuerySchema.parse(receipt.result);
  }

  async function recover(generation: string) {
    await storage.request({ requestId: 'native-recover:' + supervisorEpoch + ':' + generation,
      fingerprint: digest({ supervisorEpoch, generation }) }, async tx => {
      await tx.query(`UPDATE native_sessions SET status_knowledge='unknown',reason=$3,updated_at=clock_timestamp()
        WHERE state IN ('queued','running','paused') AND (supervisor_epoch <> $1 OR install_generation <> $2)`,
        [supervisorEpoch, generation, JSON.stringify(reasonOf('resource-unavailable',
          '产品重启或安装代际变化后原执行器实例不可核实，旧会话不再推进；已确认的观察仍保留。'))]);
      return true;
    });
  }

  const probe = { promise: null as Promise<NativeSessionIsolation | null> | null };
  /** The entry is measured once per process; a host that cannot confine a session never gets one. */
  function linuxFact(): Promise<NativeSessionIsolation | null> {
    if (!options.linuxEntry) return Promise.resolve(null);
    if (options.linuxIsolation) return Promise.resolve(options.linuxIsolation);
    if (!probe.promise) {
      probe.promise = probeLinuxIsolation(options.linuxEntry, options.nodePath ?? process.execPath)
        .catch(() => null);
    }
    return probe.promise;
  }

  const ready = { generation: '', promise: null as Promise<void> | null };
  /** 恢复关闸重新打开后按当前代际重新失权，失败的恢复允许重试。 */
  function ensureReady(): Promise<void> {
    const generation = currentGeneration();
    if (!ready.promise || ready.generation !== generation) {
      ready.generation = generation;
      const attempt = recover(generation).catch(error => {
        if (ready.promise === attempt) ready.promise = null;
        throw error;
      });
      ready.promise = attempt;
    }
    return ready.promise;
  }

  async function shutdown() {
    await Promise.allSettled([...live.values()].map(entry => entry.process.dispose()));
    live.clear();
    await Promise.allSettled([...settling]);
  }
  process.once('exit', () => { for (const entry of live.values()) entry.process.terminateNow() });

  return {
    ensureReady,
    accept, read, list, control, stop, owns, shutdown, reclaim,
    async validate() { await validateNativeSessions(storage); },
    /** What the Linux restricted entry can actually enforce; `null` means it was not measured. */
    linuxEntryIsolation: linuxFact,
    supervisorEpoch,
  };
}

/** Recovery validation: a stored session still names its own activity, adapter and applied position. */
export async function validateNativeSessions(storage: OwnedStorage) {
  const { rows } = await storage.read('SELECT * FROM native_sessions');
  for (const row of rows) {
    const query = queryOf(row), action = executionActionSchema.parse(row.action);
    const fixedText = typeof row.action_text === 'string' ? row.action_text : JSON.stringify(action);
    let original: unknown;
    try { original = executionActionSchema.parse(JSON.parse(fixedText)); } catch { throw new StorageError('corrupt'); }
    if (canonicalDigest(original) !== canonicalDigest(action)) throw new StorageError('corrupt');
    const fixedDigest = createHash('sha256').update(fixedText).digest('hex');
    const { rows: [activity] } = await storage.read('SELECT body FROM activities WHERE id=$1', [row.activity_id]);
    const body = activity?.body as LearningActivity | undefined;
    if (!body || query.requestId !== row.request_id || query.executionRef !== row.session_ref
      || query.scope.activityId !== row.activity_id || query.scope.environmentId !== body.identity.environmentId
      || query.scope.spaceId !== body.identity.spaceId || query.scope.principalId !== body.identity.principalId
      || fixedDigest !== row.input_digest || Number(row.confirmed_seq) < 1
      || Number(row.applied_seq) < 0 || Number(row.confirmed_seq) < Number(row.applied_seq)) throw new StorageError('corrupt');
    const observations = Array.isArray(row.observations) ? row.observations : [];
    for (const item of observations) {
      const entry = item as ExecutionObservation;
      if (!entry || typeof entry.controlId !== 'string' || typeof entry.seq !== 'number') throw new StorageError('corrupt');
    }
  }
  const { rows: operations } = await storage.read('SELECT * FROM native_session_operations');
  for (const row of operations) {
    const { rows: [session] } = await storage.read('SELECT applied_seq,last_control_id,state,status_knowledge,stop_requested FROM native_sessions WHERE session_ref=$1',
      [row.session_ref]);
    if (!session) throw new StorageError('corrupt');
    if (row.status === 'applied') {
      const observation = row.observation as ExecutionObservation | null;
      if (!observation || observation.controlId !== row.control_id || observation.seq !== Number(row.seq)) throw new StorageError('corrupt');
      // 终态、失权或停止后的迟到确认只归档操作事实，不改变会话的已确认位置。
      if (Number(row.seq) > Number(session.applied_seq) && session.status_knowledge !== 'unknown'
        && !session.stop_requested && !['succeeded', 'failed', 'cancelled'].includes(String(session.state))) throw new StorageError('corrupt');
    }
  }
  const { rows: stops } = await storage.read('SELECT * FROM native_session_stops');
  for (const row of stops) {
    const { rows: [session] } = await storage.read('SELECT stop_requested FROM native_sessions WHERE session_ref=$1',
      [row.session_ref]);
    if (!session || !session.stop_requested) throw new StorageError('corrupt');
  }
}
