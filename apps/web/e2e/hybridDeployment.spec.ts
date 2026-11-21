import { evidenceDirectory } from './evidence'
import { createWorkFile, clickActivityAction, openWorkspacePopover, closeWorkspacePopover, courseTaskCard, openCourseTasks } from './support/product-ui'
import { test, expect } from '@playwright/test'
import { randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir, release as osRelease } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime'
import { fixedPdf } from '../../server/tests/fixtures/pdf-material.mjs'

test.skip(!process.env.XUNJIE_PRODUCT_POSTGRES_BIN, 'Requires native PostgreSQL 18.6.')
test.use({ trace: 'off' })
let school: ReturnType<typeof openProductRuntime>, device: ReturnType<typeof openProductRuntime>
let schoolEndpoint: string, deviceEndpoint: string, hybridKey: string
let schoolRoot: string
let courseReleaseId: string
let pdfCourse: { courseId: string; principalId: string; materialId: string }
let browserVersion: string
const password = randomUUID(), loginName = 'hybrid-browser-' + randomUUID()
const results: { name: string; status?: string; durationMs: number }[] = []
const evidence = evidenceDirectory('154')

test.beforeAll(async ({ browser }) => {
  // Two independent native installations and authenticated owner binding precede UI assertions.
  test.setTimeout(180000)
  if (evidence) await mkdir(evidence, { recursive: true })
  browserVersion = browser.version()
  const root = await mkdtemp(join(tmpdir(), 'xj-hybrid-chrome-'))
  schoolRoot = join(root, 'school')
  const deviceRoot = join(root, 'device')
  const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresVersion: '18.6',
    postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
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
  courseReleaseId = releaseId
  const bytes = Buffer.from('# 学校原始题目\n编辑中文作品并重新打开。')
  const pdf = fixedPdf(), pdfId = randomUUID()
  pdfCourse = { courseId, principalId: localMember.principalId, materialId: pdfId }
  await api(schoolEndpoint, 'manage/course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '部署验收课程' },
    task: { taskId, title: '部署验收任务', summary: '' }, release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['在原空间继续学习'], requirements: '保存并重开中文作品。',
      materials: [{ materialId, title: '学校原题', path: 'open.md', mediaType: 'text/markdown', access: 'student',
        sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length },
      { materialId: pdfId, title: '固定 PDF 讲义', path: 'lecture.pdf', mediaType: 'application/pdf', access: 'student',
        sha256: createHash('sha256').update(pdf).digest('hex'), byteLength: pdf.length }], starterWorks: [], capabilities: [] },
    resources: [{ path: 'open.md', contentBase64: bytes.toString('base64') },
      { path: 'lecture.pdf', contentBase64: pdf.toString('base64') }] }, admin)
  for (const member of [sharedMember, localMember]) await api(schoolEndpoint, 'manage/course-access',
    { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin)
  const login = await fetch(schoolEndpoint + '/api/learning/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ loginName: hybridName, password }) })
  expect(login.status).toBe(200)
  const cookie = login.headers.get('set-cookie')!.split(';')[0]
  const requestId = randomUUID()
  await api(deviceEndpoint, 'client/start', { requestId, schoolEndpoint })
  await api(schoolEndpoint, 'connections/approve', { requestId }, { cookie })
  await api(deviceEndpoint, 'client/complete', { requestId })
  const grant = await school.authorize({ sourceEnvironmentId: target.environmentId, sourceServiceId: target.serviceId, sourceInstallationId: deviceStatus.environment.installationId, capabilities: ['learning.authority'] })
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
  if (evidence) await writeFile(join(evidence, 'chrome-hybrid.json'), JSON.stringify({ measuredAt: new Date().toISOString(),
    platform: process.platform, osRelease: osRelease(), arch: process.arch, node: process.version,
    postgres: '18.6', browserVersion, browser: 'installed Chrome', headless: false,
    topology: 'two independent native product daemons on the same host; NOT cross-machine evidence', results }, null, 2))
})

