// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import type { AgentConversation } from '@xunjie/contracts/agent-service'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { SessionConversation } from './SessionConversation'
import { AgentSessionsClient } from './agent-sessions'
import { useAgentSession, type AgentSessionController } from './useAgentSession'
const id = () => crypto.randomUUID()
const identity = { kind: 'personal' as const, environmentId: id(), spaceId: id(), principalId: id(), name: '个人' }
const client = new AgentSessionsClient({ identity, spaceKey: 'personal', namespace: 'test' })
let host: HTMLDivElement, root: Root, controller: AgentSessionController
const empty = (sessionId: string, text: string) => {
  const runId = id(), now = new Date().toISOString()
  return { sessionId, lastSeq: 1, messages: [{ messageId: id(), runId, role: 'assistant', text, state: 'settled', createdAt: now }],
    runs: [{ runId, sessionId, requestId: id(), inputId: id(), state: 'completed', reason: '', generation: 1, stopRequested: false, needsContinue: false, previousRunId: null, createdAt: now, updatedAt: now, completedAt: now }], inputs: [], waits: [], tools: [], workspaces: [] }
}
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setTimeout(resolve, 0)) }
function View({ sessionId }: { sessionId: string }) { controller = useAgentSession(client, sessionId, true); return <div>{controller.conversation?.messages.map(item => item.text)}</div> }
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

it('pending input edits survive a lost acknowledgement; move/remove and user responses use the versioned session controls', async () => {
  const sessionId = id(), projection = empty(sessionId, '准备回答') as AgentConversation, run = projection.runs[0]!, inputId = id(), requestId = id(), waitId = id()
  const fixedInput = { requestId, sessionId, text: '原问题', mode: 'queue', context: {} }
  const input = { inputId, runId: run.runId, version: 1, mode: 'queue', state: 'pending', input: fixedInput, createdAt: run.createdAt }
  Object.assign(run, { state: 'waiting', completedAt: null })
  Object.assign(projection, { inputs: [{ ...input, text: fixedInput.text, input: undefined }], messages: [{ messageId: 'input:' + inputId, inputId, runId: run.runId, role: 'user', text: fixedInput.text, state: 'settled', createdAt: run.createdAt }],
    waits: [{ waitId, runId: run.runId, operationId: id(), version: 1, kind: 'user', state: 'pending', presentation: { question: '继续练习吗？', source: '当前任务', options: [{ id: 'yes', label: '继续练习' }], allowText: true, skippable: false }, response: null, deadline: null }] })
  delete (projection.inputs[0] as any).input
  const calls: { route: string; body: any }[] = [], receipts = new Map<string, any>(); let loseReply = true
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const body = options.body ? JSON.parse(String(options.body)) : undefined
    const route = url.split('/agent-sessions/')[1]!
    expect(new Headers(options.headers).get('x-xj-agent-contract')).toBe('2')
    let result: any
    if (!body) result = projection
    else {
      calls.push({ route, body })
      result = receipts.get(body.requestId)
      if (!result && route.endsWith('/control')) {
        expect(body.expectedVersion).toBe(input.version)
        input.version++
        if (body.operation === 'edit') input.input.text = body.text
        if (body.operation === 'move') input.mode = input.input.mode = body.mode
        if (body.operation === 'remove') input.state = 'removed'
        Object.assign(projection.inputs[0]!, { version: input.version, mode: input.mode, state: input.state, text: input.input.text })
        result = { requestId: body.requestId, input: structuredClone(input) }; receipts.set(body.requestId, result)
        if (loseReply) { loseReply = false; throw new Error('lost ACK') }
      } else if (!result && route.endsWith('/responses')) {
        expect(body).toMatchObject({ expectedVersion: 1, answer: { kind: 'choice', optionId: 'yes' } })
        Object.assign((projection as any).waits[0], { state: 'consumed' })
        result = { waitId, runId: run.runId }; receipts.set(body.requestId, result)
      } else if (!result) {
        Object.assign(run, route.endsWith('/stop') ? { state: 'stopped', stopRequested: true, needsContinue: false } : { state: 'waiting', stopRequested: false, needsContinue: false })
        result = run; receipts.set(body.requestId, structuredClone(result))
      }
    }
    return new Response(JSON.stringify(result))
  }))
  function Controls() { controller = useAgentSession(client, sessionId, true); return <SessionConversation controller={controller} /> }
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
  await clickText('引导当前回答'); expect(input.mode).toBe('steering')
  await clickText('移除待处理消息'); expect(host.textContent).not.toContain('修改后的原问题')
  Object.assign(run, { state: 'paused', needsContinue: true })
  await act(async () => { await controller.refresh(); await settle() })
  expect(host.textContent).toContain('回答尚未完成')
  await clickText('继续回答'); expect(run.stopRequested).toBe(false)
  await clickText('继续练习'); expect(host.textContent).not.toContain('继续练习吗？')
  await clickText('停止回答'); expect(run.state).toBe('stopped'); expect(host.textContent).not.toContain('继续回答')
  expect(calls.filter(call => call.route.includes('/inputs/')).every(call => call.route === `${sessionId}/inputs/${inputId}/control`)).toBe(true)
})
it('retrying an unconfirmed follow-up queries the original request instead of creating a second question', async () => {
  const sessionId = id(), original = new Map<string, any>(), writes: any[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    const body = options.body ? JSON.parse(String(options.body)) : undefined
    if (body) { writes.push(body); original.set(body.requestId, { input: body, receipt: { sessionId, requestId: body.requestId, inputId: id(), runId: id(), inputDigest: 'a'.repeat(64) } }); throw new Error('lost ACK') }
    return new Response(JSON.stringify(url.includes('/requests/') ? original.get(url.split('/').at(-1)!) ?? null : empty(sessionId, '已有回答')))
  }))
  await act(async () => { root.render(<View sessionId={sessionId} />); await settle() })
  await act(async () => { await controller.send('继续解释', 'steering').catch(() => {}); await settle() })
  await act(async () => { await controller.send('继续解释', 'steering').catch(() => {}); await settle() })
  expect(writes).toHaveLength(1)
  expect(controller.outbox.pending(sessionId)).toHaveLength(0)
})

