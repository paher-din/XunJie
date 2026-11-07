// @vitest-environment jsdom
import { transferableAbortController } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement, useImperativeHandle, type ReactNode, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { CreateActivity, LearningActivity } from '@xunjie/contracts/learning-data'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import type { ActivityWorkspaceHandle } from './ActivityWorkspace'
import { LearningApp } from './LearningApp'
import { firstQuestionKey, parsePendingActivityRequest, readFirstQuestion } from './first-question'

// Exercise the real home controls, router and creation/recovery transport. The
// separate conversation regression exercises the real durable queue and receipt.
vi.mock('../lib/theme', () => ({ useTheme() {} }))
vi.mock('../components/ProductShell', () => ({ ProductShell: ({ children, onModels, onHome }: {
  children: ReactNode; onModels(): void; onHome(): void
}) => createElement('main', null, createElement('button', { onClick: onModels }, '打开模型设置'),
  createElement('button', { onClick: onHome }, '返回首页'), children) }))
vi.mock('./PersonalModelSettings', () => ({ PersonalModelSettings: () => createElement('p', null, '模型设置视图') }))
vi.mock('./ActivityReferences', () => ({ ActivityReferences: ({ children }: { children: ReactNode }) => children,
  CourseMaterialReferences: () => null, CourseRequirementsReference: () => null }))
vi.mock('./ActivityPage', () => ({ ActivityPage: ({ activity, workspaceRef }: {
  activity: LearningActivity; workspaceRef: RefObject<ActivityWorkspaceHandle | null>
}) => {
  useImperativeHandle(workspaceRef, () => ({ leave: async () => {} }))
  return createElement('h1', { id: 'activity-title' }, activity.goal)
} }))

let root: Root, host: HTMLDivElement, identity: SpaceIdentity, namespace: string, pendingKey: string
let activities: Map<string, LearningActivity>, created: CreateActivity[], receiptReads: string[]
let loseCreationReply: boolean, releaseCreation: (() => void) | undefined, holdCreation: Promise<void> | undefined
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
const pending = () => parsePendingActivityRequest(JSON.parse(localStorage.getItem(pendingKey)!))
function button(label: string) {
  const found = [...host.querySelectorAll('button')].find(element => element.textContent?.trim() === label)
  expect(found, label).toBeDefined(); return found!
}
async function click(label: string) { await act(async () => { button(label).click(); await settle() }) }
async function fillQuestion(text: string) {
  await act(async () => {
    const field = host.querySelector<HTMLTextAreaElement>('.product-new-activity textarea')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true })); await settle()
  })
}
async function mount() {
  await act(async () => { root.render(createElement(LearningApp)); await settle() })
}
async function reload() {
  await act(async () => { root.unmount(); await settle() })
  root = createRoot(host); await mount()
}

beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // React Router creates Node's native Request; its signal must come from the
  // same implementation instead of jsdom's otherwise compatible DOM signal.
  const abort = transferableAbortController()
  vi.stubGlobal('AbortController', abort.constructor)
  vi.stubGlobal('AbortSignal', abort.signal.constructor)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/')
  identity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(),
    kind: 'personal', name: '测试用户' }
  namespace = crypto.randomUUID()
  pendingKey = `xj.activity-request.${namespace}.${identity.environmentId}.${identity.spaceId}.${identity.principalId}`
  activities = new Map(); created = []; receiptReads = []; loseCreationReply = false; holdCreation = undefined; releaseCreation = undefined
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const route = url.replace('/api/learning/', '')
    if (route === 'context') return response({ clientNamespace: namespace, profile: 'local', identities: [{ key: 'personal', identity }] })
    if (route === 'models/selection') return response({ version: 0, selected: null, options: [] })
    if (route.startsWith('receipts/')) {
      const requestId = route.slice('receipts/'.length); receiptReads.push(requestId)
      return response(activities.get(requestId) ?? null)
    }
    if (route === 'activities' && options.method === 'POST') {
      const input = JSON.parse(options.body as string) as CreateActivity
      created.push(input)
      const activity: LearningActivity = { activityId: crypto.randomUUID(), identity,
        target: { environmentId: identity.environmentId, serviceId: crypto.randomUUID(), version: 1 },
        goal: input.goal, question: input.question, references: input.references, status: 'open', createdAt: new Date().toISOString() }
      activities.set(input.requestId, activity)
      await holdCreation
      if (loseCreationReply) { loseCreationReply = false; throw new TypeError('Synthetic creation ACK loss') }
      return response(activity)
    }
    if (route === 'activities') return response([...activities.values()])
    if (route.startsWith('activities/')) return response([...activities.values()].find(activity => activity.activityId === route.slice('activities/'.length)))
    throw new Error('Unexpected route ' + route)
  }))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await mount()
})
afterEach(async () => {
  await act(async () => { releaseCreation?.(); await settle(); root.unmount(); await settle() })
  host.remove(); vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals()
})

