import { clickWorkspaceAction } from './workspaceControls'
import { test, expect, type Locator, type Page, type Route } from '@playwright/test'
import { start, create, edit, localState } from './helpers'

// Fixed public 503 body from teaching/contracts/common/http.ts:errorDefinitions.
// Only failed HTTP delivery is replayed; all successful reads/writes use the same dev:prep authority.
const dependencyUnavailable = {
  code: 'DEPENDENCY_UNAVAILABLE',
  message: 'Required capability is unavailable.',
  retryable: false,
  recovery: 'Use the manual workflow while unavailable; check the original request before explicitly retrying.',
}
async function failPublicRead(route: Route) {
  await route.fulfill({ status: 503, json: { requestId: crypto.randomUUID(), error: dependencyUnavailable } })
}
interface OriginalHelp {
  key: string
  kind: string
  state: string
  question?: string
  wireJson: string
  error?: string
}
async function helpCommands(page: Page): Promise<OriginalHelp[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('xunjie-i0-workspace', 2)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const rows = await new Promise<Array<{ key: string; commands?: OriginalHelp[] }>>((resolve, reject) => {
        const request = db.transaction('metadata').objectStore('metadata').getAll()
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      return rows.filter(row => row.key.startsWith('tutor:ledger:')).flatMap(row => row.commands ?? []).filter(c => c.kind === 'help')
    } finally { db.close() }
  })
}
function technicalNotice(text: string): string[] {
  return ['GET /__i0prep/', 'POST /__i0prep/', 'HTTP 503', dependencyUnavailable.code,
    dependencyUnavailable.message, dependencyUnavailable.recovery].filter(value => text.includes(value))
}
async function visibleLeaks(pane: Locator, source: string): Promise<string[]> {
  return technicalNotice(await pane.innerText()).map(value => `${source}: ${value}`)
}

test('辅导events、历史与help公开失败只显示中文恢复提示，保留草稿/原命令且不自动新求助', async ({ page }) => {
  await start(page, 'tutor-public-failure-notice')
  await create(page)
  const source = 'int main(void) { return 0; } // 尚未确认的本机作品'
  await edit(page, source)
  const requests: Array<{ key: string; wireJson: string }> = []
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().endsWith('/help')) {
      requests.push({ key: request.headers()['idempotency-key']!, wireJson: request.postData()! })
    }
  })
  await clickWorkspaceAction(page, '就项目求助')
  const pane = page.getByTestId('tutoring-pane')
  const question = page.getByRole('textbox', { name: '就这个任务提问' })
  const originalQuestion = '帮我检查这个起点，我会自行修改和保存。'
  await question.fill(originalQuestion)
  const leaks: string[] = []

  const eventsPath = '**/__i0prep/api/attempts/*/events?*'
  await page.route(eventsPath, failPublicRead)
  await page.getByRole('button', { name: '重新读取辅导', exact: true }).click()
  await expect(pane).toContainText('辅导读取未完成')
  leaks.push(...await visibleLeaks(pane, 'events'))
  await expect(question).toHaveValue(originalQuestion)
  expect(requests).toEqual([])
  expect(await helpCommands(page)).toEqual([])
  await page.unroute(eventsPath)
  await page.getByRole('button', { name: '重新读取辅导', exact: true }).click()
  await expect(page.getByRole('button', { name: '发送辅导问题', exact: true })).toBeEnabled()

  const historyPath = '**/__i0prep/api/attempts/*/teaching-records'
  await page.route(historyPath, failPublicRead)
  await pane.locator('.tutor-history-details > summary').click()
  await page.getByRole('button', { name: '刷新教学历史', exact: true }).click()
  await expect(page.getByTestId('tutor-history')).toContainText('教学历史不可回取')
  leaks.push(...await visibleLeaks(pane, 'history'))
  await expect(question).toHaveValue(originalQuestion)
  expect(requests).toEqual([])
  await page.unroute(historyPath)
  await page.getByRole('button', { name: '刷新教学历史', exact: true }).click()
  await expect(page.getByTestId('tutor-history')).toContainText('暂无可回取的已展示或已明确回应内容')

  const helpPath = '**/__i0prep/api/attempts/*/help'
  await page.route(helpPath, failPublicRead)
  await page.getByRole('button', { name: '发送辅导问题', exact: true }).click()
  await expect(page.getByTestId('tutor-question-status')).toHaveText('服务未接纳')
  await expect(pane).toContainText('原问题保留')
  leaks.push(...await visibleLeaks(pane, 'help'))
  await expect(question).toHaveValue(originalQuestion)
  expect(requests).toHaveLength(1)
  const original = (await helpCommands(page))[0]!
  expect(original).toMatchObject({ kind: 'help', state: 'rejected', key: requests[0]!.key,
    wireJson: requests[0]!.wireJson, question: originalQuestion })
  expect((await localState(page)).drafts.some(draft => draft.text === source)).toBe(true)
  await page.unroute(helpPath)

  // Explicit reads and normal polling can recover state, but must never create or rewrite a help command.
  await page.getByRole('button', { name: '重新读取辅导', exact: true }).click()
  await expect(page.getByRole('button', { name: '发送辅导问题', exact: true })).toBeEnabled()
  expect(requests).toHaveLength(1)
  expect((await helpCommands(page)).map(({ key, wireJson, question, state }) => ({ key, wireJson, question, state })))
    .toEqual([{ key: original.key, wireJson: original.wireJson, question: originalQuestion, state: 'rejected' }])
  expect((await localState(page)).drafts.some(draft => draft.text === source)).toBe(true)
  expect(leaks, 'technical HTTP details must remain in diagnostics, not student recovery notices').toEqual([])
})
