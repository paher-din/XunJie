import { describe, expect, it, vi } from 'vitest'
import { componentManifestSchema } from '@xunjie/contracts/components'
import { executionQuerySchema, type ExecutionAction, type ExecutionQuery } from '@xunjie/contracts/execution'
import type { ReliableWorkspace } from '../reliable-workspace'
import { nativeLimits, sessionAction } from './session'
import { NativeSessionController } from './session-controller'

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
    return { first, transport, controller: new NativeSessionController(key, transport) }
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
})
