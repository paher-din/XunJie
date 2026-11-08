import type { ReactNode, RefObject } from 'react'
import { XunjieLogo } from '../brand/XunjieLogo'

export type EntryRole = 'student' | 'teacher'
export interface SessionLoginProps {
  entryRole: EntryRole
  loginName: string
  password: string
  busy: boolean
  logoutFailed: boolean
  notice?: string | null
  accountRef?: RefObject<HTMLInputElement | null>
  previewLink?: ReactNode
  onRoleChange: (role: EntryRole) => void
  onLoginNameChange: (value: string) => void
  onPasswordChange: (value: string) => void
  onSubmit: () => void
  onRetryLogout: () => void
  onRestoreSession: () => void
}

/** 登录界面只呈现状态并传递输入；认证和会话由宿主处理。 */
export function SessionLogin({ entryRole, loginName, password, busy, logoutFailed, notice, accountRef, previewLink,
  onRoleChange, onLoginNameChange, onPasswordChange, onSubmit, onRetryLogout, onRestoreSession }: SessionLoginProps) {
  return <main className="session-entry">
    <section className="session-card" aria-labelledby="session-title">
      <XunjieLogo format="horizontal" label="循阶" />
      <h1 id="session-title">登录学习空间</h1>
      <p>{entryRole === 'teacher' ? '使用教师账号登录，查看任教课程与固定活动。' : '使用课程提供的账号登录，继续打开获准的任务。'}</p>
      <div className="st-seg session-role-switch" role="group" aria-label="登录身份">
        {(['student', 'teacher'] as const).map(role => <button key={role} type="button"
          className={`st-seg-item${entryRole === role ? ' active' : ''}`} aria-pressed={entryRole === role}
          disabled={busy || logoutFailed} onClick={() => onRoleChange(role)}>{role === 'student' ? '学生' : '教师'}</button>)}
      </div>
      <form onSubmit={event => { event.preventDefault(); if (!busy && !logoutFailed) onSubmit() }}>
        <label htmlFor="session-account">账号</label>
        <input ref={accountRef} id="session-account" name="username" autoComplete="username"
          required maxLength={128} value={loginName} disabled={busy || logoutFailed}
          onChange={event => onLoginNameChange(event.target.value)} />
        <label htmlFor="session-password">密码</label>
        <input id="session-password" name="password" type="password" autoComplete="current-password"
          required maxLength={1024} value={password} disabled={busy || logoutFailed}
          onChange={event => onPasswordChange(event.target.value)} />
        <div role="status" aria-live="polite" className="session-notice">{notice || (busy ? '正在核对登录状态…' : '')}</div>
        <button className="primary" type="submit" disabled={busy || logoutFailed}>{busy ? '请稍候…' : '登录'}</button>
      </form>
      {logoutFailed
        ? <button type="button" onClick={onRetryLogout}>重试退出</button>
        : <button type="button" disabled={busy} onClick={onRestoreSession}>重新读取当前会话</button>}
      {previewLink}
    </section>
  </main>
}
