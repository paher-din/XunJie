import { expect, type Page } from '@playwright/test'
import { start, create, edit, openFileMenu, confirmSave, serverHead } from './helpers'

export async function fixedProject(page: Page, name: string) {
  await start(page, name)
  await create(page, 'main.c'); await edit(page, 'int main(void) { return 0; }\n')
  await openFileMenu(page)
  await page.getByRole('menuitem', { name: '新建文件', exact: true }).click()
  await page.getByRole('textbox', { name: '新文件名' }).fill('sample.txt')
  await page.getByRole('textbox', { name: '新文件名' }).press('Enter')
  await edit(page, 'one two one\n')
  await confirmSave(page, 1)
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.getByText('已冻结快照 v1')).toBeVisible()
  return serverHead(page)
}
export async function selectRun(page: Page, snapshotId: string, entry: string, input: string) {
  await expect(page.getByRole('button', { name: 'Core 运行', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await page.getByRole('combobox', { name: '确认快照', exact: true }).selectOption(snapshotId)
  await page.getByRole('combobox', { name: 'C 入口文件', exact: true }).selectOption(entry)
  await page.getByRole('checkbox', { name: 'sample.txt', exact: true }).check()
  expect(await page.getByRole('checkbox', { name: 'sample.txt', exact: true }).isChecked()).toBe(true)
  return input
}
export async function setRunScript(page: Page, outcome: string) {
  return page.evaluate(async outcome => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const response = await fetch('/__i0prep/run-script', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken }, body: JSON.stringify({ outcome }) })
    return response.status
  }, outcome)
}

export async function recoverRunContext(page: Page) {
  return page.evaluate(async () => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const data = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const response = await fetch('/__i0prep/recover', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ attemptId: data.refs.attemptId, workspaceRevision: 1 }) })
    return { status: response.status, before: data.recoveryGeneration, after: (await response.json()).data.recoveryGeneration }
  })
}
