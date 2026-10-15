import { test, expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { confirmSave, edit, localState, serverHead, trackBusinessWrites } from './helpers'
import { fixedProject, selectRun, setRunScript } from './runHelpers'

async function seedHistory(page: Page, snapshotId: string, sample: string) {
  return page.evaluate(async ({ snapshotId, sample }) => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const context = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const response = await fetch('/__i0prep/history-sample', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ attemptId: context.refs.attemptId, snapshotId, sample }) })
    if (response.status !== 200) throw new Error(`seed ${response.status}`)
    return (await response.json()).data as { runId: string; jobId: string; snapshotId: string }
  }, { snapshotId, sample })
}
async function openHistory(page: Page) {
  await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await page.getByRole('button', { name: '历史运行与产物', exact: true }).click()
  await expect(page.getByRole('region', { name: '历史运行与产物', exact: true })).toBeVisible()
}
const side = (page: Page, index: 'A' | 'B') => page.getByRole('region', { name: `运行 ${index}`, exact: true })
async function choose(page: Page, index: 'A' | 'B', runId: string) {
  await page.getByRole('combobox', { name: `运行 ${index}`, exact: true }).selectOption(runId)
  await expect(side(page, index).locator('[data-run-id]')).toHaveAttribute('data-run-id', runId)
  await expect(side(page, index)).toHaveAttribute('aria-busy', 'false')
}

test('比较两次已回执关联运行，各保留旧快照与本机参数，改稿和只读比较不写回', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  let head = await fixedProject(page, 'history-local')
  const first = head.snapshots[0]!
  await selectRun(page, first.snapshotId, first.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行完成')
  const firstRun = await page.locator('.core-run-result').getAttribute('data-run-id')
  await page.getByRole('button', { name: '返回编辑', exact: true }).click()
  await edit(page, 'changed input\n')
  await confirmSave(page, 2)
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.getByText('已冻结快照 v2')).toBeVisible()
  head = await serverHead(page)
  const second = head.snapshots.find(s => s.workspaceRevision === 2)!
  await setRunScript(page, 'compile_failed')
  await selectRun(page, second.snapshotId, second.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('combobox', { name: 'Core 操作', exact: true }).selectOption('find')
  await page.getByRole('textbox', { name: '查找词', exact: true }).fill('one')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('编译失败')
  const secondRun = await page.locator('.core-run-result').getAttribute('data-run-id')
  const before = await localState(page), writes = trackBusinessWrites(page)
  await page.getByRole('button', { name: '历史运行与产物', exact: true }).click()
  await choose(page, 'A', firstRun!)
  await choose(page, 'B', secondRun!)
  await expect(side(page, 'A')).toContainText('本机请求记录')
  await expect(side(page, 'A')).toContainText('stats')
  await expect(side(page, 'B')).toContainText('find one')
  await expect(side(page, 'B')).toContainText('编译失败')
  await expect(side(page, 'A').locator('[data-snapshot-id]')).toHaveAttribute('data-snapshot-id', first.snapshotId)
  await expect(side(page, 'B').locator('[data-snapshot-id]')).toHaveAttribute('data-snapshot-id', second.snapshotId)
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: test.info().outputPath(`history-${theme}.png`) })
  }
  await page.getByRole('button', { name: '重新读取历史', exact: true }).click()
  await expect(side(page, 'B')).toContainText('编译失败')
  await page.getByRole('button', { name: '返回运行', exact: true }).click()
  expect(writes).toEqual([])
  expect((await localState(page)).commands).toEqual(before.commands)
  expect((await serverHead(page)).files).toEqual(head.files)
})

