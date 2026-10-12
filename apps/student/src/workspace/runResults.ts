import { record, requiredId, revision } from './confirmation'
import type { CommandContext, OutboxRecord } from './frozenCommand'
import { verifyRunReceipt, type RunInput } from './runRequest'
import type { CoreResultDisplay } from '../components/workspace/RunPanel'

import type { JobStatus, JobView, RunView } from './runContracts'
export type { JobStatus, JobView, RunView } from './runContracts'
const statuses: JobStatus[] = ['queued', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled', 'stale', 'timed_out', 'outcome_unknown']
export const settledJob = (status: JobStatus): boolean => ['succeeded', 'failed', 'cancelled', 'timed_out'].includes(status)
export const jobLabels: Record<JobStatus, string> = { queued: '等待运行', running: '运行中', succeeded: '运行完成',
  failed: '执行失败', cancelling: '正在停止', cancelled: '已停止', stale: '运行已过期，仍需核对',
  timed_out: '运行超时', outcome_unknown: '执行结果未知，仍需核对' }

export function verifyJob(value: unknown, c: CommandContext, runId?: string, jobId?: string): JobView {
  const job = record(value), scope = record(job.scope)
  requiredId(job.jobId); requiredId(job.runId); requiredId(job.requestReceiptId)
  // 权威当前读取可以包含旧代际的原 Job；来源代际不能冒充当前写入资格。
  requiredId(job.recoveryGeneration)
  if (scope.courseId !== c.courseId || scope.studentId !== c.userId || scope.attemptId !== c.attemptId ||
    job.purpose !== 'student_run' || !['run', 'course_check'].includes(String(job.kind)) ||
    (runId !== undefined && job.runId !== runId) || (jobId !== undefined && job.jobId !== jobId) ||
    !statuses.includes(job.status as JobStatus) || typeof job.stopRequested !== 'boolean') throw new Error('Job 归属、代际或状态不符')
  revision(job.expectedRevision, 1); revision(job.decisionEpoch); revision(job.attemptCount)
  for (const key of ['acceptedAt', 'deadline']) if (typeof job[key] !== 'string' || !Number.isFinite(Date.parse(job[key]))) throw new Error('Job 时间不完整')
  return structuredClone(job) as unknown as JobView
}
export function verifyRun(value: unknown, runId: string, jobId: string, command?: OutboxRecord | null): RunView {
  const run = record(value), diagnostics = record(run.diagnostics)
  requiredId(run.snapshotId); requiredId(run.runtimeProfileVersion)
  if (run.runId !== runId || run.jobId !== jobId || !/^[a-f0-9]{64}$/.test(String(run.snapshotHash)) ||
    !/^sha256:[a-f0-9]{64}$/.test(String(run.imageDigest)) || !['run', 'check'].includes(String(run.mode))) throw new Error('Run 固定引用不完整')
  if (diagnostics.runId !== runId || diagnostics.snapshotId !== run.snapshotId || diagnostics.snapshotHash !== run.snapshotHash ||
    diagnostics.source !== 'runner_diagnostics' || !['available', 'unavailable'].includes(String(diagnostics.status))) throw new Error('运行诊断归属不符')
  if (diagnostics.status === 'available') {
    if (run.mode === 'run' && (typeof diagnostics.stdout !== 'string' || typeof diagnostics.stderr !== 'string')) throw new Error('可用诊断缺少输出')
    if (run.mode === 'check' && typeof diagnostics.verdict !== 'string') throw new Error('可用检查缺少公开 verdict')
    if (diagnostics.failureKind !== undefined && typeof diagnostics.failureKind !== 'string') throw new Error('诊断故障类型不符')
    if (new TextEncoder().encode(`${diagnostics.stdout ?? ''}${diagnostics.stderr ?? ''}`).byteLength > 65536) throw new Error('公开诊断超过输出限额')
  }
  if (command) {
    const receipt = verifyRunReceipt(command, command.receipt), input = JSON.parse(command.wireJson) as RunInput
    if (receipt.result.runId !== runId || receipt.result.jobId !== jobId || input.snapshotId !== run.snapshotId ||
      input.runtimeProfileVersion !== run.runtimeProfileVersion || run.mode !== 'run' ||
      command.runSnapshot?.hash !== run.snapshotHash) throw new Error('Run 与本机原请求绑定不符')
  }
  return structuredClone(run) as unknown as RunView
}
export function displayRun(run: RunView | null, job: JobView | null, command: OutboxRecord | null,
  workspaceRevision?: number): CoreResultDisplay | null {
  if (!run || !job) return null
  let parameters: string | null = null
  if (command?.receipt) {
    // 展示函数本身也核绑定，不能只因另一个位置找到一条命令就把其参数贴到当前结果上。
    verifyRun(run, run.runId, job.jobId, command)
    const input = JSON.parse(command.wireJson) as RunInput, files = command.runSnapshot!.files
    const path = (id: string) => files.find(f => f.fileId === id)?.path ?? '文件实例不可回取'
    const argument = input.input.operation === 'find' ? ` ${input.input.word}` : input.input.operation === 'top' ? ` ${input.input.count}` : ''
    parameters = `入口 ${path(input.entryFileId)} · ${input.input.operation}${argument} · 输入 ${input.input.fileIds.map(path).join('、')}`
  }
  const d = run.diagnostics
  const failureLabels: Record<string, string> = { compile_error: '编译失败', program_error: '程序执行失败', timeout: '程序超时', output_limit: '输出超过限额' }
  const failure = d.status === 'available' && d.failureKind ? (failureLabels[d.failureKind] ?? '程序未正常完成') : null
  return { runId: run.runId, snapshotId: run.snapshotId, snapshotHash: run.snapshotHash,
    snapshotLabel: workspaceRevision === undefined ? '固定快照结果' : `快照作品 v${workspaceRevision} 的结果`,
    statusLabel: `${jobLabels[job.status]}${failure ? ` · ${failure}` : ''}`, parameters,
    diagnostics: d.status === 'available' ? { stdout: d.stdout, stderr: d.stderr, failureKind: d.failureKind, verdict: d.verdict } : null }
}
