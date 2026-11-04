import { advanceExecution, isTerminalExecutionState, type ExecutionAction, type ExecutionControl, type ExecutionQuery } from '@xunjie/contracts/execution'
import type { SessionTransport } from '../product/executionTransport'
import { openWorkspaceDatabase } from '../reliable-workspace/draft-store'

interface SessionIntent {
  requestId: string; instanceId: string; action?: ExecutionAction; query?: ExecutionQuery
  starting?: boolean; control?: ExecutionControl; stopId?: string
}
interface SessionJournal { scope: string; selected: Record<string, string>; records: SessionIntent[] }
export interface NativeSessionState { ready: boolean; queries: ExecutionQuery[]; error: string }

/** 意图与当前选择在网络发送前提交；恢复时只对账原身份。 */
export class NativeSessionController {
  private listeners = new Set<() => void>()
  private journal: SessionJournal
  private active = new Map<string, Promise<ExecutionQuery | null>>()
  private observationOrder = 0
  private observed = new Map<string, number>()
  state: NativeSessionState = { ready: false, queries: [], error: '' }
  constructor(readonly scope: string, private transport: SessionTransport,
    private canAccess: () => boolean = () => true) {
    this.journal = { scope, selected: {}, records: [] }
  }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  private notify(patch: Partial<NativeSessionState>) {
    if (!this.canAccess()) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private belongs(query: Pick<ExecutionQuery, 'scope'>) {
    const parsed = JSON.parse(this.scope) as string[]
    return query.scope.environmentId === parsed[1] && query.scope.spaceId === parsed[2]
      && query.scope.principalId === parsed[3] && query.scope.activityId === parsed[4]
  }
  private async change(update: (journal: SessionJournal) => void) {
    if (!this.canAccess()) throw new Error('forbidden')
    const db = await openWorkspaceDatabase()
    const saved = await new Promise<SessionJournal>((resolve, reject) => {
      const tx = db.transaction('nativeSessionJournal', 'readwrite')
      const store = tx.objectStore('nativeSessionJournal'), read = store.get(this.scope)
      let result: SessionJournal, failure: unknown
      read.onsuccess = () => {
        try {
          if (!this.canAccess()) throw new Error('forbidden')
          result = read.result ?? { scope: this.scope, selected: {}, records: [] }
          update(result)
          store.put(result)
        } catch (error) { failure = error; tx.abort() }
      }
      tx.oncomplete = () => resolve(result)
      tx.onabort = () => reject(failure ?? tx.error)
      tx.onerror = () => {}
    })
    if (!this.canAccess()) throw new Error('forbidden')
    this.journal = saved
    this.notify({ queries: saved.records.flatMap(record => record.query ? [record.query] : []) })
  }
  private async upsert(query: ExecutionQuery, order: number) {
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
      if (record.control && (merged.session!.appliedSeq > record.control.expectedSeq
        || merged.session!.lastControlId === record.control.controlId || merged.stopRequested || isTerminalExecutionState(merged.state)))
        delete record.control
      if (merged.stopRequested || isTerminalExecutionState(merged.state)) delete record.stopId
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
  async open() {
    if (!this.canAccess()) return
    try {
      await this.change(() => {})
      const order = ++this.observationOrder
      const queries = (await this.transport.list()).filter(query => this.belongs(query))
      for (const query of queries) await this.upsert(query, order)
      for (const record of this.journal.records.filter(item => item.starting || item.control || item.stopId))
        await this.reconcile(record.requestId)
      this.notify({ ready: true, error: '' })
    } catch {
      this.notify({ ready: true, error: '会话状态暂时无法核实；原请求与已确认观察已保留，可继续核对。' })
    }
  }
  async retryStart(instanceId: string): Promise<ExecutionQuery | null> {
    await this.change(() => {})
    const record = this.journal.records.find(item => item.requestId === this.journal.selected[instanceId])
    return record?.starting ? this.reconcile(record.requestId) : null
  }
  async start(action: ExecutionAction): Promise<ExecutionQuery> {
    if (!this.belongs(action)) throw new Error('forbidden')
    const instanceId = action.execution.instance.instanceId
    let requestId = action.requestId
    await this.change(journal => {
      const current = journal.records.find(item => item.requestId === journal.selected[instanceId])
      if (current && (current.starting || current.query && !isTerminalExecutionState(current.query.state))) {
        requestId = current.requestId; return
      }
      if (journal.records.some(item => item.requestId === action.requestId)) throw new Error('identity-conflict')
      journal.records.push({ requestId, instanceId, action: structuredClone(action), starting: true })
      journal.selected[instanceId] = requestId
    })
    const result = await this.reconcile(requestId)
    if (!result) throw new Error('status-unknown')
    return result
  }
  async input(query: ExecutionQuery, operationId: string, parameters: unknown): Promise<ExecutionQuery> {
    await this.change(journal => {
      const record = journal.records.find(item => item.requestId === query.requestId)
      const current = record?.query
      if (!record || !current?.session || journal.selected[record.instanceId] !== query.requestId
        || isTerminalExecutionState(current.state) || current.stopRequested || record.stopId
        || current.statusKnowledge !== 'confirmed') throw new Error('invalid')
      if (record.control) throw new Error('pending-control')
      if (query.confirmedSeq !== current.confirmedSeq || query.session?.appliedSeq !== current.session.appliedSeq)
        throw new Error('stale-query')
      record.control = { controlId: crypto.randomUUID(), operationId, effect: 'input',
        expectedSeq: current.session.appliedSeq, parameters: structuredClone(parameters) }
    })
    const result = await this.reconcile(query.requestId)
    if (!result) throw new Error('status-unknown')
    return result
  }
  async refresh(requestId: string): Promise<ExecutionQuery | null> {
    if (!this.canAccess()) return null
    const order = ++this.observationOrder
    const query = await this.transport.read(requestId)
    if (!this.canAccess()) return null
    if (query && query.requestId !== requestId) throw new Error('identity-conflict')
    return query ? this.upsert(query, order) : null
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
    await this.refresh(requestId)
    let record = this.journal.records.find(item => item.requestId === requestId)
    if (!record) return null
    if (!this.canAccess()) throw new Error('forbidden')
    const order = ++this.observationOrder
    const accept = async (query: ExecutionQuery) => {
      if (query.requestId !== requestId) throw new Error('identity-conflict')
      return this.upsert(query, order)
    }
    if (record.starting && record.action) {
      await accept(await this.transport.create(record.action))
      record = this.journal.records.find(item => item.requestId === requestId)!
    }
    if (!this.canAccess()) throw new Error('forbidden')
    if (record.stopId) return accept(await this.transport.stop(requestId, record.stopId, '用户请求停止原生会话。'))
    if (record.control) return accept(await this.transport.control(requestId, record.control))
    return record.query ?? null
  }
  async stop(requestId: string, stopId: string = crypto.randomUUID()): Promise<ExecutionQuery> {
    await this.change(journal => {
      const record = journal.records.find(item => item.requestId === requestId)
      if (!record) throw new Error('invalid')
      if (!record.query?.stopRequested && !isTerminalExecutionState(record.query?.state ?? 'queued'))
        record.stopId ??= stopId
    })
    const result = await this.reconcile(requestId)
    if (!result) throw new Error('status-unknown')
    return result
  }
}
