import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir, release } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime'

test.skip(!process.env.XUNJIE_PRODUCT_POSTGRES_BIN, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
test.setTimeout(120000)
type Runtime = Pick<ReturnType<typeof openProductRuntime>, 'install' | 'start' | 'stop'>
const output = fileURLToPath(new URL('../../../.verification/167', import.meta.url))
let school: Runtime, device: Runtime, schoolEndpoint = '', deviceEndpoint = '', schoolCookie = '', connectionKey = '', baseUrl = '', browserVersion = ''
const cases: { title: string; status?: string; duration: number }[] = []
const upstream = createServer(async (request, response) => {
  const parts = []; for await (const chunk of request) parts.push(chunk)
  const input = JSON.parse(Buffer.concat(parts).toString('utf8'))
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const send = (value: { type: string; [field: string]: unknown }) => response.write('event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n')
  send({ type: 'message_start', message: { id: 'ui-message', type: 'message', role: 'assistant', model: input.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } })
  send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Messages 检查正常' } })
  if (input.model === 'fixture-messages-cancel') return
  send({ type: 'content_block_stop', index: 0 })
  send({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { input_tokens: 7, output_tokens: 4 } })
  send({ type: 'message_stop' }); response.end()
})
test.beforeAll(async ({ browser }) => {
  browserVersion = browser.version(); await mkdir(output, { recursive: true })
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done))
  baseUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/anthropic`
  const open = async (root: string): Promise<Runtime> => {
    if (!process.env.XUNJIE_PRODUCT_TEST_PACKAGE) return openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6',
      postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
      windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
    const product = resolve(process.env.XUNJIE_PRODUCT_TEST_PACKAGE), resources = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'))
    const execute = promisify(execFile)
    const run = async (command: string, args: string[] = []) => JSON.parse((await execute(resolve(product, resources.nodePath),
      [join(product, 'app/cli.js'), command, '--root', root, ...args], { windowsHide: true, timeout: 180000 })).stdout)
    return { install: input => run('install', ['--profile', input?.profile ?? 'local']), start: () => run('start'), stop: () => run('stop') }
  }
  const schoolRoot = await mkdtemp(join(tmpdir(), 'xj-messages-ui-school-'))
  school = await open(schoolRoot); await school.install({ profile: 'school' }); schoolEndpoint = (await school.start()).endpoint!
  device = await open(await mkdtemp(join(tmpdir(), 'xj-messages-ui-device-'))); await device.install({ profile: 'local' }); deviceEndpoint = (await device.start()).endpoint!
  const call = async (endpoint: string, route: string, body: unknown, headers = {}) => {
    const response = await fetch(endpoint + '/api/learning/' + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    expect(response.status).toBe(200); return { value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const admin = { authorization: 'Bearer ' + await resolveCredential(schoolRoot, 'control') }, password = randomUUID()
  await call(schoolEndpoint, 'manage/members', { requestId: randomUUID(), loginName: 'messages-ui', password }, admin)
  schoolCookie = (await call(schoolEndpoint, 'login', { loginName: 'messages-ui', password })).cookie!
  const config = (name: string) => ({ connectionId: randomUUID(), requestId: randomUUID(), expectedVersion: 0, name, protocol: 'messages', baseUrl, path: '/v1/messages',
    modelId: 'deepseek-flash', dialect: 'deepseek', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: 'synthetic-messages-ui-key' } })
  await call(schoolEndpoint, 'manage/model-default', { ...config('学校 Messages 默认'), policy: { checksAllowed: true, maxChecksPerHour: 4, maxOutputTokens: 64, timeoutMs: 10000 } }, admin)
  await call(deviceEndpoint, 'models/connections', config('本机 Messages 连接'), { 'x-xj-space': 'personal' })
  const pending = await call(deviceEndpoint, 'client/start', { requestId: randomUUID(), schoolEndpoint })
  await call(schoolEndpoint, 'connections/approve', { requestId: pending.value.requestId }, { cookie: schoolCookie })
  await call(deviceEndpoint, 'client/complete', { requestId: pending.value.requestId }); connectionKey = 'school:' + pending.value.requestId
})
test.afterEach(async ({}, info) => { cases.push({ title: info.title, ...(info.status ? { status: info.status } : {}), duration: info.duration }) })
test.afterAll(async ({}, info) => {
  await device?.stop(); await school?.stop(); upstream.closeAllConnections(); await new Promise<void>(done => upstream.close(() => done()))
  await writeFile(join(output, 'messages-chrome-' + process.platform + '.json'), JSON.stringify({ platform: process.platform, os: release(), browser: 'installed Chrome', browserVersion,
    headless: info.project.use.headless !== false, measuredAt: new Date().toISOString(), cases }, null, 2))
})
test('Messages formal draft check save reopen and cancel use the production owner', async ({ page }) => {
  await page.goto(deviceEndpoint + '/?settings=models'); await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('Messages 正式连接')
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl)
  await dialog.getByRole('textbox', { name: '模型 ID', exact: true }).fill('deepseek-flash')
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-messages-ui-key')
  await dialog.getByLabel('协议', { exact: true }).selectOption('messages')
  await dialog.getByLabel('方言', { exact: true }).selectOption('deepseek')
  const check = dialog.getByRole('button', { name: '保存前检查', exact: true })
  if (process.env.XUNJIE_CAPTURE_BEFORE === '1') await page.screenshot({ path: join(output, 'messages-settings-before-win.png'), fullPage: true })
  await expect(check).toBeEnabled(); await check.click(); await expect(dialog.getByRole('status')).toContainText('检查已完成')
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0)
  await page.screenshot({ path: join(output, 'messages-settings-after-win.png'), fullPage: true })
  await dialog.getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog).toBeHidden(); await page.reload()
  const card = page.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: 'Messages 正式连接' })
  await card.getByRole('button', { name: '连接检查', exact: true }).click(); await expect(page.getByText('Messages 检查正常', { exact: true })).toHaveCount(2)
  await card.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(dialog.getByLabel('协议', { exact: true })).toHaveValue('messages'); await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('')
  await dialog.getByRole('textbox', { name: '模型 ID', exact: true }).fill('fixture-messages-cancel')
  await dialog.getByRole('button', { name: '保存', exact: true }).click(); await card.getByRole('button', { name: '连接检查', exact: true }).click()
  await expect(page.getByText('正在检查', { exact: true })).toBeVisible(); await page.getByRole('button', { name: '停止检查', exact: true }).click()
  await expect(page.getByText('已停止本机检查', { exact: true })).toBeVisible()
})
test('Messages school identity and device selection stay isolated when returning to personal space', async ({ page }) => {
  const [name, value] = schoolCookie.split('='); await page.context().addCookies([{ name, value, url: schoolEndpoint }])
  await page.goto(schoolEndpoint + '/?settings=models')
  const choices = page.getByRole('region', { name: '当前空间模型', exact: true })
  await expect(choices.getByText('学校 Messages 默认', { exact: true })).toBeVisible()
  await choices.getByRole('button', { name: '检查当前模型', exact: true }).click()
  await expect(page.getByText('检查已完成', { exact: true }).first()).toBeVisible()
  await page.goto(deviceEndpoint + '/?settings=models&space=' + encodeURIComponent(connectionKey))
  const personal = choices.locator('.st-provider').filter({ hasText: '本机 Messages 连接' })
  await personal.getByRole('button', { name: '授权并选用', exact: true }).click(); await expect(choices.getByText('使用个人费用', { exact: true })).toBeVisible()
  await choices.getByRole('button', { name: '检查当前模型', exact: true }).click(); await expect(page.getByText('检查已完成', { exact: true }).first()).toBeVisible()
  await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 720, height: 900 })
  await page.getByRole('heading', { name: '个人模型设置', exact: true }).scrollIntoViewIfNeeded()
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0)
  await page.screenshot({ path: join(output, 'messages-device-dark-narrow-win.png'), fullPage: true })
  await page.getByRole('button', { name: '个人空间', exact: true }).click()
  await expect(choices.getByText('学校 Messages 默认', { exact: true })).toHaveCount(0); await expect(choices.getByText('未选用模型', { exact: true })).toBeVisible()
})
test('unsupported Command Code Messages remains configurable but cannot send a model check', async ({ page }) => {
  await page.goto(deviceEndpoint + '/?settings=models'); await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('不支持的 Messages 路线')
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill('https://api.commandcode.ai/provider')
  await dialog.getByRole('textbox', { name: '模型 ID', exact: true }).fill('deepseek/deepseek-v4.1-flash')
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-no-network-key')
  await dialog.getByLabel('协议', { exact: true }).selectOption('messages'); await dialog.getByLabel('方言', { exact: true }).selectOption('command-code')
  await dialog.getByRole('button', { name: '保存前检查', exact: true }).click(); await expect(dialog.getByRole('alert')).toBeVisible()
  await dialog.getByRole('button', { name: '保存', exact: true }).click(); await expect(dialog).toBeHidden()
  const card = page.getByRole('region', { name: '个人连接配置', exact: true }).locator('.st-provider').filter({ hasText: '不支持的 Messages 路线' })
  await expect(card.getByText('该目标路线不支持所选协议', { exact: true })).toBeVisible(); await expect(card.getByRole('button', { name: '连接检查', exact: true })).toBeDisabled()
})
