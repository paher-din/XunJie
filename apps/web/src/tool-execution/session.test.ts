import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { componentManifestSchema } from '@xunjie/contracts/components'
import { executionQuerySchema, type ExecutionAction, type ExecutionControl, type ExecutionControlReceipt, type ExecutionQuery } from '@xunjie/contracts/execution'
import type { ReliableWorkspace } from '../reliable-workspace'
import { nativeLimits, sessionAction, sessionPlacement } from './session'
import { digestOf } from './action'
import { observeExecutionDevice, observeExecutionPlatform, sessionExecutionDevice, type ExecutionEnvironment } from './device'
import type { CourseExecutionPlan, ExecutionDevice } from '@xunjie/contracts/execution'
import { NativeSessionController } from './session-controller'
import { SessionRequests } from './session-requests'
import { openWorkspaceDatabase } from '../reliable-workspace/draft-store'

const controllers: NativeSessionController[] = []
const managed = (controller: NativeSessionController) => { controllers.push(controller); return controller }
afterEach(() => { controllers.splice(0).forEach(controller => controller.dispose()) })

const componentId = crypto.randomUUID()
const manifest = componentManifestSchema.parse({ formatVersion: 1, componentId, version: 1, hostApiVersion: 1,
  title: '四态累加模拟',
  entry: { resourceId: crypto.randomUUID(), sha256: 'b'.repeat(64), byteLength: 20, mediaType: 'text/html' },
  stateVersion: 1, stateShape: { type: 'object', properties: {} }, initialState: {},
  requiredCapabilities: ['execution.submit'],
  session: { adapterId: 'four-state-accumulator', adapterVersion: 1,
    parameters: { type: 'object', properties: {} },
    operation: { operationId: 'advance', parameters: { type: 'object', properties: { value: { type: 'number' } } },
      result: { type: 'object', properties: { value: { type: 'number' }, total: { type: 'number' }, applied: { type: 'number' } } } },
    budgets: { operationTimeoutMs: 5000, idleMs: 600000, maxMs: 3600000, memoryMiB: 64, inputBytes: 1024,
      outputBytes: 65536, concurrentSessions: 2, queuedSessions: 0 } } })
const binding = { key: 'accumulator', configuration: { title: '四态累加模拟' }, materialIds: [],
  definition: { digest: 'a'.repeat(64), manifest } }
const activityId = crypto.randomUUID(), environmentId = crypto.randomUUID(), spaceId = crypto.randomUUID()
const principalId = crypto.randomUUID()
const scope = { environmentId, spaceId, principalId, activityId }
const key = JSON.stringify(['school', environmentId, spaceId, principalId, activityId])
const instanceId = `${activityId}:accumulator`
const workspace = { key, snapshot: () => ({ ready: true, files: [] }) } as unknown as ReliableWorkspace
const receiver = { receiverId: 'native-execution', location: 'local' as const, kind: 'execution' as const }

const query = (patch: Partial<ExecutionQuery> = {}): ExecutionQuery => executionQuerySchema.parse({
  requestId: crypto.randomUUID(), inputDigest: 'c'.repeat(64), scope, executionRef: crypto.randomUUID(),
  state: 'running', statusKnowledge: 'confirmed', stopRequested: false, confirmedSeq: 2, reason: null, output: null,
  session: { adapterId: 'four-state-accumulator', adapterVersion: 1, instanceId, instanceKey: 'accumulator',
    nodeId: 'local-native', installGeneration: 'generation', supervisorEpoch: crypto.randomUUID(),
    executorInstanceId: crypto.randomUUID(), appliedSeq: 0, lastControlId: null,
    observation: { value: 0, total: 0, applied: 0 }, observations: [] }, ...patch })

describe('the native session command is assembled by the host', () => {
  it('pins the native plan, the declared adapter and the session budgets', async () => {
    const action = await sessionAction({ workspace, binding, instanceId, receiver, parameters: {}, requestId: crypto.randomUUID() })
    expect(action.execution.plan.location).toBe('native')
    expect(action.execution.plan.kind).toBe('session')
    expect(action.execution.operation).toEqual({ operationId: 'advance', effect: 'input' })
    expect(action.execution.session).toMatchObject({ adapterId: 'four-state-accumulator', adapterVersion: 1,
      limits: { idleMs: 600000, memoryMiB: 64 } })
    expect(action.execution.limits).toEqual({ timeMs: 5000, memoryPages: 1, inputBytes: 1024, outputBytes: 65536,
      concurrentJobs: 2, queuedJobs: 0 })
    expect(action.execution.basis).toMatchObject({ works: [], state: null, expected: { stateContentId: null }, resources: [] })
    expect(nativeLimits(manifest.formatVersion === 1 ? manifest.session! : expect.anything())).toEqual(action.execution.limits)
  })
  it('refuses creation parameters the manifest does not declare', async () => {
    await expect(sessionAction({ workspace, binding, instanceId, receiver, parameters: { value: 1 },
      requestId: crypto.randomUUID() })).rejects.toThrow('invalid-input')
  })
})

