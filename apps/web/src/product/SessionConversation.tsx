import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentConversation } from '@xunjie/contracts/agent-service'
import { AgentMessage, UserMessage, MessageTaskCard, AgentTrace, AgentThinking, AgentSkillRead } from '@xunjie/ui/chat'
import { Button } from '@xunjie/ui/foundation'
import { workspaceCard } from './agent-sessions'
import type { AgentSessionController } from './useAgentSession'
import { toolDetail, toolResultData, toolFailed } from './workspace-conversation'
import { TeachingToolRecords } from './TeachingToolRecords'
import { useSessionDraft } from './session-drafts'
import { useAgentImagePreviews } from '../reliable-workspace/agent-images'
import { orderedAgentTrace } from './trace-order'
import { AgentQuestionRecord } from './SessionQuestion'
import { MessageCitations, type CitationRecord } from '@xunjie/ui/chat'

export function SessionConversation({ controller, readOnly = false, onOpenWorkspace, onWorkspaceCreated, renderTool, onOpenCitation, pendingMessages }: {
  renderTool?: (tool: AgentConversation['tools'][number]) => ReactNode
  controller: AgentSessionController; readOnly?: boolean; onOpenWorkspace?: (activityId: string) => void; onWorkspaceCreated?: () => void
  onOpenCitation?: (citation: CitationRecord) => void | Promise<void>
  pendingMessages?: ReactNode
}) {
  const { conversation, busy, error } = controller
  const cardsSeen = useRef(new Set<string>())
  const initial = useRef<{ sessionId: string; messages: Set<string> } | null>(null)
  if (conversation && initial.current?.sessionId !== conversation.sessionId) initial.current = { sessionId: conversation.sessionId, messages: new Set(conversation.messages.map(message => message.messageId)) }
  useEffect(() => {
    const created = conversation?.workspaces.filter(item => workspaceCard(item.workspace) && !cardsSeen.current.has(item.toolCallId)) ?? []
    if (created.length) { for (const item of created) cardsSeen.current.add(item.toolCallId); onWorkspaceCreated?.() }
  }, [conversation?.workspaces, onWorkspaceCreated])
  if (!conversation) return <section aria-label="与 Agent 的对话" className="session-conversation">{pendingMessages}
    {error ? <p role="alert">{error}<Button variant="outline" onClick={() => void controller.refresh()}>重新读取</Button></p>
      : !pendingMessages && <p role="status" aria-label="正在读取对话" />}</section>
  const inputs = new Map(conversation.inputs.map(input => [input.inputId, input]))
  const messages = conversation.messages.filter(message => !message.inputId || inputs.get(message.inputId)?.state !== 'removed')
  const lastAssistants = new Map<string, string>()
  for (const message of messages) if (message.role === 'assistant') lastAssistants.set(message.turnId, message.messageId)
  const renderedCards = new Set<string>()
  // Citations belong to the exact assistant response that produced them. Fall back to the
  // message's Step only for older projections that predate attempt identity.
  const citationsFor = (message: AgentConversation['messages'][number]) => {
    if (message.role !== 'assistant') return []
    const attemptId = message.attemptId
      ?? (message.messageId.startsWith('assistant:') ? message.messageId.slice('assistant:'.length) : undefined)
    return (conversation.citations ?? []).filter(item => item.turnId === message.turnId
      && (item.attemptId ? item.attemptId === attemptId : item.stepId === message.stepId)
      && (!item.inputId || !message.inputId || item.inputId === message.inputId)).map(item => {
      const source = item.citation.source
      if (source.kind !== 'tool-call' || !['read_course_task', 'list_design_materials', 'read_design_material'].includes(String(source.toolName))) return item
      const tool = conversation.tools.find(entry => entry.toolCallId === source.toolCallId)
      const result = tool && toolResultData(tool)
      const title = result?.title ?? result?.taskTitle
      return { ...item, citation: { ...item.citation, label: typeof title === 'string' ? title : '公开材料列表' } }
    })
  }
  const cards = (runId: string) => conversation.workspaces.filter(item => item.turnId === runId && !renderedCards.has(item.toolCallId)).map(item => {
    const card = workspaceCard(item.workspace); if (!card || renderedCards.has(item.toolCallId)) return null
    renderedCards.add(item.toolCallId)
    return <MessageTaskCard key={item.toolCallId} status="进行中" title={card.title} metadata={card.goal ? [card.goal] : []} onOpen={() => onOpenWorkspace?.(card.activityId)} />
  })
  return <section aria-label="与 Agent 的对话" className="session-conversation">
    {messages.map(message => {
      const input = message.inputId ? inputs.get(message.inputId) : undefined
      if (input?.state === 'removed') return null
      const lastAssistant = lastAssistants.get(message.turnId) === message.messageId
      const messageCitations = citationsFor(message)
      return <div key={message.messageId} className={initial.current?.messages.has(message.messageId) ? 'message-history' : undefined} data-message-id={message.messageId} data-turn-id={message.turnId} data-state={message.state}>
        {message.role === 'user' ? <>
          {input ? <SessionUserMessage input={input} at={message.editedAt ?? message.createdAt} controller={controller} readOnly={readOnly} />
            : <UserMessage text={message.text} at={message.editedAt ?? message.createdAt} busy={busy || readOnly} />}
          {<SessionTrace controller={controller} runId={message.turnId} inputId={input?.inputId} renderTool={renderTool} />}
        </> : <>{!messages.some(item => item.turnId === message.turnId && item.role === 'user') && messages.find(item => item.turnId === message.turnId && item.role === 'assistant')?.messageId === message.messageId && <SessionTrace controller={controller} runId={message.turnId} renderTool={renderTool} />}<AgentMessage reveal={!initial.current?.messages.has(message.messageId)} message={{ role: 'agent', text: message.text, at: message.createdAt, phase: message.state }} markdownVariant="astryx" showStopActions={false}>{lastAssistant ? cards(message.turnId) : null}{messageCitations.length ? <MessageCitations citations={messageCitations} onOpen={onOpenCitation} /> : null}</AgentMessage></>}
      </div>
    })}
    {conversation.turns.filter(run => !messages.some(message => message.turnId === run.turnId))
      .map(run => <SessionTrace key={run.turnId} controller={controller} runId={run.turnId} renderTool={renderTool} />)}
    {conversation.workspaces.filter(item => !renderedCards.has(item.toolCallId)).map(item => <div key={item.toolCallId}>{cards(item.turnId)}</div>)}
    {pendingMessages}
    {error && <p role="alert" className="learning-error">{error} <button type="button" onClick={() => void (readOnly ? controller.refresh() : controller.replay())}>{readOnly ? '重新读取' : '核对并重试'}</button></p>}
  </section>
}
function DraftProtectionFeedback({ error, retry }: { error: string; retry: () => Promise<void> }) {
  return error ? <p role="alert" className="learning-error">{error} <button type="button" onClick={() => void retry().catch(() => {})}>重试保留输入</button></p> : null
}
function SessionUserMessage({ input, at, controller, readOnly }: { input: AgentConversation['inputs'][number]; at: string; controller: AgentSessionController; readOnly: boolean }) {
  const draft = useSessionDraft(controller.client.scope, controller.sessionId, 'input:' + input.inputId,
    { text: input.text, editing: false, expectedVersion: input.version })
  const [stopping, setStopping] = useState(false), [error, setError] = useState('')
  const lastInput = controller.conversation?.inputs.filter(item => item.state !== 'removed').at(-1)
  const editable = !readOnly && (input.canEdit ?? input.inputId === lastInput?.inputId)
  const stopForEdit = async () => {
    const activeRuns = controller.conversation?.turns.filter(run => run.state === 'active') ?? []
    if (!activeRuns.length) return
    setStopping(true); setError('')
    try {
      for (const run of activeRuns) await controller.control(run.turnId, 'stop')
      for (let attempt = 0; attempt < 150; attempt++) {
        const current = await controller.client.conversation(controller.sessionId!)
        if (activeRuns.every(original => current.turns.some(run => run.turnId === original.turnId && ['completed', 'failed', 'stopped', 'interrupted'].includes(run.state)))) { await controller.refresh(); return }
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      throw new Error('正在停止原回答，请稍后重试编辑。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '停止尚未确认。'); throw cause }
    finally { setStopping(false) }
  }
  const previews = useAgentImagePreviews(controller.client.scope, input.images ?? [])
  const images = (input.images ?? []).flatMap(image => previews[image.imageId] ? [{ name: image.name, dataUrl: previews[image.imageId]! }] : [])
  const missing = (input.images ?? []).filter(image => !previews[image.imageId])
  return <><UserMessage text={input.text} at={at} images={images} busy={controller.busy || stopping || !draft.ready}
    editDraft={draft.value} onRequestEdit={stopForEdit} onEditDraftChange={value => {
      void draft.change({ ...value, expectedVersion: value.editing && !draft.value.editing ? input.version : draft.value.expectedVersion }).catch(() => {})
    }} onEdit={editable ? async text => {
      await draft.protect()
      await controller.inputControl(input.inputId, draft.value.expectedVersion, 'edit', { text })
    } : undefined} />
    {missing.length > 0 && <p className="wr-hint" aria-label="图片附件">{missing.map(image => image.name).join('、')}</p>}
    {error && <p role="alert" className="learning-error">{error}</p>}
    <DraftProtectionFeedback error={draft.error} retry={draft.protect} /></>
}
function SessionTrace({ controller, runId, inputId, renderTool }: { controller: AgentSessionController; runId: string; inputId?: string; renderTool?: (tool: AgentConversation['tools'][number]) => ReactNode }) {
  const conversation = controller.conversation!
  const run = conversation.turns.find(run => run.turnId === runId)
  const thinking = (conversation.thinking ?? []).filter(item => item.turnId === runId && (!item.inputId || item.inputId === inputId))
    .map(item => ({ ...item, active: item.active && !conversation.messages.some(message =>
      message.turnId === runId && message.role === 'assistant' && message.createdAt >= item.createdAt) }))
  const questionsByTool = new Map(conversation.questions.map(question => [question.toolCallId, question]))
  const tools = conversation.tools.filter(item => item.turnId === runId && (!item.inputId || item.inputId === inputId)
    && questionsByTool.get(item.toolCallId)?.state !== 'pending')
  const ordered = orderedAgentTrace(thinking, tools)
  const lastInput = conversation.inputs.filter(input => input.turnId === runId && input.state !== 'removed').at(-1)
  const active = (!inputId || lastInput?.inputId === inputId) && !!run && run.state === 'active'
  const failure = run?.state === 'failed' ? run.reason === 'teacher-model-unavailable'
    ? '当前教师模型不可用，请切换或重新配置模型。原问题仍保留。'
    : ['budget_exhausted', 'budget-exhausted', 'input-budget-exhausted', 'output-budget-exhausted'].includes(run.reason)
    ? '本次回答已达到预算上限，原问题和内容已保留。'
    : ['context-capacity-exceeded', 'context-capacity-preflight'].includes(run.reason)
      ? '当前模型容纳不了这次回答所需的上下文。可以缩小引用范围，或换用上下文更大的模型。'
      : '这次回答未能完成，原问题和内容已保留，可以稍后继续。' : ''
  if (!thinking.length && !tools.length && !active) return failure ? <p role="status" className="learning-error">{failure}</p> : null
  return <><AgentTrace grouped active={active} label="思考与执行" aria-label="思考与执行记录" data-turn-id={runId}>
    {!thinking.length && active && !conversation.questions.some(question => question.turnId === runId && question.state === 'pending') && <AgentThinking text="正在理解当前问题并整理可用信息。" active />}
    {ordered.map(entry => {
      if (entry.kind === 'thinking') return <AgentThinking key={entry.item.messageId} text={entry.item.text} active={entry.item.active} />
      const question = questionsByTool.get(entry.item.toolCallId)
      return <div key={entry.item.toolCallId}>{question ? <AgentQuestionRecord question={question} />
        : entry.item.skill && entry.item.skill.path === 'SKILL.md' ? <AgentSkillRead document={entry.item.skill} />
          : (renderTool?.(entry.item) ?? <TeachingToolRecords embedded records={[{
            commandId: entry.item.toolCallId, runId: entry.item.turnId, name: entry.item.name,
            state: entry.item.state === 'closed' ? 'settled' : entry.item.state === 'pending' ? 'prepared' : 'dispatching',
            outcome: entry.item.state === 'closed' ? toolFailed(entry.item) ? 'failed' : 'completed' : null,
            feedback: toolDetail(entry.item), result: toolResultData(entry.item), arguments: {}, basis: {}, source: null,
          }]} />)}</div>
    })}
  </AgentTrace>{failure && <p role="status" className="learning-error">{failure}</p>}</>
}
