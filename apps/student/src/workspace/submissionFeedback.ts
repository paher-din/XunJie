import { record, requiredId, revision, textHash } from './confirmation'
import { confirmationRepository } from './confirmationDb'
import type { ConfirmationWorkspace } from './confirmationWorkspace'
import type { AssignmentView, SessionView } from './contracts'
import { openWorkspaceDb } from './draftDb'
import type { CommandContext } from './frozenCommand'
import { apiGet, apiPostFrozen, setCsrfToken, WorkspaceRequestError } from './http'
import type { AttemptView, Receipt, SnapshotView } from './workspaceContracts'

export interface ReopenView {
  state: 'none' | 'valid' | 'consumed' | 'superseded'; actionable: boolean
  grantId?: string; submissionId?: string; reason?: string; grantedAt?: string; consumedAt?: string
}
export interface SubmissionSummary {
  submissionId: string; snapshotId: string; snapshotHash: string; workspaceRevision: number
  attemptRevision: number; serverSeq: number; submittedAt: string; hasReflection: boolean
  checkRefs: Array<{ runId: string; snapshotId: string; resultHash?: string; verdict?: string }>
}
export interface SubmissionRecovery {
  attempt: AttemptView; recoveryGeneration: string; resyncRequired: boolean
  submissions: SubmissionSummary[]; latestSubmissionId?: string; reopen: ReopenView
  runs: Array<{ runId: string; snapshotId: string; mode: 'run' | 'check'; outcome: string }>
  feedback: { status: 'unavailable' } | { status: 'available'; feedbackRevision: number; entries: unknown[] }
}
export interface FeedbackEntry {
  feedbackId: string; threadRevision: number; courseId: string; studentId: string; attemptId: string
  submissionId: string; teacherId: string; kind: 'formative' | 'submission_review'
  summary: string; reason: string; createdAt: string; current: boolean; disputed: boolean
  basis: Array<{ claimId: string; claimRevision: number; status: 'current' | 'revised' | 'withdrawn' | 'superseded' | 'unavailable' }>
}
export interface FeedbackView { feedbackRevision: number; entries: FeedbackEntry[]; reopen: ReopenView }
export interface SubmissionCommand {
  commandKey: string; context: CommandContext; kind: 'submit' | 'resume'; path: string; target: string
  wireJson: string; requestHash: string; snapshot?: { snapshotId: string; hash: string; workspaceRevision: number }
  grantId?: string; submissionId?: string; state: 'pending' | 'confirmed' | 'rejected'; receipt?: Receipt
}
export interface SubmissionState {
  phase: 'idle' | 'reading' | 'ready' | 'sending' | 'unknown' | 'unavailable'
  recovery: SubmissionRecovery | null; feedback: FeedbackView | null; assignment: AssignmentView | null
  pending: SubmissionCommand | null; notice: string | null; feedbackNotice: string | null
}
type ConfirmationPort = Pick<ConfirmationWorkspace, 'context' | 'isCurrent' | 'readHead' | 'commandInFlight'>
export interface SubmissionJournal {
  read(c: CommandContext): Promise<SubmissionCommand[]>
  append(command: SubmissionCommand, valid: () => boolean): Promise<void>
  settle(command: SubmissionCommand, valid: () => boolean): Promise<void>
}
const journalKey = (c: CommandContext) => `submission-feedback:${JSON.stringify([
  c.mode, c.userId, c.courseId, c.assignmentId, c.activityVersionId, c.attemptId, c.scenarioId ?? null,
])}`
async function journalTransaction<T>(c: CommandContext, write: boolean,
  work: (commands: SubmissionCommand[]) => T, valid: () => boolean = () => true): Promise<T> {
  const db = await openWorkspaceDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('metadata', write ? 'readwrite' : 'readonly'), store = tx.objectStore('metadata')
    let result: T, failure: unknown
    const read = store.get(journalKey(c))
    read.onsuccess = () => {
      try {
        if (!valid()) throw new Error('提交上下文已失效')
        const commands: SubmissionCommand[] = read.result?.commands ?? []
        result = work(commands)
        if (write) store.put({ key: journalKey(c), commands })
      } catch (e) { failure = e; tx.abort() }
    }
    tx.oncomplete = () => resolve(result)
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('原提交请求没有保存到本机'))
    tx.onerror = () => { failure ??= tx.error }
  })
}
/** Preserve original requests across refresh in the existing v2 metadata store; no schema change. */
export const submissionJournal: SubmissionJournal = {
  read: c => journalTransaction(c, false, commands => commands),
  append: (command, valid) => journalTransaction(command.context, true, commands => {
    if (commands.some(item => item.state === 'pending')) throw new Error('原提交或修订请求仍需核对')
    commands.push(structuredClone(command))
  }, valid),
  settle: (command, valid) => journalTransaction(command.context, true, commands => {
    const index = commands.findIndex(item => item.commandKey === command.commandKey)
    if (index < 0) throw new Error('原提交请求不可回取')
    commands[index] = structuredClone(command)
  }, valid),
}
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
  : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}` : JSON.stringify(value)
function owns(c: CommandContext, a: AttemptView): boolean {
  return a.attemptId === c.attemptId && a.courseId === c.courseId && a.studentId === c.userId &&
    a.assignmentId === c.assignmentId && a.activityVersionId === c.activityVersionId
}
export async function freezeSubmissionCommand(c: CommandContext, recovery: SubmissionRecovery,
  choice: { kind: 'submit'; snapshot: SnapshotView; reflection: string; checkRunIds: string[] } | { kind: 'resume' }): Promise<SubmissionCommand> {
  if (!c.userId || !c.attemptId || !c.trustedRecoveryGeneration || !owns(c, recovery.attempt) ||
    recovery.recoveryGeneration !== c.trustedRecoveryGeneration || recovery.resyncRequired) throw new Error('当前作品与恢复状态尚未核对')
  const expectedAttemptRevision = revision(recovery.attempt.attemptRevision, 1)
  let fields: object, path: string
  if (choice.kind === 'submit') {
    if (!['ready', 'active'].includes(recovery.attempt.status) || choice.snapshot.attemptId !== c.attemptId ||
      choice.snapshot.activityVersionId !== c.activityVersionId) throw new Error('当前阶段或快照不允许提交')
    if (choice.reflection.length > 4096 || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(choice.reflection)) throw new Error('反思须为不超过 4096 字的有效文本')
    if (choice.checkRunIds.length > 16 || new Set(choice.checkRunIds).size !== choice.checkRunIds.length ||
      choice.checkRunIds.some(id => !recovery.runs.some(run => run.runId === id && run.mode === 'check' && run.snapshotId === choice.snapshot.snapshotId))) throw new Error('检查引用须绑定所选提交快照')
    fields = { expectedAttemptRevision, snapshotId: choice.snapshot.snapshotId, checkRunIds: choice.checkRunIds,
      ...(choice.reflection ? { reflection: choice.reflection } : {}) }
    path = `/attempts/${encodeURIComponent(c.attemptId)}/submissions`
  } else {
    if (recovery.attempt.status !== 'reviewed' || !recovery.reopen.actionable || !recovery.reopen.grantId ||
      recovery.reopen.submissionId !== recovery.latestSubmissionId) throw new Error('当前没有可消费的教师修订许可')
    fields = { expectedAttemptRevision, control: { kind: 'resume_revision' } }
    path = `/attempts/${encodeURIComponent(c.attemptId)}/controls`
  }
  const target = `/api${path}`
  const hashFields = choice.kind === 'resume' ? { expectedRevision: expectedAttemptRevision, control: { kind: 'resume_revision' } } : fields
  return { commandKey: crypto.randomUUID(), context: structuredClone(c), kind: choice.kind, path, target,
    wireJson: JSON.stringify({ recoveryGeneration: c.trustedRecoveryGeneration, ...fields }),
    requestHash: await textHash(canonical({ target, fields: hashFields })), state: 'pending',
    ...(choice.kind === 'submit' ? { snapshot: { snapshotId: choice.snapshot.snapshotId, hash: choice.snapshot.hash, workspaceRevision: choice.snapshot.workspaceRevision } }
      : { grantId: recovery.reopen.grantId, submissionId: recovery.latestSubmissionId }) }
}
export function verifySubmissionReceipt(command: SubmissionCommand, value: unknown): Receipt {
  const r = record(value), i = record(r.identity), scope = record(i.scope), result = record(r.result), c = command.context
  requiredId(r.receiptId); requiredId(r.commandId); revision(r.serverSeq, 1)
  if (r.requestHash !== command.requestHash || i.actorId !== c.userId || i.command !== (command.kind === 'submit' ? 'submission.create' : 'attempt.control') ||
    i.target !== command.target || i.idempotencyKey !== command.commandKey || i.recoveryGeneration !== c.trustedRecoveryGeneration ||
    scope.courseId !== c.courseId || scope.studentId !== c.userId || scope.attemptId !== c.attemptId ||
    typeof r.committedAt !== 'string' || !Number.isFinite(Date.parse(r.committedAt))) throw new Error('回执与原提交或修订请求不符')
  revision(result.attemptRevision, 1); revision(result.decisionEpoch)
  if (command.kind === 'submit') {
    requiredId(result.submissionId)
    if (!command.snapshot || result.snapshotId !== command.snapshot.snapshotId || result.snapshotHash !== command.snapshot.hash ||
      result.workspaceRevision !== command.snapshot.workspaceRevision || result.status !== 'submitted') throw new Error('提交回执没有固定所选快照')
  } else if (result.status !== 'active' || result.grantId !== command.grantId || result.submissionId !== command.submissionId) throw new Error('修订回执与原教师许可不符')
  return structuredClone(r) as unknown as Receipt
}
function verifyReopen(value: unknown): ReopenView {
  const r = record(value)
  if (!['none', 'valid', 'consumed', 'superseded'].includes(String(r.state)) || typeof r.actionable !== 'boolean') throw new Error('修订许可状态不完整')
  if (r.state !== 'none') { requiredId(r.grantId); requiredId(r.submissionId) }
  if (r.actionable && r.state !== 'valid') throw new Error('修订许可状态不一致')
  for (const field of ['reason', 'grantedAt', 'consumedAt']) if (r[field] !== undefined && typeof r[field] !== 'string') throw new Error('修订许可说明不完整')
  return structuredClone(r) as unknown as ReopenView
}
export function verifySubmissionRecovery(value: unknown, c: CommandContext, attempt: AttemptView): SubmissionRecovery {
  const r = record(value), a = record(r.attempt) as unknown as AttemptView
  if (!owns(c, a) || a.attemptRevision !== attempt.attemptRevision || a.decisionEpoch !== attempt.decisionEpoch ||
    a.status !== attempt.status || r.recoveryGeneration !== c.trustedRecoveryGeneration || typeof r.resyncRequired !== 'boolean') throw new Error('恢复状态已变化，请重新读取')
  if (!Array.isArray(r.submissions) || !Array.isArray(r.runs)) throw new Error('提交清单尚未完整读取')
  for (const value of r.runs) {
    const run = record(value); requiredId(run.runId); requiredId(run.snapshotId)
    if (!['run', 'check'].includes(String(run.mode)) || typeof run.outcome !== 'string') throw new Error('课程检查引用不完整')
  }
  for (const value of r.submissions) {
    const s = record(value); requiredId(s.submissionId); requiredId(s.snapshotId); revision(s.workspaceRevision)
    revision(s.attemptRevision, 1); revision(s.serverSeq, 1)
    if (!Array.isArray(s.checkRefs) || typeof s.submittedAt !== 'string' || typeof s.hasReflection !== 'boolean' ||
      typeof s.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(s.snapshotHash)) throw new Error('固定提交记录不完整')
  }
  if (r.latestSubmissionId !== undefined && !r.submissions.some(s => record(s).submissionId === r.latestSubmissionId)) throw new Error('最新提交引用不可回取')
  verifyReopen(r.reopen)
  const feedback = record(r.feedback)
  if (feedback.status !== 'unavailable' && (feedback.status !== 'available' || !Array.isArray(feedback.entries))) throw new Error('正式反馈可用状态不完整')
  if (feedback.status === 'available') revision(feedback.feedbackRevision)
  return structuredClone(r) as unknown as SubmissionRecovery
}
export function verifyFeedbackView(value: unknown, c: CommandContext): FeedbackView {
  const f = record(value); revision(f.feedbackRevision)
  if (!Array.isArray(f.entries)) throw new Error('教师反馈清单不可回取')
  for (const value of f.entries) {
    const entry = record(value)
    if (entry.courseId !== c.courseId || entry.studentId !== c.userId || entry.attemptId !== c.attemptId ||
      !['formative', 'submission_review'].includes(String(entry.kind)) || typeof entry.summary !== 'string' ||
      typeof entry.reason !== 'string' || typeof entry.current !== 'boolean' || typeof entry.disputed !== 'boolean' ||
      typeof entry.createdAt !== 'string' || !Array.isArray(entry.basis)) throw new Error('教师反馈归属或正文不完整')
    requiredId(entry.feedbackId); requiredId(entry.submissionId); revision(entry.threadRevision, 1)
    for (const value of entry.basis) {
      const basis = record(value); requiredId(basis.claimId); revision(basis.claimRevision, 1)
      if (!['current', 'revised', 'withdrawn', 'superseded', 'unavailable'].includes(String(basis.status))) throw new Error('反馈依据状态不完整')
    }
  }
  verifyReopen(f.reopen)
  return structuredClone(f) as unknown as FeedbackView
}
interface SubmissionIo {
  get(path: string, c: CommandContext): Promise<unknown>
  post(command: SubmissionCommand): Promise<unknown>
  authority(c: CommandContext): Promise<boolean>
}
const io: SubmissionIo = {
  get: (path, c) => apiGet(path, { mode: c.mode, scenarioId: c.scenarioId, timeoutMs: 15000 }),
  post: command => apiPostFrozen(command.path, command.wireJson, { mode: command.context.mode,
    scenarioId: command.context.scenarioId, idempotencyKey: command.commandKey, timeoutMs: 15000 }),
  authority: c => confirmationRepository.isCurrentAuthority(c),
}
const initial = (): SubmissionState => ({ phase: 'idle', recovery: null, feedback: null, assignment: null, pending: null, notice: null, feedbackNotice: null })
/** Commands require an explicit student click; GETs never save, submit, resume, edit or run. */
export class SubmissionFeedbackWorkspace {
  private state = initial()
  private readonly c: CommandContext
  private busy = false
  private disposed = false
  private readSequence = 0
  private listeners = new Set<(state: SubmissionState) => void>()
  constructor(private readonly confirmation: ConfirmationPort, private readonly journal: SubmissionJournal = submissionJournal,
    private readonly transport: SubmissionIo = io) { this.c = confirmation.context }
  get current(): SubmissionState { return this.state }
  subscribe(fn: (state: SubmissionState) => void): () => void { this.listeners.add(fn); fn(this.state); return () => { this.listeners.delete(fn) } }
  dispose(): void { this.disposed = true; this.readSequence++; this.listeners.clear() }
  private valid = () => !this.disposed && this.confirmation.isCurrent(this.c)
  private publish(change: Partial<SubmissionState>) { if (this.valid()) { this.state = { ...this.state, ...change }; this.listeners.forEach(fn => fn(this.state)) } }
  async refresh(): Promise<void> {
    if (!this.valid() || this.busy) return
    const seq = ++this.readSequence
    const valid = () => this.valid() && seq === this.readSequence
    this.publish({ phase: 'reading', feedback: null, feedbackNotice: null })
    try {
      const commands = await this.journal.read(this.c)
      if (!valid()) return
      this.publish({ pending: commands.find(command => command.state === 'pending') ?? null })
      const assignment = await this.transport.get(`/assignments/${encodeURIComponent(this.c.assignmentId!)}`, this.c) as AssignmentView
      if (!valid()) return
      if (assignment.assignmentId !== this.c.assignmentId || assignment.studentId !== this.c.userId ||
        assignment.activityVersionId !== this.c.activityVersionId || typeof assignment.active !== 'boolean') throw new Error('当前分配没有核对成功')
      const head = await this.confirmation.readHead({ controlsOnly: true })
      if (!valid()) return
      if (!head) throw new Error('当前作品状态不可回取')
      const query = new URLSearchParams({ recoveryGeneration: this.c.trustedRecoveryGeneration!, decisionEpoch: String(head.attempt.decisionEpoch) })
      const recovery = verifySubmissionRecovery(await this.transport.get(`/attempts/${encodeURIComponent(this.c.attemptId!)}/recovery?${query}`, this.c), this.c, head.attempt)
      if (!valid()) return
      if (recovery.resyncRequired) throw new Error('恢复状态已变化，请重新读取；旧许可不会自动恢复')
      this.publish({ recovery, assignment, phase: this.state.pending ? 'unknown' : 'ready', notice: this.state.pending ? '原请求结果尚待核对，请勿重复提交。' : null })
      if (recovery.feedback.status === 'unavailable') { this.publish({ feedbackNotice: '教师反馈服务当前不可用，无法确认是否已有反馈。' }); return }
      try {
        const feedback = verifyFeedbackView(await this.transport.get(`/attempts/${encodeURIComponent(this.c.attemptId!)}/feedback`, this.c), this.c)
        if (!valid()) return
        if (recovery.feedback.status !== 'available' || feedback.feedbackRevision !== recovery.feedback.feedbackRevision ||
          JSON.stringify(feedback.reopen) !== JSON.stringify(recovery.reopen)) throw new Error('反馈或修订许可在读取期间已变化，请重新读取')
        this.publish({ feedback })
      } catch (e) { if (valid()) this.publish({ feedback: null, feedbackNotice: e instanceof Error ? e.message : '教师反馈没有读取成功' }) }
    } catch (e) {
      if (valid()) this.publish({ phase: 'unavailable', recovery: null, feedback: null, assignment: null,
        notice: e instanceof Error ? e.message : '提交与反馈状态没有读取成功' })
    }
  }
  async submit(snapshot: SnapshotView, reflection: string, checkRunIds: string[]): Promise<void> { await this.create({ kind: 'submit', snapshot, reflection, checkRunIds }) }
  async resume(): Promise<void> { await this.create({ kind: 'resume' }) }
  private async create(choice: Parameters<typeof freezeSubmissionCommand>[2]): Promise<void> {
    if (!this.valid() || this.busy || this.state.phase !== 'ready' || this.state.pending || !this.state.recovery ||
      !this.state.assignment?.active || this.confirmation.commandInFlight) return
    this.busy = true; this.readSequence++
    try {
      const command = await freezeSubmissionCommand(this.c, this.state.recovery, choice)
      if (!this.valid()) return
      await this.journal.append(command, this.valid)
      if (!this.valid()) return
      this.publish({ pending: command })
      await this.send(command)
    } catch (e) { this.publish({ phase: this.state.pending ? 'unknown' : 'ready', notice: e instanceof Error ? e.message : '请求没有发出' }) }
    finally { this.busy = false }
  }
  async reconcile(): Promise<void> {
    if (!this.valid() || this.busy || !this.state.pending) return
    this.busy = true; this.readSequence++
    try { await this.send(this.state.pending) } finally { this.busy = false }
  }
  private async send(command: SubmissionCommand): Promise<void> {
    this.publish({ phase: 'sending', notice: null })
    let postStarted = false
    try {
      if (journalKey(command.context) !== journalKey(this.c) || command.context.trustedRecoveryGeneration !== this.c.trustedRecoveryGeneration ||
        command.context.preparationEpoch !== this.c.preparationEpoch || !await this.transport.authority(this.c)) throw new Error('原请求属于较早的恢复代际，请重新载入核对；不会自动重发到新代际')
      if (!this.valid()) return
      const session = await this.transport.get('/session', this.c) as SessionView
      if (!this.valid()) return
      if (session.userId !== this.c.userId || !session.courses?.some(course => course.courseId === this.c.courseId && course.role === 'student') || !session.csrfToken) throw new Error('当前学生会话尚未核对，请重新登录')
      setCsrfToken(session.csrfToken)
      postStarted = true
      const receipt = verifySubmissionReceipt(command, await this.transport.post(command))
      if (!this.valid()) return
      if (!await this.transport.authority(this.c) || !this.valid()) throw new Error('恢复代际已变化，原回执保留待核对')
      await this.journal.settle({ ...command, state: 'confirmed', receipt }, this.valid)
      if (!this.valid()) return
      this.publish({ pending: null, phase: 'ready', recovery: null, feedback: null,
        notice: command.kind === 'submit' ? '提交已确认，所选作品已固定。' : '已开始修订；旧提交和反馈保留。' })
      await this.confirmation.readHead()
      this.busy = false
      await this.refresh()
      this.publish({ notice: command.kind === 'submit' ? '提交已确认，所选作品已固定。' : '已开始修订；旧提交和反馈保留。' })
    } catch (e) {
      if (!this.valid()) return
      if (postStarted && e instanceof WorkspaceRequestError && e.failure.kind === 'api' &&
        ['INVALID_REQUEST', 'FORBIDDEN', 'VERSION_CONFLICT', 'STATE_CONFLICT', 'INVALID_REFERENCE', 'IDEMPOTENCY_CONFLICT', 'RECOVERY_REQUIRED', 'CONTENT_LIMIT'].includes(e.failure.error.code)) {
        try { await this.journal.settle({ ...command, state: 'rejected' }, this.valid) }
        catch { this.publish({ phase: 'unknown', notice: '服务已拒绝原请求，本机记录尚未完成，请核对原请求。' }); return }
        this.publish({ phase: 'unavailable', pending: null, recovery: null, feedback: null,
          notice: `本次请求未生效：${e.failure.error.message}。请重新读取状态后明确选择。` })
      } else this.publish({ phase: 'unknown', notice: '原请求结果尚未确认，已保留原请求。请核对原请求；不会自动换键重复执行。' })
    }
  }
}
