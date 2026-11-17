// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { AgentConversation } from '@xunjie/contracts/agent-service'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { SessionConversation } from './SessionConversation'
import { SessionQuestionBox } from './SessionQuestion'
import { AgentSessionsClient } from './agent-sessions'
import { useAgentSession, type AgentSessionController } from './useAgentSession'
const id = () => crypto.randomUUID()
const identity = { kind: 'personal' as const, environmentId: id(), spaceId: id(), principalId: id(), name: '个人' }
const client = new AgentSessionsClient({ identity, spaceKey: 'personal', namespace: 'test' })
let host: HTMLDivElement, root: Root, controller: AgentSessionController
const empty = (sessionId: string, text: string) => {
  const turnId = id(), now = new Date().toISOString()
  return { sessionId, lastSeq: 1, messages: [{ messageId: id(), turnId, role: 'assistant', text, state: 'settled', createdAt: now }],
    turns: [{ turnId, sessionId, requestId: id(), trigger: 'user', originNotificationId: null, state: 'completed', reason: '', ownerInstanceId: 'test',
      createdAt: now, updatedAt: now, completedAt: now }], inputs: [], questions: [], tools: [], workspaces: [] }
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
function View({ sessionId }: { sessionId: string }) { controller = useAgentSession(client, sessionId, true); return <div>{controller.conversation?.messages.map(item => item.text)}</div> }
function ConversationWithQuestion({ sessionId }: { sessionId: string }) {
  controller = useAgentSession(client, sessionId, true)
  const question = controller.conversation?.questions.find(item => item.state === 'pending')
  return <><SessionConversation controller={controller} />
    {question && <SessionQuestionBox key={question.questionId + ':' + question.version} question={question} controller={controller} readOnly={false} />}</>
}
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); localStorage.clear(); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals() })
it('opens the next session while the previous read is in flight and ignores its late answer', async () => {
  const first = id(), second = id(); let finish!: (value: Response) => void
  vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes(first) ? new Promise<Response>(resolve => { finish = resolve }) : new Response(JSON.stringify(empty(second, '第二段对话')))))
  await act(async () => { root.render(<View sessionId={first} />); await settle() })
  await act(async () => { root.render(<View sessionId={second} />); await settle() })
  expect(host.textContent).toContain('第二段对话')
  await act(async () => { finish(new Response(JSON.stringify(empty(first, '旧回答')))); await settle() })
  expect(host.textContent).not.toContain('旧回答')
})

