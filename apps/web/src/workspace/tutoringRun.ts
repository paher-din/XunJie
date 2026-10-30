import { requiredId } from './confirmation'
import type { CommandContext } from './frozenCommand'
import { verifyJob, verifyRun } from './runResults'

/** 结果面板的显式选择；只能来自可见的原结果，不能来自运行控件。 */
export interface RunHelpTarget { runId: string; snapshotId: string }
export interface RunHelpObjectRef extends RunHelpTarget { kind: 'run'; attemptId: string }

/**
 * 复用原 Job/Run 的公开校验，拒绝跨 Attempt、错快照和错模式。
 * 原运行可以未知、诊断 unavailable、来自旧代际或没有本机参数；这些不是禁止提问的理由。
 * 只构造 TECH §4.1 已有 ObjectRef，不发送、保存、重跑或推测 Action→Job 关系。
 * 调用方在选择及发送前核当前上下文；异步读取完成后也必须核原 loadEpoch。
 */
export function createRunHelpObjectRef(context: CommandContext, target: RunHelpTarget,
  jobValue: unknown, runValue: unknown): RunHelpObjectRef {
  requiredId(context.attemptId)
  requiredId(target.runId); requiredId(target.snapshotId)
  const job = verifyJob(jobValue, context, target.runId)
  const run = verifyRun(runValue, target.runId, job.jobId)
  if (run.snapshotId !== target.snapshotId || (job.kind === 'course_check') !== (run.mode === 'check')) {
    throw new Error('求助原运行的快照或模式不符')
  }
  return { kind: 'run', attemptId: context.attemptId!, runId: run.runId, snapshotId: run.snapshotId }
}
