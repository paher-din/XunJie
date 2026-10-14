import { createLimitProblem, pathProblem } from '../lib/projectFiles'
import { record, requiredId, revision, textHash, verifySnapshot } from './confirmation'
import type { ApiErrorCode } from './contracts'
import type { WorkspaceContext } from './context'
import type { ConfirmedWorkspace, Receipt, SyncInput, SyncResult, SnapshotResult, AttemptResult, SnapshotView, WorkspaceFile } from './workspaceContracts'

export interface CommandContext extends WorkspaceContext { courseId: string; scenarioId?: string }
export interface FrozenDraft {
  localId: string; path: string; text: string; draftRevision: number | null; serverFileId?: string
  /** 学生本次要让这个实例处于的生命周期；省略 = 'active'（02/03/04A 既有调用方语义不变）。 */
  lifecycle?: 'active' | 'recycled'
}
export interface FrozenCommand {
  commandKey: string; context: CommandContext; kind: 'attempt.create' | 'workspace.sync' | 'snapshot.create' | 'run.create' | 'job.cancel' | 'hdl.build' | 'hdl.program' | 'hdl.interact' | 'hdl.stop'
  path: string; target: string; wireJson: string; requestHash: string; createdAt: number
  before: ConfirmedWorkspace | null; drafts: FrozenDraft[]
  /** 06 本机来源标签：经回执关联后才展示，不补入 GET Run 或 POST wire。 */
  runSnapshot?: { hash: string; workspaceRevision: number; files: Array<{ fileId: string; path: string }> }
  /** 06A 本机原停止对象；不扩充 POST cancel 的 wire。 */
  cancelRun?: { runId: string; jobId: string }
  /** Original HDL provenance in the existing outbox; never added to the HTTP body. */
  hdlSnapshot?: SnapshotView
}
export interface OutboxRecord extends FrozenCommand {
  state: 'pending' | 'confirmed' | 'historical'
  receipt?: Receipt; lease?: { owner: string; until: number }
  /**
   * 服务对**这条**原命令的明确拒绝（04 新增的同一 outbox 字段，不新建 store）：
   * 有它就不再重放，刷新后仍是同一事实；未送达/丢 ACK 不写这个字段，保持「未知」。
   */
  rejected?: { code: ApiErrorCode; at: number }
}

/**
 * 服务拒绝里属于「重放不能解决」的码：只有这些停止发送原命令。
 *
 * 版本冲突要改基础版本、代际变化要先重读受信上下文、业务键冲突不能改输入重发同一键——三者都不可能
 * 靠重放同一份 wireJson 解决。STATE_CONFLICT（例如恢复时该路径已被另一个实例占用、生命周期迁移非法）
 * 同样不可能：它说明整批**原子地没有生效**，重放同一份命令只会拿到同一个拒绝（05 设计决定第 8 条）。
 * 其余拒绝（限流、持久化/依赖不可用、未认证等）只是「这次没被接受」：
 * 服务端自己的 recovery 提示就是「先核对原请求再显式重试」，客户端不能把它变成永久封禁。
 */
const TERMINAL_REJECTIONS: ReadonlySet<ApiErrorCode> = new Set(['IDEMPOTENCY_CONFLICT', 'STATE_CONFLICT'])

