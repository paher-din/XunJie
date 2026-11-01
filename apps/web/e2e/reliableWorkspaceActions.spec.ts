import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir, release as osRelease } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication } from '@xunjie/product-runtime'
import { controlledActionReceiver } from '../../server/tests/support/action-receiver.mjs'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
let runtime: ReturnType<typeof openProductRuntime>, endpoint = ''
let host: Awaited<ReturnType<typeof createProductRuntimeHost>>
let bundle = ''
type Session = Awaited<ReturnType<typeof import('./support/action-workspace').openActionWorkspace>>
declare global { interface Window { reliableDriver?: Session } }
const receiver = controlledActionReceiver()
interface Config { key: string; base: string; activityId: string; spaceKey: string; moduleUrl: string
  scope: { environmentId: string; spaceId: string; principalId: string; activityId: string } }
const cases: { name: string; status: string | undefined; durationMs: number }[] = []
let browserVersion = ''
let runtimeRoot = '', headless = true
test.beforeAll(async ({ browser }, info) => {
  browserVersion = browser.version()
  headless = info.project.use.headless !== false
  await mkdir(fileURLToPath(new URL('../../../.verification/157', import.meta.url)), { recursive: true })
  const root = await mkdtemp(join(tmpdir(), 'xj-reliable-actions-'))
  runtimeRoot = root
  runtime = openProductRuntime({ root, resources: {
    nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
  await runtime.install({ profile: 'local' })
  host = await createProductRuntimeHost({ root,
    createApplication: context => createProductLearningApplication(context, { receivers: [receiver] }) })
  endpoint = host.endpoint
  bundle = (await build({ stdin: { contents: `export { ReliableWorkspace } from './index'; export { ReliableQuestionDraft } from './draft'; export { openActionWorkspace } from '../../e2e/support/action-workspace'`,
    resolveDir: fileURLToPath(new URL('../src/reliable-workspace', import.meta.url)) }, bundle: true, write: false, format: 'esm', platform: 'browser' })).outputFiles[0].text
})

test('an unverifiable cancellation stays a recorded intent instead of reporting success', async ({ page }) => {
  const config = await driver(page)
  const requestId = randomUUID()
  await prepareRemote(page, config, requestId, '另一客户端已经接受的原问题')
  await openSession(page, config)
  // This page only holds the imported prepared view, exactly like a reopened history record.
  await expect.poll(() => viewOf(page, requestId), { timeout: 15000 })
    .toEqual({ history: true, phase: 'ready', state: 'prepared', cancelRequested: false })
  await reopenSession(page, config)
  await expect.poll(() => viewOf(page, requestId), { timeout: 15000 }).toEqual({ history: true, phase: 'ready', state: 'prepared', cancelRequested: false })
  // Neither the read of this request nor the authoritative list can be reached from this browser.
  const blocked = [intentPath(config), intentPath(config, requestId)]
  for (const path of blocked) await page.route(path, route => route.abort('failed'))
  try {
    // Another client dispatched it and the receiver accepted, but this page cannot verify that yet.
    const dispatched = await page.request.post(intentPath(config, requestId) + '/dispatch',
      { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' }, data: {} })
    expect(dispatched.status()).toBe(200)
    expect(receiver.acceptedInput(requestId)?.requestId).toBe(requestId)
    const cancelled = await page.evaluate(async id => {
      await window.reliableDriver!.actions.cancel(id)
      const item = (await window.reliableDriver!.actions.read(id))!
      return { phase: item.phase, cancelRequested: item.cancelRequested, state: item.remote?.state }
    }, requestId)
    // Preparation was already registered, so only the original authority may call it cancelled.
    expect(cancelled.phase).not.toBe('cancelled')
    expect(cancelled.cancelRequested).toBe(true)
    expect(cancelled.state).toBe('prepared')
    for (const path of blocked) await page.unroute(path)
    await expect.poll(() => page.evaluate(async id => (await window.reliableDriver!.actions.read(id))!.phase, requestId),
      { timeout: 15000 }).toBe('accepted')
    const settled = await page.evaluate(async id => window.reliableDriver!.actions.read(id), requestId)
    expect(settled!.remote!.state).toBe('accepted')
    expect(settled!.cancelRequested).toBe(true)
    expect(receiver.acceptedIds().filter(id => id === requestId)).toHaveLength(1)
  } finally {
    for (const path of blocked) await page.unroute(path)
    await page.evaluate(() => { window.reliableDriver?.dispose(); delete window.reliableDriver })
  }
})

test('a lost preparation acknowledgement cannot make an offline cancellation look confirmed', async ({ page }) => {
  const config = await driver(page), requestId = randomUUID()
  await openSession(page, config)
  let registered = false, release = () => {}, preparationStarted = () => {}
  const held = new Promise<void>(resolve => { release = resolve })
  const prepared = new Promise<void>(resolve => { preparationStarted = resolve })
  const path = intentPath(config), itemPath = intentPath(config, requestId)
  await page.route(path, async route => {
    if (route.request().method() === 'POST') {
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      registered = true; preparationStarted()
      await held
    }
    await route.abort('failed')
  })
  await page.route(itemPath, route => registered ? route.abort('failed') : route.continue())
  try {
    await page.evaluate(async id => {
      const { actions, draft } = window.reliableDriver!
      actions.suspend(); draft.change('登记回执丢失的固定问题', [])
      await actions.create({ requestId: id, receiver: { receiverId: 'controlled-agent', location: 'remote', kind: 'question' } })
      actions.resume()
    }, requestId)
    await prepared
    // The receiver has accepted it, while this browser is still awaiting the lost prepare reply.
    const dispatched = await page.request.post(itemPath + '/dispatch', { headers: { 'x-xj-space': 'personal' }, data: {} })
    expect(dispatched.status()).toBe(200)
    const cancelled = await page.evaluate(async id => {
      const item = await window.reliableDriver!.actions.cancel(id)
      return { phase: item.phase, cancelRequested: item.cancelRequested, hasRemote: !!item.remote }
    }, requestId)
    expect(cancelled.hasRemote).toBe(false)
    expect(cancelled.cancelRequested).toBe(true)
    expect(cancelled.phase).not.toBe('cancelled')
    release()
    await page.unroute(path); await page.unroute(itemPath)
    await expect.poll(() => page.evaluate(async id => (await window.reliableDriver!.actions.read(id))!.phase, requestId),
      { timeout: 10000 }).toBe('accepted')
    expect(receiver.acceptedIds().filter(id => id === requestId)).toHaveLength(1)
  } finally {
    release(); await page.unroute(path); await page.unroute(itemPath)
    await page.evaluate(() => { window.reliableDriver?.dispose(); delete window.reliableDriver })
  }
})

test('an imported record keeps adopting authoritative facts instead of freezing at import time', async ({ page }) => {
  const config = await driver(page)
  const requestId = randomUUID()
  await prepareRemote(page, config, requestId, '服务端后来取消的历史动作')
  await openSession(page, config)
  await expect.poll(() => viewOf(page, requestId), { timeout: 15000 })
    .toEqual({ history: true, phase: 'ready', state: 'prepared', cancelRequested: false })
  // The owner cancels it out of band; this page must only refresh its facts, never dispatch.
  const cancelled = await page.request.post(intentPath(config, requestId) + '/cancel',
    { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' }, data: {} })
  expect(cancelled.status()).toBe(200)
  // Two bounded network cycles of NETWORK_MAX_WAIT_MS are enough for the next refresh.
  await expect.poll(() => viewOf(page, requestId), { timeout: 6000 })
    .toEqual({ history: true, phase: 'cancelled', state: 'cancelled', cancelRequested: true })
  await reopenSession(page, config)
  const restored = await page.evaluate(async id => window.reliableDriver!.actions.read(id), requestId)
  expect(restored!.phase).toBe('cancelled')
  expect(restored!.remote!.state).toBe('cancelled')
  // Adopting facts is not dispatching: this identity never reached the receiver from this page.
  await new Promise(resolve => setTimeout(resolve, 1200))
  expect(receiver.acceptedInput(requestId)).toBeUndefined()
  expect(receiver.acceptedIds().filter(id => id === requestId)).toHaveLength(0)
  await page.evaluate(() => { window.reliableDriver?.dispose(); delete window.reliableDriver })
})

test('a local handoff is never blocked by an unrelated remote cancellation query', async ({ page }) => {
  const config = await driver(page)
  const remoteId = randomUUID()
  await prepareRemote(page, config, remoteId, '远端核实挂起的历史动作')
  await openSession(page, config)
  await expect.poll(() => viewOf(page, remoteId), { timeout: 15000 })
    .toEqual({ history: true, phase: 'ready', state: 'prepared', cancelRequested: false })
  // The read of this exact request never returns, so remote verification cannot finish this round.
  const heldPath = intentPath(config, remoteId)
  let releaseHeld = () => {}
  const held = new Promise<void>(resolve => { releaseHeld = resolve })
  await page.route(heldPath, async route => { await held; await route.continue() })
  try {
    // The cancellation intent is durable, while its remote verification stays unanswered.
    await page.evaluate(async id => { void window.reliableDriver!.actions.cancel(id) }, remoteId)
    await expect.poll(() => page.evaluate(async id => (await window.reliableDriver!.actions.read(id))!.cancelRequested, remoteId),
      { timeout: 5000 }).toBe(true)
    const localId = await page.evaluate(async () => {
      const session = window.reliableDriver!
      session.draft.change('远端核实挂起时的本机输入', [])
      const receipts = new Map()
      const identity = { receiverId: 'local-handoff-while-remote-pending', location: 'local', kind: 'execution' } as const
      session.actions.registerLocal({ identity,
        query: async (requestId: string) => receipts.get(requestId) ?? null,
        accept: async (input: { requestId: string }, inputDigest: string) => {
          const receipt = { requestId: input.requestId, receiver: identity, inputDigest, state: 'accepted' as const,
            receiptId: crypto.randomUUID(), detail: '本机交接只接纳固定输入' }
          receipts.set(input.requestId, receipt); return receipt
        }, cancel: async () => null })
      const requestId = crypto.randomUUID()
      await session.actions.create({ requestId, receiver: identity })
      return requestId
    })
    // Local handoff is this action's own dependency, so it completes within two bounded cycles.
    await expect.poll(() => page.evaluate(async id => {
      const item = await window.reliableDriver!.actions.read(id)
      return item && { phase: item.phase, receipt: !!item.localReceipt, settled: !!item.draftSettled,
        question: window.reliableDriver!.draft.snapshot().question }
    }, localId), { timeout: 2300 }).toEqual({ phase: 'accepted', receipt: true, settled: true, question: '' })
    releaseHeld()
    // The remote action still converges on its own once its authority answers again.
    await expect.poll(() => page.evaluate(async id => (await window.reliableDriver!.actions.read(id))!.phase, remoteId),
      { timeout: 15000 }).toBe('cancelled')
    expect(receiver.acceptedInput(remoteId)).toBeUndefined()
    const local = await page.evaluate(async id => window.reliableDriver!.actions.read(id), localId)
    expect(local!.phase).toBe('accepted')
  } finally {
    releaseHeld()
    await page.unroute(heldPath)
    await page.evaluate(() => { window.reliableDriver?.dispose(); delete window.reliableDriver })
  }
})

test('a local handoff is independent of another local receiver cancellation', async ({ page }) => {
  const config = await driver(page)
  await openSession(page, config)
  const result = await page.evaluate(async () => {
    const { actions, draft } = window.reliableDriver!
    actions.suspend()
    let release = () => {}
    const held = new Promise<null>(resolve => { release = () => resolve(null) })
    const cancelledReceiver = { receiverId: 'blocked-local-cancel', location: 'local', kind: 'execution' } as const
    actions.registerLocal({ identity: cancelledReceiver, query: () => held, cancel: () => held,
      accept: async () => { throw new Error('A cancelled action must not be accepted') } })
    draft.change('先取消的本机动作', [])
    const cancelledId = crypto.randomUUID()
    await actions.create({ requestId: cancelledId, receiver: cancelledReceiver })
    await actions.cancel(cancelledId)
    let accepts = 0
    const identity = { receiverId: 'independent-local-receiver', location: 'local', kind: 'execution' } as const
    actions.registerLocal({ identity, query: async () => null, cancel: async () => null,
      accept: async (input, inputDigest) => {
        accepts++
        return { requestId: input.requestId, inputDigest, receiver: identity, state: 'accepted' as const,
          receiptId: crypto.randomUUID(), detail: '' }
      } })
    draft.change('另一个接收器的本机输入', [])
    const requestId = crypto.randomUUID()
    await actions.create({ requestId, receiver: identity })
    actions.resume()
    try {
      const deadline = Date.now() + 2300
      while (!(await actions.read(requestId))!.draftSettled && Date.now() < deadline)
        await new Promise(resolve => setTimeout(resolve, 25))
      const item = (await actions.read(requestId))!
      return { accepts, phase: item.phase, settled: !!item.draftSettled, question: draft.snapshot().question }
    } finally { release(); window.reliableDriver!.dispose(); delete window.reliableDriver }
  })
  expect(result.accepts).toBe(1)
  expect(result.phase).toBe('accepted')
  expect(result.settled).toBe(true)
  expect(result.question).toBe('')
})

test.afterEach(async ({}, info) => { cases.push({ name: info.title, status: info.status, durationMs: info.duration }) })
test.afterAll(async () => {
  await host?.stop()
  if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true })
  await writeFile(fileURLToPath(new URL('../../../.verification/157/reliable-actions-chrome-results.json', import.meta.url)), JSON.stringify({
    measuredAt: new Date().toISOString(), node: process.version, postgres: '18.6', platform: process.platform, arch: process.arch,
    osRelease: osRelease(), browser: process.env.XUNJIE_E2E_BROWSER_CHANNEL ?? 'chromium', browserVersion, headless, cases,
    receiverScope: 'Public workspace API and actual IndexedDB/HTTP/PG; no real Agent, execution or teacher receiver.' }, null, 2))
})
const intentPath = (config: Config, requestId?: string) => `${endpoint}/api/learning/intents/${config.activityId}${requestId ? '/' + requestId : ''}`
const viewOf = (page: Page, requestId: string) => page.evaluate(async id => {
  const item = await window.reliableDriver!.actions.read(id)
  return item && { history: !!item.history, phase: item.phase, state: item.remote?.state ?? '', cancelRequested: item.cancelRequested }
}, requestId)
async function openSession(page: Page, config: Config) {
  await page.evaluate(async config => {
    const { openActionWorkspace } = await import(config.moduleUrl)
    window.reliableDriver = await openActionWorkspace(config)
  }, config)
}
async function reopenSession(page: Page, config: Config) {
  await page.evaluate(async config => {
    window.reliableDriver!.dispose()
    const { openActionWorkspace } = await import(config.moduleUrl)
    window.reliableDriver = await openActionWorkspace(config)
  }, config)
}
/** Out-of-band preparation by another client, so this page holds no local action of its own. */
async function prepareRemote(page: Page, config: Config, requestId: string, question: string) {
  const prepared = await page.request.post(intentPath(config), { headers: { 'content-type': 'application/json', 'x-xj-space': 'personal' },
    data: { requestId, scope: config.scope, receiver: { receiverId: 'controlled-agent', location: 'remote', kind: 'question' },
      draft: { token: randomUUID(), question, references: [], bases: [] }, works: [], evidence: [] } })
  expect(prepared.status()).toBe(200)
  expect((await prepared.json()).state).toBe('prepared')
}
async function driver(page: Page) {
  const created = await page.request.post(endpoint + '/api/learning/activities', { headers: { 'x-xj-space': 'personal' },
    data: { requestId: randomUUID(), goal: '可靠动作的权威事实核对', question: '', references: [] } })
  expect(created.status()).toBe(200)
  const activity = await created.json()
  await page.route('**/__reliable_actions_interface.js', route => route.fulfill({ contentType: 'application/javascript', body: bundle }))
  await page.goto(endpoint + '/?diagnostics=1')
  const context = await (await page.request.get(endpoint + '/api/learning/context')).json()
  const identity = activity.identity
  return { key: JSON.stringify([context.clientNamespace, identity.environmentId, identity.spaceId,
    identity.principalId, activity.activityId]), base: '/api/learning/', activityId: activity.activityId, spaceKey: 'personal',
    moduleUrl: endpoint + '/__reliable_actions_interface.js',
    scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId,
      activityId: activity.activityId } } satisfies Config
}
