import { clickWorkspaceAction } from './workspaceControls'
import { test, expect } from '@playwright/test'
import { confirmSave, edit, localState, serverHead } from './helpers'
import { fixedProject, selectRun, setRunScript } from './runHelpers'

/**
 * 原结果选择、发送、继续编辑及另一运行全部走当前页面；来源核实际 D-01 公开投影。
 * 保留最后的独立公开引用规则检查，但它不替代前面的真实 DOM/请求链。
 */
test('原运行求助后继续编辑并启动另一Run，旧回答仍保留原Run/快照且不自动重跑', async ({ page }) => {
  const head = await fixedProject(page, 'tutor-original-run'), snapshot = head.snapshots[0]!
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  const result = page.getByRole('region', { name: '固定快照结果', exact: true })
  await expect(result).toContainText('运行完成')
  const runId = await result.getAttribute('data-run-id')
  await page.getByRole('combobox', { name: 'Core 操作', exact: true }).selectOption('find')
  await page.getByRole('textbox', { name: '查找词', exact: true }).fill('different-controls')
  const before = await localState(page), writes: string[] = []
  const helpBodies:Array<{objectRef:unknown}>=[]
  page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()) })
  page.on('request', request => {if(request.method()==='POST'&&request.url().endsWith('/help'))helpBodies.push(JSON.parse(request.postData()!))})
  await expect(result.getByRole('button', { name: '就这次运行求助', exact: true })).toBeEnabled()
  await result.getByRole('button', { name: '就这次运行求助', exact: true }).click()
  expect(writes).toEqual([])
  expect((await localState(page)).commands).toEqual(before.commands)
  expect((await serverHead(page)).files).toEqual(head.files)
  expect(runId).toBeTruthy()
  await expect(page.getByTestId('tutor-object')).toContainText(runId!)
  await page.getByRole('textbox',{name:'就这个任务提问'}).fill('核查这次原运行，保留其原快照。')
  await page.getByRole('button',{name:'发送辅导问题'}).click()
  await expect.poll(()=>helpBodies.length).toBe(1)
  expect(helpBodies[0]!.objectRef).toEqual({kind:'run',attemptId:head.attempt.attemptId,runId,snapshotId:snapshot.snapshotId})
  await expect(page.getByTestId('tutor-message')).toHaveCount(1)
  await expect(page.getByTestId('tutor-source')).toContainText(`原运行 ${runId}`)
  await expect(page.getByTestId('tutor-source')).toContainText(`原快照 ${snapshot.snapshotId}`)
  expect(writes.some(url=>/\/(runs|sync|snapshots)$/.test(url))).toBe(false)
  const actionId = await page.getByTestId('tutor-message').getAttribute('data-action-id')
  const originalSource = (await page.getByTestId('tutor-source').textContent())!

  await page.getByRole('button', { name: '收起辅导', exact: true }).click()
  await page.getByRole('button', { name: '返回编辑', exact: true }).click()
  await page.locator('.cw-filetab-main', { hasText: 'main.c' }).click()
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press('ControlOrMeta+End')
  await edit(page, '// revised after original help 😀')
  await expect(page.locator('.ws-flow')).toContainText('1 个文件未确认')
  await clickWorkspaceAction(page, '就项目求助')
  await expect(page.getByTestId('tutor-source')).toHaveText(originalSource)
  await expect(page.getByTestId('tutor-message')).toHaveAttribute('data-action-id', actionId!)
  expect(writes.some(url=>/\/(runs|sync|snapshots)$/.test(url))).toBe(false)

  await page.getByRole('button', { name: '收起辅导', exact: true }).click()
  await confirmSave(page, 2)
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.getByText('已冻结快照 v2', { exact: true })).toBeVisible()
  const updated = await serverHead(page)
  const nextSnapshot = updated.snapshots.find(item => item.workspaceRevision === 2)!
  expect(nextSnapshot.snapshotId).not.toBe(snapshot.snapshotId)
  await selectRun(page, nextSnapshot.snapshotId, nextSnapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('combobox', { name: 'Core 操作', exact: true }).selectOption('stats')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  await expect.poll(async () => {
    const id = await result.getAttribute('data-run-id')
    return !!id && id !== runId
  }).toBe(true)
  await expect(result).toContainText('运行完成')
  const nextRunId = await result.getAttribute('data-run-id')
  expect(nextRunId).toBeTruthy(); expect(nextRunId).not.toBe(runId)
  await clickWorkspaceAction(page, '就项目求助')
  await expect(page.getByTestId('tutor-source')).toHaveText(originalSource)
  await expect(page.getByTestId('tutor-source')).not.toContainText(nextRunId!)
  await expect(page.getByTestId('tutor-source')).not.toContainText(nextSnapshot.snapshotId)
  await expect(page.getByTestId('tutor-message')).toHaveAttribute('data-action-id', actionId!)
  expect(helpBodies).toHaveLength(1)
  expect(writes.filter(url => /\/runs$/.test(url))).toHaveLength(1)
  expect(writes.filter(url => /\/sync$/.test(url))).toHaveLength(1)
  expect(writes.filter(url => /\/snapshots$/.test(url))).toHaveLength(1)
})

