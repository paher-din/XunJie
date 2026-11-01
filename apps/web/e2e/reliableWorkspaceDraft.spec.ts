import { test, expect, type Page } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir, release } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication } from '@xunjie/product-runtime'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
let runtime: ReturnType<typeof openProductRuntime>, endpoint: string, bundle: string
let host: Awaited<ReturnType<typeof createProductRuntimeHost>>
const cases: { name: string; status: string | undefined; durationMs: number }[] = []
let browserVersion = ''

/**
 * Browser-side plumbing bundled with the production reliable workspace. Every assertion below still
 * runs against real IndexedDB, real HTTP and real PostgreSQL; nothing here replaces product behavior.
 */
const bundleSource = `export { ReliableWorkspace } from './index'
export { ReliableQuestionDraft } from './draft'

export function makeRequest(base, spaceKey) {
  return async function request(route, body) {
    const response = await fetch(base + route, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', 'x-xj-space': spaceKey },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const value = await response.json()
    if (!response.ok) throw Object.assign(new Error(value.error), { code: value.error })
    return value
  }
}
export function transportFor(request, path) {
  return { read: () => request(path), receipt: id => request(path + '/receipts/' + id), sync: body => request(path, body) }
}
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
export const workFile = (name, value) => ({ objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name,
  kind: 'code', encoding: 'utf8', mediaType: 'text/plain', value })
/** Holds a real IndexedDB transaction so the following write commits only after the test releases it. */
export async function holdStore(storeName) {
  const database = await new Promise((resolve, reject) => {
    const opening = indexedDB.open('xunjie-reliable-works-v1')
    opening.onsuccess = () => resolve(opening.result)
    opening.onerror = () => reject(opening.error)
  })
  const state = { held: true, done: false }
  const transaction = database.transaction(storeName, 'readwrite')
  const keepAlive = () => {
    const request = transaction.objectStore(storeName).get('__held_reliable_regression__')
    request.onsuccess = () => { if (state.held) keepAlive() }
  }
  transaction.oncomplete = () => { state.done = true; database.close() }
  keepAlive()
  return { release: () => { state.held = false }, get done() { return state.done } }
}
export async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let value = await check()
  while (!value && Date.now() < deadline) { await sleep(50); value = await check() }
  return value
}`

