/** server/workspace/commands.ts readWorkspace 的公开字段；不暴露租约/私有 phase/入口/输入。 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelling' | 'cancelled' | 'stale' | 'timed_out' | 'outcome_unknown'
export interface JobView {
  jobId: string; kind: string; purpose: 'student_run'
  scope: { courseId: string; studentId?: string; attemptId?: string }
  requestReceiptId: string; status: JobStatus; stopRequested: boolean
  expectedRevision: number; decisionEpoch: number; recoveryGeneration: string
  acceptedAt: string; deadline: string; attemptCount: number; runId: string
}
interface DiagnosticsBase { runId: string; snapshotId: string; snapshotHash: string; source: 'runner_diagnostics' }
export type RunDiagnostics = DiagnosticsBase & (
  | { status: 'unavailable' }
  | { status: 'available'; stdout?: string; stderr?: string; failureKind?: string; verdict?: string })
export interface RunView {
  runId: string; jobId: string; snapshotId: string; snapshotHash: string
  mode: 'run' | 'check'; runtimeProfileVersion: string; imageDigest: string; diagnostics: RunDiagnostics
}
