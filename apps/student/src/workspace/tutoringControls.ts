import { record, requiredId, revision, textHash } from './confirmation'
import { confirmationRepository } from './confirmationDb'
import type { ConfirmationWorkspace } from './confirmationWorkspace'
import type { CommandContext } from './frozenCommand'
import type { ActivityView, AssignmentView, ApiErrorCode } from './contracts'
import { openWorkspaceDb } from './draftDb'
import { apiGet, apiPostFrozen, WorkspaceRequestError } from './http'
import type { AttemptView, Receipt, WorkspaceHead } from './workspaceContracts'

/** server/workspace/inputs.ts controlInput 中本票的四个操作；不增加 wire 字段。 */
export type TutoringControl = { kind: 'pause' } | { kind: 'resume' } | { kind: 'capture'; value: boolean } | { kind: 'reminders'; value: boolean }
export interface ControlResult {
  attemptRevision: number; decisionEpoch: number; captureRevision: number
  cancelledJobIds: string[]; captureChanged: boolean
}
export interface ControlCommand {
  commandKey: string; context: CommandContext; path: string; target: string
  wireJson: string; requestHash: string; createdAt: number
  state: 'pending' | 'confirmed' | 'rejected'
  receipt?: Receipt<ControlResult>; rejection?: ApiErrorCode
  lease?: { owner: string; until: number }
}
export interface ControlsState {
  phase: 'idle' | 'reading' | 'ready' | 'sending' | 'unknown' | 'rejected' | 'unavailable'
  attempt: AttemptView | null; assignment: AssignmentView | null
  pending: ControlCommand | null; notice: string | null
}
type ConfirmationPort = Pick<ConfirmationWorkspace, 'context' | 'isCurrent' | 'readHead' | 'commandInFlight'> &
  Partial<Pick<ConfirmationWorkspace, 'current'>>
