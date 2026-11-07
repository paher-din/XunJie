// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { componentRuntimeManifestSchema, componentStateName, type ComponentBinding } from '@xunjie/contracts/components'
import { type AnyExecutionAction } from '@xunjie/contracts/execution'
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data'
import type { ReliableWorkspace } from '../../reliable-workspace'
import type { ExecutionRecord } from '../../tool-execution/ledger'
import { analyzeCheck } from '../../tool-execution/adapters/alu-check'
import { runtimeAction } from '../../tool-execution/runtime-action'
import { useActivitySession } from '../../product/ActivitySession'
import { RuntimeTool } from '../../product/RuntimeTool'
import { defaultAluState, encodeEnabledBasis, type AluState } from './state'
import { WorkspaceReferencesProvider, WorkspaceReferenceList, useWorkspaceReferences } from '../../components/workspace/references'
import { ALU_REFLECTION_MEDIA_TYPE, aluReflectionName } from '@xunjie/contracts/alu-learning'

vi.mock('../../product/ActivitySession', () => ({ useActivitySession: vi.fn() }))
const preparation = vi.hoisted(() => ({ prepare: vi.fn(), entry: vi.fn() }))
vi.mock('../../component-preparation/runtime', () => ({ runtimePreparation: preparation }))
let root: Root | undefined, container: HTMLDivElement
beforeEach(() => {
  preparation.prepare.mockReset().mockResolvedValue({ status: 'ready', diagnostics: [] })
  preparation.entry.mockReset().mockResolvedValue('<p>原实验说明</p>')
  vi.stubGlobal('crypto', webcrypto); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container)
})
afterEach(async () => { await act(async () => root?.unmount()); container.remove(); vi.unstubAllGlobals() })

