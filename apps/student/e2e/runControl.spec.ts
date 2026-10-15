import { test, expect } from '@playwright/test'
import { fixedProject, selectRun, setRunScript, recoverRunContext } from './runHelpers'
import { identities, localState, setFault } from './helpers'

test('学生停止原运行，取消受理不当成已停止，公开 GET 确认后才能再次主动运行', async ({ page }) => {
  const snapshot = (await fixedProject(page, 'stop-intent')).snapshots[0]!
  await setRunScript(page, 'running')
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  const posts: Array<{ key: string; body: string }> = []
  let jobId = ''
  page.on('request', r => {
    if (r.method() === 'POST' && r.url().endsWith('/cancel')) {
      posts.push({ key: r.headers()['idempotency-key']!, body: r.postData()! })
      jobId = r.url().split('/').at(-2)!
    }
  })
  await page.route('**/api/jobs/*/cancel', async route => {
    const key = route.request().headers()['idempotency-key']!
    expect((await localState(page)).commands.some(c => c.kind === 'job.cancel' && c.commandKey === key && c.state === 'pending')).toBe(true)
    await route.continue()
  })
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  await page.getByRole('button', { name: '停止此运行', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('正在停止')
  await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
  expect(posts).toHaveLength(1)
  expect(JSON.parse(posts[0]!.body)).toEqual({ recoveryGeneration: expect.any(String) })
  expect(jobId).not.toBe('')
  const commands = (await localState(page)).commands
  expect(commands.filter(c => c.kind === 'job.cancel')[0]!.state).toBe('confirmed')
  expect(commands.filter(c => c.kind === 'run.create')).toHaveLength(1)
  await setRunScript(page, 'cancelled')
  await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('已停止')
  await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeEnabled()
  expect(identities(posts).size).toBe(1)
  expect((await localState(page)).commands.filter(c => c.kind === 'run.create')).toHaveLength(1)
})

test('核对 GET Session 期间另一标签确认原命令，本页接纳同回执而不重变未知', async ({ page, context }) => {
  const snapshot = (await fixedProject(page, 'reconcile-confirmed-race')).snapshots[0]!
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  const posts: string[] = []
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/runs')) posts.push(r.headers()['idempotency-key']!) })
  await setFault(page, 'drop-ack')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('运行请求结果未知')
  await setFault(page, 'none')
  await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行完成')
  const other = await context.newPage()
  await other.goto(page.url())
  await expect(other.getByText('已冻结快照 v1')).toBeVisible()
  await other.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await expect(other.getByRole('button', { name: '核对原运行请求', exact: true })).toBeVisible()
  let release!: () => void, arrived!: () => void
  const held = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { arrived = r })
  await page.route('**/api/session', async route => {
    const response = await route.fetch(); arrived(); await held; await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '核对原运行请求', exact: true }).click()
  await ready
  await other.getByRole('button', { name: '核对原运行请求', exact: true }).click()
  await expect.poll(async () => (await localState(other)).commands.find(c => c.kind === 'run.create')!.state).toBe('confirmed')
  release()
  await expect(page.getByRole('button', { name: '核对原运行请求', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeEnabled()
  expect(posts).toHaveLength(1) // A 不发送第二个 POST；B 只重放同一原键。
})

test('确认原回执后租约清理事务失败仍读取原运行，不重新标未知', async ({ page }) => {
  const snapshot = (await fixedProject(page, 'reconcile-release-fail')).snapshots[0]!
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  const posts: Array<{ key: string; body: string }> = []
  page.on('request', r => {
    if (r.method() === 'POST' && r.url().endsWith('/runs')) posts.push({ key: r.headers()['idempotency-key']!, body: r.postData()! })
  })
  await setFault(page, 'drop-ack')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('运行请求结果未知')
  await setFault(page, 'none')
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      const stores = typeof args[0] === 'string' ? [args[0]] : Array.from(args[0])
      if (args[1] === 'readwrite' && stores.length === 1 && stores[0] === 'outbox') {
        IDBDatabase.prototype.transaction = transaction
        document.documentElement.dataset.releaseFailure = 'injected'
        throw new DOMException('Synthetic release unavailable', 'UnknownError')
      }
      return transaction.apply(this, args)
    }
  })
  await page.getByRole('button', { name: '核对原运行请求', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-release-failure', 'injected')
  await expect.poll(async () => (await localState(page)).commands.find(c => c.kind === 'run.create')!.state).toBe('confirmed')
  await expect(page.getByRole('button', { name: '核对原运行请求', exact: true })).toHaveCount(0)
  await expect(page.locator('.core-run-result')).toContainText('运行完成')
  await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeEnabled()
  expect(posts).toHaveLength(2)
  expect(identities(posts).size).toBe(1)
})

test('核对锁定点击时的未知原运行，独立浏览器的新运行不替换它', async ({ page, browser }) => {
  const snapshot = (await fixedProject(page, 'reconcile-pin')).snapshots[0]!
  await setRunScript(page, 'outcome_unknown')
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('执行结果未知')
  const originalId = await page.locator('.core-run-result').getAttribute('data-run-id')
  // A 暂停网络读取，后台由另一浏览器核回原结果、再由学生发起 r2。
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false }); window.dispatchEvent(new Event('offline'))
  })
  await setRunScript(page, 'success')
  const otherContext = await browser.newContext(), other = await otherContext.newPage()
  await other.goto(page.url())
  await expect(other.getByText('已冻结快照 v1')).toBeVisible()
  await selectRun(other, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await expect(other.locator('.core-run-result')).toContainText('运行完成')
  await setRunScript(other, 'running')
  await other.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(other.locator('.core-run-result')).toContainText('运行中')
  expect(await other.locator('.core-run-result').getAttribute('data-run-id')).not.toBe(originalId)
  await page.getByRole('button', { name: '核对原运行请求', exact: true }).click()
  await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', originalId!)
  await expect(page.locator('.core-run-result')).toContainText('运行完成')
  await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
  await otherContext.close()
})

