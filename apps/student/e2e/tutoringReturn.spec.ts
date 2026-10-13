import { expect, test, type Page } from '@playwright/test'
import { create, edit, localState, serverHead, start } from './helpers'

// Prepared for the main Agent's onExample + center overlay wiring. NOT run by the 05 worker.
// Same dev authority and explicitly synthetic resource, no vendor/real student operations.
async function exampleMessage(page: Page) {
  await page.getByRole('button', { name: '就项目求助', exact: true }).click()
  await page.getByRole('textbox', { name: '就这个任务提问' }).fill('给一个相邻边界测试例子，我会返回原作品自己试。')
  await page.getByRole('button', { name: '发送辅导问题', exact: true }).click()
  await expect(page.getByTestId('tutor-facts')).toContainText('展示：本机已发生')
}
function forbiddenWrites(page: Page) {
  const writes: string[] = []
  page.on('request', r => {
    const path = new URL(r.url()).pathname
    // received/displayed may finish asynchronously; opening/returning must never acknowledge.
    if (r.method() !== 'GET' && (/\/(sync|snapshots|help|runs|controls|cancel)$/.test(path) ||
      (path.endsWith('/receipts') && r.postData()?.includes('acknowledged')))) writes.push(`${r.method()} ${path}`)
  })
  return writes
}

test('键盘看合成相邻例子→返回同一编辑器视图，草稿/undo保持且没有业务副作用', async ({ page }) => {
  await start(page, 'tutor-example-return')
  await create(page)
  await edit(page, '// original 😀\nint main(void) { return 0; }\n')
  const input = page.locator('.monaco-editor textarea').first()
  await input.focus()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('// local suffix')
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
  const before = await localState(page), head = await serverHead(page)
  const position = (await page.locator('.cw-status').innerText()).match(/行 \d+，列 \d+/)?.[0]
  expect(position).toBeTruthy()
  await page.locator('.monaco-editor').first().evaluate(el => el.setAttribute('data-original-reader-test', 'retained'))
  await exampleMessage(page)
  const writes = forbiddenWrites(page)
  const open = page.getByRole('button', { name: '查看获准类似例子', exact: true })
  await open.focus(); await page.keyboard.press('Enter')
  const reading = page.getByTestId('tutoring-example')
  await expect(reading).toBeVisible()
  await expect(reading.getByTestId('tutoring-example-source')).toContainText('共同设计的相邻例子')
  await expect(reading).toContainText('29、30、31')
  await expect(page.locator('.monaco-editor[data-original-reader-test="retained"]')).toHaveCount(1)
  await reading.getByRole('button', { name: '返回原作品', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(reading).toHaveCount(0)
  await expect(page.locator('.cw-status')).toContainText(position!)
  expect((await localState(page)).drafts).toEqual(before.drafts)
  expect((await serverHead(page)).files).toEqual(head.files)
  expect(writes).toEqual([])
  await expect(page.getByTestId('tutor-facts')).toContainText('回应：未回应')
  await input.focus(); await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await localState(page)).drafts[0]?.text.includes('// local suffix')).toBe(false)
})

test('从实际公开投影读取例子并验证同名重建/代际变化不返回旧位置', async ({ page }) => {
  await start(page, 'tutor-example-resource')
  const outcome = await page.evaluate(async () => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const get = async (path: string) => (await (await fetch(path, { headers })).json()).data
    const prep = await get('/__i0prep/context')
    const activity = await get(`/__i0prep/api/activities/${encodeURIComponent(prep.refs.activityVersionId)}?audience=student`)
    const resourceId = 'prep-resource-adjacent-example-01'
    const index = activity.content.materials.findIndex((m: { resourceVersionId?: string }) => m.resourceVersionId === resourceId)
    const view = await get(`/__i0prep/api/resources/${resourceId}`)
    const logic = await import('/src/workspace/tutoringReturn.ts' as string)
    const resolved = logic.resolveTutoringResource(resourceId, activity,
      [{ index, projectedStatus: 'available', state: { kind: 'loaded', view } }], 'preparation')
    const context = { mode: 'preparation', userId: prep.syntheticAccount.userId, assignmentId: prep.refs.assignmentId,
      activityVersionId: prep.refs.activityVersionId, attemptId: prep.refs.attemptId, loadEpoch: 1,
      preparationEpoch: prep.preparationEpoch, trustedRecoveryGeneration: prep.recoveryGeneration }
    const file = { fileId: 'original-instance', path: 'main.c', lifecycle: 'active', documentVersion: null,
      contentHash: null, draftText: '\ufeff// 😀\r\nint x;\r// tail\n' }
    const anchor = logic.captureTutoringReturn(context, file, { cursor: { line: 2, column: 4 }, scrollTop: 200 })
    return { resolved, rebuilt: logic.validateTutoringReturn(anchor, context, [{ ...file, fileId: 'rebuilt-instance' }]),
      changed: logic.validateTutoringReturn(anchor, { ...context, trustedRecoveryGeneration: 'new' }, [file]),
      missing: logic.resolveTutoringResource('not-authorized', activity, [], 'preparation') }
  })
  expect(outcome.resolved).toMatchObject({ kind: 'ready', nature: 'synthetic-example' })
  expect(outcome.rebuilt).toMatchObject({ kind: 'unavailable', reason: 'file-missing' })
  expect(outcome.changed).toMatchObject({ kind: 'unavailable', reason: 'context-changed' })
  expect(outcome.missing).toMatchObject({ kind: 'unavailable', reason: 'not-readable' })
})
