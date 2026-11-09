import { useCallback, useEffect, useRef, useState } from 'react'
import { conversationArchiveStateSchema, conversationHistoryStateSchema,
  type ConversationHistoryItem } from '@xunjie/contracts/learning-data'

type HistoryState = { key: string; items: ConversationHistoryItem[]; ready: boolean; busy: boolean; error: string }
type HistorySession = { key: string; spaceKey: string; namespace: string; expectedSubject: string;
  disposed: boolean; ready: boolean; refreshPending: boolean; migrationWarning: string;
  tail: Promise<void>; pending: boolean; controller: AbortController }

function legacyArchive(key: string): { raw: string; ids: string[] } | null {
  const raw = localStorage.getItem(key)
  if (raw === null) return null
  const saved: unknown = JSON.parse(raw)
  if (!Array.isArray(saved) || saved.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) {
    throw new Error('invalid legacy archive')
  }
  return { raw, ids: [...new Set(saved as string[])] }
}

async function historyRequest(session: HistorySession, route: string, body?: unknown) {
  const response = await fetch('/api/learning/' + route, {
    method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
    signal: AbortSignal.any([session.controller.signal, AbortSignal.timeout(30000)]),
    headers: { 'content-type': 'application/json', 'x-xj-space': session.spaceKey, 'x-xj-namespace': session.namespace,
      'x-xj-expected-subject': session.expectedSubject },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw Object.assign(new Error('conversation history request failed'), { status: response.status })
  const value: unknown = await response.json()
  return route.startsWith('conversation-archives') ? conversationArchiveStateSchema.parse(value)
    : conversationHistoryStateSchema.parse(value)
}

async function readHistory(session: HistorySession) {
  return conversationHistoryStateSchema.parse(await historyRequest(session, 'conversation-history')).items
}

function enqueue<T>(session: HistorySession, operation: () => Promise<T>): Promise<T> {
  const next = session.tail.then(() => {
    if (session.disposed) throw new Error('conversation history session closed')
    return operation()
  })
  session.tail = next.then(() => {}, () => {})
  return next
}

/** Labels and visibility belong to the learning owner, with a one-time import of browser archives. */
export function useConversationHistory(key: string, spaceKey: string, namespace: string, expectedSubject: string) {
  const [state, setState] = useState<HistoryState>({ key: '', items: [], ready: false, busy: false, error: '' })
  const sessionRef = useRef<HistorySession | null>(null)
  const refreshRef = useRef<() => void>(() => {})
  useEffect(() => {
    if (!key || !spaceKey || !namespace || !expectedSubject) {
      sessionRef.current = null; refreshRef.current = () => {}
      setState({ key, items: [], ready: false, busy: false, error: '' })
      return
    }
    const session: HistorySession = { key, spaceKey, namespace, expectedSubject, disposed: false, ready: false,
      refreshPending: false, migrationWarning: '', tail: Promise.resolve(), pending: false, controller: new AbortController() }
    sessionRef.current = session
    setState({ key, items: [], ready: false, busy: false, error: '' })
    const current = () => sessionRef.current === session && !session.disposed
    const refresh = () => {
      if (session.refreshPending || session.disposed) return
      session.refreshPending = true
      void enqueue(session, async () => {
        let legacy: ReturnType<typeof legacyArchive> = null
        if (!session.ready) {
          try { legacy = legacyArchive(key) }
          catch { session.migrationWarning = '无法读取此浏览器原有的归档，原记录已保留。' }
          if (legacy !== null) for (let offset = 0; offset < legacy.ids.length; offset += 200) {
            await historyRequest(session, 'conversation-archives/import', { requestId: crypto.randomUUID(), activityIds: legacy.ids.slice(offset, offset + 200) })
          }
        }
        const items = await readHistory(session)
        if (legacy !== null && current()) try {
          if (localStorage.getItem(key) === legacy.raw) localStorage.removeItem(key)
        } catch { /* Import is safe to retry. */ }
        session.ready = true
        if (current()) setState(previous => ({ ...previous, items, ready: true, error: session.migrationWarning }))
      }).catch(() => {
        if (current()) setState(previous => ({ ...previous, error: '无法读取对话列表，请检查连接后重试。' }))
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
  const mutate = useCallback(async (route: string, input: Record<string, unknown>) => {
    const session = sessionRef.current
    if (!session || !session.ready || session.pending) return false
    session.pending = true
    setState(previous => previous.key === session.key ? { ...previous, busy: true, error: '' } : previous)
    const body = { requestId: crypto.randomUUID(), ...input }
    const current = () => sessionRef.current === session && !session.disposed
    try {
      await enqueue(session, async () => {
        try { await historyRequest(session, route, body) }
        catch (error) {
          if (session.disposed || (typeof (error as { status?: unknown }).status === 'number' && (error as { status: number }).status < 500)) throw error
          await historyRequest(session, route, body)
        }
        const items = await readHistory(session)
        if (current()) setState(previous => ({ ...previous, items, error: session.migrationWarning }))
      })
      return current()
    } catch {
      if (current()) setState(previous => ({ ...previous, error: '对话操作未确认，请检查连接后再次操作。' }))
      return false
    } finally {
      session.pending = false
      if (current()) setState(previous => ({ ...previous, busy: false }))
    }
  }, [])
  const items = state.key === key ? state.items : []
  return { items, archivedIds: items.filter(item => item.archived && !item.deleted).map(item => item.activityId),
    ready: state.key === key && state.ready, busy: state.key === key && state.busy, error: state.key === key ? state.error : '',
    setArchived: (activityId: string, archived: boolean) => mutate('conversation-archives/set', { activityId, archived }),
    rename: (activityId: string, title: string) => mutate('conversation-history/update', { activityId, action: 'rename', title }),
    setPinned: (activityId: string, pinned: boolean) => mutate('conversation-history/update', { activityId, action: 'pin', pinned }),
    remove: (activityId: string) => mutate('conversation-history/update', { activityId, action: 'delete' }),
    retry: () => refreshRef.current() }
}
