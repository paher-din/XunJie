/**
 * 断线重连下的**原命令核对结论**。
 *
 * 依据 docs/tasks/I0_UI_CLIENT_CONTRACT.md §3/§5 与 I0_UI_04 的验收项：断线只允许「核对或重放同一原
 * 命令」，不得自动换键、改输入或把超时当拒绝/成功。这里把判定收成纯函数，UI 只负责展示结论，
 * 客户端只按结论行动；不新建第二份确认状态，事实仍留在 03 的 outbox 与确认头里。
 *
 * 结论分成两层文案，**不要混用**：
 * - \`studentHint\`：学生界面唯一可见的一句话——发生了什么、草稿还在不在、下一步做什么；
 * - \`diagnosticText\`：只进浏览器控制台的排障文本（错误码、原请求事实在 \`diagnostics.ts\` 里一并上报）。
 *
 * 三种「没有确认回执」的事实必须分开：
 * - \`unresolved\`：没拿到服务端信封（断线/超时/丢 ACK），可能未送达也可能已被接受；
 * - \`local-failed\`：回执到了，本机确认事务没提交，可重新接纳同一回执；
 * - \`rejected\`/\`conflict\`/\`recovery-required\`：服务明确拒绝、版本冲突或代际已变，停止旧重试。
 */

import type { ApiErrorCode } from './contracts'
import { CommandConfirmedError, CommandRejectedError, LeaseHeldError, sameGeneration } from './confirmationDb'
import { isTerminalRejection, type CommandContext, type FrozenCommand, type OutboxRecord } from './frozenCommand'
import { textHash } from './confirmation'
import { utf8Bytes } from '../lib/projectFiles'
import { WorkspaceRequestError } from './http'

export type CommandOutcome =
  | { kind: 'unresolved' }
  | { kind: 'local-failed' }
  | { kind: 'rejected'; code: ApiErrorCode }
  | { kind: 'conflict' }
  | { kind: 'recovery-required' }
  | { kind: 'lease-held' }
  | { kind: 'confirmed' }
  | { kind: 'historical' }

/** 能否重新核对原命令：未知、本机未确认、租约占用以及可重试的服务拒绝都可以。 */
export function canReplay(outcome: CommandOutcome | null): boolean {
  switch (outcome?.kind) {
    case 'unresolved':
    case 'local-failed':
    case 'lease-held':
      return true
    case 'rejected':
      return !isTerminalRejection(outcome.code)
    default:
      return false
  }
}

/**
 * 学生界面唯一可见的一句提示。
 *
 * 只回答学生真正需要的三件事：这次保存成没成、我的字还在不在、我现在能做什么。
 * 不出现错误码、命令键、代际、HTTP 状态、接口路径或服务原文——那些进控制台（\`diagnostics.ts\`）。
 */
export function studentHint(outcome: CommandOutcome | null): string {
  switch (outcome?.kind) {
    case undefined:
    case null:
    case 'confirmed':
      return '这次保存已完成。'
    case 'unresolved':
      return '这次保存的结果还没确认，草稿已保留。可以重试。'
    case 'local-failed':
      return '保存已经发出，但本地还没记完，草稿已保留。可以重试。'
    case 'lease-held':
      return '另一个标签页正在处理这次保存，请稍后再试。'
    case 'conflict':
      return '作品在别处有了新的版本。请先重新读取，再决定怎么保存。'
    case 'recovery-required':
      return '登录状态已更新。请重新读取后再保存。'
    case 'historical':
      return '这是较早的一次保存，已过有效期。请重新读取当前作品。'
    case 'rejected':
      return isTerminalRejection(outcome.code)
        ? '这次保存没能完成，草稿已保留。请重新读取后再保存。'
        : '服务暂时没能保存，草稿已保留。可以稍后重试。'
  }
}

/** 只进开发者控制台的诊断结论；学生界面不显示。 */
export function diagnosticText(outcome: CommandOutcome): string {
  switch (outcome.kind) {
    case 'unresolved': return 'no service envelope: request may be un-delivered or ACK lost'
    case 'local-failed': return 'receipt received, local confirmation transaction failed'
    case 'lease-held': return 'another tab holds the send lease'
    case 'confirmed': return 'original command already confirmed'
    case 'historical': return 'original command retired with an older recovery generation'
    case 'conflict': return 'service rejected the original command with VERSION_CONFLICT'
    case 'recovery-required': return 'service rejected the original command with RECOVERY_REQUIRED'
    case 'rejected': return `service rejected the original command with ${outcome.code}${isTerminalRejection(outcome.code) ? ' (terminal)' : ' (retryable)'}`
  }
}

/** 服务错误码到核对结论：版本冲突与代际变化各自单列，其余如实保留错误码。 */
export function outcomeOfCode(code: ApiErrorCode): CommandOutcome {
  if (code === 'VERSION_CONFLICT') return { kind: 'conflict' }
  if (code === 'RECOVERY_REQUIRED') return { kind: 'recovery-required' }
  return { kind: 'rejected', code }
}

