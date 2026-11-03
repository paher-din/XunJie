import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ComponentBinding } from '@xunjie/contracts/components'
import { isTerminalExecutionState, type ExecutionQuery } from '@xunjie/contracts/execution'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { useActivitySession } from './ActivitySession'
import { stateLabel } from '../tool-execution/ledger'
import { declaredSession, sessionAction } from '../tool-execution/session'
import './execution-panel.css'

interface Observation { value?: number; total?: number; applied?: number }
const number = (value: unknown) => typeof value === 'number' ? String(value) : '—'
const duration = (milliseconds: number) => milliseconds % 60_000 === 0
  ? `${milliseconds / 60_000} 分钟` : `${Math.round(milliseconds / 1000)} 秒`

/**
 * The product side of a native stateful session. It reads the execution owner's reference and
 * never pretends a stopped or unknown session is still advancing.
 */
export function NativeSessionPanel({ activity, binding, authorized }: {
  activity: LearningActivity; binding: ComponentBinding; authorized: boolean
}) {
  const { workspace, sessions } = useActivitySession()
  const state = useSyncExternalStore(sessions.subscribe, sessions.snapshot)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const stopIds = useRef(new Map<string, string>())
  const instanceId = `${activity.activityId}:${binding.key}`
  const declared = declaredSession(binding)
  const record = state.ready && authorized ? sessions.find(instanceId) : null
  useEffect(() => { if (!state.ready) void sessions.open() }, [sessions, state.ready])
  if (!declared) return null
  const observation = (record?.session?.observation ?? null) as Observation | null
  const observations = [...(record?.session?.observations ?? [])].reverse()
  const terminal = record ? isTerminalExecutionState(record.state) : false
  const canStart = authorized && !busy && (!record || terminal)
  const canInput = authorized && !busy && !!record && record.state === 'running'
    && record.statusKnowledge === 'confirmed' && !record.stopRequested
  const reason = record?.reason?.detail
  const refresh = async (requestId: string) => {
    setNote('')
    try { await sessions.refresh(requestId) }
    catch { setNote('暂时无法核实会话状态，已保留最后一次确认的观察。') }
  }
  const start = async () => {
    setBusy(true); setNote('')
    try {
      const action = await sessionAction({ workspace, binding, instanceId,
        receiver: { receiverId: 'native-execution', location: 'local', kind: 'execution' },
        parameters: {}, requestId: crypto.randomUUID() })
      await sessions.start(action)
      setNote('本机会话已启动。输入会真实推进进程内部状态。')
    } catch {
      setNote('本机会话未能启动。请核对本机准备状态后重试；作品与已有记录仍保留。')
    } finally { setBusy(false) }
  }
  const input = async (query: ExecutionQuery) => {
    const value = Number(amount)
    if (!Number.isInteger(value) || value < 0 || value > 99) {
      setNote('请输入 0 到 99 之间的整数。')
      return
    }
    setBusy(true); setNote('')
    try {
      await sessions.input(query, declared.operation.operationId, { value })
      setAmount('')
      setNote('输入已确认，观察来自正在运行的本机进程。')
    } catch {
      // A lost reply is reconciled by querying the original reference before the student acts again.
      try { await sessions.refresh(query.requestId) } catch { /* Keep the last confirmed fact. */ }
      setNote('这次输入没有确认。已先核对原会话；若已推进，请从当前观察继续，不要重复输入。')
    } finally { setBusy(false) }
  }
  const stop = async (query: ExecutionQuery) => {
    const stopId = stopIds.current.get(query.requestId) ?? crypto.randomUUID()
    stopIds.current.set(query.requestId, stopId)
    setBusy(true); setNote('')
    try {
      await sessions.stop(query.requestId, stopId)
      setNote('停止请求已受理；只有进程实际退出才会显示已停止。')
    } catch {
      setNote('停止请求没有确认。原会话记录与已确认观察仍保留，可再次核对。')
    } finally { setBusy(false) }
  }
  return <section className="execution-panel native-session" aria-label="本机会话">
    <header>
      <h2>本机会话</h2>
      <span className="execution-hint">原生进程 · 固定适配器 v{declared.adapterVersion}</span>
    </header>
    {!state.ready ? <p className="execution-hint" role="status">正在读取本机会话记录…</p>
      : state.error ? <p className="execution-warn" role="status">{state.error}</p>
      : null}
    {note && <p role="status" className="execution-note">{note}</p>}
    {!record ? <div className="native-session-empty">
      <p className="execution-hint">会话会启动一个真实的本机进程并保留内部状态。每次输入只在前一次确认后推进。</p>
      <p className="execution-hint">空闲 {duration(declared.budgets.idleMs)} 后结束；单次输入等待上限 {duration(declared.budgets.operationTimeoutMs)}；会话最长 {duration(declared.budgets.maxMs)}。</p>
      <button type="button" className="ws-btn solid" disabled={!canStart} onClick={() => void start()}>启动本机会话</button>
    </div> : <>
      <p className="execution-title">{binding.configuration.title} · {stateLabel(record)}</p>
      <p className="native-session-observation" aria-live="polite">
        当前状态 <strong>{number(observation?.value)}</strong>；累计输入 {number(observation?.total)}；已确认 {number(observation?.applied)} 次。
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
          onClick={() => void refresh(record.requestId)}>核对状态</button>
        {!terminal && <button type="button" className="ws-btn ghost" disabled={!authorized || busy || record.stopRequested}
          onClick={() => void stop(record)}>停止会话</button>}
        {terminal && <button type="button" className="ws-btn solid" disabled={!canStart} onClick={() => void start()}>开始新会话</button>}
      </div>
    </>}
  </section>
}
