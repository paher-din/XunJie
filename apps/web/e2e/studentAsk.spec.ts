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
const evidence = fileURLToPath(new URL('../../../docs/student-agent-implementation/evidence/wp07-199', import.meta.url))
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
async function api(request: import('@playwright/test').APIRequestContext, route: string, body?: unknown) {
  const response = await request.fetch(endpoint + '/api/learning/' + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-xj-space': 'personal' }, ...(body === undefined ? {} : { data: body }) })
  const value = await response.json()
  expect(response.status(), route + ': ' + JSON.stringify(value)).toBe(200)
  return value
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
test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true })
  upstream = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString())
      payloads.push(payload); await answer(payload, response)
    } catch (error) { modelErrors.push(String(error)); response.destroy() }
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
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
  await page.getByLabel('学习目标', { exact: true }).fill('理解四态累加的先验预测')
  await page.getByLabel('起始问题', { exact: true }).fill('先问我的预测，再结合我的回答解释。')
  await page.getByRole('button', { name: '建立并开始对话', exact: true }).click()
  await expect(page.locator('#activity-title')).toHaveText('理解四态累加的先验预测')
  await expect(page.getByText('尚未选择模型，问题与草稿已保留。')).toBeVisible({ timeout: 20000 })
  await page.screenshot({ path: join(evidence, `student-ask-before-${process.platform}.png`) })
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
  await page.getByLabel('学习目标', { exact: true }).fill('理解四态累加的先验预测')
  await page.getByLabel('起始问题', { exact: true }).fill('先问我的预测，再结合我的回答解释。')
  await page.getByRole('button', { name: '建立并开始对话', exact: true }).click()
  const card = page.getByRole('group', { name: 'Agent 的提问', exact: true })
  await expect(card).toBeVisible({ timeout: 20000 })
  await expect(card).toContainText('你预计状态 3 再输入 2 会变成几？')
  await expect(page.getByRole('region', { name: '待发与接收记录', exact: true })).not.toContainText(/"runId"|"inputId"/)
  await card.getByRole('radio', { name: '1', exact: true }).check()
  await page.screenshot({ path: join(evidence, `student-ask-choice-${process.platform}.png`) })
  await card.getByRole('button', { name: '提交回应', exact: true }).click()
  await expect(page.getByText('依据你选择的 1 继续：3 加 2 再对 4 取余，结果为 1。', { exact: true })).toBeVisible({ timeout: 20000 })
  await expect(card).toContainText('回应已接收')
  expect(payloads.length - before).toBe(2)
  expect(modelErrors).toEqual([])
  await page.reload()
  await expect(page.getByText('依据你选择的 1 继续：3 加 2 再对 4 取余，结果为 1。', { exact: true })).toBeVisible()
  expect(payloads.length - before).toBe(2)
})

