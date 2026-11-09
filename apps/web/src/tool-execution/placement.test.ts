import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { manifestResources, componentStateMediaType, type ComponentBinding } from '@xunjie/contracts/components'
import { courseExecutionPlanBasis, courseExecutionPlanV2Schema, type CourseExecutionPlanV2,
  type ExecutionAction, type ExecutionDevice, type ExecutionTarget } from '@xunjie/contracts/execution'
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data'
import { accumulatorPackage } from '../../../../components/state-accumulator/package.mjs'
import { aggregationPackage } from '../../../../components/table-aggregation/package.mjs'
import { aluCoursePackage } from '../../../../components/alu-experiment/package.mjs'
import type { ReliableWorkspace } from '../reliable-workspace'
import { digestOf, executionAction } from './action'
import { sessionAction, sessionPlacement } from './session'
import { runtimeAction } from './runtime-action'
import { executionEnvironmentSchema, sessionPlacementFromEnvironment, type ExecutionEnvironment } from './device'
import { createComponentBridge } from '../component-host/bridge'
import type { ExecutionController } from './controller'
import { createAggregationAdapter } from './adapters/aggregation'
import { runAggregation } from './algorithm'

afterEach(() => vi.unstubAllGlobals())
const device: ExecutionDevice = { platform: 'macos-arm64',
  browser: { worker: true, webassembly: true, sandboxedFrame: true },
  native: { supported: true, installed: true, authorized: true, prepared: 'ready' } }
const scope = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(),
  principalId: crypto.randomUUID(), activityId: crypto.randomUUID() }
const workspace = (files: WorkFile[] = []) => ({ key: JSON.stringify(['school', scope.environmentId,
  scope.spaceId, scope.principalId, scope.activityId]), snapshot: () => ({ ready: true, files }),
  trackInput: (input: Promise<unknown>) => input } as unknown as ReliableWorkspace)
const receiver = { receiverId: 'native-execution', location: 'local' as const, kind: 'execution' as const }

async function bound(target: ExecutionTarget, key = 'counter'): Promise<ComponentBinding> {
  const input = target === 'student-browser' ? await aggregationPackage() : await accumulatorPackage({ version: 1 })
  return { key, definition: { manifest: input.manifest, digest: await digestOf(input.manifest) },
    configuration: { title: key }, materialIds: [] }
}
async function teacherPlan(bindings: ComponentBinding[], targets: ExecutionTarget[]): Promise<CourseExecutionPlanV2> {
  const components = await Promise.all(bindings.map(async binding => {
    const m = binding.definition.manifest
    return { key: binding.key, definitionDigest: binding.definition.digest, configurationDigest: await digestOf(binding.configuration),
      operations: m.formatVersion === 3 ? m.runtime.operations.map(item => item.operationId)
        : m.formatVersion === 1 ? m.session ? [m.session.operation.operationId] : m.operations!.map(item => item.operationId) : [] }
  }))
  const native = targets.some(target => target !== 'student-browser'), browser = targets.includes('student-browser')
  const placements = bindings.flatMap((binding, index) => {
    const m = binding.definition.manifest
    return components[index].operations.map(operationId => {
      const budgets = m.formatVersion === 3 ? { ...m.runtime.operations.find(item => item.operationId === operationId)!.budgets,
        concurrentJobs: m.budget.concurrentJobs, queuedJobs: m.budget.queuedJobs }
        : m.formatVersion === 1 && m.session ? { ...m.session.budgets }
          : m.formatVersion === 1 ? { timeMs: m.operations![0].budgets.timeMs, memoryPages: m.algorithm!.memoryPages,
            inputBytes: 1048576, outputBytes: m.operations![0].budgets.outputBytes, concurrentJobs: 2, queuedJobs: 4 } : {}
      return { componentKey: binding.key, operationId, target: targets[index], budgets,
        resources: [m.entry, ...manifestResources(m)].map(({ resourceId, sha256, byteLength }) =>
          ({ resourceId, sha256, byteLength })) }
    })
  })
  const draft = courseExecutionPlanV2Schema.parse({ version: 2, planId: 'fixed-teacher-target', planVersion: 1,
    planDigest: '0'.repeat(64), components, placements, capabilities: ['execution.submit', ...(native ? ['native-session'] : [])],
    resources: { browser: browser ? { features: ['webassembly'] } : null,
      native: native ? { memoryMiB: 64, operationTimeoutMs: 5000, maxMs: 3600000 } : null },
    locations: [...(browser ? ['browser'] : []), ...(native ? ['native'] : [])], remote: null })
  return { ...draft, planDigest: await digestOf(courseExecutionPlanBasis(draft)) }
}
const rehash = async (plan: CourseExecutionPlanV2) => { plan.planDigest = await digestOf(courseExecutionPlanBasis(plan)); return plan }
const nativeAction = (binding: ComponentBinding, placement: Parameters<typeof sessionAction>[0]['placement']) =>
  sessionAction({ workspace: workspace(), binding, instanceId: scope.activityId + ':' + binding.key,
    receiver, parameters: {}, requestId: crypto.randomUUID(), placement })

