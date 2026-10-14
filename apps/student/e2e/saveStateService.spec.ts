import { randomUUID } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { confirmSave, create, edit, openFileMenu, trackBusinessWrites, trackSync, typeIn } from './helpers'
import { loginThroughForm, startSessionHost } from './sessionHost'
import type { WorkspaceHead } from '../src/workspace/workspaceContracts'

/** UI-REAL-07：正式构建、真实登录表单及隔离 HTTPS/SQLite；私有 IPC 只构造合成阶段。 */
test.use({ ignoreHTTPSErrors: true, trace: 'off' })
test.setTimeout(120_000)
test.beforeEach(() => {
  test.skip(!process.env.XUNJIE_E2E_SERVICE_NODE, 'Requires approved teaching Node 24.21.0 and existing native dependencies')
})

type Host = Awaited<ReturnType<typeof startSessionHost>>
interface LocalCommand {
  kind: string; state: string; createdAt: number; commandKey: string; wireJson: string
  context: { mode: string; attemptId?: string }; rejected?: { code: string }
}
interface LocalFacts {
  commands: LocalCommand[]
  drafts: Array<{ clientFileKey: string; text: string; draftRevision: number }>
}

async function enter(page: Page, service: Host) {
  await expect.poll(async () => {
    try { return (await page.context().request.get(`${service.base}/health/live`)).status() } catch { return 0 }
  }, { timeout: 20_000 }).toBe(200)
  await page.goto(`${service.base}/#/task/${service.assignmentId}`)
  await expect(page.getByRole('heading', { name: '登录学习空间' })).toBeVisible()
  await loginThroughForm(page, 'student', service.password)
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  const created = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === `/api/assignments/${service.assignmentId}/attempts`)
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  const response = await created
  expect(response.status()).toBe(200)
  const attemptId = (await response.json()).data.result.attemptId as string
  await expect(page.locator('.cw')).toBeVisible()
  return attemptId
}

async function head(page: Page, service: Host, attemptId: string): Promise<WorkspaceHead> {
  const response = await page.context().request.get(`${service.base}/api/attempts/${attemptId}`)
  expect(response.status()).toBe(200)
  return (await response.json()).data
}

/** 生产 bundle 不开放 /src 模块；只读现有库，不创建、迁移或改写记录。 */
async function localFacts(page: Page, attemptId: string): Promise<LocalFacts> {
  return page.evaluate(async id => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('xunjie-i0-workspace')
      request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('Expected existing workspace database')) }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      return await new Promise<LocalFacts>((resolve, reject) => {
        const tx = db.transaction(['outbox', 'drafts'], 'readonly')
        const commands = tx.objectStore('outbox').getAll(), drafts = tx.objectStore('drafts').getAll()
        tx.oncomplete = () => resolve({
          commands: (commands.result as LocalCommand[]).filter(row => row.context.mode === 'real' && row.context.attemptId === id),
          drafts: (drafts.result as LocalFacts['drafts']).filter(row => row.clientFileKey.startsWith(`real\u0000student\u0000${id}\u0000`)),
        })
        tx.onabort = () => reject(tx.error)
        tx.onerror = () => reject(tx.error)
      })
    } finally { db.close() }
  }, attemptId)
}

async function createAnother(page: Page, name: string, text: string) {
  await openFileMenu(page)
  await page.locator('.cw-filemenu').getByRole('menuitem', { name: '新建文件', exact: true }).click()
  const input = page.getByRole('textbox', { name: '新文件名' })
  await input.fill(name); await input.press('Enter')
  await expect(page.locator('.monaco-editor textarea').first()).toBeAttached()
  await edit(page, text)
}

async function lifecycleProject(page: Page, service: Host, attemptId: string) {
  await create(page, 'main.c'); await edit(page, 'int main(void) { return 0; }\n')
  await createAnother(page, 'sample.txt', 'one two one\n')
  await createAnother(page, 'archived.txt', 'retained archived body\n')
  await confirmSave(page, 1)
  await openFileMenu(page)
  await page.locator('[data-fileid] button[aria-label="回收 archived.txt"]').click()
  await confirmSave(page, 2)
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.getByText('已冻结快照 v2', { exact: true })).toBeVisible()
  const result = await head(page, service, attemptId)
  expect(result.files.find(file => file.path === 'archived.txt')?.lifecycle).toBe('recycled')
  return result
}

