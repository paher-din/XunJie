import { evidenceDirectory } from './evidence'
import { test, expect, type Page } from '@playwright/test'
import { randomUUID, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication, resolveCredential } from '@xunjie/product-runtime'
import { controlledActionReceiver } from '../../server/tests/support/action-receiver.mjs'
import { annotationPackage } from '../../../components/material-annotation/package.mjs'
import { aluPackage, aluCoursePackage } from '../../../components/alu-experiment/package.mjs'
import { openCourseTasks, selectProductSpace } from './support/product-ui'
import type { AgentConversation } from '@xunjie/contracts/agent-service'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires the native PostgreSQL distribution')
test.use({ trace: 'off' })
const receiver = controlledActionReceiver('ui-regression-receiver')
let root = '', endpoint = '', browserVersion = '', headless = true
let runtime: ReturnType<typeof openProductRuntime>
let host: Awaited<ReturnType<typeof createProductRuntimeHost>>
const cases: { name: string; status: string | undefined; durationMs: number }[] = []
const output = evidenceDirectory('159')
test.beforeAll(async ({ browser }, info) => {
  browserVersion = browser.version(); headless = info.project.use.headless !== false
  if (output) await mkdir(output, { recursive: true })
  root = await mkdtemp(join(tmpdir(), 'xj-ui159-tests-'))
  runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
  await runtime.install({ profile: 'local' })
  host = await createProductRuntimeHost({ root, createApplication: context => createProductLearningApplication(context, { receivers: [receiver] }) })
  endpoint = host.endpoint
})
test.afterEach(async ({}, info) => { cases.push({ name: info.title, status: info.status, durationMs: info.duration }) })
test.afterAll(async () => {
  await host?.stop(); await runtime?.stop()
  if (output) await writeFile(join(output, `product-ui-${process.platform}.json`), JSON.stringify({ measuredAt: new Date().toISOString(),
    platform: process.platform, arch: process.arch, osRelease: release(), node: process.version,
    browser: 'installed Chrome', browserVersion, headless, backend: 'production host, native PostgreSQL, built product UI',
    receiver: 'controlled test receiver; no real Agent or teaching outcome', cases }, null, 2))
  if (root) await rm(root, { recursive: true, force: true })
})
async function newActivity(page: Page, goal = '自主学习-' + randomUUID()) {
  await page.goto(endpoint)
  await page.getByRole('button', { name: 'Agent 对话', exact: true }).click()
  await page.getByLabel('向 Agent 提问', { exact: true }).fill(goal)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.product-conversation h1')).toHaveText(goal)
  await page.getByRole('button', { name: '进入工作区', exact: true }).click()
  await expect(page.locator('#activity-title')).toHaveText(goal)
  return new URL(page.url()).searchParams.get('activity')!
}
async function fileMenu(page: Page) {
  const trigger = page.getByRole('button', { name: '文件', exact: true })
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
}
async function newFile(page: Page, name: string) {
  await fileMenu(page)
  await page.getByLabel('文件名', { exact: true }).fill(name)
  await page.getByRole('button', { name: '新建文件', exact: true }).click()
  await page.keyboard.press('Escape')
  await page.locator('.monaco-editor textarea').focus()
}
const readWorks = async (page: Page, id: string) => (await page.request.get(endpoint + '/api/learning/workspaces/' + id,
  { headers: { 'x-xj-space': 'personal' } })).json()

test('default product entry uses shared UI and stable file identities through rename, deletion and recreation', async ({ page }) => {
  const id = await newActivity(page)
  await expect(page.locator('.shell.immersive')).toBeVisible()
  await newFile(page, '中文.txt')
  await page.keyboard.insertText('第一份原文')
  await expect.poll(async () => (await readWorks(page, id)).files[0]?.value).toBe('第一份原文')
  const first = (await readWorks(page, id)).files[0]
  await fileMenu(page)
  await page.getByLabel('新名称', { exact: true }).fill('改名.txt')
  await page.getByRole('button', { name: '重命名', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await readWorks(page, id)).files[0]?.name).toBe('改名.txt')
  expect((await readWorks(page, id)).files[0].objectId).toBe(first.objectId)
  await fileMenu(page); await page.getByRole('button', { name: '删除文件', exact: true }).click(); await page.keyboard.press('Escape')
  await expect.poll(async () => (await readWorks(page, id)).files).toHaveLength(0)
  await newFile(page, '改名.txt'); await page.keyboard.insertText('同名新作品')
  await expect.poll(async () => (await readWorks(page, id)).files[0]?.value).toBe('同名新作品')
  expect((await readWorks(page, id)).files[0].objectId).not.toBe(first.objectId)
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(page.locator('.brand')).toBeVisible()
  await expect(page.locator('.product-home')).toBeVisible()
  await expect(page.locator(`[data-activity-id="${id}"]`)).toBeFocused()
  await page.goBack()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('同名新作品')
  await page.goForward()
  await expect(page.getByRole('heading', { name: '我的课程' })).toBeVisible()
  await expect(page.getByRole('button', { name: /保存|冻结|确认作品/ })).toHaveCount(0)
  await expect(page.getByText(/演示统计|热力/)).toHaveCount(0)
})