it.each([
  ['choice', { kind: 'choice', optionId: 'yes' }],
  ['text', { kind: 'text', text: '先比较这两次结果。' }],
  ['skip', { kind: 'skip' }],
] as const)('renders a host-routed question and submits its %s answer with the original wait version', async (kind, answer) => {
  const sessionId = id(), projection = empty(sessionId, '请先回应这个问题。') as AgentConversation
  const run = projection.runs[0]!, waitId = id(), commandId = id(), bindingId = 'a'.repeat(64)
  Object.assign(run, { state: 'waiting', completedAt: null })
  projection.waits = [{ waitId, runId: run.runId, operationId: commandId, version: 7, kind: 'user', state: 'pending',
    presentation: { questionId: id(), commandId, sourceInputId: run.inputId, moduleId: 'student-questions',
      toolDiscovery: { commandId, bindingId, moduleId: 'student-questions', moduleVersion: 1 },
      question: '接下来想怎样比较？', source: '原实验结果', options: [{ id: 'yes', label: '比较结果' }], allowText: true, skippable: true },
    response: null, deadline: null }]
  const writes: { route: string; body: unknown }[] = []
  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (!options.body) return new Response(JSON.stringify(projection))
    writes.push({ route: url, body: JSON.parse(String(options.body)) })
    projection.waits[0]!.state = 'consumed'
    return new Response(JSON.stringify({ waitId, runId: run.runId }))
  }))
  function Questions() { controller = useAgentSession(client, sessionId, true); return <SessionConversation controller={controller} /> }
  await act(async () => { root.render(<Questions />); await settle() })
  const question = host.querySelector('[aria-label="Agent 的问题"]')
  for (let i = 0; i < 40 && question?.querySelector<HTMLButtonElement>('button')?.disabled; i++) await act(async () => { await settle() })
  expect(question?.textContent).toContain('接下来想怎样比较？')
  expect(question?.querySelector('textarea')).not.toBeNull()
  expect([...question!.querySelectorAll('button')].map(button => button.textContent)).toEqual(['比较结果', '发送回应', '跳过'])
  if (kind === 'text') {
    await act(async () => {
      const textarea = question!.querySelector('textarea')!
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, answer.text)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => { question!.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle() })
  } else await act(async () => {
    const label = kind === 'choice' ? '比较结果' : '跳过'
    ;[...question!.querySelectorAll('button')].find(button => button.textContent === label)!.click()
    await settle()
  })
  expect(writes).toHaveLength(1)
  expect(writes[0]!.route).toBe(`/api/learning/agent-sessions/${sessionId}/waits/${waitId}/responses`)
  expect(writes[0]!.body).toEqual({ requestId: expect.any(String), expectedVersion: 7, answer })
  expect(host.querySelector('[aria-label="Agent 的问题"]')).toBeNull()
})

