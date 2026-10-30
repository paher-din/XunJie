import type { ConfirmationWorkspace } from './confirmationWorkspace'
import type { CommandContext, FrozenCommand, OutboxRecord } from './frozenCommand'
import type { SessionView } from './contracts'
import { apiGet, apiPostFrozen, setCsrfToken, WorkspaceRequestError } from './http'
import { sameGeneration } from './confirmationDb'
import { record, requiredId } from './confirmation'
import { hdlStore } from './hdlStore'
import { freezeHdl, hdlSettled, verifyHdlBuild, verifyHdlCommand, verifyHdlInputs, verifyHdlJob, verifyHdlOperationCommand, verifyHdlReceipt, verifyHdlSession, verifyHdlTrace } from './hdlStore'
import type { HdlBuildView, HdlSessionView, HdlOperationResult, HdlTraceView, HdlJobView, HdlRuntimeProfile, HdlReplacement, HdlInputs, HdlCommandKind } from './hdlContracts'

export type HdlPhase = 'idle' | 'reading' | 'ready' | 'sending' | 'request-unknown' | 'read-unknown' | 'blocked' | 'rejected'
export interface HdlState {
  phase: HdlPhase; busy: boolean; pending: boolean; unknown: boolean; notice: string | null
  build: HdlBuildView | null; sessionBuild: HdlBuildView | null; session: HdlSessionView | null
  operation: HdlOperationResult | null; trace: HdlTraceView | null; job: HdlJobView | null
  command: OutboxRecord | null; commands: OutboxRecord[]
  canBuild: boolean; canProgram: boolean; canInteract: boolean; canStop: boolean
}
export const emptyHdlState = (): HdlState => ({ phase: 'idle', busy: false, pending: false, unknown: false, notice: null,
  build: null, sessionBuild: null, session: null, operation: null, trace: null, job: null, command: null, commands: [],
  canBuild: false, canProgram: false, canInteract: false, canStop: false })
const definite = new Set(['INVALID_REQUEST', 'INVALID_REFERENCE', 'INVALID_CONFIGURATION', 'CONTENT_LIMIT', 'RUNTIME_NOT_READY',
  'VERSION_CONFLICT', 'STATE_CONFLICT', 'RECOVERY_REQUIRED', 'FORBIDDEN', 'UNAUTHENTICATED'])

