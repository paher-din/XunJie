/**
 * 工作区当前上下文与异步接纳规则。
 *
 * 依据 docs/tasks/I0_UI_CLIENT_CONTRACT.md §3：每次打开工作区、重新认证、切换模式/账号/Attempt
 * 或主动重新加载，都产生单调增加的本机 `loadEpoch`。任何 await 之后更新 UI 之前必须重新核对
 * 捕获的上下文仍然有效；AbortController 只减少在途请求，不作为正确性保证。
 *
 * 同一上下文内，权威读取另有按资源键单调的 read 序号：较早发出的 GET 不能覆盖较晚已接受的 GET。
 */

import type { WorkspaceMode } from './mode'

/** 决定归属的身份要素；任一项变化都必须换上下文，不能靠「对象 ID 一样」放行。 */
export interface WorkspaceIdentity {
  mode: WorkspaceMode
  /** Session 的 userId；尚未取得时为 null。 */
  userId: string | null
  assignmentId: string | null
  activityVersionId: string | null
  /** 01 只读，不创建 Attempt；创建后由 03 填入。 */
  attemptId: string | null
  /** 仅准备模式有值；真实模式恒为 null，不用准备常量顶替。 */
  preparationEpoch: string | null
}

export interface WorkspaceContext extends WorkspaceIdentity {
  /** 本机单调递增的载入代次。 */
  loadEpoch: number
  /** 受信 recoveryGeneration；缺失时不得发送写命令（H-03）。 */
  trustedRecoveryGeneration: string | null
}

let epochSeq = 0
let activeGuard: ContextGuard | null = null

/** 退出/会话失效时同步停止当前工作区，不能等 React 卸载后再丢弃 ACK。 */
export function invalidateWorkspaceContext(): void {
  activeGuard?.dispose()
}

/** 领取下一个本机 loadEpoch（单调递增，进程内不回退）。 */
export function nextLoadEpoch(): number {
  epochSeq += 1
  return epochSeq
}

/**
 * 一次工作区载入的上下文守卫。
 *
 * 新建守卫即成为当前守卫；旧守卫立刻失效，其在途响应不得再写当前工作区。
 * 组件卸载或主动重载时调用 `dispose()`。
 */
export class ContextGuard {
  readonly context: WorkspaceContext
  private readonly issuedSeq = new Map<string, number>()
  private readonly acceptedSeq = new Map<string, number>()
  private disposed = false

  constructor(context: WorkspaceContext) {
    this.context = Object.freeze({ ...context })
    activeGuard?.dispose()
    activeGuard = this
  }

  get loadEpoch(): number {
    return this.context.loadEpoch
  }

  /** 上下文是否已失效：被更新的上下文取代，或已显式释放。 */
  get stale(): boolean {
    return this.disposed || activeGuard !== this
  }

  dispose(): void {
    this.disposed = true
    if (activeGuard === this) activeGuard = null
  }

  /** 领取某个资源键的下一个读取序号（单调递增，可跳号，不回退不复用）。 */
  nextReadSeq(key: string): number {
    const next = (this.issuedSeq.get(key) ?? 0) + 1
    this.issuedSeq.set(key, next)
    return next
  }

  /**
   * 该读取结果是否仍可被接纳。
   *
   * 只有序号大于该键已接受的最大序号时才接纳；否则说明它是较早发出、迟到返回的读取，
   * 调用方必须丢弃它，不得覆盖当前已接受的权威状态。
   */
  acceptRead(key: string, seq: number): boolean {
    if (this.stale) return false
    const accepted = this.acceptedSeq.get(key) ?? 0
    if (seq <= accepted) return false
    this.acceptedSeq.set(key, seq)
    return true
  }

  /** 接纳后还有本机事务 await，期间较新读取/ACK 也能使本次结果失效。 */
  isAcceptedRead(key: string, seq: number): boolean {
    return !this.stale && this.acceptedSeq.get(key) === seq
  }
}
