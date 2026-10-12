/** 可序列化的 C2 公开投影；来源 contracts/workspace、records 与 workspace/inputs、commands。 */
export interface AttemptView {
  attemptId: string; courseId: string; studentId: string; assignmentId: string; activityVersionId: string
  status: 'ready' | 'active' | 'paused' | 'submitted' | 'reviewed'
  attemptRevision: number; workspaceRevision: number; decisionEpoch: number; captureRevision: number
  collecting: boolean; reminders: boolean
  route?: string; question?: string; returnPosition?: unknown
}
export interface SnapshotFile {
  fileId: string; path: string; documentVersion: number; contentHash: string; text: string
}
export interface WorkspaceFile extends SnapshotFile {
  attemptId: string; lifecycle: 'active' | 'recycled'
}
export interface ConfirmedWorkspace { attemptId: string; workspaceRevision: number; files: WorkspaceFile[] }
export interface SnapshotView {
  snapshotId: string; attemptId: string; activityVersionId: string; workspaceRevision: number
  hashFormat: 'sha256-manifest-v1'; hash: string; files: SnapshotFile[]; createdAt: string
}
export interface WorkspaceHead {
  attempt: AttemptView; files: WorkspaceFile[]; snapshots: SnapshotView[]
  jobs: unknown[]; runs: unknown[]; checks: unknown[]
}
/**
 * 单个文件操作。字段与顺序对齐 `server/workspace/inputs.ts` 的 `fileOperationSchema`：
 * `create` 由服务端分配 fileId；`recycle`/`restore` 是生命周期状态迁移，不带正文——
 * 恢复带回的是**已确认**正文，本机后续修改由学生再确认保存一次（TECH §7.4 同实例每批一个操作）。
 */
export type SyncOperation =
  | { kind: 'create'; clientFileKey: string; path: string; text: string }
  | { kind: 'update'; fileId: string; baseVersion: number; text: string }
  | { kind: 'recycle'; fileId: string; baseVersion: number }
  | { kind: 'restore'; fileId: string; baseVersion: number }
export interface SyncInput {
  recoveryGeneration: string; expectedWorkspaceRevision: number; clientId: string; clientSeq: number
  operations: SyncOperation[]
}
export interface Receipt<T = unknown> {
  receiptId: string; commandId: string; requestHash: string; result: T; serverSeq: number
  committedAt: string; replayed?: boolean
  identity: {
    actorId: string; command: string; target: string; idempotencyKey: string; recoveryGeneration: string
    scope: { courseId: string; studentId?: string; attemptId?: string }
    sync?: { clientId: string; clientSeq: number }
  }
}
export interface SyncResult {
  workspaceRevision: number
  files: Array<Omit<WorkspaceFile, 'attemptId' | 'text'>>
  created: Record<string, string>
  process: { status: 'eligible' | 'not_collected'; reason?: string }
}
export interface SnapshotResult { snapshotId: string; snapshotHash: string; workspaceRevision: number }
export interface AttemptResult { attemptId: string; assignmentId: string; activityVersionId: string }
