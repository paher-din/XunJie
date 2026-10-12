import { createLimitProblem, pathProblem } from '../lib/projectFiles'
import { record, requiredId, revision, textHash, verifySnapshot } from './confirmation'
import type { WorkspaceContext } from './context'
import type { ConfirmedWorkspace, Receipt, SyncInput, SyncResult, SnapshotResult, AttemptResult, SnapshotView, WorkspaceFile } from './workspaceContracts'

export interface CommandContext extends WorkspaceContext { courseId: string; scenarioId?: string }
export interface FrozenDraft {
  localId: string; path: string; text: string; draftRevision: number | null; serverFileId?: string
}
export interface FrozenCommand {
  commandKey: string; context: CommandContext; kind: 'attempt.create' | 'workspace.sync' | 'snapshot.create'
  path: string; target: string; wireJson: string; requestHash: string; createdAt: number
  before: ConfirmedWorkspace | null; drafts: FrozenDraft[]
}
export interface OutboxRecord extends FrozenCommand {
  state: 'pending' | 'confirmed' | 'historical'
  receipt?: Receipt; lease?: { owner: string; until: number }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(value)
}
async function freeze(context: CommandContext, kind: FrozenCommand['kind'], path: string, body: object,
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
export function freezeSync(context: CommandContext, before: ConfirmedWorkspace, drafts: FrozenDraft[], clientId: string, clientSeq: number): Promise<FrozenCommand> {
  if (before.attemptId !== context.attemptId) throw new Error('确认作品归属不符')
  let activeFiles = 0, activeBytes = 0
  const paths: string[] = []
  for (const draft of drafts) {
    requiredId(draft.localId)
    const problem = pathProblem(draft.path, paths) ?? createLimitProblem(draft.text, { activeFiles, activeBytes })
    if (problem) throw new Error(`作品不能确认：${problem}`)
    paths.push(draft.path); activeFiles++; activeBytes += new TextEncoder().encode(draft.text).byteLength
  }
  const operations = drafts.flatMap<SyncInput['operations'][number]>(d => {
    const old = d.serverFileId ? before.files.find(f => f.fileId === d.serverFileId && f.lifecycle === 'active') : undefined
    if (d.serverFileId && !old) throw new Error('原文件实例不在当前确认清单，需要重新比较')
    if (!old) return [{ kind: 'create' as const, clientFileKey: d.localId, path: d.path, text: d.text }]
    if (old.path !== d.path) throw new Error('文件路径不符')
    return old.text === d.text ? [] : [{ kind: 'update' as const, fileId: old.fileId, baseVersion: old.documentVersion, text: d.text }]
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
