import { expect, test, type Page } from '@playwright/test'
import { confirmSave, create, edit, localState, openFileMenu, serverHead, start, trackBusinessWrites } from './helpers'

// 已批准 02 行为的补验：走实际 Monaco / 设置按钮与同源 IndexedDB，始终使用隔离合成场景。
const source = 'int folded(void) {\n  int inside = 3;\n  return inside;\n}\n'
  + Array.from({ length: 100 }, (_, i) => `// scroll marker ${i}`).join('\n') + '\nint tail = 7;'

async function selectAllInEditor(page: Page) {
  // Desktop Chrome 的 UA 可模拟 Windows；快捷键跟随浏览器里的 Monaco 平台，不跟随 runner 宿主。
  const modifier = await page.evaluate(() => navigator.userAgent.includes('Macintosh') ? 'Meta' : 'Control')
  await page.keyboard.press(`${modifier}+a`)
}

async function prepareFoldedEditor(page: Page, name: string) {
  await start(page, name)
  await create(page)
  const input = page.locator('.monaco-editor textarea').first()
  await input.focus()
  // 批量 insertText 会走逐字输入的自动缩进/括号补全；本例用真实系统粘贴建立精确正文。
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
  await page.evaluate(text => navigator.clipboard.writeText(text), source)
  await page.keyboard.press('ControlOrMeta+v')
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
  await expect.poll(async () => (await localState(page)).drafts[0].text).toBe(source)
  await selectAllInEditor(page)
  await page.keyboard.press('ArrowLeft')
  const expanded = page.locator('.monaco-editor .codicon-folding-expanded').first()
  await expect(expanded).toBeAttached()
  await expanded.hover()
  await expanded.click()
  await expect(page.locator('.monaco-editor .codicon-folding-collapsed')).toHaveCount(1)
  await input.focus()
  await selectAllInEditor(page)
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('.view-lines')).toContainText('int tail = 7;')
  const cursor = await page.locator('.cw-status').innerText()
  const position = cursor.match(/行 \d+，列 \d+/)?.[0]
  expect(position).toBeTruthy()
  const visible = await page.locator('.view-lines .view-line').allTextContents()
  const before = await localState(page)
  expect(before.drafts[0].text).toBe(source)
  return { position: position!, visible, before }
}

async function expectRestoredEditor(page: Page, saved: Awaited<ReturnType<typeof prepareFoldedEditor>>) {
  await expect(page.locator('.cw-status')).toContainText(saved.position)
  await expect(page.locator('.view-lines')).toContainText('int tail = 7;')
  await expect.poll(() => page.locator('.view-lines .view-line').allTextContents()).toEqual(saved.visible)
  expect((await localState(page)).drafts.find(d => d.text === source)).toBeTruthy()
  // 滚动回来核对折叠仍有效；观察与切换不能修改正文。
  await page.locator('.monaco-editor textarea').first().focus()
  await selectAllInEditor(page)
  await page.keyboard.press('ArrowLeft')
  await expect(page.locator('.monaco-editor .codicon-folding-collapsed')).toHaveCount(1)
  await expect(page.locator('.view-lines')).not.toContainText('int inside = 3;')
}

test('切换文件后保留折叠、光标、滚动与完整原文', async ({ page }) => {
  const saved = await prepareFoldedEditor(page, 'editor-fold-file')
  await openFileMenu(page)
  await page.getByRole('menuitem', { name: '新建文件', exact: true }).click()
  const input = page.getByRole('textbox', { name: '新文件名' })
  await input.fill('notes.txt')
  await input.press('Enter')
  await expect(page.locator('.cw-status-path')).toHaveText('notes.txt')
  await edit(page, 'another file')
  await page.locator('.cw-filetab-main', { hasText: 'main.c' }).click()
  await expectRestoredEditor(page, saved)
  expect((await localState(page)).drafts.some(d => d.text === 'another file')).toBe(true)
})

test('中心工具切换卸载再挂载后保留折叠与视图', async ({ page }) => {
  const saved = await prepareFoldedEditor(page, 'editor-fold-remount')
  await page.getByRole('tab', { name: '虚拟板', exact: true }).click()
  await expect(page.locator('.cw')).toHaveCount(0)
  await page.getByRole('tab', { name: '设计', exact: true }).click()
  await expectRestoredEditor(page, saved)
})

