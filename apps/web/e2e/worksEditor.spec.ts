import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir, release as osRelease } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
const endOfDocument = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'
const pasteShortcut = process.platform === 'darwin' ? 'Meta+V' : 'Control+V'
test.skip(!postgresBin, 'Requires the native PostgreSQL 18.6 distribution.')
test.use({ trace: 'off' }) // Authentication input and cookies never enter retained browser traces.
let runtime: ReturnType<typeof openProductRuntime>
let endpoint: string
let runtimeRoot: string
let activityId: string
let activityGoal: string
const cases: { name: string; status: string | undefined; durationMs: number }[] = []
let browserVersion: string
function storageFaultBoundary(blocked: boolean) {
  const fault = { blocked }
  Object.assign(window, { workStorageFault: fault })
  const put = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args) {
    if (fault.blocked) throw new DOMException('Controlled browser quota refusal', 'QuotaExceededError')
    return Reflect.apply(put, this, args)
  }
}
test.beforeAll(async ({ browser }) => {
  await mkdir(fileURLToPath(new URL('../../../.verification/151', import.meta.url)), { recursive: true })
  browserVersion = browser.version()
  const root = await mkdtemp(join(tmpdir(), 'xj-editor-browser-'))
  runtimeRoot = root
  runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
  await runtime.install({ profile: 'local' })
  endpoint = (await runtime.start()).endpoint!
})
test.beforeEach(async () => {
  activityGoal = '可靠编辑回归-' + randomUUID()
  const response = await fetch(new URL('/api/learning/activities', endpoint), { method: 'POST', headers: {
    'content-type': 'application/json', 'x-xj-space': 'personal' },
  body: JSON.stringify({ requestId: randomUUID(), goal: activityGoal, question: '', references: [] }) })
  expect(response.status).toBe(200)
  activityId = (await response.json()).activityId
})
test.afterEach(async ({}, info) => { cases.push({ name: info.title, status: info.status, durationMs: info.duration }) })
test.afterAll(async () => {
  await runtime?.stop()
  await writeFile(fileURLToPath(new URL('../../../.verification/151/chrome-results.json', import.meta.url)), JSON.stringify({
    measuredAt: new Date().toISOString(), platform: process.platform, arch: process.arch, osRelease: osRelease(),
    node: process.version, postgres: '18.6', browser: 'installed Chrome', browserVersion, headless: false,
    backend: 'production product host, native PostgreSQL and real filesystem resources', cases,
  }, null, 2))
})

test('course catalog returns after activity restoration races with discovery', async ({ page }) => {
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID();
  const control = await resolveCredential(runtimeRoot, 'control');
  const manage = async (path: string, body: unknown) => {
    const response = await fetch(new URL('/api/learning/manage/' + path, endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + control }, body: JSON.stringify(body) });
    expect(response.status).toBe(200);
    return response.json();
  };
  await manage('course-import', { formatVersion: 1, requestId: randomUUID(), course: { courseId, name: '课程目录恢复' },
    task: { taskId, title: '固定版本任务', summary: '' }, release: { releaseId, objectives: ['保持课程入口可用'],
      requirements: '返回活动列表后可以继续选择课程。', materials: [], starterWorks: [], capabilities: [] }, resources: [] });
  const password = randomUUID();
  const loginName = 'catalog-session-' + randomUUID();
  const member = await manage('members', { requestId: randomUUID(), loginName, password });
  await manage('course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true });
  const login = await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } });
  expect(login.status()).toBe(200);
  const created = await page.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } });
  expect(created.status()).toBe(200);
  const activity = await created.json();
  let releaseDiscovery!: () => void;
  const held = new Promise<void>(resolve => { releaseDiscovery = resolve });
  let first = true;
  await page.route('**/api/learning/courses', async route => {
    const response = await route.fetch();
    if (first) { first = false; await held }
    await route.fulfill({ response });
  });
  try {
    await page.goto(endpoint + '/?space=school&activity=' + activity.activityId);
    await expect(page.locator('#activity-title')).toHaveText('固定版本任务');
    releaseDiscovery();
    await page.getByRole('button', { name: '返回活动列表', exact: true }).click();
    await expect(page.getByRole('heading', { name: '课程目录恢复', exact: true })).toBeVisible();
  } finally { releaseDiscovery() }
});

