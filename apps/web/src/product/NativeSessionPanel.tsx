import { SelectField } from '@xunjie/ui/foundation'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { toast, type ToastKind } from '@xunjie/ui/feedback'
import type { ComponentBinding } from '@xunjie/contracts/components'
import { isTerminalExecutionState, type ExecutionQuery, type ExecutionCheckpoint, type SessionControlEffect } from '@xunjie/contracts/execution'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { useActivitySession } from './ActivitySession'
import { stateLabel } from '../tool-execution/ledger'
import { declaredSession, sessionAction, sessionPlacement } from '../tool-execution/session'
import { createComponentBridge } from '../component-host/bridge'
import { readComponentState } from '../tool-execution/action'
import { executionEnvironmentSchema, observeExecutionPlatform, sessionPlacementFromEnvironment, type ExecutionEnvironment } from '../tool-execution/device'
import { learningRequest } from './learningTransport'
import type { ExecutionPlatform } from '@xunjie/contracts/execution'
import './execution-panel.css'

interface Observation { value?: number; total?: number; applied?: number; pid?: number; threads?: number }
const number = (value: unknown) => typeof value === 'number' ? String(value) : '—'
const duration = (milliseconds: number) => milliseconds % 60_000 === 0
  ? `${milliseconds / 60_000} 分钟` : `${Math.round(milliseconds / 1000)} 秒`

/**
 * The product side of a native stateful session. It reads the execution owner's reference and
 * never pretends a stopped or unknown session is still advancing.
 */
