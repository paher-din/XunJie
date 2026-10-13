import type { LogoutView } from './contracts'
import { apiPost, setCsrfToken } from './http'
import type { WorkspaceMode } from './mode'

/**
 * POST `/api/logout`：结束当前会话。由学生明确发起，不自动调用。
 * 无论服务端是否成功，本机都不再保留 CSRF token；失败如实抛出，不回退成「已退出」。
 */
export async function signOut(mode: WorkspaceMode): Promise<void> {
  try {
    await apiPost<LogoutView>('/logout', {}, { mode })
  } finally {
    setCsrfToken(null)
  }
}
