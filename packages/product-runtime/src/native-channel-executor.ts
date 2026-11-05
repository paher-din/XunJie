import { access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { StorageError } from '@xunjie/storage';
import { acceptsState, componentInstanceId, componentStateName } from '@xunjie/contracts/components';
import { activitySchema } from '@xunjie/contracts/learning-data';
import { canonicalValue, executionActionSchema, executionControlSchema, executionQuerySchema, executionStopSchema, isTerminalExecutionState } from '@xunjie/contracts/execution';
import type { ExecutionQuery } from '@xunjie/contracts/execution';
import { SupervisedSession, productNativeAdapters, nativeChannelNodeSchema } from '@xunjie/learning-space';
import type { NativeChannelCommand, NativeChannelNode, NativeSessionHostOptions } from '@xunjie/learning-space';
import type { NativeObservation } from '@xunjie/learning-space';

/** 只登记本机已具备强制隔离的产品适配器；外部登记数据不决定可执行代码。 */
export async function nativeChannelNode(options: NativeSessionHostOptions & {
  connectionId: string; installationId: string;
}): Promise<NativeChannelNode> {
  const platform = globalThis.process.platform === 'darwin' && globalThis.process.arch === 'arm64' ? 'macos-arm64'
    : globalThis.process.platform === 'win32' && globalThis.process.arch === 'x64' ? 'windows-x64'
    : globalThis.process.platform === 'linux' && globalThis.process.arch === 'x64' ? 'linux-x64' : null;
  if (!platform) throw new StorageError('unavailable');
  let isolated = false;
  if (platform === 'macos-arm64') isolated = await access('/usr/bin/sandbox-exec').then(() => true, () => false);
  if (platform === 'windows-x64') isolated = !!options.windowsHelper && await access(options.windowsHelper).then(() => true, () => false);
  if (platform === 'linux-x64') isolated = !!options.linuxEntry && !!options.linuxIsolation;
  const adapters: NativeChannelNode['adapters'] = [];
  if (isolated) for (const adapter of productNativeAdapters.filter(item => item.platforms?.includes(platform))) {
    let probe: SupervisedSession | undefined;
    try {
      probe = await SupervisedSession.create({ adapter,
        ...(options.nodePath ? { nodePath: options.nodePath } : {}), ...(options.sessionRoot ? { sessionRoot: options.sessionRoot } : {}),
        ...(options.windowsHelper ? { windowsHelper: options.windowsHelper } : {}), ...(options.linuxEntry ? { linuxEntry: options.linuxEntry } : {}),
        ...(options.linuxIsolation ? { linuxIsolation: options.linuxIsolation } : {}),
        limits: { operationTimeoutMs: 1000, idleMs: 5000, maxMs: 10000, memoryMiB: 64, outputBytes: 65536 } });
      if (probe.isolation.kind !== 'process-group' && await probe.stop()) adapters.push({ adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion });
    } catch { /* 未通过实际受限启动与退出确认的适配器不登记可用。 */ }
    finally { await probe?.dispose(); }
  }
  return nativeChannelNodeSchema.parse({ connectionId: options.connectionId, installationId: options.installationId,
    nodeId: options.nodeId ?? `local-${options.installationId}`, platform, supervisorEpoch: options.supervisorEpoch ?? randomUUID(), adapters,
    runtime: { platform: process.platform, arch: process.arch, node: process.version } });
}

/** 学校保管唯一持久账本。本机只对已领取的固定快照执行产品登记适配器，不需要活动或作品数据库。 */
export function createNativeChannelExecutor(options: NativeSessionHostOptions & { node: NativeChannelNode }) {
  const node = nativeChannelNodeSchema.parse(options.node);
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
  let cleanupGeneration = 0;
  const sessions = new Map<string, { process: SupervisedSession; query: ExecutionQuery;
    operationId: string; controls: readonly string[]; checkpointVersion?: number;
    parameters: Parameters<typeof acceptsState>[0]; result: Parameters<typeof acceptsState>[0] }>();
  const fail = (code: 'invalid' | 'identity-conflict' | 'forbidden' | 'missing'): never => { throw new StorageError(code); };
  function fixed(query: ExecutionQuery, command: NativeChannelCommand) {
    const session = query.session;
    if (!session || query.executionRef !== command.sessionId || query.scope.activityId !== command.activityId
      || session.nodeId !== node.nodeId || session.installGeneration !== node.installationId
      || session.supervisorEpoch !== node.supervisorEpoch) return fail('forbidden');
    return session;
  }
  async function execute(command: NativeChannelCommand): Promise<ExecutionQuery | { query: ExecutionQuery;
    checkpoint: { observation: NativeObservation; environment: { platform: string; arch: string; node: string } } }> {
    for (const sessionId of sessions.keys()) query(sessionId);
    if (command.operation === 'submit') {
      const input = z.object({ action: executionActionSchema, activity: activitySchema, execution: executionQuerySchema,
        restore: z.object({ snapshot: z.json(), environment: z.object({ platform: z.string(), arch: z.string(), node: z.string() }).strict() }).strict().optional(),
      }).strict().parse(command.payload);
      const { action, activity } = input, execution = input.execution, session = fixed(execution, command);
      if (sessions.has(command.sessionId)) return fail('identity-conflict');
      const run = action.execution, spec = run.session, instance = run.instance;
      const binding = activity.course?.components?.find(item => item.key === instance.key);
      if (!binding || binding.definition.manifest.formatVersion !== 1 || !binding.definition.manifest.session || !spec) return fail('invalid');
      const manifest = binding.definition.manifest, declared = manifest.session!;
      if (action.requestId !== execution.requestId || command.commandId !== action.requestId || action.scope.activityId !== activity.activityId
        || activity.activityId !== command.activityId || action.scope.environmentId !== execution.scope.environmentId
        || action.scope.spaceId !== execution.scope.spaceId || action.scope.principalId !== execution.scope.principalId
        || activity.identity.environmentId !== action.scope.environmentId || activity.identity.spaceId !== action.scope.spaceId
        || activity.identity.principalId !== action.scope.principalId || run.plan.location !== 'native' || run.plan.kind !== 'session'
        || componentInstanceId(activity.activityId, instance.key) !== instance.instanceId || binding.definition.digest !== instance.definitionDigest
        || manifest.componentId !== instance.componentId || manifest.version !== instance.componentVersion
        || manifest.hostApiVersion !== instance.hostApiVersion || manifest.stateVersion !== instance.stateVersion
        || declared.adapterId !== spec.adapterId || declared.adapterVersion !== spec.adapterVersion
        || declared.adapterId !== session.adapterId || declared.adapterVersion !== session.adapterVersion
        || session.instanceId !== instance.instanceId || session.instanceKey !== instance.key
        || declared.operation.operationId !== run.operation.operationId || run.operation.effect !== 'input'
        || !acceptsState(declared.parameters, run.parameters)) return fail('identity-conflict');
      const budget = declared.budgets, limits = spec.limits;
      if (limits.operationTimeoutMs !== budget.operationTimeoutMs || limits.idleMs !== budget.idleMs || limits.maxMs !== budget.maxMs
        || limits.memoryMiB !== budget.memoryMiB || limits.concurrentSessions !== budget.concurrentSessions || limits.queuedSessions !== budget.queuedSessions
        || run.limits.timeMs > budget.operationTimeoutMs || run.limits.outputBytes > budget.outputBytes
        || run.limits.inputBytes > budget.inputBytes || run.basis.resources.length) return fail('invalid');
      if (run.plan.planId !== 'native-session' || run.plan.planVersion !== 1 || run.plan.planDigest !== hash({
        planId: run.plan.planId, planVersion: run.plan.planVersion, componentId: manifest.componentId,
        componentVersion: manifest.version, operationId: run.operation.operationId })
        || run.limits.concurrentJobs > budget.concurrentSessions || run.limits.queuedJobs > budget.queuedSessions) return fail('invalid');
      const state = run.basis.state;
      if ((state?.contentId ?? null) !== run.basis.expected.stateContentId) return fail('invalid');
      if (state) {
        const file = run.basis.works.find(item => item.name === state.name);
        if (!file || state.name !== componentStateName(instance.key) || file.contentId !== state.contentId
          || file.kind !== 'state' || file.encoding !== 'json' || file.mediaType !== 'application/vnd.xunjie.component-state+json') return fail('invalid');
        if (hash(JSON.parse(file.value)) !== state.sha256) return fail('invalid');
      }
      const platform = globalThis.process.platform === 'darwin' && globalThis.process.arch === 'arm64' ? 'macos-arm64'
        : globalThis.process.platform === 'win32' && globalThis.process.arch === 'x64' ? 'windows-x64'
        : globalThis.process.platform === 'linux' && globalThis.process.arch === 'x64' ? 'linux-x64' : null;
      if (platform !== node.platform || platform === 'linux-x64' && (!options.linuxEntry || !options.linuxIsolation)
        || platform === 'windows-x64' && !options.windowsHelper) return fail('forbidden');
      const adapter = productNativeAdapters.find(item => item.adapterId === declared.adapterId && item.adapterVersion === declared.adapterVersion);
      if (!adapter?.platforms?.includes(node.platform) || !node.adapters.some(item => item.adapterId === adapter.adapterId
        && item.adapterVersion === adapter.adapterVersion)) return fail('forbidden');
      if (declared.controls?.some(effect => !adapter.controls?.includes(effect))
        || declared.checkpointVersion && declared.checkpointVersion !== adapter.checkpointVersion
        || !!run.resumeFromCheckpoint !== !!input.restore
        || input.restore && hash(input.restore.environment) !== hash({ platform: globalThis.process.platform,
          arch: globalThis.process.arch, node: globalThis.process.version })) return fail('invalid');
      const sameAdapter = [...sessions.values()].filter(item => !isTerminalExecutionState(item.query.state)
        && item.query.session?.adapterId === adapter.adapterId).length;
      if (sameAdapter >= limits.concurrentSessions) return fail('forbidden');
      const generation = cleanupGeneration;
      const process = await SupervisedSession.create({ adapter, instanceId: session.executorInstanceId,
        ...(options.nodePath ? { nodePath: options.nodePath } : {}), ...(options.windowsHelper ? { windowsHelper: options.windowsHelper } : {}),
        ...(options.sessionRoot ? { sessionRoot: options.sessionRoot } : {}), ...(options.linuxEntry ? { linuxEntry: options.linuxEntry } : {}),
        ...(options.linuxIsolation ? { linuxIsolation: options.linuxIsolation } : {}),
        limits: { operationTimeoutMs: run.limits.timeMs, idleMs: limits.idleMs, maxMs: limits.maxMs,
          memoryMiB: limits.memoryMiB, outputBytes: run.limits.outputBytes },
      });
      if (generation !== cleanupGeneration) { await process.dispose(); return fail('forbidden'); }
      let initial = process.initialObservation, initialState = 'running';
      if (input.restore) {
        try { const recovered = await process.restore(input.restore.snapshot); initial = recovered.state; initialState = recovered.sessionState; }
        catch (error) { await process.dispose(); throw error; }
      }
      if (generation !== cleanupGeneration) { await process.dispose(); return fail('forbidden'); }
      if (!acceptsState(declared.operation.result, initial)) { await process.dispose(); return fail('invalid'); }
      const query = executionQuerySchema.parse({ ...execution, state: initialState, confirmedSeq: execution.confirmedSeq + 1,
        statusKnowledge: 'confirmed', session: { ...session, observation: initial } });
      sessions.set(command.sessionId, { process, query, operationId: declared.operation.operationId,
        controls: declared.controls ?? [], ...(declared.checkpointVersion ? { checkpointVersion: declared.checkpointVersion } : {}),
        parameters: declared.operation.parameters, result: declared.operation.result });
      return query;
    }
    const entry = sessions.get(command.sessionId);
    if (!entry) return fail('missing');
    const session = fixed(entry.query, command);
    if (command.operation === 'control') {
      const input = z.object({ requestId: z.uuid(), executionRef: z.uuid(), control: executionControlSchema }).strict().parse(command.payload);
      if (input.requestId !== entry.query.requestId || input.executionRef !== entry.query.executionRef || input.control.controlId !== command.commandId
        || input.control.expectedSeq !== session.appliedSeq || isTerminalExecutionState(entry.query.state)
        || entry.query.stopRequested || entry.query.statusKnowledge !== 'confirmed') return fail('identity-conflict');
      const control = input.control;
      if (control.effect === 'input' ? control.operationId !== entry.operationId
        : control.operationId !== control.effect || !entry.controls.includes(control.effect)) return fail('invalid');
      if (control.effect === 'input' || control.effect === 'step') {
        if (!acceptsState(entry.parameters, control.parameters)) return fail('invalid');
      } else if (!control.parameters || typeof control.parameters !== 'object' || Array.isArray(control.parameters)
        || Object.keys(control.parameters).length) return fail('invalid');
      const observation = await entry.process.control(control.effect, control.controlId, session.appliedSeq + 1, control.parameters);
      if (!acceptsState(entry.result, observation.state)) { await entry.process.dispose(); return fail('invalid'); }
      entry.query = executionQuerySchema.parse({ ...entry.query, state: observation.sessionState ?? entry.query.state,
        confirmedSeq: entry.query.confirmedSeq + 1,
        session: { ...session, appliedSeq: observation.seq, lastControlId: observation.controlId, observation: observation.state,
          observations: [...session.observations, { seq: observation.seq, controlId: observation.controlId,
            state: observation.state, at: observation.at }].slice(-64) } });
      if (control.effect === 'checkpoint') {
        if (observation.checkpoint === undefined || !entry.checkpointVersion) return fail('invalid');
        return { query: entry.query, checkpoint: { observation,
          environment: { platform: process.platform, arch: process.arch, node: process.version } } };
      }
      return entry.query;
    }
    const input = z.object({ requestId: z.uuid(), executionRef: z.uuid(), stop: executionStopSchema }).strict().parse(command.payload);
    if (input.requestId !== entry.query.requestId || input.executionRef !== entry.query.executionRef || input.stop.stopId !== command.commandId) return fail('identity-conflict');
    if (isTerminalExecutionState(entry.query.state) && entry.query.statusKnowledge === 'confirmed') return entry.query;
    const confirmed = await entry.process.stop();
    entry.query = executionQuerySchema.parse({ ...entry.query, stopRequested: true, state: confirmed ? 'cancelled' : entry.query.state,
      statusKnowledge: confirmed ? 'confirmed' : 'unknown', confirmedSeq: entry.query.confirmedSeq + (confirmed ? 1 : 0),
      reason: confirmed ? entry.query.reason : { code: 'resource-unavailable', detail: '原生会话进程尚未确认退出，保留原停止请求以继续核实。' } });
    return entry.query;
  }
  async function cleanup() {
    cleanupGeneration++;
    const results = await Promise.allSettled([...sessions.values()].map(async entry => {
      if (isTerminalExecutionState(entry.query.state) && entry.query.statusKnowledge === 'confirmed') return;
      const confirmed = await entry.process.stop();
      entry.query = executionQuerySchema.parse({ ...entry.query, stopRequested: true, state: confirmed ? 'cancelled' : entry.query.state,
        statusKnowledge: confirmed ? 'confirmed' : 'unknown', confirmedSeq: entry.query.confirmedSeq + (confirmed ? 1 : 0),
        reason: confirmed ? null : { code: 'resource-unavailable', detail: '原生会话进程尚未确认退出，保留原实例以继续清理。' } });
      if (!confirmed) throw new StorageError('unavailable');
    }));
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), '原生会话尚未确认停止。');
  }
  function query(sessionId: string): ExecutionQuery | null {
    const entry = sessions.get(z.uuid().parse(sessionId));
    if (!entry) return null;
    const exit = entry.process.exitFact;
    if (exit && !isTerminalExecutionState(entry.query.state)) {
      entry.query = executionQuerySchema.parse({ ...entry.query, state: exit.confirmed ? (exit.expired ? 'failed' : exit.requested ? 'cancelled' : 'failed') : entry.query.state,
        reason: exit.expired ? { code: 'budget-exceeded', detail: `会话已达到 ${exit.expired} 预算，原进程已回收。` } : exit.confirmed && entry.query.reason?.code === 'resource-unavailable' ? null : entry.query.reason,
        statusKnowledge: exit.confirmed ? 'confirmed' : 'unknown', confirmedSeq: entry.query.confirmedSeq + (exit.confirmed ? 1 : 0) });
    }
    return entry.query;
  }
  function snapshots(): ExecutionQuery[] {
    return [...sessions.keys()].map(sessionId => query(sessionId)!);
  }
  return { execute, cleanup, query, snapshots };
}
