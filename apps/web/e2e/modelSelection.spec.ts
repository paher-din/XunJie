import { evidenceDirectory } from './evidence'
import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime'
import { selectProductSpace } from './support/product-ui'

test.skip(!process.env.XUNJIE_PRODUCT_POSTGRES_BIN, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
const output = evidenceDirectory('165')
let school: Pick<ReturnType<typeof openProductRuntime>, 'install' | 'start' | 'stop'>, device: typeof school
let schoolEndpoint = '', deviceEndpoint = '', schoolCookie = '', connectionKey = '', browserVersion = ''
const roots: string[] = []
const cases: { title: string; status?: string; duration: number }[] = []
test.beforeAll(async ({ browser }) => {
  browserVersion = browser.version(); if (output) await mkdir(output, { recursive: true })
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6', postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
    webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) }
  const schoolRoot = await mkdtemp(join(tmpdir(), 'xj-model-choice-school-')); roots.push(schoolRoot)
  const open = async (root: string): Promise<typeof school> => {
    if (!process.env.XUNJIE_PRODUCT_TEST_PACKAGE) return openProductRuntime({ root, resources })
    const product = resolve(process.env.XUNJIE_PRODUCT_TEST_PACKAGE), packaged = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'))
    const execute = promisify(execFile)
    const run = async (command: string, args: string[] = []) => JSON.parse((await execute(resolve(product, packaged.nodePath),
      [join(product, 'app/cli.js'), command, '--root', root, ...args], { windowsHide: true, timeout: 180000 })).stdout)
    return { install: input => run('install', ['--profile', input?.profile ?? 'local']), start: () => run('start'), stop: () => run('stop') }
  }
  school = await open(schoolRoot); await school.install({ profile: 'school' }); schoolEndpoint = (await school.start()).endpoint!
  const deviceRoot = await mkdtemp(join(tmpdir(), 'xj-model-choice-device-')); roots.push(deviceRoot)
  device = await open(deviceRoot)
  await device.install({ profile: 'local' }); deviceEndpoint = (await device.start()).endpoint!
  const call = async (endpoint: string, route: string, body: unknown, headers = {}) => {
    const response = await fetch(endpoint + '/api/learning/' + route, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    expect(response.status).toBe(200); return { value: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const admin = { authorization: 'Bearer ' + await resolveCredential(schoolRoot, 'control') }
  const password = randomUUID()
  await call(schoolEndpoint, 'manage/members', { requestId: randomUUID(), loginName: 'model-choice-ui', password }, admin)
  schoolCookie = (await call(schoolEndpoint, 'login', { loginName: 'model-choice-ui', password })).cookie!
  const config = (name: string) => ({ requestId: randomUUID(), connectionId: randomUUID(), expectedVersion: 0, name,
    // Configuration only: a public literal satisfies server target policy without DNS or provider dispatch.
    protocol: 'chat-completions', baseUrl: 'https://1.1.1.1/v1', path: '/chat/completions', modelId: 'synthetic',
    dialect: 'standard', parameterMode: 'plain', enabled: true, credential: { action: 'replace', value: 'synthetic-ui-only' } })
  await call(schoolEndpoint, 'manage/model-default', { ...config('学校默认服务'), policy: { checksAllowed: true, maxChecksPerHour: 4, maxOutputTokens: 64, timeoutMs: 10000 } }, admin)
  await call(schoolEndpoint, 'models/connections', config('本人的学校网页连接'), { cookie: schoolCookie })
  await call(deviceEndpoint, 'models/connections', config('本机一次配置的连接'), { 'x-xj-space': 'personal' })
  const pending = await call(deviceEndpoint, 'client/start', { requestId: randomUUID(), schoolEndpoint })
  await call(schoolEndpoint, 'connections/approve', { requestId: pending.value.requestId }, { cookie: schoolCookie })
  await call(deviceEndpoint, 'client/complete', { requestId: pending.value.requestId })
  connectionKey = 'school:' + pending.value.requestId
})
test.afterEach(async ({}, info) => { cases.push({ title: info.title, ...(info.status ? { status: info.status } : {}), duration: info.duration }) })
test.afterAll(async ({}, info) => {
  await device?.stop(); await school?.stop()
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  if (output) await writeFile(join(output, 'selection-chrome-' + process.platform + '.json'), JSON.stringify({ platform: process.platform, os: release(),
    browser: 'installed Chrome', browserVersion, headless: info.project.use.headless !== false, measuredAt: new Date().toISOString(), cases }, null, 2))
})
async function openPersonalSpaceSettings(page: Page) {
  const toggle = page.getByRole('button', { name: '切换边栏', exact: true })
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click()
  await selectProductSpace(page, '个人空间')
  const settings = page.getByRole('button', { name: '设置与帮助', exact: true })
  if (!await settings.isVisible()) await page.getByRole('button', { name: '切换边栏' }).click()
  await settings.click()
  await page.getByRole('button', { name: '模型', exact: true }).click()
}
async function chooseModel(page: Page, provider: string) {
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  const option = page.getByRole('menuitemradio').filter({ hasText: provider })
  await expect(option).toBeVisible()
  const receipt = page.waitForResponse(response => response.url().endsWith('/models/selection') && response.request().method() === 'POST')
  await option.click()
  const response = await receipt
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toBeEnabled()
  return response
}
async function expectSelected(page: Page, provider: string) {
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await expect(page.getByRole('menuitemradio').filter({ hasText: provider })).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press('Escape')
}

test('configured personal models are selected directly and the school appears as a supplier', async ({ page }) => {
  const [name, value] = schoolCookie.split('=')
  await page.context().addCookies([{ name, value, url: schoolEndpoint }])
  const grants: string[] = []
  page.on('request', request => { if (request.url().includes('/models/grants')) grants.push(request.url()) })
  await page.goto(schoolEndpoint + '/?settings=models')
  await expect(page.getByRole('button', { name: '添加供应商', exact: true })).toBeVisible()
  await expect(page.getByRole('region', { name: '当前空间模型', exact: true })).toHaveCount(0)
  await expect(page.locator('.st-provider').filter({ hasText: '学校提供' })).toContainText('synthetic')
  await expect(page.locator('.st-provider').filter({ hasText: '本人的学校网页连接' })).toBeVisible()
  await expect(page.getByText(/跨空间使用需单独授权/)).toHaveCount(0)
  await page.getByRole('button', { name: '返回学习空间', exact: true }).click()
  await page.getByRole('button', { name: 'Agent 对话', exact: true }).click()
  const response = await chooseModel(page, '本人的学校网页连接')
  expect(response.status()).toBe(200)
  expect(response.request().postDataJSON().source).toMatchObject({ kind: 'personal', owner: 'self' })
  expect(response.request().postDataJSON().source.grantId).toBeUndefined()
  await expectSelected(page, '本人的学校网页连接')
  await page.reload()
  await expectSelected(page, '本人的学校网页连接')
  expect(grants).toHaveLength(0)
})

test('device models can be chosen in school conversations without grants and space choices stay separate', async ({ page }) => {
  const grants: string[] = []
  page.on('request', request => { if (request.url().includes('/models/grants')) grants.push(request.url()) })
  await page.goto(deviceEndpoint + '/?view=agent&space=' + encodeURIComponent(connectionKey))
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  const option = page.getByRole('menuitemradio').filter({ hasText: '本机一次配置的连接' })
  await expect(option).toBeVisible()
  await option.focus(); await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: '切换模型', exact: true })).toBeEnabled()
  await expectSelected(page, '本机一次配置的连接')
  await page.reload()
  await expectSelected(page, '本机一次配置的连接')
  await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 720, height: 900 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await openPersonalSpaceSettings(page)
  await expect(page.locator('.st-provider').filter({ hasText: '学校提供' })).toHaveCount(0)
  await expect(page.locator('.st-provider').filter({ hasText: '本机一次配置的连接' })).toBeVisible()
  expect(grants).toHaveLength(0)
})