async function selectRun(page: Page, before: WorkspaceHead) {
  const snapshot = before.snapshots.find(row => row.workspaceRevision === 2)!
  await page.getByRole('button', { name: 'Core 运行', exact: true }).click()
  await page.getByRole('combobox', { name: '确认快照', exact: true }).selectOption(snapshot.snapshotId)
  await page.getByRole('combobox', { name: 'C 入口文件', exact: true }).selectOption(snapshot.files.find(file => file.path === 'main.c')!.fileId)
  await page.getByRole('checkbox', { name: 'sample.txt', exact: true }).check()
}

async function writeInput(page: Page, service: Host) {
  const session = await page.context().request.get(`${service.base}/api/session`)
  expect(session.status()).toBe(200)
  const bootstrap = await page.context().request.get(`${service.base}/api/assignments/${service.assignmentId}/bootstrap`)
  expect(bootstrap.status()).toBe(200)
  return {
    headers: { Origin: service.base, 'x-csrf-token': (await session.json()).data.csrfToken, 'Idempotency-Key': randomUUID() },
    generation: (await bootstrap.json()).data.recoveryGeneration as string,
  }
}

test('实际暂停：既有 active 文件 update 可保存，新建、回收、恢复和运行零写', async ({ page }) => {
  const service = await startSessionHost()
  try {
    const attemptId = await enter(page, service)
    const active = await lifecycleProject(page, service, attemptId)
    const paused = await service.control({ kind: 'state', attemptId, state: 'paused' })
    expect(paused.status).toBe('paused')
    const baseline = await service.control({ kind: 'inspect', attemptId })
    const writes = trackBusinessWrites(page)
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(page.locator('.cw-access')).toHaveAttribute('data-kind', 'paused')
    await openFileMenu(page)
    const newFile = page.locator('.cw-filemenu').getByRole('menuitem', { name: '新建文件', exact: true })
    await expect(newFile).toBeDisabled()
    await expect(newFile).toHaveAttribute('title', /暂停|不允许|状态|不能/)
    await expect(page.locator('[data-fileid] button[aria-label="回收 main.c"]')).toBeDisabled()
    await expect(page.locator('.cw-filerecycled button[aria-label="恢复 archived.txt"]')).toBeDisabled()
    await page.keyboard.press('Escape')
    await selectRun(page, active)
    await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
    await page.getByRole('combobox', { name: 'C 入口文件', exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.getByRole('button', { name: '返回编辑', exact: true }).click()
    expect(writes).toEqual([])
    const blocked = await service.control({ kind: 'inspect', attemptId })
    expect(blocked.requests.businessWrites).toBe(baseline.requests.businessWrites)
    expect(blocked.database).toEqual(baseline.database)
    expect(blocked.attemptCounts).toEqual(baseline.attemptCounts)

    await page.getByRole('tab', { name: 'main.c', exact: true }).click()
    const saves = trackSync(page)
    await edit(page, '// paused update\n')
    await confirmSave(page, 3)
    const after = await head(page, service, attemptId)
    expect(after.attempt.status).toBe('paused')
    expect(after.attempt.workspaceRevision).toBe(paused.workspaceRevision + 1)
    // 记录当前实际语义：sync 也推进 attemptRevision；控制 CAS 仍要单独读取它。
    expect(after.attempt.attemptRevision).toBe(paused.attemptRevision + 1)
    expect(after.files.map(file => [file.fileId, file.lifecycle])).toEqual(active.files.map(file => [file.fileId, file.lifecycle]))
    expect(after.files.find(file => file.path === 'main.c')!.text).toContain('paused update')
    expect(after.files.find(file => file.path === 'archived.txt')).toEqual(active.files.find(file => file.path === 'archived.txt'))
    expect(saves).toHaveLength(1)
    const sent = JSON.parse(saves[0]!.body)
    expect(sent.expectedWorkspaceRevision).toBe(paused.workspaceRevision)
    expect(sent.operations).toHaveLength(1)
    expect(sent.operations[0]).toMatchObject({ kind: 'update', fileId: active.files.find(file => file.path === 'main.c')!.fileId })
    expect(writes).toEqual([`POST /api/attempts/${attemptId}/sync`])
    const saved = await service.control({ kind: 'inspect', attemptId })
    expect(saved.requests.businessWrites).toBe(baseline.requests.businessWrites + 1)
    expect(saved.attemptCounts!.files).toBe(baseline.attemptCounts!.files)
    expect(saved.attemptCounts!.receipts).toBe(baseline.attemptCounts!.receipts + 1)
  } finally { await page.context().close(); await service.stop() }
})

test('实际 submitted/reviewed：正文只读，保存、冻结、新建、回收、恢复、运行均零写', async ({ page }) => {
  const service = await startSessionHost()
  try {
    const attemptId = await enter(page, service)
    const active = await lifecycleProject(page, service, attemptId)
    for (const state of ['submitted', 'reviewed'] as const) {
      expect((await service.control({ kind: 'state', attemptId, state })).status).toBe(state)
      const baseline = await service.control({ kind: 'inspect', attemptId })
      const writes = trackBusinessWrites(page)
      await page.getByRole('button', { name: '重新读取', exact: true }).click()
      await expect(page.locator('.cw-access')).toHaveAttribute('data-kind', 'read-only')
      await expect(page.locator('.cw-access')).toContainText('终态')
      await page.getByRole('tab', { name: 'main.c', exact: true }).click()
      const before = await localFacts(page, attemptId)
      await typeIn(page, 'TERMINAL-MUST-NOT-LAND')
      expect((await localFacts(page, attemptId)).drafts).toEqual(before.drafts)
      await expect(page.locator('.view-lines')).not.toContainText('TERMINAL-MUST-NOT-LAND')
      await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
      await expect(page.getByRole('button', { name: '冻结确认作品', exact: true })).toBeDisabled()
      await openFileMenu(page)
      await expect(page.locator('.cw-filemenu').getByRole('menuitem', { name: '新建文件', exact: true })).toBeDisabled()
      await expect(page.locator('[data-fileid] button[aria-label="回收 main.c"]')).toBeDisabled()
      await expect(page.locator('.cw-filerecycled button[aria-label="恢复 archived.txt"]')).toBeDisabled()
      await page.keyboard.press('Escape')
      await selectRun(page, active)
      await expect(page.getByRole('button', { name: '运行此快照', exact: true })).toBeDisabled()
      await page.getByRole('combobox', { name: 'C 入口文件', exact: true }).focus()
      await page.keyboard.press('Enter')
      await page.getByRole('button', { name: '返回编辑', exact: true }).click()
      expect(writes).toEqual([])
      const after = await service.control({ kind: 'inspect', attemptId })
      expect(after.requests.businessWrites).toBe(baseline.requests.businessWrites)
      expect(after.database).toEqual(baseline.database)
      expect(after.attemptCounts).toEqual(baseline.attemptCounts)
      expect(after.attempt!.attempt.status).toBe(state)
      expect(after.attempt!.attempt.workspaceRevision).toBe(active.attempt.workspaceRevision)
      expect(after.attempt!.files).toEqual(active.files)
      expect((await localFacts(page, attemptId)).commands).toEqual(before.commands)
    }
  } finally { await page.context().close(); await service.stop() }
})

test('实际 VERSION_CONFLICT 保留原草稿与拒绝事实，重读比较后显式保留正文才用新命令保存', async ({ page }) => {
  const service = await startSessionHost()
  try {
    const attemptId = await enter(page, service)
    await create(page); await edit(page, 'first body\n'); await confirmSave(page, 1)
    const first = await head(page, service, attemptId)
    const write = await writeInput(page, service)
    const external = await page.context().request.post(`${service.base}/api/attempts/${attemptId}/sync`, {
      headers: write.headers, data: { recoveryGeneration: write.generation, expectedWorkspaceRevision: first.attempt.workspaceRevision,
        clientId: randomUUID(), clientSeq: 1, operations: [{ kind: 'update', fileId: first.files[0]!.fileId,
          baseVersion: first.files[0]!.documentVersion, text: 'first body\n// other writer\n' }] },
    })
    expect(external.status()).toBe(200)
    const externalHead = await head(page, service, attemptId)
    expect(externalHead.attempt.workspaceRevision).toBe(2)
    expect(externalHead.attempt.attemptRevision).toBe(first.attempt.attemptRevision + 1)
    await edit(page, '// mine\n')
    const mine = (await localFacts(page, attemptId)).drafts[0]!.text
    const saves = trackSync(page)
    const conflict = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith(`/api/attempts/${attemptId}/sync`))
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    const rejected = await conflict
    expect(rejected.status()).toBe(409)
    expect((await rejected.json()).error.code).toBe('VERSION_CONFLICT')
    await expect(page.locator('.ws-run-state')).toHaveText('作品有更新')
    await expect(page.locator('.ws-head-run [role=alert]')).toContainText('草稿已保留')
    await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
    await expect(page.getByRole('button', { name: '重试上次保存' })).toHaveCount(0)
    await expect(page.locator('.view-lines')).toContainText('// mine')
    expect(saves).toHaveLength(1)
    const oldCommand = (await localFacts(page, attemptId)).commands.filter(row => row.kind === 'workspace.sync').sort((a, b) => b.createdAt - a.createdAt)[0]!
    expect(oldCommand.rejected?.code).toBe('VERSION_CONFLICT')
    expect(JSON.parse(oldCommand.wireJson).expectedWorkspaceRevision).toBe(1)
    const beforeReread = await service.control({ kind: 'inspect', attemptId })
    expect(beforeReread.attempt!.files[0]!.text).toContain('other writer')
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(page.locator('.ws-run-state')).toHaveText('作品有更新')
    expect(saves).toHaveLength(1)
    expect((await service.control({ kind: 'inspect', attemptId })).requests.businessWrites).toBe(beforeReread.requests.businessWrites)
    expect((await localFacts(page, attemptId)).drafts[0]!.text).toBe(mine)
    await page.getByRole('button', { name: '比较双方正文' }).click()
    const compare = page.locator('.ws-compare[data-source="version-conflict"]')
    await expect(compare).toBeVisible()
    await expect(compare.locator('.view-lines').first()).toContainText('mine')
    await expect(compare.locator('.view-lines').last()).toContainText('other writer')
    expect(saves).toHaveLength(1)
    await page.getByRole('button', { name: '保留本页正文' }).click()
    await expect(page.locator('.toast')).toHaveText('已保留本页正文，可以重新保存了。')
    const retired = (await localFacts(page, attemptId)).commands.find(row => row.commandKey === oldCommand.commandKey)!
    expect(retired.state).toBe('historical')
    expect(retired.wireJson).toBe(oldCommand.wireJson)
    expect(retired.rejected?.code).toBe('VERSION_CONFLICT')
    expect(saves).toHaveLength(1)
    await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeEnabled()
    await confirmSave(page, 3)
    expect(saves).toHaveLength(2)
    expect(saves[1]!.key).not.toBe(saves[0]!.key)
    const accepted = JSON.parse(saves[1]!.body)
    expect(accepted.expectedWorkspaceRevision).toBe(2)
    expect(accepted.operations[0]).toMatchObject({ kind: 'update', baseVersion: 2, text: mine })
    const after = await head(page, service, attemptId)
    expect(after.files[0]!.text).toBe(mine)
    expect(after.files[0]!.documentVersion).toBe(3)
    expect(after.attempt.workspaceRevision).toBe(3)
    expect(after.attempt.attemptRevision).toBe(externalHead.attempt.attemptRevision + 1)
    expect((await localFacts(page, attemptId)).commands.find(row => row.commandKey === oldCommand.commandKey)!.wireJson).toBe(oldCommand.wireJson)
  } finally { await page.context().close(); await service.stop() }
})

test('两个 revision 分别读取：保存/快照后控制重读权威 attemptRevision，拒用作品版本与旧渲染版本', async ({ page }) => {
  const service = await startSessionHost()
  try {
    const attemptId = await enter(page, service)
    const initial = await head(page, service, attemptId)
    await create(page); await edit(page, 'version one\n'); await confirmSave(page, 1)
    const first = await head(page, service, attemptId)
    expect(first.attempt.workspaceRevision).toBe(initial.attempt.workspaceRevision + 1)
    expect(first.attempt.attemptRevision).toBe(initial.attempt.attemptRevision + 1)
    await page.getByRole('button', { name: '任务信息', exact: true }).click()
    const reminders = page.getByRole('switch', { name: '里程碑提醒', exact: true })
    await expect(reminders).toBeEnabled()
    await reminders.click()
    await expect(page.getByTestId('tutoring-controls')).toContainText('控制已确认')
    const controlled = await head(page, service, attemptId)
    expect(controlled.attempt.attemptRevision).toBe(first.attempt.attemptRevision + 1)
    expect(controlled.attempt.workspaceRevision).toBe(first.attempt.workspaceRevision)
    await page.getByRole('button', { name: '关闭', exact: true }).click()
    await edit(page, 'version two\n'); await confirmSave(page, 2)
    const second = await head(page, service, attemptId)
    expect(second.attempt.workspaceRevision).toBe(controlled.attempt.workspaceRevision + 1)
    expect(second.attempt.attemptRevision).toBe(controlled.attempt.attemptRevision + 1)
    await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
    await expect(page.getByText('已冻结快照 v2', { exact: true })).toBeVisible()
    const frozen = await head(page, service, attemptId)
    expect(frozen.attempt.workspaceRevision).toBe(second.attempt.workspaceRevision)
    expect(frozen.attempt.attemptRevision).toBe(second.attempt.attemptRevision)
    expect(frozen.snapshots[0]!.workspaceRevision).toBe(second.attempt.workspaceRevision)
    await page.getByRole('button', { name: '任务信息', exact: true }).click()
    const capture = page.getByRole('switch', { name: '过程采集', exact: true })
    await expect(capture).toBeEnabled()
    // 保留旧渲染，再通过同一公开命令推进控制版本，迫使下一次 UI 操作重读。
    const write = await writeInput(page, service)
    const outside = await page.context().request.post(`${service.base}/api/attempts/${attemptId}/controls`, {
      headers: write.headers, data: { recoveryGeneration: write.generation, expectedAttemptRevision: frozen.attempt.attemptRevision,
        control: { kind: 'reminders', value: !frozen.attempt.reminders } },
    })
    expect(outside.status()).toBe(200)
    const authoritative = await head(page, service, attemptId)
    expect(authoritative.attempt.attemptRevision).toBe(frozen.attempt.attemptRevision + 1)
    expect(authoritative.attempt.workspaceRevision).toBe(frozen.attempt.workspaceRevision)
    expect(authoritative.attempt.attemptRevision).not.toBe(authoritative.attempt.workspaceRevision)
    const events: Array<{ kind: 'head' | 'control'; revision: number }> = []
    page.on('response', async response => {
      if (response.request().method() === 'GET' && new URL(response.url()).pathname === `/api/attempts/${attemptId}` && response.status() === 200) {
        const event = { kind: 'head' as const, revision: -1 }
        events.push(event)
        event.revision = (await response.json()).data.attempt.attemptRevision
      }
    })
    const controls: Array<Record<string, unknown>> = []
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith(`/api/attempts/${attemptId}/controls`)) {
        const body = request.postDataJSON()
        controls.push(body); events.push({ kind: 'control', revision: body.expectedAttemptRevision })
      }
    })
    await capture.click()
    await expect(page.getByTestId('tutoring-controls')).toContainText('控制已确认')
    expect(controls).toHaveLength(1)
    expect(controls[0]!.expectedAttemptRevision).toBe(authoritative.attempt.attemptRevision)
    expect(controls[0]!.expectedAttemptRevision).not.toBe(frozen.attempt.attemptRevision)
    expect(controls[0]!.expectedAttemptRevision).not.toBe(authoritative.attempt.workspaceRevision)
    const index = events.findIndex(row => row.kind === 'control')
    await expect.poll(() => events.slice(0, index).some(row => row.kind === 'head' && row.revision === authoritative.attempt.attemptRevision)).toBe(true)
    const after = await head(page, service, attemptId)
    expect(after.attempt.attemptRevision).toBe(authoritative.attempt.attemptRevision + 1)
    expect(after.attempt.workspaceRevision).toBe(authoritative.attempt.workspaceRevision)
    expect(after.attempt.collecting).toBe(!authoritative.attempt.collecting)
  } finally { await page.context().close(); await service.stop() }
})
