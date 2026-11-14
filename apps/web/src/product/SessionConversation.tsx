import { useEffect, useRef, type ReactNode } from 'react'
import type { AgentConversation } from '@xunjie/contracts/agent-service'
import type { AgentWait } from '@xunjie/contracts/agent-runtime'
import { AgentMessage, UserMessage, MessageTaskCard } from '@xunjie/ui/chat'
import { Button } from '@xunjie/ui/foundation'
import { teachingStudentAskInputSchema } from '@xunjie/contracts/student-questions'
import { workspaceCard } from './agent-sessions'
import './student-questions.css'
import type { AgentSessionController } from './useAgentSession'
import { useSessionDraft } from './session-drafts'

export function SessionConversation({ controller, readOnly = false, onOpenWorkspace, onWorkspaceCreated, renderTool }: {
  renderTool?: (tool: AgentConversation['tools'][number]) => ReactNode
  controller: AgentSessionController; readOnly?: boolean; onOpenWorkspace?: (activityId: string) => void; onWorkspaceCreated?: () => void
}) {
  const { conversation, busy, error } = controller
  const cardsSeen = useRef(new Set<string>())
  useEffect(() => {
    const created = conversation?.workspaces.filter(item => workspaceCard(item.workspace) && !cardsSeen.current.has(item.operationId)) ?? []
    if (created.length) { for (const item of created) cardsSeen.current.add(item.operationId); onWorkspaceCreated?.() }
  }, [conversation?.workspaces, onWorkspaceCreated])
  if (!conversation) return <section aria-label="与 Agent 的对话">{error ? <p role="alert">{error}<Button variant="outline" onClick={() => void controller.refresh()}>重新读取</Button></p>
    : <p role="status" aria-label="正在读取对话" />}</section>
  const inputs = new Map(conversation.inputs.map(input => [input.inputId, input]))
  const lastAssistants = new Map<string, string>()
  for (const message of conversation.messages) if (message.role === 'assistant') lastAssistants.set(message.runId, message.messageId)
  const renderedCards = new Set<string>()
  const cards = (runId: string) => conversation.workspaces.filter(item => item.runId === runId && !renderedCards.has(item.operationId)).map(item => {
    const card = workspaceCard(item.workspace); if (!card || renderedCards.has(item.operationId)) return null
    renderedCards.add(item.operationId)
    return <MessageTaskCard key={item.operationId} status="进行中" title={card.title} metadata={card.goal ? [card.goal] : []} onOpen={() => onOpenWorkspace?.(card.activityId)} />
  })
  return <section aria-label="与 Agent 的对话" className="session-conversation">
    {conversation.messages.map(message => {
      const input = message.inputId ? inputs.get(message.inputId) : undefined
      if (input?.state === 'removed') return null
      const lastAssistant = lastAssistants.get(message.runId) === message.messageId
      return <div key={message.messageId} data-message-id={message.messageId} data-run-id={message.runId} data-state={message.state}>
        {message.role === 'user' ? <>
          {input ? <SessionUserMessage input={input} at={message.createdAt} controller={controller} readOnly={readOnly} />
            : <UserMessage text={message.text} at={message.createdAt} busy={busy || readOnly} />}
          {input?.state === 'pending' && !readOnly && <div className="session-input-actions">
            <button type="button" disabled={busy} onClick={() => void controller.inputControl(input.inputId, input.version, 'remove').catch(() => {})}>移除待处理消息</button>
            <button type="button" disabled={busy} onClick={() => void controller.inputControl(input.inputId, input.version, 'move', { mode: input.mode === 'queue' ? 'steering' : 'queue' }).catch(() => {})}>
              {input.mode === 'queue' ? '引导当前回答' : '改为排队'}</button>
          </div>}
        </> : <AgentMessage message={{ role: 'agent', text: message.text, at: message.createdAt, phase: message.state }}>{lastAssistant ? cards(message.runId) : null}</AgentMessage>}
      </div>
    })}
    {conversation.workspaces.filter(item => !renderedCards.has(item.operationId)).map(item => <div key={item.operationId}>{cards(item.runId)}</div>)}
    {conversation.tools.filter(tool => tool.name !== 'student_ask').map(tool => <div key={tool.operationId}>{renderTool ? renderTool(tool) : <details className="session-tool">
      <summary>{({ search_materials: '检索资料', read_pdf: '阅读 PDF', read_work: '阅读作品', read_personal_material: '阅读笔记', create_workspace: '创建工作区', create_personal_project: '创建项目', create_teaching_artifact: '生成学习页面' } as Record<string, string>)[tool.name] ?? '处理学习任务'}{tool.state === 'failed' ? ' · 未完成' : tool.state === 'completed' ? '' : ' · 进行中'}</summary>
      {tool.feedback?.text && <p className="preserve-lines">{tool.feedback.text}</p>}
    </details>}</div>)}
    {conversation.waits.filter(wait => wait.kind === 'user' && wait.state === 'pending' && conversation.runs.some(run => run.runId === wait.runId && !run.stopRequested && run.state === 'waiting'))
      .map(wait => <SessionQuestion key={wait.waitId} wait={wait} controller={controller} readOnly={readOnly} />)}
    {conversation.runs.filter(run => ['received', 'running', 'waiting', 'paused'].includes(run.state) || run.needsContinue).map(run => <div key={run.runId} className="teaching-run-status">
      <span role="status">{run.needsContinue || run.state === 'paused' ? '回答尚未完成，原问题和内容已保留。' : run.state === 'waiting'
        ? conversation.waits.some(wait => wait.runId === run.runId && wait.state === 'pending') ? '等待回应或原操作结果。' : '等待模型资源，原问题已保留。' : 'Agent 正在回答…'}</span>
      {!readOnly && <div className="teaching-run-actions">
        {(run.needsContinue || run.state === 'paused') && <Button disabled={busy} onClick={() => void controller.control(run.runId, 'continue').catch(() => {})}>继续回答</Button>}
        {!run.stopRequested && <Button variant="outline" disabled={busy} onClick={() => void controller.control(run.runId, 'stop').catch(() => {})}>停止回答</Button>}
      </div>}
    </div>)}
    {error && <p role="alert" className="learning-error">{error} <button type="button" onClick={() => void controller.replay()}>核对并重试</button></p>}
  </section>
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
function SessionQuestion({ wait, controller, readOnly }: { wait: AgentWait; controller: AgentSessionController; readOnly: boolean }) {
  const { question, source, options, allowText, skippable } = wait.presentation
  const parsed = teachingStudentAskInputSchema.safeParse({ question, source, options, allowText, skippable })
  const draftKey = 'xj.agent-wait-draft.' + controller.client.scope + ':' + wait.waitId + ':' + wait.version
  const draft = useSessionDraft(controller.client.scope, controller.sessionId, 'wait:' + wait.waitId + ':' + wait.version,
    { text: '', editing: true, expectedVersion: wait.version }, draftKey)
  const text = draft.value.text
  if (!parsed.success) return <p role="status">正在等待原操作结果。</p>
  const prompt = parsed.data
  const answer = (value: Record<string, string>) => void draft.protect().then(() => controller.respond(wait.waitId, wait.version, value)).catch(() => {})
  return <section className="student-question" data-wait-id={wait.waitId} tabIndex={-1} aria-label="Agent 的问题"><h3>{prompt.question}</h3>
    <div className="student-question-options">{prompt.options.map(option => <Button key={option.id} variant="outline" disabled={readOnly || controller.busy || !draft.ready}
      onClick={() => answer({ kind: 'choice', optionId: option.id })}>{option.label}</Button>)}</div>
    {prompt.allowText && <form onSubmit={event => { event.preventDefault(); if (text.trim()) answer({ kind: 'text', text }) }}>
      <textarea aria-label="回应 Agent 的问题" value={text} disabled={readOnly || controller.busy || !draft.ready} onChange={event => { void draft.change({ ...draft.value, text: event.target.value }).catch(() => {}) }} />
      <Button type="submit" disabled={readOnly || controller.busy || !draft.ready || !text.trim()}>发送回应</Button></form>}
    <DraftProtectionFeedback error={draft.error} retry={draft.protect} />
    {prompt.skippable && <button type="button" disabled={readOnly || controller.busy || !draft.ready} onClick={() => answer({ kind: 'skip' })}>跳过</button>}
  </section>
}