test('IP opens the same unanswered question without stealing focus or treating display as an answer', async ({ page, request }) => {
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
    await page.getByLabel('学习目标', { exact: true }).fill('保留焦点与新问题草稿')
    await page.getByLabel('起始问题', { exact: true }).fill('请先问我准备怎样核对。')
    await page.getByRole('button', { name: '建立并开始对话', exact: true }).click()
    await expect.poll(() => payloads.length).toBe(before + 1)
    const activityId = new URL(page.url()).searchParams.get('activity')!
    const draft = page.getByLabel('你的问题', { exact: true })
    await expect(draft).toHaveValue('')
    await draft.fill('保留的后续消息：我还想比较另一种方法。')
    await page.getByRole('button', { name: '收起对话', exact: true }).click()
    const reopen = page.getByRole('button', { name: '打开对话', exact: true })
    await reopen.focus()
    release()
    await expect.poll(async () => (await api(request, `agent/${activityId}/conversation`)).questions.length).toBe(1)
    const original = (await api(request, `agent/${activityId}/conversation`)).questions[0]
    expect(original.presentedAt).toBeNull()
    await expect(page.getByRole('button', { name: '回答当前问题', exact: true })).toBeVisible({ timeout: 15000 })
    await expect(reopen).toBeFocused()
    await page.screenshot({ path: join(evidence, `student-ask-ip-${process.platform}.png`) })
    await page.getByRole('button', { name: '回答当前问题', exact: true }).click()
    const card = page.getByRole('group', { name: 'Agent 的提问', exact: true })
    await expect(card).toBeVisible()
    await expect(card).toBeFocused()
    await expect(draft).toHaveValue('保留的后续消息：我还想比较另一种方法。')
    await expect.poll(async () => (await api(request, `agent/${activityId}/conversation`)).questions[0].presentedAt).not.toBeNull()
    expect((await api(request, `agent/${activityId}/conversation`)).questions[0].state).toBe('pending')
    expect(payloads.length - before).toBe(1)
    await card.getByLabel('你的回应', { exact: true }).fill('先列出输入，再算出对 4 取余的结果。\n与实际观察比较。')
    await page.screenshot({ path: join(evidence, `student-ask-text-${process.platform}.png`) })
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await expect(card).toContainText('这次提问已取消')
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
  await page.route('**/api/learning/agent/*/questions/*/responses', async route => {
    sent.push(route.request().postDataJSON())
    if (phase === 'offline') { await route.abort('failed'); return }
    if (phase === 'lose-reply') {
      const committed = await route.fetch()
      expect(committed.status()).toBe(200)
      expect((await committed.json()).status).toBe('accepted')
      phase = 'online'; await route.abort('failed'); return
    }
    await route.continue()
  })
  await page.goto(endpoint)
  await page.getByLabel('学习目标', { exact: true }).fill('可靠保存中文回应')
  await page.getByLabel('起始问题', { exact: true }).fill('请通过明确提问等我回答。')
  await page.getByRole('button', { name: '建立并开始对话', exact: true }).click()
  await expect(page).toHaveURL(/[?&]activity=[0-9a-f-]+/)
  const activityId = new URL(page.url()).searchParams.get('activity')!
  const card = page.getByRole('group', { name: 'Agent 的提问', exact: true })
  const text = '  我预计为 1。\n先列出状态与输入，再对 4 取余。  '
  await expect(card).toBeVisible()
  await expect(card.getByRole('button', { name: '跳过这次提问', exact: true })).toHaveCount(0)
  const entry = card.getByLabel('你的回应', { exact: true })
  await entry.focus(); await page.keyboard.insertText(text)
  await expect(card.getByText('输入已在本机保留。', { exact: true })).toBeVisible()
  await page.reload(); await expect(entry).toHaveValue(text)
  await card.getByRole('button', { name: '提交回应', exact: true }).click()
  await expect(card.getByRole('button', { name: '核对原回应', exact: true })).toBeEnabled()
  await expect(entry).toHaveValue(text)
  expect((await api(request, `agent/${activityId}/conversation`)).questions[0].state).toBe('pending')
  expect(await api(request, `agent/${activityId}/responses/${sent[0].requestId}`)).toBeNull()
  phase = 'lose-reply'
  await card.getByRole('button', { name: '核对原回应', exact: true }).click()
  await expect.poll(() => phase).toBe('online')
  await page.reload()
  await expect(page.getByText('已根据你保留的中文回应继续，先验判断与核对方法分别保留。', { exact: true })).toBeVisible({ timeout: 20000 })
  await expect(card).toContainText('回应已接收')
  const conversation = await api(request, `agent/${activityId}/conversation`)
  expect(conversation.questions[0].response.answer.text).toBe(text)
  expect(conversation.messages.filter((message: { kind?: string }) => message.kind === 'student-response')).toHaveLength(1)
  expect(sent).toHaveLength(2)
  expect(sent[1]).toEqual(sent[0])
  expect(payloads.length - before).toBe(2)
  await page.screenshot({ path: join(evidence, `student-ask-receipt-recovered-${process.platform}.png`) })
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
  await page.getByLabel('学习目标', { exact: true }).fill('可以跳过的预测')
  await page.getByLabel('起始问题', { exact: true }).fill('先问我是否要做预测，允许跳过。')
  await page.getByRole('button', { name: '建立并开始对话', exact: true }).click()
  const card = page.getByRole('group', { name: 'Agent 的提问', exact: true })
  await expect(card).toBeVisible()
  const option = card.getByRole('radio', { name: '预计为 1', exact: true })
  await option.focus(); await page.keyboard.press('Space'); await expect(option).toBeChecked()
  const skip = card.getByRole('button', { name: '跳过这次提问', exact: true })
  await skip.focus(); await expect(skip).toBeFocused()
  await page.screenshot({ path: join(evidence, `student-ask-dark-narrow-${process.platform}.png`) })
  await page.keyboard.press('Enter')
  await expect(card).toContainText('你已明确跳过')
  await expect(page.getByText('你明确跳过了预测；我会说明核对方法，不把跳过当作你的理解证据。', { exact: true })).toBeVisible({ timeout: 20000 })
  expect(payloads.length - before).toBe(2)
  await page.screenshot({ path: join(evidence, `student-ask-skipped-${process.platform}.png`) })
})