test('actual editor automatically protects and synchronizes Chinese original text across reload', async ({ page }) => {
  await page.goto(endpoint + '/?activity=' + activityId)
  await page.getByLabel('文件名', { exact: true }).fill('递归.c')
  await page.getByRole('button', { name: '新建文件', exact: true }).click()
  await expect(page.locator('.monaco-editor')).toBeVisible()
  await page.locator('.monaco-editor textarea').focus()
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.evaluate(() => navigator.clipboard.writeText('// 中文原文\nint main() {\n  return 0;\n}\n'))
  await page.keyboard.press(pasteShortcut)
  const read = async () => (await (await fetch(new URL('/api/learning/workspaces/' + activityId, endpoint), {
    headers: { 'x-xj-space': 'personal' } })).json()).files
  await expect.poll(async () => (await read())[0]?.value).toBe('// 中文原文\nint main() {\n  return 0;\n}\n')
  const before = (await read())[0]
  await page.reload()
  await expect(page.getByRole('button', { name: '递归.c', exact: true })).toBeVisible()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('// 中文原文')
  await expect.poll(async () => (await read())[0]?.objectId).toBe(before.objectId)
  await expect(page.getByRole('button', { name: /保存|冻结|确认作品/ })).toHaveCount(0)
  await expect(page.getByText(/^(保存中|已保存|待同步|本机已保存)$/)).toHaveCount(0)
  await page.screenshot({ path: fileURLToPath(new URL('../../../.verification/151/works-editor-light.png', import.meta.url)), fullPage: true })
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.screenshot({ path: fileURLToPath(new URL('../../../.verification/151/works-editor-dark.png', import.meta.url)), fullPage: true })
})

test('an opened activity survives API disconnection and reload, then continues its original pending sync', async ({ page }) => {
  await page.goto(endpoint + '/?activity=' + activityId)
  await page.getByLabel('文件名', { exact: true }).fill('离线.txt')
  await page.getByRole('button', { name: '新建文件', exact: true }).click()
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.insertText('离线甲')
  const read = async () => (await (await fetch(new URL('/api/learning/workspaces/' + activityId, endpoint), {
    headers: { 'x-xj-space': 'personal' } })).json()).files
  await expect.poll(async () => (await read())[0]?.value).toBe('离线甲')
  await page.route('**/api/learning/**', route => route.abort('connectionfailed'))
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.press(endOfDocument)
  await page.keyboard.insertText('乙')
  // The public contract fixes a 250ms maximum write batching window; allow transaction completion too.
  await page.waitForTimeout(750)
  await page.reload()
  await expect(page.getByRole('button', { name: '离线.txt', exact: true })).toBeVisible()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('离线甲乙')
  await page.unroute('**/api/learning/**')
  await expect.poll(async () => (await read())[0]?.value, { timeout: 15000 }).toBe('离线甲乙')
})

test('late and lost confirmations never settle later editor content', async ({ page }) => {
  await page.goto(endpoint + '/?activity=' + activityId)
  await page.getByLabel('文件名', { exact: true }).fill('迟到.txt')
  await page.getByRole('button', { name: '新建文件', exact: true }).click()
  await page.locator('.monaco-editor textarea').focus()
  const read = async () => (await (await fetch(new URL('/api/learning/workspaces/' + activityId, endpoint), {
    headers: { 'x-xj-space': 'personal' } })).json()).files
  await expect.poll(async () => (await read())[0]?.value).toBe('')
  let release!: () => void
  let admitted!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const sent = new Promise<void>(resolve => { admitted = resolve })
  const posted: string[] = []
  const queried: string[] = []
  page.on('request', request => { if (request.url().includes('/receipts/')) queried.push(request.url().split('/').at(-1)!) })
  await page.route('**/api/learning/workspaces/' + activityId, async route => {
    if (route.request().method() !== 'POST') return route.continue()
    posted.push(route.request().postDataJSON().requestId)
    const response = await route.fetch()
    if (posted.length === 1) { admitted(); await held; return route.fulfill({ response }) }
    if (posted.length === 3) return route.abort('connectionfailed') // The real transaction already committed.
    return route.fulfill({ response })
  })
  try {
    await page.keyboard.insertText('甲')
    await sent
    await page.keyboard.insertText('乙')
    await page.waitForTimeout(750)
    release()
    await expect.poll(async () => (await read())[0]?.value).toBe('甲乙')
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('甲乙')
    await page.keyboard.insertText('丙')
    await expect.poll(async () => (await read())[0]?.value).toBe('甲乙丙')
    await expect.poll(() => queried.filter(id => id === posted[2]).length).toBeGreaterThan(1)
    expect(posted).toHaveLength(3)
    await page.reload()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('甲乙丙')
  } finally { release() }
})

