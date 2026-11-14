import { useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { ReliableRecordStore } from '../reliable-workspace/record-store'
import { sessionInputProtection } from '../reliable-workspace/input-protection'
import { ActivitySessionContext } from './ActivitySession'

export interface SessionDraftValue { text: string; editing: boolean; expectedVersion: number }
interface SessionDraftRecord { key: string; scope: string; value: SessionDraftValue }
export const sessionDraftStore = new ReliableRecordStore<SessionDraftRecord>('agentControls')
export const sessionDraftKey = (scope: string, sessionId: string | undefined, target: string) => JSON.stringify([scope, sessionId ?? 'new', 'session-draft', target])

export function useSessionDraft(scope: string, sessionId: string | undefined, target: string, initial: SessionDraftValue, legacyKey?: string) {
  const workspace = useContext(ActivitySessionContext)?.workspace
  const protection = workspace ?? sessionInputProtection
  const key = sessionDraftKey(scope, sessionId, target)
  const [state, setState] = useState<{ key: string; value: SessionDraftValue; ready: boolean; error: string }>(() => {
    const retained = protection.retainedInput<SessionDraftRecord>(key)
    return { key, value: retained?.value ?? initial, ready: !!retained, error: '' }
  })
  const shown = useRef(key); shown.current = key
  const current = useRef({ key, value: initial })
  if (state.key === key) current.current = { key, value: state.value }
  const alive = useRef(true), edited = useRef(0)
  const status = useSyncExternalStore(protection.subscribe, () => protection.inputProtection(key))
  const change = (value: SessionDraftValue): Promise<void> => {
    const record = { key, scope, value }
    edited.current++; current.current = { key, value }
    if (alive.current && shown.current === key) setState({ key, value, ready: true, error: '' })
    return protection.retainInput(key, record, input => sessionDraftStore.change(key, saved => {
      if (saved && saved.scope !== scope) throw new Error('草稿不属于当前会话。')
      return input
    }))
  }
  const load = async () => {
    const epoch = edited.current
    try {
      const saved = await sessionDraftStore.read(key)
      if (saved && saved.scope !== scope) throw new Error('草稿不属于当前会话。')
      const retained = protection.retainedInput<SessionDraftRecord>(key)
      const legacy = !saved && legacyKey ? localStorage.getItem(legacyKey) : null
      const value = retained?.value ?? saved?.value ?? (legacy ? { ...initial, text: legacy } : initial)
      if (!alive.current || shown.current !== key || edited.current !== epoch) return
      current.current = { key, value }; setState({ key, value, ready: true, error: '' })
      if (!saved && legacy) void change(value).catch(() => {})
    } catch (cause) {
      if (!alive.current || shown.current !== key || edited.current !== epoch) return
      const value = protection.retainedInput<SessionDraftRecord>(key)?.value ?? initial
      current.current = { key, value }; setState({ key, value, ready: true, error: '本机草稿暂时无法读取，请保留输入后重试。' })
      throw cause
    }
  }
  useEffect(() => {
    alive.current = true
    void load().catch(() => {})
    return () => { alive.current = false }
  }, [key, protection])
  const value = state.key === key ? state.value : initial
  return { value, ready: state.key === key && state.ready, change,
    error: status === 'failed' ? '输入尚未在本机可靠保留，请保留页面或复制后重试。' : state.key === key ? state.error : '',
    latest: () => current.current.key === key ? current.current.value : initial,
    protect: async () => {
      await protection.protectInput(key)
      if (state.key === key && state.error) { await load(); await protection.protectInput(key) }
    },
    clearIfMatches: async (text: string) => {
      const latest = current.current
      if (latest.key === key && latest.value.text === text) await change({ ...latest.value, text: '', editing: false })
    },
  }
}

export function protectSessionDraft(scope: string, sessionId: string, target: string, value: SessionDraftValue) {
  const record = { key: sessionDraftKey(scope, sessionId, target), scope, value }
  return sessionInputProtection.retainInput(record.key, record, input => sessionDraftStore.change(record.key, () => input))
}
