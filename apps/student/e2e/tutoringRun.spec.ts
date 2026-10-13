import { test, expect } from '@playwright/test'
import { localState, serverHead } from './helpers'
import { fixedProject, selectRun, setRunScript } from './runHelpers'

/**
 * 主 Agent 接入两个面板的 onHelp 后统一执行：选原结果只开核对表单，不发送 help/run/sync。
 * 不约定未交付求助表单的标签，也不伪造 D-01 教学 Action→Job/Run 关系。
 * 实际发送/冻结问题/晚到回答边界由 02 接入后另补；本文件没有跳过这些缺口并称整票通过。
 */
test('运行控件改变后原结果的求助动作仍可用，选择本身没有写请求', async ({ page }) => {
  const head = await fixedProject(page, 'tutor-original-run'), snapshot = head.snapshots[0]!
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  const result = page.getByRole('region', { name: '固定快照结果', exact: true })
  await expect(result).toContainText('运行完成')
  const runId = await result.getAttribute('data-run-id')
  await page.getByRole('combobox', { name: 'Core 操作', exact: true }).selectOption('find')
  await page.getByRole('textbox', { name: '查找词', exact: true }).fill('different-controls')
  const before = await localState(page), writes: string[] = []
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()) })
  await expect(result.getByRole('button', { name: '就这次运行求助', exact: true })).toBeEnabled()
  await result.getByRole('button', { name: '就这次运行求助', exact: true }).click()
  expect(writes).toEqual([])
  expect((await localState(page)).commands).toEqual(before.commands)
  expect((await serverHead(page)).files).toEqual(head.files)
  expect(runId).toBeTruthy()
})

test('没有原参数且环境诊断不可回取时历史仍可选择求助，不自动重跑', async ({ page, browser }) => {
  const head = await fixedProject(page, 'tutor-run-no-parameters'), snapshot = head.snapshots[0]!
  await setRunScript(page, 'node_failed')
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect(page.getByRole('region', { name: '固定快照结果', exact: true })).toContainText('执行失败')
  const fresh = await browser.newContext()
  try {
    const other = await fresh.newPage()
    await other.goto(page.url())
    await expect(other.getByText('已冻结快照 v1')).toBeVisible()
    await other.getByRole('button', { name: 'Core 运行', exact: true }).click()
    await other.getByRole('button', { name: '历史运行与产物', exact: true }).click()
    const side = other.getByRole('region', { name: '运行 A', exact: true })
    await expect(side).toHaveAttribute('aria-busy', 'false')
    await expect(side).toContainText('历史运行参数不可回取')
    await expect(side).toContainText('诊断暂不可回取')
    await expect(side).toContainText('执行失败')
    const writes: string[] = []
    other.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()) })
    await side.getByRole('button', { name: '就这次运行求助', exact: true }).click()
    expect(writes).toEqual([])
    expect((await localState(other)).commands).toEqual([])
  } finally { await fresh.close() }
})

test('从同一 authority 的公开 Run/Job 构造引用，控件快照错配拒绝', async ({ page }) => {
  const head = await fixedProject(page, 'tutor-run-public-ref'), snapshot = head.snapshots[0]!
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  const result = page.getByRole('region', { name: '固定快照结果', exact: true })
  await expect(result).toContainText('运行完成')
  const runId = (await result.getAttribute('data-run-id'))!
  const checked = await page.evaluate(async ({ runId, snapshotId }) => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const read = async (path: string) => (await (await fetch(path, { headers })).json()).data
    const data = await read('/__i0prep/context')
    const run = await read(`/__i0prep/api/attempts/${encodeURIComponent(data.refs.attemptId)}/runs/${encodeURIComponent(runId)}`)
    const job = await read(`/__i0prep/api/jobs/${encodeURIComponent(run.jobId)}`)
    const context = { mode: 'preparation', userId: data.syntheticAccount.userId, courseId: data.syntheticAccount.courseId,
      assignmentId: data.refs.assignmentId, activityVersionId: data.refs.activityVersionId, attemptId: data.refs.attemptId,
      loadEpoch: 1, preparationEpoch: data.preparationEpoch, trustedRecoveryGeneration: data.recoveryGeneration }
    const { createRunHelpObjectRef } = await import('/src/workspace/tutoringRun.ts' as string)
    const objectRef = createRunHelpObjectRef(context, { runId, snapshotId }, job, run)
    let rejected = false
    try { createRunHelpObjectRef(context, { runId, snapshotId: 'current-controls' }, job, run) } catch { rejected = true }
    return { objectRef, rejected, attemptId: data.refs.attemptId }
  }, { runId, snapshotId: snapshot.snapshotId })
  expect(checked.objectRef).toEqual({ kind: 'run', attemptId: checked.attemptId, runId, snapshotId: snapshot.snapshotId })
  expect(checked.rejected).toBe(true)
})
