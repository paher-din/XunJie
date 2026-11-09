import { useCallback, useEffect, useRef, useState } from 'react'
import { conversationArchiveStateSchema } from '@xunjie/contracts/learning-data'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { ArchivedConversationRow } from '@xunjie/ui/foundation'
import { Icon } from '@xunjie/ui/icons'

type ArchiveState = { key: string; ids: string[]; ready: boolean; busy: boolean; error: string }
type ArchiveSession = { key: string; spaceKey: string; namespace: string; expectedSubject: string;
  disposed: boolean; ready: boolean; refreshPending: boolean; migrationWarning: string;
  tail: Promise<void>; pending: number; controller: AbortController }

function legacyArchive(key: string): { raw: string; ids: string[] } | null {
  const raw = localStorage.getItem(key)
  if (raw === null) return null
  const saved: unknown = JSON.parse(raw)
  if (!Array.isArray(saved) || saved.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error('invalid legacy archive')
  }
  return { raw, ids: [...new Set(saved as string[])] }
}

async function archiveRequest(session: ArchiveSession, suffix = '', body?: unknown) {
  const response = await fetch('/api/learning/conversation-archives' + suffix, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(30000)]),
    headers: { 'content-type': 'application/json', 'x-xj-space': session.spaceKey, 'x-xj-namespace': session.namespace,
      'x-xj-expected-subject': session.expectedSubject },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw Object.assign(new Error('archive request failed'), { status: response.status })
  return conversationArchiveStateSchema.parse(await response.json()).archivedIds
}

function enqueue<T>(session: ArchiveSession, operation: () => Promise<T>): Promise<T> {
  const next = session.tail.then(() => {
    if (session.disposed) throw new Error('archive session closed')
    return operation()
  })
  session.tail = next.then(() => {}, () => {})
  return next
}

/** The learning owner persists archive state; the old local list is imported only once. */
export function useConversationArchive(key: string, spaceKey: string, namespace: string, expectedSubject: string) {
  const [state, setState] = useState<ArchiveState>({ key: '', ids: [], ready: false, busy: false, error: '' })
  const sessionRef = useRef<ArchiveSession | null>(null)
  const refreshRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!key || !spaceKey || !namespace || !expectedSubject) {
      sessionRef.current = null
      setState({ key, ids: [], ready: false, busy: false, error: '' })
      return
    }
    const session: ArchiveSession = { key, spaceKey, namespace, expectedSubject, disposed: false, ready: false,
      refreshPending: false, migrationWarning: '',
      tail: Promise.resolve(), pending: 0, controller: new AbortController() }
    sessionRef.current = session
    setState({ key, ids: [], ready: false, busy: false, error: '' })
    const current = () => sessionRef.current === session && !session.disposed
    const refresh = () => {
      if (session.refreshPending || session.disposed) return
      session.refreshPending = true
      void enqueue(session, async () => {
        if (!session.ready) {
          let legacy: ReturnType<typeof legacyArchive> = null
          try { legacy = legacyArchive(key) }
          catch { session.migrationWarning = '无法读取此浏览器原有的归档，原记录已保留。' }
          if (legacy !== null) {
            for (let offset = 0; offset < legacy.ids.length; offset += 200) {
              await archiveRequest(session, '/import', { requestId: crypto.randomUUID(), activityIds: legacy.ids.slice(offset, offset + 200) })
            }
          }
          const ids = await archiveRequest(session)
          if (legacy !== null && current()) try {
            if (localStorage.getItem(key) === legacy.raw) localStorage.removeItem(key)
          } catch { /* Import is safe to retry. */ }
          session.ready = true
          if (current()) setState(previous => ({ ...previous, ids, ready: true, error: session.migrationWarning }))
        } else {
          const ids = await archiveRequest(session)
          if (current()) setState(previous => ({ ...previous, ids, error: session.migrationWarning }))
        }
      }).catch(() => {
        if (current()) setState(previous => ({ ...previous, error: '无法读取归档，请检查连接后重试。' }))
      }).finally(() => { session.refreshPending = false })
    }
    refreshRef.current = refresh
    refresh()
    const onFocus = () => { if (!document.hidden) refresh() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    const timer = window.setInterval(onFocus, 5000)
    return () => {
      session.disposed = true; session.controller.abort()
      if (sessionRef.current === session) sessionRef.current = null
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      window.clearInterval(timer)
    }
  }, [key, spaceKey, namespace, expectedSubject])
  const setArchived = useCallback(async (activityId: string, archived: boolean) => {
    const session = sessionRef.current
    if (!session || !session.ready || session.pending > 0) return false
    session.pending++
    setState(previous => previous.key === session.key ? { ...previous, busy: true, error: '' } : previous)
    const body = { requestId: crypto.randomUUID(), activityId, archived }
    try {
      await enqueue(session, async () => {
        try { await archiveRequest(session, '/set', body) }
        catch (error) {
          if (session.disposed || (typeof (error as { status?: unknown }).status === 'number' && (error as { status: number }).status < 500)) throw error
          await archiveRequest(session, '/set', body)
        }
        const ids = await archiveRequest(session)
        if (sessionRef.current === session && !session.disposed) setState(previous => ({ ...previous, ids, error: session.migrationWarning }))
      })
      return !session.disposed
    } catch {
      if (sessionRef.current === session && !session.disposed) setState(previous => ({ ...previous, error: '归档操作未确认，请检查连接后再次操作。' }))
      return false
    } finally {
      session.pending--
      if (sessionRef.current === session && !session.disposed) setState(previous => ({ ...previous, busy: session.pending > 0 }))
    }
  }, [])
  return { ids: state.key === key ? state.ids : [], ready: state.key === key && state.ready,
    busy: state.key === key && state.busy, error: state.key === key ? state.error : '', setArchived,
    retry: () => refreshRef.current() }
}