test('failed navigation leaves the editor able to continue automatic sync', async ({ page }) => {
  await page.goto(endpoint + '/?activity=' + activityId)
  await page.getByLabel('文件名', { exact: true }).fill('导航.txt')
  await page.getByRole('button', { name: '新建文件', exact: true }).click()
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.insertText('导航前')
  await page.route('**/api/learning/context', route => route.abort('connectionfailed'))
  await page.getByRole('button', { name: '刷新列表', exact: true }).click()
  await expect(page.locator('.monaco-editor')).toBeVisible()
  await page.unroute('**/api/learning/context')
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.press(endOfDocument)
  await page.keyboard.insertText('继续')
  await expect.poll(async () => (await (await fetch(new URL('/api/learning/workspaces/' + activityId, endpoint), {
    headers: { 'x-xj-space': 'personal' } })).json()).files[0]?.value).toBe('导航前继续')
})

test('reopening an activity uses the latest body from another actual tab, not a retained editor model', async ({ page, context }) => {
  await page.goto(endpoint + '/?activity=' + activityId)
  await page.getByLabel('文件名', { exact: true }).fill('重开.txt')
  await page.getByRole('button', { name: '新建文件', exact: true }).click()
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.insertText('原文')
  const read = async () => (await (await fetch(new URL('/api/learning/workspaces/' + activityId, endpoint), {
    headers: { 'x-xj-space': 'personal' } })).json()).files
  await expect.poll(async () => (await read())[0]?.value).toBe('原文')
  await page.getByRole('button', { name: '返回活动列表' }).click()
  const other = await context.newPage()
  try {
    await other.goto(endpoint + '/?activity=' + activityId)
    await other.locator('.monaco-editor textarea').focus()
    await other.keyboard.press(endOfDocument)
    await other.keyboard.insertText('新版')
    await expect.poll(async () => (await read())[0]?.value).toBe('原文新版')
    await page.getByRole('button', { name: activityGoal, exact: true }).click()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('原文新版')
    await page.locator('.monaco-editor textarea').focus()
    await page.keyboard.press(endOfDocument)
    await page.keyboard.insertText('续写')
    await expect.poll(async () => (await read())[0]?.value).toBe('原文新版续写')
  } finally { await other.close() }
})

test('a browser storage transaction failure blocks navigation, keeps exportable memory, and retries automatically', async ({ page }) => {
  await page.addInitScript(storageFaultBoundary, false)
  await page.goto(endpoint + '/?activity=' + activityId)
  await page.getByLabel('文件名', { exact: true }).fill('配额.txt')
  await page.getByRole('button', { name: '新建文件', exact: true }).click()
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.insertText('受保护')
  const read = async () => (await (await fetch(new URL('/api/learning/workspaces/' + activityId, endpoint), {
    headers: { 'x-xj-space': 'personal' } })).json()).files
  await expect.poll(async () => (await read())[0]?.value).toBe('受保护')
  await page.evaluate(() => { (window as unknown as { workStorageFault: { blocked: boolean } }).workStorageFault.blocked = true })
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.press(endOfDocument)
  await page.keyboard.insertText('仍在内存')
  await expect(page.getByLabel('可复制的当前原文')).toHaveValue('受保护仍在内存')
  await page.getByRole('button', { name: '返回活动列表' }).click()
  await expect(page.locator('.monaco-editor')).toBeVisible()
  await expect(page.getByRole('button', { name: '导出当前作品' })).toBeVisible()
  await page.waitForTimeout(2200) // Storage refusal spans more than one network retry window.
  await page.evaluate(() => { (window as unknown as { workStorageFault: { blocked: boolean } }).workStorageFault.blocked = false })
  await expect.poll(async () => (await read())[0]?.value).toBe('受保护仍在内存')
})

