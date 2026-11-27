import { agentSessionSchema, type AgentSession } from '@xunjie/contracts/agent-sessions'

/** 记住每门课上次打开的教师对话，让再次进入课程时不必等会话列表返回。 */
const PREFIX = 'xj.teacher-course-session.v1.'
const TTL = 30 * 60 * 1000
interface Saved { sessionId?: unknown; savedAt?: unknown; session?: unknown }
const key = (scope: string) => PREFIX + scope
const forget = (scope: string) => { try { sessionStorage.removeItem(key(scope)) } catch { /* ignore */ } }

export function readTeacherCourseSession(scope: string): AgentSession | undefined {
  try {
    const raw = sessionStorage.getItem(key(scope))
    if (!raw) return
    const saved = JSON.parse(raw) as Saved
    if (typeof saved.sessionId !== 'string' || typeof saved.savedAt !== 'number'
      || !Number.isFinite(saved.savedAt) || Date.now() - saved.savedAt > TTL) {
      forget(scope)
      return
    }
    const parsed = agentSessionSchema.safeParse(saved.session)
    if (!parsed.success || parsed.data.sessionId !== saved.sessionId
      || parsed.data.state !== 'ready' || parsed.data.deleted || parsed.data.archived) {
      forget(scope)
      return
    }
    return parsed.data
  } catch { forget(scope) }
}

export function writeTeacherCourseSession(scope: string, session: AgentSession) {
  try {
    if (session.state !== 'ready' || session.deleted || session.archived) { forget(scope); return }
    sessionStorage.setItem(key(scope), JSON.stringify({ sessionId: session.sessionId, savedAt: Date.now(), session }))
  } catch { /* 存储已满或被禁用时继续走服务端 */ }
}

export function clearTeacherCourseSession(scope: string) {
  forget(scope)
}
