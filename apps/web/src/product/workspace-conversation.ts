import { z } from 'zod'
import type { AgentConversation } from '@xunjie/contracts/agent-service'
import type { AgentEvent } from '@xunjie/contracts/agent-runtime'
import { modelProgressSchema, modelToolResultSchema } from '@xunjie/contracts/model-connections'
import { teachingToolRecordSchema } from '@xunjie/contracts/teaching-agent'
import type { TeachingToolRecordView } from './TeachingToolRecords'

const facts = z.record(z.string(), z.json())
const outcome = z.object({ state: z.enum(['completed', 'accepted', 'failed', 'unknown', 'not-dispatched']),
  feedback: modelToolResultSchema.omit({ callId: true }), result: facts,
  source: teachingToolRecordSchema.shape.source.optional() })
const resultEvent = z.object({ runId: z.uuid(), commandId: z.uuid(), name: z.string(), outcome })
const preparedEvent = z.object({ runId: z.uuid(), commandId: z.uuid(), callId: z.string() })
const progressEvent = z.object({ runId: z.uuid(), stepId: z.uuid(), operationId: z.uuid(), ...modelProgressSchema.shape })
const workIdentity = z.object({ objectId: z.uuid(), contentId: z.uuid() })
const generatingPage = (name: string) => ['generate_teaching_artifact', 'revise_teaching_artifact'].includes(name)

/** Read only authenticated v2 events; never invent legacy snapshot, call or binding identities. */
export function workspaceConversation(conversation: AgentConversation | null, events: AgentEvent[]) {
  const results = new Map<string, z.infer<typeof resultEvent>>()
  const prepared: (z.infer<typeof preparedEvent> & { seq: number })[] = []
  const progress = new Map<string, { key: string; runId: string; callId: string; seq: number; html: string }>()
  const runs = new Map(conversation?.runs.map(run => [run.runId, run]) ?? [])
  for (const event of events) {
    if (event.sessionId !== conversation?.sessionId) continue
    if (event.kind === 'tool-result') {
      const parsed = resultEvent.safeParse(event.body)
      if (parsed.success && runs.has(parsed.data.runId)) results.set(parsed.data.commandId, parsed.data)
    } else if (event.kind === 'tool-prepared') {
      const parsed = preparedEvent.safeParse(event.body)
      if (parsed.success && runs.has(parsed.data.runId)) prepared.push({ ...parsed.data, seq: event.seq })
    } else if (event.kind === 'model-progress') {
      const parsed = progressEvent.safeParse(event.body)
      if (!parsed.success || !runs.has(parsed.data.runId)) continue
      for (const tool of parsed.data.tools ?? []) if (generatingPage(tool.name)) {
        const key = parsed.data.operationId + ':' + tool.callId
        progress.set(key, { key, runId: parsed.data.runId, callId: tool.callId, seq: event.seq, html: tool.text })
      }
    }
  }
  const records = new Map<string, TeachingToolRecordView>()
  for (const tool of conversation?.tools ?? []) {
    const detail = results.get(tool.operationId), original = detail?.runId === tool.runId && detail.name === tool.name ? detail.outcome : undefined
    const result = original?.result ?? null, fixedWork = workIdentity.safeParse(result?.file)
    const toolSource = teachingToolRecordSchema.shape.source.safeParse(result?.toolSource)
    const state = ['completed', 'failed', 'unknown', 'not-dispatched', 'stopped'].includes(tool.state) ? 'settled'
      : tool.state === 'prepared' ? 'prepared' : tool.state === 'dispatching' ? 'dispatching' : 'waiting'
    records.set(tool.operationId, { commandId: tool.operationId, runId: tool.runId, name: tool.name, state,
      outcome: original?.state ?? null, feedback: original?.feedback.text ?? tool.feedback?.text ?? '', result,
      arguments: fixedWork.success ? fixedWork.data : {}, basis: {},
      source: toolSource.success && toolSource.data ? toolSource.data
        : original?.source ?? (result?.source || result?.reference || result?.search ? { label: '固定资料' } : null) })
  }
  const previews = [...progress.values()].filter(item => {
    const run = runs.get(item.runId)
    // Providers may reuse callIds; only the next preparation in this Run can settle this preview.
    const command = prepared.find(command => command.runId === item.runId && command.callId === item.callId && command.seq > item.seq)
    return item.html.trim() && run && ['received', 'running', 'waiting'].includes(run.state) && !run.stopRequested
      && (!command || !results.has(command.commandId))
  })
  return { records, previews, generatingPage }
}
