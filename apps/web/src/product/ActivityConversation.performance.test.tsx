// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentConversation } from '@xunjie/contracts/agent-service'
import { SessionConversation } from './SessionConversation'
import type { AgentSessionController } from './useAgentSession'
import { mergeAgentConversation } from './agent-sessions'
const state = vi.hoisted(() => ({ lex: vi.fn() }))
vi.mock('marked', async original => { const actual = await original<typeof import('marked')>(); return { ...actual, lexer: (...args: Parameters<typeof actual.lexer>) => { state.lex(); return actual.lexer(...args) } } })
let root: Root, host: HTMLDivElement, conversation: AgentConversation
const runId = crypto.randomUUID(), sessionId = crypto.randomUUID()
const render = async (onWorkspaceCreated = () => {}) => act(async () => root.render(<SessionConversation onWorkspaceCreated={onWorkspaceCreated}
  controller={{ conversation, busy: false, error: '' } as unknown as AgentSessionController} />))
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} })); state.lex.mockClear()
  conversation = { sessionId, lastSeq: 500, runs: [], tools: [], waits: [], inputs: [], workspaces: [], messages: Array.from({ length: 500 }, (_, index) => ({
    messageId: crypto.randomUUID(), runId, role: 'assistant', text: `## 第 ${index + 1} 条说明\n\n已有 **解释** 与学习依据。`, createdAt: '2026-11-13T00:00:00.000Z', state: 'settled' })) }
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
it('unchanged long session projections keep Markdown parsed once and preserve message DOM during incremental updates', async () => {
  await render(); const count = state.lex.mock.calls.length, first = host.querySelector('[data-message-id]')
  conversation = mergeAgentConversation(conversation, structuredClone(conversation)); await render()
  expect(state.lex).toHaveBeenCalledTimes(count)
  expect(host.querySelector('[data-message-id]')).toBe(first)
  conversation = mergeAgentConversation(conversation, { ...conversation, lastSeq: 501, messages: [{ ...conversation.messages[0]!, messageId: crypto.randomUUID(), text: '新增的回答' }] })
  await render(); expect(host.textContent).toContain('新增的回答'); expect(host.querySelectorAll('[data-message-id]')).toHaveLength(501)
  expect(state.lex).toHaveBeenCalledTimes(count + 1)
})
it('only real workspace result data produces one reusable task card and notifies course lists once', async () => {
  const created = vi.fn(), operationId = crypto.randomUUID(), activityId = crypto.randomUUID()
  conversation = { ...conversation, messages: [conversation.messages[0]!], workspaces: [{ operationId, runId, workspace: { activityId, title: '递归练习', goal: '比较递归与迭代',
    target: { environmentId: crypto.randomUUID(), serviceId: crypto.randomUUID(), version: 1 } } }] }
  await render(created); expect(host.querySelectorAll('.msg-task-card')).toHaveLength(1); expect(host.textContent).toContain('递归练习'); expect(created).toHaveBeenCalledOnce()
  conversation = mergeAgentConversation(conversation, structuredClone(conversation)); await render(created)
  expect(created).toHaveBeenCalledOnce(); expect(host.querySelectorAll('.msg-task-card')).toHaveLength(1)
  conversation = { ...conversation, workspaces: [{ operationId: crypto.randomUUID(), runId, workspace: { title: '模型声称创建成功' } }] }
  await render(created); expect(host.querySelectorAll('.msg-task-card')).toHaveLength(0)
})
