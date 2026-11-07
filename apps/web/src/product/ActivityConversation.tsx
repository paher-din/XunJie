import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { teachingConversationSchema } from '@xunjie/contracts/teaching-agent'
import type { TeachingConversation, TeachingMessage, TeachingRun, TeachingWait, TeachingStudentQuestion } from '@xunjie/contracts/teaching-agent'
import { learningRequest, workspaceScope } from './learningTransport'
import { useActivitySession } from './ActivitySession'
import { Markdown } from '../components/chat/Markdown'
import { TeachingToolRecords, type TeachingToolLocator } from './TeachingToolRecords'
import { StudentQuestionCard } from './StudentQuestionCard'
import { AgentInputRecord, AgentRunControls } from './AgentControls'
import { actionInputSchema } from '@xunjie/contracts/action-intents'
import { actionScopeFromWorkspaceKey } from '../reliable-workspace/actions'
import { firstQuestionKey, firstQuestionToken, readFirstQuestion, rememberFirstQuestion } from './first-question'
export { firstQuestionKey } from './first-question'

const activeStates: TeachingRun['state'][] = ['received', 'running', 'dispatching', 'waiting']

export function currentStudentQuestion(value: TeachingConversation) {
  return value.questions.find(question => question.state === 'pending'
    && value.runs.some(run => run.runId === question.runId && activeStates.includes(run.state) && !run.stopRequested)) ?? null
}

function runLabel(run: TeachingRun, waits: TeachingWait[]) {
  if (run.stopRequested && activeStates.includes(run.state)) return '已请求停止，正在核对原任务…'
  if (run.state === 'received' || run.state === 'running') return 'Agent 正在准备回答…'
  if (run.state === 'dispatching') return 'Agent 正在生成回答…'
  if (run.state === 'waiting') {
    if (['learning-fee-budget', 'learning-request-exceeds-budget'].includes(run.reason))
      return '当前模型额度不足，问题与依据已保留，正在等待可用额度。'
    if (run.reason.startsWith('learning-')) return '正在排队等待模型资源，问题与依据已保留。'
    if (run.reason === 'student-response-expired') return '回应等待已到期，正在结清原调用；不会重新生成。'
    const reasons = new Set(waits.filter(wait => wait.runId === run.runId && wait.state === 'pending').map(wait => wait.reason))
    return [reasons.has('student') && 'Agent 在等你明确回应，可以继续编辑作品。',
      reasons.has('browser') && '等待浏览器连接或操作结果…', reasons.has('execution') && '等待实验结果…',
      (reasons.has('unknown') || !reasons.size) && '任务状态未知，等待核对原记录…'].filter(Boolean).join(' ')
  }
  if (run.state === 'paused' && run.reason === 'model-not-selected') return '尚未选择模型，问题与草稿已保留。'
  if (run.state === 'paused' && run.reason === 'max-output-missing') return '尚未填写最大输出 token，问题与草稿已保留。'
  if (run.state === 'paused' && run.reason === 'model-unavailable') return '当前模型暂不可用，问题与草稿已保留。'
  if (run.state === 'paused' && run.reason === 'capacity-exceeded') return '这次内容超出模型窗口，完整内容已保留。'
  if (run.state === 'paused' && run.reason === 'student-response-expired') return '等待回应已到期，原任务已暂停；原问题与输入仍保留。'
  if (run.state === 'paused' && ['model-step-budget-exhausted', 'tool-budget-exhausted'].includes(run.reason))
    return '本次任务已达到计算或操作预算，问题、回应与结果仍保留。'
  if (run.state === 'paused') return '回答尚未完成，原有问题与历史已保留。'
  if (run.state === 'stopped') return '回答已停止，已发生的内容仍保留。'
  if (run.state === 'failed') return `本次回答未完成${run.reason ? `：${run.reason}` : ''}。`
  return ''
}

