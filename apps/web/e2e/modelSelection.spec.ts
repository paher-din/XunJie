import { evidenceDirectory } from './evidence'
import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
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
const cases: { title: string; status?: string; duration: number }[] = []
test.beforeAll(async ({ browser }) => {
  browserVersion = browser.version(); if (output) await mkdir(output, { recursive: true })
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6', postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN,
    webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) }
  const schoolRoot = await mkdtemp(join(tmpdir(), 'xj-model-choice-school-'))
  const open = async (root: string): Promise<typeof school> => {
    if (!process.env.XUNJIE_PRODUCT_TEST_PACKAGE) return openProductRuntime({ root, resources })
    const product = resolve(process.env.XUNJIE_PRODUCT_TEST_PACKAGE), packaged = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'))
    const execute = promisify(execFile)
    const run = async (command: string, args: string[] = []) => JSON.parse((await execute(resolve(product, packaged.nodePath),
      [join(product, 'app/cli.js'), command, '--root', root, ...args], { windowsHide: true, timeout: 180000 })).stdout)
    return { install: input => run('install', ['--profile', input?.profile ?? 'local']), start: () => run('start'), stop: () => run('stop') }
  }
  school = await open(schoolRoot); await school.install({ profile: 'school' }); schoolEndpoint = (await school.start()).endpoint!
  device = await open(await mkdtemp(join(tmpdir(), 'xj-model-choice-device-')))
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
  if (output) await writeFile(join(output, 'selection-chrome-' + process.platform + '.json'), JSON.stringify({ platform: process.platform, os: release(),
    browser: 'installed Chrome', browserVersion, headless: info.project.use.headless !== false, measuredAt: new Date().toISOString(), cases }, null, 2))
})
async function openPersonalSpaceSettings(page: Page) {
  await selectProductSpace(page, '个人空间')
  const settings = page.getByRole('button', { name: '设置与帮助', exact: true })
  if (!await settings.isVisible()) await page.getByRole('button', { name: '切换边栏' }).click()
  await settings.click()
  await page.getByRole('button', { name: '模型', exact: true }).click()
}
test('school website explicitly selects and revokes a personal model and preserves learning without a model', async ({ page }) => {
  const [name, value] = schoolCookie.split('=')
  await page.context().addCookies([{ name, value, url: schoolEndpoint }])
  await page.goto(schoolEndpoint + '/?settings=models')
  await expect(page.getByRole('heading', { name: '个人模型配置', exact: true })).toBeVisible()
  if (process.env.XUNJIE_CAPTURE_BEFORE === '1' && output) await page.screenshot({ path: join(output, 'before-school-model-selection.png'), fullPage: true })
  const choices = page.getByRole('region', { name: '当前空间模型', exact: true })
  await expect(choices).toBeVisible()
  await expect(choices.getByText('学校默认服务', { exact: true })).toBeVisible()
  await expect(choices.getByText('使用学校额度', { exact: true })).toBeVisible()
  const personal = choices.locator('.st-provider').filter({ hasText: '本人的学校网页连接' })
  await personal.getByRole('button', { name: '授权并选用', exact: true }).click()
  await expect(personal.getByText('当前选用', { exact: true })).toBeVisible()
  await expect(choices.getByText('使用个人费用', { exact: true })).toBeVisible()
  await page.reload()
  await expect(choices.getByText('使用个人费用', { exact: true })).toBeVisible()
  if (output) await page.screenshot({ path: join(output, 'after-school-model-selection-light.png'), fullPage: true })
  await choices.getByRole('button', { name: '撤销此空间授权', exact: true }).click()
  await expect(choices.getByText('原授权已撤销，请重新选用模型。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '返回学习空间', exact: true }).click()
  const created = await page.request.post(schoolEndpoint + '/api/learning/activities', { headers: { 'x-xj-space': 'school' },
    data: { requestId: randomUUID(), goal: '未选模型也能编辑活动', question: '', references: [] } })
  expect(created.status()).toBe(200)
  const activity = await created.json()
  await page.getByRole('button', { name: '刷新任务', exact: true }).click()
  await page.locator(`[data-activity-id="${activity.activityId}"]`).click()
  await expect(page.locator('#activity-title')).toHaveText('未选模型也能编辑活动')
})
test('installed client exposes the device connection to the actual school subject and keeps space choices separate', async ({ page }) => {
  await page.goto(deviceEndpoint + '/?settings=models&space=' + encodeURIComponent(connectionKey))
  const choices = page.getByRole('region', { name: '当前空间模型', exact: true })
  await expect(choices).toBeVisible()
  const personal = choices.locator('.st-provider').filter({ hasText: '本机一次配置的连接' })
  const choose = personal.getByRole('button', { name: '授权并选用', exact: true })
  await choose.focus(); await page.keyboard.press('Enter')
  await expect(personal.getByText('当前选用', { exact: true })).toBeVisible()
  await expect(choices.getByText('图片：尚未验证', { exact: false }).first()).toBeVisible()
  await page.emulateMedia({ colorScheme: 'dark' }); await page.setViewportSize({ width: 720, height: 900 })
  await expect.poll(() => page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running'
    && animation.effect?.getComputedTiming().iterations !== Infinity).length)).toBe(0)
  if (output) await page.screenshot({ path: join(output, 'after-device-model-selection-dark-narrow.png'), fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await openPersonalSpaceSettings(page)
  await expect(choices.getByText('未选用模型', { exact: true })).toBeVisible()
  await expect(choices.getByText('学校默认服务', { exact: true })).toHaveCount(0)
})

test('a late school selection receipt cannot replace a new personal-space view or its form input', async ({ page }) => {
  await page.goto(deviceEndpoint + '/?settings=models&space=' + encodeURIComponent(connectionKey))
  const choices = page.getByRole('region', { name: '当前空间模型', exact: true })
  const schoolCard = choices.locator('.st-provider').filter({ hasText: '学校默认服务' })
  let release!: () => void, committed!: () => void
  const hold = new Promise<void>(resolve => { release = resolve }), reached = new Promise<void>(resolve => { committed = resolve })
  await page.route('**/api/learning/models/selection', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return }
    const response = await route.fetch(); committed(); await hold; await route.fulfill({ response })
  })
  try {
    await schoolCard.getByRole('button', { name: '选用', exact: true }).click(); await reached
    await openPersonalSpaceSettings(page)
    await expect(choices.getByText('未选用模型', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '添加供应商', exact: true }).click()
    const name = page.getByRole('dialog').getByRole('textbox', { name: '连接名称', exact: true })
    await name.fill('新空间继续填写的中文输入'); release()
    await expect(name).toHaveValue('新空间继续填写的中文输入')
    await expect(choices.getByText('使用学校额度', { exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('button', { name: '添加供应商', exact: true })).toBeFocused()
  } finally { release(); await page.unroute('**/api/learning/models/selection') }
})

test('a confirmed selection conflict can be reloaded and retried without refreshing the page', async ({ page }) => {
  await page.goto(deviceEndpoint + '/?settings=models&space=' + encodeURIComponent(connectionKey))
  const choices = page.getByRole('region', { name: '当前空间模型', exact: true })
  await expect(choices.locator('.st-provider').filter({ hasText: '学校默认服务' }).getByText('当前选用', { exact: true })).toBeVisible()
  const reload = choices.getByRole('button', { name: '重新读取选用', exact: true })
  await page.route('**/api/learning/models/selection', route => route.abort('connectionfailed'))
  await reload.click()
  await expect(choices.getByRole('status')).toHaveText('当前模型状态待确认')
  await expect(choices.getByRole('button', { name: '检查当前模型', exact: true })).toBeDisabled()
  await page.unroute('**/api/learning/models/selection')
  await page.route('**/api/learning/models/selection', async route => {
    const response = await route.fetch()
    await route.fulfill({ response, json: { ...await response.json(), restoredInstallation: true } })
  }, { times: 1 })
  await reload.click()
  await expect(choices.getByRole('alert')).toHaveCount(0)
  await expect(choices.getByText('此环境已完成接管。', { exact: false })).toBeVisible()
  const headers = { 'x-xj-space': connectionKey }
  const current = await (await page.request.get(deviceEndpoint + '/api/learning/models/selection', { headers })).json()
  const advanced = await page.request.post(deviceEndpoint + '/api/learning/models/selection', { headers,
    data: { requestId: randomUUID(), expectedVersion: current.version, source: { kind: 'school', connectionId: current.selected.connection.connectionId } } })
  expect(advanced.status()).toBe(200)
  const personal = choices.locator('.st-provider').filter({ hasText: '本机一次配置的连接' })
  await personal.getByRole('button', { name: '选用', exact: true }).click()
  await expect(choices.getByRole('alert')).toContainText('选用记录已变化')
  await choices.getByRole('button', { name: '重新读取选用', exact: true }).click()
  await expect(choices.getByRole('alert')).toHaveCount(0)
  await personal.getByRole('button', { name: '选用', exact: true }).click()
  await expect(personal.getByText('当前选用', { exact: true })).toBeVisible()
})
