import { createHash, randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { create, edit, identities, openFileMenu, trackSync } from './helpers'
import { loginThroughForm, startSessionHost } from './sessionHost'
import type { SnapshotView, WorkspaceHead } from '../src/workspace/workspaceContracts'

// Normal dist, actual HTTPS/Fastify/SQLite. ACK/network faults affect transport only;
// generation/state/reopen/clock conditions use the isolated host's private IPC.
// Synthetic passwords stay in private stdin/memory; traces must not record login.
test.use({ ignoreHTTPSErrors: true, trace: 'off' })
test.beforeEach(() => test.skip(!process.env.XUNJIE_E2E_SERVICE_NODE, 'Requires approved teaching Node 24.21.0'))
type Host = Awaited<ReturnType<typeof startSessionHost>>
interface OutboxRecord {
  commandKey: string; kind: string; state: string; wireJson: string;
  context: { trustedRecoveryGeneration: string }; rejected?: { code: string };
  receipt?: { result: unknown; replayed?: boolean }; lease?: { owner: string; until: number }
}
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

async function enter(page: Page, host: Host, start = true) {
  // WSL loopback forwarding can become reachable shortly after listener readiness.
  await expect.poll(async () => {
    try { return (await page.context().request.get(host.base + '/health/live')).status() } catch { return 0 }
  }, { timeout: 20_000 }).toBe(200)
  await page.goto(`${host.base}/#/task/${host.assignmentId}`)
  await expect(page.getByRole('heading', { name: '登录学习空间' })).toBeVisible()
  await loginThroughForm(page, 'student', host.password)
  if (!start) return
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  await expect(page.locator('.cw')).toBeVisible()
  await expect(page.getByRole('button', { name: '新建文件', exact: true }).first()).toBeEnabled()
}
async function saved(page: Page, revision: number) {
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText(`确认作品 v${revision}`)
}
async function local(page: Page) {
  return page.evaluate(() => new Promise<{
    commands: OutboxRecord[]; drafts: Array<{ text: string; draftRevision: number; clientFileKey: string }>;
    candidates: Array<{ text: string }>; heads: Array<{ context: { trustedRecoveryGeneration: string }; workspace: { workspaceRevision: number; files: Array<{ text: string }> } }>
  }>((resolve, reject) => {
    const request = indexedDB.open('xunjie-i0-workspace')
    request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('Expected existing workspace database')) }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['outbox', 'drafts', 'candidates', 'metadata'], 'readonly')
      const commands = tx.objectStore('outbox').getAll(), drafts = tx.objectStore('drafts').getAll()
      const candidates = tx.objectStore('candidates').getAll(), metadata = tx.objectStore('metadata').getAll()
      tx.oncomplete = () => { db.close(); resolve({ commands: commands.result, drafts: drafts.result,
        candidates: candidates.result, heads: metadata.result.filter(row => row.key.startsWith('head:')) }) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }))
}
async function attemptId(page: Page) {
  const commands = (await local(page)).commands
  return (commands.find(command => command.kind === 'attempt.create')!.receipt!.result as { attemptId: string }).attemptId
}
async function head(page: Page, host: Host, id: string): Promise<WorkspaceHead> {
  const response = await page.context().request.get(`${host.base}/api/attempts/${id}`)
  expect(response.status()).toBe(200)
  return (await response.json()).data
}
async function publicSync(page: Page, host: Host, id: string, operations: unknown[]) {
  const session = (await (await page.context().request.get(host.base + '/api/session')).json()).data
  const bootstrap = (await (await page.context().request.get(`${host.base}/api/assignments/${host.assignmentId}/bootstrap`)).json()).data
  const before = await head(page, host, id)
  const response = await page.context().request.post(`${host.base}/api/attempts/${id}/sync`, {
    headers: { Origin: host.base, 'x-csrf-token': session.csrfToken, 'Idempotency-Key': randomUUID() },
    data: { recoveryGeneration: bootstrap.recoveryGeneration, expectedWorkspaceRevision: before.attempt.workspaceRevision,
      clientId: randomUUID(), clientSeq: 1, operations },
  })
  expect(response.status()).toBe(200)
  return (await response.json()).data
}
async function selectFile(page: Page, path: string) {
  const tab = page.locator('.cw-filetab-main').filter({ hasText: path })
  if (await tab.count()) await tab.click()
  else {
    await openFileMenu(page)
    await page.getByRole('menuitem', { name: path, exact: true }).click()
  }
  await expect(page.locator('.monaco-editor textarea').first()).toBeAttached()
}

