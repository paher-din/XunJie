import { expect, type Page } from '@playwright/test'

/** Exercise the actual disclosure and its Escape/focus contract, including portalled controls. */
export async function openWorkspacePopover(page: Page, name: '文件' | '活动') {
  const trigger = page.getByRole('button', { name, exact: true })
  await expect(trigger).toBeVisible()
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  const panel = page.getByRole('region', { name, exact: true })
  await expect(panel).toBeVisible()
  return panel
}

export async function closeWorkspacePopover(page: Page, name: '文件' | '活动') {
  const trigger = page.getByRole('button', { name, exact: true })
  // A successful activity navigation can unmount the entire workspace.
  if (!await trigger.isVisible() || await trigger.getAttribute('aria-expanded') !== 'true') return
  await page.keyboard.press('Escape')
  await expect(page.getByRole('region', { name, exact: true })).toHaveCount(0)
  await expect(trigger).toBeFocused()
}

export async function createWorkFile(page: Page, name: string) {
  const files = await openWorkspacePopover(page, '文件')
  await files.getByLabel('文件名', { exact: true }).fill(name)
  await files.getByRole('button', { name: '新建文件', exact: true }).click()
  await closeWorkspacePopover(page, '文件')
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
}

export async function renameWorkFile(page: Page, name: string) {
  const files = await openWorkspacePopover(page, '文件')
  await files.getByLabel('新名称', { exact: true }).fill(name)
  await files.getByRole('button', { name: '重命名', exact: true }).click()
  await closeWorkspacePopover(page, '文件')
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
}

export async function deleteWorkFile(page: Page) {
  const files = await openWorkspacePopover(page, '文件')
  await files.getByRole('button', { name: '删除文件', exact: true }).click()
  await closeWorkspacePopover(page, '文件')
}

export async function clickActivityAction(page: Page, name: string) {
  const activity = await openWorkspacePopover(page, '活动')
  await activity.getByRole('button', { name, exact: true }).click()
  await closeWorkspacePopover(page, '活动')
}

export async function selectProductSpace(page: Page, name: string) {
  const back = page.getByRole('button', { name: '返回活动列表', exact: true })
  if (await back.isVisible()) {
    await back.click()
    await expect(back).toHaveCount(0)
  }
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true')
}

export async function openCourseTasks(page: Page, name: string) {
  await page.getByRole('button').filter({ has: page.getByRole('heading', { name, exact: true }) }).click()
  await expect(page.getByRole('button', { name: '全部课程', exact: true })).toBeVisible()
}
