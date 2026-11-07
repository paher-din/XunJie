import { ReliableRecordStore } from './record-store'

export interface PendingAgentOperation {
  requestId: string; route: string; queryRoute: string; input: Record<string, unknown>
}
export interface LocalAgentControl {
  key: string; scope: string; draft?: { text: string; expectedVersion: number; editing: boolean }
  selected?: { inputId: string; expectedVersion: number }[]
  pending?: PendingAgentOperation; receipt?: unknown; rejected?: PendingAgentOperation
}
export class AgentControlStore extends ReliableRecordStore<LocalAgentControl> {
  constructor() { super('agentControls') }
}
export const agentControlStore = new AgentControlStore()

/** null never creates a new identity. Every retry uses the already protected route and request bytes. */
export async function deliverAgentOperation<T>(pending: PendingAgentOperation,
  request: (route: string, body?: unknown) => Promise<unknown>, parse: (value: unknown) => T): Promise<T> {
  const known = await request(pending.queryRoute)
  if (known !== null) return parse(known)
  try { await request(pending.route, pending.input) }
  catch (error) {
    const confirmed = await request(pending.queryRoute).catch(() => null)
    if (confirmed !== null) return parse(confirmed)
    throw error
  }
  const confirmed = await request(pending.queryRoute)
  if (confirmed === null) throw new Error('原操作的结果尚未确认。')
  return parse(confirmed)
}

export async function protectAgentOperation(key: string, scope: string, pending: PendingAgentOperation) {
  return agentControlStore.change(key, saved => {
    if (saved && saved.scope !== scope) throw new Error('操作不属于当前空间。')
    if (saved?.pending && JSON.stringify(saved.pending) !== JSON.stringify(pending)) throw new Error('上一操作尚未核实，原内容仍保留。')
    return { ...saved, key, scope, pending: saved?.pending ?? structuredClone(pending) }
  })
}
export async function confirmAgentOperation(key: string, pending: PendingAgentOperation, receipt: unknown) {
  return agentControlStore.change(key, saved => {
    if (!saved) throw new Error('原操作保护记录不可用。')
    if (saved.pending?.requestId !== pending.requestId) return saved
    return { ...saved, pending: undefined, receipt }
  })
}
