import { expect, test, type Locator, type Page } from '@playwright/test'
import { sceneUrl, serverHead } from './helpers'
import { setRunScript } from './runHelpers'

/**
 * UI-PREP-03：一条学生操作路径全程使用真实键盘导航。
 * 唯一程序定位焦点是初始「开始 Attempt」；后续通过 Tab / Shift+Tab 到达控件，
 * 或接受界面自己的焦点恢复。Ctrl+M 是 Monaco 已有的「Tab 移动焦点」命令。
 * 合成 authority 的另一处保存与 runner 状态仅用于构造版本冲突/停止确认；
 * 学生页面的每个业务命令仍由 Enter / Space 明确触发，不连接执行节点或模型。
 */
async function tabTo(page: Page, target: Locator, direction: 'Tab' | 'Shift+Tab' = 'Tab') {
  await expect(target).toBeVisible()
  await expect(target).toBeEnabled()
  for (let step = 0; step < 60; step++) {
    if (await target.evaluate(element => element === document.activeElement)) return
    await page.keyboard.press(direction)
  }
  // 不用 focus() 绕过不可达路径；失败时保留实际焦点，供定位 Tab 陷阱。
  const active = await page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    label: document.activeElement?.getAttribute('aria-label'),
    text: document.activeElement?.textContent?.slice(0, 100),
  }))
  await expect(target, `键盘未到达控件；当前焦点 ${JSON.stringify(active)}`).toBeFocused()
}

async function returnedFocus(editor: Locator, entry: Locator) {
  // 回到可继续编辑的正文或原操作入口均有意义；body/已卸载浮层不能算恢复。
  await expect.poll(async () =>
    await editor.evaluate(element => element === document.activeElement) ||
    await entry.evaluate(element => element === document.activeElement),
  { message: '离开只读视图后，应回到编辑器或原入口' }).toBe(true)
}

async function otherWriter(page: Page, text: string) {
  const refs = await page.evaluate(async () => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const context = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    return { headers, attemptId: context.refs.attemptId as string,
      generation: context.recoveryGeneration as string, csrf: session.csrfToken as string }
  })
  const head = await serverHead(page)
  const file = head.files.find(file => file.path === 'main.c')!
  // APIRequestContext 表示另一处公开写入，不把它误计为学生页面发出的命令。
  const response = await page.request.post(new URL(`/__i0prep/api/attempts/${refs.attemptId}/sync`, page.url()).href, {
    headers: { ...refs.headers, 'x-csrf-token': refs.csrf, 'Idempotency-Key': crypto.randomUUID() },
    data: { recoveryGeneration: refs.generation, expectedWorkspaceRevision: head.attempt.workspaceRevision,
      clientId: crypto.randomUUID(), clientSeq: 1,
      operations: [{ kind: 'update', fileId: file.fileId, baseVersion: file.documentVersion, text }] },
  })
  expect(response.status()).toBe(200)
}

