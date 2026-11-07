// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { createHash, webcrypto } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ActionInput, ActionReceiverIdentity, ActionView } from '@xunjie/contracts/action-intents'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { ReliableActions, type ActionTransport } from '../reliable-workspace/actions'
import { ReliableQuestionDraft } from '../reliable-workspace/draft'
import { ActionStore } from '../reliable-workspace/action-store'
import { ActivitySessionContext } from './ActivitySession'
import { FirstQuestionAutoSend } from './ActivityConversation'
import { firstQuestionKey, readFirstQuestion, rememberFirstQuestion } from './first-question'

let root: Root, host: HTMLDivElement
const cleanups: (() => void)[] = []
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const originalReceiver: ActionReceiverIdentity = { kind: 'question', location: 'remote', receiverId: 'teaching-agent:original' }
const delivery: NonNullable<ActionInput['delivery']> = { version: 1, mode: 'steering', basis: { source: 'preference', preferenceVersion: 1 } }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('crypto', webcrypto)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  localStorage.clear()
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { root.unmount(); cleanups.splice(0).forEach(dispose => dispose()); await settle() })
  host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
})

async function fixture() {
  const activityId = crypto.randomUUID()
  const key = JSON.stringify(['test', crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID(), activityId])
  let remoteDraft = { draftId: crypto.randomUUID(), revision: 0, revisionId: null as string | null, question: '', references: [] }
  const draft = new ReliableQuestionDraft(key, { read: async () => remoteDraft, receipt: async () => null,
    sync: async input => (remoteDraft = { ...remoteDraft, revision: input.baseRevision + 1, revisionId: crypto.randomUUID(), question: input.question }) })
  await draft.open(); cleanups.push(() => draft.dispose())
  const remote = new Map<string, ActionView>()
  let advertised = originalReceiver
  const prepare = vi.fn(async (input: ActionInput) => {
    const view: ActionView = { input, inputDigest: createHash('sha256').update(JSON.stringify(input)).digest('hex'),
      dependencies: [], state: 'prepared', cancelRequested: false, receipt: null }
    remote.set(input.requestId, view); return view
  })
  const transport: ActionTransport = { prepare, read: async id => remote.get(id) ?? null, list: async () => [...remote.values()],
    capabilities: async () => [advertised], cancel: async () => { throw new Error('Unexpected cancel') },
    dispatch: async id => {
      const prior = remote.get(id)!
      const view: ActionView = { ...prior, state: 'accepted', receipt: { requestId: id, receiver: prior.input.receiver,
        inputDigest: prior.inputDigest, state: 'accepted', receiptId: 'receipt:' + id, detail: 'Accepted' } }
      remote.set(id, view); return view
    } }
  const captureWorks = vi.fn(() => [{ objectId: crypto.randomUUID(), contentId: crypto.randomUUID(),
    name: 'later.txt', kind: 'text' as const, encoding: 'utf8' as const, mediaType: 'text/plain', value: 'Later unsent work' }])
  async function queue(receiver = originalReceiver) {
    advertised = receiver
    const actions = new ReliableActions(key, draft, captureWorks, transport, { denied: () => false, confirmed() {} })
    cleanups.push(() => actions.dispose()); await actions.open()
    await vi.waitFor(() => expect(actions.snapshot().receivers).toHaveLength(1))
    return actions
  }
  const actions = await queue()
  async function render(activeActions = actions, ready = true, mode = delivery) {
    await act(async () => {
      root.render(createElement(ActivitySessionContext.Provider, { value: { draft, actions: activeActions,
        inputInteraction: { ready, writable: true, delivery: mode } } as never },
      createElement(FirstQuestionAutoSend, { activity: { activityId } as LearningActivity })))
      await settle()
    })
  }
  return { activityId, key, draft, actions, queue, render, captureWorks, prepare }
}

it('submits only the fixed home question after delayed readiness and preserves later edits even after acceptance', async () => {
  const env = await fixture(), requestId = crypto.randomUUID()
  rememberFirstQuestion(env.activityId, { requestId, question: 'The submitted home question A' })
  await env.render(env.actions, false)
  env.draft.change('Later unsent draft B', [])
  await env.render()
  await act(async () => { await vi.waitFor(() => expect(env.actions.snapshot().items[0]?.draftSettled).toBe(true)) })
  const input = env.prepare.mock.calls[0][0]
  expect(input.requestId).toBe(requestId)
  expect(input.draft.question).toBe('The submitted home question A')
  expect(input.draft.token).not.toBe(env.draft.capture().token)
  expect(input.works).toEqual([])
  expect(env.captureWorks).not.toHaveBeenCalled()
  expect(env.draft.snapshot().question).toBe('Later unsent draft B')
  expect(localStorage.getItem(firstQuestionKey(env.activityId))).toBeNull()
  await act(async () => { root.render(null); await settle() })
  await env.render()
  expect(env.prepare).toHaveBeenCalledTimes(1)
})

it('reopens the same fixed request after local protection fails, despite changed settings, receiver and composer', async () => {
  const env = await fixture(), requestId = crypto.randomUUID()
  const first = { requestId, question: 'The original home question' }
  rememberFirstQuestion(env.activityId, first)
  const change = ActionStore.prototype.change
  let unavailable = true
  vi.spyOn(ActionStore.prototype, 'change').mockImplementation(function (this: ActionStore, scope, id, update) {
    if (scope === env.key && id === requestId && unavailable) return Promise.reject(new Error('Synthetic local storage failure'))
    return change.call(this, scope, id, update)
  })
  await env.render()
  expect(env.actions.snapshot().items[0]?.phase).toBe('unprotected')
  expect(env.prepare).not.toHaveBeenCalled()
  const fixed = readFirstQuestion(env.activityId)!.input!
  expect(fixed).toBeDefined()
  expect(fixed.delivery).toEqual(delivery)
  // A duplicate creation recovery must not discard an already fixed binding.
  rememberFirstQuestion(env.activityId, first)
  expect(readFirstQuestion(env.activityId)!.input).toEqual(fixed)
  await act(async () => { root.render(null); env.actions.dispose(); await settle() })
  unavailable = false
  env.draft.change('A new unsent draft after reopening', [])
  const reopened = await env.queue({ ...originalReceiver, receiverId: 'teaching-agent:new-advertisement' })
  await env.render(reopened, true, { version: 1, mode: 'queue', basis: { source: 'preference', preferenceVersion: 2 } })
  await act(async () => { await vi.waitFor(() => expect(reopened.snapshot().items[0]?.draftSettled).toBe(true)) })
  expect(env.prepare).toHaveBeenCalledTimes(1)
  expect(env.prepare.mock.calls[0][0]).toEqual(fixed)
  expect((await new ActionStore().list(env.key)).map(item => item.input.requestId)).toEqual([requestId])
  expect(env.draft.snapshot().question).toBe('A new unsent draft after reopening')
  expect(localStorage.getItem(firstQuestionKey(env.activityId))).toBeNull()
})