test('home Agent reads and cites a real published PDF page in desktop Chrome', async ({ page }) => {
  test.setTimeout(120_000)
  const calls = ['search_learning', 'read_learning', 'cite_source']
  let dispatch = 0
  let reading: { pdf?: { readingId: string }; text?: string } | undefined
  let upstreamError: unknown
  const upstream = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      const payload = JSON.parse(Buffer.concat(chunks).toString())
      const toolText = (id: string) => JSON.parse(payload.messages.find((message: { tool_call_id?: string }) => message.tool_call_id === id).content)
      const step = dispatch++
      let args: unknown
      if (step === 0) args = { query: '固定 PDF 讲义', kinds: ['course-material'] }
      if (step === 1) args = { reference: toolText('search-pdf').items.find((item: { reference: { objectId: string } }) =>
        item.reference.objectId === pdfCourse.materialId).reference, page: 2 }
      if (step === 2) {
        reading = toolText('read-pdf')
        if (!reading?.pdf || !reading.text?.includes('37 volts')) throw new Error('The model request did not receive the fixed page')
        args = { toolCallId: 'read-pdf', claim: '讲义第 2 页记录了 37 volts' }
      }
      const delta = step < calls.length ? { role: 'assistant', tool_calls: [{ index: 0,
        id: ['search-pdf', 'read-pdf', 'cite-pdf'][step], type: 'function',
        function: { name: calls[step], arguments: JSON.stringify(args) } }] }
        : { role: 'assistant', content: '讲义第 2 页记录了 37 volts。' }
      const chunk = (value: object, finish: string | null) => ({ id: 'pdf-fixture-' + step, object: 'chat.completion.chunk',
        model: 'pdf-fixture', choices: [{ index: 0, delta: value, finish_reason: finish }] })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.end([chunk(delta, null), chunk({}, step < calls.length ? 'tool_calls' : 'stop'),
        { choices: [], usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 } }]
        .map(value => 'data: ' + JSON.stringify(value) + '\n\n').join('') + 'data: [DONE]\n\n')
    } catch (error) { upstreamError = error; response.writeHead(500).end() }
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  try {
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('Fixture model has no loopback port')
    const headers = { 'x-xj-space': 'personal', 'x-xj-agent-contract': '3' }
    const api = async (route: string, data?: unknown) => {
      const url = deviceEndpoint + '/api/learning/' + route
      const result = data === undefined ? await page.request.get(url, { headers })
        : await page.request.post(url, { headers, data })
      expect(result.status(), route).toBe(200)
      return result.json()
    }
    const connectionId = randomUUID()
    await api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'PDF fixture',
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, path: '/chat/completions',
      modelId: 'pdf-fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 128_000, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-pdf-model' } })
    const selection = await api('models/selection')
    await api('models/selection', { requestId: randomUUID(), expectedVersion: selection.version,
      source: { kind: 'personal', connectionId, owner: 'self' } })
    const sessionId = randomUUID()
    await api('agent-sessions', { requestId: randomUUID(), sessionId, scenario: 'student-assistant', title: '课程 PDF 读页' })
    await api('agent-sessions/' + sessionId + '/inputs', { requestId: randomUUID(), sessionId,
      text: '请读取学校讲义第 2 页并给我出处。', context: {} })
    await expect.poll(async () => {
      if (upstreamError) throw upstreamError
      const conversation = await api('agent-sessions/' + sessionId + '/conversation')
      if (!conversation.messages.some((message: { role: string; text: string }) =>
        message.role === 'assistant' && message.text === '讲义第 2 页记录了 37 volts。')) return null
      return conversation.citations?.[0]?.citation?.source?.source?.readingId
    }, { timeout: 50000 }).toEqual(expect.any(String))
    expect(dispatch).toBe(4)
    expect(reading?.pdf?.readingId).toEqual(expect.any(String))
    await page.goto(deviceEndpoint + '/?space=personal&view=agent&session=' + sessionId)
    await page.getByRole('button', { name: /讲义第 2 页记录了 37 volts/ }).click()
    await expect(page.getByRole('link', { name: '打开 PDF 第 2 页' })).toHaveAttribute('href', /^blob:.*#page=2$/)
    const access = await page.request.post(schoolEndpoint + '/api/learning/manage/course-access', {
      headers: { authorization: 'Bearer ' + await resolveCredential(schoolRoot, 'control') },
      data: { requestId: randomUUID(), courseId: pdfCourse.courseId, principalId: pdfCourse.principalId, active: false },
    })
    expect(access.ok()).toBe(true)
    try {
      await page.getByRole('button', { name: '返回对话' }).click()
      await page.getByRole('button', { name: /讲义第 2 页记录了 37 volts/ }).click()
      await expect(page.getByText('这份课程资料的固定版本当前无法读取，原出处仍保留。')).toBeVisible()
    } finally {
      await page.request.post(schoolEndpoint + '/api/learning/manage/course-access', {
        headers: { authorization: 'Bearer ' + await resolveCredential(schoolRoot, 'control') },
        data: { requestId: randomUUID(), courseId: pdfCourse.courseId, principalId: pdfCourse.principalId, active: true },
      })
    }
  } finally { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) }
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
      await page.getByRole('button', { name: 'Agent 对话', exact: true }).click()
      await page.getByLabel('向 Agent 提问', { exact: true }).fill(goal)
      await page.getByRole('button', { name: '发送消息', exact: true }).click()
      await expect(page.locator('.product-conversation h1')).toHaveText(goal)
      await page.getByRole('button', { name: '进入工作区', exact: true }).click()
    } else {
      await openCourseTasks(page, '部署验收课程')
      await courseTaskCard(page, '部署验收任务').click()
      const preview = page.getByRole('dialog', { name: '部署验收任务', exact: true })
      await expect(preview).toContainText('保存并重开中文作品。')
      await preview.getByRole('button', { name: '开始任务', exact: true }).click()
      await expect(preview).toHaveCount(0)
      await expect(page.locator('#activity-title')).toHaveText('部署验收任务', { timeout: 30000 })
      await page.getByRole('tab', { name: '课程材料', exact: true }).click()
      await page.getByRole('region', { name: '课程材料', exact: true }).getByRole('button', { name: '学校原题', exact: true }).click()
      await expect(page.getByRole('region', { name: '课程材料阅读', exact: true })).toContainText('学校原始题目')
      await page.getByRole('button', { name: '返回作品', exact: true }).click()
    }
    await createWorkFile(page, '中文原文.txt')
    await page.locator('.monaco-editor textarea').focus()
    await page.keyboard.insertText('学校身份与中文作品\n自动保存，重开不变。')
    const activityId = new URL(page.url()).searchParams.get('activity')!
    const spaceKey = mode === 'personal' ? 'personal' : mode === 'school-shared' ? 'school' : hybridKey
    if (mode !== 'personal') {
      const activity = await page.request.get(endpoint + '/api/learning/activities/' + activityId, { headers: { 'x-xj-space': spaceKey } })
      expect(activity.status()).toBe(200)
      expect((await activity.json()).course.releaseId).toBe(courseReleaseId)
    }
    const read = async () => {
      const response = await page.request.get(endpoint + '/api/learning/workspaces/' + activityId, { headers: { 'x-xj-space': spaceKey } })
      expect(response.status()).toBe(200); return response.json()
    }
    await expect.poll(async () => (await read()).files[0]?.value, { timeout: 30000 }).toBe('学校身份与中文作品\n自动保存，重开不变。')
    await clickActivityAction(page, '关闭活动')
    await page.reload()
    const activityMenu = await openWorkspacePopover(page, '活动')
    await expect(activityMenu.getByRole('button', { name: '重新开始活动', exact: true })).toBeVisible()
    await closeWorkspacePopover(page, '活动')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('自动保存，重开不变。')
    if (evidence) await page.screenshot({ path: join(evidence, `chrome-${mode}.png`), fullPage: true })
    expect((await read()).files).toHaveLength(1)
  })
}
