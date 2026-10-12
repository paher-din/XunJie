import { test, expect } from '@playwright/test'
import { edit, localState, serverHead, setFault } from './helpers'

import { fixedProject, selectRun, setRunScript } from './runHelpers'

test('明确运行固定 Core 快照，先落盘原命令再 POST，GET 公开结果与本机参数关联', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  const head = await fixedProject(page, 'run-core-success')
  const snapshot = head.snapshots[0]!
  const entry = snapshot.files.find(f => f.path === 'main.c')!.fileId
  const input = snapshot.files.find(f => f.path === 'sample.txt')!.fileId
  const posts: Array<{ key: string; body: string }> = []
  await page.route('**/api/attempts/*/runs', async route => {
    const request = route.request()
    if (request.method() !== 'POST') return route.continue()
    posts.push({ key: request.headers()['idempotency-key']!, body: request.postData()! })
    const local = await localState(page)
    expect(local.commands.some(c => c.kind === 'run.create' && c.commandKey === posts[0]!.key && c.wireJson === posts[0]!.body)).toBe(true)
    await route.continue()
  })
  await selectRun(page, snapshot.snapshotId, entry, input)
  expect(posts).toHaveLength(0)
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  const result = page.getByRole('region', { name: '固定快照结果', exact: true })
  await expect(result).toContainText('运行完成')
  await expect(result).toHaveAttribute('data-snapshot-id', snapshot.snapshotId)
  await expect(result).toContainText('本机请求记录')
  await expect(result.getByLabel('stdout', { exact: true })).toContainText('SYNTHETIC')
  expect(posts).toHaveLength(1)
  expect(JSON.parse(posts[0]!.body)).toEqual({ recoveryGeneration: expect.any(String), expectedAttemptRevision: head.attempt.attemptRevision,
    snapshotId: snapshot.snapshotId, runtimeProfileVersion: expect.any(String), entryFileId: entry,
    input: { operation: 'stats', fileIds: [input] }, mode: 'run' })
  for (const theme of ['light', 'dark']) {
    await page.evaluate(theme => document.documentElement.setAttribute('data-theme', theme), theme)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    const tabs = await page.locator('.ws-head-tabs .ws-tooltabs').boundingBox()
    const badge = await page.locator('.ts-badge').boundingBox()
    expect(tabs).not.toBeNull(); expect(badge).not.toBeNull()
    expect(tabs!.x + tabs!.width).toBeLessThanOrEqual(badge!.x)
    await page.screenshot({ path: test.info().outputPath(`core-${theme}.png`) })
  }
})

test('运行 readiness 明确拒绝保留原请求事实，重读后新操作才另建命令', async ({ page }) => {
  const head = await fixedProject(page, 'run-not-ready'), snapshot = head.snapshots[0]!
  await setRunScript(page, 'not_ready')
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('未被接受')
  const rejected = (await localState(page)).commands.filter(c => c.kind === 'run.create')
  expect(rejected).toHaveLength(1)
  expect(rejected[0]!.state).toBe('historical')
  expect(rejected[0]!.rejected?.code).toBe('RUNTIME_NOT_READY')
  expect((await serverHead(page) as unknown as { jobs: unknown[] }).jobs).toHaveLength(0)
  await setRunScript(page, 'success')
  await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
  await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeEnabled()
  expect((await localState(page)).commands.filter(c => c.kind === 'run.create')).toHaveLength(1)
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行完成')
  const commands = (await localState(page)).commands.filter(c => c.kind === 'run.create')
  expect(commands).toHaveLength(2)
  expect(commands.find(c => c.state === 'confirmed')!.commandKey).not.toBe(rejected[0]!.commandKey)
})

