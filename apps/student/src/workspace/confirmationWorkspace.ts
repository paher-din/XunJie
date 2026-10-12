import { ContextGuard, nextLoadEpoch } from './context'
import { verifyHead, verifySnapshot, workspaceOf } from './confirmation'
import { confirmationRepository, sameGeneration } from './confirmationDb'
import { freezeAttempt, freezeSnapshot, freezeSync, verifyAttemptReceipt, verifySyncReceipt, verifyReceipt, verifySnapshotReceipt,
  type CommandContext, type FrozenCommand, type FrozenDraft, type OutboxRecord } from './frozenCommand'
import { apiGet, apiPostFrozen, setCsrfToken, type RequestOptions } from './http'
import { classifyWriteFailure, codeOfOutcome, outcomeMessage, reconcileStoredCommand, summarizeOriginalRequest,
  type CommandOutcome, type OriginalRequestSummary } from './recovery'
import type { SessionView } from './contracts'
import type { AttemptView, ConfirmedWorkspace, Receipt, SnapshotResult, SnapshotView, WorkspaceHead } from './workspaceContracts'

export type ConfirmationPhase =
  | 'idle' | 'loading' | 'ready' | 'saving' | 'local-failed' | 'unknown' | 'error' | 'readonly'
  /** 04：服务明确拒绝原命令，正文保留、停止重放。 */
  | 'rejected'
  /** 04：VERSION_CONFLICT，明确比较与选择属 04A。 */
  | 'conflict'
  /** 04：受信代际已变化，停止旧重试并重读受信上下文。 */
  | 'recovery-required'

export interface ConfirmationState {
  phase: ConfirmationPhase; workspace: ConfirmedWorkspace | null; attempt: AttemptView | null
  snapshot: SnapshotView | null; pending: OutboxRecord | null; error: string | null
  /** 原命令的核对结论（未知/已拒绝/版本冲突/代际已变/已确认/历史），决定能否重放。 */
  outcome: CommandOutcome | null
  /** 冻结原请求的可核对事实；不含当前草稿，也不含任何凭据。 */
  original: OriginalRequestSummary | null
}
const initialState = (): ConfirmationState => ({ phase: 'idle', workspace: null, attempt: null, snapshot: null, pending: null, outcome: null, original: null, error: null })
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)

/**
 * 当前工作区该展示哪一条未决原命令。
 *
 * 先要同一代际的；没有时只看**同一 Attempt** 的旧代际记录（例如准备进程重启／恢复换代际后，原请求
 * 仍是本 Attempt 的事实）。绝不回退到别的 Attempt 或别的账号：那会把别处的工作区锁住并展示错误事实。
 */
function currentPendingRow(rows: OutboxRecord[], context: CommandContext): OutboxRecord | null {
  const ordered = [...rows].sort((a, b) => b.createdAt - a.createdAt)
  return ordered.find(r => sameGeneration(r.context, context)) ??
    ordered.find(r => r.context.attemptId === context.attemptId) ?? null
}

/**
 * 一条未决原命令相对**当前**上下文应展示的结论。
 *
 * 必须用当前上下文比对：归属/代际不一致正是「停止旧重试」的依据，用记录自己的上下文会让
 * 这条判定永远成立。
 */
function outcomeOf(row: OutboxRecord, context: CommandContext): CommandOutcome {
  const decision = reconcileStoredCommand(row, context)
  return decision.action === 'stop' ? decision.outcome : { kind: 'unresolved' }
}

/** 核对结论到可见阶段：断线与租约占用都保持「未知」，不冒充拒绝或成功。 */
export function phaseFor(outcome: CommandOutcome): ConfirmationPhase {
  switch (outcome.kind) {
    case 'unresolved':
    case 'lease-held': return 'unknown'
    case 'local-failed': return 'local-failed'
    case 'rejected': return 'rejected'
    case 'conflict': return 'conflict'
    case 'recovery-required': return 'recovery-required'
    // 已确认通常由 acceptLocal/reconcile 直接处理；这里保留分支是为了让映射对整个结论集完备。
    case 'confirmed': return 'ready'
    case 'historical': return 'error'
  }
}

