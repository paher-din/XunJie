import { expect, type Page } from '@playwright/test'

/** Follow the visible disclosure path; keep protocol and effect assertions in each scenario. */
export async function openWorkspaceMenu(page: Page, name: string) {
  const trigger = name === '会话' ? page.locator('.ts-badge button') : page.getByRole('button', { name, exact: true })
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
}

export async function clickWorkspaceAction(page: Page, name: string) {
  const action = page.getByRole('button', { name, exact: true })
  if (!await action.isVisible()) {
    const menu = name === '退出' ? '会话'
      : name === '比较版本' || name === '重新读取' ? '版本与恢复'
        : name === '核对 HDL 状态' ? '构建设置' : '求助'
    await openWorkspaceMenu(page, menu)
  }
  await action.click()
}
