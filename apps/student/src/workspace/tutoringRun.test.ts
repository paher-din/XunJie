import { expect, it } from 'vitest'
import type { CommandContext } from './frozenCommand'
import type { JobView, RunView } from './runContracts'
import { createRunHelpObjectRef } from './tutoringRun'

const context: CommandContext = { mode: 'preparation', userId: 'student', courseId: 'course', assignmentId: 'assignment',
  activityVersionId: 'activity', attemptId: 'attempt', loadEpoch: 2, preparationEpoch: 'prep', trustedRecoveryGeneration: 'g2' }
const job: JobView = { jobId: 'job', runId: 'run', kind: 'run', purpose: 'student_run',
  scope: { courseId: 'course', studentId: 'student', attemptId: 'attempt' }, requestReceiptId: 'receipt',
  status: 'outcome_unknown', stopRequested: false, expectedRevision: 2, decisionEpoch: 0, recoveryGeneration: 'g1',
  acceptedAt: '2026-10-13T00:00:00Z', deadline: '2026-10-13T00:01:00Z', attemptCount: 1 }
const run: RunView = { runId: 'run', jobId: 'job', snapshotId: 'snapshot', snapshotHash: 'a'.repeat(64), mode: 'run',
  runtimeProfileVersion: 'profile', imageDigest: `sha256:${'b'.repeat(64)}`,
  diagnostics: { runId: 'run', snapshotId: 'snapshot', snapshotHash: 'a'.repeat(64), source: 'runner_diagnostics', status: 'unavailable' } }
const target = { runId: 'run', snapshotId: 'snapshot' }
const select = (j: unknown = job, r: unknown = run) => createRunHelpObjectRef(context, target, j, r)

it('原运行未知、诊断不可回取、旧来源代际和缺本机参数仍可引用，不补当前值或私有字段', () => {
  expect(select(job, { ...run, input: 'PRIVATE', inputHash: 'PRIVATE', messageId: 'guessed' })).toEqual({
    kind: 'run', attemptId: 'attempt', runId: 'run', snapshotId: 'snapshot' })
  const ref = select()
  ref.runId = 'changed'
  expect(target.runId).toBe('run'); expect(run.runId).toBe('run')
})
it.each(['courseId', 'studentId', 'attemptId'] as const)('拒绝其他归属 %s 的公开运行', field => {
  expect(() => select({ ...job, scope: { ...job.scope, [field]: 'other' } })).toThrow()
})
it('拒绝结果控件、Job、Run 和诊断的错配', () => {
  expect(() => createRunHelpObjectRef(context, { ...target, snapshotId: 'latest-controls' }, job, run)).toThrow()
  expect(() => select({ ...job, runId: 'another' })).toThrow()
  expect(() => select(job, { ...run, jobId: 'another' })).toThrow()
  expect(() => select(job, { ...run, diagnostics: { ...run.diagnostics, snapshotId: 'another' } })).toThrow()
  expect(() => createRunHelpObjectRef({ ...context, attemptId: null }, target, job, run)).toThrow()
})
it('公开检查允许裁剪的 verdict 引用，但拒绝 Job/Run 模式错配', () => {
  const check = { ...run, mode: 'check', diagnostics: { ...run.diagnostics, status: 'available', verdict: 'failed', stdout: 'PRIVATE' } }
  expect(() => select(job, check)).toThrow()
  expect(select({ ...job, kind: 'course_check' }, check)).toEqual(select())
  expect(() => select({ ...job, kind: 'course_check' }, run)).toThrow()
})
it('基础设施失败保持原运行身份，不被写成学生错误或成功', () => {
  const failed = { ...job, status: 'failed' }
  expect(select(failed)).toEqual(select())
  expect(failed.status).toBe('failed'); expect(run.diagnostics.status).toBe('unavailable')
})
