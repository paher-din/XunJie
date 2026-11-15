import { useEffect, useRef, type ReactNode } from 'react'
import type { AgentConversation } from '@xunjie/contracts/agent-service'
import type { AgentQuestion } from '@xunjie/contracts/agent-runtime'
import { AgentMessage, UserMessage, MessageTaskCard } from '@xunjie/ui/chat'
import { Button } from '@xunjie/ui/foundation'
import { teachingStudentAskInputSchema } from '@xunjie/contracts/student-questions'
import { workspaceCard } from './agent-sessions'
import { toolDetail, toolStatus } from './workspace-conversation'
import './student-questions.css'
import type { AgentSessionController } from './useAgentSession'
import { useSessionDraft } from './session-drafts'

const toolLabels: Record<string, string> = { search_materials: '检索资料', read_pdf: '阅读 PDF', read_work: '阅读作品',
  read_personal_material: '阅读笔记', create_workspace: '创建工作区', create_personal_project: '创建项目', create_teaching_artifact: '生成学习页面' }

export function SessionConversation({ controller, readOnly = false, onOpenWorkspace, onWorkspaceCreated, renderTool }: {
  renderTool?: (tool: AgentConversation['tools'][number]) => ReactNode
  controller: AgentSessionController; readOnly?: boolean; onOpenWorkspace?: (activityId: string) => void; onWorkspaceCreated?: () => void
}) {
  const { conversation, busy, error } = controller
  const cardsSeen = useRef(new Set<string>())
  useEffect(() => {
    const created = conversation?.workspaces.filter(item => workspaceCard(item.workspace) && !cardsSeen.current.has(item.toolCallId)) ?? []
    if (created.length) { for (const item of created) cardsSeen.current.add(item.toolCallId); onWorkspaceCreated?.() }
  }, [conversation?.workspaces, onWorkspaceCreated])
  if (!conversation) return <section aria-label="与 Agent 的对话">{error ? <p role="alert">{error}<Button variant="outline" onClick={() => void controller.refresh()}>重新读取</Button></p>
    : <p role="status" aria-label="正在读取对话" />}</section>
  const inputs = new Map(conversation.inputs.map(input => [input.inputId, input]))
  const lastAssistants = new Map<string, string>()
  for (const message of conversation.messages) if (message.role === 'assistant') lastAssistants.set(message.turnId, message.messageId)
  const renderedCards = new Set<string>()
  const cards = (turnId: string) => conversation.workspaces.filter(item => item.turnId === turnId && !renderedCards.has(item.toolCallId)).map(item => {
    const card = workspaceCard(item.workspace); if (!card || renderedCards.has(item.toolCallId)) return null
    renderedCards.add(item.toolCallId)
    return <MessageTaskCard key={item.toolCallId} status="进行中" title={card.title} metadata={card.goal ? [card.goal] : []} onOpen={() => onOpenWorkspace?.(card.activityId)} />
  })
  const turn = conversation.turns.at(-1)
  const pending = conversation.questions.filter(question => question.state === 'pending')
  return <section aria-label="与 Agent 的对话" className="session-conversation">
    {conversation.messages.map(message => {
      const input = message.inputId ? inputs.get(message.inputId) : undefined
      if (input?.state === 'removed') return null
      const lastAssistant = lastAssistants.get(message.turnId) === message.messageId
      return <div key={message.messageId} data-message-id={message.messageId} data-turn-id={message.turnId} data-state={message.state}>
        {message.role === 'user' ? <>
          {input ? <SessionUserMessage input={input} at={message.createdAt} controller={controller} readOnly={readOnly} />
            : <UserMessage text={message.text} at={message.createdAt} busy={busy || readOnly} />}
          {input?.state === 'pending' && <p className="session-input-state" role="status">排队中，将在当前步骤结束后处理。</p>}
          {input?.state === 'deferred' && <p className="session-input-state" role="status">尚未处理，继续时处理。</p>}
          {input?.state === 'pending' && !readOnly && <div className="session-input-actions">
            <button type="button" disabled={busy} onClick={() => void controller.inputControl(input.inputId, input.version, 'remove').catch(() => {})}>移除待处理消息</button>
          </div>}
        </> : <AgentMessage message={{ role: 'agent', text: message.text, at: message.createdAt, phase: message.state }}>{lastAssistant ? cards(message.turnId) : null}</AgentMessage>}
      </div>
    })}
    {conversation.workspaces.filter(item => !renderedCards.has(item.toolCallId)).map(item => <div key={item.toolCallId}>{cards(item.turnId)}</div>)}
    {conversation.tools.filter(tool => tool.name !== 'student_ask').map(tool => <div key={tool.toolCallId}>{renderTool ? renderTool(tool) : <details className="session-tool">
      <summary>{toolLabels[tool.name] ?? '处理学习任务'}{toolStatus(tool)}</summary>
      {toolDetail(tool) && <p className="preserve-lines">{toolDetail(tool)}</p>}
    </details>}</div>)}
    {pending.map(question => <SessionQuestion key={question.questionId} question={question} controller={controller} readOnly={readOnly} />)}
    {turn && turn.state !== 'completed' && <div className="teaching-run-status">
      <span role="status">{turn.state === 'active' ? pending.length ? '等待回应或原操作结果。' : 'Agent 正在回答…'
        : turnStatusLabel(turn)}</span>
      {!readOnly && <div className="teaching-run-actions">
        {turn.state === 'active' ? <Button variant="outline" disabled={busy} onClick={() => void controller.control(turn.turnId, 'stop').catch(() => {})}>停止回答</Button>
          : <Button disabled={busy} onClick={() => void controller.control(turn.turnId, 'continue').catch(() => {})}>继续回答</Button>}
      </div>}
    </div>}
    {error && <p role="alert" className="learning-error">{error} <button type="button" onClick={() => void controller.replay()}>核对并重试</button></p>}
  </section>
}
function turnStatusLabel(turn: AgentConversation['turns'][number]) {
  if (turn.state === 'stopped') return '你已停止这次回答，原问题和内容已保留。'
  if (turn.state === 'interrupted') return '宿主中断了这次回答，原问题和内容已保留；可以继续回答。'
  if (turn.state === 'failed') {
    const known: Record<string, string> = {
      budget_exhausted: '本次回答已达到预算上限，原问题和内容已保留；可以继续回答。',
      'deadline-exceeded': '本次回答超过时限，原问题和内容已保留；可以继续回答。',
      'model-unavailable': '模型服务暂时不可用，原问题和内容已保留；可以稍后继续。',
      'protocol-error': '模型返回格式异常，原问题和内容已保留；可以继续回答。',
    }
    return known[turn.reason] ?? '这次回答未能完成，原问题和内容已保留；可以继续回答。'
  }
  return '回答尚未完成，原问题和内容已保留。'
}
function DraftProtectionFeedback({ error, retry }: { error: string; retry: () => Promise<void> }) {
  return error ? <p role="alert" className="learning-error">{error} <button type="button" onClick={() => void retry().catch(() => {})}>重试保留输入</button></p> : null
}
function SessionUserMessage({ input, at, controller, readOnly }: { input: AgentConversation['inputs'][number]; at: string; controller: AgentSessionController; readOnly: boolean }) {
  const draft = useSessionDraft(controller.client.scope, controller.sessionId, 'input:' + input.inputId,
    { text: input.text, editing: false, expectedVersion: input.version })
  const editable = !readOnly && input.state === 'pending'
  return <><UserMessage text={input.text} at={at} busy={controller.busy || !editable || !draft.ready}
    editDraft={draft.value} onEditDraftChange={value => {
      void draft.change({ ...value, expectedVersion: value.editing && !draft.value.editing ? input.version : draft.value.expectedVersion }).catch(() => {})
    }} onEdit={editable ? async text => {
      await draft.protect()
      await controller.inputControl(input.inputId, draft.value.expectedVersion, 'edit', { text })
    } : undefined} />
    <DraftProtectionFeedback error={draft.error} retry={draft.protect} /></>
}
function SessionQuestion({ question, controller, readOnly }: { question: AgentQuestion; controller: AgentSessionController; readOnly: boolean }) {
  const { questionId: _questionId, sourceInputId: _sourceInputId, ...presentation } = question.presentation
  const parsed = teachingStudentAskInputSchema.safeParse(presentation)
  const draft = useSessionDraft(controller.client.scope, controller.sessionId, 'question:' + question.questionId + ':' + question.version,
    { text: '', editing: true, expectedVersion: question.version })
  const text = draft.value.text
  if (!parsed.success) return <p role="status">正在等待原操作结果。</p>
  const prompt = parsed.data
  const answer = (value: Record<string, string>) => void draft.protect().then(() => controller.respond(question.questionId, question.version, value)).catch(() => {})
  return <section className="student-question" data-question-id={question.questionId} tabIndex={-1} aria-label="Agent 的问题"><h3>{prompt.question}</h3>
    <div className="student-question-options">{prompt.options.map(option => <Button key={option.id} variant="outline" disabled={readOnly || controller.busy || !draft.ready}
      onClick={() => answer({ kind: 'choice', optionId: option.id })}>{option.label}</Button>)}</div>
    {prompt.allowText && <form onSubmit={event => { event.preventDefault(); if (text.trim()) answer({ kind: 'text', text }) }}>
      <textarea aria-label="回应 Agent 的问题" value={text} disabled={readOnly || controller.busy || !draft.ready} onChange={event => { void draft.change({ ...draft.value, text: event.target.value }).catch(() => {}) }} />
      <Button type="submit" disabled={readOnly || controller.busy || !draft.ready || !text.trim()}>发送回应</Button></form>}
    <DraftProtectionFeedback error={draft.error} retry={draft.protect} />
    {prompt.skippable && <button type="button" disabled={readOnly || controller.busy || !draft.ready} onClick={() => answer({ kind: 'skip' })}>跳过</button>}
  </section>
}
