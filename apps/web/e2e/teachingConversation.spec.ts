import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication } from '@xunjie/product-runtime'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
const output = fileURLToPath(new URL('../../../.verification/197', import.meta.url))
let runtime: ReturnType<typeof openProductRuntime>
let host: Awaited<ReturnType<typeof createProductRuntimeHost>>
let upstream: ReturnType<typeof createServer>
let endpoint = '', root = ''
const replies: string[] = []

test.beforeAll(async () => {
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
    if (index === 2) setTimeout(reply, 2500); else reply()
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
test.afterAll(async () => {
  await host?.stop(); await runtime?.stop()
  upstream?.closeAllConnections(); if (upstream) await new Promise(resolve => upstream.close(resolve))
})

async function configureModel(request: import('@playwright/test').APIRequestContext) {
  const connectionId = randomUUID(), grantId = randomUUID()
  const headers = { 'content-type': 'application/json', 'x-xj-space': 'personal' }
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
  await page.screenshot({ path: join(output, `teaching-conversation-${process.platform}.png`), fullPage: false })

  await page.reload()
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await expect(page.getByText('界面回答1', { exact: true })).toBeVisible({ timeout: 20000 })

  await page.getByLabel('你的问题', { exact: true }).fill('这是界面中的第二个问题。')
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(page.getByText('界面回答2', { exact: true })).toBeVisible({ timeout: 20000 })

  await page.getByLabel('你的问题', { exact: true }).fill('请生成一个可以被停止的回答。')
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(page.getByText('Agent 正在生成回答…')).toBeVisible({ timeout: 20000 })
  await page.getByLabel('你的问题', { exact: true }).fill('生成期间继续输入的新草稿。')
  await expect(page.getByRole('button', { name: '等待当前回答', exact: true })).toBeDisabled()
  await expect(page.getByText('当前回答结束后再发送；问题会先保存在草稿中。')).toBeVisible()
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.getByText('回答已停止，已发生的内容仍保留。')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.teaching-message.student').filter({ hasText: '请生成一个可以被停止的回答。' })).toBeVisible()
  await expect(page.getByLabel('你的问题', { exact: true })).toHaveValue('生成期间继续输入的新草稿。')
  await expect(page.getByRole('button', { name: '发送问题', exact: true })).toBeEnabled()
  await page.screenshot({ path: join(output, `teaching-stopped-${process.platform}.png`), fullPage: false })
  expect(replies.length).toBe(3)
})
