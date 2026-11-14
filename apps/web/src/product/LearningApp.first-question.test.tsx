// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { transferableAbortController } from 'node:util'
import { act, type ReactNode, useImperativeHandle, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { sessionInputProtection } from '../reliable-workspace/input-protection'
import { LearningApp } from './LearningApp'
import type { AgentSession } from '@xunjie/contracts/agent-sessions'
import type { AgentConversation } from '@xunjie/contracts/agent-service'
import type { AgentInput } from '@xunjie/contracts/agent-runtime'
import type { ActivityWorkspaceHandle } from './ActivityWorkspace'
import { toast } from '@xunjie/ui/feedback'

vi.mock('../lib/theme', () => ({ useTheme() {} }))
vi.mock('../components/ProductShell', () => ({ ProductShell: ({ children, onHome, onAgent, agentHistory }: {
  children: ReactNode; onHome(): void; onAgent(): void; agentHistory(close: () => void): ReactNode
}) => <main><button onClick={onHome}>首页</button><button onClick={onAgent}>Agent 对话</button><nav>{agentHistory(() => {})}</nav>{children}</main> }))
vi.mock('./ActivityReferences', () => ({ ActivityReferences: ({ children }: { children: ReactNode }) => children,
  CourseMaterialReferences: () => null, CourseRequirementsReference: () => null }))
vi.mock('./ActivityPage', () => ({ ActivityPage: ({ workspaceRef }: { workspaceRef: RefObject<ActivityWorkspaceHandle | null> }) => {
  useImperativeHandle(workspaceRef, () => ({ leave: async () => {} })); return <h1>真实工作区</h1>
} }))
const actor = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), kind: 'personal', name: '学生' }
const owner = { version: 1, connectionId: crypto.randomUUID(), installationId: crypto.randomUUID(), target: { environmentId: actor.environmentId, serviceId: crypto.randomUUID(),
  endpoint: 'https://agent.example.test', unit: 'teaching-agent', protocolVersion: 1, capabilities: ['agent.sessions.v2'] } }
