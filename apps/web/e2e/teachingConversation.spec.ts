import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication, resolveCredential } from '@xunjie/product-runtime'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
const output = fileURLToPath(new URL('../../../.verification/197', import.meta.url))
let runtime: ReturnType<typeof openProductRuntime>
let host: Awaited<ReturnType<typeof createProductRuntimeHost>>
let upstream: ReturnType<typeof createServer>
let endpoint = '', root = ''
const replies: string[] = []

test.beforeEach(async () => {
  replies.length = 0
  await mkdir(output, { recursive: true })
  upstream = createServer(async (request, response) => {
    for await (const _chunk of request) { /* consume the native payload */ }
    const index = replies.length;
    const text = '界面回答' + (index + 1)
    replies.push(text)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (value: unknown) => response.write('data: ' + JSON.stringify(value) + '\n\n')
    const reply = () => {
      send({ id: 'ui-' + index, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
      send({ id: 'ui-' + index, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      response.end('data: [DONE]\n\n')
    }
    if (index === 2) {
      // Long enough to clear the credential withholding window, then a slow tail for stop.
      send({ id: 'ui-' + index, choices: [{ index: 0, delta: { role: 'assistant',
        content: '这是正在生成的界面回答，内容会逐步出现' }, finish_reason: null }] })
      const tail = setTimeout(() => {
        send({ id: 'ui-' + index, choices: [{ index: 0, delta: { content: '，并在结束后完整保留。' }, finish_reason: null }] })
        send({ id: 'ui-' + index, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        response.end('data: [DONE]\n\n')
      }, 30000)
      tail.unref()
    } else reply()
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  root = await mkdtemp(join(tmpdir(), 'xj-teaching-ui-'))
  runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
  await runtime.install({ profile: 'local' })
  host = await createProductRuntimeHost({ root, createApplication: context => createProductLearningApplication(context) })
  endpoint = host.endpoint
})
test.afterEach(async () => {
  await host?.stop(); await runtime?.stop()
  upstream?.closeAllConnections(); if (upstream) await new Promise(resolve => upstream.close(resolve))
  if (root) await rm(root, { recursive: true, force: true })
})

async function configureModel(request: import('@playwright/test').APIRequestContext,
  headers: Record<string, string> = { 'content-type': 'application/json', 'x-xj-space': 'personal' }) {
  const connectionId = randomUUID(), grantId = randomUUID()
  const port = (upstream.address() as { port: number }).port
  const saved = await request.post(endpoint + '/api/learning/models/connections', { headers, data: {
    requestId: randomUUID(), connectionId, expectedVersion: 0, name: '界面模型', protocol: 'chat-completions',
    baseUrl: `http://127.0.0.1:${port}/v1`, path: '/chat/completions', modelId: 'fixture-ui', dialect: 'standard',
    parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: 8192,
    credential: { action: 'replace', value: 'synthetic-ui-key' } } })
  expect(saved.status()).toBe(200)
  expect((await request.post(endpoint + '/api/learning/models/grants', { headers,
    data: { requestId: randomUUID(), grantId, connectionId, owner: 'self' } })).status()).toBe(200)
  expect((await request.post(endpoint + '/api/learning/models/selection', { headers,
    data: { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, grantId } } })).status()).toBe(200)
}

test('a missing model keeps the activity and first question and offers the real settings entry', async ({ page }) => {
  await page.goto(endpoint)
  await page.getByLabel('学习目标', { exact: true }).fill('缺模型时保留活动')
  await page.getByLabel('起始问题', { exact: true }).fill('还没有模型时，这个问题应当保留。')
  await page.getByRole('button', { name: '建立并开始对话', exact: true }).click()
  await expect(page.locator('#activity-title')).toHaveText('缺模型时保留活动')
  await expect(page.getByText('尚未选择模型，问题与草稿已保留。')).toBeVisible({ timeout: 20000 })
  await expect(page.getByRole('button', { name: '打开模型设置', exact: true })).toBeVisible()
  await expect(page.locator('.teaching-message.student').filter({ hasText: '还没有模型时，这个问题应当保留。' })).toBeVisible()
  await page.screenshot({ path: join(output, `teaching-missing-model-${process.platform}.png`), fullPage: false })
  await page.getByRole('button', { name: '打开模型设置', exact: true }).click()
  await expect(page.getByRole('region', { name: '当前空间模型' })).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  await expect(page.getByLabel('上下文窗口', { exact: true })).toBeVisible()
  await expect(page.getByLabel('最大输出 token', { exact: true })).toBeVisible()
  await page.getByLabel('上下文窗口', { exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(output, `teaching-model-settings-${process.platform}.png`), fullPage: false })
})

test('the formal home and activity conversation persist a first question, a follow-up, reload and stop', async ({ page, request }) => {
  test.setTimeout(120_000)
  await configureModel(request)
  await page.goto(endpoint)
  await page.getByLabel('学习目标', { exact: true }).fill('界面持久学习对话')
  await page.getByLabel('起始问题', { exact: true }).fill('请解释界面中的第一个学习问题。')
  await page.getByRole('button', { name: '建立并开始对话', exact: true }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(output, `teaching-home-${process.platform}.png`), fullPage: false })
  await page.getByRole('button', { name: '建立并开始对话', exact: true }).click()
  await expect(page.locator('#activity-title')).toHaveText('界面持久学习对话')
  await expect(page.getByRole('region', { name: '与 Agent 的对话' })).toBeVisible()
  await expect(page.getByText('界面回答1', { exact: true })).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.teaching-message.student').filter({ hasText: '请解释界面中的第一个学习问题。' })).toBeVisible()
  const composer = page.getByLabel('你的问题', { exact: true })
  await page.getByRole('button', { name: '收起对话', exact: true }).click()
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await expect(composer).toBeFocused()
  await composer.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  await page.keyboard.insertText('中文输入草稿')
  await expect(composer).toHaveValue('中文输入草稿')
  await page.keyboard.press('Enter')
  await expect(composer).toHaveValue(/中文输入草稿/)
  await composer.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
  await composer.fill('')
  await page.screenshot({ path: join(output, `teaching-conversation-${process.platform}.png`), fullPage: false })

  await page.reload()
  const reopen = page.getByRole('button', { name: '打开对话', exact: true })
  if (await reopen.isVisible()) await reopen.click()
  await expect(page.getByText('界面回答1', { exact: true })).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('来源：个人模型 · fixture-ui · chat-completions', { exact: true })).toBeVisible()

  const switchedConnectionId = randomUUID(), switchedGrantId = randomUUID()
  const headers = { 'content-type': 'application/json', 'x-xj-space': 'personal' }
  const port = (upstream.address() as { port: number }).port
  expect((await request.post(endpoint + '/api/learning/models/connections', { headers, data: {
    requestId: randomUUID(), connectionId: switchedConnectionId, expectedVersion: 0, name: '切换界面模型',
    protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${port}/v1`, path: '/chat/completions',
    modelId: 'fixture-ui-switched', dialect: 'standard', parameterMode: 'plain', enabled: true,
    contextWindow: 262144, maxOutputTokens: 8192, credential: { action: 'replace', value: 'synthetic-ui-switched-key' } } })).status()).toBe(200)
  expect((await request.post(endpoint + '/api/learning/models/grants', { headers, data: {
    requestId: randomUUID(), grantId: switchedGrantId, connectionId: switchedConnectionId, owner: 'self' } })).status()).toBe(200)
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await page.getByRole('region', { name: '当前空间模型' })
    .getByRole('button', { name: '重新读取选用', exact: true }).click()
  const switchedCard = page.getByRole('region', { name: '当前空间模型' })
    .locator('.st-provider').filter({ hasText: '切换界面模型' })
  await expect(switchedCard).toBeVisible({ timeout: 20000 })
  await switchedCard.getByRole('button', { name: /选用$/ }).click()
  await expect(page.getByText('已为当前学习活动切换到「fixture-ui-switched」。已有消息和结果保留原出处。', { exact: true })).toBeVisible({ timeout: 20000 })
  await page.getByRole('button', { name: '返回学习空间', exact: true }).click()
  await expect(page.locator('#activity-title')).toHaveText('界面持久学习对话')

  await page.getByLabel('你的问题', { exact: true }).fill('这是界面中的第二个问题。')
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(page.getByText('界面回答2', { exact: true })).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('来源：个人模型 · fixture-ui-switched · chat-completions', { exact: true })).toBeVisible()

  await page.getByLabel('你的问题', { exact: true }).fill('请生成一个可以被停止的回答。')
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(page.getByText('Agent 正在生成回答…')).toBeVisible({ timeout: 20000 })
  await page.getByLabel('你的问题', { exact: true }).fill('生成期间继续输入的新草稿。')
  await expect(page.getByRole('button', { name: '补充当前任务', exact: true })).toBeEnabled()
  await expect(page.getByText('收到后会在下一步纳入；已开始的操作保留实际状态。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.getByText('回答已停止，已发生的内容仍保留。')).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('这是正在生成的界面回答，内容会逐步出现', { exact: true })).toBeVisible()
  await expect(page.locator('.teaching-message.assistant .turn-caret')).toHaveCount(0)
  await expect(page.locator('.teaching-message.student').filter({ hasText: '请生成一个可以被停止的回答。' })).toBeVisible()
  await expect(page.getByLabel('你的问题', { exact: true })).toHaveValue('生成期间继续输入的新草稿。')
  await expect(page.getByRole('button', { name: '发送问题', exact: true })).toBeEnabled()
  await page.screenshot({ path: join(output, `teaching-stopped-${process.platform}.png`), fullPage: false })
  expect(replies.length).toBe(3)
})

test('a course activity asks through the fixed help policy in the formal conversation UI', async ({ page }) => {
  const control = await resolveCredential(root, 'control')
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID()
  const manage = async (path: string, body: unknown) => {
    const response = await page.request.post(endpoint + '/api/learning/manage/' + path, {
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + control }, data: body })
    expect(response.status()).toBe(200)
    return response.json()
  }
  await manage('course-import', { formatVersion: 1, requestId: randomUUID(),
    course: { courseId, name: '课程问答验收' }, task: { taskId, title: '课程问答任务', summary: '固定帮助范围' },
    release: { releaseId, objectives: ['解释课程概念'], requirements: '结合课堂内容回答。', materials: [], starterWorks: [],
      capabilities: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } }, resources: [] })
  const loginName = 'teaching-chrome-' + randomUUID(), password = randomUUID()
  const member = await manage('members', { requestId: randomUUID(), loginName, password })
  await manage('course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true })
  expect((await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status()).toBe(200)
  const created = await page.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } })
  expect(created.status()).toBe(200)
  const activityId = (await created.json()).activityId as string
  await configureModel(page.request, { 'content-type': 'application/json' })
  const expected = '界面回答' + (replies.length + 1)
  await page.goto(endpoint + '/?space=school&activity=' + activityId)
  await expect(page.getByRole('heading', { name: '课程问答任务', exact: true })).toBeVisible()
  const open = page.getByRole('button', { name: '打开对话', exact: true })
  await expect(open).toBeVisible()
  await open.click()
  await expect(page.getByRole('region', { name: '与 Agent 的对话' })).toBeVisible()
  await page.getByLabel('你的问题', { exact: true }).fill('课程允许问答时，请解释本任务的核心概念。')
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(page.getByText(expected, { exact: true })).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.teaching-message.student').filter({ hasText: '课程允许问答时' })).toBeVisible()
  await page.screenshot({ path: join(output, `teaching-course-${process.platform}.png`), fullPage: false })
})

test('a product process restart reopens the persisted conversation in the same Chrome session', async ({ page, request }) => {
  await configureModel(request)
  const expected = '界面回答' + (replies.length + 1)
  await page.goto(endpoint)
  await page.getByLabel('学习目标', { exact: true }).fill('重启恢复对话')
  await page.getByLabel('起始问题', { exact: true }).fill('重启之后这个问题和回答还在吗？')
  await page.getByRole('button', { name: '建立并开始对话', exact: true }).click()
  await expect(page.locator('#activity-title')).toHaveText('重启恢复对话')
  await expect(page.getByText(expected, { exact: true })).toBeVisible({ timeout: 20000 })
  const activityId = new URL(page.url()).searchParams.get('activity')!
  await host.stop()
  host = await createProductRuntimeHost({ root, createApplication: context => createProductLearningApplication(context) })
  endpoint = host.endpoint
  await page.goto(endpoint + '/?space=personal&activity=' + activityId)
  await expect(page.locator('#activity-title')).toHaveText('重启恢复对话')
  const open = page.getByRole('button', { name: '打开对话', exact: true })
  if (await open.isVisible()) await open.click()
  await expect(page.getByText(expected, { exact: true })).toBeVisible({ timeout: 20000 })
  await page.screenshot({ path: join(output, `teaching-restart-${process.platform}.png`), fullPage: false })
})
