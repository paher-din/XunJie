import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Link, Navigate, useLocation } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { XunjieLogo } from '../brand/XunjieLogo'
import { demoTasks } from '../bridge/mockData'
import { PREP_BUILD } from '../workspace/mode'
import { useTheme } from '../lib/theme'
import { getSessionState, loginSession, logoutSession, restoreSession, startSessionLifecycle, subscribeSession } from '../workspace/session'

export function useSession() {
  return useSyncExternalStore(subscribeSession, getSessionState)
}

function LoginForm() {
  const session = useSession()
  const teacherEntry = useLocation().pathname.startsWith('/teacher')
  useTheme()
  const accountInput = useRef<HTMLInputElement>(null)
  const [loginName, setLoginName] = useState('')
  const [password, setPassword] = useState('')
  const busy = session.status === 'checking' || session.status === 'signing-out'
  const logoutFailed = session.status === 'logout-failed'
  useEffect(() => {
    if (session.status === 'login') accountInput.current?.focus()
  }, [session.status])
  return (
    <main className="session-entry">
      <section className="session-card" aria-labelledby="session-title">
        <XunjieLogo format="horizontal" label="循阶" />
        <h1 id="session-title">{teacherEntry ? '登录教师工作台' : '登录学习空间'}</h1>
        <p>{teacherEntry ? '使用教师账号登录，查看任教课程与固定活动。' : '使用课程提供的账号登录，继续打开获准的任务。'}</p>
        <form onSubmit={event => {
          event.preventDefault()
          if (busy || logoutFailed) return
          const secret = password
          setPassword('')
          void loginSession(loginName.trim(), secret)
        }}>
          <label htmlFor="session-account">账号</label>
          <input ref={accountInput} id="session-account" name="username" autoComplete="username"
            required maxLength={128} value={loginName} disabled={busy || logoutFailed}
            onChange={event => setLoginName(event.target.value)} />
          <label htmlFor="session-password">密码</label>
          <input id="session-password" name="password" type="password" autoComplete="current-password"
            required maxLength={1024} value={password} disabled={busy || logoutFailed}
            onChange={event => setPassword(event.target.value)} />
          <div role="status" aria-live="polite" className="session-notice">
            {session.notice || (busy ? '正在核对登录状态…' : '')}
          </div>
          <button className="primary" type="submit" disabled={busy || logoutFailed}>
            {busy ? '请稍候…' : '登录'}
          </button>
        </form>
        {logoutFailed
          ? <button type="button" onClick={() => { void logoutSession() }}>重试退出</button>
          : <button type="button" disabled={busy} onClick={() => { void restoreSession() }}>重新读取当前会话</button>}
        <Link to={teacherEntry ? '/' : '/teacher'} style={{ display: 'block', marginTop: 16, fontSize: 13 }}>{teacherEntry ? '进入学生空间' : '进入教师工作台'}</Link>
        {import.meta.env.DEV && <Link to="/teacher/preview" style={{ display: 'block', marginTop: 12, fontSize: 13 }}>查看教师端交互预览</Link>}
      </section>
    </main>
  )
}

/** 准备工程及来源演示保持原样；正式入口未认证时不挂载工作区。 */
export default function SessionEntry({ children }: { children: ReactNode }) {
  const state = useSession()
  const location = useLocation()
  const queries = useQueryClient()
  const demo = demoTasks.some(task => location.pathname === `/task/${task.id}`)
  const preparation = PREP_BUILD && !location.pathname.startsWith('/teacher')
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
  if (state.status !== 'authenticated') return <LoginForm />
  if (location.pathname === '/' && state.session?.courses.some(course => course.role === 'teacher') &&
    !state.session.courses.some(course => course.role === 'student')) return <Navigate to="/teacher" replace />
  return <div className="session-shell" key={state.epoch}>
    {state.notice && <div className="session-health" role="status">
      {state.notice}<button type="button" onClick={() => { void restoreSession() }}>重新核对登录</button>
    </div>}
    {children}
  </div>
}
