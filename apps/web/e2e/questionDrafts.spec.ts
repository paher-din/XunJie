import { test, expect, type Page } from '@playwright/test'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir, release as osRelease } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires the native PostgreSQL 18.6 distribution.')
test.use({ trace: 'off' })
let runtime: ReturnType<typeof openProductRuntime>
let endpoint: string
let runtimeRoot: string
const results: { name: string; status: string | undefined; durationMs: number }[] = []
let browserVersion: string
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

test.beforeAll(async ({ browser }) => {
  await mkdir(fileURLToPath(new URL('../../../.verification/152', import.meta.url)), { recursive: true })
  browserVersion = browser.version()
  runtimeRoot = await mkdtemp(join(tmpdir(), 'xj-drafts-browser-'))
  runtime = openProductRuntime({ root: runtimeRoot, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
  await runtime.install({ profile: 'local' })
  endpoint = (await runtime.start()).endpoint!
})
test.afterEach(async ({}, info) => { results.push({ name: info.title, status: info.status, durationMs: info.duration }) })
test.afterAll(async () => {
  await runtime?.stop()
  await writeFile(fileURLToPath(new URL('../../../.verification/152/chrome-results.json', import.meta.url)), JSON.stringify({
    measuredAt: new Date().toISOString(), platform: process.platform, arch: process.arch, osRelease: osRelease(),
    node: process.version, postgres: '18.6', browser: 'installed Chrome', browserVersion, headless: false,
    backend: 'production product host, native PostgreSQL and real filesystem resources', cases: results,
  }, null, 2))
})

async function personalActivity(page: Page) {
  const created = await page.request.post(endpoint + '/api/learning/activities', { headers: { 'x-xj-space': 'personal' },
    data: { requestId: randomUUID(), goal: '问题草稿回归-' + randomUUID(), question: '', references: [] } })
  expect(created.status()).toBe(200)
  return (await created.json()).activityId as string
}
const draftOf = async (page: Page, activityId: string, personal = true) =>
  (await page.request.get(endpoint + '/api/learning/drafts/' + activityId,
    personal ? { headers: { 'x-xj-space': 'personal' } } : undefined)).json()
const refs = (page: Page) => page.getByRole('region', { name: '上下文引用' }).locator('li')
const question = (page: Page) => page.getByRole('textbox', { name: '你的问题', exact: true })
const openComposer = async (page: Page) => {
  const open = page.getByRole('button', { name: '打开对话', exact: true })
  if (await question(page).count() === 0) {
    await expect(open).toBeVisible()
    await open.click()
  }
  await expect(question(page)).toBeEnabled()
}
async function selectText(page: Page, label: string, text: string) {
  const source = page.getByLabel(label, { exact: true })
  await source.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }))
  const points = await source.evaluate((el, text) => {
    const node = el.firstChild!, start = node.textContent!.indexOf(text), end = start + text.length
    if (start < 0) throw new Error('Text not present')
    const first = document.createRange(), last = document.createRange()
    first.setStart(node, start); first.setEnd(node, start + 1)
    last.setStart(node, end - 1); last.setEnd(node, end)
    const a = first.getBoundingClientRect(), b = last.getBoundingClientRect()
    return { x1: a.left + .2, y1: a.top + a.height / 2, x2: b.right - .2, y2: b.top + b.height / 2 }
  }, text)
  await page.mouse.click(points.x1, points.y1)
  await page.mouse.move(points.x1, points.y1)
  await page.mouse.down()
  await page.mouse.move(points.x2, points.y2, { steps: 12 })
  await page.mouse.up()
}
async function selectAllCode(page: Page) {
  await page.locator('.monaco-editor').scrollIntoViewIfNeeded()
  const editor = page.locator('.monaco-editor textarea.inputarea')
  await editor.focus()
  const modifier = await page.evaluate(() => navigator.userAgent.includes('Macintosh') ? 'Meta' : 'Control')
  await page.keyboard.press(`${modifier}+a`)
}

