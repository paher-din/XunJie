import { ContextGuard, nextLoadEpoch } from './context'
import { verifyHead, verifySnapshot, workspaceOf } from './confirmation'
import { confirmationRepository, sameGeneration } from './confirmationDb'
import { freezeAttempt, freezeSnapshot, freezeSync, verifyAttemptReceipt, verifySyncReceipt, verifyReceipt, verifySnapshotReceipt,
  type CommandContext, type FrozenCommand, type FrozenDraft, type OutboxRecord } from './frozenCommand'
import { apiGet, apiPostFrozen, setCsrfToken, type RequestOptions } from './http'
import { buildWorkspaceComparison, type WorkspaceComparison } from './comparison'
import { blocksNewSave, classifyWriteFailure, codeOfOutcome, diagnosticText, reconcileStoredCommand, studentHint,
  summarizeOriginalRequest, type CommandOutcome } from './recovery'
import { describeError, reportDiagnostic } from './diagnostics'
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
  /** 04：上一次保存属于旧代际且已被服务拒绝：不会生效，学生可以重新保存。 */
  | 'stale'
  /** 05：服务明确拒绝且整批未生效（例如恢复时路径已被占用）：先重新读取，再用新命令保存。 */
  | 'not-applied'

/**
 * 学生可见状态。\`error\` 只放学生能懂、能行动的一句话；技术事实（错误码、命令键、代际、ID/hash、
 * 服务原文、HTTP 状态）只进控制台，见 \`diagnostics.ts\`。
 */
export interface ConfirmationState {
  phase: ConfirmationPhase; workspace: ConfirmedWorkspace | null; attempt: AttemptView | null
  snapshot: SnapshotView | null; pending: OutboxRecord | null; error: string | null
  /** 原命令的核对结论（未知/已拒绝/版本冲突/代际已变/已确认/历史），决定能否重放。 */
  outcome: CommandOutcome | null
  /** 04A：当前打开的只读比较（本机原文/原确认基线/新服务正文）；null = 没有打开。 */
  comparison: WorkspaceComparison | null
  /**
   * 05：当前权威 head 里已核验的全部快照（`verifyHead` 已逐个核验清单与摘要）。
   *
   * 只读版本比较直接用这份已核验投影，不再另发请求：比较因此不可能产生写副作用，
   * 也不会因为多读一次而改变任何摘要。
   */
  snapshots: SnapshotView[]
}
const initialState = (): ConfirmationState => ({ phase: 'idle', workspace: null, attempt: null, snapshot: null, pending: null, outcome: null, error: null, comparison: null, snapshots: [] })

/**
 * 当前工作区该展示哪一条未决原命令。
 *
 * 先要同一代际的；没有时只看**同一 Attempt** 的旧代际记录（例如准备进程重启／恢复换代际后，原请求
 * 仍是本 Attempt 的事实）。绝不回退到别的 Attempt 或别的账号：那会把别处的工作区锁住并展示错误事实。
 */