export function ProductConversationHistory({ activities, activeId, archivedIds, archiveOpen, query, error, ready, busy,
  onNew, onOpen, onArchiveOpenChange, onQueryChange, onArchive, onRestore, onRetry }: {
  activities: LearningActivity[] | null
  activeId?: string
  archivedIds: readonly string[]
  archiveOpen: boolean
  query: string
  error: string
  ready: boolean
  busy: boolean
  onNew: () => void
  onOpen: (id: string) => void
  onArchiveOpenChange: (open: boolean) => void
  onQueryChange: (query: string) => void
  onArchive: (id: string) => void
  onRestore: (id: string) => void
  onRetry: () => void
}) {
  const conversations = activities?.filter(activity => !activity.course) ?? []
  const archived = conversations.filter(activity => archivedIds.includes(activity.activityId))
  const term = query.trim().toLowerCase()
  const title = (activity: LearningActivity) => activity.goal || activity.question || '资料学习'
  const matches = (activity: LearningActivity) => title(activity).toLowerCase().includes(term)
  const active = conversations.filter(activity => !archivedIds.includes(activity.activityId) && matches(activity))
  const archivedHits = term ? archived.filter(matches) : []
  const archivedRows = (items: LearningActivity[]) => items.map(activity => <ArchivedConversationRow
    key={activity.activityId} title={title(activity)} disabled={busy} onRestore={() => onRestore(activity.activityId)} />)
  return <>
    <button type="button" className="agent-newchat" onClick={onNew}>
      <span className="navicon"><Icon name="pen-new-square" size={14} /></span>新对话
    </button>
    {(archived.length > 0 || archiveOpen) && <button type="button" className={'agent-archive-entry' + (archiveOpen ? ' on' : '')}
      aria-expanded={archiveOpen} onClick={() => onArchiveOpenChange(!archiveOpen)}>
      <Icon name={archiveOpen ? 'alt-arrow-left' : 'archive'} size={14} />已归档<span className="count">{archived.length}</span>
    </button>}
    {error && <div className="agent-side-empty" role="alert">{error} <button type="button" onClick={onRetry}>重试</button></div>}
    {!ready ? <div className="agent-side-empty">{error ? '暂时无法显示对话' : '正在读取对话…'}</div>
      : archiveOpen ? <div className="agent-groups"><div className="agent-group">
      {archived.length ? archivedRows(archived) : <div className="agent-side-empty">暂无已归档对话</div>}
    </div></div> : <>
      <div className="agent-search"><Icon name="minimalistic-magnifier" size={14} />
        <input aria-label="搜索对话" placeholder="搜索对话…" value={query} onChange={event => onQueryChange(event.target.value)} /></div>
      <div className="agent-groups"><div className="agent-group">
        {active.map(activity => <div className={'agent-conv-row' + (activeId === activity.activityId ? ' active' : '')} key={activity.activityId}>
          <button type="button" className={'agent-conv' + (activeId === activity.activityId ? ' active' : '')}
            aria-current={activeId === activity.activityId ? 'page' : undefined} onClick={() => onOpen(activity.activityId)}>{title(activity)}</button>
          <button type="button" className="agent-conv-more" aria-label={`归档「${title(activity)}」`} title="归档" disabled={busy}
            onClick={() => onArchive(activity.activityId)}><Icon name="archive" size={14} /></button>
        </div>)}
        {archivedHits.length > 0 && <><div className="agent-group-label">已归档</div>{archivedRows(archivedHits)}</>}
        {activities === null ? <div className="agent-side-empty">正在读取对话…</div>
          : active.length === 0 && archivedHits.length === 0 ? <div className="agent-side-empty">
            {term ? `没有匹配「${query.trim()}」的对话` : '开始提问后，对话会留在这里'}
          </div> : null}
      </div></div>
    </>}
  </>
}
