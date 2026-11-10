import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { toast } from '@xunjie/ui/feedback'
import type { ComponentBinding } from '@xunjie/contracts/components'
import { ALU_REFLECTION_MEDIA_TYPE, aluCaseFromAction, aluReflectionName, isAluObservationAction, newAluCaseDraft, parseAluReflectionFile,
  type AluCaseDraft, type AluReflection } from '@xunjie/contracts/alu-learning'
import { normalizeAluWaveRange, describeAluVcdRange, type AluWaveRange } from '@xunjie/contracts/alu-waveform'
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data'
import { questionWorkBasisSchema, normalizeSemanticRange, questionReferenceRangeSchema, type QuestionReferenceRange } from '@xunjie/contracts/question-drafts'
import { componentSource, useSemanticSource } from '../../components/workspace/references/SemanticSource'
import type { LocateResult, ReferenceSnapshot } from '../../components/workspace/references/model'
import { useWorkspaceReferences } from '../../components/workspace/references'
import { useActivitySession } from '../../product/ActivitySession'
import { stateLabel, type ExecutionRecord } from '../../tool-execution/ledger'
import type { ResultRecord } from '../../tool-execution/store'
import { AluWaveform } from './AluWaveform'
import { comparisonText, editCase, priorCaseSources, readCaseDraft } from './cases'
import { controlsOf, type AluState } from './state'

type WriteState = (change: (state: AluState) => AluState, quiet?: boolean, additions?: WorkFile[]) => boolean
type CaseProps = { activity: LearningActivity; binding: ComponentBinding; state: AluState; records: ExecutionRecord[];
  canWrite: boolean; writeState: WriteState }
const rangeOf = (typeId: string, target: Record<string, unknown> = {}): Extract<QuestionReferenceRange, { kind: 'semantic' }> =>
  ({ kind: 'semantic', formatVersion: 1, typeId, version: 1, target, start: 0, end: 1 })
const describeInputs = (inputs: unknown) => Object.entries(inputs as Record<string, number>).map(([key, value]) => `${key}=${value}`).join(' ')

