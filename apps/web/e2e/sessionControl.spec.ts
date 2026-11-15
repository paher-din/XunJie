import { test, expect } from '@playwright/test'
import { randomUUID as id } from 'node:crypto'
import { REAL_URL } from './env'
import type { AgentSession } from '@xunjie/contracts/agent-sessions'
import type { AgentConversation } from '@xunjie/contracts/agent-service'

// PLAN §14 browser matrix through the production entry: Stop, manual continue,
// an in-batch student question answered in place, and a background task
// notification that opens a new Turn. Only the HTTP boundary is substituted;
// the real React state machine, drafts and polling run unchanged.
type Script = 'stop-continue' | 'question' | 'notification'

async function mount(page: import('@playwright/test').Page, script: Script) {
  const now = new Date().toISOString(), actor = { kind: 'personal' as const, name: 'Robert', environmentId: id(), spaceId: id(), principalId: id() }
  const owner: AgentSession['owner'] = { version: 1, connectionId: id(), installationId: id(), target: { environmentId: actor.environmentId, serviceId: id(), unit: 'teaching-agent', endpoint: 'https://agent.example.test', protocolVersion: 1, capabilities: ['agent.sessions.v2'] } }
  const sessionId = id(), turnId = id(), questionId = id(), inputId = id()
  const sessions = new Map<string, AgentSession>(), requests = new Map<string, unknown>()
  const writes: { path: string; body: any }[] = [], errors: string[] = []
  const conversation: AgentConversation = { sessionId, lastSeq: 0, messages: [], turns: [], inputs: [], questions: [], tools: [], workspaces: [] }
  const turn: AgentConversation['turns'][number] = { turnId, sessionId, requestId: id(), trigger: 'user', originNotificationId: null, state: 'active', reason: '', ownerInstanceId: 'test', createdAt: now, updatedAt: now, completedAt: null }
  conversation.turns.push(turn)
  conversation.inputs.push({ inputId, turnId, version: 1, state: 'adopted', text: '解释独立运行的 Agent', createdAt: now })
  conversation.messages.push({ messageId: 'input:' + inputId, turnId, inputId, role: 'user', text: '解释独立运行的 Agent', state: 'settled', createdAt: now })
  let question: import('@xunjie/contracts/agent-runtime').AgentQuestion | null = script === 'question' ? { questionId, sessionId, turnId, stepId: id(), toolCallId: id(), version: 1, state: 'pending',
    presentation: { question: '是否创建这个项目？', source: 'browser-matrix', options: [{ id: 'yes', label: '创建' }, { id: 'no', label: '不创建' }], allowText: true, skippable: true },
    answer: null, answerRequestId: null, deadline: null, createdAt: now, updatedAt: now } : null
  if (question) conversation.questions.push(question)
  const assistant = (turnIdOf: string, text: string) => conversation.messages.push({ messageId: 'assistant:' + turnIdOf, turnId: turnIdOf, role: 'assistant', text, state: 'settled', createdAt: new Date().toISOString() })
  const close = (patch: Partial<typeof turn>) => { Object.assign(turn, patch, { updatedAt: new Date().toISOString() }); conversation.lastSeq++ }
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/api/learning/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/learning/', ''), body = request.postDataJSON()
    const respond = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
    if (request.method() === 'POST') writes.push({ path, body })
    if (path === 'context') return respond({ profile: 'local', clientNamespace: 'chrome-session-control', account: null, identities: [{ key: 'personal', identity: actor }] })
    if (path === 'models/selection') return respond({ version: 0, selected: null, options: [] })
    if (path === 'agent-settings') return respond({ version: 0, busyInputMode: 'steering' })
    if (path === 'skills') return respond({ skills: [], selections: [] })
    if (path.startsWith('workspaces/') || path.startsWith('drafts/') || path.startsWith('executions/')) return respond({ revision: 0, files: [] })
    if (/^(pdf|materials|artifacts)\//.test(path) || path === 'activities') return respond([])
    if (!path.startsWith('agent-sessions')) return respond({ error: 'missing' }, 404)
    expect(request.headers()['x-xj-agent-contract']).toBe('3')
    if (path === 'agent-sessions') return respond(body ? { ...sessions.get(sessionId)!, sessionId: body.sessionId } : { items: [...sessions.values()] })
    if (path === 'agent-sessions/update') return respond(sessions.get(sessionId)!)
    if (path === 'agent-sessions/workspace') return respond(sessions.get(sessionId)!)
    const [, targetSession, suffix, targetId, action] = path.split('/')
    if (targetSession !== sessionId) return respond({ error: 'missing' }, 404)
    if (!suffix) return respond(sessions.get(sessionId)!)
    if (suffix === 'conversation') return respond(conversation)
    if (suffix === 'requests') return respond(requests.get(targetId!) ?? null)
    if (suffix === 'events') return respond([])
    if (suffix === 'waits' && action === 'responses') {
      // Real answer recorded: the pending question closes and the batch runs to completion.
      const receipt = { requestId: body.requestId, questionId, questionVersion: question!.version + 1, turnId, status: 'accepted', reason: '' }
      question = { ...question!, state: 'closed', answer: body.answer, answerRequestId: body.requestId, version: question!.version + 1, updatedAt: new Date().toISOString() }
      conversation.questions = [question]
      close({ state: 'completed', completedAt: new Date().toISOString() })
      assistant(turnId, '已按你的选择创建项目。')
      return respond(receipt)
    }
    if (suffix === 'runs' && (action === 'stop' || action === 'continue')) {
      if (action === 'stop') {
        close({ state: 'stopped', reason: 'user', completedAt: new Date().toISOString() })
        if (question) { question = { ...question!, state: 'closed' }; conversation.questions = [question] }
        return respond(turn)
      }
      const newTurn: AgentConversation['turns'][number] = { turnId: id(), sessionId, requestId: body.requestId, trigger: 'continue', originNotificationId: null, state: 'active', reason: '', ownerInstanceId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null }
      conversation.turns.push(newTurn)
      assistant(newTurn.turnId, '递归通过更小的同类问题求解。')
      setTimeout(() => { Object.assign(newTurn, { state: 'completed', completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }); conversation.lastSeq++ }, 300)
      conversation.lastSeq++
      return respond(newTurn)
    }
    if (suffix === 'inputs') {
      const receipt = { sessionId, inputId: id(), turnId: id(), requestId: body.requestId, inputDigest: 'a'.repeat(64) }
      requests.set(body.requestId, { input: body, receipt })
      return respond(receipt)
    }
    return respond({ error: 'missing' }, 404)
  })
  sessions.set(sessionId, { sessionId, requestId: id(), identity: actor, owner, scenario: 'student-assistant', title: '递归练习',
    pinned: false, archived: false, deleted: false, state: 'ready', createdAt: now, updatedAt: now, readyAt: now })
  await page.goto(REAL_URL + `/?view=agent&space=personal&session=${sessionId}`)
  const notification = script === 'notification' ? { fire: () => {
    // The agent host opens a new Turn from a background task notification while idle.
    const notified: AgentConversation['turns'][number] = { turnId: id(), sessionId, requestId: id(), trigger: 'task-notification', originNotificationId: id(), state: 'completed', reason: '', ownerInstanceId: 'test', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: new Date().toISOString() }
    conversation.turns.push(notified)
    assistant(notified.turnId, '后台任务完成了，我继续解释。')
    conversation.lastSeq++
  } } : null
  return { sessionId, turnId, questionId, writes, errors, conversation, notification }
}