test('另一浏览器缺本机请求仍能比较公开历史与未知/失败，读取不创建运行', async ({ page, browser }) => {
  const head = await fixedProject(page, 'history-no-cache')
  const first = await seedHistory(page, head.snapshots[0]!.snapshotId, 'check')
  const second = await seedHistory(page, head.snapshots[0]!.snapshotId, 'unknown')
  const fresh = await browser.newContext()
  const other = await fresh.newPage(), posts = trackBusinessWrites(other)
  await other.goto(page.url())
  await expect(other.getByText('已冻结快照 v1')).toBeVisible()
  await openHistory(other)
  await choose(other, 'A', first.runId); await choose(other, 'B', second.runId)
  await expect(side(other, 'A')).toContainText('历史运行参数不可回取')
  await expect(side(other, 'B')).toContainText('历史运行参数不可回取')
  await expect(side(other, 'A')).toContainText('failed')
  await expect(side(other, 'B')).toContainText('执行结果未知')
  expect((await localState(other)).commands).toEqual([])
  expect(posts).toEqual([])
  await fresh.close()
})

test('公开文件完整验证后安全查看与合法下载，字节保留 BOM/CRLF 且无写请求', async ({ page }) => {
  const head = await fixedProject(page, 'history-download'), snapshot = head.snapshots[0]!
  const reference = await seedHistory(page, snapshot.snapshotId, 'complete')
  const before = await localState(page), writes = trackBusinessWrites(page)
  await openHistory(page); await choose(page, 'A', reference.runId)
  const region = side(page, 'A')
  await region.getByText('查看 report.txt', { exact: true }).focus()
  await region.getByText('查看 report.txt', { exact: true }).press('Enter')
  await expect(region).toContainText('<script>window.__artifactExecuted=true</script>')
  expect(await page.evaluate(() => (window as unknown as { __artifactExecuted?: boolean }).__artifactExecuted)).toBeUndefined()
  const event = page.waitForEvent('download')
  await region.getByRole('button', { name: '下载 report.txt', exact: true }).click()
  const download = await event
  expect(download.suggestedFilename()).toBe('report.txt')
  const bytes = await readFile((await download.path())!)
  const expected = '\ufeffSYNTHETIC public result\r\n<script>window.__artifactExecuted=true</script>\n'
  expect(bytes).toEqual(Buffer.from(expected))
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'))
  expect(writes).toEqual([])
  expect((await localState(page)).commands).toEqual(before.commands)
})

test('检查只显示公开 verdict/failureKind，HTTP course_check 与节点 check 分层，产物已裁剪', async ({ page }) => {
  const head = await fixedProject(page, 'history-private')
  const reference = await seedHistory(page, head.snapshots[0]!.snapshotId, 'check')
  await page.route('**/api/attempts/*/runs/*', async route => {
    const response = await route.fetch(), body = await response.json()
    if (body.data.mode === 'check') { body.data.input = 'PRIVATE INPUT'; body.data.diagnostics.stdout = 'PRIVATE ANSWER' }
    await route.fulfill({ response, json: body })
  })
  await openHistory(page); await choose(page, 'A', reference.runId)
  await expect(side(page, 'A')).toContainText('failed')
  await expect(side(page, 'A')).toContainText('mismatch')
  await expect(side(page, 'A')).toContainText('检查产物已裁剪')
  await expect(side(page, 'A')).not.toContainText('PRIVATE')
  await expect(side(page, 'A').getByRole('button', { name: /下载/ })).toHaveCount(0)
})

for (const [sample, message] of [['missing', '文件缺失'], ['incomplete', '文件不完整'], ['unavailable', '产物不可回取']]) {
  test(`历史产物 ${sample} 单列且不能查看或下载`, async ({ page }) => {
    const head = await fixedProject(page, `history-${sample}`)
    const reference = await seedHistory(page, head.snapshots[0]!.snapshotId, sample!)
    await openHistory(page); await choose(page, 'A', reference.runId)
    await expect(side(page, 'A')).toContainText(message!)
    await expect(side(page, 'A').getByRole('button', { name: /下载/ })).toHaveCount(0)
    await expect(side(page, 'A').getByText('查看 report.txt', { exact: true })).toHaveCount(0)
  })
}

