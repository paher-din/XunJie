import type { AnyExecutionAction } from '@xunjie/contracts/execution'

/** One bounded result artifact. The controller retains these; it never interprets them. */
export interface ResultResource { name: string; mediaType: string; text: string }

/**
 * What an adapter really produced. The public executor owns identities, retention and the terminal
 * fact; an adapter owns only the semantics of its own fixed action.
 */
export interface AdapterResult {
  /** The structured value recorded as this run's output. Never derived from the live workspace. */
  output: unknown
  /** Ordered by the operation's own result format; the first is the run's primary artifact. */
  resources: ResultResource[]
  diagnostics: string[]
}

/** Everything an adapter may consult about its own run; it cannot accept, sync or publish facts. */
export interface AdapterContext {
  signal: AbortSignal
  /**
   * Re-reads durable ownership and throws if this run must stop. An adapter calls it after loading
   * its resources and before any side effect, so a durable stop never dispatches a worker.
   */
  checkpoint(): Promise<void>
}

/**
 * A registered executor for exactly one execution protocol version. Selection is by that version
 * and by the adapter identity the action itself declares; the workspace never picks an executor by
 * course, ALU id or file suffix.
 */
export interface ExecutionAdapter {
  readonly adapterId: string
  readonly adapterVersion: number
  readonly protocolVersion: 2 | 3
  /** Whether this adapter really implements that action, not just its protocol version. */
  handles(action: AnyExecutionAction): boolean
  /** The basis checks this adapter will rely on, run before it starts any work. */
  validateAndFreeze(action: AnyExecutionAction): void
  run(action: AnyExecutionAction, context: AdapterContext): Promise<AdapterResult>
}

export class AdapterUnavailable extends Error {
  readonly code = 'capability-unavailable'
  constructor(detail: string) { super(detail) }
}

/**
 * The whole set of executors this build ships. An unknown adapter, or two implementations claiming
 * one identity, is a refusal — never a fallback to another executor.
 */
export class AdapterRegistry {
  private readonly adapters: ExecutionAdapter[]
  constructor(adapters: ExecutionAdapter[]) {
    this.adapters = [...adapters]
    for (const adapter of this.adapters) {
      if (this.adapters.filter(item => item.adapterId === adapter.adapterId
        && item.adapterVersion === adapter.adapterVersion).length !== 1)
        throw new Error(`执行 Adapter 版本重复登记：${adapter.adapterId}@${adapter.adapterVersion}`)
      if (this.adapters.filter(item => item.protocolVersion === adapter.protocolVersion).length !== 1)
        throw new Error(`执行协议版本 ${adapter.protocolVersion} 被多个 Adapter 认领。`)
    }
  }
  resolve(action: AnyExecutionAction): ExecutionAdapter {
    const found = this.adapters.find(adapter => adapter.protocolVersion === action.protocolVersion)
    if (!found) throw new AdapterUnavailable(
      `本产品版本没有登记执行协议 ${action.protocolVersion} 的 Adapter，不能执行这条固定动作。`
      + '请更新产品，或回到仍支持该版本的课程发布。')
    // A v3 action names the runtime adapter it was accepted under; a different one must not run it.
    if (action.protocolVersion === 3 && (found.adapterId !== action.execution.basis.runtime.adapterId
      || found.adapterVersion !== action.execution.basis.runtime.adapterVersion))
      throw new AdapterUnavailable(`运行包声明的 Adapter ${action.execution.basis.runtime.adapterId}@`
        + `${action.execution.basis.runtime.adapterVersion} 与本产品登记的实现不一致，已停止本次执行。`)
    if (!found.handles(action)) throw new AdapterUnavailable(
      `执行 Adapter ${found.adapterId}@${found.adapterVersion} 不接受这条动作，已停止本次执行。`)
    return found
  }
  has(adapterId: string, adapterVersion: number): boolean {
    return this.adapters.some(adapter => adapter.adapterId === adapterId && adapter.adapterVersion === adapterVersion)
  }
  get size() { return this.adapters.length }
}
