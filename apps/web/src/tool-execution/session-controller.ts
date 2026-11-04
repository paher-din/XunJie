import { advanceExecution, isTerminalExecutionState, type ExecutionAction, type ExecutionControl, type ExecutionQuery, type SessionControlEffect, type ActivityCheckpoint, type ExecutionControlReceipt } from '@xunjie/contracts/execution'
import type { SessionTransport } from '../product/executionTransport'
import { openWorkspaceDatabase } from '../reliable-workspace/draft-store'
import type { PendingSessionRequest, SessionRequestQueue } from './session-requests'
import { digestOf } from './action'

interface SessionIntent {
  requestId: string; instanceId: string; action?: ExecutionAction; query?: ExecutionQuery
  starting?: boolean; control?: ExecutionControl; stopId?: string; stopReason?: string
}
interface SessionJournal { scope: string; selected: Record<string, string>; records: SessionIntent[] }
export interface NativeSessionState { ready: boolean; queries: ExecutionQuery[]; error: string; pending: PendingSessionRequest[]
  checkpoints: ActivityCheckpoint[]; checkpointsReady: boolean }

/** 意图与当前选择在网络发送前提交；恢复时只对账原身份。 */
export class NativeSessionController {
  private listeners = new Set<() => void>()
  private disposed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private journal: SessionJournal
  private active = new Map<string, Promise<ExecutionQuery | null>>()
  private observationOrder = 0
  private observed = new Map<string, number>()
  state: NativeSessionState = { ready: false, queries: [], error: '', pending: [], checkpoints: [], checkpointsReady: false }
  constructor(readonly scope: string, private transport: SessionTransport,
    private canAccess: () => boolean = () => true, private queue?: SessionRequestQueue) {
    this.journal = { scope, selected: {}, records: [] }
  }

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
  private async change(update: (journal: SessionJournal) => void) {
    if (this.disposed || !this.canAccess()) throw new Error('forbidden')
    const db = await openWorkspaceDatabase()
    const saved = await new Promise<SessionJournal>((resolve, reject) => {
      const tx = db.transaction('nativeSessionJournal', 'readwrite')
      const store = tx.objectStore('nativeSessionJournal'), read = store.get(this.scope)
      let result: SessionJournal, failure: unknown
      read.onsuccess = () => {
        try {
          if (this.disposed || !this.canAccess()) throw new Error('forbidden')
          result = read.result ?? { scope: this.scope, selected: {}, records: [] }
          update(result)
          store.put(result)
        } catch (error) { failure = error; tx.abort() }
      }
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(failure ?? tx.error)
      tx.onerror = () => {}
    })
    if (this.disposed || !this.canAccess()) throw new Error('forbidden')
    this.journal = saved
    this.notify({ queries: saved.records.flatMap(record => record.query ? [record.query] : []) })
  }
  private async upsert(query: ExecutionQuery, order: number = ++this.observationOrder) {
    if (!this.belongs(query) || !query.session) throw new Error('invalid-input')
    await this.change(journal => {
      let record = journal.records.find(item => item.requestId === query.requestId)
      if (!record) {
        record = { requestId: query.requestId, instanceId: query.session!.instanceId }
        journal.records.push(record)
      }
      if (record.instanceId !== query.session!.instanceId) throw new Error('invalid-input')
      const current = record.query
      // 序号相同也不能让已确认的状态或较新请求的可达性观察倒退。
      const stale = current && query.confirmedSeq <= current.confirmedSeq
        && order < (this.observed.get(query.requestId) ?? 0)
      if (!current || !stale && query.confirmedSeq >= current.confirmedSeq
        && query.session!.appliedSeq >= (current.session?.appliedSeq ?? 0)) {
        const next = current && query.confirmedSeq === current.confirmedSeq
          ? { ...query, state: current.state } : query
        record.query = advanceExecution(current ?? null, next)
      }
      if (record.query && query.stopRequested) record.query = { ...record.query, stopRequested: true }
      this.observed.set(query.requestId, Math.max(order, this.observed.get(query.requestId) ?? 0))
      const merged = record.query!
      record.starting = false
      if (!this.queue && record.control && (merged.session!.appliedSeq > record.control.expectedSeq
        || merged.session!.lastControlId === record.control.controlId || merged.stopRequested || isTerminalExecutionState(merged.state)))
        delete record.control
      if (isTerminalExecutionState(merged.state) || !this.queue && merged.stopRequested) delete record.stopId
      journal.selected[record.instanceId] ??= record.requestId
    })
    return this.journal.records.find(item => item.requestId === query.requestId)!.query!
  }
  find(instanceId: string): ExecutionQuery | null {
    const requestId = this.journal.selected[instanceId]
    return this.journal.records.find(record => record.requestId === requestId)?.query ?? null
  }
  pending(instanceId: string): 'start' | 'control' | 'stop' | null {
    const record = this.journal.records.find(item => item.requestId === this.journal.selected[instanceId])
    return record?.stopId ? 'stop' : record?.control ? 'control' : record?.starting ? 'start' : null
  }
  async select(requestId: string) {
    await this.change(journal => {
      const record = journal.records.find(item => item.requestId === requestId)
      if (record?.query?.session) journal.selected[record.instanceId] = requestId
    })
  }
  async open() {
    if (this.disposed || !this.canAccess()) return
    try {
      await this.change(() => {})
      if (this.queue) {
        const pending = await this.queue.list(this.scope)
        this.notify({ pending })
        // Adopt pre-merge journal intents without changing their original identities.
        for (const record of this.journal.records) {
          const request: PendingSessionRequest | undefined = record.starting && record.action
            ? { kind: 'start', id: record.requestId, action: record.action }
            : record.control ? { kind: 'control', id: record.control.controlId, requestId: record.requestId, control: record.control }
              : undefined
          if (request && !this.state.pending.some(item => item.id === request.id)) await this.enqueue(request)
          if (record.stopId && !this.state.pending.some(item => item.id === record.stopId))
            await this.enqueue({ kind: 'stop', id: record.stopId, requestId: record.requestId, reason: record.stopReason ?? '用户请求停止原生会话。' })
        }
      }
      const order = ++this.observationOrder
      const queries = (await this.transport.list()).filter(query => this.belongs(query))
      for (const query of queries) await this.upsert(query, order)
      for (const record of this.journal.records.filter(item => !queries.some(query => query.requestId === item.requestId))) {
        if (record.query && isTerminalExecutionState(record.query.state) && record.query.statusKnowledge === 'confirmed') continue
        await this.refresh(record.requestId)
      }
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
      if (this.queue) {
        for (const request of [...this.state.pending]) await this.queryPending(request)
      } else {
        for (const record of this.journal.records.filter(item => item.starting || item.control || item.stopId))
          await this.reconcile(record.requestId)
      }
      this.notify({ ready: true, error: '' })
    } catch {
      if (this.disposed || !this.canAccess()) return
      for (const query of this.state.queries) await this.unknown(query)
      this.notify({ ready: true, checkpointsReady: false,
        error: '本机会话或检查点记录暂时无法完整读取；已保留的观察不会在这里被重写。' })
    }
    this.schedule()
  }
  private schedule() {
    if (this.timer) clearTimeout(this.timer)
    if (this.disposed) return
    this.timer = setTimeout(() => { void this.open() }, 3000)
  }
  dispose() { this.disposed = true; if (this.timer) clearTimeout(this.timer); this.listeners.clear() }
  private async unknown(query: ExecutionQuery, order = ++this.observationOrder) {
    if (isTerminalExecutionState(query.state) && query.statusKnowledge === 'confirmed') return
    await this.upsert({ ...query, statusKnowledge: 'unknown',
      reason: { code: 'resource-unavailable', detail: '原会话连接待核实，保留最后可信观察。' } }, order)
  }
  async retryStart(instanceId: string): Promise<ExecutionQuery | null> {
    await this.change(() => {})
    const record = this.journal.records.find(item => item.requestId === this.journal.selected[instanceId])
    return record?.starting ? this.reconcile(record.requestId) : null
  }
  async start(action: ExecutionAction): Promise<ExecutionQuery> {
    if (this.disposed || !this.canAccess() || !this.belongs(action)) throw new Error('forbidden')
    const instanceId = action.execution.instance.instanceId
    let requestId = action.requestId
    await this.change(journal => {
      const current = journal.records.find(item => item.requestId === journal.selected[instanceId])
      if (current?.starting) {
        if (this.queue) throw new Error('outcome-unknown')
        requestId = current.requestId; return
      }
      if (!action.execution.resumeFromCheckpoint && current?.query && !isTerminalExecutionState(current.query.state)) {
        requestId = current.requestId; return
      }
      if (journal.records.some(item => item.requestId === action.requestId)) throw new Error('identity-conflict')
      journal.records.push({ requestId, instanceId, action: structuredClone(action), starting: true })
      journal.selected[instanceId] = requestId
    })
    if (this.queue) {
      const record = this.journal.records.find(item => item.requestId === requestId)!
      if (!record.starting) {
        if (!record.query) throw new Error('status-unknown')
        return record.query
      }
      const pending: PendingSessionRequest = { kind: 'start', id: requestId, action: record.action! }
      await this.enqueue(pending)
      return this.dispatch(pending)
    }
    const result = await this.reconcile(requestId)
    if (!result) throw new Error('status-unknown')
    return result
  }
  async input(query: ExecutionQuery, operationId: string, parameters: unknown): Promise<ExecutionQuery> {
    return this.control(query, 'input', operationId, parameters)
  }
  async control(query: ExecutionQuery, effect: SessionControlEffect, operationId: string, parameters: unknown): Promise<ExecutionQuery> {
    if (!query.session || isTerminalExecutionState(query.state) || query.stopRequested || query.statusKnowledge !== 'confirmed') throw new Error('invalid')
    await this.change(journal => {
      const record = journal.records.find(item => item.requestId === query.requestId)
      const current = record?.query
      if (!record || !current?.session || journal.selected[record.instanceId] !== query.requestId
        || isTerminalExecutionState(current.state) || current.stopRequested || record.stopId
        || current.statusKnowledge !== 'confirmed') throw new Error('invalid')
      if (record.control || this.state.pending.some(item => item.kind === 'control' && item.requestId === query.requestId)) throw new Error('pending-control')
      if (query.confirmedSeq !== current.confirmedSeq || query.session?.appliedSeq !== current.session.appliedSeq)
        throw new Error('stale-query')
      record.control = { controlId: crypto.randomUUID(), operationId, effect,
        expectedSeq: current.session.appliedSeq, parameters: structuredClone(parameters) }
    })
    if (this.queue) {
      const control = this.journal.records.find(item => item.requestId === query.requestId)!.control!
      const pending: PendingSessionRequest = { kind: 'control', id: control.controlId, requestId: query.requestId, control }
      await this.enqueue(pending)
      return this.dispatch(pending)
    }
    const result = await this.reconcile(query.requestId)
    if (!result) throw new Error('status-unknown')
    return result
  }
  async refresh(requestId: string): Promise<ExecutionQuery | null> {
    if (this.disposed || !this.canAccess()) return null
    const order = ++this.observationOrder
    try {
      const query = await this.transport.read(requestId)
      if (this.disposed || !this.canAccess()) return null
      if (query && query.requestId !== requestId) throw new Error('identity-conflict')
      if (query) return await this.upsert(query, order)
      const previous = this.state.queries.find(item => item.requestId === requestId)
      if (previous) await this.unknown(previous, order)
      return null
    } catch (error) {
      const previous = this.state.queries.find(item => item.requestId === requestId)
      if (previous) await this.unknown(previous, order)
      throw error
    }
  }
  /** 先查原请求；只有原操作尚未应用时，才按固定 controlId / expectedSeq 重发。 */
  reconcile(requestId: string): Promise<ExecutionQuery | null> {
    const current = this.active.get(requestId)
    if (current) return current
    const run = this.reconcileOnce(requestId).finally(() => { this.active.delete(requestId) })
    this.active.set(requestId, run)
    return run
  }
  private async reconcileOnce(requestId: string): Promise<ExecutionQuery | null> {
    if (this.queue) {
      for (const request of [...this.state.pending].filter(item => item.kind === 'start' ? item.action.requestId === requestId : item.requestId === requestId))
        await this.retryPending(request.id)
      return this.refresh(requestId)
    }
    await this.refresh(requestId)
    let record = this.journal.records.find(item => item.requestId === requestId)
    if (!record) return null
    if (this.disposed || !this.canAccess()) throw new Error('forbidden')
    const order = ++this.observationOrder
    const accept = async (query: ExecutionQuery) => {
      if (query.requestId !== requestId) throw new Error('identity-conflict')
      return this.upsert(query, order)
    }
    if (record.starting && record.action) {
      await accept(await this.transport.create(record.action))
      record = this.journal.records.find(item => item.requestId === requestId)!
    }
    if (this.disposed || !this.canAccess()) throw new Error('forbidden')
    if (record.stopId) return accept(await this.transport.stop(requestId, record.stopId, '用户请求停止原生会话。'))
    if (record.control) return accept(await this.transport.control(requestId, record.control))
    return record.query ?? null
  }
  async stop(requestId: string, stopId: string = crypto.randomUUID()): Promise<ExecutionQuery> {
    await this.change(journal => {
      const record = journal.records.find(item => item.requestId === requestId)
      if (!record) throw new Error('invalid')
      if (!record.query?.stopRequested && !isTerminalExecutionState(record.query?.state ?? 'queued') && !record.stopId) {
        record.stopId = stopId
        record.stopReason = this.queue ? '用户请求停止本机会话。' : '用户请求停止原生会话。'
      }
    })
    if (this.queue) {
      const existing = this.state.pending.find(item => item.kind === 'stop' && item.requestId === requestId)
      const record = this.journal.records.find(item => item.requestId === requestId)!
      const pending: PendingSessionRequest = existing ?? { kind: 'stop', id: record.stopId ?? stopId, requestId,
        reason: record.stopReason ?? '用户请求停止原生会话。' }
      await this.enqueue(pending)
      return this.dispatch(pending)
    }
    const result = await this.reconcile(requestId)
    if (!result) throw new Error('status-unknown')
    return result
  }

