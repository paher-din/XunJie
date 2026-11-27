import { z } from 'zod'
import type { AgentConversation } from '@xunjie/contracts/agent-service'
import { agentToolResultSchema, type AgentEvent, type AgentToolResult } from '@xunjie/contracts/agent-runtime'
import { modelProgressSchema } from '@xunjie/contracts/model-connections'
import type { TeachingToolRecordView } from './TeachingToolRecords'

type Tool = AgentConversation['tools'][number]
const preparedEvent = z.object({ turnId: z.uuid(), stepId: z.uuid(), toolCallId: z.uuid(), callId: z.string() })
const progressEvent = z.object({ turnId: z.uuid(), stepId: z.uuid(), attemptId: z.uuid(), ...modelProgressSchema.shape })
const workIdentity = z.object({ objectId: z.uuid(), contentId: z.uuid() })
const uuid = z.uuid()
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const generatingPage = (name: string) => ['generate_teaching_artifact', 'revise_teaching_artifact'].includes(name)
const toolResult = (tool: Tool): AgentToolResult | null => {
  const parsed = agentToolResultSchema.safeParse(tool.result); return parsed.success ? parsed.data : null
}

/** Only a normally completed call carries a result payload; every other kind is a terminal fact. */
export function toolResultData(tool: Tool) {
  const result = toolResult(tool)
  return result?.kind === 'completed' ? record(result.data) : null
}
export function toolFailed(tool: Tool) {
  const result = toolResult(tool)
  return !!result && (result.kind === 'interrupted' || result.kind === 'not_started'
    || result.kind === 'completed' && result.outcome === 'error')
}
export function toolDetail(tool: Tool) {
  const result = toolResult(tool)
  if (!result) return ''
  return result.kind === 'accepted' || result.kind === 'completed' ? result.summary : result.reason
}
/** Status text for a tool whose call has ended; running calls report their own state. */
export function toolStatus(tool: Tool) {
  if (tool.state !== 'closed') return ' · 进行中'
  const result = toolResult(tool)
  if (!result) return ' · 进行中'
  if (toolFailed(tool)) return ' · 未完成'
  return result.kind === 'accepted' ? ' · 等待结果' : result.kind === 'outcome_unknown' ? ' · 效果未知' : ''
}
/** The fixed learning source of a result, as far as the v3 tool result payload retains it. */
function toolSource(result: Record<string, unknown> | null): TeachingToolRecordView['source'] {
  if (!result) return null
  const file = workIdentity.safeParse(result.file)
  if (file.success) return { label: typeof record(result.file).name === 'string' ? String(record(result.file).name) : '固定作品',
    contentId: file.data.contentId }
  const query = record(result.query)
  if (typeof query.requestId === 'string' && uuid.safeParse(query.requestId).success)
    return { label: '原执行结果', requestId: query.requestId, ...(typeof result.contentId === 'string' ? { contentId: result.contentId } : {}) }
  if (result.reference || result.search || result.source) return { label: '固定资料' }
  return typeof result.name === 'string' ? { label: result.name } : null
}
function toolOutcome(tool: Tool): TeachingToolRecordView['outcome'] {
  const result = toolResult(tool)
  if (!result) return null
  if (result.kind === 'completed') return result.outcome === 'success' ? 'completed' : 'failed'
  if (result.kind === 'accepted') return 'accepted'
  if (result.kind === 'not_started') return 'not-dispatched'
  return result.kind === 'outcome_unknown' ? 'unknown' : 'failed'
}

/** Read only authenticated v3 projections and events; never invent legacy snapshot, call or binding identities. */
export function workspaceConversation(conversation: Pick<AgentConversation, 'sessionId' | 'turns' | 'tools'> | null, events: AgentEvent[]) {
  const prepared: (z.infer<typeof preparedEvent> & { seq: number })[] = []
  const progress = new Map<string, { key: string; turnId: string; callId: string; seq: number; html: string }>()
  const turns = new Map(conversation?.turns.map(turn => [turn.turnId, turn]) ?? [])
  for (const event of events) {
    if (event.sessionId !== conversation?.sessionId) continue
    if (event.kind === 'tool-prepared') {
      const parsed = preparedEvent.safeParse(event.body)
      if (parsed.success && turns.has(parsed.data.turnId)) prepared.push({ ...parsed.data, seq: event.seq })
    } else if (event.kind === 'model-progress') {
      const parsed = progressEvent.safeParse(event.body)
      if (!parsed.success || !turns.has(parsed.data.turnId)) continue
      for (const tool of parsed.data.tools ?? []) if (generatingPage(tool.name)) {
        const key = parsed.data.attemptId + ':' + tool.callId
        progress.set(key, { key, turnId: parsed.data.turnId, callId: tool.callId, seq: event.seq, html: tool.text })
      }
    }
  }
  const records = new Map<string, TeachingToolRecordView>()
  for (const tool of conversation?.tools ?? []) {
    const result = toolResultData(tool), fixedWork = workIdentity.safeParse(result?.file)
    records.set(tool.toolCallId, { commandId: tool.toolCallId, runId: tool.turnId, name: tool.name,
      state: tool.state === 'closed' ? 'settled' : tool.state === 'started' ? 'dispatching' : 'prepared',
      outcome: toolOutcome(tool), feedback: toolDetail(tool), result,
      arguments: fixedWork.success ? fixedWork.data : {}, basis: {}, source: toolSource(result) })
  }
  const previews = [...progress.values()].filter(item => {
    const turn = turns.get(item.turnId)
    // Providers may reuse callIds; only the next preparation in this Turn can settle this preview.
    const command = prepared.find(command => command.turnId === item.turnId && command.callId === item.callId && command.seq > item.seq)
    const settled = command && conversation?.tools.some(tool => tool.toolCallId === command.toolCallId && tool.state === 'closed')
    return item.html.trim() && turn?.state === 'active' && !settled
  })
  return { records, previews, generatingPage }
}