test('文件 hash 不符/不完整/来源错误拒绝正文与下载，原公开运行仍可比较', async ({ page }) => {
  const head = await fixedProject(page, 'history-bad-file')
  const reference = await seedHistory(page, head.snapshots[0]!.snapshotId, 'complete')
  let fault = 'hash'
  await page.route('**/api/attempts/*/runs/*/files', async route => {
    const response = await route.fetch(), body = await response.json(), f = body.data.files[0]
    if (fault === 'hash') f.text += 'corrupted'
    if (fault === 'incomplete') delete f.text
    if (fault === 'source') f.runId = 'other-run'
    await route.fulfill({ response, json: body })
  })
  await openHistory(page); await choose(page, 'A', reference.runId)
  for (const value of ['hash', 'incomplete', 'source']) {
    fault = value
    await Promise.all([
      page.waitForResponse(r => r.url().endsWith(`/runs/${reference.runId}/files`)),
      page.getByRole('button', { name: '重新读取历史', exact: true }).click(),
    ])
    await expect(side(page, 'A')).toHaveAttribute('aria-busy', 'false')
    await expect(side(page, 'A')).toContainText('产物读取或校验失败')
    await expect(side(page, 'A')).toContainText('SYNTHETIC historical public output')
    await expect(side(page, 'A').getByRole('button', { name: /下载/ })).toHaveCount(0)
  }
})

test('切换比较来源后迟到的完整文件不能绑定另一次运行或开放下载', async ({ page }) => {
  const head = await fixedProject(page, 'history-late-file'), snapshotId = head.snapshots[0]!.snapshotId
  const complete = await seedHistory(page, snapshotId, 'complete')
  const missing = await seedHistory(page, snapshotId, 'missing')
  await openHistory(page)
  await choose(page, 'A', missing.runId); await choose(page, 'B', complete.runId)
  await expect(side(page, 'B').getByRole('button', { name: '下载 report.txt' })).toBeVisible()
  let release!: () => void, arrived!: () => void
  const held = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { arrived = r })
  await page.route(`**/api/attempts/*/runs/${complete.runId}/files`, async route => {
    const response = await route.fetch()
    arrived(); await held
    await route.fulfill({ response })
  })
  await page.getByRole('combobox', { name: '运行 A', exact: true }).selectOption(complete.runId)
  await ready
  await choose(page, 'A', missing.runId)
  await expect(side(page, 'A')).toContainText('文件缺失')
  release()
  await page.waitForTimeout(150)
  await expect(side(page, 'A').locator('[data-run-id]')).toHaveAttribute('data-run-id', missing.runId)
  await expect(side(page, 'A')).toContainText('文件缺失')
  await expect(side(page, 'A').getByRole('button', { name: /下载/ })).toHaveCount(0)
})

test('损坏本机请求关联时不借用表单或其他记录的参数，公开输出继续可读', async ({ page }) => {
  const head = await fixedProject(page, 'history-invalid-local'), snapshot = head.snapshots[0]!
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('本机请求记录')
  const runId = await page.locator('.core-run-result').getAttribute('data-run-id')
  await page.evaluate(async runId => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('xunjie-i0-workspace', 2)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('outbox', 'readwrite'), store = tx.objectStore('outbox')
        const cursor = store.openCursor()
        cursor.onsuccess = () => {
          const c = cursor.result
          if (!c) return
          const value = c.value
          if (value.kind === 'run.create' && value.receipt?.result?.runId === runId) {
            value.runSnapshot.hash = 'f'.repeat(64); c.update(value)
          }
          c.continue()
        }
        tx.oncomplete = () => { db.close(); resolve() }
        tx.onabort = () => { db.close(); reject(tx.error) }
      }
    })
  }, runId)
  await page.reload()
  await expect(page.getByText('已冻结快照 v1')).toBeVisible()
  const writes = trackBusinessWrites(page)
  await openHistory(page); await choose(page, 'A', runId!)
  await expect(side(page, 'A')).toContainText('历史运行参数不可回取')
  await expect(side(page, 'A')).toContainText('SYNTHETIC Core result')
  expect(writes).toEqual([])
})