test('HTTPS 隔离宿主墙钟回拨不误判会话失效或限流，仍可明确保存原文', async ({ page }) => {
  const host = await startSessionHost()
  try {
    await enter(page, host); await create(page); await edit(page, 'clock-safe-draft\n')
    const id = await attemptId(page)
    await host.control({ kind: 'clock-regress', milliseconds: 20_000 })
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('.cw')).toBeVisible()
    expect((await page.context().request.get(host.base + '/api/session')).status()).toBe(200)
    await saved(page, 1)
    expect((await head(page, host, id)).files[0]!.text).toBe('clock-safe-draft\n')
    // Same host and account, but a separate context still signs in through the form.
    const siblingContext = await page.context().browser()!.newContext({ ignoreHTTPSErrors: true })
    try {
      const sibling = await siblingContext.newPage()
      await enter(sibling, host, false)
      await expect(sibling.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
      expect((await siblingContext.request.get(host.base + '/api/session')).status()).toBe(200)
    } finally { await siblingContext.close() }
  } finally { await page.context().close(); await host.stop() }
})

test('HTTPS 缺受信代际真实409：入口不可用、零业务写、零活动读取', async ({ page }) => {
  const host = await startSessionHost()
  try {
    await host.control({ kind: 'generation', value: '' })
    const before = await host.control({ kind: 'inspect' })
    const paths: string[] = []
    page.on('request', request => paths.push(new URL(request.url()).pathname))
    const bootstrap = page.waitForResponse(response => response.url().endsWith('/bootstrap'))
    await enter(page, host, false)
    const response = await bootstrap
    expect(response.status()).toBe(409)
    expect((await response.json()).error.code).toBe('RECOVERY_REQUIRED')
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'unavailable')
    await expect(page.locator('.cw')).toHaveCount(0)
    const after = await host.control({ kind: 'inspect' })
    expect(after.requests.businessWrites).toBe(before.requests.businessWrites)
    expect(after.requests.activityReads).toBe(before.requests.activityReads)
    expect(after.database).toEqual(before.database)
    expect(paths.some(path => path.startsWith('/__i0prep'))).toBe(false)
    await page.screenshot({ path: test.info().outputPath('generation-unavailable.png') })
  } finally { await page.context().close(); await host.stop() }
})

test('HTTPS 代际轮换拒绝旧保存：显式重读同Attempt保留草稿后使用新键', async ({ page }) => {
  const host = await startSessionHost()
  try {
    await enter(page, host); await create(page); await edit(page, 'generation-base\n'); await saved(page, 1)
    const id = await attemptId(page), posts = trackSync(page)
    await edit(page, 'generation-newer-draft\n')
    const draft = (await local(page)).drafts[0]!.text
    await host.control({ kind: 'generation', value: 'save-recovery-next-generation' })
    const before = await host.control({ kind: 'inspect', attemptId: id })
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await expect(page.locator('.ws-run-state')).toHaveText('需要重新读取')
    expect(posts).toHaveLength(1)
    expect((await host.control({ kind: 'inspect', attemptId: id })).attemptCounts).toEqual(before.attemptCounts)
    expect((await local(page)).drafts[0]!.text).toBe(draft)
    await expect(page.getByRole('button', { name: '重试上次保存' })).toHaveCount(0)
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(page.locator('.cw')).toBeVisible()
    await expect(page.locator('.view-lines')).toContainText('generation-newer-draft')
    await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeEnabled()
    expect(posts).toHaveLength(1)
    await saved(page, 2)
    expect(posts).toHaveLength(2)
    expect(posts[1]!.key).not.toBe(posts[0]!.key)
    expect(JSON.parse(posts[1]!.body).recoveryGeneration).toBe('save-recovery-next-generation')
    const after = await head(page, host, id)
    expect(after.files[0]!.text).toBe(draft)
    expect((await host.control({ kind: 'inspect' })).database.attempts).toBe(before.database.attempts)
    const rejected = (await local(page)).commands.find(command => command.commandKey === posts[0]!.key)!
    expect(rejected.rejected?.code).toBe('RECOVERY_REQUIRED')
    expect(rejected.receipt).toBeUndefined()
    await page.reload(); await expect(page.locator('.cw')).toBeVisible()
    await expect(page.locator('.ws-flow')).toContainText('确认作品 v2 · 与草稿一致')
    await expect(page.locator('.ws-run-state')).toHaveCount(0)
    expect((await local(page)).commands.find(command => command.commandKey === posts[0]!.key)!.state).toBe('historical')
    await page.screenshot({ path: test.info().outputPath('generation-reread-saved.png') })
  } finally { await page.context().close(); await host.stop() }
})

