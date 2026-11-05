import { test, expect, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProductRuntime } from '@xunjie/product-runtime'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
const reviewScreenshots = fileURLToPath(new URL('../../../.verification/pr177', import.meta.url))
test.skip(!postgresBin, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
let runtime: Pick<ReturnType<typeof openProductRuntime>, 'install' | 'start' | 'stop'>, endpoint: string, baseUrl: string
let calls = 0
const upstream = createServer(async (request, response) => {
  calls++
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (request.url === '/v1/responses') {
    const chunks = []; for await (const chunk of request) chunks.push(chunk)
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
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
test.beforeAll(async () => {
  await mkdir(fileURLToPath(new URL('../../../.verification/164', import.meta.url)), { recursive: true })
  await mkdir(reviewScreenshots, { recursive: true })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`
  const root = await mkdtemp(join(tmpdir(), 'xj-models-chrome-'))
  if (process.env.XUNJIE_PRODUCT_TEST_PACKAGE) {
    const product = resolve(process.env.XUNJIE_PRODUCT_TEST_PACKAGE)
    const resources = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'))
    const execute = promisify(execFile)
    const run = async (command: string, args: string[] = []) => JSON.parse((await execute(resolve(product, resources.nodePath),
      [join(product, 'app/cli.js'), command, '--root', root, ...args], { windowsHide: true, timeout: 180000 })).stdout)
    runtime = { install: input => run('install', ['--profile', input?.profile ?? 'local']), start: () => run('start'), stop: () => run('stop') }
  } else runtime = openProductRuntime({ root, resources: {
    nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
  await runtime.install({ profile: 'local' }); endpoint = (await runtime.start()).endpoint!
})
test.afterAll(async () => { await runtime?.stop(); upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) })

test('formal model settings save and reopen a personal connection without a legacy session', async ({ page }) => {
  await page.goto(endpoint)
  if (await page.getByRole('button', { name: '模型设置', exact: true }).count() === 0)
    await page.screenshot({ path: fileURLToPath(new URL('../../../.verification/164/before-model-settings.png', import.meta.url)), fullPage: true })
  await page.getByRole('button', { name: '模型设置', exact: true }).click()
  await expect(page.getByRole('heading', { name: '个人模型设置', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('本人的测试服务')
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl)
  await dialog.getByRole('textbox', { name: '模型 ID', exact: true }).fill('known-model-without-catalog')
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-private-ui-key')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('region', { name: '个人连接配置', exact: true }).getByText('本人的测试服务', { exact: true })).toBeVisible()
  await expect(page.getByText('密钥已保存', { exact: true })).toBeVisible()
  expect(calls).toBe(0)
  await page.reload()
  await expect(page.getByRole('region', { name: '个人连接配置', exact: true }).getByText('本人的测试服务', { exact: true })).toBeVisible()
  expect(calls).toBe(0)
  await page.getByRole('button', { name: '连接检查', exact: true }).click()
  await expect(page.getByText('检查已完成', { exact: true })).toBeVisible()
  expect(calls).toBe(1)
  await expect(page.getByText('用量未知', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('')
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.screenshot({ path: fileURLToPath(new URL('../../../.verification/164/after-model-settings-light.png', import.meta.url)), fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 720, height: 900 })
  await page.screenshot({ path: fileURLToPath(new URL('../../../.verification/164/after-model-settings-dark-narrow.png', import.meta.url)), fullPage: true })
})

test('a delayed save confirmation preserves later form input and its next versioned save', async ({ page }) => {
  await page.goto(endpoint + '/?settings=models')
  await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('先提交 A')
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl)
  await dialog.getByRole('textbox', { name: '模型 ID', exact: true }).fill('known-form-model')
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-first-key')
  let release!: () => void, committed!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const reached = new Promise<void>(resolve => { committed = resolve })
  await page.route('**/api/learning/models/connections', async route => {
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
  } finally { release(); await page.unroute('**/api/learning/models/connections') }
})

test('dialog keyboard focus, Chinese composition, blank-key reuse and ordinary navigation remain usable', async ({ page }) => {
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
  await page.screenshot({ path: fileURLToPath(new URL('../../../.verification/164/model-dialog-keyboard.png', import.meta.url)), fullPage: true })
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(add).toBeFocused()
  const card = page.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: '本人的测试服务' })
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  await dialog.getByLabel('API Key', { exact: true }).fill('   ')
  await dialog.getByRole('button', { name: '保存前检查', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('检查已完成')
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
  await dialog.getByRole('textbox', { name: '模型 ID', exact: true }).fill('fixture-responses')
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-responses-ui-key')
  await dialog.getByLabel('协议', { exact: true }).selectOption('responses')
  const check = dialog.getByRole('button', { name: '保存前检查', exact: true })
  await expect(check).toBeEnabled()
  await check.click()
  await expect(dialog.getByRole('status')).toContainText('检查已完成')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.reload()
  const card = page.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: 'Responses 正式连接' })
  await expect(card.getByText('responses · 版本 1', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: '连接检查', exact: true }).click()
  await expect(page.getByText('Responses 检查正常', { exact: true })).toHaveCount(2)
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(dialog.getByLabel('协议', { exact: true })).toHaveValue('responses')
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('')
  await dialog.getByRole('textbox', { name: '模型 ID', exact: true }).fill('fixture-responses-cancel')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  expect(await card.textContent()).toContain('responses · 版本 2')
  await expect(card.getByText('responses · 版本 2', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: '连接检查', exact: true }).click()
  await expect(page.getByText('正在检查', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '停止检查', exact: true }).click()
  await expect(page.getByText('已停止本机检查', { exact: true })).toBeVisible()
  await page.screenshot({ path: fileURLToPath(new URL('../../../.verification/164/responses-settings.png', import.meta.url)), fullPage: true })
})

async function createRecoveryConnection(page: Page, name: string) {
  await page.goto(endpoint + '/?settings=models')
  await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill(name)
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl)
  await dialog.getByRole('textbox', { name: '模型 ID', exact: true }).fill('synthetic-recovery-model')
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-recovery-key')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  return page.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: name })
}

test('rejected connection actions remain visible across successful polls until that action succeeds', async ({ page }) => {
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
    await page.screenshot({ path: join(reviewScreenshots, 'action-before.png'), fullPage: true })
    await card.getByRole('button', { name: '连接检查', exact: true }).click()
    const failure = page.getByRole('alert').filter({ hasText: '检查频次或并发已达上限' })
    await expect(failure).toBeVisible()
    const afterFailure = polls
    await expect.poll(() => polls).toBeGreaterThanOrEqual(afterFailure + 2)
    await page.getByRole('button', { name: '重新读取配置', exact: true }).click()
    await expect(failure).toBeVisible()
    await page.screenshot({ path: join(reviewScreenshots, 'action-error-after-two-polls.png'), fullPage: true })
    denied = false
    await card.getByRole('button', { name: '连接检查', exact: true }).click()
    await expect(failure).toBeHidden()
    await expect(page.getByText('轮询错误回归 · synthetic-recovery-model', { exact: true })).toBeVisible()
    await page.screenshot({ path: join(reviewScreenshots, 'action-retry-confirmed.png'), fullPage: true })
  } finally { await page.unroute('**/api/learning/models/checks') }
})

for (const credential of ['keep', 'replace', 'clear'] as const) {
  test(`two tabs explicitly reconcile CAS while preserving the draft and ${credential} credential intent`, async ({ page, context }) => {
    const title = '双标签冲突-' + credential
    const card = await createRecoveryConnection(page, title)
    await card.getByRole('button', { name: '编辑', exact: true }).click()
    const dialog = page.getByRole('dialog')
    await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill(title + '-本人草稿')
    if (credential === 'replace') await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-replacement-key')
    if (credential === 'clear') await dialog.getByLabel('清除已保存密钥', { exact: true }).check()
    const other = await context.newPage()
    const submissions: { requestId: string; expectedVersion: number; credential: { action: string } }[] = []
    await page.route('**/api/learning/models/connections', async route => {
      if (route.request().method() === 'POST') submissions.push(route.request().postDataJSON())
      await route.continue()
    })
    try {
      await page.screenshot({ path: join(reviewScreenshots, `cas-${credential}-before.png`), fullPage: true })
      await other.goto(endpoint + '/?settings=models')
      await other.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: title })
        .getByRole('button', { name: '编辑', exact: true }).click()
      const remote = other.getByRole('dialog')
      await remote.getByRole('textbox', { name: '连接名称', exact: true }).fill(title + '-其他标签')
      await remote.getByRole('textbox', { name: '模型 ID', exact: true }).fill('other-tab-model')
      await remote.getByRole('button', { name: '保存', exact: true }).click()
      await expect(remote).toBeHidden()
      // Radix marks the background aria-hidden while this dialog is open.
      await expect(page.locator('[aria-label="个人连接配置"]').getByText(title + '-其他标签', { exact: true })).toHaveCount(1)
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect(dialog.getByRole('alert')).toContainText('版本冲突')
      await page.screenshot({ path: join(reviewScreenshots, `cas-${credential}-conflict.png`), fullPage: true })
      await dialog.getByRole('button', { name: '读取最新版本', exact: true }).click()
      const comparison = dialog.getByRole('region', { name: '配置冲突核对', exact: true })
      await expect(comparison).toContainText('已保存版本 2')
      await expect(comparison).toContainText('other-tab-model')
      await expect(dialog.getByRole('textbox', { name: '连接名称', exact: true })).toHaveValue(title + '-本人草稿')
      await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue(credential === 'replace' ? 'synthetic-replacement-key' : '')
      if (credential === 'clear') await expect(dialog.getByLabel('清除已保存密钥', { exact: true })).toBeChecked()
      await page.screenshot({ path: join(reviewScreenshots, `cas-${credential}-compare.png`), fullPage: true })
      expect(submissions).toHaveLength(1)
      await dialog.getByRole('button', { name: '确认按当前草稿重试', exact: true }).click()
      await expect(dialog).toBeHidden()
      expect(submissions.map(input => input.expectedVersion)).toEqual([1, 2])
      expect(submissions[1].requestId).not.toBe(submissions[0].requestId)
      expect(submissions[1].credential.action).toBe(credential)
      const saved = page.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: title + '-本人草稿' })
      await expect(saved.getByText('chat-completions · 版本 3', { exact: true })).toBeVisible()
      await expect(saved.getByText(credential === 'clear' ? '尚未保存密钥' : '密钥已保存', { exact: true })).toBeVisible()
      await page.screenshot({ path: join(reviewScreenshots, `cas-${credential}-recovered.png`), fullPage: true })
    } finally { await other.close(); await page.unroute('**/api/learning/models/connections') }
  })
}

test('a lost save ACK is reconciled by the identical POST before submitting later edits', async ({ page }) => {
  const card = await createRecoveryConnection(page, '未知保存回归')
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('未知保存-原提交')
  const submissions: string[] = []
  await page.route('**/api/learning/models/connections', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    submissions.push(route.request().postData()!)
    // route.fetch commits through the real owner/PG; only the browser ACK is lost.
    const response = await route.fetch()
    if (submissions.length === 1) { expect(response.ok()).toBe(true); await route.abort('failed'); return }
    await route.fulfill({ response })
  })
  try {
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog.getByRole('alert')).toContainText('保存结果尚未确认')
    await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('未知保存-后续草稿')
    await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-next-key')
    await expect(dialog.getByRole('button', { name: '保存', exact: true })).toBeDisabled()
    await page.screenshot({ path: join(reviewScreenshots, 'unknown-ack-draft-preserved.png'), fullPage: true })
    await dialog.getByRole('button', { name: '核对原提交', exact: true }).click()
    await expect(dialog.getByRole('status')).toContainText('原提交已确认')
    expect(submissions[1]).toBe(submissions[0])
    await expect(dialog.getByRole('textbox', { name: '连接名称', exact: true })).toHaveValue('未知保存-后续草稿')
    await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('synthetic-next-key')
    await page.screenshot({ path: join(reviewScreenshots, 'unknown-ack-confirmed.png'), fullPage: true })
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeHidden()
    expect(submissions.map(input => JSON.parse(input).expectedVersion)).toEqual([1, 1, 2])
    const saved = page.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: '未知保存-后续草稿' })
    await expect(saved.getByText('chat-completions · 版本 3', { exact: true })).toBeVisible()
    await page.screenshot({ path: join(reviewScreenshots, 'unknown-ack-recovered.png'), fullPage: true })
  } finally { await page.unroute('**/api/learning/models/connections') }
})
