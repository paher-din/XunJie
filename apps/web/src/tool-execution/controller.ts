import { isTerminalExecutionState, type ExecutionAction, type ExecutionQuery } from '@xunjie/contracts/execution'
import { acceptsState, type StateShape } from '@xunjie/contracts/components'
import { AlgorithmError, jobFromAction, type AggregationOutcome } from './algorithm'
import { stopDecision, type ExecutionRecord } from './ledger'
import { retainResult, mergeServiceFact, reconcileOnOpen, type ExecutionTransport } from './retention'
import type { BrowserExecutionReceiver } from './receiver'
import type { ResultRecord } from './store'
import { acquireSlot, runInWorker } from './runner'

export interface AlgorithmProvider {
  /** `result` is the snapshot's declared result shape; a run must produce exactly that. */
  load(action: ExecutionAction): Promise<{ bytes: ArrayBuffer; entry: string; memoryPages: number; result: StateShape }>
}
export interface ExecutionControllerState { ready: boolean; records: ExecutionRecord[]; error: string }
export interface RunAlgorithm { (job: Parameters<typeof runInWorker>[0], signal: AbortSignal): Promise<AggregationOutcome> }

/**
 * The execution controller owns real worker lifetimes and execution records. It deliberately has no
 * React dependency: switching tools, rebuilding an iframe or closing the component view keeps the
 * query and stop entry points for the runs this page actually started.
 */
