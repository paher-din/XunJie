// @vitest-environment jsdom
import { transferableAbortController } from 'node:util'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement, useImperativeHandle, type ReactNode, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ConversationHistoryItem, CreateActivity, LearningActivity } from '@xunjie/contracts/learning-data'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import type { ActivityWorkspaceHandle } from './ActivityWorkspace'
import { LearningApp } from './LearningApp'
import { firstQuestionKey, parsePendingActivityRequest, readFirstQuestion } from './first-question'

// Exercise the real Agent controls, router and creation/recovery transport. The
// separate conversation regression exercises the real durable queue and receipt.
vi.mock('../lib/theme', () => ({ useTheme() {} }))
vi.mock('../components/ProductShell', () => ({ ProductShell: ({ children, onSettings, onHome, onAgent, agentHistory }: {
  children: ReactNode; onSettings(): void; onHome(): void; onAgent(): void; agentHistory(close: () => void): ReactNode
}) => createElement('main', null, createElement('button', { onClick: onSettings }, '打开侧栏设置'),
  createElement('button', { onClick: onHome }, '返回首页'),
  createElement('button', { onClick: onAgent }, 'Agent 对话'), createElement('nav', { 'aria-label': '对话历史' }, agentHistory(() => {})), children) }))
vi.mock('./ProductSettings', () => ({ ProductSettings: ({ modelSettings, onBack }: { modelSettings: ReactNode; onBack(): void }) =>
  createElement('div', null, '设置视图', modelSettings, createElement('button', { onClick: onBack }, '关闭设置')) }))
vi.mock('./PersonalModelSettings', () => ({ PersonalModelSettings: () => createElement('p', null, '模型设置视图') }))
vi.mock('./ActivityReferences', () => ({ ActivityReferences: ({ children }: { children: ReactNode }) => children,
  CourseMaterialReferences: () => null, CourseRequirementsReference: () => null }))
vi.mock('./ActivityPage', () => ({ ActivityPage: ({ activity, workspaceRef }: {
  activity: LearningActivity; workspaceRef: RefObject<ActivityWorkspaceHandle | null>
}) => {
  useImperativeHandle(workspaceRef, () => ({ leave: async () => { if (rejectLeave) throw new Error('保护失败') } }))
  return createElement('h1', { id: 'activity-title' }, activity.goal || activity.question)
} }))
vi.mock('./ProductConversation', () => ({ ProductConversation: ({ activity, workspaceRef }: {
  activity: LearningActivity; workspaceRef: RefObject<ActivityWorkspaceHandle | null>
}) => {
  useImperativeHandle(workspaceRef, () => ({ leave: async () => { if (rejectLeave) throw new Error('保护失败') } }))
  return createElement('h1', { id: 'activity-title' }, activity.goal || activity.question)
} }))

