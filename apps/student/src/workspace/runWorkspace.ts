import type { ConfirmationWorkspace } from './confirmationWorkspace'
import { confirmationRepository, sameGeneration } from './confirmationDb'
import type { CommandContext, OutboxRecord } from './frozenCommand'
import { apiGet, apiPostFrozen, setCsrfToken, WorkspaceRequestError } from './http'
import type { SessionView } from './contracts'
import { freezeRun, verifyRunReceipt, RunInputError, type CoreInput, type RunCreated } from './runRequest'
import { settledJob, verifyJob, verifyRun, type JobView, type RunView } from './runResults'
import { describeError, reportDiagnostic } from './diagnostics'
import type { Receipt } from './workspaceContracts'

export type RunPhase = 'idle' | 'reading' | 'ready' | 'submitting' | 'request-unknown' | 'read-unknown' | 'rejected' | 'blocked'
export interface RunState {
  phase: RunPhase; job: JobView | null; run: RunView | null; command: OutboxRecord | null
  pending: boolean; eligible: boolean; notice: string | null
}
export const emptyRunState = (): RunState => ({ phase: 'idle', job: null, run: null, command: null, pending: false, eligible: false, notice: null })
/** H-04 由已交接来源提供；准备配置仅声明合成能力，真实模式缺少时禁写。 */
export interface RunReadiness { verified: boolean; runtimeProfileVersion: string; recoveryGeneration: string | null }
const definiteRejections = new Set(['INVALID_REQUEST', 'INVALID_REFERENCE', 'INVALID_CONFIGURATION', 'CONTENT_LIMIT',
  'RUNTIME_NOT_READY', 'VERSION_CONFLICT', 'STATE_CONFLICT', 'RECOVERY_REQUIRED', 'FORBIDDEN', 'UNAUTHENTICATED'])

/** 一次 Core 运行：共用确认客户端/DB/HTTP，06 不重放未知命令、不提供取消或历史列表。 */
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
    this.state = { ...this.state, ...change }; this.listeners.forEach(listener => listener(this.state))
  }
  private opts() { return { mode: this.context.mode, scenarioId: this.context.scenarioId } }
  private async authority(): Promise<boolean> {
    if (!this.valid) return false
    const current = await confirmationRepository.isCurrentAuthority(this.context)
    return this.valid && current
  }
  /** 刷新/新浏览器只 GET 已有结果，未决原请求继续阻塞，不以缺缓存补做运行。 */
  async initialize(): Promise<void> {
    if (!this.valid || !this.context.attemptId) return
    const seq = ++this.initSeq
    const current = () => this.valid && seq === this.initSeq
    this.publish({ phase: 'reading', eligible: false })
    try {
      const head = await this.workspace.readHead()
      if (!current()) return
      if (!head) { this.publish({ phase: 'read-unknown', notice: '运行记录没有读到，请重新读取。' }); return }
      const commands = await confirmationRepository.commands(this.context)
      if (!current()) return
      const pending = commands.some(c => c.kind === 'run.create' && c.state === 'pending' && c.context.attemptId === this.context.attemptId)
      const jobs = head.jobs.filter(value => (value as { purpose?: string }).purpose === 'student_run')
        .map(value => verifyJob(value, this.context))
      const ordered = [...jobs].sort((a, b) => Date.parse(b.acceptedAt) - Date.parse(a.acceptedAt))
      const selected = ordered.find(j => !settledJob(j.status)) ?? ordered[0] ?? null
      if (!await this.authority() || !current()) return
      const eligible = !pending && jobs.every(j => settledJob(j.status)) && ['ready', 'active'].includes(head.attempt.status)
      this.publish({ pending, eligible, phase: pending ? 'request-unknown' : 'ready',
        notice: pending ? '上次运行请求还没有核对完成，暂时不能再次运行。' : null })
      if (!selected) {
        this.selectionEpoch++; this.publish({ job: null, run: null, command: null }); return
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
  async run(snapshotId: string, entryFileId: string, input: CoreInput): Promise<void> {
    if (!this.valid || this.busy || this.workspace.commandInFlight) return
    this.busy = true
    let command: OutboxRecord | null = null
    try {
      // 每次明确新操作都核原请求与权威服务执行资格；不从旧编辑器版本猜 revision。
      await this.initialize()
      if (!this.valid) return
      if (!this.state.eligible || this.state.pending) {
        this.publish({ notice: '上次运行或当前作品状态仍需核对，暂时不能再次运行。' }); return
      }
      if (!this.readiness.verified || this.readiness.recoveryGeneration !== this.context.trustedRecoveryGeneration) {
        this.publish({ phase: 'blocked', eligible: false, notice: '运行环境尚未就绪，请稍后再试。' }); return
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
      if (this.state.run?.diagnostics.status === 'available' && run.diagnostics.status === 'unavailable') return
      let eligible = false
      if (settledJob(job.status) && !this.state.pending) {
        const head = await this.workspace.readHead()
        if (!current()) return
        eligible = !!head && ['ready', 'active'].includes(head.attempt.status) && head.jobs
          .filter(value => (value as { purpose?: string }).purpose === 'student_run')
          .every(value => settledJob(verifyJob(value, this.context).status))
      }
      if (!await this.authority() || !current()) return
      this.acceptedSeq = seq
      this.publish({ job, run, eligible, phase: this.state.pending ? 'request-unknown' : 'ready',
        // 是否还有别的作业只有 head 能核；终态读回后重新 initialize 才开放下一次。
        notice: this.state.pending ? this.state.notice : job.status === 'outcome_unknown' || job.status === 'stale'
          ? '原运行仍需核对，暂时不能再次运行。' : null })
    } catch (error) {
      if (!current()) return
      this.acceptedSeq = seq
      reportDiagnostic('run.read-failed', { runId: selected.runId, jobId: selected.jobId, error: describeError(error) })
      this.publish({ phase: 'read-unknown', eligible: false, notice: '网络或结果读取未知；保留原运行，请重新读取。' })
    }
  }
}