/** 结论对应的服务错误码；「未知 / 本机未完成 / 租约」不是服务结论，返回 null。 */
export function codeOfOutcome(outcome: CommandOutcome): ApiErrorCode | null {
  if (outcome.kind === 'conflict') return 'VERSION_CONFLICT'
  if (outcome.kind === 'recovery-required') return 'RECOVERY_REQUIRED'
  return outcome.kind === 'rejected' ? outcome.code : null
}

/** 一次写请求失败的分类；\`receiptReceived\` 说明是否已核对到服务回执。 */
export function classifyWriteFailure(error: unknown, options: { receiptReceived: boolean }): CommandOutcome {
  if (error instanceof LeaseHeldError) return { kind: 'lease-held' }
  // 本机事务里读到的事实优先于网络结论：核对与领取租约之间另一标签可能已确认或记录拒绝。
  if (error instanceof CommandConfirmedError) return { kind: 'confirmed' }
  if (error instanceof CommandRejectedError) return outcomeOfCode(error.code)
  if (error instanceof WorkspaceRequestError && error.failure.kind === 'api' && !options.receiptReceived) {
    return outcomeOfCode(error.failure.error.code)
  }
  // 回执已到：后续任何失败都只说明本机确认没完成；没拿到信封则保持「未知」。
  return options.receiptReceived ? { kind: 'local-failed' } : { kind: 'unresolved' }
}

export type Reconciliation =
  | { action: 'none' }
  | { action: 'accept-local' }
  | { action: 'replay' }
  | { action: 'stop'; outcome: CommandOutcome }

/**
 * 按原命令的本机事实决定下一步：重放、只在本机重新接纳回执、或停止。
 *
 * 判定只看落盘事实（回执、状态、代际、已记录的拒绝），不看内存里的当前草稿，
 * 因此刷新、换标签、重连后得到同一结论。
 *
 * 只有调用方声明自己的发送身份时（\`options.owner\`，即真正要重放的那一刻）才判定发送租约：
 * 租约是有期限的，用它提前隐藏「重试上次保存」会让别的标签在租约到期后无从重试；
 * 抢租约的最终拦截仍由本机事务（claim）执行。
 */
export function reconcileStoredCommand(
  record: OutboxRecord | null,
  context: CommandContext,
  options: { owner?: string; now?: number } = {},
): Reconciliation {
  if (!record) return { action: 'none' }
  if (record.state === 'confirmed') return record.receipt ? { action: 'accept-local' } : { action: 'none' }
  if (record.state === 'historical') return { action: 'stop', outcome: { kind: 'historical' } }
  if (!sameGeneration(record.context, context)) return { action: 'stop', outcome: { kind: 'recovery-required' } }
  if (record.rejected) {
    const outcome = outcomeOfCode(record.rejected.code)
    // 可重试的拒绝只是「这次没被接受」的事实：允许学生明确重试；终态拒绝才停手。
    return isTerminalRejection(record.rejected.code) ? { action: 'stop', outcome } : { action: 'replay' }
  }
  const lease = record.lease
  if (lease && options.owner !== undefined && lease.owner !== options.owner && lease.until > (options.now ?? Date.now())) {
    return { action: 'stop', outcome: { kind: 'lease-held' } }
  }
  return { action: 'replay' }
}

/** 控制台诊断用的冻结事实：命令身份、冻结输入与逐文件摘要（不含 Session/CSRF，也不含作品全文）。 */
export interface OriginalRequestSummary {
  commandKey: string
  kind: FrozenCommand['kind']
  target: string
  recoveryGeneration: string
  createdAt: number
  expectedWorkspaceRevision?: number
  clientId?: string
  clientSeq?: number
  files: Array<{ label: string; bytes: number; hash: string }>
}

/**
 * 从冻结命令本身（不是当前草稿）生成诊断事实。
 *
 * 只读 wireJson 与冻结的 drafts；正文摘要用于和编辑器里的正文比对，不重新序列化业务输入，
 * 也不把 Session/CSRF 带进来（它们从不进 outbox）。
 */
export async function summarizeOriginalRequest(command: FrozenCommand): Promise<OriginalRequestSummary> {
  const body = JSON.parse(command.wireJson) as Record<string, unknown>
  const number = (value: unknown) => (Number.isSafeInteger(value) ? (value as number) : undefined)
  return {
    commandKey: command.commandKey,
    kind: command.kind,
    target: command.target,
    recoveryGeneration: command.context.trustedRecoveryGeneration ?? '',
    createdAt: command.createdAt,
    ...(number(body.expectedWorkspaceRevision) !== undefined
      ? { expectedWorkspaceRevision: number(body.expectedWorkspaceRevision) } : {}),
    ...(typeof body.clientId === 'string' ? { clientId: body.clientId } : {}),
    ...(number(body.clientSeq) !== undefined ? { clientSeq: number(body.clientSeq) } : {}),
    files: await Promise.all(command.drafts.map(async draft => ({
      label: draft.path, bytes: utf8Bytes(draft.text), hash: await textHash(draft.text),
    }))),
  }
}