function currentPendingRow(rows: OutboxRecord[], context: CommandContext): OutboxRecord | null {
  const ordered = rows.filter(r => r.kind !== 'run.create' && r.kind !== 'job.cancel').sort((a, b) => b.createdAt - a.createdAt)
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
    case 'historical': return 'stale'
    // 确定没有生效，路径/状态要对齐的是服务端当前事实：与 historical 一样放行新保存。
    case 'state-conflict': return 'not-applied'
    // 服务已接收、本机没记录：需要先重新读取，学生对它的动作与「工作区过期」一样。
    case 'superseded': return 'recovery-required'
    // 业务键冲突是终态拒绝的一种，但结论单列；界面沿用「保存未成功」状态，区别在提示文案。
    case 'key-conflict': return 'rejected'
  }
}

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
  /** 06 复用这个上下文守卫，不新建会使确认客户端失效的第二个 guard。 */
  isCurrent(context: CommandContext): boolean { return this.context === context && !this.guard.stale }
  get commandInFlight(): boolean { return this.busy }
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
  /**
   * 展示一条未决原命令的结论。
   *
   * 租约不参与这里的判定：租约未过期只说明有标签正在核对，学生仍应能尝试核对（真正的拦截在
   * 本机事务 claim）。\`busy\` 时不覆盖正在进行的保存/核对阶段。
   */
  private async publishPending(row: OutboxRecord, outcome = outcomeOf(row, this.context)): Promise<void> {
    // 具体结论优先于「工作区已重新加载」这类泛化提示：只给学生一句。
    this.publish({ pending: row, outcome, phase: this.busy ? this.state.phase : phaseFor(outcome),
      error: studentHint(outcome) })
    // 学生界面只留一句话；命令身份、冻结输入、代际与结论原文进控制台排障。
    reportDiagnostic('command.reconciled', { outcome: outcome.kind, reason: diagnosticText(outcome),
      ...await summarizeOriginalRequest(row) })
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
      if (this.state.pending) this.publish({ pending: null, outcome: null, error: null,
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
      // 成功载入的上下文也要留痕：刷新后控制台只剩本次载入事实，落盘事实仍在 outbox 里。
      reportDiagnostic('context.loaded', { mode: this.context.mode, userId: this.context.userId,
        assignmentId: this.context.assignmentId, activityVersionId: this.context.activityVersionId,
        attemptId: this.context.attemptId, recoveryGeneration: this.context.trustedRecoveryGeneration,
        preparationEpoch: this.context.preparationEpoch, loadEpoch: this.context.loadEpoch,
        referenceChanged: reference.changed === true,
        missingTrustedGeneration: !this.context.trustedRecoveryGeneration })
      if (reference.changed) {
        // 没有更具体的未决原命令时，学生至少要知道「草稿还在、要先重新读取」。
        reportDiagnostic('context.changed', { reason: 'local attempt reference belongs to another recovery generation',
          attemptId: this.context.attemptId, recoveryGeneration: this.context.trustedRecoveryGeneration,
          preparationEpoch: this.context.preparationEpoch })
        this.publish({ error: '工作区已重新加载，草稿保留；请重新读取后再保存。' })
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
    } catch (e) {
      reportDiagnostic('workspace.initialize-failed', { reason: 'workspace initialize failed', error: describeError(e) })
      if (this.valid(guard)) this.publish({ phase: 'error', error: '工作区没有读取成功，请重新读取。' })
    }
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
        this.publish({ workspace, attempt: null, error: '读取到的是较早的版本，请重新读取。', phase: 'unknown' })
        return null
      }
      // C2 清单按 ID 排列，不代表创建先后；同时间时保留本次明确冻结的选择。
      const latest = [...head.snapshots].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
        (a.snapshotId === this.state.snapshot?.snapshotId ? -1 : b.snapshotId === this.state.snapshot?.snapshotId ? 1 : a.snapshotId.localeCompare(b.snapshotId)))[0] ?? null
      this.publish({ workspace, attempt: head.attempt, snapshot: latest, snapshots: head.snapshots,
        phase: this.state.pending ? this.state.phase : ['submitted', 'reviewed'].includes(head.attempt.status) ? 'readonly' : 'ready' })
      return head
    } catch (e) {
      reportDiagnostic('workspace.read-failed', { reason: 'authority attempt read failed', attemptId: c.attemptId, error: describeError(e) })
      if (this.valid(guard) && (guard.isAcceptedRead('workspace-head', seq) || guard.acceptRead('workspace-head', seq))) {
        this.publish({ error: '作品没有读取成功，请重新读取。', phase: 'error', attempt: null })
      }
      return null
    }
  }
  /**
   * 04A：打开只读比较。先重读当前获准 head，再从落盘原命令（本机原文 + 原确认基线）与
   * 重读结果（新服务正文）构造比较；head 读不到就如实不可用，不拿旧缓存冒充。
   */
  async openComparison(commandKey: string): Promise<void> {
    if (this.busy || this.guard.stale) return
    const guard = this.guard
    this.busy = true
    try {
      // commands() 已按归属过滤，避免把别的账号/模式的记录拿来比较。
      const stored = (await confirmationRepository.commands(this.context)).find(c => c.commandKey === commandKey)
      if (!this.valid(guard)) return
      if (!stored) {
        this.publish({ error: '这条保存记录在本机读不到了，请重新读取。', comparison: null })
        return
      }
      const head = await this.readHead()
      if (!this.valid(guard)) return
      if (!head || !this.state.workspace) {
        this.publish({ error: '当前作品没有读取成功，暂时不能比较。请重新读取后再试。', comparison: null })
        return
      }
      // 旧代际且已有拒绝事实的，结果是已知的恢复比较；没有拒绝事实的才是「结果未知」。
      const source = sameGeneration(stored.context, this.context) ? 'version-conflict'
        : stored.rejected ? 'recovery' : 'unresolved'
      reportDiagnostic('comparison.opened', { commandKey, source, files: stored.drafts.map(d => d.path) })
      this.publish({ comparison: buildWorkspaceComparison(stored, this.state.workspace, source), error: null })
    } catch (e) {
      reportDiagnostic('command.failed', { reason: 'comparison failed', error: describeError(e) })
      if (this.valid(guard)) this.publish({ error: '比较没有准备好，请重新读取后再试。', comparison: null })
    } finally { this.busy = false }
  }
  closeComparison(): void {
    if (this.state.comparison) this.publish({ comparison: null })
  }
  /**
   * 04A：学生已在比较中明确选择。退役这条冲突原命令（拒绝/旧事实保留在记录上），
   * 不迁代际、不换键补发；新的保存由学生随后以新键与当前权威预期版本发起。
   */
  async resolveConflict(commandKey: string): Promise<'retired' | 'unchanged'> {
    if (this.guard.stale) return 'unchanged'
    const guard = this.guard
    try {
      const result = await confirmationRepository.retireResolved(commandKey, this.context, this.leaseOwner)
      if (!this.valid(guard)) return 'unchanged'
      reportDiagnostic('command.resolved', { commandKey, result })
      if (result === 'retired') {
        this.publish({ comparison: null, pending: null, outcome: null, error: null,
          phase: this.state.workspace ? 'ready' : this.state.phase })
        this.channel?.postMessage(this.context)
      }
      return result
    } catch (e) {
      reportDiagnostic('command.failed', { reason: 'conflict resolution failed', error: describeError(e) })
      if (this.valid(guard)) this.publish({ error: '这次处理没有完成，请重新读取后再试。' })
      return 'unchanged'
    }
  }
  async openAttempt(): Promise<void> {
    if (this.busy || blocksNewSave(this.state.outcome) || this.guard.stale) return
    if (this.context.attemptId) { await this.readHead(); return }
    const guard = this.guard
    this.busy = true; this.publish({ phase: 'saving', error: null })
    try {
      const command = await freezeAttempt(this.context)
      if (!this.valid(guard)) return
      await confirmationRepository.persist(command, () => this.valid(guard))
      if (!this.valid(guard)) return
      await this.send(command, guard)
    } catch (e) { this.failLocally(guard, 'attempt command not protected', e, '工作区没有建好，请稍后重试。') }
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
    // 旧代际且已明确被拒的原命令不挡新保存：学生用新键在当前代际重新保存，不是迁旧请求。
    if (this.busy || blocksNewSave(this.state.outcome) || !this.state.workspace || !this.state.attempt || this.guard.stale) return
    if (['submitted', 'reviewed'].includes(this.state.attempt.status)) return
    // 暂停期间服务端只接受已有 active 文件的 update：新建与回收/恢复都会被整批拒绝，客户端先挡下来，
    // 否则学生会看到一条注定失败的「上一次操作没有生效」。判定用**确认清单里的生命周期**，
    // 与草稿带的学生意图比对——恢复意图同样发不出去。
    if (this.state.attempt.status === 'paused') {
      const wantsLifecycleChange = drafts.some(d =>
        (d.lifecycle ?? 'active') !== (this.state.workspace!.files.find(f => f.fileId === d.serverFileId)?.lifecycle ?? 'active'))
      if (drafts.some(d => !d.serverFileId) || wantsLifecycleChange) {
        this.publish({ phase: 'error', error: '暂停期间只能保存已有文件的修改。' }); return
      }
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
    } catch (e) { this.failLocally(guard, 'sync command not protected', e, this.freezeHint(e, '保存')) }
    finally { this.busy = false }
  }
  async snapshot(): Promise<void> {
    if (this.busy || blocksNewSave(this.state.outcome) || !this.state.workspace || !this.state.attempt || this.guard.stale) return
    if (['submitted', 'reviewed'].includes(this.state.attempt.status)) return
    const guard = this.guard
    this.busy = true; this.publish({ phase: 'saving', error: null })
    try {
      const command = await freezeSnapshot(this.context, this.state.workspace)
      if (!this.valid(guard)) return
      await confirmationRepository.persist(command, () => this.valid(guard))
      if (!this.valid(guard)) return
      await this.send(command, guard)
    } catch (e) { this.failLocally(guard, 'snapshot command not protected', e, this.freezeHint(e, '冻结')) }
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
        this.publish({ pending: null, outcome: null, phase: 'ready', error: null })
        await this.readHead()
        return
      }
      const decision = reconcileStoredCommand(stored, this.context, { owner: this.leaseOwner })
      reportDiagnostic('command.reconciled', { action: decision.action, commandKey: stored.commandKey, kind: stored.kind,
        recoveryGeneration: stored.context.trustedRecoveryGeneration, leaseOwner: stored.lease?.owner })
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
        this.publish({ pending: null, outcome: null, phase: 'ready', error: null })
        await this.readHead()
        return
      }
      await this.send(stored, guard)
    } catch (e) {
      reportDiagnostic('command.failed', { reason: 'reconcile failed', error: describeError(e) })
      if (this.valid(guard)) this.publish({ phase: 'error', error: '重试没有完成，请再试一次。' })
    } finally { this.busy = false }
  }
  /** 原命令没能落盘时：不发请求，学生看到一句能行动的话，技术原因进控制台。 */
  private failLocally(guard: ContextGuard, reason: string, e: unknown, hint = '这次没有发出，请稍后重试。'): void {
    reportDiagnostic('command.failed', { reason, error: describeError(e) })
    if (this.valid(guard)) this.publish({ phase: 'error', error: hint })
  }
  /**
   * 冻结原命令失败时给学生的归因（原因原文进控制台）。
   *
   * 这些失败都发生在**发出请求之前**，所以不能承诺「稍后重试一定行」：
   * 内容/路径问题要学生自己改，状态过期要重新读取，内部核验失败则只能重新读取后再说。
   */
  private freezeHint(e: unknown, action: '保存' | '冻结'): string {
    const message = e instanceof Error ? e.message : String(e)
    if (message.includes('没有需要确认的修改')) return '没有需要保存的修改。'
    if (message.includes('需要重新比较') || message.includes('不在当前确认清单')) return '这件作品已经在别处更新，请重新读取后再保存。'
    // 05：两种只发生在冻结阶段、学生能直接处理的拒绝，必须给具体说法（见任务文档设计决定第 5 条）。
    if (message.includes('恢复路径被占用')) return '这个路径现在被另一个文件实例占用；先在它那一行回收，才能恢复这个实例。'
    if (message.includes('不能回收')) return '这个文件还没有确认保存过，不能回收。'
    // 正文与上限问题沿用编辑器里的同一套说法，学生改完就能保存。
    for (const problem of ['invalid-unicode', 'total-bytes', 'file-count', 'duplicate', 'separator', 'segment', 'drive', 'empty', 'not-allowed']) {
      if (message.includes(problem)) return `作品还不符合保存条件，请先按编辑器提示修改。`
    }
    if (message.includes('缺少身份或受信代际') || message.includes('H-03')) return '现在还不能保存这件作品。'
    return `这次${action}没有发出，请重新读取后再试。`
  }
  /** 原命令已由本机或另一标签确认：不重发，只在本机重新接纳同一回执并重读当前 head。 */
  private async acceptLocal(record: OutboxRecord, captured: ContextGuard): Promise<void> {
    const receipt = record.receipt
    if (!receipt) {
      reportDiagnostic('command.failed', { reason: 'accept-local without receipt', commandKey: record.commandKey })
      this.publish({ phase: 'error', error: '这次保存的结果在本机读不出来，请重新读取。' })
      return
    }
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
    this.publish({ pending: null, outcome: null, workspace: confirmed ?? this.state.workspace,
      snapshot: snapshot ?? this.state.snapshot, attempt: null, error: null, phase: 'ready' })
    reportDiagnostic('command.acknowledged', { commandKey: record.commandKey, kind: record.kind, receiptId: receipt.receiptId,
      serverSeq: receipt.serverSeq, acceptedLocallyAfterTheFact: true })
    if (record.kind === 'attempt.create') this.bindAttempt((receipt.result as { attemptId: string }).attemptId)
    this.channel?.postMessage(this.context)
    await this.readHead()
  }
  private async send(command: FrozenCommand, captured: ContextGuard): Promise<void> {
    let receipt: Receipt | null = null
    /** 回执已到、但回执/快照核验不通过：与学生可见的「本机没记完」分开表述。 */
    let verificationFailed = false
    const valid = () => this.valid(captured) && sameGeneration(command.context, this.context)
    /** 静默中止也要留痕：否则控制台只有 command.sent 而没有下文，无法判因。 */
    const abandon = (reason: string) => reportDiagnostic('command.abandoned',
      { reason, commandKey: command.commandKey, kind: command.kind, loadEpoch: this.guard.loadEpoch })
    const guardValid = (label: string): boolean => {
      if (valid()) return true
      abandon(label)
      return false
    }
    if (this.guard.stale) return
    // 学生只看一句话；命令身份与冻结输入进控制台。
    reportDiagnostic('command.sent', await summarizeOriginalRequest(command))
    this.publish({ pending: { ...command, state: 'pending' }, outcome: { kind: 'unresolved' },
      phase: 'saving', error: null })
    try {
      const stored = await confirmationRepository.claim(command.commandKey, this.leaseOwner, valid)
      if (!guardValid('context changed while claiming the lease')) return
      // 每次发送读取当前有效 Session/CSRF；原正文和业务键保持不变。
      const session = await apiGet<SessionView>('/session', this.opts())
      if (!guardValid('context changed while reading the session')) return
      if (session.userId !== command.context.userId || !session.courses.some(c => c.courseId === command.context.courseId && c.role === 'student') || !session.csrfToken) {
        throw new Error('当前 Session 与原命令身份不符，停止发送')
      }
      setCsrfToken(session.csrfToken)
      const response = await apiPostFrozen<unknown>(command.path, stored.wireJson, { ...this.opts(), idempotencyKey: command.commandKey })
      // 即使已失效，仍核旧回执并仅写原命令的历史事实。
      receipt = verifyReceipt(command, response)
      if (!valid()) {
        await confirmationRepository.acknowledge(command, receipt, null, {}, null, () => false)
        reportDiagnostic('command.historical', { commandKey: command.commandKey, kind: command.kind, receiptId: receipt.receiptId,
          reason: 'context changed before the receipt was accepted' })
        return
      }
      let workspace: ConfirmedWorkspace | null = null, mappings: Record<string, string> = {}, snapshot: SnapshotView | null = null
      const retire = async (reason: string) => {
        await confirmationRepository.acknowledge(command, receipt!, null, {}, null, () => false)
        reportDiagnostic('command.abandoned', { reason, commandKey: command.commandKey, kind: command.kind })
      }
      if (command.kind === 'workspace.sync') {
        const verified = await verifySyncReceipt(command, receipt)
        if (!valid()) { await retire('context changed while verifying the sync receipt'); return }
        workspace = verified.workspace; mappings = verified.mappings
      } else if (command.kind === 'snapshot.create') {
        try {
          const r = verifyReceipt<SnapshotResult>(command, receipt)
          const value = await this.readSnapshot(r.result.snapshotId)
          if (!valid()) { await retire('context changed while reading the frozen snapshot'); return }
          snapshot = (await verifySnapshotReceipt(command, receipt, value)).snapshot
          if (!valid()) { await retire('context changed while verifying the snapshot receipt'); return }
        } catch (error) {
          // 回执到了但拿不到可核验的快照：不当成功、也不当成「本机没记完」。
          verificationFailed = true
          throw error
        }
      } else verifyAttemptReceipt(command, receipt)
      // ACK 是新的权威接纳点，屏蔽此前启动但尚未返回的 GET。
      captured.acceptRead('workspace-head', captured.nextReadSeq('workspace-head'))
      const confirmed = await confirmationRepository.acknowledge(command, receipt, workspace, mappings, snapshot, valid)
      if (!guardValid('context changed while committing the acknowledgement')) return
      const accepted = await confirmationRepository.command(command.commandKey)
      if (!guardValid('context changed while re-reading the command fact')) return
      const acceptedContext = command.kind === 'attempt.create'
        ? { ...command.context, attemptId: verifyAttemptReceipt(command, receipt).result.attemptId } : command.context
      const authorityCurrent = await confirmationRepository.isCurrentAuthority(acceptedContext)
      if (!guardValid('context changed while checking the trusted authority')) return
      if ((accepted?.state === 'historical' && confirmed === null) || !authorityCurrent) {
        reportDiagnostic('command.historical', { commandKey: command.commandKey, kind: command.kind, receiptId: receipt.receiptId,
          reason: 'another tab advanced the trusted generation before this receipt was bound' })
        this.publish({ pending: null, outcome: null, phase: 'error', workspace: null, attempt: null, snapshot: null,
          error: '另一个标签页更新了作品，这里需要重新读取。' })
        return
      }
      reportDiagnostic('command.acknowledged', { commandKey: command.commandKey, kind: command.kind, receiptId: receipt.receiptId,
        serverSeq: receipt.serverSeq, replayed: receipt.replayed === true, workspaceRevision: workspace?.workspaceRevision })
      if (snapshot) {
        reportDiagnostic('snapshot.frozen', { snapshotId: snapshot.snapshotId, hash: snapshot.hash,
          workspaceRevision: snapshot.workspaceRevision, files: snapshot.files.map(f => ({ fileId: f.fileId, path: f.path,
            documentVersion: f.documentVersion, contentHash: f.contentHash })) })
      }
      this.publish({ pending: null, outcome: null, workspace: confirmed ?? this.state.workspace,
        snapshot: snapshot ?? this.state.snapshot, attempt: null, error: null, phase: 'ready' })
      if (command.kind === 'attempt.create') this.bindAttempt(verifyAttemptReceipt(command, receipt).result.attemptId)
      this.channel?.postMessage(this.context)
      // 不猜 attemptRevision：保存/快照均重读原公开 GET。
      await this.readHead()
    } catch (e) {
      if (!valid()) {
        reportDiagnostic('command.historical', { commandKey: command.commandKey, kind: command.kind,
          reason: 'send failed after the context changed', error: describeError(e) })
        return
      }
      let outcome = classifyWriteFailure(e, { receiptReceived: receipt !== null })
      if (outcome.kind === 'confirmed') {
        // 核对与领取租约之间另一标签已确认同一原命令：不重发，改走本机重新接纳。
        const stored = await confirmationRepository.command(command.commandKey).catch(() => null)
        if (!this.valid(captured)) return
        if (stored?.receipt) { await this.acceptLocal(stored, captured); return }
        outcome = { kind: 'unresolved' }
      }
      // 上面分支已各自上报；这里只补「核对期间被取代」这一类静默路径。
      // 服务明确拒绝的事实写回原命令：刷新、换标签后仍是同一结论，不靠内存记忆。
      // 写失败只是少一条本机事实，不影响已经得出的结论，因此不让它掩盖原始错误。
      const code = codeOfOutcome(outcome)
      if (receipt === null && code !== null) {
        await confirmationRepository.noteRejection(command.commandKey, code, this.leaseOwner).catch(() => {})
      }
      const stored = await confirmationRepository.command(command.commandKey).catch(() => null)
      if (!this.valid(captured)) return
      reportDiagnostic('command.failed', { commandKey: command.commandKey, kind: command.kind, outcome: outcome.kind,
        reason: diagnosticText(outcome), receiptReceived: receipt !== null,
        error: describeError(e),
        ...(e instanceof Error && 'failure' in e ? { httpFailure: (e as { failure: unknown }).failure } : {}) })
      this.publish({ pending: stored ?? this.state.pending, outcome, phase: phaseFor(outcome),
        error: verificationFailed ? '服务返回的快照没有通过核验，作品本身没有改动。可以重试。' : studentHint(outcome) })
    } finally {
      // 租约释放只更新原 outbox，不写当前作品；失败时保留有期限租约，原命令仍可核对。
      await confirmationRepository.release(command.commandKey, this.leaseOwner).catch(() => {})
    }
  }
}