test.beforeAll(async ({ browser }) => {
  browserVersion = browser.version()
  await mkdir(fileURLToPath(new URL('../../../.verification/157', import.meta.url)), { recursive: true })
  const root = await mkdtemp(join(tmpdir(), 'xj-reliable-draft-'))
  runtime = openProductRuntime({ root, resources: {
    nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
  await runtime.install({ profile: 'local' })
  host = await createProductRuntimeHost({ root, createApplication: context => createProductLearningApplication(context) })
  endpoint = host.endpoint
  bundle = (await build({ stdin: { contents: bundleSource, loader: 'ts',
    resolveDir: fileURLToPath(new URL('../src/reliable-workspace', import.meta.url)) },
    bundle: true, write: false, format: 'esm', platform: 'browser' })).outputFiles[0].text
})
test.afterEach(async ({}, info) => { cases.push({ name: info.title, status: info.status, durationMs: info.duration }) })
test.afterAll(async () => {
  await host?.stop()
  await writeFile(fileURLToPath(new URL('../../../.verification/157/chrome-results.json', import.meta.url)), JSON.stringify({
    measuredAt: new Date().toISOString(), node: process.version, postgres: '18.6', platform: process.platform, arch: process.arch,
    osRelease: release(), browser: 'installed Chrome', browserVersion, headless: false, cases,
    scope: 'Public reliable workspace and question draft over real IndexedDB, HTTP and PostgreSQL.' }, null, 2))
})

async function driver(page: Page) {
  const created = await page.request.post(endpoint + '/api/learning/activities', { headers: { 'x-xj-space': 'personal' },
    data: { requestId: randomUUID(), goal: '可靠工作区回归-' + randomUUID(), question: '', references: [] } })
  expect(created.status()).toBe(200)
  const activity = await created.json()
  await page.route('**/__draft_public_interface.js', route => route.fulfill({ contentType: 'application/javascript', body: bundle }))
  await page.goto(endpoint + '/?diagnostics=1')
  const context = await (await page.request.get(endpoint + '/api/learning/context')).json()
  return { key: JSON.stringify([context.clientNamespace, activity.identity.environmentId, activity.identity.spaceId,
    activity.identity.principalId, activity.activityId]), base: '/api/learning/', activityId: activity.activityId,
    moduleUrl: endpoint + '/__draft_public_interface.js' }
}

test('question input during a conflict choice survives the protected resolution', async ({ page }) => {
  const config = await driver(page)
  const result = await page.evaluate(async ({ key, base, activityId, moduleUrl }) => {
    const { ReliableQuestionDraft, makeRequest, transportFor, holdStore, sleep } = await import(moduleUrl)
    const transport = transportFor(makeRequest(base, 'personal'), 'drafts/' + activityId)
    const first = new ReliableQuestionDraft(key, transport), second = new ReliableQuestionDraft(key, transport)
    await first.open(); await second.open()
    first.suspend(); second.suspend()
    first.change('tab A question', []); await first.protect()
    second.change('tab B question', []); await second.protect().catch(() => {})
    if (!second.snapshot().conflict) throw new Error('The controlled local competition was not created')
    await second.protect()
    // Hold the candidate store so the resolution transaction commits after the following input.
    const held = await holdStore('draftCandidates')
    const resolving = second.resolve('tab B question', [])
    await sleep(80)
    second.change('new input after choosing conflict resolution', [])
    held.release()
    await resolving
    await second.protect()
    await sleep(600); await second.protect()
    const live = second.snapshot().question
    first.dispose(); second.dispose()
    const reopened = new ReliableQuestionDraft(key, transport)
    reopened.suspend()
    await reopened.open()
    const persisted = reopened.snapshot().question
    reopened.dispose()
    return { live, persisted }
  }, config)
  expect(result.live).toBe('new input after choosing conflict resolution')
  expect(result.persisted).toBe('new input after choosing conflict resolution')
})

test('work input during a conflict choice survives the protected resolution', async ({ page }) => {
  const config = await driver(page)
  const result = await page.evaluate(async ({ key, base, activityId, moduleUrl }) => {
    const { ReliableWorkspace, makeRequest, transportFor, holdStore, sleep, workFile } = await import(moduleUrl)
    const transport = transportFor(makeRequest(base, 'personal'), 'workspaces/' + activityId)
    const chosen = [workFile('a.c', '// tab B work')]
    const later = [workFile('a.c', '// new input after choosing conflict resolution')]
    const first = new ReliableWorkspace(key, transport), second = new ReliableWorkspace(key, transport)
    await first.open(); await second.open()
    first.suspend(); second.suspend()
    first.change([workFile('a.c', '// tab A work')]); await first.protect()
    second.change(chosen); await second.protect().catch(() => {})
    if (!second.snapshot().conflict) throw new Error('The controlled local competition was not created')
    await second.protect()
    const held = await holdStore('candidates')
    const resolving = second.resolve(chosen)
    await sleep(80)
    second.change(later)
    held.release()
    await resolving
    await second.protect()
    await sleep(600); await second.protect()
    const live = second.snapshot().files[0]?.value
    first.dispose(); second.dispose()
    const reopened = new ReliableWorkspace(key, transport)
    reopened.suspend()
    await reopened.open()
    const persisted = reopened.snapshot().files[0]?.value
    reopened.dispose()
    return { live, persisted }
  }, config)
  expect(result.live).toBe('// new input after choosing conflict resolution')
  expect(result.persisted).toBe('// new input after choosing conflict resolution')
})

test('a later edit from the other tab refreshes the draft comparison without replacing this page', async ({ page }) => {
  const config = await driver(page)
  const result = await page.evaluate(async ({ key, base, activityId, moduleUrl }) => {
    const { ReliableQuestionDraft, makeRequest, transportFor, sleep } = await import(moduleUrl)
    const transport = transportFor(makeRequest(base, 'personal'), 'drafts/' + activityId)
    const first = new ReliableQuestionDraft(key, transport), second = new ReliableQuestionDraft(key, transport)
    await first.open(); await second.open()
    first.suspend(); second.suspend()
    first.change('tab A question', []); await first.protect()
    second.change('tab B question', []); await second.protect().catch(() => {})
    if (!second.snapshot().conflict) throw new Error('The controlled local competition was not created')
    await second.protect()
    const before = second.snapshot().conflict!.at
    first.change('tab A question 2', []); await first.protect()
    await second.protect(); await sleep(300); await second.protect()
    const conflict = second.snapshot().conflict
    const output = { question: second.snapshot().question, before,
      conflict: conflict ? { source: conflict.source, at: conflict.at, local: conflict.local.question,
        other: conflict.other.question } : null }
    first.dispose(); second.dispose()
    return output
  }, config)
  expect(result.conflict).not.toBeNull()
  expect(result.question).toBe('tab B question')
  expect(result.conflict!.source).toBe('local')
  expect(result.conflict!.local).toBe('tab B question')
  expect(result.conflict!.other).toBe('tab A question 2')
  expect(result.conflict!.at).toBeGreaterThan(result.before)
})

test('a later edit from the other tab refreshes the work comparison without remounting the editor', async ({ page }) => {
  const config = await driver(page)
  const result = await page.evaluate(async ({ key, base, activityId, moduleUrl }) => {
    const { ReliableWorkspace, makeRequest, transportFor, sleep, workFile } = await import(moduleUrl)
    const transport = transportFor(makeRequest(base, 'personal'), 'workspaces/' + activityId)
    const first = new ReliableWorkspace(key, transport), second = new ReliableWorkspace(key, transport)
    await first.open(); await second.open()
    first.suspend(); second.suspend()
    const mine = [workFile('a.c', '// tab B work')]
    first.change([workFile('a.c', '// tab A work')]); await first.protect()
    second.change(mine); await second.protect().catch(() => {})
    if (!second.snapshot().conflict) throw new Error('The controlled local competition was not created')
    await second.protect()
    const before = { at: second.snapshot().conflict!.at, editorEpoch: second.snapshot().editorEpoch }
    first.change([workFile('a.c', '// tab A work 2')]); await first.protect()
    await second.protect(); await sleep(300); await second.protect()
    const conflict = second.snapshot().conflict
    const values = (files: { value: string }[]) => files.map(file => file.value)
    const output = { files: values(second.snapshot().files), before,
      editorEpoch: second.snapshot().editorEpoch,
      conflict: conflict ? { source: conflict.source, at: conflict.at, local: values(conflict.local),
        other: values(conflict.other) } : null }
    first.dispose(); second.dispose()
    return output
  }, config)
  expect(result.conflict).not.toBeNull()
  expect(result.files).toEqual(['// tab B work'])
  expect(result.conflict!.local).toEqual(['// tab B work'])
  expect(result.conflict!.other).toEqual(['// tab A work 2'])
  expect(result.conflict!.at).toBeGreaterThan(result.before.at)
  expect(result.editorEpoch).toBe(result.before.editorEpoch)
})

test('a refused over-long draft keeps its text and syncs again after an edit', async ({ page }) => {
  test.setTimeout(180000)
  const config = await driver(page)
  const result = await page.evaluate(async ({ key, base, activityId, moduleUrl }) => {
    const { ReliableQuestionDraft, makeRequest, transportFor, waitFor } = await import(moduleUrl)
    const request = makeRequest(base, 'personal')
    const path = 'drafts/' + activityId
    const transport = transportFor(request, path)
    const draft = new ReliableQuestionDraft(key, transport)
    await draft.open()
    const overLong = '太'.repeat(10001)
    draft.change(overLong, [])
    await waitFor(async () => draft.snapshot().error, 20000)
    const refused = { error: draft.snapshot().error, denied: draft.accessDenied(), length: draft.snapshot().question.length }
    draft.change('短问题', [])
    const remote = await waitFor(async () => {
      const view = await request(path)
      return view.question === '短问题' ? view : null
    }, 40000)
    const after = { denied: draft.accessDenied(), question: draft.snapshot().question, remote: remote?.question }
    draft.dispose()
    const reopened = new ReliableQuestionDraft(key, transport)
    reopened.suspend()
    await reopened.open()
    const restored = { question: reopened.snapshot().question, denied: reopened.accessDenied() }
    reopened.dispose()
    return { refused, after, restored }
  }, config)
  expect(result.refused.denied).toBe(false)
  expect(result.refused.error).toContain('未通过校验')
  expect(result.refused.length).toBe(10001)
  expect(result.after.remote).toBe('短问题')
  expect(result.after.denied).toBe(false)
  expect(result.after.question).toBe('短问题')
  expect(result.restored.question).toBe('短问题')
  expect(result.restored.denied).toBe(false)
})