export function AluCaseEditor({ activity, binding, state, stateFile, records, enabled, canWrite, canCompare,
  writeState, onCompare }: CaseProps & { stateFile?: WorkFile; enabled?: ExecutionRecord; canCompare: boolean; onCompare(): void }) {
  const references = useWorkspaceReferences()
  const host = useRef<HTMLElement>(null)
  const draft = readCaseDraft(state.caseDraft)
  const select = useSemanticSource({ source: stateFile ? componentSource(activity, binding, stateFile.objectId, stateFile.contentId) : null,
    title: 'ALU 预测用例', content: state, basis: stateFile && questionWorkBasisSchema.parse(stateFile),
    locate: reference => reference.range.typeId === 'alu-case' && host.current
      ? focusSource(host.current) : { ok: false, reason: '原用例暂不可定位；引用副本仍保留。' } })
  const change = (patch: Partial<AluCaseDraft>) => writeState(previous => editCase(previous, patch))
  const prior = enabled ? priorCaseSources(records, enabled, controlsOf(state)) : []
  return <section ref={host} tabIndex={-1} className="alu-cases" aria-label="预测用例">
    <header className="alu-section-head"><h2>预测用例</h2><div className="execution-actions">
      <button type="button" className="ws-btn ghost" disabled={!canWrite} onClick={() => writeState(previous => ({ ...previous,
        feedbackPolicy: 'hold', caseRequestId: '', caseDraft: JSON.stringify(newAluCaseDraft(crypto.randomUUID(), crypto.randomUUID())) }))}>新用例</button>
      {draft && state.feedbackPolicy === 'live' && <button type="button" className="ws-btn ghost" disabled={!canWrite}
        onClick={() => change({})}>编辑预测</button>}
      {state.feedbackPolicy === 'hold' && <button type="button" className="ws-btn ghost" disabled={!canWrite}
        onClick={() => writeState(previous => ({ ...previous, feedbackPolicy: 'live', caseRequestId: '', selectedCase: '',
          selectedObservation: '', selectedObservationRevision: -1 }))}>恢复自由观察</button>}
    </div></header>
    {!draft ? <p className="alu-hint">可先记录一条进位或边界用例，再选一条能区分操作的用例；预测也可留空。</p> : <>
      <div className="alu-case-fields">
        <label>用例目的<select aria-label="用例目的" value={draft.purpose} disabled={!canWrite}
          onChange={event => change({ purpose: event.target.value as AluCaseDraft['purpose'] })}>
          <option value="unspecified">自由选择</option><option value="boundary">进位 / 边界</option>
          <option value="operation">操作区别</option><option value="custom">其他</option>
        </select></label>
        <label>预测 F<input aria-label="预测 F" placeholder="4 位二进制，可留空" value={draft.predictedF} maxLength={32}
          disabled={!canWrite} onChange={event => change({ predictedF: event.target.value })} /></label>
        <label>预测 Cout<input aria-label="预测 Cout" placeholder="0 或 1，可留空" value={draft.predictedCout} maxLength={32}
          disabled={!canWrite} onChange={event => change({ predictedCout: event.target.value })} /></label>
      </div>
      <label className="alu-case-reason">选择这组输入的理由<textarea aria-label="选择这组输入的理由" rows={2} value={draft.reason} maxLength={4000}
        disabled={!canWrite} onChange={event => change({ reason: event.target.value })} /></label>
      <label className="alu-case-help"><input type="checkbox" checked={draft.helpReported} disabled={!canWrite}
        onChange={event => change({ helpReported: event.target.checked })} />我已获得帮助或在其他地方看过相关答案</label>
      {prior.length > 0 && <p className="alu-hint">应用内已有同一作品的{prior.some(source => source.kind === 'work-check') ? '检查或观察' : '相同输入观察'}来源，本次会保留来源，不作为独立预测；无法判断应用外见过的答案。</p>}
      <div className="execution-actions">
        <button type="button" className="ws-btn solid" disabled={!canCompare} onClick={onCompare}>运行并比较</button>
        <button type="button" className="ws-btn ghost" disabled={!canWrite || !stateFile} onClick={event => {
          const anchor = event.currentTarget
          select(rangeOf('alu-case'), () => anchor.getBoundingClientRect()); references.ask()
        }}>用例加入问题</button>
        <span className="alu-hint">输入使用下方开关；可留空直接观察，草稿随输入保护。</span>
      </div>
    </>}
  </section>
}

