import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useActivitySession } from './ActivitySession'
import { SessionConversation } from './SessionConversation'
import type { AgentEvent } from '@xunjie/contracts/agent-runtime'
import { useViewPolling } from './useViewPolling'
import { workspaceConversation } from './workspace-conversation'
import { TeachingToolRecords } from './TeachingToolRecords'
import { ArtifactCard, ArtifactPreview } from '../teaching-artifacts/ArtifactCard'
import type { TeachingToolLocator } from './TeachingToolRecords'
import type { TeachingArtifactsController } from '../teaching-artifacts/useTeachingArtifacts'
export function ActivityConversation(props: { activity: LearningActivity; spaceKey: string; namespace: string; onModels?: () => void; onActiveChange?: (active: boolean) => void; onLocateTool?: TeachingToolLocator; focusQuestionId?: string | null; onQuestionFocused?: () => void; artifacts?: TeachingArtifactsController; onOpenArtifact?: (id: string) => Promise<void> }) {
  const root = useRef<HTMLDivElement>(null)
  const { agent, workspace, viewActive = true } = useActivitySession()
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
      const events = new Map(before.map(event => [event.seq, event]))
      for (const event of incoming) events.set(event.seq, event)
      const next = { scope, events: [...events.values()].sort((a, b) => a.seq - b.seq), error: '' }
      current.current = next; setDetails(next)
    } catch {
      if (shown.current === scope) setDetails({ scope, events: before, error: '原工具记录暂时无法读取。' })
    }
  }
  useViewPolling(readEvents, scope, agent?.active ? 1000 : 5000, !!agent?.sessionId && viewActive, String(agent?.conversation?.lastSeq ?? 0))
  const presentation = useMemo(() => workspaceConversation(agent?.conversation ?? null, details?.scope === scope ? details.events : []), [agent?.conversation, details, scope])
  useEffect(() => { props.onActiveChange?.(!!agent?.active); return () => props.onActiveChange?.(false) }, [agent?.active, props.onActiveChange])
  useEffect(() => {
    if (!props.focusQuestionId) return
    const target = root.current?.querySelector<HTMLElement>(`[data-wait-id="${CSS.escape(props.focusQuestionId)}"]`)
    if (target) { target.focus(); target.scrollIntoView?.({ block: 'nearest' }); props.onQuestionFocused?.() }
  }, [props.focusQuestionId, agent?.conversation, props.onQuestionFocused])
  return <div ref={root}>
    {agent ? <SessionConversation controller={agent} readOnly={workspace.isReadOnly() || props.activity.status !== 'open'} renderTool={tool => {
      if (presentation.generatingPage(tool.name)) return tool.state === 'failed'
        ? <p role="alert" className="learning-error">这次页面未能完成，原内容和输入仍保留。{tool.feedback?.text}</p> : null
      const record = presentation.records.get(tool.operationId)
      return record ? <TeachingToolRecords records={[record]} onLocate={props.onLocateTool} /> : null
    }} /> : <p role="status" aria-label="正在打开工作区对话" />}
    {presentation.previews.map(preview => <ArtifactPreview key={preview.key} preview={preview} />)}
    {props.artifacts?.entries.map(entry => <ArtifactCard key={entry.artifact.artifactId} entry={entry} controller={props.artifacts!}
      onOpen={props.onOpenArtifact ? () => props.onOpenArtifact!(entry.artifact.artifactId) : undefined} />)}
    {details?.scope === scope && details.error && <p role="alert" className="learning-error">{details.error} <button type="button" onClick={() => void readEvents()}>重新读取</button></p>}
    {props.artifacts?.error && <p role="alert" className="learning-error">{props.artifacts.error}</p>}
  </div>
}
