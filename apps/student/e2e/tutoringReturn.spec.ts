import { expect, test, type Page } from '@playwright/test'
import { confirmSave, create, edit, localState, newestSync, openFileMenu, serverHead, start } from './helpers'

// Actual reading/return, refresh and another tab's file lifecycle all use the current UI.
// Initial raw EOL data is seeded via the existing draft repository, never a return constructor.
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

test('实际打开资料后刷新：保留原引用，明确缺精确位置而不自动定位或写作品', async ({ page }) => {
  await start(page, 'tutor-example-refresh')
  await create(page); await edit(page, '// original first line\n// original second line 😀\n')
  await confirmSave(page, 1)
  const original = (await serverHead(page)).files[0]!
  const input = page.locator('.monaco-editor textarea').first()
  await input.focus(); await page.keyboard.press('ControlOrMeta+End')
  await exampleMessage(page)
  await page.getByRole('button', { name: '查看获准类似例子', exact: true }).click()
  await expect(page.getByTestId('tutoring-example')).toBeVisible()
  const before = await localState(page), writes = forbiddenWrites(page)
  await page.reload()
  await expect(page.locator('.cw')).toBeVisible()
  await expect(page.getByTestId('tutor-return-notice')).toContainText('精确位置未保留')
  await expect(page.getByTestId('tutor-return-origin')).toHaveAttribute('data-file-id', original.fileId)
  await expect(page.getByTestId('tutor-return-origin')).toContainText('main.c')
  await expect(page.getByTestId('tutor-return-origin')).toContainText('1')
  await expect(page.getByTestId('tutoring-example')).toHaveCount(0)
  const after = await localState(page)
  expect(after.drafts).toEqual(before.drafts)
  expect(after.commands).toEqual(before.commands)
  expect((await serverHead(page)).files).toEqual([original])
  expect(writes).toEqual([])
})

test('阅读期间另一标签回收并同名重建：明确返回只保留原引用，不定位新实例', async ({ page, context }) => {
  await start(page, 'tutor-example-rebuilt')
  await create(page); await edit(page, '// original instance 😀\n')
  await confirmSave(page, 1)
  const original = (await serverHead(page)).files[0]!
  await exampleMessage(page)
  await page.getByRole('button', { name: '查看获准类似例子', exact: true }).click()
  await expect(page.getByTestId('tutoring-example')).toBeVisible()
  const other = await context.newPage()
  try {
    await other.goto(page.url())
    await expect(other.locator('.view-lines')).toContainText('original instance')
    await openFileMenu(other)
    await other.locator('[data-fileid] button[aria-label="回收 main.c"]').click()
    await confirmSave(other, 2)
    await openFileMenu(other)
    await other.getByRole('menuitem', { name: '新建文件', exact: true }).click()
    await other.getByRole('textbox', { name: '新文件名' }).fill('main.c')
    await other.getByRole('textbox', { name: '新文件名' }).press('Enter')
    await edit(other, '// rebuilt instance 😀\n')
    await confirmSave(other, 3)
    const authoritative = await serverHead(other)
    const rebuilt = authoritative.files.find(file => file.lifecycle === 'active')!
    expect(rebuilt.fileId).not.toBe(original.fileId)
    expect(authoritative.files.find(file => file.fileId === original.fileId)).toMatchObject({ lifecycle: 'recycled', text: original.text })
    // Read the authoritative head without replacing the original reading context/anchor.
    await page.getByRole('button', { name: '任务信息', exact: true }).click()
    const controls = page.getByTestId('tutoring-controls')
    await expect(controls.getByRole('button', { name: '重读学习控制', exact: true })).toBeEnabled()
    await controls.getByRole('button', { name: '重读学习控制', exact: true }).click()
    await expect(controls.getByTestId('limited-check-state')).toHaveAttribute('data-state', 'not-limited')
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await expect(page.getByTestId('tutoring-example')).toBeVisible()
    const before = await localState(page), writes = forbiddenWrites(page)
    await page.getByTestId('tutoring-example').getByRole('button', { name: '返回原作品', exact: true }).click()
    await expect(page.getByTestId('tutor-return-notice')).toContainText(/原文件|原实例|原位置/)
    await expect(page.getByTestId('tutor-return-origin')).toHaveAttribute('data-file-id', original.fileId)
    await expect(page.getByTestId('tutor-return-origin')).not.toHaveAttribute('data-file-id', rebuilt.fileId)
    expect((await localState(page)).drafts).toEqual(before.drafts)
    expect((await localState(page)).commands).toEqual(before.commands)
    expect((await serverHead(page)).files).toEqual(authoritative.files)
    expect(writes).toEqual([])
  } finally { await other.close() }
})

