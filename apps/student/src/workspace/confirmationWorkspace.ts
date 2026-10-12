import { ContextGuard, nextLoadEpoch } from './context'
import { verifyHead, verifySnapshot, workspaceOf } from './confirmation'
import { confirmationRepository, sameGeneration } from './confirmationDb'
import { freezeAttempt, freezeSnapshot, freezeSync, verifyAttemptReceipt, verifySyncReceipt, verifyReceipt, verifySnapshotReceipt,
  type CommandContext, type FrozenCommand, type FrozenDraft, type OutboxRecord } from './frozenCommand'
import { apiGet, apiPostFrozen, setCsrfToken, WorkspaceRequestError, type RequestOptions } from './http'
import type { SessionView } from './contracts'
import type { AttemptView, ConfirmedWorkspace, Receipt, SnapshotResult, SnapshotView, WorkspaceHead } from './workspaceContracts'

export type ConfirmationPhase = 'idle' | 'loading' | 'ready' | 'saving' | 'local-failed' | 'unknown' | 'error' | 'readonly'
export interface ConfirmationState {
  phase: ConfirmationPhase; workspace: ConfirmedWorkspace | null; attempt: AttemptView | null
  snapshot: SnapshotView | null; pending: OutboxRecord | null; error: string | null
}
const initialState = (): ConfirmationState => ({ phase: 'idle', workspace: null, attempt: null, snapshot: null, pending: null, error: null })
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)