async function experiment(patch: Partial<AluState> = {}, split = false, version = 3, componentVersion = 4) {
  const componentId = crypto.randomUUID(), scaffoldResourceId = crypto.randomUUID(), checkScaffoldId = crypto.randomUUID()
  const ports = { type: 'object', properties: Object.fromEntries(['A', 'B', 'M', 'S', 'Cin'].map(key => [key, { type: 'number' }])) }
  const operation = (operationId: string) => ({ operationId, effect: 'execute',
    parameters: operationId === 'check-all' ? { type: 'object', properties: {} } : ports,
    compile: { top: 'experiment', entryFiles: ['alu.sv'], includeDirs: [] },
    observation: { scaffoldResourceId: operationId === 'check-all' ? checkScaffoldId : scaffoldResourceId,
      scaffoldVersion: 1, ports: { result: 'F', carry: 'Cout' }, resultFormat: 'xunjie-observations-v1' },
    result: ports, budgets: { compileTimeoutMs: 30000, simulateTimeoutMs: 5000, jobTimeoutMs: 40000, memoryMiB: 256,
      inputBytes: 1048576, textBytes: 2097152, vcdBytes: 8388608, resultBytes: 16777216 } })
  const manifest = componentRuntimeManifestSchema.parse({ formatVersion: 3, componentId, version: componentVersion, stateVersion: version,
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
      instanceId, componentId, version: componentVersion, definitionDigest: binding.definition.digest, stateVersion: version, operationId: crypto.randomUUID(), content: state }) })
  let snapshot = { ready: true, files: [code, stateFile()], conflict: null }
  const listeners = new Set<() => void>(), runListeners = new Set<() => void>()
  let readOnly = false
  const changes: WorkFile[][] = []
  const workspace = { key, snapshot: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
    isReadOnly: () => readOnly, accessDenied: () => false, change: (files: WorkFile[]) => {
      if (readOnly) throw new Error('Read-only recovery')
      changes.push(files)
      snapshot = { ...snapshot, files }; state = JSON.parse(files.find(file => file.kind === 'state')!.value).content
      listeners.forEach(listener => listener())
    }, trackInput: async (task: Promise<unknown>) => task, leave: async () => {} } as unknown as ReliableWorkspace
  const enabledAction = await runtimeAction(workspace, activity, binding, 'browser-execution', { operationId: 'run-single' })
  const enabled: ExecutionRecord = { requestId: enabledAction.requestId, inputDigest: '1'.repeat(64), executionRef: crypto.randomUUID(),
    action: enabledAction, query: { state: 'succeeded', statusKnowledge: 'confirmed', output: { contentId: crypto.randomUUID(), output: { f: '1000', cout: '0', observationState: 'complete' } } },
    acceptance: { execution: { executionRef: 'unused' } }, createdAt: Date.now() } as unknown as ExecutionRecord
  state = { ...state, enabledBasis: encodeEnabledBasis({ requestId: enabled.requestId, executionRef: enabled.executionRef,
    definitionDigest: binding.definition.digest, activationRevision: 1 }), activationRevision: 1, ...patch }
  if (patch.selectedObservation === 'enabled') state = { ...state, selectedObservation: enabled.requestId }
  snapshot = { ...snapshot, files: [code, stateFile()] }
  let runs = { ready: true, records: [enabled], error: '' }
  const submitted: AnyExecutionAction[] = []
  let artifactAvailable = true, vcdText = probeVcd
  const artifact = vi.fn(async (requestId: string) => {
    if (!artifactAvailable) return null
    if (runs.records.find(record => record.requestId === requestId)?.action.execution.operation.operationId === 'check-all') {
      const analysis = analyzeCheck([])
      return { requestId, name: 'check-report.json', text: JSON.stringify({ ...analysis, counterexamples: analysis.counterexamples.slice(0, 1), formatVersion: 1, kind: 'alu-check',
        createdAt: new Date().toISOString(), rounds: [], source: { adapterId: 'icarus-alu', adapterVersion: 1,
          bundleIdentity: 'b'.repeat(64), dependencyId: 'c'.repeat(64), suiteVersion: 1,
          scaffold: { path: 'check.sv', sha256: 'f'.repeat(64), version: 1 }, rule: { version: 1, digest: 'd'.repeat(64) },
          works: [{ name: code.name, contentId: code.contentId, sha256: 'e'.repeat(64) }] } }),
        resources: [
          { name: 'check-observations.json', text: JSON.stringify({ formatVersion: 1, kind: 'alu-check-observations',
            totalInputs: 4096, plannedSamples: 16384, verdict: analysis.verdict, counterexamples: [], rounds: [] }) },
          { name: 'diagnostics.txt', text: '' },
          { name: 'check-traces.json', text: JSON.stringify({ formatVersion: 1, kind: 'alu-check-traces', rounds: [] }) },
        ].map(resource => ({ ...resource, contentId: crypto.randomUUID(), mediaType: 'text/plain',
          sha256: 'f'.repeat(64), byteLength: Buffer.byteLength(resource.text) })) }
    }
    return { requestId, resources: [{ name: 'trace.vcd', text: vcdText }] }
  })
  const execution = { snapshot: () => runs, subscribe: (listener: () => void) => { runListeners.add(listener); return () => runListeners.delete(listener) },
    receiver: { identity: { receiverId: 'browser-execution' } }, submit: async (action: AnyExecutionAction) => { submitted.push(action) },
    artifact, query: async () => null }
  const actionsState = { items: [] }
  const actions = { subscribe: () => () => {}, snapshot: () => actionsState }
  vi.mocked(useActivitySession).mockReturnValue({ workspace, execution, actions } as unknown as ReturnType<typeof useActivitySession>)
  root = createRoot(container)
  const props = { activity, binding, spaceKey: 'school', namespace: 'new', authorized: true }
  let generation = 0
  const render = () => root!.render(<WorkspaceReferencesProvider workspaceKey={key} onSubmit={() => {}}>
    <ProbeReferences />{split && <RuntimeTool {...props} compact />}<RuntimeTool key={generation} {...props} /></WorkspaceReferencesProvider>)
  await act(async () => render())
  return { submitted, enabled, artifact, changes,
    remount: () => { generation++; render() },
    unavailable: () => { artifactAvailable = false },
    replaceVcd: (text: string) => { vcdText = text },
    replaceContent: () => { runs = { ...runs, records: runs.records.map(record => ({ ...record,
      query: { ...record.query, output: { ...record.query.output!, contentId: crypto.randomUUID() } } })) }; runListeners.forEach(listener => listener()) },
    read: () => state,
    isolate: () => { readOnly = true; snapshot = { ...snapshot }; listeners.forEach(listener => listener()) },
    files: () => snapshot.files,
    seedHistory: (count: number, operationId = 'observe-enabled') => {
      const history = Array.from({ length: count }, (_, index) => ({ ...enabled, requestId: crypto.randomUUID(), createdAt: Date.now() - (index + 1) * 1000,
        query: { ...enabled.query, output: { contentId: crypto.randomUUID(), artifact: null, output: { f: '0010', cout: '1', observationState: 'complete' } } }, action: { ...enabledAction, requestId: crypto.randomUUID(), execution: { ...enabledAction.execution, operation: { ...enabledAction.execution.operation, operationId }, parameters: { A: index, B: 0, M: 1, S: 0, Cin: 0 } } } }));
      history.forEach(record => { record.action.requestId = record.requestId });
      runs = { ...runs, records: [...history, enabled] }; runListeners.forEach(listener => listener()); return history;
    },
    seedNotes: () => {
      const noteIds = [crypto.randomUUID(), crypto.randomUUID()], action = submitted.at(-1) ?? enabled.action
      const files = noteIds.map((noteId, index): WorkFile => ({ objectId: noteId, contentId: noteId,
        name: aluReflectionName(binding.key, noteId), kind: 'state', encoding: 'json', mediaType: ALU_REFLECTION_MEDIA_TYPE,
        value: JSON.stringify({ formatVersion: 1, kind: 'alu-reflection', noteId, activityId,
          bindingKey: binding.key, instanceId, definitionDigest: binding.definition.digest,
          requestId: action.requestId, inputDigest: enabled.inputDigest, executionRef: enabled.executionRef,
          parentNoteId: index ? noteIds[0] : null, text: `已有解释 ${index + 1}` }) }))
      workspace.change([...snapshot.files, ...files]); return noteIds
    },
    patch: (next: Partial<AluState>) => { state = { ...state, ...next }; workspace.change([code, stateFile()]) },
  }
}