test('browser history cannot bypass a refused local protection transaction', async ({ page }) => {
  await page.addInitScript(() => {
    const fault = { refuse: false }; Object.assign(window, { productUiQuota: fault })
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args) {
      if (fault.refuse) throw new DOMException('Controlled quota refusal', 'QuotaExceededError')
      return Reflect.apply(put, this, args)
    }
  })
  const id = await newActivity(page)
  await newFile(page, '离开保护.txt')
  await page.keyboard.insertText('已有正文')
  await expect.poll(async () => (await readWorks(page, id)).files[0]?.value).toBe('已有正文')
  await page.evaluate(() => { (window as unknown as { productUiQuota: { refuse: boolean } }).productUiQuota.refuse = true })
  await page.keyboard.insertText('仍在内存')
  await expect(page.getByRole('button', { name: '导出当前作品' })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(new RegExp('activity=' + id))
  await expect(page.getByLabel('可复制的当前原文')).toHaveValue('已有正文仍在内存')
  await page.evaluate(() => { (window as unknown as { productUiQuota: { refuse: boolean } }).productUiQuota.refuse = false })
  await page.goBack()
  await expect(page.locator('.product-conversation')).toBeVisible()
  await page.goForward()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('已有正文仍在内存')
  await expect.poll(async () => (await readWorks(page, id)).files[0]?.value).toBe('已有正文仍在内存')
})

test('selection, fixed send and later input survive the integrated discussion panel and reload', async ({ page }) => {
  const created = await page.request.post(endpoint + '/api/learning/activities', {
    headers: { 'x-xj-space': 'personal' },
    data: { requestId: randomUUID(), goal: '固定发送回归', question: '', references: [] },
  })
  expect(created.status()).toBe(200)
  const { activityId: id } = await created.json()
  await page.goto(endpoint + '/?space=personal&activity=' + id)
  await expect(page.locator('#activity-title')).toHaveText('固定发送回归')
  await newFile(page, '依据.c'); await page.keyboard.insertText('// 固定选择甲')
  await expect.poll(async () => (await readWorks(page, id)).files[0]?.value).toBe('// 固定选择甲')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  const askSelection = page.getByRole('button', { name: '询问 Agent', exact: true })
  await askSelection.click()
  await expect(page.getByRole('region', { name: '上下文引用' }).locator('li')).toHaveCount(1)
  const input = page.getByRole('textbox', { name: '你的问题', exact: true })
  await input.fill('问题甲')
  let releaseAccept!: () => void
  const hold = new Promise<void>(resolve => { releaseAccept = resolve })
  const pending = page.waitForRequest(request => request.method() === 'POST' && /\/agent-sessions\/[^/]+\/inputs$/.test(request.url()))
  await page.route('**/agent-sessions/*/inputs', async route => {
    await hold
    await route.continue()
  })
  try {
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    const sent = await pending
    await input.fill('发送后继续输入乙')
    await page.locator('.monaco-editor textarea').focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
    await page.keyboard.insertText('\n// 作品乙')
    await expect(page.getByRole('region', { name: '上下文引用' }).locator('li')).toHaveCount(1)
    releaseAccept()
    const response = await sent.response()
    expect(response?.status()).toBe(200)
    const submitted = sent.postDataJSON()
    const headers = await sent.allHeaders()
    const receipt = await page.request.get(sent.url().replace(/\/inputs$/, '/requests/' + submitted.requestId),
      { headers: Object.fromEntries(Object.entries(headers).filter(([name]) => name.startsWith('x-xj-'))) })
    expect(receipt.status()).toBe(200)
    const accepted = (await receipt.json()).input.context.action
    expect(accepted.scope.activityId).toBe(id)
    expect(accepted.draft.question).toBe('问题甲')
    expect(accepted.works[0].value).toBe('// 固定选择甲')
    expect(accepted.draft.references[0].copy).toBe('// 固定选择甲')
    await expect(input).toHaveValue('发送后继续输入乙')
    await expect.poll(async () => (await readWorks(page, id)).files[0]?.value).toContain('// 作品乙')
    await page.reload()
    const openConversation = page.getByRole('button', { name: '打开对话', exact: true })
    await expect(input.or(openConversation).first()).toBeVisible()
    if (await openConversation.isVisible()) await openConversation.click()
    await expect(input).toHaveValue('发送后继续输入乙')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('// 作品乙')
  } finally { releaseAccept() }
})

