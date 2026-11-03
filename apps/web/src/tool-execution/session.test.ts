import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { componentManifestSchema } from '@xunjie/contracts/components'
import { executionQuerySchema, type ExecutionAction, type ExecutionQuery } from '@xunjie/contracts/execution'
import type { ReliableWorkspace } from '../reliable-workspace'
import { nativeLimits, sessionAction } from './session'
import { NativeSessionController } from './session-controller'
import { SessionRequests } from './session-requests'
import { digestOf } from './action'

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

describe('the session controller keeps the owner reference and the next expected sequence', () => {
  const open = (overrides: Partial<{ list(): Promise<ExecutionQuery[]>; control: ReturnType<typeof vi.fn> }> = {}) => {
    const first = query()
    const transport = {
      list: overrides.list ?? vi.fn(async () => [first]),
      create: vi.fn(async (_action: ExecutionAction) => first),
      read: vi.fn(async () => first),
      control: overrides.control ?? vi.fn(async (_requestId: string, control: { expectedSeq: number }) => query({
        requestId: first.requestId, executionRef: first.executionRef, confirmedSeq: 3,
        session: { ...first.session!, appliedSeq: control.expectedSeq + 1,
          observation: { value: 1, total: 1, applied: control.expectedSeq + 1 } } })),
      stop: vi.fn(async () => query({ requestId: first.requestId, state: 'cancelled', confirmedSeq: 3 })),
    }
    return { first, transport, controller: managed(new NativeSessionController(key, transport)) }
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
    const controller = managed(new NativeSessionController(key, transport))
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
    const action = await sessionAction({ workspace, binding, instanceId, receiver, parameters: {}, requestId: newer.requestId })
    await controller.start(action); await controller.refresh(first.requestId)
    expect(controller.find(instanceId)?.requestId).toBe(newer.requestId)
  })
  it('a lost start reply survives a new controller and is queried without automatic resubmission', async () => {
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
  it('a checkpoint response lost before refresh is resolved by its control receipt, never re-executed', async () => {
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
  it('an unacknowledged control is only retried explicitly with its original identity and position', async () => {
    const { first, transport: base } = open(), queue = new SessionRequests()
    const transport = { ...base, controlReceipt: vi.fn(async () => null) }
    transport.control.mockRejectedValueOnce(new Error('offline'))
    const before = managed(new NativeSessionController(key, transport, () => true, queue)); await before.open()
    await expect(before.input(first, 'advance', { value: 1 })).rejects.toThrow('offline')
    const original = transport.control.mock.calls[0]; before.dispose()
    const after = managed(new NativeSessionController(key, transport, () => true, queue)); await after.open()
    expect(transport.control).toHaveBeenCalledTimes(1)
    await after.retryPending(after.snapshot().pending[0]!.id)
    expect(transport.control.mock.calls[1]).toEqual(original)
    expect(await queue.list(key)).toEqual([])
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
    const controller = managed(new NativeSessionController(key, transport)); await controller.open()
    expect(controller.snapshot().checkpoints).toEqual([checkpoint, second])
    expect(controller.snapshot().checkpointsReady).toBe(true)
    expect(controller.snapshot().queries[0]?.session?.checkpoints).toBeUndefined()
    expect(transport.checkpoints.mock.calls).toEqual([[undefined], [checkpoint.checkpointId]])
  })
  it('an incomplete checkpoint page is not represented as a confirmed empty history', async () => {
    const { transport: base } = open()
    const transport = { ...base, checkpoints: vi.fn().mockRejectedValue(new Error('offline')) }
    const controller = managed(new NativeSessionController(key, transport)); await controller.open()
    expect(controller.snapshot().checkpointsReady).toBe(false)
    expect(controller.snapshot().error).toContain('无法完整读取')
  })
  it('rejects a repeated checkpoint cursor instead of looping or claiming a complete history', async () => {
    const { transport: base } = open(), cursor = crypto.randomUUID()
    const transport = { ...base, checkpoints: vi.fn().mockResolvedValue({ items: [], nextCursor: cursor }) }
    const controller = managed(new NativeSessionController(key, transport)); await controller.open()
    expect(transport.checkpoints).toHaveBeenCalledTimes(2)
    expect(controller.snapshot().checkpointsReady).toBe(false)
  })
})
