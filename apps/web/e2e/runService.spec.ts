import { expect, test } from '@playwright/test'
import { edit } from './helpers'
import { startSessionHost } from './sessionHost'
import { actualHead, realProject, selectActualRun, acceptedRun, runLocal, trackRuns } from './runServiceHelpers'

// Actual HTTP/SQLite/consumer. Only the isolated external runner is synthetic.
test.use({ ignoreHTTPSErrors: true, trace: 'off' })
test.beforeEach(() => test.skip(!process.env.XUNJIE_E2E_SERVICE_NODE, 'Requires approved teaching Node 24.21.0'))

test('实际 Core 固定快照 stats/find/top：原命令先落盘、原消费者推进，运行中改稿不改结果来源', async ({ page }) => {
  const host = await startSessionHost({ runs: true })
  try {
    const head = await realProject(page, host), snapshot = await selectActualRun(page, head)
    const posts = trackRuns(page)
    await host.control({ kind: 'runner', action: 'configure', outcome: 'running' })
    await page.route('**/api/attempts/*/runs', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      const request = route.request()
      expect((await runLocal(page)).commands.some(c => c.kind === 'run.create' &&
        c.commandKey === request.headers()['idempotency-key'] && c.wireJson === request.postData() && c.state === 'pending')).toBe(true)
      await route.continue()
    })
    const first = await acceptedRun(page)
    await expect(page.locator('.core-run-result')).toContainText('运行中')
    expect(JSON.parse(posts[0]!.body)).toEqual({ recoveryGeneration: expect.any(String), expectedAttemptRevision: head.attempt.attemptRevision,
      snapshotId: snapshot.snapshotId, runtimeProfileVersion: 'runtime-v1', entryFileId: snapshot.files.find(f => f.path === 'main.c')!.fileId,
      input: { operation: 'stats', fileIds: [snapshot.files.find(f => f.path === 'sample.txt')!.fileId] }, mode: 'run' })
    await page.getByRole('button', { name: '返回编辑', exact: true }).click()
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press('Control+a')
    await edit(page, 'newer draft during the original run\n')
    await expect(page.locator('.ws-flow')).toContainText('未确认')
    await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
    await host.control({ kind: 'runner', action: 'finish', runId: first.result.runId, outcome: 'success' })
    await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
    await expect(page.locator('.core-run-result')).toContainText('运行完成')
    await expect(page.locator('.core-run-result')).toHaveAttribute('data-snapshot-id', snapshot.snapshotId)
    await expect(page.locator('.core-run-result')).toContainText('本机请求记录')
    const source = await page.context().request.get(`${host.base}/api/attempts/${head.attempt.attemptId}/runs/${first.result.runId}`)
    const run = (await source.json()).data
    expect(run.snapshotHash).toBe(snapshot.hash)
    expect((await runLocal(page)).drafts.some(d => d.text === 'newer draft during the original run\n')).toBe(true)
    expect((await actualHead(page, host, head.attempt.attemptId)).files.find(f => f.path === 'sample.txt')!.text).toBe('one two one\n')
    await host.control({ kind: 'runner', action: 'configure', outcome: 'success' })
    for (const operation of ['find', 'top']) {
      await page.getByRole('combobox', { name: 'Core 操作', exact: true }).selectOption(operation)
      if (operation === 'find') await page.getByRole('textbox', { name: '查找词', exact: true }).fill('one')
      else await page.getByRole('textbox', { name: '数量', exact: true }).fill('2')
      const receipt = await acceptedRun(page)
      await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', receipt.result.runId)
      await expect(page.locator('.core-run-result')).toContainText('运行完成')
      expect(receipt.result.runId).not.toBe(first.result.runId)
    }
    expect(new Set(posts.map(p => p.key)).size).toBe(3)
    const metrics = await host.control({ kind: 'runner', action: 'inspect' })
    expect(metrics.totals.submitEffects).toBe(3)
    await page.screenshot({ path: test.info().outputPath('actual-core-newer-draft.png') })
  } finally { await page.context().close(); await host.stop() }
})