for (const heldRead of [1, 2]) test(`HTTPS 迟到代际读取${heldRead}不能覆盖另一标签已重读的新代际`, async ({ page, context }) => {
  const host = await startSessionHost()
  let release = () => {}
  try {
    await enter(page, host); await create(page); await edit(page, 'generation-race-draft\n'); await saved(page, 1)
    const sibling = await context.newPage()
    await sibling.goto(page.url()); await expect(sibling.locator('.cw')).toBeVisible()
    await host.control({ kind: 'generation', value: 'race-generation-two' })
    let arrived!: () => void, delivered!: () => void, reads = 0
    const ready = new Promise<void>(r => { arrived = r }), finished = new Promise<void>(r => { delivered = r })
    const held = new Promise<void>(r => { release = r })
    await page.route('**/api/assignments/*/bootstrap', async route => {
      if (++reads !== heldRead) return route.continue()
      const response = await route.fetch(); arrived(); await held
      try { await route.fulfill({ response }) } finally { delivered() }
    })
    await page.getByRole('button', { name: '重新读取', exact: true }).click(); await ready
    await host.control({ kind: 'generation', value: 'race-generation-three' })
    await sibling.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(sibling.locator('.cw')).toBeVisible()
    await expect.poll(async () => (await local(sibling)).heads[0]!.context.trustedRecoveryGeneration).toBe('race-generation-three')
    const before = await host.control({ kind: 'inspect' })
    release(); await finished
    await expect(page.locator('.ws-run-state')).toHaveText('操作未完成')
    expect((await local(sibling)).heads[0]!.context.trustedRecoveryGeneration).toBe('race-generation-three')
    await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
    expect((await host.control({ kind: 'inspect' })).requests.businessWrites).toBe(before.requests.businessWrites)
    await sibling.close()
  } finally { release(); await context.close(); await host.stop() }
})

test('HTTPS 换代际并重读较新作品后，迟到旧ACK只留历史不回退确认头或草稿', async ({ page, context }) => {
  const host = await startSessionHost()
  let release = () => {}
  try {
    await enter(page, host); await create(page); await edit(page, 'old-generation-base\n'); await saved(page, 1)
    const id = await attemptId(page), posts = trackSync(page)
    await edit(page, 'old-generation-sent\n')
    let arrived!: () => void, delivered!: () => void
    const ready = new Promise<void>(r => { arrived = r }), finished = new Promise<void>(r => { delivered = r })
    const held = new Promise<void>(r => { release = r })
    await page.route('**/api/attempts/*/sync', async route => {
      const response = await route.fetch(); arrived(); await held
      try { await route.fulfill({ response }) } finally { delivered() }
    })
    await page.getByRole('button', { name: '确认保存', exact: true }).click(); await ready
    await edit(page, 'later-local-draft\n')
    const draft = (await local(page)).drafts[0]!.text
    await host.control({ kind: 'generation', value: 'ack-next-generation' })
    const sibling = await context.newPage()
    await sibling.goto(page.url()); await expect(sibling.locator('.cw')).toBeVisible()
    const accepted = await head(sibling, host, id)
    await publicSync(sibling, host, id, [{ kind: 'update', fileId: accepted.files[0]!.fileId,
      baseVersion: accepted.files[0]!.documentVersion, text: 'new-generation-authority\n' }])
    await sibling.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect.poll(async () => (await local(sibling)).heads[0]!.workspace.workspaceRevision).toBe(3)
    release(); await finished
    await expect.poll(async () => (await local(sibling)).commands.find(row => row.commandKey === posts[0]!.key)!.state).toBe('historical')
    const stored = await local(sibling)
    expect(stored.heads[0]!.context.trustedRecoveryGeneration).toBe('ack-next-generation')
    expect(stored.heads[0]!.workspace.files[0]!.text).toBe('new-generation-authority\n')
    expect(stored.heads[0]!.workspace.workspaceRevision).toBe(3)
    expect(stored.drafts[0]!.text).toBe(draft)
    expect(posts).toHaveLength(1)
    await sibling.close()
  } finally { release(); await context.close(); await host.stop() }
})

