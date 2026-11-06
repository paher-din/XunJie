import { isTerminalExecutionState, type AnyExecutionAction, type ExecutionQuery } from '@xunjie/contracts/execution'
import type { AdapterRegistry } from './adapter'
import { ExecutionError } from './errors'
import { stopDecision, type ExecutionRecord } from './ledger'
import { retainResult, mergeServiceFact, reconcileOnOpen, type ExecutionTransport } from './retention'
import type { BrowserExecutionReceiver } from './receiver'
import type { ResultRecord } from './store'
import { acquireSlot } from './runner'

export interface ExecutionControllerState { ready: boolean; records: ExecutionRecord[]; error: string }

/**
 * The execution controller owns real worker lifetimes and execution records. It deliberately has no
 * React dependency: switching tools, rebuilding an iframe or closing the component view keeps the
 * query and stop entry points for the runs this page actually started.
 */
export class ExecutionController {
  private history: ExecutionRecord[] = []
  private listeners = new Set<() => void>()
  private runs = new Map<string, AbortController>()
  private waiting = 0
  private started = 0
  private syncing = new Set<string>()
  private disposed = false
  private stopTimer: ReturnType<typeof setTimeout> | undefined
  private syncRetryTimer:ReturnType<typeof setTimeout>|undefined
  private syncRetries=new Set<string>()
  private unsubscribeAccept: () => void
  state: ExecutionControllerState = { ready: false, records: [], error: '' }
  constructor(readonly scope: string, readonly receiver: BrowserExecutionReceiver, private actions: {
    createExecution(options: { requestId: string; receiver: AnyExecutionAction['receiver']
      execution: AnyExecutionAction['execution']; protocolVersion?: 2 | 3 }): Promise<unknown>
    cancel(requestId: string): Promise<unknown>
  }, private transport: ExecutionTransport, private adapters: AdapterRegistry,
  private canAccess: () => boolean = () => true, private readonly readOnly = false) {
    this.unsubscribeAccept = receiver.onAccept(requestId => { void this.start(requestId) })
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  /** What this page is really doing, for the capability answer the component reads. */
  counts() { return { running: this.started, queued: Math.max(0, this.runs.size - this.started) } }
  private notify(patch: Partial<ExecutionControllerState> = {}) {
    if (this.disposed || !this.canAccess()) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private async refresh() {
    const records = this.readOnly ? [] : await this.receiver.store.list(this.scope)
    const localIds = new Set(records.map(item => item.requestId))
    this.notify({ ready: true, records: [...records, ...this.history.filter(item => !localIds.has(item.requestId))]
      .sort((a, b) => b.createdAt - a.createdAt) })
  }
  /** Only the durable record can stop a worker; no broadcast or other page's memory is required. */
  private async observeStop(requestId: string, abort: AbortController) {
    const record = await this.receiver.store.read(this.scope, requestId)
    if (this.runs.get(requestId) === abort && record?.query.stopRequested)
      abort.abort(new ExecutionError('worker-terminated', '用户请求停止。'))
    return record
  }
  private watchStops() {
    if (this.disposed || !this.runs.size || this.stopTimer !== undefined) return
    const timer = setTimeout(() => {
      void Promise.all([...this.runs].map(([requestId, abort]) =>
        this.observeStop(requestId, abort).catch(() => { /* Retry unreadable local facts while a run remains live. */ })))
        .finally(() => {
          if (this.stopTimer !== timer) return
          this.stopTimer = undefined; this.watchStops()
        })
    }, 100)
    this.stopTimer = timer
  }
  /** Resolve completion vs. stop in the ledger transaction, including stops during result retention. */
  private async finish(requestId: string, next: Parameters<BrowserExecutionReceiver['finish']>[1]) {
    if (next.state === 'cancelled') return this.receiver.finish(requestId, next)
    try {
      return await this.receiver.store.record(this.scope, requestId, current => {
        if (current.stopRequested && !isTerminalExecutionState(current.state))
          throw new ExecutionError('worker-terminated', '用户请求停止。')
        return { ...current, state: next.state, statusKnowledge: 'confirmed', confirmedSeq: current.confirmedSeq + 1,
          reason: next.reason ?? null, output: next.output ?? null }
      }, {}, this.receiver.generation)
    } catch (error) {
      if (!(error instanceof ExecutionError) || error.code !== 'worker-terminated') throw error
      return this.receiver.finish(requestId, { state: 'cancelled',
        reason: { code: error.code, detail: error.message }, stopped: true })
    }
  }
  /** A reload resumes only a command that provably never started; anything else becomes unknown. */
  async open() {
    if (this.transport.history) {
      try {
        const entries = await this.transport.history()
        this.history = entries.map(entry => ({ scope: this.scope, requestId: entry.query.requestId,
          inputDigest: entry.query.inputDigest, executionRef: entry.query.executionRef,
          action: entry.action, acceptance: entry.acceptance, query: entry.query, createdAt: Date.parse(entry.createdAt),
          generation: -1, startedAt: null, stoppedAt: null }))
      } catch {
        if (this.readOnly) { this.notify({ ready: true, error: '暂时无法读取原执行历史。' }); return }
      }
    }
    if (this.readOnly) { await this.refresh(); return }
    const records = await this.receiver.store.list(this.scope)
    for (const record of records) {
      const decided = reconcileOnOpen(record)
      if (decided.resume) continue
      if (decided.query !== record.query) {
        await this.receiver.store.record(this.scope, record.requestId, () => decided.query,
          { startedAt: record.startedAt ?? null })
      }
      if (record.acceptance.execution) void this.flush(record.requestId)
    }
    await this.refresh()
    for (const record of records) {
      if (!reconcileOnOpen(record).resume) continue
      // A command that provably never started is taken over by this page before it can run.
      await this.receiver.adopt(record.requestId).catch(() => false)
      void this.start(record.requestId)
    }
  }
  async submit(action: AnyExecutionAction): Promise<void> {
    if (this.readOnly) throw new Error('还原校验环境不能运行实验。')
    if (!this.canAccess()) throw new Error('forbidden')
    // The executor for this action is resolved before anything is accepted: an unsupported version
    // must fail here, not once the command is already the durable truth.
    this.adapters.resolve(action).validateAndFreeze(action)
    await this.actions.createExecution({ requestId: action.requestId, receiver: action.receiver,
      execution: action.execution, protocolVersion: action.protocolVersion })
    if (!this.canAccess()) throw new Error('forbidden')
    await this.refresh()
    if (!this.canAccess()) throw new Error('forbidden')
  }
  async query(requestId: string, inputDigest?: string): Promise<ExecutionQuery | null> {
    if (!this.canAccess()) return null
    const historical = this.history.find(item => item.requestId === requestId)
    if (historical && (this.readOnly || !await this.receiver.store.read(this.scope, requestId))) {
      if (inputDigest && historical.inputDigest !== inputDigest) return null
      const next = await this.transport.read(requestId)
      if (!this.canAccess()) return null
      historical.query = mergeServiceFact(historical.query, next) ?? historical.query
      await this.refresh()
      return historical.query
    }
    const record = await this.receiver.store.read(this.scope, requestId)
    if (!this.canAccess()) return null
    // A query that pins a different input is not asking about this run.
    if (!record || (inputDigest && inputDigest !== record.inputDigest)) return null
    if (record.query.statusKnowledge === 'confirmed' && isTerminalExecutionState(record.query.state)) return record.query
    try {
      const remote = await this.transport.read(requestId)
      if (!this.canAccess()) return null
      const merged = mergeServiceFact(record.query, remote)
      if (merged && merged !== record.query) {
        await this.receiver.store.record(this.scope, requestId, () => merged)
        if (!this.canAccess()) return null
        await this.refresh()
      }
      return this.canAccess() ? merged : null
    } catch { return this.canAccess() ? record.query : null /* An unreachable service never rewrites a confirmed fact. */ }
  }
  async artifact(requestId: string): Promise<ResultRecord | null> {
    if (!this.canAccess()) return null
    if(!this.readOnly) {
      const record=await this.receiver.store.read(this.scope,requestId)
      if(!this.canAccess())return null
      const local=record&&await this.receiver.store.readResult(this.scope,record.executionRef)
      if(!this.canAccess())return null
      if(local) {
        for(const ref of [local,...(local.resources??[])]) {
          const bytes=new TextEncoder().encode(ref.text)
          const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('')
          if(bytes.length!==ref.byteLength||hash!==ref.sha256)throw new Error('原结果资源完整性校验失败。')
        }
        return this.canAccess()?local:null
      }
    }
    if (this.history.some(item => item.requestId === requestId) && this.transport.artifact) {
      const result = await this.transport.artifact(requestId)
      return this.canAccess() && result ? { ...result, scope: this.scope, at: Date.now() } : null
    }
    return null
  }
  /** `stopId` is the caller's stable identity: retrying the same stop is the same request. */
  async stop(requestId: string, stopId: string = crypto.randomUUID(), inputDigest?: string): Promise<void> {
    if (this.readOnly) throw new Error('还原校验环境不能停止原执行。')
    const record = await this.receiver.store.read(this.scope, requestId)
    const historical = this.history.find(item => item.requestId === requestId)
    if (!record && historical) {
      if (inputDigest && historical.inputDigest !== inputDigest) throw new Error('conflict')
      historical.query = mergeServiceFact(historical.query, await this.transport.stop(requestId, stopId, '用户请求停止原执行。')) ?? historical.query
      await this.refresh()
      return
    }
    if (!record) { await this.actions.cancel(requestId); return }
    if (inputDigest && inputDigest !== record.inputDigest) throw new Error('conflict')
    const decision = stopDecision(record, record.query)
    if (decision === 'already-terminal') return
    await this.receiver.requestStop(record, decision === 'pre-start-cancel' ? '开始前取消。' : '用户请求停止。', stopId)
    this.runs.get(requestId)?.abort(new ExecutionError('worker-terminated', '用户请求停止。'))
    // The initial read may have raced the owner's claim or completion.
    const latest = await this.receiver.store.read(this.scope, requestId)
    if (latest && isTerminalExecutionState(latest.query.state) && latest.query.statusKnowledge === 'confirmed') {
      await this.refresh(); return
    }
    if (latest?.startedAt === null) {
      // Accepted but never started: this page may adopt and confirm the cancellation.
      await this.receiver.adopt(requestId).catch(() => false)
      await this.receiver.finish(requestId, { state: 'cancelled', reason: { code: 'worker-terminated', detail: '执行开始前已取消。' }, stopped: true })
      await this.actions.cancel(requestId)
      await this.refresh(); void this.flush(requestId)
      return
    }
    await this.refresh()
    try { await this.transport.stop(requestId, stopId, '用户请求停止。') } catch { /* Local stop stays durable. */ }
  }
  private async start(requestId: string) {
    if (this.disposed || this.readOnly) return
    const record = await this.receiver.store.read(this.scope, requestId)
    if (this.disposed) return
    if (!record?.acceptance.execution) return
    if (this.runs.has(requestId)) return
    if (record.startedAt !== null) return
    if (isTerminalExecutionState(record.query.state) || record.query.stopRequested) return
    const limits = record.action.execution.limits
    // The declared budget is the whole allowance: `concurrentJobs` may run, `queuedJobs` may wait.
    if (this.waiting >= limits.concurrentJobs + limits.queuedJobs) {
      await this.finish(requestId, { state: 'failed', reason: { code: 'budget-exceeded',
        detail: `同一浏览器已有 ${limits.concurrentJobs} 项执行、${limits.queuedJobs} 项等待，本次未进入队列。` } })
      await this.refresh(); void this.flush(requestId); return
    }
    this.waiting++
    let claimedNow = false
    const abort = new AbortController()
    this.runs.set(requestId, abort)
    this.watchStops()
    try {
      const slot = await acquireSlot(limits.concurrentJobs, 15000)
      try {
        const latest = await this.receiver.store.read(this.scope, requestId)
        if (latest && isTerminalExecutionState(latest.query.state)) return
        if (!latest || latest.query.stopRequested || abort.signal.aborted) {
          await this.receiver.finish(requestId, { state: 'cancelled', reason: { code: 'worker-terminated', detail: '执行开始前已取消。' }, stopped: true })
          return
        }
        // From here the run may have produced effects, so a reload can only report unknown, and
        // only this page may record them: the claim is written in the same transaction as `running`.
        const claimed = await this.receiver.claim(requestId)
        if (!claimed) return
        claimedNow = true
        this.started++
        await this.refresh()
        // The adapter owns this run's input and output semantics; the controller owns its lifetime.
        const adapter = this.adapters.resolve(record.action)
        let outcome
        try {
          outcome = await adapter.run(record.action, { signal: abort.signal,
            checkpoint: async () => { await this.observeStop(requestId, abort); abort.signal.throwIfAborted() } })
        } catch (error) {
          // Diagnostics of a failed run are still the run's own facts; the terminal reason keeps them.
          if (error instanceof ExecutionError) throw error
          throw new ExecutionError('algorithm-error', error instanceof Error ? error.message : '执行没有完成。')
        }
        await this.observeStop(requestId, abort)
        if (abort.signal.aborted) {
          await this.receiver.finish(requestId, { state: 'cancelled', reason: { code: 'worker-terminated', detail: '用户请求停止。' }, stopped: true })
          return
        }
        if (!outcome.resources.length) throw new ExecutionError('algorithm-error', '执行没有产生任何结果资源，未发布。')
        // The first result resource is the run's primary artifact; the rest are read back by role.
        const primary = outcome.resources[0]!
        const retained = await retainResult(this.receiver, record, { output: outcome.output, text: primary.text,
          name: primary.name, mediaType: primary.mediaType }, outcome.resources.slice(1))
        abort.signal.throwIfAborted()
        await this.finish(requestId, { state: 'succeeded', output: retained.output })
      } finally { slot.release() }
    } catch (error) {
      const code = error instanceof ExecutionError ? error.code : 'algorithm-error'
      const detail = (error instanceof Error ? error.message : '执行没有完成。').slice(0,500)
      const stopped = abort.signal.aborted || code === 'worker-terminated'
      let output:ExecutionQuery['output']=null
      if(error instanceof ExecutionError && error.resources?.length) {
        const [primary,...extras]=error.resources
        try { output=(await retainResult(this.receiver,record,{output:null,...primary},extras)).output }
        catch { /* A storage failure cannot publish an unreadable result. */ }
      }
      await this.finish(requestId, { state: stopped ? 'cancelled' : 'failed', output,
        reason: { code, detail }, stopped }).catch(() => {})
    } finally {
      this.runs.delete(requestId); this.waiting--
      if (!this.runs.size && this.stopTimer !== undefined) {
        clearTimeout(this.stopTimer); this.stopTimer = undefined
      }
      if (claimedNow) this.started--
      await this.refresh().catch(() => {})
      void this.flush(requestId)
    }
  }
  /** Service delivery of the same facts; a failure keeps the local truth and retries later. */
  async synchronize() {
    if(this.disposed || this.readOnly || !this.canAccess())return
    const records=await this.receiver.store.list(this.scope)
    await Promise.all(records.filter(record=>record.acceptance.execution).map(record=>this.flush(record.requestId)))
  }
  private retrySync(requestId:string) {
    if(this.disposed || this.readOnly)return
    this.syncRetries.add(requestId)
    if(this.syncRetryTimer!==undefined || !this.canAccess())return
    this.syncRetryTimer=setTimeout(()=>{
      this.syncRetryTimer=undefined
      for(const id of this.syncRetries)void this.flush(id)
    },1000)
  }
  private async flush(requestId: string) {
    if (this.disposed || this.readOnly || !this.canAccess()) return
    if (this.syncing.has(requestId)) return
    this.syncing.add(requestId)
    try {
      const record = await this.receiver.store.read(this.scope, requestId)
      if (!record?.acceptance.execution) return
      // Only what the service has not confirmed yet: a lost reply resumes this run's own resource
      // instead of re-sending a command the service already holds.
      const sent = await this.receiver.store.synced(this.scope, requestId).catch(() => undefined)
      if (!sent?.command) await this.transport.accept(record.action, record.acceptance)
      const stopIds=new Set(sent?.stopIds??[])
      for(const stop of (await this.receiver.store.stops(this.scope)).filter(stop=>stop.requestId===requestId)) {
        if(stopIds.has(stop.stopId))continue
        await this.transport.stop(requestId,stop.stopId,stop.reason);stopIds.add(stop.stopId)
      }
      const artifact = record.query.output && !sent?.result
        ? await this.receiver.store.readResult(this.scope, record.executionRef) : null
      if(record.query.output && !sent?.result && !artifact)throw new Error('原结果资源暂时不可读。')
      if (artifact && record.query.output) {
        const confirmed=await this.transport.result(requestId, { contentId: record.query.output.contentId,
        output: artifact.output, text: artifact.text, name: artifact.name, mediaType: artifact.mediaType,
        sha256: artifact.sha256, byteLength: artifact.byteLength, ...(artifact.resources?{resources:artifact.resources}:{}) })
        if(!confirmed)throw new Error('原结果资源尚未确认。')
      }
      // Publish completion only after the owner can read every retained resource it cites.
      if (!sent || sent.factSeq !== record.query.confirmedSeq) await this.transport.report(requestId, record.query)
      await this.receiver.store.sync({ scope: this.scope, requestId, command: true,
        factSeq: record.query.confirmedSeq, result: sent?.result === true || artifact !== null, at: Date.now(),...(stopIds.size?{stopIds:[...stopIds]}:{}) })
      const latest=await this.receiver.store.read(this.scope,requestId)
      if(latest && (latest.query.confirmedSeq!==record.query.confirmedSeq || latest.query.stopRequested!==record.query.stopRequested))this.retrySync(requestId)
      else this.syncRetries.delete(requestId)
      this.notify()
    } catch { this.retrySync(requestId) /* Same durable identity; never rerun computation. */ }
    finally { this.syncing.delete(requestId) }
  }
  async drain() { for (const abort of this.runs.values()) abort.abort(new ExecutionError('worker-terminated', '页面正在离开。')) }
  dispose() { this.disposed = true; this.unsubscribeAccept()
    if(this.syncRetryTimer!==undefined)clearTimeout(this.syncRetryTimer)
    this.syncRetryTimer=undefined;this.syncRetries.clear()
    if (this.stopTimer !== undefined) { clearTimeout(this.stopTimer); this.stopTimer = undefined }
    for (const abort of this.runs.values()) abort.abort(new ExecutionError('worker-terminated', '页面正在离开。'))
    this.listeners.clear() }
}
