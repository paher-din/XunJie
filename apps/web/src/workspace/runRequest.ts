import { requiredId, revision, verifySnapshot } from './confirmation'
import { freeze, verifyReceipt, type CommandContext, type FrozenCommand } from './frozenCommand'
import type { SnapshotView, Receipt } from './workspaceContracts'

/** server/workspace/inputs.ts runInput 的 Core 子集；没有 shell/路径或 sync 身份字段。 */
export type CoreInput =
  | { operation: 'stats'; fileIds: string[] }
  | { operation: 'find'; fileIds: string[]; word: string }
  | { operation: 'top'; fileIds: string[]; count: string }
export interface RunInput {
  recoveryGeneration: string; expectedAttemptRevision: number; snapshotId: string
  runtimeProfileVersion: string; entryFileId: string; input: CoreInput; mode: 'run'
}
export interface RunCreated { runId: string; jobId: string; snapshotId: string }

/** 明确可展示的学生输入问题；完整性、身份与本机事务异常只进开发诊断。 */
export class RunInputError extends Error {}

export async function freezeRun(context: CommandContext, attemptRevision: number, snapshot: SnapshotView,
  profile: string, entryFileId: string, input: CoreInput): Promise<FrozenCommand> {
  if (!context.attemptId || !context.activityVersionId) throw new Error('请先开始并读取作品。')
  revision(attemptRevision, 1); requiredId(profile)
  const fixed = await verifySnapshot(snapshot, context.attemptId, context.activityVersionId)
  if (!fixed.files.some(f => f.fileId === entryFileId && f.path.endsWith('.c'))) throw new RunInputError('请选择这个快照里的 C 入口文件。')
  if (!Array.isArray(input.fileIds) || input.fileIds.length < 1 || input.fileIds.length > 50 ||
    new Set(input.fileIds).size !== input.fileIds.length) throw new RunInputError('请选择 1～50 个不同的输入文件。')
  if (input.fileIds.some(id => !fixed.files.some(f => f.fileId === id && /^[\x00-\x7f]*$/.test(f.text)))) throw new RunInputError('输入必须是这个快照里的 ASCII 文件。')
  let core: CoreInput
  if (input.operation === 'stats') core = { operation: 'stats', fileIds: [...input.fileIds] }
  else if (input.operation === 'find') {
    if (typeof input.word !== 'string' || !/^[A-Za-z0-9]+$/.test(input.word)) throw new RunInputError('查找词只能包含 ASCII 字母或数字。')
    core = { operation: 'find', fileIds: [...input.fileIds], word: input.word }
  } else if (input.operation === 'top') {
    if (typeof input.count !== 'string' || !/^[1-9][0-9]{0,9}$/.test(input.count) || BigInt(input.count) > 2147483647n) throw new RunInputError('数量须为 1～2147483647 的整数。')
    core = { operation: 'top', fileIds: [...input.fileIds], count: input.count }
  } else throw new RunInputError('请选择 stats、find 或 top。')
  const command = await freeze(context, 'run.create', `/attempts/${encodeURIComponent(context.attemptId)}/runs`,
    { recoveryGeneration: context.trustedRecoveryGeneration!, expectedAttemptRevision: attemptRevision,
      snapshotId: fixed.snapshotId, runtimeProfileVersion: profile, entryFileId, input: core, mode: 'run' } satisfies RunInput, null, [])
  command.runSnapshot = { hash: fixed.hash, workspaceRevision: fixed.workspaceRevision,
    files: fixed.files.map(({ fileId, path }) => ({ fileId, path })) }
  return command
}

export function verifyRunReceipt(command: FrozenCommand, value: unknown): Receipt<RunCreated> {
  if (command.kind !== 'run.create') throw new Error('缺少原运行命令')
  const receipt = verifyReceipt<RunCreated>(command, value)
  const input = JSON.parse(command.wireJson) as RunInput
  requiredId(receipt.result.runId); requiredId(receipt.result.jobId)
  if (receipt.result.snapshotId !== input.snapshotId) throw new Error('运行回执快照不符')
  return receipt
}
