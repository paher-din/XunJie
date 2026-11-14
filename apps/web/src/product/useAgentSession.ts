import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AgentSession, UpdateAgentSession } from '@xunjie/contracts/agent-sessions'
import type { AgentConversation } from '@xunjie/contracts/agent-service'
import { agentInputControlReceiptSchema } from '@xunjie/contracts/agent-service'
import type { AgentInput } from '@xunjie/contracts/agent-runtime'
import { AgentSessionsClient, AgentSessionRequestError, SessionOutbox, mergeAgentConversation, type SessionSubject } from './agent-sessions'
import { useViewPolling } from './useViewPolling'

export const sessionError = (error: unknown) => error instanceof Error && error.name !== 'ZodError' ? error.message : '对话响应不完整，请刷新后核对原请求。'
export function useAgentSessionHistory(subject?: SessionSubject, enabled = true) {
  const scope = subject ? JSON.stringify(subject) : ''
  const client = useMemo(() => subject ? new AgentSessionsClient(subject) : null, [scope])
  const [items, setItems] = useState<AgentSession[]>([]), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const current = useRef(client); current.current = client
  const readAt = useRef(0)
  const retry = useCallback(async () => {
    if (!client || !enabled) return
    try { const list = await client.list(); if (current.current === client) { readAt.current = Date.now(); setItems(list); setReady(true); setError('') } }
    catch (cause) { if (current.current === client) setError(sessionError(cause)) }
  }, [client, enabled])
  useEffect(() => { setItems([]); setReady(false); setBusy(false); setError(''); readAt.current = 0 }, [client])
  useViewPolling(retry, scope, 10000, !!client && enabled)
  const upsert = useCallback((value: AgentSession) => setItems(items => [...items.filter(item => item.sessionId !== value.sessionId), value]), [])
  async function change(sessionId: string, patch: Partial<Pick<UpdateAgentSession, 'title' | 'pinned' | 'archived' | 'deleted'>>) {
    if (!client || busy) return false
    setBusy(true)
    const key = 'xj.agent-session.metadata.' + client.scope + '.' + sessionId
    try {
      const previous = localStorage.getItem(key)
      const value: UpdateAgentSession = previous ? JSON.parse(previous) : { ...patch, sessionId, requestId: crypto.randomUUID() }
      localStorage.setItem(key, JSON.stringify(value))
      let result = await client.update(value)
      if (localStorage.getItem(key) === JSON.stringify(value)) localStorage.removeItem(key)
      if (Object.entries(patch).some(([name, field]) => value[name as keyof UpdateAgentSession] !== field)) {
        const next: UpdateAgentSession = { ...patch, sessionId, requestId: crypto.randomUUID() }
        localStorage.setItem(key, JSON.stringify(next)); result = await client.update(next)
        if (localStorage.getItem(key) === JSON.stringify(next)) localStorage.removeItem(key)
      }
      if (current.current === client) { upsert(result); setError('') }
      return true
    } catch (cause) { if (current.current === client) setError(sessionError(cause)); return false }
    finally { if (current.current === client) setBusy(false) }
  }
  return { client, items, ready, busy, error, retry, revalidate: () => { if (Date.now() - readAt.current >= 10000) void retry() }, upsert, change,
    rename: (id: string, title: string) => change(id, { title }), setPinned: (id: string, pinned: boolean) => change(id, { pinned }),
    setArchived: (id: string, archived: boolean) => change(id, { archived }), remove: (id: string) => change(id, { deleted: true }) }
}

