// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { componentRuntimeManifestSchema, componentStateName, type ComponentBinding } from '@xunjie/contracts/components'
import { rejectedExecutionAcceptance, type AnyExecutionAction } from '@xunjie/contracts/execution'
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data'
import type { ReliableWorkspace } from '../../reliable-workspace'
import type { LocalAction } from '../../reliable-workspace/action-store'
import type { ExecutionRecord } from '../../tool-execution/ledger'
import { runtimeAction } from '../../tool-execution/runtime-action'
import { useActivitySession } from '../../product/ActivitySession'
import { AluExperimentTool } from './AluExperimentTool'
import { defaultAluState, encodeEnabledBasis, type AluState } from './state'

vi.mock('../../product/ActivitySession', () => ({ useActivitySession: vi.fn() }))
vi.mock('../../product/ExecutionPanel', () => ({ ExecutionPanel: () => <p>原执行历史结果</p> }))
vi.mock('../../component-preparation/runtime', () => ({ runtimePreparation: {
  prepare: async () => ({ status: 'ready', diagnostics: [] }),
} }))
let root: Root | undefined, container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container)
})
afterEach(async () => { await act(async () => root?.unmount()); container.remove(); vi.unstubAllGlobals() })

async function experiment(patch: Partial<AluState> = {}, split = false) {
  const componentId = crypto.randomUUID(), scaffoldResourceId = crypto.randomUUID(), checkScaffoldId = crypto.randomUUID()
  const ports = { type: 'object', properties: Object.fromEntries(['A', 'B', 'M', 'S', 'Cin'].map(key => [key, { type: 'number' }])) }
  const operation = (operationId: string) => ({ operationId, effect: 'execute',
    parameters: operationId === 'check-all' ? { type: 'object', properties: {} } : ports,
    compile: { top: 'experiment', entryFiles: ['alu.sv'], includeDirs: [] },
    observation: { scaffoldResourceId: operationId === 'check-all' ? checkScaffoldId : scaffoldResourceId,
      scaffoldVersion: 1, ports: { result: 'F', carry: 'Cout' }, resultFormat: 'xunjie-observations-v1' },
    result: ports, budgets: { compileTimeoutMs: 30000, simulateTimeoutMs: 5000, jobTimeoutMs: 40000, memoryMiB: 256,
      inputBytes: 1048576, textBytes: 2097152, vcdBytes: 8388608, resultBytes: 16777216 } })
  const manifest = componentRuntimeManifestSchema.parse({ formatVersion: 3, componentId, version: 2, stateVersion: 2,
    hostApiVersion: 1, preparationProtocolVersion: 2, title: 'ALU 实验',
    entry: { resourceId: crypto.randomUUID(), sha256: 'e'.repeat(64), byteLength: 20, mediaType: 'text/html' },
    stateShape: { type: 'object', properties: Object.fromEntries(Object.entries(defaultAluState).map(([key, value]) =>
      [key, typeof value === 'string' ? { type: 'string', maxLength: 4000 } : { type: 'number' }])) }, initialState: defaultAluState,
    requiredCapabilities: ['workspace.read', 'workspace.change', 'execution.submit'],
    environment: { preparationType: 'browser', preparationProtocolVersion: 2, selfTestVersion: 1, requiredFeatures: ['worker'] },
    budget: { resourceCount: 32, totalResourceBytes: 16777216, preparationTimeoutMs: 300000, selfTestTimeoutMs: 60000,
      concurrentJobs: 1, queuedJobs: 1, cacheScope: 'device-local' },
    selfTest: { selfTestVersion: 1, fixture: { resourceId: scaffoldResourceId, path: 'single.sv', top: 'experiment', expect: { result: '0000', carry: '0' } }, timeoutMs: 60000 },
    runtime: { adapterId: 'icarus-alu', adapterVersion: 1, bundleIdentity: 'b'.repeat(64),
      resources: [{ resourceId: scaffoldResourceId, path: 'single.sv', sha256: 'c'.repeat(64), byteLength: 16, role: 'scaffold', mediaType: 'text/plain' },
        { resourceId: checkScaffoldId, path: 'check.sv', sha256: 'f'.repeat(64), byteLength: 16, role: 'scaffold', mediaType: 'text/plain' }],
      operations: ['run-single', 'observe-enabled', 'check-all'].map(operation) } })
  const binding: ComponentBinding = { key: 'alu', configuration: { title: 'ALU 实验', boardMapping: { version: 1,
    inputs: { A: [3, 2, 1, 0], B: [7, 6, 5, 4], M: [8], S: [10, 9], Cin: [11] }, outputs: { F: [3, 2, 1, 0], Cout: [4] } } },
    materialIds: [], definition: { digest: 'a'.repeat(64), manifest } }
  const activityId = crypto.randomUUID(), instanceId = `${activityId}:alu`
  const key = JSON.stringify(['school', crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), activityId])
  const activity = { activityId, course: { releaseId: crypto.randomUUID(), requirements: '公开 ALU 规则', components: [binding],
    executionPlan: { planId: 'alu-browser', planVersion: 2, planDigest: 'd'.repeat(64), components: [] } } } as unknown as LearningActivity
  const code: WorkFile = { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: 'alu.sv', kind: 'code',
    encoding: 'utf8', mediaType: 'text/plain', value: 'module alu; endmodule' }
  const stateId = crypto.randomUUID()
  let state = { ...defaultAluState, ...patch }
  const stateFile = (): WorkFile => ({ objectId: stateId, contentId: crypto.randomUUID(), name: componentStateName('alu'),
    kind: 'state', encoding: 'json', mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1,
      instanceId, componentId, version: 2, definitionDigest: binding.definition.digest, stateVersion: 2, operationId: crypto.randomUUID(), content: state }) })
  let snapshot = { ready: true, files: [code, stateFile()], conflict: null }
  const listeners = new Set<() => void>(), runListeners = new Set<() => void>()
  const workspace = { key, snapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    isReadOnly: () => false, accessDenied: () => false, change: (files: WorkFile[]) => {
      snapshot = { ...snapshot, files }; state = JSON.parse(files.find(file => file.kind === 'state')!.value).content
      listeners.forEach(listener => listener())
    }, trackInput: async (task: Promise<unknown>) => task } as unknown as ReliableWorkspace
  const enabledAction = await runtimeAction(workspace, activity, binding, 'browser-execution', { operationId: 'run-single' })
  const enabled: ExecutionRecord = { requestId: enabledAction.requestId, inputDigest: '1'.repeat(64), executionRef: crypto.randomUUID(),
    action: enabledAction, query: { state: 'succeeded', statusKnowledge: 'confirmed', output: { output: { f: '1000', cout: '0', observationState: 'complete' } } },
    acceptance: { execution: { executionRef: 'unused' } }, createdAt: Date.now() } as unknown as ExecutionRecord
  state = { ...state, enabledBasis: encodeEnabledBasis({ requestId: enabled.requestId, executionRef: enabled.executionRef,
    definitionDigest: binding.definition.digest, activationRevision: 1 }), activationRevision: 1, ...patch }
  if (patch.selectedObservation === 'enabled') state = { ...state, selectedObservation: enabled.requestId }
  snapshot = { ...snapshot, files: [code, stateFile()] }
  let runs = { ready: true, records: [enabled], error: '' }
  const submitted: AnyExecutionAction[] = []
  let releaseSubmit: (() => void) | undefined
  const submitBarrier = new Promise<void>(resolve => { releaseSubmit = resolve })
  const execution = { snapshot: () => runs, subscribe: (listener: () => void) => { runListeners.add(listener); return () => runListeners.delete(listener) },
    receiver: { identity: { receiverId: 'browser-execution' } }, submit: async (action: AnyExecutionAction) => { submitted.push(action); await submitBarrier },
    artifact: async () => null, query: async () => null }
  let actionsState = { items: [] as LocalAction[] }
  const actionListeners = new Set<() => void>()
  const actions = { subscribe: (listener: () => void) => { actionListeners.add(listener); return () => actionListeners.delete(listener) }, snapshot: () => actionsState }
  vi.mocked(useActivitySession).mockReturnValue({ workspace, execution, actions } as unknown as ReturnType<typeof useActivitySession>)
  root = createRoot(container)
  const props = { activity, binding, spaceKey: 'school', namespace: 'new', authorized: true }
  await act(async () => { root!.render(<>{split && <AluExperimentTool {...props} compact />}<AluExperimentTool {...props} /></>) })
  return { submitted, enabled, release: () => releaseSubmit!(), read: () => state,
    patch: (next: Partial<AluState>) => { state = { ...state, ...next }; workspace.change([code, stateFile()]) },
    reject: () => { const action = submitted[0]!
      actionsState = { items: [{ key: `${key}:${action.requestId}`, scope: key, input: action, phase: 'failed',
        cancelRequested: false, error: '', localAcceptance: rejectedExecutionAcceptance(action.requestId, '2'.repeat(64), action.receiver, '候选已变更') }] }
      actionListeners.forEach(listener => listener())
    },
    unknown: () => { runs = { ...runs, records: [{ ...enabled, query: { ...enabled.query, statusKnowledge: 'unknown' } }] }; runListeners.forEach(listener => listener()) } }
}