test('course content and shared navigation keep usable widths, theme and keyboard focus', async ({ page }) => {
  const control = await resolveCredential(root, 'control')
  const manage = async (path: string, data: unknown) => {
    const response = await page.request.post(endpoint + '/api/learning/manage/' + path, { headers: { authorization: 'Bearer ' + control }, data })
    expect(response.status()).toBe(200); return response.json()
  }
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID(), materialId = randomUUID()
  const bytes = Buffer.from('可选择的课程材料，中文原文保持不变。')
  await manage('course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '课程入口回归' },
    task: { taskId, title: '实际课程任务', summary: '从固定材料进入作品' }, release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['保留固定依据'],
      requirements: '要求与当前作品一起容易找到。', materials: [{ materialId, title: '课程材料', path: 'material.txt', access: 'student',
        mediaType: 'text/plain', byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }], starterWorks: [], capabilities: [] },
    resources: [{ path: 'material.txt', contentBase64: bytes.toString('base64') }] })
  const loginName = 'ui-' + randomUUID(), password = randomUUID()
  const member = await manage('members', { requestId: randomUUID(), loginName, password })
  await manage('course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true })
  expect((await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status()).toBe(200)
  await page.setViewportSize({ width: 960, height: 900 }); await page.goto(endpoint + '/?space=school')
  await expect(page.locator('.shell')).toHaveClass(/collapsed/)
  await expect(page.locator('.main')).toHaveCSS('margin-left', '60px')
  await page.getByRole('button', { name: '切换边栏' }).click()
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.setViewportSize({ width: 960, height: 900 })
  await expect(page.locator('.shell')).not.toHaveClass(/collapsed/)
  await page.getByRole('button', { name: /外观/ }).click(); await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /外观/ })).toBeFocused()
  await openCourseTasks(page, '课程入口回归')
  await page.getByRole('button', { name: /最近发布/ }).click()
  await page.getByRole('button', { name: '从这一版本开始活动' }).click()
  await expect(page.getByLabel('课程材料', { exact: true })).toContainText(bytes.toString())
  await newFile(page, '中文.txt')
  const cdp = await page.context().newCDPSession(page)
  // Browser IME protocol; physical OS input is measured separately in the platform evidence.
  await cdp.send('Input.imeSetComposition', { text: '你好', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.insertText', { text: '你好' })
  await page.keyboard.press('Enter')
  await cdp.send('Input.imeSetComposition', { text: '世界', selectionStart: 2, selectionEnd: 2 })
  await cdp.send('Input.insertText', { text: '世界' })
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('你好')
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('世界')
  const courseActivity = new URL(page.url()).searchParams.get('activity')!
  await expect.poll(async () => (await (await page.request.get(endpoint + '/api/learning/workspaces/' + courseActivity,
    { headers: { 'x-xj-space': 'school' } })).json()).files[0]?.value).toBe('你好\n世界')
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await page.getByRole('button', { name: '收起对话', exact: true }).click()
  await expect(page.getByRole('button', { name: '打开对话', exact: true })).toBeFocused()
  expect(await page.locator('.ws').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  if (output) await page.screenshot({ path: join(output, 'course-narrow-dark.png') })
})

test('home citations open the pinned course text and PDF page, then respect course access revocation', async ({ page }) => {
  const control = await resolveCredential(root, 'control')
  async function manage(path: string, data: unknown) {
    const response = await page.request.post(endpoint + '/api/learning/manage/' + path, {
      headers: { authorization: 'Bearer ' + control }, data,
    })
    expect(response.status()).toBe(200)
    return response.json()
  }
  const courseId = randomUUID(), taskId = randomUUID(), oldRelease = randomUUID()
  const loginName = 'citation-' + randomUUID(), password = randomUUID()
  const student = await manage('members', { requestId: randomUUID(), loginName, password })
  const textBytes = Buffer.from('前缀固定讲义后缀')
  const pdfObjects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = pdfObjects.map((object, index) => {
    const offset = pdf.length
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`
    return offset
  })
  const xref = pdf.length
  pdf += `xref\n0 5\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const pdfBytes = Buffer.from(pdf)
  const material = (title: string, path: string, mediaType: string, bytes: Buffer) => ({
    materialId: randomUUID(), title, path, mediaType, access: 'student', sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length,
  })
  const oldText = material('原版讲义', 'old.txt', 'text/plain', textBytes)
  const oldPdf = material('原版双页讲义', 'old.pdf', 'application/pdf', pdfBytes)
  const publish = (releaseId: string, items: ReturnType<typeof material>[], contents: Buffer[]) => manage('course-import', {
    formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '课程出处回归' },
    task: { taskId, title: '阅读讲义', summary: '' },
    release: { releaseId, helpPolicy: { version: 1, questions: 'allowed', scope: 'course' }, objectives: ['阅读固定版本'],
      requirements: '核对引用范围', materials: items, starterWorks: [], capabilities: [] },
    resources: items.map((item, index) => ({ path: item.path, contentBase64: contents[index]!.toString('base64') })),
  })
  await publish(oldRelease, [oldText, oldPdf], [textBytes, pdfBytes])
  const newText = Buffer.from('新版正文不可代替旧版')
  await publish(randomUUID(), [material('新版讲义', 'new.txt', 'text/plain', newText)], [newText])
  const setAccess = (active: boolean) => manage('course-access', { requestId: randomUUID(), courseId, principalId: student.principalId, active })
  await setAccess(true)
  expect((await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status()).toBe(200)
  const releases = await page.request.get(endpoint + '/api/learning/releases/' + oldRelease, { headers: { 'x-xj-space': 'school' } })
  expect(releases.ok()).toBe(true)
  const { contentDigest } = await releases.json()
  const sessionId = randomUUID(), turnId = randomUUID(), stepId = randomUUID()
  const created = await page.request.post(endpoint + '/api/learning/agent-sessions', {
    headers: { 'x-xj-space': 'personal', 'x-xj-agent-contract': '3' },
    data: { requestId: randomUUID(), sessionId, scenario: 'student-assistant', title: '课程出处回归' },
  })
  expect(created.ok()).toBe(true)
  const cite = (item: typeof oldText, range: Record<string, number>) => ({ turnId, stepId, citation: {
    citationId: randomUUID(), claim: item.title, label: item.title, version: item.sha256, digest: item.sha256, range,
    source: { kind: 'course-material', courseId, taskId, releaseId: oldRelease, materialId: item.materialId,
      materialSha256: item.sha256, mediaType: item.mediaType, contentDigest },
  } })
  const conversation: AgentConversation = { sessionId, lastSeq: 1, reset: true,
    turns: [], inputs: [], questions: [], tools: [], workspaces: [],
    messages: [{ messageId: 'assistant:fixture', turnId, role: 'assistant', text: '请核对讲义。',
      createdAt: new Date().toISOString(), state: 'settled' }],
    citations: [cite(oldText, { offset: 2, length: 4 }), cite(oldPdf, { page: 2 })],
  }
  await page.route('**/agent-sessions/' + sessionId + '/conversation?*', route => route.fulfill({ json: conversation }))
  await page.goto(endpoint + '/?space=personal&view=agent&session=' + sessionId)
  const textCitation = page.getByRole('button', { name: /原版讲义/ })
  await expect(textCitation).toBeVisible()
  await textCitation.click()
  const textReader = page.getByRole('region', { name: oldText.title, exact: true })
  await expect(textReader).toContainText('固定讲义')
  await expect(textReader).not.toContainText(/前缀|后缀|新版正文/)
  await textReader.getByRole('button', { name: '返回对话' }).click()
  const pdfCitation = page.getByRole('button', { name: /原版双页讲义/ })
  const pdfResponse = page.waitForResponse(response => response.ok() && response.url().endsWith('/releases/' + oldRelease + '/materials/' + oldPdf.materialId))
  await pdfCitation.click()
  const pdfOriginal = await (await pdfResponse).json()
  expect(Buffer.from(pdfOriginal.contentBase64, 'base64')).toEqual(pdfBytes)
  const original = page.getByRole('link', { name: '打开 PDF 第 2 页' })
  await expect(original).toHaveAttribute('href', /^blob:.*#page=2$/)
  const target = await original.getAttribute('href')
  const opened = page.context().waitForEvent('page')
  await original.click()
  const pdfViewer = await opened
  await expect(pdfViewer).toHaveURL(target!)
  await pdfViewer.close()
  await setAccess(false)
  await pdfCitation.click()
  await expect(page.getByText('这份课程资料的固定版本当前无法读取，原出处仍保留。')).toBeVisible()
  await expect(original).toHaveCount(0)
  await expect(pdfCitation).toBeVisible()
})

test('retained ALU v4 runs after a new release and a home citation is revoked by local school logout', async ({ page }) => {
  test.setTimeout(180_000)
  const rootAdmin = { authorization: 'Bearer ' + await resolveCredential(root, 'control') }
  const request = async (route: string, data?: unknown, headers: Record<string, string> = {}) => {
    const url = endpoint + '/api/learning/' + route
    const response = data === undefined ? await page.request.get(url, { headers })
      : await page.request.post(url, { data, headers })
    expect(response.status(), route).toBe(200)
    return response.json()
  }
  const manage = (route: string, data: unknown) => request('manage/' + route, data, rootAdmin)
  const definition = await manage('component-import', await aluPackage())
  const latest = await aluCoursePackage()
  latest.release.components![0]!.definition = definition
  const old = structuredClone(latest)
  old.requestId = randomUUID()
  old.release.releaseId = randomUUID()
  old.release.helpPolicy = { version: 1, questions: 'allowed', scope: 'course' }
  const loginName = 'old-alu-' + randomUUID(), password = randomUUID()
  const member = await manage('members', { requestId: randomUUID(), loginName, password })
  await manage('course-import', old)
  await manage('course-access', { requestId: randomUUID(), courseId: old.course.courseId,
    principalId: member.principalId, active: true })
  const login = () => request('login', { loginName, password })
  await login()
  const namespace = (await request('context')).clientNamespace
  const school = { 'x-xj-space': 'school', 'x-xj-namespace': namespace }
  const personal = { 'x-xj-space': 'personal', 'x-xj-namespace': namespace, 'x-xj-agent-contract': '3' }
  const activity = await request('course-activities', { requestId: randomUUID(), releaseId: old.release.releaseId }, school)
  await manage('course-import', latest)
  const reopened = await request('activities/' + activity.activityId, undefined, school)
  expect(reopened.course.releaseId).toBe(old.release.releaseId)
  expect(reopened.course.components[0].definition.digest).toBe(definition.digest)
  await page.goto(endpoint + '/?space=school&activity=' + activity.activityId)
  await expect(page.locator('#activity-title')).toHaveText(old.task.title)
  await page.getByRole('tab', { name: '作品', exact: true }).click()
  const editor = page.locator('.monaco-editor .view-lines').first()
  await editor.click()
  await page.keyboard.press('ControlOrMeta+A')
  await page.keyboard.insertText('module alu(input logic [3:0] A, B, input logic M, input logic [1:0] S, input logic Cin, output logic [3:0] F, output logic Cout); assign F = ~A; assign Cout = 0; endmodule')
  await page.getByRole('tab', { name: 'ALU 实验', exact: true }).click()
  const run = page.getByRole('button', { name: '运行', exact: true }).first()
  await expect(run).toBeEnabled({ timeout: 60000 })
  const displayReceipts: { status: number; code?: string }[] = []
  page.on('response', async response => {
    if (!response.url().endsWith('/displayed')) return
    const body = await response.json()
    displayReceipts.push({ status: response.status(), ...(body.error ? { code: body.error } : {}) })
  })
  await run.click()
  const readout = page.locator('.alu-readout-value').last()
  await expect(readout).toContainText('F=1111', { timeout: 65000 })
  await readout.scrollIntoViewIfNeeded()
  const getExecution = async () => (await request('executions/' + activity.activityId + '/history', undefined, school))
    .entries.find((entry: { query: { state: string; output?: { output?: { f: string } } } }) =>
      entry.query.state === 'succeeded' && entry.query.output?.output?.f === '1111')
  await expect.poll(async () => !!await getExecution(), { timeout: 20000 }).toBe(true)
  const { action, query } = await getExecution()
  await expect.poll(() => displayReceipts, { timeout: 10000 }).toContainEqual({ status: 200 })
  expect(action.execution.instance.componentVersion).toBe(4)
  const ref = { activityId: activity.activityId, requestId: query.requestId, executionRef: query.executionRef,
    inputDigest: query.inputDigest, label: '原 ALU 观察',
    source: { kind: 'component', formatVersion: 1, ...action.scope, origin: 'execution-result',
      instanceId: action.execution.instance.instanceId, componentId: action.execution.instance.componentId,
      componentVersion: 4, definitionDigest: definition.digest, bindingKey: 'alu', objectId: query.requestId,
      contentId: query.output.contentId, requestId: query.requestId, executionRef: query.executionRef } }
  const payloads: string[] = []
  const upstream = createServer(async (incoming, response) => {
    const chunks = []
    for await (const chunk of incoming) chunks.push(chunk)
    payloads.push(Buffer.concat(chunks).toString())
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '已核对当前依据。' }, finish_reason: 'stop' }] })
      + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  try {
    const address = upstream.address()
    if (!address || typeof address === 'string') throw new Error('Fixture model has no loopback port')
    const connectionId = randomUUID()
    await request('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: 'ALU authorization fixture',
      protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${address.port}/v1`, path: '/chat/completions',
      modelId: 'alu-auth-fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
      contextWindow: 128_000, maxOutputTokens: 1024, credential: { action: 'replace', value: 'synthetic-alu-auth-model' } }, personal)
    const selection = await request('models/selection', undefined, personal)
    await request('models/selection', { requestId: randomUUID(), expectedVersion: selection.version,
      source: { kind: 'personal', connectionId, owner: 'self' } }, personal)
    const sessionId = randomUUID(), route = 'agent-sessions/' + sessionId
    await request('agent-sessions', { requestId: randomUUID(), sessionId, scenario: 'student-assistant' }, personal)
    const ask = async (text: string, attach = true) => {
      const before = payloads.length
      const receipt = await request(route + '/inputs', { requestId: randomUUID(), sessionId, text,
        context: attach ? { experimentReferences: [ref] } : {} }, personal)
      await expect.poll(async () => (await request(route + '/runs/' + receipt.turnId, undefined, personal)).state,
        { timeout: 25000 }).toBe('completed')
      expect(payloads).toHaveLength(before + 1)
      const messages = JSON.parse(payloads.at(-1)!).messages as { role: string; content: unknown }[]
      return messages.filter(message => message.role !== 'system').map(message => JSON.stringify(message.content)).join('\n')
    }
    const hasVerifiedResult = (messages: string) => messages.includes('hostVerifiedStage') && messages.includes('1111')
    expect(hasVerifiedResult(await ask('登录后核对原实验'))).toBe(true)
    await request('logout', {}, school)
    const after = await ask('退出后重新核对原实验')
    expect(hasVerifiedResult(after)).toBe(false)
    expect(after.includes('原实验当前不可访问')).toBe(true)
    await login()
    expect(hasVerifiedResult(await ask('仅重新登录后核对先前上下文', false))).toBe(false)
    expect(hasVerifiedResult(await ask('重新登录并授权后核对原实验'))).toBe(true)
  } finally { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())) }
})

test('a late browser-history activity read cannot reopen the activity after forward returns to the list', async ({ page }) => {
  const goal = '历史活动读取-' + randomUUID()
  const id = await newActivity(page, goal)
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(page.locator(`[data-activity-id="${id}"]`)).toContainText(goal)
  let releaseRead!: () => void, reading!: () => void, delivered!: () => void
  const held = new Promise<void>(resolve => { releaseRead = resolve })
  const started = new Promise<void>(resolve => { reading = resolve })
  const finished = new Promise<void>(resolve => { delivered = resolve })
  await page.route('**/api/learning/activities/' + id, async route => {
    const response = await route.fetch(); reading(); await held
    try { await route.fulfill({ response }) }
    catch (cause) { if (!(cause instanceof Error) || !/already handled/.test(cause.message)) throw cause }
    finally { delivered() }
  })
  try {
    await page.goBack(); await started
    await page.goForward()
    await expect(page.locator('.product-home')).toBeVisible()
    releaseRead(); await finished
    await page.unroute('**/api/learning/activities/' + id)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(page.locator('#activity-title')).toHaveCount(0)
    expect(new URL(page.url()).searchParams.has('activity')).toBe(false)
  } finally { releaseRead() }
})

test('course browser history retires both visible and in-flight release details from the other course', async ({ page }) => {
  const courses = await courseHistoryFixture(page)
  await page.goto(endpoint + '/?space=school')
  await openCourseTasks(page, '课程历史 A')
  await page.getByRole('button', { name: '全部课程', exact: true }).click()
  await openCourseTasks(page, '课程历史 B')
  await page.getByRole('button', { name: /最近发布/ }).click()
  await expect(page.locator('#release-title')).toHaveText(courses[1].title)
  await page.goBack()
  await expect(page.locator('#release-title')).toHaveCount(0)
  await page.goBack()
  await expect(page.locator('#course-title')).toContainText(courses[0].name)
  await expect(page.locator('#release-title')).toHaveCount(0)
  let releaseRead!: () => void, reading!: () => void, delivered!: () => void
  const held = new Promise<void>(resolve => { releaseRead = resolve })
  const started = new Promise<void>(resolve => { reading = resolve })
  const finished = new Promise<void>(resolve => { delivered = resolve })
  await page.route('**/api/learning/releases/' + courses[0].releaseId, async route => {
    const response = await route.fetch(); reading(); await held; await route.fulfill({ response }); delivered()
  })
  try {
    await page.getByRole('button', { name: /最近发布/ }).click(); await started
    await page.goBack(); releaseRead(); await finished
    await page.unroute('**/api/learning/releases/' + courses[0].releaseId)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(page.locator('#release-title')).toHaveCount(0)
    await expect(page.getByRole('button', { name: '从这一版本开始活动' })).toHaveCount(0)
  } finally { releaseRead() }
})

test('an initial activity reopen cannot undo browser back to the list while its read is pending', async ({ page }) => {
  const id = await newActivity(page)
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(page.locator(`[data-activity-id="${id}"]`)).toBeVisible()
  await page.goto(endpoint + '/?space=personal&activity=' + id)
  await expect(page.locator('#activity-title')).toBeVisible()
  let releaseRead!: () => void, reading!: () => void, delivered!: () => void
  const held = new Promise<void>(resolve => { releaseRead = resolve })
  const started = new Promise<void>(resolve => { reading = resolve })
  const finished = new Promise<void>(resolve => { delivered = resolve })
  await page.route('**/api/learning/activities/' + id, async route => {
    const response = await route.fetch(); reading(); await held
    try { await route.fulfill({ response }) }
    catch (cause) { if (!(cause instanceof Error) || !/already handled/.test(cause.message)) throw cause }
    finally { delivered() }
  })
  try {
    await page.reload(); await started
    await page.goBack()
    await expect(page.locator('.product-home')).toBeVisible()
    releaseRead(); await finished
    await page.unroute('**/api/learning/activities/' + id)
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    await expect(page.locator('#activity-title')).toHaveCount(0)
    expect(new URL(page.url()).searchParams.has('activity')).toBe(false)
  } finally { releaseRead() }
})

async function courseHistoryFixture(page: Page, withComponent = false) {
  const control = await resolveCredential(root, 'control')
  const manage = async (path: string, data: unknown) => {
    const response = await page.request.post(endpoint + '/api/learning/manage/' + path, { headers: { authorization: 'Bearer ' + control }, data })
    expect(response.status()).toBe(200); return response.json()
  }
  const loginName = 'history-' + randomUUID(), password = randomUUID()
  const member = await manage('members', { requestId: randomUUID(), loginName, password })
  const definition = withComponent ? await manage('component-import', { requestId: randomUUID(), ...await annotationPackage() }) : undefined
  const courses: { courseId: string; releaseId: string; name: string; title: string }[] = []
  for (const label of ['A', 'B']) {
    const courseId = randomUUID(), releaseId = randomUUID(), name = '课程历史 ' + label, title = '发布任务 ' + label
    await manage('course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name },
      task: { taskId: randomUUID(), title, summary: '' }, release: { helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },  releaseId, objectives: ['固定课程依据'], requirements: '核对当前课程', materials: [], starterWorks: [], capabilities: [],
        ...(definition ? { components: [{ key: 'annotation', definition, configuration: { title: '材料标注' }, materialIds: [] }] } : {}) }, resources: [] })
    await manage('course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true })
    courses.push({ courseId, releaseId, name, title })
  }
  await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })
  return courses
}

test('component-only navigation protects an unretained action and its independent later question draft', async ({ page }) => {
  const [course] = await courseHistoryFixture(page, true)
  const created = await page.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId: course.releaseId } })
  expect(created.status()).toBe(200); const activity = await created.json()
  await page.goto(endpoint + '?space=school&activity=' + activity.activityId)
  await page.getByRole('tab', { name: '材料标注', exact: true }).click()
  await expect(page.frameLocator('iframe[title="材料标注"]').getByRole('button', { name: '标注选中文字' })).toBeEnabled()
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  const input = page.getByRole('textbox', { name: '你的问题', exact: true })
  await input.fill('动作中固定的问题')
  await expect(page.getByRole('button', { name: '发送问题', exact: true })).toBeEnabled()
  await page.evaluate(() => {
    Object.assign(window, { actionStorageBlocked: true })
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(...args) {
      if (this.name === 'actions' && (window as unknown as { actionStorageBlocked: boolean }).actionStorageBlocked)
        throw new DOMException('Controlled action storage refusal', 'QuotaExceededError')
      return Reflect.apply(original, this, args)
    }
  })
  const release = receiver.holdAccept()
  try {
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await expect(page.getByText('尚未可靠保留', { exact: true })).toBeVisible()
    await input.fill('发送后继续写的独立草稿')
    await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
    await expect(page.locator('.product-workspace-notice [role="alert"]').first()).toBeVisible()
    await expect(page.locator('iframe[title="材料标注"]')).toBeVisible()
    await expect(input).toHaveValue('发送后继续写的独立草稿')
    await page.evaluate(() => { Object.assign(window, { actionStorageBlocked: false }) })
    await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
    await expect(page.locator('#activity-title')).toHaveCount(0)
    await page.locator(`[data-activity-id="${activity.activityId}"]`).click()
    if (await page.getByRole('button', { name: '打开对话', exact: true }).isVisible())
      await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await expect(input).toHaveValue('发送后继续写的独立草稿')
    release()
    await expect.poll(() => receiver.acceptedIds().filter(id => receiver.acceptedInput(id)?.scope.activityId === activity.activityId).length).toBe(1)
    const id = receiver.acceptedIds().find(id => receiver.acceptedInput(id)?.scope.activityId === activity.activityId)!
    expect(receiver.acceptedInput(id)!.draft.question).toBe('动作中固定的问题')
  } finally { release(); await page.evaluate(() => { Object.assign(window, { actionStorageBlocked: false }) }).catch(() => {}) }
})

test('cross-space browser history waits for the destination list before reopening its activity', async ({ page }) => {
  await courseHistoryFixture(page)
  const personalGoal = '个人历史-' + randomUUID(), schoolGoal = '学校历史-' + randomUUID()
  await newActivity(page, personalGoal)
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(page.locator('[data-activity-id]').filter({ hasText: personalGoal })).toBeVisible()
  await selectProductSpace(page, '学校空间')
  const created = await page.request.post(endpoint + '/api/learning/activities', { headers: { 'x-xj-space': 'school' },
    data: { requestId: randomUUID(), goal: schoolGoal, question: '', references: [] } })
  expect(created.status()).toBe(200)
  const schoolId = (await created.json()).activityId
  await page.getByRole('button', { name: '刷新任务', exact: true }).click()
  await page.locator(`[data-activity-id="${schoolId}"]`).click()
  await expect(page.locator('#activity-title')).toHaveText(schoolGoal)
  await newFile(page, '学校历史.txt'); await page.keyboard.insertText('学校空间的原文')
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(page.locator(`[data-activity-id="${schoolId}"]`)).toContainText(schoolGoal)
  await selectProductSpace(page, '个人空间')
  await expect(page.locator(`[data-activity-id]`).filter({ hasText: personalGoal })).toBeVisible()
  await page.evaluate(() => history.go(-2))
  await expect(page.locator('#activity-title')).toHaveText(schoolGoal)
  await expect(page.getByRole('button', { name: '学校历史.txt', exact: true })).toBeVisible()
  expect(new URL(page.url()).searchParams.get('activity')).toBe(schoolId)
  expect(new URL(page.url()).searchParams.get('space')).toBe('school')
})

test('a late older course result cannot clear the newer unknown request', async ({ page }) => {
  const courses = await courseHistoryFixture(page)
  let releaseA!: () => void, releaseB!: () => void, startedA!: () => void, startedB!: () => void, doneA!: () => void, doneB!: () => void
  const heldA = new Promise<void>(resolve => { releaseA = resolve }), heldB = new Promise<void>(resolve => { releaseB = resolve })
  const sentA = new Promise<void>(resolve => { startedA = resolve }), sentB = new Promise<void>(resolve => { startedB = resolve })
  const finishedA = new Promise<void>(resolve => { doneA = resolve }), finishedB = new Promise<void>(resolve => { doneB = resolve })
  const posted: { requestId: string; releaseId: string }[] = []
  await page.route('**/api/learning/course-activities', async route => {
    const input = route.request().postDataJSON(); posted.push(input)
    const response = await route.fetch()
    if (input.releaseId === courses[0].releaseId) {
      startedA(); await heldA; await route.fulfill({ response }); doneA()
    } else { startedB(); await heldB; await route.abort('failed'); doneB() }
  })
  try {
    await page.goto(endpoint + '/?space=school')
    await openCourseTasks(page, '课程历史 A')
    await page.getByRole('button', { name: /最近发布/ }).click()
    await page.getByRole('button', { name: '从这一版本开始活动', exact: true }).click(); await sentA
    await page.getByRole('button', { name: '全部课程', exact: true }).click()
    await openCourseTasks(page, '课程历史 B')
    await page.getByRole('button', { name: '放弃这次请求', exact: true }).click()
    await page.getByRole('button', { name: /最近发布/ }).click()
    await page.getByRole('button', { name: '从这一版本开始活动', exact: true }).click(); await sentB
    releaseA(); await finishedA
    releaseB(); await finishedB
    await expect(page.getByRole('alert')).toContainText('暂时无法连接')
    await expect(page.getByRole('button', { name: '从这一版本开始活动', exact: true })).toBeDisabled()
    const queried: string[] = []
    page.on('request', request => { if (request.url().includes('course-activity-results/')) queried.push(request.url().split('/').at(-1)!) })
    await page.getByRole('button', { name: '核对并继续原请求', exact: true }).click()
    await expect(page.locator('#activity-title')).toHaveText(courses[1].title)
    expect(posted).toHaveLength(2)
    expect(queried.at(-1)).toBe(posted[1].requestId)
  } finally { releaseA(); releaseB() }
})