test('a late selection receipt does not replace a new personal-space view or its input', async ({ page }) => {
  await page.goto(deviceEndpoint + '/?view=agent&space=' + encodeURIComponent(connectionKey))
  let release!: () => void, committed!: () => void
  const hold = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { committed = resolve })
  await page.route('**/api/learning/models/selection', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    const response = await route.fetch(); committed(); await hold; await route.fulfill({ response })
  })
  try {
    await page.getByRole('button', { name: '切换模型', exact: true }).click()
    await page.getByRole('menuitemradio').filter({ hasText: '学校' }).click(); await reached
    await openPersonalSpaceSettings(page)
    await page.getByRole('button', { name: '添加供应商', exact: true }).click()
    const name = page.getByRole('dialog').getByRole('textbox', { name: '连接名称', exact: true })
    await name.fill('新空间继续填写的中文输入'); release()
    await expect(name).toHaveValue('新空间继续填写的中文输入')
    await expect(page.getByRole('region', { name: '当前空间模型', exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '添加供应商', exact: true })).toBeFocused()
  } finally { release(); await page.unroute('**/api/learning/models/selection') }
})

test('a selection conflict can be retried from the model menu', async ({ page }) => {
  const headers = { 'x-xj-space': connectionKey }
  const initial = await (await page.request.get(deviceEndpoint + '/api/learning/models/selection', { headers })).json()
  const school = initial.options.find((choice: { kind: string }) => choice.kind === 'school')
  expect((await page.request.post(deviceEndpoint + '/api/learning/models/selection', { headers,
    data: { requestId: randomUUID(), expectedVersion: initial.version, source: { kind: 'school', connectionId: school.connection.connectionId } } })).status()).toBe(200)
  await page.goto(deviceEndpoint + '/?view=agent&space=' + encodeURIComponent(connectionKey))
  await expectSelected(page, '学校')
  const current = await (await page.request.get(deviceEndpoint + '/api/learning/models/selection', { headers })).json()
  const advanced = await page.request.post(deviceEndpoint + '/api/learning/models/selection', { headers,
    data: { requestId: randomUUID(), expectedVersion: current.version, source: { kind: 'school', connectionId: current.selected.connection.connectionId } } })
  expect(advanced.status()).toBe(200)
  const conflict = await chooseModel(page, '本机一次配置的连接')
  expect(conflict.status()).toBe(409)
  await expect(page.getByRole('alert')).toContainText('选用记录已变化')
  const retried = await chooseModel(page, '本机一次配置的连接')
  expect(retried.status()).toBe(200)
  await expectSelected(page, '本机一次配置的连接')
})