export interface ControlJournal {
  read(context: CommandContext): Promise<ControlCommand[]>
  append(command: ControlCommand, valid: () => boolean): Promise<void>
  update(context: CommandContext, commandKey: string, change: (command: ControlCommand) => void,
    valid: () => boolean): Promise<ControlCommand>
}
interface JournalRow { key: string; commands: ControlCommand[] }
/** 与旧保存 outbox 完全隔离；复用 v2 metadata，不创建 store/index 或改旧记录。 */
export const controlJournalKey = (c: CommandContext) => `tutor-controls:${JSON.stringify([
  c.mode, c.userId, c.courseId, c.assignmentId, c.activityVersionId, c.attemptId, c.scenarioId ?? null,
])}`
function sameAuthority(a: CommandContext, b: CommandContext): boolean {
  return controlJournalKey(a) === controlJournalKey(b) && a.trustedRecoveryGeneration === b.trustedRecoveryGeneration &&
    a.preparationEpoch === b.preparationEpoch
}
async function journalTransaction<T>(c: CommandContext, mode: IDBTransactionMode,
  work: (row: JournalRow) => T, valid: () => boolean = () => true): Promise<T> {
  const db = await openWorkspaceDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction('metadata', mode), store = tx.objectStore('metadata')
    let result: T, failure: unknown
    const request = store.get(controlJournalKey(c))
    request.onsuccess = () => {
      try {
        if (!valid()) throw new Error('控制上下文已失效')
        const row: JournalRow = request.result ?? { key: controlJournalKey(c), commands: [] }
        result = work(row)
        if (mode === 'readwrite') store.put(row)
      } catch (e) { failure = e; tx.abort() }
    }
    tx.oncomplete = () => resolve(result)
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('控制记录未完成'))
    tx.onerror = () => { failure ??= tx.error }
  })
}
export const tutoringControlJournal: ControlJournal = {
  read: c => journalTransaction(c, 'readonly', row => row.commands),
  append: (command, valid) => journalTransaction(command.context, 'readwrite', row => {
    if (row.commands.some(item => item.state === 'pending' && sameAuthority(item.context, command.context))) {
      throw new Error('原控制命令仍需核对')
    }
    row.commands.push(structuredClone(command))
  }, valid),
  update: (c, key, change, valid) => journalTransaction(c, 'readwrite', row => {
    const item = row.commands.find(command => command.commandKey === key)
    if (!item) throw new Error('原控制命令不可回取')
    change(item)
    return structuredClone(item)
  }, valid),
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
export async function freezeTutoringControl(c: CommandContext, attempt: AttemptView, control: TutoringControl): Promise<ControlCommand> {
  if (!c.userId || !c.attemptId || !c.assignmentId || !c.activityVersionId || !c.trustedRecoveryGeneration ||
    attempt.attemptId !== c.attemptId || attempt.studentId !== c.userId || attempt.courseId !== c.courseId ||
    attempt.assignmentId !== c.assignmentId || attempt.activityVersionId !== c.activityVersionId) throw new Error('缺少当前控制身份或受信代际')
  const path = `/attempts/${encodeURIComponent(c.attemptId)}/controls`, target = `/api${path}`
  const expectedRevision = revision(attempt.attemptRevision, 1)
  // controlCommand 的摘要字段是 expectedRevision，而 HTTP 输入是 expectedAttemptRevision。
  const requestHash = await textHash(canonical({ target, fields: { expectedRevision, control } }))
  return { commandKey: crypto.randomUUID(), context: structuredClone(c), path, target, requestHash,
    wireJson: JSON.stringify({ recoveryGeneration: c.trustedRecoveryGeneration, expectedAttemptRevision: expectedRevision, control }),
    createdAt: Date.now(), state: 'pending' }
}
export function verifyControlReceipt(command: ControlCommand, value: unknown): Receipt<ControlResult> {
  const r = record(value), i = record(r.identity), scope = record(i.scope), result = record(r.result), c = command.context
  requiredId(r.receiptId); requiredId(r.commandId); revision(r.serverSeq, 1)
  if (i.actorId !== c.userId || i.command !== 'attempt.control' || i.target !== command.target ||
    i.idempotencyKey !== command.commandKey || i.recoveryGeneration !== c.trustedRecoveryGeneration ||
    scope.courseId !== c.courseId || scope.studentId !== c.userId || scope.attemptId !== c.attemptId ||
    r.requestHash !== command.requestHash || typeof r.replayed !== 'boolean' ||
    typeof r.committedAt !== 'string' || !Number.isFinite(Date.parse(r.committedAt))) throw new Error('控制回执与原命令不符')
  revision(result.attemptRevision, 1); revision(result.decisionEpoch); revision(result.captureRevision)
  if (typeof result.captureChanged !== 'boolean' || !Array.isArray(result.cancelledJobIds)) throw new Error('控制结果不完整')
  result.cancelledJobIds.forEach(requiredId)
  return structuredClone(r) as unknown as Receipt<ControlResult>
}
export function controlAllowed(attempt: AttemptView | null, assignment: AssignmentView | null, control: TutoringControl): boolean {
  if (!attempt || !assignment || ['submitted', 'reviewed'].includes(attempt.status)) return false
  if (control.kind === 'pause') return attempt.status === 'active'
  if (control.kind === 'resume') return attempt.status === 'paused' && assignment.active
  return true
}
/** 固定政策只给固定许可；不推断限定检查当前是否生效，也不作为服务端授权。 */
export function describeTutoringPolicy(activity: ActivityView): { version: string; description: string; help: string } {
  return { version: activity.helpPolicy.versionId, description: activity.helpPolicy.description,
    help: activity.helpPolicy.helpAllowed ? '活动政策允许主动求助，发送时仍由服务核验当前条件。' : '活动政策不允许主动求助。' }
}
interface ControlIo {
  getAssignment(c: CommandContext): Promise<AssignmentView>
  post(command: ControlCommand): Promise<unknown>
  authorityCurrent(c: CommandContext): Promise<boolean>
}
const defaultIo: ControlIo = {
  getAssignment: c => apiGet(`/assignments/${encodeURIComponent(c.assignmentId!)}`, { mode: c.mode, scenarioId: c.scenarioId }),
  post: command => apiPostFrozen(command.path, command.wireJson, { mode: command.context.mode,
    scenarioId: command.context.scenarioId, idempotencyKey: command.commandKey }),
  authorityCurrent: c => confirmationRepository.isCurrentAuthority(c),
}
const initial = (): ControlsState => ({ phase: 'idle', attempt: null, assignment: null, pending: null, notice: null })
const refusal = (code: ApiErrorCode): string => {
  if (code === 'VERSION_CONFLICT') return '控制版本已变化；原请求未生效，请重读后明确选择。'
  if (code === 'RECOVERY_REQUIRED') return '恢复代际已变化；旧控制请求不会改贴新代际，请重新载入。'
  if (code === 'STATE_CONFLICT') return '当前阶段或教师暂停不允许这项操作；请重读当前状态。'
  if (code === 'FORBIDDEN' || code === 'UNAUTHENTICATED') return '当前账号没有获准执行这项控制，请重新核对登录与分配。'
  return '服务没有确认这项控制；请核对原请求。获准保存仍可继续。'
}
/** 所有 GET 走原确认客户端；不新建 ContextGuard，不触碰草稿、保存队列或采集事件。 */
export class TutoringControlsWorkspace {
  private state = initial()
  private readonly c: CommandContext
  private readonly owner = crypto.randomUUID()
  private disposed = false
  private busy = false
  private readSeq = 0
  private readonly listeners = new Set<(state: ControlsState) => void>()
  constructor(private readonly confirmation: ConfirmationPort,
    private readonly journal: ControlJournal = tutoringControlJournal, private readonly io: ControlIo = defaultIo) {
    this.c = confirmation.context
  }
  get current(): ControlsState { return this.state }
  get context(): CommandContext { return this.c }
  subscribe(fn: (state: ControlsState) => void): () => void { this.listeners.add(fn); fn(this.state); return () => { this.listeners.delete(fn) } }
  dispose(): void { this.disposed = true; this.listeners.clear() }
  private valid = (): boolean => !this.disposed && this.confirmation.isCurrent(this.c)
  private publish(change: Partial<ControlsState>): void {
    if (!this.valid()) return
    this.state = { ...this.state, ...change }; this.listeners.forEach(fn => fn(this.state))
  }
  private async readAuthority(): Promise<WorkspaceHead | null> {
    const seq = ++this.readSeq
    const head = await this.confirmation.readHead()
    if (!this.valid() || seq !== this.readSeq || !head) return null
    const assignment = await this.io.getAssignment(this.c)
    if (!this.valid() || seq !== this.readSeq) return null
    const latest = this.confirmation.current?.attempt
    if (latest && (latest.attemptRevision > head.attempt.attemptRevision || latest.decisionEpoch > head.attempt.decisionEpoch ||
      latest.captureRevision > head.attempt.captureRevision)) return null
    if (assignment.assignmentId !== this.c.assignmentId || assignment.activityVersionId !== this.c.activityVersionId ||
      assignment.studentId !== this.c.userId || typeof assignment.active !== 'boolean' ||
      !['active', 'paused'].includes(assignment.status)) throw new Error('分配控制投影不符')
    revision(assignment.assignmentRevision, 1); revision(assignment.activityControlRevision, 1)
    this.publish({ attempt: head.attempt, assignment })
    return head
  }
  async refresh(): Promise<void> {
    if (this.busy || !this.valid()) return
    this.busy = true; this.publish({ phase: 'reading', notice: null })
    try {
      const head = await this.readAuthority()
      if (!this.valid()) return
      if (!head) throw new Error('当前控制不可回取')
      const rows = await this.journal.read(this.c)
      if (!this.valid()) return
      const pending = rows.find(row => row.state === 'pending' && sameAuthority(row.context, this.c)) ?? null
      const oldPending = rows.some(row => row.state === 'pending' && !sameAuthority(row.context, this.c))
      this.publish({ pending, phase: pending ? 'unknown' : 'ready', notice: pending
        ? '原控制请求结果仍需核对；不会自动重放或换键。' : oldPending ? '旧代际控制请求已保留，不会在当前代际重放。' : null })
    } catch { this.publish({ phase: 'unavailable', notice: '当前控制或本机记录不可回取，请重新读取；获准保存仍可继续。' }) }
    finally { this.busy = false }
  }
  async set(control: TutoringControl): Promise<void> {
    if (this.busy || !this.valid() || this.confirmation.commandInFlight || this.state.pending || this.state.phase === 'unavailable') return
    this.busy = true; this.publish({ phase: 'reading', notice: null })
    try {
      // 不拿渲染时的 revision，也不计算“保存后 +1”。
      const head = await this.readAuthority()
      if (!this.valid()) return
      if (!head || !controlAllowed(head.attempt, this.state.assignment, control)) {
        this.publish({ phase: 'rejected', notice: '当前阶段或教师暂停不允许这项操作。' }); return
      }
      const command = await freezeTutoringControl(this.c, head.attempt, control)
      if (!this.valid()) return
      if (!await this.io.authorityCurrent(this.c) || !this.valid()) {
        this.publish({ phase: 'unavailable', notice: '受信恢复代际已失效，请重新载入后再设置控制。' }); return
      }
      await this.journal.append(command, this.valid)
      if (!this.valid()) return
      this.publish({ pending: command })
      await this.send(command)
    } catch { this.publish({ phase: this.state.pending ? 'unknown' : 'unavailable',
      notice: '这项控制尚未确认；保留原状态，请核对原请求或重新读取。获准保存仍可继续。' }) }
    finally { this.busy = false }
  }
  async retry(): Promise<void> {
    if (this.busy || !this.valid()) return
    this.busy = true
    try {
      const rows = await this.journal.read(this.c)
      if (!this.valid()) return
      const pending = rows.find(row => row.state === 'pending' && sameAuthority(row.context, this.c))
      if (!pending) { this.publish({ pending: null, phase: 'ready', notice: '原命令已被其他页面核对，请重新读取当前状态。' }); return }
      this.publish({ pending })
      // 原请求已经持久化：即使 revision 已推进也只原键重放，服务先查回执再 CAS。
      await this.send(pending)
    } catch { this.publish({ phase: 'unknown', notice: '原控制请求仍未确认；请稍后核对，不会换键重做。' }) }
    finally { this.busy = false }
  }
  private async send(command: ControlCommand): Promise<void> {
    if (!sameAuthority(command.context, this.c) || !this.valid()) return
    if (!await this.io.authorityCurrent(this.c) || !this.valid()) {
      this.publish({ phase: 'unavailable', notice: '当前恢复代际已失效，请重新载入；不会发送旧控制。' }); return
    }
    const claimed = await this.journal.update(this.c, command.commandKey, row => {
      if (row.state !== 'pending') return
      if (row.lease && row.lease.owner !== this.owner && row.lease.until > Date.now()) throw new Error('另一标签正在核对')
      row.lease = { owner: this.owner, until: Date.now() + 30000 }
    }, this.valid)
    if (!this.valid()) return
    if (claimed.state !== 'pending') { this.publish({ pending: null, phase: 'ready' }); return }
    this.publish({ pending: claimed, phase: 'sending' })
    try {
      const value = await this.io.post(claimed)
      if (!this.valid()) return
      if (!await this.io.authorityCurrent(this.c) || !this.valid()) {
        this.publish({ phase: 'unavailable', notice: '控制响应属于已失效的恢复代际，请重新载入后核对原记录。' }); return
      }
      const receipt = verifyControlReceipt(claimed, value)
      await this.journal.update(this.c, claimed.commandKey, row => {
        if (row.lease?.owner !== this.owner) throw new Error('发送租约已变更')
        row.receipt = receipt; row.state = 'confirmed'; delete row.lease
      }, this.valid)
      if (!this.valid()) return
      this.publish({ pending: null })
      const head = await this.readAuthority()
      if (!this.valid()) return
      this.publish({ phase: head ? 'ready' : 'unavailable', notice: head ? '控制已确认，当前状态已重读。' : '原控制已确认，但当前状态尚未读回，请重新读取。' })
    } catch (e) {
      if (!this.valid()) return
      const code = e instanceof WorkspaceRequestError && e.failure.kind === 'api' ? e.failure.error.code : null
      // 明确 CAS/阶段/权限拒绝不能换键自动重试；网络、非法ACK及依赖失败保持原命令未知。
      const terminal = code && ['VERSION_CONFLICT', 'RECOVERY_REQUIRED', 'STATE_CONFLICT', 'IDEMPOTENCY_CONFLICT', 'FORBIDDEN', 'INVALID_REQUEST'].includes(code)
      const row = await this.journal.update(this.c, claimed.commandKey, row => {
        if (row.lease?.owner !== this.owner) return
        if (terminal) { row.state = 'rejected'; row.rejection = code }
        delete row.lease
      }, this.valid)
      if (!this.valid()) return
      if (row.state === 'confirmed') {
        this.publish({ pending: null, phase: 'unavailable', notice: '原控制已确认，但当前状态尚未读回，请重新读取。' }); return
      }
      this.publish({ pending: row.state === 'pending' ? row : null, phase: terminal ? 'rejected' : 'unknown',
        notice: code ? refusal(code) : '原控制请求结果未知；原状态保留，核对时重放相同命令。获准保存仍可继续。' })
      // 服务拒绝可来自跨标签教师暂停；重读原 Attempt，不把失败理解为开关已改变。
      try { await this.readAuthority() } catch { /* 保留最后的权威状态与未确认提示。 */ }
    }
  }
}
