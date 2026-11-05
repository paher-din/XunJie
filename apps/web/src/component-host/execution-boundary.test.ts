import 'fake-indexeddb/auto'
import { expect, it, vi } from 'vitest'
import type { CourseExecutionPlan, ExecutionDevice, ExecutionAction } from '@xunjie/contracts/execution'
import { aggregationPackage } from '../../../../components/table-aggregation/package.mjs'
import { ReliableWorkspace } from '../reliable-workspace'
import { digestOf, executionAction } from '../tool-execution/action'
import { BrowserExecutionReceiver } from '../tool-execution/receiver'
import { ExecutionController } from '../tool-execution/controller'
import { createComponentBridge } from './bridge'

it.each(['closed', 'forbidden', 'capability', 'current'] as const)(
  'a component awaiting a fixed input digest rechecks its %s mount before acceptance', async retired => {
    const scope = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), activityId: crypto.randomUUID() }
    const key = JSON.stringify(['school', scope.environmentId, scope.spaceId, scope.principalId, scope.activityId])
    const { manifest } = await aggregationPackage()
    const binding = { key: 'table', definition: { manifest, digest: await digestOf(manifest) }, configuration: { title: '表格' }, materialIds: [] }
    const unused = async (): Promise<never> => { throw new Error('not dispatched') }
    const workspace = new ReliableWorkspace(key, { read: unused, receipt: unused, sync: unused })
    const receiver = new BrowserExecutionReceiver({ receiverId: 'browser-execution', location: 'local', kind: 'execution' }, key, 1)
    const actions = { async createExecution(input: Pick<ExecutionAction, 'requestId' | 'receiver' | 'execution'>) {
      const action = { protocolVersion: 2 as const, kind: 'execution' as const, scope, ...input }
      await receiver.accept(action, await digestOf(action))
    }, cancel: async () => {} }
    const transport = { accept: unused, read: async () => null, report: unused, stop: unused, result: unused }
    const controller = new ExecutionController(key, receiver, actions, transport, { load: unused })
    let allowed = true, runnable = true
    const bridge = createComponentBridge(workspace, scope.activityId, binding, () => allowed, { controller, canRun: () => runnable })
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const delayed = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, bytes) => {
      enter(); await gate; return digest(algorithm, bytes)
    })
    const requestId = crypto.randomUUID()
    try {
      const pending = bridge.handle({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
        messageId: crypto.randomUUID(), method: 'execution.submit', payload: { requestId, operationId: 'aggregate',
          parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'sum' }, expectedContentId: null } })
        .then(() => 'accepted', error => error.message)
      await entered
      if (retired === 'closed') bridge.close()
      if (retired === 'forbidden') allowed = false
      if (retired === 'capability') runnable = false
      release()
      expect(await pending).toBe(retired === 'closed' ? 'stale-connection' : retired === 'forbidden' ? 'forbidden'
        : retired === 'capability' ? 'capability-unavailable' : 'accepted')
      expect((await receiver.store.list(key)).map(record => record.requestId)).toEqual(retired === 'current' ? [requestId] : [])
    } finally { release(); delayed.mockRestore(); bridge.close(); controller.dispose() }
  })