test('实际 readiness 失效禁新运行且不冻结命令；恢复后仅学生新操作运行，保存仍可用', async ({ page }) => {
  const host = await startSessionHost({ runs: true })
  try {
    const head = await realProject(page, host)
    await selectActualRun(page, head)
    await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeEnabled()
    const before = await host.control({ kind: 'inspect' }), posts = trackRuns(page)
    await host.control({ kind: 'runner', action: 'configure', ready: false })
    await page.getByRole('button', { name: '运行此快照', exact: true }).click()
    await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
    expect(posts).toHaveLength(0)
    expect((await runLocal(page)).commands.filter(c => c.kind === 'run.create')).toHaveLength(0)
    expect((await host.control({ kind: 'inspect' })).requests.businessWrites).toBe(before.requests.businessWrites)
    await page.getByRole('button', { name: '返回编辑', exact: true }).click()
    await edit(page, 'saved while execution readiness is unavailable\n')
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await expect(page.locator('.ws-flow')).toContainText('确认作品 v2')
    await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
    await host.control({ kind: 'runner', action: 'configure', ready: true, outcome: 'success' })
    await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
    await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeEnabled()
    expect(posts).toHaveLength(0)
    await acceptedRun(page)
    await expect(page.locator('.core-run-result')).toContainText('运行完成')
  } finally { await page.context().close(); await host.stop() }
})

test('实际公开诊断区分编译/程序/时间/输出失败与基础设施不可回取，不将 Job succeeded 当课程通过', async ({ page }) => {
  test.setTimeout(100_000)
  const host = await startSessionHost({ runs: true })
  try {
    const head = await realProject(page, host)
    await selectActualRun(page, head)
    for (const [outcome, failureKind] of [['compile-error', 'compile_error'], ['program-error', 'program_error'],
      ['timeout', 'timeout'], ['output-limit', 'output_limit'], ['infrastructure-error', null]] as const) {
      await host.control({ kind: 'runner', action: 'configure', outcome })
      const receipt = await acceptedRun(page)
      await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', receipt.result.runId)
      await expect.poll(async () => (await (await page.context().request.get(`${host.base}/api/jobs/${receipt.result.jobId}`)).json()).data.status)
        .toBe(failureKind ? 'succeeded' : 'failed')
      await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
      const run = (await (await page.context().request.get(`${host.base}/api/attempts/${head.attempt.attemptId}/runs/${receipt.result.runId}`)).json()).data
      expect(run.diagnostics.status).toBe(failureKind ? 'available' : 'unavailable')
      if (failureKind) expect(run.diagnostics.failureKind).toBe(failureKind)
      else await expect(page.locator('.core-run-result')).toContainText('诊断暂不可回取')
      expect(run.mode).toBe('run'); expect(run.diagnostics.verdict).toBeUndefined()
      await expect(page.locator('.core-run-result')).not.toContainText('公开检查结果：passed')
      await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeEnabled()
    }
    expect((await host.control({ kind: 'runner', action: 'inspect' })).totals.submitEffects).toBe(5)
  } finally { await page.context().close(); await host.stop() }
})