let root: Root, host: HTMLDivElement, identity: SpaceIdentity, namespace: string, pendingKey: string
let activities: Map<string, LearningActivity>, created: CreateActivity[], receiptReads: string[]
let archivedIds: Set<string>
let labels: Map<string, Pick<ConversationHistoryItem, 'title' | 'pinned' | 'deleted'>>
let loseCreationReply: boolean, releaseCreation: (() => void) | undefined, holdCreation: Promise<void> | undefined
let rejectLeave = false
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
const pending = () => parsePendingActivityRequest(JSON.parse(localStorage.getItem(pendingKey)!))
function button(label: string) {
  const found = [...host.querySelectorAll('button')].find(element => element.textContent?.trim() === label)
  expect(found, label).toBeDefined(); return found!
}
async function click(label: string) { await act(async () => { button(label).click(); await settle() }) }
async function conversationMenu(activityId: string, action: string) {
  await act(async () => { host.querySelector<HTMLButtonElement>(`[data-conversation-id="${activityId}"] .agent-conv-more`)!.click(); await settle() })
  await click(action)
}
async function fillQuestion(text: string) {
  await vi.waitFor(async () => {
    await act(async () => { await settle() })
    expect(host.querySelector('textarea[aria-label="向 Agent 提问"]')).not.toBeNull()
  })
  await act(async () => {
    const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 Agent 提问"]')!
    expect(field).not.toBeNull()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text)
    field.dispatchEvent(new Event('input', { bubbles: true })); await settle()
  })
}
async function startQuestion(text: string) {
  await click('Agent 对话')
  await fillQuestion(text)
  const send = host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!
  expect(send).not.toBeNull()
  expect(send.disabled).toBe(false)
  await act(async () => { send.click(); await settle() })
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
  // jsdom does not implement the image decoding or layout observer used by the real Agent UI.
  vi.stubGlobal('Image', class { src = ''; decode() { return Promise.resolve() } })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
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
  activities = new Map(); archivedIds = new Set(); labels = new Map(); created = []; receiptReads = []; loseCreationReply = false; holdCreation = undefined; releaseCreation = undefined; rejectLeave = false
  const historyState = () => ({ items: [...new Set([...archivedIds, ...labels.keys()])].map(activityId => ({ activityId,
    title: null, pinned: false, deleted: false, ...labels.get(activityId), archived: archivedIds.has(activityId) })) })
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const route = url.replace('/api/learning/', '')
    if (route === 'context') return response({ clientNamespace: namespace, profile: 'local', identities: [{ key: 'personal', identity }] })
    if (route === 'models/selection') return response({ version: 0, selected: null, options: [] })
    if (route === 'conversation-archives/set') {
      const input = JSON.parse(options.body as string) as { activityId: string; archived: boolean }
      if (input.archived) archivedIds.add(input.activityId); else archivedIds.delete(input.activityId)
      return response({ archivedIds: [...archivedIds] })
    }
    if (route === 'conversation-archives') return response({ archivedIds: [...archivedIds] })
    if (route === 'conversation-history') return response(historyState())
    if (route === 'conversation-history/update') {
      const input = JSON.parse(options.body as string) as { activityId: string; action: string; title?: string; pinned?: boolean }
      const existing = labels.get(input.activityId) ?? { title: null, pinned: false, deleted: false }
      labels.set(input.activityId, { ...existing, ...(input.action === 'delete' ? { deleted: true }
        : input.action === 'rename' ? { title: input.title! } : { pinned: input.pinned! }) })
      return response(historyState())
    }
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

it.each(['send', 'old-envelope', 'legacy'] as const)(
  'recovers the original creation and saved send intent after an ACK loss and reload (%s)', async (format) => {
  loseCreationReply = true
  await startQuestion('The fixed initial question')
  expect(created).toHaveLength(1)
  const original = pending(), originalQuestionId = original.firstQuestion?.requestId
  expect(originalQuestionId).toBeTypeOf('string')
  if (format === 'old-envelope') localStorage.setItem(pendingKey, JSON.stringify({ ...original, firstQuestion: null }))
  if (format === 'legacy') localStorage.setItem(pendingKey, JSON.stringify(original.input))
  const saved = pending()
  expect(saved.input).toEqual(created[0])
  if (format === 'send') expect(saved.firstQuestion?.requestId).toBe(originalQuestionId)
  else expect(saved.firstQuestion).toBeNull()
  await reload()
  await click('核对并继续原请求')
  expect(created).toHaveLength(1)
  expect(receiptReads).toEqual([saved.input.requestId, saved.input.requestId])
  expect(localStorage.getItem(pendingKey)).toBeNull()
  const activity = activities.get(saved.input.requestId)!
  expect(host.querySelector('#activity-title')).not.toBeNull()
  expect(readFirstQuestion(activity.activityId)).toEqual(format === 'send' ? {
    requestId: originalQuestionId, question: 'The fixed initial question',
  } : null)
})

it('retains the authorized first question when creation completes after a view change', async () => {
  holdCreation = new Promise(resolve => { releaseCreation = resolve })
  await startQuestion('The first question belongs to the created activity')
  const saved = pending()
  expect(saved.firstQuestion).not.toBeNull()
  await click('打开侧栏设置')
  expect(host.textContent).toContain('模型设置视图')
  await act(async () => { releaseCreation!(); await settle() })
  const activity = activities.get(saved.input.requestId)!
  expect(host.textContent).toContain('模型设置视图')
  expect(readFirstQuestion(activity.activityId)).toEqual(saved.firstQuestion)
  expect(localStorage.getItem(pendingKey)).toBeNull()
  await click('关闭设置')
  expect(host.textContent).not.toContain('上次发起的学习尚未确认')
  expect(host.querySelector('nav[aria-label="对话历史"]')?.textContent).toContain(activity.question)
  const field = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="向 Agent 提问"]')!
  expect(field.disabled).toBe(false)
  expect(field.readOnly).toBe(false)
  await fillQuestion('A new question can be sent')
  expect(host.querySelector<HTMLButtonElement>('button[aria-label="发送消息"]')!.disabled).toBe(false)
  await click('返回首页')
  const activityCard = host.querySelector<HTMLButtonElement>(`[data-activity-id="${activity.activityId}"]`)
  expect(activityCard?.textContent).toContain(activity.question)
  expect(created).toHaveLength(1)
})

