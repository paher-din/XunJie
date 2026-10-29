import type { ConfirmationWorkspace } from './confirmationWorkspace'
import { confirmationRepository, sameGeneration } from './confirmationDb'
import { apiGet } from './http'
import { displayRun, jobLabels, verifyJob, verifyRun, type JobView, type RunView } from './runResults'
import { freezeRun, verifyRunReceipt, type RunInput } from './runRequest'
import { verifyRunFiles, type RunFiles } from './runFiles'
import type { OutboxRecord } from './frozenCommand'
import { describeError, reportDiagnostic } from './diagnostics'

export interface HistoryDetail {
  job: JobView; run: RunView; result: NonNullable<ReturnType<typeof displayRun>>
  files: RunFiles | null; filesNotice: string | null
}
export interface HistorySide { runId: string; busy: boolean; detail: HistoryDetail | null; notice: string | null }
export interface RunHistoryState { jobs: JobView[]; sides: [HistorySide, HistorySide]; busy: boolean; notice: string | null }
const emptySide = (): HistorySide => ({ runId: '', busy: false, detail: null, notice: null })
export const emptyRunHistory = (): RunHistoryState => ({ jobs: [], sides: [emptySide(), emptySide()], busy: false, notice: null })

/** 06B 只 GET 已授权 head/Job/Run/files 和读取原 outbox；不写作品、不创建或核对运行命令。 */
export class RunHistory {
  private state = emptyRunHistory()
  private listeners = new Set<(state: RunHistoryState) => void>()
  private disposed = false
  private listSeq = 0
  private sideSeq = [0, 0]
  constructor(private readonly workspace: ConfirmationWorkspace) {}
  get current() { return this.state }
  get valid() { return !this.disposed && this.workspace.isCurrent(this.workspace.context) }
  subscribe(listener: (state: RunHistoryState) => void) {
    this.listeners.add(listener); listener(this.state)
    return () => { this.listeners.delete(listener) }
  }
  dispose() { this.disposed = true; this.listeners.clear() }
  private publish(patch: Partial<RunHistoryState>) {
    if (!this.valid) return
    this.state = { ...this.state, ...patch }; this.listeners.forEach(f => f(this.state))
  }
  private side(index: 0 | 1, patch: Partial<HistorySide>) {
    const sides: [HistorySide, HistorySide] = [...this.state.sides]
    sides[index] = { ...sides[index], ...patch }; this.publish({ sides })
  }
  private async authority() {
    const current = await confirmationRepository.isCurrentAuthority(this.workspace.context)
    return this.valid && current
  }
  async initialize() {
    if (!this.valid) return
    const seq = ++this.listSeq
    this.sideSeq = this.sideSeq.map(n => n + 1)
    const current = () => this.valid && seq === this.listSeq
    this.publish({ busy: true, notice: null, sides: this.state.sides.map(s => ({ ...s, busy: false })) as [HistorySide, HistorySide] })
    try {
      const head = await this.workspace.readHead()
      if (!current()) return
      if (!head) throw new Error('历史 head 未读取')
      const jobs = head.jobs.filter(j => (j as { purpose?: string }).purpose === 'student_run')
        .map(j => verifyJob(j, this.workspace.context)).sort((a, b) => Date.parse(b.acceptedAt) - Date.parse(a.acceptedAt))
      if (new Set(jobs.map(j => j.runId)).size !== jobs.length) throw new Error('历史运行引用重复')
      if (!await this.authority() || !current()) return
      this.publish({ jobs, busy: false })
      for (const index of [0, 1] as const) {
        if (!current()) return
        const original = this.state.sides[index].runId
        const runId = jobs.some(j => j.runId === original) ? original : jobs[index]?.runId ?? ''
        // 两侧读路径独立；各自序号限制迟到接纳。
        void this.select(index, runId)
      }
    } catch (error) {
      if (!current()) return
      reportDiagnostic('run.read-failed', { error: describeError(error) })
      this.publish({ busy: false, notice: '历史列表没有读到；保留已有结果，请重新读取。' })
    }
  }
  async select(index: 0 | 1, runId: string) {
    const seq = ++this.sideSeq[index]!, listSeq = this.listSeq
    const current = () => this.valid && seq === this.sideSeq[index] && listSeq === this.listSeq
    if (!this.valid) return
    const selected = this.state.jobs.find(j => j.runId === runId)
    if (!selected) { this.side(index, emptySide()); return }
    this.side(index, { runId, busy: true, notice: null,
      detail: this.state.sides[index].runId === runId ? this.state.sides[index].detail : null })
    const c = this.workspace.context, opts = { mode: c.mode, scenarioId: c.scenarioId }
    const path = `/attempts/${encodeURIComponent(c.attemptId!)}/runs/${encodeURIComponent(runId)}`
    try {
      const job = verifyJob(await apiGet(`/jobs/${encodeURIComponent(selected.jobId)}`, opts), c, runId, selected.jobId)
      if (!current()) return
      const run = verifyRun(await apiGet(path, opts), runId, job.jobId)
      if (!current()) return
      if ((job.kind === 'course_check') !== (run.mode === 'check') || job.recoveryGeneration !== selected.recoveryGeneration) throw new Error('历史运行模式或来源不符')
      const snapshot = this.workspace.current.snapshots.find(s => s.snapshotId === run.snapshotId)
      if (snapshot && snapshot.hash !== run.snapshotHash) throw new Error('历史快照摘要不符')
      const commands = await confirmationRepository.commands(c)
      if (!current()) return
      const local = await this.localSource(commands, job, run)
      if (!current()) return
      const detail: HistoryDetail = { job, run, result: displayRun(run, job, local, snapshot?.workspaceRevision)!, files: null, filesNotice: null }
      if (!await this.authority() || !current()) return
      this.side(index, { detail })
      try {
        const files = await verifyRunFiles(await apiGet(`${path}/files`, opts), run)
        if (!await this.authority() || !current()) return
        this.side(index, { detail: { ...detail, files }, busy: false })
      } catch (error) {
        if (!current()) return
        reportDiagnostic('run.read-failed', { runId, error: describeError(error) })
        this.side(index, { detail: { ...detail, filesNotice: '产物读取或校验失败，无法查看或下载。' }, busy: false })
      }
    } catch (error) {
      if (!current()) return
      reportDiagnostic('run.read-failed', { runId, error: describeError(error) })
      this.side(index, { busy: false, notice: '这次运行读取未知；保留已读结果，请重新读取。' })
    }
  }
  private async localSource(commands: OutboxRecord[], job: JobView, run: RunView): Promise<OutboxRecord | null> {
    for (const command of commands) {
      if (command.kind !== 'run.create' || !command.receipt || command.receipt.receiptId !== job.requestReceiptId ||
        command.context.courseId !== this.workspace.context.courseId || command.context.activityVersionId !== this.workspace.context.activityVersionId ||
        !sameGeneration(command.context, { ...this.workspace.context, trustedRecoveryGeneration: job.recoveryGeneration })) continue
      try {
        verifyRunReceipt(command, command.receipt)
        const snapshot = this.workspace.current.snapshots.find(s => s.snapshotId === run.snapshotId)
        if (!snapshot || !command.runSnapshot || command.runSnapshot.workspaceRevision !== snapshot.workspaceRevision ||
          command.runSnapshot.files.length !== snapshot.files.length || command.runSnapshot.files.some(f =>
            !snapshot.files.some(s => s.fileId === f.fileId && s.path === f.path))) throw new Error('本机快照来源不符')
        const input = JSON.parse(command.wireJson) as RunInput
        // 复用原冻结/输入校验算摘要，不持久化或发送新命令；损坏 wire 不能沿用旧 receipt 标签。
        const checked = await freezeRun(command.context, input.expectedAttemptRevision, snapshot,
          input.runtimeProfileVersion, input.entryFileId, input.input)
        if (input.mode !== 'run' || input.recoveryGeneration !== command.context.trustedRecoveryGeneration ||
          checked.requestHash !== command.requestHash) throw new Error('本机原请求摘要不符')
        // displayRun 核固定请求/run/job/snapshot/profile/hash 与本机文件来源。
        displayRun(run, job, command)
        return command
      } catch (error) { reportDiagnostic('run.read-failed', { runId: run.runId, error: describeError(error) }) }
    }
    return null
  }
  /** 明确下载时再次核完整公开文本；异步校验期间切换选择/上下文就取消。 */
  async download(index: 0 | 1, fileId: string): Promise<{ name: string; text: string } | null> {
    const side = this.state.sides[index], detail = side.detail
    if (!this.valid || side.busy || side.notice || detail?.filesNotice || detail?.files?.status !== 'available') return null
    const current = () => this.valid && this.state.sides[index] === side
    try {
      const files = await verifyRunFiles(detail.files, detail.run)
      if (!current() || !await this.authority() || !current() || files.status !== 'available') return null
      const file = files.files.find(f => f.resultFileId === fileId)
      return file?.status === 'complete' && file.text !== undefined ? { name: file.relativeName, text: file.text } : null
    } catch (error) {
      reportDiagnostic('run.read-failed', { runId: detail.run.runId, error: describeError(error) })
      if (current()) this.side(index, { detail: { ...detail, files: null, filesNotice: '产物校验失败，无法查看或下载。' } })
      return null
    }
  }
}

export const historyLabel = (job: JobView) => `${job.acceptedAt} · ${jobLabels[job.status]} · ${job.runId}`