it('pending input edits survive a lost acknowledgement; remove and question responses use the versioned session controls', async () => {
  const sessionId = id(), projection = empty(sessionId, '准备回答') as AgentConversation, turn = projection.turns[0]!, inputId = id(), requestId = id(), questionId = id()
  const now = new Date().toISOString()
  const input = { inputId, turnId: turn.turnId, version: 1, state: 'pending' as 'pending' | 'removed', text: '原问题', createdAt: turn.createdAt }
  Object.assign(turn, { state: 'active', completedAt: null })
  Object.assign(projection, { inputs: [input], messages: [{ messageId: 'input:' + inputId, inputId, turnId: turn.turnId, role: 'user', text: input.text, state: 'settled', createdAt: turn.createdAt }],
    questions: [{ questionId, sessionId, turnId: turn.turnId, stepId: id(), toolCallId: id(), version: 1, state: 'pending' as const,
      presentation: { question: '继续练习吗？', source: '当前任务', options: [{ id: 'yes', label: '继续练习' }], allowText: true, skippable: false },
      answer: null, answerRequestId: null, deadline: null, createdAt: now, updatedAt: now }] })
  const calls: { route: string; body: any }[] = [], receipts = new Map<string, any>(); let loseReply = true
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const body = options.body ? JSON.parse(String(options.body)) : undefined
    const route = url.split('/agent-sessions/')[1]!
    expect(new Headers(options.headers).get('x-xj-agent-contract')).toBe('3')
    let result: any
    if (!body) result = projection
    else {
      calls.push({ route, body })
      result = receipts.get(body.requestId)
      if (!result && route.endsWith('/control')) {
        expect(body.expectedVersion).toBe(input.version)
        input.version++
        if (body.operation === 'edit') input.text = body.text
        if (body.operation === 'remove') input.state = 'removed'
        Object.assign(projection.inputs[0]!, { version: input.version, state: input.state, text: input.text })
        result = { requestId: body.requestId, input: { inputId, turnId: turn.turnId, version: input.version, state: input.state,
          input: { requestId, sessionId, text: input.text, context: {} }, createdAt: input.createdAt } }
        receipts.set(body.requestId, result)
        if (loseReply) { loseReply = false; throw new Error('lost ACK') }
      } else if (!result && route.endsWith('/responses')) {
        expect(body).toMatchObject({ questionId, expectedVersion: 1, answer: { kind: 'choice', optionId: 'yes' } })
        Object.assign(projection.questions[0]!, { state: 'answered' })
        result = { requestId: body.requestId, questionId, questionVersion: 2, turnId: turn.turnId, status: 'accepted', reason: '' }
        receipts.set(body.requestId, result)
      } else if (!result) {
        Object.assign(turn, route.endsWith('/stop') ? { state: 'stopped', reason: 'student-stop', completedAt: now }
          : { state: 'active', reason: '', completedAt: null })
        result = turn; receipts.set(body.requestId, structuredClone(result))
      }
    }
    return new Response(JSON.stringify(result))
  }))
  function Controls() { return <ConversationWithQuestion sessionId={sessionId} /> }
  await act(async () => { root.render(<Controls />); await settle() })
  await act(async () => { await controller.inputControl(inputId, 1, 'edit', { text: '修改后的原问题' }).catch(() => {}); await settle() })
  await act(async () => root.unmount()); root = createRoot(host)
  await act(async () => { root.render(<Controls />); await settle() })
  expect(host.textContent).toContain('修改后的原问题')
  const edits = calls.filter(call => call.body.operation === 'edit')
  expect(edits).toHaveLength(2); expect(edits[0]).toEqual(edits[1])
  const clickText = async (text: string) => {
    for (let i = 0; i < 40; i++) {
      const button = [...host.querySelectorAll('button')].find(button => button.textContent === text)
      if (button && !button.disabled) { await act(async () => { button.click(); await settle() }); return }
      await act(async () => { await settle() })
    }
    throw new Error('Ready control not found: ' + text)
  }
  await act(async () => { await controller.inputControl(inputId, input.version, 'remove'); await settle() }); expect(host.textContent).not.toContain('修改后的原问题')
  Object.assign(turn, { state: 'stopped', reason: 'student-stop', completedAt: now })
  await act(async () => { await controller.refresh(); await settle() })
  expect(host.textContent).not.toContain('你已停止这次回答')
  await act(async () => { await controller.control(turn.turnId, 'continue'); await settle() }); expect(turn.state).toBe('active')
  for (let attempt = 0; attempt < 40 && host.querySelector('.agent-question-option input')?.matches(':disabled'); attempt++) await act(async () => { await settle() })
  await act(async () => { host.querySelector<HTMLInputElement>('.agent-question-option input')!.click(); await settle() })
  await clickText('提交回应'); expect(host.textContent).not.toContain('继续练习吗？')
  await act(async () => { await controller.control(turn.turnId, 'stop'); await settle() }); expect(turn.state).toBe('stopped')
  expect(host.textContent).not.toContain('停止回答')
  expect(calls.filter(call => call.route.includes('/inputs/')).every(call => call.route === `${sessionId}/inputs/${inputId}/control`)).toBe(true)
  expect(calls.filter(call => call.route.includes('/waits/')).map(call => call.route))
    .toEqual([`${sessionId}/waits/${questionId}/responses`])
})
it('shows deferred input state and a failed Turn reason from persisted conversation state', async () => {
  const sessionId = id(), projection = empty(sessionId, '暂时没有回答') as AgentConversation, turn = projection.turns[0]!, now = new Date().toISOString()
  const inputId = id()
  projection.inputs = [{ inputId, turnId: turn.turnId, version: 1, state: 'deferred' as any, text: '请在继续时处理', createdAt: now }]
  projection.messages = [{ messageId: 'input:' + inputId, inputId, turnId: turn.turnId, role: 'user', text: '请在继续时处理', state: 'settled', createdAt: now }]
  Object.assign(turn, { state: 'failed', reason: 'budget_exhausted', completedAt: now })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(projection))))
  function View() { const current = useAgentSession(client, sessionId, true); controller = current; return <SessionConversation controller={current} /> }
  await act(async () => { root.render(<View />); await settle() })
  expect(controller.conversation!.inputs[0]!.state).toBe('deferred')
  expect(host.textContent).toContain('本次回答已达到预算上限')
  expect(host.textContent).not.toContain('回答尚未完成')
  await act(async () => root.unmount()); root = createRoot(host)
  await act(async () => { root.render(<View />); await settle() })
  expect(controller.conversation!.inputs[0]!.state).toBe('deferred')
})