describe('发布方案决定原生会话执行位置', () => {
  const plan = async (): Promise<CourseExecutionPlan> => ({ planId: 'published-session', planVersion: 3,
    planDigest: 'd'.repeat(64), components: [{ key: binding.key, definitionDigest: binding.definition.digest,
      configurationDigest: await digestOf(binding.configuration), operations: ['advance'] }],
    capabilities: ['native-session'], locations: ['native'], resources: { browser: null,
      native: { memoryMiB: 64, operationTimeoutMs: 5000, maxMs: 3600000 } },
    remote: { nodeClass: 'school-execution-node', secureTransport: true,
      adapter: { adapterId: 'four-state-accumulator', adapterVersion: 1 }, clientPlatforms: ['macos-arm64'] } })
  const device = (native: ExecutionDevice['native']): ExecutionDevice => ({ platform: 'macos-arm64',
    browser: { worker: true, webassembly: true, sandboxedFrame: true }, native })
  const create = (placement: NonNullable<Parameters<typeof sessionAction>[0]['placement']>) =>
    sessionAction({ workspace, binding, instanceId, receiver, parameters: {}, requestId: crypto.randomUUID(), placement })

  it('未知本机能力不因学校节点可用而迁移执行', async () => {
    const placement = { plan: await plan(), device: device(null), remoteAvailable: true }
    expect(sessionPlacement(binding, placement)).toMatchObject({ location: null, owner: null })
    await expect(create(placement)).rejects.toThrow('尚未报告')
  })
  it('缺少安装或准备失败保留在本机处理', async () => {
    for (const native of [
      { supported: true, installed: false, authorized: true, prepared: 'none' as const },
      { supported: true, installed: true, authorized: true, prepared: 'failed' as const },
    ]) {
      const placement = { plan: await plan(), device: device(native), remoteAvailable: true }
      expect(sessionPlacement(binding, placement).owner).toBeNull()
      await expect(create(placement)).rejects.toThrow()
    }
  })
  it('仅已观测不支持的平台与发布方案匹配时传远端执行和设备证据', async () => {
    const placement = { plan: await plan(),
      device: device({ supported: false, installed: false, authorized: false, prepared: 'none' }), remoteAvailable: true }
    const action = await create(placement)
    expect(action.receiver.location).toBe('remote')
    expect(action.execution.plan).toMatchObject({ planId: 'native-session', planVersion: 1, location: 'native', kind: 'session' })
    expect(action.execution).toHaveProperty('device', placement.device)
    await expect(create({ ...placement, remoteAvailable: false })).rejects.toThrow()
    await expect(create({ ...placement, device: { ...placement.device, platform: null } })).rejects.toThrow()
  })
  it('本机就绪保持本机执行且拒绝发布配置漂移', async () => {
    const placement = { plan: await plan(),
      device: device({ supported: true, installed: true, authorized: true, prepared: 'ready' }), remoteAvailable: true }
    expect((await create(placement)).receiver.location).toBe('local')
    placement.plan.components[0].configurationDigest = 'e'.repeat(64)
    await expect(create(placement)).rejects.toThrow('not-planned')
  })
  it('学校服务不能冒充客户端能力，只有明确平台限制能证明本机不支持', () => {
    const adapter = { adapterId: 'linux-experiment', adapterVersion: 1 }
    const environment: ExecutionEnvironment = { nodeClass: 'school-execution-node', secureTransport: true,
      remoteAvailable: true, device: device({ supported: true, installed: true, authorized: true, prepared: 'ready' }),
      adapters: [{ ...adapter, platforms: ['linux-x64'] }] }
    expect(sessionExecutionDevice(environment, null, adapter).native).toBeNull()
    expect(sessionExecutionDevice(environment, 'macos-arm64', adapter)).toMatchObject({ platform: 'macos-arm64',
      native: { supported: false, installed: false, authorized: false, prepared: 'none' } })
    expect(sessionExecutionDevice(environment, 'linux-x64', adapter).native).toBeNull()
    expect(sessionExecutionDevice({ ...environment, adapters: [] }, 'macos-arm64', adapter).native).toBeNull()
    expect(sessionExecutionDevice({ ...environment, nodeClass: 'device' }, null, { adapterId: 'other', adapterVersion: 1 }).native)
      .toEqual(environment.device.native)
    expect(observeExecutionDevice().platform).toBeNull()
  })
  it('本机登记与学校能力共存时按操作区分平台限制和未就绪适配器', async () => {
    const published = await plan()
    const adapter = published.remote!.adapter
    const environment: ExecutionEnvironment = { nodeClass: 'device', secureTransport: true, remoteAvailable: true,
      device: device({ supported: true, installed: true, authorized: true, prepared: 'ready' }),
      adapters: [{ ...adapter, platforms: ['linux-x64'], available: false }] }
    const unsupported = sessionExecutionDevice(environment, 'macos-arm64', adapter)
    expect(sessionPlacement(binding, { plan: published, device: unsupported, remoteAvailable: environment.remoteAvailable }))
      .toMatchObject({ state: 'device-unsupported', owner: 'school-node', location: 'native' })
    const unavailable = sessionExecutionDevice({ ...environment,
      adapters: [{ ...adapter, platforms: ['macos-arm64'], available: false }] }, 'macos-arm64', adapter)
    expect(sessionPlacement(binding, { plan: published, device: unavailable, remoteAvailable: true }))
      .toMatchObject({ state: 'install-missing', owner: null, location: null })
  })
  it('通过高熵平台实测识别架构，拒绝缺失与失败的观测', async () => {
    const client = (platform: string, architecture: string, bitness = '64') => ({ userAgentData: {
      getHighEntropyValues: vi.fn(async () => ({ platform, architecture, bitness })) } })
    expect(await observeExecutionPlatform(client('macOS', 'arm'))).toBe('macos-arm64')
    expect(await observeExecutionPlatform(client('Windows', 'x86'))).toBe('windows-x64')
    expect(await observeExecutionPlatform(client('Linux', 'x86'))).toBe('linux-x64')
    expect(await observeExecutionPlatform(client('macOS', 'x86'))).toBeNull()
    expect(await observeExecutionPlatform(client('Windows', 'x86', '32'))).toBeNull()
    expect(await observeExecutionPlatform({})).toBeNull()
    expect(await observeExecutionPlatform({ userAgentData: { getHighEntropyValues: async () => { throw new Error('denied') } } })).toBeNull()
  })
})