const now = '2026-11-13T00:00:00.000Z'
let root: Root, host: HTMLDivElement, sessions: Map<string, AgentSession>, conversations: Map<string, AgentConversation>, receipts: Map<string, any>
let writes: { path: string; body: any }[], loss: boolean, activityReads: number, workspaces: any[]
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
async function waitFor(check: () => unknown | Promise<unknown>) {
  let failure: unknown
  for (let i = 0; i < 100; i++) {
    await act(settle)
    try { await check(); return } catch (cause) { failure = cause }
  }
  throw failure
}
const click = async (label: string) => act(async () => { const button = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === label); expect(button, label).toBeDefined(); button!.click(); await settle() })
async function fill(text: string) {
  await waitFor(async () => { await act(async () => { await settle() }); expect(host.querySelector('textarea[aria-label="向 Agent 提问"]')).not.toBeNull() })
  await act(async () => { const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 Agent 提问"]')!; expect(field).not.toBeNull()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text); field.dispatchEvent(new Event('input', { bubbles: true })); await settle() })
}
async function send(text: string) { await fill(text); await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click(); await settle() }) }
const mount = async () => act(async () => { root.render(<LearningApp />); await settle() })
const reload = async () => { await act(async () => root.unmount()); root = createRoot(host); await mount() }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const abort = transferableAbortController(); vi.stubGlobal('AbortController', abort.constructor); vi.stubGlobal('AbortSignal', abort.signal.constructor)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('Image', class { src = ''; decode() { return Promise.resolve() } })
  HTMLElement.prototype.scrollTo = vi.fn(); HTMLElement.prototype.scrollIntoView = vi.fn()
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/?view=agent&space=personal')
  sessions = new Map(); conversations = new Map(); receipts = new Map(); writes = []; loss = false; activityReads = 0; workspaces = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const path = url.replace('/api/learning/', ''), body = options.body ? JSON.parse(String(options.body)) : undefined
    if (body) writes.push({ path, body })
    if (path === 'context') return response({ clientNamespace: 'session-ui', profile: 'local', identities: [{ key: 'personal', identity: actor }] })
    if (path === 'models/selection') return response({ version: 0, selected: null, options: [] })
    if (path === 'activities') { activityReads++; return response(workspaces) }
    if (path.startsWith('activities/')) return response(workspaces.find(item => item.activityId === path.split('/')[1]))
    if (path.startsWith('skills')) return response({ skills: [] })
    if (!path.startsWith('agent-sessions')) throw new Error('Unexpected endpoint ' + path)
    expect(new Headers(options.headers).get('x-xj-agent-contract')).toBe('2')
    expect(new Headers(options.headers).get('x-xj-space')).toBe('personal')
    if (path === 'agent-sessions' && !body) return response({ items: [...sessions.values()] })
    if (path === 'agent-sessions' && body) {
      const value = { ...body, identity: actor, owner, title: body.title ?? null, pinned: false, archived: false, deleted: false,
        state: 'ready', createdAt: now, updatedAt: now, readyAt: now } as AgentSession
      sessions.set(body.sessionId, value)
      conversations.set(body.sessionId, { sessionId: body.sessionId, lastSeq: 0, messages: [], runs: [], inputs: [], waits: [], tools: [], workspaces: [] })
      return response(value)
    }
    if (path === 'agent-sessions/update') {
      const session = { ...sessions.get(body.sessionId)!, ...Object.fromEntries(Object.entries(body).filter(([key]) => key !== 'requestId')), updatedAt: now }
      sessions.set(body.sessionId, session); return response(session)
    }
    const parts = path.split('/'), sessionId = parts[1]!
    if (parts.length === 2) return sessions.has(sessionId) ? response(sessions.get(sessionId)) : response({ error: 'missing' }, 404)
    if (parts[2] === 'materials' || parts[2] === 'pdf') return response([])
    if (parts[2]?.startsWith('conversation')) return response(conversations.get(sessionId))
    if (parts[2] === 'requests') return response(receipts.get(parts[3]! ) ?? null)
    if (parts[2] === 'inputs' && parts.length === 3) {
      const input = body as AgentInput, inputId = crypto.randomUUID(), runId = crypto.randomUUID()
      const receipt = { requestId: input.requestId, sessionId, inputId, runId, inputDigest: 'a'.repeat(64) }
      receipts.set(input.requestId, { receipt, input })
      const run = { sessionId, inputId, runId, requestId: input.requestId, state: 'completed' as const, reason: '', generation: 1, stopRequested: false,
        needsContinue: false, previousRunId: null, createdAt: now, updatedAt: now, completedAt: now }
      const value = conversations.get(sessionId)!
      conversations.set(sessionId, { ...value, lastSeq: value.lastSeq + 2, runs: [...value.runs, run],
        messages: [...value.messages, { messageId: inputId, inputId, runId, role: 'user', text: input.text, createdAt: now, state: 'settled' },
          { messageId: crypto.randomUUID(), runId, role: 'assistant', text: '递归通过更小的同类问题求解。', createdAt: now, state: 'settled' }],
        inputs: [...value.inputs, { inputId, runId, version: 1, mode: input.mode, state: 'adopted', text: input.text, createdAt: now }] })
      if (loss) throw new Error('lost reply')
      return response(receipt)
    }
    return response({ error: 'missing' }, 404)
  }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => { root.unmount(); toast.dismiss() }); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
