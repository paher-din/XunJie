import { isTerminalExecutionState, type ExecutionAction, type ExecutionControl, type ExecutionQuery } from '@xunjie/contracts/execution'
import type { SessionTransport } from '../product/executionTransport'

export interface NativeSessionState { ready: boolean; queries: ExecutionQuery[]; error: string }

/**
 * Native session references live on the execution owner, so a reopened view finds the same
 * reference instead of minting a second run. This controller owns no child process.
 */
export class NativeSessionController {
  private listeners = new Set<() => void>()
  state: NativeSessionState = { ready: false, queries: [], error: '' }
  constructor(readonly scope: string, private transport: SessionTransport,
    private canAccess: () => boolean = () => true) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  private notify(patch: Partial<NativeSessionState>) {
    if (!this.canAccess()) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private belongs(query: ExecutionQuery) {
    const parsed = JSON.parse(this.scope) as string[]
    return query.scope.environmentId === parsed[1] && query.scope.spaceId === parsed[2]
      && query.scope.principalId === parsed[3] && query.scope.activityId === parsed[4]
  }
  private upsert(query: ExecutionQuery) {
    const queries = [query, ...this.state.queries.filter(item => item.requestId !== query.requestId)]
    this.notify({ queries })
  }
  find(instanceId: string): ExecutionQuery | null {
    return this.state.queries.find(query => query.session?.instanceId === instanceId) ?? null
  }
  async open() {
    if (!this.canAccess()) return
    try {
      const queries = (await this.transport.list()).filter(query => this.belongs(query))
      this.notify({ ready: true, queries, error: '' })
    } catch {
      this.notify({ ready: true, error: '本机会话记录暂时无法读取；已保留的观察不会在这里被重写。' })
    }
  }
  async start(action: ExecutionAction): Promise<ExecutionQuery> {
    if (!this.canAccess()) throw new Error('forbidden')
    const query = await this.transport.create(action)
    if (!this.canAccess()) throw new Error('forbidden')
    this.upsert(query)
    return query
  }
  /** One attempt per control identity; a lost reply is reconciled by the next query, never replayed blindly. */
  async input(query: ExecutionQuery, operationId: string, parameters: unknown): Promise<ExecutionQuery> {
    if (!this.canAccess()) throw new Error('forbidden')
    if (!query.session) throw new Error('capability-unavailable')
    if (isTerminalExecutionState(query.state) || query.stopRequested || query.statusKnowledge !== 'confirmed')
      throw new Error('invalid')
    const control: ExecutionControl = { controlId: crypto.randomUUID(), operationId, effect: 'input',
      expectedSeq: query.session.appliedSeq, parameters }
    const updated = await this.transport.control(query.requestId, control)
    if (!this.canAccess()) throw new Error('forbidden')
    this.upsert(updated)
    return updated
  }
  async refresh(requestId: string): Promise<ExecutionQuery | null> {
    if (!this.canAccess()) return null
    const query = await this.transport.read(requestId)
    if (!this.canAccess()) return null
    if (query) this.upsert(query)
    return query
  }
  async stop(requestId: string, stopId: string): Promise<ExecutionQuery> {
    if (!this.canAccess()) throw new Error('forbidden')
    const query = await this.transport.stop(requestId, stopId, '用户请求停止本机会话。')
    if (!this.canAccess()) throw new Error('forbidden')
    this.upsert(query)
    return query
  }
}
