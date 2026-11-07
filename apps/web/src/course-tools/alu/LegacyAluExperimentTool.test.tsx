// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptsState, componentRuntimeManifestSchema, componentStateName, type ComponentBinding } from '@xunjie/contracts/components'
import type { AnyExecutionAction } from '@xunjie/contracts/execution'
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data'
import { useActivitySession } from '../../product/ActivitySession'
import { RuntimeTool } from '../../product/RuntimeTool'
import type { ReliableWorkspace } from '../../reliable-workspace'
import { readComponentState } from '../../tool-execution/action'

vi.mock('../../product/ActivitySession', () => ({ useActivitySession: vi.fn() }))
vi.mock('../../component-preparation/runtime', () => ({ runtimePreparation: {
  prepare: async () => ({ status: 'ready', diagnostics: [] }),
  entry: async () => '<p>固定单次实验说明</p>',
} }))

let root: Root | undefined
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto)
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function oldActivity() {
  const controls = { A: 0, B: 0, M: 0, S: 0, Cin: 0 }
  const ports = { type: 'object' as const, properties: Object.fromEntries(Object.keys(controls).map(key => [key, { type: 'number' as const }])) }
  const scaffoldResourceId = crypto.randomUUID()
  const single = { operationId: 'run-single', effect: 'execute' as const, parameters: ports,
    compile: { top: 'experiment', entryFiles: ['alu.sv'], includeDirs: [] },
    observation: { scaffoldResourceId, scaffoldVersion: 1, ports: { result: 'F', carry: 'Cout' }, resultFormat: 'xunjie-observations-v1' as const },
    budgets: { compileTimeoutMs: 30000, simulateTimeoutMs: 5000, jobTimeoutMs: 40000, memoryMiB: 256,
      inputBytes: 1048576, textBytes: 2097152, vcdBytes: 8388608, resultBytes: 16777216 },
    result: { type: 'object' as const, properties: { f: { type: 'string' as const, maxLength: 4 },
      cout: { type: 'string' as const, maxLength: 1 }, observationState: { type: 'string' as const, maxLength: 40 } } } }
  const legacy = componentRuntimeManifestSchema.parse({ formatVersion: 3, componentId: crypto.randomUUID(), hostApiVersion: 1,
    version: 1, stateVersion: 1, preparationProtocolVersion: 2, title: '原单次 ALU 实验',
    entry: { resourceId: crypto.randomUUID(), sha256: 'e'.repeat(64), byteLength: 20, mediaType: 'text/html' },
    stateShape: ports, initialState: controls, requiredCapabilities: ['workspace.read', 'workspace.change', 'execution.submit'],
    environment: { preparationType: 'browser', preparationProtocolVersion: 2, selfTestVersion: 1, requiredFeatures: ['worker'] },
    budget: { resourceCount: 32, totalResourceBytes: 16777216, preparationTimeoutMs: 300000, selfTestTimeoutMs: 60000,
      concurrentJobs: 1, queuedJobs: 1, cacheScope: 'device-local' },
    selfTest: { selfTestVersion: 1, fixture: { resourceId: scaffoldResourceId, path: 'single.sv', top: 'experiment',
      expect: { result: '0000', carry: '0' } }, timeoutMs: 60000 },
    runtime: { adapterId: 'icarus-alu', adapterVersion: 1, bundleIdentity: 'b'.repeat(64),
      resources: [{ resourceId: scaffoldResourceId, path: 'single.sv', sha256: 'c'.repeat(64), byteLength: 16, role: 'scaffold', mediaType: 'text/plain' }],
      operations: [single] } })
  const binding: ComponentBinding = { key: 'alu', configuration: { title: 'ALU 实验' }, materialIds: [],
    definition: { digest: 'a'.repeat(64), manifest: legacy } }
  const activityId = crypto.randomUUID(), key = JSON.stringify(['school', crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), activityId])
  const activity = { activityId, course: { releaseId: crypto.randomUUID(), requirements: '公开单次实验规则',
    executionPlan: { planId: 'alu-browser', planVersion: 1, planDigest: 'd'.repeat(64), components: [] } } } as unknown as LearningActivity
  const code: WorkFile = { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: 'alu.sv', kind: 'code',
    encoding: 'utf8', mediaType: 'text/plain', value: 'module alu; endmodule' }
  let snapshot = { ready: true, files: [code], conflict: null }
  const listeners = new Set<() => void>(), submitted: AnyExecutionAction[] = []
  const workspace = { key, snapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    isReadOnly: () => false, accessDenied: () => false,
    change: (files: WorkFile[]) => { snapshot = { ...snapshot, files }; listeners.forEach(listener => listener()) },
    trackInput: async (task: Promise<unknown>) => task,
  } as unknown as ReliableWorkspace
  const executions = { ready: true, records: [], error: '' }
  const execution = { snapshot: () => executions, subscribe: () => () => {},
    receiver: { identity: { receiverId: 'browser-execution' } },
    submit: async (action: AnyExecutionAction) => { submitted.push(action) }, query: async () => null }
  vi.mocked(useActivitySession).mockReturnValue({ workspace, execution } as unknown as ReturnType<typeof useActivitySession>)
  root = createRoot(container)
  await act(async () => { root!.render(<RuntimeTool activity={activity} binding={binding} spaceKey="school" namespace="old"
    authorized compact />) })
  return { workspace, binding, instanceId: `${activityId}:alu`, submitted, code }
}

describe('existing format 3 ALU activities retain their single-run state contract', () => {
  it('changes the five-port state without adding activation fields or automatically running', async () => {
    const { workspace, binding, instanceId, submitted } = await oldActivity()
    const select = container.querySelector('select')
    expect(select, 'the original activity keeps its original single-input form').not.toBeNull()
    await act(async () => {
      select!.value = '9'
      select!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const current = readComponentState(workspace, binding, instanceId)
    expect(current.content).toEqual({ A: 9, B: 0, M: 0, S: 0, Cin: 0 })
    expect(acceptsState(binding.definition.manifest.stateShape, current.content)).toBe(true)
    expect(submitted).toHaveLength(0)
  })

  it('runs the original code and input basis without a pending-activation state migration', async () => {
    const { workspace, binding, instanceId, submitted, code } = await oldActivity()
    const selects = container.querySelectorAll('select')
    expect(selects).toHaveLength(5)
    await act(async () => {
      selects[0]!.value = '15'; selects[0]!.dispatchEvent(new Event('change', { bubbles: true }))
    })
    const originalState = workspace.snapshot().files.find(file => file.name === componentStateName('alu'))!
    const run = [...container.querySelectorAll('button')].find(button => button.textContent === '运行')!
    expect(run.disabled).toBe(false)
    await act(async () => {
      run.click()
      await vi.waitFor(() => expect(submitted).toHaveLength(1), { timeout: 2000, interval: 10 })
    })
    expect(submitted).toHaveLength(1)
    const action = submitted[0]!
    expect(action.execution.operation.operationId).toBe('run-single')
    expect(action.execution.parameters).toEqual({ A: 15, B: 0, M: 0, S: 0, Cin: 0 })
    expect(action.execution.basis.works).toEqual([code, originalState])
    expect(action.execution.basis.expected.stateContentId).toBe(originalState.contentId)
    expect(readComponentState(workspace, binding, instanceId).content).toEqual({ A: 15, B: 0, M: 0, S: 0, Cin: 0 })
  })
})
