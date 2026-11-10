import { expect, type Page } from '@playwright/test'

/** Choose through the visible component popup, including options rendered in a Portal. */
export async function selectFieldOption(page: Page, label: string, option: string | RegExp) {
  const trigger = page.getByRole('combobox', { name: label, exact: true })
  await trigger.click()
  await expect(trigger).toHaveAttribute('aria-controls', /.+/)
  const listId = await trigger.getAttribute('aria-controls')
  const list = page.locator(`[id="${listId}"]`)
  await list.getByRole('option', { name: option, exact: typeof option === 'string' }).click()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
}
