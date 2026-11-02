import { test, expect } from '@playwright/test'
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
test.skip(!postgresBin, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
let runtime: Pick<ReturnType<typeof openProductRuntime>, 'install' | 'start' | 'stop'>, endpoint: string, baseUrl: string
let calls = 0
const upstream = createServer(async (_request, response) => {
  calls++
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.end('data: ' + JSON.stringify({ id: 'check-ui', choices: [{ index: 0, delta: { content: '检查正常' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
})
test.beforeAll(async () => {
  await mkdir(fileURLToPath(new URL('../../../.verification/164', import.meta.url)), { recursive: true })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`
  const root = await mkdtemp(join(tmpdir(), 'xj-models-chrome-'))
  if (process.env.XUNJIE_PRODUCT_TEST_PACKAGE) {
    const product = resolve(process.env.XUNJIE_PRODUCT_TEST_PACKAGE)
    const resources = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'))
    const execute = promisify(execFile)
    const run = async (command: string, args: string[] = []) => JSON.parse((await execute(resolve(product, resources.nodePath),
      [join(product, 'app/cli.js'), command, '--root', root, ...args], { windowsHide: true, timeout: 180000 })).stdout)
    runtime = { install: input => run('install', ['--profile', input.profile]), start: () => run('start'), stop: () => run('stop') }
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
  await expect(page.getByText('本人的测试服务', { exact: true })).toBeVisible()
  await expect(page.getByText('密钥已保存', { exact: true })).toBeVisible()
  expect(calls).toBe(0)
  await page.reload()
  await expect(page.getByText('本人的测试服务', { exact: true })).toBeVisible()
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
    await expect(page.getByText('等待时继续填写 B', { exact: true })).toBeVisible()
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
  const card = page.locator('.st-provider').filter({ hasText: '本人的测试服务' })
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  await dialog.getByLabel('API Key', { exact: true }).fill('   ')
  await dialog.getByRole('button', { name: '保存前检查', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('检查已完成')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '首页', exact: true }).click()
  await expect(page.getByRole('heading', { name: '个人模型设置', exact: true })).toBeHidden()
})