const probeVcd = `$timescale 1 ns $end
$scope module tb $end
$var wire 4 ! F [3:0] $end
$var wire 1 # Cout $end
$upscope $end
$enddefinitions $end
#0
b0000 !
0#
#10
b1000 !
#20
b1010 !
`
let referenceController: ReturnType<typeof useWorkspaceReferences>
function ProbeReferences() {
  referenceController = useWorkspaceReferences()
  return <><WorkspaceReferenceList /><p data-probe-notice>{referenceController.notice}</p></>
}
const clickNamed = async (text: string) => {
  const button = Array.from(container.querySelectorAll('button')).find(item => item.textContent === text)!
  expect(button, `button ${text}`).toBeTruthy()
  await act(async () => button.click())
}
const setText = async (label: string, value: string) => {
  const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('independent WP04 frontend requirement probes', () => {
  it('reopens the exact retained signal and time range when locating a waveform reference', async () => {
    const env = await experiment({ selectedObservation: 'enabled', selectedObservationRevision: 0 }, false, 3)
    const signal = container.querySelector<HTMLInputElement>('input[aria-label="选择 tb.F[3:0]"]')!
    expect(signal).toBeTruthy()
    await act(async () => signal.click())
    await setText('结束 tick', '10')
    await act(async () => container.querySelector<HTMLFormElement>('form[aria-label="波形范围"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    const original = env.read().waveSelection
    expect(JSON.parse(original).range).toEqual({ signalIds: ['tb.F[3:0]'], fromTick: '0', toTick: '10' })
    await clickNamed('引用波形')
    expect(referenceController.references).toHaveLength(1)
    expect(referenceController.references[0]!.text).toContain('原始 tick 闭区间：0 至 10')
    await setText('结束 tick', '20')
    await act(async () => container.querySelector<HTMLFormElement>('form[aria-label="波形范围"]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(JSON.parse(env.read().waveSelection).range.toTick).toBe('20')
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="定位引用 1"]')!.click())
    expect(container.querySelector('[data-probe-notice]')!.textContent).toBe('已定位引用来源。')
    // Requirement: the original selected signal/time range is reopened.
    expect(env.read().waveSelection).toBe(original)
    expect(document.activeElement).toBe(container.querySelector('.alu-waveform'))
    expect(env.submitted).toHaveLength(0)
  })

  it('keeps older free observations selectable for their original waveform after eight newer results', async () => {
    const env = await experiment({ selectedObservation: 'enabled', selectedObservationRevision: 0 }, false, 3)
    let history: ReturnType<typeof env.seedHistory> = []
    await act(async () => { history = env.seedHistory(9) })
    const retainedRecord = history[8]!
    // Generic execution history retains the record, but currently only query/download are offered.
    const executionPanel = container.querySelector<HTMLElement>('section[aria-label="计算记录"]')!
    expect(executionPanel.querySelectorAll('.execution-records > li')).toHaveLength(10)
    expect(executionPanel.textContent).toContain('A=8')
    const historySection = container.querySelector<HTMLElement>('.alu-history')!
    await clickNamed('显示更多观察')
    const selectors = [...historySection.querySelectorAll('button')].filter(item => item.textContent === '查看')
    // All retained free observations need an in-product selection path (list or pagination).
    expect(selectors).toHaveLength(10)
    expect(historySection.textContent).toContain('A=8')
    expect(env.read().selectedObservation).not.toBe(retainedRecord.requestId)
    const board = container.querySelector('.alu-board')!.innerHTML
    const controls = { A: env.read().A, B: env.read().B, M: env.read().M, S: env.read().S, Cin: env.read().Cin }
    await act(async () => selectors[8]!.click())
    expect(env.read().selectedObservation).toBe(retainedRecord.requestId)
    expect(container.querySelector('.alu-readout-inputs')!.textContent).toContain('A=8')
    expect(container.querySelector('.alu-board')!.innerHTML).toBe(board)
    expect({ A: env.read().A, B: env.read().B, M: env.read().M, S: env.read().S, Cin: env.read().Cin }).toEqual(controls)
    expect(env.artifact).toHaveBeenCalledWith(retainedRecord.requestId)
    expect(env.submitted).toHaveLength(0)
  })
})

async function citeWave() {
  await act(async () => container.querySelector<HTMLInputElement>('input[aria-label="选择 tb.F[3:0]"]')!.click())
  await setText('结束 tick', '10')
  await act(async () => container.querySelector<HTMLFormElement>('form[aria-label="波形范围"]')!
    .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
  await clickNamed('引用波形')
}
async function locateFirst() {
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="定位引用 1"]')!.click())
}
const success = () => expect(container.querySelector('[data-probe-notice]')!.textContent).toBe('已定位引用来源。')
const failure = () => expect(container.querySelector('[data-probe-notice]')!.textContent).toMatch(/不可|变化|不支持/)

describe('retained ALU semantic navigation', () => {
  it.each(['newer-reference', 'manual-history'] as const)('does not let delayed locate A replace a later %s selection B', async navigation => {
    const env = await experiment({ selectedObservation: 'enabled', selectedObservationRevision: 0 }, false, 3)
    await citeWave()
    let history: ReturnType<typeof env.seedHistory> = []
    await act(async () => { history = env.seedHistory(1) })
    const historyButtons = () => [...container.querySelectorAll<HTMLButtonElement>('.alu-history button')]
      .filter(button => button.textContent === '查看')
    await act(async () => historyButtons()[0]!.click())
    await citeWave()
    const [referenceA, referenceB] = referenceController.references
    expect(referenceA!.source).toMatchObject({ kind: 'component', objectId: env.enabled.requestId })
    expect(referenceB!.source).toMatchObject({ kind: 'component', objectId: history[0]!.requestId })
    await act(async () => historyButtons()[1]!.click())

    const retainedA = await env.artifact(env.enabled.requestId)
    let releaseA!: (artifact: typeof retainedA) => void
    env.artifact.mockImplementationOnce(() => new Promise(resolve => { releaseA = resolve }))
    let locateA!: Promise<void>
    await act(async () => { locateA = Promise.resolve(referenceController.locate(referenceA!)) })
    expect(releaseA).toBeTypeOf('function')
    if (navigation === 'newer-reference') {
      await act(async () => { referenceController.locate(referenceB!) })
      await vi.waitFor(success)
      expect(document.activeElement).toBe(container.querySelector('.alu-waveform'))
    } else {
      await act(async () => {
        const button = historyButtons()[0]!
        button.focus()
        button.click()
      })
    }
    expect(env.read().selectedObservation).toBe(history[0]!.requestId)
    const selectedWave = env.read().waveSelection, focused = document.activeElement
    await act(async () => { releaseA(retainedA) })
    await locateA
    expect(env.read().selectedObservation, 'the newest navigation must retain selection B').toBe(history[0]!.requestId)
    expect(env.read().waveSelection).toBe(selectedWave)
    expect(document.activeElement, 'stale locate A must not steal focus').toBe(focused)
    if (navigation === 'newer-reference')
      expect(container.querySelector('[data-probe-notice]')!.textContent, 'stale A must not replace the newer locate result notice')
        .toBe('已定位引用来源。')
    else failure()
    expect(env.submitted).toHaveLength(0)
  })

  it.each([false, true])('opens a different result after source remount, read-only=%s, without running', async readOnly => {
    const env = await experiment({ selectedObservation: 'enabled', selectedObservationRevision: 0 }, false, 3)
    await citeWave()
    const original = env.read().waveSelection
    await act(async () => { env.seedHistory(1); env.remount() })
    const view = [...container.querySelectorAll<HTMLButtonElement>('.alu-history button')].find(button => button.textContent === '查看')!
    await act(async () => view.click())
    expect(env.read().selectedObservation).not.toBe(env.enabled.requestId)
    if (readOnly) await act(async () => env.isolate())
    const before = env.files(), writes = env.changes.length
    await locateFirst()
    await vi.waitFor(success)
    expect(document.activeElement).toBe(container.querySelector('.alu-waveform'))
    expect(container.querySelector<HTMLInputElement>('input[aria-label="结束 tick"]')!.value).toBe('10')
    expect(container.querySelector<HTMLInputElement>('input[aria-label="选择 tb.F[3:0]"]')!.checked).toBe(true)
    expect(container.querySelector('.alu-case-results')!.textContent).toContain(env.enabled.requestId)
    if (readOnly) {
      expect(env.files()).toBe(before)
      expect(env.changes).toHaveLength(writes)
    } else expect(env.read().waveSelection).toBe(original)
    expect(env.submitted).toHaveLength(0)
  })

  it('normalizes duplicate signals and decimal point ticks before focusing', async () => {
    const env = await experiment({ selectedObservation: 'enabled', selectedObservationRevision: 0 }, false, 3)
    await citeWave()
    const reference = referenceController.references[0]!
    await act(async () => referenceController.locate({ ...reference, range: { ...reference.range, target: {
      signalIds: ['tb.F[3:0]', 'tb.F[3:0]'], fromTick: '00010', toTick: '0010',
    } } }))
    await vi.waitFor(success)
    expect(JSON.parse(env.read().waveSelection).range).toEqual({ signalIds: ['tb.F[3:0]'], fromTick: '10', toTick: '10' })
    expect(document.activeElement).toBe(container.querySelector('.alu-waveform'))
    expect(env.submitted).toHaveLength(0)
  })

  it.each(['missing', 'changed', 'signal', 'tick', 'malformed'] as const)('refuses unavailable original waveform: %s', async reason => {
    const env = await experiment({ selectedObservation: 'enabled', selectedObservationRevision: 0 }, false, 3)
    await citeWave()
    const before = env.read().waveSelection
    if (reason === 'missing') env.unavailable()
    if (reason === 'changed') await act(async () => env.replaceContent())
    if (reason === 'signal') env.replaceVcd(probeVcd.replace(' F ', ' G '))
    if (reason === 'tick') env.replaceVcd(probeVcd.replace('#10', '#1').replace('#20', '#2'))
    if (reason === 'malformed') env.replaceVcd('broken VCD')
    await locateFirst()
    await vi.waitFor(failure)
    expect(env.read().waveSelection).toBe(before)
    expect(referenceController.references[0]!.text).toContain('0 至 10')
    expect(env.submitted).toHaveLength(0)
  })

  it.each([false, true])('locates an observation and an immutable reflection after switching results, read-only=%s', async readOnly => {
    const env = await experiment({ selectedObservation: 'enabled', selectedObservationRevision: 0 }, false, 3)
    await clickNamed('结果加入问题')
    await act(async () => env.seedNotes())
    await clickNamed('解释加入问题')
    await act(async () => env.seedHistory(1))
    const first = container.querySelector<HTMLButtonElement>('.alu-history button')!
    await act(async () => { first.click(); if (readOnly) env.isolate() })
    const files = env.files(), writes = env.changes.length
    await locateFirst()
    await vi.waitFor(success)
    expect(document.activeElement).toBe(container.querySelector('table[aria-label="预测与实际比较"]'))
    await act(async () => first.click())
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="定位引用 2"]')!.click())
    await vi.waitFor(success)
    expect(document.activeElement).toBe(container.querySelector('.alu-reflection'))
    expect(document.activeElement?.textContent).toContain('已有解释 1')
    if (readOnly) { expect(env.files()).toBe(files); expect(env.changes).toHaveLength(writes) }
    expect(env.submitted).toHaveLength(0)
  })

  it('focuses the original case and rejects its changed content', async () => {
    const env = await experiment({ selectedObservation: 'enabled', selectedObservationRevision: 0 }, false, 3)
    await clickNamed('新用例')
    await clickNamed('用例加入问题')
    await locateFirst()
    success()
    expect(document.activeElement).toBe(container.querySelector('.alu-cases'))
    await act(async () => env.patch({ caseDraft: '' }))
    await locateFirst()
    failure()
    expect(env.submitted).toHaveLength(0)
  })

  it('reopens a check older than eight records in read-only recovery', async () => {
    const env = await experiment({ selectedObservation: 'enabled', selectedObservationRevision: 0 }, false, 3)
    let history: ReturnType<typeof env.seedHistory> = []
    await act(async () => { history = env.seedHistory(10, 'check-all'); env.isolate() })
    const board = container.querySelector('.alu-board')!.innerHTML, files = env.files(), writes = env.changes.length
    await clickNamed('显示更多检查')
    const selectors = [...container.querySelectorAll<HTMLButtonElement>('.alu-history-columns > div:nth-child(2) button')]
      .filter(button => button.textContent === '查看')
    expect(selectors).toHaveLength(10)
    await act(async () => selectors[9]!.click())
    expect(env.artifact).toHaveBeenLastCalledWith(history[9]!.requestId)
    expect(container.querySelector('.alu-check')!.textContent).toContain(history[9]!.requestId)
    expect(container.querySelector('.alu-check')!.textContent).toContain('4096')
    expect(env.files()).toBe(files)
    expect(env.changes).toHaveLength(writes)
    expect(container.querySelector('.alu-board')!.innerHTML).toBe(board)
    expect(env.submitted).toHaveLength(0)
  })
})

describe('preparation messages preserve version-specific lifecycles', () => {
  it.each([1, 3])('retries quota failure without loading an entry or executing early, stateVersion=%s', async version => {
    preparation.prepare.mockResolvedValueOnce({ status: 'failed', reason: 'storage-unavailable', diagnostics: [
      { stage: 'cache', detail: 'QuotaExceededError' },
    ] })
    const env = await experiment({ selectedObservation: 'enabled', selectedObservationRevision: 0 }, false, version)
    expect(container.textContent).toContain('浏览器存储空间不足，未启用实验')
    expect(container.textContent).toContain('cache：QuotaExceededError')
    expect(preparation.entry).not.toHaveBeenCalled()
    await clickNamed('重试准备')
    expect(preparation.prepare).toHaveBeenCalledTimes(2)
    expect(container.textContent).not.toContain('浏览器存储空间不足，未启用实验')
    expect(preparation.entry).toHaveBeenCalledTimes(version === 1 ? 1 : 0)
    expect(env.submitted).toHaveLength(0)
  })
})