test('course text and requirements stay as fixed references through collapse, reload and activity switch', async ({ page }) => {
  const control = await resolveCredential(runtimeRoot, 'control')
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID(), materialId = randomUUID()
  const studentText = '\uFEFF# ALU 题目\r\n完成 4 位加减与逻辑运算。\r\n请比较两种逻辑。'
  const requirements = '实现四种运算并用仿真验证边界输入。\r\n中文要求保持原样。'
  const bytes = Buffer.from(studentText)
  const manage = async (path: string, body: unknown) => {
    const response = await fetch(new URL('/api/learning/manage/' + path, endpoint), { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + control }, body: JSON.stringify(body) })
    expect(response.status).toBe(200)
    return response.json()
  }
  await manage('course-import', { formatVersion: 1, requestId: randomUUID(),
    course: { courseId, name: '固定引用课程' }, task: { taskId, title: '固定引用的任务', summary: '课堂材料' },
    release: { releaseId, objectives: ['引用材料与要求'], requirements,
      materials: [{ materialId, title: 'ALU 题目', path: 'alu.txt', mediaType: 'text/plain', access: 'student',
        sha256: sha256(bytes), byteLength: bytes.byteLength }], starterWorks: [], capabilities: [] },
    resources: [{ path: 'alu.txt', contentBase64: bytes.toString('base64') }] })
  const password = randomUUID(), loginName = 'draft-chrome-' + randomUUID()
  const member = await manage('members', { requestId: randomUUID(), loginName, password })
  await manage('course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true })
  const login = await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })
  expect(login.status()).toBe(200)
  const created = await page.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } })
  expect(created.status()).toBe(200)
  const activityId = (await created.json()).activityId as string
  await page.goto(endpoint + '/?space=school&activity=' + activityId)
  await expect(page.getByRole('heading', { name: '固定引用的任务', exact: true })).toBeVisible()
  await expect(page.getByLabel('ALU 题目', { exact: true })).toBeVisible()
  const selected = '完成 4 位加减与逻辑运算。'
  await selectText(page, 'ALU 题目', selected)
  await expect(page.getByRole('button', { name: '询问 Agent', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '询问 Agent', exact: true }).click()
  await expect(refs(page)).toHaveCount(1)
  expect(await refs(page).first().locator('pre').textContent()).toBe(selected)
  await question(page).fill('为什么需要边界输入？')
  await expect.poll(async () => (await draftOf(page, activityId, false)).question).toBe('为什么需要边界输入？')
  const firstDraft = await draftOf(page, activityId, false)
  expect(firstDraft.revision).toBe(1)
  expect(firstDraft.references[0].source.kind).toBe('course-material')
  expect(firstDraft.references[0].copy).toBe(selected)
  expect(firstDraft.references[0].copyDigest).toBe(sha256(selected))
  expect(firstDraft.references[0].range.start).toBe(studentText.indexOf(selected))

  await selectText(page, 'ALU 题目', selected)
  await expect(refs(page)).toHaveCount(1)
  await selectText(page, '任务要求', '实现四种运算')
  await expect(refs(page)).toHaveCount(2)
  expect(await refs(page).nth(1).locator('pre').textContent()).toBe('实现四种运算')
  await expect.poll(async () => (await draftOf(page, activityId, false)).references.length).toBe(2)
  const ordered = await draftOf(page, activityId, false)
  expect(ordered.references.map((reference: { source: { kind: string } }) => reference.source.kind))
    .toEqual(['course-material', 'course-field'])
  await page.getByRole('button', { name: '移除引用 1', exact: true }).click()
  await expect(refs(page)).toHaveCount(1)
  await page.evaluate(() => { document.dispatchEvent(new Event('selectionchange')); document.dispatchEvent(new Event('selectionchange')) })
  await question(page).focus()
  await expect(refs(page)).toHaveCount(1)
  await expect.poll(async () => (await draftOf(page, activityId, false)).references.length).toBe(1)
  await selectText(page, 'ALU 题目', selected)
  await expect(refs(page)).toHaveCount(2)
  await expect.poll(async () => (await draftOf(page, activityId, false)).references.length).toBe(2)

  await page.getByRole('button', { name: '收起对话' }).click()
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await expect(question(page)).toHaveValue('为什么需要边界输入？')
  await expect(refs(page)).toHaveCount(2)
  const send = page.getByRole('button', { name: '发送问题（尚未接入）' })
  await expect(send).toBeDisabled()
  await expect(page.getByText('真实 Agent 尚未接入', { exact: false })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('heading', { name: '固定引用的任务', exact: true })).toBeVisible()
  await openComposer(page)
  await expect(question(page)).toHaveValue('为什么需要边界输入？')
  await expect(refs(page)).toHaveCount(2)
  await page.getByRole('button', { name: '返回活动列表', exact: true }).click()
  await expect(page.getByRole('heading', { name: '固定引用的任务', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '固定引用的任务', exact: true }).click()
  await expect(page.getByRole('heading', { name: '固定引用的任务', exact: true })).toBeVisible()
  await openComposer(page)
  await expect(question(page)).toHaveValue('为什么需要边界输入？')
  await expect(refs(page)).toHaveCount(2)
  await page.getByRole('button', { name: '个人空间', exact: true }).click()
  await expect(page.getByRole('heading', { name: '个人学习空间', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '学校空间', exact: true }).click()
  await expect(page.getByRole('heading', { name: '课程任务', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '固定引用的任务', exact: true }).click()
  await expect(page.getByRole('heading', { name: '固定引用的任务', exact: true })).toBeVisible()
  await openComposer(page)
  await expect(question(page)).toHaveValue('为什么需要边界输入？')
  await expect(refs(page)).toHaveCount(2)
  await page.screenshot({ path: fileURLToPath(new URL('../../../.verification/152/chrome-course-draft.png', import.meta.url)), fullPage: true })
})

test('code reference keeps original copy after rename and edit, and survives file deletion and reload', async ({ page }) => {
  const activityId = await personalActivity(page)
  const original = '\uFEFF// 样例代码：中文 🧩\r\nmodule demo;\r\n  wire ready = 1;\r\nendmodule\r\n'
  const seeded = await page.request.post(endpoint + '/api/learning/workspaces/' + activityId,
    { headers: { 'x-xj-space': 'personal' }, data: { requestId: randomUUID(), baseRevision: 0,
      files: [{ objectId: randomUUID(), contentId: randomUUID(), name: 'demo.sv', kind: 'code',
        encoding: 'utf8', mediaType: 'text/plain', value: original }] } })
  expect(seeded.status()).toBe(200)
  await page.goto(endpoint + '/?activity=' + activityId)
  await expect(page.getByRole('button', { name: 'demo.sv', exact: true })).toBeVisible()
  await expect(page.locator('.monaco-editor textarea.inputarea')).toBeAttached()
  await selectAllCode(page)
  const ask = page.locator('.wr-toolbar button')
  await expect(ask).toBeVisible()
  await ask.click()
  await expect(refs(page)).toHaveCount(1)
  expect(await refs(page).first().locator('pre').textContent()).toBe(original.slice(1))
  await expect.poll(async () => (await draftOf(page, activityId)).references.length).toBe(1)
  const firstDraft = await draftOf(page, activityId)
  expect(firstDraft.references[0].source.kind).toBe('work')
  expect(firstDraft.references[0].range.start).toBe(1)
  expect(firstDraft.references[0].copy).toBe(original.slice(1))

  await page.getByLabel('新名称', { exact: true }).fill('renamed.sv')
  await page.getByRole('button', { name: '重命名', exact: true }).click()
  await expect(page.getByRole('button', { name: 'renamed.sv', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '定位引用 1：demo.sv', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '已定位引用来源。' })).toBeVisible()
  const editor = page.locator('.monaco-editor textarea.inputarea')
  await editor.focus()
  const endOfDocument = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End'
  await page.keyboard.press(endOfDocument)
  await page.keyboard.insertText('// 已编辑')
  await page.getByRole('button', { name: '定位引用 1：demo.sv', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: '来源内容已改变' })).toBeVisible()
  await selectAllCode(page)
  await expect(refs(page)).toHaveCount(2)
  expect(await refs(page).nth(0).locator('pre').textContent()).toBe(original.slice(1))
  expect(await refs(page).nth(1).locator('pre').textContent()).toContain('// 已编辑')
  await expect.poll(async () => (await draftOf(page, activityId)).references.length).toBe(2)
  await page.getByRole('button', { name: '删除文件', exact: true }).click()
  await expect(page.getByRole('button', { name: 'renamed.sv', exact: true })).toHaveCount(0)
  await page.reload()
  await openComposer(page)
  await expect(refs(page)).toHaveCount(2)
  expect(await refs(page).nth(0).locator('pre').textContent()).toBe(original.slice(1))
  const finalDraft = await draftOf(page, activityId)
  expect(finalDraft.references).toHaveLength(2)
  expect(finalDraft.references[0].copy).toBe(original.slice(1))
  await page.screenshot({ path: fileURLToPath(new URL('../../../.verification/152/chrome-code-draft.png', import.meta.url)), fullPage: true })
})

test('an existing reliable workspace database upgrades without losing its work', async ({ page }) => {
  const activityId = await personalActivity(page)
  const context = await (await page.request.get(endpoint + '/api/learning/context', { headers: { 'x-xj-space': 'personal' } })).json()
  const identity = context.identities[0].identity
  const key = JSON.stringify([context.clientNamespace, identity.environmentId, identity.spaceId, identity.principalId, activityId])
  const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'legacy.sv', kind: 'code',
    encoding: 'utf8', mediaType: 'text/plain', value: '// v1 记录\nmodule legacy;\nendmodule\n' }
  await page.goto(endpoint + '/?diagnostics=1')
  await page.evaluate(async ({ key, file }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('xunjie-reliable-works-v1', 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore('workspaces', { keyPath: 'key' })
        request.result.createObjectStore('candidates', { keyPath: 'id' }).createIndex('scope', 'scope')
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result
        const tx = db.transaction('workspaces', 'readwrite')
        tx.objectStore('workspaces').put({ key, localRevision: 0, remoteRevision: 0,
          confirmedFiles: [file], files: [file], pending: null })
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onerror = () => reject(tx.error)
      }
    })
  }, { key, file })
  await page.goto(endpoint + '/?activity=' + activityId)
  await expect(page.getByRole('button', { name: 'legacy.sv', exact: true })).toBeVisible()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('module legacy;')
  expect(await page.evaluate(async () => new Promise(resolve => {
    const request = indexedDB.open('xunjie-reliable-works-v1')
    request.onsuccess = () => {
      const db = request.result
      resolve({ version: db.version, stores: [...db.objectStoreNames] })
    }
  }))).toEqual({ version: 2, stores: ['candidates', 'draftCandidates', 'drafts', 'workspaces'] })
})