test('two actual tabs preserve both local edits under simultaneous IndexedDB competition', async ({ page, context }) => {
  function intervalBarrier() {
    const gate = { paused: false }
    Object.assign(window, { workTimerGate: gate })
    const interval = window.setInterval.bind(window)
    window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (typeof handler !== 'function') return interval(handler, timeout, ...args)
      return interval(() => { if (!gate.paused) handler(...args) }, timeout)
    }) as typeof window.setInterval
  }
  await page.addInitScript(intervalBarrier)
  await page.goto(endpoint + '/?activity=' + activityId)
  await page.getByLabel('文件名', { exact: true }).fill('并发.txt')
  await page.getByRole('button', { name: '新建文件', exact: true }).click()
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.insertText('共同基线')
  const read = async () => (await (await fetch(new URL('/api/learning/workspaces/' + activityId, endpoint), {
    headers: { 'x-xj-space': 'personal' } })).json()).files
  await expect.poll(async () => (await read())[0]?.value).toBe('共同基线')
  const other = await context.newPage()
  try {
    await other.addInitScript(intervalBarrier)
    await other.goto(endpoint + '/?activity=' + activityId)
    await expect(other.locator('.monaco-editor .view-lines')).toContainText('共同基线')
    // Pause interval delivery only; native clocks, rendering and real IndexedDB transactions remain intact.
    for (const target of [page, other]) await target.evaluate(() => { (window as unknown as { workTimerGate: { paused: boolean } }).workTimerGate.paused = true })
    for (const target of [page, other]) { await target.locator('.monaco-editor textarea').focus(); await target.keyboard.press(endOfDocument) }
    await Promise.all([page.keyboard.insertText('甲'), other.keyboard.insertText('乙')])
    for (const target of [page, other]) await target.evaluate(() => { (window as unknown as { workTimerGate: { paused: boolean } }).workTimerGate.paused = false })
    await expect.poll(async () => await page.getByText('作品存在分歧', { exact: true }).count() + await other.getByText('作品存在分歧', { exact: true }).count()).toBeGreaterThan(0)
    const conflicted = await page.getByText('作品存在分歧', { exact: true }).count() ? page : other
    await expect(conflicted.locator('.work-comparison')).toContainText('共同基线甲')
    await expect(conflicted.locator('.work-comparison')).toContainText('共同基线乙')
    await conflicted.getByRole('button', { name: '采用本页内容', exact: true }).click()
    await conflicted.reload()
    await expect(conflicted.locator('.monaco-editor .view-lines')).toContainText('共同基线')
  } finally { await other.close() }
})

