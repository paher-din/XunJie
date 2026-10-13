import { pathProblem, utf8Bytes } from '../lib/projectFiles'
import type { WorkspaceContext } from './context'
import type { AttemptView, SnapshotFile, SnapshotView, WorkspaceHead } from './workspaceContracts'

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('响应对象不完整')
  return value as Record<string, unknown>
}
export function requiredId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 128) throw new Error('响应 ID 不完整')
  return value
}
export function revision(value: unknown, min = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < min) throw new Error('响应版本不合法')
  return value as number
}
export async function textHash(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}
const comparePath = (a: SnapshotFile, b: SnapshotFile) => {
  const encoder = new TextEncoder(), left = encoder.encode(a.path), right = encoder.encode(b.path)
  for (let i = 0; i < Math.min(left.length, right.length); i++) if (left[i] !== right[i]) return left[i]! - right[i]!
  return left.length - right.length
}
export function manifestRows(files: SnapshotFile[]): Array<[string, string, number, string]> {
  return [...files].sort(comparePath).map(f => [f.fileId, f.path, f.documentVersion, f.contentHash])
}
export function sameWorkspace(a: { files: SnapshotFile[] }, b: { files: SnapshotFile[] }): boolean {
  // lifecycle is part of the workspace head, but deliberately absent from the snapshot manifest.
  // Recycled and active instances may share a path; identity gives the full list a stable order.
  const rows = (files: SnapshotFile[]) => [...files].sort((a, b) => a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0).map(f => [
    f.fileId, f.path, f.documentVersion, f.contentHash, 'lifecycle' in f ? f.lifecycle : null,
  ])
  return JSON.stringify(rows(a.files)) === JSON.stringify(rows(b.files))
}
async function verifiedFiles(value: unknown, workspaceAttempt?: string): Promise<SnapshotFile[]> {
  if (!Array.isArray(value)) throw new Error('响应缺少完整文件清单')
  const ids = new Set<string>(), paths = new Set<string>()
  let activeCount = 0, activeBytes = 0
  for (const entry of value) {
    const f = record(entry)
    const id = requiredId(f.fileId)
    if (ids.has(id)) throw new Error('重复文件实例')
    ids.add(id)
    revision(f.documentVersion, 1)
    if (typeof f.path !== 'string' || pathProblem(f.path, []) || typeof f.text !== 'string') throw new Error('文件路径或原文不合法')
    if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(f.text)) throw new Error('原文不是有效 Unicode')
    if (workspaceAttempt !== undefined && (f.attemptId !== workspaceAttempt || !['active', 'recycled'].includes(String(f.lifecycle)))) throw new Error('文件归属或生命周期不符')
    if (workspaceAttempt === undefined || f.lifecycle === 'active') {
      if (paths.has(f.path)) throw new Error('重复活动路径')
      paths.add(f.path)
      activeCount++; activeBytes += utf8Bytes(f.text)
    }
    if (activeCount > 50 || activeBytes > 1048576) throw new Error('作品超过文件或字节限额')
    if (f.contentHash !== await textHash(f.text)) throw new Error('文件原文摘要不符')
  }
  return structuredClone(value) as SnapshotFile[]
}
export async function verifySnapshot(value: unknown, attemptId: string, activityVersionId: string): Promise<SnapshotView> {
  const s = record(value)
  requiredId(s.snapshotId)
  if (s.attemptId !== attemptId || s.activityVersionId !== activityVersionId) throw new Error('快照归属不符')
  revision(s.workspaceRevision)
  if (s.hashFormat !== 'sha256-manifest-v1' || typeof s.createdAt !== 'string' || !Number.isFinite(Date.parse(s.createdAt))) throw new Error('快照格式不符')
  const files = await verifiedFiles(s.files)
  if (s.hash !== await textHash(JSON.stringify(manifestRows(files)))) throw new Error('快照清单摘要不符')
  return structuredClone(s) as unknown as SnapshotView
}
export async function verifyHead(value: unknown, context: WorkspaceContext, courseId: string): Promise<WorkspaceHead> {
  const h = record(value), a = record(h.attempt)
  if (a.attemptId !== context.attemptId || a.studentId !== context.userId || a.assignmentId !== context.assignmentId ||
    a.activityVersionId !== context.activityVersionId || a.courseId !== courseId) throw new Error('Attempt 归属不符')
  if (!['ready', 'active', 'paused', 'submitted', 'reviewed'].includes(String(a.status))) throw new Error('Attempt 状态不符')
  for (const field of ['workspaceRevision', 'decisionEpoch', 'captureRevision']) revision(a[field])
  revision(a.attemptRevision, 1)
  if (typeof a.collecting !== 'boolean' || typeof a.reminders !== 'boolean') throw new Error('Attempt 控制状态不完整')
  await verifiedFiles(h.files, requiredId(a.attemptId))
  for (const field of ['snapshots', 'jobs', 'runs', 'checks']) if (!Array.isArray(h[field])) throw new Error('Attempt 读取投影不完整')
  for (const snapshot of h.snapshots as unknown[]) await verifySnapshot(snapshot, requiredId(a.attemptId), requiredId(a.activityVersionId))
  return structuredClone(h) as unknown as WorkspaceHead
}
export function workspaceOf(head: WorkspaceHead) {
  return { attemptId: head.attempt.attemptId, workspaceRevision: head.attempt.workspaceRevision, files: head.files }
}
export function isTerminal(attempt: AttemptView): boolean { return ['submitted', 'reviewed'].includes(attempt.status) }