async function databaseRecords(page: Page) {
  return page.evaluate(() => new Promise<Record<string, unknown[]>>((resolve, reject) => {
    const request = indexedDB.open('xunjie-i0-workspace')
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result
      const stores = Array.from(db.objectStoreNames)
      const tx = db.transaction(stores, 'readonly')
      const records: Record<string, unknown[]> = {}
      for (const name of stores) {
        const all = tx.objectStore(name).getAll()
        all.onsuccess = () => { records[name] = all.result }
      }
      tx.oncomplete = () => { db.close(); resolve(records) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }))
}

for (const action of ['清除缓存', '重置布局'] as const) {
  test(`${action} 实际生效但保留草稿、确认记录、快照与原命令`, async ({ page }) => {
    await start(page, action === '清除缓存' ? 'editor-protection-cache' : 'editor-protection-layout')
    await create(page)
    await edit(page, 'int main(void) { return 0; }\n')
    await confirmSave(page, 1)
    await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
    await expect(page.getByText('已冻结快照 v1')).toBeVisible()
    await edit(page, '// local only\n')
    await expect(page.locator('.ws-flow')).toContainText('1 个文件未确认')
    const head = await serverHead(page)
    const local = await localState(page)
    const workspaceUrl = page.url()
    const writes = trackBusinessWrites(page)
    const settingsUrl = new URL(workspaceUrl)
    settingsUrl.hash = '/settings/privacy'
    await page.goto(settingsUrl.toString())
    await expect(page.getByRole('button', { name: action, exact: true })).toBeVisible()
    // 哨兵证明清理实际执行；不向业务库写入测试替身。
    await page.evaluate(() => {
      localStorage.setItem('i0-bv-cache', 'temporary')
      sessionStorage.setItem('i0-bv-session', 'temporary')
      localStorage.setItem('ws-layout:i0-bv', 'temporary')
      sessionStorage.setItem('ws-cards:i0-bv', 'temporary')
    })
    const before = await databaseRecords(page)
    expect(before.drafts.length).toBeGreaterThan(0)
    expect(before.metadata.length).toBeGreaterThan(0)
    expect(before.outbox.length).toBeGreaterThan(0)
    await page.getByRole('button', { name: action, exact: true }).click()
    await page.getByRole('button', { name: '确认', exact: true }).click()
    const cache = await page.evaluate(() => ({
      local: localStorage.getItem('i0-bv-cache'), session: sessionStorage.getItem('i0-bv-session'),
      layout: localStorage.getItem('ws-layout:i0-bv'), cards: sessionStorage.getItem('ws-cards:i0-bv'),
    }))
    expect(cache).toEqual(action === '清除缓存'
      ? { local: null, session: null, layout: 'temporary', cards: null }
      : { local: 'temporary', session: 'temporary', layout: null, cards: null })
    expect(await databaseRecords(page)).toEqual(before)
    // 清缓存按现有规则保留 ws- 布局键；移除仅用于本例的哨兵，避免非合法布局干扰恢复。
    await page.evaluate(() => {
      localStorage.removeItem('ws-layout:i0-bv')
      sessionStorage.removeItem('ws-cards:i0-bv')
    })
    await page.goto(workspaceUrl)
    await expect(page.locator('.view-lines')).toContainText('// local only')
    await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
    await expect(page.locator('.ws-flow')).toContainText('1 个文件未确认')
    await expect(page.getByText('已冻结快照 v1')).toBeVisible()
    await page.reload()
    await expect(page.locator('.view-lines')).toContainText('// local only')
    await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
    await expect(page.locator('.ws-flow')).toContainText('1 个文件未确认')
    const after = await localState(page)
    expect(after.workspace).toEqual(local.workspace)
    expect(after.drafts).toEqual(local.drafts)
    expect(after.instances).toEqual(local.instances)
    expect(after.commands).toEqual(local.commands)
    expect(await serverHead(page)).toEqual(head)
    expect(writes).toEqual([])
  })
}