test('两标签同时停止时原命令事务和发送租约阻止第二个停止 POST', async ({ page, context }) => {
  const snapshot = (await fixedProject(page, 'stop-two-tabs')).snapshots[0]!
  await setRunScript(page, 'running')
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  const other = await context.newPage()
  await other.goto(page.url())
  await expect(other.getByText('已冻结快照 v1')).toBeVisible()
  await other.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await expect(other.locator('.core-run-result')).toContainText('运行中')
  const posts: string[] = []
  for (const tab of [page, other]) tab.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/cancel')) posts.push(r.headers()['idempotency-key']!) })
  let release!: () => void, arrived!: () => void
  const held = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { arrived = r })
  await page.route('**/api/jobs/*/cancel', async route => {
    // Hold before the server applies cancellation; otherwise the other tab can
    // correctly poll stopRequested and remove its stop button before the race.
    arrived(); await held; const response = await route.fetch(); await route.fulfill({ response })
  })
  try {
    await page.getByRole('button', { name: '停止此运行', exact: true }).click()
    await ready
    await other.getByRole('button', { name: '停止此运行', exact: true }).click()
    await expect(other.locator('.core-run-notice')).toBeVisible()
    await other.getByRole('button', { name: '核对原运行请求', exact: true }).click()
    await expect(other.locator('.core-run-notice')).toContainText('停止请求结果未知')
    expect(posts).toHaveLength(1)
    release()
    await expect.poll(async () => (await localState(page)).commands.find(c => c.kind === 'job.cancel')!.state).toBe('confirmed')
    await other.getByRole('button', { name: '重新读取结果', exact: true }).click()
    await expect(other.locator('.core-run-result')).toContainText('正在停止')
    expect(posts).toHaveLength(1)
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }) }
})

test('停止命令未能落盘时不 POST，不宣称已停止', async ({ page }) => {
  const snapshot = (await fixedProject(page, 'stop-persist-fail')).snapshots[0]!
  await setRunScript(page, 'running')
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  const cancels: string[] = []
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/cancel')) cancels.push(r.url()) })
  await page.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction
    let failOnce = true
    IDBDatabase.prototype.transaction = function (...args: Parameters<typeof transaction>) {
      if (failOnce && args[1] === 'readwrite' && Array.from(args[0] as string[]).includes('outbox')) {
        failOnce = false
        throw new DOMException('Synthetic storage unavailable', 'QuotaExceededError')
      }
      return transaction.apply(this, args)
    }
  })
  await page.getByRole('button', { name: '停止此运行', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toBeVisible()
  expect(cancels).toHaveLength(0)
  expect((await localState(page)).commands.filter(c => c.kind === 'job.cancel')).toHaveLength(0)
  await expect(page.locator('.core-run-result')).toContainText('运行中')
})