test('原运行回答的HTTP页晚到，学生已改稿并完成另一Run仍只显示原来源', async ({ page }) => {
  const head = await fixedProject(page, 'tutor-late-original-run'), snapshot = head.snapshots[0]!
  await selectRun(page, snapshot.snapshotId, snapshot.files.find(f => f.path === 'main.c')!.fileId, '')
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  const result = page.getByRole('region', { name: '固定快照结果', exact: true })
  await expect(result).toContainText('运行完成')
  const runId = (await result.getAttribute('data-run-id'))!
  let release!: () => void, arrived!: () => void, held = false
  const waiting = new Promise<void>(resolve => { release = resolve })
  const ready = new Promise<void>(resolve => { arrived = resolve })
  await page.route('**/api/attempts/*/events?*', async route => {
    const response = await route.fetch(), envelope = await response.json()
    if (!held && envelope.data.events.some((event: { payload?: { basis?: { objectRef?: { runId?: string } } } }) =>
      event.payload?.basis?.objectRef?.runId === runId)) {
      held = true; arrived(); await waiting
    }
    await route.fulfill({ response })
  })
  try {
    await result.getByRole('button', { name: '就这次运行求助', exact: true }).click()
    await page.getByRole('textbox', { name: '就这个任务提问' }).fill('请只核查原运行，传输晚到也保留来源。')
    await page.getByRole('button', { name: '发送辅导问题', exact: true }).click()
    await ready
    await expect(page.getByTestId('tutor-message')).toHaveCount(0)
    await page.getByRole('button', { name: '收起辅导', exact: true }).click()
    await page.getByRole('button', { name: '返回编辑', exact: true }).click()
    await page.locator('.cw-filetab-main', { hasText: 'main.c' }).click()
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press('ControlOrMeta+End')
    await edit(page, '// changed before delivery 😀')
    await confirmSave(page, 2)
    await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
    await expect(page.getByText('已冻结快照 v2', { exact: true })).toBeVisible()
    const next = (await serverHead(page)).snapshots.find(item => item.workspaceRevision === 2)!
    await selectRun(page, next.snapshotId, next.files.find(f => f.path === 'main.c')!.fileId, '')
    await page.getByRole('button', { name: '运行此快照', exact: true }).click()
    await expect.poll(async () => {
      const id = await result.getAttribute('data-run-id')
      return !!id && id !== runId
    }).toBe(true)
    await expect(result).toContainText('运行完成')
    const nextRunId = (await result.getAttribute('data-run-id'))!
    expect(nextRunId).not.toBe(runId)
    release()
    await clickWorkspaceAction(page, '就项目求助')
    await expect(page.getByTestId('tutor-message')).toHaveCount(1)
    await expect(page.getByTestId('tutor-source')).toContainText(`原运行 ${runId}`)
    await expect(page.getByTestId('tutor-source')).toContainText(`原快照 ${snapshot.snapshotId}`)
    await expect(page.getByTestId('tutor-source')).not.toContainText(nextRunId)
    await expect(page.getByTestId('tutor-source')).not.toContainText(next.snapshotId)
  } finally { release(); await page.unroute('**/api/attempts/*/events?*') }
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
