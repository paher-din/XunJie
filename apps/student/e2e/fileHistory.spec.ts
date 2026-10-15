import { clickWorkspaceAction, openWorkspaceMenu } from './workspaceControls'
import { expect, test, type Page } from '@playwright/test'
import {
  confirmSave, create, edit, localState, openFileMenu, sceneUrl, serverHead, setAttemptState, start, typeIn,
  type LocalSummary, trackBusinessWrites as trackWrites,
} from './helpers'

/**
 * I0_UI_05：文件实例的回收/恢复与只读版本比较。
 *
 * 覆盖的验收点：
 * 1. 回收 → 同名重建 → 恢复被占用：占用时只拒绝并说明，不覆盖、不改名、双方都还在；学生显式回收
 *    占用者之后，用一个**新的**确认保存把旧实例恢复回原 fileId 与原文。
 * 2. 暂停与终态下回收/恢复不可操作（准备 authority 由 dev-only /__i0prep/attempt-state 切状态）。
 * 3. 只读版本比较：快照 × 快照、草稿 × 当前确认作品；打开/切换/离开全程零写请求。
 * 4. 同名重建在比较里不合并：同一路径、不同 fileId 必须是两行（左旧右新），不按路径撮合。
 * 5. 混合 EOL/BOM/非 BMP 正文进入 diff 不改摘要、不改正文。
 * 6. 键盘打开、切换、离开比较。
 *
 * 全部走同一个 dev:prep 进程与真实浏览器（Monaco、IndexedDB、HTTP）；「另一处」一律由 fixture
 * 的合成接口充当，不在测试里造业务响应。
 */

/** 本机实例 ID（clientFileKey 最后一段）；同名实例只能靠身份区分。 */
function localIdOf(state: LocalSummary, serverFileId: string): string {
  const instance = state.instances.find(row => row.fileId === serverFileId)
  if (!instance?.clientFileKey) throw new Error(`本机没有 ${serverFileId} 的实例映射`)
  return instance.clientFileKey.split('\u0000').at(-1)!
}

/** 工作区已有文件时，「新建文件」入口在文件列表里，先打开浮层再点。 */
async function createFile(page: Page, name: string) {
  await openFileMenu(page)
  // 列表里的入口带 role=menuitem（不是 button）：按可访问角色取，别按元素类型猜
  await page.locator('.cw-filemenu').getByRole('menuitem', { name: '新建文件', exact: true }).click()
  const input = page.getByRole('textbox', { name: '新文件名' })
  await input.fill(name)
  await input.press('Enter')
  await expect(page.locator('.monaco-editor textarea').first()).toBeAttached()
}

async function freezeSnapshot(page: Page, revision: number) {
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.getByText(`已冻结快照 v${revision}`)).toBeVisible()
  await expect(page.getByRole('button', { name: '冻结确认作品', exact: true })).toBeEnabled()
}

