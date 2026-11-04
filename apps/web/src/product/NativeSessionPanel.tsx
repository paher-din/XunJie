import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ComponentBinding } from '@xunjie/contracts/components'
import { isTerminalExecutionState, type ExecutionQuery } from '@xunjie/contracts/execution'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { useActivitySession } from './ActivitySession'
import { stateLabel } from '../tool-execution/ledger'
import { declaredSession, sessionAction, sessionPlacement } from '../tool-execution/session'
import { executionEnvironmentSchema, observeExecutionDevice, observeExecutionPlatform, sessionExecutionDevice, type ExecutionEnvironment } from '../tool-execution/device'
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
  const state = useSyncExternalStore(sessions.subscribe, sessions.snapshot)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [environment, setEnvironment] = useState<ExecutionEnvironment>()
  const [platform, setPlatform] = useState<ExecutionPlatform | null>(null)
  const [checking, setChecking] = useState(false)
  const [checkAttempt, setCheckAttempt] = useState(0)
  const plan = activity.course?.executionPlan
  const sessionTitle = plan ? '原生会话' : '本机会话'
  useEffect(() => {
    if (!plan) return
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
  }, [plan, activity, spaceKey, namespace, checkAttempt])
  const instanceId = `${activity.activityId}:${binding.key}`
  const declared = declaredSession(binding)
  const record = state.ready && authorized ? sessions.find(instanceId) : null
  const pending = state.ready && authorized ? sessions.pending(instanceId) : null
  useEffect(() => { if (!state.ready) void sessions.open() }, [sessions, state.ready])
  if (!declared) return null
  const observation = (record?.session?.observation ?? null) as Observation | null
  const observations = [...(record?.session?.observations ?? [])].reverse()
  const terminal = record ? isTerminalExecutionState(record.state) : false
  const placementFor = (facts: ExecutionEnvironment | undefined, observedPlatform: ExecutionPlatform | null) => plan ? {
    plan, device: facts ? sessionExecutionDevice(facts, observedPlatform, declared) : observeExecutionDevice(),
    remoteAvailable: facts?.secureTransport === true && facts.remoteAvailable,
  } : undefined
  const placement = placementFor(environment, platform)
  let decision: ReturnType<typeof sessionPlacement> | undefined
  let placementIssue = ''
  try { if (placement) decision = sessionPlacement(binding, placement) }
  catch { placementIssue = '课程方案未允许当前组件的原生会话，请核对课程发布内容。' }
  const canStart = authorized && state.ready && !busy && !checking && !pending && (!record || terminal)
    && !placementIssue && (!placement || decision?.location === 'native')
  const canRetryStart = authorized && state.ready && !busy && pending === 'start'
  const canInput = authorized && !busy && !pending && !!record && record.state === 'running'
    && record.statusKnowledge === 'confirmed' && !record.stopRequested
  const reason = record?.reason?.detail
  const refresh = async (requestId: string) => {
    if (!authorized || busy) return
    setBusy(true); setNote('')
    try {
      await sessions.reconcile(requestId)
      if (pending === 'control' && sessions.pending(instanceId) !== 'control') setAmount('')
      setNote('已核对原会话与待确认操作，请按当前观察继续。')
    } catch { setNote('暂时无法核实会话状态；原操作与最后一次确认的观察已保留，请再次核对。') }
    finally { setBusy(false) }
  }
  const start = async () => {
    if (!canStart && !canRetryStart) return
    setBusy(true); setNote('')
    try {
      const recovered = await sessions.retryStart(instanceId)
      if (recovered) {
        setNote('已核对原启动请求，请按当前会话状态继续。')
        return
      }
      const currentEnvironment = plan ? executionEnvironmentSchema.parse(
        await learningRequest(activity, spaceKey, namespace, 'execution-environment')) : undefined
      const currentPlatform = plan ? await observeExecutionPlatform() : null
      if (currentEnvironment) { setEnvironment(currentEnvironment); setPlatform(currentPlatform) }
      const action = await sessionAction({ workspace, binding, instanceId,
        receiver: { receiverId: 'native-execution', location: 'local', kind: 'execution' },
        parameters: {}, requestId: crypto.randomUUID(),
        placement: placementFor(currentEnvironment, currentPlatform) })
      await sessions.start(action)
      setNote('原生会话已启动。输入会真实推进进程内部状态。')
    } catch {
      setNote(sessions.pending(instanceId) === 'start'
        ? '启动结果尚未确认，原启动请求已保留。请核对原启动请求后继续。'
        : '原生会话未能启动。请核对执行环境准备状态后重试；作品与已有记录仍保留。')
    } finally { setBusy(false) }
  }
  const input = async (query: ExecutionQuery) => {
    if (!canInput) return
    const value = Number(amount)
    if (!Number.isInteger(value) || value < 0 || value > 99) {
      setNote('请输入 0 到 99 之间的整数。')
      return
    }
    setBusy(true); setNote('')
    try {
      await sessions.input(query, declared.operation.operationId, { value })
      setAmount('')
      setNote('输入已确认，观察来自正在运行的原生进程。')
    } catch {
      try {
        const current = await sessions.refresh(query.requestId)
        if (current?.session && current.session.appliedSeq > (query.session?.appliedSeq ?? 0)) {
          setAmount('')
          setNote('已通过原会话确认输入推进，请从当前观察继续。')
        } else setNote('输入尚未确认，原输入已保留。请核对原操作后继续。')
      } catch { setNote('输入尚未确认，原输入与已确认观察已保留。请核对原操作后继续。') }
    } finally { setBusy(false) }
  }
  const stop = async (query: ExecutionQuery) => {
    if (!authorized || busy || query.stopRequested || terminal) return
    setBusy(true); setNote('')
    try {
      await sessions.stop(query.requestId)
      setNote('停止请求已受理；只有进程实际退出才会显示已停止。')
    } catch {
      setNote('停止请求没有确认。原会话记录与已确认观察仍保留，可再次核对。')
    } finally { setBusy(false) }
  }
  return <section className="execution-panel native-session" aria-label={sessionTitle}>
    <header>
      <h2>{sessionTitle}</h2>
      <span className="execution-hint">原生进程 · 固定适配器 v{declared.adapterVersion}</span>
    </header>
    {!state.ready ? <p className="execution-hint" role="status">正在读取原生会话记录…</p>
      : state.error ? <p className="execution-warn" role="status">{state.error}</p>
      : null}
    {plan && <p role="status" className={decision?.location ? 'execution-hint' : 'execution-warn'}>
      {checking ? '正在核对执行环境准备状态…' : placementIssue || decision?.detail}
    </p>}
    {plan && !decision?.location && <button type="button" className="ws-btn ghost"
      disabled={checking || busy || !authorized} onClick={() => setCheckAttempt(value => value + 1)}>重新检查环境</button>}
    {pending && <p role="status" className="execution-warn">
      {pending === 'start' ? '原启动请求尚待确认；核对时会继续使用已保留的启动身份与输入。'
        : pending === 'control' ? '原输入尚待确认；请核对原操作，确认前不能继续输入或开始新会话。'
          : '原停止请求尚待确认；请核对原操作，确认前不能继续输入或开始新会话。'}
    </p>}
    {note && <p role="status" className="execution-note">{note}</p>}
    {!record ? <div className="native-session-empty">
      <p className="execution-hint">{plan ? '会话按课程方案启动真实的原生进程并保留内部状态。' : '会话会启动一个真实的本机进程并保留内部状态。'}每次输入只在前一次确认后推进。</p>
      <p className="execution-hint">空闲 {duration(declared.budgets.idleMs)} 后结束；单次输入等待上限 {duration(declared.budgets.operationTimeoutMs)}；会话最长 {duration(declared.budgets.maxMs)}。</p>
      <button type="button" className="ws-btn solid" disabled={!canStart && !canRetryStart} onClick={() => void start()}>
        {pending === 'start' ? '核对原启动请求' : `启动${sessionTitle}`}
      </button>
    </div> : <>
      <p className="execution-title">{binding.configuration.title} · {stateLabel(record)}</p>
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
          <input type="number" min={0} max={99} step={1} value={amount} disabled={!canInput}
            onChange={event => setAmount(event.target.value)} />
        </label>
        <button type="submit" className="ws-btn solid" disabled={!canInput || amount === ''}>输入</button>
      </form>
      {observations.length > 0 && <ol className="native-session-history" aria-label="已确认观察">
        {observations.slice(0, 8).map(item => <li key={item.controlId}>
          <span>第 {item.seq} 次</span>
          <span>状态 {number((item.state as Observation | null)?.value)}</span>
        </li>)}
      </ol>}
      <div className="execution-actions">
        <button type="button" className="ws-btn ghost" disabled={!authorized || busy}
          onClick={() => void refresh(record.requestId)}>{pending ? '核对原操作' : '核对状态'}</button>
        {!terminal && <button type="button" className="ws-btn ghost" disabled={!authorized || busy || record.stopRequested || pending === 'stop'}
          onClick={() => void stop(record)}>停止会话</button>}
        {terminal && <button type="button" className="ws-btn solid" disabled={!canStart} onClick={() => void start()}>开始新会话</button>}
      </div>
    </>}
  </section>
}