test('正式入口：Stop 停止当前 Turn 后手动继续开启新 Turn', async ({ page }) => {
  const f = await mount(page, 'stop-continue')
  await expect(page.locator('.teaching-run-status [role="status"]')).toContainText('Agent 正在回答…')
  await page.getByRole('button', { name: '停止回答', exact: true }).click()
  await expect(page.locator('.teaching-run-status [role="status"]')).toContainText('回答尚未完成，原问题和内容已保留。')
  const stop = f.writes.find(write => /\/runs\/.+\/stop$/.test(write.path))!
  expect(stop.body).toMatchObject({ requestId: expect.any(String) })
  expect(f.writes.filter(write => /\/runs\/.+\/stop$/.test(write.path))).toHaveLength(1)
  await page.getByRole('button', { name: '继续回答', exact: true }).click()
  await expect(page.locator('[data-message-id]')).toHaveCount(2)
  await expect(page.locator('.teaching-run-status')).toHaveCount(0)
  expect(f.writes.filter(write => /\/runs\/.+\/continue$/.test(write.path))).toHaveLength(1)
  expect(f.errors).toEqual([])
})

test('正式入口：同批提问挂起期间等待，真实答案保存后批次继续', async ({ page }) => {
  const f = await mount(page, 'question')
  await expect(page.locator('.student-question')).toBeVisible()
  await expect(page.locator('.teaching-run-status [role="status"]')).toContainText('等待回应或原操作结果。')
  await page.getByRole('button', { name: '创建', exact: true }).click()
  await expect(page.locator('.student-question')).toHaveCount(0)
  await expect(page.getByText('已按你的选择创建项目。')).toBeVisible()
  await expect(page.locator('.teaching-run-status')).toHaveCount(0)
  const response = f.writes.find(write => /\/waits\/.+\/responses$/.test(write.path))!
  expect(response.body).toMatchObject({ questionId: f.questionId, expectedVersion: 1, answer: { kind: 'choice', optionId: 'yes' } })
  expect(f.errors).toEqual([])
})

test('正式入口：后台通知自动开启新 Turn 并解释', async ({ page }) => {
  const f = await mount(page, 'notification')
  await expect(page.locator('.session-conversation')).toBeVisible()
  await expect(page.locator('.teaching-run-status [role="status"]')).toContainText('Agent 正在回答…')
  f.notification!.fire()
  await expect(page.getByText('后台任务完成了，我继续解释。')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-turn-id]')).toHaveCount(2, { timeout: 15000 })
  // A notification Turn is read-side only: no durable write is issued for it.
  expect(f.writes.filter(write => /\/runs\/|\/inputs$|\/waits\//.test(write.path))).toHaveLength(0)
  expect(f.errors).toEqual([])
})
