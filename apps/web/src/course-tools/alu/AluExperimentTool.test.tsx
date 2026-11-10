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
import { WorkspaceReferencesProvider } from '../../components/workspace/references'
import { ALU_REFLECTION_MEDIA_TYPE, aluReflectionName, aluCaseFromAction } from '@xunjie/contracts/alu-learning'

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

async function compare(button: HTMLButtonElement, submitted: AnyExecutionAction[]) {
  const expected = submitted.length + 1
  await act(async () => {
    button.click()
    await vi.waitFor(() => expect(submitted).toHaveLength(expected))
  })
}

async function experiment(patch: Partial<AluState> = {}, split = false, version = 2) {
  const componentId = crypto.randomUUID(), scaffoldResourceId = crypto.randomUUID(), checkScaffoldId = crypto.randomUUID()
  const ports = { type: 'object', properties: Object.fromEntries(['A', 'B', 'M', 'S', 'Cin'].map(key => [key, { type: 'number' }])) }
  const operation = (operationId: string) => ({ operationId, effect: 'execute',
    parameters: operationId === 'check-all' ? { type: 'object', properties: {} } : ports,
    compile: { top: 'experiment', entryFiles: ['alu.sv'], includeDirs: [] },
    observation: { scaffoldResourceId: operationId === 'check-all' ? checkScaffoldId : scaffoldResourceId,
      scaffoldVersion: 1, ports: { result: 'F', carry: 'Cout' }, resultFormat: 'xunjie-observations-v1' },
    result: ports, budgets: { compileTimeoutMs: 30000, simulateTimeoutMs: 5000, jobTimeoutMs: 40000, memoryMiB: 256,
      inputBytes: 1048576, textBytes: 2097152, vcdBytes: 8388608, resultBytes: 16777216 } })
  const manifest = componentRuntimeManifestSchema.parse({ formatVersion: 3, componentId, version, stateVersion: version,
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
  const [, environmentId, spaceId, principalId] = JSON.parse(key)
  const activity = { activityId, identity: { environmentId, spaceId, principalId }, course: { releaseId: crypto.randomUUID(), requirements: '公开 ALU 规则', components: [binding],
    executionPlan: { planId: 'alu-browser', planVersion: 2, planDigest: 'd'.repeat(64), components: [] } } } as unknown as LearningActivity
  const code: WorkFile = { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: 'alu.sv', kind: 'code',
    encoding: 'utf8', mediaType: 'text/plain', value: 'module alu; endmodule' }
  const stateId = crypto.randomUUID()
  let state = { ...defaultAluState, ...patch }
  const stateFile = (): WorkFile => ({ objectId: stateId, contentId: crypto.randomUUID(), name: componentStateName('alu'),
    kind: 'state', encoding: 'json', mediaType: 'application/vnd.xunjie.component-state+json', value: JSON.stringify({ formatVersion: 1,
      instanceId, componentId, version, definitionDigest: binding.definition.digest, stateVersion: version, operationId: crypto.randomUUID(), content: state }) })
  let snapshot = { ready: true, files: [code, stateFile()], conflict: null }
  const listeners = new Set<() => void>(), runListeners = new Set<() => void>()
  let readOnly = false
  const workspace = { key, snapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    isReadOnly: () => readOnly, accessDenied: () => false, change: (files: WorkFile[]) => {
      if (readOnly) throw new Error('Read-only recovery')
      snapshot = { ...snapshot, files }; state = JSON.parse(files.find(file => file.kind === 'state')!.value).content
      listeners.forEach(listener => listener())
    }, trackInput: async (task: Promise<unknown>) => task, leave: async () => {} } as unknown as ReliableWorkspace
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
  await act(async () => { root!.render(<WorkspaceReferencesProvider workspaceKey={key} onSubmit={() => {}}>
    {split && <AluExperimentTool {...props} compact />}<AluExperimentTool {...props} /></WorkspaceReferencesProvider>) })
  return { submitted, enabled, release: () => releaseSubmit!(), read: () => state,
    isolate: () => { readOnly = true; snapshot = { ...snapshot }; listeners.forEach(listener => listener()) },
    files: () => snapshot.files,
    seedNotes: () => {
      const noteIds = [crypto.randomUUID(), crypto.randomUUID()], action = submitted.at(-1)!
      const files = noteIds.map((noteId, index): WorkFile => ({ objectId: noteId, contentId: noteId,
        name: aluReflectionName(binding.key, noteId), kind: 'state', encoding: 'json', mediaType: ALU_REFLECTION_MEDIA_TYPE,
        value: JSON.stringify({ formatVersion: 1, kind: 'alu-reflection', noteId, activityId,
          bindingKey: binding.key, instanceId, definitionDigest: binding.definition.digest,
          requestId: action.requestId, inputDigest: enabled.inputDigest, executionRef: enabled.executionRef,
          parentNoteId: index ? noteIds[0] : null, text: `已有解释 ${index + 1}` }) }))
      workspace.change([...snapshot.files, ...files]); return noteIds
    },
    complete: async () => {
      const action = submitted.at(-1)!
      runs = { ...runs, records: [{ ...enabled, requestId: action.requestId, action,
        query: { ...enabled.query, output: { ...enabled.query.output!, output: { f: '1000', cout: '0', observationState: 'complete' } } } }, ...runs.records] }
      runListeners.forEach(listener => listener())
    },
    patch: (next: Partial<AluState>) => { state = { ...state, ...next }; workspace.change([code, stateFile()]) },
    reject: () => { const action = submitted[0]!
      actionsState = { items: [{ key: `${key}:${action.requestId}`, scope: key, input: action, phase: 'failed',
        cancelRequested: false, error: '', localAcceptance: rejectedExecutionAcceptance(action.requestId, '2'.repeat(64), action.receiver, '候选已变更') }] }
      actionListeners.forEach(listener => listener())
    },
    unknown: () => { runs = { ...runs, records: [{ ...enabled, query: { ...enabled.query, statusKnowledge: 'unknown' } }] }; runListeners.forEach(listener => listener()) } }
}

describe('ALU view coordination and result ownership', () => {
  it('browses an earlier restored case without changing the read-only workspace or executing again', async () => {
    const env = await experiment({}, false, 3)
    const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!
    for (let index = 0; index < 2; index++) {
      await act(async () => button('新用例').click())
      await compare(button('运行并比较'), env.submitted)
      await act(async () => env.release())
      await act(async () => env.complete())
    }
    const first = env.submitted[0]!.requestId, saved = JSON.stringify(env.files()), state = { ...env.read() }
    await act(async () => env.isolate())
    const select = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="用例记录"]')!
    await act(async () => select.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    const list = document.getElementById(select.getAttribute('aria-controls')!)
    expect(list).not.toBeNull()
    const option = Array.from(list!.querySelectorAll<HTMLElement>('[role="option"]')).find(node => node.textContent?.startsWith('1 ·'))!
    const optionLabel = option.textContent
    await act(async () => { option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); option.click() })
    expect(select.textContent).toBe(optionLabel)
    expect(container.querySelector('.alu-case-results')?.getAttribute('data-execution-request-id')).toBe(first)
    expect(JSON.stringify(env.files())).toBe(saved)
    expect(env.read()).toEqual(state)
    expect(env.submitted).toHaveLength(2)
    expect(button('运行').disabled).toBe(true)
  })
  it('keeps resumed free observation when an older compare submission finishes', async () => {
    const env = await experiment({}, false, 3)
    const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!
    await act(async () => button('新用例').click())
    await compare(button('运行并比较'), env.submitted)
    await act(async () => button('恢复自由观察').click())
    expect(env.read().feedbackPolicy).toBe('live')
    await act(async () => env.release())
    expect(env.read().feedbackPolicy).toBe('live')
    expect(env.read().selectedCase).toBe('')
  })

  it('saves an explanation of a direct observation without asking for another run or inventing a prediction', async () => {
    const env = await experiment({ selectedObservation: 'enabled', selectedObservationRevision: 0 }, false, 3)
    const explanation = container.querySelector<HTMLTextAreaElement>('[aria-label="实验解释"]')
    expect(explanation).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(explanation, '这是直接观察之后的解释，先前没有预测。')
      explanation!.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => [...container.querySelectorAll('button')].find(node => node.textContent === '保存解释修订')!.click())
    const note = env.files().find(file => file.mediaType === ALU_REFLECTION_MEDIA_TYPE)
    expect(note && JSON.parse(note.value)).toMatchObject({ requestId: env.enabled.requestId, parentNoteId: null,
      text: '这是直接观察之后的解释，先前没有预测。' })
    expect(env.read().caseDraft).toBe('')
    expect(env.submitted).toHaveLength(0)
  })

  it('keeps the chosen earlier explanation as the parent after clearing and rewriting its text', async () => {
    const env = await experiment({}, false, 3)
    const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!
    await act(async () => button('新用例').click())
    await compare(button('运行并比较'), env.submitted)
    await act(async () => env.release())
    await act(async () => env.complete())
    let noteIds: string[] = []
    await act(async () => { noteIds = env.seedNotes() })
    await act(async () => container.querySelector<HTMLButtonElement>('.alu-reflection button')!.click())
    const explanation = container.querySelector<HTMLTextAreaElement>('[aria-label="实验解释"]')!
    expect(explanation.value).toBe('已有解释 1')
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(explanation, '')
      explanation.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(explanation, '从解释 1 继续修订')
      explanation.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('保存解释修订').click())
    const notes = env.files().filter(file => file.mediaType === ALU_REFLECTION_MEDIA_TYPE).map(file => JSON.parse(file.value))
    expect(notes).toHaveLength(3)
    expect(notes[2]).toMatchObject({ parentNoteId: noteIds[0], text: '从解释 1 继续修订' })
    expect(notes[0].text).toBe('已有解释 1')
    expect(notes[1].text).toBe('已有解释 2')
  })
  it('reveals the fixed comparison in hold after its original accepted record arrives', async () => {
    const env = await experiment({}, false, 3)
    const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!
    await act(async () => button('新用例').click())
    await compare(button('运行并比较'), env.submitted)
    await act(async () => env.release())
    await act(async () => env.complete())
    expect(container.querySelector('[aria-label="预测与实际比较"]')?.textContent).toContain('1000')
    expect(container.querySelector('[aria-label="预测与实际比较"]')?.textContent).toContain('未填写预测')
    expect(env.read().feedbackPolicy).toBe('hold')
    expect(env.submitted).toHaveLength(1)
  })
  it('editing a candidate suppresses adjacent output and fixes only the clicked prediction while later edits survive', async () => {
    const env = await experiment({ selectedObservation: 'enabled', selectedObservationRevision: 0 }, true, 3)
    expect(container.textContent).toContain('F=1000')
    const button = (label: string) => [...container.querySelectorAll('button')].find(node => node.textContent === label)!
    await act(async () => button('新用例').click())
    expect(container.textContent).not.toContain('F=1000')
    expect(container.textContent).not.toContain('原执行历史结果')
    const reason = container.querySelector<HTMLTextAreaElement>('[aria-label="选择这组输入的理由"]')!
    const input = async (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(reason, value)
      reason.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await input('我想检查边界')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) })
    expect(env.submitted).toHaveLength(0)
    const originalDigest = webcrypto.subtle.digest.bind(webcrypto.subtle)
    let releaseDigest!: () => void
    // The real digest may finish after React's click turn, as on the CI runner.
    const digestBarrier = new Promise<void>(resolve => { releaseDigest = resolve })
    const digest = vi.spyOn(webcrypto.subtle, 'digest').mockImplementation(async (...args) => {
      await digestBarrier
      return originalDigest(...args)
    })
    try {
      expect(button('运行并比较').disabled).toBe(false)
      await act(async () => button('运行并比较').click())
      expect(digest).toHaveBeenCalled()
      expect(env.submitted).toHaveLength(0)
      await act(async () => {
        releaseDigest()
        await vi.waitFor(() => expect(env.submitted).toHaveLength(1))
      })
      const action = env.submitted[0]!
      expect(action.protocolVersion === 3 && aluCaseFromAction(action)?.draft.reason).toBe('我想检查边界')
      await input('接收期间的新草稿')
      await act(async () => env.release())
      expect(reason.value).toBe('接收期间的新草稿')
      expect(env.read().selectedCase).toBe('')
      expect(action.protocolVersion === 3 && aluCaseFromAction(action)?.draft.reason).toBe('我想检查边界')
    } finally {
      digest.mockRestore()
      await act(async () => {
        releaseDigest(); env.release()
        await vi.waitFor(() => expect(env.submitted).toHaveLength(1))
      })
    }
  })
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