test('HTTPS 多文件原字节、版本/hash/manifest与刷新和同库重开读回一致，较新草稿单列', async ({ page }) => {
  const host = await startSessionHost()
  try {
    await enter(page, host)
    const id = await attemptId(page), raw = '\uFEFF中文😀\r\nsecond\rthird\n\n', plain = 'int value = 1;\n'
    await publicSync(page, host, id, [
      { kind: 'create', clientFileKey: randomUUID(), path: 'unicode.txt', text: raw },
      { kind: 'create', clientFileKey: randomUUID(), path: 'main.c', text: plain },
    ])
    await page.reload(); await expect(page.locator('.cw')).toBeVisible()
    await selectFile(page, 'unicode.txt'); await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press('Control+End'); await edit(page, 'tail😀')
    await selectFile(page, 'main.c'); await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press('Control+End'); await edit(page, '// local tail')
    const posts = trackSync(page)
    await saved(page, 2)
    const confirmed = await head(page, host, id)
    const expected = new Map([['unicode.txt', raw + 'tail😀'], ['main.c', plain + '// local tail']])
    expect(JSON.parse(posts[0]!.body).operations).toHaveLength(2)
    expect(confirmed.attempt.workspaceRevision).toBe(2)
    for (const file of confirmed.files) {
      expect(Buffer.from(file.text, 'utf8')).toEqual(Buffer.from(expected.get(file.path)!, 'utf8'))
      expect(file.documentVersion).toBe(2); expect(file.contentHash).toBe(hash(expected.get(file.path)!))
    }
    await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
    await expect(page.getByText('已冻结快照 v2', { exact: true })).toBeVisible()
    const frozen = (await head(page, host, id)).snapshots[0]!
    const snapshotResponse = await page.context().request.get(`${host.base}/api/attempts/${id}/snapshots/${frozen.snapshotId}`)
    expect(snapshotResponse.status()).toBe(200)
    const snapshot: SnapshotView = (await snapshotResponse.json()).data
    expect(snapshot).toEqual(frozen)
    const manifest = [...confirmed.files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
      .map(file => [file.fileId, file.path, file.documentVersion, file.contentHash])
    expect(snapshot.hashFormat).toBe('sha256-manifest-v1'); expect(snapshot.hash).toBe(hash(JSON.stringify(manifest)))
    expect([...snapshot.files].sort((a, b) => a.fileId.localeCompare(b.fileId))).toEqual(
      confirmed.files.map(({ fileId, path, documentVersion, contentHash, text }) =>
        ({ fileId, path, documentVersion, contentHash, text })).sort((a, b) => a.fileId.localeCompare(b.fileId)))
    await edit(page, '// newer-unsaved-draft')
    const drafts = (await local(page)).drafts
    const before = await host.control({ kind: 'inspect', attemptId: id })
    await page.reload(); await expect(page.locator('.cw')).toBeVisible()
    await expect(page.locator('.ws-flow')).toContainText('1 个文件未确认')
    expect((await local(page)).drafts).toEqual(drafts)
    expect((await head(page, host, id)).files).toEqual(confirmed.files)
    await host.control({ kind: 'reopen' })
    await page.reload(); await expect(page.locator('.cw')).toBeVisible()
    await expect(page.getByText('已冻结快照 v2', { exact: true })).toBeVisible()
    await expect(page.locator('.view-lines')).toContainText('newer-unsaved-draft')
    expect((await local(page)).drafts).toEqual(drafts)
    const reopened = await head(page, host, id)
    expect(reopened.files).toEqual(confirmed.files); expect(reopened.snapshots).toEqual([snapshot])
    const after = await host.control({ kind: 'inspect', attemptId: id })
    expect(after.database).toEqual(before.database)
    expect(after.requests.businessWrites).toBe(before.requests.businessWrites)
    await page.screenshot({ path: test.info().outputPath('confirmed-and-newer-draft.png') })
  } finally { await page.context().close(); await host.stop() }
})

test('HTTPS 服务接收但丢ACK：刷新和明确重试只重放原命令、一次效果且保留新草稿', async ({ page }) => {
  const host = await startSessionHost()
  try {
    await enter(page, host); await create(page); await edit(page, 'accepted-frozen-text\n')
    const id = await attemptId(page), posts = trackSync(page), before = await host.control({ kind: 'inspect', attemptId: id })
    await page.route('**/api/attempts/*/sync', async route => { await route.fetch(); await route.abort('failed') })
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await expect(page.locator('.ws-run-state')).toHaveText('保存结果待确认')
    const accepted = await head(page, host, id)
    expect(accepted.files[0]!.text).toBe('accepted-frozen-text\n')
    await edit(page, 'newer-after-lost-ack\n')
    const draft = (await local(page)).drafts[0]!.text
    const command = (await local(page)).commands.find(row => row.commandKey === posts[0]!.key)!
    expect(command.state).toBe('pending'); expect(command.receipt).toBeUndefined()
    await page.unroute('**/api/attempts/*/sync'); await page.reload()
    await expect(page.getByRole('button', { name: '重试上次保存', exact: true })).toBeVisible()
    expect(posts).toHaveLength(1)
    await page.getByRole('button', { name: '重试上次保存', exact: true }).click()
    await expect(page.getByRole('button', { name: '重试上次保存', exact: true })).toHaveCount(0)
    expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0]); expect(identities(posts).size).toBe(1)
    const after = await host.control({ kind: 'inspect', attemptId: id })
    expect(after.attemptCounts!.files).toBe(1)
    expect(after.attemptCounts!.receipts).toBe(before.attemptCounts!.receipts + 1)
    expect((await head(page, host, id)).files).toEqual(accepted.files)
    const stored = await local(page)
    expect(stored.commands.find(row => row.commandKey === command.commandKey)!.state).toBe('confirmed')
    expect(stored.commands.find(row => row.commandKey === command.commandKey)!.receipt?.replayed).toBe(true)
    expect(stored.drafts[0]!.text).toBe(draft)
    await expect(page.locator('.view-lines')).toContainText('newer-after-lost-ack')
    await page.screenshot({ path: test.info().outputPath('lost-ack-reconciled.png') })
  } finally { await page.context().close(); await host.stop() }
})

