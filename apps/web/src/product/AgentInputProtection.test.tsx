// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ActivitySessionContext } from './ActivitySession'
import { SessionConversation } from './SessionConversation'
import { AgentSessionsClient } from './agent-sessions'
import { useAgentSession, type AgentSessionController } from './useAgentSession'
import { ReliableWorkspace } from '../reliable-workspace/index'
import { ReliableQuestionDraft } from '../reliable-workspace/draft'
import { sessionInputProtection } from '../reliable-workspace/input-protection'
import { agentControlStore } from '../reliable-workspace/agent-controls'

let root: Root, host: HTMLDivElement, controller: AgentSessionController
let environments: Awaited<ReturnType<typeof fixture>>[] = []
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
const id = () => crypto.randomUUID()
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  localStorage.clear(); Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount(); await settle() })
  for (const env of environments) { env.actions.dispose(); env.draft.dispose(); env.workspace.dispose() }
  environments = []; host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})
async function fixture() {
  const activityId = id(), environmentId = id(), spaceId = id(), principalId = id(), sessionId = id(), runId = id(), inputId = id(), waitId = id()
  const scope = JSON.stringify(['session-protection', environmentId, spaceId, principalId, activityId])
  const workspace = new ReliableWorkspace(scope, { read: async () => ({ revision: 0, files: [] }), receipt: async () => null,
    sync: async () => { throw new Error('Unexpected work synchronization') } })
  const draft = new ReliableQuestionDraft(scope, { read: async () => ({ draftId: id(), revision: 0, revisionId: null, question: '', references: [] }),
    receipt: async () => null, sync: async () => { throw new Error('Unexpected draft synchronization') } })
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected legacy action') }
  const actions = workspace.actions(draft, { list: async () => [], read: async () => null, capabilities: async () => [], prepare: unexpected, dispatch: unexpected, cancel: unexpected })
  const identity = { kind: 'personal' as const, environmentId, spaceId, principalId, name: '个人' }
  const client = new AgentSessionsClient({ identity, namespace: 'session-protection', spaceKey: 'personal' })
  const now = new Date().toISOString(), original = '原排队问题', requestId = id()
  const input = { inputId, runId, version: 1, mode: 'queue', state: 'pending', text: original, createdAt: now }
  const run = { runId, sessionId, requestId, inputId, state: 'waiting', reason: '', generation: 1, stopRequested: false, needsContinue: false,
    previousRunId: null, createdAt: now, updatedAt: now, completedAt: null }
  const wait = { waitId, runId, operationId: id(), version: 1, kind: 'user', state: 'pending', presentation: { question: '观察到了什么？', source: '原实验', options: [], allowText: true, skippable: false }, response: null, deadline: null }
  const projection = { sessionId, lastSeq: 1, messages: [{ messageId: 'input:' + inputId, inputId, runId, role: 'user', text: original, state: 'settled', createdAt: now }],
    runs: [run], inputs: [input], waits: [wait], tools: [], workspaces: [] }
  const writes: { url: string; body: any }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (!options.body) return new Response(JSON.stringify(projection))
    const body = JSON.parse(String(options.body)); writes.push({ url, body })
    if (url.endsWith('/responses')) { wait.state = 'consumed'; return new Response(JSON.stringify({ runId, waitId })) }
    input.version++; input.text = body.text
    return new Response(JSON.stringify({ requestId: body.requestId, input: { ...input, input: { sessionId, requestId, text: input.text, mode: 'queue', context: {} } } }))
  }))
  await Promise.all([workspace.open(), draft.open()]); await actions.open(); await settle()
  return { activityId, scope, workspace, draft, actions, actionScope: { environmentId, spaceId, principalId, activityId }, client, sessionId, inputId, waitId, original, writes }
}
function View({ env, standalone = false }: { env: Awaited<ReturnType<typeof fixture>>; standalone?: boolean }) {
  controller = useAgentSession(env.client, env.sessionId, true)
  if (standalone) return createElement(SessionConversation, { controller })
  return createElement(ActivitySessionContext.Provider, { value: { workspace: env.workspace, draft: env.draft, actions: env.actions, agent: controller } as never },
    createElement(SessionConversation, { controller }))
}
async function mount(env: Awaited<ReturnType<typeof fixture>>, visible = true, standalone = false) {
  await act(async () => { root.render(visible ? createElement(View, { env, standalone }) : null); await settle() })
}
async function expectDraft(text: string) {
  for (let i = 0; i < 40; i++) {
    if (host.querySelector('textarea')?.value === text) return
    await act(settle)
  }
  expect(host.querySelector('textarea')?.value).toBe(text)
}
async function type(text: string) {
  const textarea = host.querySelector('textarea')!
  expect(textarea).not.toBeNull()
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true })); await settle() })
}
async function click(label: string) {
  for (let i = 0; i < 40; i++) {
    const button = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === label || button.getAttribute('aria-label') === label)
    if (button && !button.disabled) { await act(async () => { button.click(); await settle() }); return }
    await act(settle)
  }
  throw new Error('Ready control not found: ' + label)
}

function failSessionWrites(sessionId: string) {
  const put = IDBObjectStore.prototype.put
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
    if (this.name === 'agentControls' && value.key.includes(sessionId)) throw new DOMException('Review-injected IndexedDB quota failure', 'QuotaExceededError')
    return put.call(this, value, key)
  })
  return { restore: () => spy.mockRestore() }
}
function beforeUnloadPrevented() { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented }
async function activityLeave(env: Awaited<ReturnType<typeof fixture>>) { await env.workspace.leave(); await env.draft.leave(); await env.actions.leave() }