test('运行轮询断线暂停、隐藏降频且有次数上限，主动只读可恢复', async ({ page }) => {
  const head = await fixedProject(page, 'run-poll-budget'), snapshot = head.snapshots[0]!
  await setRunScript(page, 'running')
  let reads = 0
  page.on('request', r => { if (r.method() === 'GET' && /\/api\/jobs\/[^/]+$/.test(r.url())) reads++ })
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  await page.clock.install()
  await page.clock.pauseAt(new Date())
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  let before = reads
  await page.clock.runFor(9000)
  expect(reads).toBe(before)
  await page.clock.runFor(1000)
  await expect.poll(() => reads).toBe(before + 1)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    window.dispatchEvent(new Event('offline'))
  })
  before = reads
  await page.clock.runFor(30_000)
  expect(reads).toBe(before)
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange'))
  })
  // 接受回执后有两次初始 Job GET，之后最多 60 次自动读取。
  for (let i = 0; i < 60 && reads < 62; i++) {
    const count = reads
    const response = page.waitForResponse(r => /\/runs\/[^/]+$/.test(r.url()) && r.request().method() === 'GET')
    await page.clock.runFor(1000)
    await expect.poll(() => reads).toBe(count + 1)
    // 等本轮公开 Run 读到并发布后，再推进下一轮的浏览器时钟。
    await expect(page.locator('.core-run-result')).toContainText('运行中')
    await (await response).finished()
    await page.waitForTimeout(30)
  }
  await expect(page.locator('.core-run-notice')).toContainText('自动读取已暂停')
  expect(reads).toBe(62)
  before = reads
  await page.clock.runFor(60_000)
  expect(reads).toBe(before)
  await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
  await expect.poll(() => reads).toBe(before + 1)
  await page.clock.runFor(1000)
  await expect.poll(() => reads).toBe(before + 2)
  expect((await localState(page)).commands.filter(c => c.kind === 'run.create')).toHaveLength(1)
})

test('运行 ACK 丢失后刷新不换键重跑，保存核对不误处理运行原命令', async ({ page }) => {
  const head = await fixedProject(page, 'run-unknown')
  const snapshot = head.snapshots[0]!
  const posts: string[] = []
  page.on('request', r => { if (r.method() === 'POST' && /\/runs$/.test(r.url())) posts.push(r.postData()!) })
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await setFault(page, 'drop-ack')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('运行请求结果未知')
  await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
  const pending = (await localState(page)).commands.filter(c => c.kind === 'run.create')
  expect(pending).toHaveLength(1); expect(pending[0]!.state).toBe('pending')
  await setFault(page, 'none')
  await page.reload()
  await expect(page.getByText('已冻结快照 v1')).toBeVisible()
  await expect(page.getByRole('button', { name: '重试上次保存', exact: true })).toHaveCount(0)
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('combobox', { name: 'Core 操作', exact: true }).selectOption('find')
  await page.getByRole('textbox', { name: '查找词', exact: true }).fill('one')
  await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('还没有核对完成')
  await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
  expect(posts).toHaveLength(1)
  expect((await localState(page)).commands.filter(c => c.kind === 'run.create')[0]!.commandKey).toBe(pending[0]!.commandKey)
})

test('较早 running poll 迟到不能覆盖较新已读取的终态', async ({ page }) => {
  const head = await fixedProject(page, 'run-old-poll'), snapshot = head.snapshots[0]!
  await setRunScript(page, 'running')
  let count = 0, release!: () => void, arrived!: () => void
  const wait = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { arrived = r })
  await page.route('**/api/jobs/*', async route => {
    const response = await route.fetch()
    if (++count === 3) {
      expect((await response.json()).data.status).toBe('running')
      arrived(); await wait
    }
    await route.fulfill({ response })
  })
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  await ready
  await setRunScript(page, 'success')
  await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行完成')
  release()
  await page.waitForTimeout(300)
  await expect(page.locator('.core-run-result')).toContainText('运行完成')
  expect((await localState(page)).commands.filter(c => c.kind === 'run.create')).toHaveLength(1)
})

