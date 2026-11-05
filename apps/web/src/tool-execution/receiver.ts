import { actionReceiptSchema } from '@xunjie/contracts/action-intents'
import { executionAcceptanceSchema, type ExecutionAcceptance, type ExecutionAction, type ExecutionQuery } from '@xunjie/contracts/execution'
import type { ActionReceiverIdentity } from '@xunjie/contracts/action-intents'
import { ExecutionStore, type ResultRecord, type StopRecord } from './store'
import type { ExecutionRecord } from './ledger'

/**
 * The durable browser receiver. Acceptance means the command and its pending fact commit
 * together; nothing about a run exists only in the page that started it.
 */
export class BrowserExecutionReceiver {
  readonly store = new ExecutionStore()
  private acceptListeners = new Set<(requestId: string) => void>()
  constructor(readonly identity: ActionReceiverIdentity, readonly scope: string, readonly generation: number, private canAccept: () => boolean = () => true) {}
  /** The controller observes real acceptances, not a polled guess about them. */
  onAccept(listener: (requestId: string) => void) { this.acceptListeners.add(listener); return () => { this.acceptListeners.delete(listener) } }
  async accept(action: ExecutionAction, inputDigest: string): Promise<ExecutionAcceptance> {
    if (!this.canAccept()) throw Object.assign(new Error('forbidden'), { code: 'forbidden' })
    const receipt = actionReceiptSchema.parse({ requestId: action.requestId, inputDigest, receiver: action.receiver,
      state: 'accepted', receiptId: 'browser:' + action.requestId, detail: '已在本机可靠保存命令与待处理事实。' })
    const record = await this.store.accept(this.scope, action, inputDigest, executionAcceptanceSchema.parse({ receipt,
      execution: { executionRef: crypto.randomUUID(), acceptedSeq: 1 } }), this.generation)
    for (const listener of this.acceptListeners) listener(action.requestId)
    return record.acceptance
  }
  async query(requestId: string, inputDigest: string): Promise<ExecutionQuery | null> {
    const record = await this.store.read(this.scope, requestId)
    return record && record.inputDigest === inputDigest ? record.query : null
  }
  async cancel(requestId: string, inputDigest: string): Promise<ExecutionAcceptance | null> {
    const record = await this.store.read(this.scope, requestId)
    if (record) {
      if (record.inputDigest !== inputDigest) return null
      // An accepted command keeps its original receipt; stopping is a separate, queryable fact.
      await this.requestStop(record, '接收后取消转为停止原执行。', crypto.randomUUID())
      return record.acceptance
    }
    // Nothing was accepted under this identity: record a block that a late acceptance cannot revive.
    await this.store.stop({ scope: this.scope, stopId: crypto.randomUUID(), requestId, inputDigest,
      reason: '接收前取消。', state: 'confirmed', at: Date.now() })
    return executionAcceptanceSchema.parse({ receipt: actionReceiptSchema.parse({ requestId, inputDigest,
      receiver: this.identity, state: 'cancelled', receiptId: 'browser-cancel:' + requestId,
      detail: '接收前已取消，不会再有迟到接受。' }), execution: null })
  }
  async blocked(requestId: string, inputDigest: string): Promise<boolean> {
    const stops = await this.store.stops(this.scope)
    return stops.some(stop => stop.requestId === requestId && stop.inputDigest === inputDigest)
  }
  async requestStop(record: ExecutionRecord, reason: string, stopId: string): Promise<ExecutionQuery> {
    const stop: StopRecord = { scope: this.scope, stopId, requestId: record.requestId,
      inputDigest: record.inputDigest, reason, state: 'confirmed', at: Date.now() }
    await this.store.stop(stop)
    const updated = await this.store.record(this.scope, record.requestId, current => ({ ...current, stopRequested: true,
      confirmedSeq: current.confirmedSeq + 1 }))
    return updated.query
  }
  /** The durable claim that precedes any effect of this run; `null` means another page owns it. */
  async claim(requestId: string, now = Date.now()): Promise<ExecutionRecord | null> {
    return this.store.claim(this.scope, requestId, this.generation, now)
  }
  /** A reload may take over a command that never started; a started run keeps its owner. */
  async adopt(requestId: string): Promise<boolean> {
    return this.store.adopt(this.scope, requestId, this.generation)
  }
  async finish(requestId: string, next: { state: 'succeeded' | 'failed' | 'cancelled'; output?: ExecutionQuery['output']
    reason?: ExecutionQuery['reason']; stopped?: boolean }): Promise<ExecutionRecord> {
    return this.store.record(this.scope, requestId, current => ({ ...current, state: next.state, statusKnowledge: 'confirmed',
      confirmedSeq: current.confirmedSeq + 1, reason: next.reason ?? null, output: next.output ?? null,
      stopRequested: current.stopRequested }), next.stopped ? { stoppedAt: Date.now() } : {}, this.generation)
  }
  /** The artifact is read back before its reference is published; a record alone is not proof of readability. */
  async retainResult(value: ResultRecord): Promise<ResultRecord> {
    await this.store.result(value)
    const saved = await this.store.readResult(value.scope, value.executionRef)
    if (!saved || saved.text !== value.text || saved.sha256 !== value.sha256)
      throw new Error('结果文件未能通过重读校验，未发布引用。')
    return saved
  }
}