it('retrying an unconfirmed follow-up queries the original request instead of creating a second question', async () => {
  const sessionId = id(), original = new Map<string, any>(), writes: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const body = options.body ? JSON.parse(String(options.body)) : undefined
    if (body) { writes.push(body); original.set(body.requestId, { input: body, receipt: { sessionId, requestId: body.requestId, inputId: id(), turnId: id(), inputDigest: 'a'.repeat(64) } }); throw new Error('lost ACK') }
    return new Response(JSON.stringify(url.includes('/requests/') ? original.get(url.split('/').at(-1)!) ?? null : empty(sessionId, '已有回答')))
  }))
  await act(async () => { root.render(<View sessionId={sessionId} />); await settle() })
  await act(async () => { await controller.send('继续解释').catch(() => {}); await settle() })
  await act(async () => { await controller.send('继续解释').catch(() => {}); await settle() })
  expect(writes).toHaveLength(1)
  expect(controller.outbox.pending(sessionId)).toHaveLength(0)
})

it.each([
  ['choice', { kind: 'choice', optionId: 'yes' }],
  ['text', { kind: 'text', text: '先比较这两次结果。' }],
  ['skip', { kind: 'skip' }],
] as const)('renders a host-routed question and submits its %s answer with the original question version', async (kind, answer) => {
  const sessionId = id(), projection = empty(sessionId, '请先回应这个问题。') as AgentConversation
  const turn = projection.turns[0]!, questionId = id(), now = new Date().toISOString()
  Object.assign(turn, { state: 'active', completedAt: null })
  projection.questions = [{ questionId, sessionId, turnId: turn.turnId, stepId: id(), toolCallId: id(), version: 7, state: 'pending',
    presentation: { questionId, question: '接下来想怎样比较？', source: '原实验结果', options: [{ id: 'yes', label: '比较结果' }], allowText: true, skippable: true },
    answer: null, answerRequestId: null, deadline: null, createdAt: now, updatedAt: now }]
  const pending = projection.questions[0]!
  projection.tools = [{ toolCallId: pending.toolCallId, turnId: turn.turnId, stepId: pending.stepId,
    name: 'student_ask', state: 'pending', result: {}, stepNo: 1, createdAt: now }]
  const writes: { route: string; body: unknown }[] = []
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (!options.body) return new Response(JSON.stringify(projection))
    writes.push({ route: url, body: JSON.parse(String(options.body)) })
    projection.questions[0]!.state = 'answered'
    return new Response(JSON.stringify({ requestId: JSON.parse(String(options.body)).requestId, questionId, questionVersion: 8, turnId: turn.turnId, status: 'accepted', reason: '' }))
  }))
  function Questions() { return <ConversationWithQuestion sessionId={sessionId} /> }
  await act(async () => { root.render(<Questions />); await settle() })
  const question = host.querySelector('[aria-label="Agent 的问题"]')
  for (let i = 0; i < 40 && question?.querySelector<HTMLButtonElement>('button')?.disabled; i++) await act(async () => { await settle() })
  expect(question?.textContent).toContain('接下来想怎样比较？')
  expect(host.querySelector('.agent-question-record')).toBeNull()
  expect(host.querySelector('[data-tool-name="student_ask"]')).toBeNull()
  expect(host.textContent?.match(/接下来想怎样比较？/g)).toHaveLength(1)
  expect(question?.querySelector('textarea')).not.toBeNull()
  expect([...question!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['提交回应', '跳过这次提问'])
  if (kind === 'text') {
    await act(async () => {
      const textarea = question!.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, answer.text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { question!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle() })
  } else await act(async () => {
    if (kind === 'choice') question!.querySelector<HTMLInputElement>('.agent-question-option input')!.click()
    else [...question!.querySelectorAll('button')].find(button => button.textContent === '跳过这次提问')!.click()
    await settle()
  })
  if (kind === 'choice') await act(async () => { question!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle() })
  expect(writes).toHaveLength(1)
  expect(writes[0]!.route).toBe(`/api/learning/agent-sessions/${sessionId}/waits/${questionId}/responses`)
  expect(writes[0]!.body).toEqual({ requestId: expect.any(String), questionId, expectedVersion: 7, answer })
  expect(host.querySelector('[aria-label="Agent 的问题"]')).toBeNull()
})

