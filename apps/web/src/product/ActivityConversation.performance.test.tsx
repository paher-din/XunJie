// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import type { TeachingConversation } from '@xunjie/contracts/teaching-agent'
import { ActivityConversation } from './ActivityConversation'
import { LearningReadCache } from './learning-read-cache'
import { workspaceScope } from './learningTransport'

const state = vi.hoisted(() => ({ cache: undefined as LearningReadCache | undefined, active: true,
  request: vi.fn(), lex: vi.fn(), actions: { items: [] } }))
vi.mock('./ActivitySession', () => ({ useActivitySession: () => ({
  workspace: { isReadOnly: () => false }, actions: { subscribe: () => () => {}, snapshot: () => state.actions },
  readCache: state.cache, viewActive: state.active,
}) }))
vi.mock('./learningTransport', async original => ({ ...await original<typeof import('./learningTransport')>(),
  learningRequest: state.request, learningSubjectRequest: state.request }))
vi.mock('marked', async original => {
  const actual = await original<typeof import('marked')>()
  return { ...actual, lexer: (...args: Parameters<typeof actual.lexer>) => { state.lex(); return actual.lexer(...args) } }
})

const identity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), kind: 'personal' as const, name: '性能测试' }
const activity: LearningActivity = { activityId: crypto.randomUUID(), identity,
  target: { environmentId: identity.environmentId, serviceId: crypto.randomUUID(), version: 1 },
  goal: '', question: '性能测试', references: [], status: 'open', createdAt: '2026-01-01T00:00:00.000Z' }
let root: Root, host: HTMLDivElement, conversation: TeachingConversation
const render = async () => act(async () => { root.render(<ActivityConversation activity={activity} spaceKey="personal" namespace="performance" />) })
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  state.cache = new LearningReadCache(); state.active = true; state.lex.mockClear(); state.request.mockReset()
  conversation = { activityId: activity.activityId, cursor: 500, runs: [], tools: [], waits: [], questions: [], inputs: [], artifactPreviews: [],
    messages: Array.from({ length: 500 }, (_, index) => ({ eventId: crypto.randomUUID(), seq: index + 1, role: 'assistant' as const,
      text: `## 第 ${index + 1} 条教学说明\n\n已有内容包含 **解释**、代码和列表。\n\n- 观察结果\n- 修订想法`, runId: null, createdAt: activity.createdAt })) }
  state.request.mockImplementation(async () => structuredClone(conversation))
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove(); vi.useRealTimers(); vi.unstubAllGlobals()
})

it('does not parse unchanged historical Markdown again when polling a long conversation', async () => {
  await render()
  expect(host.querySelectorAll('.teaching-message')).toHaveLength(500)
  const parsed = state.lex.mock.calls.length
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(state.request).toHaveBeenCalledTimes(2)
  expect(state.lex).toHaveBeenCalledTimes(parsed)
  conversation = { ...conversation, cursor: 501, messages: [...conversation.messages,
    { ...conversation.messages[0], eventId: crypto.randomUUID(), seq: 501, text: '新增的回答' }] }
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(host.textContent).toContain('新增的回答')
  expect(state.lex).toHaveBeenCalledTimes(parsed + 1)
})

it('shows a cached conversation while its fresh read is pending and pauses reads behind settings', async () => {
  state.cache!.set('personal', 'conversation:' + workspaceScope('performance', activity), conversation)
  await vi.advanceTimersByTimeAsync(1001)
  let finish!: (value: TeachingConversation) => void
  state.request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await render()
  expect(host.querySelectorAll('.teaching-message')).toHaveLength(500)
  expect(host.textContent).not.toContain('正在读取学习对话')
  state.active = false
  await render()
  await act(async () => { finish(conversation) })
  await act(async () => { await vi.advanceTimersByTimeAsync(15000) })
  expect(state.request).toHaveBeenCalledOnce()
  state.active = true
  await render()
  expect(state.request).toHaveBeenCalledTimes(2)
  await act(async () => { finish(conversation) })
})

it('joins a conversation read started before the page module mounts', async () => {
  const { readConversation } = await import('./conversation-read')
  let finish!: (value: TeachingConversation) => void
  state.request.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const prepared = readConversation(activity, 'personal', 'performance', state.cache)
  await render()
  expect(state.request).toHaveBeenCalledOnce()
  await act(async () => { finish(conversation); await prepared })
  expect(host.querySelectorAll('.teaching-message')).toHaveLength(500)
})

it('consumes a just-completed preload without immediately downloading the same history again', async () => {
  const { readConversation } = await import('./conversation-read')
  await readConversation(activity, 'personal', 'performance', state.cache)
  await render()
  expect(host.querySelectorAll('.teaching-message')).toHaveLength(500)
  expect(state.request).toHaveBeenCalledOnce()
  await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
  expect(state.request).toHaveBeenCalledTimes(2)
})