test('HTTPS 浏览器离线可继续保护草稿，重连重开服务不自动重发，明确重试原命令', async ({ page, context }) => {
  const host = await startSessionHost()
  try {
    await enter(page, host); await create(page); await edit(page, 'offline-frozen\n')
    const id = await attemptId(page), posts = trackSync(page), before = await host.control({ kind: 'inspect', attemptId: id })
    await context.setOffline(true)
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await expect(page.locator('.ws-run-state')).toHaveText('保存结果待确认')
    await edit(page, 'offline-newer\n')
    const original = (await local(page)).commands.find(row => row.kind === 'workspace.sync')!
    await context.setOffline(false); await host.control({ kind: 'reopen' }); await page.reload()
    await expect(page.getByRole('button', { name: '重试上次保存', exact: true })).toBeVisible()
    expect((await host.control({ kind: 'inspect', attemptId: id })).database).toEqual(before.database)
    await expect(page.locator('.view-lines')).toContainText('offline-newer')
    await page.getByRole('button', { name: '重试上次保存', exact: true }).click()
    await expect(page.getByRole('button', { name: '重试上次保存', exact: true })).toHaveCount(0)
    expect(identities(posts).size).toBe(1)
    expect(posts.at(-1)).toEqual({ key: original.commandKey, body: original.wireJson })
    expect((await head(page, host, id)).files[0]!.text).toBe('offline-frozen\n')
    expect((await local(page)).drafts[0]!.text).toContain('offline-newer')
  } finally { await context.setOffline(false); await context.close(); await host.stop() }
})