test('a remote conflict comparison includes input made while the original service read was delayed', async ({ page, browser }) => {
  await page.goto(endpoint + '/?activity=' + activityId)
  await page.getByLabel('文件名', { exact: true }).fill('远端竞争.txt')
  await page.getByRole('button', { name: '新建文件', exact: true }).click()
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.insertText('基线')
  const read = async () => (await (await fetch(new URL('/api/learning/workspaces/' + activityId, endpoint), {
    headers: { 'x-xj-space': 'personal' } })).json()).files
  await expect.poll(async () => (await read())[0]?.value).toBe('基线')
  const separate = await browser.newContext()
  const other = await separate.newPage()
  let release!: () => void
  let admitted!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const reading = new Promise<void>(resolve => { admitted = resolve })
  let conflicted = false
  let delayed = false
  let newObjectId: string | undefined
  try {
    await other.goto(endpoint + '/?activity=' + activityId)
    await expect(other.locator('.monaco-editor .view-lines')).toContainText('基线')
    await other.route('**/api/learning/workspaces/' + activityId, async route => {
      if (route.request().method() === 'POST') {
        newObjectId ??= route.request().postDataJSON().files.find((f: { name: string }) => f.name === '附录.txt')?.objectId
        const response = await route.fetch(); if (response.status() === 409) conflicted = true
        return route.fulfill({ response })
      }
      if (!conflicted) return route.abort('connectionfailed')
      if (!delayed) { delayed = true; const response = await route.fetch(); admitted(); await held; return route.fulfill({ response }) }
      return route.continue()
    })
    await page.locator('.monaco-editor textarea').focus(); await page.keyboard.press(endOfDocument); await page.keyboard.insertText('甲')
    await expect.poll(async () => (await read())[0]?.value).toBe('基线甲')
    await other.getByLabel('文件名', { exact: true }).fill('附录.txt')
    await other.getByRole('button', { name: '新建文件', exact: true }).click()
    await other.getByRole('button', { name: '远端竞争.txt', exact: true }).click()
    await other.locator('.monaco-editor textarea').focus(); await other.keyboard.press(endOfDocument); await other.keyboard.insertText('乙')
    await reading
    await other.keyboard.insertText('新输入')
    release()
    await expect(other.locator('.work-comparison')).toContainText('基线乙新输入')
    await expect(other.locator('.work-comparison')).toContainText('基线甲')
    await other.getByRole('button', { name: '采用本页内容', exact: true }).click()
    await expect.poll(async () => (await read())[0]?.value).toBe('基线乙新输入')
    expect(newObjectId).toBeTruthy()
    expect((await read()).find((f: { name: string }) => f.name === '附录.txt').objectId).toBe(newObjectId)
    await other.reload()
    await expect(other.locator('.monaco-editor .view-lines')).toContainText('基线乙新输入')
  } finally { release(); await separate.close() }
})

test('continuous input advances durable local and remote content before the student stops typing', async ({ page }) => {
  await page.goto(endpoint + '/?activity=' + activityId)
  await page.getByLabel('文件名', { exact: true }).fill('持续.txt')
  await page.getByRole('button', { name: '新建文件', exact: true }).click()
  await page.locator('.monaco-editor textarea').focus()
  for (let i = 0; i < 30; i++) {
    await page.keyboard.insertText('中')
    await page.waitForTimeout(100)
    if (i === 19) {
      const view = await (await fetch(new URL('/api/learning/workspaces/' + activityId, endpoint), { headers: { 'x-xj-space': 'personal' } })).json()
      expect(view.files[0]?.value.length).toBeGreaterThan(0)
      expect(view.files[0]?.value.length).toBeLessThan(30)
    }
  }
  await page.waitForTimeout(750)
  await page.reload()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('中'.repeat(30))
})

test('the actual editor retains UTF-8 BOM and CRLF of an existing immutable source while editing', async ({ page }) => {
  const value = '\ufeff中文\r\n第二行\r\n'
  const file = { objectId: randomUUID(), contentId: randomUUID(), name: '原文.txt', kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value }
  const response = await fetch(new URL('/api/learning/workspaces/' + activityId, endpoint), { method: 'POST', headers: {
    'content-type': 'application/json', 'x-xj-space': 'personal' }, body: JSON.stringify({ requestId: randomUUID(), baseRevision: 0, files: [file] }) })
  expect(response.status).toBe(200)
  await page.goto(endpoint + '/?activity=' + activityId)
  await page.locator('.monaco-editor textarea').focus()
  await page.keyboard.press(endOfDocument); await page.keyboard.insertText('补充')
  await expect.poll(async () => (await (await fetch(new URL('/api/learning/workspaces/' + activityId, endpoint), {
    headers: { 'x-xj-space': 'personal' } })).json()).files[0]?.value).toBe(value + '补充')
  await page.reload()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('补充')
})

