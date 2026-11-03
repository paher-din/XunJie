import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime'
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires the native PostgreSQL distribution')
test.use({ trace: 'off' })

const output = fileURLToPath(new URL('../../../.verification/wp03-173', import.meta.url))
const evidence = fileURLToPath(new URL('../../../docs/student-agent-implementation/evidence', import.meta.url))
let root = '', endpoint = '', activityId = '', spaceKey = '', cookie = { name: '', value: '' }
let browserVersion = '', headless = true
let runtime: ReturnType<typeof openProductRuntime>
const cases: { name: string; status: string | undefined; durationMs: number }[] = []

test.beforeAll(async ({ browser }, info) => {
  browserVersion = browser.version(); headless = info.project.use.headless !== false
  await mkdir(output, { recursive: true })
  root = await mkdtemp(join(tmpdir(), 'xj-native-ui-'))
  runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin: postgresBin!,
    postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
  await runtime.install({ profile: 'local' })
  const started = await runtime.start(); endpoint = started.endpoint!
  const admin = { authorization: `Bearer ${await resolveCredential(root, 'control')}` }
  const api = async (route: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(new URL('/api/learning/' + route, endpoint), { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    return { status: response.status, value: await response.json() }
  }
  const published = await accumulatorPackage()
  const imported = await api('manage/component-import', { requestId: randomUUID(), ...published }, admin)
  if (imported.status !== 200) throw new Error('component import failed: ' + JSON.stringify(imported.value))
  const definition = imported.value
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID(), password = randomUUID()
  const binding = { key: 'accumulator', definition, configuration: { title: '四态累加模拟' }, materialIds: [] }
  const course = { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '有状态会话浏览器验收' },
    task: { taskId, title: '观察四态累加', summary: '' },
    release: { releaseId, objectives: ['连续输入并观察真实内部状态'], requirements: '依次输入 1、2、2，观察 1、3、1。',
      starterWorks: [], capabilities: [], components: [binding], materials: [] }, resources: [] }
  if ((await api('manage/course-import', course, admin)).status !== 200) throw new Error('course import failed')
  const member = await api('manage/members', { requestId: randomUUID(), loginName: 'native-ui-student', password }, admin)
  const login = await fetch(new URL('/api/learning/login', endpoint), { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: 'native-ui-student', password }) })
  if (login.status !== 200) throw new Error('login failed')
  const raw = login.headers.get('set-cookie')!.split(';')[0]!
  cookie = { name: raw.slice(0, raw.indexOf('=')), value: raw.slice(raw.indexOf('=') + 1) }
  await api('manage/course-access', { requestId: randomUUID(), courseId, principalId: member.value.principalId, active: true }, admin)
  const created = await api('course-activities', { requestId: randomUUID(), releaseId }, { cookie: raw })
  if (created.status !== 200) throw new Error('activity creation failed: ' + JSON.stringify(created.value))
  activityId = created.value.activityId
  const context = await (await fetch(new URL('/api/learning/context', endpoint), { headers: { cookie: raw } })).json()
  spaceKey = context.identities.find((item: { identity: { kind: string } }) => item.identity.kind === 'school')?.key
    ?? context.identities[0]?.key
  if (!spaceKey) throw new Error('no school space in context')
  void info
})
test.afterEach(async ({}, info) => { cases.push({ name: info.title, status: info.status, durationMs: info.duration }) })
test.afterAll(async () => {
  await runtime?.stop().catch(() => {})
  await writeFile(join(output, 'browser-report.json'), JSON.stringify({ measuredAt: new Date().toISOString(),
    platform: process.platform, arch: process.arch, osRelease: release(), node: process.version,
    browser: 'installed Chrome', browserVersion, headless, backend: 'product runtime, native PostgreSQL, bundled native adapter',
    cases }, null, 2))
  for (const file of ['native-session-light.png', 'native-session-dark.png', 'native-session-narrow.png']) {
    await cp(join(output, file), join(evidence, 'wp03-173-' + file)).catch(() => {})
  }
  await cp(join(output, 'browser-report.json'), join(evidence, 'wp03-173-browser-report.json')).catch(() => {})
  if (root) await rm(root, { recursive: true, force: true }).catch(() => {})
})

test('the central tool area starts, advances, reappears and stops a real native session', async ({ page, context }) => {
  await context.addCookies([{ name: cookie.name, value: cookie.value, url: endpoint }])
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(endpoint + '/?space=' + encodeURIComponent(spaceKey) + '&activity=' + activityId)
  await expect(page.locator('#activity-title')).toHaveText('观察四态累加')
  await page.getByRole('tab', { name: '四态累加模拟' }).click()
  await expect(page.locator('.component-view iframe')).toBeVisible()
  await expect(page.frameLocator('.component-view iframe').getByText('组件已就绪')).toBeVisible()
  await page.getByRole('button', { name: '启动本机会话' }).click()
  const observation = page.locator('.native-session-observation')
  await expect(observation).toContainText('当前状态')
  await expect(observation.locator('strong')).toHaveText('0')
  const enter = async (value: number, expected: string) => {
    await page.getByLabel('输入整数（0–99）').fill(String(value))
    await page.getByRole('button', { name: '输入', exact: true }).click()
    await expect(observation.locator('strong')).toHaveText(expected)
  }
  await enter(1, '1')
  await enter(2, '3')
  await enter(2, '1')
  await expect(page.locator('.native-session-history li')).toHaveCount(3)
  await expect(page.locator('.native-session-history li').first()).toContainText('状态 1')
  await page.screenshot({ path: join(output, 'native-session-light.png') })
  // Switching tools and reloading keeps the same owner reference instead of starting a new run.
  await page.getByRole('tab', { name: '作品' }).click()
  await page.getByRole('tab', { name: '四态累加模拟' }).click()
  await expect(observation.locator('strong')).toHaveText('1')
  await page.reload()
  await page.getByRole('tab', { name: '四态累加模拟' }).click()
  await expect(page.frameLocator('.component-view iframe').getByText('组件已就绪')).toBeVisible()
  await expect(observation.locator('strong')).toHaveText('1')
  await expect(page.locator('.native-session-history li')).toHaveCount(3)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.frameLocator('.component-view iframe').getByText('组件已就绪')).toBeVisible()
  await page.screenshot({ path: join(output, 'native-session-dark.png') })
  await page.setViewportSize({ width: 900, height: 900 })
  await page.emulateMedia({ colorScheme: 'light' })
  await page.screenshot({ path: join(output, 'native-session-narrow.png') })
  await page.getByRole('button', { name: '停止会话' }).click()
  await expect(page.locator('.execution-title')).toContainText('已取消')
  await expect(page.getByLabel('输入整数（0–99）')).toBeDisabled()
  await page.getByRole('button', { name: '开始新会话' }).click()
  await expect(observation.locator('strong')).toHaveText('0')
  expect(errors).toEqual([])
})
