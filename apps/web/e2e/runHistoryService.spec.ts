import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from '@playwright/test'
import { confirmSave, create, edit, openFileMenu, trackBusinessWrites } from './helpers'
import { selectRun } from './runHelpers'
import { loginThroughForm, startSessionHost } from './sessionHost'
import type { WorkspaceHead } from '../src/workspace/workspaceContracts'
import type { RunFiles, RunView } from '../src/workspace/runContracts'

// Production dist + real login/HTTPS/SQLite/consumer. Only the private synthetic runner
// supplies node facts; browser fault hooks delay original transport without changing bodies.
test.use({ ignoreHTTPSErrors: true, trace: 'off' })
test.setTimeout(120_000)
test.beforeEach(() => test.skip(!process.env.XUNJIE_E2E_SERVICE_NODE, 'Requires approved teaching Node 24.21.0'))

type Host = Awaited<ReturnType<typeof startSessionHost>>
const reportText = '\ufeff隔离合成报告\r\nstudent-owned report 😀\n<script>alert("synthetic")</script>\r'
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const side = (page: Page, index: 'A' | 'B') => page.getByRole('region', { name: `运行 ${index}`, exact: true })

async function enter(page: Page, host: Host) {
  await page.goto(`${host.base}/#/task/${host.assignmentId}`)
  await expect(page.getByRole('heading', { name: '登录学习空间' })).toBeVisible()
  await loginThroughForm(page, 'student', host.password)
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  const created = page.waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/api/assignments/${host.assignmentId}/attempts`)
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  const response = await created
  expect(response.status()).toBe(200)
  await expect(page.locator('.cw')).toBeVisible()
  return (await response.json()).data.result.attemptId as string
}
async function head(page: Page, host: Host, attemptId: string): Promise<WorkspaceHead> {
  const response = await page.context().request.get(`${host.base}/api/attempts/${attemptId}`)
  expect(response.status()).toBe(200)
  return (await response.json()).data
}
async function publicRun(page: Page, host: Host, attemptId: string, runId: string): Promise<RunView> {
  const response = await page.context().request.get(`${host.base}/api/attempts/${attemptId}/runs/${runId}`)
  expect(response.status()).toBe(200)
  return (await response.json()).data
}
async function publicFiles(page: Page, host: Host, attemptId: string, runId: string): Promise<RunFiles> {
  const response = await page.context().request.get(`${host.base}/api/attempts/${attemptId}/runs/${runId}/files`)
  expect(response.status()).toBe(200)
  return (await response.json()).data
}
async function project(page: Page, host: Host) {
  const attemptId = await enter(page, host)
  await expect(page.getByRole('button', { name: '新建文件', exact: true }).first()).toBeEnabled()
  await create(page, 'main.c'); await edit(page, 'int main(void) { return 0; }\n')
  await openFileMenu(page)
  await page.locator('.cw-filemenu').getByRole('menuitem', { name: '新建文件', exact: true }).click()
  const name = page.getByRole('textbox', { name: '新文件名' })
  await name.fill('sample.txt'); await name.press('Enter')
  await expect(page.locator('.monaco-editor textarea').first()).toBeAttached()
  await edit(page, 'one two one\n'); await confirmSave(page, 1)
  await freeze(page, 1)
  return { attemptId, head: await head(page, host, attemptId) }
}
async function freeze(page: Page, revision: number) {
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.getByText(`已冻结快照 v${revision}`, { exact: true })).toBeVisible()
}
async function openHistory(page: Page) {
  await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await page.getByRole('button', { name: '历史运行与产物', exact: true }).click()
  await expect(page.getByRole('region', { name: '历史运行与产物', exact: true })).toBeVisible()
}
async function choose(page: Page, index: 'A' | 'B', runId: string) {
  await page.getByRole('combobox', { name: `运行 ${index}`, exact: true }).selectOption(runId)
  await expect(side(page, index).locator('[data-run-id]')).toHaveAttribute('data-run-id', runId)
  await expect(side(page, index)).toHaveAttribute('aria-busy', 'false')
}
async function facts(page: Page) {
  return page.evaluate(() => new Promise<{
    commands: Array<{ kind: string }>; drafts: Array<{ text: string }>; candidates: unknown[]
  }>((resolve, reject) => {
    const open = indexedDB.open('xunjie-i0-workspace')
    open.onupgradeneeded = () => { open.transaction?.abort(); reject(new Error('Expected existing workspace database')) }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result, tx = db.transaction(['outbox', 'drafts', 'candidates'], 'readonly')
      const commands = tx.objectStore('outbox').getAll(), drafts = tx.objectStore('drafts').getAll()
      const candidates = tx.objectStore('candidates').getAll()
      tx.oncomplete = () => { db.close(); resolve({ commands: commands.result, drafts: drafts.result, candidates: candidates.result }) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }))
}
async function runCore(page: Page, snapshot: WorkspaceHead['snapshots'][number], operation: 'stats' | 'find') {
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(file => file.path === 'main.c')!.fileId, '')
  await page.getByRole('combobox', { name: 'Core 操作', exact: true }).selectOption(operation)
  if (operation === 'find') await page.getByRole('textbox', { name: '查找词', exact: true }).fill('one')
  const accepted = page.waitForResponse(response => response.request().method() === 'POST' && /\/api\/attempts\/[^/]+\/runs$/.test(new URL(response.url()).pathname))
  await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  const response = await accepted
  expect(response.status()).toBe(200)
  const result = (await response.json()).data.result as { runId: string; jobId: string }
  await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', result.runId)
  await expect(page.locator('.core-run-result')).toContainText('运行完成')
  return result
}

test('HTTPS 两次真实 Core：固定快照和本机参数分别关联，第二浏览器不猜参数，只读不改稿', async ({ page, browser }) => {
  const host = await startSessionHost({ runs: true })
  let fresh: Awaited<ReturnType<typeof browser.newContext>> | undefined
  try {
    const initial = await project(page, host), firstSnapshot = initial.head.snapshots[0]!
    const first = await runCore(page, firstSnapshot, 'stats')
    await page.getByRole('button', { name: '返回编辑', exact: true }).click()
    await edit(page, 'second confirmed input\n'); await confirmSave(page, 2); await freeze(page, 2)
    const confirmed = await head(page, host, initial.attemptId)
    const secondSnapshot = confirmed.snapshots.find(snapshot => snapshot.workspaceRevision === 2)!
    const second = await runCore(page, secondSnapshot, 'find')
    expect(second.runId).not.toBe(first.runId); expect(secondSnapshot.snapshotId).not.toBe(firstSnapshot.snapshotId)
    await page.getByRole('button', { name: '返回编辑', exact: true }).click()
    await edit(page, 'newer local draft remains separate\n')
    const original = await facts(page), before = await host.control({ kind: 'inspect', attemptId: initial.attemptId })
    const writes = trackBusinessWrites(page)
    await openHistory(page); await choose(page, 'A', first.runId); await choose(page, 'B', second.runId)
    for (const [index, reference, snapshot, parameters] of [
      ['A', first, firstSnapshot, 'stats'], ['B', second, secondSnapshot, 'find one'],
    ] as const) {
      const result = side(page, index).locator('[data-run-id]')
      await expect(result).toHaveAttribute('data-job-id', reference.jobId)
      await expect(result).toHaveAttribute('data-snapshot-id', snapshot.snapshotId)
      await expect(result).toHaveAttribute('data-snapshot-hash', snapshot.hash)
      await expect(side(page, index)).toContainText('本机请求记录')
      await expect(side(page, index).getByLabel(`运行 ${index}参数`, { exact: true })).toContainText(parameters)
      const read = await publicRun(page, host, initial.attemptId, reference.runId)
      expect(read.snapshotHash).toBe(snapshot.hash); expect(read.snapshotId).toBe(snapshot.snapshotId)
      expect(read).not.toHaveProperty('input'); expect(read).not.toHaveProperty('entryFileId')
    }
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: test.info().outputPath(`actual-history-${theme}.png`) })
    }
    await page.getByRole('button', { name: '重新读取历史', exact: true }).click()
    await expect(side(page, 'A')).toHaveAttribute('aria-busy', 'false')
    await expect(side(page, 'B')).toHaveAttribute('aria-busy', 'false')
    expect(writes).toEqual([]); expect(await facts(page)).toEqual(original)
    const after = await host.control({ kind: 'inspect', attemptId: initial.attemptId })
    expect(after.requests.businessWrites).toBe(before.requests.businessWrites)
    expect(after.database).toEqual(before.database)
    expect((await head(page, host, initial.attemptId)).files).toEqual(confirmed.files)

    fresh = await browser.newContext({ ignoreHTTPSErrors: true })
    const other = await fresh.newPage()
    expect(await enter(other, host)).toBe(initial.attemptId)
    const otherBefore = await host.control({ kind: 'inspect', attemptId: initial.attemptId }), otherWrites = trackBusinessWrites(other)
    const empty = await facts(other)
    expect(empty.commands.filter(command => command.kind === 'run.create')).toEqual([])
    await openHistory(other); await choose(other, 'A', first.runId); await choose(other, 'B', second.runId)
    for (const index of ['A', 'B'] as const) {
      await expect(side(other, index)).toContainText('历史运行参数不可回取')
      await expect(side(other, index)).not.toContainText('本机请求记录')
      await expect(side(other, index).getByLabel(`运行 ${index}参数`, { exact: true })).toHaveCount(0)
    }
    expect(otherWrites).toEqual([]); expect(await facts(other)).toEqual(empty)
    expect((await host.control({ kind: 'inspect', attemptId: initial.attemptId })).requests.businessWrites).toBe(otherBefore.requests.businessWrites)
  } finally { await fresh?.close(); await page.context().close(); await host.stop() }
})

test('HTTPS 完整 Report：原 UTF-8 字节/BOM/CRLF/非BMP、hash/bytes/稳定 ID 全部相符且下载只读', async ({ page }) => {
  const host = await startSessionHost({ runs: true })
  try {
    const initial = await project(page, host)
    const reference = await host.control({ kind: 'history', attemptId: initial.attemptId, outcome: 'report-complete' })
    const run = await publicRun(page, host, initial.attemptId, reference.runId)
    const files = await publicFiles(page, host, initial.attemptId, reference.runId)
    expect(files.status).toBe('available')
    if (files.status !== 'available') throw new Error('Expected public complete result')
    const file = files.files.find(file => file.relativeName === 'report.txt')!
    expect(file.status).toBe('complete'); expect(file.text).toBe(reportText)
    expect(file.runId).toBe(reference.runId); expect(file.snapshotId).toBe(reference.snapshotId)
    expect(file.source).toBe('runner_result_file')
    expect(file.contentHash).toBe(hash(reportText)); expect(file.bytes).toBe(Buffer.byteLength(reportText, 'utf8'))
    expect(file.resultFileId).toBe(hash(JSON.stringify([reference.runId, reference.snapshotId, file.caseIndex, 'report.txt', hash(reportText)])))
    expect(run.snapshotHash).toBe(initial.head.snapshots[0]!.hash)
    const before = await host.control({ kind: 'inspect', attemptId: initial.attemptId }), original = await facts(page)
    const writes = trackBusinessWrites(page), dialogs: string[] = []
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss() })
    await openHistory(page); await choose(page, 'A', reference.runId)
    const region = side(page, 'A'), article = region.locator('[data-result-file-id]')
    await expect(article).toHaveAttribute('data-result-file-id', file.resultFileId)
    await expect(article).toContainText(file.contentHash!)
    await expect(article).toContainText(String(file.bytes))
    await region.getByText('查看 report.txt', { exact: true }).focus()
    await region.getByText('查看 report.txt', { exact: true }).press('Enter')
    await expect(region.getByLabel('运行 A report.txt 完整文本', { exact: true })).toContainText('<script>alert("synthetic")</script>')
    expect(dialogs).toEqual([])
    const downloading = page.waitForEvent('download')
    await region.getByRole('button', { name: '下载 report.txt', exact: true }).click()
    const download = await downloading
    expect(download.suggestedFilename()).toBe('report.txt')
    const bytes = await readFile((await download.path())!)
    expect(bytes).toEqual(Buffer.from(reportText, 'utf8'))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.contentHash)
    expect(bytes.length).toBe(file.bytes)
    await page.screenshot({ path: test.info().outputPath('actual-report-download.png') })
    expect(await publicFiles(page, host, initial.attemptId, reference.runId)).toEqual(files)
    expect(writes).toEqual([]); expect(await facts(page)).toEqual(original)
    const after = await host.control({ kind: 'inspect', attemptId: initial.attemptId })
    expect(after.requests.businessWrites).toBe(before.requests.businessWrites)
    expect(after.database).toEqual(before.database)
    expect(after.attempt!.files).toEqual(initial.head.files)
  } finally { await page.context().close(); await host.stop() }
})

test('HTTPS 课程检查：原 course_check Job 与 check Run 分层，实际公开响应裁剪私有正文和产物', async ({ page }) => {
  const host = await startSessionHost({ runs: true })
  try {
    const initial = await project(page, host)
    const reference = await host.control({ kind: 'history', attemptId: initial.attemptId, outcome: 'check' })
    const run = await publicRun(page, host, initial.attemptId, reference.runId)
    expect(run.mode).toBe('check'); expect(run.diagnostics.status).toBe('available')
    expect(run.diagnostics).not.toHaveProperty('stdout'); expect(run.diagnostics).not.toHaveProperty('stderr')
    expect(run).not.toHaveProperty('input'); expect(run).not.toHaveProperty('entryFileId')
    expect(await publicFiles(page, host, initial.attemptId, reference.runId)).toEqual({ status: 'redacted' })
    const jobResponse = await page.context().request.get(`${host.base}/api/jobs/${reference.jobId}`)
    expect(jobResponse.status()).toBe(200)
    const job = (await jobResponse.json()).data
    expect(job.kind).toBe('course_check'); expect(job.runId).toBe(reference.runId)
    const before = await host.control({ kind: 'inspect', attemptId: initial.attemptId }), original = await facts(page)
    const writes = trackBusinessWrites(page)
    await openHistory(page); await choose(page, 'A', reference.runId)
    await expect(side(page, 'A')).toContainText('检查产物已裁剪')
    if (run.diagnostics.status === 'available') {
      await expect(side(page, 'A')).toContainText(`公开检查结果：${run.diagnostics.verdict}`)
      if (run.diagnostics.failureKind) await expect(side(page, 'A')).toContainText(`故障：${run.diagnostics.failureKind}`)
    }
    await expect(side(page, 'A').getByRole('button', { name: /下载/ })).toHaveCount(0)
    await expect(side(page, 'A').getByText('查看 stdout', { exact: true })).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('PRIVATE')
    expect(writes).toEqual([]); expect(await facts(page)).toEqual(original)
    expect((await host.control({ kind: 'inspect', attemptId: initial.attemptId })).requests.businessWrites).toBe(before.requests.businessWrites)
  } finally { await page.context().close(); await host.stop() }
})

for (const [outcome, expectedStatus, message] of [
  ['report-missing', 'missing', '文件缺失'],
  ['report-incomplete', 'incomplete', '文件不完整'],
  ['files-unavailable', 'unavailable', '产物不可回取'],
] as const) {
  test(`HTTPS ${outcome}：实际产物状态单列，没有正文查看或下载，也不补写作品`, async ({ page }) => {
    const host = await startSessionHost({ runs: true })
    try {
      const initial = await project(page, host)
      const reference = await host.control({ kind: 'history', attemptId: initial.attemptId, outcome })
      const files = await publicFiles(page, host, initial.attemptId, reference.runId)
      if (expectedStatus === 'unavailable') expect(files.status).toBe('unavailable')
      else {
        expect(files.status).toBe('available')
        if (files.status !== 'available') throw new Error('Expected actual public file metadata')
        expect(files.files.find(file => file.relativeName === 'report.txt')?.status).toBe(expectedStatus)
      }
      const before = await host.control({ kind: 'inspect', attemptId: initial.attemptId }), original = await facts(page)
      const writes = trackBusinessWrites(page)
      await openHistory(page); await choose(page, 'A', reference.runId)
      await expect(side(page, 'A')).toContainText(message)
      await expect(side(page, 'A').getByRole('button', { name: /下载/ })).toHaveCount(0)
      await expect(side(page, 'A').getByText('查看 report.txt', { exact: true })).toHaveCount(0)
      await expect(side(page, 'A')).not.toContainText('student-owned report')
      expect(writes).toEqual([]); expect(await facts(page)).toEqual(original)
      const after = await host.control({ kind: 'inspect', attemptId: initial.attemptId })
      expect(after.requests.businessWrites).toBe(before.requests.businessWrites)
      expect(after.database).toEqual(before.database)
      expect(after.attempt!.files).toEqual(initial.head.files)
    } finally { await page.context().close(); await host.stop() }
  })
}

test('HTTPS 选择逆序：实际完整产物迟到不能绑定另一运行或开放下载，原草稿和写计数不变', async ({ page }) => {
  const host = await startSessionHost({ runs: true })
  let release = () => {}, arrived = false
  const held = new Promise<void>(resolve => { release = resolve })
  try {
    const initial = await project(page, host)
    const complete = await host.control({ kind: 'history', attemptId: initial.attemptId, outcome: 'report-complete' })
    const missing = await host.control({ kind: 'history', attemptId: initial.attemptId, outcome: 'report-missing' })
    const before = await host.control({ kind: 'inspect', attemptId: initial.attemptId }), original = await facts(page)
    const writes = trackBusinessWrites(page)
    await openHistory(page); await choose(page, 'A', missing.runId); await choose(page, 'B', complete.runId)
    await expect(side(page, 'B').getByRole('button', { name: '下载 report.txt', exact: true })).toBeVisible()
    let delivered = false
    await page.route(`**/api/attempts/${initial.attemptId}/runs/${complete.runId}/files`, async route => {
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      arrived = true; await held
      await route.fulfill({ response }).catch(() => {})
      delivered = true
    })
    await page.getByRole('combobox', { name: '运行 A', exact: true }).selectOption(complete.runId)
    await expect.poll(() => arrived).toBe(true)
    await choose(page, 'A', missing.runId)
    await expect(side(page, 'A')).toContainText('文件缺失')
    release(); await expect.poll(() => delivered).toBe(true)
    await expect(side(page, 'A').locator('[data-run-id]')).toHaveAttribute('data-run-id', missing.runId)
    await expect(side(page, 'A')).toContainText('文件缺失')
    await expect(side(page, 'A').getByRole('button', { name: /下载/ })).toHaveCount(0)
    await expect(side(page, 'B').getByRole('button', { name: '下载 report.txt', exact: true })).toBeVisible()
    expect(writes).toEqual([]); expect(await facts(page)).toEqual(original)
    const after = await host.control({ kind: 'inspect', attemptId: initial.attemptId })
    expect(after.requests.businessWrites).toBe(before.requests.businessWrites)
    expect(after.database).toEqual(before.database)
  } finally { release(); await page.context().close(); await host.stop() }
})
