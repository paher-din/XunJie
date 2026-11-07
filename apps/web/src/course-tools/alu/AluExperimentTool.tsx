import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { componentStateName, type ComponentBinding } from '@xunjie/contracts/components'
import { isExecutionAction, isTerminalExecutionState } from '@xunjie/contracts/execution'
import type { ExecutionRetainedResource } from '@xunjie/contracts/execution'
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data'
import { useActivitySession } from '../../product/ActivitySession'
import { runtimePreparation } from '../../component-preparation/runtime'
import { runtimeAction } from '../../tool-execution/runtime-action'
import { componentStateMediaType, readComponentState } from '../../tool-execution/action'
import type { ExecutionRecord } from '../../tool-execution/ledger'
import { ExecutionPanel } from '../../product/ExecutionPanel'
import type { ComponentResultLocation } from '../../product/RuntimeTool'
import { AluBoard, type AluReading } from './AluBoard'
import { CheckReportTool, type AluCheckObservations, type AluCheckReport } from './CheckReport'
import { NumericEditor } from './NumericEditor'
import { aluAdmission } from './coordination'
import { parseAluBoardMapping } from './mapping'
import { readCheckArtifact } from './check-report-reader'
import { protectCompositionNavigation } from '../../components/workspace/compositionNavigation'
import { aluCaseFromAction, newAluCaseDraft } from '@xunjie/contracts/alu-learning'
import { editCase, isCurrentComparison, priorCaseSources, readCaseDraft } from './cases'
import { AluCaseEditor, AluCaseResults } from './AluCases'
import { componentSource, useSemanticSource } from '../../components/workspace/references/SemanticSource'
import { useWorkspaceReferences } from '../../components/workspace/references'
import { controlsOf, defaultAluState, encodeEnabledBasis, parseEnabledBasis, readAluState, sameControls,
  type AluControl, type AluState, type EnabledBasis } from './state'
import { preparationMessage } from './preparation-message'
import './alu.css'

const operationName = (state: Pick<AluState, 'M' | 'S'>) => state.M === 0
  ? ['NOT A', 'A AND B', 'A OR B', 'A XOR B'][state.S] ?? '未知操作'
  : state.S === 0 ? 'A + B + Cin' : '保留组合（F/Cout 应为 0）'
const codeOf = (works: WorkFile[]) => works.filter(file => file.kind === 'code')
const codeSignature = (works: WorkFile[]) => codeOf(works).map(file => `${file.name}:${file.contentId}`).sort().join('|')
const sameCodeBasis = (left: ExecutionRecord, right: ExecutionRecord) =>
  codeSignature(left.action.execution.basis.works) === codeSignature(right.action.execution.basis.works)
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
const settled = (record: ExecutionRecord) => record.query.statusKnowledge === 'confirmed' && isTerminalExecutionState(record.query.state)

function readingOf(record: ExecutionRecord | undefined, waiting: boolean): AluReading {
  if (waiting || !record) return { state: waiting ? 'waiting' : 'none' }
  if (!settled(record)) return { state: 'waiting' }
  if (record.query.state !== 'succeeded') return { state: 'incomplete' }
  const output = record.query.output?.output as { f?: string; cout?: string; observationState?: string } | undefined
  const f = output?.f ?? '', cout = output?.cout ?? ''
  if (/^[01]{4}$/.test(f) && /^[01]$/.test(cout)) return { state: 'binary', f, cout }
  if (/^[01xz]{4}$/.test(f) && /^[01xz]$/.test(cout)) return { state: 'unknown', f, cout }
  return { state: 'incomplete', f: f || undefined, cout: cout || undefined }
}

