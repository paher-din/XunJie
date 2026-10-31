import { test, expect } from '@playwright/test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir, release as osRelease } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime'

test.skip(!process.env.XUNJIE_PRODUCT_POSTGRES_BIN, 'Requires native PostgreSQL 18.6.')
test.use({ trace: 'off' })
let school: ReturnType<typeof openProductRuntime>, device: ReturnType<typeof openProductRuntime>
let schoolEndpoint: string, deviceEndpoint: string, hybridKey: string
let schoolRoot: string
let browserVersion: string
const password = randomUUID(), loginName = 'hybrid-browser-' + randomUUID()
const results: { name: string; status?: string; durationMs: number }[] = []
const evidence = fileURLToPath(new URL('../../../.verification/154', import.meta.url))

test.beforeAll(async ({ browser }) => {
  // Two independent native installations and authenticated owner binding precede UI assertions.
  test.setTimeout(180000)
  await mkdir(evidence, { recursive: true })
  browserVersion = browser.version()
  const root = await mkdtemp(join(tmpdir(), 'xj-hybrid-chrome-'))
  schoolRoot = join(root, 'school')
  const deviceRoot = join(root, 'device')
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6',
    postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, webRoot: fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) }
  school = openProductRuntime({ root: schoolRoot, resources }); device = openProductRuntime({ root: deviceRoot, resources })
  await school.install({ profile: 'school', database: { mode: 'managed' } }); await device.install({ profile: 'local' })
  const schoolStatus = await school.start(), deviceStatus = await device.start()
  schoolEndpoint = schoolStatus.endpoint!; deviceEndpoint = deviceStatus.endpoint!
  const api = async (endpoint: string, path: string, data: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(endpoint + '/api/learning/' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(data) })
    expect(response.status, path).toBe(200); return response.json()
  }
  const admin = { authorization: 'Bearer ' + await resolveCredential(schoolRoot, 'control') }
  const service = deviceStatus.environment.services.find(s => s.unit === 'learning-data')!
  const target = { environmentId: service.environmentId, serviceId: service.serviceId, version: 1 }
  const sharedMember = await api(schoolEndpoint, 'manage/members', { requestId: randomUUID(), loginName, password }, admin)
  const hybridName = loginName + '-device'
  const localMember = await api(schoolEndpoint, 'manage/members', { requestId: randomUUID(), loginName: hybridName, password, target }, admin)
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID(), materialId = randomUUID()
  const bytes = Buffer.from('# 学校原始题目\n编辑中文作品并重新打开。')
  await api(schoolEndpoint, 'manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '部署验收课程' },
    task: { taskId, title: '部署验收任务', summary: '' }, release: { releaseId, objectives: ['在原空间继续学习'], requirements: '保存并重开中文作品。',
      materials: [{ materialId, title: '学校原题', path: 'open.md', mediaType: 'text/markdown', access: 'student',
        sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length }], starterWorks: [], capabilities: [] },
    resources: [{ path: 'open.md', contentBase64: bytes.toString('base64') }] }, admin)
  for (const member of [sharedMember, localMember]) await api(schoolEndpoint, 'manage/course-access',
    { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin)
  const login = await fetch(schoolEndpoint + '/api/learning/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: hybridName, password }) })
  expect(login.status).toBe(200)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]
  const requestId = randomUUID()
  await api(deviceEndpoint, 'client/start', { requestId, schoolEndpoint })
  await api(schoolEndpoint, 'connections/approve', { requestId }, { cookie })
  await api(deviceEndpoint, 'client/complete', { requestId })
  const grant = await school.authorize({ sourceEnvironmentId: target.environmentId, sourceServiceId: target.serviceId, capabilities: ['learning.authority'] })
  const runtimeConnectionId = randomUUID()
  await device.connect({ connectionId: runtimeConnectionId, sourceEnvironmentId: target.environmentId, sourceServiceId: target.serviceId,
    target: (await school.status()).environment.services[0]!, requiredCapabilities: ['learning.authority'], optionalCapabilities: [], credentialRef: 'school-authority' }, grant.token)
  await api(deviceEndpoint, 'manage/local-binding', { connectionId: requestId, runtimeConnectionId, target },
    { authorization: 'Bearer ' + await resolveCredential(deviceRoot, 'control') })
  hybridKey = 'school:' + requestId
})

test.afterEach(async ({}, info) => { results.push({ name: info.title, status: info.status, durationMs: info.duration }) })
test.afterAll(async () => {
  await device?.stop().catch(() => {}); await school?.stop().catch(() => {})
  await writeFile(join(evidence, 'chrome-hybrid.json'), JSON.stringify({ measuredAt: new Date().toISOString(),
    platform: process.platform, osRelease: osRelease(), arch: process.arch, node: process.version,
    postgres: '18.6', browserVersion, browser: 'installed Chrome', headless: false,
    topology: 'two independent native product daemons on the same host; NOT cross-machine evidence', results }, null, 2))
})

for (const mode of ['personal', 'school-shared', 'hybrid-local-owner'] as const) {
  test(`${mode}: the production page automatically retains Chinese work and reopens the same activity`, async ({ page }) => {
    const endpoint = mode === 'school-shared' ? schoolEndpoint : deviceEndpoint
    if (mode === 'school-shared') {
      await page.goto(endpoint)
      await page.getByLabel('学校账号').fill(loginName)
      await page.getByLabel('密码', { exact: true }).fill(password)
      await page.getByRole('button', { name: '登录此学校', exact: true }).click()
    } else await page.goto(endpoint + (mode === 'hybrid-local-owner' ? '/?space=' + encodeURIComponent(hybridKey) : ''))
    const goal = mode + '-' + randomUUID()
    if (mode === 'personal') {
      await page.getByLabel('学习目标', { exact: true }).fill(goal)
      await page.getByRole('button', { name: '建立学习活动', exact: true }).click()
    } else {
      await page.getByRole('button', { name: /最近发布/ }).click()
      await page.getByRole('button', { name: '从这一版本开始活动', exact: true }).click()
      await expect(page.getByText('固定版本', { exact: false })).toBeVisible({ timeout: 30000 })
      await page.getByRole('button', { name: '学校原题', exact: false }).click()
      await expect(page.getByRole('link', { name: '打开或下载材料' })).toBeVisible()
    }
    await page.getByLabel('文件名', { exact: true }).fill('中文原文.txt')
    await page.getByRole('button', { name: '新建文件', exact: true }).click()
    await page.locator('.monaco-editor textarea').focus()
    await page.keyboard.insertText('学校身份与中文作品\n自动保存，重开不变。')
    const activityId = new URL(page.url()).searchParams.get('activity')!
    const spaceKey = mode === 'personal' ? 'personal' : mode === 'school-shared' ? 'school' : hybridKey
    const read = async () => {
      const response = await page.request.get(endpoint + '/api/learning/workspaces/' + activityId, { headers: { 'x-xj-space': spaceKey } })
      expect(response.status()).toBe(200); return response.json()
    }
    await expect.poll(async () => (await read()).files[0]?.value, { timeout: 30000 }).toBe('学校身份与中文作品\n自动保存，重开不变。')
    await page.getByRole('button', { name: '关闭活动', exact: true }).click()
    await page.reload()
    await expect(page.getByRole('button', { name: '重新开始活动', exact: true })).toBeVisible()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('自动保存，重开不变。')
    await page.screenshot({ path: join(evidence, `chrome-${mode}.png`), fullPage: true })
    expect((await read()).files).toHaveLength(1)
  })
}
