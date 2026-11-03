import 'fake-indexeddb/auto'
import { expect, it } from 'vitest'
import { aggregationPackage } from '../../../../components/table-aggregation/package.mjs'
import type { ReliableWorkspace } from '../reliable-workspace'
import { digestOf, executionAction } from '../tool-execution/action'
import { BrowserExecutionReceiver } from '../tool-execution/receiver'
import { ExecutionController } from '../tool-execution/controller'
import { createComponentBridge } from './bridge'

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
