import { expect, test } from '@playwright/test'
import { startSessionHost } from './sessionHost'
import { realProject, selectActualRun, acceptedRun, runLocal, trackRuns } from './runServiceHelpers'

test.use({ ignoreHTTPSErrors: true, trace: 'off' })
test.beforeEach(() => test.skip(!process.env.XUNJIE_E2E_SERVICE_NODE, 'Requires approved teaching Node 24.21.0'))

test('实际停止受理保持原身份和未确认槽位，确认后仍服从最新 readiness，只有显式新操作再运行', async ({ page }) => {
  const host = await startSessionHost({ runs: true })
  try {
    const head = await realProject(page, host)
    await selectActualRun(page, head)
    await host.control({ kind: 'runner', action: 'configure', outcome: 'running', stopConfirmed: false })
    const original = await acceptedRun(page), posts = trackRuns(page)
    await expect(page.locator('.core-run-result')).toContainText('运行中')
    await page.getByRole('button', { name: '停止此运行', exact: true }).click()
    await expect(page.locator('.core-run-result')).toContainText('正在停止')
    await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
    expect(posts).toHaveLength(1)
    expect(posts[0]!.path).toBe(`/api/jobs/${original.result.jobId}/cancel`)
    expect(JSON.parse(posts[0]!.body)).toEqual({ recoveryGeneration: expect.any(String) })
    const stopping = await host.control({ kind: 'runner', action: 'inspect', runId: original.result.runId })
    expect(stopping.totals.submitEffects).toBe(1)
    await host.control({ kind: 'runner', action: 'configure', ready: false })
    await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
    await host.control({ kind: 'runner', action: 'confirm-stop', runId: original.result.runId })
    await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
    await expect(page.locator('.core-run-result')).toContainText('已停止')
    await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', original.result.runId)
    await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
    await host.control({ kind: 'runner', action: 'configure', ready: true, outcome: 'success' })
    await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
    await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeEnabled()
    expect(posts.filter(p => p.path.endsWith('/runs'))).toHaveLength(0)
    const next = await acceptedRun(page)
    expect(next.result.runId).not.toBe(original.result.runId)
    await expect(page.locator('.core-run-result')).toContainText('运行完成')
    expect((await host.control({ kind: 'runner', action: 'inspect' })).totals.submitEffects).toBe(2)
    await page.screenshot({ path: test.info().outputPath('actual-stop-confirmation.png') })
  } finally { await page.context().close(); await host.stop() }
})

test('实际停止丢ACK后刷新不自动再取消，明确核对只重放原停止命令，结果GET确认', async ({ page }) => {
  const host = await startSessionHost({ runs: true })
  try {
    const head = await realProject(page, host)
    await selectActualRun(page, head)
    await host.control({ kind: 'runner', action: 'configure', outcome: 'running', stopConfirmed: false })
    const original = await acceptedRun(page), posts = trackRuns(page)
    await expect(page.locator('.core-run-result')).toContainText('运行中')
    await page.route('**/api/jobs/*/cancel', async route => {
      const response = await route.fetch(); expect(response.status()).toBe(200); await route.abort('failed')
    }, { times: 1 })
    await page.getByRole('button', { name: '停止此运行', exact: true }).click()
    await expect(page.locator('.core-run-notice')).toContainText('停止请求结果未知')
    await page.reload()
    await expect(page.getByText('已冻结快照 v1')).toBeVisible()
    await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对原运行请求', exact: true })).toBeVisible()
    expect(posts).toHaveLength(1)
    await host.control({ kind: 'runner', action: 'confirm-stop', runId: original.result.runId })
    await page.getByRole('button', { name: '核对原运行请求', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对原运行请求', exact: true })).toHaveCount(0)
    await expect(page.locator('.core-run-result')).toContainText('已停止')
    await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', original.result.runId)
    expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0])
    const commands = (await runLocal(page)).commands.filter(c => c.kind === 'job.cancel')
    expect(commands).toHaveLength(1); expect(commands[0]!.state).toBe('confirmed')
    expect((await host.control({ kind: 'runner', action: 'inspect' })).totals.submitEffects).toBe(1)
  } finally { await page.context().close(); await host.stop() }
})

