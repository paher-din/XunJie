import { WorkspaceRequestError } from './http'
import type { TutorCommand } from './tutoringStore'

// Only these deliberate student-operation guards may contribute an exception's text to a notice.
// HTTP/protocol/storage exceptions and all other details remain in the diagnostic channel.
const studentGuards = new Set([
  '当前尝试未读取，问题未发送',
  '模型配置正在读取或保存，请确认后再发送。',
  '等待期间已停止帮助，原问题未发送。',
  '限定检查进行中，当前不能发送辅导问题。',
  '限定检查状态尚未确认，请重新读取后再求助。',
  '所指代码或原对象已改变，问题未发送；请重新核对',
  '当前尝试不允许新求助',
  '求助对象不属于当前尝试',
  '所选 HDL 来源已变化或尚未核对，问题未发送',
  '所选 HDL 来源在发送前改变，原问题未发送。',
])

const apiNotices = {
  UNAUTHENTICATED: { status: 401, notice: '登录已失效，请重新登录后继续。' },
  FORBIDDEN: { status: 403, notice: '当前账号没有这项辅导内容的访问权限，请核对任务链接或重新登录。' },
  RECOVERY_REQUIRED: { status: 409, notice: '工作区恢复状态已改变，请重新载入后再操作。' },
  VERSION_CONFLICT: { status: 409, notice: '作品或控制状态已改变，请重新读取后再操作。' },
  STATE_CONFLICT: { status: 409, notice: '当前状态不允许这项辅导操作，请重新读取后再操作。' },
  INVALID_REFERENCE: { status: 422, notice: '所指对象尚未取得确认，请重新选择并核对。' },
  RATE_LIMITED: { status: 429, notice: '操作过于频繁，请稍后明确重试。' },
  BUDGET_EXHAUSTED: { status: 429, notice: '辅导预算不可用，编辑和保存仍可继续，也可以联系教师获得支持。' },
} as const
function apiNotice(code: string, status: number): string {
  const value = Object.hasOwn(apiNotices, code) ? apiNotices[code as keyof typeof apiNotices] : undefined
  return value?.status === status ? value.notice : ''
}

function storageFailed(error: unknown): boolean {
  if (error instanceof WorkspaceRequestError) return false
  return error instanceof Error && ['写入事务被中止', '写入事务失败', 'IndexedDB 打开失败', 'IndexedDB 被其他连接阻塞'].includes(error.message)
    || typeof DOMException !== 'undefined' && error instanceof DOMException &&
      ['AbortError', 'QuotaExceededError', 'InvalidStateError', 'TransactionInactiveError', 'ReadOnlyError',
        'DataError', 'DataCloneError', 'UnknownError', 'VersionError', 'SecurityError'].includes(error.name)
}

/** Display-only explanation. Never changes the persisted error, command state or retry decision. */
export function tutoringFailureNotice(error: unknown, fallback: string): string {
  if (error instanceof WorkspaceRequestError && error.failure.kind === 'api') {
    const notice = apiNotice(error.failure.error.code, error.failure.status)
    if (notice) return notice
  }
  if (storageFailed(error)) return '辅导记录没有保存到本机，请恢复本机存储后重新读取；未确认的求助不会自动发送。'
  if (error instanceof Error && error.message === '同一教学动作的正文发生冲突')
    return '新收到的辅导正文与原记录不一致，这次未接纳。已展示的原内容保留，请重新读取核对。'
  if (error instanceof Error && error.message === '同一教学动作的原始来源发生冲突')
    return '新收到的辅导来源与原记录不一致，这次未接纳。已展示的原内容保留，请重新读取核对。'
  if (error instanceof Error && ['原辅导代际已退役，请重新载入', '原历史读取代际已退役，请重新载入',
    '服务代际已改变，请重新载入工作区'].includes(error.message)) return '工作区恢复状态已改变，请重新载入后再操作。'
  return error instanceof Error && studentGuards.has(error.message) ? error.message : fallback
}

/** A non-retryable read rejection pauses automatic reads, without inferring a permanent capability. */
export function tutoringReadRejectionNotice(error: unknown): string {
  return `服务未接纳这次辅导读取。${tutoringFailureNotice(error, '')}自动读取已暂停，请明确点击“重新读取辅导”再次核对；编辑和保存仍可继续。`
}

/** The original error string is retained in the ledger; the student's view follows its existing state. */
export function tutoringCommandFailureNotice(command: Pick<TutorCommand, 'kind' | 'state' | 'error'>, failure?: unknown): string {
  if (command.error && studentGuards.has(command.error)) return command.error
  // Stored commands keep the exact original Error.message. Recognize only http.ts's anchored API
  // rendering with a known code/status pair; never guess from arbitrary words or protocol/transport text.
  const api = command.error?.match(/^(?:GET|POST) [^\r\n]+ 失败 · ([A-Z_]+)（HTTP ([1-5][0-9]{2})）：/)
  const reason = failure !== undefined ? tutoringFailureNotice(failure, '') : api ? apiNotice(api[1]!, Number(api[2])) : ''
  if (command.state === 'confirmed') return `原请求已确认，后续状态待读。${reason || '请重新读取辅导。'}`
  if (command.state === 'rejected') return command.kind === 'help'
    ? `服务未接纳这次请求。${reason}原问题保留，可以在条件恢复后明确发起新问题。`
    : `服务未接纳这次停止请求。${reason}原请求已保留，请重新读取后再操作。`
  return command.kind === 'help'
    ? '请求结果未知。原问题和请求已保留，请先核对原辅导请求。'
    : '停止请求结果未知。原请求已保留，请先核对；尚不能确认帮助已停止。'
}
