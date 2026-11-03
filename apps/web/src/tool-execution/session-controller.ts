import { advanceExecution, isTerminalExecutionState, type ExecutionAction, type ExecutionControl, type ExecutionQuery, type SessionControlEffect } from '@xunjie/contracts/execution'
import type { SessionTransport } from '../product/executionTransport'
import type { PendingSessionRequest, SessionRequestQueue } from './session-requests'
import { digestOf } from './action'
import type { ActivityCheckpoint, ExecutionControlReceipt } from '@xunjie/contracts/execution'

export interface NativeSessionState { ready: boolean; queries: ExecutionQuery[]; error: string; pending: PendingSessionRequest[]
  checkpoints: ActivityCheckpoint[]; checkpointsReady: boolean }

/**
 * Native session references live on the execution owner, so a reopened view finds the same
 * reference instead of minting a second run. This controller owns no child process.
 */
export class NativeSessionController {
  private listeners = new Set<() => void>()
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private selected = new Map<string, string>()
  state: NativeSessionState = { ready: false, queries: [], error: '', pending: [], checkpoints: [], checkpointsReady: false }
  constructor(readonly scope: string, private transport: SessionTransport,
    private canAccess: () => boolean = () => true, private queue?: SessionRequestQueue) {}

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  private notify(patch: Partial<NativeSessionState>) {
    if (this.disposed || !this.canAccess()) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private belongs(query: Pick<ExecutionQuery, 'scope'>) {
    const parsed = JSON.parse(this.scope) as string[]
    return query.scope.environmentId === parsed[1] && query.scope.spaceId === parsed[2]
      && query.scope.principalId === parsed[3] && query.scope.activityId === parsed[4]
  }
  private upsert(query: ExecutionQuery) {
    if (!this.belongs(query)) throw new Error('forbidden')
    const previous = this.state.queries.find(item => item.requestId === query.requestId)
    if (query.session && !this.selected.has(query.session.instanceId)) this.selected.set(query.session.instanceId, query.requestId)
    const queries = previous ? this.state.queries.map(item => item.requestId === query.requestId ? advanceExecution(item, query) : item)
      : [query, ...this.state.queries]
    this.notify({ queries })
  }
  find(instanceId: string): ExecutionQuery | null {
    return this.state.queries.find(query => query.requestId === this.selected.get(instanceId))
      ?? this.state.queries.find(query => query.session?.instanceId === instanceId) ?? null
  }
  select(requestId: string) {
    const query = this.state.queries.find(item => item.requestId === requestId)
    if (!query?.session || this.disposed || !this.canAccess()) return
    this.selected.set(query.session.instanceId, requestId); this.notify({})
  }
  async open() {
    if (this.disposed || !this.canAccess()) return
    try {
      const pending = this.queue ? await this.queue.list(this.scope) : this.state.pending
      this.notify({ pending })
      const queries = (await this.transport.list()).filter(query => this.belongs(query))
      if (this.transport.checkpoints) {
        const checkpoints = new Map<string, ActivityCheckpoint>(), cursors = new Set<string>()
        let cursor: string | undefined
        do {
          const page = await this.transport.checkpoints(cursor)
          for (const checkpoint of page.items) {
            if (!this.belongs(checkpoint)) throw new Error('forbidden')
            checkpoints.set(checkpoint.checkpointId, checkpoint)
          }
          cursor = page.nextCursor ?? undefined
          if (cursor && cursors.has(cursor)) throw new Error('invalid-input')
          if (cursor) cursors.add(cursor)
        } while (cursor)
        this.notify({ checkpoints: [...checkpoints.values()], checkpointsReady: true })
      }
      const current = this.state.queries
      const merged = queries.map(query => {
        const previous = current.find(item => item.requestId === query.requestId)
        return previous ? advanceExecution(previous, query) : query
      })
      const absent: ExecutionQuery[] = []
      for (const previous of current.filter(item => !merged.some(query => query.requestId === item.requestId))) {
        const query = isTerminalExecutionState(previous.state) && previous.statusKnowledge === 'confirmed' ? previous
          : await this.transport.read(previous.requestId)
        absent.push(query ? advanceExecution(previous, query) : { ...previous, statusKnowledge: 'unknown',
          reason: { code: 'resource-unavailable', detail: '暂未查到原执行记录，不能据此认定未执行或已停止。' } })
      }
      for (const query of merged) if (query.session && !this.selected.has(query.session.instanceId)) this.selected.set(query.session.instanceId, query.requestId)
      this.notify({ ready: true, queries: [...absent, ...merged], error: '' })
      for (const request of pending) {
        if (request.kind === 'control') {
          const receipt = await this.transport.controlReceipt?.(request.requestId, request.id)
          if (receipt) {
            await this.checkReceipt(request, receipt)
            this.upsert(receipt.query)
            if (receipt.status === 'applied' || receipt.status === 'rejected') await this.settle(request.id)
          }
        } else {
          const requestId = request.kind === 'start' ? request.action.requestId : request.requestId
          const query = this.state.queries.find(item => item.requestId === requestId) ?? await this.transport.read(requestId)
          if (query) {
            this.upsert(query)
            if (request.kind === 'start' || (isTerminalExecutionState(query.state) && query.statusKnowledge === 'confirmed')) await this.settle(request.id)
          }
        }
      }
    } catch {
      for (const query of this.state.queries) this.unknown(query)
      this.notify({ ready: true, checkpointsReady: false, error: '本机会话或检查点记录暂时无法完整读取；已保留的观察不会在这里被重写。' })
    }
    this.schedule()
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    if (this.disposed) return
    this.timer = setTimeout(() => { void this.open() }, 3000)
  }
  dispose() { this.disposed = true; if (this.timer) clearTimeout(this.timer); this.listeners.clear() }
  private unknown(query: ExecutionQuery) {
    if (isTerminalExecutionState(query.state) && query.statusKnowledge === 'confirmed') return
    this.upsert({ ...query, statusKnowledge: 'unknown', reason: { code: 'resource-unavailable', detail: '原会话连接待核实，保留最后可信观察。' } })
  }
  async start(action: ExecutionAction): Promise<ExecutionQuery> {
    if (this.disposed || !this.canAccess()) throw new Error('forbidden')
    if (this.state.pending.some(request => request.kind === 'start' && request.action.execution.instance.instanceId === action.execution.instance.instanceId))
      throw new Error('outcome-unknown')
    const pending: PendingSessionRequest = { kind: 'start', id: action.requestId, action }
    await this.enqueue(pending)
    let query: ExecutionQuery
    try { query = await this.transport.create(action) }
    catch (error) { await this.failed(pending, error); throw error }
    if (!this.canAccess()) throw new Error('forbidden')
    if (query.session) this.selected.set(query.session.instanceId, query.requestId)
    this.upsert(query)
    await this.settle(pending.id)
    return query
  }
  /** One attempt per control identity; a lost reply is reconciled by the next query, never replayed blindly. */
  async input(query: ExecutionQuery, operationId: string, parameters: unknown): Promise<ExecutionQuery> {
    return this.control(query, 'input', operationId, parameters)
  }
  async control(query: ExecutionQuery, effect: SessionControlEffect, operationId: string, parameters: unknown): Promise<ExecutionQuery> {
    if (this.disposed || !this.canAccess()) throw new Error('forbidden')
    if (!query.session) throw new Error('capability-unavailable')
    if (isTerminalExecutionState(query.state) || query.stopRequested || query.statusKnowledge !== 'confirmed')
      throw new Error('invalid')
    const control: ExecutionControl = { controlId: crypto.randomUUID(), operationId, effect,
      expectedSeq: query.session.appliedSeq, parameters }
    if (this.state.pending.some(request => request.kind === 'control' && request.requestId === query.requestId)) throw new Error('outcome-unknown')
    const pending: PendingSessionRequest = { kind: 'control', id: control.controlId, requestId: query.requestId, control }
    await this.enqueue(pending)
    let updated: ExecutionQuery
    try { updated = await this.transport.control(query.requestId, control) }
    catch (error) { this.unknown(query); await this.failed(pending, error); await this.refresh(query.requestId).catch(() => null); throw error }
    if (!this.canAccess()) throw new Error('forbidden')
    this.upsert(updated)
    await this.settle(pending.id)
    return updated
  }
  async refresh(requestId: string): Promise<ExecutionQuery | null> {
    if (this.disposed || !this.canAccess()) return null
    let query: ExecutionQuery | null
    try { query = await this.transport.read(requestId) }
    catch (error) {
      const previous = this.state.queries.find(item => item.requestId === requestId)
      if (previous) this.unknown(previous)
      throw error
    }
    if (!this.canAccess()) return null
    if (query) this.upsert(query)
    else {
      const previous = this.state.queries.find(item => item.requestId === requestId)
      if (previous) this.unknown(previous)
    }
    return query
  }
  async stop(requestId: string, stopId: string): Promise<ExecutionQuery> {
    if (this.disposed || !this.canAccess()) throw new Error('forbidden')
    const existing = this.state.pending.find(request => request.kind === 'stop' && request.requestId === requestId)
    const pending: PendingSessionRequest = existing ?? { kind: 'stop', id: stopId, requestId, reason: '用户请求停止本机会话。' }
    if (pending.kind !== 'stop') throw new Error('invalid')
    await this.enqueue(pending)
    let query: ExecutionQuery
    try { query = await this.transport.stop(requestId, pending.id, pending.reason) }
    catch (error) { await this.failed(pending, error); throw error }
    if (!this.canAccess()) throw new Error('forbidden')
    this.upsert(query)
    if (query.statusKnowledge === 'confirmed' && isTerminalExecutionState(query.state)) await this.settle(pending.id)
    return query
  }

  private async enqueue(request: PendingSessionRequest) {
    await this.queue?.put(this.scope, request)
    if (this.disposed || !this.canAccess()) throw new Error('forbidden')
    this.notify({ pending: [...this.state.pending.filter(item => item.id !== request.id), request] })
  }
  private async settle(id: string) {
    await this.queue?.remove(this.scope, id)
    this.notify({ pending: this.state.pending.filter(item => item.id !== id) })
  }
  private async failed(request: PendingSessionRequest, error: unknown) {
    const code = (error as { code?: string })?.code
    const rejected = ['invalid', 'forbidden', 'identity-conflict', ...(request.kind === 'start' ? ['missing', 'corrupt'] : [])]
    if (code && rejected.includes(code)) await this.settle(request.id)
  }
  private async checkReceipt(request: Extract<PendingSessionRequest, { kind: 'control' }>, receipt: ExecutionControlReceipt) {
    if (receipt.controlId !== request.id || receipt.requestId !== request.requestId || receipt.query.requestId !== request.requestId
      || receipt.executionRef !== receipt.query.executionRef || receipt.seq !== request.control.expectedSeq + 1
      || receipt.effect !== request.control.effect || receipt.inputDigest !== await digestOf(request.control)) throw new Error('identity-conflict')
  }
  /** Explicit user retry only, always directed at the original run and original operation identity. */
  async retryPending(id: string) {
    if (this.disposed || !this.canAccess()) throw new Error('forbidden')
    const pending = this.state.pending.find(item => item.id === id)
    if (!pending) return
    let query: ExecutionQuery
    try {
      if (pending.kind === 'start') query = await this.transport.read(pending.action.requestId) ?? await this.transport.create(pending.action)
      else if (pending.kind === 'control') {
        const receipt = await this.transport.controlReceipt?.(pending.requestId, pending.id)
        if (receipt) await this.checkReceipt(pending, receipt)
        if (receipt && (receipt.status === 'unknown' || receipt.status === 'dispatching')) throw new Error('outcome-unknown')
        query = receipt?.query ?? await this.transport.control(pending.requestId, pending.control)
      } else {
        const previous = await this.transport.read(pending.requestId)
        query = previous && isTerminalExecutionState(previous.state) && previous.statusKnowledge === 'confirmed' ? previous
          : await this.transport.stop(pending.requestId, pending.id, pending.reason)
      }
    } catch (error) { await this.failed(pending, error); throw error }
    this.upsert(query)
    if (pending.kind !== 'stop' || (query.statusKnowledge === 'confirmed' && isTerminalExecutionState(query.state))) await this.settle(id)
  }
}
