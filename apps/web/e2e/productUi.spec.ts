import { test, expect, type Page } from '@playwright/test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication, resolveCredential } from '@xunjie/product-runtime'
import { controlledActionReceiver } from '../../server/tests/support/action-receiver.mjs'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires the native PostgreSQL distribution')
test.use({ trace: 'off' })
const receiver = controlledActionReceiver('ui-regression-receiver')
let root = '', endpoint = '', browserVersion = '', headless = true
let runtime: ReturnType<typeof openProductRuntime>
let host: Awaited<ReturnType<typeof createProductRuntimeHost>>
const cases: { name: string; status: string | undefined; durationMs: number }[] = []
const output = fileURLToPath(new URL('../../../.verification/159', import.meta.url))
test.beforeAll(async ({ browser }, info) => {
  browserVersion = browser.version(); headless = info.project.use.headless !== false
  await mkdir(output, { recursive: true })
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
  await writeFile(join(output, `product-ui-${process.platform}.json`), JSON.stringify({ measuredAt: new Date().toISOString(),
    platform: process.platform, arch: process.arch, osRelease: release(), node: process.version,
    browser: 'installed Chrome', browserVersion, headless, backend: 'production host, native PostgreSQL, built product UI',
    receiver: 'controlled test receiver; no real Agent or teaching outcome', cases }, null, 2))
  if (root) await rm(root, { recursive: true, force: true })
})
async function newActivity(page: Page, goal = '自主学习-' + randomUUID()) {
  await page.goto(endpoint)
  await page.getByLabel('学习目标', { exact: true }).fill(goal)
  await page.getByRole('button', { name: '建立学习活动', exact: true }).click()
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
  await expect(page.getByRole('heading', { name: '我的学习活动' })).toBeVisible()
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
  await expect(page.locator('.product-home')).toBeVisible()
  await page.goForward()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('已有正文仍在内存')
  await expect.poll(async () => (await readWorks(page, id)).files[0]?.value).toBe('已有正文仍在内存')
})

test('selection, fixed send and later input survive the integrated discussion panel and reload', async ({ page }) => {
  const id = await newActivity(page)
  await newFile(page, '依据.c'); await page.keyboard.insertText('// 固定选择甲')
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
  await page.getByRole('button', { name: '询问 Agent', exact: true }).click()
  const input = page.getByRole('textbox', { name: '你的问题', exact: true })
  await input.fill('问题甲')
  const releaseAccept = receiver.holdAccept()
  try {
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await input.fill('发送后继续输入乙')
    await page.locator('.monaco-editor textarea').focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End')
    await page.keyboard.insertText('\n// 作品乙')
    await expect(page.getByRole('region', { name: '上下文引用' }).locator('li')).toHaveCount(1)
    releaseAccept()
    await expect.poll(() => receiver.acceptedIds().length).toBeGreaterThan(0)
    const accepted = receiver.acceptedIds().map(requestId => receiver.acceptedInput(requestId)).find(value => value?.scope.activityId === id)!
    expect(accepted.draft.question).toBe('问题甲')
    expect(accepted.works[0].value).toBe('// 固定选择甲')
    expect(accepted.draft.references[0].copy).toBe('// 固定选择甲')
    await expect(input).toHaveValue('发送后继续输入乙')
    await expect.poll(async () => (await readWorks(page, id)).files[0]?.value).toContain('// 作品乙')
    await page.reload(); await page.getByRole('button', { name: '打开对话', exact: true }).click()
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
    task: { taskId, title: '实际课程任务', summary: '从固定材料进入作品' }, release: { releaseId, objectives: ['保留固定依据'],
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
  await page.getByRole('button', { name: /课程入口回归.*查看任务/ }).click()
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
  await page.screenshot({ path: join(output, 'course-narrow-dark.png') })
})

test('a late browser-history activity read cannot reopen the activity after forward returns to the list', async ({ page }) => {
  const goal = '历史活动读取-' + randomUUID()
  const id = await newActivity(page, goal)
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(page.getByRole('button', { name: goal, exact: true })).toBeVisible()
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
  await page.getByRole('button', { name: /课程历史 A.*查看任务/ }).click()
  await page.getByRole('button', { name: '全部课程', exact: true }).click()
  await page.getByRole('button', { name: /课程历史 B.*查看任务/ }).click()
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

async function courseHistoryFixture(page: Page) {
  const control = await resolveCredential(root, 'control')
  const manage = async (path: string, data: unknown) => {
    const response = await page.request.post(endpoint + '/api/learning/manage/' + path, { headers: { authorization: 'Bearer ' + control }, data })
    expect(response.status()).toBe(200); return response.json()
  }
  const loginName = 'history-' + randomUUID(), password = randomUUID()
  const member = await manage('members', { requestId: randomUUID(), loginName, password })
  const courses: { courseId: string; releaseId: string; name: string; title: string }[] = []
  for (const label of ['A', 'B']) {
    const courseId = randomUUID(), releaseId = randomUUID(), name = '课程历史 ' + label, title = '发布任务 ' + label
    await manage('course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name },
      task: { taskId: randomUUID(), title, summary: '' }, release: { releaseId, objectives: ['固定课程依据'], requirements: '核对当前课程', materials: [], starterWorks: [], capabilities: [] }, resources: [] })
    await manage('course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true })
    courses.push({ courseId, releaseId, name, title })
  }
  await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })
  return courses
}

test('cross-space browser history waits for the destination list before reopening its activity', async ({ page }) => {
  await courseHistoryFixture(page)
  const personalGoal = '个人历史-' + randomUUID(), schoolGoal = '学校历史-' + randomUUID()
  await newActivity(page, personalGoal)
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(page.getByRole('button', { name: personalGoal, exact: true })).toBeVisible()
  await page.getByRole('button', { name: '学校空间', exact: true }).click()
  await page.locator('.product-new-activity summary').click()
  await page.getByLabel('学习目标', { exact: true }).fill(schoolGoal)
  await page.getByRole('button', { name: '建立学习活动', exact: true }).click()
  await expect(page.locator('#activity-title')).toHaveText(schoolGoal)
  const schoolId = new URL(page.url()).searchParams.get('activity')!
  await newFile(page, '学校历史.txt'); await page.keyboard.insertText('学校空间的原文')
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(page.getByRole('button', { name: schoolGoal, exact: true })).toBeVisible()
  await page.getByRole('button', { name: '个人空间', exact: true }).click()
  await expect(page.getByRole('button', { name: personalGoal, exact: true })).toBeVisible()
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
    await page.getByRole('button', { name: /课程历史 A.*查看任务/ }).click()
    await page.getByRole('button', { name: /最近发布/ }).click()
    await page.getByRole('button', { name: '从这一版本开始活动', exact: true }).click(); await sentA
    await page.getByRole('button', { name: '全部课程', exact: true }).click()
    await page.getByRole('button', { name: /课程历史 B.*查看任务/ }).click()
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