test('工作区重新加载后的权威读取可含旧代际 Job，旧加载 poll 不绑定新结果', async ({ page }) => {
  const head = await fixedProject(page, 'run-restored-job'), snapshot = head.snapshots[0]!
  await setRunScript(page, 'running')
  let count = 0, release!: () => void, arrived!: () => void
  const held = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { arrived = r })
  await page.route('**/api/jobs/*', async route => {
    const response = await route.fetch()
    if (++count === 3) { arrived(); await held }
    await route.fulfill({ response })
  })
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  await ready
  const originalId = await page.locator('.core-run-result').getAttribute('data-run-id')
  const rotated = await page.evaluate(async () => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const data = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const response = await fetch('/__i0prep/recover', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ attemptId: data.refs.attemptId, workspaceRevision: 1 }) })
    return { status: response.status, before: data.recoveryGeneration, after: (await response.json()).data.recoveryGeneration }
  })
  expect(rotated.status).toBe(200); expect(rotated.after).not.toBe(rotated.before)
  await setRunScript(page, 'success')
  await page.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行完成')
  await expect(page.locator('.core-run-result')).toContainText('本机请求记录')
  await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', originalId!)
  release()
  await page.waitForTimeout(100)
  await expect(page.locator('.core-run-result')).toContainText('运行完成')
  // 新加载不继承运行表单选择；学生重新选择后才能发起另一操作。
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeEnabled()
  expect((await localState(page)).commands.filter(c => c.kind === 'run.create')).toHaveLength(1)
})

for (const [outcome, status, failure] of [
  ['compile_failed', '运行完成 · 编译失败', 'compile_error'], ['runtime_failed', '运行完成 · 程序执行失败', 'program_error'],
  ['timed_out', '运行完成 · 程序超时', 'timeout'], ['output_limit', '运行完成 · 输出超过限额', 'output_limit'],
  ['unavailable', '运行完成', null], ['node_failed', '执行失败', null],
] as const) {
  test(`公开诊断 ${outcome} 与网络未知分开，缺项不伪装空输出`, async ({ page }) => {
    const head = await fixedProject(page, `run-${outcome}`), snapshot = head.snapshots[0]!
    await setRunScript(page, outcome)
    await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
    let publicRun: Record<string, unknown> | null = null
    page.on('response', async response => {
      if (response.request().method() === 'GET' && /\/runs\/[^/]+$/.test(response.url())) publicRun = (await response.json()).data
    })
    await page.getByRole('button', { name: '运行此快照', exact: true }).click()
    const result = page.locator('.core-run-result')
    await expect(result).toContainText(status)
    if (failure) {
      await expect(result).toContainText(`故障：${failure}`)
      if (outcome === 'compile_failed') {
        await expect(result.getByLabel('stderr', { exact: true })).toHaveText('SYNTHETIC compiler diagnostic\n')
        expect(await result.textContent()).not.toMatch(/第\s*\d+\s*行|phase|行号/)
      }
    } else {
      await expect(result).toContainText('诊断暂不可回取')
      await expect(result.getByLabel('stdout', { exact: true })).toHaveCount(0)
    }
    expect(publicRun).not.toBeNull()
    expect(Object.keys(publicRun!)).toEqual(['runId', 'jobId', 'snapshotId', 'snapshotHash', 'mode', 'runtimeProfileVersion', 'imageDigest', 'diagnostics'])
    expect(Object.keys(publicRun!)).not.toContain('entryFileId')
    expect(Object.keys(publicRun!)).not.toContain('input')
  })
}

