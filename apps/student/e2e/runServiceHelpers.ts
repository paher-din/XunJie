import { expect, type Page } from '@playwright/test'
import { create, edit, openFileMenu, confirmSave } from './helpers'
import { loginThroughForm, startSessionHost } from './sessionHost'
import type { WorkspaceHead } from '../src/workspace/workspaceContracts'

export type RunHost = Awaited<ReturnType<typeof startSessionHost>>
export interface RunCommand { commandKey: string; kind: string; state: string; wireJson: string;
  receipt?: { receiptId: string; result: { runId?: string; jobId?: string } } }
export async function runLocal(page: Page) {
  return page.evaluate(() => new Promise<{ commands: RunCommand[]; drafts: Array<{ text: string }> }>((resolve, reject) => {
    const request = indexedDB.open('xunjie-i0-workspace')
    request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('Existing workspace required')) }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction(['outbox', 'drafts'], 'readonly')
      const commands = tx.objectStore('outbox').getAll(), drafts = tx.objectStore('drafts').getAll()
      tx.oncomplete = () => { db.close(); resolve({ commands: commands.result, drafts: drafts.result }) }
      tx.onabort = () => { db.close(); reject(tx.error) }
    }
  }))
}
export async function actualHead(page: Page, host: RunHost, attemptId: string): Promise<WorkspaceHead> {
  const response = await page.context().request.get(`${host.base}/api/attempts/${attemptId}`)
  expect(response.status()).toBe(200)
  return (await response.json()).data
}
export async function realProject(page: Page, host: RunHost) {
  await page.goto(`${host.base}/#/task/${host.assignmentId}`)
  await expect(page.getByRole('heading', { name: '登录学习空间' })).toBeVisible()
  await loginThroughForm(page, 'student', host.password)
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  const created = page.waitForResponse(r => r.request().method() === 'POST' && /\/api\/assignments\/[^/]+\/attempts$/.test(r.url()))
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  const attemptId = String((await (await created).json()).data.result.attemptId)
  await expect(page.getByRole('button', { name: '新建文件', exact: true }).first()).toBeEnabled()
  await create(page, 'main.c'); await edit(page, 'int main(void) { return 0; }\n')
  await openFileMenu(page)
  await page.getByRole('menuitem', { name: '新建文件', exact: true }).click()
  await page.getByRole('textbox', { name: '新文件名' }).fill('sample.txt')
  await page.getByRole('textbox', { name: '新文件名' }).press('Enter')
  await edit(page, 'one two one\n')
  await confirmSave(page, 1)
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.getByText('已冻结快照 v1')).toBeVisible()
  return actualHead(page, host, attemptId)
}
export async function selectActualRun(page: Page, head: WorkspaceHead) {
  const snapshot = head.snapshots[0]!
  await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await page.getByRole('combobox', { name: '确认快照', exact: true }).selectOption(snapshot.snapshotId)
  await page.getByRole('combobox', { name: 'C 入口文件', exact: true }).selectOption(snapshot.files.find(f => f.path === 'main.c')!.fileId)
  await page.getByRole('checkbox', { name: 'sample.txt', exact: true }).check()
  return snapshot
}
export function trackRuns(page: Page) {
  const posts: Array<{ key: string; body: string; path: string }> = []
  page.on('request', r => {
    if (r.method() === 'POST' && /\/(runs|cancel)$/.test(r.url()))
      posts.push({ key: r.headers()['idempotency-key']!, body: r.postData()!, path: new URL(r.url()).pathname })
  })
  return posts
}
export async function acceptedRun(page: Page) {
  const accepted = page.waitForResponse(r => r.request().method() === 'POST' && /\/api\/attempts\/[^/]+\/runs$/.test(r.url()))
  await page.getByRole('button', { name: '运行此快照', exact: true }).click()
  const response = await accepted
  expect(response.status()).toBe(200)
  const receipt = (await response.json()).data
  return receipt as { receiptId: string; result: { runId: string; jobId: string } }
}