it('a definitive stale-version rejection refreshes the session and never blocks or replays over stop, continue and responses', async () => {
  const sessionId = id(), projection = empty(sessionId, '旧内容') as AgentConversation, run = projection.runs[0]!, inputId = id(), waitId = id()
  Object.assign(run, { state: 'waiting', completedAt: null })
  projection.inputs = [{ inputId, runId: run.runId, version: 1, mode: 'queue', state: 'pending', text: '待处理原文', createdAt: run.createdAt }]
  projection.waits = [{ waitId, runId: run.runId, operationId: id(), version: 2, kind: 'user', state: 'pending', presentation: {}, response: null, deadline: null }]
  const writes: { route: string; body: any }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (!options.body) return new Response(JSON.stringify(projection))
    const body = JSON.parse(String(options.body)); writes.push({ route: url, body })
    if (url.includes('/inputs/')) {
      projection.lastSeq++; projection.inputs[0]!.version = 2; projection.messages[0]!.text = '其他页面已更新'
      return new Response(JSON.stringify({ error: 'conflict' }), { status: 409 })
    }
    if (url.endsWith('/responses')) { expect(body.expectedVersion).toBe(2); return new Response(JSON.stringify({ waitId, runId: run.runId })) }
    Object.assign(run, url.endsWith('/stop') ? { state: 'stopped', stopRequested: true } : { state: 'waiting', stopRequested: false })
    return new Response(JSON.stringify(run))
  }))
  await act(async () => { root.render(<View sessionId={sessionId} />); await settle() })
  await act(async () => { await expect(controller.inputControl(inputId, 1, 'edit', { text: '过时修订' })).rejects.toMatchObject({ code: 'conflict' }); await settle() })
  expect(controller.conversation?.inputs[0]?.version).toBe(2)
  expect(host.textContent).toContain('其他页面已更新')
  for (const operation of ['stop', 'continue'] as const) await act(async () => { await controller.control(run.runId, operation); await settle() })
  await act(async () => { await controller.respond(waitId, 2, { kind: 'skip' }); await settle() })
  await act(async () => root.unmount()); root = createRoot(host)
  await act(async () => { root.render(<View sessionId={sessionId} />); await settle() })
  expect(writes.map(call => call.route.split('/').slice(-1)[0])).toEqual(['control', 'stop', 'continue', 'responses'])
  expect(new Set(writes.map(call => call.body.requestId)).size).toBe(4)
})
it('an ambiguous HTTP failure preserves the original mutation and prevents another operation from replacing it', async () => {
  const sessionId = id(), projection = empty(sessionId, '保留原回应') as AgentConversation, run = projection.runs[0]!, waitId = id()
  const writes: { route: string; body: any }[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit = {}) => {
    if (!options.body) return new Response(JSON.stringify(projection))
    writes.push({ route: url, body: JSON.parse(String(options.body)) })
    return new Response(JSON.stringify({ error: 'conflict' }), { status: 503 })
  }))
  await act(async () => { root.render(<View sessionId={sessionId} />); await settle() })
  await act(async () => { await controller.respond(waitId, 1, { kind: 'text', text: '原回应' }).catch(() => {}); await settle() })
  await act(async () => { await expect(controller.control(run.runId, 'stop')).rejects.toThrow('上次操作仍待核对'); await settle() })
  await act(async () => root.unmount()); root = createRoot(host)
  await act(async () => { root.render(<View sessionId={sessionId} />); await settle() })
  expect(writes).toHaveLength(2)
  expect(writes[1]).toEqual(writes[0])
})