describe('the session controller keeps the owner reference and the next expected sequence', () => {
  const open = (overrides: Partial<import('../product/executionTransport').SessionTransport> = {}) => {
    const first = query()
    const transport = {
      list: vi.fn(async () => [first]),
      create: vi.fn(async (_action: ExecutionAction) => first),
      read: vi.fn(async (_requestId: string): Promise<ExecutionQuery | null> => first),
      control: vi.fn(async (_requestId: string, control: ExecutionControl) => query({
        requestId: first.requestId, executionRef: first.executionRef, confirmedSeq: 3,
        session: { ...first.session!, appliedSeq: control.expectedSeq + 1,
          observation: { value: 1, total: 1, applied: control.expectedSeq + 1 } } })),
      stop: vi.fn(async (_requestId: string, _stopId: string, _reason: string): Promise<ExecutionQuery> => ({ ...first, state: 'cancelled', confirmedSeq: 3 })),
    }
    return { first, transport, controller: managed(new NativeSessionController(
      JSON.stringify([crypto.randomUUID(), environmentId, spaceId, principalId, activityId]), Object.assign(transport, overrides))) }
  }

  it('reads sessions for this scope and sends the last confirmed sequence', async () => {
    const { first, transport, controller } = open()
    await controller.open()
    expect(controller.find(instanceId)?.requestId).toBe(first.requestId)
    const updated = await controller.input(first, 'advance', { value: 1 })
    expect(transport.control).toHaveBeenCalledWith(first.requestId, expect.objectContaining({
      operationId: 'advance', effect: 'input', expectedSeq: 0, parameters: { value: 1 } }))
    expect(updated.session?.appliedSeq).toBe(1)
    expect(controller.find(instanceId)?.session?.appliedSeq).toBe(1)
  })
  it('丢失启动确认后重载按原请求核对，不创建第二个会话', async () => {
    const { first, transport, controller } = open()
    let accepted = false
    transport.list.mockImplementation(async () => [])
    transport.read.mockImplementation(async () => accepted ? first : null)
    transport.create.mockImplementation(async action => {
      expect(action.requestId).toBe(first.requestId)
      accepted = true
      throw new Error('lost-ack')
    })
    const action = await sessionAction({ workspace, binding, instanceId, receiver, parameters: {}, requestId: first.requestId })
    await expect(controller.start(action)).rejects.toThrow('lost-ack')
    expect(controller.pending(instanceId)).toBe('start')
    const reopened = managed(new NativeSessionController(controller.scope, transport))
    await reopened.open()
    expect(reopened.find(instanceId)?.requestId).toBe(first.requestId)
    expect(reopened.pending(instanceId)).toBeNull()
    expect(transport.create).toHaveBeenCalledTimes(1)
  })

  it('启动尚未被接收时，重载重发完全相同的固定输入', async () => {
    const { first, transport, controller } = open()
    transport.list.mockImplementation(async () => [])
    transport.read.mockImplementation(async () => null)
    transport.create.mockRejectedValueOnce(new Error('offline'))
    const action = await sessionAction({ workspace, binding, instanceId, receiver, parameters: {}, requestId: first.requestId })
    await expect(controller.start(action)).rejects.toThrow('offline')
    const reopened = managed(new NativeSessionController(controller.scope, transport))
    await reopened.open()
    expect(transport.create.mock.calls.map(([sent]) => sent)).toEqual([action, action])
    expect(reopened.find(instanceId)?.requestId).toBe(first.requestId)
  })

  it('输入已应用但确认丢失时重载仅核对，禁止生成另一次输入', async () => {
    const { first, transport, controller } = open()
    await controller.open()
    let known = first
    transport.read.mockImplementation(async () => known)
    transport.control.mockImplementation(async (_requestId, control) => {
      known = { ...first, confirmedSeq: 3, session: { ...first.session!, appliedSeq: 1,
        lastControlId: control.controlId, observation: { value: 1 }, observations: [] } }
      throw new Error('lost-ack')
    })
    await expect(controller.input(first, 'advance', { value: 1 })).rejects.toThrow('lost-ack')
    await expect(controller.input(first, 'advance', { value: 2 })).rejects.toThrow('pending-control')
    const reopened = managed(new NativeSessionController(controller.scope, transport))
    await reopened.open()
    expect(transport.control).toHaveBeenCalledTimes(1)
    expect(reopened.pending(instanceId)).toBeNull()
    expect(reopened.find(instanceId)?.session?.appliedSeq).toBe(1)
  })

  it('未应用的输入重载后保留 controlId、expectedSeq 与参数', async () => {
    const { first, transport, controller } = open()
    await controller.open()
    transport.control.mockRejectedValueOnce(new Error('offline'))
    await expect(controller.input(first, 'advance', { value: 7 })).rejects.toThrow('offline')
    const original = transport.control.mock.calls[0]![1]
    const reopened = managed(new NativeSessionController(controller.scope, transport))
    await reopened.open()
    expect(transport.control.mock.calls[1]![1]).toEqual(original)
    expect(reopened.find(instanceId)?.session?.appliedSeq).toBe(1)
  })

  it('停止请求跨重载保留同一身份', async () => {
    const { first, transport, controller } = open()
    await controller.open()
    transport.stop.mockRejectedValueOnce(new Error('lost-stop'))
    await expect(controller.stop(first.requestId)).rejects.toThrow('lost-stop')
    const stopId = transport.stop.mock.calls[0]![1]
    const reopened = managed(new NativeSessionController(controller.scope, transport))
    // 模拟停止尚未应用，仍只能重发原身份。
    transport.stop.mockImplementation(async () => ({ ...first, stopRequested: true, confirmedSeq: 3 }))
    await reopened.open()
    expect(transport.stop.mock.calls[1]![1]).toBe(stopId)
    expect(reopened.pending(instanceId)).toBeNull()
  })

  it('并行查询乱序与迟到的列表不会回退观察或终态', async () => {
    const { first, transport, controller } = open()
    await controller.open()
    let finishOld!: (value: ExecutionQuery) => void
    transport.read.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    const older = controller.refresh(first.requestId)
    const newer = { ...first, confirmedSeq: 4, session: { ...first.session!, appliedSeq: 2 } }
    transport.read.mockResolvedValueOnce(newer)
    await controller.refresh(first.requestId)
    finishOld(first)
    await older
    expect(controller.find(instanceId)?.session?.appliedSeq).toBe(2)
    await controller.open()
    expect(controller.find(instanceId)?.session?.appliedSeq).toBe(2)
    transport.read.mockResolvedValueOnce({ ...newer, state: 'cancelled', confirmedSeq: 5 })
    await controller.refresh(first.requestId)
    transport.read.mockResolvedValueOnce({ ...newer, confirmedSeq: 6 })
    await controller.refresh(first.requestId)
    expect(controller.find(instanceId)?.state).toBe('cancelled')
  })

  it('同确认序号的旧 queued 不回退 running，停止标记保持单调', async () => {
    const { first, transport, controller } = open()
    await controller.open()
    transport.read.mockResolvedValueOnce({ ...first, stopRequested: true })
    await controller.refresh(first.requestId)
    transport.read.mockResolvedValueOnce({ ...first, state: 'queued' })
    await controller.refresh(first.requestId)
    expect(controller.find(instanceId)).toMatchObject({ state: 'running', stopRequested: true })
  })

  it('同确认序号的迟到查询不覆盖较新的状态未知结果，后续查询可恢复确认', async () => {
    const { first, transport, controller } = open()
    await controller.open()
    let finishOld!: (value: ExecutionQuery) => void
    transport.read.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve }))
    const older = controller.refresh(first.requestId)
    const unknown: ExecutionQuery = { ...first, statusKnowledge: 'unknown',
      reason: { code: 'resource-unavailable', detail: '连接暂时不可达' } }
    transport.read.mockResolvedValueOnce(unknown)
    await controller.refresh(first.requestId)
    finishOld(first)
    await older
    expect(controller.find(instanceId)?.statusKnowledge).toBe('unknown')
    transport.read.mockResolvedValueOnce(first)
    await controller.refresh(first.requestId)
    expect(controller.find(instanceId)?.statusKnowledge).toBe('confirmed')
  })

  it('刷新旧会话或其他实例不会改变已选的新会话，重载保留选择', async () => {
    const { first, transport, controller } = open()
    await controller.open()
    transport.read.mockResolvedValueOnce({ ...first, state: 'cancelled', confirmedSeq: 3 })
    await controller.refresh(first.requestId)
    const next = query()
    transport.create.mockResolvedValueOnce(next)
    transport.read.mockResolvedValueOnce(null)
    await controller.start(await sessionAction({ workspace, binding, instanceId, receiver, parameters: {}, requestId: next.requestId }))
    const other = query({ session: { ...first.session!, instanceId: 'other-instance' } })
    transport.read.mockResolvedValueOnce(other)
    await controller.refresh(other.requestId)
    transport.read.mockResolvedValueOnce(first)
    await controller.refresh(first.requestId)
    expect(controller.find(instanceId)?.requestId).toBe(next.requestId)
    const reopened = managed(new NativeSessionController(controller.scope, transport))
    await reopened.open()
    expect(reopened.find(instanceId)?.requestId).toBe(next.requestId)
    expect(reopened.find('other-instance')?.requestId).toBe(other.requestId)
  })

  it('本机存储事务失败时不发送启动或控制', async () => {
    const { first, transport, controller } = open()
    await controller.open()
    const db = await openWorkspaceDatabase()
    const transaction = vi.spyOn(db, 'transaction').mockImplementationOnce(() => { throw new Error('quota') })
    try {
      await expect(controller.input(first, 'advance', { value: 1 })).rejects.toThrow('quota')
      expect(transport.control).not.toHaveBeenCalled()
      transaction.mockImplementationOnce(() => { throw new Error('quota') })
      const action = await sessionAction({ workspace, binding, instanceId, receiver, parameters: {}, requestId: crypto.randomUUID() })
      await expect(controller.start(action)).rejects.toThrow('quota')
      expect(transport.create).not.toHaveBeenCalled()
    } finally { transaction.mockRestore() }
  })

  it('两个页面同时输入时只接收一份待确认意图', async () => {
    const { first, transport, controller } = open()
    await controller.open()
    const second = managed(new NativeSessionController(controller.scope, transport))
    await second.open()
    transport.control.mockRejectedValue(new Error('lost-ack'))
    const results = await Promise.allSettled([
      controller.input(first, 'advance', { value: 1 }), second.input(first, 'advance', { value: 2 }),
    ])
    expect(results.every(result => result.status === 'rejected')).toBe(true)
    expect(transport.control).toHaveBeenCalledTimes(1)
  })

  it('停止已受理后不会恢复尚未确认的输入', async () => {
    const { first, transport, controller } = open()
    await controller.open()
    transport.control.mockRejectedValueOnce(new Error('lost-input'))
    await expect(controller.input(first, 'advance', { value: 1 })).rejects.toThrow('lost-input')
    transport.read.mockResolvedValue({ ...first, stopRequested: true, confirmedSeq: 3 })
    await controller.reconcile(first.requestId)
    expect(transport.control).toHaveBeenCalledTimes(1)
    expect(controller.pending(instanceId)).toBeNull()
  })

  it('隔离其他活动命名空间的意图与观察', async () => {
    const { controller, transport } = open()
    await controller.open()
    const isolated = managed(new NativeSessionController(JSON.stringify(['school', environmentId, spaceId, principalId, crypto.randomUUID()]), transport))
    await isolated.open()
    expect(isolated.find(instanceId)).toBeNull()
    expect(isolated.snapshot().queries).toEqual([])
  })

  it('does not accept input for a stopped or unknown session', async () => {
    const { controller } = open()
    await expect(controller.input(query({ stopRequested: true }), 'advance', { value: 1 })).rejects.toThrow('invalid')
    await expect(controller.input(query({ statusKnowledge: 'unknown', reason: { code: 'resource-unavailable', detail: '待核实' } }),
      'advance', { value: 1 })).rejects.toThrow('invalid')
  })
  it('a late running reply cannot reverse a confirmed terminal fact', async () => {
    const { first, transport, controller } = open()
    await controller.open()
    let resolve!: (value: ExecutionQuery) => void
    transport.read.mockImplementationOnce(() => new Promise<ExecutionQuery>(done => { resolve = done }))
    transport.stop.mockResolvedValueOnce({ ...first, state: 'cancelled', confirmedSeq: 5 })
    const late = controller.refresh(first.requestId)
    await controller.stop(first.requestId, crypto.randomUUID())
    resolve(first); await late
    expect(controller.find(instanceId)?.state).toBe('cancelled')
    transport.read.mockResolvedValueOnce({ ...first, state: 'cancelled', confirmedSeq: 6,
      session: { ...first.session!, appliedSeq: 1, observation: { value: 1, total: 1, applied: 1 } } })
    await controller.refresh(first.requestId)
    expect(controller.find(instanceId)?.state).toBe('cancelled')
    expect(controller.find(instanceId)?.session?.appliedSeq).toBe(1)
  })
  it('connection loss keeps the last observation and marks knowledge unknown', async () => {
    const { first, controller } = open({ list: vi.fn().mockResolvedValueOnce([query()]).mockRejectedValueOnce(new Error('offline')) })
    await controller.open(); const known = controller.find(instanceId)!
    await controller.open()
    expect(controller.find(instanceId)?.statusKnowledge).toBe('unknown')
    expect(controller.find(instanceId)?.session?.observation).toEqual(known.session?.observation)
    void first
  })
  it('an absent owner record cannot be interpreted as confirmed running or stopped', async () => {
    const { first, transport: base } = open()
    const transport = { ...base, read: vi.fn(async () => null) }
    const controller = managed(new NativeSessionController(JSON.stringify([crypto.randomUUID(), environmentId, spaceId, principalId, activityId]), transport))
    await controller.open(); await controller.refresh(first.requestId)
    expect(controller.find(instanceId)?.statusKnowledge).toBe('unknown')
    expect(controller.find(instanceId)?.session?.observation).toEqual(first.session?.observation)
    vi.mocked(transport.list).mockResolvedValueOnce([]); await controller.open()
    expect(controller.find(instanceId)?.statusKnowledge).toBe('unknown')
    expect(transport.create).not.toHaveBeenCalled()
  })
  it('late old-run queries do not replace an explicitly selected recovery instance', async () => {
    const { first, transport, controller } = open(); await controller.open()
    const newer = { ...first, requestId: crypto.randomUUID(), executionRef: crypto.randomUUID() }
    transport.create.mockResolvedValueOnce(newer)
    transport.read.mockResolvedValueOnce(null)
    const action = await sessionAction({ workspace, binding, instanceId, receiver, parameters: {}, requestId: newer.requestId,
      resumeFromCheckpoint: { checkpointId: crypto.randomUUID(), sessionRef: crypto.randomUUID(), sha256: 'd'.repeat(64) } })
    await controller.start(action); await controller.refresh(first.requestId)
    expect(controller.find(instanceId)?.requestId).toBe(newer.requestId)
  })
  it('adopts a pre-merge journal stop without dispatch and preserves its original request bytes', async () => {
    const { first, transport, controller } = open()
    await controller.open()
    transport.stop.mockRejectedValueOnce(new Error('offline'))
    await expect(controller.stop(first.requestId)).rejects.toThrow('offline')
    const original = transport.stop.mock.calls[0]!
    controller.dispose()
    const queue = new SessionRequests()
    const reopened = managed(new NativeSessionController(controller.scope, transport, () => true, queue))
    await reopened.open()
    expect(transport.stop).toHaveBeenCalledTimes(1)
    expect(await queue.list(controller.scope)).toEqual([{ kind: 'stop', requestId: original[0], id: original[1], reason: original[2] }])
    await reopened.retryPending(original[1])
    expect(transport.stop.mock.calls[1]).toEqual(original)
    expect(await queue.list(controller.scope)).toEqual([])
  })
  it('a lost start reply survives a new controller and is queried without automatic resubmission', async () => {
    const key = JSON.stringify([crypto.randomUUID(), environmentId, spaceId, principalId, activityId])
    const { first, transport } = open(), queue = new SessionRequests()
    const action = await sessionAction({ workspace, binding, instanceId, receiver, parameters: {}, requestId: first.requestId })
    transport.create.mockRejectedValueOnce(new Error('reply lost'))
    const before = managed(new NativeSessionController(key, transport, () => true, queue))
    await expect(before.start(action)).rejects.toThrow('reply lost')
    expect((await queue.list(key)).map(item => item.id)).toContain(first.requestId)
    before.dispose()
    const after = managed(new NativeSessionController(key, transport, () => true, queue))
    await after.open()
    expect(after.find(instanceId)?.requestId).toBe(first.requestId)
    expect(await queue.list(key)).toEqual([])
    expect(transport.create).toHaveBeenCalledTimes(1)
  })
  it('a lost stop reply survives a new controller and is only retried with its original identity', async () => {
    const key = JSON.stringify([crypto.randomUUID(), environmentId, spaceId, principalId, activityId])
    const { first, transport } = open(), queue = new SessionRequests()
    const stopId = crypto.randomUUID()
    transport.stop.mockRejectedValueOnce(new Error('reply lost'))
    const before = managed(new NativeSessionController(key, transport, () => true, queue))
    await before.open()
    await expect(before.stop(first.requestId, stopId)).rejects.toThrow('reply lost')
    const pending = await queue.list(key)
    expect(pending).toHaveLength(1)
    expect(pending[0]).toMatchObject({ kind: 'stop', id: stopId, requestId: first.requestId })
    before.dispose()
    const after = managed(new NativeSessionController(key, transport, () => true, queue))
    await after.open()
    expect(transport.stop).toHaveBeenCalledTimes(1)
    expect(after.snapshot().pending.map(item => item.id)).toContain(stopId)
    transport.stop.mockResolvedValueOnce({ ...first, state: 'cancelled', stopRequested: true, confirmedSeq: 3 })
    await after.retryPending(stopId)
    expect(transport.stop.mock.calls[1]).toEqual([first.requestId, stopId, '用户请求停止本机会话。'])
    expect(await queue.list(key)).toEqual([])
    expect(after.find(instanceId)?.state).toBe('cancelled')
  })
  it('a checkpoint response lost before refresh is resolved by its control receipt, never re-executed', async () => {
    const key = JSON.stringify([crypto.randomUUID(), environmentId, spaceId, principalId, activityId])
    const { first, transport: base } = open(), queue = new SessionRequests()
    const updated = { ...first, confirmedSeq: 3, session: { ...first.session!, appliedSeq: 1 } }
    const transport = { ...base, controlReceipt: vi.fn(async (_requestId: string, id: string) => ({
      controlId: id, requestId: first.requestId, executionRef: first.executionRef, effect: 'checkpoint' as const,
      inputDigest: await digestOf({ controlId: id, operationId: 'checkpoint', effect: 'checkpoint', expectedSeq: 0, parameters: {} }),
      status: 'applied' as const, seq: 1, query: updated })) }
    transport.control.mockRejectedValueOnce(new Error('reply lost'))
    const before = managed(new NativeSessionController(key, transport, () => true, queue))
    await before.open()
    await expect(before.control(first, 'checkpoint', 'checkpoint', {})).rejects.toThrow('reply lost')
    expect(await queue.list(key)).toHaveLength(1); before.dispose()
    const after = managed(new NativeSessionController(key, transport, () => true, queue))
    await after.open()
    expect(await queue.list(key)).toEqual([])
    expect(transport.control).toHaveBeenCalledTimes(1)
    expect(after.find(instanceId)?.session?.appliedSeq).toBe(1)
  })
  it.each(['dispatching', 'unknown', null] as const)('HTTP acceptance with receipt %s keeps the original control gated until refresh confirms application', async initialStatus => {
    const key = JSON.stringify([crypto.randomUUID(), environmentId, spaceId, principalId, activityId])
    const { first, transport: base } = open(), queue = new SessionRequests()
    let status: ExecutionControlReceipt['status'] | null = initialStatus
    const updated = { ...first, confirmedSeq: 3, session: { ...first.session!, appliedSeq: 1,
      observation: { value: 1, total: 1, applied: 1 } } }
    base.control.mockResolvedValue(first)
    const transport = { ...base, controlReceipt: vi.fn(async (_requestId: string, id: string): Promise<ExecutionControlReceipt | null> => {
      if (status === null) return null
      const control = base.control.mock.calls[0]![1]
      return { controlId: id, requestId: first.requestId, executionRef: first.executionRef, effect: control.effect,
        inputDigest: await digestOf(control), seq: control.expectedSeq + 1, status,
        query: status === 'applied' ? updated : first }
    }) }
    const before = managed(new NativeSessionController(key, transport, () => true, queue))
    await before.open()
    await before.input(first, 'advance', { value: 1 })
    const control = base.control.mock.calls[0]![1]
    expect(before.pending(instanceId)).toBe('control')
    expect(before.snapshot().pending).toEqual([{ kind: 'control', id: control.controlId, requestId: first.requestId, control }])
    expect(await queue.list(key)).toEqual(before.snapshot().pending)
    await expect(before.input(first, 'advance', { value: 2 })).rejects.toThrow('pending-control')
    before.dispose()
    const after = managed(new NativeSessionController(key, transport, () => true, queue))
    await after.open()
    expect(after.pending(instanceId)).toBe('control')
    await expect(after.input(first, 'advance', { value: 2 })).rejects.toThrow('pending-control')
    expect(base.control).toHaveBeenCalledTimes(1)
    status = 'applied'
    await after.open()
    expect(after.pending(instanceId)).toBeNull()
    expect(after.snapshot().pending).toEqual([])
    expect(await queue.list(key)).toEqual([])
    expect(after.find(instanceId)?.session?.appliedSeq).toBe(1)
    expect(transport.controlReceipt).toHaveBeenLastCalledWith(first.requestId, control.controlId)
    expect(base.control).toHaveBeenCalledTimes(1)
  })
  it.each(['list', 'receipt'] as const)('settling during an older poll at %s keeps the control absent after a confirmed stop', async boundary => {
    const key = JSON.stringify([crypto.randomUUID(), environmentId, spaceId, principalId, activityId])
    const { first, transport: base } = open(), queue = new SessionRequests()
    const updated = { ...first, confirmedSeq: 3, session: { ...first.session!, appliedSeq: 1,
      observation: { value: 1, total: 1, applied: 1 } } }
    const stopped: ExecutionQuery = { ...updated, confirmedSeq: 4, state: 'cancelled', stopRequested: true }
    let status: ExecutionControlReceipt['status'] = 'dispatching'
    const receipt = async (id: string, status: ExecutionControlReceipt['status']): Promise<ExecutionControlReceipt> => {
      const control = base.control.mock.calls[0]![1]
      return { controlId: id, requestId: first.requestId, executionRef: first.executionRef, effect: control.effect,
        inputDigest: await digestOf(control), seq: control.expectedSeq + 1, status,
        query: status === 'applied' ? updated : first }
    }
    base.control.mockResolvedValue(first)
    base.stop.mockResolvedValue(stopped)
    const transport = { ...base, controlReceipt: vi.fn(async (_requestId: string, id: string) => receipt(id, status)) }
    const controller = managed(new NativeSessionController(key, transport, () => true, queue))
    await controller.open()
    await controller.input(first, 'advance', { value: 1 })
    const control = base.control.mock.calls[0]![1]
    expect(controller.pending(instanceId)).toBe('control')

    let reached!: () => void, release!: () => void
    const paused = new Promise<void>(resolve => { reached = resolve })
    const resume = new Promise<void>(resolve => { release = resolve })
    // Only delay a real network reply. The IndexedDB queue and its transactions are unmodified.
    if (boundary === 'list') transport.list.mockImplementationOnce(async () => {
      reached(); await resume; return [first]
    })
    else transport.controlReceipt.mockImplementationOnce(async (_requestId: string, id: string) => {
      reached(); await resume; return receipt(id, 'dispatching')
    })
    const polling = controller.open()
    try {
      await paused
      status = 'applied'
      await controller.retryPending(control.controlId)
      expect(controller.pending(instanceId)).toBeNull()
      expect(controller.snapshot().pending).toEqual([])
      expect(await queue.list(key)).toEqual([])
      await controller.stop(first.requestId)
      expect(controller.find(instanceId)).toMatchObject({ state: 'cancelled', statusKnowledge: 'confirmed' })
      expect(await queue.list(key)).toEqual([])
    } finally { release(); await polling }
    await controller.open()
    expect(controller.snapshot().error).toBe('')
    expect(controller.pending(instanceId)).toBeNull()
    expect(controller.snapshot().pending).toEqual([])
    expect(await queue.list(key)).toEqual([])
    expect(controller.find(instanceId)).toMatchObject({ state: 'cancelled', statusKnowledge: 'confirmed' })
    expect(base.control).toHaveBeenCalledTimes(1)
    expect(base.stop).toHaveBeenCalledTimes(1)
  })
  it('an unacknowledged control is only retried explicitly with its original identity and position', async () => {
    const key = JSON.stringify([crypto.randomUUID(), environmentId, spaceId, principalId, activityId])
    const { first, transport: base } = open(), queue = new SessionRequests()
    const transport = { ...base, controlReceipt: vi.fn(async (): Promise<ExecutionControlReceipt | null> => null) }
    transport.control.mockRejectedValueOnce(new Error('offline'))
    const before = managed(new NativeSessionController(key, transport, () => true, queue)); await before.open()
    await expect(before.input(first, 'advance', { value: 1 })).rejects.toThrow('offline')
    const original = transport.control.mock.calls[0]; before.dispose()
    const after = managed(new NativeSessionController(key, transport, () => true, queue)); await after.open()
    expect(transport.control).toHaveBeenCalledTimes(1)
    await after.retryPending(after.snapshot().pending[0]!.id)
    expect(transport.control.mock.calls[1]).toEqual(original)
    expect(await queue.list(key)).toEqual(after.snapshot().pending)
    expect(after.pending(instanceId)).toBe('control')
    const control = original![1]
    transport.controlReceipt.mockResolvedValueOnce({ controlId: control.controlId, requestId: first.requestId,
      executionRef: first.executionRef, effect: control.effect, inputDigest: await digestOf(control),
      status: 'applied', seq: control.expectedSeq + 1, query: after.find(instanceId)! })
    await after.open()
    expect(await queue.list(key)).toEqual([])
    expect(after.pending(instanceId)).toBeNull()
    expect(transport.control).toHaveBeenCalledTimes(2)
  })
  it('a failed local request commit prevents dispatch', async () => {
    const { first, transport } = open()
    const action = await sessionAction({ workspace, binding, instanceId, receiver, parameters: {}, requestId: first.requestId })
    const queue = { list: async () => [], put: async () => { throw new Error('quota') }, remove: async () => {} }
    const controller = managed(new NativeSessionController(key, transport, () => true, queue))
    await expect(controller.start(action)).rejects.toThrow('quota')
    expect(transport.create).not.toHaveBeenCalled()
  })
  it('loads historical checkpoints across pages independently of the recent session window', async () => {
    const { first, transport: base } = open()
    const checkpoint = { checkpointId: crypto.randomUUID(), sessionRef: crypto.randomUUID(), sha256: 'd'.repeat(64),
      contentId: crypto.randomUUID(), appliedSeq: 2, byteLength: 200, createdAt: '2026-11-04T00:00:00.000Z',
      requestId: crypto.randomUUID(), instanceId, scope: first.scope }
    const second = { ...checkpoint, checkpointId: crypto.randomUUID() }
    const transport = { ...base, checkpoints: vi.fn().mockResolvedValueOnce({ items: [checkpoint], nextCursor: checkpoint.checkpointId })
      .mockResolvedValueOnce({ items: [second], nextCursor: null }) }
    const controller = managed(new NativeSessionController(JSON.stringify([crypto.randomUUID(), environmentId, spaceId, principalId, activityId]), transport)); await controller.open()
    expect(controller.snapshot().checkpoints).toEqual([checkpoint, second])
    expect(controller.snapshot().checkpointsReady).toBe(true)
    expect(controller.snapshot().queries[0]?.session?.checkpoints).toBeUndefined()
    expect(transport.checkpoints.mock.calls).toEqual([[undefined], [checkpoint.checkpointId]])
  })
  it('an incomplete checkpoint page is not represented as a confirmed empty history', async () => {
    const { transport: base } = open()
    const transport = { ...base, checkpoints: vi.fn().mockRejectedValue(new Error('offline')) }
    const controller = managed(new NativeSessionController(JSON.stringify([crypto.randomUUID(), environmentId, spaceId, principalId, activityId]), transport)); await controller.open()
    expect(controller.snapshot().checkpointsReady).toBe(false)
    expect(controller.snapshot().error).toContain('无法完整读取')
  })
  it('rejects a repeated checkpoint cursor instead of looping or claiming a complete history', async () => {
    const { transport: base } = open(), cursor = crypto.randomUUID()
    const transport = { ...base, checkpoints: vi.fn().mockResolvedValue({ items: [], nextCursor: cursor }) }
    const controller = managed(new NativeSessionController(JSON.stringify([crypto.randomUUID(), environmentId, spaceId, principalId, activityId]), transport)); await controller.open()
    expect(transport.checkpoints).toHaveBeenCalledTimes(2)
    expect(controller.snapshot().checkpointsReady).toBe(false)
  })
})
