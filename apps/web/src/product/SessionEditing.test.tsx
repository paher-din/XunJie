// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { agentConversationSchema } from '@xunjie/contracts/agent-service'
import { AgentSessionsClient } from './agent-sessions'
import { useAgentSession } from './useAgentSession'
import { SessionConversation } from './SessionConversation'

it.each(['active', 'completed', 'stopped', 'interrupted', 'failed'] as const)('v3 %s edits reset cancelled text and replace the original message on send', async state => {
  const identity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), kind: 'personal' as const, name: '学生' }
  const sessionId = crypto.randomUUID(), turnId = crypto.randomUUID(), inputId = crypto.randomUUID(), now = new Date().toISOString()
  const turn = { turnId, sessionId, requestId: crypto.randomUUID(), trigger: 'user' as const, originNotificationId: null,
    ownerInstanceId: 'test-owner', state, reason: '', createdAt: now, updatedAt: now, completedAt: state === 'active' ? null : now }
  const view = agentConversationSchema.parse({ sessionId, lastSeq: 1, reset: true, turns: [turn], questions: [], tools: [], workspaces: [],
    inputs: [{ inputId, turnId, version: 1, state: 'adopted', text: '原问题', createdAt: now, canEdit: true }],
    messages: [{ messageId: 'input:' + inputId, inputId, turnId, role: 'user', text: '原问题', createdAt: now, state: 'settled' },
      { messageId: 'answer:' + turnId, turnId, role: 'assistant', text: '旧回答', createdAt: now, state: 'settled' }] })
  const writes: string[] = []
  const client = new AgentSessionsClient({ identity, spaceKey: 'personal', namespace: 'editing-v3' })
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (!options.body) return Response.json(view)
    const body = JSON.parse(String(options.body)); writes.push(url.endsWith('/stop') ? 'stop' : body.operation)
    if (url.endsWith('/stop')) { Object.assign(view.turns[0]!, { state: 'stopped', completedAt: now }); return Response.json(view.turns[0]) }
    const replacement = { ...turn, turnId: crypto.randomUUID(), requestId: body.requestId, state: 'completed' as const, completedAt: now }
    view.turns.push(replacement)
    Object.assign(view.inputs[0]!, { turnId: replacement.turnId, version: 2, text: body.text })
    const editedAt = new Date(Date.parse(now) + 60000).toISOString()
    view.messages = [{ ...view.messages[0]!, turnId: replacement.turnId, text: body.text, editedAt },
      { ...view.messages[1]!, messageId: 'answer:' + replacement.turnId, turnId: replacement.turnId, text: '新回答' }]
    const { text, canEdit: _canEdit, ...input } = view.inputs[0]!
    return Response.json({ requestId: body.requestId, input: { ...input, input: { sessionId, requestId: turn.requestId, text, context: {} } } })
  }))
  localStorage.clear()
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  function Conversation() { return <SessionConversation controller={useAgentSession(client, sessionId, true)} /> }
  const settle = async () => { for (let index = 0; index < 8; index++) await new Promise(resolve => setTimeout(resolve, 0)) }
  const click = async (label: string) => {
    for (let attempt = 0; attempt < 60; attempt++) {
      const button = host.querySelector<HTMLButtonElement>('button[aria-label="' + label + '"]')
        ?? [...host.querySelectorAll('button')].find(element => element.textContent === label)
      if (button && !button.disabled) { await act(async () => { button.click(); await settle() }); return }
      await act(settle)
    }
    throw new Error('Unavailable control: ' + label)
  }
  const fill = async (value: string) => act(async () => {
    const field = host.querySelector<HTMLTextAreaElement>('[aria-label="修改这条消息"]')!
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true })); await settle()
  })
  try {
    await act(async () => { root.render(<Conversation />); await settle() })
    await click('编辑这条消息')
    expect(writes).toEqual(state === 'active' ? ['stop'] : [])
    await fill(''); await click('取消'); await click('编辑这条消息')
    expect(host.querySelector<HTMLTextAreaElement>('[aria-label="修改这条消息"]')!.value).toBe('原问题')
    await fill('修订问题'); await click('发送')
    expect(host.querySelectorAll('.chat-message.user')).toHaveLength(1)
    expect(host.querySelector('.bubble')!.textContent).toBe('修订问题')
    expect(host.textContent).not.toContain('旧回答')
    expect(host.querySelector('.chat-message.user time')!.getAttribute('dateTime')).toBe(view.messages[0]!.editedAt)
    expect(writes).toEqual(state === 'active' ? ['stop', 'edit'] : ['edit'])
  } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() }
})