describe('session v2 drafts use the actual public input protection contract', () => {
  it.each(['response', 'queued revision'] as const)('retains a %s through quota failure, remount, blocked leave and recovery retry', async kind => {
    const env = await fixture(); environments.push(env); await mount(env)
    if (kind === 'queued revision') { await click('编辑这条消息'); expect(host.querySelector('[aria-label="修改这条消息"]')).not.toBeNull() }
    const fault = failSessionWrites(env.sessionId), text = '必须保留的详细输入，不能回退原文'
    await type(text)
    expect(host.textContent).toContain('输入尚未在本机可靠保留')
    expect(beforeUnloadPrevented()).toBe(true)
    await act(async () => { await expect(activityLeave(env)).rejects.toThrow('Review-injected IndexedDB quota failure')
      await expect(env.workspace.flush()).rejects.toThrow('Review-injected IndexedDB quota failure') })
    expect(env.writes).toHaveLength(0)
    await mount(env, false); await mount(env)
    await expectDraft(text)
    await mount(env, false); expect(beforeUnloadPrevented()).toBe(true)
    fault.restore()
    await expect(activityLeave(env)).resolves.toBeUndefined()
    expect(beforeUnloadPrevented()).toBe(false)
    await mount(env); await expectDraft(text)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    await click(kind === 'response' ? '发送回应' : '发送')
    expect(env.writes).toHaveLength(1)
    expect(env.writes[0]!.body).toMatchObject(kind === 'response' ? { expectedVersion: 1, answer: { kind: 'text', text } } : { expectedVersion: 1, operation: 'edit', text })
    expect(env.writes[0]!.url).toContain('/agent-sessions/' + env.sessionId + '/')
  })

  it.each(['response', 'queued revision'] as const)('protects an ordinary session %s without an activity workspace', async kind => {
    const env = await fixture(); environments.push(env); await mount(env, true, true)
    if (kind === 'queued revision') { await click('编辑这条消息'); expect(host.querySelector('[aria-label="修改这条消息"]')).not.toBeNull() }
    const fault = failSessionWrites(env.sessionId), text = '普通会话中不能丢失的草稿'
    await type(text)
    expect(host.textContent).toContain('输入尚未在本机可靠保留')
    expect(beforeUnloadPrevented()).toBe(true)
    await act(async () => { await expect(sessionInputProtection.leave()).rejects.toThrow('Review-injected IndexedDB quota failure') })
    await mount(env, false, true); await mount(env, true, true); await expectDraft(text)
    fault.restore()
    if (kind === 'queued revision') await click('重试保留输入')
    else await act(async () => { await vi.advanceTimersByTimeAsync(250); await settle() })
    await expect(sessionInputProtection.leave()).resolves.toBeUndefined()
    expect(beforeUnloadPrevented()).toBe(false)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    await mount(env, false, true); await mount(env, true, true); await expectDraft(text)
    expect(env.writes).toHaveLength(0)
  })

  it('reloads the original saved response after a local read failure is repaired', async () => {
    const env = await fixture(); environments.push(env); await mount(env)
    const text = '已经可靠保存的原回应'
    await type(text); await act(async () => { await activityLeave(env) }); await mount(env, false)
    const get = IDBObjectStore.prototype.get
    const fault = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementation(function (this: IDBObjectStore, key) {
      if (this.name === 'agentControls' && String(key).includes(env.sessionId)) throw new DOMException('draft read unavailable', 'UnknownError')
      return get.call(this, key)
    })
    await mount(env)
    for (let i = 0; i < 40 && !host.textContent?.includes('本机草稿暂时无法读取'); i++) await act(settle)
    expect(host.textContent).toContain('本机草稿暂时无法读取')
    fault.mockRestore()
    const response = host.querySelector('[aria-label="Agent 的问题"]')!
    await act(async () => { response.querySelector<HTMLButtonElement>('[role="alert"] button')!.click(); await settle() })
    await expectDraft(text)
    expect(response.querySelector('[role="alert"]')).toBeNull()
    expect(env.writes).toHaveLength(0)
  })

  it('keeps leave pending through older in-flight bytes and only clears protection after the latest edit commits', async () => {
    const env = await fixture(), key = JSON.stringify([env.scope, 'synthetic-control'])
    environments.push(env)
    let releaseOlder!: () => void, releaseNewer!: () => void, left = false
    const olderBlocked = new Promise<void>(resolve => { releaseOlder = resolve })
    const newerBlocked = new Promise<void>(resolve => { releaseNewer = resolve })
    const older = env.workspace.retainInput(key, 'older', async text => {
      await olderBlocked; return agentControlStore.change(key, () => ({ key, scope: env.scope, draft: { text, editing: true, expectedVersion: 1 } }))
    })
    const newer = env.workspace.retainInput(key, 'newer', async text => {
      await newerBlocked; return agentControlStore.change(key, () => ({ key, scope: env.scope, draft: { text, editing: true, expectedVersion: 1 } }))
    })
    const leave = activityLeave(env).then(() => { left = true })
    try {
      await settle()
      expect(left).toBe(false); expect(beforeUnloadPrevented()).toBe(true)
      releaseOlder(); await older
      expect((await agentControlStore.read(key))?.draft?.text).toBe('older')
      expect(left, 'The older successful transaction must not release the latest edit').toBe(false)
      expect(beforeUnloadPrevented()).toBe(true)
      releaseNewer(); await Promise.all([newer, leave])
      expect(left).toBe(true); expect(beforeUnloadPrevented()).toBe(false)
      expect((await agentControlStore.read(key))?.draft?.text).toBe('newer')
    } finally { releaseOlder(); releaseNewer(); await Promise.allSettled([older, newer, leave]) }
  })
})