test('HTTPS 两标签持久租约阻止重复重放，原ACK确认后另一标签只读且保留草稿', async ({ page, context }) => {
  const host = await startSessionHost()
  let release = () => {}
  try {
    await enter(page, host); await create(page); await edit(page, 'two-tabs-frozen\n')
    const id = await attemptId(page), posts = trackSync(page)
    let arrived!: () => void, delivered!: () => void
    const atServer = new Promise<void>(r => { arrived = r }), finished = new Promise<void>(r => { delivered = r })
    const held = new Promise<void>(r => { release = r })
    await page.route('**/api/attempts/*/sync', async route => {
      const response = await route.fetch(); arrived(); await held
      try { await route.fulfill({ response }) } finally { delivered() }
    })
    await page.getByRole('button', { name: '确认保存', exact: true }).click(); await atServer
    const sibling = await context.newPage(), siblingPosts = trackSync(sibling)
    await sibling.goto(page.url()); await expect(sibling.locator('.cw')).toBeVisible()
    await sibling.getByRole('button', { name: '重试上次保存', exact: true }).click()
    await expect(sibling.locator('.ws-head-run [role=alert]')).toContainText('另一个标签页')
    expect(siblingPosts).toHaveLength(0)
    release(); await finished
    await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
    await expect(sibling.getByRole('button', { name: '重试上次保存', exact: true })).toHaveCount(0)
    expect(posts).toHaveLength(1); expect(siblingPosts).toHaveLength(0)
    expect((await head(page, host, id)).files).toHaveLength(1)
    expect((await local(sibling)).drafts[0]!.text).toBe('two-tabs-frozen\n')
    await sibling.close()
  } finally { release(); await context.close(); await host.stop() }
})

test('HTTPS 两标签本机草稿CAS冲突保留败方候选且不覆盖赢家作品', async ({ page, context }) => {
  const host = await startSessionHost()
  try {
    await enter(page, host); await create(page); await edit(page, 'shared-base\n'); await saved(page, 1)
    const id = await attemptId(page), sibling = await context.newPage()
    await sibling.goto(page.url()); await expect(sibling.locator('.cw')).toBeVisible()
    await edit(page, 'winner-local-draft\n')
    const winner = (await local(page)).drafts[0]!.text
    await sibling.locator('.monaco-editor textarea').first().focus(); await sibling.keyboard.insertText('loser-local-draft\n')
    await expect(sibling.locator('.cw-protect')).toHaveAttribute('data-status', 'failed')
    await expect(sibling.locator('.cw-protect')).toHaveAttribute('title', /冲突/)
    const writes = trackSync(sibling)
    await sibling.getByRole('button', { name: '确认保存', exact: true }).click()
    await expect(sibling.locator('.toast')).toContainText('这次没有发送')
    const stored = await local(sibling)
    expect(stored.drafts[0]!.text).toBe(winner)
    expect(stored.candidates.some(candidate => candidate.text.includes('loser-local-draft'))).toBe(true)
    await saved(page, 2)
    expect((await head(page, host, id)).files[0]!.text).toBe(winner)
    expect(writes).toHaveLength(0)
    await page.screenshot({ path: test.info().outputPath('two-tabs-winner.png') })
    await sibling.screenshot({ path: test.info().outputPath('two-tabs-preserved-conflict.png') })
    await sibling.close()
  } finally { await context.close(); await host.stop() }
})
