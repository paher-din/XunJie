import type { LogoutView, SessionCreatedView, SessionView } from './contracts'
import { apiGet, apiPost, invalidateSessionRequests, onSessionExpired, onSessionRead, setCsrfToken, WorkspaceRequestError } from './http'
import { invalidateWorkspaceContext } from './context'
import type { WorkspaceMode } from './mode'
import { clearExecutionNodes } from './executionNodes'

/**
 * POST `/api/logout`：结束当前会话。由学生明确发起，不自动调用。
 * 准备模式失败仍抛出；正常模式交由全局会话入口呈现失败与重试。
 */
export async function signOut(mode: WorkspaceMode): Promise<void> {
  if (mode === 'real') return logoutSession()
  try {
    await apiPost<LogoutView>('/logout', {}, { mode })
  } finally {
    setCsrfToken(null)
  }
}

export interface SessionState {
  status: 'checking' | 'authenticated' | 'login' | 'signing-out' | 'logout-failed'
  session: SessionView | null
  epoch: number
  notice: string
}

let state: SessionState = { status: 'checking', session: null, epoch: 0, notice: '' }
const listeners = new Set<() => void>()
let operation = 0
let channel: BroadcastChannel | null = null
const sessionRequest = { mode: 'real' as const, timeoutMs: 15_000 }

export const getSessionState = (): SessionState => state
export function subscribeSession(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
function publish(next: SessionState): void {
  state = next
  for (const listener of listeners) listener()
}
function isolate(status: SessionState['status'], notice: string): number {
  operation += 1
  invalidateWorkspaceContext()
  invalidateSessionRequests()
  clearExecutionNodes()
  setCsrfToken(null)
  publish({ status, session: null, epoch: state.epoch + 1, notice })
  return operation
}
onSessionExpired(() => {
  const notice = state.status === 'authenticated'
    ? '登录已失效，请重新登录。你的本机草稿已按账号保留。'
    : '请登录后继续。本机草稿已按账号保留。'
  isolate('login', notice)
})

function validSession(value: SessionView): boolean {
  return !!value && typeof value.userId === 'string' && value.userId.length > 0 &&
    typeof value.csrfToken === 'string' && value.csrfToken.length > 0 && Array.isArray(value.courses) &&
    value.courses.every(c => !!c && typeof c.courseId === 'string' && c.courseId.length > 0 && ['student', 'teacher'].includes(c.role))
}
onSessionRead(value => {
  const session = value as SessionView
  if (state.status !== 'authenticated' || !state.session || !validSession(session)) return
  if (state.session.userId === session.userId && state.session.csrfToken === session.csrfToken) return
  // 外部登录/同账号新会话亦须换 loadEpoch；旧初始化不能带着新 CSRF 继续发送。
  isolate('checking', '')
  setCsrfToken(session.csrfToken)
  publish({ status: 'authenticated', session, epoch: state.epoch, notice: '' })
})
function unauthenticated(error: unknown): boolean {
  return error instanceof WorkspaceRequestError && error.failure.kind === 'api' &&
    error.failure.status === 401 && error.failure.error.code === 'UNAUTHENTICATED'
}
function readFailure(error: unknown): string {
  if (unauthenticated(error)) return '请登录后继续。'
  return '登录服务暂时无法连接，请稍后重试。'
}

/** Session 的身份与 CSRF 必须来自服务端；刷新/重新认证不创建教学对象。 */
export async function restoreSession(): Promise<void> {
  if (state.status === 'signing-out' || state.status === 'logout-failed') return
  const current = ++operation
  try {
    const session = await apiGet<SessionView>('/session', sessionRequest)
    if (current !== operation) return
    if (!validSession(session)) throw new Error('Invalid session projection')
    setCsrfToken(session.csrfToken)
    publish({ status: 'authenticated', session, epoch: state.epoch, notice: '' })
  } catch (error) {
    if (current !== operation) return
    if (state.status === 'authenticated' && state.session && !unauthenticated(error)) {
      // 断网/协议故障不证明 Cookie 已失效，保留本机编辑，写入仍由服务端鉴权。
      publish({ ...state, notice: '当前登录状态暂时无法核对，可继续本机编辑。联网后请重新核对。' })
      return
    }
    isolate('login', readFailure(error))
  }
}

export async function loginSession(loginName: string, password: string): Promise<void> {
  const current = isolate('checking', '')
  try {
    const created = await apiPost<SessionCreatedView>('/sessions', { loginName, password }, sessionRequest)
    if (current !== operation) return
    if (typeof created?.csrfToken !== 'string' || !created.csrfToken) throw new Error('Invalid session response')
    // POST 只有 CSRF；重新读取 Session，不能把输入账号名当作 userId。
    const session = await apiGet<SessionView>('/session', sessionRequest)
    if (current !== operation) return
    if (!validSession(session)) throw new Error('Invalid session projection')
    setCsrfToken(session.csrfToken)
    publish({ status: 'authenticated', session, epoch: state.epoch, notice: '' })
    channel?.postMessage('changed')
  } catch (error) {
    if (current !== operation) return
    let notice = readFailure(error)
    if (unauthenticated(error)) notice = '账号或密码不正确，请重新输入。'
    else if (error instanceof WorkspaceRequestError && error.failure.kind === 'api' && error.failure.status === 429) {
      notice = '登录尝试过于频繁，请稍后再试。'
    }
    isolate('login', notice)
  }
}

export async function logoutSession(): Promise<void> {
  if (state.status === 'signing-out') return
  const token = state.session?.csrfToken
  const current = isolate('signing-out', '正在退出登录…')
  // 失效旧上下文后，只为这次明确退出取得当前 CSRF；不留给下一会话。
  if (token) setCsrfToken(token)
  channel?.postMessage('changed')
  try {
    if (!token) {
      const session = await apiGet<SessionView>('/session', sessionRequest)
      if (current !== operation) return
      if (!validSession(session)) throw new Error('Invalid session projection')
      setCsrfToken(session.csrfToken)
    }
    const result = await apiPost<LogoutView>('/logout', {}, sessionRequest)
    if (current !== operation) return
    if (result?.loggedOut !== true) throw new Error('Invalid logout response')
    isolate('login', '已退出登录。本机草稿已按账号保留。')
    channel?.postMessage('changed')
  } catch (error) {
    if (current !== operation) return
    isolate('logout-failed', '退出未确认，请重试退出后再切换账号。')
  } finally {
    // 仅清理本次操作；迟到 finally 不得清空下一会话的 CSRF。
    if (state.status !== 'authenticated') setCsrfToken(null)
  }
}

/** 跨标签页只广播改变事实；前台恢复重读 Session，不广播身份或凭据。 */
export function startSessionLifecycle(): () => void {
  if (typeof BroadcastChannel !== 'undefined') {
    try {
      channel = new BroadcastChannel('xunjie-session')
      channel.onmessage = event => {
        if (event.data !== 'changed') return
        isolate('login', '其他页面的登录状态已改变，请重新登录或读取当前会话。')
      }
    } catch { channel = null }
  }
  const resume = () => {
    if (document.visibilityState === 'visible' && state.status === 'authenticated') void restoreSession()
  }
  window.addEventListener('focus', resume)
  document.addEventListener('visibilitychange', resume)
  return () => {
    window.removeEventListener('focus', resume)
    document.removeEventListener('visibilitychange', resume)
    channel?.close()
    channel = null
  }
}