it.each([{ send: true, legacy: false }, { send: false, legacy: false }, { send: false, legacy: true }])(
  'recovers the original creation and saved send intent after an ACK loss and reload (send=$send, legacy=$legacy)', async ({ send, legacy }) => {
  loseCreationReply = true
  await fillQuestion('The fixed initial question')
  await click(send ? '建立并开始对话' : '建立学习活动')
  expect(created).toHaveLength(1)
  const saved = pending(), originalQuestionId = saved.firstQuestion?.requestId
  expect(saved.input).toEqual(created[0])
  if (send) expect(originalQuestionId).toBeTypeOf('string')
  else expect(saved.firstQuestion).toBeNull()
  if (legacy) localStorage.setItem(pendingKey, JSON.stringify(saved.input))
  await reload()
  await click('核对并继续原请求')
  expect(created).toHaveLength(1)
  expect(receiptReads).toEqual([saved.input.requestId, saved.input.requestId])
  expect(localStorage.getItem(pendingKey)).toBeNull()
  const activity = activities.get(saved.input.requestId)!
  expect(host.querySelector('#activity-title')).not.toBeNull()
  expect(readFirstQuestion(activity.activityId)).toEqual(send ? {
    requestId: originalQuestionId, question: 'The fixed initial question',
  } : null)
})

it('retains the authorized first question when creation completes after a view change', async () => {
  holdCreation = new Promise(resolve => { releaseCreation = resolve })
  await fillQuestion('The first question belongs to the created activity')
  await click('建立并开始对话')
  const saved = pending()
  expect(saved.firstQuestion).not.toBeNull()
  await click('打开模型设置')
  expect(host.textContent).toContain('模型设置视图')
  await act(async () => { releaseCreation!(); await settle() })
  const activity = activities.get(saved.input.requestId)!
  expect(host.textContent).toContain('模型设置视图')
  expect(readFirstQuestion(activity.activityId)).toEqual(saved.firstQuestion)
  expect(localStorage.getItem(pendingKey)).toBeNull()
})

it('does not recreate a discarded automatic-send intent when the original creation replies late', async () => {
  holdCreation = new Promise(resolve => { releaseCreation = resolve })
  await fillQuestion('This request will be discarded')
  await click('建立并开始对话')
  const saved = pending()
  await click('打开模型设置')
  await click('返回首页')
  await click('放弃这次请求并重新填写')
  await act(async () => { releaseCreation!(); await settle() })
  const activity = activities.get(saved.input.requestId)!
  expect(readFirstQuestion(activity.activityId)).toBeNull()
  expect(localStorage.getItem(pendingKey)).toBeNull()
  expect(host.querySelector('#activity-title')).toBeNull()
})

it('keeps both original identities until the first question handoff itself is protected', async () => {
  const setItem = Storage.prototype.setItem
  let rejectFirstQuestion = true
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith(firstQuestionKey('')) && rejectFirstQuestion) throw new Error('Synthetic full browser storage')
    return setItem.call(this, key, value)
  })
  await fillQuestion('Do not discard the send intent before handoff')
  await click('建立并开始对话')
  const saved = pending()
  expect(saved.firstQuestion).not.toBeNull()
  expect(created).toHaveLength(1)
  rejectFirstQuestion = false
  await reload()
  await click('核对并继续原请求')
  const activity = activities.get(saved.input.requestId)!
  expect(readFirstQuestion(activity.activityId)).toEqual(saved.firstQuestion)
  expect(created).toHaveLength(1)
  expect(localStorage.getItem(pendingKey)).toBeNull()
})