describe('teacher targets from the real execution owner capability response', () => {
  it('uses componentKey for identical operation names and fixes the receiver without student choices', async () => {
    const local = await bound('student-runtime', 'local'), school = { ...local, key: 'school' }
    const plan = await teacherPlan([local, school], ['student-runtime', 'school-runtime'])
    const placement = { plan, device, remoteAvailable: true }
    expect((await nativeAction(local, placement)).receiver.location).toBe('local')
    expect((await nativeAction(school, placement)).receiver.location).toBe('remote')
    await expect(nativeAction(school, { ...placement, remoteAvailable: false })).rejects.toThrow('不可用')
    await expect(nativeAction(local, { ...placement, device: { ...device, native: null } })).rejects.toThrow()
  })

  it('does not infer school availability from a ready local adapter or local availability from a school host', async () => {
    const binding = await bound('student-runtime')
    const localPlan = await teacherPlan([binding], ['student-runtime']), schoolPlan = await teacherPlan([binding], ['school-runtime'])
    const environment: ExecutionEnvironment = { nodeClass: 'device', device, secureTransport: true, remoteAvailable: true,
      adapters: [{ adapterId: 'four-state-accumulator', adapterVersion: 1, platforms: ['macos-arm64'], available: true }] }
    const placement = (plan: CourseExecutionPlanV2, facts: ExecutionEnvironment | undefined) =>
      sessionPlacement(binding, sessionPlacementFromEnvironment(binding, plan, facts, 'macos-arm64'))
    expect(placement(localPlan, environment).owner).toBe('device')
    expect(placement(schoolPlan, environment)).toMatchObject({ state: 'target-unavailable', owner: null })
    expect(placement(localPlan, { ...environment, adapters: [] }).owner).toBeNull()
    expect(placement(localPlan, { ...environment, adapters: [{ ...environment.adapters[0], available: false }] }).owner).toBeNull()
    expect(placement(localPlan, undefined).owner).toBeNull()
    expect(placement(localPlan, { ...environment, nodeClass: 'school-execution-node' }).owner).toBeNull()
    expect(placement(schoolPlan, { ...environment, nodeClass: 'school-execution-node' }).owner).toBe('school-node')
    const reported = { target: 'school-runtime' as const, adapterId: 'four-state-accumulator', adapterVersion: 1, available: true }
    const facts = executionEnvironmentSchema.parse({ ...environment, placements: [reported] })
    expect(placement(schoolPlan, facts).owner).toBe('school-node')
    expect(placement(schoolPlan, { ...facts, secureTransport: false }).owner).toBeNull()
    expect(placement(schoolPlan, { ...facts, placements: [{ ...reported, available: false }] }).owner).toBeNull()
    expect(() => executionEnvironmentSchema.parse({ ...facts, placements: [reported, { ...reported, available: false }] })).toThrow()
  })

  it('narrows native supervisor and command budgets together, and freezes the chosen plan before hashing', async () => {
    const binding = await bound('student-runtime'), plan = await teacherPlan([binding], ['student-runtime'])
    Object.assign(plan.placements[0].budgets, { memoryMiB: 32, operationTimeoutMs: 1000, maxMs: 120000,
      idleMs: 60000, inputBytes: 128, outputBytes: 2048, concurrentSessions: 1 })
    await rehash(plan)
    const pending = nativeAction(binding, { plan, device, remoteAvailable: true })
    plan.placements[0].target = 'school-runtime'; plan.placements[0].budgets.inputBytes = 1024
    const action = await pending
    expect(action.receiver.location).toBe('local')
    expect(action.execution.session!.limits).toMatchObject({ memoryMiB: 32, operationTimeoutMs: 1000,
      maxMs: 120000, idleMs: 60000, concurrentSessions: 1 })
    expect(action.execution.limits).toMatchObject({ timeMs: 1000, inputBytes: 128, outputBytes: 2048, concurrentJobs: 1 })
  })
})