test('旧代际停止被服务拒绝，不宣称已停或自动迁代际补发', async ({ page }) => {
  const snapshot = (await fixedProject(page, 'stop-generation-reject')).snapshots[0]!
  await setRunScript(page, 'running')
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  const rotated = await recoverRunContext(page)
  const cancels: string[] = []
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/cancel')) cancels.push(r.postData()!) })
  await page.getByRole('button', { name: '停止此运行', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('停止请求被拒绝')
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
  expect(cancels).toHaveLength(1)
  expect(JSON.parse(cancels[0]!).recoveryGeneration).toBe(rotated.before)
  const command = (await localState(page)).commands.find(c => c.kind === 'job.cancel')!
  expect(command.rejected?.code).toBe('RECOVERY_REQUIRED')
})

test('停止前的迟到 running poll 不覆盖停止后已接受的 cancelling', async ({ page }) => {
  const snapshot = (await fixedProject(page, 'stop-old-poll')).snapshots[0]!
  await setRunScript(page, 'running')
  let count = 0, release!: () => void, arrived!: () => void
  const held = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { arrived = r })
  await page.route('**/api/jobs/*', async route => {
    const response = await route.fetch()
    if (++count === 3) { expect((await response.json()).data.status).toBe('running'); arrived(); await held }
    await route.fulfill({ response })
  })
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  await ready
  await page.getByRole('button', { name: '停止此运行', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('正在停止')
  release()
  await page.waitForTimeout(200)
  await expect(page.locator('.core-run-result')).toContainText('正在停止')
  expect((await localState(page)).commands.filter(c => c.kind === 'run.create')).toHaveLength(1)
})

test('工作区换代际后迟到 cancel 回执只留历史，不覆盖新加载的已停止结果', async ({ page }) => {
  const snapshot = (await fixedProject(page, 'stop-old-ack')).snapshots[0]!
  await setRunScript(page, 'running')
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  const id = await page.locator('.core-run-result').getAttribute('data-run-id')
  let release!: () => void, arrived!: () => void
  const held = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { arrived = r })
  await page.route('**/api/jobs/*/cancel', async route => {
    const response = await route.fetch()
    expect((await response.json()).data.result.status).toBe('cancelling')
    arrived(); await held; await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '停止此运行', exact: true }).click()
  await ready
  await recoverRunContext(page)
  await setRunScript(page, 'cancelled')
  await page.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('已停止')
  release()
  await expect.poll(async () => (await localState(page)).commands.find(c => c.kind === 'job.cancel')!.state).toBe('historical')
  await expect(page.locator('.core-run-result')).toContainText('已停止')
  await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', id!)
  expect((await localState(page)).commands.filter(c => c.kind === 'run.create')).toHaveLength(1)
})

test('取消回执本机事务 abort 后保留原命令，刷新原键核对可以完成', async ({ page }) => {
  const snapshot = (await fixedProject(page, 'stop-local-abort')).snapshots[0]!
  await setRunScript(page, 'running')
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  await page.evaluate(async () => {
    const { setConfirmationAbortStage } = await import('/src/workspace/confirmationDb.ts' as string)
    setConfirmationAbortStage('outbox')
  })
  const posts: Array<{ key: string; body: string }> = []
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/cancel')) posts.push({ key: r.headers()['idempotency-key']!, body: r.postData()! }) })
  await page.getByRole('button', { name: '停止此运行', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('停止请求结果未知')
  expect((await localState(page)).commands.find(c => c.kind === 'job.cancel')!.state).toBe('pending')
  await page.reload()
  await expect(page.getByText('已冻结快照 v1')).toBeVisible()
  await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await page.getByRole('button', { name: '核对原运行请求', exact: true }).click()
  await expect.poll(async () => (await localState(page)).commands.find(c => c.kind === 'job.cancel')!.state).toBe('confirmed')
  expect(identities(posts).size).toBe(1)
})

test('未知原运行的旧代际核对被拒仍保留原请求，新上下文不改键/代际补做', async ({ page }) => {
  const snapshot = (await fixedProject(page, 'unknown-generation')).snapshots[0]!
  await setRunScript(page, 'running')
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  const posts: Array<{ key: string; body: string }> = []
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/runs')) posts.push({ key: r.headers()['idempotency-key']!, body: r.postData()! }) })
  await setFault(page, 'drop-ack')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('运行请求结果未知')
  await setFault(page, 'none')
  const rotated = await recoverRunContext(page)
  expect(rotated.after).not.toBe(rotated.before)
  await page.getByRole('button', { name: '核对原运行请求', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('这次核对被拒绝')
  const original = (await localState(page)).commands.find(c => c.kind === 'run.create')!
  expect(original.state).toBe('pending')
  expect(original.rejected?.code).toBe('RECOVERY_REQUIRED')
  expect(identities(posts).size).toBe(1)
  await page.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('恢复核对尚未交接')
  await page.getByRole('button', { name: '核对原运行请求', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('恢复核对尚未交接')
  expect(posts).toHaveLength(2)
  expect((await localState(page)).commands.find(c => c.kind === 'run.create')!.wireJson).toBe(original.wireJson)
})

test('创建 ACK 丢失后核对冻结原请求，当前控件修改不进入重放；原回执恢复同 run/job', async ({ page }) => {
  const snapshot = (await fixedProject(page, 'run-reconcile')).snapshots[0]!
  await setRunScript(page, 'running')
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  const runs: Array<{ key: string; body: string }> = []
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/runs')) runs.push({ key: r.headers()['idempotency-key']!, body: r.postData()! }) })
  await setFault(page, 'drop-ack')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('运行请求结果未知')
  await setFault(page, 'none')
  await page.reload()
  await expect(page.getByText('已冻结快照 v1')).toBeVisible()
  await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  const originalId = await page.locator('.core-run-result').getAttribute('data-run-id')
  await page.getByRole('combobox', { name: 'Core 操作', exact: true }).selectOption('find')
  await page.getByRole('textbox', { name: '查找词', exact: true }).fill('changed')
  expect(runs).toHaveLength(1)
  await page.getByRole('button', { name: '核对原运行请求', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('本机请求记录 · 入口 main.c · stats')
  await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', originalId!)
  expect(runs).toHaveLength(2); expect(identities(runs).size).toBe(1)
  expect((await localState(page)).commands.filter(c => c.kind === 'run.create')).toHaveLength(1)
})

for (const status of ['outcome_unknown', 'stale'] as const) {
  test(`${status} 与断线核对只 GET 原运行，不产生新的执行`, async ({ page }) => {
    const snapshot = (await fixedProject(page, `known-${status}`)).snapshots[0]!
    await setRunScript(page, status)
    await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
    const posts: string[] = []
    page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/runs')) posts.push(r.postData()!) })
    await page.getByRole('button', { name: '运行此快照', exact: true }).click()
    await expect(page.locator('.core-run-result')).toContainText(status === 'stale' ? '运行已过期' : '执行结果未知')
    const id = await page.locator('.core-run-result').getAttribute('data-run-id')
    await page.route('**/api/jobs/*', route => route.abort('internetdisconnected'))
    await page.getByRole('button', { name: '核对原运行请求', exact: true }).click()
    await expect(page.locator('.core-run-notice')).toContainText('读取未知')
    await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
    await page.unroute('**/api/jobs/*')
    await page.getByRole('button', { name: '核对原运行请求', exact: true }).click()
    await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', id!)
    await expect(page.locator('.core-run-notice')).toContainText('仍需核对')
    expect(posts).toHaveLength(1)
  })
}

test('停止 ACK 丢失且刷新后只显式重放原停止键/正文，终态也不替代未决回执核对', async ({ page }) => {
  const snapshot = (await fixedProject(page, 'stop-lost-ack')).snapshots[0]!
  await setRunScript(page, 'running')
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  const cancels: Array<{ key: string; body: string }> = [], runs: string[] = []
  page.on('request', r => {
    if (r.method() !== 'POST') return
    if (r.url().endsWith('/cancel')) cancels.push({ key: r.headers()['idempotency-key']!, body: r.postData()! })
    if (r.url().endsWith('/runs')) runs.push(r.headers()['idempotency-key']!)
  })
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  await setFault(page, 'drop-ack')
  await page.getByRole('button', { name: '停止此运行', exact: true }).click()
  await expect(page.locator('.core-run-notice')).toContainText('停止请求结果未知')
  const original = (await localState(page)).commands.find(c => c.kind === 'job.cancel')!
  expect(original.state).toBe('pending')
  await setFault(page, 'none')
  await setRunScript(page, 'cancelled')
  await page.reload()
  await expect(page.getByText('已冻结快照 v1')).toBeVisible()
  await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await expect(page.locator('.core-run-result')).toContainText('已停止')
  await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
  expect(cancels).toHaveLength(1); expect(runs).toHaveLength(1)
  await page.getByRole('button', { name: '核对原运行请求', exact: true }).click()
  await expect.poll(async () => (await localState(page)).commands.find(c => c.kind === 'job.cancel')!.state).toBe('confirmed')
  expect(cancels).toHaveLength(2); expect(identities(cancels).size).toBe(1)
  expect(cancels[1]).toEqual({ key: original.commandKey, body: original.wireJson })
  expect(runs).toHaveLength(1)
  await expect(page.getByRole('button', { name: '重试上次保存', exact: true })).toHaveCount(0)
})
