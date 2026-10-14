import type { ConfirmationWorkspace } from './confirmationWorkspace'
import { confirmationRepository, sameGeneration, CommandConfirmedError } from './confirmationDb'
import type { CommandContext, OutboxRecord } from './frozenCommand'
import { apiGet, apiPostFrozen, setCsrfToken, WorkspaceRequestError } from './http'
import type { SessionView } from './contracts'
import { freezeRun, verifyRunReceipt, RunInputError, type CoreInput, type RunCreated } from './runRequest'
import { settledJob, verifyJob, verifyRun, type JobView, type RunView } from './runResults'
import { describeError, reportDiagnostic } from './diagnostics'
import type { Receipt } from './workspaceContracts'
import { freezeCancel, verifyCancelReceipt } from './runControl'

export type RunPhase = 'idle' | 'reading' | 'ready' | 'submitting' | 'request-unknown' | 'read-unknown' | 'rejected' | 'blocked'
export interface RunState {
  phase: RunPhase; job: JobView | null; run: RunView | null; command: OutboxRecord | null
  pending: boolean; eligible: boolean; notice: string | null
  controlBusy: boolean
}
export const emptyRunState = (): RunState => ({ phase: 'idle', job: null, run: null, command: null, pending: false, eligible: false, notice: null, controlBusy: false })
/** 真实 read 只读取当前同源健康入口；verified 仅用于已声明的准备能力。 */
export interface RunReadiness {
  verified: boolean; runtimeProfileVersion: string; recoveryGeneration: string | null
  read?: () => Promise<boolean>
}
type RunReference = Pick<JobView, 'runId' | 'jobId'>
const definiteRejections = new Set(['INVALID_REQUEST', 'INVALID_REFERENCE', 'INVALID_CONFIGURATION', 'CONTENT_LIMIT',
  'RUNTIME_NOT_READY', 'VERSION_CONFLICT', 'STATE_CONFLICT', 'RECOVERY_REQUIRED', 'FORBIDDEN', 'UNAUTHENTICATED'])

