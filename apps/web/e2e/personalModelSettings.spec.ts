import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProductRuntime } from '@xunjie/product-runtime'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
let runtime: ReturnType<typeof openProductRuntime>, endpoint: string, baseUrl: string
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
  runtime = openProductRuntime({ root: await mkdtemp(join(tmpdir(), 'xj-models-chrome-')), resources: {
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