test('真实 Tab 路径完成新建/切换/保存/比较/冲突选择/Core停止/返回，焦点与原作品保留', async ({ page }) => {
  test.setTimeout(120_000)
  const writes: Array<{ path: string; key: string | undefined; body: string }> = []
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && path.startsWith('/__i0prep/api/') &&
      /\/(attempts|sync|snapshots|runs|cancel)$/.test(path)) {
      writes.push({ path, key: request.headers()['idempotency-key'], body: request.postData()! })
    }
  })
  await page.goto(sceneUrl('keyboard-workflow'))
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  const start = page.getByRole('button', { name: '开始 Attempt', exact: true })
  await start.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.cw')).toBeVisible()

  await tabTo(page, page.getByRole('button', { name: '新建文件', exact: true }))
  await page.keyboard.press('Space')
  const name = page.getByRole('textbox', { name: '新文件名' })
  await expect(name).toBeFocused()
  await page.keyboard.insertText('main.c')
  await page.keyboard.press('Enter')
  const editor = page.locator('.cw .monaco-editor textarea').first()
  await expect(editor).toBeAttached()
  await tabTo(page, editor)
  await page.keyboard.press('ControlOrMeta+m')
  const initial = 'int main(void) { return 0; }\n'
  await page.keyboard.insertText(initial)
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')

  const files = page.locator('.cw-stripbtn')
  await tabTo(page, files, 'Shift+Tab')
  await page.keyboard.press('Enter')
  await tabTo(page, page.getByRole('menuitem', { name: '新建文件', exact: true }))
  await page.keyboard.press('Space')
  await expect(name).toBeFocused()
  await page.keyboard.insertText('sample.txt')
  await page.keyboard.press('Enter')
  await tabTo(page, editor)
  await page.keyboard.insertText('one two one\n')
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')

  const mainTab = page.getByRole('tab', { name: /^main\.c/ })
  await tabTo(page, mainTab, 'Shift+Tab')
  await page.keyboard.press('Enter')
  await expect(mainTab).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('.cw .view-lines')).toContainText('int main(void)')
  // 打开文件列表后确实 Tab 进入浮层，再 Escape；不能以触发器始终有焦点冒充恢复。
  await tabTo(page, files, 'Shift+Tab')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('menu', { name: '项目文件', exact: true })).toBeVisible()
  await tabTo(page, page.getByRole('menuitem', { name: /^main\.c/ }))
  await expect(page.getByRole('menuitem', { name: /^main\.c/ })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator('.cw-filemenu')).toHaveCount(0)
  await expect(files).toBeFocused()

  const save = page.getByRole('button', { name: '确认保存', exact: true })
  await tabTo(page, save, 'Shift+Tab')
  await page.keyboard.press('Space')
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')
  const freeze = page.getByRole('button', { name: '冻结确认作品', exact: true })
  await tabTo(page, freeze)
  await page.keyboard.press('Enter')
  await expect(page.getByText('已冻结快照 v1')).toBeVisible()
  const baseline = await serverHead(page)
  // The authority orders by file identity; generated IDs do not imply filename order.
  expect(baseline.files.map(file => ({ path: file.path, text: file.text })).sort((a, b) => a.path.localeCompare(b.path))).toEqual([
    { path: 'main.c', text: initial }, { path: 'sample.txt', text: 'one two one\n' },
  ])

  const versions = page.getByRole('button', { name: '版本与恢复', exact: true })
  await tabTo(page, versions)
  await page.keyboard.press('Enter')
  const compareEntry = page.getByRole('button', { name: '比较版本', exact: true })
  const beforeComparison = writes.length
  await tabTo(page, compareEntry)
  await page.keyboard.press('Space')
  const compare = page.locator('.ws-compare')
  await expect(compare).toBeVisible()
  await expect(compare.locator('.ws-compare-note')).toContainText('只读')
  const cycle = compare.getByRole('button', { name: '切换左侧来源' })
  await tabTo(page, cycle)
  await page.keyboard.press('Enter')
  await expect(compare.getByLabel('左侧来源', { exact: true })).toHaveValue('draft')
  await page.keyboard.press('Tab')
  await expect(compare.getByLabel('左侧来源', { exact: true })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(compare).toHaveCount(0)
  await expect(editor).toBeAttached()
  await returnedFocus(editor, versions)
  expect(writes).toHaveLength(beforeComparison)

  const mine = `${initial}// my revision\n`
  await tabTo(page, editor)
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.insertText(mine)
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
  await otherWriter(page, `${initial}// another writer\n`)
  await tabTo(page, save, 'Shift+Tab')
  await page.keyboard.press('Space')
  await expect(page.locator('.ws-head-run [role=alert]')).toContainText('草稿已保留')
  const rejected = writes.filter(write => write.path.endsWith('/sync'))[1]!
  expect(JSON.parse(rejected.body).expectedWorkspaceRevision).toBe(1)
  await tabTo(page, page.getByRole('button', { name: '比较双方正文', exact: true }))
  await page.keyboard.press('Enter')
  await expect(page.locator(".ws-compare[data-source='version-conflict']")).toBeVisible()
  await expect(compare.locator('[data-path="main.c"] .view-lines').first()).toContainText('my revision')
  await expect(compare.locator('[data-path="main.c"] .view-lines').last()).toContainText('another writer')
  const beforeChoice = writes.length
  await tabTo(page, compare.getByRole('button', { name: '保留本页正文', exact: true }))
  await page.keyboard.press('Space')
  await expect(compare).toHaveCount(0)
  await expect(page.locator('.cw .view-lines')).toContainText('my revision')
  expect(writes).toHaveLength(beforeChoice)
  await returnedFocus(editor, save)
  await tabTo(page, save, 'Shift+Tab')
  await page.keyboard.press('Enter')
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v3 · 与草稿一致')
  const syncs = writes.filter(write => write.path.endsWith('/sync'))
  expect(syncs).toHaveLength(3)
  expect(syncs[2]!.key).not.toBe(rejected.key)
  expect(JSON.parse(syncs[2]!.body).expectedWorkspaceRevision).toBe(2)
  expect(JSON.parse(syncs[2]!.body).operations[0].text).toBe(mine)

  await tabTo(page, freeze)
  await page.keyboard.press('Space')
  await expect(page.getByText('已冻结快照 v3')).toBeVisible()
  const head = await serverHead(page)
  const snapshot = head.snapshots.find(snapshot => snapshot.workspaceRevision === 3)!
  const entryFile = snapshot.files.find(file => file.path === 'main.c')!
  const inputFile = snapshot.files.find(file => file.path === 'sample.txt')!
  expect(entryFile.text).toBe(mine)
  expect(inputFile.text).toBe('one two one\n')
  await setRunScript(page, 'running')
  const runEntry = page.getByRole('button', { name: 'Core 运行', exact: true })
  await tabTo(page, runEntry)
  await page.keyboard.press('Enter')
  const panel = page.getByRole('region', { name: 'Core 运行与结果', exact: true })
  const snapshotSelect = panel.getByRole('combobox', { name: '确认快照', exact: true })
  await tabTo(page, snapshotSelect)
  await page.keyboard.press('End')
  await expect(snapshotSelect).toHaveValue(snapshot.snapshotId)
  await page.keyboard.press('Tab')
  const entrySelect = panel.getByRole('combobox', { name: 'C 入口文件', exact: true })
  await expect(entrySelect).toBeFocused()
  await page.keyboard.press('End')
  await expect(entrySelect).toHaveValue(entryFile.fileId)
  await page.keyboard.press('Tab')
  await expect(panel.getByRole('combobox', { name: 'Core 操作', exact: true })).toBeFocused()
  await tabTo(page, panel.getByRole('checkbox', { name: 'sample.txt', exact: true }))
  await page.keyboard.press('Space')
  await expect(panel.getByRole('checkbox', { name: 'sample.txt', exact: true })).toBeChecked()
  const runButton = panel.getByRole('button', { name: '运行此快照', exact: true })
  await tabTo(page, runButton)
  const received = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname.endsWith('/runs'))
  await page.keyboard.press('Enter')
  const created = (await (await received).json()).data.result as { runId: string; jobId: string }
  await expect(page.locator('.core-run-result')).toContainText('运行中')
  await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', created.runId)
  await expect(page.locator('.core-run-result')).toHaveAttribute('data-snapshot-id', snapshot.snapshotId)
  const runs = writes.filter(write => write.path.endsWith('/runs'))
  expect(runs).toHaveLength(1)
  expect(JSON.parse(runs[0]!.body)).toMatchObject({ snapshotId: snapshot.snapshotId,
    entryFileId: entryFile.fileId, input: { operation: 'stats', fileIds: [inputFile.fileId] } })

  await tabTo(page, panel.getByRole('button', { name: '停止此运行', exact: true }))
  await page.keyboard.press('Space')
  await expect(page.locator('.core-run-result')).toContainText('正在停止')
  await expect(runButton).toBeDisabled()
  const stops = writes.filter(write => write.path.endsWith('/cancel'))
  expect(stops).toHaveLength(1)
  expect(stops[0]!.path).toBe(`/__i0prep/api/jobs/${created.jobId}/cancel`)
  await setRunScript(page, 'cancelled')
  await tabTo(page, panel.getByRole('button', { name: '重新读取结果', exact: true }), 'Shift+Tab')
  await page.keyboard.press('Enter')
  await expect(page.locator('.core-run-result')).toContainText('已停止')
  await expect(page.locator('.core-run-result')).toHaveAttribute('data-run-id', created.runId)
  expect(writes.filter(write => write.path.endsWith('/runs'))).toHaveLength(1)

  const beforeReturn = writes.length
  await tabTo(page, panel.getByRole('button', { name: '返回编辑', exact: true }), 'Shift+Tab')
  await page.keyboard.press('Space')
  await expect(panel).toHaveCount(0)
  await expect(editor).toBeAttached()
  await returnedFocus(editor, runEntry)
  await tabTo(page, editor)
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.insertText('// continue editing')
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
  await expect(page.locator('.cw .view-lines')).toContainText('continue editing')
  expect(writes).toHaveLength(beforeReturn)
  const final = await serverHead(page)
  expect(final.files.find(file => file.path === 'main.c')!.text).toBe(mine)
  expect(final.files.find(file => file.path === 'sample.txt')!.text).toBe('one two one\n')
  expect(final.snapshots.find(fixed => fixed.snapshotId === snapshot.snapshotId)!.files).toEqual(snapshot.files)
})