test('首次读取首项已回收时打开活动文件，保留已存回收视图且全回收时如实提示', async ({ page, browser }) => {
  await start(page, 'file-initial-active')
  await create(page, 'scratch.txt')
  await edit(page, 'retained scratch\n')
  await confirmSave(page, 1)
  await createFile(page, 'main.c')
  const original = 'int main(void){return 0;}\n'
  await edit(page, original)
  await confirmSave(page, 2)
  await openFileMenu(page)
  await page.getByRole('menuitem', { name: 'scratch.txt', exact: true }).click()
  await openFileMenu(page)
  await page.getByRole('menuitem', { name: '回收 scratch.txt', exact: true }).click()
  await confirmSave(page, 3)
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
  const head = await serverHead(page)
  expect(head.files.map(file => ({ path: file.path, lifecycle: file.lifecycle }))).toEqual([
    { path: 'scratch.txt', lifecycle: 'recycled' }, { path: 'main.c', lifecycle: 'active' },
  ])

  // 独立浏览器没有UI/草稿/实例记录。通过正常登录与公开GET读同一authority，不能灌UI元数据。
  const fresh = await browser.newContext()
  try {
    const reader = await fresh.newPage()
    const writes = trackWrites(reader)
    await reader.goto(page.url())
    await expect(reader.locator('.ws-flow')).toContainText('确认作品 v3 · 与草稿一致')
    await expect(reader.locator('.cw-status-path')).toHaveText('main.c')
    await expect(reader.locator('.cw .monaco-editor textarea').first()).toBeVisible()
    await expect(reader.locator('.cw .view-lines')).toContainText('int main(void)')
    await reader.reload()
    await expect(reader.locator('.cw-status-path')).toHaveText('main.c')
    await expect(reader.locator('.cw .view-lines')).toContainText('int main(void)')
    expect(writes.filter(write => !write.endsWith('/sessions'))).toEqual([])
    expect((await serverHead(reader)).files).toEqual(head.files)
  } finally { await fresh.close() }

  // 原浏览器明确选择scratch后回收，已存的active/open视图即使是回收实例也不能被默认策略覆盖。
  await page.reload()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v3 · 与草稿一致')
  await expect(page.locator('.cw-status-path')).toHaveText('scratch.txt')
  await expect(page.locator('.cw-empty')).toContainText('这个实例已回收，草稿保留。')
  await expect(page.locator('.cw .monaco-editor textarea')).toHaveCount(0)

  await openFileMenu(page)
  await page.getByRole('menuitem', { name: 'main.c', exact: true }).click()
  await openFileMenu(page)
  await page.getByRole('menuitem', { name: '回收 main.c', exact: true }).click()
  await confirmSave(page, 4)
  const allRecycled = await browser.newContext()
  try {
    const reader = await allRecycled.newPage()
    const writes = trackWrites(reader)
    await reader.goto(page.url())
    await expect(reader.locator('.ws-flow')).toContainText('确认作品 v4 · 与草稿一致')
    await expect(reader.locator('.cw-status-path')).toHaveText('scratch.txt')
    await expect(reader.locator('.cw-empty')).toContainText('这个实例已回收，草稿保留。')
    await expect(reader.locator('.cw .monaco-editor textarea')).toHaveCount(0)
    expect(writes.filter(write => !write.endsWith('/sessions'))).toEqual([])
    const final = await serverHead(reader)
    expect(final.files.map(file => file.lifecycle)).toEqual(['recycled', 'recycled'])
    expect(final.files.find(file => file.path === 'main.c')!.text).toBe(original)
    expect(final.files.find(file => file.path === 'scratch.txt')!.text).toBe('retained scratch\n')
  } finally { await allRecycled.close() }
})