/** Read/command acceptance is fenced by the existing confirmation context and durable authority. */
export class HdlWorkspace {
  readonly context: CommandContext
  private state = emptyHdlState()
  private readonly listeners = new Set<(state: HdlState) => void>()
  private disposed = false
  private writing = false
  private epoch = 0
  private readSequence = 0
  private acceptedRead = 0
  private runtimeReady = false
  private buildRuntimeReady = false
  private readable = false
  private controlsCurrent = false
  private leaseOwner = crypto.randomUUID()
  private buildId: string | null = null
  private sessionId: string | null = null
  private selectedJob: { jobId: string; objectId: string; receiptId?: string } | null = null
  private cursor = -1
  private verifiedJobs: HdlJobView[] = []
  constructor(private readonly workspace: ConfirmationWorkspace, private readonly profile?: HdlRuntimeProfile) { this.context = workspace.context }
  get current(): HdlState { return this.state }
  get valid(): boolean { return !this.disposed && this.workspace.isCurrent(this.context) }
  subscribe(listener: (state: HdlState) => void): () => void {
    this.listeners.add(listener); listener(this.state)
    return () => { this.listeners.delete(listener) }
  }
  dispose(): void { this.disposed = true; this.epoch++; this.listeners.clear() }
  pollingExhausted(): void { this.publish({ notice: '自动读取已暂停，请主动重新读取结果。' }) }
  private opts() { return { mode: this.context.mode, scenarioId: this.context.scenarioId } }
  private async authority(): Promise<boolean> { const ready = this.valid && await hdlStore.authority(this.context); return this.valid && ready }
  private publish(change: Partial<HdlState>): void {
    if (!this.valid) return
    this.state = { ...this.state, ...change }
    const s = this.state.session, mutable = this.readable && this.runtimeReady && !this.state.pending && !this.state.unknown && !this.writing && !this.workspace.commandInFlight &&
      ['ready', 'active'].includes(this.workspace.current.attempt?.status ?? '')
    const occupied = !!s && !s.terminationConfirmed
    const jobBusy = !!this.state.job && !hdlSettled(this.state.job.status)
    this.state.busy = this.writing
    this.state.canBuild = mutable && this.buildRuntimeReady && !jobBusy
    this.state.canProgram = mutable && !jobBusy && this.state.build?.result?.status === 'succeeded' && this.state.build.result.terminationConfirmed
    this.state.canInteract = mutable && !!s && s.status === 'active' && !s.pendingOperationId && !s.stopRequested && !s.terminationConfirmed && !jobBusy
    // Stopping is allowed with a known current object even if readiness has become unavailable.
    this.state.canStop = this.controlsCurrent && !this.state.pending && !this.writing && !this.workspace.commandInFlight &&
      ['ready', 'active'].includes(this.workspace.current.attempt?.status ?? '') && (occupied && !s!.stopRequested || jobBusy && !this.state.job!.stopRequested)
    this.listeners.forEach(listener => listener(this.state))
  }
  private async readiness(valid: () => boolean): Promise<void> {
    this.runtimeReady = false
    this.buildRuntimeReady = false
    if (!this.profile || this.profile.recoveryGeneration !== this.context.trustedRecoveryGeneration) return
    try {
      const [verified, build] = await Promise.all([this.profile.read?.(), this.profile.readBuild?.()])
      const buildVerified = this.profile.readBuild ? build : verified
      if (valid() && await this.authority() && valid()) { this.runtimeReady = verified === true; this.buildRuntimeReady = buildVerified === true }
    }
    catch { /* Keep readonly results available; new execution remains unavailable. */ }
  }
  private acceptCommand(row: OutboxRecord): void {
    if (!row.receipt) return
    const r = verifyHdlReceipt(row, row.receipt), result = r.result
    if (row.kind === 'hdl.build') this.buildId = requiredId(result.buildId)
    if (row.kind === 'hdl.program') {
      this.buildId = requiredId(record(JSON.parse(row.wireJson)).buildId)
      const id = requiredId(result.sessionId)
      if (id !== this.sessionId) { this.epoch++; this.cursor = -1; this.publish({ session: null, sessionBuild: null, operation: null, trace: null }) }
      this.sessionId = id
    }
    if (row.kind !== 'hdl.stop') this.selectedJob = { jobId: requiredId(result.jobId), objectId: requiredId(result.buildId ?? result.operationId), receiptId: r.receiptId }
    this.publish({ command: row })
  }
  /** Only authorized reads; never replays an outbox or implicitly creates a Session. */
  async initialize(): Promise<void> {
    if (!this.valid || !this.context.attemptId || this.writing) return
    const epoch = ++this.epoch, valid = () => this.valid && this.epoch === epoch
    this.readable = false; this.controlsCurrent = false
    this.publish({ phase: 'reading', notice: null })
    try {
      const head = await this.workspace.readHead()
      if (!valid() || !head) throw new Error('当前工作区未确认')
      const rows = await hdlStore.commands(this.context)
      if (!valid() || !await this.authority() || !valid()) return
      const pending = hdlStore.pending(rows), confirmed = hdlStore.confirmed(rows, this.context)
      const oldGeneration = pending.some(row => !sameGeneration(row.context, this.context))
      this.publish({ commands: rows, pending: pending.length > 0, command: pending[0] ?? this.state.command,
        unknown: pending.length > 0, phase: pending.length ? 'request-unknown' : 'reading',
        notice: oldGeneration ? '代际已经变化，原 HDL 请求保留为待核对；禁止换键重做。' : pending.length ? '原 HDL 请求结果待确认，请核对原请求。' : null })
      // A stored receipt proves a past ACK, not that its objects exist on the current server.
      // Restore IDs from this authorized head; keep every local command, especially unknown requests.
      const jobs = head.jobs.filter(v => ['hdl_build', 'hdl_program', 'hdl_interact'].includes(String(record(v).kind)))
        .map(v => verifyHdlJob(v, this.context)).sort((a, b) => Date.parse(a.acceptedAt) - Date.parse(b.acceptedAt))
      const buildId = jobs.filter(j => j.kind === 'hdl_build').at(-1)?.runId ?? null
      const sessionId = jobs.filter(j => j.kind === 'hdl_program').at(-1)?.runId ?? null
      const latestJob = jobs.at(-1)
      if (buildId !== this.buildId) this.publish({ build: null })
      if (sessionId !== this.sessionId) {
        this.cursor = -1
        this.publish({ session: null, sessionBuild: null, operation: null, trace: null })
      }
      this.buildId = buildId; this.sessionId = sessionId
      this.selectedJob = latestJob ? { jobId: latestJob.jobId, objectId: latestJob.runId, receiptId: latestJob.requestReceiptId } : null
      if (!latestJob) this.publish({ job: null })
      const obsolete = confirmed.some(row => row.kind !== 'hdl.stop' && !jobs.some(job =>
        job.jobId === record(row.receipt!.result).jobId && job.requestReceiptId === row.receipt!.receiptId))
      await this.read()
      if (valid() && obsolete && !this.state.unknown && !this.state.notice) {
        this.publish({ notice: '本机旧操作记录已保留，当前构建与会话按服务器记录恢复。' })
      }
    } catch (error) { if (valid()) this.failure(error, false) }
  }
  /** One bounded read batch, preserving original IDs and immutable result provenance. */
  async read(): Promise<void> {
    if (!this.valid || !this.context.attemptId) return
    const epoch = this.epoch, sequence = ++this.readSequence
    const current = () => this.valid && this.epoch === epoch && sequence >= this.acceptedRead
    this.readable = false; this.controlsCurrent = false
    this.publish({ phase: this.state.pending ? 'request-unknown' : 'reading' })
    try {
      const head = await this.workspace.readHead()
      if (!current() || !head) throw new Error('当前工作区未确认')
      if (!await this.authority() || !current()) return
      const jobs = head.jobs.filter(v => ['hdl_build', 'hdl_program', 'hdl_interact'].includes(String(record(v).kind)))
        .map(v => verifyHdlJob(v, this.context))
      this.controlsCurrent = true
      await this.readiness(current)
      if (!current()) return
      const rows = await hdlStore.commands(this.context)
      if (!current()) return
      const unresolved = hdlStore.pending(rows)
      let selectedBuild = this.state.build, sessionBuild = this.state.sessionBuild, selectedSession = this.state.session
      let selectedJob = this.state.job, selectedTrace = this.state.trace, operation = this.state.operation, cursor = this.cursor
      if (this.buildId) {
        const original = hdlStore.confirmed(rows, this.context).find(row => row.kind === 'hdl.build' && row.receipt?.result && record(row.receipt.result).buildId === this.buildId)
        if (original) { await verifyHdlCommand(original); if (!current()) return }
        selectedBuild = await this.verifiedBuild(await apiGet<unknown>(`/hdl/builds/${encodeURIComponent(this.buildId)}`, this.opts()), this.buildId, jobs, original)
        if (!current()) return
        if (this.state.build?.request.identity.id === this.buildId && this.state.build.result && !selectedBuild.result) throw new Error('原构建结果不能回退为缺失')
      }
      if (this.sessionId) {
        const raw = await apiGet<unknown>(`/hdl/sessions/${encodeURIComponent(this.sessionId)}`, this.opts())
        if (!current()) return
        const id = requiredId(record(raw).buildId)
        sessionBuild = selectedBuild?.request.identity.id === id ? selectedBuild : await this.verifiedBuild(
          await apiGet<unknown>(`/hdl/builds/${encodeURIComponent(id)}`, this.opts()), id, jobs)
        if (!current()) return
        selectedSession = verifyHdlSession(raw, this.context, this.sessionId, sessionBuild, this.profile,
          jobs.find(job => job.kind === 'hdl_program' && job.runId === this.sessionId))
        const prior = this.state.session
        if (prior?.sessionId === selectedSession.sessionId && (selectedSession.sessionRevision < prior.sessionRevision || selectedSession.confirmedSequence < prior.confirmedSequence ||
          BigInt(selectedSession.simTimePs) < BigInt(prior.simTimePs) || prior.stopRequested && !selectedSession.stopRequested || prior.terminationConfirmed && !selectedSession.terminationConfirmed)) throw new Error('原 Session 状态回退')
        for (let count = 0; count < 8; count++) {
          const value = await apiGet<unknown>(`/hdl/sessions/${encodeURIComponent(this.sessionId)}/trace?afterSequence=${cursor}`, this.opts())
          if (!current()) return
          const trace = await verifyHdlTrace(value, selectedSession, cursor)
          if (!current()) return
          if (trace.operation?.result) {
            const original = hdlStore.confirmed(rows, this.context).find(row => row.receipt && record(row.receipt.result).operationId === trace.operation!.operationId)
            if (original) { await verifyHdlOperationCommand(trace.operation.result, original); if (!current()) return }
            operation = trace.operation.result; cursor = trace.nextSequence; selectedTrace = trace
          }
          else { if (!operation) selectedTrace = trace; break }
          if (cursor >= selectedSession.confirmedSequence && !selectedSession.pendingOperationId) break
        }
      }
      if (this.selectedJob) {
        const ref = this.selectedJob
        selectedJob = verifyHdlJob(await apiGet<unknown>(`/jobs/${encodeURIComponent(ref.jobId)}`, this.opts()), this.context, ref.jobId, ref.objectId)
        if (!current()) return
        if (selectedJob.recoveryGeneration !== this.context.trustedRecoveryGeneration || ref.receiptId && selectedJob.requestReceiptId !== ref.receiptId) throw new Error('Job 原回执或代际不符')
        if (this.state.job?.jobId === selectedJob.jobId && (hdlSettled(this.state.job.status) && !hdlSettled(selectedJob.status) || this.state.job.stopRequested && !selectedJob.stopRequested)) throw new Error('原 Job 终态回退')
      }
      if (!current() || !await this.authority() || !current()) return
      this.acceptedRead = sequence; this.cursor = cursor; this.readable = true
      this.verifiedJobs = jobs
      const unknown = unresolved.length > 0 || selectedJob?.status === 'outcome_unknown' || selectedSession?.status === 'outcome_unknown'
      this.publish({ build: selectedBuild, sessionBuild, session: selectedSession, operation, trace: selectedTrace, job: selectedJob,
        commands: rows, pending: unresolved.length > 0, unknown, phase: unresolved.length ? 'request-unknown' : unknown ? 'read-unknown' : 'ready',
        command: unresolved[0] ?? this.state.command,
        notice: unresolved.length ? '原 HDL 请求结果待确认，请核对原请求。' : unknown ? '原执行状态未知，保留原对象并重新读取。' :
          selectedSession?.stopRequested && !selectedSession.terminationConfirmed ? '已请求停止，等待原会话终止确认。' :
          !this.runtimeReady ? '执行环境未就绪；确认作品和已有结果仍可查看。' : null })
    } catch (error) { if (current()) { this.acceptedRead = sequence; this.failure(error, false) } }
  }
  private verifiedBuild(value: unknown, id: string, jobs: HdlJobView[], command?: FrozenCommand | null): Promise<HdlBuildView> {
    const jobId = requiredId(record(value).jobId)
    return verifyHdlBuild(value, this.context, id, this.profile, command,
      jobs.find(job => job.kind === 'hdl_build' && job.jobId === jobId && job.runId === id))
  }
  private failure(error: unknown, request: boolean): void {
    this.readable = false
    this.publish({ phase: request ? 'request-unknown' : 'read-unknown', unknown: true,
      notice: request ? '请求结果未知，原输入与幂等键已保留；请核对原请求。' :
        `结果读取未确认，保留原对象，请重新读取。${error instanceof Error ? ` ${error.message}` : ''}` })
  }
  private async execute(frozen: FrozenCommand, replay: boolean): Promise<void> {
    let row: OutboxRecord | null = null
    const epoch = this.epoch, current = () => this.valid && this.epoch === epoch
    try {
      await verifyHdlCommand(frozen)
      if (!current()) return
      if (!replay) await hdlStore.persist(frozen, current)
      if (!current()) return
      row = await hdlStore.command(frozen.commandKey)
      if (!row) throw new Error('原命令未落盘，禁止发送')
      if (row.receipt) { this.acceptCommand(row); await this.read(); return }
      this.publish({ command: row, pending: true, phase: 'sending', notice: null })
      const session = await apiGet<SessionView>('/session', this.opts())
      if (!current()) return
      if (session.userId !== this.context.userId || !session.courses.some(c => c.courseId === this.context.courseId && c.role === 'student')) throw new Error('当前会话身份不符')
      setCsrfToken(session.csrfToken)
      row = await hdlStore.claim(row.commandKey, this.leaseOwner, current)
      if (!current() || !await this.authority() || !current()) return
      const receipt = verifyHdlReceipt(row, await apiPostFrozen<unknown>(row.path, row.wireJson, { ...this.opts(), idempotencyKey: row.commandKey, executionNodeId: row.executionNodeId }))
      await hdlStore.acknowledge(row, receipt, current)
      if (!current() || !await this.authority() || !current()) return
      row = await hdlStore.command(row.commandKey)
      if (!row || row.state !== 'confirmed') return
      this.acceptCommand(row)
      this.publish({ pending: false, unknown: false, phase: 'reading' })
      await this.read()
    } catch (error) {
      if (!current()) return
      if (row?.receipt) this.failure(error, false)
      else if (row && error instanceof WorkspaceRequestError && error.method === 'POST' && error.failure.kind === 'api' && definite.has(error.failure.error.code)) {
        await hdlStore.rejection(row.commandKey, error.failure.error.code, this.leaseOwner, replay)
        if (!current()) return
        this.publish({ phase: replay ? 'request-unknown' : 'rejected', pending: replay, unknown: replay,
          notice: replay ? '这次原请求核对被拒绝，未知事实仍保留，请重新读取。' : '这次请求未被接受，请重新读取作品和原会话后再操作。' })
      } else if (row) this.failure(error, true)
      else this.publish({ phase: 'rejected', notice: error instanceof Error ? error.message : '请求没有发出，请重新读取。' })
    } finally { if (row) { try { await hdlStore.release(row.commandKey, this.leaseOwner) } catch { /* Original durable fact remains authoritative. */ } } }
  }
  private async command(kind: HdlCommandKind, prepare: () => Promise<FrozenCommand>): Promise<void> {
    if (!this.valid || this.writing || this.workspace.commandInFlight) return
    this.writing = true; this.epoch++; this.publish({ notice: null })
    try {
      await this.read()
      if (!this.valid) return
      if (this.state.pending || kind !== 'hdl.stop' && (!this.readable || this.state.unknown) || kind === 'hdl.stop' && !this.controlsCurrent) throw new Error('原状态尚未确认，请先读取或核对原请求')
      if (!['ready', 'active'].includes(this.workspace.current.attempt?.status ?? '')) throw new Error('当前尝试不能发起此操作')
      if (kind !== 'hdl.stop' && !this.runtimeReady) throw new Error('获准执行环境尚未就绪')
      if (kind === 'hdl.build' && !this.buildRuntimeReady) throw new Error('请选择已连接的执行电脑；编辑与保存仍可继续。')
      const frozen = await prepare()
      if (!this.valid || !await this.authority()) return
      await this.execute(frozen, false)
    } catch (error) { if (this.valid) this.publish({ phase: 'blocked', notice: error instanceof Error ? error.message : '操作条件尚未确认' }) }
    finally { this.writing = false; this.publish({}) }
  }
  build(snapshotId: string): Promise<void> {
    const executionNodeId = this.profile?.executionNodeId?.()
    return this.command('hdl.build', async () => {
      if (this.state.job && !hdlSettled(this.state.job.status)) throw new Error('原作业尚未结束')
      const snapshot = await this.workspace.readSnapshot(snapshotId)
      if (!snapshot || !this.valid) throw new Error('确认快照尚未核验')
      const frozen = await freezeHdl(this.context, 'hdl.build', { expectedAttemptRevision: this.workspace.current.attempt!.attemptRevision, snapshotId: snapshot.snapshotId }, snapshot)
      if (executionNodeId !== this.profile?.executionNodeId?.()) throw new Error('执行电脑已切换，请重新确认构建。')
      if (executionNodeId) frozen.executionNodeId = executionNodeId
      return frozen
    })
  }
  program(buildId: string, replacement?: HdlReplacement): Promise<void> {
    const intended = replacement ? structuredClone(replacement) : undefined
    return this.command('hdl.program', async () => {
      if (this.state.job && !hdlSettled(this.state.job.status)) throw new Error('原作业尚未结束，请先等待或显式停止')
      const build = await this.verifiedBuild(await apiGet<unknown>(`/hdl/builds/${encodeURIComponent(buildId)}`, this.opts()), buildId, this.verifiedJobs)
      if (build.result?.status !== 'succeeded' || !build.result.terminationConfirmed) throw new Error('该构建没有确认可装载产物')
      const original = this.state.session
      if (original && !original.terminationConfirmed && !intended) throw new Error('已有持续会话，请明确选择替换原实例')
      if (intended && (!original || original.sessionId !== intended.sessionId || original.sessionRevision !== intended.sessionRevision || original.stopRequested)) throw new Error('所选替换会话已改变，请重新核对')
      return freezeHdl(this.context, 'hdl.program', { expectedAttemptRevision: this.workspace.current.attempt!.attemptRevision, buildId,
        ...(intended ? { replaceSessionId: intended.sessionId, expectedSessionRevision: intended.sessionRevision } : {}) })
    })
  }
  interact(inputs: HdlInputs, advanceCycles: number): Promise<void> {
    const selected = this.state.session ? { id: this.state.session.sessionId, revision: this.state.session.sessionRevision, sequence: this.state.session.confirmedSequence } : null
    const input = structuredClone(inputs)
    return this.command('hdl.interact', async () => {
      const s = this.state.session
      if (!selected || !s || s.sessionId !== selected.id || s.sessionRevision !== selected.revision || s.confirmedSequence !== selected.sequence ||
        s.status !== 'active' || s.pendingOperationId || s.stopRequested || s.terminationConfirmed) throw new Error('原会话已改变、正在处理或已停止，请重新读取')
      const fixed = verifyHdlInputs(input)
      if (!Number.isSafeInteger(advanceCycles) || advanceCycles < 1 || advanceCycles > 5000000) throw new Error('推进周期应为1～5000000之间的整数')
      return freezeHdl(this.context, 'hdl.interact', { expectedAttemptRevision: this.workspace.current.attempt!.attemptRevision,
        sessionId: s.sessionId, expectedSessionRevision: s.sessionRevision, expectedSequence: s.confirmedSequence + 1, inputs: fixed, advanceCycles })
    })
  }
  stop(reason: string): Promise<void> {
    return this.command('hdl.stop', async () => {
      const why = reason.trim()
      if (!why || why.length > 1024) throw new Error('请填写有效停止原因')
      if (!this.state.session && (!this.state.job || hdlSettled(this.state.job.status))) throw new Error('没有可核对的活动会话或作业')
      return freezeHdl(this.context, 'hdl.stop', { expectedAttemptRevision: this.workspace.current.attempt!.attemptRevision, action: 'stop', reason: why })
    })
  }
  /** Explicit replay of exactly the persisted original wire and key; never performed by initialize/read. */
  async reconcile(): Promise<void> {
    if (!this.valid || this.writing || this.workspace.commandInFlight) return
    this.writing = true; this.epoch++; this.publish({})
    try {
      const rows = await hdlStore.commands(this.context), row = hdlStore.pending(rows)[0]
      if (!this.valid || !row) { await this.read(); return }
      if (!sameGeneration(row.context, this.context)) { this.publish({ phase: 'blocked', notice: '原请求来自旧代际，不能迁移、换键或自动重做。' }); return }
      const head = await this.workspace.readHead()
      if (!this.valid || !head || !await this.authority()) return
      await this.execute(row, true)
    } catch (error) { if (this.valid) this.failure(error, true) }
    finally { this.writing = false; this.publish({}) }
  }
}
