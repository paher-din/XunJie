import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { teachingConversationSchema } from '@xunjie/contracts/teaching-agent'
import type { TeachingConversation, TeachingMessage, TeachingRun } from '@xunjie/contracts/teaching-agent'
import { learningRequest } from './learningTransport'
import { useActivitySession } from './ActivitySession'
import { Markdown } from '../components/chat/Markdown'

const activeStates: TeachingRun['state'][] = ['received', 'running', 'dispatching']

function runLabel(run: TeachingRun) {
  if (run.stopRequested && activeStates.includes(run.state)) return '已请求停止，等待上游收尾…'
  if (run.state === 'received' || run.state === 'running') return 'Agent 正在准备回答…'
  if (run.state === 'dispatching') return 'Agent 正在生成回答…'
  if (run.state === 'paused' && run.reason === 'model-not-selected') return '尚未选择模型，问题与草稿已保留。'
  if (run.state === 'paused' && run.reason === 'max-output-missing') return '尚未填写最大输出 token，问题与草稿已保留。'
  if (run.state === 'paused' && run.reason === 'model-unavailable') return '当前模型暂不可用，问题与草稿已保留。'
  if (run.state === 'paused' && run.reason === 'capacity-exceeded') return '这次内容超出模型窗口，完整内容已保留。'
  if (run.state === 'paused') return '回答尚未完成，原有问题与历史已保留。'
  if (run.state === 'stopped') return '回答已停止，已发生的内容仍保留。'
  if (run.state === 'failed') return `本次回答未完成${run.reason ? `：${run.reason}` : ''}。`
  return ''
}

export function ActivityConversation({ activity, spaceKey, namespace, onModels, onActiveChange }: {
  activity: LearningActivity; spaceKey: string; namespace: string; onModels?: () => void
  onActiveChange?: (active: boolean) => void
}) {
  const { workspace } = useActivitySession()
  const [conversation, setConversation] = useState<TeachingConversation | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const shown = useRef(activity.activityId)
  const request = useCallback((route: string, body?: unknown) =>
    learningRequest(activity, spaceKey, namespace, route, body), [activity, spaceKey, namespace])
  const refresh = useCallback(async () => {
    const activityId = activity.activityId
    try {
      const value = teachingConversationSchema.parse(await request(`agent/${activityId}/conversation`))
      if (mounted.current && shown.current === activityId) { setConversation(value); setError('') }
    } catch (cause) {
      if (mounted.current && shown.current === activityId && (cause as { code?: string }).code !== 'unavailable')
        setError('学习对话暂时无法读取；原问题、草稿和历史仍保留。')
    }
  }, [activity.activityId, request])
  useEffect(() => {
    shown.current = activity.activityId
    setConversation(null); setError(''); setBusy(false)
  }, [activity.activityId])
  useEffect(() => {
    mounted.current = true
    void refresh()
    const timer = setInterval(() => { void refresh() }, 1500)
    return () => { mounted.current = false; clearInterval(timer) }
  }, [refresh])
  const latest = conversation?.runs.at(-1)
  const active = !!latest && activeStates.includes(latest.state)
  useEffect(() => { onActiveChange?.(active) }, [active, onActiveChange])
  useEffect(() => () => { onActiveChange?.(false) }, [onActiveChange])
  const readOnly = workspace.isReadOnly()
  const act = async (operation: () => Promise<unknown>) => {
    if (readOnly) return
    setBusy(true)
    try { await operation(); await refresh(); setError('') }
    catch { setError('操作尚未完成，原对话与问题仍保留。请稍后重试。') }
    finally { setBusy(false) }
  }
  if (!conversation) {
    return <section aria-label="与 Agent 的对话" className="teaching-conversation">
      <h3>学习对话</h3>
      {error ? <p role="alert" className="learning-error">{error}</p> : <p className="detail">正在读取学习对话…</p>}
    </section>
  }
  const messages: TeachingMessage[] = conversation.messages
  return <section aria-label="与 Agent 的对话" className="teaching-conversation">
    <h3>学习对话</h3>
    {messages.length === 0 && <p className="detail">还没有对话。输入问题并发送后，回答会在这里持续保留。</p>}
    {messages.map(message => <article key={message.eventId} className={`teaching-message ${message.role}`} data-state={message.state ?? ''}>
      <span className="teaching-role">{message.role === 'student' ? '你' : message.role === 'assistant' ? 'Agent' : '说明'}</span>
      {message.role === 'assistant'
        ? <Markdown text={message.text} live={message.state === 'streaming'}
          truncated={message.state === 'stopped' || message.state === 'failed'} />
        : <div className="preserve-lines">{message.text}</div>}
      {message.role === 'assistant' && message.state === 'stopped' && <span className="detail">（已停止，以上是已发生的内容）</span>}
    </article>)}
    {active && <div className="teaching-run-status" role="status">
      <span>{runLabel(latest)}</span>
      {!readOnly && <button type="button" className="outline" disabled={busy || latest.stopRequested}
        onClick={() => void act(() => request(`agent/${activity.activityId}/runs/${latest.runId}/stop`, { requestId: crypto.randomUUID() }))}>停止</button>}
    </div>}
    {!active && latest && latest.state !== 'completed' && <div className="teaching-run-status">
      <span>{runLabel(latest)}</span>
      <div className="teaching-run-actions">
        {!readOnly && <button type="button" className="outline" disabled={busy}
          onClick={() => void act(() => request(`agent/${activity.activityId}/runs/${latest.runId}/continue`, { requestId: crypto.randomUUID() }))}>继续这次学习</button>}
        {onModels && latest.state === 'paused' && ['model-not-selected', 'model-unavailable', 'max-output-missing'].includes(latest.reason) &&
          <button type="button" className="outline" onClick={onModels}>打开模型设置</button>}
      </div>
    </div>}
    {error && <p role="alert" className="learning-error">{error}</p>}
  </section>
}

const FIRST_QUESTION_PREFIX = 'xj:first-question:'
export const firstQuestionKey = (activityId: string) => FIRST_QUESTION_PREFIX + activityId
export function rememberFirstQuestion(activityId: string, question: string) {
  localStorage.setItem(firstQuestionKey(activityId), JSON.stringify({ requestId: crypto.randomUUID(), question }))
}

/** A first question is already fixed in the activity creation input; this sends the same text through the durable action queue. */
export function FirstQuestionAutoSend({ activity }: { activity: LearningActivity }) {
  const { draft, actions } = useActivitySession()
  const state = useSyncExternalStore(actions.subscribe, actions.snapshot)
  const receiver = state.receivers.find(item => item.kind === 'question')
  const sent = useRef(false)
  useEffect(() => {
    if (sent.current || !receiver || !state.ready) return
    const key = firstQuestionKey(activity.activityId)
    const raw = localStorage.getItem(key)
    if (!raw) return
    let saved: { requestId: string; question: string }
    try { saved = JSON.parse(raw) as typeof saved } catch { localStorage.removeItem(key); return }
    if (!saved.requestId || !saved.question.trim()) { localStorage.removeItem(key); return }
    sent.current = true
    void (async () => {
      try {
        if (!draft.snapshot().question) draft.change(saved.question, [])
        await actions.create({ requestId: saved.requestId, receiver })
        localStorage.removeItem(key)
      } catch { sent.current = false }
    })()
  }, [actions, activity.activityId, draft, receiver, state.ready])
  return null
}
