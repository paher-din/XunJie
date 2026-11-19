import { evidenceDirectory } from './evidence'
import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ServerResponse } from 'node:http'
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication } from '@xunjie/product-runtime'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
const evidence = evidenceDirectory('wp07-199', process.env.XUNJIE_STUDENT_ASK_EVIDENCE_DIR)
let runtime: ReturnType<typeof openProductRuntime>
let host: Awaited<ReturnType<typeof createProductRuntimeHost>>
let root = '', endpoint = ''
let upstream: ReturnType<typeof createServer>
let answer: (payload: Record<string, unknown>, response: ServerResponse) => void | Promise<void> = (_payload, response) => reply(response, { text: '原有活动对话。' })
const payloads: Record<string, unknown>[] = []
const modelErrors: string[] = []

function reply(response: ServerResponse, value: { text: string } | { call: { id: string; arguments: unknown } }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const delta = 'text' in value ? { role: 'assistant', content: value.text }
    : { role: 'assistant', tool_calls: [{ index: 0, id: value.call.id, type: 'function',
      function: { name: 'student_ask', arguments: JSON.stringify(value.call.arguments) } }] }
  for (const chunk of [
    { id: 'student-ask-ui', choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'student-ask-ui', choices: [{ index: 0, delta: {}, finish_reason: 'call' in value ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]) response.write('data: ' + JSON.stringify(chunk) + '\n\n')
  response.end('data: [DONE]\n\n')
}
let apiNamespace = ''
async function api(request: import('@playwright/test').APIRequestContext, route: string, body?: unknown) {
  if (!apiNamespace) apiNamespace = (await (await request.get(endpoint + '/api/learning/context')).json()).clientNamespace
  const response = await request.fetch(endpoint + '/api/learning/' + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-xj-space': 'personal', 'x-xj-namespace': apiNamespace, 'x-xj-agent-contract': '2' },
    ...(body === undefined ? {} : { data: body }) })
  const value = await response.json()
  expect(response.status(), route + ': ' + JSON.stringify(value)).toBe(200)
  return value
}
async function conversationOf(request: import('@playwright/test').APIRequestContext, sessionId: string) {
  return api(request, 'agent-sessions/' + sessionId + '/conversation?after=0')
}
async function configureModel(request: import('@playwright/test').APIRequestContext) {
  const connectionId = randomUUID(), grantId = randomUUID()
  await api(request, 'models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
    name: '明确回应时序', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`,
    path: '/chat/completions', modelId: 'fixture-student-ask-ui', dialect: 'standard', parameterMode: 'plain', enabled: true,
    contextWindow: 262144, maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-student-ask-ui-key' } })
  await api(request, 'models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' })
  const selection = await api(request, 'models/selection')
  await api(request, 'models/selection', { requestId: randomUUID(), expectedVersion: selection.version,
    source: { kind: 'personal', connectionId, grantId } })
}
// Keep the former goal and first question together in the new single-message entry.
async function startConversation(page: import('@playwright/test').Page, goal: string, question: string) {
  const firstQuestion = `${goal}。\n${question}`
  await page.getByRole('button', { name: 'Agent 对话', exact: true }).click()
  await page.getByLabel('向 Agent 提问', { exact: true }).fill(firstQuestion)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.product-conversation-head h1')).toHaveText(firstQuestion)
  return firstQuestion
}
test.beforeAll(async () => {
  if (evidence) await mkdir(evidence, { recursive: true })
  upstream = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString())
      if ((payload.messages ?? []).some((message: { role: string; content: unknown }) => message.role === 'system'
        && typeof message.content === 'string' && message.content.includes('STUDENT_INPUT_POLICY_V2'))) {
        const raw = payload.messages.filter((message: { role: string }) => message.role === 'user').at(-1)?.content
        const source = JSON.parse(typeof raw === 'string' ? raw : raw.map((part: { text?: string }) => part.text ?? '').join(''))
        reply(response, { text: JSON.stringify({ inputDigest: source.inputDigest, creationAuthorization: 'ordinary' }) })
        return
      }
      payloads.push(payload); await answer(payload, response)
    } catch (error) { modelErrors.push(String(error)); response.destroy() }
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  // A fresh, already-started complete product package can use the same public
  // Chrome scenarios without replacing its CLI, daemon or bundled application.
  if (process.env.XUNJIE_STUDENT_ASK_ENDPOINT) {
    endpoint = process.env.XUNJIE_STUDENT_ASK_ENDPOINT
    return
  }
  root = await mkdtemp(join(tmpdir(), 'xj-student-ask-ui-'))
  runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
    postgresBin, postgresVersion: '18.6',
    webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
  await runtime.install({ profile: 'local' })
  host = await createProductRuntimeHost({ root, createApplication: context => createProductLearningApplication(context) })
  endpoint = host.endpoint
})
test.afterAll(async () => {
  await host?.stop(); await runtime?.stop()
  upstream?.closeAllConnections()
  if (upstream) await new Promise<void>(resolve => upstream.close(() => resolve()))
  if (root) await rm(root, { recursive: true, force: true })
})

test('capture the formal conversation baseline before student response UI', async ({ page }) => {
  test.skip(process.env.XUNJIE_CAPTURE_STUDENT_ASK_BASELINE !== '1', 'Only capture before changing the product UI')
  await page.goto(endpoint)
  await startConversation(page, '理解四态累加的先验预测', '先问我的预测，再结合我的回答解释。')
  await expect(page.getByRole('heading', { name: '学习对话', exact: true })).toHaveCount(0)
  await expect(page.getByText('还没有对话。输入问题并发送后，回答会在这里持续保留。', { exact: true })).toHaveCount(0)
  await expect(page.locator('.product-conversation-head h1')).toHaveText('理解四态累加的先验预测。\n先问我的预测，再结合我的回答解释。')
  await expect(page.getByText('尚未选择模型，问题与草稿已保留。')).toBeVisible({ timeout: 20000 })
  if (evidence) await page.screenshot({ path: join(evidence, `student-ask-before-${process.platform}.png`) })
})

test('the existing conversation presents a durable Agent question and explicitly submits a choice', async ({ page, request }) => {
  test.setTimeout(90000)
  await configureModel(request)
  const before = payloads.length
  answer = (_payload, response) => payloads.length === before + 1
    ? reply(response, { call: { id: 'predict-state', arguments: { question: '你预计状态 3 再输入 2 会变成几？',
      source: '当前四态累加的先验预测', options: [{ id: 'one', label: '1' }, { id: 'three', label: '3' }], allowText: true, skippable: true } } })
    : reply(response, { text: '依据你选择的 1 继续：3 加 2 再对 4 取余，结果为 1。' })
  await page.goto(endpoint)
  await startConversation(page, '理解四态累加的先验预测', '先问我的预测，再结合我的回答解释。')
  const card = page.getByRole('region', { name: 'Agent 的问题', exact: true })
  await expect(card).toBeVisible({ timeout: 20000 })
  await expect(card).toContainText('你预计状态 3 再输入 2 会变成几？')
  await expect(card.locator('fieldset')).toHaveCSS('display', 'grid')
  await expect(card.locator('.agent-question-option').first()).toHaveCSS('display', 'flex')
  const options = await card.locator('.agent-question-option').evaluateAll(elements => elements.map(element => {
    const { x, y, bottom } = element.getBoundingClientRect()
    return { x, y, bottom }
  }))
  expect(options).toHaveLength(3)
  for (let index = 1; index < options.length; index++) {
    expect(options[index].x).toBeCloseTo(options[0].x, 0)
    expect(options[index].y).toBeGreaterThanOrEqual(options[index - 1].bottom)
  }
  await expect(page.getByText('发送记录', { exact: true })).toHaveCount(0)
  await expect(card.getByText('当前四态累加的先验预测', { exact: true })).toHaveCount(0)
  await card.getByRole('radio', { name: '1', exact: true }).check()
  if (evidence) await page.screenshot({ path: join(evidence, `student-ask-choice-${process.platform}.png`) })
  await card.getByRole('button', { name: '提交回应', exact: true }).click()
  await expect(page.getByText('依据你选择的 1 继续：3 加 2 再对 4 取余，结果为 1。', { exact: true })).toBeVisible({ timeout: 20000 })
  // The answered question leaves the pending question slot; the answer is the durable record.
  await expect(card).toHaveCount(0)
  expect(payloads.length - before).toBe(2)
  expect(modelErrors).toEqual([])
  await page.reload()
  await expect(page.getByText('依据你选择的 1 继续：3 加 2 再对 4 取余，结果为 1。', { exact: true })).toBeVisible()
  expect(payloads.length - before).toBe(2)
})

test('editing while waiting for a student response cancels the question before opening the editor', async ({ page, request }) => {
  test.setTimeout(90000)
  await configureModel(request)
  const before = payloads.length
  answer = (_payload, response) => payloads.length === before + 1 ? reply(response, { call: { id: 'edit-waiting-question', arguments: {
    question: '你想先讨论哪个问题？', source: '当前学习问题', options: [], allowText: true, skippable: true,
  } } }) : reply(response, { text: '已经按修改后的学习问题重新回答。' })
  await page.goto(endpoint)
  const question = await startConversation(page, '等待时编辑', '你好')
  const card = page.getByRole('region', { name: 'Agent 的问题', exact: true })
  await expect(card).toBeVisible({ timeout: 20000 })
  const student = page.locator('.product-conversation .chat-message.user').first()
  await student.getByRole('button', { name: '编辑这条消息', exact: true }).click()
  await expect(student.getByLabel('修改这条消息', { exact: true })).toHaveValue(question, { timeout: 20000 })
  const sessionId = new URL(page.url()).searchParams.get('session')!
  const conversation = await conversationOf(request, sessionId)
  expect(conversation.runs.at(-1).state).toBe('stopped')
  expect(conversation.waits.at(-1).state).toBe('cancelled')
  expect(payloads.length - before).toBe(1)
  await student.getByLabel('修改这条消息', { exact: true }).fill('修改后的学习问题')
  await student.getByRole('button', { name: '发送', exact: true }).click()
  await expect(student.locator('.bubble')).toHaveText('修改后的学习问题')
  await expect(page.getByText('已经按修改后的学习问题重新回答。', { exact: true })).toBeVisible({ timeout: 20000 })
  expect(payloads.length - before).toBe(2)
  await expect(page.getByText('回答已停止，已发生的内容仍保留。', { exact: true })).toHaveCount(0)
  await expect(page.getByText('选择要继续处理的输入', { exact: true })).toHaveCount(0)
})

test('an unanswered Agent question waits without treating display as an answer', async ({ page, request }) => {
  test.setTimeout(90000)
  await configureModel(request)
  const before = payloads.length
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  answer = async (_payload, response) => {
    await gate
    reply(response, { call: { id: 'ask-while-closed', arguments: { question: '你会先怎样核对这个预测？',
      source: '当前活动需要你先给出观察办法', options: [], allowText: true, skippable: true } } })
  }
  try {
    await page.goto(endpoint)
    await startConversation(page, '保留焦点与新问题草稿', '请先问我准备怎样核对。')
    await expect.poll(() => payloads.length).toBe(before + 1)
    release()
    const card = page.getByRole('region', { name: 'Agent 的问题', exact: true })
    await expect(card).toBeVisible({ timeout: 20000 })
    const sessionId = new URL(page.url()).searchParams.get('session')!
    const draft = page.getByLabel('向 Agent 提问', { exact: true })
    await draft.fill('保留的后续消息：我还想比较另一种方法。')
    await expect.poll(async () => (await conversationOf(request, sessionId)).waits.length).toBe(1)
    const original = (await conversationOf(request, sessionId)).waits[0]
    expect(original.state).toBe('pending')
    expect(original.response).toBeNull()
    expect(payloads.length - before).toBe(1)
    await expect(draft).toHaveValue('保留的后续消息：我还想比较另一种方法。')
    await card.getByLabel('你的回应', { exact: true }).fill('先列出输入，再算出对 4 取余的结果。\n与实际观察比较。')
    if (evidence) await page.screenshot({ path: join(evidence, `student-ask-text-${process.platform}.png`) })
    // A retained composer draft becomes the single primary action; clear it to reach stop.
    await page.getByLabel('向 Agent 提问', { exact: true }).fill('')
    await page.getByRole('button', { name: '停止生成', exact: true }).click()
    await expect(card).toHaveCount(0)
    expect(payloads.length - before).toBe(1)
  } finally { release() }
})

test('Chinese text survives an unaccepted send and a lost acceptance reply is queried by its original identity', async ({ page, request }) => {
  test.setTimeout(90000)
  await configureModel(request)
  const before = payloads.length, sent: Record<string, unknown>[] = []
  let phase: 'offline' | 'lose-reply' | 'online' = 'offline'
  answer = (_payload, response) => payloads.length === before + 1
    ? reply(response, { call: { id: 'ask-preserved-text', arguments: { question: '你预计为几？也请说出核对办法。',
      source: '先保留你的判断，再核对实际结果', options: [], allowText: true, skippable: false } } })
    : reply(response, { text: '已根据你保留的中文回应继续，先验判断与核对方法分别保留。' })
  await page.route('**/api/learning/agent-sessions/*/waits/*/responses', async route => {
    sent.push(route.request().postDataJSON())
    if (phase === 'offline') { await route.abort('failed'); return }
    if (phase === 'lose-reply') {
      const committed = await route.fetch()
      expect(committed.status()).toBe(200)
      const committedBody = await committed.json()
      expect(committedBody.waitId).toBeTruthy()
      phase = 'online'; await route.abort('failed'); return
    }
    await route.continue()
  })
  await page.goto(endpoint)
  await startConversation(page, '可靠保存中文回应', '请通过明确提问等我回答。')
  await expect(page).toHaveURL(/[?&]session=[0-9a-f-]+/)
  const sessionId = new URL(page.url()).searchParams.get('session')!
  const card = page.getByRole('region', { name: 'Agent 的问题', exact: true })
  const text = '  我预计为 1。\n先列出状态与输入，再对 4 取余。  '
  await expect(card).toBeVisible()
  await expect(card.getByRole('button', { name: '跳过这次提问', exact: true })).toHaveCount(0)
  const entry = card.getByLabel('你的回应', { exact: true })
  await entry.focus(); await page.keyboard.insertText(text)
  await expect(entry).toHaveValue(text)
  await page.reload(); await expect(entry).toHaveValue(text)
  await card.getByRole('button', { name: '提交回应', exact: true }).click()
  await expect(page.getByRole('alert').getByRole('button', { name: '核对并重试', exact: true })).toBeEnabled()
  await expect(entry).toHaveValue(text)
  expect((await conversationOf(request, sessionId)).waits[0].state).toBe('pending')
  expect(await api(request, `agent-sessions/${sessionId}/requests/${sent[0].requestId}`)).toBeNull()
  phase = 'lose-reply'
  await page.getByRole('alert').getByRole('button', { name: '核对并重试', exact: true }).click()
  await expect.poll(() => phase).toBe('online')
  await page.reload()
  await expect(page.getByText('已根据你保留的中文回应继续，先验判断与核对方法分别保留。', { exact: true })).toBeVisible({ timeout: 20000 })
  await expect(card).toHaveCount(0)
  const conversation = await conversationOf(request, sessionId)
  expect(conversation.waits[0].response.text).toBe(text)
  expect(conversation.waits).toHaveLength(1)
  expect(sent.length).toBeGreaterThanOrEqual(2)
  expect(sent.every(value => JSON.stringify(value) === JSON.stringify(sent[0]))).toBe(true)
  expect(payloads.length - before).toBe(2)
  if (evidence) await page.screenshot({ path: join(evidence, `student-ask-receipt-recovered-${process.platform}.png`) })
})

test('explicit skip remains distinct and the response entry works with keyboard, dark mode and a narrow desktop', async ({ page, request }) => {
  test.setTimeout(90000)
  await configureModel(request)
  const before = payloads.length
  answer = (_payload, response) => payloads.length === before + 1
    ? reply(response, { call: { id: 'ask-optional', arguments: { question: '要先给出你的预测吗？', source: '这个预测可以明确跳过',
      options: [{ id: 'one', label: '预计为 1' }], allowText: true, skippable: true } } })
    : reply(response, { text: '你明确跳过了预测；我会说明核对方法，不把跳过当作你的理解证据。' })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 1000, height: 760 })
  await page.goto(endpoint)
  await startConversation(page, '可以跳过的预测', '先问我是否要做预测，允许跳过。')
  const card = page.getByRole('region', { name: 'Agent 的问题', exact: true })
  await expect(card).toBeVisible()
  const option = card.getByRole('radio', { name: '预计为 1', exact: true })
  await option.focus(); await page.keyboard.press('Space'); await expect(option).toBeChecked()
  const skip = card.getByRole('button', { name: '跳过这次提问', exact: true })
  await skip.focus(); await expect(skip).toBeFocused()
  if (evidence) await page.screenshot({ path: join(evidence, `student-ask-dark-narrow-${process.platform}.png`) })
  await page.keyboard.press('Enter')
  await expect(card).toHaveCount(0)
  await expect(page.getByText('你明确跳过了预测；我会说明核对方法，不把跳过当作你的理解证据。', { exact: true })).toBeVisible({ timeout: 20000 })
  expect(payloads.length - before).toBe(2)
  if (evidence) await page.screenshot({ path: join(evidence, `student-ask-skipped-${process.platform}.png`) })
})