test('回收→同名重建→恢复被占用→显式回收占用者后用新命令恢复：双方保留、身份与正文各自独立', async ({ page }) => {
  const original = 'int main(void){return 0;}\n'
  await start(page, 'file-lifecycle')
  await create(page)
  await edit(page, original)
  await confirmSave(page, 1)
  const first = await serverHead(page)
  const oldId = first.files[0]!.fileId
  const oldHash = first.files[0]!.contentHash

  // 学生明确回收：本机先标「待确认回收」，确认保存后服务端 lifecycle 变 recycled，正文与身份不变
  await openFileMenu(page)
  await page.locator('[data-fileid] button[aria-label="回收 main.c"]').click()
  await expect(page.locator('.cw-tag-pending').first()).toHaveText('待确认回收')
  await confirmSave(page, 2)
  let head = await serverHead(page)
  expect(head.attempt.workspaceRevision).toBe(2)
  expect(head.files).toHaveLength(1)
  expect(head.files[0]!.fileId).toBe(oldId)
  expect(head.files[0]!.lifecycle).toBe('recycled')
  expect(head.files[0]!.text).toBe(original)
  expect(head.files[0]!.contentHash).toBe(oldHash)

  // 同路径重建：得到**新实例**，旧实例的原文件引用不受影响
  await createFile(page, 'main.c')
  await typeIn(page, 'int main(void){return 1;}\n')
  await confirmSave(page, 3)
  head = await serverHead(page)
  expect(head.files).toHaveLength(2)
  const rebuilt = head.files.find(file => file.path === 'main.c' && file.lifecycle === 'active')!
  expect(rebuilt.fileId).not.toBe(oldId)

  // 恢复被占用：只拒绝并说明，不覆盖、不擅自 rename，服务端两个实例都还在
  await openFileMenu(page)
  const restore = (fileId: string) =>
    page.locator(`.cw-filerecycled [data-fileid="${fileId}"] button[aria-label="恢复 main.c"]`)
  const oldLocalId = localIdOf(await localState(page), oldId)
  await expect(restore(oldLocalId)).toBeDisabled()
  await expect(restore(oldLocalId)).toHaveAttribute('title', /占用/)
  await expect(page.locator('.cw-lifecycle-blocked')).toContainText('占用')
  head = await serverHead(page)
  expect(head.attempt.workspaceRevision).toBe(3)
  expect(head.files.map(file => file.lifecycle).sort()).toEqual(['active', 'recycled'])

  // 学生显式处理当前占用：先回收新实例并确认
  const rebuiltLocalId = localIdOf(await localState(page), rebuilt.fileId)
  await page.locator(`[data-fileid="${rebuiltLocalId}"] button[aria-label="回收 main.c"]`).click()
  await confirmSave(page, 4)
  head = await serverHead(page)
  expect(head.files.every(file => file.lifecycle === 'recycled')).toBe(true)

  // 路径空出后用新的确认保存恢复旧实例：同一 fileId 回到 active，正文与摘要都是它原来那一份
  await openFileMenu(page)
  await expect(restore(oldLocalId)).toBeEnabled()
  await restore(oldLocalId).click()
  await confirmSave(page, 5)
  head = await serverHead(page)
  const restored = head.files.find(file => file.fileId === oldId)!
  expect(restored.lifecycle).toBe('active')
  expect(restored.text).toBe(original)
  expect(restored.contentHash).toBe(oldHash)
  expect(head.files.find(file => file.fileId === rebuilt.fileId)!.lifecycle).toBe('recycled')

  // 恢复回来的实例可以正常打开：正文是它自己那一份，不是同名新实例的
  await openFileMenu(page)
  await page.locator(`.cw-filemenu [data-fileid="${oldLocalId}"] .cw-filemenu-open`).click()
  await expect(page.locator('.view-lines').first()).toContainText('return 0;')
  expect(await page.locator('.view-lines').first().textContent()).not.toContain('return 1;')
})

test('暂停与终态下不能回收或恢复，暂停仍可修改已有文件', async ({ page }) => {
  await start(page, 'file-lifecycle-locked')
  await create(page)
  await edit(page, 'a\n')
  await confirmSave(page, 1)

  expect((await setAttemptState(page, 'paused')).status).toBe(200)
  await clickWorkspaceAction(page, '重新读取')
  await expect(page.locator('.cw-access')).toContainText('暂停')
  await openFileMenu(page)
  await expect(page.locator('[data-fileid] button[aria-label="回收 main.c"]')).toBeDisabled()
  await expect(page.locator('[data-fileid] button[aria-label="回收 main.c"]'))
    .toHaveAttribute('title', /暂停|不允许|状态/)

  // 暂停期间仍可继续修改已有 active 文件并确认保存
  await page.keyboard.press('Escape')
  await edit(page, 'b\n')
  await confirmSave(page, 2)

  // 终态：作品只读，回收/恢复同样不可操作
  expect((await setAttemptState(page, 'submitted')).status).toBe(200)
  await clickWorkspaceAction(page, '重新读取')
  await expect(page.locator('.cw-access')).toContainText('终态')
  await openFileMenu(page)
  await expect(page.locator('[data-fileid] button[aria-label="回收 main.c"]')).toBeDisabled()
  expect((await serverHead(page)).attempt.workspaceRevision).toBe(2)
})

