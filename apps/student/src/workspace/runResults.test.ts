import { expect, it } from 'vitest'
import { displayRun, verifyJob } from './runResults'
import type { CommandContext } from './frozenCommand'
import type { JobView, RunView } from './runContracts'

const context: CommandContext = { mode: 'preparation', userId: 'student', courseId: 'course', assignmentId: 'assignment',
  activityVersionId: 'activity', attemptId: 'attempt', loadEpoch: 2, preparationEpoch: 'prep', trustedRecoveryGeneration: 'g2' }
const job: JobView = { jobId: 'job', runId: 'run', kind: 'run', purpose: 'student_run',
  scope: { courseId: 'course', studentId: 'student', attemptId: 'attempt' }, requestReceiptId: 'receipt',
  status: 'succeeded', stopRequested: false, expectedRevision: 2, decisionEpoch: 0, recoveryGeneration: 'g1',
  acceptedAt: '2026-10-12T00:00:00Z', deadline: '2026-10-12T00:01:00Z', attemptCount: 1 }

it('当前获准读取保留历史 Job 的来源代际，仍拒绝其他作品归属', () => {
  expect(verifyJob(job, context).recoveryGeneration).toBe('g1')
  expect(() => verifyJob({ ...job, scope: { ...job.scope, attemptId: 'another' } }, context)).toThrow()
  expect(() => verifyJob({ ...job, recoveryGeneration: '' }, context)).toThrow()
})
it('调度 succeeded 配有编译失败诊断时，学生结果同时区分调度完成与程序失败', () => {
  const run: RunView = { runId: 'run', jobId: 'job', snapshotId: 'snapshot', snapshotHash: 'a'.repeat(64),
    mode: 'run', runtimeProfileVersion: 'profile', imageDigest: `sha256:${'b'.repeat(64)}`,
    diagnostics: { runId: 'run', snapshotId: 'snapshot', snapshotHash: 'a'.repeat(64), source: 'runner_diagnostics',
      status: 'available', stdout: '', stderr: 'compiler message', failureKind: 'compile_error' } }
  expect(displayRun(run, job, null)!.statusLabel).toBe('运行完成 · 编译失败')
})
