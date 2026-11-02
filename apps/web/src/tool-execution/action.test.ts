import { describe, expect, it } from 'vitest'
import { componentManifestSchema, componentStateName } from '@xunjie/contracts/components'
import { defaultExecutionLimits } from '@xunjie/contracts/execution'
import type { ReliableWorkspace } from '../reliable-workspace'
import { browserLimits, browserPlan, digestOf, executionAction } from './action'

const componentId = crypto.randomUUID()
const manifest = componentManifestSchema.parse({ formatVersion: 1, componentId, version: 1, hostApiVersion: 1, title: '表格聚合',
  entry: { resourceId: crypto.randomUUID(), sha256: 'b'.repeat(64), byteLength: 20, mediaType: 'text/html' },
  stateVersion: 1, stateShape: { type: 'object', properties: { text: { type: 'string', maxLength: 100 } } }, initialState: { text: '' },
  requiredCapabilities: ['workspace.read', 'workspace.change', 'execution.submit'],
  algorithm: { resource: { resourceId: crypto.randomUUID(), sha256: 'c'.repeat(64), byteLength: 270,
    mediaType: 'application/wasm' }, mediaType: 'application/wasm', entry: 'aggregate', memoryPages: 256 },
  operations: [{ operationId: 'aggregate', effect: 'execute',
    parameters: { type: 'object', properties: { aggregate: { type: 'string', maxLength: 10 } } },
    result: { type: 'object', properties: { value: { type: 'number' } } }, budgets: { timeMs: 5000, outputBytes: 65536 } },
  { operationId: 'aggregate-top', effect: 'execute',
    parameters: { type: 'object', properties: { aggregate: { type: 'string', maxLength: 10 } } },
    result: { type: 'object', properties: { value: { type: 'number' } } }, budgets: { timeMs: 2000, outputBytes: 65536 } }] })
const binding = { key: 'table', configuration: { title: '表格聚合' }, materialIds: [], definition: { digest: 'a'.repeat(64), manifest } }
const instanceId = crypto.randomUUID() + ':table'
const content = { text: '固定输入' }
const stateValue = { formatVersion: 1, instanceId, componentId, version: 1, definitionDigest: 'a'.repeat(64), stateVersion: 1,
  operationId: crypto.randomUUID(), content }
const file = { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: componentStateName('table'),
  kind: 'state' as const, encoding: 'json' as const, mediaType: 'application/vnd.xunjie.component-state+json',
  value: JSON.stringify(stateValue) }
const workspace = { key: JSON.stringify(['school', crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()]),
  snapshot: () => ({ ready: true, files: [file] }) } as unknown as ReliableWorkspace
const receiver = { receiverId: 'browser-execution', location: 'local' as const, kind: 'execution' as const }

describe('the fixed execution request is the one the adapter advertises', () => {
  it('declares the adapter ceiling and the algorithm memory, not a looser per-run guess', () => {
    const limits = browserLimits(manifest, manifest.operations![0]!)
    expect(limits).toEqual({ timeMs: 5000, memoryPages: 256, inputBytes: defaultExecutionLimits.inputBytes,
      outputBytes: 65536, concurrentJobs: 2, queuedJobs: 4 })
  })
  it('pins a plan digest per operation, so a view cannot be promised a plan the service refuses', async () => {
    const first = await browserPlan(manifest, 'aggregate'), second = await browserPlan(manifest, 'aggregate-top')
    expect(first.planDigest).not.toBe(second.planDigest)
    const action = await executionAction({ workspace, binding, instanceId, receiver, operationId: 'aggregate',
      parameters: { aggregate: 'sum' }, expectedContentId: file.contentId, requestId: crypto.randomUUID() })
    // The accepted command carries exactly the advertised plan and limits.
    expect(action.execution.plan).toEqual(first)
    expect(action.execution.limits).toEqual(browserLimits(manifest, manifest.operations![0]!))
    // The basis cites the state copy it really read, and nothing from another instance.
    expect(action.execution.basis.works).toEqual([])
    expect(action.execution.basis.state).toEqual({ name: file.name, contentId: file.contentId, sha256: await digestOf(stateValue) })
    expect(action.execution.basis.expected.stateContentId).toBe(file.contentId)
    expect(action.execution.plan.location).toBe('browser')
    expect(action.execution.plan.kind).toBe('job')
  })
  it('refuses a stale expected state and an undeclared parameter shape before any dispatch', async () => {
    await expect(executionAction({ workspace, binding, instanceId, receiver, operationId: 'aggregate',
      parameters: { aggregate: 'sum' }, expectedContentId: crypto.randomUUID(), requestId: crypto.randomUUID() })).rejects.toThrow('conflict')
    await expect(executionAction({ workspace, binding, instanceId, receiver, operationId: 'aggregate',
      parameters: { aggregate: 5 }, expectedContentId: file.contentId, requestId: crypto.randomUUID() })).rejects.toThrow('invalid-input')
    await expect(executionAction({ workspace, binding, instanceId, receiver, operationId: 'missing',
      parameters: {}, expectedContentId: file.contentId, requestId: crypto.randomUUID() })).rejects.toThrow('capability-unavailable')
  })
})