test('successful navigation protects input entered immediately before its delayed response', async ({ page }) => {
  await page.goto(endpoint + '/?activity=' + activityId)
  await page.getByLabel('文件名', { exact: true }).fill('切换窗口.txt')
  await page.getByRole('button', { name: '新建文件', exact: true }).click()
  await page.locator('.monaco-editor textarea').focus(); await page.keyboard.insertText('开始')
  let release!: () => void
  let admitted!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const sent = new Promise<void>(resolve => { admitted = resolve })
  await page.route('**/api/learning/context', async route => { const response = await route.fetch(); admitted(); await held; await route.fulfill({ response }) })
  try {
    await page.getByRole('button', { name: '刷新列表', exact: true }).click()
    await sent
    await page.locator('.monaco-editor textarea').focus(); await page.keyboard.press(endOfDocument); await page.keyboard.insertText('切换前输入')
    release()
    await page.getByRole('button', { name: activityGoal, exact: true }).click()
    await expect(page.locator('.monaco-editor .view-lines')).toContainText('开始切换前输入')
  } finally { release() }
})

test('initial storage refusal retries automatically after the browser permits transactions again', async ({ page }) => {
  await page.addInitScript(storageFaultBoundary, true)
  await page.goto(endpoint + '/?activity=' + activityId)
  await expect(page.getByRole('button', { name: '导出当前作品' })).toBeVisible()
  await page.evaluate(() => { (window as unknown as { workStorageFault: { blocked: boolean } }).workStorageFault.blocked = false })
  await expect(page.getByLabel('文件名', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '导出当前作品' })).toHaveCount(0)
})

test.describe('school workspace logout', () => {
  for (const switchWhilePending of [false, true]) test(`confirmed logout clears the old identity despite failed context refresh${switchWhilePending ? ' after switching spaces' : ''}, preserving work for reauthentication`, async ({ page }) => {
    const loginName = 'works-' + randomUUID(), password = randomUUID()
    const managed = await fetch(new URL('/api/learning/manage/members', endpoint), { method: 'POST', headers: {
      'content-type': 'application/json', authorization: 'Bearer ' + await resolveCredential(runtimeRoot, 'control') },
    body: JSON.stringify({ requestId: randomUUID(), loginName, password }) })
    expect(managed.status).toBe(200)
    expect((await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status()).toBe(200)
    const created = await page.request.post(endpoint + '/api/learning/activities', { headers: { 'x-xj-space': 'school' },
      data: { requestId: randomUUID(), goal: '学校作品退出回归', question: '', references: [] } })
    expect(created.status()).toBe(200)
    const schoolActivity = (await created.json()).activityId
    await page.goto(endpoint + '/?space=school&activity=' + schoolActivity)
    await page.getByLabel('文件名', { exact: true }).fill('学校.txt')
    await page.getByRole('button', { name: '新建文件', exact: true }).click()
    await page.locator('.monaco-editor textarea').focus(); await page.keyboard.insertText('学校原文')
    let release!: () => void
    let admitted!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const sent = new Promise<void>(resolve => { admitted = resolve })
    await page.route('**/api/learning/context', route => route.abort('connectionfailed'))
    await page.route('**/api/learning/logout', async route => { const response = await route.fetch(); admitted(); await held; await route.fulfill({ response }) })
    try {
      await page.getByRole('button', { name: '退出学校登录' }).click()
      await sent
      await page.locator('.monaco-editor textarea').focus(); await page.keyboard.press(endOfDocument); await page.keyboard.insertText('退出前新输入')
      if (switchWhilePending) await page.getByRole('button', { name: '个人空间', exact: true }).click()
      release()
      await expect(page.getByRole('button', { name: '退出学校登录' })).toHaveCount(0)
      await expect(page.getByRole('button', { name: '学校空间', exact: true })).toHaveCount(0)
      await page.unroute('**/api/learning/context')
      expect((await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status()).toBe(200)
      await page.goto(endpoint + '/?space=school&activity=' + schoolActivity)
      await expect(page.locator('.monaco-editor .view-lines')).toContainText('学校原文退出前新输入')
      await expect.poll(async () => (await (await page.request.get(endpoint + '/api/learning/workspaces/' + schoolActivity,
        { headers: { 'x-xj-space': 'school' } })).json()).files[0]?.value).toBe('学校原文退出前新输入')
    } finally { release() }
  })
})