export function AluCaseResults({ activity, binding, state, records, fallbackRecord, suppressed, canWrite, writeState, selectState }: CaseProps & {
  fallbackRecord?: ExecutionRecord; suppressed: boolean; selectState: WriteState
}) {
  const { execution, workspace } = useActivitySession(), references = useWorkspaceReferences()
  const works = useSyncExternalStore(workspace.subscribe, workspace.snapshot)
  const cases = records.filter(record => record.action.protocolVersion === 3 && aluCaseFromAction(record.action))
  const selected = records.find(record => record.requestId === state.selectedCase)
  const record = state.selectedCase ? selected : fallbackRecord
  const capture = record?.action.protocolVersion === 3 ? aluCaseFromAction(record.action) : null
  const observation = !!record && isAluObservationAction(record.action)
  const recordLabel = record ? `${record.action.execution.initiator.kind === 'agent' ? 'Agent 验证'
    : capture ? `用例 ${cases.length - cases.findIndex(item => item.requestId === record.requestId)}` : '观察'} · ${new Date(record.createdAt).toLocaleTimeString('zh-CN')}` : '原仿真波形'
  const [loaded, setLoaded] = useState<{ requestId: string; artifact: ResultRecord | null; loading: boolean; error: string }>(
    { requestId: '', artifact: null, loading: false, error: '' })
  const saving = useRef(false)
  const host = useRef<HTMLElement>(null)
  const pending = useRef<{ requestId: string; contentId: string; typeId: string; noteFile?: WorkFile; wave?: AluWaveRange;
    resolve(result: LocateResult): void } | null>(null)
  const selectionKey = JSON.stringify([activity.activityId, binding.definition.digest, state.selectedCase, state.selectedObservation,
    state.selectedCheck, state.waveSelection, state.feedbackPolicy, state.inputRevision, state.activationRevision])
  const latest = useRef({ records, files: works.files, selectionKey }); latest.current = { records, files: works.files, selectionKey }
  const locateRevision = useRef(0)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => {
    alive.current = false
    locateRevision.current++
    pending.current?.resolve({ ok: false, reason: '来源视图已关闭；引用副本仍保留。' })
  } }, [])
  const locate = async (reference: ReferenceSnapshot, target: ExecutionRecord, noteFile?: WorkFile): Promise<LocateResult> => {
    const unavailable: LocateResult = { ok: false, reason: '原结果或引用范围暂不可定位；引用副本仍保留，未重新运行。' }
    const revision = ++locateRevision.current, initialSelection = latest.current.selectionKey
    pending.current?.resolve(unavailable)
    pending.current = null
    try {
      const range = questionReferenceRangeSchema.parse({ ...reference.range, kind: reference.kind })
      if (range.kind !== 'semantic') return unavailable
      const normalized = normalizeSemanticRange(range)
      if (reference.source?.kind !== 'component' || reference.source.objectId !== (noteFile?.objectId ?? target.requestId)
        || !noteFile && (reference.source.requestId !== target.requestId || reference.source.executionRef !== target.executionRef)) return unavailable
      if (noteFile ? normalized.typeId !== 'alu-reflection' : !['alu-observation', 'alu-waveform'].includes(normalized.typeId)) return unavailable
      const retained = await execution.artifact(target.requestId)
      if (!retained || retained.requestId !== target.requestId || !alive.current || locateRevision.current !== revision
        || latest.current.selectionKey !== initialSelection) return unavailable
      const fresh = latest.current.records.find(item => item.requestId === target.requestId)
      if (!fresh || fresh.query.statusKnowledge !== 'confirmed' || !fresh.query.output
        || fresh.query.output.contentId !== target.query.output?.contentId || fresh.executionRef !== target.executionRef
        || noteFile && !latest.current.files.some(file => file.objectId === noteFile.objectId && file.contentId === noteFile.contentId)) return unavailable
      let wave: AluWaveRange | undefined
      if (normalized.typeId === 'alu-waveform') {
        const vcd = retained.resources?.find(resource => resource.name === 'trace.vcd')?.text
        if (typeof vcd !== 'string') return unavailable
        wave = normalizeAluWaveRange(vcd, { signalIds: normalized.target.signalIds as string[],
          fromTick: normalized.target.fromTick as string, toTick: normalized.target.toTick as string })
        const copy = JSON.parse(describeAluVcdRange(vcd, wave)) as { signals: { changes: unknown[] }[] }
        if (wave.signalIds.length > 64 || copy.signals.reduce((sum, signal) => sum + signal.changes.length, 0) > 4096) return unavailable
      }
      return await new Promise<LocateResult>(resolve => {
        pending.current = { requestId: target.requestId, contentId: fresh.query.output!.contentId, typeId: normalized.typeId, noteFile, wave, resolve }
        if (!selectState(previous => ({ ...previous, selectedCase: target.action.protocolVersion === 3 && aluCaseFromAction(target.action) ? target.requestId : '',
          selectedObservation: target.requestId, selectedObservationRevision: -1, feedbackPolicy: 'live',
          ...(wave ? { waveSelection: JSON.stringify({ requestId: target.requestId, range: wave }) } : {}) }), true)) {
          pending.current = null
          resolve(unavailable)
        }
      })
    } catch { return unavailable }
  }
  useEffect(() => {
    const request = pending.current
    if (!request) return
    if (suppressed || record?.requestId !== request.requestId || record.query.statusKnowledge !== 'confirmed'
      || record.query.output?.contentId !== request.contentId
      || request.noteFile && !works.files.some(file => file.objectId === request.noteFile!.objectId && file.contentId === request.noteFile!.contentId)) {
      pending.current = null
      request.resolve({ ok: false, reason: '来源选择已变化；引用副本仍保留。' })
      return
    }
    if (loaded.requestId !== request.requestId || loaded.loading) return
    const target = request.typeId === 'alu-waveform' ? host.current?.querySelector<HTMLElement>('.alu-waveform')
      : request.typeId === 'alu-reflection' ? Array.from(host.current?.querySelectorAll<HTMLElement>('[data-note-id]') ?? []).find(item => item.dataset.noteId === request.noteFile?.objectId)
      : host.current?.querySelector<HTMLElement>('table[aria-label="预测与实际比较"]')
    let waveVisible = true
    if (request.wave) {
      try {
        const text = loaded.artifact?.resources?.find(resource => resource.name === 'trace.vcd')?.text
        const selectedWave = JSON.parse(state.waveSelection)
        waveVisible = typeof text === 'string' && selectedWave.requestId === request.requestId
          && JSON.stringify(selectedWave.range) === JSON.stringify(request.wave)
          && JSON.stringify(normalizeAluWaveRange(text, request.wave)) === JSON.stringify(request.wave)
      } catch { waveVisible = false }
    }
    pending.current = null
    request.resolve(target && waveVisible && loaded.artifact && !loaded.error ? focusSource(target)
      : { ok: false, reason: '原结果暂不可显示；引用副本仍保留，未重新运行。' })
  })
  useEffect(() => {
    let active = true
    if (!record || !record.query.output || suppressed) return
    setLoaded({ requestId: record.requestId, artifact: null, loading: true, error: '' })
    void execution.artifact(record.requestId).then(artifact => {
      if (active) setLoaded({ requestId: record.requestId, artifact, loading: false,
        error: artifact ? '' : '原结果资源暂不可读；未重新编译或运行。' })
    }).catch(() => { if (active) setLoaded({ requestId: record.requestId, artifact: null, loading: false,
      error: '原结果资源暂不可读；原选择仍保留，未重新运行。' }) })
    return () => { active = false }
  }, [record?.requestId, record?.query.output, execution, suppressed])
  const artifact = loaded.requestId === record?.requestId ? loaded.artifact : null
  const output = record?.query.statusKnowledge === 'confirmed' ? record.query.output?.output as { f?: string; cout?: string; observationState?: string } | undefined : undefined
  const content = record ? { action: record.action, output: output ?? null, state: record.query.statusKnowledge === 'confirmed' ? record.query.state : 'unknown',
    resources: artifact?.resources ?? [], inputDigest: record.inputDigest, executionRef: record.executionRef } : null
  const source = !suppressed && record?.query.statusKnowledge === 'confirmed' && record.query.output && artifact ? componentSource(activity, binding, record.requestId, record.query.output.contentId,
    { requestId: record.requestId, executionRef: record.executionRef }) : null
  const select = useSemanticSource({ source, title: 'ALU 实验观察', content, locate: reference => record ? locate(reference, record) : { ok: false, reason: '原结果暂不可定位。' } })
  const add = (typeId: string, anchor: HTMLElement, target: Record<string, unknown> = {}) => {
    try { select(rangeOf(typeId, target), () => anchor.getBoundingClientRect()); references.ask() }
    catch (error) { toast.error(error instanceof Error ? error.message : '当前范围无法引用，请缩小范围。') }
  }
  let selection: AluWaveRange | null = null
  try { const saved = JSON.parse(state.waveSelection); if (saved.requestId === record?.requestId) selection = saved.range } catch { /* No selection yet. */ }
  const notes: { file: WorkFile; note: AluReflection }[] = []
  for (const file of works.files) if (file.mediaType === ALU_REFLECTION_MEDIA_TYPE) {
    try { notes.push({ file, note: parseAluReflectionFile(file) }) } catch { /* The original owner's error remains visible in workspace status. */ }
  }
  const ownedNotes = notes.filter(item => item.note.activityId === activity.activityId && item.note.bindingKey === binding.key
    && item.note.instanceId === `${activity.activityId}:${binding.key}` && item.note.definitionDigest === binding.definition.digest)
  const selectedNotes = ownedNotes.filter(item => item.note.requestId === record?.requestId)
  const reflectionTarget = records.find(item => item.requestId === state.reflectionFor) ?? (state.reflectionDraft ? undefined : record)
  const reflectionAllowed = !!reflectionTarget && isAluObservationAction(reflectionTarget.action)
  const saveReflection = async () => {
    if (!canWrite || !reflectionTarget || !reflectionAllowed || saving.current || !state.reflectionDraft.trim()) return
    saving.current = true
    const original = state.reflectionDraft, requestId = reflectionTarget.requestId
    const noteId = crypto.randomUUID()
    const note: AluReflection = { formatVersion: 1, kind: 'alu-reflection', noteId, activityId: activity.activityId,
      bindingKey: binding.key, instanceId: `${activity.activityId}:${binding.key}`, definitionDigest: binding.definition.digest,
      requestId, inputDigest: reflectionTarget.inputDigest, executionRef: reflectionTarget.executionRef,
      parentNoteId: state.reflectionParent || null, text: original }
    const file: WorkFile = { objectId: noteId, contentId: noteId, name: aluReflectionName(binding.key, noteId), kind: 'state',
      encoding: 'json', mediaType: ALU_REFLECTION_MEDIA_TYPE, value: JSON.stringify(note) }
    try {
      if (!writeState(previous => previous.reflectionDraft === original && (!previous.reflectionFor || previous.reflectionFor === requestId)
        ? { ...previous, reflectionFor: '', reflectionParent: '', reflectionDraft: '' } : previous, true, [file])) return
      await workspace.leave()
      toast.success('解释修订已在本机保护；由原作品通道同步，原预测和观察保持不变。')
    } catch { toast.error('解释修订仍待本机保护或同步确认，请保留页面核对原记录。') }
    finally { saving.current = false }
  }
  return <section ref={host} className="alu-case-results" aria-label="比较与解释" data-execution-request-id={record?.requestId} tabIndex={-1}>
    {records.filter(item => isAluObservationAction(item.action) && item.query.statusKnowledge === 'confirmed' && item.query.output
      && (!source || item.requestId !== record?.requestId)).map(item => <RetainedSource key={item.requestId}
        source={componentSource(activity, binding, item.requestId, item.query.output!.contentId, { requestId: item.requestId, executionRef: item.executionRef })}
        locate={reference => locate(reference, item)} />)}
    {ownedNotes.filter(item => suppressed || item.note.requestId !== record?.requestId).map(item => {
      const original = records.find(result => result.requestId === item.note.requestId)
      return original && <RetainedSource key={item.file.objectId} source={componentSource(activity, binding, item.file.objectId, item.file.contentId)}
        locate={reference => locate(reference, original, item.file)} />
    })}
    <header className="alu-section-head"><h2>比较与解释</h2>
      {cases.length > 0 && <label>用例记录<select aria-label="用例记录" value={suppressed ? '' : state.selectedCase}
        onChange={event => selectState(previous => ({ ...previous, selectedCase: event.target.value, caseRequestId: '',
          selectedObservation: event.target.value, selectedObservationRevision: -1, feedbackPolicy: 'live' }))}>
        <option value="">当前观察</option>{cases.map((item, index) => <option key={item.requestId} value={item.requestId}>
          {cases.length - index} · {new Date(item.createdAt).toLocaleTimeString('zh-CN')} · {stateLabel(item.query)}
        </option>)}
      </select></label>}
    </header>
    {suppressed ? <p className="alu-hint">候选编辑中，实际值、旧比较和波形暂不展示。</p> : <>
      {record && <p className="alu-hint">{recordLabel} · {describeInputs(record.action.execution.parameters)}
        {record.action.protocolVersion === 3 && ` · ${{ student: '学生发起', agent: 'Agent 验证', 'self-check': '独立自检', 'teacher-preview': '教师预览' }[record.action.execution.initiator.kind]}`}</p>}
      {observation ? <>
        {(record?.query.statusKnowledge !== 'confirmed' || record.query.state !== 'succeeded') && <p role="status" className="alu-hint">
          {record?.query.statusKnowledge !== 'confirmed' ? '原执行状态待核实，实际值保持缺项。'
            : record.query.state === 'failed' || record.query.state === 'cancelled' ? '本次执行未完成，未填造实际值。' : '正在等待原执行结果。'}
        </p>}
        <table aria-label="预测与实际比较"><thead><tr><th>信号</th><th>固定预测</th><th>实际观察</th><th>比较依据</th></tr></thead><tbody>
          <tr><th>F</th><td>{capture?.draft.predictedF || '未填写'}</td><td>{output?.f || '未取得'}</td><td>{comparisonText(capture?.draft.predictedF ?? '', output?.f, 4)}</td></tr>
          <tr><th>Cout</th><td>{capture?.draft.predictedCout || '未填写'}</td><td>{output?.cout || '未取得'}</td><td>{comparisonText(capture?.draft.predictedCout ?? '', output?.cout, 1)}</td></tr>
        </tbody></table>
        <p className="alu-case-original">选择理由：{capture?.draft.reason || '未填写'}</p>
        {capture ? <p className="alu-hint">{capture.draft.priorSources.length ? `保留 ${capture.draft.priorSources.length} 个已有观察 / 检查来源；不作为独立预测。` : '应用内未保留同一作品 / 输入的已知观察来源。'}
          {capture.draft.helpReported && ' 学生已报告获得帮助。'} 环境自检用于确认工具链，不证明学生掌握。</p>
          : <p className="alu-hint">{record?.action.execution.initiator.kind === 'agent'
            ? '这是 Agent 发起的验证，没有学生预测，也不作为学生独立理解的证据。'
            : '本次直接观察没有固定预测，缺项保留。'}</p>}
        {capture && <button type="button" className="ws-btn ghost" disabled={!canWrite} onClick={() => writeState(previous => editCase({ ...previous,
          ...capture.inputs, inputRevision: previous.inputRevision + 1, selectedObservation: '', selectedObservationRevision: -1,
          caseDraft: JSON.stringify(capture.draft) }))}>以该用例继续编辑</button>}
      </> : <p className="alu-hint">运行或比较后，在这里查看实际值与解释。</p>}
      {record && <>
        <div className="execution-actions">
          <button type="button" className="ws-btn ghost" disabled={!canWrite || !source} onClick={event => add('alu-observation', event.currentTarget)}>结果加入问题</button>
          <button type="button" className="ws-btn ghost" onClick={() => void execution.query(record.requestId)}>核对原结果</button>
        </div>
        <details><summary>本次作品与输入</summary><p className="alu-hint">执行标识：{record.requestId}</p>
          {record.action.execution.basis.works.filter(file => file.kind === 'code').map(file =>
          <details key={file.contentId}><summary>{file.name} · {file.contentId.slice(0, 8)}</summary><pre>{file.value}</pre></details>)}</details>
      </>}
      <AluWaveform vcdText={artifact?.resources?.find(resource => resource.name === 'trace.vcd')?.text ?? null}
        selection={selection} onChange={range => selectState(previous => ({ ...previous,
          waveSelection: range && record ? JSON.stringify({ requestId: record.requestId, range }) : '' }), true)}
        onReference={canWrite && source ? (range, anchor) => add('alu-waveform', anchor, range) : undefined}
        sourceLabel={record ? `${recordLabel} · ${describeInputs(record.action.execution.parameters)}` : '原仿真波形'}
        loading={loaded.requestId === record?.requestId && loaded.loading} error={loaded.requestId === record?.requestId ? loaded.error : ''}
        incomplete={!!record && (record.query.statusKnowledge !== 'confirmed' || record.query.state !== 'succeeded'
          || output?.observationState !== 'complete' && output?.observationState !== 'complete-with-unknown')} />
      {selectedNotes.map((item, index) => <Reflection key={item.note.noteId} {...{ activity, binding }} {...item}
        action={record!.action} onLocate={reference => locate(reference, record!, item.file)} index={index} canWrite={canWrite} onRevise={() => writeState(previous => ({ ...previous,
          reflectionFor: item.note.requestId, reflectionParent: item.note.noteId, reflectionDraft: item.note.text }))} />)}
    </>}
    {observation && !suppressed && <label className="alu-case-reason">解释、仍未解决的问题或用例能发现的错误
      <textarea aria-label="实验解释" rows={3} value={state.reflectionDraft} maxLength={8000} disabled={!canWrite}
        onChange={event => writeState(previous => ({ ...previous, reflectionDraft: event.target.value,
          reflectionFor: previous.reflectionFor || record!.requestId,
          reflectionParent: previous.reflectionFor ? previous.reflectionParent : selectedNotes.at(-1)?.note.noteId ?? '' }), true)} />
    </label>}
    {state.reflectionDraft && state.reflectionFor && state.reflectionFor !== record?.requestId
      && <p className="alu-hint">解释草稿仍对应另一条原观察，切换用例不会改挂到新结果。</p>}
    {state.reflectionDraft && <button type="button" className="ws-btn ghost" disabled={!canWrite || !reflectionAllowed}
      onClick={() => void saveReflection()}>保存解释修订</button>}
  </section>
}