test('实际原消费者同库重开继续核原未确认停止，绝不生成替代运行', async ({ page }) => {
  const host = await startSessionHost({ runs: true })
  try {
    const head = await realProject(page, host)
    await selectActualRun(page, head)
    await host.control({ kind: 'runner', action: 'configure', outcome: 'running', stopConfirmed: false })
    const original = await acceptedRun(page), posts = trackRuns(page)
    await expect(page.locator('.core-run-result')).toContainText('运行中')
    await page.getByRole('button', { name: '停止此运行', exact: true }).click()
    await expect(page.locator('.core-run-result')).toContainText('正在停止')
    await host.control({ kind: 'reopen' })
    await page.reload()
    await expect(page.getByText('已冻结快照 v1')).toBeVisible()
    await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
    await expect(page.locator('.core-run-result')).toContainText('正在停止')
    await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', original.result.runId)
    await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
    await host.control({ kind: 'runner', action: 'confirm-stop', runId: original.result.runId })
    await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
    await expect(page.locator('.core-run-result')).toContainText('已停止')
    expect(posts.filter(p => p.path.endsWith('/runs'))).toHaveLength(0)
    expect((await host.control({ kind: 'runner', action: 'inspect' })).totals.submitEffects).toBe(1)
  } finally { await page.context().close(); await host.stop() }
})

test('实际两标签未决停止共用原命令租约，另一标签核对不能重复POST或新建运行', async ({ page, context }) => {
  const host = await startSessionHost({ runs: true })
  let release: (() => void) | undefined
  try {
    const head = await realProject(page, host)
    await selectActualRun(page, head)
    await host.control({ kind: 'runner', action: 'configure', outcome: 'running', stopConfirmed: false })
    const original = await acceptedRun(page)
    await expect(page.locator('.core-run-result')).toContainText('运行中')
    const other = await context.newPage()
    await other.goto(page.url())
    await expect(other.getByText('已冻结快照 v1')).toBeVisible()
    await other.getByRole('button', { name: 'Core 运行', exact: true }).click()
    await expect(other.locator('.core-run-result')).toContainText('运行中')
    // Pause automatic polls only. Explicit reads/controls still use the actual HTTPS service.
    await other.evaluate(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
      window.dispatchEvent(new Event('offline'))
    })
    const firstPosts = trackRuns(page), otherPosts = trackRuns(other)
    let arrive!: () => void
    const held = new Promise<void>(resolve => { release = resolve }), arrived = new Promise<void>(resolve => { arrive = resolve })
    await page.route('**/api/jobs/*/cancel', async route => {
      const response = await route.fetch(); expect(response.status()).toBe(200); arrive()
      await held; await route.fulfill({ response })
    }, { times: 1 })
    await page.getByRole('button', { name: '停止此运行', exact: true }).click()
    await arrived
    // The real consumer can already publish stopping to the sibling. Read the
    // original intent instead of requiring its deliberately stale Stop button.
    await other.getByRole('button', { name: '重新读取结果', exact: true }).click()
    await expect(other.getByRole('button', { name: '核对原运行请求', exact: true })).toBeVisible()
    await other.getByRole('button', { name: '核对原运行请求', exact: true }).click()
    await expect(other.locator('.core-run-notice')).toContainText('停止请求结果未知')
    expect(firstPosts).toHaveLength(1); expect(otherPosts).toHaveLength(0)
    release!()
    await expect.poll(async () => (await runLocal(page)).commands.find(c => c.kind === 'job.cancel')!.state).toBe('confirmed')
    await host.control({ kind: 'runner', action: 'confirm-stop', runId: original.result.runId })
    await other.getByRole('button', { name: '重新读取结果', exact: true }).click()
    await expect(other.locator('.core-run-result')).toContainText('已停止')
    await expect(other.locator('.core-run-result')).toHaveAttribute('data-run-id', original.result.runId)
    expect(firstPosts).toHaveLength(1); expect(otherPosts).toHaveLength(0)
    expect((await host.control({ kind: 'runner', action: 'inspect' })).totals.submitEffects).toBe(1)
  } finally { release?.(); await page.context().close(); await host.stop() }
})