export function useAgentSession(client: AgentSessionsClient, sessionId: string | undefined, writable: boolean, viewActive = true) {
  const outbox = useMemo(() => new SessionOutbox(client), [client])
  const scope = client.scope + ':' + sessionId
  const [projection, setProjection] = useState<{ scope: string; value: AgentConversation } | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const conversation = projection?.scope === scope ? projection.value : null
  const current = useRef(scope); current.current = scope
  const alive = useRef(true), reading = useRef<{ scope: string; promise: Promise<void> } | null>(null), latest = useRef(conversation); latest.current = conversation
  const operation = useRef<string | null>(null)
  useEffect(() => { alive.current = true; setError(''); setBusy(false); return () => { alive.current = false } }, [scope])
  const refresh = useCallback(async () => {
    if (!sessionId) return
    if (reading.current?.scope === scope) return reading.current.promise
    const pending = (async () => {
      try {
        const previous = latest.current?.sessionId === sessionId ? latest.current : null
        const value = await client.conversation(sessionId, previous?.lastSeq ?? 0)
        if (alive.current && current.current === scope) { setProjection(old => ({ scope, value: mergeAgentConversation(old?.scope === scope ? old.value : null, value) })); if (!localStorage.getItem('xj.agent-operation.' + scope) && !outbox.pending(sessionId).length) setError('') }
      } catch (cause) { if (alive.current && current.current === scope) setError(sessionError(cause)) }
    })().finally(() => { if (reading.current?.promise === pending) reading.current = null })
    reading.current = { scope, promise: pending }; return pending
  }, [client, sessionId])
  const active = !!conversation?.runs.some(run => ['received', 'running', 'waiting'].includes(run.state) && !run.stopRequested)
  useViewPolling(refresh, scope, active ? 1000 : 5000, !!sessionId && viewActive)
  const perform = useCallback(async (operation: () => Promise<unknown>) => {
    const expected = scope
    if (!writable) throw new Error('当前会话只读。')
    setBusy(true)
    try { const value = await operation(); if (alive.current && current.current === expected) setError(''); await refresh(); return value }
    catch (cause) { if (alive.current && current.current === expected) setError(sessionError(cause)); throw cause }
    finally { if (alive.current && current.current === expected) setBusy(false) }
  }, [writable, refresh, sessionId])
  const mutationKey = 'xj.agent-operation.' + scope
  const executeMutation = async (name: string, value: Record<string, any>) => {
    const [kind, id] = name.split(':')
    if (kind === 'stop' || kind === 'continue') return client.control(sessionId!, id!, kind, value.requestId)
    if (kind === 'response') return client.respond(sessionId!, id!, value.expectedVersion, value.answer, value.requestId)
    const receipt = agentInputControlReceiptSchema.parse(await client.request(`${sessionId}/inputs/${id}/control`, value))
    if (receipt.requestId !== value.requestId || receipt.input.inputId !== id || receipt.input.input.sessionId !== sessionId) throw new Error('输入操作回执不匹配。')
    return receipt
  }
  const retryMutation = async () => {
    const raw = localStorage.getItem(mutationKey)
    if (!raw) return
    const saved = JSON.parse(raw)
    try {
      const result = await executeMutation(saved.name, saved.value)
      if (localStorage.getItem(mutationKey) === raw) localStorage.removeItem(mutationKey)
      return result
    } catch (cause) {
      if (cause instanceof AgentSessionRequestError && cause.rejected) {
        if (localStorage.getItem(mutationKey) === raw) localStorage.removeItem(mutationKey)
        await refresh()
      }
      throw cause
    }
  }
  const replay = useCallback(async () => {
    if (!sessionId || !writable || operation.current === scope) return
    operation.current = scope
    try { for (const input of outbox.pending(sessionId)) await outbox.send(input); await retryMutation(); await refresh() }
    catch (cause) { if (alive.current && current.current === scope) setError(sessionError(cause)) }
    finally { if (operation.current === scope) operation.current = null }
  }, [outbox, sessionId, writable, refresh])
  useEffect(() => { void replay() }, [replay])
  const durable = async (name: string, body: Record<string, unknown>) => {
    const raw = localStorage.getItem(mutationKey)
    if (raw) {
      const saved = JSON.parse(raw)
      const { requestId: _request, ...original } = saved.value
      if (saved.name !== name || JSON.stringify(original) !== JSON.stringify(body)) throw new Error('上次操作仍待核对，请先重试原操作。')
      return retryMutation()
    }
    const saved = { name, value: { ...body, requestId: crypto.randomUUID() } }
    localStorage.setItem(mutationKey, JSON.stringify(saved))
    return retryMutation()
  }
  return { client, sessionId, conversation, busy, error, active, refresh, replay, outbox,
    send: (text: string, mode: AgentInput['mode'], context: AgentInput['context'] = {}) => perform(async () => {
      if (!sessionId) throw new Error('会话尚未准备。')
      const pending = outbox.pending(sessionId)
      if (pending.length) {
        let receipt
        for (const input of pending) receipt = await outbox.send(input)
        const original = pending.at(-1)!
        if (pending.length === 1 && original.text === text && original.mode === mode && JSON.stringify(original.context) === JSON.stringify(context)) return receipt
        throw new Error('原问题已核对并保留，请再次确认发送当前内容。')
      }
      return outbox.send({ sessionId, requestId: crypto.randomUUID(), text, mode, context })
    }),
    control: (runId: string, operation: 'stop' | 'continue') => perform(() => durable(operation + ':' + runId, {})),
    respond: (waitId: string, expectedVersion: number, answer: Record<string, any>) => perform(() => durable('response:' + waitId,
      { expectedVersion, answer })),
    inputControl: (inputId: string, expectedVersion: number, operation: 'edit' | 'remove' | 'move', patch: { text?: string; mode?: 'steering' | 'queue' } = {}) => perform(() => durable('input:' + inputId,
      { expectedVersion, operation, ...patch })),
  }
}
export type AgentSessionController = ReturnType<typeof useAgentSession>
