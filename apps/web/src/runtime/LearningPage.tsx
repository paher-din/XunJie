import { useEffect, useRef, useState } from 'react'
import { activitySchema, createActivitySchema } from '@xunjie/contracts/learning-data'
import type { LearningActivity, CreateActivity } from '@xunjie/contracts/learning-data'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { useTheme } from '../lib/theme'
import './learning.css'

type Context = { clientNamespace: string; profile: string; identities: { key: string; identity: SpaceIdentity }[] }
type PendingConnection = { requestId: string; authorizationUrl: string }
const messages: Record<string, string> = {
  forbidden: '访问资格已失效，请重新登录或联系学校管理员。原活动仍属于原空间。',
  missing: '无法找到或无权访问这项活动，请返回列表核对。',
  'identity-conflict': '这个请求已使用其他内容，请先核对原请求结果。',
  unavailable: '暂时无法连接原服务，请稍后重试。',
  invalid: '请检查填写的内容。', maintenance: '学习服务正在维护，请稍后重试。',
}
async function api(path: string, body?: unknown, key?: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch('/api/learning/' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-xj-space': key } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: signal ?? AbortSignal.timeout(10000), credentials: 'same-origin' })
  const result = await response.json()
  if (!response.ok) {
    const failure = new Error(messages[result.error] ?? '操作结果尚未确认，请核对原请求后重试。') as Error & { code?: string }
    failure.code = result.error
    throw failure
  }
  return result
}
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。'

export function LearningPage() {
  useTheme()
  const [context, setContext] = useState<Context | null>(null)
  const [key, setKey] = useState('')
  const [activities, setActivities] = useState<LearningActivity[] | null>(null)
  const [opened, setOpened] = useState<LearningActivity | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [goal, setGoal] = useState('')
  const [question, setQuestion] = useState('')
  const [reference, setReference] = useState('')
  const [loginName, setLoginName] = useState('')
  const [password, setPassword] = useState('')
  const [schoolEndpoint, setSchoolEndpoint] = useState('')
  const [pendingConnection, setPendingConnection] = useState<PendingConnection | null>(null)
  const [pendingRequest, setPendingRequest] = useState<CreateActivity | null>(null)
  const [notice, setNotice] = useState('')
  const [reload, setReload] = useState(0)
  const epoch = useRef(0)
  const formScope = useRef('')
  const authorize = new URLSearchParams(location.search).get('authorize')
  const identity = context?.identities.find(item => item.key === key)?.identity
  const pendingKey = context && identity ? `xj.activity-request.${context.clientNamespace}.${identity.environmentId}.${identity.spaceId}.${identity.principalId}` : ''

  async function refreshContext(prefer?: string, generation = epoch.current) {
    const next = await api('context') as Context
    if (generation !== epoch.current) return
    setOpened(null); setActivities(null)
    setContext(next)
    setReload(value => value + 1)
    setKey(previous => prefer && next.identities.some(item => item.key === prefer) ? prefer
      : next.identities.some(item => item.key === previous) ? previous : next.identities[0]?.key ?? '')
  }
  useEffect(() => {
    let disposed = false
    void api('context').then(result => {
      if (!disposed) { const next = result as Context; setContext(next); setKey(next.identities[0]?.key ?? '') }
    }).catch(error => { if (!disposed) setError(errorText(error)) })
    return () => { disposed = true }
  }, [])
  useEffect(() => {
    const generation = ++epoch.current
    const controller = new AbortController()
    setActivities(null); setOpened(null); setError(''); setPendingRequest(null); setBusy(false)
    if (formScope.current !== pendingKey) {
      formScope.current = pendingKey; setGoal(''); setQuestion(''); setReference('')
    }
    if (key && pendingKey) {
      try {
        const saved = localStorage.getItem(pendingKey)
        if (saved) {
          const pending = createActivitySchema.parse(JSON.parse(saved))
          setPendingRequest(pending); setGoal(pending.goal); setQuestion(pending.question); setReference(pending.references[0]?.url ?? '')
        }
      } catch { setError('无法读取上次活动请求，请保留当前输入并检查浏览器存储。') }
      void api('activities', undefined, key, controller.signal).then(value => {
        if (epoch.current === generation) setActivities((value as unknown[]).map(item => activitySchema.parse(item)))
      }).catch(error => { if (epoch.current === generation && !controller.signal.aborted) setError(errorText(error)) })
    }
    return () => { ++epoch.current; controller.abort() }
  }, [key, pendingKey, reload])

  function switchSpace(next: string) {
    if (next === key) return
    ++epoch.current; setKey(next); setOpened(null); setActivities(null); setError(''); setNotice('')
    setGoal(''); setQuestion(''); setReference(''); setBusy(false)
  }
  async function action(operation: (generation: number) => Promise<void>) {
    const generation = epoch.current
    setBusy(true); setError(''); setNotice('')
    try { await operation(generation) } catch (error) { if (generation === epoch.current) setError(errorText(error)) }
    finally { if (generation === epoch.current) setBusy(false) }
  }
  async function createActivity() {
    const generation = epoch.current
    const scopeKey = pendingKey
    const selected = key
    const input = pendingRequest ?? createActivitySchema.parse({ requestId: crypto.randomUUID(), goal, question,
      references: reference ? [{ kind: 'url', url: reference, label: reference }] : [] })
    // Persist the exact request before dispatch; an unknown result keeps this identity across reloads.
    localStorage.setItem(scopeKey, JSON.stringify(input))
    setPendingRequest(input)
    try {
      const existing = await api('receipts/' + input.requestId, undefined, selected)
      const activity = activitySchema.parse(existing ?? await api('activities', input, selected))
      const saved = localStorage.getItem(scopeKey)
      if (saved && createActivitySchema.parse(JSON.parse(saved)).requestId === input.requestId) localStorage.removeItem(scopeKey)
      if (generation === epoch.current) {
        setPendingRequest(null); setOpened(activity); setActivities(previous => [activity, ...(previous ?? []).filter(item => item.activityId !== activity.activityId)])
        setGoal(''); setQuestion(''); setReference('')
      }
    } catch (error) {
      // A rejected input can never succeed under this request identity; let the student edit again.
      if ((error as { code?: string }).code === 'invalid') {
        const saved = localStorage.getItem(scopeKey)
        if (saved && createActivitySchema.parse(JSON.parse(saved)).requestId === input.requestId) localStorage.removeItem(scopeKey)
        if (generation === epoch.current) setPendingRequest(null)
      }
      throw error
    }
  }
  function discardPending() {
    if (pendingKey) localStorage.removeItem(pendingKey)
    setPendingRequest(null); setGoal(''); setQuestion(''); setReference(''); setError('')
  }
  async function openActivity(activityId: string) {
    const generation = epoch.current
    const activity = activitySchema.parse(await api('activities/' + activityId, undefined, key))
    if (generation === epoch.current) setOpened(activity)
  }
  async function changeStatus(activity: LearningActivity) {
    const generation = epoch.current
    const next = activitySchema.parse(await api('activity-status', { requestId: crypto.randomUUID(), activityId: activity.activityId,
      status: activity.status === 'closed' ? 'open' : 'closed' }, key))
    if (generation === epoch.current) { setOpened(next); setActivities(previous => previous?.map(item => item.activityId === next.activityId ? next : item) ?? null) }
  }

  return <main className="learning-page">
    <header><div><p className="eyebrow">循阶 · 学习空间</p><h1>{identity?.name ?? '从这里开始学习'}</h1></div>
      <a href="?diagnostics=1">运行诊断</a></header>
    {context && <nav aria-label="学习空间" className="space-switcher">
      {context.identities.map(item => <button type="button" key={item.key} aria-pressed={item.key === key}
        onClick={() => switchSpace(item.key)}>{item.identity.kind === 'personal' ? '个人空间' : '学校空间'}
        {context.identities.filter(other => other.identity.kind === 'school').length > 1 && item.identity.kind === 'school' ? ` · ${item.identity.name}` : ''}</button>)}
      <button type="button" disabled={busy} onClick={() => void action(async generation => {
        await refreshContext(undefined, generation)
      })}>刷新列表</button>
    </nav>}
    {error && <p className="learning-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!context && !error && <p role="status">正在连接学习空间…</p>}
    {authorize && <section aria-labelledby="approve-title"><h2 id="approve-title">连接这台客户端</h2>
      <p>确认后，此客户端可以使用你在本学校的学习活动。你可以随时撤销连接。</p>
      <button type="button" className="primary" disabled={busy || !context?.identities.some(item => item.key === 'school')}
        onClick={() => void action(async () => { await api('connections/approve', { requestId: authorize }); setNotice('连接已批准，请返回原客户端完成连接。') })}>允许连接</button>
    </section>}
    {identity && <>
      {opened ? <section aria-labelledby="activity-title">
        <button type="button" onClick={() => setOpened(null)}>返回活动列表</button>
        <h2 id="activity-title">{opened.goal || opened.question || '资料学习'}</h2>
        {opened.question && opened.goal && <p className="preserve-lines">{opened.question}</p>}
        {opened.references.map((item, index) => <p key={index}><a href={item.url} target="_blank" rel="noreferrer">{item.label}</a></p>)}
        <p className="detail">{opened.status === 'closed' ? '活动已关闭，可随时重新开始。' : '继续围绕这个目标学习。'}</p>
        <button type="button" disabled={busy} onClick={() => void action(() => changeStatus(opened))}>{opened.status === 'closed' ? '重新开始活动' : '关闭活动'}</button>
      </section> : <>
        <section aria-labelledby="new-activity-title"><h2 id="new-activity-title">开始一次自主学习</h2><p className="detail">从一个目标、问题或资料开始。</p>
          <form onSubmit={event => { event.preventDefault(); void action(createActivity) }}>
            <label>学习目标<input value={goal} maxLength={4000} disabled={!!pendingRequest} onChange={event => setGoal(event.target.value)} /></label>
            <label>起始问题<textarea value={question} maxLength={10000} disabled={!!pendingRequest} onChange={event => setQuestion(event.target.value)} rows={3} /></label>
            <label>资料链接（可选）<input type="url" value={reference} disabled={!!pendingRequest} onChange={event => setReference(event.target.value)} placeholder="https://" /></label>
            {pendingRequest && <p className="detail">上次建立活动的结果尚未核对，将先查询原请求。</p>}
            {pendingRequest && <button type="button" disabled={busy} onClick={discardPending}>放弃这次请求并重新填写</button>}
            <button className="primary" disabled={busy || !pendingRequest && !goal.trim() && !question.trim() && !reference}>
              {busy ? '正在处理…' : pendingRequest ? '核对并继续原请求' : '建立学习活动'}</button>
          </form>
        </section>
        <section aria-labelledby="activities-title"><h2 id="activities-title">我的学习活动</h2>
          {activities === null ? <p>{error ? '列表尚未读取成功。' : '正在读取活动…'}</p> : activities.length === 0 ? <p className="detail">还没有学习活动，从上面开始。</p>
            : <ul>{activities.map(activity => <li key={activity.activityId} className="activity-row"><button type="button" disabled={busy}
              onClick={() => void action(() => openActivity(activity.activityId))}>{activity.goal || activity.question || '资料学习'}</button>
              <span className="detail">{activity.status === 'closed' ? '已关闭' : '进行中'}</span></li>)}</ul>}
        </section>
      </>}
    </>}
    {context && <section aria-labelledby="school-title"><h2 id="school-title">学校学习空间</h2>
      {context.identities.some(item => item.key === 'school') ? <button type="button" disabled={busy} onClick={() => void action(async generation => {
        await api('logout', {}); if (generation !== epoch.current) return
        setOpened(null); setActivities(null); await refreshContext('personal', generation)
      })}>退出学校登录</button> : context.profile === 'school' && <form onSubmit={event => { event.preventDefault(); void action(async generation => {
        await api('login', { loginName, password }); if (generation !== epoch.current) return
        setPassword(''); await refreshContext('school', generation)
      }) }}><label>学校账号<input autoComplete="username" required value={loginName} onChange={event => setLoginName(event.target.value)} /></label>
        <label>密码<input type="password" autoComplete="current-password" required value={password} onChange={event => setPassword(event.target.value)} /></label>
        <button type="submit" disabled={busy}>登录此学校</button></form>}
      {context.profile !== 'school' && <details><summary>连接学校提供的入口</summary>
        <form onSubmit={event => { event.preventDefault(); void action(async () => {
          const pending = await api('client/start', { requestId: crypto.randomUUID(), schoolEndpoint }) as PendingConnection
          setPendingConnection(pending)
        }) }}><label>学校入口<input type="url" required value={schoolEndpoint} onChange={event => setSchoolEndpoint(event.target.value)} /></label>
          <button type="submit" disabled={busy}>前往学校认证</button></form>
        {pendingConnection && <div><p><a href={pendingConnection.authorizationUrl} target="_blank" rel="noreferrer">打开学校认证页面</a></p>
          <button type="button" disabled={busy} onClick={() => void action(async generation => {
            const connection = await api('client/complete', { requestId: pendingConnection.requestId }) as { connectionId: string }
            if (generation !== epoch.current) return
            setPendingConnection(null); await refreshContext('school:' + connection.connectionId, generation)
          })}>已在学校批准，完成连接</button></div>}
      </details>}
      {key.startsWith('school:') && <button type="button" disabled={busy} onClick={() => void action(async generation => {
        await api('connections/revoke', { connectionId: key.slice(7) }, key)
        // The revoked connection is gone; re-read so the stale school space cannot be selected again.
        if (generation === epoch.current) await refreshContext(context.identities.some(item => item.key === 'personal') ? 'personal' : undefined, generation)
      })}>撤销此客户端连接</button>}
    </section>}
  </main>
}