export function AluExperimentTool({ activity, binding, spaceKey, namespace, authorized, compact = false, location }: {
  activity: LearningActivity
  binding: ComponentBinding
  spaceKey: string
  namespace: string
  authorized: boolean
  compact?: boolean
  location?: ComponentResultLocation
}) {
  const { workspace, execution, actions } = useActivitySession()
  const work = useSyncExternalStore(workspace.subscribe, workspace.snapshot)
  const runs = useSyncExternalStore(execution.subscribe, execution.snapshot)
  const actionFacts = useSyncExternalStore(actions.subscribe, actions.snapshot)
  const manifest = binding.definition.manifest
  const toolHost = useRef<HTMLElement>(null)
  useEffect(() => { if (toolHost.current && manifest.stateVersion === 3) return protectCompositionNavigation(toolHost.current) }, [manifest.stateVersion])
  const instanceId = `${activity.activityId}:${binding.key}`
  const admission = useMemo(() => aluAdmission(workspace, instanceId), [workspace, instanceId])
  const mapping = useMemo(() => parseAluBoardMapping(binding.configuration.boardMapping), [binding.configuration])
  const [ready, setReady] = useState(false)
  const [preparationNote, setPreparationNote] = useState('正在准备实验环境…')
  const [preparationDetails, setPreparationDetails] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [note, setNote] = useState('')
  const [observeTick, setObserveTick] = useState(0)
  const [observationLimit, setObservationLimit] = useState(8)
  const [checkLimit, setCheckLimit] = useState(8)
  const [reportState, setReportState] = useState<{ recordId: string; loading: boolean; error: string
    report: AluCheckReport | null; observations: AluCheckObservations | null; diagnostics: string | null
    resources: ExecutionRetainedResource[]; primary: { name: string; mediaType: string; text: string } | null }>(
    { recordId: '', loading: false, error: '', report: null, observations: null, diagnostics: null, resources: [], primary: null })
  const references = useWorkspaceReferences()
  const [counterexampleLocation, setCounterexampleLocation] = useState<{ index: number; token: string }>()

  // The click-time guards are kept beside the state so a reload can finish the same pending activation.
  const stateRef = useRef<AluState | null>(null)
  const enabledRecordRef = useRef<ExecutionRecord | undefined>(undefined)
  const activeCheckRef = useRef<ExecutionRecord | undefined>(undefined)
  const activeRunRef = useRef<ExecutionRecord | undefined>(undefined)
  const activeObservationRef = useRef<ExecutionRecord | undefined>(undefined)
  const queried = useRef(new Set<string>())
  const stopIds = useRef(new Map<string, string>())
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  useEffect(() => {
    let active = true
    if (!authorized || workspace.isReadOnly()) return
    const target = { activity, binding, spaceKey, namespace }
    void runtimePreparation.prepare(target, crypto.randomUUID()).then(result => {
      if (!active) return
      const message = preparationMessage(result)
      setReady(result.status === 'ready')
      setPreparationNote(message.note)
      setPreparationDetails(message.details)
    }).catch(error => { if (active) setPreparationNote(`实验准备未完成：${errorText(error)}`) })
    return () => { active = false }
  }, [activity, binding, spaceKey, namespace, authorized, workspace, attempt])

  const current = useMemo(() => {
    try {
      return { ...readComponentState(workspace, binding, instanceId), stateError: '' }
    } catch (error) {
      return { file: undefined, contentId: null, content: manifest.initialState, stateError: errorText(error) }
    }
  }, [workspace, work.files, binding, instanceId, manifest])
  const [historyView, setHistoryView] = useState<{ key: string; selection: Partial<AluState> }>({ key: '', selection: {} })
  const alu = { ...readAluState(current.content),
    ...(workspace.isReadOnly() && historyView.key === workspace.key ? historyView.selection : {}) }
  stateRef.current = alu
  const controls = controlsOf(alu)
  const basis = parseEnabledBasis(alu.enabledBasis)
  const records = runs.records.filter(record => record.action.execution.instance.instanceId === instanceId
    && record.action.scope.activityId === activity.activityId)
  const enabledRecord = basis ? records.find(record => record.requestId === basis.requestId) : undefined
  const pendingCheck = actionFacts.items.some(item => isExecutionAction(item.input)
    && item.input.execution.instance.instanceId === instanceId && item.input.execution.operation.operationId === 'check-all'
    && !['failed', 'cancelled'].includes(item.phase) && !records.some(record => record.requestId === item.input.requestId))
  const activeCheck = records.find(record => record.action.execution.operation.operationId === 'check-all'
    && !settled(record))
  const activeRun = records.find(record => record.action.execution.operation.operationId === 'run-single'
    && !settled(record))
  const activeObservation = records.find(record => record.action.execution.operation.operationId === 'observe-enabled'
    && !settled(record))
  enabledRecordRef.current = enabledRecord
  activeCheckRef.current = activeCheck
  activeRunRef.current = activeRun
  activeObservationRef.current = activeObservation

  // A pointer names a local or historical record. If the service still has it, query once; never rerun.
  useEffect(() => {
    for (const requestId of [basis?.requestId, alu.pendingActivation, alu.selectedObservation, alu.selectedCheck,
      alu.selectedCase, alu.reflectionFor].filter(Boolean) as string[]) {
      if (records.some(record => record.requestId === requestId) || queried.current.has(requestId)) continue
      queried.current.add(requestId)
      void execution.query(requestId).catch(() => { /* The original pointer stays; the user may retry. */ })
    }
  }, [basis?.requestId, alu.pendingActivation, alu.selectedObservation, alu.selectedCheck, alu.selectedCase, alu.reflectionFor, records, execution])

  const contentForBinding = (state: AluState) => manifest.stateShape.type === 'object'
    ? Object.fromEntries(Object.keys(manifest.stateShape.properties).map(key => [key, state[key as keyof AluState]])) : state
  const writeState = (change: (state: AluState) => AluState, quiet = false, additions: WorkFile[] = []) => {
    try {
      const fresh = readComponentState(workspace, binding, instanceId)
      const previous = readAluState(fresh.content)
      const next = change(previous)
      if (next === previous && !additions.length) return true
      const file = fresh.file
      workspace.change([...workspace.snapshot().files.filter(item => item.objectId !== file?.objectId), {
        objectId: file?.objectId ?? crypto.randomUUID(), contentId: crypto.randomUUID(),
        name: componentStateName(binding.key), kind: 'state', encoding: 'json', mediaType: componentStateMediaType,
        value: JSON.stringify({ formatVersion: 1, instanceId, componentId: manifest.componentId, version: manifest.version,
          definitionDigest: binding.definition.digest, stateVersion: manifest.stateVersion,
          operationId: crypto.randomUUID(), content: contentForBinding(next) }),
      }, ...additions])
      if (!quiet) setNote('')
      return true
    } catch (error) {
      setNote(`输入或选择未能保护：${errorText(error)}`)
      return false
    }
  }
  const located = useRef<string | null>(null)
  useEffect(() => {
    if (!location || compact || !work.ready || work.conflict || located.current === location.token) return
    const original = records.find(record => record.requestId === location.requestId)
    if (!original) { void execution.query(location.requestId).catch(() => {}); return }
    located.current = location.token
    if (workspace.isReadOnly()) return
    writeState(previous => original.action.execution.operation.operationId === 'check-all'
      ? { ...previous, selectedCheck: original.requestId, feedbackPolicy: 'live',
        selectedCheckBasis: original.action.protocolVersion === 3 ? original.action.execution.basis.enabledBy?.requestId ?? '' : '' }
      : { ...previous, selectedObservation: original.requestId, selectedObservationRevision: -1, feedbackPolicy: 'live',
        selectedCase: original.action.protocolVersion === 3 && aluCaseFromAction(original.action) ? original.requestId : '',
        ...(location.range?.kind === 'semantic' && location.range.typeId === 'alu-waveform'
          ? { waveSelection: JSON.stringify({ requestId: original.requestId, range: location.range.target }) } : {}) })
  }, [location, compact, work.ready, work.conflict, records, execution, workspace])
  const resetState = () => {
    try {
      const files = workspace.snapshot().files
      const file = files.find(item => item.name === componentStateName(binding.key))
      workspace.change([...files.filter(item => item.objectId !== file?.objectId), {
        objectId: file?.objectId ?? crypto.randomUUID(), contentId: crypto.randomUUID(),
        name: componentStateName(binding.key), kind: 'state', encoding: 'json', mediaType: componentStateMediaType,
        value: JSON.stringify({ formatVersion: 1, instanceId, componentId: manifest.componentId, version: manifest.version,
          definitionDigest: binding.definition.digest, stateVersion: manifest.stateVersion,
          operationId: crypto.randomUUID(), content: contentForBinding(defaultAluState) }),
      }])
      setNote('已重建实验输入状态；作品、运行记录和检查报告均未删除。')
    } catch (error) { setNote(`未能重建实验输入状态：${errorText(error)}`) }
  }
  // Isolated history browsing changes only this view, never the restored work or a sync queue.
  const selectState = (change: (state: AluState) => AluState, quiet = false) => {
    if (!workspace.isReadOnly()) return writeState(change, quiet)
    setHistoryView(previous => {
      const base = { ...readAluState(current.content), ...(previous.key === workspace.key ? previous.selection : {}) }
      const next = change(base)
      const keys = ['selectedCase', 'selectedObservation', 'selectedObservationRevision', 'selectedCheck',
        'selectedCheckBasis', 'feedbackPolicy', 'waveSelection'] as const
      return { key: workspace.key, selection: Object.fromEntries(keys.map(key => [key, next[key]])) }
    })
    return true
  }
  const changeInput = (control: AluControl, value: number) => {
    if (!canWrite) return
    const max = control === 'A' || control === 'B' ? 15 : control === 'S' ? 3 : 1
    if (!Number.isInteger(value) || value < 0 || value > max) return
    if (stateRef.current?.[control] === value) return
    writeState(previous => ({ ...(manifest.stateVersion === 3 && previous.feedbackPolicy === 'hold' ? editCase(previous) : previous),
      [control]: value, inputRevision: previous.inputRevision + 1, caseRequestId: '',
      selectedCase: previous.feedbackPolicy === 'live' ? '' : previous.selectedCase,
      selectedObservation: '', selectedObservationRevision: -1 }))
  }
  const useInputs = (inputs: { A: number; B: number; M: number; S: number; Cin: number }) => {
    if (!canWrite) return
    writeState(previous => ({ ...(manifest.stateVersion === 3 && previous.feedbackPolicy === 'hold' ? editCase(previous) : previous),
      ...inputs, inputRevision: previous.inputRevision + 1, caseRequestId: '',
      selectedCase: '',
      selectedObservation: '', selectedObservationRevision: -1 }))
    setNote('已复制该输入；实际读数仍要等对应观察返回。')
  }

  const enabledCode = enabledRecord?.action.execution.basis.works ? codeOf(enabledRecord.action.execution.basis.works) : []
  const enabledUsable = !!basis && !!enabledRecord && enabledRecord.query.statusKnowledge === 'confirmed'
    && enabledRecord.query.state === 'succeeded' && enabledRecord.action.execution.operation.operationId === 'run-single'
    && basis.definitionDigest === binding.definition.digest
  const codeChanged = !!enabledRecord && codeSignature(codeOf(work.files)) !== codeSignature(enabledCode)
  const historySelected = !!alu.selectedObservation && alu.selectedObservationRevision === -1
  const canWrite = authorized && work.ready && work.files.some(file => file.kind === 'code') && !work.conflict
    && !workspace.isReadOnly() && !workspace.accessDenied()
  const canAct = canWrite && ready && !current.stateError && !!mapping
  const busy = !!alu.pendingActivation || !!activeRun
  const canObserve = !!basis && enabledUsable && canAct && alu.feedbackPolicy === 'live' && !alu.pendingActivation
    && !activeCheck && !pendingCheck && !activeRun && !activeObservation && !historySelected
    && alu.inputRevision !== alu.selectedObservationRevision
  const showModified = !!enabledRecord && codeChanged

  // Free input is merged before acceptance. A 150 ms quiet window keeps short switch series together;
  // the 500 ms bound prevents a continuously changing input from starving the observation.
  const dispatchRef = useRef<() => Promise<void>>(async () => {})
  dispatchRef.current = async () => {
    if (admission.busy || pendingCheck || !canAct) return
    const now = stateRef.current
    const pointer = now ? parseEnabledBasis(now.enabledBasis) : null
    const record = enabledRecordRef.current
    if (!now || !pointer || !record || now.feedbackPolicy !== 'live') return
    if (now.inputRevision === now.selectedObservationRevision) return
    if (activeCheckRef.current || activeRunRef.current || activeObservationRef.current) return
    const revision = now.inputRevision, inputs = controlsOf(now), savedBasis = now.enabledBasis
    const selection = now.selectedObservation, selectionRevision = now.selectedObservationRevision
    admission.busy = true
    try {
      const action = await runtimeAction(workspace, activity, binding, execution.receiver.identity.receiverId,
        { operationId: 'observe-enabled', parameters: inputs, basisWorks: codeOf(record.action.execution.basis.works),
          enabledBy: { requestId: record.requestId, inputDigest: record.inputDigest, executionRef: record.executionRef } })
      // A candidate older than the current input is discarded before it is accepted.
      if (stateRef.current?.inputRevision !== revision || stateRef.current?.enabledBasis !== savedBasis || stateRef.current?.feedbackPolicy !== 'live') return
      await workspace.trackInput(execution.submit(action))
      writeState(previous => previous.inputRevision === revision && previous.enabledBasis === savedBasis
        && previous.selectedObservation === selection && previous.selectedObservationRevision === selectionRevision
        ? { ...previous, selectedObservation: action.requestId, selectedObservationRevision: revision } : previous, true)
    } catch (error) {
      if (alive.current) setNote(`本次自由观察未提交：${errorText(error)}`)
    } finally {
      admission.busy = false
      if (alive.current) setObserveTick(value => value + 1)
    }
  }
  useEffect(() => {
    if (!canObserve || admission.busy) { admission.candidateSince = null; return }
    const now = Date.now()
    if (admission.candidateSince === null) admission.candidateSince = now
    const delay = Math.max(0, Math.min(150, 500 - (now - admission.candidateSince)))
    const timer = setTimeout(() => { admission.candidateSince = null; void dispatchRef.current() }, delay)
    return () => clearTimeout(timer)
  }, [canObserve, alu.inputRevision, alu.selectedObservationRevision, alu.enabledBasis, alu.feedbackPolicy,
    activeCheck?.requestId, activeRun?.requestId, activeObservation?.requestId, ready, canWrite, observeTick])

  // Finish a pending activation only after the accepted result is really succeeded and retained.
  useEffect(() => {
    if (!alu.pendingActivation) return
    const record = records.find(item => item.requestId === alu.pendingActivation)
    if (!record) return
    if (!settled(record)) return
    if (record.query.state === 'succeeded' && record.query.output && record.acceptance.execution) {
      const base = alu.pendingActivationBase, clickRevision = alu.pendingActivationRevision
      const inputStill = sameControls(record.action.execution.parameters, controlsOf(stateRef.current!))
      const activation: { outcome: 'activated' | 'conflict' | 'superseded' } = { outcome: 'superseded' }
      const saved = writeState(previous => {
        if (previous.pendingActivation !== record.requestId) return previous
        if (previous.activationRevision !== base) {
          activation.outcome = 'conflict'
          return { ...previous, pendingActivation: '', pendingActivationRevision: 0, pendingActivationBase: 0 }
        }
        const enabled: EnabledBasis = { requestId: record.requestId, executionRef: record.executionRef,
          definitionDigest: binding.definition.digest, activationRevision: previous.activationRevision + 1 }
        activation.outcome = 'activated'
        const preserveHistory = !!previous.selectedObservation && previous.selectedObservationRevision === -1
        return { ...previous, enabledBasis: encodeEnabledBasis(enabled), activationRevision: previous.activationRevision + 1, caseRequestId: '',
          pendingActivation: '', pendingActivationRevision: 0, pendingActivationBase: 0,
          selectedObservation: preserveHistory ? previous.selectedObservation : inputStill && previous.inputRevision === clickRevision ? record.requestId : '',
          selectedObservationRevision: preserveHistory ? -1 : inputStill && previous.inputRevision === clickRevision ? previous.inputRevision : -1 }
      }, true)
      if (saved && activation.outcome === 'activated') setNote('已启用这次运行的作品；拨动开关会观察这份作品，检查也只针对它。')
      else if (saved && activation.outcome === 'conflict') setNote('另一标签更新了实验作品，请核对后继续；本次结果保留在历史中，不覆盖新的启用选择。')
    } else {
      const saved = writeState(previous => previous.pendingActivation === record.requestId
        ? { ...previous, pendingActivation: '', pendingActivationRevision: 0, pendingActivationBase: 0 } : previous, true)
      if (saved) setNote(`本次未启用：${record.query.state === 'succeeded'
        ? '运行完成但完整结果未确认保留'
        : record.query.reason?.detail ?? '运行未完成'}。实验仍使用上次运行的作品。`)
    }
  }, [alu.pendingActivation, alu.pendingActivationBase, alu.pendingActivationRevision, records, binding.definition.digest])

  // A rejected candidate never acquired an execution identity. Keep accepted/unknown requests fixed,
  // while allowing a later live candidate to proceed after a real pre-acceptance rejection.
  useEffect(() => {
    for (const requestId of [alu.selectedObservation, alu.pendingActivation].filter(Boolean)) {
      if (records.some(record => record.requestId === requestId)) continue
      const fact = actionFacts.items.find(item => item.input.requestId === requestId)
      if (!fact || !['failed', 'cancelled'].includes(fact.phase) || fact.localAcceptance?.execution) continue
      writeState(previous => ({ ...previous,
        ...(previous.selectedObservation === requestId ? { selectedObservation: '', selectedObservationRevision: -1 } : {}),
        ...(previous.pendingActivation === requestId ? { pendingActivation: '', pendingActivationBase: 0, pendingActivationRevision: 0 } : {}),
      }), true)
    }
  }, [alu.selectedObservation, alu.pendingActivation, actionFacts.items, records])

  const run = async () => {
    if (!canAct || busy || admission.busy) return
    admission.busy = true
    // The run is assembled from the click-time files and the click-time inputs; later edits are independent.
    const click = stateRef.current
    if (!click) { admission.busy = false; return }
    const clickInputs = controlsOf(click), clickRevision = click.inputRevision, base = click.activationRevision
    let attemptedRequestId: string | undefined
    try {
      const action = await runtimeAction(workspace, activity, binding, execution.receiver.identity.receiverId,
        { operationId: 'run-single', parameters: clickInputs })
      attemptedRequestId = action.requestId
      const protectedPending = writeState(previous => ({ ...previous, pendingActivation: action.requestId,
        pendingActivationRevision: clickRevision, pendingActivationBase: base }))
      if (!protectedPending) return
      await workspace.trackInput(execution.submit(action))
    } catch (error) {
      if (attemptedRequestId) writeState(previous => previous.pendingActivation === attemptedRequestId
        ? { ...previous, pendingActivation: '', pendingActivationRevision: 0, pendingActivationBase: 0 } : previous, true)
      setNote(`本次未能运行：${errorText(error)}`)
    } finally { admission.busy = false; if (alive.current) setObserveTick(value => value + 1) }
  }

  const check = async () => {
    if (!canAct || !basis || !enabledRecord || !enabledUsable || activeCheck || pendingCheck || admission.busy) return
    admission.busy = true
    try {
      const action = await runtimeAction(workspace, activity, binding, execution.receiver.identity.receiverId,
        { operationId: 'check-all', parameters: {}, basisWorks: codeOf(enabledRecord.action.execution.basis.works),
          enabledBy: { requestId: enabledRecord.requestId, inputDigest: enabledRecord.inputDigest, executionRef: enabledRecord.executionRef } })
      await workspace.trackInput(execution.submit(action))
      writeState(previous => !previous.selectedCheck || previous.selectedCheckBasis.startsWith('follow:')
        ? { ...previous, selectedCheck: action.requestId, selectedCheckBasis: `follow:${basis.requestId}` } : previous, true)
      setNote(codeChanged ? '已检查上次运行的作品；当前代码有修改，若要检查新代码请先运行。' : '已提交全量检查；完成前不会显示通过。')
    } catch (error) {
      setNote(`全量检查未提交：${errorText(error)}`)
    } finally { admission.busy = false; if (alive.current) setObserveTick(value => value + 1) }
  }
  const compare = async () => {
    const click = stateRef.current, enabled = enabledRecordRef.current
    if (!click || !enabled || !canAct || !enabledUsable || admission.busy || busy || activeCheck || activeObservation) return
    admission.busy = true
    const draft = readCaseDraft(click.caseDraft) ?? newAluCaseDraft(crypto.randomUUID(), crypto.randomUUID())
    const fixed = { ...draft, revisionId: crypto.randomUUID(), priorSources: priorCaseSources(records, enabled, controlsOf(click)) }
    try {
      const action = await runtimeAction(workspace, activity, binding, execution.receiver.identity.receiverId, {
        requestId: crypto.randomUUID(), operationId: 'observe-enabled', parameters: controlsOf(click),
        basisWorks: codeOf(enabled.action.execution.basis.works),
        enabledBy: { requestId: enabled.requestId, inputDigest: enabled.inputDigest, executionRef: enabled.executionRef }, caseDraft: fixed,
      })
      await workspace.trackInput(execution.submit(action))
      // This result may select only the draft it captured. A later edit or history choice wins.
      writeState(previous => previous.caseDraft === click.caseDraft && previous.inputRevision === click.inputRevision
        && previous.enabledBasis === click.enabledBasis && previous.selectedCase === click.selectedCase
        && previous.feedbackPolicy === click.feedbackPolicy && previous.caseRequestId === click.caseRequestId
        && previous.selectedObservation === click.selectedObservation && previous.selectedObservationRevision === click.selectedObservationRevision
        ? { ...previous, caseDraft: JSON.stringify(fixed), caseRequestId: action.requestId, selectedCase: action.requestId,
          feedbackPolicy: 'hold', selectedObservation: action.requestId, selectedObservationRevision: click.inputRevision } : previous, true)
      setNote('比较依据已在本机固定；结果归入原用例，期间的新草稿继续保留。')
    } catch (error) { setNote(`比较尚未确认：${errorText(error)}。请核对原动作，不要重跑取回旧结果。`) }
    finally { admission.busy = false; if (alive.current) setObserveTick(value => value + 1) }
  }
  const stopCheck = async (record: ExecutionRecord | undefined) => {
    if (!record) return
    const stopId = stopIds.current.get(record.requestId) ?? crypto.randomUUID()
    stopIds.current.set(record.requestId, stopId)
    try { await execution.stop(record.requestId, stopId) }
    catch { setNote('停止请求没有确认。原执行记录仍保留，可再次查询，不要重复发起新检查。') }
  }
  const queryRecord = async (record: ExecutionRecord | undefined) => {
    if (!record) return
    try { await execution.query(record.requestId) }
    catch { setNote('执行状态暂时无法核实，原记录仍保留。') }
  }

  const latestCheck = enabledRecord
    ? records.find(record => record.action.execution.operation.operationId === 'check-all' && sameCodeBasis(record, enabledRecord))
    : undefined
  const selectedCheckRecord = alu.selectedCheck ? records.find(record => record.requestId === alu.selectedCheck) : undefined
  const displayCheckRecord = alu.selectedCheck ? selectedCheckRecord : latestCheck ?? activeCheck
  const checkActive = !!displayCheckRecord && !settled(displayCheckRecord)
  const checkMismatch = !!selectedCheckRecord && !!enabledRecord && !sameCodeBasis(selectedCheckRecord, enabledRecord)

  useEffect(() => {
    if (!displayCheckRecord || !settled(displayCheckRecord)) {
      if (reportState.recordId) setReportState({ recordId: '', loading: false, error: '', report: null, observations: null, diagnostics: null, resources: [], primary: null })
      return
    }
    let active = true
    setReportState(previous => ({ ...previous, recordId: displayCheckRecord.requestId, loading: true, error: '',
      report: null, observations: null, diagnostics: null, resources: [], primary: null }))
    void execution.artifact(displayCheckRecord.requestId).then(artifact => {
      if (!active) return
      if (!artifact) {
        setReportState({ recordId: displayCheckRecord.requestId, loading: false,
          error: '本机没有这次检查的结果资源；结果只在发起检查的浏览器或原服务中保留，不会重新仿真。',
          report: null, observations: null, diagnostics: null, resources: [], primary: null })
        return
      }
      setReportState({ recordId: displayCheckRecord.requestId, loading: false,
        primary: { name: artifact.name, mediaType: artifact.mediaType, text: artifact.text },
        ...readCheckArtifact(artifact) })
    }).catch(error => {
      if (!active) return
      setReportState({ recordId: displayCheckRecord.requestId, loading: false,
        error: `原检查报告暂时不可读：${errorText(error)}。原选择与元信息保留，不会重新仿真或替换成另一个报告。`,
        report: null, observations: null, diagnostics: null, resources: [], primary: null })
    })
    return () => { active = false }
  }, [displayCheckRecord?.requestId, displayCheckRecord?.query.state, displayCheckRecord?.query.output, execution])

  const counterexampleSource = displayCheckRecord?.query.statusKnowledge === 'confirmed' && displayCheckRecord.query.output
    && reportState.recordId === displayCheckRecord.requestId && reportState.primary && !reportState.error && !reportState.loading
    ? componentSource(activity, binding, displayCheckRecord.requestId, displayCheckRecord.query.output.contentId,
      { requestId: displayCheckRecord.requestId, executionRef: displayCheckRecord.executionRef }) : null
  const selectCounterexample = useSemanticSource({ source: counterexampleSource, title: 'ALU 检查反例',
    content: displayCheckRecord ? { action: displayCheckRecord.action, output: displayCheckRecord.query.output?.output,
      state: displayCheckRecord.query.statusKnowledge === 'confirmed' ? displayCheckRecord.query.state : 'unknown',
      ...reportState.primary, resources: reportState.resources } : null,
    locate: reference => {
      const index = reference.kind === 'semantic' ? reference.range.target?.index : undefined
      if (typeof index !== 'number') return { ok: false, reason: '原反例范围不可用，固定副本仍保留。' }
      setCounterexampleLocation({ index, token: crypto.randomUUID() }); return { ok: true }
    } })
  const locatedCounterexample = location?.requestId === displayCheckRecord?.requestId
    && location?.range?.kind === 'semantic' && location.range.typeId === 'alu-counterexample'
    && typeof location.range.target.index === 'number' ? { index: location.range.target.index, token: location.token } : counterexampleLocation

  const selectedObservationRecord = alu.selectedObservation ? records.find(record => record.requestId === alu.selectedObservation) : undefined
  const observationHistory = alu.selectedObservationRevision === -1 && !!selectedObservationRecord
  const observationCurrent = !!selectedObservationRecord && !observationHistory
    && alu.selectedObservationRevision === alu.inputRevision
    && sameControls(selectedObservationRecord.action.execution.parameters, controls)
    && !!enabledRecord && sameCodeBasis(selectedObservationRecord, enabledRecord)
  const shownObservation = observationHistory ? selectedObservationRecord : observationCurrent ? selectedObservationRecord : undefined
  const waitingForObservation = checkActive || !!activeCheck || !!activeObservation || !!activeRun || !!alu.pendingActivation
  // The board is driven only by a reading that still matches the current input and enabled basis.
  // A selected history record is shown in the readout, never wired back to the board.
  const boardObservation = useRef<{ key: string; requestId: string } | null>(null)
  const boardKey = JSON.stringify([alu.enabledBasis, alu.inputRevision, controls])
  if (observationCurrent && selectedObservationRecord) boardObservation.current = { key: boardKey, requestId: selectedObservationRecord.requestId }
  else if (boardObservation.current?.key !== boardKey) boardObservation.current = null
  const currentObservationRecord = observationCurrent ? selectedObservationRecord
    : observationHistory ? records.find(record => record.requestId === boardObservation.current?.requestId) : undefined
  const selectedCase = records.find(record => record.requestId === alu.selectedCase)
  const feedbackHeld = alu.feedbackPolicy === 'hold' && !isCurrentComparison(alu, selectedCase)
  const currentReading = feedbackHeld ? { state: 'none' as const } : readingOf(currentObservationRecord, waitingForObservation || (!currentObservationRecord && !!basis))
  const shownReading = feedbackHeld ? { state: 'none' as const } : observationHistory ? readingOf(selectedObservationRecord, false) : currentReading
  const readingRecord = observationHistory ? selectedObservationRecord : currentObservationRecord
  const readingState = readingRecord && settled(readingRecord) ? readingRecord.query.state : undefined
  const shownInputs = observationHistory && selectedObservationRecord ? selectedObservationRecord.action.execution.parameters as Record<string, number> : controls

  const observations = records.filter(record => record.action.execution.operation.operationId !== 'check-all')
  const checks = records.filter(record => record.action.execution.operation.operationId === 'check-all')
  const enabledInputs = enabledRecord?.action.execution.parameters
  const currentReadout = shownReading.state === 'binary' || shownReading.state === 'unknown'
    ? <p className="alu-readout-value"><b>F={shownReading.f}</b><span> </span><b>Cout={shownReading.cout}</b></p>
    : <p className="alu-readout-value alu-muted">{shownReading.state === 'waiting' ? '等待观察' : shownReading.state === 'incomplete' ? '观察不完整' : '尚未取得观察'}</p>

  return <section ref={toolHost} className={`execution-panel runtime-tool alu-tool ${compact ? 'runtime-tool-compact' : 'runtime-tool-full'}`}
    aria-label="ALU 实验" data-component-key={binding.key} tabIndex={-1}>
    <header className="alu-tool-head">
      <div>
        <h2>ALU 实验</h2>
        <p className="alu-hint">{enabledRecord
          ? (showModified ? '实验使用上次运行的作品；当前代码有修改，检查也不会验证修改。' : '实验使用上次运行的作品；代码未改动。')
          : '编辑 alu.sv，点「运行」启用当时作品，再用开关或全部输入检查验证。'}</p>
      </div>
      <div className="execution-actions">
        {!canWrite && <span className="alu-muted">{workspace.isReadOnly() ? '当前环境只读'
          : workspace.accessDenied() ? '访问资格已失效'
          : work.conflict ? '作品存在分歧，先处理作品'
          : !work.ready ? '正在读取作品…'
          : '还没有代码文件，先在「作品」中建立 alu.sv'}</span>}
        <button type="button" className="ws-btn solid" disabled={!canAct || busy}
          onClick={() => void run()}>{busy ? '等待运行…' : '运行'}</button>
        {!ready && canWrite && <button type="button" className="ws-btn ghost" onClick={() => setAttempt(value => value + 1)}>重试准备</button>}
      </div>
    </header>
    {showModified && <p role="status" className="alu-notice">修改尚未运行。运行后才把新代码用于实验；旧观察和旧检查仍只对应旧作品。</p>}
    {alu.pendingActivation && <p role="status" className="alu-notice">已接收运行，正在等待真实结果后启用；旧作品在确认前仍可用于实验。
      <button type="button" className="ws-btn ghost" onClick={() => {
        const requestId = alu.pendingActivation
        queried.current.delete(requestId)
        void execution.query(requestId).catch(() => setNote('运行状态暂时无法核实；原请求仍保留，不会自动重跑。'))
      }}>核对运行状态</button>
      <button type="button" className="ws-btn ghost" onClick={() => writeState(previous => previous.pendingActivation === alu.pendingActivation
        ? { ...previous, pendingActivation: '', pendingActivationRevision: 0, pendingActivationBase: 0 } : previous)}>清除待确认指针</button>
    </p>}
    {work.error && <p role="alert" className="alu-alert">作品暂时不可用：{work.error}</p>}
    {!mapping && <p role="alert" className="alu-alert">课程未提供兼容的固定板卡映射，实验未派发；请使用完整的课程发布。</p>}
    {feedbackHeld && <p role="status" className="alu-notice">预测编辑中，候选输入不自动观察，实际读数、历史和检查报告暂不展示。</p>}
    {current.stateError && <p role="alert" className="alu-alert">组件状态无法读取：{current.stateError}。未自动覆盖原状态。
      <button type="button" className="ws-btn ghost" disabled={!canWrite} onClick={resetState}>重建实验输入状态</button>
    </p>}
    {note && <p role="status" className="alu-notice">{note}</p>}
    {!ready && <p role="status" className="alu-hint">{workspace.isReadOnly()
      ? '这是还原校验环境，作品与历史只读，实验未启用。'
      : !authorized ? '当前身份没有这个活动的实验权限。'
      : preparationNote || '正在确认实验能力…'}</p>}
    {!ready && preparationDetails && <details><summary>准备详情</summary><pre>{preparationDetails}</pre></details>}
    {basis && !enabledRecord && <p role="status" className="alu-hint">正在读取原启用依据；若本机与服务都没有这条记录，不会自动重跑。
      <button type="button" className="ws-btn ghost" onClick={() => {
        queried.current.delete(basis.requestId)
        void execution.query(basis.requestId).catch(() => setNote('原启用依据暂时无法核实；不会自动重跑。'))
      }}>核对启用依据</button>
    </p>}
    {basis && enabledRecord && !enabledUsable && <p role="alert" className="alu-alert">原启用依据当前不可用（{enabledRecord.query.reason?.detail ?? '执行未成功或状态未核实'}）。请运行当前作品后再观察。</p>}
    {alu.selectedObservation && !selectedObservationRecord && <p role="status" className="alu-hint">所选观察记录暂不可读，原选择仍保留，未重新运行或改选其他结果。
      <button className="ws-btn ghost" onClick={() => void execution.query(alu.selectedObservation)}>核对原观察</button>
      <button className="ws-btn ghost" onClick={() => writeState(previous => ({ ...previous, selectedObservation: '', selectedObservationRevision: -1 }))}>返回当前输入</button>
    </p>}

    {compact ? <div className="alu-compact">
      <NumericEditor values={controls} disabled={!canWrite} onChange={changeInput} />
      <div className="alu-compact-readout">
        {currentReadout}
        <p className="alu-hint">{operationName(alu)} · {alu.feedbackPolicy === 'hold' ? '预测编辑中，候选不自动观察' : '输入变化会自动观察已启用作品'}</p>
      </div>
    </div> : <>
      {manifest.stateVersion === 3 && <AluCaseEditor activity={activity} binding={binding} state={alu}
        stateFile={current.file} records={records} enabled={enabledRecord} canWrite={canWrite}
        canCompare={canAct && enabledUsable && !busy && !activeCheck && !activeObservation && !admission.busy}
        writeState={writeState} onCompare={() => void compare()} />}
      {mapping && <AluBoard values={controls} reading={currentReading} mapping={mapping} disabled={!canWrite} waiting={waitingForObservation}
        onChange={changeInput} />}
      <section className="alu-readout" aria-label="当前读数">
        <div>
          <p className="alu-readout-inputs">{observationHistory ? '原输入' : '输入'} A={shownInputs.A} B={shownInputs.B} M={shownInputs.M} S={shownInputs.S} Cin={shownInputs.Cin} · {operationName(shownInputs as Pick<AluState, 'M' | 'S'>)}</p>
          {currentReadout}
          <p className="alu-hint">
            {readingState === 'failed' ? `观察未完成：${readingRecord?.query.reason?.detail ?? '真实执行失败'}`
              : readingState === 'cancelled' ? '观察已停止；没有自动重试原输入。'
              : observationHistory ? `${readingRecord?.action.execution.initiator.kind === 'agent' ? 'Agent 验证' : '历史观察'}：显示原输入和当时结果，不接成当前板卡读数。`
              : shownReading.state === 'binary' ? '已取得观察；不等同于“正确”。'
              : shownReading.state === 'unknown' ? '输出含未知值 X 或高阻 Z，不能显示成十进制零。'
              : shownReading.state === 'incomplete' ? '这次观察不完整，不能当作成功。'
              : checkActive ? '检查中，输入已保留；结束后再观察当前输入。'
              : '等待观察；当前 F/Cout 不用旧灯态冒充新输入。'}
          </p>
        </div>
        <div className="execution-actions">
          {observationHistory && <button type="button" className="ws-btn ghost" onClick={() => {
            selectState(previous => ({ ...previous, selectedObservation: '', selectedObservationRevision: -1 }))
          }}>返回当前输入</button>}
          {!observationHistory && shownObservation && <button type="button" className="ws-btn ghost" onClick={() => {
            writeState(previous => ({ ...previous, selectedObservation: '', selectedObservationRevision: -1 }))
          }}>取消固定选择</button>}
          {shownObservation && <button type="button" className="ws-btn ghost" disabled={!canWrite} onClick={() => useInputs(shownObservation.action.execution.parameters as {
            A: number; B: number; M: number; S: number; Cin: number })}>将该输入用于实验</button>}
          {!!enabledInputs && <button type="button" className="ws-btn ghost" disabled={!canWrite} onClick={() => useInputs(enabledInputs as {
            A: number; B: number; M: number; S: number; Cin: number })}>使用启用时的输入</button>}
        </div>
      </section>
      <NumericEditor values={controls} disabled={!canWrite} onChange={changeInput} />
      {manifest.stateVersion === 3 && <AluCaseResults activity={activity} binding={binding} state={alu} records={records}
        fallbackRecord={readingRecord} suppressed={feedbackHeld} canWrite={canWrite} writeState={writeState} selectState={selectState} />}
      <details className="alu-rules" open>
        <summary>公开行为、映射与采样规则</summary>
        <table><thead><tr><th>M</th><th>S</th><th>F</th><th>Cout</th></tr></thead><tbody>
          {['NOT A', 'A AND B', 'A OR B', 'A XOR B'].map((operation, index) => <tr key={operation}>
            <td>0</td><td>{index.toString(2).padStart(2, '0')}</td><td>{operation}</td><td>0</td></tr>)}
          <tr><td>1</td><td>00</td><td>A + B + Cin 的低 4 位</td><td>完整和第 5 位</td></tr>
          <tr><td>1</td><td>01 / 10 / 11</td><td>0（保留组合）</td><td>0</td></tr>
        </tbody></table>
        <p>{mapping ? <>{Object.entries(mapping.inputs).map(([signal, pins]) => `${signal}=${pins.map(pin => `SW${pin}`).join('/')}`).join('；')}；F={mapping.outputs.F.map(pin => `LED${pin}`).join('/')}，Cout=LED{mapping.outputs.Cout[0]}。</> : '课程板卡映射不可用。'}逻辑模式忽略 Cin，NOT 忽略 B；保留组合必须归零，不能当作 don't-care。X 表示未知，Z 表示高阻，均不当作零。</p>
        <p>自由观察支架在 t=0 施加输入、t=1ns 采样、t=2ns 结束。全量检查按 index=(M&lt;&lt;11)|(S&lt;&lt;9)|(A&lt;&lt;5)|(B&lt;&lt;1)|Cin 枚举 0–4095，四轮分别使用 P0/P1 前驱并在 T1/T2 采样；它是有限采样，不是所有时刻的形式化证明。</p>
        <p className="alu-hint">运行和检查都不发送或清空问题草稿；检查通过不生成掌握结论或教师接收记录。</p>
      </details>
      {activeCheck && (!displayCheckRecord || displayCheckRecord.requestId !== activeCheck.requestId) &&
        <p role="status" className="alu-notice">另有一次检查正在进行（不是你当前查看的报告）。
          <button type="button" className="ws-btn ghost" onClick={() => void stopCheck(activeCheck)}>停止该检查</button></p>}
      {latestCheck && alu.selectedCheck && latestCheck.requestId !== alu.selectedCheck &&
        <p role="status" className="alu-notice">已有更新的检查记录。
          <button type="button" className="ws-btn ghost" onClick={() => selectState(previous => ({ ...previous, selectedCheck: '', selectedCheckBasis: '' }))}>查看最新检查</button></p>}
      {checkMismatch && <p role="alert" className="alu-alert">这份报告对应另一份已启用作品，不是当前作品的检查；请核对运行记录。</p>}
      {alu.selectedCheck && !selectedCheckRecord && <p role="status">所选检查记录暂不可读，原选择仍保留，未改选其他报告。</p>}
      {!feedbackHeld && displayCheckRecord?.query.statusKnowledge === 'unknown' && <p role="status">检查结果尚未确认，原记录仍保留，不显示通过。
        <button className="ws-btn ghost" onClick={() => void queryRecord(displayCheckRecord)}>核对状态</button>
        <button className="ws-btn ghost" onClick={() => void stopCheck(displayCheckRecord)}>停止检查</button></p>}
      {!feedbackHeld && displayCheckRecord?.query.statusKnowledge !== 'unknown' && <CheckReportTool record={displayCheckRecord} active={checkActive}
        canStart={canAct && !!basis && !!enabledRecord && enabledUsable && !activeCheck && !pendingCheck}
        report={reportState.recordId === displayCheckRecord?.requestId ? reportState.report : null}
        observations={reportState.recordId === displayCheckRecord?.requestId ? reportState.observations : null}
        diagnostics={reportState.recordId === displayCheckRecord?.requestId ? reportState.diagnostics : null}
        resources={reportState.recordId === displayCheckRecord?.requestId ? reportState.resources : []}
        loading={reportState.recordId === displayCheckRecord?.requestId && reportState.loading}
        error={reportState.recordId === displayCheckRecord?.requestId ? reportState.error : ''}
        onUseInput={useInputs} onRecheck={() => void check()}
        location={locatedCounterexample}
        onReference={canWrite && counterexampleSource ? (item, anchor) => {
          try {
            selectCounterexample({ kind: 'semantic', formatVersion: 1, typeId: 'alu-counterexample', version: 1,
              target: { index: item.index }, start: 0, end: 1 }, () => anchor.getBoundingClientRect())
            references.ask()
          } catch (error) { setNote(`原反例暂时无法引用：${errorText(error)}`) }
        } : undefined}
        onStop={() => void stopCheck(displayCheckRecord ?? activeCheck)}
        onQuery={() => void queryRecord(displayCheckRecord ?? activeCheck)} />}
      {feedbackHeld && activeCheck && <button className="ws-btn ghost" onClick={() => void stopCheck(activeCheck)}>停止检查</button>}
      {feedbackHeld && (activeObservation || activeRun) && <div className="execution-actions">
        <button type="button" className="ws-btn ghost" onClick={() => void stopCheck(activeObservation ?? activeRun)}>停止原执行</button>
        <button type="button" className="ws-btn ghost" onClick={() => void queryRecord(activeObservation ?? activeRun)}>核对原执行</button>
      </div>}
      {!feedbackHeld && <details className="alu-history"><summary>观察与检查记录（选择历史不改变开关）</summary>
        <div className="alu-history-columns">
          <div><h3>观察</h3>
            {observations.length === 0 ? <p className="alu-hint">还没有自由观察或运行记录。</p>
              : <ul>{observations.slice(0, observationLimit).map(record => <li key={record.requestId}>
                <button type="button" className="ws-btn ghost" onClick={() => selectState(previous => ({ ...previous,
                  selectedObservation: record.requestId, selectedObservationRevision: -1, feedbackPolicy: 'live',
                  selectedCase: record.action.protocolVersion === 3 && aluCaseFromAction(record.action) ? record.requestId : '' }))}>查看</button>
                <span>{record.action.execution.initiator.kind === 'agent' ? 'Agent 验证'
                  : record.action.execution.operation.operationId === 'run-single' ? '显式运行' : '自由观察'}</span>
                <span className="alu-mono">{Object.entries(record.action.execution.parameters as Record<string, number>).map(([key, value]) => `${key}=${value}`).join(' ')}</span>
                <span>{new Date(record.createdAt).toLocaleTimeString('zh-CN')} · {record.query.state}</span>
              </li>)}</ul>}
            {observations.length > observationLimit && <button type="button" className="ws-btn ghost"
              onClick={() => setObservationLimit(limit => limit + 8)}>显示更多观察</button>}
          </div>
          <div><h3>检查</h3>
            {checks.length === 0 ? <p className="alu-hint">还没有全量检查记录。</p>
              : <ul>{checks.slice(0, checkLimit).map(record => <li key={record.requestId}>
                <button type="button" className="ws-btn ghost" onClick={() => selectState(previous => ({ ...previous,
                  selectedCheck: record.requestId, selectedCheckBasis: basis?.requestId ?? '' }))}>查看</button>
                <span>{new Date(record.createdAt).toLocaleTimeString('zh-CN')} · {record.query.state}</span>
                <span>{enabledRecord && sameCodeBasis(record, enabledRecord) ? '当前启用作品' : '另一份作品'}</span>
              </li>)}</ul>}
            {checks.length > checkLimit && <button type="button" className="ws-btn ghost"
              onClick={() => setCheckLimit(limit => limit + 8)}>显示更多检查</button>}
          </div>
        </div>
      </details>}
      {!feedbackHeld && <ExecutionPanel activity={activity} binding={binding} authorized={authorized} />}
    </>}
  </section>
}
