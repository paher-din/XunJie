import { evidenceDirectory, evidencePath } from './evidence'
import { test, expect, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProductRuntime } from '@xunjie/product-runtime'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
const reviewScreenshots = evidenceDirectory('pr177')
test.skip(!postgresBin, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
let runtime: Pick<ReturnType<typeof openProductRuntime>, 'install' | 'start' | 'stop'>, endpoint: string, baseUrl: string
let runtimeRoot: string
let calls = 0
const payloads: { model: string; reasoning_effort?: string }[] = []
const upstream = createServer(async (request, response) => {
  calls++
  const chunks = []; for await (const chunk of request) chunks.push(chunk)
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  payloads.push(input)
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (request.url === '/v1/responses') {
    if (input.model === 'fixture-responses-cancel') {
      response.write('data: ' + JSON.stringify({ type: 'response.created', response: { id: 'ui-pending', object: 'response', status: 'in_progress', output: [] } }) + '\n\n')
      return
    }
    response.end('data: ' + JSON.stringify({ type: 'response.completed', response: { id: 'ui-responses', object: 'response', status: 'completed',
      output: [{ type: 'message', id: 'ui-message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Responses 检查正常', annotations: [] }] }] } }) + '\n\n')
    return
  }
  response.end('data: ' + JSON.stringify({ id: 'check-ui', choices: [{ index: 0, delta: { content: '检查正常' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
})
async function openRuntime(root: string): Promise<typeof runtime> {
  if (process.env.XUNJIE_PRODUCT_TEST_PACKAGE) {
    const product = resolve(process.env.XUNJIE_PRODUCT_TEST_PACKAGE)
    const resources = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'))
    const execute = promisify(execFile)
    const run = async (command: string, args: string[] = []) => JSON.parse((await execute(resolve(product, resources.nodePath),
      [join(product, 'app/cli.js'), command, '--root', root, ...args], { windowsHide: true, timeout: 180000 })).stdout)
    return { install: input => run('install', ['--profile', input?.profile ?? 'local']), start: () => run('start'), stop: () => run('stop') }
  }
  return openProductRuntime({ root, resources: {
    nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
}
test.beforeAll(async () => {
  if (evidenceDirectory()) await mkdir(evidencePath('164'), { recursive: true })
  if (reviewScreenshots) await mkdir(reviewScreenshots, { recursive: true })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`
  const root = runtimeRoot = await mkdtemp(join(tmpdir(), 'xj-models-chrome-'))
  runtime = await openRuntime(root)
  await runtime.install({ profile: 'local' }); endpoint = (await runtime.start()).endpoint!
})
test.afterAll(async () => { await runtime?.stop(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true }) })

async function addModel(page: Page, modelId: string) {
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '搜索或输入模型 ID', exact: true }).fill(modelId)
  await dialog.getByRole('button', { name: '添加模型', exact: true }).click()
}

test('formal model settings save and reopen a personal connection without a legacy session', async ({ page }) => {
  await page.goto(endpoint + '/?settings=models')
  await expect(page.getByRole('region', { name: '个人连接配置', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('本人的测试服务')
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl)
  await addModel(page, 'known-model-without-catalog')
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-private-ui-key')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('region', { name: '个人连接配置', exact: true }).getByText('本人的测试服务', { exact: true })).toBeVisible()
  await expect(page.locator('.st-provider-url')).toHaveCount(0)
  await expect(page.getByText('密钥已保存', { exact: true })).toHaveCount(0)
  await expect(page.getByText('连接与能力', { exact: true })).toHaveCount(0)
  expect(calls).toBe(0)
  await page.reload()
  await expect(page.getByRole('region', { name: '个人连接配置', exact: true }).getByText('本人的测试服务', { exact: true })).toBeVisible()
  expect(calls).toBe(0)
  await page.getByRole('button', { name: '模型测试', exact: true }).click()
  await expect(page.getByText('模型测试通过', { exact: true }).first()).toBeVisible()
  await expect(page.getByText(/^模型测试记录（/)).toHaveCount(0)
  expect(calls).toBe(1)
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('synthetic-private-ui-key')
  await expect(page.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  if (evidenceDirectory()) await page.screenshot({ path: evidencePath('164/after-model-settings-light.png'), fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 720, height: 900 })
  if (evidenceDirectory()) await page.screenshot({ path: evidencePath('164/after-model-settings-dark-narrow.png'), fullPage: true })
})

test('a delayed save confirmation preserves later form input and its next versioned save', async ({ page }) => {
  await page.goto(endpoint + '/?settings=models')
  await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('先提交 A')
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl)
  await addModel(page, 'known-form-model')
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-first-key')
  let release!: () => void, committed!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { committed = resolve })
  await page.route('**/api/learning/models/providers', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    const response = await route.fetch(); committed(); await held; await route.fulfill({ response })
  })
  try {
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await reached
    await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('等待时继续填写 B')
    await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-second-key')
    release()
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeEnabled()
    await expect(dialog.getByRole('textbox', { name: '连接名称', exact: true })).toHaveValue('等待时继续填写 B')
    await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('synthetic-second-key')
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(page.getByRole('region', { name: '个人连接配置', exact: true }).getByText('等待时继续填写 B', { exact: true })).toBeVisible()
  } finally { release(); await page.unroute('**/api/learning/models/providers') }
})

test('protocol examples, inline address errors and masked saved-key replacement follow the current form value', async ({ page }) => {
  await page.goto(endpoint + '/?settings=models')
  await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  const dialog = page.getByRole('dialog'), key = dialog.getByLabel('API Key', { exact: true })
  const address = dialog.getByRole('textbox', { name: 'Base URL', exact: true })
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('密钥编辑验收')
  await addModel(page, 'synthetic-editor-model')
  await expect(address).toHaveAttribute('placeholder', 'https://api.example.com/v1')
  await address.fill(baseUrl + '/chat/completions')
  await address.blur()
  await expect(dialog.getByRole('alert')).toContainText('请去掉末尾 /chat/completions')
  await dialog.getByRole('radio', { name: 'Anthropic 兼容', exact: true }).click()
  await expect(address).toHaveAttribute('placeholder', 'https://api.example.com')
  await address.fill(baseUrl)
  await expect(dialog.getByRole('alert')).toContainText('不带末尾 /v1')
  await dialog.getByRole('radio', { name: 'OpenAI Responses', exact: true }).click()
  await expect(address).toHaveAttribute('placeholder', 'https://api.example.com/v1')
  await expect(address).toHaveAttribute('aria-invalid', 'false')
  await key.fill('synthetic-editor-first')
  await expect(key).toHaveAttribute('type', 'password')
  await dialog.getByRole('button', { name: '显示 API Key', exact: true }).click()
  await expect(key).toHaveAttribute('type', 'text')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  const card = page.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: '密钥编辑验收' })
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(key).toHaveValue('synthetic-editor-first')
  await expect(key).toHaveAttribute('type', 'password')
  await dialog.getByRole('button', { name: '显示 API Key', exact: true }).click()
  await expect(key).toHaveAttribute('type', 'text')
  await key.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await key.press('Backspace')
  await key.fill('synthetic-editor-second')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(key).toHaveValue('synthetic-editor-second')
  await expect(key).toHaveAttribute('type', 'password')
  await key.fill('')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(key).toHaveValue('')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
})

test('dialog keyboard focus, Chinese composition, saved-key checks and ordinary navigation remain usable', async ({ page }) => {
  await page.goto(endpoint + '/?settings=models')
  const add = page.getByRole('button', { name: '添加供应商', exact: true })
  await add.click()
  const dialog = page.getByRole('dialog')
  const name = dialog.getByRole('textbox', { name: '连接名称', exact: true })
  await name.focus()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.imeSetComposition', { text: '循阶中文输入', selectionStart: 6, selectionEnd: 6 })
  await cdp.send('Input.insertText', { text: '循阶中文输入' })
  await expect(name).toHaveValue('循阶中文输入')
  for (let index = 0; index < 18; index++) {
    await page.keyboard.press('Tab')
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true)
  }
  if (evidenceDirectory()) await page.screenshot({ path: evidencePath('164/model-dialog-keyboard.png'), fullPage: true })
  if (await page.getByRole('tooltip').isVisible()) {
    await page.keyboard.press('Escape')
    await expect(page.getByRole('tooltip')).toBeHidden()
    await expect(dialog).toBeVisible()
  }
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(add).toBeFocused()
  const card = await createRecoveryConnection(page, '键盘测试连接')
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('synthetic-recovery-key')
  await dialog.getByRole('button', { name: '展开 synthetic-recovery-model 的配置', exact: true }).click()
  await dialog.getByRole('button', { name: '模型测试', exact: true }).click()
  await expect(dialog.getByText('模型测试通过', { exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '首页', exact: true }).click()
  await expect(page.getByRole('heading', { name: '个人模型设置', exact: true })).toBeHidden()
})

test('Responses settings check drafts, save, reopen and cancel through the formal owner', async ({ page }) => {
  await page.goto(endpoint + '/?settings=models')
  await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('Responses 正式连接')
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl)
  await addModel(page, 'fixture-responses')
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-responses-ui-key')
  await dialog.getByRole('radio', { name: 'OpenAI Responses', exact: true }).click()
  const check = dialog.getByRole('button', { name: '模型测试', exact: true })
  await expect(check).toBeEnabled()
  await check.click()
  await expect(dialog.getByText('模型测试通过', { exact: true })).toBeVisible()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.reload()
  const card = page.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: 'Responses 正式连接' })
  await card.getByRole('button', { name: '模型测试', exact: true }).click()
  await expect(card.getByText('模型测试通过', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(dialog.getByRole('radio', { name: 'OpenAI Responses', exact: true })).toBeChecked()
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('synthetic-responses-ui-key')
  await dialog.getByRole('button', { name: '展开 fixture-responses 的配置', exact: true }).click()
  await dialog.getByRole('textbox', { name: '模型 ID', exact: true }).fill('fixture-responses-cancel')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(card.getByText('fixture-responses-cancel', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: '模型测试', exact: true }).click()
  await expect(card.getByText('正在测试文本与默认思考参数…', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: '停止模型测试', exact: true }).click()
  await expect(card.getByText('模型测试已停止', { exact: true })).toBeVisible()
  if (evidenceDirectory()) await page.screenshot({ path: evidencePath('164/responses-settings.png'), fullPage: true })
})

async function createRecoveryConnection(page: Page, name: string) {
  await page.goto(endpoint + '/?settings=models')
  await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill(name)
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl)
  await addModel(page, 'synthetic-recovery-model')
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-recovery-key')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  return page.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: name })
}

test('rejected tests notify once across successful polls and allow a later retry without a model result', async ({ page }) => {
  const card = await createRecoveryConnection(page, '轮询错误回归')
  let polls = 0, denied = true
  await page.route('**/api/learning/models/checks', async route => {
    if (route.request().method() === 'GET') {
      const response = await route.fetch(); polls++; await route.fulfill({ response }); return
    }
    if (denied) { await route.fulfill({ status: 409, json: { error: 'resource-busy' } }); return }
    await route.continue()
  })
  try {
    if (reviewScreenshots) await page.screenshot({ path: join(reviewScreenshots, 'action-before.png'), fullPage: true })
    await card.getByRole('button', { name: '模型测试', exact: true }).click()
    const failure = page.locator('[data-sonner-toast][data-type="error"]').filter({ hasText: '检查频次或并发已达上限' })
    await expect(failure).toBeVisible()
    await expect(card.locator('.st-model-test-feedback')).toHaveCount(0)
    const afterFailure = polls
    await expect.poll(() => polls).toBeGreaterThanOrEqual(afterFailure + 2)
    await expect(failure).toHaveCount(1)
    if (reviewScreenshots) await page.screenshot({ path: join(reviewScreenshots, 'action-error-after-two-polls.png'), fullPage: true })
    denied = false
    await card.getByRole('button', { name: '模型测试', exact: true }).click()
    await expect(card.getByText('模型测试通过', { exact: true })).toBeVisible()
    if (reviewScreenshots) await page.screenshot({ path: join(reviewScreenshots, 'action-retry-confirmed.png'), fullPage: true })
  } finally { await page.unroute('**/api/learning/models/checks') }
})

for (const credential of ['unchanged', 'replace', 'clear'] as const) {
  test(`two tabs explicitly reconcile CAS while preserving the draft and ${credential} credential intent`, async ({ page, context }) => {
    const title = '双标签冲突-' + credential
    const card = await createRecoveryConnection(page, title)
    await card.getByRole('button', { name: '编辑', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill(title + '-本人草稿')
    if (credential === 'replace') await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-replacement-key')
    if (credential === 'clear') await dialog.getByLabel('API Key', { exact: true }).fill('')
    const other = await context.newPage()
    const submissions: { requestId: string; expectedVersion: number; credential: { action: string } }[] = []
    await page.route('**/api/learning/models/providers', async route => {
      if (route.request().method() === 'POST') submissions.push(route.request().postDataJSON())
      await route.continue()
    })
    try {
      if (reviewScreenshots) await page.screenshot({ path: join(reviewScreenshots, `cas-${credential}-before.png`), fullPage: true })
      await other.goto(endpoint + '/?settings=models')
      await other.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: title })
        .getByRole('button', { name: '编辑', exact: true }).click()
      const remote = other.getByRole('dialog')
      await remote.getByRole('textbox', { name: '连接名称', exact: true }).fill(title + '-其他标签')
      await remote.getByRole('button', { name: '展开 synthetic-recovery-model 的配置', exact: true }).click()
      await remote.getByRole('textbox', { name: '模型 ID', exact: true }).fill('other-tab-model')
      await remote.getByRole('button', { name: '保存', exact: true }).click()
      await expect(remote).toBeHidden()
      // Radix marks the background aria-hidden while this dialog is open.
      await expect(page.locator('[aria-label="个人连接配置"]').getByText(title + '-其他标签', { exact: true })).toHaveCount(1)
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect(dialog.getByText(/版本冲突，当前草稿和密钥操作已保留/)).toBeVisible()
      if (reviewScreenshots) await page.screenshot({ path: join(reviewScreenshots, `cas-${credential}-conflict.png`), fullPage: true })
      await dialog.getByRole('button', { name: '读取最新版本', exact: true }).click()
      const comparison = dialog.getByRole('region', { name: '配置冲突核对', exact: true })
      await expect(comparison).toContainText('已保存版本 2')
      await expect(comparison).toContainText('other-tab-model')
      await expect(dialog.getByRole('textbox', { name: '连接名称', exact: true })).toHaveValue(title + '-本人草稿')
      await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue(credential === 'replace' ? 'synthetic-replacement-key' : credential === 'clear' ? '' : 'synthetic-recovery-key')
      if (reviewScreenshots) await page.screenshot({ path: join(reviewScreenshots, `cas-${credential}-compare.png`), fullPage: true })
      expect(submissions).toHaveLength(1)
      await dialog.getByRole('button', { name: '确认按当前草稿重试', exact: true }).click()
      await expect(dialog).toBeHidden()
      expect(submissions.map(input => input.expectedVersion)).toEqual([1, 2])
      expect(submissions[1].requestId).not.toBe(submissions[0].requestId)
      expect(submissions[1].credential.action).toBe(credential === 'clear' ? 'clear' : 'replace')
      const saved = page.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: title + '-本人草稿' })
      await saved.getByRole('button', { name: '编辑', exact: true }).click()
      await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue(credential === 'clear' ? '' : credential === 'replace' ? 'synthetic-replacement-key' : 'synthetic-recovery-key')
      await dialog.getByRole('button', { name: '关闭', exact: true }).click()
      if (reviewScreenshots) await page.screenshot({ path: join(reviewScreenshots, `cas-${credential}-recovered.png`), fullPage: true })
    } finally { await other.close(); await page.unroute('**/api/learning/models/providers') }
  })
}

test('a lost save ACK is reconciled by the identical POST before submitting later edits', async ({ page }) => {
  const card = await createRecoveryConnection(page, '未知保存回归')
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('未知保存-原提交')
  const submissions: string[] = []
  await page.route('**/api/learning/models/providers', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    submissions.push(route.request().postData()!)
    // route.fetch commits through the real owner/PG; only the browser ACK is lost.
    const response = await route.fetch()
    if (submissions.length === 1) { expect(response.ok()).toBe(true); await route.abort('failed'); return }
    await route.fulfill({ response })
  })
  try {
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog.getByText(/保存结果尚未确认，当前输入已保留/)).toBeVisible()
    await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('未知保存-后续草稿')
    await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-next-key')
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
    if (reviewScreenshots) await page.screenshot({ path: join(reviewScreenshots, 'unknown-ack-draft-preserved.png'), fullPage: true })
    await dialog.getByRole('button', { name: '核对原提交', exact: true }).click()
    await expect(dialog.getByText(/原提交已确认/)).toBeVisible()
    expect(submissions[1]).toBe(submissions[0])
    await expect(dialog.getByRole('textbox', { name: '连接名称', exact: true })).toHaveValue('未知保存-后续草稿')
    await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('synthetic-next-key')
    if (reviewScreenshots) await page.screenshot({ path: join(reviewScreenshots, 'unknown-ack-confirmed.png'), fullPage: true })
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeHidden()
    expect(submissions.map(input => JSON.parse(input).expectedVersion)).toEqual([1, 1, 2])
    const saved = page.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: '未知保存-后续草稿' })
    await expect(saved).toBeVisible()
    if (reviewScreenshots) await page.screenshot({ path: join(reviewScreenshots, 'unknown-ack-recovered.png'), fullPage: true })
  } finally { await page.unroute('**/api/learning/models/providers') }
})

test('one provider holds multiple models, switches independently, and sends the selected reasoning effort', async ({ page }) => {
  const root = await mkdtemp(join(tmpdir(), 'xj-provider-switches-chrome-'))
  const isolated = await openRuntime(root)
  try {
    await isolated.install({ profile: 'local' })
    await page.goto((await isolated.start()).endpoint! + '/?settings=models')
    await page.getByRole('button', { name: '添加供应商', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('多模型与思考强度')
    await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl)
    await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-multi-model-key')
    await addModel(page, 'gpt-5.2')
    await dialog.getByRole('combobox', { name: '模型 ID的默认思考强度', exact: true }).click()
    await dialog.getByRole('option', { name: '高 · high', exact: true }).click()
    await dialog.getByRole('textbox', { name: '搜索或输入模型 ID', exact: true }).fill('custom-orbit-model')
    await dialog.getByRole('button', { name: '添加模型', exact: true }).click()
    await dialog.getByRole('combobox', { name: '模型 ID 2的默认思考强度', exact: true }).click()
    await expect(dialog.getByRole('option')).toHaveCount(1)
    await dialog.getByRole('combobox', { name: '模型 ID 2的默认思考强度', exact: true }).press('Escape')
    await expect(dialog.getByText('方言', { exact: true })).toHaveCount(0)
    await expect(dialog.getByText('参数模式', { exact: true })).toHaveCount(0)
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeHidden()
    const card = page.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: '多模型与思考强度' })
    const providerSwitch = card.getByRole('switch', { name: '启用供应商 多模型与思考强度', exact: true })
    const first = card.getByRole('switch', { name: '启用模型 gpt-5.2', exact: true })
    const second = card.getByRole('switch', { name: '启用模型 custom-orbit-model', exact: true })
    await second.click(); await expect(second).not.toBeChecked(); await expect(second).toBeEnabled()
    await providerSwitch.click(); await expect(providerSwitch).not.toBeChecked(); await expect(providerSwitch).toBeEnabled()
    await expect(first).toBeChecked(); await expect(second).not.toBeChecked()
    for (const button of await card.getByRole('button', { name: '模型测试', exact: true }).all()) await expect(button).toBeDisabled()
    await providerSwitch.click(); await expect(providerSwitch).toBeChecked(); await expect(providerSwitch).toBeEnabled()
    await expect(first).toBeChecked(); await expect(second).not.toBeChecked()
    const before = calls
    await card.locator('.st-configured-model').filter({ hasText: 'gpt-5.2' }).getByRole('button', { name: '模型测试', exact: true }).click()
    await expect.poll(() => calls).toBe(before + 1)
    expect(payloads.at(-1)).toMatchObject({ model: 'gpt-5.2', reasoning_effort: 'high' })
    await card.getByRole('button', { name: '编辑', exact: true }).click()
    await dialog.getByRole('button', { name: '展开 gpt-5.2 的配置', exact: true }).click()
    await expect(dialog.getByRole('combobox', { name: '模型 ID的默认思考强度', exact: true })).toHaveText('高 · high')
    await expect(dialog.getByLabel('API Key', { exact: true })).toHaveAttribute('type', 'password')
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await page.reload(); await expect(first).toBeChecked(); await expect(second).not.toBeChecked()
  } finally { await isolated.stop(); await rm(root, { recursive: true, force: true }) }
})