export class ExecutionController {
  private listeners = new Set<() => void>()
  private runs = new Map<string, AbortController>()
  private waiting = 0
  private started = 0
  private syncing = new Set<string>()
  private disposed = false
  state: ExecutionControllerState = { ready: false, records: [], error: '' }
  constructor(readonly scope: string, readonly receiver: BrowserExecutionReceiver, private actions: {
    createExecution(options: { requestId: string; receiver: ExecutionAction['receiver']
      execution: Omit<ExecutionAction['execution'], 'basis'> & { basis: Pick<ExecutionAction['execution']['basis'], 'state' | 'expected' | 'resources'> } }): Promise<unknown>
    cancel(requestId: string): Promise<unknown>
  }, private transport: ExecutionTransport, private provider: AlgorithmProvider,
  private run: RunAlgorithm = runInWorker) {
    receiver.onAccept(requestId => { void this.start(requestId) })
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  /** What this page is really doing, for the capability answer the component reads. */
  counts() { return { running: this.started, queued: Math.max(0, this.runs.size - this.started) } }
  private notify(patch: Partial<ExecutionControllerState> = {}) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
  private async refresh() {
    const records = await this.receiver.store.list(this.scope)
    this.notify({ ready: true, records: records.sort((a, b) => b.createdAt - a.createdAt) })
  }
  /** A reload resumes only a command that provably never started; anything else becomes unknown. */
  async open() {
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
  async submit(action: ExecutionAction): Promise<void> {
    await this.actions.createExecution({ requestId: action.requestId, receiver: action.receiver, execution: action.execution })
    await this.refresh()
  }
  async query(requestId: string, inputDigest?: string): Promise<ExecutionQuery | null> {
    const record = await this.receiver.store.read(this.scope, requestId)
    // A query that pins a different input is not asking about this run.
    if (!record || (inputDigest && inputDigest !== record.inputDigest)) return null
    if (record.query.statusKnowledge === 'confirmed' && isTerminalExecutionState(record.query.state)) return record.query
    try {
      const remote = await this.transport.read(requestId)
      const merged = mergeServiceFact(record.query, remote)
      if (merged && merged !== record.query) {
        await this.receiver.store.record(this.scope, requestId, () => merged)
        await this.refresh()
      }
      return merged
    } catch { return record.query /* An unreachable service never rewrites a confirmed fact. */ }
  }
  async artifact(requestId: string): Promise<ResultRecord | null> {
    const record = await this.receiver.store.read(this.scope, requestId)
    return record ? (await this.receiver.store.readResult(this.scope, record.executionRef)) ?? null : null
  }
  /** `stopId` is the caller's stable identity: retrying the same stop is the same request. */
  async stop(requestId: string, stopId: string = crypto.randomUUID(), inputDigest?: string): Promise<void> {
    const record = await this.receiver.store.read(this.scope, requestId)
    if (!record) { await this.actions.cancel(requestId); return }
    if (inputDigest && inputDigest !== record.inputDigest) throw new Error('conflict')
    const decision = stopDecision(record, record.query)
    if (decision === 'already-terminal') return
    if (decision === 'pre-start-cancel') {
      // Nothing ran yet, so this is a pre-accept cancellation, not a stop of live work.
      this.runs.get(requestId)?.abort(new AlgorithmError('worker-terminated', '用户在执行开始前取消。'))
      await this.receiver.requestStop(record, '开始前取消。', stopId)
      // Nothing started, so this page may own the record it is about to cancel.
      await this.receiver.adopt(requestId).catch(() => false)
      await this.receiver.finish(requestId, { state: 'cancelled', reason: { code: 'worker-terminated', detail: '执行开始前已取消。' }, stopped: true })
      await this.actions.cancel(requestId)
      await this.refresh(); void this.flush(requestId)
      return
    }
    await this.receiver.requestStop(record, '用户请求停止。', stopId)
    const running = this.runs.get(requestId)
    // A queued-but-not-started worker is cancelled before it ever touches the algorithm.
    running?.abort(new AlgorithmError('worker-terminated', '用户请求停止。'))
    await this.refresh()
    try { await this.transport.stop(requestId, stopId, '用户请求停止。') } catch { /* Local stop stays durable. */ }
  }
  private async start(requestId: string) {
    if (this.disposed) return
    const record = await this.receiver.store.read(this.scope, requestId)
    if (!record?.acceptance.execution) return
    if (this.runs.has(requestId)) return
    if (record.startedAt !== null) return
    if (isTerminalExecutionState(record.query.state) || record.query.stopRequested) return
    const limits = record.action.execution.limits
    // The declared budget is the whole allowance: `concurrentJobs` may run, `queuedJobs` may wait.
    if (this.waiting >= limits.concurrentJobs + limits.queuedJobs) {
      await this.receiver.finish(requestId, { state: 'failed', reason: { code: 'budget-exceeded',
        detail: `同一浏览器已有 ${limits.concurrentJobs} 项执行、${limits.queuedJobs} 项等待，本次未进入队列。` } })
      await this.refresh(); void this.flush(requestId); return
    }
    this.waiting++
    let claimedNow = false
    const abort = new AbortController()
    this.runs.set(requestId, abort)
    try {
      const slot = await acquireSlot(limits.concurrentJobs, 15000)
      try {
        const latest = await this.receiver.store.read(this.scope, requestId)
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
        const algorithm = await this.provider.load(record.action)
        // The ABI, not this executor, decides how a fixed command becomes a worker job.
        const outcome = await this.run({ ...jobFromAction(record.action, limits), bytes: algorithm.bytes,
          memoryPages: algorithm.memoryPages, entry: algorithm.entry }, abort.signal)
        if (abort.signal.aborted) {
          await this.receiver.finish(requestId, { state: 'cancelled', reason: { code: 'worker-terminated', detail: '用户请求停止。' }, stopped: true })
          return
        }
        // The manifest declared the result structure; a run whose numbers do not fit it is not published.
        if (!acceptsState(algorithm.result, outcome.result))
          throw new AlgorithmError('algorithm-error', '算法结果与清单声明的结果结构不一致，已停止。')
        const retained = await retainResult(this.receiver, record, { output: outcome.result, text: outcome.artifact.text,
          name: outcome.artifact.name, mediaType: outcome.artifact.mediaType })
        await this.receiver.finish(requestId, { state: 'succeeded', output: retained.output })
      } finally { slot.release() }
    } catch (error) {
      const code = error instanceof AlgorithmError ? error.code : 'algorithm-error'
      const detail = error instanceof Error ? error.message : '执行没有完成。'
      const stopped = abort.signal.aborted || code === 'worker-terminated'
      await this.receiver.finish(requestId, { state: stopped ? 'cancelled' : 'failed',
        reason: { code, detail }, stopped }).catch(() => {})
    } finally {
      this.runs.delete(requestId); this.waiting--
      if (claimedNow) this.started--
      await this.refresh().catch(() => {})
      void this.flush(requestId)
    }
  }
  /** Service delivery of the same facts; a failure keeps the local truth and retries later. */
  private async flush(requestId: string) {
    if (this.syncing.has(requestId)) return
    const record = await this.receiver.store.read(this.scope, requestId).catch(() => undefined)
    if (!record?.acceptance.execution) return
    this.syncing.add(requestId)
    try {
      // Only what the service has not confirmed yet: a lost reply resumes this run's own resource
      // instead of re-sending a command the service already holds.
      const sent = await this.receiver.store.synced(this.scope, requestId).catch(() => undefined)
      if (!sent?.command) await this.transport.accept(record.action, record.acceptance)
      if (!sent || sent.factSeq !== record.query.confirmedSeq) await this.transport.report(requestId, record.query)
      this.notify()
      const artifact = record.query.output && !sent?.result
        ? await this.receiver.store.readResult(this.scope, record.executionRef) : null
      if (artifact && record.query.output) await this.transport.result(requestId, { contentId: record.query.output.contentId,
        output: artifact.output, text: artifact.text, name: artifact.name, mediaType: artifact.mediaType,
        sha256: artifact.sha256, byteLength: artifact.byteLength })
      await this.receiver.store.sync({ scope: this.scope, requestId, command: true,
        factSeq: record.query.confirmedSeq, result: sent?.result === true || artifact !== null, at: Date.now() })
    } catch { /* Offline or service unavailable: the local record is already the durable truth. */ }
    finally { this.syncing.delete(requestId) }
  }
  async drain() { for (const abort of this.runs.values()) abort.abort(new AlgorithmError('worker-terminated', '页面正在离开。')) }
  dispose() { this.disposed = true; for (const abort of this.runs.values()) abort.abort(new AlgorithmError('worker-terminated', '页面正在离开。'))
    this.listeners.clear() }
}
