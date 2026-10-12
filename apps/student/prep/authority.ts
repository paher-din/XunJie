/**
 * 准备模式的 authority 状态，归 Vite 开发进程持有。
 *
 * 依据 docs/tasks/I0_UI_CLIENT_CONTRACT.md §2：浏览器刷新与新标签读同一个进程状态；
 * 开发进程重启后 authority 重置并换 preparation epoch 与合成受信代际，因此旧的「已确认」
 * 缓存不能当新 head。
 *
 * 这里**不实现真实鉴权**：不做口令哈希存储、不做限流窗口、不发 `__Host-` Secure cookie。
 * 真实会话的 `__Host-xunjie`（`Path=/; HttpOnly; SameSite=Lax; Secure`，见
 * `apps/teaching/server/access/app.ts:34-35`）在 `http://127.0.0.1:5180` 上无法下发，
 * 属交接项 H-01；准备模式用非 Secure 的开发 cookie 名，只为让客户端走同一条请求代码路径。
 */

import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { SCENARIO_ID, SYNTHETIC_ACCOUNT } from './scenario'

const bootSecret = randomBytes(32)
const bootId = randomBytes(6).toString('hex')

/** 开发进程本次启动的准备 epoch；重启即换代。 */
export const preparationEpoch = `prep-epoch-${bootId}`

/** 合成受信 recoveryGeneration；仅准备模式有效，不是真实代际来源（H-03）。 */
export const syntheticRecoveryGeneration = `prep-gen-${bootId}`

/** 开发专用会话 cookie 名（非 `__Host-`，无 Secure；见文件头说明）。 */
export const SESSION_COOKIE = 'i0prep_session'

export interface PrepSession {
  scenarioId: string
  sessionId: string
  csrfToken: string
  userId: string
  loginName: string
  courseId: string
}

const sessions = new Map<string, PrepSession>()

/** CSRF token 的生成方式与真实实现同构：HMAC-SHA256(secret, "xunjie-csrf\0" + sessionId) 的 base64url。 */
function csrfOf(sessionId: string): string {
  return createHmac('sha256', bootSecret).update(`xunjie-csrf\0${sessionId}`).digest('base64url')
}

export function createSession(loginName: string, scenarioId = SCENARIO_ID): PrepSession {
  const sessionId = randomUUID()
  const session: PrepSession = {
    scenarioId,
    sessionId,
    csrfToken: csrfOf(sessionId),
    userId: SYNTHETIC_ACCOUNT.userId,
    loginName,
    courseId: SYNTHETIC_ACCOUNT.courseId,
  }
  sessions.set(sessionId, session)
  return session
}

export function sessionOf(sessionId: string | undefined, scenarioId = SCENARIO_ID): PrepSession | null {
  if (!sessionId) return null
  const session = sessions.get(sessionId)
  return session?.scenarioId === scenarioId ? session : null
}

export function destroySession(sessionId: string | undefined): void {
  if (sessionId) sessions.delete(sessionId)
}

/** 当前 authority 的活跃会话数；诊断与测试用，不含任何正文或凭据。 */
export function authoritySummary(scenarioId = SCENARIO_ID) {
  return {
    scenarioId,
    preparationEpoch,
    recoveryGeneration: syntheticRecoveryGeneration,
    activeSessions: [...sessions.values()].filter(session => session.scenarioId === scenarioId).length,
  }
}

/** 从 `Cookie` 头里取准备会话 cookie。 */
export function readSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim()
  }
  return undefined
}
