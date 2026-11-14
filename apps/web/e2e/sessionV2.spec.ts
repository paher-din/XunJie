import { test, expect } from '@playwright/test'
import { randomUUID as id } from 'node:crypto'
import { REAL_URL } from './env'
import type { AgentSession } from '@xunjie/contracts/agent-sessions'
import type { AgentConversation } from '@xunjie/contracts/agent-service'

// Exercise the production entry and components; substitute only the HTTP boundary.
test('formal sessions recover original inputs and open an independent real workspace conversation', async ({ page }) => {
  const now = new Date().toISOString(), actor = { kind: 'personal' as const, name: 'Robert', environmentId: id(), spaceId: id(), principalId: id() }
  const owner: AgentSession['owner'] = { version: 1, connectionId: id(), installationId: id(), target: { environmentId: actor.environmentId, serviceId: id(), unit: 'teaching-agent', endpoint: 'https://agent.example.test', protocolVersion: 1, capabilities: ['agent.sessions.v2'] } }
  const activity = { activityId: id(), identity: actor, target: { environmentId: actor.environmentId, serviceId: id(), version: 1 }, question: '递归练习', goal: '掌握函数调用与递归终止条件', references: [], status: 'open', createdAt: now }
  const sessions = new Map<string, AgentSession>(), conversations = new Map<string, AgentConversation>(), requests = new Map<string, unknown>()
  const writes: { path: string; body: any }[] = [], errors: string[] = []
  let created = false, loseReply = true
  page.on('pageerror', error => errors.push(error.message))
  const create = (sessionId: string, requestId: string, title: string | null, workspace?: AgentSession['workspace']) => {
    const value: AgentSession = { sessionId, requestId, identity: actor, owner, scenario: workspace ? 'workspace-assistant' : 'student-assistant', ...(workspace ? { workspace } : {}), title,
      pinned: false, archived: false, deleted: false, state: 'ready', createdAt: now, updatedAt: now, readyAt: now }
    sessions.set(sessionId, value); conversations.set(sessionId, { sessionId, lastSeq: 0, messages: [], runs: [], inputs: [], waits: [], tools: [], workspaces: [] }); return value
  }
  await page.route('**/api/learning/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname.replace('/api/learning/', ''), body = request.postDataJSON()
    const respond = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) })
    if (request.method() === 'POST') writes.push({ path, body })
    if (path === 'context') return respond({ profile: 'local', clientNamespace: 'chrome-session-v2', account: null, identities: [{ key: 'personal', identity: actor }] })
    if (path === 'models/selection') return respond({ version: 0, selected: null, options: [] })
    if (path === 'activities') return respond(created ? [activity] : [])
    if (path === 'activities/' + activity.activityId) return respond(activity)
    if (path === `activities/${activity.activityId}/project`) return respond({ projectId: id(), activityId: activity.activityId, workspaceSessionId: [...sessions.values()].find(value => value.workspace)?.sessionId ?? id(), operationId: id(), sourceSessionId: [...sessions.keys()][0], inputId: id(), identity: actor, target: activity.target, createdAt: now, content: { title: '递归练习', goal: '理解递归和基例', stages: [{ title: '找出基例', goal: '写出最小输入时的结果' }, { title: '实现递归', goal: '用更小输入验证递归步骤' }], materialRefs: [] } })
    if (path === 'agent-settings') return respond({ version: 0, busyInputMode: 'steering' })
    if (path === 'skills') return respond({ skills: [], selections: [] })
    if (path.endsWith('/skills')) return respond({ catalog: [], loaded: [], selectionDigest: 'a'.repeat(64) })
    if (path.startsWith('workspaces/')) return respond({ revision: 0, files: [] })
    if (path.startsWith('drafts/')) return respond(body ? { draftId: body.draftId, revision: body.baseRevision + 1, revisionId: id(), question: body.question, references: body.references }
      : path.includes('/receipts/') ? null : { draftId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', revision: 0, revisionId: null, question: '', references: [] })
    if (/^(pdf|materials|artifacts)\//.test(path)) return respond([])
    if (path.startsWith('executions/')) return respond(path.endsWith('/history') ? { entries: [], nextCursor: null } : [])
    if (!path.startsWith('agent-sessions')) return respond({ error: 'missing' }, 404)
    expect(request.headers()['x-xj-agent-contract']).toBe('2')
    expect(request.headers()['x-xj-expected-subject']).toBe([actor.environmentId, actor.spaceId, actor.principalId].join('.'))
    if (path === 'agent-sessions') return respond(body ? create(body.sessionId, body.requestId, body.title) : { items: [...sessions.values()] })
    if (path === 'agent-sessions/update') { const { requestId: _request, ...patch } = body, value = { ...sessions.get(body.sessionId)!, ...patch }; sessions.set(value.sessionId, value); return respond(value) }
    if (path === 'agent-sessions/workspace') return respond([...sessions.values()].find(value => value.workspace?.activityId === body.activityId) ?? create(id(), id(), '递归练习', body))
    const [, sessionId, suffix, requestId] = path.split('/')
    if (!suffix) return respond(sessions.get(sessionId!) ?? { error: 'missing' }, sessions.has(sessionId!) ? 200 : 404)
    if (suffix === 'pdf' || suffix === 'materials') return respond([])
    if (suffix === 'conversation') return respond(conversations.get(sessionId!))
    if (suffix === 'requests') return respond(requests.get(requestId!) ?? null)
    if (suffix === 'inputs') {
      const runId = id(), inputId = id(), conversation = conversations.get(sessionId!)!
      conversation.runs.push({ runId, inputId, sessionId: sessionId!, requestId: body.requestId, state: 'completed', reason: '', generation: 1, stopRequested: false, needsContinue: false, previousRunId: null, createdAt: now, updatedAt: now, completedAt: now }); conversation.lastSeq++
      conversation.messages.push({ messageId: 'input:' + inputId, runId, inputId, role: 'user', text: body.text, state: 'settled', createdAt: now }, { messageId: 'assistant:' + runId, runId, role: 'assistant', text: body.context.action ? '已结合你的作品继续讨论。' : '递归通过更小的同类问题求解。', state: 'settled', createdAt: now })
      conversation.inputs.push({ inputId, runId, version: 1, mode: body.mode, state: 'adopted', text: body.text, createdAt: now })
      if (!body.context.action) { created = true; conversation.workspaces.push({ operationId: id(), runId, workspace: { ...activity, title: '递归练习' } }) }
      const receipt = { sessionId: sessionId!, inputId, runId, requestId: body.requestId, inputDigest: 'a'.repeat(64) }
      requests.set(body.requestId, { input: body, receipt })
      if (loseReply) { loseReply = false; return route.abort('failed') }
      return respond(receipt)
    }
    return respond({ error: 'missing' }, 404)
  })
  await page.goto(REAL_URL + '/?view=agent&space=personal')
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('请创建递归练习项目')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('button', { name: '核对并继续原请求' })).toBeVisible()
  await expect(page.locator('.product-agent-notices [role="alert"]')).toBeVisible()
  await page.reload(); await expect(page.locator('[data-message-id]')).toHaveCount(2)
  expect(writes.filter(write => /\/inputs$/.test(write.path))).toHaveLength(1)
  await expect(page.locator('.msg-task-card')).toHaveCount(1)
  await page.getByRole('button', { name: '置顶', exact: true }).first().click()
  await expect(page.getByRole('button', { name: '取消置顶', exact: true }).first()).toBeVisible()
  await page.getByRole('button', { name: '更多操作', exact: true }).first().click(); await page.getByRole('menuitem', { name: '重命名' }).click()
  await page.getByLabel('重命名对话').fill('递归讨论'); await page.getByLabel('重命名对话').press('Enter')
  await expect(page.locator('.product-conversation-head h1')).toHaveText('递归讨论')
  if (process.env.XUNJIE_E2E_SCREENSHOT) await page.screenshot({ path: process.env.XUNJIE_E2E_SCREENSHOT, fullPage: true })
  await page.getByRole('button', { name: '首页', exact: true }).first().click()
  await expect(page.locator(`[data-activity-id="${activity.activityId}"]`).first()).toContainText('递归练习')
  await page.getByRole('button', { name: 'Agent 对话', exact: true }).first().click()
  await page.getByRole('button', { name: '递归讨论', exact: true }).first().click()
  await page.locator('.msg-task-card').getByRole('button').click(); await expect(page.locator('#activity-title')).toHaveText('递归练习')
  await expect(page.getByRole('region', { name: '项目任务清单' })).toContainText('写出最小输入时的结果')
  if (process.env.XUNJIE_E2E_SCREENSHOT) await page.screenshot({ path: process.env.XUNJIE_E2E_SCREENSHOT + '.workspace.png', fullPage: true })
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  const composer = page.getByRole('complementary', { name: '问题与引用' })
  await composer.locator('textarea').fill('结合当前作品解释递归'); await composer.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(page.getByText('已结合你的作品继续讨论。', { exact: true })).toBeVisible()
  expect(writes.find(write => write.body?.context?.action)?.body.context.action).toMatchObject({ scope: { activityId: activity.activityId }, receiver: { receiverId: 'teaching-agent:' + owner.target.serviceId, kind: 'question', location: 'local' }, draft: { question: '结合当前作品解释递归' }, works: [] })
  expect(new Set(writes.filter(write => /\/inputs$/.test(write.path)).map(write => write.body.sessionId)).size).toBe(2)
  expect(writes.some(write => write.path === 'activities' || write.path.startsWith('intents/'))).toBe(false)
  expect(errors).toEqual([])
})