it('a component can query its own run but cannot query or stop another instance in the same activity', async () => {
  const scope = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), activityId: crypto.randomUUID() }
  const key = JSON.stringify(['school', scope.environmentId, scope.spaceId, scope.principalId, scope.activityId])
  const { manifest } = await aggregationPackage()
  const definition = { manifest, digest: await digestOf(manifest) }
  const binding = { key: 'table', definition, configuration: { title: '表格' }, materialIds: [] }
  const other = { ...binding, key: 'other' }
  const workspace = { key, snapshot: () => ({ ready: true, files: [] }) } as unknown as ReliableWorkspace
  const identity = { receiverId: 'browser-execution', location: 'local' as const, kind: 'execution' as const }
  const receiver = new BrowserExecutionReceiver(identity, key, 1)
  const actions = { createExecution: async () => {}, cancel: async () => {} }
  const unused = async (): Promise<never> => { throw new Error('not dispatched') }
  const transport = { accept: unused, read: async () => null, report: unused, stop: unused, result: unused }
  const make = async (selected: typeof binding) => {
    const action = await executionAction({ workspace, binding: selected, instanceId: `${scope.activityId}:${selected.key}`,
      receiver: identity, requestId: crypto.randomUUID(), operationId: 'aggregate', expectedContentId: null,
      parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'sum' } })
    await receiver.accept(action, await digestOf(action)); return action
  }
  const own = await make(binding), foreign = await make(other)
  const controller = new ExecutionController(key, receiver, actions, transport, { load: async () => { throw new Error('not dispatched') } })
  const bridge = createComponentBridge(workspace, scope.activityId, binding, () => true, { controller, canRun: () => true })
  const message = (method: string, requestId: string) => ({ hostApiVersion: 1, connectionId: bridge.connectionId,
    instanceId: bridge.instanceId, messageId: crypto.randomUUID(), method,
    payload: { requestId, ...(method === 'execution.stop' ? { stopId: crypto.randomUUID() } : {}) } })
  try {
    expect(await bridge.handle(message('execution.query', own.requestId))).toMatchObject({ requestId: own.requestId })
    await expect(bridge.handle(message('execution.query', foreign.requestId))).rejects.toThrow('forbidden')
    await expect(bridge.handle(message('execution.stop', foreign.requestId))).rejects.toThrow('forbidden')
    expect((await receiver.store.read(key, foreign.requestId))?.query.stopRequested).toBe(false)
    await expect(bridge.handle(message('execution.stop', crypto.randomUUID()))).rejects.toThrow('outcome-unknown')
  } finally { bridge.close(); controller.dispose() }
})

it('answers a planned operation from real browser facts and never turns a missing feature into a relocation', async () => {
  const scope = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), activityId: crypto.randomUUID() }
  const key = JSON.stringify(['school', scope.environmentId, scope.spaceId, scope.principalId, scope.activityId])
  const { manifest } = await aggregationPackage()
  const binding = { key: 'table', definition: { manifest, digest: await digestOf(manifest) }, configuration: { title: '表格' }, materialIds: [] }
  const workspace = { key, snapshot: () => ({ ready: true, files: [] }) } as unknown as ReliableWorkspace
  const receiver = new BrowserExecutionReceiver({ receiverId: 'browser-execution', location: 'local' as const, kind: 'execution' as const }, key, 1)
  const unused = async (): Promise<never> => { throw new Error('not dispatched') }
  const transport = { accept: unused, read: async () => null, report: unused, stop: unused, result: unused }
  const controller = new ExecutionController(key, receiver, { createExecution: async () => {}, cancel: async () => {} }, transport,
    { load: async () => { throw new Error('not dispatched') } })
  const plan: CourseExecutionPlan = { planId: 'table-run', planVersion: 1, planDigest: 'c'.repeat(64),
    components: [{ key: 'table', definitionDigest: binding.definition.digest,
      configurationDigest: await digestOf(binding.configuration), operations: ['aggregate'] }],
    capabilities: ['execution.submit'], resources: { browser: { features: ['worker'] }, native: null },
    locations: ['browser'], remote: null }
  const capabilities = async (worker: boolean, planned: boolean) => {
    const device: ExecutionDevice = { platform: null, browser: { worker, webassembly: true, sandboxedFrame: true }, native: null }
    const bridge = createComponentBridge(workspace, scope.activityId, binding, () => true, { controller, canRun: () => true }, () => {},
      undefined, planned ? { plan, device, remoteAvailable: false } : undefined)
    const reply = await bridge.handle({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
      messageId: crypto.randomUUID(), method: 'execution.capabilities', payload: {} })
    bridge.close()
    return reply as { operations: { operationId: string; decision?: { state: string; location: string | null; owner: string | null;
      remote: { declared: boolean; available: boolean } } }[] }
  }
  try {
    // An unplanned release keeps stating only what the adapter enforces.
    expect((await capabilities(true, false)).operations[0]).not.toHaveProperty('decision')
    expect((await capabilities(true, true)).operations[0]).toMatchObject({ operationId: 'aggregate',
      decision: { state: 'browser-satisfied', location: 'browser', owner: 'device', remote: { declared: false, available: false } } })
    // A restricted job has no other declared form, so a missing feature leaves it unplaced here.
    expect((await capabilities(false, true)).operations[0]).toMatchObject({ operationId: 'aggregate',
      decision: { state: 'device-unsupported', location: null, owner: null } })
  } finally { controller.dispose() }
})
