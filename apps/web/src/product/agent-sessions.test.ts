import { beforeEach, expect, it, vi } from 'vitest'
import { AgentSessionsClient, SessionOutbox, mergeAgentConversation, workspaceCard, createSessionActionReceiver } from './agent-sessions'
import type { AgentSession } from '@xunjie/contracts/agent-sessions'
import type { AgentConversation } from '@xunjie/contracts/agent-service'

const id = () => crypto.randomUUID()
const actor = { environmentId: id(), spaceId: id(), principalId: id(), kind: 'personal' as const, name: '学生' }
const owner = { version: 1 as const, connectionId: id(), installationId: id(), target: { environmentId: id(), serviceId: id(),
  unit: 'teaching-agent' as const, endpoint: 'https://agent.example.test', protocolVersion: 1 as const, capabilities: ['agent.sessions.v2'] } }
const target = { environmentId: actor.environmentId, serviceId: id(), version: 1 as const }
let sessions: Map<string, AgentSession>, inputs: Map<string, any>, calls: { path: string; body?: any }[], loseReply: boolean
const storage = () => { const map = new Map<string, string>(); return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value) }, removeItem: (key: string) => { map.delete(key) } } }
beforeEach(() => {
  sessions = new Map(); inputs = new Map(); calls = []; loseReply = false
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    expect(new Headers(options.headers).get('x-xj-agent-contract')).toBe('2')
    expect(new Headers(options.headers).get('x-xj-expected-subject')).toBe([actor.environmentId, actor.spaceId, actor.principalId].join('.'))
    const path = url.replace('/api/learning/', ''), body = options.body ? JSON.parse(String(options.body)) : undefined
    calls.push({ path, body })
    const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
    if (path === 'agent-sessions' && body || path === 'agent-sessions/workspace') {
      const sessionId = body.sessionId ?? id(), now = new Date().toISOString()
      const value: AgentSession = { sessionId, requestId: body.requestId ?? id(), identity: actor, owner,
        scenario: body.activityId ? 'workspace-assistant' : 'student-assistant', ...(body.activityId ? { workspace: body } : {}),
        title: body.title ?? null, pinned: false, archived: false, deleted: false, state: 'ready', createdAt: now, updatedAt: now, readyAt: now }
      sessions.set(sessionId, value); return respond(value)
    }
    const parts = path.split('/'), sessionId = parts[1]!
    if (parts.length === 2) return sessions.has(sessionId) ? respond(sessions.get(sessionId)) : respond({ error: 'missing' }, 404)
    if (parts[2] === 'requests') return respond(inputs.get(parts[3]!) ?? null)
    if (parts[2] === 'inputs' && body) {
      const receipt = { requestId: body.requestId, sessionId, inputId: id(), runId: id(), inputDigest: 'a'.repeat(64) }
      inputs.set(body.requestId, { receipt, input: body })
      if (loseReply) { loseReply = false; throw new Error('lost ACK') }
      return respond(receipt)
    }
    throw new Error('Unexpected endpoint ' + path)
  }))
})
it('ordinary first questions create only a session; a lost ACK survives reconstruction and queries the original input before any resend', async () => {
  const client = new AgentSessionsClient({ identity: actor, spaceKey: 'personal', namespace: 'browser' }), store = storage()
  const first = new SessionOutbox(client, store)
  const pending = first.begin('什么是递归？')
  loseReply = true
  await expect(first.deliverStart()).rejects.toThrow()
  const restored = new SessionOutbox(client, store)
  expect(restored.start()).toEqual(pending)
  const result = await restored.deliverStart()
  expect(result.session.sessionId).toBe(pending.create.sessionId)
  expect(restored.start()).toBeNull()
  expect(calls.filter(call => call.path.endsWith('/inputs'))).toHaveLength(1)
  expect(calls.filter(call => call.path === 'activities')).toHaveLength(0)
  expect(calls.at(-1)!.path).toBe(`agent-sessions/${result.session.sessionId}/requests/${pending.input.requestId}`)
})
it('workspace inputs retain the actual ActionInput in context and never reuse the home session identity', async () => {
  const client = new AgentSessionsClient({ identity: actor, spaceKey: 'personal', namespace: 'browser' }), outbox = new SessionOutbox(client, storage())
  const home = await outbox.deliverStart(outbox.begin('普通问答'))
  const activityId = id(), workspace = await client.workspace(activityId, target)
  expect(workspace.sessionId).not.toBe(home.session.sessionId)
  const action = { requestId: id(), scope: { ...actor, activityId }, draft: { question: '分析当前作品' } }
  const input = { requestId: action.requestId, sessionId: workspace.sessionId, text: '分析当前作品', mode: 'steering' as const, context: { action } }
  await outbox.send(input)
  expect(inputs.get(action.requestId).input.context.action).toEqual(action)
  expect(calls.find(call => call.path === 'agent-sessions/workspace')!.body).toEqual({ activityId, target })
})
it('incremental reads retain prior messages and update streaming messages by stable identity without duplicating workspace cards', () => {
  const sessionId = id(), runId = id(), messageId = id(), operationId = id()
  const base = { sessionId, lastSeq: 2, messages: [{ messageId, runId, role: 'assistant', text: '递', createdAt: '2026-11-13T00:00:00Z', state: 'streaming' }], runs: [], inputs: [], waits: [], tools: [], workspaces: [] } as unknown as AgentConversation
  const next = { ...base, lastSeq: 3, messages: [{ ...base.messages[0]!, text: '递归', state: 'settled' }], workspaces: [{ operationId, runId, workspace: { activityId: id(), title: '递归练习', target } }] } as AgentConversation
  const merged = mergeAgentConversation(base, next)
  expect(merged.messages).toHaveLength(1); expect(merged.messages[0]!.text).toBe('递归')
  expect(mergeAgentConversation(merged, { ...next, messages: [], workspaces: [] }).messages).toHaveLength(1)
  expect(mergeAgentConversation(merged, { ...next, messages: [], workspaces: [] }).workspaces).toHaveLength(1)
  expect(mergeAgentConversation(merged, base)).toBe(merged)
  expect(workspaceCard(next.workspaces[0]!.workspace)?.title).toBe('递归练习')
  expect(workspaceCard({ title: '模型声称创建成功' })).toBeNull()
})

