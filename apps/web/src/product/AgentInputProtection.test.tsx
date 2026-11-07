// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ActivitySessionContext } from './ActivitySession'
import { StudentQuestionCard } from './StudentQuestionCard'
import { AgentInputRecord } from './AgentControls'
import { ReliableWorkspace } from '../reliable-workspace/index'
import { ReliableQuestionDraft } from '../reliable-workspace/draft'
import { StudentResponseStore } from '../reliable-workspace/student-responses'
import { agentControlStore } from '../reliable-workspace/agent-controls'

// Real UI and public controllers; only IndexedDB put failures are injected.
// No protection, leave, flush or record-store method is mocked:
// ReliableRecordStore still performs its real read/update/abort transaction.
let root: Root, host: HTMLDivElement
let environments: { workspace: ReliableWorkspace; draft: ReliableQuestionDraft; actions: ReturnType<ReliableWorkspace['actions']> }[] = []
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount(); await settle() })
  for (const env of environments) { env.actions.dispose(); env.draft.dispose(); env.workspace.dispose() }
  environments = []; host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers()
})

async function fixture() {
  const activityId = crypto.randomUUID(), environmentId = crypto.randomUUID(), spaceId = crypto.randomUUID(), principalId = crypto.randomUUID()
  const scope = JSON.stringify(['standards-review', environmentId, spaceId, principalId, activityId])
  const workspace = new ReliableWorkspace(scope, {
    read: async () => ({ revision: 0, files: [] }), receipt: async () => null,
    sync: async () => { throw new Error('Unexpected work synchronization in an unchanged workspace') },
  })
  const draft = new ReliableQuestionDraft(scope, {
    read: async () => ({ draftId: crypto.randomUUID(), revision: 0, revisionId: null, question: '', references: [] }),
    receipt: async () => null, sync: async () => { throw new Error('Unexpected draft synchronization') },
  })
  const unexpected = async (): Promise<never> => { throw new Error('Unexpected business action') }
  const actions = workspace.actions(draft, { list: async () => [], read: async () => null,
    capabilities: async () => [], prepare: unexpected, dispatch: unexpected, cancel: unexpected })
  const env = { activityId, scope, workspace, draft, actions, actionScope: { environmentId, spaceId, principalId, activityId } }
  environments.push(env)
  await Promise.all([workspace.open(), draft.open()]); await actions.open(); await settle()
  return env
}

async function mount(env: Awaited<ReturnType<typeof fixture>>, child: ReactNode) {
  // Unused execution/session interactions are absent. All three real leave
  // controllers are supplied; no production method is spied or stubbed.
  await act(async () => { root.render(createElement(ActivitySessionContext.Provider,
    { value: { workspace: env.workspace, draft: env.draft, actions: env.actions } as never }, child)) })
  await act(settle)
}
async function type(text: string) {
  const textarea = host.querySelector('textarea')!
  expect(textarea).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text)
    textarea.dispatchEvent(new Event('input', { bubbles: true })); await settle()
  })
}
async function click(label: string) {
  const button = [...host.querySelectorAll('button')].find(button => button.textContent?.trim() === label)
  expect(button).toBeDefined()
  await act(async () => { button!.click(); await settle() })
}
function failPartitionWrites(partition: string, key: string) {
  const attempts: unknown[] = [], put = IDBObjectStore.prototype.put
  const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, suppliedKey) {
    if (this.name === partition && value.key === key) {
      attempts.push(structuredClone(value))
      throw new DOMException('Review-injected IndexedDB quota failure', 'QuotaExceededError')
    }
    return put.call(this, value, suppliedKey)
  })
  return { attempts, restore: () => spy.mockRestore() }
}
function beforeUnloadPrevented() {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}
async function activityLeave(env: Awaited<ReturnType<typeof fixture>>) {
  // Exact public contract installed by ActivityPage.tsx:76–78. This test does
  // not pretend to exercise React Router; LearningApp proceeds iff this resolves.
  await env.workspace.leave(); await env.draft.leave(); await env.actions.leave()
}
const request = async () => null, confirmed = async () => {}