describe('every browser execution entry consumes the immutable teacher plan', () => {
  it('advertises and submits identical narrowed budgets through the actual component bridge', async () => {
    const binding = await bound('student-browser', 'table'), plan = await teacherPlan([binding], ['student-browser'])
    Object.assign(plan.placements[0].budgets, { timeMs: 1000, memoryPages: 8, inputBytes: 1024,
      outputBytes: 2048, concurrentJobs: 1, queuedJobs: 1 })
    await rehash(plan)
    const submit = vi.fn(async (_action: ExecutionAction) => {})
    const controller = { receiver: { identity: { receiverId: 'browser-execution' } }, submit,
      counts: () => ({ running: 0, queued: 0 }) } as unknown as ExecutionController
    const bridge = createComponentBridge(workspace(), scope.activityId, binding, () => true,
      { controller, canRun: () => true }, undefined, undefined, { plan, device, remoteAvailable: true })
    const call = (method: string, payload: unknown) => bridge.handle({ hostApiVersion: 1, connectionId: bridge.connectionId,
      instanceId: bridge.instanceId, messageId: crypto.randomUUID(), method, payload })
    try {
      const capabilities = await call('execution.capabilities', {}) as { operations: { available: boolean; limits: unknown }[] }
      expect(capabilities.operations[0].available).toBe(true)
      await call('execution.submit', { requestId: crypto.randomUUID(), operationId: 'aggregate', expectedContentId: null,
        parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } })
      expect(submit).toHaveBeenCalledOnce()
      expect(submit.mock.calls[0][0].execution.limits).toEqual(capabilities.operations[0].limits)
      expect(submit.mock.calls[0][0].execution.limits).toMatchObject({ timeMs: 1000, memoryPages: 8, concurrentJobs: 1 })
    } finally { bridge.close() }
  })

  it('refuses missing operations, configuration drift, absent browser features and a mismatched target before submission', async () => {
    const binding = await bound('student-browser', 'table')
    for (const fault of ['missing', 'configuration', 'features', 'target'] as const) {
      const plan = await teacherPlan([binding], ['student-browser'])
      if (fault === 'missing') plan.placements = []
      if (fault === 'configuration') plan.components[0].configurationDigest = 'a'.repeat(64)
      if (fault === 'target') plan.placements[0].target = 'school-runtime'
      await rehash(plan)
      const placement = { plan, device: fault === 'features'
        ? { ...device, browser: { ...device.browser, webassembly: false } } : device, remoteAvailable: true }
      const submit = vi.fn()
      const controller = { receiver: { identity: { receiverId: 'browser-execution' } }, submit,
        counts: () => ({ running: 0, queued: 0 }) } as unknown as ExecutionController
      const bridge = createComponentBridge(workspace(), scope.activityId, binding, () => true,
        { controller, canRun: () => true }, undefined, undefined, placement)
      const call = (method: string, payload: unknown) => bridge.handle({ hostApiVersion: 1, connectionId: bridge.connectionId,
        instanceId: bridge.instanceId, messageId: crypto.randomUUID(), method, payload })
      try {
        const caps = await call('execution.capabilities', {}) as { operations: { available: boolean }[] }
        expect(caps.operations[0].available, fault).toBe(false)
        await expect(call('execution.submit', { requestId: crypto.randomUUID(), operationId: 'aggregate', expectedContentId: null,
          parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } })).rejects.toThrow()
        expect(submit).not.toHaveBeenCalled()
      } finally { bridge.close() }
    }
  })

  it('the actual WASM adapter honours a teacher memory ceiling instead of restoring the manifest ceiling', async () => {
    const input = await aggregationPackage(), binding = await bound('student-browser', 'table')
    const manifest = input.manifest
    const instanceId = scope.activityId + ':table'
    const file: WorkFile = { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: 'components/table.json',
      kind: 'state', encoding: 'json', mediaType: componentStateMediaType,
      value: JSON.stringify({ formatVersion: 1, instanceId, componentId: manifest.componentId, version: manifest.version,
        definitionDigest: binding.definition.digest, stateVersion: 1, operationId: crypto.randomUUID(), content: manifest.initialState }) }
    const plan = await teacherPlan([binding], ['student-browser'])
    plan.placements[0].budgets.memoryPages = 8; await rehash(plan)
    const action = await executionAction({ workspace: workspace([file]), binding, instanceId,
      receiver: { receiverId: 'browser-execution', kind: 'execution', location: 'local' }, operationId: 'aggregate',
      parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' }, expectedContentId: file.contentId,
      requestId: crypto.randomUUID(), placement: { plan, device, remoteAvailable: false } })
    const run = vi.fn(async (job: Parameters<typeof runAggregation>[0]) => runAggregation(job))
    const adapter = createAggregationAdapter({ provider: { load: async () => ({
      bytes: Uint8Array.from(atob(input.algorithmBase64), char => char.charCodeAt(0)).buffer,
      entry: 'aggregate', memoryPages: 256, result: manifest.operations![0].result }) }, run })
    await adapter.run(action, { signal: new AbortController().signal, checkpoint: async () => {} })
    expect(run.mock.calls[0][0].memoryPages).toBe(8)
  })

  it('ALU construction applies V2 limits and refuses an attempted non-browser target', async () => {
    const course = await aluCoursePackage(), binding = course.release.components![0]
    const plan = await teacherPlan([binding], ['student-browser'])
    const operation = plan.placements.find(item => item.operationId === 'run-single')!
    operation.budgets.compileTimeoutMs = 1000; operation.budgets.jobTimeoutMs = 2000
    await rehash(plan)
    const identity = { environmentId: scope.environmentId, spaceId: scope.spaceId, principalId: scope.principalId,
      kind: 'school' as const, name: 'test' }
    const activity: LearningActivity = { activityId: scope.activityId, identity, target: { environmentId: scope.environmentId,
      serviceId: crypto.randomUUID(), version: 1 }, goal: '', question: '', references: [], status: 'open', createdAt: new Date().toISOString(),
      course: { ...course.release, associationId: crypto.randomUUID(), courseId: course.course.courseId, taskId: course.task.taskId,
        courseName: course.course.name, taskTitle: course.task.title, contentDigest: 'a'.repeat(64), executionPlan: plan } }
    const code: WorkFile = { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: 'alu.sv',
      kind: 'code', encoding: 'utf8', mediaType: 'text/plain', value: 'module alu; endmodule' }
    const action = await runtimeAction(workspace([code]), activity, binding, 'browser-execution')
    expect(action.execution.limits).toMatchObject({ compileTimeoutMs: 1000, jobTimeoutMs: 2000 })
    operation.target = 'school-runtime'; await rehash(plan)
    await expect(runtimeAction(workspace([code]), activity, binding, 'browser-execution')).rejects.toThrow()
  })
})
