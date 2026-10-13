import { test, expect, type Page } from '@playwright/test'
import { create, edit, start, sceneUrl, localState } from './helpers'

const panel = (page: Page) => page.getByTestId('tutoring-controls')
async function head(page: Page) {
  return page.evaluate(async () => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const context = (await (await fetch('/__i0prep/context', { headers })).json()).data
    return (await (await fetch(`/__i0prep/api/attempts/${context.refs.attemptId}`, { headers })).json()).data
  })
}
function requests(page: Page) {
  const posts: Array<{ key: string; body: string }> = []
  page.on('request', r => {
    if (r.method() === 'POST' && /\/attempts\/[^/]+\/controls$/.test(r.url())) {
      posts.push({ key: r.headers()['idempotency-key']!, body: r.postData()! })
    }
  })
  return posts
}
async function saveFile(page: Page, text = 'int main(void) { return 0; }\n') {
  await create(page); await edit(page, text)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
}

test('固定帮助政策和三个控制分别可查，默认提醒关闭，键盘操作不激活 ready', async ({ page }) => {
  const posts = requests(page)
  await page.goto(sceneUrl('controls-defaults'))
  await expect(panel(page)).toContainText('不提供整份可直接提交的答案')
  await expect(panel(page)).toContainText('限定检查的当前状态尚无公开依据')
  expect(posts).toHaveLength(0)
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  await expect(panel(page).getByRole('switch', { name: '里程碑提醒', exact: true })).toHaveAttribute('aria-checked', 'false')
  const before = await head(page)
  const capture = panel(page).getByRole('switch', { name: '过程采集', exact: true })
  await capture.focus(); await page.keyboard.press('Space')
  await expect(capture).toHaveAttribute('aria-checked', 'false')
  await expect(panel(page)).toContainText('控制已确认')
  const reminder = panel(page).getByRole('switch', { name: '里程碑提醒', exact: true })
  await reminder.focus(); await page.keyboard.press('Enter')
  await expect(reminder).toHaveAttribute('aria-checked', 'true')
  const after = await head(page)
  expect(after.attempt.status).toBe(before.attempt.status)
  expect(after.attempt.decisionEpoch).toBe(before.attempt.decisionEpoch)
  expect(after.attempt.captureRevision).toBe(before.attempt.captureRevision + 1)
  expect(JSON.parse(posts[0]!.body).control).toEqual({ kind: 'capture', value: false })
  expect(JSON.parse(posts[1]!.body).control).toEqual({ kind: 'reminders', value: true })
})

test('关闭采集仍确认作品；恢复不追认暂停期间的旧过程', async ({ page }) => {
  await start(page, 'controls-capture-save'); await saveFile(page)
  const before = await head(page)
  await panel(page).getByRole('switch', { name: '过程采集', exact: true }).click()
  await expect(panel(page).getByRole('switch', { name: '过程采集', exact: true })).toHaveAttribute('aria-checked', 'false')
  await expect(panel(page)).toContainText('属于功能数据')
  await edit(page, '// paused capture save\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v2')
  expect((await localState(page)).workspace!.files[0]!.text).toContain('paused capture save')
  await panel(page).getByRole('switch', { name: '过程采集', exact: true }).click()
  await expect(panel(page).getByRole('switch', { name: '过程采集', exact: true })).toHaveAttribute('aria-checked', 'true')
  // Synthetic stale process arrives through the original sync HTTP, not a fabricated UI coverage fact.
  const result = await page.evaluate(async oldCaptureRevision => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const c = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const h = (await (await fetch(`/__i0prep/api/attempts/${c.refs.attemptId}`, { headers })).json()).data
    const file = h.files[0]
    const response = await fetch(`/__i0prep/api/attempts/${c.refs.attemptId}/sync`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ recoveryGeneration: c.recoveryGeneration, expectedWorkspaceRevision: h.attempt.workspaceRevision,
        clientId: 'stale-process-control-test', clientSeq: 1, process: { captureRevision: oldCaptureRevision },
        operations: [{ kind: 'update', fileId: file.fileId, baseVersion: file.documentVersion, text: file.text }] }) })
    return { status: response.status, data: (await response.json()).data }
  }, before.attempt.captureRevision)
  expect(result.status).toBe(200)
  expect(result.data.result.process).toEqual({ status: 'not_collected', reason: 'stale_capture_revision' })
})