export function NativeSessionPanel({ activity, binding, authorized, spaceKey, namespace }: {
  activity: LearningActivity; binding: ComponentBinding; authorized: boolean; spaceKey: string; namespace: string
}) {
  const { workspace, sessions } = useActivitySession()
  const readOnly = workspace.isReadOnly()
  const state = useSyncExternalStore(sessions.subscribe, sessions.snapshot)
  const works = useSyncExternalStore(workspace.subscribe, workspace.snapshot)
  const [amount, setAmount] = useState('')
  const noteToast = useRef<string | number | undefined>(undefined)
  const setNote = (message: string, kind: ToastKind = 'info') => {
    if (message) noteToast.current = toast[kind](message, { id: noteToast.current, duration: kind === 'error' ? 8000 : 5000 })
    else if (noteToast.current !== undefined) toast.dismiss(noteToast.current)
  }
  const [busy, setBusy] = useState(false)
  const [environment, setEnvironment] = useState<ExecutionEnvironment>()
  const [platform, setPlatform] = useState<ExecutionPlatform | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkAttempt, setCheckAttempt] = useState(0)
  const plan = activity.course?.executionPlan
  const sessionTitle = plan ? '原生会话' : '本机会话'
  useEffect(() => {
    if (!plan || readOnly) return
    let current = true
    setChecking(true)
    setEnvironment(undefined)
    void Promise.all([learningRequest(activity, spaceKey, namespace, 'execution-environment'), observeExecutionPlatform()])
      .then(([value, observedPlatform]) => {
        if (!current) return
        setEnvironment(executionEnvironmentSchema.parse(value)); setPlatform(observedPlatform)
      }).catch(() => { if (current) setEnvironment(undefined) })
      .finally(() => { if (current) setChecking(false) })
    return () => { current = false }
  }, [plan, activity, spaceKey, namespace, checkAttempt, readOnly])
  const [selectedCheckpoint, setSelectedCheckpoint] = useState('')
  const inputLoaded = useRef(false)
  const queuedInput = useRef<Promise<unknown>>(Promise.resolve())
  const access = useRef(authorized); access.current = authorized
  const stopIds = useRef(new Map<string, string>())
  const instanceId = `${activity.activityId}:${binding.key}`
  const declared = declaredSession(binding)
  const bridge = useMemo(() => createComponentBridge(workspace, activity.activityId, binding, () => access.current,
    undefined, undefined, undefined, undefined, readOnly),
    [workspace, activity.activityId, binding])
  useEffect(() => () => { void workspace.leave().finally(() => bridge.close()).catch(() => {}) }, [workspace, bridge])
  useEffect(() => {
    if (!works.ready || inputLoaded.current || !declared?.checkpointVersion) return
    const content = readComponentState(workspace, binding, instanceId).content as { pendingInput?: string }
    setAmount(content.pendingInput ?? ''); inputLoaded.current = true
  }, [works.ready, workspace, binding, instanceId, declared])
  const record = state.ready && authorized ? sessions.find(instanceId) : null
  useEffect(() => { if (!state.ready) void sessions.open() }, [sessions, state.ready])
  if (!declared) return null
  const observation = (record?.session?.observation ?? null) as Observation | null
  const observations = [...(record?.session?.observations ?? [])].reverse()
  const terminal = record ? isTerminalExecutionState(record.state) : false
  const placementFor = (facts: ExecutionEnvironment | undefined, observedPlatform: ExecutionPlatform | null) =>
    plan ? sessionPlacementFromEnvironment(binding, plan, facts, observedPlatform) : undefined
  const placement = placementFor(environment, platform)
  let decision: ReturnType<typeof sessionPlacement> | undefined
  let placementIssue = ''
  try { if (placement) decision = sessionPlacement(binding, placement) }
  catch { placementIssue = '课程方案未允许当前组件的原生会话，请核对课程发布内容。' }
  const journalPending = sessions.pending(instanceId)
  const pending = state.pending.filter(request => request.kind === 'start'
    ? request.action.execution.instance.instanceId === instanceId
    : state.queries.some(query => query.requestId === request.requestId && query.session?.instanceId === instanceId))
  const unresolved = pending.some(request => request.kind === 'control' && request.requestId === record?.requestId)
  const canPlace = !checking && !placementIssue && (!placement || decision?.location === 'native')
  const canStart = authorized && !readOnly && !busy && state.ready && !state.error && canPlace
    && !journalPending && pending.length === 0 && (!record || terminal)
  const canInput = authorized && !readOnly && !busy && !!record && record.state === 'running'
    && record.statusKnowledge === 'confirmed' && !record.stopRequested && !unresolved && !journalPending
  const reason = record?.reason?.detail
  const canControl = authorized && !readOnly && !busy && !!record && ['running', 'paused'].includes(record.state)
    && record.statusKnowledge === 'confirmed' && !record.stopRequested && !unresolved && !journalPending
  const canEditAmount = authorized && !readOnly && !busy && works.ready && !works.conflict && !!record && !terminal
    && ['running', 'paused'].includes(record.state) && record.statusKnowledge === 'confirmed'
    && !record.stopRequested && !unresolved && !journalPending
  const supported = (effect: Exclude<SessionControlEffect, 'input'>) => declared.controls?.includes(effect)
  const checkpoints = [...new Map([...state.checkpoints.filter(item => item.instanceId === instanceId),
    ...state.queries.filter(query => query.session?.instanceId === instanceId).flatMap(query => query.session?.checkpoints ?? [])]
    .map(item => [item.checkpointId, item])).values()]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.appliedSeq - right.appliedSeq)
  const checkpoint = checkpoints.find(item => item.checkpointId === selectedCheckpoint) ?? checkpoints.at(-1)
  const persistAmount = async (value: string) => {
    if (value.length > 16) { setNote('输入过长，请在当前保留内容中修正为 0 到 99 的整数。', 'error'); return }
    setAmount(value); inputLoaded.current = true
    if (!declared.checkpointVersion) return
    try {
      const operation = queuedInput.current.catch(() => {}).then(() => bridge.handle({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
        messageId: crypto.randomUUID(), method: 'workspace.change', payload: { operationId: crypto.randomUUID(),
          expectedContentId: bridge.read().contentId, contentId: crypto.randomUUID(), content: { pendingInput: value } } }))
      queuedInput.current = operation
      await workspace.trackInput(operation)
    } catch { setNote('输入尚未可靠保存，内容仍保留；请先核对作品保存状态。', 'error') }
  }
  const refresh = async (requestId: string) => {
    setNote('')
    try { await sessions.refresh(requestId) }
    catch { setNote('暂时无法核实会话状态，已保留最后一次确认的观察。', 'error') }
  }
  const start = async () => {
    if (!canStart) return
    setBusy(true); setNote('')
    try {
      await workspace.flush()
      const currentEnvironment = plan ? executionEnvironmentSchema.parse(
        await learningRequest(activity, spaceKey, namespace, 'execution-environment')) : undefined
      const currentPlatform = plan ? await observeExecutionPlatform() : null
      if (currentEnvironment) { setEnvironment(currentEnvironment); setPlatform(currentPlatform) }
      const action = await sessionAction({ workspace, binding, instanceId,
        receiver: { receiverId: 'native-execution', location: 'local', kind: 'execution' },
        parameters: {}, requestId: crypto.randomUUID(), placement: placementFor(currentEnvironment, currentPlatform) })
      const started = await sessions.start(action)
      if (started.statusKnowledge !== 'confirmed' || isTerminalExecutionState(started.state)) throw new Error('unavailable')
      setNote('本机会话已启动。输入会真实推进进程内部状态。')
    } catch {
      setNote('本机会话未能启动。请核对本机准备状态后重试；作品与已有记录仍保留。', 'error')
    } finally { setBusy(false) }
  }
  const input = async (query: ExecutionQuery) => {
    if (!canInput) return
    const value = Number(amount)
    if (!Number.isInteger(value) || value < 0 || value > 99) {
      setNote('请输入 0 到 99 之间的整数。', 'error')
      return
    }
    setBusy(true); setNote('')
    try {
      await sessions.input(query, declared.operation.operationId, { value })
      await persistAmount('')
      setNote('输入已确认，观察来自正在运行的本机进程。')
    } catch {
      // A lost reply is reconciled by querying the original reference before the student acts again.
      try { await sessions.refresh(query.requestId) } catch { /* Keep the last confirmed fact. */ }
      setNote('这次输入没有确认。已先核对原会话；若已推进，请从当前观察继续，不要重复输入。', 'error')
    } finally { setBusy(false) }
  }
  const stop = async (query: ExecutionQuery) => {
    if (!authorized || readOnly || busy || query.stopRequested || isTerminalExecutionState(query.state)) return
    const stopId = stopIds.current.get(query.requestId) ?? crypto.randomUUID()
    stopIds.current.set(query.requestId, stopId)
    setBusy(true); setNote('')
    try {
      await sessions.stop(query.requestId, stopId)
      setNote('停止请求已受理；只有进程实际退出才会显示已停止。')
    } catch {
      setNote('停止请求没有确认。原会话记录与已确认观察仍保留，可再次核对。', 'error')
    } finally { setBusy(false) }
  }
  const control = async (effect: Exclude<SessionControlEffect, 'input'>) => {
    if (!record || !canControl) return
    const value = Number(amount)
    if (effect === 'step' && (amount === '' || !Number.isInteger(value) || value < 0 || value > 99)) {
      setNote('单步需要一个 0 到 99 之间的整数输入。', 'error'); return
    }
    setBusy(true); setNote('')
    try {
      await sessions.control(record, effect, effect, effect === 'step' ? { value } : {})
      setNote(effect === 'checkpoint' ? '检查点已由执行器生成，并可靠保存。'
        : effect === 'pause' ? '原会话已暂停，内部状态不会推进。'
          : effect === 'resume' ? '原会话已恢复推进，仍是同一个进程。'
            : effect === 'reset' ? '当前会话已复位，运行身份保持不变。' : '原会话已推进一步，仍保持暂停。')
    } catch { setNote('操作尚未确认或当前状态不允许。已核对原会话，不会自动重做。', 'error') }
    finally { setBusy(false) }
  }
  const restore = async (checkpoint: ExecutionCheckpoint) => {
    if (!authorized || readOnly || busy || !canPlace) return
    setBusy(true); setNote('')
    try {
      await workspace.flush()
      const currentEnvironment = plan ? executionEnvironmentSchema.parse(
        await learningRequest(activity, spaceKey, namespace, 'execution-environment')) : undefined
      const currentPlatform = plan ? await observeExecutionPlatform() : null
      if (currentEnvironment) { setEnvironment(currentEnvironment); setPlatform(currentPlatform) }
      const action = await sessionAction({ workspace, binding, instanceId,
        receiver: { receiverId: 'native-execution', location: 'local', kind: 'execution' }, parameters: {}, requestId: crypto.randomUUID(),
        placement: placementFor(currentEnvironment, currentPlatform),
        resumeFromCheckpoint: { checkpointId: checkpoint.checkpointId, sessionRef: checkpoint.sessionRef, sha256: checkpoint.sha256 } })
      const restored = await sessions.start(action)
      if (restored.statusKnowledge !== 'confirmed' || isTerminalExecutionState(restored.state)) throw new Error('unavailable')
      setNote('已从检查点建立新的恢复会话，原会话历史保留；没有重放检查点后的操作。')
    } catch { setNote('检查点不可恢复：请核对资源、访问资格和环境兼容性。当前输入、问题及原会话历史均保留。', 'error') }
    finally { setBusy(false) }
  }
  return <section className="execution-panel native-session" aria-label={sessionTitle}
    data-execution-request-id={record?.requestId} tabIndex={-1}>
    <header>
      <h2>{sessionTitle}</h2>
      <span className="execution-hint">原生进程 · 固定适配器 v{declared.adapterVersion}</span>
    </header>
    {!state.ready ? <p className="execution-hint" role="status">正在读取本机会话记录…</p>
      : state.error ? <p className="execution-warn" role="status">{state.error}</p>
      : null}
    {plan && <p role="status" className={decision?.location ? 'execution-hint' : 'execution-warn'}>
      {checking ? '正在核对执行环境准备状态…' : placementIssue || decision?.detail}
    </p>}
    {plan && !decision?.location && <button type="button" className="ws-btn ghost"
      disabled={checking || busy || !authorized || readOnly} onClick={() => setCheckAttempt(value => value + 1)}>重新检查环境</button>}
    {pending.length > 0 && <div className="execution-warn" role="status">
      <p>还有操作尚未确认。返回时只查询原请求；继续核对会使用原身份，不会作用于其他恢复实例。</p>
      {pending.map(request => <button key={request.id} type="button" className="ws-btn ghost" disabled={!authorized || busy}
        onClick={() => { setBusy(true); void sessions.retryPending(request.id).catch(() => setNote('原操作仍待核实，已有输入和观察保留。', 'error')).finally(() => setBusy(false)) }}>继续核对这次{request.kind === 'start' ? '启动' : request.kind === 'stop' ? '停止' : '操作'}</button>)}
    </div>}
    {!record ? <div className="native-session-empty">
      <p className="execution-hint">{plan ? '会话按课程方案启动真实的原生进程并保留内部状态。' : '会话会启动一个真实的本机进程并保留内部状态。'}每次输入只在前一次确认后推进。</p>
      <p className="execution-hint">空闲 {duration(declared.budgets.idleMs)} 后结束；单次输入等待上限 {duration(declared.budgets.operationTimeoutMs)}；会话最长 {duration(declared.budgets.maxMs)}。</p>
      <button type="button" className="ws-btn solid" disabled={!canStart} onClick={() => void start()}>启动{sessionTitle}</button>
    </div> : <>
      <p className="execution-title">{binding.configuration.title} · {stateLabel(record)}</p>
      {record.session?.restoredFrom && <p className="execution-hint">这是从检查点建立的新恢复实例；原会话未被复活。</p>}
      <p className="native-session-observation" aria-live="polite">
        当前状态 <strong>{number(observation?.value)}</strong>；累计输入 {number(observation?.total)}；已确认 {number(observation?.applied)} 次。
        {typeof observation?.pid === 'number' && Number.isFinite(observation.pid)
          && typeof observation.threads === 'number' && Number.isFinite(observation.threads)
          && <>进程 PID {observation.pid}；线程数 {observation.threads}。</>}
      </p>
      {record.stopRequested && !terminal && <p className="execution-warn">停止已受理，正在等待受管进程退出；此时不会再接受新输入。</p>}
      {record.statusKnowledge === 'unknown' && <p className="execution-warn">状态待核实：这里不表示会话仍在运行，也不表示已经停止。</p>}
      {reason && <p className="execution-warn">{reason}</p>}
      <form className="native-session-input" onSubmit={event => { event.preventDefault(); void input(record) }}>
        <label>输入整数（0–99）
          <input type="number" min={0} max={99} step={1} value={amount}
            disabled={!canEditAmount}
            onChange={event => void persistAmount(event.target.value)} />
        </label>
        <button type="submit" className="ws-btn solid" disabled={!canInput || amount === ''}>输入</button>
      </form>
      {observations.length > 0 && <ol className="native-session-history" aria-label="已确认观察">
        {observations.slice(0, 8).map(item => <li key={item.controlId} data-observation-seq={item.seq} tabIndex={-1}>
          <span>第 {item.seq} 次</span>
          <span>状态 {number((item.state as Observation | null)?.value)}</span>
        </li>)}
      </ol>}
      <div className="execution-actions">
        {supported('pause') && record.state === 'running' && <button type="button" className="ws-btn ghost"
          disabled={!canControl} onClick={() => void control('pause')}>暂停</button>}
        {supported('resume') && record.state === 'paused' && <button type="button" className="ws-btn ghost"
          disabled={!canControl} onClick={() => void control('resume')}>恢复推进</button>}
        {supported('step') && record.state === 'paused' && <button type="button" className="ws-btn ghost"
          disabled={!canControl || amount === ''} onClick={() => void control('step')}>单步</button>}
        {supported('reset') && ['running', 'paused'].includes(record.state) && <button type="button" className="ws-btn ghost"
          disabled={!canControl} onClick={() => void control('reset')}>复位</button>}
        {supported('checkpoint') && record.state === 'paused' && <button type="button" className="ws-btn ghost"
          disabled={!canControl} onClick={() => void control('checkpoint')}>保存检查点</button>}
        <button type="button" className="ws-btn ghost" disabled={!authorized || busy}
          onClick={() => void refresh(record.requestId)}>核对状态</button>
        {!terminal && <button type="button" className="ws-btn ghost" disabled={!authorized || readOnly || busy || record.stopRequested}
          onClick={() => void stop(record)}>停止会话</button>}
        {terminal && <button type="button" className="ws-btn solid" disabled={!canStart} onClick={() => void start()}>开始新会话</button>}
      </div>
      {declared.checkpointVersion && <div className="native-session-recovery">
        {checkpoints.length ? <>
          <label>恢复检查点 <SelectField label="恢复检查点" value={checkpoint?.checkpointId ?? ''}
            onChange={setSelectedCheckpoint} options={checkpoints.map(item => ({ value: item.checkpointId,
              label: `第 ${item.appliedSeq} 次操作 · ${new Date(item.createdAt).toLocaleTimeString()}` }))} /></label>
          <button type="button" className="ws-btn ghost" disabled={!authorized || readOnly || busy || !canPlace || !checkpoint}
            onClick={() => checkpoint && void restore(checkpoint)}>从检查点建立恢复会话</button>
        </> : <p className="execution-hint">{state.checkpointsReady
          ? '尚无可靠检查点。原进程丢失后无法续接内部状态；已有输入和历史仍保留。'
          : '检查点记录尚未完整核实，请稍后重试查询；已有输入和历史仍保留。'}</p>}
      </div>}
      {state.queries.filter(query => query.session?.instanceId === instanceId && query.requestId !== record.requestId).length > 0 && <details>
        <summary>原会话与历史</summary>
        {state.queries.filter(query => query.session?.instanceId === instanceId && query.requestId !== record.requestId).map(query =>
          <div key={query.requestId} className="execution-actions"><span>{stateLabel(query)}</span>
            <button type="button" className="ws-btn ghost" disabled={busy || !authorized}
              onClick={() => { setNote(''); void sessions.select(query.requestId).catch(() => setNote('会话选择尚未保存，请重试。', 'error')) }}>查看这次会话</button>
            <button type="button" className="ws-btn ghost" disabled={busy || !authorized} onClick={() => void refresh(query.requestId)}>核对原会话</button>
            {!isTerminalExecutionState(query.state) && <button type="button" className="ws-btn ghost" disabled={busy || !authorized || query.stopRequested}
              onClick={() => void stop(query)}>停止原会话</button>}</div>)}
      </details>}
    </>}
  </section>
}