export function isTerminalRejection(code: ApiErrorCode): boolean {
  return TERMINAL_REJECTIONS.has(code) || code === 'VERSION_CONFLICT' || code === 'RECOVERY_REQUIRED'
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(value)
}
export async function freeze(context: CommandContext, kind: FrozenCommand['kind'], path: string, body: object,
  before: ConfirmedWorkspace | null, drafts: FrozenDraft[]): Promise<FrozenCommand> {
  if (!context.userId || !context.assignmentId || !context.activityVersionId || !context.trustedRecoveryGeneration) throw new Error('缺少身份或受信代际，禁止写入（H-03）')
  const wireJson = JSON.stringify(body), fields = JSON.parse(wireJson) as Record<string, unknown>
  if (kind !== 'attempt.create') delete fields.recoveryGeneration
  const target = kind === 'attempt.create' ? context.assignmentId : `/api${path}`
  return structuredClone({ commandKey: crypto.randomUUID(), context, kind, path, target, wireJson,
    requestHash: await textHash(canonical({ target, fields })), createdAt: Date.now(), before, drafts })
}
export function freezeAttempt(context: CommandContext): Promise<FrozenCommand> {
  return freeze(context, 'attempt.create', `/assignments/${encodeURIComponent(context.assignmentId!)}/attempts`,
    { recoveryGeneration: context.trustedRecoveryGeneration }, null, [])
}
export function freezeSnapshot(context: CommandContext, before: ConfirmedWorkspace): Promise<FrozenCommand> {
  return freeze(context, 'snapshot.create', `/attempts/${encodeURIComponent(before.attemptId)}/snapshots`,
    { recoveryGeneration: context.trustedRecoveryGeneration, expectedWorkspaceRevision: before.workspaceRevision }, before, [])
}
/**
 * 冻结一次确认保存：按「期望生命周期 × 当前确认清单」生成操作（05 的映射表）。
 *
 * 每个实例每批最多一个操作：回收/恢复不带正文，恢复带回的是**已确认**正文，之后的修改由学生再确认一次。
 * 本机新建（确认清单里没有）只能 create；生命周期迁移只对已确认实例成立，而回收后的同名重建是新实例。
 */