/** 03 共同客户端：原命令串行，head/快照来自同一 HTTP 层，所有接纳核当前上下文。 */
export class ConfirmationWorkspace {
  private guard: ContextGuard
  private state = initialState()
  private readonly clientId = crypto.randomUUID()
  private readonly leaseOwner = crypto.randomUUID()
  private busy = false
  /** 本次载入发现的上下文变化提示（例如准备进程换代际）；与结论说明合并显示，直到下一次载入。 */
  private contextNotice: string | null = null
  private channel: BroadcastChannel | null = null
  private readonly listeners = new Set<(state: ConfirmationState) => void>()
  constructor(context: CommandContext) {
    this.guard = new ContextGuard(context)
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel('xunjie-i0-confirmation')
      this.channel.onmessage = event => {
        const c = event.data as CommandContext | null
        if (c && sameGeneration(c, this.context) && !this.guard.stale) {
          // 另一标签可能已核对同一原命令或推进确认头：先核原命令事实，再重读 head。
          void this.refreshPending()
          void this.readHead()
        }
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
    this.contextNotice = null
    this.state = initialState()
  }
  /** 结论说明与上下文变化提示一起显示，避免后写入的一条把另一条事实抹掉。 */
  private withNotice(text: string): string {
    return this.contextNotice ? `${this.contextNotice} · ${text}` : text
  }
  /**
   * 展示一条未决原命令的结论。
   *
   * 租约不参与这里的判定：租约未过期只说明有标签正在核对，学生仍应能尝试核对（真正的拦截在
   * 本机事务 claim）。`busy` 时不覆盖正在进行的保存/核对阶段。
   */
  private async publishPending(row: OutboxRecord, outcome = outcomeOf(row, this.context)): Promise<void> {
    this.publish({ pending: row, outcome, original: await summarizeOriginalRequest(row),
      phase: this.busy ? this.state.phase : phaseFor(outcome), error: this.withNotice(outcomeMessage(outcome)) })
  }
  /** 落盘事实与当前展示完全一致：另一标签的例行广播不必重算可见状态。 */
  private pendingUnchanged(row: OutboxRecord, outcome: CommandOutcome): boolean {
    const current = this.state.pending
    return !!current && !row.receipt && !row.rejected && current.commandKey === row.commandKey &&
      current.state === row.state && current.lease?.owner === row.lease?.owner && this.state.outcome?.kind === outcome.kind
  }
  /** 内存里的 pending 可能已被另一标签推进（确认/拒绝/换代），以落盘记录为准刷新结论。 */
  private async refreshPending(): Promise<void> {
    const guard = this.guard
    const commands = await confirmationRepository.commands(this.context)
    if (!this.valid(guard)) return
    const row = currentPendingRow(commands.filter(r => r.state === 'pending'), this.context)
    if (!row) {
      if (this.state.pending) this.publish({ pending: null, outcome: null, original: null, error: null,
        phase: this.state.workspace ? 'ready' : this.state.phase })
      return
    }
    if (this.pendingUnchanged(row, outcomeOf(row, this.context))) return
    await this.publishPending(row)
  }
  async initialize(): Promise<void> {
    let guard = this.guard
    this.publish({ phase: 'loading' })
    try {
      const reference = await confirmationRepository.reference(this.context)
      if (!this.valid(guard)) return
      if (reference.changed) {
        this.contextNotice = '准备上下文已改变：旧草稿保留，须重新比较；旧确认缓存与原请求不能当当前作品'
        this.publish({ error: this.contextNotice })
      }
      if (!this.context.attemptId && reference.attemptId) { this.bindAttempt(reference.attemptId); guard = this.guard }
      if (this.context.attemptId) await this.readHead()
      else this.publish({ phase: 'idle' })
      if (!this.valid(guard)) return
      const commands = await confirmationRepository.commands(this.context)
      if (!this.valid(guard)) return
      // 同一代际的未决原命令优先；同 Attempt 的旧代际记录只作为事实保留，不自动重放、不迁代际。
      const row = currentPendingRow(commands.filter(r => r.state === 'pending'), this.context)
      if (row) await this.publishPending(row)
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
  /**
   * 核对原请求：以落盘记录决定「原样重放」「本机重新接纳同一回执」或「停止」。
   *
   * 不会换业务键、不会改业务输入、不会为迟到结果补发新命令；已确认或已被拒绝时只重读权威 head。
   */
  async retry(): Promise<void> {
    if (this.busy || this.guard.stale) return
    const guard = this.guard, known = this.state.pending
    if (!known) return
    this.busy = true
    try {
      const stored = await confirmationRepository.command(known.commandKey)
      if (!this.valid(guard)) return
      if (!stored) {
        this.publish({ pending: null, outcome: null, original: null, phase: 'ready', error: null })
        await this.readHead()
        return
      }
      const decision = reconcileStoredCommand(stored, this.context, { owner: this.leaseOwner })
      if (decision.action === 'accept-local') {
        await this.publishPending(stored)
        await this.acceptLocal(stored, guard)
        return
      }
      if (decision.action === 'stop') {
        // 用领取租约时的真实结论（可能是「另一标签正在核对」），不能回退成「未知」。
        await this.publishPending(stored, decision.outcome)
        return
      }
      if (decision.action === 'none') {
        this.publish({ pending: null, outcome: null, original: null, phase: 'ready', error: null })
        await this.readHead()
        return
      }
      await this.send(stored, guard)
    } catch (e) {
      if (this.valid(guard)) this.publish({ phase: 'error', error: `核对原请求失败：${errorText(e)}` })
    } finally { this.busy = false }
  }
  /** 原命令已由本机或另一标签确认：不重发，只在本机重新接纳同一回执并重读当前 head。 */
  private async acceptLocal(record: OutboxRecord, captured: ContextGuard): Promise<void> {
    const receipt = record.receipt
    if (!receipt) { this.publish({ phase: 'error', error: '原命令缺少回执，不能只在本机接纳' }); return }
    const valid = () => this.valid(captured) && sameGeneration(record.context, this.context)
    let workspace: ConfirmedWorkspace | null = null, mappings: Record<string, string> = {}, snapshot: SnapshotView | null = null
    if (record.kind === 'workspace.sync') {
      const verified = await verifySyncReceipt(record, receipt)
      if (!valid()) return
      workspace = verified.workspace; mappings = verified.mappings
    } else if (record.kind === 'snapshot.create') {
      const value = await this.readSnapshot((receipt.result as SnapshotResult).snapshotId)
      if (!valid()) return
      snapshot = (await verifySnapshotReceipt(record, receipt, value)).snapshot
      if (!valid()) return
    } else verifyAttemptReceipt(record, receipt)
    const confirmed = await confirmationRepository.acknowledge(record, receipt, workspace, mappings, snapshot, valid)
    if (!valid()) return
    this.publish({ pending: null, outcome: null, original: null, workspace: confirmed ?? this.state.workspace,
      snapshot: snapshot ?? this.state.snapshot, attempt: null, error: null, phase: 'ready' })
    if (record.kind === 'attempt.create') this.bindAttempt((receipt.result as { attemptId: string }).attemptId)
    this.channel?.postMessage(this.context)
    await this.readHead()
  }
  private async send(command: FrozenCommand, captured: ContextGuard): Promise<void> {
    let receipt: Receipt | null = null
    const valid = () => this.valid(captured) && sameGeneration(command.context, this.context)
    const original = await summarizeOriginalRequest(command)
    if (this.guard.stale) return
    this.publish({ pending: { ...command, state: 'pending' }, outcome: { kind: 'unresolved' }, original,
      phase: 'saving', error: null })
    try {
      const stored = await confirmationRepository.claim(command.commandKey, this.leaseOwner, valid)
      if (!valid()) return
      // 每次发送读取当前有效 Session/CSRF；原正文和业务键保持不变。
      const session = await apiGet<SessionView>('/session', this.opts())
      if (!valid()) return
      if (session.userId !== command.context.userId || !session.courses.some(c => c.courseId === command.context.courseId && c.role === 'student') || !session.csrfToken) throw new Error('当前 Session 与原命令身份不符，停止发送')
      setCsrfToken(session.csrfToken)
      const response = await apiPostFrozen<unknown>(command.path, stored.wireJson, { ...this.opts(), idempotencyKey: command.commandKey })
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
        this.publish({ pending: null, outcome: null, original: null, phase: 'error', workspace: null, attempt: null, snapshot: null,
          error: '另一标签已推进受信代际：旧回执只保留历史，请重新读取并比较草稿。' })
        return
      }
      this.publish({ pending: null, outcome: null, original: null, workspace: confirmed ?? this.state.workspace,
        snapshot: snapshot ?? this.state.snapshot, attempt: null, error: null, phase: 'ready' })
      if (command.kind === 'attempt.create') this.bindAttempt(verifyAttemptReceipt(command, receipt).result.attemptId)
      this.channel?.postMessage(this.context)
      // 不猜 attemptRevision：保存/快照均重读原公开 GET。
      await this.readHead()
    } catch (e) {
      if (!valid()) return
      let outcome = classifyWriteFailure(e, { receiptReceived: receipt !== null })
      if (outcome.kind === 'confirmed') {
        // 核对与领取租约之间另一标签已确认同一原命令：不重发，改走本机重新接纳。
        const stored = await confirmationRepository.command(command.commandKey).catch(() => null)
        if (!this.valid(captured)) return
        if (stored?.receipt) { await this.acceptLocal(stored, captured); return }
        outcome = { kind: 'unresolved' }
      }
      // 服务明确拒绝的事实写回原命令：刷新、换标签后仍是同一结论，不靠内存记忆。
      // 写失败只是少一条本机事实，不影响已经得出的结论，因此不让它掩盖原始错误。
      const code = codeOfOutcome(outcome)
      if (receipt === null && code !== null) {
        await confirmationRepository.noteRejection(command.commandKey, code, this.leaseOwner).catch(() => {})
      }
      const stored = await confirmationRepository.command(command.commandKey).catch(() => null)
      if (!this.valid(captured)) return
      this.publish({ pending: stored ?? this.state.pending, outcome, phase: phaseFor(outcome),
        original: stored ? await summarizeOriginalRequest(stored) : this.state.original,
        error: this.withNotice(`${outcomeMessage(outcome)}：${errorText(e)}`) })
    } finally {
      // 租约释放只更新原 outbox，不写当前作品；失败时保留有期限租约，原命令仍可核对。
      await confirmationRepository.release(command.commandKey, this.leaseOwner).catch(() => {})
    }
  }
}
