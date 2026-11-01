import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication, resolveCredential } from '@xunjie/product-runtime'
import { controlledActionReceiver } from '../../server/tests/support/action-receiver.mjs'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
let runtime: ReturnType<typeof openProductRuntime>, endpoint: string, bundle: string
let host: Awaited<ReturnType<typeof createProductRuntimeHost>>
let runtimeRoot = ''
type BrowserDriver = Awaited<ReturnType<typeof import('./support/action-workspace').openActionWorkspace>>
declare global { interface Window { actionIntentDriver?: BrowserDriver } }
const receiver = controlledActionReceiver()
const cases: { name: string; status: string | undefined; durationMs: number }[] = []
let browserVersion = ''
test.beforeAll(async ({ browser }) => {
  browserVersion = browser.version()
  await mkdir(fileURLToPath(new URL('../../../.verification/153', import.meta.url)), { recursive: true })
  const root = await mkdtemp(join(tmpdir(), 'xj-intents-chrome-'))
  runtimeRoot = root
  runtime = openProductRuntime({ root, resources: {
    nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
  await runtime.install({ profile: 'local' })
  host = await createProductRuntimeHost({ root,
    createApplication: context => createProductLearningApplication(context, { receivers: [receiver] }) })
  endpoint = host.endpoint
  bundle = (await build({ stdin: { contents: `export { ReliableWorkspace } from './index'; export { ReliableQuestionDraft } from './draft'; export { openActionWorkspace } from '../../e2e/support/action-workspace'`,
    resolveDir: fileURLToPath(new URL('../src/reliable-workspace', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'browser' })).outputFiles[0].text
})

test('quota refusal sends nothing and an unsent cancellation survives a new workspace instance', async ({ page }) => {
  const config = await driver(page)
  const result = await page.evaluate(async config => {
    const { openActionWorkspace } = await import(config.moduleUrl)
    const session = await openActionWorkspace(config)
    session.workspace.suspend(); session.draft.suspend(); session.actions.suspend()
    session.draft.change('未保护时不能发出的原文', [])
    const put = IDBObjectStore.prototype.put
    let refuse = true
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (refuse && this.name === 'actions') throw new DOMException('Controlled quota refusal', 'QuotaExceededError')
      return put.apply(this, args)
    }
    const id = crypto.randomUUID()
    let rejected = false
    try { await session.actions.create({ requestId: id, receiver: { receiverId: 'future-agent', location: 'remote', kind: 'question' } }) }
    catch { rejected = true }
    const before = await session.request(session.actionPath + '/' + id)
    const unprotected = await session.actions.read(id)
    let cancelRefused = false
    try { await session.actions.cancel(id) } catch { cancelRefused = true }
    refuse = false
    const deadline = Date.now() + 2500
    while ((await session.actions.read(id)).phase !== 'cancelled' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    const cancelled = await session.actions.read(id)
    session.dispose()
    const reopened = await openActionWorkspace(config)
    const restored = await reopened.actions.read(id)
    await new Promise(resolve => setTimeout(resolve, 1300))
    const after = await reopened.request(reopened.actionPath + '/' + id)
    reopened.dispose(); IDBObjectStore.prototype.put = put
    return { rejected, cancelRefused, before, unprotected, cancelled, restored, after }
  }, config)
  expect(result.rejected).toBe(true)
  expect(result.cancelRefused).toBe(true)
  expect(result.before).toBeNull()
  expect(result.unprotected.phase).toBe('unprotected')
  expect(result.cancelled.phase).toBe('cancelled')
  expect(result.restored.phase).toBe('cancelled')
  expect(result.restored.input.draft.question).toBe('未保护时不能发出的原文')
  expect(result.after).toBeNull()
})
test.afterEach(async ({}, info) => { cases.push({ name: info.title, status: info.status, durationMs: info.duration }) })
test.afterAll(async () => {
  await host?.stop()
  await writeFile(fileURLToPath(new URL('../../../.verification/153/chrome-results.json', import.meta.url)), JSON.stringify({
    measuredAt: new Date().toISOString(), node: process.version, postgres: '18.6', platform: process.platform, arch: process.arch,
    osRelease: release(), browser: 'installed Chrome', browserVersion, headless: false, cases,
    receiverScope: 'Public workspace API and actual IndexedDB/HTTP/PG; no real Agent, execution or teacher receiver.' }, null, 2))
})
async function driver(page: Page, provided?: { activityId: string; identity: { environmentId: string; spaceId: string; principalId: string } }) {
  let activity = provided
  if (!activity) {
    const created = await page.request.post(endpoint + '/api/learning/activities', { headers: { 'x-xj-space': 'personal' },
      data: { requestId: randomUUID(), goal: '固定问题并继续编辑', question: '', references: [] } })
    expect(created.status()).toBe(200); activity = await created.json()
  }
  const actual = activity!
  await page.route('**/__action_public_interface.js', route => route.fulfill({ contentType: 'application/javascript', body: bundle }))
  await page.goto(endpoint + '/?diagnostics=1')
  const context = await (await page.request.get(endpoint + '/api/learning/context')).json()
  return { key: JSON.stringify([context.clientNamespace, actual.identity.environmentId, actual.identity.spaceId,
    actual.identity.principalId, actual.activityId]), base: '/api/learning/', activityId: actual.activityId, spaceKey: provided ? 'school' : 'personal',
    moduleUrl: endpoint + '/__action_public_interface.js' }
}

test('one workspace call durably captures A while later edits B continue and reload keeps the same action', async ({ page }) => {
  const config = await driver(page)
  const result = await page.evaluate(async ({ key, base, activityId, moduleUrl }) => {
    const { ReliableWorkspace, ReliableQuestionDraft } = await import(moduleUrl)
    const request = async (route: string, body?: unknown) => {
      const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
      const value = await response.json()
      if (!response.ok) throw Object.assign(new Error(value.error), { code: value.error })
      return value
    }
    const workPath = 'workspaces/' + activityId, draftPath = 'drafts/' + activityId, actionPath = 'intents/' + activityId
    const workspace = new ReliableWorkspace(key, { read: () => request(workPath),
      receipt: (id: string) => request(workPath + '/receipts/' + id), sync: (body: unknown) => request(workPath, body) })
    const draft = new ReliableQuestionDraft(key, { read: () => request(draftPath),
      receipt: (id: string) => request(draftPath + '/receipts/' + id), sync: (body: unknown) => request(draftPath, body) })
    await workspace.open(); await draft.open()
    workspace.suspend(); draft.suspend()
    const transport = { prepare: (body: unknown) => request(actionPath, body),
      list: () => request(actionPath), read: (id: string) => request(actionPath + '/' + id),
      dispatch: (id: string) => request(actionPath + '/' + id + '/dispatch', {}),
      cancel: (id: string) => request(actionPath + '/' + id + '/cancel', {}), capabilities: () => request(actionPath + '/capabilities') }
    const actions = workspace.actions(draft, transport)
    actions.suspend(); await actions.open()
    const id = workspace.create('当时.c')
    workspace.edit(id, '\uFEFF甲\r\n乙😀\r\n'); draft.change('固定问题 A', [])
    const requestId = crypto.randomUUID()
    const creating = actions.create({ requestId, receiver: { receiverId: 'future-agent', location: 'remote', kind: 'question' } })
    workspace.edit(id, '后来持续写 B'); draft.change('后来问题 B', [])
    const fixed = await creating
    await workspace.protect(); await draft.protect()
    actions.dispose()
    const restored = workspace.actions(draft, transport)
    restored.suspend(); await restored.open()
    const recovered = await restored.read(requestId)
    restored.resume()
    await new Promise(resolve => setTimeout(resolve, 1300))
    const remote = await request(actionPath + '/' + requestId)
    const output = { fixed: fixed.input, recovered: recovered.input, remote: remote.input,
      state: remote.state, files: workspace.snapshot().files, question: draft.snapshot().question }
    restored.dispose(); workspace.dispose(); draft.dispose()
    return output
  }, config)
  expect(result.fixed.draft.question).toBe('固定问题 A')
  expect(result.fixed.works[0].value).toBe('\uFEFF甲\r\n乙😀\r\n')
  expect(result.recovered).toEqual(result.fixed)
  expect(result.remote).toEqual(result.fixed)
  expect(result.state).toBe('prepared')
  expect(result.question).toBe('后来问题 B')
  expect(result.files[0].value).toBe('后来持续写 B')
})

test('production composer shows pending facts and late acceptance keeps the newer question', async ({ page }) => {
  const config = await driver(page)
  const originalFile = { objectId: randomUUID(), contentId: randomUUID(), name: 'continue.c', kind: 'code',
    encoding: 'utf8', mediaType: 'text/plain', value: '// 发送时的作品 A\r\nint value = 1;\r\n' }
  expect((await page.request.post(endpoint + '/api/learning/workspaces/' + config.activityId,
    { headers: { 'x-xj-space': 'personal' }, data: { requestId: randomUUID(), baseRevision: 0, files: [originalFile] } })).status()).toBe(200)
  await page.goto(endpoint + '/?activity=' + config.activityId)
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  const question = page.getByRole('textbox', { name: '你的问题', exact: true })
  await expect(question).toBeEnabled()
  await question.fill('发送时的问题 A')
  const unblock = receiver.holdAccept()
  try {
    const send = page.getByRole('button', { name: '发送问题', exact: true })
    await expect(send).toBeEnabled()
    await send.click()
    const records = page.getByRole('region', { name: '待发与接收记录', exact: true })
    await expect(records).toContainText('发送时的问题 A')
    await expect(records).toContainText('已发出，正在核实')
    await question.fill('发送后继续写的问题 B')
    const editor = page.locator('.monaco-editor textarea.inputarea')
    await expect(editor).toBeVisible(); await editor.focus()
    const modifier = await page.evaluate(() => navigator.userAgent.includes('Macintosh') ? 'Meta' : 'Control')
    await page.keyboard.press(`${modifier}+a`)
    await page.keyboard.insertText('// 后续继续编辑的作品 B\nint value = 2;\n')
    unblock()
    await expect(records).toContainText('接收方已接受')
    await expect(question).toHaveValue('发送后继续写的问题 B')
    const views = await (await page.request.get(endpoint + '/api/learning/intents/' + config.activityId,
      { headers: { 'x-xj-space': 'personal' } })).json()
    expect(views).toHaveLength(1)
    expect(receiver.acceptedInput(views[0].input.requestId)?.draft.question).toBe('发送时的问题 A')
    expect(receiver.acceptedInput(views[0].input.requestId)?.works[0].value).toBe(originalFile.value)
    // Reload tests already protected content; an edit inside the 250 ms window is guarded by beforeunload.
    await expect.poll(async () => (await (await page.request.get(endpoint + '/api/learning/drafts/' + config.activityId,
      { headers: { 'x-xj-space': 'personal' } })).json()).question).toBe('发送后继续写的问题 B')
    await expect.poll(async () => (await (await page.request.get(endpoint + '/api/learning/workspaces/' + config.activityId,
      { headers: { 'x-xj-space': 'personal' } })).json()).files[0].value).toContain('后续继续编辑的作品 B')
    await page.reload()
    await expect(page.getByRole('region', { name: '待发与接收记录', exact: true })).toContainText('接收方已接受')
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await expect(question).toHaveValue('发送后继续写的问题 B')
    await page.screenshot({ path: fileURLToPath(new URL('../../../.verification/153/chrome-pending-and-new-draft.png', import.meta.url)), fullPage: true })
  } finally { unblock() }
})

test('rejected contents recover as an independent draft and merge only after an explicit choice', async ({ page }) => {
  const config = await driver(page)
  await page.goto(endpoint + '/?activity=' + config.activityId)
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  const question = page.getByRole('textbox', { name: '你的问题', exact: true })
  await expect(question).toBeEnabled(); await question.fill('拒绝此问题')
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  const records = page.getByRole('region', { name: '待发与接收记录', exact: true })
  await expect(records).toContainText('未被接受')
  await question.fill('后来独立写下的新问题')
  await records.getByRole('button', { name: '恢复为独立草稿', exact: true }).click()
  await expect(records.getByRole('textbox', { name: '取回的问题', exact: true })).toHaveValue('拒绝此问题')
  await expect(question).toHaveValue('后来独立写下的新问题')
  await records.getByRole('button', { name: '明确合并到当前问题', exact: true }).click()
  await expect(question).toHaveValue('后来独立写下的新问题\n\n拒绝此问题')
  await expect(records).toContainText('未被接受')
})

test('a local input receiver gets durable fixed typed inputs without waiting for any remote dependency', async ({ page }) => {
  const config = await driver(page)
  await page.route('**/api/learning/intents/**', route => route.abort('failed'))
  const result = await page.evaluate(async config => {
    const { openActionWorkspace } = await import(config.moduleUrl)
    const session = await openActionWorkspace(config)
    session.workspace.suspend(); session.draft.suspend(); session.actions.suspend()
    const files = [
      { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: '输入.txt', kind: 'text', encoding: 'utf8', mediaType: 'text/plain', value: '\uFEFF原输入\r\n😀' },
      { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: '组件状态', kind: 'state', encoding: 'json', mediaType: 'application/json', value: '{"switch":true}' },
      { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: '输入资源', kind: 'resource', encoding: 'base64', mediaType: 'application/octet-stream', value: 'AQID' },
    ]
    session.workspace.change(files); session.draft.change('本机固定输入', [])
    const receipts = new Map(), received: unknown[] = []
    const identity = { receiverId: 'test-local-input-handoff', location: 'local', kind: 'execution' }
    session.actions.registerLocal({ identity,
      query: async (id: string) => receipts.get(id) ?? null,
      accept: async (input: unknown, inputDigest: string) => {
        const action = input as { requestId: string }
        const known = receipts.get(action.requestId)
        if (known) return known
        const receipt = { requestId: action.requestId, receiver: identity, inputDigest, state: 'accepted', receiptId: crypto.randomUUID(), detail: '只接纳固定输入，不运行实验' }
        received.push(input); receipts.set(action.requestId, receipt); return receipt
      }, cancel: async () => null,
    })
    const requestId = crypto.randomUUID(), nextId = crypto.randomUUID()
    await session.actions.create({ requestId, receiver: identity })
    await session.actions.create({ requestId, receiver: identity })
    await session.actions.create({ requestId: nextId, receiver: identity })
    session.workspace.edit(files[0].objectId, '后来的输入'); session.draft.change('后来的问题', [])
    session.actions.resume()
    const deadline = Date.now() + 5000
    while ((await session.actions.read(nextId)).phase !== 'accepted' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    const first = await session.actions.read(requestId), second = await session.actions.read(nextId)
    session.dispose()
    return { first, second, received, files }
  }, config)
  expect(result.first.phase).toBe('accepted'); expect(result.second.phase).toBe('accepted')
  expect(result.received).toHaveLength(2)
  expect(result.first.input.works).toEqual(result.files)
  expect(result.second.input.works).toEqual(result.files)
  expect(result.first.input.requestId).not.toBe(result.second.input.requestId)
  expect(result.first.input.draft.question).toBe('本机固定输入')
  expect(result.first.remote).toBeUndefined()
})

test('a new client namespace preserves the old queue and only explicit verified reconnection resumes its original identity', async ({ page }) => {
  const config = await driver(page)
  const result = await page.evaluate(async config => {
    const { openActionWorkspace } = await import(config.moduleUrl)
    const old = await openActionWorkspace(config)
    old.workspace.suspend(); old.draft.suspend(); old.actions.suspend()
    old.draft.change('旧环境留下的原问题', [])
    const fixed = await old.actions.create({ requestId: crypto.randomUUID(),
      receiver: { receiverId: 'controlled-agent', location: 'remote', kind: 'question' } })
    await old.request(old.actionPath, fixed.input)
    old.dispose()
    const scope = JSON.parse(config.key); scope[0] = 'explicit-new-client-namespace'
    const fresh = await openActionWorkspace({ ...config, key: JSON.stringify(scope) })
    await new Promise(resolve => setTimeout(resolve, 1300))
    const before = await fresh.request(fresh.actionPath + '/' + fixed.input.requestId)
    const candidates = await fresh.actions.previous()
    await fresh.actions.reconnect(fixed.input.requestId, config.key)
    const deadline = Date.now() + 5000
    while ((await fresh.actions.read(fixed.input.requestId))?.phase !== 'accepted' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    const adopted = await fresh.actions.read(fixed.input.requestId)
    const oldStillExists = await old.actions.read(fixed.input.requestId)
    fresh.dispose()
    return { before, candidates, adopted, oldStillExists }
  }, config)
  expect(result.before.state).toBe('prepared')
  expect(result.candidates).toHaveLength(1)
  expect(result.adopted.phase).toBe('accepted')
  expect(result.adopted.input.requestId).toBe(result.oldStillExists.input.requestId)
  expect(result.adopted.input).toEqual(result.oldStillExists.input)
  expect(result.oldStillExists.phase).toBe('waiting-dependencies')
})

test('expired school membership blocks dispatch and original reauthorization resumes without another create', async ({ page }) => {
  const control = await resolveCredential(runtimeRoot, 'control'), password = randomUUID(), loginName = 'intent-' + randomUUID()
  const manage = async (route: string, data: unknown) => {
    const response = await page.request.post(endpoint + '/api/learning/manage/' + route,
      { headers: { authorization: 'Bearer ' + control }, data })
    expect(response.status()).toBe(200); return response.json()
  }
  const member = await manage('members', { requestId: randomUUID(), loginName, password })
  expect((await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status()).toBe(200)
  const created = await page.request.post(endpoint + '/api/learning/activities',
    { data: { requestId: randomUUID(), goal: '恢复原资格后继续', question: '', references: [] } })
  expect(created.status()).toBe(200)
  const config = await driver(page, await created.json())
  const id = await page.evaluate(async config => {
    const { openActionWorkspace } = await import(config.moduleUrl)
    const session = await openActionWorkspace(config)
    window.actionIntentDriver = session
    session.workspace.suspend(); session.draft.suspend(); session.actions.suspend()
    session.draft.change('授权恢复后仍是这一请求', [])
    const requestId = crypto.randomUUID()
    await session.actions.create({ requestId, receiver: { receiverId: 'controlled-agent', location: 'remote', kind: 'question' } })
    return requestId
  }, config)
  try {
    await manage('membership', { requestId: randomUUID(), principalId: member.principalId, active: false })
    await page.evaluate(() => window.actionIntentDriver!.actions.resume())
    await expect.poll(() => page.evaluate(() => window.actionIntentDriver!.actions.snapshot().active)).toBe(false)
    expect(receiver.acceptedInput(id)).toBeUndefined()
    await manage('membership', { requestId: randomUUID(), principalId: member.principalId, active: true })
    expect((await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status()).toBe(200)
    await expect.poll(() => page.evaluate(async id => (await window.actionIntentDriver!.actions.read(id))!.phase, id), { timeout: 15000 }).toBe('accepted')
    expect(receiver.acceptedInput(id)?.scope.principalId).toBe(member.principalId)
    expect(receiver.acceptedInput(id)?.requestId).toBe(id)
  } finally { await page.evaluate(() => { window.actionIntentDriver?.dispose(); delete window.actionIntentDriver }) }
})

test('two actual tabs cannot revive a cancellation committed before their resumed dispatch', async ({ page, context }) => {
  const config = await driver(page)
  const second = await context.newPage()
  await second.route('**/__action_public_interface.js', route => route.fulfill({ contentType: 'application/javascript', body: bundle }))
  await second.goto(endpoint + '/?diagnostics=1')
  const id = await page.evaluate(async config => {
    const { openActionWorkspace } = await import(config.moduleUrl)
    const session = await openActionWorkspace(config); window.actionIntentDriver = session
    session.workspace.suspend(); session.draft.suspend(); session.actions.suspend()
    session.draft.change('两个标签也不能复活取消', [])
    const requestId = crypto.randomUUID()
    await session.actions.create({ requestId, receiver: { receiverId: 'controlled-agent', location: 'remote', kind: 'question' } })
    return requestId
  }, config)
  try {
    await second.evaluate(async ({ config, id }) => {
      const { openActionWorkspace } = await import(config.moduleUrl)
      const session = await openActionWorkspace(config); window.actionIntentDriver = session
      session.actions.suspend(); await session.actions.cancel(id)
    }, { config, id })
    await Promise.all([page.evaluate(() => window.actionIntentDriver!.actions.resume()),
      second.evaluate(() => window.actionIntentDriver!.actions.resume())])
    await page.waitForTimeout(1300)
    const read = (tab: Page) => tab.evaluate(async id => window.actionIntentDriver!.actions.read(id), id)
    expect((await read(page))!.phase).toBe('cancelled'); expect((await read(second))!.phase).toBe('cancelled')
    expect(receiver.acceptedInput(id)).toBeUndefined()
    await second.reload()
    await second.evaluate(async config => {
      const { openActionWorkspace } = await import(config.moduleUrl)
      window.actionIntentDriver = await openActionWorkspace(config)
    }, config)
    expect((await read(second))!.phase).toBe('cancelled')
  } finally {
    await page.evaluate(() => { window.actionIntentDriver?.dispose(); delete window.actionIntentDriver })
    await second.evaluate(() => { window.actionIntentDriver?.dispose(); delete window.actionIntentDriver }); await second.close()
  }
})

test('accepted but lost replies remain unknown through reopening and reconcile without changing identity or the new draft', async ({ page }) => {
  const config = await driver(page)
  receiver.loseNextReply({ offline: true })
  const id = await page.evaluate(async config => {
    const { openActionWorkspace } = await import(config.moduleUrl)
    const session = await openActionWorkspace(config); window.actionIntentDriver = session
    session.workspace.suspend(); session.draft.suspend(); session.actions.suspend()
    session.draft.change('回包丢失的固定问题', [])
    const requestId = crypto.randomUUID()
    await session.actions.create({ requestId, receiver: { receiverId: 'controlled-agent', location: 'remote', kind: 'question' } })
    session.draft.change('未知期间的新草稿', []); await session.draft.protect()
    session.actions.resume(); return requestId
  }, config)
  try {
    await expect.poll(() => receiver.acceptedInput(id)?.requestId).toBe(id)
    await expect.poll(() => page.evaluate(async id => (await window.actionIntentDriver!.actions.read(id))!.phase, id)).toBe('dispatched')
    await page.evaluate(async config => {
      window.actionIntentDriver!.dispose()
      const { openActionWorkspace } = await import(config.moduleUrl)
      window.actionIntentDriver = await openActionWorkspace(config)
    }, config)
    expect(await page.evaluate(async id => (await window.actionIntentDriver!.actions.read(id))!.phase, id)).toBe('dispatched')
    receiver.offline(false)
    await expect.poll(() => page.evaluate(async id => (await window.actionIntentDriver!.actions.read(id))!.phase, id)).toBe('accepted')
    expect(await page.evaluate(() => window.actionIntentDriver!.draft.snapshot().question)).toBe('未知期间的新草稿')
    const stored = await (await page.request.get(`${endpoint}/api/learning/intents/${config.activityId}/${id}`,
      { headers: { 'x-xj-space': 'personal' } })).json()
    expect(stored.input.requestId).toBe(id); expect(stored.input.draft.question).toBe('回包丢失的固定问题')
    expect(stored.receipt.requestId).toBe(id)
    expect(receiver.acceptedIds().filter(value => value === id)).toHaveLength(1)
  } finally {
    receiver.offline(false)
    await page.evaluate(() => { window.actionIntentDriver?.dispose(); delete window.actionIntentDriver })
  }
})