describe('Agent drafts use the real activity protection contract', () => {
  it('retains response bytes through failed transactions, remounts and automatic protection retries', async () => {
    const env = await fixture(), questionId = crypto.randomUUID()
    const question = { questionId, version: 1, waitVersion: 1, question: 'What did you observe?',
      state: 'pending', source: { detail: 'Current activity' }, options: [], allowText: true, skippable: false }
    const child = createElement(StudentQuestionCard, { question: question as never, activityId: env.activityId,
      scope: env.scope, readOnly: false, request, onConfirmed: confirmed })
    const key = JSON.stringify([env.scope, questionId, 1, 1]), store = new StudentResponseStore()
    await mount(env, child)
    expect((await store.read(key))?.text).toBe('')
    const fault = failPartitionWrites('studentResponses', key), text = 'My detailed response must survive'
    await type(text)
    expect(fault.attempts).toHaveLength(1)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('输入尚未在本机可靠保留')
    expect((await store.read(key))?.text).toBe('')
    expect(beforeUnloadPrevented()).toBe(true)
    await act(async () => {
      await expect(activityLeave(env)).rejects.toThrow('Review-injected IndexedDB quota failure')
      await expect(env.workspace.flush()).rejects.toThrow('Review-injected IndexedDB quota failure')
    })
    await mount(env, null); await mount(env, child)
    expect(host.querySelector('textarea')?.value).toBe(text)
    expect(beforeUnloadPrevented()).toBe(true)
    fault.restore()
    await act(async () => { await vi.advanceTimersByTimeAsync(250); await settle() })
    expect((await store.read(key))?.text).toBe(text)
    expect(host.querySelector('[role="alert"]')).toBeNull()
    expect(beforeUnloadPrevented()).toBe(false)
    await expect(activityLeave(env)).resolves.toBeUndefined()
    await expect(env.workspace.flush()).resolves.toBeUndefined()
    await mount(env, null); await mount(env, child)
    expect(host.querySelector('textarea')?.value).toBe(text)
  })

  it('retains a queued-input revision through failed writes and lets leave retry after the editor unmounts', async () => {
    const env = await fixture(), inputId = crypto.randomUUID(), original = 'Original queued question'
    const input = { inputId, version: 1, state: 'pending', mode: 'queue',
      input: { scope: env.actionScope, draft: { question: original, references: [] }, works: [] } }
    const child = createElement(AgentInputRecord, { input: input as never, scope: env.scope, readOnly: false, request, onConfirmed: confirmed })
    const key = JSON.stringify([env.scope, 'agent-control', 'input:' + inputId])
    await mount(env, child); await click('编辑')
    expect((await agentControlStore.read(key))?.draft?.text).toBe(original)
    const fault = failPartitionWrites('agentControls', key), text = 'The revised queued input must survive'
    await type(text)
    expect(fault.attempts).toHaveLength(1)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('草稿尚未在本机可靠保留')
    expect((await agentControlStore.read(key))?.draft?.text).toBe(original)
    expect(beforeUnloadPrevented()).toBe(true)
    await act(async () => {
      await expect(activityLeave(env)).rejects.toThrow('Review-injected IndexedDB quota failure')
      await expect(env.workspace.flush()).rejects.toThrow('Review-injected IndexedDB quota failure')
    })
    await mount(env, null); await mount(env, child)
    expect(host.querySelector('textarea')?.value).toBe(text)
    await mount(env, null)
    expect(beforeUnloadPrevented()).toBe(true)
    fault.restore()
    await expect(activityLeave(env)).resolves.toBeUndefined()
    expect(beforeUnloadPrevented()).toBe(false)
    expect((await agentControlStore.read(key))?.draft?.text).toBe(text)
    await expect(env.workspace.flush()).resolves.toBeUndefined()
    await mount(env, child)
    expect(host.querySelector('textarea')?.value).toBe(text)
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps leave pending through older in-flight bytes and only clears protection after the latest edit commits', async () => {
    const env = await fixture(), key = JSON.stringify([env.scope, 'synthetic-control'])
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