/** 共用确认客户端/DB/HTTP；06A 停止与显式原命令核对，历史列表仍归 06B。 */
export class RunWorkspace {
  private readonly context: CommandContext
  private readonly listeners = new Set<(value: RunState) => void>()
  private state = emptyRunState()
  private disposed = false
  private busy = false
  private readSeq = 0
  private initSeq = 0
  private acceptedSeq = 0
  private selectionEpoch = 0
  private readinessSeq = 0
  private runtimeVerified = false
  private readonly leaseOwner = crypto.randomUUID()
  constructor(private readonly workspace: ConfirmationWorkspace, private readonly readiness: RunReadiness) {
    this.context = workspace.context
  }
  get current(): RunState { return this.state }
  get valid(): boolean { return !this.disposed && this.workspace.isCurrent(this.context) }
  subscribe(listener: (state: RunState) => void): () => void {
    this.listeners.add(listener); listener(this.state)
    return () => { this.listeners.delete(listener) }
  }
  dispose(): void { this.disposed = true; this.selectionEpoch++; this.listeners.clear() }
  pollingExhausted(): void {
    if (this.state.notice !== '自动读取已暂停，请主动重新读取结果。') this.publish({ notice: '自动读取已暂停，请主动重新读取结果。' })
  }
  private publish(change: Partial<RunState>): void {
    if (!this.valid) return
    // 原运行读到终态也不能绕过最近一次就绪失败，或把核对原请求当成新运行许可。
    this.state = { ...this.state, ...change }
    this.state.eligible = this.state.eligible && this.runtimeReady
    this.listeners.forEach(listener => listener(this.state))
  }
  private opts() { return { mode: this.context.mode, scenarioId: this.context.scenarioId } }
  private get runtimeReady(): boolean {
    return this.runtimeVerified && !!this.context.trustedRecoveryGeneration &&
      this.readiness.recoveryGeneration === this.context.trustedRecoveryGeneration &&
      typeof this.readiness.runtimeProfileVersion === 'string' && this.readiness.runtimeProfileVersion.length > 0 &&
      this.readiness.runtimeProfileVersion.length <= 128
  }
  private get readinessNotice(): string | null {
    return this.runtimeReady ? null : '运行环境尚未就绪，请稍后重新读取。编辑与保存仍可继续。'
  }
  private async refreshReadiness(current: () => boolean): Promise<void> {
    const seq = ++this.readinessSeq
    this.runtimeVerified = false
    if (this.context.mode === 'preparation') {
      if (current()) this.runtimeVerified = this.readiness.verified
      return
    }
    try {
      const verified = await this.readiness.read?.()
      if (!current() || seq !== this.readinessSeq || !await this.authority()) return
      if (current() && seq === this.readinessSeq) this.runtimeVerified = verified === true
    } catch (error) {
      if (current() && seq === this.readinessSeq) {
        reportDiagnostic('run.read-failed', { source: 'runtime-readiness', error: describeError(error) })
      }
    }
  }
  private async authority(): Promise<boolean> {
    if (!this.valid) return false
    const current = await confirmationRepository.isCurrentAuthority(this.context)
    return this.valid && current
  }
  private unresolved(commands: OutboxRecord[]): OutboxRecord[] {
    return commands.filter(c => (c.kind === 'run.create' || c.kind === 'job.cancel') &&
      c.state === 'pending' && c.context.attemptId === this.context.attemptId).sort((a, b) => a.createdAt - b.createdAt)
  }
  /** 刷新/新浏览器只 GET 已有结果，未决原请求继续阻塞，不以缺缓存补做运行。 */
  async initialize(original?: RunReference | null): Promise<void> {
    if (!this.valid || !this.context.attemptId) return
    const seq = ++this.initSeq
    const current = () => this.valid && seq === this.initSeq
    this.publish({ phase: 'reading', eligible: false })
    try {
      // 就绪失败只收紧新运行；原 head/Job/Run 仍按原读取与核对路径继续，不生成拒绝回执。
      const [head] = await Promise.all([this.workspace.readHead(), this.refreshReadiness(current)])
      if (!current()) return
      if (!head) { this.publish({ phase: 'read-unknown', notice: '运行记录没有读到，请重新读取。' }); return }
      const commands = await confirmationRepository.commands(this.context)
      if (!current()) return
      const unresolved = this.unresolved(commands), pending = unresolved.length > 0
      const oldGeneration = unresolved.some(c => !sameGeneration(c.context, this.context))
      const jobs = head.jobs.filter(value => (value as { purpose?: string }).purpose === 'student_run')
        .map(value => verifyJob(value, this.context))
      const ordered = [...jobs].sort((a, b) => Date.parse(b.acceptedAt) - Date.parse(a.acceptedAt))
      const selected = original === undefined ? ordered.find(j => !settledJob(j.status)) ?? ordered[0] ?? null
        : original === null ? null : ordered.find(j => j.jobId === original.jobId && j.runId === original.runId) ?? null
      if (!await this.authority() || !current()) return
      const eligible = !pending && jobs.every(j => settledJob(j.status)) && ['ready', 'active'].includes(head.attempt.status)
      this.publish({ pending, eligible, phase: pending ? 'request-unknown' : 'ready',
        notice: oldGeneration ? '服务已恢复到新的状态，原请求不能直接重试；恢复核对尚未交接，请联系教师。'
          : pending ? unresolved.some(c => c.kind === 'job.cancel')
          ? '停止请求结果未知，已保留原请求；请核对，暂时不能再次运行。'
          : '上次运行请求还没有核对完成，暂时不能再次运行。' : this.readinessNotice })
      if (original && !selected) {
        this.publish({ phase: 'read-unknown', eligible: false, notice: '原运行记录不可回取，请重新读取工作区；暂时不能再次运行。' })
        return
      }
      if (!selected) {
        if (this.state.job) this.selectionEpoch++
        this.publish({ job: null, run: null, command: null }); return
      }
      let local = commands.find(c => c.kind === 'run.create' &&
        sameGeneration(c.context, { ...this.context, trustedRecoveryGeneration: selected.recoveryGeneration }) && c.receipt &&
        (c.receipt.result as RunCreated).runId === selected.runId && (c.receipt.result as RunCreated).jobId === selected.jobId) ?? null
      if (local) {
        try {
          verifyRunReceipt(local, local.receipt)
          if (!local.runSnapshot || !Array.isArray(local.runSnapshot.files) ||
            local.runSnapshot.files.some(f => typeof f.fileId !== 'string' || typeof f.path !== 'string')) throw new Error('本机运行参数来源缺失')
          if (this.state.run?.runId === selected.runId) verifyRun(this.state.run, selected.runId, selected.jobId, local)
        } catch (error) {
          reportDiagnostic('run.read-failed', { runId: selected.runId, error: describeError(error) })
          local = null
        }
      }
      // 同一个 run 重读不清掉已接纳终态，防止头里迟到 running 把最终结果回退。
      if (this.state.job?.jobId !== selected.jobId) {
        this.selectionEpoch++; this.publish({ job: selected, run: null, command: local })
      } else this.publish({ command: local })
      await this.readResult()
    } catch (error) {
      if (!current()) return
      reportDiagnostic('run.read-failed', { error: describeError(error) })
      this.publish({ phase: 'read-unknown', eligible: false, notice: '运行记录没有读到，请重新读取。' })
    }
  }
  /** 学生明确停止的是点击时的原 run/job；不能在 await 后改成另一次运行。 */
  async cancel(): Promise<void> {
    const selected = this.state.job
    if (!this.valid || this.busy || this.workspace.commandInFlight || !selected || settledJob(selected.status) || selected.stopRequested || this.state.pending) return
    this.busy = true
    this.selectionEpoch++ // 停止前开始的 poll 不接纳到停止后的展示。
    const epoch = this.selectionEpoch
    const current = () => this.valid && epoch === this.selectionEpoch && this.state.job?.jobId === selected.jobId && this.state.job.runId === selected.runId
    this.publish({ controlBusy: true, eligible: false, notice: null })
    let command: OutboxRecord | null = null
    try {
      if (!await this.authority() || !current()) return
      const frozen = await freezeCancel(this.context, selected.jobId, selected.runId)
      if (!current()) return
      await confirmationRepository.persist(frozen, current)
      if (!current()) return
      command = { ...frozen, state: 'pending' }
      this.publish({ pending: true })
      const accepted = await this.sendOriginal(command, current)
      if (!accepted || !current()) return
      this.publish({ notice: '停止请求已受理，等待服务确认。' })
      await this.initialize(selected)
    } catch (error) {
      await this.controlFailure(command, error, current)
    } finally {
      await this.releaseControl(command)
    }
  }
  /** 仅学生点击核对才重发同代际的冻结命令；无原命令时只 GET 原 Job/Run。 */
  async reconcile(): Promise<void> {
    if (!this.valid || this.busy || this.workspace.commandInFlight) return
    this.busy = true
    this.selectionEpoch++
    const epoch = this.selectionEpoch, current = () => this.valid && epoch === this.selectionEpoch
    let originalRun: RunReference | null = this.state.job
    this.publish({ controlBusy: true, eligible: false })
    let command: OutboxRecord | null = null
    try {
      const commands = this.unresolved(await confirmationRepository.commands(this.context))
      if (!current() || !await this.authority()) return
      for (const original of commands) {
        if (!current()) return
        if (!sameGeneration(original.context, this.context)) {
          await this.initialize(originalRun)
          this.publish({ eligible: false, notice: '服务已恢复到新的状态，原请求不能直接重试；恢复核对尚未交接，请联系教师。' })
          return
        }
        command = original
        const accepted = await this.sendOriginal(command, current)
        if (!accepted || !current()) return
        originalRun = this.referenceOf(accepted)
        await this.releaseLease(command)
        command = null
      }
      if (current()) await this.initialize(originalRun)
    } catch (error) {
      await this.controlFailure(command, error, current, true)
    } finally {
      await this.releaseControl(command)
    }
  }
  private referenceOf(command: OutboxRecord): RunReference {
    if (command.kind === 'run.create') return verifyRunReceipt(command, command.receipt).result
    verifyCancelReceipt(command, command.receipt)
    return command.cancelRun!
  }
  private async sendOriginal(command: OutboxRecord, current: () => boolean): Promise<OutboxRecord | null> {
    const stored = await confirmationRepository.command(command.commandKey)
    if (!current() || !stored || !sameGeneration(stored.context, this.context)) throw new Error('原请求上下文失效')
    // 另一标签已保存回执：只核同一回执，不再次 POST。
    if (stored.receipt) {
      this.referenceOf(stored)
      return stored
    }
    if (stored.state !== 'pending') throw new Error('原请求不可重放')
    const session = await apiGet<SessionView>('/session', this.opts())
    if (!current()) return null
    if (session.userId !== this.context.userId || !session.courses.some(c => c.courseId === this.context.courseId && c.role === 'student')) throw new Error('Session 身份不符')
    setCsrfToken(session.csrfToken)
    let leased: OutboxRecord
    try {
      leased = await confirmationRepository.claim(command.commandKey, this.leaseOwner, current)
    } catch (error) {
      if (!(error instanceof CommandConfirmedError)) throw error
      // 在读取原记录与领取租约之间，另一标签已经完成 ACK 事务；不得再标未知或 POST。
      const confirmed = await confirmationRepository.command(command.commandKey)
      if (!current()) return null
      if (!confirmed?.receipt) throw new Error('已确认原回执不可回取')
      this.referenceOf(confirmed)
      return confirmed
    }
    if (!current()) return null
    if (!await this.authority()) throw new Error('受信上下文已变化')
    if (!current()) return null
    reportDiagnostic('command.sent', { kind: leased.kind, commandKey: leased.commandKey,
      requestHash: leased.requestHash, attemptId: this.context.attemptId })
    const value = await apiPostFrozen<unknown>(leased.path, leased.wireJson, { ...this.opts(), idempotencyKey: leased.commandKey })
    const receipt = leased.kind === 'run.create' ? verifyRunReceipt(leased, value) : verifyCancelReceipt(leased, value)
    // 仅持久化原回执。无论回执中的 status 是什么，当前显示均须再 GET。
    await confirmationRepository.acknowledge(leased, receipt, null, {}, null, current)
    reportDiagnostic(current() ? 'command.acknowledged' : 'command.historical', {
      kind: leased.kind, commandKey: leased.commandKey, receiptId: receipt.receiptId, replayed: receipt.replayed })
    const acknowledged = await confirmationRepository.command(leased.commandKey)
    return current() && acknowledged?.state === 'confirmed' ? acknowledged : null
  }
  private async controlFailure(command: OutboxRecord | null, error: unknown, current: () => boolean, replay = false): Promise<void> {
    reportDiagnostic('command.failed', { kind: command?.kind, commandKey: command?.commandKey, error: describeError(error) })
    if (!current()) return
    if (command && error instanceof WorkspaceRequestError && error.method === 'POST' &&
      error.failure.kind === 'api' && definiteRejections.has(error.failure.error.code)) {
      // 重放的拒绝只说明本次核对被拒，不能推翻此前丢 ACK 的未知事实。
      if (replay) await confirmationRepository.noteRejection(command.commandKey, error.failure.error.code, this.leaseOwner)
      else await confirmationRepository.rejectRun(command.commandKey, error.failure.error.code, this.leaseOwner)
      if (!current()) return
      await this.initialize(command.kind === 'job.cancel' ? command.cancelRun : this.state.job)
      if (!current()) return
      this.publish({ eligible: false, notice: error.failure.error.code === 'RECOVERY_REQUIRED'
        ? replay ? '服务状态已变化，这次核对被拒绝；请重新读取工作区，勿重复运行。'
          : '服务状态已变化，停止请求被拒绝；请重新读取工作区。'
        : replay ? '这次核对被拒绝，原请求仍需核对；请重新读取原运行。'
          : '停止请求未被接受，请重新读取原运行后再操作。' })
      return
    }
    this.publish({ phase: command ? 'request-unknown' : 'read-unknown', eligible: false,
      pending: command !== null || this.state.pending, notice: command?.kind === 'job.cancel'
        ? '停止请求结果未知，已保留原请求；请核对，暂时不能再次运行。'
        : replay ? '原运行核对没有完成；请重新读取或核对原请求。'
          : '这次停止没有发出，请重新读取原运行后再试。' })
  }
  /** 清理失败不推翻已落盘回执，也不能阻断权威结果读取。 */
  private async releaseLease(command: OutboxRecord | null): Promise<void> {
    try { if (command) await confirmationRepository.release(command.commandKey, this.leaseOwner) }
    catch (error) { reportDiagnostic('command.failed', { error: describeError(error) }) }
  }
  private async releaseControl(command: OutboxRecord | null): Promise<void> {
    try { await this.releaseLease(command) }
    finally { this.busy = false; this.publish({ controlBusy: false }) }
  }
  async run(snapshotId: string, entryFileId: string, input: CoreInput): Promise<void> {
    if (!this.valid || this.busy || this.workspace.commandInFlight) return
    this.busy = true
    let command: OutboxRecord | null = null
    try {
      // 每次明确新操作都核原请求与权威服务执行资格；不从旧编辑器版本猜 revision。
      await this.initialize()
      if (!this.valid) return
      if (this.state.pending) {
        this.publish({ notice: '上次运行或当前作品状态仍需核对，暂时不能再次运行。' }); return
      }
      if (!this.runtimeReady) {
        this.publish({ phase: 'blocked', eligible: false, notice: this.readinessNotice }); return
      }
      if (!this.state.eligible) {
        this.publish({ notice: '上次运行或当前作品状态仍需核对，暂时不能再次运行。' }); return
      }
      const attempt = this.workspace.current.attempt
      if (!attempt || !['ready', 'active'].includes(attempt.status)) return
      this.publish({ phase: 'submitting', notice: null })
      const snapshot = await this.workspace.readSnapshot(snapshotId)
      if (!this.valid || !snapshot) return
      const frozen = await freezeRun(this.context, attempt.attemptRevision, snapshot, this.readiness.runtimeProfileVersion, entryFileId, input)
      if (!this.valid) return
      await confirmationRepository.persist(frozen, () => this.valid)
      if (!this.valid) return
      command = { ...frozen, state: 'pending' }
      this.publish({ pending: true, eligible: false })
      const session = await apiGet<SessionView>('/session', this.opts())
      if (!this.valid) return
      if (session.userId !== this.context.userId || !session.courses.some(c => c.courseId === this.context.courseId && c.role === 'student')) throw new Error('Session 身份不符')
      setCsrfToken(session.csrfToken)
      command = await confirmationRepository.claim(command.commandKey, this.leaseOwner, () => this.valid)
      if (!this.valid || !await this.authority()) return
      reportDiagnostic('command.sent', { kind: 'run.create', commandKey: command.commandKey,
        attemptId: this.context.attemptId, snapshotId, requestHash: command.requestHash })
      const response = await apiPostFrozen<unknown>(command.path, command.wireJson, { ...this.opts(), idempotencyKey: command.commandKey })
      const receipt = verifyRunReceipt(command, response)
      // 失效 ACK 只进原隔离事实，acknowledge 同事务再核 authority，不能绑定当前 Run。
      await confirmationRepository.acknowledge(command, receipt as Receipt, null, {}, null, () => this.valid)
      if (!this.valid || !await this.authority()) return
      const stored = await confirmationRepository.command(command.commandKey)
      if (!this.valid || !stored || stored.state !== 'confirmed') return
      command = stored
      this.selectionEpoch++
      this.publish({ pending: false, job: null, run: null, command: stored, phase: 'reading' })
      const job = verifyJob(await apiGet<unknown>(`/jobs/${encodeURIComponent(receipt.result.jobId)}`, this.opts()),
        this.context, receipt.result.runId, receipt.result.jobId)
      if (!this.valid || !await this.authority()) return
      if (job.requestReceiptId !== receipt.receiptId) throw new Error('Job 未关联原请求回执')
      if (job.recoveryGeneration !== this.context.trustedRecoveryGeneration) throw new Error('新运行 Job 的来源代际不符')
      this.publish({ job })
      await this.workspace.readHead()
      if (!this.valid) return
      await this.readResult()
    } catch (error) {
      reportDiagnostic('command.failed', { kind: 'run.create', commandKey: command?.commandKey, error: describeError(error) })
      const failure = error instanceof WorkspaceRequestError ? error.failure : null
      if (command?.receipt) this.publish({ phase: 'read-unknown', eligible: false, pending: false,
        notice: '运行已被接受，但结果读取未知；请重新读取。' })
      else if (command && error instanceof WorkspaceRequestError && error.method === 'POST' &&
        failure?.kind === 'api' && definiteRejections.has(failure.error.code)) {
        await confirmationRepository.rejectRun(command.commandKey, failure.error.code, this.leaseOwner)
        if (!this.valid) return
        this.publish({ phase: 'rejected', pending: false, eligible: false, notice: '这次运行未被接受，请检查输入或重新读取作品后再试。' })
      } else this.publish({ phase: command ? 'request-unknown' : 'rejected', pending: command !== null || this.state.pending,
        eligible: false, notice: command ? '运行请求结果未知，已保留原请求；核对完成前不能再次运行。' :
          error instanceof RunInputError ? error.message : '这次运行没有发出，请重新读取作品后再试。' })
    } finally {
      // 清理故障不覆盖原命令/回执结论，也不能让下一次主动操作永久被 busy 阻塞。
      try { if (command) await confirmationRepository.release(command.commandKey, this.leaseOwner) }
      catch (error) { reportDiagnostic('command.failed', { kind: 'run.create', error: describeError(error) }) }
      finally { this.busy = false }
      if (this.valid && this.state.phase === 'submitting') this.publish({ phase: 'read-unknown', notice: '运行没有完成读取，请重新读取。' })
    }
  }
  /** 有界轮询每轮读取原 Job/Run；请求轮次、选择、上下文、代际均在接纳前重核。 */
  async readResult(): Promise<void> {
    if (!this.valid || !this.state.job) return
    const selected = this.state.job, epoch = this.selectionEpoch, seq = ++this.readSeq
    const current = () => this.valid && epoch === this.selectionEpoch && this.state.job?.jobId === selected.jobId &&
      this.state.job.runId === selected.runId && seq > this.acceptedSeq
    try {
      const jobValue = await apiGet<unknown>(`/jobs/${encodeURIComponent(selected.jobId)}`, this.opts())
      if (!current()) return
      // 先读 Job 再读诊断，避免终态 Job 与更早的 unavailable Run 并发交叉后停止轮询。
      const runValue = await apiGet<unknown>(`/attempts/${encodeURIComponent(this.context.attemptId!)}/runs/${encodeURIComponent(selected.runId)}`, this.opts())
      if (!current()) return
      const job = verifyJob(jobValue, this.context, selected.runId, selected.jobId)
      if (job.recoveryGeneration !== selected.recoveryGeneration) throw new Error('原 Job 来源代际改变')
      const run = verifyRun(runValue, selected.runId, selected.jobId, this.state.command)
      if (this.state.command?.receipt && job.requestReceiptId !== this.state.command.receipt.receiptId) throw new Error('Job 回执关联不符')
      if (!await this.authority() || !current()) return
      if (this.state.job && settledJob(this.state.job.status) && !settledJob(job.status)) return
      if (this.state.job?.stopRequested && !job.stopRequested) return
      if (this.state.run?.diagnostics.status === 'available' && run.diagnostics.status === 'unavailable') return
      const pending = this.unresolved(await confirmationRepository.commands(this.context)).length > 0
      if (!current()) return
      let eligible = false
      if (settledJob(job.status) && !pending) {
        const head = await this.workspace.readHead()
        if (!current()) return
        eligible = !!head && ['ready', 'active'].includes(head.attempt.status) && head.jobs
          .filter(value => (value as { purpose?: string }).purpose === 'student_run')
          .every(value => settledJob(verifyJob(value, this.context).status))
      }
      if (!await this.authority() || !current()) return
      this.acceptedSeq = seq
      this.publish({ job, run, eligible, pending, phase: pending ? 'request-unknown' : 'ready',
        // 是否还有别的作业只有 head 能核；终态读回后重新 initialize 才开放下一次。
        notice: pending ? this.state.notice : job.stopRequested && !settledJob(job.status)
          ? '停止请求已受理，等待服务确认；暂时不能再次运行。'
          : job.status === 'outcome_unknown' || job.status === 'stale' ? '原运行仍需核对，暂时不能再次运行。' : this.readinessNotice })
    } catch (error) {
      if (!current()) return
      this.acceptedSeq = seq
      reportDiagnostic('run.read-failed', { runId: selected.runId, jobId: selected.jobId, error: describeError(error) })
      this.publish({ phase: 'read-unknown', eligible: false, notice: '网络或结果读取未知；保留原运行，请重新读取。' })
    }
  }
}