async function draftDriver(page: Page, activityId: string) {
  const { build } = await import('esbuild')
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/reliable-workspace/draft.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'browser' })
  await page.route('**/__draft_public_interface.js', route => route.fulfill({ contentType: 'application/javascript', body: bundle.outputFiles[0].text }))
  await page.goto(endpoint + '/?diagnostics=1')
  const context = await (await page.request.get(endpoint + '/api/learning/context')).json()
  const identity = context.identities.find((item: { key: string }) => item.key === 'personal').identity
  return { key: JSON.stringify([context.clientNamespace, identity.environmentId, identity.spaceId, identity.principalId, activityId]),
    base: '/api/learning/drafts/' + activityId, moduleUrl: endpoint + '/__draft_public_interface.js' }
}

test('a restored draft resumes periodic sync after authentication recovers', async ({ page }) => {
  const activityId = await personalActivity(page)
  const driver = await draftDriver(page, activityId)
  await page.evaluate(async ({ key, base, moduleUrl }) => {
    const { ReliableQuestionDraft } = await import(moduleUrl)
    const request = async (suffix: string, body?: unknown) => {
      const response = await fetch(base + suffix, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const result = await response.json()
      if (!response.ok) throw Object.assign(new Error(result.error), { code: result.error })
      return result
    }
    const draft = new ReliableQuestionDraft(key, { read: () => request(''),
      receipt: (id: string) => request('/receipts/' + id), sync: (body: unknown) => request('', body) })
    await draft.open()
    draft.suspend()
    draft.resume()
    await new Promise(resolve => setTimeout(resolve, 1200))
    draft.change('After context recovery', [])
  }, driver)
  await expect.poll(async () => (await draftOf(page, activityId)).question, { timeout: 15000 }).toBe('After context recovery')
})

test('a local conflict candidate retains an unsynchronized code basis across reload', async ({ page }) => {
  const activityId = await personalActivity(page)
  const file = { objectId: randomUUID(), contentId: randomUUID(), name: 'retained.sv', kind: 'code',
    encoding: 'utf8', mediaType: 'text/plain', value: 'module retained;\nendmodule\n' }
  expect((await page.request.post(endpoint + '/api/learning/workspaces/' + activityId,
    { headers: { 'x-xj-space': 'personal' }, data: { requestId: randomUUID(), baseRevision: 0, files: [file] } })).status()).toBe(200)
  const basis = { ...file, contentId: randomUUID(), value: 'module selected;\nendmodule\n' }
  const reference = { referenceId: randomUUID(), source: { kind: 'work', objectId: file.objectId, contentId: basis.contentId },
    range: { kind: 'code', start: 0, end: basis.value.length }, copy: basis.value, sourceName: file.name }
  const driver = await draftDriver(page, activityId)
  await page.evaluate(async ({ key, base, moduleUrl, basis, reference }) => {
    const { ReliableQuestionDraft } = await import(moduleUrl)
    const request = async (suffix: string, body?: unknown) => {
      const response = await fetch(base + suffix, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const result = await response.json()
      if (!response.ok) throw Object.assign(new Error(result.error), { code: result.error })
      return result
    }
    const transport = { read: () => request(''), receipt: (id: string) => request('/receipts/' + id), sync: (body: unknown) => request('', body) }
    const first = new ReliableQuestionDraft(key, transport), second = new ReliableQuestionDraft(key, transport)
    await first.open(); await second.open()
    first.suspend(); second.suspend()
    first.change('Selected original', [reference], [basis])
    second.change('The other tab wins the local transaction', [])
    await second.protect()
    await first.protect().catch(() => {})
    if (!first.snapshot().conflict) throw new Error('The controlled local competition was not created')
    first.dispose(); second.dispose()
    const restored = new ReliableQuestionDraft(key, transport)
    restored.suspend()
    await restored.open()
    const conflict = restored.snapshot().conflict
    if (!conflict) throw new Error('The protected conflict candidate was not restored')
    await restored.resolve(conflict.local.question, conflict.local.references)
    restored.resume()
  }, { ...driver, basis, reference })
  await expect.poll(async () => (await draftOf(page, activityId)).references[0]?.copy, { timeout: 15000 }).toBe(basis.value)
  const head = await (await page.request.get(endpoint + '/api/learning/workspaces/' + activityId,
    { headers: { 'x-xj-space': 'personal' } })).json()
  expect(head.files[0].value).toBe(file.value)
})

test('local storage refusal keeps memory and retries automatically', async ({ page }) => {
  const activityId = await personalActivity(page)
  await page.goto(endpoint + '/?activity=' + activityId)
  await openComposer(page)
  await page.evaluate(() => {
    const fault = { blocked: true }
    ;(window as unknown as { draftStorageFault: typeof fault }).draftStorageFault = fault
    const put = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (fault.blocked && this.name === 'drafts') throw new DOMException('Controlled quota refusal', 'QuotaExceededError')
      return put.apply(this, args)
    }
  })
  await question(page).fill('配额失败时仍保留的问题')
  await expect(page.getByRole('alert').filter({ hasText: '本机存储未能保护当前问题草稿' })).toBeVisible()
  await expect(question(page)).toHaveValue('配额失败时仍保留的问题')
  await page.evaluate(() => { (window as unknown as { draftStorageFault: { blocked: boolean } }).draftStorageFault.blocked = false })
  await expect.poll(async () => (await draftOf(page, activityId)).question).toBe('配额失败时仍保留的问题')
  await expect(page.getByRole('alert').filter({ hasText: '本机存储未能保护当前问题草稿' })).toHaveCount(0)
  await expect(question(page)).toHaveValue('配额失败时仍保留的问题')
})

test('two actual tabs preserve both local drafts until an explicit choice', async ({ page }) => {
  const activityId = await personalActivity(page)
  await page.goto(endpoint + '/?activity=' + activityId)
  await openComposer(page)
  const second = await page.context().newPage()
  try {
    await second.goto(endpoint + '/?activity=' + activityId)
    await openComposer(second)
    await question(page).fill('标签页 A')
    await question(second).fill('标签页 B')
    const conflict = (target: Page) => target.getByRole('heading', { name: '问题草稿存在分歧' })
    await expect.poll(async () => (await conflict(page).isVisible().catch(() => false))
      || (await conflict(second).isVisible().catch(() => false)), { timeout: 15000 }).toBe(true)
    const loser = await conflict(page).isVisible().catch(() => false) ? page : second
    await expect(loser.getByRole('alert').getByText('标签页 A', { exact: true })).toBeVisible()
    await expect(loser.getByRole('alert').getByText('标签页 B', { exact: true })).toBeVisible()
    await expect(loser.getByText('本页与另一版本均保留，请比较后明确选择。', { exact: true })).toBeVisible()
    await loser.getByRole('button', { name: '采用本页草稿', exact: true }).click()
    await expect(loser.getByRole('heading', { name: '问题草稿存在分歧' })).toHaveCount(0)
  } finally { await second.close() }
})

test('another client conflict keeps both drafts and a late acknowledgement never settles later input', async ({ page }) => {
  test.setTimeout(180000)
  const activityId = await personalActivity(page)
  await page.goto(endpoint + '/?activity=' + activityId)
  await openComposer(page)
  let block = true
  await page.route('**/api/learning/drafts/**', async route => {
    if (block && route.request().method() === 'POST') return route.abort('connectionfailed')
    await route.continue()
  })
  await question(page).fill('本页草稿 A')
  await page.waitForTimeout(800)
  const draft = await draftOf(page, activityId)
  const other = await page.request.post(endpoint + '/api/learning/drafts/' + activityId,
    { headers: { 'x-xj-space': 'personal' }, data: { requestId: randomUUID(), draftId: draft.draftId,
      baseRevision: 0, question: '另一客户端 B', references: [], bases: [] } })
  expect(other.status()).toBe(200)
  const otherView = await other.json()
  block = false
  await expect(page.getByRole('heading', { name: '问题草稿存在分歧' })).toBeVisible({ timeout: 15000 })
  await expect(page.getByRole('alert').getByText('本页草稿 A', { exact: true })).toBeVisible()
  await expect(page.getByRole('alert').getByText('另一客户端 B', { exact: true })).toBeVisible()
  await page.screenshot({ path: fileURLToPath(new URL('../../../.verification/152/chrome-draft-conflict.png', import.meta.url)), fullPage: true })
  await page.getByRole('button', { name: '采用本页草稿', exact: true }).click()
  await expect.poll(async () => (await draftOf(page, activityId)).question).toBe('本页草稿 A')
  const resolved = await draftOf(page, activityId)
  expect(resolved.revision).toBe(2)
  const preserved = await page.request.get(endpoint + `/api/learning/drafts/${activityId}/revisions/${otherView.revisionId}`,
    { headers: { 'x-xj-space': 'personal' } })
  expect((await preserved.json()).question).toBe('另一客户端 B')
  await page.unroute('**/api/learning/drafts/**')

  const lateActivity = await personalActivity(page)
  await page.goto(endpoint + '/?activity=' + lateActivity)
  await openComposer(page)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let admitted!: () => void
  const started = new Promise<void>(resolve => { admitted = resolve })
  let first = true
  let firstRequestId = ''
  await page.route(`**/api/learning/drafts/${lateActivity}`, async route => {
    if (first && route.request().method() === 'POST') {
      first = false
      firstRequestId = route.request().postDataJSON().requestId
      admitted()
      await held
    }
    await route.continue()
  })
  await question(page).fill('第一版问题')
  await started
  await question(page).fill('第二版问题（确认期间继续输入）')
  await page.waitForTimeout(500)
  release()
  await expect.poll(async () => {
    const response = await page.request.get(endpoint + `/api/learning/drafts/${lateActivity}/receipts/${firstRequestId}`,
      { headers: { 'x-xj-space': 'personal' } })
    const value = response.ok() ? await response.json() : null
    return value?.question ?? ''
  }, { timeout: 15000 }).toBe('第一版问题')
  await expect.poll(async () => (await draftOf(page, lateActivity)).question, { timeout: 15000 })
    .toBe('第二版问题（确认期间继续输入）')
  expect((await draftOf(page, lateActivity)).revision).toBe(2)
})
