import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AgentEmptyState, UserMessage } from '@xunjie/ui/chat'
import { useActivitySession } from './ActivitySession'
import { SessionConversation } from './SessionConversation'
import type { AgentEvent } from '@xunjie/contracts/agent-runtime'
import { isExecutionAction } from '@xunjie/contracts/execution'
import { useViewPolling } from './useViewPolling'
import { workspaceConversation, toolDetail, toolFailed } from './workspace-conversation'
import { TeachingToolRecords } from './TeachingToolRecords'
import { ArtifactCard, ArtifactPreview } from '../teaching-artifacts/ArtifactCard'
import type { TeachingToolLocator } from './TeachingToolRecords'
import type { TeachingArtifactsController } from '../teaching-artifacts/useTeachingArtifacts'
import type { CitationRecord } from '@xunjie/ui/chat'
export function ActivityConversation(props: { activity: LearningActivity; onLocateTool?: TeachingToolLocator; onOpenCitation?: (citation: CitationRecord) => void | Promise<void>; artifacts?: TeachingArtifactsController; onOpenArtifact?: (id: string) => Promise<void> }) {
  const { agent, agentSession, actions, workspace, viewActive = true } = useActivitySession()
  const { items } = useSyncExternalStore(actions.subscribe, actions.snapshot)
  const scope = agent ? agent.client.scope + ':' + agent.sessionId : ''
  const shown = useRef(scope); shown.current = scope
  useEffect(() => { shown.current = scope; return () => { shown.current = '' } }, [scope])
  const [details, setDetails] = useState<{ scope: string; events: AgentEvent[]; error: string } | null>(null)
  const current = useRef(details); current.current = details
  const readEvents = async () => {
    if (!agent?.sessionId) return
    const before = current.current?.scope === scope ? current.current.events : []
    try {
      const incoming = await agent.client.events(agent.sessionId, before.at(-1)?.seq ?? 0)
      if (shown.current !== scope) return
      if (!incoming.length && current.current?.scope === scope && !current.current.error) return
      const next = { scope, events: incoming.length ? [...before, ...incoming] : before, error: '' }
      current.current = next; setDetails(next)
    } catch {
      if (shown.current === scope) setDetails({ scope, events: before, error: '原工具记录暂时无法读取。' })
    }
  }
  const conversation = agent?.conversation
  // Artifact previews still read event deltas at their own cadence. Text uses the lighter
  // conversation projection, so each streaming batch need not trigger a second event read.
  useViewPolling(readEvents, scope, agent?.active ? 1000 : 5000, !!agent?.sessionId && viewActive,
    agent?.active ? undefined : String(conversation?.lastSeq ?? 0))
  const events = details?.scope === scope ? details.events : undefined
  const sessionId = conversation?.sessionId, turns = conversation?.turns, tools = conversation?.tools, inputs = conversation?.inputs
  const presentation = useMemo(() => workspaceConversation(sessionId && turns && tools ? { sessionId, turns, tools } : null, events ?? []),
    [sessionId, turns, tools, events])
  const receivedInputs = useMemo(() => {
    const inputs = new Map<string, string>()
    for (const event of events ?? []) {
      const { inputId, input } = event.body
      if (event.kind === 'input-received' && typeof inputId === 'string' && input && typeof input === 'object'
        && 'requestId' in input && typeof input.requestId === 'string') inputs.set(input.requestId, inputId)
    }
    return inputs
  }, [events])
  const pending = useMemo(() => {
    if (!agentSession) return []
    const inputIds = new Set(inputs?.map(input => input.inputId))
    const turnRequests = new Set(turns?.map(turn => turn.requestId))
    return items.flatMap(item => {
      const { input, localReceipt, phase } = item
      if (isExecutionAction(input) || input.receiver.receiverId !== 'teaching-agent:' + agentSession.owner.target.serviceId
        || item.history || item.cancelRequested || phase === 'unprotected' || phase === 'cancelled' || phase === 'failed'
        || inputIds.has(localReceipt?.receiptId ?? receivedInputs.get(input.requestId) ?? '')
        || turnRequests.has(input.requestId)) return []
      return [{ id: input.requestId, text: input.draft.question || '请结合所选内容帮助我。', accepted: !!localReceipt }]
    })
  }, [agentSession, inputs, turns, items, receivedInputs])
  const accepted = pending.filter(message => message.accepted).map(message => message.id).join(',')
  const refresh = agent?.refresh
  useEffect(() => {
    if (accepted && viewActive) void refresh?.()
  }, [accepted, refresh, viewActive])
  const pendingMessages = conversation ? pending : pending.filter(message => !message.accepted)
  const empty = conversation && !agent?.active && !agent?.error && !conversation.messages.length && !conversation.turns.length
    && !pending.length && !conversation.workspaces.length && !presentation.previews.length && !props.artifacts?.entries.length
    && !workspace.isReadOnly() && props.activity.status === 'open'
  return <div>
    {empty && <AgentEmptyState title="围绕当前作业提问" description="可以问课程要求、学习资料或你的作品。" />}
    {agent ? <SessionConversation controller={agent} readOnly={workspace.isReadOnly() || props.activity.status !== 'open'} renderTool={tool => {
      if (presentation.generatingPage(tool.name)) return toolFailed(tool)
        ? <p role="alert" className="learning-error">这次页面未能完成，原内容和输入仍保留。{toolDetail(tool)}</p> : null
      const record = presentation.records.get(tool.toolCallId)
      return record ? <TeachingToolRecords embedded records={[record]} onLocate={props.onLocateTool} /> : null
    }} onOpenCitation={props.onOpenCitation} /> : <p role="status" aria-label="正在打开工作区对话" />}
    {pendingMessages.length > 0 && <section className="session-conversation" aria-label="待接收的问题">
      {pendingMessages.map(message => <div key={message.id} data-message-id={message.id}><UserMessage text={message.text} /></div>)}
    </section>}
    {presentation.previews.map(preview => <ArtifactPreview key={preview.key} preview={preview} />)}
    {props.artifacts?.entries.map(entry => <ArtifactCard key={entry.artifact.artifactId} entry={entry} controller={props.artifacts!}
      onOpen={props.onOpenArtifact ? () => props.onOpenArtifact!(entry.artifact.artifactId) : undefined} />)}
    {details?.scope === scope && details.error && <p role="alert" className="learning-error">{details.error} <button type="button" onClick={() => void readEvents()}>重新读取</button></p>}
    {props.artifacts?.error && <p role="alert" className="learning-error">{props.artifacts.error}</p>}
  </div>
}
