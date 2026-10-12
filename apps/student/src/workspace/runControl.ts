import { requiredId, textHash } from './confirmation'
import { freeze, verifyReceipt, type CommandContext, type FrozenCommand } from './frozenCommand'
import { jobLabels } from './runResults'
import type { JobStatus } from './runContracts'
import type { Receipt } from './workspaceContracts'

export interface CancelResult { jobId: string; status: JobStatus; stopRequested: true }

/** server/workspace/inputs.ts generationInput；commands.ts 的摘要输入是 {jobId}。 */
export async function freezeCancel(context: CommandContext, jobId: string, runId: string): Promise<FrozenCommand> {
  requiredId(jobId); requiredId(runId)
  if (!context.attemptId) throw new Error('缺少原停止对象')
  const command = await freeze(context, 'job.cancel', `/jobs/${encodeURIComponent(jobId)}/cancel`,
    { recoveryGeneration: context.trustedRecoveryGeneration }, null, [])
  command.requestHash = await textHash(JSON.stringify({ fields: { jobId }, target: command.target }))
  command.cancelRun = { jobId, runId }
  return command
}

export function verifyCancelReceipt(command: FrozenCommand, value: unknown): Receipt<CancelResult> {
  if (command.kind !== 'job.cancel' || !command.cancelRun ||
    command.path !== `/jobs/${encodeURIComponent(command.cancelRun.jobId)}/cancel`) throw new Error('缺少原停止命令')
  const receipt = verifyReceipt<CancelResult>(command, value), result = receipt.result
  if (result.jobId !== command.cancelRun.jobId || result.stopRequested !== true ||
    !Object.hasOwn(jobLabels, result.status)) throw new Error('停止回执归属或状态不符')
  return receipt
}