describe('ALU view coordination and result ownership', () => {
  it('admits one candidate when editor and board views are simultaneously mounted', async () => {
    const env = await experiment({ inputRevision: 1 }, true)
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
    expect(env.submitted).toHaveLength(1)
    expect(env.submitted[0]!.execution.operation.operationId).toBe('observe-enabled')
    expect(env.submitted[0]!.execution.basis).toMatchObject({ enabledBy: { requestId: env.enabled.requestId,
      inputDigest: env.enabled.inputDigest, executionRef: env.enabled.executionRef } })
    await act(async () => env.release())
  })

  it('hold hides a previously matching reading and the original execution history and never starts a candidate', async () => {
    const env = await experiment({ feedbackPolicy: 'hold', inputRevision: 1, selectedObservation: 'enabled', selectedObservationRevision: 1 })
    expect(container.textContent).toContain('预测编辑中')
    expect(container.textContent).not.toContain('F=1000')
    expect(container.textContent).not.toContain('原执行历史结果')
    expect(container.querySelector('[aria-label="反例筛选"]')).toBeNull()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)) })
    expect(env.submitted).toHaveLength(0)
  })

  it('labels a manual historical observation with its original input and does not display an unconfirmed terminal value', async () => {
    const env = await experiment({ feedbackPolicy: 'live', selectedObservation: 'enabled', selectedObservationRevision: -1, A: 7 })
    expect(container.textContent).toContain('原输入 A=7')
    await act(async () => env.patch({ A: 9 }))
    expect(container.textContent).toContain('原输入 A=7')
    await act(async () => env.unknown())
    expect(container.textContent).not.toContain('F=1000')
    expect(env.submitted).toHaveLength(0)
  })

  it('does not replace a historical choice made while a candidate is being protected', async () => {
    const env = await experiment({ inputRevision: 1 })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
    expect(env.submitted).toHaveLength(1)
    await act(async () => env.patch({ selectedObservation: env.enabled.requestId, selectedObservationRevision: -1 }))
    await act(async () => env.release())
    expect(env.read().selectedObservation).toBe(env.enabled.requestId)
    expect(env.read().selectedObservationRevision).toBe(-1)
  })

  it('clears a definitely rejected unaccepted candidate so hold can later resume normally', async () => {
    const env = await experiment({ inputRevision: 1 })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
    await act(async () => { env.patch({ feedbackPolicy: 'hold' }); env.release() })
    expect(env.read().selectedObservation).toBe(env.submitted[0]!.requestId)
    await act(async () => env.reject())
    expect(env.read().selectedObservation).toBe('')
    expect(env.read().selectedObservationRevision).toBe(-1)
    await act(async () => env.patch({ feedbackPolicy: 'live' }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 250)) })
    expect(env.submitted).toHaveLength(2)
  })
})
