import { clickWorkspaceAction } from './workspaceControls'
import { expect, test } from '@playwright/test'
import { create, edit, identities, localState, newestSync, serverHead, start, trackSync } from './helpers'

/**
 * UI-PREP-01：同一业务键被异正文占用，必须比较并明确选择后才允许新保存。
 *
 * 页面和公开 HTTP 是主边界。按住原请求只安排到达顺序；另一客户端的有效 POST
 * 由同一准备 authority 正常处理，409 也来自 authority，不伪造回执或灌入成功状态。
 * 本机 outbox 只补充核查原冻结正文与拒绝事实是否保留。
 */
test('同键异正文被真实 authority 拒绝：保留较新草稿，刷新和重读不补做，明确比较后用新命令保存', async ({ page }) => {
  await start(page, 'idempotency-conflict')
  await create(page)
  await edit(page, 'int main(void) { return 0; }\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')
  const initial = await serverHead(page)
  expect(initial.files).toHaveLength(1)
  const originalFileId = initial.files[0]!.fileId

  const frozenText = 'int main(void) { return 1; }\n'
  const newerDraft = 'int main(void) { return 1; }\n// edit after sending\n'
  const occupyingText = 'int main(void) { return 2; }\n// another command owns this key\n'
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.press('Control+a')
  await edit(page, frozenText)
  const posts = trackSync(page)

  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let arrived!: (request: { url: string; headers: Record<string, string>; key: string; body: string }) => void
  const ready = new Promise<{ url: string; headers: Record<string, string>; key: string; body: string }>(resolve => { arrived = resolve })
  await page.route('**/api/attempts/*/sync', async route => {
    const request = route.request()
    arrived({ url: request.url(), headers: request.headers(), key: request.headers()['idempotency-key']!, body: request.postData()! })
    await gate
    const response = await route.fetch()
    await route.fulfill({ response })
  }, { times: 1 })

  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  const original = await ready
  try {
    // 正常公开写入来自另一个客户端，保留相同业务 key，改变正文；不用本机仓库造成功状态。
    const occupyingBody = JSON.parse(original.body)
    expect(occupyingBody.operations).toHaveLength(1)
    expect(occupyingBody.operations[0].kind).toBe('update')
    expect(occupyingBody.operations[0].text).toBe(frozenText)
    occupyingBody.clientId = crypto.randomUUID()
    occupyingBody.clientSeq = 1
    occupyingBody.operations[0].text = occupyingText
    const headers = Object.fromEntries(['content-type', 'x-csrf-token', 'x-i0prep-scenario', 'idempotency-key']
      .map(name => [name, original.headers[name]!]))
    const occupied = await page.request.post(original.url, { headers, data: JSON.stringify(occupyingBody) })
    expect(occupied.status()).toBe(200)
    expect((await occupied.json()).data.result.workspaceRevision).toBe(2)

    // 请求在途期间仍能自主编辑并落本机；原冻结请求必须保持不变。
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press('Control+a')
    await edit(page, newerDraft)
    const rejected = page.waitForResponse(response => response.request().method() === 'POST'
      && response.url() === original.url && response.request().postData() === original.body)
    release()
    const conflict = await rejected
    expect(conflict.status()).toBe(409)
    expect((await conflict.json()).error.code).toBe('IDEMPOTENCY_CONFLICT')
  } finally {
    release()
  }

  const hint = '这次保存的标识已被另一个请求占用，可能是重复发起。草稿已保留，请重新读取后再保存。'
  await expect(page.locator('.ws-head-run [role=alert]')).toHaveText(hint)
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '重试上次保存', exact: true })).toHaveCount(0)
  await expect(page.locator('.view-lines')).toContainText('edit after sending')
  expect(posts).toEqual([{ key: original.key, body: original.body }])
  const rejectedRow = newestSync(await localState(page))
  expect(rejectedRow.commandKey).toBe(original.key)
  expect(rejectedRow.wireJson).toBe(original.body)
  expect(rejectedRow.rejected?.code).toBe('IDEMPOTENCY_CONFLICT')
  const occupiedHead = await serverHead(page)
  expect(occupiedHead.attempt.workspaceRevision).toBe(2)
  expect(occupiedHead.files).toHaveLength(1)
  expect(occupiedHead.files[0]!.fileId).toBe(originalFileId)
  expect(occupiedHead.files[0]!.text).toBe(occupyingText)
  // 技术码、原命令 key 与 clientId 留在诊断，不挤入学生提示。
  const visible = await page.locator('.ws-head').innerText()
  for (const internal of ['IDEMPOTENCY_CONFLICT', original.key, JSON.parse(original.body).clientId]) {
    expect(visible).not.toContain(internal)
  }

  // 页面刷新、显式重新读取都只读当前作品；没有替原命令换键或自动再发一条业务保存。
  await page.reload()
  await expect(page.locator('.ws-head-run [role=alert]')).toHaveText(hint)
  await expect(page.locator('.view-lines')).toContainText('edit after sending')
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: '重试上次保存', exact: true })).toHaveCount(0)
  expect(posts).toHaveLength(1)
  await clickWorkspaceAction(page, '重新读取')
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await expect(page.locator('.ws-head-run [role=alert]')).toHaveText(hint)
  await expect(page.locator('.view-lines')).toContainText('edit after sending')
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
  expect(posts).toHaveLength(1)

  await page.getByRole('button', { name: '比较双方正文', exact: true }).click()
  const compare = page.locator(".ws-compare[data-source='version-conflict']")
  await expect(compare).toBeVisible()
  const diff = compare.locator(".ws-compare-file[data-path='main.c'] .ws-compare-diff")
  await expect(diff.locator('.view-lines').first()).toContainText('return 1')
  await expect(diff.locator('.view-lines').last()).toContainText('another command owns this key')
  // 只读打开/退出不等于选择，也不改较新草稿或放行保存。
  await page.keyboard.press('Escape')
  await expect(page.locator('.ws-compare')).toHaveCount(0)
  await expect(page.locator('.view-lines')).toContainText('edit after sending')
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
  expect(posts).toHaveLength(1)

  await page.getByRole('button', { name: '比较双方正文', exact: true }).click()
  await expect(compare).toBeVisible()
  await page.getByRole('button', { name: '保留本页正文', exact: true }).click()
  await expect(page.locator('.toast')).toHaveText('已保留本页正文，可以重新保存了。')
  await expect(page.locator('.view-lines')).toContainText('edit after sending')
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeEnabled()
  expect(posts).toHaveLength(1)

  // 原命令成为保留拒绝事实的历史；学生新发起保存才用新 key/当前版本与较新草稿。
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v3 · 与草稿一致')
  expect(posts).toHaveLength(2)
  expect(identities(posts).size).toBe(2)
  expect(posts[1]!.key).not.toBe(original.key)
  const newBody = JSON.parse(posts[1]!.body), originalBody = JSON.parse(original.body)
  expect([newBody.clientId, newBody.clientSeq]).not.toEqual([originalBody.clientId, originalBody.clientSeq])
  expect(newBody.expectedWorkspaceRevision).toBe(2)
  expect(newBody.operations).toHaveLength(1)
  expect(newBody.operations[0].fileId).toBe(originalFileId)
  expect(newBody.operations[0].baseVersion).toBe(2)
  expect(newBody.operations[0].text).toBe(newerDraft)
  const finalHead = await serverHead(page)
  expect(finalHead.attempt.workspaceRevision).toBe(3)
  expect(finalHead.files).toHaveLength(1)
  expect(finalHead.files[0]!.fileId).toBe(originalFileId)
  expect(finalHead.files[0]!.text).toBe(newerDraft)
  const commands = (await localState(page)).commands
  const preserved = commands.find(command => command.commandKey === original.key)!
  expect(preserved.state).toBe('historical')
  expect(preserved.rejected?.code).toBe('IDEMPOTENCY_CONFLICT')
  expect(preserved.wireJson).toBe(original.body)

  await page.reload()
  await expect(page.locator('.view-lines')).toContainText('edit after sending')
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v3 · 与草稿一致')
  await expect(page.getByRole('button', { name: '重试上次保存', exact: true })).toHaveCount(0)
  expect(posts).toHaveLength(2)
})