it('protects an open conversation before archiving it without closing the activity', async () => {
  await startQuestion('要归档的对话')
  const activity = [...activities.values()][0]
  expect(activity).toBeDefined()
  rejectLeave = true
  await conversationMenu(activity.activityId, '归档')
  expect(archivedIds.has(activity.activityId)).toBe(false)
  expect(host.querySelector('#activity-title')).not.toBeNull()
  rejectLeave = false
  await conversationMenu(activity.activityId, '归档')
  expect(archivedIds.has(activity.activityId)).toBe(true)
  expect(activity.status).toBe('open')
  expect(host.querySelector('#activity-title')).toBeNull()
  expect(location.search).not.toContain('activity=')
})

it('protects an open conversation before deleting its entry and keeps the activity', async () => {
  await startQuestion('删除前保留输入的对话')
  const activity = [...activities.values()][0]
  await conversationMenu(activity.activityId, '删除')
  expect(labels.get(activity.activityId)?.deleted).not.toBe(true)
  rejectLeave = true
  await act(async () => { host.querySelector<HTMLButtonElement>('.agent-conv-confirm .danger')!.click(); await settle() })
  expect(labels.get(activity.activityId)?.deleted).not.toBe(true)
  expect(host.querySelector('#activity-title')).not.toBeNull()
  rejectLeave = false
  await act(async () => { host.querySelector<HTMLButtonElement>('.agent-conv-confirm .danger')!.click(); await settle() })
  expect(labels.get(activity.activityId)?.deleted).toBe(true)
  expect(activity.status).toBe('open')
  expect(host.querySelector('#activity-title')).toBeNull()
  expect(location.search).not.toContain('activity=')
})

it('keeps the same activity tree mounted across settings and browser back/forward navigation', async () => {
  await startQuestion('Keep the original activity mounted')
  const title = host.querySelector('#activity-title')!
  expect(title).not.toBeNull()
  await click('打开侧栏设置')
  expect(host.querySelector('#activity-title')).toBe(title)
  expect(title.closest('[inert]')).not.toBeNull()
  await act(async () => { history.back(); await settle() })
  await vi.waitFor(async () => { await act(settle); expect(location.search).not.toContain('settings=account') })
  expect(host.querySelector('#activity-title')).toBe(title)
  expect(title.closest('[inert]')).toBeNull()
  await act(async () => { history.forward(); await settle() })
  await vi.waitFor(async () => { await act(settle); expect(location.search).toContain('settings=account') })
  expect(host.querySelector('#activity-title')).toBe(title)
  expect(title.closest('[inert]')).not.toBeNull()
})

it('does not recreate a discarded automatic-send intent when the original creation replies late', async () => {
  holdCreation = new Promise(resolve => { releaseCreation = resolve })
  await startQuestion('This request will be discarded')
  const saved = pending()
  await click('打开侧栏设置')
  await click('返回首页')
  await click('Agent 对话')
  await click('放弃这次请求')
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
  await startQuestion('Do not discard the send intent before handoff')
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