test('只读版本比较：快照×快照与草稿×确认作品，打开/切换/离开零写请求，键盘可达', async ({ page }) => {
  await start(page, 'file-version-compare')
  await create(page)
  await edit(page, 'first\n')
  await confirmSave(page, 1)
  await freezeSnapshot(page, 1)
  await edit(page, 'second\n')
  await confirmSave(page, 2)
  await freezeSnapshot(page, 2)

  const writes = trackWrites(page)
  await openWorkspaceMenu(page, '版本与恢复')
  const entry = page.getByRole('button', { name: '比较版本', exact: true })
  await entry.focus()
  await page.keyboard.press('Enter')

  // 默认比最近两版快照：只读容器、按身份一行、两侧版本读数与正文差异都在
  const compare = page.locator(".ws-compare[data-source='snapshots']")
  await expect(compare).toBeVisible()
  await expect(compare.locator('.ws-compare-note')).toContainText('只读')
  const file = compare.locator('.ws-compare-file')
  await expect(file).toHaveCount(1)
  await expect(file.locator('.ws-compare-file-path')).toHaveText('main.c')
  await expect(file.locator('.ws-compare-file-id')).toContainText('实例 ')
  await expect(file.locator('.ws-compare-file-versions')).toContainText('v1')
  const diff = file.locator('.ws-compare-diff')
  await expect(diff.locator('.view-lines').first()).toContainText('first')
  await expect(diff.locator('.view-lines').last()).toContainText('second')

  // 键盘切换左侧来源：焦点落在「切换左侧来源」上按 Enter，快照 v1 → 快照 v2（全程不点鼠标）
  const cycleLeft = compare.getByRole('button', { name: '切换左侧来源' })
  await cycleLeft.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator('.ws-compare-file-versions')).toContainText('左侧 v2')

  // 切到「快照 × 本机草稿」：比较族变成 draft-confirmed，右侧是学生当前写的东西
  await compare.getByLabel('右侧来源', { exact: true }).selectOption({ label: '本机草稿（当前）' })
  await expect(page.locator(".ws-compare[data-source='draft-confirmed']")).toBeVisible()
  await expect(page.locator('.ws-compare-diff .view-lines').last()).toContainText('second')

  // 原生下拉也要能被键盘聚焦（直接选版本交给原生控件，不在测试里模拟平台行为）
  const current = page.locator('.ws-compare')
  await current.getByLabel('右侧来源', { exact: true }).focus()
  await expect(current.getByLabel('右侧来源', { exact: true })).toBeFocused()

  // Esc 离开：回到编辑器，草稿与正文原样
  await page.keyboard.press('Escape')
  await expect(page.locator('.ws-compare')).toHaveCount(0)
  await expect(page.locator('.view-lines')).toContainText('second')
  expect(writes).toEqual([])
})

test('同名重建在比较里是两行而不是按路径合并，且单侧状态明确', async ({ page }) => {
  await start(page, 'file-version-identity')
  await create(page)
  await edit(page, 'old\n')
  await confirmSave(page, 1)
  await freezeSnapshot(page, 1)

  const beforeRecycle = await serverHead(page)
  const oldId = beforeRecycle.files[0]!.fileId

  await openFileMenu(page)
  await page.locator('[data-fileid] button[aria-label="回收 main.c"]').click()
  await confirmSave(page, 2)
  await createFile(page, 'main.c')
  await typeIn(page, 'new\n')
  await confirmSave(page, 3)

  const ids = await localState(page)
  const oldLocalId = localIdOf(ids, oldId)
  const newLocalId = localIdOf(ids, (await serverHead(page)).files.find(file => file.path === 'main.c' && file.lifecycle === 'active')!.fileId)

  const writes = trackWrites(page)
  await clickWorkspaceAction(page, '比较版本')
  const compare = page.locator(".ws-compare[data-source='draft-confirmed']")
  await expect(compare).toBeVisible()
  await compare.getByLabel('右侧来源', { exact: true }).selectOption({ label: '当前确认作品 v3' })

  // 回收状态看得见：旧实例在两侧都有（回收不是删除），右侧当前确认作品标它已回收
  await expect(compare.locator('.ws-compare-file-lifecycle')).toHaveCount(1)
  await expect(compare.locator('.ws-compare-file-lifecycle')).toHaveText('右侧已回收')

  // 同一路径两个实例 → 两行、两个身份；旧引用那一行两侧都是它自己的旧正文，没被新实例顶替
  await expect(compare.locator('.ws-compare-file[data-path="main.c"]')).toHaveCount(2)
  const rowIds = await compare.locator('.ws-compare-file').evaluateAll(rows => rows.map(row => row.getAttribute('data-fileid')))
  expect(new Set(rowIds).size).toBe(2)
  const oldRow = compare.locator(`.ws-compare-file[data-fileid="${oldLocalId}"]`)
  await expect(oldRow.locator('.ws-compare-diff .view-lines').first()).toContainText('old')
  await expect(oldRow.locator('.ws-compare-diff .view-lines').last()).toContainText('old')
  // 新实例只在右侧出现：单侧状态明确，不当成旧引用的改动
  const newRow = compare.locator(`.ws-compare-file[data-fileid="${newLocalId}"]`)
  await expect(newRow.locator('.ws-compare-body[data-missing="left"]')).toHaveCount(1)
  await expect(newRow.locator('.ws-compare-read')).toContainText('new')
  await expect(compare.locator('.ws-compare-missing')).toHaveCount(1)
  expect(writes).toEqual([])
})

