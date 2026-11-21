import { expect, type Page } from '@playwright/test'

/** Present the authenticated embedded school account without replacing its course APIs. */
export async function useEmbeddedSchoolFixture(page: Page, endpoint: string, loginName: string, password: string) {
  expect((await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status()).toBe(200)
  const context = await (await page.request.get(endpoint + '/api/learning/context')).json()
  const school = context.identities.find((item: { key: string }) => item.key === 'school')
  expect(school?.identity.kind).toBe('school')
  await page.route(endpoint + '/api/learning/context', async route => {
    const response = await route.fetch()
    if (!response.ok()) { await route.fulfill({ response }); return }
    const current = await response.json()
    const session = current.identities.find((item: { key: string }) => item.key === 'school')
    const account = current.account ?? (session && { key: 'school', accountName: loginName, schoolName: session.identity.name }) ?? null
    await route.fulfill({ response, json: { ...current, account } })
  })
}

/** Exercise the actual disclosure and its Escape/focus contract, including portalled controls. */
export async function openWorkspacePopover(page: Page, name: '文件' | '活动') {
  const trigger = page.getByRole('button', { name, exact: true })
  await expect(trigger).toBeVisible()
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  const panel = page.getByRole(name === '文件' ? 'dialog' : 'region', { name, exact: true })
  await expect(panel).toBeVisible()
  return panel
}

export async function closeWorkspacePopover(page: Page, name: '文件' | '活动') {
  const trigger = page.getByRole('button', { name, exact: true })
  // A successful activity navigation can unmount the entire workspace.
  if (!await trigger.isVisible() || await trigger.getAttribute('aria-expanded') !== 'true') return
  await page.keyboard.press('Escape')
  await expect(page.getByRole(name === '文件' ? 'dialog' : 'region', { name, exact: true })).toHaveCount(0)
  await expect(trigger).toBeFocused()
}

export async function createWorkFile(page: Page, name: string) {
  const files = await openWorkspacePopover(page, '文件')
  await files.getByRole('button', { name: '新建文件', exact: true }).click()
  await files.getByLabel('文件名', { exact: true }).fill(name)
  await files.getByRole('button', { name: '创建', exact: true }).click()
  await expect(files).toHaveCount(0)
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
}

export async function openWorkFileActions(page: Page, name: string) {
  const files = await openWorkspacePopover(page, '文件')
  await files.getByRole('button', { name: `管理 ${name}`, exact: true }).click()
  return files
}

export async function renameWorkFile(page: Page, previousName: string, name: string) {
  const files = await openWorkFileActions(page, previousName)
  await files.getByRole('button', { name: '重命名', exact: true }).click()
  await files.getByLabel('新名称', { exact: true }).fill(name)
  await files.getByRole('button', { name: '确认改名', exact: true }).click()
  await expect(files).toHaveCount(0)
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible()
}

export async function deleteWorkFile(page: Page, name: string) {
  const files = await openWorkFileActions(page, name)
  await files.getByRole('button', { name: '删除', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '删除文件', exact: true })
  await dialog.getByRole('button', { name: '删除文件', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

export async function clickActivityAction(page: Page, name: string) {
  const activity = await openWorkspacePopover(page, '活动')
  await activity.getByRole('button', { name, exact: true }).click()
  await closeWorkspacePopover(page, '活动')
}

export async function selectProductSpace(page: Page, name: string) {
  const category = name === '个人空间' ? '个人' : '学校'
  const tabs = page.getByRole('group', { name: '课程分类' })
  if (!await tabs.isVisible()) await page.getByRole('button', { name: '首页', exact: true }).click()
  await expect(tabs).toBeVisible()
  const tab = tabs.getByRole('button', { name: category, exact: true })
  await tab.click()
  await expect(tab).toHaveAttribute('aria-pressed', 'true')
  const schools = page.getByLabel('选择学校', { exact: true })
  if (category === '学校' && name !== '学校空间' && await schools.isVisible()) {
    await schools.selectOption({ label: name })
  }
}

export async function openCourseTasks(page: Page, name: string) {
  const course = page.locator('.course-region .course-tile').filter({ has: page.getByText(name, { exact: true }) })
  await expect(course).toBeVisible()
  await course.click()
  await expect(page.getByRole('button', { name: '全部课程', exact: true })).toBeVisible()
}

export function courseTaskCard(page: Page, name: string) {
  return page.locator('[data-course-selected="true"] button[aria-haspopup="dialog"]')
    .filter({ has: page.getByText(name, { exact: true }) })
}