export function freezeSync(context: CommandContext, before: ConfirmedWorkspace, drafts: FrozenDraft[], clientId: string, clientSeq: number): Promise<FrozenCommand> {
  if (before.attemptId !== context.attemptId) throw new Error('确认作品归属不符')
  const wantsActive = (draft: FrozenDraft) => (draft.lifecycle ?? 'active') === 'active'
  // 路径与限额只约束**期望 active** 的草稿：回收意图不占 active 名额，也不因为和别的实例重名被误判。
  // 恢复意图算名额，但它的重名不进这张表——同名占用交给下面「恢复路径被占用」判，那个说法才指向
  // 学生该做的一步（去占用者那一行回收），而不是笼统的「换个路径」（恢复不能改路径）。
  let activeFiles = 0, activeBytes = 0
  const paths: string[] = []
  for (const draft of drafts) {
    requiredId(draft.localId)
    if (!wantsActive(draft)) continue
    const restored = before.files.find(f => f.fileId === draft.serverFileId && f.lifecycle === 'recycled')
    // 恢复算 active 名额，但按**恢复回来的确认正文**算：服务端 restore 不带正文，恢复后文件里就是
    // before.files 的那一份。用本机草稿算会给出一条服务端必然以 CONTENT_LIMIT 拒绝的命令。
    const text = restored ? restored.text : draft.text
    const problem = pathProblem(draft.path, restored ? [] : paths) ?? createLimitProblem(text, { activeFiles, activeBytes })
    if (problem) throw new Error(`作品不能确认：${problem}`)
    if (!restored) paths.push(draft.path)
    activeFiles++; activeBytes += new TextEncoder().encode(text).byteLength
  }
  const operations = drafts.flatMap<SyncInput['operations'][number]>(draft => {
    const want = draft.lifecycle ?? 'active'
    const old = draft.serverFileId ? before.files.find(f => f.fileId === draft.serverFileId) : undefined
    if (draft.serverFileId && !old) throw new Error('原文件实例不在当前确认清单，需要重新比较')
    if (!old) {
      // 服务端只认识已确认的实例；本机新建还没有基线，回收它没有可迁移的对象。
      if (want === 'recycled') throw new Error(`这个文件还没有确认保存过，不能回收：${draft.path}`)
      return [{ kind: 'create' as const, clientFileKey: draft.localId, path: draft.path, text: draft.text }]
    }
    if (old.path !== draft.path) throw new Error('文件路径不符')
    if (want === 'recycled') {
      return old.lifecycle === 'active'
        ? [{ kind: 'recycle' as const, fileId: old.fileId, baseVersion: old.documentVersion }]
        : []
    }
    if (old.lifecycle === 'active') {
      return old.text === draft.text ? [] : [{ kind: 'update' as const, fileId: old.fileId, baseVersion: old.documentVersion, text: draft.text }]
    }
    // recycled → active：路径要被另一个**期望 active** 的实例占着就不能恢复。占用者可以是确认清单里的
    // 活动实例（同一批把它改成 recycled 的除外——那一批结束时该路径是空的），也可以是同批要把路径占住的草稿。
    const staysActive = (fileId: string) => {
      const owner = drafts.find(d => d.serverFileId === fileId)
      return owner === undefined || (owner.lifecycle ?? 'active') === 'active'
    }
    const occupied = before.files.some(f => f.fileId !== old.fileId && f.path === old.path && f.lifecycle === 'active' && staysActive(f.fileId)) ||
      drafts.some(other => other !== draft && (other.lifecycle ?? 'active') === 'active' && other.path === old.path)
    if (occupied) throw new Error(`恢复路径被占用：${old.path} 现在被另一个实例占用，先在它那一行回收再恢复`)
    return [{ kind: 'restore' as const, fileId: old.fileId, baseVersion: old.documentVersion }]
  })
  if (operations.length === 0) throw new Error('没有需要确认的修改')
  return freeze(context, 'workspace.sync', `/attempts/${encodeURIComponent(before.attemptId)}/sync`,
    { recoveryGeneration: context.trustedRecoveryGeneration!, expectedWorkspaceRevision: before.workspaceRevision,
      clientId, clientSeq, operations } satisfies SyncInput, before, drafts)
}
/** 回执核对的是冻结命令；不接受到达时的草稿、另一条键或另一身份的结果。 */
export function verifyReceipt<T>(command: FrozenCommand, value: unknown): Receipt<T> {
  const r = record(value), i = record(r.identity), scope = record(i.scope), c = command.context
  requiredId(r.receiptId); requiredId(r.commandId); revision(r.serverSeq, 1)
  if (i.actorId !== c.userId || i.command !== command.kind || i.target !== command.target ||
    i.idempotencyKey !== command.commandKey || i.recoveryGeneration !== c.trustedRecoveryGeneration ||
    scope.courseId !== c.courseId || scope.studentId !== c.userId ||
    (command.kind !== 'attempt.create' && scope.attemptId !== c.attemptId) ||
    r.requestHash !== command.requestHash || (command.kind !== 'attempt.create' && typeof r.replayed !== 'boolean') ||
    typeof r.committedAt !== 'string' || !Number.isFinite(Date.parse(r.committedAt))) throw new Error('原命令回执归属或摘要不符')
  if (command.kind === 'workspace.sync') {
    const body = JSON.parse(command.wireJson) as SyncInput, sync = record(i.sync)
    if (sync.clientId !== body.clientId || sync.clientSeq !== body.clientSeq) throw new Error('sync 回执序号不符')
  }
  record(r.result)
  return structuredClone(r) as unknown as Receipt<T>
}
export function verifyAttemptReceipt(command: FrozenCommand, value: unknown): Receipt<AttemptResult> {
  const r = verifyReceipt<AttemptResult>(command, value)
  requiredId(r.result.attemptId)
  if (r.result.assignmentId !== command.context.assignmentId || r.result.activityVersionId !== command.context.activityVersionId) throw new Error('Attempt 回执归属不符')
  return r
}
export async function verifySyncReceipt(command: FrozenCommand, value: unknown): Promise<{receipt: Receipt<SyncResult>; workspace: ConfirmedWorkspace; mappings: Record<string, string>}> {
  if (command.kind !== 'workspace.sync' || !command.before) throw new Error('缺原 sync 命令')
  const receipt = verifyReceipt<SyncResult>(command, value), result = record(receipt.result)
  if (result.workspaceRevision !== command.before.workspaceRevision + 1 || !Array.isArray(result.files)) throw new Error('ACK 版本或清单不符')
  const created = record(result.created), body = JSON.parse(command.wireJson) as SyncInput
  const contents = new Map(command.before.files.map(f => [f.fileId, { ...f }]))
  const mappings: Record<string, string> = Object.create(null)
  for (const op of body.operations) {
    if (op.kind === 'create') {
      if (!Object.hasOwn(created, op.clientFileKey)) throw new Error('ACK 缺少创建映射')
      const id = requiredId(created[op.clientFileKey])
      if (contents.has(id)) throw new Error('ACK 创建实例重复')
      contents.set(id, { fileId: id, path: op.path, text: op.text, documentVersion: 1,
        contentHash: await textHash(op.text), attemptId: command.before.attemptId, lifecycle: 'active' })
      mappings[op.clientFileKey] = id
    } else {
      const old = contents.get(op.fileId)
      if (!old || old.documentVersion !== op.baseVersion) throw new Error('原命令基础文件不符')
      if (op.kind !== 'update') {
        // 生命周期操作不带正文：path/text/contentHash 必须与冻结基线逐字相同，只有生命周期与版本推进。
        const target = op.kind === 'recycle' ? 'recycled' : 'active'
        if (old.lifecycle === target) throw new Error('原命令生命周期迁移不符')
        contents.set(op.fileId, { ...old, documentVersion: op.baseVersion + 1, lifecycle: target })
        continue
      }
      contents.set(op.fileId, { ...old, text: op.text, contentHash: await textHash(op.text), documentVersion: op.baseVersion + 1 })
    }
  }
  if (Object.keys(created).length !== Object.keys(mappings).length || result.files.length !== contents.size) throw new Error('ACK 文件清单或创建映射不完整')
  const ids = new Set<string>()
  for (const metadata of result.files) {
    const f = record(metadata), id = requiredId(f.fileId), expected = contents.get(id)
    if (ids.has(id) || !expected || ['path', 'documentVersion', 'contentHash', 'lifecycle'].some(k => f[k] !== expected[k as keyof WorkspaceFile])) throw new Error('ACK 文件元数据与冻结原文不符')
    ids.add(id)
  }
  return { receipt, workspace: { attemptId: command.before.attemptId, workspaceRevision: revision(result.workspaceRevision), files: [...contents.values()] }, mappings }
}
export async function verifySnapshotReceipt(command: FrozenCommand, value: unknown, snapshotValue: unknown): Promise<{ receipt: Receipt<SnapshotResult>; snapshot: SnapshotView }> {
  if (command.kind !== 'snapshot.create' || !command.before) throw new Error('缺原快照命令')
  const receipt = verifyReceipt<SnapshotResult>(command, value)
  const snapshot = await verifySnapshot(snapshotValue, command.before.attemptId, command.context.activityVersionId!)
  if (snapshot.snapshotId !== receipt.result.snapshotId || snapshot.hash !== receipt.result.snapshotHash ||
    snapshot.workspaceRevision !== receipt.result.workspaceRevision || snapshot.workspaceRevision !== command.before.workspaceRevision) throw new Error('快照与原命令回执不符')
  const active = command.before.files.filter(f => f.lifecycle === 'active')
  if (active.length !== snapshot.files.length || active.some(f => !snapshot.files.some(s => s.fileId === f.fileId &&
    s.path === f.path && s.documentVersion === f.documentVersion && s.contentHash === f.contentHash && s.text === f.text))) throw new Error('快照不对应冻结的确认作品')
  return { receipt, snapshot }
}