test('暂停期间发出的回收被整批拒绝：如实显示未生效、不重放、不丢意图，刷新后不再当成未决', async ({ page }) => {
  await start(page, 'file-lifecycle-state-conflict')
  await create(page)
  await edit(page, 'v1\n')
  await confirmSave(page, 1)

  // 学生明确回收（此时还是可编辑），随后分配被暂停——本页不重新读取，客户端仍以为在编辑
  await openFileMenu(page)
  await page.locator('[data-fileid] button[aria-label="回收 main.c"]').click()
  await expect(page.locator('.cw-tag-pending').first()).toHaveText('待确认回收')
  expect((await setAttemptState(page, 'paused')).status).toBe(200)

  const posts = trackWrites(page)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  // 服务端整批拒绝（暂停只允许 update）：学生看到「没有生效」，不是「保存成功」
  await expect(page.locator('.ws-run-state')).toHaveText('上一次操作没有生效')
  await expect(page.locator('.ws-head-run [role=alert]')).toContainText('没有生效')
  // 作品没有被推进，意图也还在（草稿与生命周期意图都不丢）
  expect((await serverHead(page)).attempt.workspaceRevision).toBe(1)
  await expect(page.locator('.cw-lifecycle-pending')).toHaveText('待确认回收')

  // 被拒绝的原命令已退役为历史事实：刷新（同一准备场景）不再把它发布成未决状态
  await page.reload()
  await page.locator('.ts-badge').waitFor()
  await expect(page.getByRole('button', { name: '开始 Attempt', exact: true })).toHaveCount(0)
  // 运行簇只在阶段不是 ready 时才有节点：刷新后不应再出现「上一次操作没有生效」这一态
  await expect(page.locator('.ws-run-state')).toHaveCount(0)
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
  await expect(page.locator('.cw-lifecycle-pending')).toHaveText('待确认回收')
  await openFileMenu(page)
  await expect(page.locator('.cw-tag-pending').first()).toHaveText('待确认回收')
  const state = await localState(page)
  const rejected = state.commands.filter(c => c.kind === 'workspace.sync').sort((a, b) => b.createdAt - a.createdAt)[0]!
  expect(rejected.rejected?.code).toBe('STATE_CONFLICT')
  expect(rejected.state).toBe('historical')
  expect(posts.filter(p => p.includes('/sync'))).toHaveLength(1)

  // 暂停解除后重新读取：按钮重新可用，学生明确把意图撤回（不自动改键重发旧命令）
  expect((await setAttemptState(page, 'active')).status).toBe(200)
  await clickWorkspaceAction(page, '重新读取')
  await openFileMenu(page)
  await page.locator('.cw-filerecycled [data-fileid] button[aria-label="恢复 main.c"]').click()
  await expect(page.locator('.cw-tag-pending')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
  expect(posts.filter(p => p.includes('/sync'))).toHaveLength(1)
  expect((await serverHead(page)).attempt.workspaceRevision).toBe(1)
})

test('另一标签回收并确认后，本标签重新读取以权威为准，不把别处刚生效的回收显示成待确认恢复', async ({ page, context }) => {
  const url = sceneUrl('file-lifecycle-two-tabs')
  await page.goto(url)
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  await create(page)
  await edit(page, 'shared\n')
  await confirmSave(page, 1)

  // B 标签在同一个准备场景里明确回收并确认：服务端 v2、该实例 recycled
  const other = await context.newPage()
  await other.goto(url)
  await expect(other.locator('.view-lines')).toContainText('shared')
  await openFileMenu(other)
  await other.locator('[data-fileid] button[aria-label="回收 main.c"]').click()
  await confirmSave(other, 2)

  // A 标签重新读取：权威值已变，必须以权威为准。若把本机残留的旧意图顶回去，界面会显示
  // 「待确认恢复」，学生再点一次确认保存就会静默撤销 B 的操作。
  const writes = trackWrites(page)
  await clickWorkspaceAction(page, '重新读取')
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v2 · 与草稿一致')
  await openFileMenu(page)
  await expect(page.locator('.cw-filerecycled-row')).toHaveCount(1)
  await expect(page.locator('.cw-tag-pending')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
  // 重新读取会重新建立准备会话（POST /sessions），那不是业务写命令；这里要守的是没有新的 sync。
  expect(writes.filter(w => w.endsWith('/sync'))).toEqual([])
})

test('混合 EOL/BOM/非 BMP 正文进入只读比较不改摘要、不改正文', async ({ page }) => {
  await start(page, 'file-version-bytes')
  await create(page)
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
  const raw = '\uFEFF中文😀\r\nsecond\rthird\n\n'
  await seedDraft(page, raw)
  await page.reload()
  await expect(page.locator('.view-lines')).toContainText('中文😀')
  await confirmSave(page, 1)
  await freezeSnapshot(page, 1)
  await seedDraft(page, `${raw}// tail\r\n`)
  await page.reload()
  await confirmSave(page, 2)
  await freezeSnapshot(page, 2)

  const before = await localState(page)
  const headBefore = await serverHead(page)
  const writes = trackWrites(page)
  await clickWorkspaceAction(page, '比较版本')
  const compare = page.locator(".ws-compare[data-source='snapshots']")
  await expect(compare).toBeVisible()
  const diff = compare.locator('.ws-compare-diff')
  await expect(diff.locator('.view-lines').first()).toContainText('中文😀')
  await expect(diff.locator('.view-lines').last()).toContainText('// tail')

  // 进入比较不改摘要、不改正文、不产生写请求
  const after = await localState(page)
  const headAfter = await serverHead(page)
  expect(after.workspace!.files.map(file => file.contentHash)).toEqual(before.workspace!.files.map(file => file.contentHash))
  expect(after.workspace!.files.map(file => file.text)).toEqual([`${raw}// tail\r\n`])
  expect(headAfter.files.map(file => file.contentHash)).toEqual(headBefore.files.map(file => file.contentHash))
  expect(headAfter.snapshots.map(snapshot => snapshot.files.map(file => file.contentHash)))
    .toEqual(headBefore.snapshots.map(snapshot => snapshot.files.map(file => file.contentHash)))
  expect(writes).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.locator('.ws-compare')).toHaveCount(0)
})

/** 把原始正文直接写进本机草稿（Monaco 无法可靠输入 CR/CRLF/BOM），再让页面重读。 */
async function seedDraft(page: Page, text: string) {
  const seeded = await page.evaluate(async value => {
    const db = await import('/src/workspace/draftDb.ts' as string)
    const confirmation = await import('/src/workspace/confirmationDb.ts' as string)
    const scenarioId = new URLSearchParams(location.search).get('scenario')!
    const data = (await (await fetch('/__i0prep/context', { headers: { 'x-i0prep-scenario': scenarioId } })).json()).data
    const context = { mode: 'preparation', userId: data.syntheticAccount.userId, attemptId: data.refs.attemptId, scenarioId }
    const draft = (await confirmation.confirmationRepository.read(context)).drafts[0]
    return db.idbDraftRepository.saveDraft({ ...draft, text: value }, draft.draftRevision)
  }, text)
  expect(seeded.ok).toBe(true)
}