  private async enqueue(request: PendingSessionRequest) {
    await this.queue?.put(this.scope, request)
    if (this.disposed || !this.canAccess()) throw new Error('forbidden')
    this.notify({ pending: [...this.state.pending.filter(item => item.id !== request.id), request] })
  }
  private async settle(id: string) {
    await this.change(journal => {
      for (const record of journal.records) {
        if (record.requestId === id) record.starting = false
        if (record.control?.controlId === id) delete record.control
        if (record.stopId === id) delete record.stopId
      }
    })
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
    const previous = this.state.queries.find(item => item.requestId === request.requestId)
    if (previous && previous.executionRef !== receipt.executionRef) throw new Error('identity-conflict')
  }
  private async queryPending(request: PendingSessionRequest): Promise<boolean> {
    if (request.kind === 'control') {
      const receipt = await this.transport.controlReceipt?.(request.requestId, request.id)
      if (!receipt) return false
      await this.checkReceipt(request, receipt)
      await this.upsert(receipt.query)
      if (receipt.status === 'applied' || receipt.status === 'rejected') {
        await this.settle(request.id); return true
      }
      return false
    }
    const requestId = request.kind === 'start' ? request.action.requestId : request.requestId
    const query = await this.refresh(requestId)
    if (query && (request.kind === 'start' || query.statusKnowledge === 'confirmed' && isTerminalExecutionState(query.state))) {
      await this.settle(request.id); return true
    }
    return false
  }
  private async dispatch(request: PendingSessionRequest): Promise<ExecutionQuery> {
    if (this.disposed || !this.canAccess()) throw new Error('forbidden')
    const requestId = request.kind === 'start' ? request.action.requestId : request.requestId
    const order = ++this.observationOrder
    let merged: ExecutionQuery
    try {
      const query = request.kind === 'start' ? await this.transport.create(request.action)
        : request.kind === 'control' ? await this.transport.control(request.requestId, request.control)
          : await this.transport.stop(request.requestId, request.id, request.reason)
      if (query.requestId !== requestId) throw new Error('identity-conflict')
      merged = await this.upsert(query, order)
      if (request.kind === 'start') await this.select(query.requestId)
      if (request.kind === 'start' || request.kind === 'stop' && query.statusKnowledge === 'confirmed' && isTerminalExecutionState(query.state))
        await this.settle(request.id)
    } catch (error) {
      const previous = this.state.queries.find(item => item.requestId === requestId)
      if (previous) await this.unknown(previous, order)
      await this.failed(request, error)
      throw error
    }
    // HTTP acceptance can precede the worker applying the original control.
    // Receipt read failures must retain the accepted request, never reject or replay it.
    if (request.kind === 'control') await this.queryPending(request)
    return this.state.queries.find(query => query.requestId === requestId) ?? merged
  }
  /** Explicit retries only; receipts always refer to the original operation and run. */
  async retryPending(id: string) {
    if (this.disposed || !this.canAccess()) throw new Error('forbidden')
    const request = this.state.pending.find(item => item.id === id)
    if (!request) return
    if (request.kind !== 'control' && await this.queryPending(request)) return
    if (request.kind === 'control') {
      const receipt = await this.transport.controlReceipt?.(request.requestId, request.id)
      if (receipt) {
        await this.checkReceipt(request, receipt)
        await this.upsert(receipt.query)
        if (receipt.status === 'applied' || receipt.status === 'rejected') {
          await this.settle(request.id); return
        }
        throw new Error('outcome-unknown')
      }
    }
    await this.dispatch(request)
  }
}
