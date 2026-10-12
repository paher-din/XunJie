/**
 * 工作区开发者诊断（控制台）。
 *
 * 项目负责人 2026-10-12 的 UI 文案要求：**学生界面只保留真正需要的提示**，详细的技术事实——错误码、
 * 原命令键、clientId/clientSeq、受信代际、预期版本、HTTP 状态、服务原文、快照 ID/hash、冻结正文摘要
 * ——只留在能给开发和后台排障的地方。本模块就是那个地方：写到浏览器控制台，不进页面文案。
 *
 * 边界：
 * - 不记录会话 cookie、CSRF token 或任何 provider 凭据（它们本来也不进 outbox）；
 * - 不记录作品正文，只记录路径、字节数与 sha256 摘要；
 * - 只在真实事件发生时上报一次，不把诊断当作业务状态或确认依据。
 */

const TAG = '[i0-workspace]'

export type DiagnosticEvent =
  /** 原命令发送前：身份、冻结输入与归属。 */
  | 'command.sent'
  /** 原命令得到服务回执。 */
  | 'command.acknowledged'
  /** 原命令只作为历史事实保留（旧代际/迟到回执）。 */
  | 'command.historical'
  /** 原命令失败或其结论发生变化。 */
  | 'command.failed'
  /** 学生对原命令做的核对动作与结果。 */
  | 'command.reconciled'
  /** 准备/工作区上下文变化（换代际、重载）。 */
  | 'context.changed'
  /** 快照冻结与核验结果。 */
  | 'snapshot.frozen'

/** 上报一条诊断。detail 只放可序列化的排障字段，不放正文与凭据。 */
export function reportDiagnostic(event: DiagnosticEvent, detail: object): void {
  if (typeof console === 'undefined' || typeof console.info !== 'function') return
  console.info(`${TAG} ${event}`, detail)
}

/** 把未知异常整理成可读的排障文本（学生界面不显示这一份）。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