export function ActivityConversation({ activity, spaceKey, namespace, onModels, onActiveChange, onLocateTool,
  onQuestionChange, focusQuestionId, onQuestionFocused }: {
  activity: LearningActivity; spaceKey: string; namespace: string; onModels?: () => void
  onActiveChange?: (active: boolean) => void
  onLocateTool?: TeachingToolLocator
  onQuestionChange?: (question: TeachingStudentQuestion | null) => void
  focusQuestionId?: string | null; onQuestionFocused?: () => void
}) {
  const { workspace } = useActivitySession()
  const [conversation, setConversation] = useState<TeachingConversation | null>(null)
  const [error, setError] = useState('')
  const mounted = useRef(true)
  const scope = workspaceScope(namespace, activity)
  const shown = useRef(scope)
  const request = useCallback((route: string, body?: unknown) =>
    learningRequest(activity, spaceKey, namespace, route, body), [activity, spaceKey, namespace])
  const agentRequest = useCallback((route: string, body?: unknown) => request(`agent/${activity.activityId}/${route}`, body), [activity.activityId, request])
  const refresh = useCallback(async () => {
    const activityId = activity.activityId
    try {
      const value = teachingConversationSchema.parse(await request(`agent/${activityId}/conversation`))
      if (mounted.current && shown.current === scope) {
        setConversation(value); setError('')
        onQuestionChange?.(currentStudentQuestion(value))
      }
    } catch (cause) {
      if (mounted.current && shown.current === scope && (cause as { code?: string }).code !== 'unavailable')
        setError('学习对话暂时无法读取；原问题、草稿和历史仍保留。')
    }
  }, [activity.activityId, request, scope, onQuestionChange])
  useEffect(() => {
    shown.current = scope
    setConversation(null); setError('')
    onQuestionChange?.(null)
  }, [scope, onQuestionChange])
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
  if (!conversation) {
    return <section aria-label="与 Agent 的对话" className="teaching-conversation">
      <h3>学习对话</h3>
      {error ? <p role="alert" className="learning-error">{error}</p> : <p className="detail">正在读取学习对话…</p>}
    </section>
  }
  const messages: TeachingMessage[] = conversation.messages
  const timeline = [
    ...messages.map(message => ({ kind: 'message' as const, at: message.createdAt, order: message.role === 'student' ? 0 : 2, message })),
    ...conversation.tools.filter(tool => tool.name !== 'student_ask').map(tool => ({ kind: 'tool' as const, at: tool.createdAt, order: 1, tool })),
    ...conversation.questions.map(question => ({ kind: 'question' as const, at: question.createdAt, order: 1, question })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.order - b.order)
  return <section aria-label="与 Agent 的对话" className="teaching-conversation">
    <div className="teaching-conversation-header">
      <h3>学习对话</h3>
      {onModels && !readOnly && <button type="button" className="outline" onClick={onModels}>切换模型</button>}
    </div>
    {messages.length === 0 && <p className="detail">还没有对话。输入问题并发送后，回答会在这里持续保留。</p>}
    {timeline.map(entry => {
      if (entry.kind === 'tool') return <TeachingToolRecords key={entry.tool.commandId} records={[entry.tool]} onLocate={onLocateTool} />
      if (entry.kind === 'question') return <StudentQuestionCard key={scope + entry.question.questionId} question={entry.question}
        activityId={activity.activityId} scope={scope} readOnly={readOnly || activity.status !== 'open'} request={agentRequest} onConfirmed={refresh}
        focusRequested={focusQuestionId === entry.question.questionId} onFocused={onQuestionFocused} />
      const message = entry.message
      if (message.kind === 'native-summary') return message.text.trim() ? <details key={message.eventId}
        className="teaching-message teaching-native-summary" data-run-id={message.runId ?? undefined}>
        <summary>{message.summaryTruncated ? '模型摘要（节选）' : '模型摘要'}</summary>
        <Markdown text={message.text} />
      </details> : null
      return <article key={message.eventId} className={`teaching-message ${message.role}`} data-state={message.state ?? ''} data-run-id={message.runId ?? undefined}>
      <span className="teaching-role">{message.kind === 'student-response' ? '你 · 回应当前问题' : message.role === 'student' ? '你' : message.role === 'assistant' ? 'Agent' : '说明'}</span>
      {message.role === 'assistant'
        ? <Markdown text={message.text} live={message.state === 'streaming'}
          truncated={message.state === 'stopped' || message.state === 'failed'} />
        : <div className="preserve-lines">{message.text}</div>}
      {message.role === 'assistant' && message.model && <span className="detail">
        来源：{message.modelSource === 'school' ? '学校模型' : message.modelSource === 'personal' ? '个人模型' : '原模型'} · {message.model.modelId} · {message.model.protocol}
      </span>}
      {message.role === 'assistant' && message.state === 'stopped' && <span className="detail">（已停止，以上是已发生的内容）</span>}
      {message.inputId && conversation.inputs.find(input => input.inputId === message.inputId) && <AgentInputRecord
        input={conversation.inputs.find(input => input.inputId === message.inputId)!} scope={scope} readOnly={readOnly || activity.status !== 'open'}
        request={agentRequest} onConfirmed={refresh} />}
    </article>})}
    {active && <div className="teaching-run-status" role="status">
      <span>{readOnly ? '这是还原校验副本，原问题与任务状态只读；请由维护者完成接管后继续。' : runLabel(latest, conversation.waits)}</span>
      <AgentRunControls key={scope + latest.runId} run={latest} inputs={conversation.inputs} scope={scope} readOnly={readOnly || activity.status !== 'open'} request={agentRequest} onConfirmed={refresh} />
    </div>}
    {!active && latest && (latest.state !== 'completed' || conversation.inputs.some(input => ['pending', 'paused'].includes(input.state))) && <div className="teaching-run-status">
      <span>{latest.state === 'completed' ? '仍有待处理输入，选择后继续。' : runLabel(latest, conversation.waits)}</span>
      <div className="teaching-run-actions">
        <AgentRunControls key={scope + latest.runId} run={latest} inputs={conversation.inputs} scope={scope} readOnly={readOnly || activity.status !== 'open'} request={agentRequest} onConfirmed={refresh} />
        {onModels && latest.state === 'paused' && ['model-not-selected', 'model-unavailable', 'max-output-missing'].includes(latest.reason) &&
          <button type="button" className="outline" onClick={onModels}>打开模型设置</button>}
      </div>
    </div>}
    {error && <p role="alert" className="learning-error">{error}</p>}
  </section>
}

/** A first question is already fixed in the activity creation input; this sends the same text through the durable action queue. */
export function FirstQuestionAutoSend({ activity }: { activity: LearningActivity }) {
  const { actions, inputInteraction } = useActivitySession()
  const state = useSyncExternalStore(actions.subscribe, actions.snapshot)
  const receiver = state.receivers.find(item => item.kind === 'question')
  const sent = useRef<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!state.ready || !inputInteraction.writable) return
    const key = firstQuestionKey(activity.activityId)
    void (async () => {
      try {
        const saved = readFirstQuestion(activity.activityId)
        if (!saved) return
        // The durable queue owns an already protected request, including its original
        // receiver and send mode. An in-memory unprotected entry is not enough.
        if (state.items.some(item => item.input.requestId === saved.requestId && item.phase !== 'unprotected')) {
          localStorage.removeItem(key); setError(''); return
        }
        if (sent.current === saved.requestId) return
        if (!saved.input && (!receiver || !inputInteraction.ready)) return
        const input = saved.input ?? actionInputSchema.parse({ requestId: saved.requestId,
          scope: actionScopeFromWorkspaceKey(actions.key), receiver,
          draft: { token: firstQuestionToken(saved.requestId), question: saved.question, references: [], bases: [] },
          works: [], evidence: [], ...(inputInteraction.delivery ? { delivery: inputInteraction.delivery } : {}) })
        // Persist the binding before any async queue write. A reload or changed
        // preference cannot alter this request, and no later work/draft is captured.
        rememberFirstQuestion(activity.activityId, { ...saved, input })
        sent.current = saved.requestId
        await actions.createFixedQuestion(input)
        localStorage.removeItem(key)
        setError('')
      } catch { setError('首问尚未完成可靠交接，原问题仍保留；请检查浏览器存储后重开活动。') }
    })()
  }, [actions, activity.activityId, receiver, state.ready, state.items, inputInteraction.ready, inputInteraction.writable, inputInteraction.delivery])
  return error ? <p role="alert" className="learning-error">{error}</p> : null
}