test('运行中主动改稿不改变旧快照，刷新与另一浏览器缺参数仍能只读结果', async ({ page, browser }) => {
  const head = await fixedProject(page, 'run-edit-cache'), snapshot = head.snapshots[0]!
  await setRunScript(page, 'running')
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  const runId = await page.locator('.core-run-result').getAttribute('data-run-id')
  const hash = await page.locator('.core-run-result').getAttribute('data-snapshot-hash')
  await page.getByRole('button', { name: '返回编辑', exact: true }).click()
  await edit(page, 'later draft\n')
  await expect(page.locator('.ws-flow')).toContainText('1 个文件未确认')
  await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', runId!)
  await expect(page.locator('.core-run-result')).toHaveAttribute('data-snapshot-hash', hash!)
  await expect(page.locator('.core-run-result')).toContainText('本机请求记录')
  expect((await serverHead(page)).snapshots[0]!.files.find(f => f.path === 'sample.txt')!.text).toBe('one two one\n')
  await setRunScript(page, 'success')
  await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行完成')
  const otherContext = await browser.newContext()
  const other = await otherContext.newPage()
  const writes: string[] = []
  other.on('request', r => { if (r.method() === 'POST' && /\/runs$/.test(r.url())) writes.push(r.url()) })
  await other.goto(page.url())
  await expect(other.getByText('已冻结快照 v1')).toBeVisible()
  await other.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await expect(other.locator('.core-run-result')).toContainText('历史运行参数不可回取')
  await expect(other.locator('.core-run-result')).toHaveAttribute('data-run-id', runId!)
  await expect(other.locator('.core-run-result')).toHaveAttribute('data-snapshot-hash', hash!)
  await expect(other.locator('.core-run-result').getByLabel('stdout', { exact: true })).toContainText('SYNTHETIC')
  expect(writes).toHaveLength(0)
  await otherContext.close()
  await page.reload()
  await expect(page.locator('.view-lines')).toContainText('later draft')
  await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('本机请求记录')
  await expect(page.locator('.core-run-result')).toHaveAttribute('data-snapshot-hash', hash!)
})

test('已确认运行的 Job GET 拒绝只记读取未知，不把成功 POST 改成未被接受', async ({ page }) => {
  const head = await fixedProject(page, 'run-ack-get-rejected'), snapshot = head.snapshots[0]!
  let first = true
  await page.route('**/api/jobs/*', async route => {
    if (!first) return route.continue()
    first = false
    const response = await route.fetch({ url: route.request().url().replace(/\/jobs\/[^/]+$/, '/jobs/not-authorized') })
    expect(response.status()).toBe(403)
    await route.fulfill({ response })
  })
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('运行已被接受，但结果读取未知')
  const original = (await localState(page)).commands.filter(c => c.kind === 'run.create')
  expect(original).toHaveLength(1); expect(original[0]!.state).toBe('confirmed'); expect(original[0]!.rejected).toBeUndefined()
  await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行完成')
  expect((await localState(page)).commands.filter(c => c.kind === 'run.create')).toHaveLength(1)
})

test('find/top 输入拒绝不发送，参数修正后每次学生新操作用新命令', async ({ page }) => {
  const head = await fixedProject(page, 'run-input-limit'), snapshot = head.snapshots[0]!
  const posts: Array<{ key: string; body: string }> = []
  page.on('request', r => { if (r.method() === 'POST' && /\/runs$/.test(r.url())) posts.push({ key: r.headers()['idempotency-key']!, body: r.postData()! }) })
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('combobox', { name: 'Core 操作', exact: true }).selectOption('find')
  await page.getByRole('textbox', { name: '查找词', exact: true }).fill('one; /tmp/host')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('ASCII')
  expect(posts).toHaveLength(0)
  await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
  await page.getByRole('textbox', { name: '查找词', exact: true }).fill('one')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行完成')
  expect(JSON.parse(posts[0]!.body).input).toEqual({ operation: 'find', fileIds: [snapshot.files.find(f => f.path === 'sample.txt')!.fileId], word: 'one' })
  await page.getByRole('combobox', { name: 'Core 操作', exact: true }).selectOption('top')
  await page.getByRole('textbox', { name: '数量', exact: true }).fill('2147483648')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('2147483647')
  expect(posts).toHaveLength(1)
  await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
  await page.getByRole('textbox', { name: '数量', exact: true }).fill('2')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect.poll(() => posts.length).toBe(2)
  await expect(page.locator('.core-run-result')).toContainText('本机请求记录 · 入口 main.c · top 2')
  expect(posts[1]!.key).not.toBe(posts[0]!.key)
  expect(JSON.parse(posts[1]!.body).input.count).toBe('2')
})