function Reflection({ activity, binding, file, note, action, index, canWrite, onRevise, onLocate }: {
  activity: LearningActivity; binding: ComponentBinding; file: WorkFile; note: AluReflection;
  action: ExecutionRecord['action']; index: number; canWrite: boolean; onRevise(): void; onLocate(reference: ReferenceSnapshot): Promise<LocateResult>
}) {
  const references = useWorkspaceReferences()
  const select = useSemanticSource({ source: componentSource(activity, binding, file.objectId, file.contentId),
    title: `ALU 解释修订 ${index + 1}`, content: { note, action }, basis: questionWorkBasisSchema.parse(file), locate: onLocate })
  return <div className="alu-reflection" data-note-id={file.objectId} tabIndex={-1}><p className="alu-hint">解释修订 {index + 1}</p><p>{note.text}</p>
    <div className="execution-actions"><button type="button" className="ws-btn ghost" disabled={!canWrite} onClick={onRevise}>在此基础上修订</button>
      <button type="button" className="ws-btn ghost" disabled={!canWrite} onClick={event => {
        const anchor = event.currentTarget
        select(rangeOf('alu-reflection'), () => anchor.getBoundingClientRect()); references.ask()
      }}>解释加入问题</button></div>
  </div>
}

/** Register retained sources even while a different result is displayed. */
function RetainedSource({ source, locate }: Pick<Parameters<typeof useSemanticSource>[0], 'source' | 'locate'>) {
  useSemanticSource({ source, locate, title: 'ALU 原来源', content: null })
  return null
}

function focusSource(target: HTMLElement): LocateResult {
  for (let parent = target.parentElement; parent; parent = parent.parentElement)
    if (parent instanceof HTMLDetailsElement) parent.open = true
  target.tabIndex = -1
  target.scrollIntoView?.({ block: 'center' })
  target.focus({ preventScroll: true })
  return document.activeElement === target ? { ok: true } : { ok: false, reason: '原来源暂不可聚焦；引用副本仍保留。' }
}