it('the formal Agent first question creates a persisted session and never creates an activity', async () => {
  await mount(); await send('什么是递归？')
  await waitFor(() => expect(host.textContent).toContain('递归通过更小的同类问题求解。'))
  expect(writes.filter(item => item.path === 'activities')).toHaveLength(0)
  expect(writes.find(item => item.path === 'agent-sessions')!.body.scenario).toBe('student-assistant')
  expect(new URLSearchParams(location.search).get('session')).toBe([...sessions.keys()][0])
  expect(new URLSearchParams(location.search).has('activity')).toBe(false)
})
it('a lost first input ACK is queried under the original identity on reload and is never sent twice', async () => {
  loss = true; await mount(); await send('保留这个原问题')
  expect(writes.filter(item => /\/inputs$/.test(item.path))).toHaveLength(1)
  loss = false; await reload()
  await waitFor(() => expect(new URLSearchParams(location.search).get('session')).toBe([...sessions.keys()][0]))
  expect(writes.filter(item => /\/inputs$/.test(item.path))).toHaveLength(1)
  expect(host.textContent).toContain('保留这个原问题')
})
it('new home sessions remain independent and history keeps their real saved titles', async () => {
  await mount(); await send('第一段会话'); await waitFor(() => expect(sessions.size).toBe(1))
  await click('新对话'); await send('第二段会话'); await waitFor(() => expect(sessions.size).toBe(2))
  const first = [...sessions.values()][0]!
  await click(first.title!)
  await waitFor(() => expect(new URLSearchParams(location.search).get('session')).toBe(first.sessionId))
  expect(host.querySelectorAll('[data-message-id]')).toHaveLength(2)
})
it('the formal sidebar renames, pins, archives, restores and deletes the same session with archived input kept read-only', async () => {
  await mount(); await send('原对话标题'); await waitFor(() => expect(sessions.size).toBe(1))
  const session = [...sessions.values()][0]!
  const row = () => host.querySelector<HTMLElement>(`[data-conversation-id="${session.sessionId}"]`)!
  const rowClick = async (selector: string) => act(async () => { row().querySelector<HTMLButtonElement>(selector)!.click(); await settle() })
  await rowClick('[aria-label="置顶"]')
  expect(sessions.get(session.sessionId)?.pinned).toBe(true)
  await rowClick('[aria-label="更多操作"]'); await click('重命名')
  await act(async () => { const field = row().querySelector<HTMLInputElement>('input')!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, '新的对话标题'); field.dispatchEvent(new Event('input', { bubbles: true })); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await settle() })
  expect(sessions.get(session.sessionId)?.title).toBe('新的对话标题')
  expect(host.querySelector('h1')?.textContent).toBe('新的对话标题')
  await rowClick('[aria-label="更多操作"]'); await click('归档')
  expect(host.textContent).toContain('这段对话已归档')
  await fill('归档时不能发送'); expect(host.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')?.disabled).toBe(true)
  await click('已归档1'); await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="恢复「新的对话标题」"]')!.click(); await settle() })
  expect(sessions.get(session.sessionId)?.archived).toBe(false)
  await rowClick('[aria-label="更多操作"]'); await click('删除'); await click('删除')
  expect(sessions.get(session.sessionId)?.deleted).toBe(true)
  expect(new URLSearchParams(location.search).has('session')).toBe(false)
})

it('a confirmed workspace tool result refreshes the formal home tiles and opens the real activity', async () => {
  await mount(); await send('创建一个练习项目'); await waitFor(() => expect(sessions.size).toBe(1))
  const sessionId = [...sessions.keys()][0]!, conversation = conversations.get(sessionId)!, runId = conversation.runs[0]!.runId, activityId = crypto.randomUUID()
  const activity = { activityId, identity: actor, target: { environmentId: actor.environmentId, serviceId: crypto.randomUUID(), version: 1 }, question: '递归练习', goal: '递归练习', references: [], status: 'open', createdAt: now }
  workspaces.push(activity)
  conversation.lastSeq++
  conversation.workspaces.push({ operationId: crypto.randomUUID(), runId, workspace: { ...activity, title: '递归练习' } })
  const before = activityReads
  await act(async () => { window.dispatchEvent(new Event('focus')); await settle() })
  await waitFor(() => expect(host.querySelector('.msg-task-card')).not.toBeNull())
  expect(activityReads).toBeGreaterThan(before)
  await click('首页')
  expect(host.querySelector(`[data-activity-id="${activityId}"]`)).not.toBeNull()
})

it('the ordinary composer retains failed local drafts and blocks formal navigation until its original bytes are protected', async () => {
  await mount()
  const put = IDBObjectStore.prototype.put
  let fail = true
  const fault = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (fail && this.name === 'agentControls' && value.key.includes('session-draft')) throw new DOMException('draft quota', 'QuotaExceededError')
    return put.call(this, value, key)
  })
  const text = '尚未发送的完整首问必须保留'
  try {
    await fill(text)
    expect(host.textContent).toContain('输入尚未在本机可靠保留')
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload); expect(unload.defaultPrevented).toBe(true)
    await click('首页')
    expect(new URLSearchParams(location.search).get('view')).toBe('agent')
    expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 Agent 提问"]')?.value).toBe(text)
    await reload()
    await waitFor(async () => { await act(settle); expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 Agent 提问"]')?.value).toBe(text) })
    fail = false
    await click('首页'); expect(new URLSearchParams(location.search).get('view')).not.toBe('agent')
    await click('Agent 对话')
    await waitFor(async () => { await act(settle); expect(host.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 Agent 提问"]')?.value).toBe(text) })
    expect(writes.filter(write => /\/inputs$/.test(write.path))).toHaveLength(0)
  } finally { fail = false; await act(async () => { await sessionInputProtection.leave(); await settle() }); fault.mockRestore() }
})