it('keeps an answered question and the student choice in its execution record', async () => {
  const sessionId = id(), projection = empty(sessionId, '已根据你的回答继续。') as AgentConversation
  const turn = projection.turns[0]!, questionId = id(), toolCallId = id(), stepId = id(), now = new Date().toISOString()
  projection.questions = [{ questionId, sessionId, turnId: turn.turnId, stepId, toolCallId, version: 8, state: 'answered',
    presentation: { question: '递归最关键的两个条件是什么？', source: '递归练习',
      options: [{ id: 'both', label: '基准情形与规模缩小' }, { id: 'none', label: '以上都不对' }], allowText: true, skippable: true },
    answer: { kind: 'choice', optionId: 'both' }, answerRequestId: id(), deadline: null, createdAt: now, updatedAt: now }]
  projection.tools = [{ toolCallId, turnId: turn.turnId, stepId, name: 'student_ask', state: 'closed', result: {}, stepNo: 1, createdAt: now }]
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(projection))))
  await act(async () => { root.render(<ConversationWithQuestion sessionId={sessionId} />); await settle() })
  expect(host.querySelector('[aria-label="Agent 的问题"]')).toBeNull()
  const group = host.querySelector<HTMLButtonElement>('.agent-trace-group-trigger')!
  await act(async () => { group.click(); await settle() })
  const record = host.querySelector('.agent-question-record')!
  expect(record.textContent).toContain('递归最关键的两个条件是什么？')
  expect(record.textContent).toContain('你的选择')
  expect(record.textContent).toContain('基准情形与规模缩小')
})

it('a definitive stale-version rejection refreshes the session and never blocks or replays over stop, continue and responses', async () => {
  const sessionId = id(), projection = empty(sessionId, '旧内容') as AgentConversation, turn = projection.turns[0]!, inputId = id(), questionId = id()
  Object.assign(turn, { state: 'active', completedAt: null })
  projection.inputs = [{ inputId, turnId: turn.turnId, version: 1, state: 'pending', text: '待处理原文', createdAt: turn.createdAt }]
  projection.questions = [{ questionId, sessionId, turnId: turn.turnId, stepId: id(), toolCallId: id(), version: 2, state: 'pending',
    presentation: {}, answer: null, answerRequestId: null, deadline: null, createdAt: turn.createdAt, updatedAt: turn.createdAt }]
  const writes: { route: string; body: any }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (!options.body) return new Response(JSON.stringify(projection))
    const body = JSON.parse(String(options.body)); writes.push({ route: url, body })
    if (url.includes('/inputs/')) {
      projection.lastSeq++; projection.inputs[0]!.version = 2; projection.messages[0]!.text = '其他页面已更新'
      return new Response(JSON.stringify({ error: 'conflict' }), { status: 409 })
    }
    if (url.endsWith('/responses')) {
      expect(body.expectedVersion).toBe(2)
      return new Response(JSON.stringify({ requestId: body.requestId, questionId, questionVersion: 3, turnId: turn.turnId, status: 'accepted', reason: '' }))
    }
    Object.assign(turn, url.endsWith('/stop') ? { state: 'stopped', reason: 'student-stop', completedAt: turn.createdAt }
      : { state: 'active', reason: '', completedAt: null })
    return new Response(JSON.stringify(turn))
  }))
  await act(async () => { root.render(<View sessionId={sessionId} />); await settle() })
  await act(async () => { await expect(controller.inputControl(inputId, 1, 'edit', { text: '过时修订' })).rejects.toMatchObject({ code: 'conflict' }); await settle() })
  expect(controller.conversation?.inputs[0]?.version).toBe(2)
  expect(host.textContent).toContain('其他页面已更新')
  for (const operation of ['stop', 'continue'] as const) await act(async () => { await controller.control(turn.turnId, operation); await settle() })
  await act(async () => { await controller.respond(questionId, 2, { kind: 'skip' }); await settle() })
  await act(async () => root.unmount()); root = createRoot(host)
  await act(async () => { root.render(<View sessionId={sessionId} />); await settle() })
  expect(writes.map(call => call.route.split('/').slice(-1)[0])).toEqual(['control', 'stop', 'continue', 'responses'])
  expect(new Set(writes.map(call => call.body.requestId)).size).toBe(4)
})
it('an ambiguous HTTP failure preserves the original mutation and prevents another operation from replacing it', async () => {
  const sessionId = id(), projection = empty(sessionId, '保留原回应') as AgentConversation, turn = projection.turns[0]!, questionId = id()
  const writes: { route: string; body: any }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (!options.body) return new Response(JSON.stringify(projection))
    writes.push({ route: url, body: JSON.parse(String(options.body)) })
    return new Response(JSON.stringify({ error: 'conflict' }), { status: 503 })
  }))
  await act(async () => { root.render(<View sessionId={sessionId} />); await settle() })
  await act(async () => { await controller.respond(questionId, 1, { kind: 'text', text: '原回应' }).catch(() => {}); await settle() })
  await act(async () => { await expect(controller.control(turn.turnId, 'stop')).rejects.toThrow('上次操作仍待核对'); await settle() })
  await act(async () => root.unmount()); root = createRoot(host)
  await act(async () => { root.render(<View sessionId={sessionId} />); await settle() })
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
})