test('未确认作品命令跨只读资料返回保持原字节，混合EOL/非BMP/折叠/滚动及undo/redo分支保留', async ({ page }) => {
  await start(page, 'tutor-example-pending-original')
  await create(page)
  await expect.poll(async () => (await localState(page)).drafts.length).toBe(1)
  const raw = '\ufeffint folded(void) {\r\n  // 中文😀\r\n  return 0;\r\n}\r'
    + Array.from({ length: 65 }, (_, i) => `// line ${i}`).join('\n') + '\n// tail 😀'
  // Monaco normalizes inserted EOL; seed the isolated raw initial draft through the existing repository.
  const seeded = await page.evaluate(async text => {
    const { idbDraftRepository } = await import('/src/workspace/draftDb.ts' as string)
    const { confirmationRepository } = await import('/src/workspace/confirmationDb.ts' as string)
    const scenarioId = new URLSearchParams(location.search).get('scenario')!
    const data = (await (await fetch('/__i0prep/context', { headers: { 'x-i0prep-scenario': scenarioId } })).json()).data
    const draft = (await confirmationRepository.read({ mode: 'preparation', userId: data.syntheticAccount.userId,
      courseId: data.syntheticAccount.courseId, assignmentId: data.refs.assignmentId, activityVersionId: data.refs.activityVersionId,
      attemptId: data.refs.attemptId, preparationEpoch: data.preparationEpoch, trustedRecoveryGeneration: data.recoveryGeneration,
      scenarioId })).drafts[0]
    return idbDraftRepository.saveDraft({ ...draft, text }, draft.draftRevision)
  }, raw)
  expect(seeded.ok).toBe(true)
  await page.reload()
  await expect(page.locator('.view-lines')).toContainText('中文😀')
  await exampleMessage(page)
  await page.getByRole('button', { name: '收起辅导', exact: true }).click()
  const input = page.locator('.monaco-editor textarea').first()
  await input.focus(); await page.keyboard.press('ControlOrMeta+Home')
  const fold = page.locator('.monaco-editor .codicon-folding-expanded').first()
  await expect(fold).toBeAttached(); await fold.hover(); await fold.click()
  await expect(page.locator('.monaco-editor .codicon-folding-collapsed')).toHaveCount(1)
  await input.focus(); await page.keyboard.press('ControlOrMeta+End')
  await edit(page, ' // pending suffix 😀')
  await expect.poll(async () => (await localState(page)).drafts[0]!.text).toBe(raw + ' // pending suffix 😀')
  await page.route('**/api/attempts/*/sync', async route => { await route.fetch(); await route.abort('failed') })
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.getByRole('button', { name: '重试上次保存', exact: true })).toBeVisible()
  const before = await localState(page), pending = newestSync(before)
  expect(pending.state).toBe('pending')
  expect(JSON.parse(pending.wireJson).operations[0].text).toBe(raw + ' // pending suffix 😀')
  const position = (await page.locator('.cw-status').innerText()).match(/行 \d+，列 \d+/)?.[0]
  const visibleLines = await page.locator('.view-lines .view-line').allTextContents()
  expect(position).toBeTruthy()
  await page.getByRole('button', { name: '就项目求助', exact: true }).click()
  const writes = forbiddenWrites(page)
  await page.getByRole('button', { name: '查看获准类似例子', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('tutoring-example')).toBeVisible()
  await page.getByTestId('tutoring-example').getByRole('button', { name: '返回原作品', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('tutoring-example')).toHaveCount(0)
  await expect(page.locator('.cw-status')).toContainText(position!)
  await expect.poll(() => page.locator('.view-lines .view-line').allTextContents()).toEqual(visibleLines)
  expect((await localState(page)).drafts).toEqual(before.drafts)
  expect((await localState(page)).commands).toEqual(before.commands)
  expect(newestSync(await localState(page))).toEqual(pending)
  expect(writes).toEqual([])
  await page.getByRole('button', { name: '收起辅导', exact: true }).click()
  // Follow the actual rendered editor's undo groups, then require byte-exact raw storage agreement.
  // One Monaco undo may cover several content events; raw history cannot lag behind the visible model.
  await input.focus()
  const tail = page.locator('.view-lines .view-line').last()
  const tailText = async () => (await tail.textContent())!.replace(/\u00a0/g, ' ')
  const originalTail = '// tail 😀'
  const restoreTail = async (direction: 'undo' | 'redo', target: string) => {
    let rendered = await tailText()
    for (let step = 0; step < ' // pending suffix 😀'.length && rendered !== target; step++) {
      await page.keyboard.press(direction === 'undo' ? 'ControlOrMeta+z' : 'ControlOrMeta+Shift+z')
      await expect.poll(tailText).not.toBe(rendered)
      const next = await tailText()
      expect(next.startsWith(originalTail)).toBe(true)
      expect(direction === 'undo' ? rendered.startsWith(next) : next.startsWith(rendered)).toBe(true)
      // Every actual native group must agree with raw storage, including unchanged BOM/mixed EOL.
      await expect.poll(async () => (await localState(page)).drafts[0]!.text)
        .toBe(raw + next.slice(originalTail.length))
      rendered = next
    }
    expect(rendered).toBe(target)
  }
  await restoreTail('undo', originalTail)
  await expect.poll(async () => (await localState(page)).drafts[0]!.text).toBe(raw)
  expect(newestSync(await localState(page))).toEqual(pending)
  await restoreTail('redo', originalTail + ' // pending suffix 😀')
  expect(newestSync(await localState(page))).toEqual(pending)
  await restoreTail('undo', originalTail)
  const branch = ' // new branch 😀'
  await page.keyboard.insertText(branch)
  await expect.poll(async () => (await localState(page)).drafts[0]!.text).toBe(raw + branch)
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await expect(tail).toHaveText(originalTail + branch)
  await expect.poll(async () => (await localState(page)).drafts[0]!.text).toBe(raw + branch)
  expect(newestSync(await localState(page))).toEqual(pending)
  expect(writes).toEqual([])
  await page.keyboard.press('ControlOrMeta+Home')
  await expect(page.locator('.monaco-editor .codicon-folding-collapsed')).toHaveCount(1)
  await expect(page.locator('.view-lines')).not.toContainText('中文😀')
  await page.unroute('**/api/attempts/*/sync')
})
