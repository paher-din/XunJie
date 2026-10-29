import { clickWorkspaceAction } from './workspaceControls'
import { expect, test } from '@playwright/test'
import { confirmSave, create, edit, localState, openFileMenu, serverHead, setAttemptState, start, trackBusinessWrites, typeIn } from './helpers'
import { fixedProject, selectRun } from './runHelpers'

/**
 * I0_UI_07：全批收口补的「暂停 / 终态」状态闸回放。
 *
 * 05 已回放暂停下不能回收/恢复、仍可修改已有 active 文件（`fileHistory.spec.ts`）。本文件补 07
 * 验收清单里此前没有任何浏览器用例回放的三条：暂停下**不能新建文件**、暂停下**不能发起 Core 运行**、
 * `submitted` 与 `reviewed` 终态下编辑器只读且确认保存不可用。
 *
 * 断言落在可见状态与实际请求上：闸真的挡住 = 控件 disabled + 说明文案 + 零业务写请求离开浏览器。
 * 准备 fixture 的 `STATE_CONFLICT`（`prep/workspace.ts:222-223,322`）只是第二道防线，
 * 不用它替代客户端行为——所以这里不构造「绕过 UI 直接 POST」的用例。
 */

test('暂停时新建文件与 Core 运行都被挡住，已有 active 文件仍可编辑保存', async ({ page }) => {
  const head = await fixedProject(page, 'state-paused-guards')
  const snapshot = head.snapshots[0]!
  const entry = snapshot.files.find(f => f.path === 'main.c')!.fileId
  const input = snapshot.files.find(f => f.path === 'sample.txt')!.fileId

  // 先证明这条运行路径本来通：暂停前「运行此快照」可用，否则后面的 disabled 说明不了是状态闸生效。
  await selectRun(page, snapshot.snapshotId, entry, input)
  await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeEnabled()

  expect((await setAttemptState(page, 'paused')).status).toBe(200)
  const writes = trackBusinessWrites(page)
  await clickWorkspaceAction(page, '重新读取')
  await expect(page.locator('.cw-access')).toHaveAttribute('data-kind', 'paused')

  // 运行闸：重新选齐快照/入口/输入后仍然禁用，且没有运行 POST 离开浏览器。
  await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await page.getByRole('combobox', { name: '确认快照', exact: true }).selectOption(snapshot.snapshotId)
  await page.getByRole('combobox', { name: 'C 入口文件', exact: true }).selectOption(entry)
  await page.getByRole('checkbox', { name: 'sample.txt', exact: true }).check()
  const runButton = page.getByRole('button', { name: '运行此快照', exact: true })
  await expect(runButton).toBeDisabled()
  // 表单提交路径也要挡住：回车不能绕过 disabled 的提交按钮。
  await page.getByRole('combobox', { name: 'C 入口文件', exact: true }).focus()
  await page.keyboard.press('Enter')
  expect(writes.filter(w => w.endsWith('/runs'))).toEqual([])

  // 新建闸：文件列表里的入口禁用并给出原因，不是静默消失。
  // 「设计」标签不会关掉运行面板——运行区是叠在中心工具区上的，得用它自己的「返回编辑」。
  await page.getByRole('button', { name: '返回编辑', exact: true }).click()
  await expect(page.locator('.cw-access')).toHaveAttribute('data-kind', 'paused')
  await openFileMenu(page)
  const createEntry = page.locator('.cw-filemenu').getByRole('menuitem', { name: '新建文件', exact: true })
  await expect(createEntry).toBeDisabled()
  await expect(createEntry).toHaveAttribute('title', /暂停|不允许|状态|不能/)
  await expect(page.locator('.cw-access')).toContainText('不能新建')
  expect(writes).toEqual([])

  // 暂停只收走「新建/回收/恢复/运行」，不收走已有 active 文件的 update。
  // fixedProject 最后编辑的是 sample.txt，所以先显式切到 main.c，断言才落在确定的文件上。
  await page.keyboard.press('Escape')
  await page.getByRole('tab', { name: 'main.c', exact: true }).click()
  await edit(page, 'paused-still-editable\n')
  await confirmSave(page, 2)
  const headAfter = await serverHead(page)
  expect(headAfter.attempt.workspaceRevision).toBe(2)
  expect(headAfter.attempt.status).toBe('paused')
  expect(headAfter.files.find(f => f.path === 'main.c')!.text).toContain('paused-still-editable')
  // 暂停下没有新实例被创建：仍然只有原来那两个 active 文件。
  expect(headAfter.files.filter(f => f.lifecycle === 'active').map(f => f.path).sort()).toEqual(['main.c', 'sample.txt'])
})

test('submitted 与 reviewed 终态：编辑器只读、确认保存与新建都不可用、运行不可发起', async ({ page }) => {
  await start(page, 'state-terminal-readonly')
  await create(page, 'main.c')
  await edit(page, 'int main(void) { return 0; }\n')
  await confirmSave(page, 1)
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.getByText('已冻结快照 v1')).toBeVisible()

  for (const status of ['submitted', 'reviewed'] as const) {
    expect((await setAttemptState(page, status)).status).toBe(200)
    const writes = trackBusinessWrites(page)
    await clickWorkspaceAction(page, '重新读取')
    await expect(page.locator('.cw-access')).toHaveAttribute('data-kind', 'read-only')
    await expect(page.locator('.cw-access')).toContainText('终态')

    // 终态下键盘输入不改动本机草稿：只读不是「显示成只读但还在写库」。
    const before = (await localState(page)).drafts.map(d => d.text)
    await typeIn(page, 'TERMINAL-MUST-NOT-LAND')
    await page.waitForTimeout(300)
    expect((await localState(page)).drafts.map(d => d.text)).toEqual(before)
    await expect(page.locator('.monaco-editor')).not.toContainText('TERMINAL-MUST-NOT-LAND')

    const save = page.getByRole('button', { name: '确认保存', exact: true })
    await expect(save).toBeDisabled()
    await expect(save).toHaveAttribute('title', /.+/)
    await expect(page.getByRole('button', { name: '冻结确认作品', exact: true })).toBeDisabled()

    await openFileMenu(page)
    await expect(page.locator('[data-fileid] button[aria-label="回收 main.c"]')).toBeDisabled()
    await expect(page.locator('.cw-filemenu').getByRole('menuitem', { name: '新建文件', exact: true })).toBeDisabled()
    await page.keyboard.press('Escape')

    // 终态同样不能发起运行；重读后服务端版本没有被任何写命令推进。
    await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
    await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
    await page.getByRole('button', { name: '返回编辑', exact: true }).click()

    expect(writes).toEqual([])
    expect((await serverHead(page)).attempt.workspaceRevision).toBe(1)
    expect((await serverHead(page)).attempt.status).toBe(status)
  }
})
