import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { SessionLogin, type EntryRole } from '@xunjie/ui/foundation'
import { demoTasks } from '../bridge/mockData'
import { PREP_BUILD } from '../workspace/mode'
import { useTheme } from '../lib/theme'
import { getSessionState, loginSession, logoutSession, restoreSession, startSessionLifecycle, subscribeSession } from '../workspace/session'

export function useSession() {
  return useSyncExternalStore(subscribeSession, getSessionState)
}

export function LoginForm({ onEntryIntent }: { onEntryIntent: (role: EntryRole) => void }) {
  const session = useSession()
  const teacherEntry = useLocation().pathname.startsWith('/teacher')
  useTheme()
  const accountInput = useRef<HTMLInputElement>(null)
  const [loginName, setLoginName] = useState('')
  const [password, setPassword] = useState('')
  const [entryRole, setEntryRole] = useState<EntryRole>(teacherEntry ? 'teacher' : 'student')
  const busy = session.status === 'checking' || session.status === 'signing-out'
  const logoutFailed = session.status === 'logout-failed'
  useEffect(() => {
    if (session.status === 'login') accountInput.current?.focus()
  }, [session.status])
  return <SessionLogin entryRole={entryRole} loginName={loginName} password={password} busy={busy}
    logoutFailed={logoutFailed} notice={session.notice} accountRef={accountInput}
    onRoleChange={setEntryRole} onLoginNameChange={setLoginName} onPasswordChange={setPassword}
    onSubmit={() => {
      const secret = password
      setPassword('')
      onEntryIntent(entryRole)
      void loginSession(loginName.trim(), secret)
    }}
    onRetryLogout={() => { void logoutSession() }} onRestoreSession={() => { void restoreSession() }}
    previewLink={import.meta.env.DEV ? <Link to="/teacher/preview" style={{ display: 'block', marginTop: 12, fontSize: 13 }}>查看教师端交互预览</Link> : undefined} />
}

/** 准备工程及来源演示保持原样；正式入口未认证时不挂载工作区。 */
export default function SessionEntry({ children }: { children: ReactNode }) {
  const state = useSession()
  const location = useLocation()
  const [entryIntent, setEntryIntent] = useState<EntryRole | null>(null)
  const queries = useQueryClient()
  const demo = demoTasks.some(task => location.pathname === `/task/${task.id}`)
  const preparation = PREP_BUILD && !location.pathname.startsWith('/teacher')
  const teacherPath = location.pathname.startsWith('/teacher')
  const hasTeacher = state.session?.courses.some(course => course.role === 'teacher') === true
  const hasStudent = state.session?.courses.some(course => course.role === 'student') === true
  // The choice is a landing preference. Only authenticated course roles authorize either space.
  const landing = (entryIntent === 'teacher' && hasTeacher && !teacherPath || !hasStudent && hasTeacher && !teacherPath) ? '/teacher'
    : (entryIntent === 'student' && hasStudent && teacherPath || !hasTeacher && hasStudent && teacherPath) ? '/' : null
  useEffect(() => {
    if (state.status === 'authenticated' && !landing) setEntryIntent(null)
  }, [state.status, landing])
  useEffect(() => {
    if (preparation || demo) return
    const stop = startSessionLifecycle()
    void restoreSession()
    return stop
  }, [demo, preparation])
  useLayoutEffect(() => {
    if (!preparation && !demo) queries.clear()
  }, [state.epoch, queries, demo, preparation])
  if (preparation || demo) return children
  if (state.status !== 'authenticated') return <LoginForm onEntryIntent={setEntryIntent} />
  if (landing) return <Navigate to={landing} replace />
  const notice = state.notice || (!hasTeacher && !hasStudent ? '当前账号还没有课程角色，请联系负责人分配课程。' : '')
  return <div className="session-shell" key={state.epoch}>
    {notice && <div className="session-health" role="status">
      {notice}<button type="button" onClick={() => { void restoreSession() }}>重新核对登录</button>
    </div>}
    {children}
  </div>
}