test('实际创建丢ACK：刷新无自动第二次运行，明确核对重放同key/body且同一个原Job/Run', async ({ page }) => {
  const host = await startSessionHost({ runs: true })
  try {
    const head = await realProject(page, host)
    await selectActualRun(page, head)
    const posts = trackRuns(page)
    await page.route('**/api/attempts/*/runs', async route => {
      if (route.request().method() !== 'POST') return route.continue()
      const response = await route.fetch()
      expect(response.status()).toBe(200)
      await route.abort('failed')
    }, { times: 1 })
    await page.getByRole('button', { name: '运行此快照', exact: true }).click()
    await expect(page.locator('.core-run-notice')).toContainText('运行请求结果未知')
    await page.reload()
    await expect(page.getByText('已冻结快照 v1')).toBeVisible()
    await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对原运行请求', exact: true })).toBeVisible()
    expect(posts).toHaveLength(1)
    const originalHead = await actualHead(page, host, head.attempt.attemptId)
    expect(originalHead.jobs).toHaveLength(1)
    await page.getByRole('button', { name: '核对原运行请求', exact: true }).click()
    await expect(page.getByRole('button', { name: '核对原运行请求', exact: true })).toHaveCount(0)
    await expect(page.locator('.core-run-result')).toContainText('运行完成')
    expect(posts).toHaveLength(2)
    expect(posts[1]).toEqual(posts[0])
    const commands = (await runLocal(page)).commands.filter(c => c.kind === 'run.create')
    expect(commands).toHaveLength(1); expect(commands[0]!.state).toBe('confirmed')
    expect((await host.control({ kind: 'runner', action: 'inspect' })).totals.submitEffects).toBe(1)
  } finally { await page.context().close(); await host.stop() }
})

test('实际执行接收后失联 outcome_unknown 仅核原身份，不自动补 submit 或新运行', async ({ page, context }) => {
  const host = await startSessionHost({ runs: true })
  try {
    const head = await realProject(page, host)
    await selectActualRun(page, head)
    await host.control({ kind: 'runner', action: 'configure', outcome: 'unknown' })
    const posts = trackRuns(page), receipt = await acceptedRun(page)
    await expect(page.locator('.core-run-result')).toContainText('执行结果未知')
    await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
    await context.setOffline(true)
    await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', receipt.result.runId)
    await context.setOffline(false)
    await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
    await expect(page.locator('.core-run-result')).toContainText('执行结果未知')
    const unknown = await host.control({ kind: 'runner', action: 'inspect' })
    expect(unknown.totals.submitEffects).toBe(1); expect(unknown.totals.submit).toBe(1)
    await host.control({ kind: 'runner', action: 'finish', runId: receipt.result.runId, outcome: 'success' })
    await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
    await expect(page.locator('.core-run-result')).toContainText('运行完成')
    await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', receipt.result.runId)
    expect(posts).toHaveLength(1)
    expect((await host.control({ kind: 'runner', action: 'inspect' })).totals.submit).toBe(1)
  } finally { await page.context().close(); await host.stop() }
})

test('实际原Job迟到 running读取不能回退已接纳终态或改变原快照', async ({ page }) => {
  const host = await startSessionHost({ runs: true })
  let release: (() => void) | undefined
  try {
    const head = await realProject(page, host)
    await selectActualRun(page, head)
    await host.control({ kind: 'runner', action: 'configure', outcome: 'running' })
    const original = await acceptedRun(page)
    await expect(page.locator('.core-run-result')).toContainText('运行中')
    const posts = trackRuns(page)
    let arrive!: () => void, complete!: () => void
    const arrived = new Promise<void>(resolve => { arrive = resolve })
    const held = new Promise<void>(resolve => { release = resolve })
    const completed = new Promise<void>(resolve => { complete = resolve })
    await page.route(`**/api/jobs/${original.result.jobId}`, async route => {
      const response = await route.fetch()
      expect((await response.json()).data.status).toBe('running'); arrive()
      await held; await route.fulfill({ response }); complete()
    }, { times: 1 })
    await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
    await arrived
    await host.control({ kind: 'runner', action: 'finish', runId: original.result.runId, outcome: 'success' })
    await page.getByRole('button', { name: '重新读取结果', exact: true }).click()
    await expect(page.locator('.core-run-result')).toContainText('运行完成')
    release!(); await completed
    await expect(page.locator('.core-run-result')).toContainText('运行完成')
    await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', original.result.runId)
    await expect(page.locator('.core-run-result')).toHaveAttribute('data-snapshot-hash', head.snapshots[0]!.hash)
    expect(posts).toHaveLength(0)
  } finally { release?.(); await page.context().close(); await host.stop() }
})