it('the reliable workspace receiver sends complete protected ActionInput bytes and confirms the same authority on retry', async () => {
  vi.stubGlobal('localStorage', storage())
  const client = new AgentSessionsClient({ identity: actor, spaceKey: 'personal', namespace: 'browser' })
  const activityId = id(), session = await client.workspace(activityId, target), receiver = createSessionActionReceiver(client, session)
  const action = { requestId: id(), scope: { environmentId: actor.environmentId, spaceId: actor.spaceId, principalId: actor.principalId, activityId }, receiver: receiver.identity,
    draft: { token: 'fixed-draft', question: '检查当前作品', references: [], bases: [] },
    works: [{ objectId: id(), contentId: id(), name: 'main.py', encoding: 'utf8' as const, kind: 'code' as const, mediaType: 'text/x-python', value: 'print(42)' }], evidence: [] }
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(action))))).map(value => value.toString(16).padStart(2, '0')).join('')
  const receipt = await receiver.accept(action, digest)
  expect(inputs.get(action.requestId).input.context.action).toEqual(action)
  expect(inputs.get(action.requestId).input.text).toBe(action.draft.question)
  expect(await receiver.query(action.requestId, digest)).toEqual(receipt)
  await expect(receiver.accept({ ...action, scope: { ...action.scope, activityId: id() } }, digest)).rejects.toMatchObject({ code: 'forbidden' })
  await expect(receiver.query(action.requestId, 'b'.repeat(64))).rejects.toMatchObject({ code: 'identity-conflict' })
})
it('settles retained streaming text when the run stops without a final assistant event and keeps its original message position', () => {
  const sessionId = id(), runId = id(), inputId = id(), createdAt = '2026-11-13T00:00:00.000Z'
  const run = { runId, sessionId, requestId: id(), inputId, state: 'running' as const, reason: '', generation: 1, stopRequested: false, needsContinue: false, previousRunId: null, createdAt, updatedAt: createdAt, completedAt: null }
  const original: AgentConversation = { sessionId, lastSeq: 3, messages: [{ messageId: 'assistant:' + id(), runId, role: 'assistant', text: '已有半段回答', createdAt, state: 'streaming' }], runs: [run], inputs: [], tools: [], waits: [], workspaces: [] }
  const more = mergeAgentConversation(original, { ...original, lastSeq: 4, messages: [{ ...original.messages[0]!, text: '已有半段回答，继续', createdAt: '2026-11-13T00:00:02.000Z' }] })
  expect(more.messages[0]!.createdAt).toBe(createdAt)
  const stopped = mergeAgentConversation(more, { ...more, lastSeq: 5, messages: [], runs: [{ ...run, state: 'stopped', stopRequested: true }] })
  expect(stopped.messages[0]).toMatchObject({ text: '已有半段回答，继续', state: 'stopped', createdAt })
})