test('暂停尝试保留已有文件保存，个人恢复不改变采集或提醒', async ({ page }) => {
  await start(page, 'controls-pause-save'); await saveFile(page)
  const before = await head(page)
  await panel(page).getByRole('button', { name: '暂停尝试', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: '恢复尝试', exact: true })).toBeEnabled()
  await expect(page.getByRole('button', { name: '新建文件', exact: true }).first()).toBeDisabled()
  await edit(page, '// save while paused\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v2')
  expect((await head(page)).attempt.status).toBe('paused')
  await panel(page).getByRole('button', { name: '恢复尝试', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: '暂停尝试', exact: true })).toBeEnabled()
  const after = await head(page)
  expect(after.attempt.collecting).toBe(before.attempt.collecting)
  expect(after.attempt.reminders).toBe(before.attempt.reminders)
  expect(after.attempt.decisionEpoch).toBe(before.attempt.decisionEpoch + 1)
})

test('丢控制ACK后刷新不自动发送，明确核对原键原文且只增加一次采集代际', async ({ page }) => {
  await start(page, 'controls-lost-ack')
  const posts = requests(page), before = await head(page)
  await page.route('**/api/attempts/*/controls', async route => {
    await route.fetch(); await route.abort('failed')
  })
  await panel(page).getByRole('switch', { name: '过程采集', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: '核对原控制请求' })).toBeEnabled()
  expect(posts).toHaveLength(1)
  const persisted = await page.evaluate(async () => {
    const { openWorkspaceDb } = await import('/src/workspace/draftDb.ts' as string)
    const db = await openWorkspaceDb()
    return new Promise<Array<{ key: string; commands?: Array<{ wireJson: string; state: string }> }>>(resolve => {
      const tx = db.transaction('metadata', 'readonly'), request = tx.objectStore('metadata').getAll()
      request.onsuccess = () => resolve(request.result)
    })
  })
  expect(persisted.filter(row => row.key.startsWith('tutor-controls:'))[0]?.commands?.[0]).toMatchObject({ wireJson: posts[0]!.body, state: 'pending' })
  await page.unroute('**/api/attempts/*/controls')
  await page.reload()
  await expect(panel(page).getByRole('button', { name: '核对原控制请求' })).toBeEnabled()
  expect(posts).toHaveLength(1)
  await panel(page).getByRole('button', { name: '核对原控制请求' }).click()
  await expect(panel(page)).toContainText('控制已确认')
  expect(posts).toHaveLength(2); expect(posts[1]).toEqual(posts[0])
  const after = await head(page)
  expect(after.attempt.captureRevision).toBe(before.attempt.captureRevision + 1)
  expect(after.attempt.decisionEpoch).toBe(before.attempt.decisionEpoch)
})

test('公开教师暂停投影禁用个人恢复，按钮禁用只证明UI消费而非服务端授权', async ({ page }) => {
  await start(page, 'controls-teacher-projection'); await saveFile(page)
  await panel(page).getByRole('button', { name: '暂停尝试', exact: true }).click()
  await expect(panel(page).getByRole('button', { name: '恢复尝试', exact: true })).toBeEnabled()
  const posts = requests(page)
  // Response injection changes only published AssignmentView fields; no limitedCheck invention.
  await page.route('**/api/assignments/*', async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch(), envelope = await response.json()
    envelope.data.active = false; envelope.data.status = 'paused'
    envelope.data.assignmentRevision++; envelope.data.reasons.individual = 'teacher pause synthetic projection'
    await route.fulfill({ response, json: envelope })
  })
  await panel(page).getByRole('button', { name: '重读学习控制' }).click()
  await expect(panel(page)).toContainText('学生恢复不能解除')
  await expect(panel(page).getByRole('button', { name: '恢复尝试', exact: true })).toBeDisabled()
  expect(posts).toHaveLength(0)
})

test('服务拒绝原控制仍保护草稿，不显示假成功且不自动重放', async ({ page }) => {
  await start(page, 'controls-refusal'); await saveFile(page)
  const posts = requests(page)
  await page.route('**/api/attempts/*/controls', route => route.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ requestId: 'synthetic-control-refusal', error: { code: 'STATE_CONFLICT', message: 'Operation unavailable in the current state.',
      retryable: false, recovery: 'Read the current state before acting.' } }) }))
  await panel(page).getByRole('button', { name: '暂停尝试', exact: true }).click()
  await expect(panel(page)).toContainText('当前阶段或教师暂停不允许')
  await expect(panel(page).getByRole('button', { name: '暂停尝试', exact: true })).toBeEnabled()
  expect(posts).toHaveLength(1)
  await edit(page, '// still editable\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v2')
  expect((await localState(page)).workspace!.files[0]!.text).toContain('still editable')
  expect(posts).toHaveLength(1)
})