/** 03 共同客户端：原命令串行，head/快照来自同一 HTTP 层，所有接纳核当前上下文。 */
export class ConfirmationWorkspace {
  private guard: ContextGuard
  private state = initialState()
  private readonly clientId = crypto.randomUUID()
  private readonly leaseOwner = crypto.randomUUID()
  private busy = false
  private channel: BroadcastChannel | null = null
  private readonly listeners = new Set<(state: ConfirmationState) => void>()
  constructor(context: CommandContext) {
    this.guard = new ContextGuard(context)
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('xunjie-i0-confirmation')
      this.channel.onmessage = event => {
        const c = event.data as CommandContext | null
        if (c && sameGeneration(c, this.context) && !this.guard.stale) void this.readHead()
      }
    }
  }
  get context(): CommandContext { return this.guard.context as CommandContext }
  get current(): ConfirmationState { return this.state }
  subscribe(listener: (state: ConfirmationState) => void): () => void {
    this.listeners.add(listener); listener(this.state)
    return () => { this.listeners.delete(listener) }
  }
  dispose(): void { this.guard.dispose(); this.listeners.clear(); this.channel?.close() }
  private publish(change: Partial<ConfirmationState>): void {
    if (this.guard.stale) return
    this.state = { ...this.state, ...change }
    this.listeners.forEach(fn => fn(this.state))
  }
  private valid(guard: ContextGuard): boolean { return this.guard === guard && !guard.stale }
  private opts(): RequestOptions { return { mode: this.context.mode, scenarioId: this.context.scenarioId } }
  private bindAttempt(attemptId: string): void {
    this.guard = new ContextGuard({ ...this.context, attemptId, loadEpoch: nextLoadEpoch() })
    this.state = initialState()
  }
  async initialize(): Promise<void> {
    let guard = this.guard
    this.publish({ phase: 'loading' })
    try {
      const reference = await confirmationRepository.reference(this.context)
      if (!this.valid(guard)) return
      if (reference.changed) this.publish({ error: '准备上下文已改变：旧草稿保留，须重新比较；旧确认缓存与原请求不能当当前作品。' })
      if (!this.context.attemptId && reference.attemptId) { this.bindAttempt(reference.attemptId); guard = this.guard }
      if (this.context.attemptId) await this.readHead()
      else this.publish({ phase: 'idle' })
      if (!this.valid(guard)) return
      const commands = await confirmationRepository.commands(this.context)
      if (!this.valid(guard)) return
      const pending = commands.find(r => r.state === 'pending' && sameGeneration(r.context, this.context)) ?? null
      if (pending) this.publish({ pending, phase: 'unknown', error: '有原请求尚未完成本机确认，请先核对原请求。' })
    } catch (e) { if (this.valid(guard)) this.publish({ phase: 'error', error: errorText(e) }) }
  }
  async readHead(): Promise<WorkspaceHead | null> {
    const guard = this.guard, c = this.context
    if (!c.attemptId || guard.stale) return null
    const seq = guard.nextReadSeq('workspace-head')
    try {
      const value = await apiGet<unknown>(`/attempts/${encodeURIComponent(c.attemptId)}`, this.opts())
      if (!this.valid(guard)) return null
      const head = await verifyHead(value, c, c.courseId)
      if (!guard.acceptRead('workspace-head', seq) || !this.valid(guard)) return null
      const current = () => this.valid(guard) && guard.isAcceptedRead('workspace-head', seq)
      const workspace = await confirmationRepository.installHead(c, workspaceOf(head), current)
      if (!current()) return null
      if (workspace.workspaceRevision !== head.attempt.workspaceRevision) {
        this.publish({ workspace, attempt: null, error: '此读取早于已确认作品，请重新读取权威 Attempt。', phase: 'unknown' })
        return null
      }
      // C2 清单按 ID 排列，不代表创建先后；同时间时保留本次明确冻结的选择。
      const latest = [...head.snapshots].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        (a.snapshotId === this.state.snapshot?.snapshotId ? -1 : b.snapshotId === this.state.snapshot?.snapshotId ? 1 : a.snapshotId.localeCompare(b.snapshotId)))[0] ?? null
      this.publish({ workspace, attempt: head.attempt, snapshot: latest,
        phase: this.state.pending ? this.state.phase : ['submitted', 'reviewed'].includes(head.attempt.status) ? 'readonly' : 'ready' })
      return head
    } catch (e) {
      if (this.valid(guard) && (guard.isAcceptedRead('workspace-head', seq) || guard.acceptRead('workspace-head', seq))) this.publish({ error: `权威 Attempt 读取失败：${errorText(e)}`, phase: 'error', attempt: null })
      return null
    }
  }
  async openAttempt(): Promise<void> {
    if (this.busy || this.state.pending || this.guard.stale) return
    if (this.context.attemptId) { await this.readHead(); return }
    const guard = this.guard
    this.busy = true; this.publish({ phase: 'saving', error: null })
    try {
      const command = await freezeAttempt(this.context)
      if (!this.valid(guard)) return
      await confirmationRepository.persist(command, () => this.valid(guard))
      if (!this.valid(guard)) return
      await this.send(command, guard)
    } catch (e) { if (this.valid(guard)) this.publish({ phase: 'error', error: `原请求未能保护：${errorText(e)}` }) }
    finally { this.busy = false }
  }
  /** 后续只读比较/运行复用同一快照读取与上下文守卫，不建立第二份确认状态。 */
  async readSnapshot(snapshotId: string): Promise<SnapshotView | null> {
    const guard = this.guard, c = this.context
    if (!c.attemptId || !c.activityVersionId || guard.stale) return null
    const key = `snapshot:${snapshotId}`, seq = guard.nextReadSeq(key)
    const value = await apiGet<unknown>(`/attempts/${encodeURIComponent(c.attemptId)}/snapshots/${encodeURIComponent(snapshotId)}`, this.opts())
    if (!this.valid(guard)) return null
    const snapshot = await verifySnapshot(value, c.attemptId, c.activityVersionId)
    if (snapshot.snapshotId !== snapshotId) throw new Error('快照 ID 不符')
    return this.valid(guard) && guard.acceptRead(key, seq) ? snapshot : null
  }
  async save(drafts: FrozenDraft[]): Promise<void> {
    if (this.busy || this.state.pending || !this.state.workspace || !this.state.attempt || this.guard.stale) return
    if (['submitted', 'reviewed'].includes(this.state.attempt.status)) return
    if (this.state.attempt.status === 'paused' && drafts.some(d => !d.serverFileId)) {
      this.publish({ phase: 'error', error: '暂停期间只可确认已有 active 文件正文' }); return
    }
    const guard = this.guard
    this.busy = true; this.publish({ phase: 'saving', error: null })
    try {
      const seq = await confirmationRepository.reserveSeq(this.context, this.clientId)
      if (!this.valid(guard)) return
      const command = await freezeSync(this.context, this.state.workspace, drafts, this.clientId, seq)
      if (!this.valid(guard)) return
      await confirmationRepository.persist(command, () => this.valid(guard))
      if (!this.valid(guard)) return
      await this.send(command, guard)
    } catch (e) { if (this.valid(guard)) this.publish({ phase: 'error', error: `原请求未能保护：${errorText(e)}` }) }
    finally { this.busy = false }
  }
  async snapshot(): Promise<void> {
    if (this.busy || this.state.pending || !this.state.workspace || !this.state.attempt || this.guard.stale) return
    if (['submitted', 'reviewed'].includes(this.state.attempt.status)) return
    const guard = this.guard
    this.busy = true; this.publish({ phase: 'saving', error: null })
    try {
      const command = await freezeSnapshot(this.context, this.state.workspace)
      if (!this.valid(guard)) return
      await confirmationRepository.persist(command, () => this.valid(guard))
      if (!this.valid(guard)) return
      await this.send(command, guard)
    } catch (e) { if (this.valid(guard)) this.publish({ phase: 'error', error: `原请求未能保护：${errorText(e)}` }) }
    finally { this.busy = false }
  }
  async retry(): Promise<void> {
    if (this.busy || !this.state.pending || this.guard.stale) return
    const guard = this.guard, original = this.state.pending
    if (!sameGeneration(original.context, this.context)) { this.publish({ error: '原请求归属或代际已失效，不能改键补做。' }); return }
    this.busy = true; this.publish({ phase: 'saving', error: null })
    try { await this.send(original, guard) } finally { this.busy = false }
  }
  private async send(command: FrozenCommand, captured: ContextGuard): Promise<void> {
    let receipt: Receipt | null = null
    const valid = () => this.valid(captured) && sameGeneration(command.context, this.context)
    this.publish({ pending: { ...command, state: 'pending' }, phase: 'saving' })
    try {
      const original = await confirmationRepository.claim(command.commandKey, this.leaseOwner, valid)
      if (!valid()) return
      // 每次发送读取当前有效 Session/CSRF；原正文和业务键保持不变。
      const session = await apiGet<SessionView>('/session', this.opts())
      if (!valid()) return
      if (session.userId !== command.context.userId || !session.courses.some(c => c.courseId === command.context.courseId && c.role === 'student') || !session.csrfToken) throw new Error('当前 Session 与原命令身份不符，停止发送')
      setCsrfToken(session.csrfToken)
      const response = await apiPostFrozen<unknown>(command.path, original.wireJson, { ...this.opts(), idempotencyKey: command.commandKey })
      // 即使已失效，仍核旧回执并仅写原命令的历史事实。
      receipt = verifyReceipt(command, response)
      if (!valid()) {
        await confirmationRepository.acknowledge(command, receipt, null, {}, null, () => false)
        return
      }
      let workspace: ConfirmedWorkspace | null = null, mappings: Record<string, string> = {}, snapshot: SnapshotView | null = null
      if (command.kind === 'workspace.sync') {
        const verified = await verifySyncReceipt(command, receipt)
        if (!valid()) { await confirmationRepository.acknowledge(command, receipt, null, {}, null, () => false); return }
        workspace = verified.workspace; mappings = verified.mappings
      } else if (command.kind === 'snapshot.create') {
        const r = verifyReceipt<SnapshotResult>(command, receipt)
        const value = await this.readSnapshot(r.result.snapshotId)
        if (!valid()) { await confirmationRepository.acknowledge(command, receipt, null, {}, null, () => false); return }
        snapshot = (await verifySnapshotReceipt(command, receipt, value)).snapshot
        if (!valid()) { await confirmationRepository.acknowledge(command, receipt, null, {}, null, () => false); return }
      } else verifyAttemptReceipt(command, receipt)
      // ACK 是新的权威接纳点，屏蔽此前启动但尚未返回的 GET。
      captured.acceptRead('workspace-head', captured.nextReadSeq('workspace-head'))
      const confirmed = await confirmationRepository.acknowledge(command, receipt, workspace, mappings, snapshot, valid)
      if (!valid()) return
      const accepted = await confirmationRepository.command(command.commandKey)
      if (!valid()) return
      const acceptedContext = command.kind === 'attempt.create'
        ? { ...command.context, attemptId: verifyAttemptReceipt(command, receipt).result.attemptId } : command.context
      const authorityCurrent = await confirmationRepository.isCurrentAuthority(acceptedContext)
      if (!valid()) return
      if ((accepted?.state === 'historical' && confirmed === null) || !authorityCurrent) {
        this.publish({ pending: null, phase: 'error', workspace: null, attempt: null, snapshot: null,
          error: '另一标签已推进受信代际：旧回执只保留历史，请重新读取并比较草稿。' })
        return
      }
      this.publish({ pending: null, workspace: confirmed ?? this.state.workspace, snapshot: snapshot ?? this.state.snapshot,
        attempt: null, error: null, phase: 'ready' })
      if (command.kind === 'attempt.create') this.bindAttempt(verifyAttemptReceipt(command, receipt).result.attemptId)
      this.channel?.postMessage(this.context)
      // 不猜 attemptRevision：保存/快照均重读原公开 GET。
      await this.readHead()
    } catch (e) {
      if (!valid()) return
      const localFailure = receipt !== null && !(e instanceof WorkspaceRequestError)
      const rejected = e instanceof WorkspaceRequestError && e.failure.kind === 'api'
      this.publish({ phase: localFailure ? 'local-failed' : rejected ? 'error' : 'unknown',
        error: `${localFailure ? '服务回执已收到，本机确认记录未完成' : rejected ? '服务拒绝原请求' : '原请求结果待核对'}：${errorText(e)}` })
    } finally {
      // 租约释放只更新原 outbox，不写当前作品；失败时保留有期限租约，原命令仍可核对。
      await confirmationRepository.release(command.commandKey, this.leaseOwner).catch(() => {})
    }
  }
}
