import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { PREP_TASK_PATH, PREP_URL } from './env'

/**
 * I0_UI_04：断线重连只核或重放**原保存命令**。
 *
 * 全部走同一个 `npm run dev:prep` 进程与真实浏览器（Monaco、IndexedDB、HTTP）：
 * 丢 ACK 由 fixture 的 `/__i0prep/fault` 复现（服务照常提交，只是不下发响应），
 * 断线用浏览器离线复现；不另造假业务、不把超时当拒绝或成功。
 */
const sceneUrl = (name: string) => `${PREP_URL}/?scenario=${name}-${crypto.randomUUID()}${PREP_TASK_PATH}`

async function start(page: Page, name: string) {
  await page.goto(sceneUrl(name))
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  await expect(page.locator('.cw')).toBeVisible()
}

async function create(page: Page, name = 'main.c') {
  await page.getByRole('button', { name: '新建文件', exact: true }).first().click()
  const input = page.getByRole('textbox', { name: '新文件名' })
  await input.fill(name)
  await input.press('Enter')
  await expect(page.locator('.monaco-editor textarea').first()).toBeAttached()
}

async function edit(page: Page, text: string) {
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.insertText(text)
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
}

/** 设置/清除开发故障；只作用于当前合成场景。 */
async function setFault(page: Page, kind: 'none' | 'drop-ack' | 'fail-write') {
  return page.evaluate(async kind => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const response = await fetch('/__i0prep/fault', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ kind }) })
    return response.status
  }, kind)
}

interface LocalCommand { kind: string; state: string; createdAt: number; commandKey: string; wireJson: string
  rejected?: { code: string } | null }
interface LocalSummary { workspace: { workspaceRevision: number; files: Array<{ fileId: string; text: string }> } | null
  instances: Array<{ fileId: string }>; drafts: Array<{ text: string }>; commands: LocalCommand[] }

async function localState(page: Page): Promise<LocalSummary> {
  return page.evaluate(async () => {
    const { confirmationRepository } = await import('/src/workspace/confirmationDb.ts' as string)
    const scenarioId = new URLSearchParams(location.search).get('scenario')!
    const data = (await (await fetch('/__i0prep/context', { headers: { 'x-i0prep-scenario': scenarioId } })).json()).data
    return confirmationRepository.read({
      mode: 'preparation', userId: data.syntheticAccount.userId, courseId: data.syntheticAccount.courseId,
      assignmentId: data.refs.assignmentId, activityVersionId: data.refs.activityVersionId,
      attemptId: data.refs.attemptId, loadEpoch: 0, preparationEpoch: data.preparationEpoch,
      trustedRecoveryGeneration: data.recoveryGeneration, scenarioId,
    })
  })
}

/** 最新的原保存命令（同一测试里可能先有成功保存、再有被拒绝的保存）。 */
function newestSync(state: LocalSummary): LocalCommand {
  return state.commands.filter(c => c.kind === 'workspace.sync').sort((a, b) => b.createdAt - a.createdAt)[0]!
}

/** 用 fixture 的合成身份从页面内直接推进权威作品（模拟另一处已保存）。 */
async function syntheticUpdate(page: Page, text: string) {
  return page.evaluate(async text => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const context = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const head = (await (await fetch(`/__i0prep/api/attempts/${context.refs.attemptId}`, { headers })).json()).data
    const file = head.files[0]
    const response = await fetch(`/__i0prep/api/attempts/${context.refs.attemptId}/sync`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ recoveryGeneration: context.recoveryGeneration,
        expectedWorkspaceRevision: head.attempt.workspaceRevision, clientId: crypto.randomUUID(), clientSeq: 1,
        operations: [{ kind: 'update', fileId: file.fileId, baseVersion: file.documentVersion, text }] }) })
    return response.status
  }, text)
}

function trackSync(page: Page) {
  const posts: Array<{ key: string; body: string }> = []
  page.on('request', r => {
    if (r.method() === 'POST' && r.url().endsWith('/sync')) posts.push({ key: r.headers()['idempotency-key']!, body: r.postData()! })
  })
  return posts
}

/**
 * 业务命令身份（业务键 + 正文）。同一原命令在传输层被浏览器重试、或被学生明确重放，
 * 身份都必须完全相同；只有出现第二条身份才说明客户端新建了命令。
 */
function identities(posts: Array<{ key: string; body: string }>) {
  return new Set(posts.map(p => `${p.key}\n${p.body}`))
}

/** 按住一次写命令的响应：请求已发出（因此租约与在途状态真实存在），回执尚未到达。 */
async function holdAck(page: Page) {
  let release!: () => void, arrived!: () => void
  const wait = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { arrived = r })
  await page.route('**/api/attempts/*/sync', async route => {
    const response = await route.fetch()
    arrived()
    await wait
    await route.fulfill({ response })
  })
  return { ready, release }
}

test('丢 ACK 后继续编辑、刷新，重放原命令只创建一次并恢复同一 fileId', async ({ page }) => {
  await start(page, 'recovery-drop-ack')
  await create(page)
  const frozenText = 'int main(void) { return 0; }\n'
  await edit(page, frozenText)
  const posts = trackSync(page)

  expect(await setFault(page, 'drop-ack')).toBe(200)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  // 拿不到信封只能说「结果未知」，不是拒绝、也不是成功
  await expect(page.locator('.ws-run-state')).toHaveText('原请求结果未知')
  await expect(page.locator('.ws-head-run [role=alert]')).toContainText('可能尚未送达')
  // 本机确认头仍停在上次已接受的 v0：丢 ACK 不能被当成保存成功
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v0')
  await expect(page.locator('.ws-flow')).not.toContainText('与草稿一致')
  const afterDrop = posts.length
  expect(afterDrop).toBeGreaterThan(0)
  expect(identities(posts).size).toBe(1)

  // 断线期间继续编辑：草稿仍然受本机保护，且不允许把新编辑挂到旧键上
  await edit(page, '// offline edit\n')
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
  expect(posts.length).toBe(afterDrop)

  // 刷新后：原文草稿还在，原请求事实还在，重连不自动发送任何新业务操作
  await page.reload()
  await expect(page.locator('.cw')).toBeVisible()
  await expect(page.locator('.view-lines')).toContainText('offline edit')
  await expect(page.getByRole('button', { name: '核对原请求并重试' })).toBeVisible()
  expect(posts.length).toBe(afterDrop)

  // 核对原请求：显示冻结命令的键/序号/代际/预期版本与冻结正文摘要（不是当前草稿）
  const pending = newestSync(await localState(page))
  const body = JSON.parse(pending.wireJson)
  await page.getByRole('button', { name: '原请求详情' }).click()
  const detail = await page.locator('.ws-head-run .ws-request-detail').innerText()
  expect(detail).toContain('workspace.sync')
  expect(detail).toContain(pending.commandKey)
  expect(detail).toContain(body.clientId)
  expect(detail).toContain(`#${body.clientSeq}`)
  expect(detail).toContain(body.recoveryGeneration)
  expect(detail).toContain('main.c')
  expect(detail).toContain(createHash('sha256').update(frozenText, 'utf8').digest('hex').slice(0, 16))
  expect(detail).not.toContain('csrf')

  // 重放：同键、同正文、同代际，服务返回原回执，不产生第二次创建
  expect(await setFault(page, 'none')).toBe(200)
  await page.getByRole('button', { name: '核对原请求并重试' }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
  await expect(page.getByRole('button', { name: '核对原请求并重试' })).toHaveCount(0)
  expect(posts.length).toBeGreaterThan(afterDrop)
  expect(posts[posts.length - 1]).toEqual(posts[0])
  expect(identities(posts).size).toBe(1)

  const local = await localState(page)
  expect(local.workspace!.files).toHaveLength(1)
  expect(local.workspace!.files[0]!.text).toBe(frozenText)
  expect(local.instances[0]!.fileId).toBe(local.workspace!.files[0]!.fileId)
  expect(local.drafts[0]!.text).toContain('offline edit')
  await expect(page.locator('.cw-filetab-main')).toHaveCount(1)
  await expect(page.locator('.view-lines')).toContainText('offline edit')
})

test('浏览器断线时保存不冒充拒绝或成功，重连后只重放原命令', async ({ page, context }) => {
  await start(page, 'recovery-offline')
  await create(page)
  await edit(page, 'offline base\n')
  const posts = trackSync(page)

  await context.setOffline(true)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-run-state')).toHaveText('原请求结果未知')
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v0')
  await expect(page.locator('.ws-flow')).not.toContainText('与草稿一致')
  // 断线时继续编辑仍写入本机草稿
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.insertText('// still editing\n')
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')

  await context.setOffline(false)
  await page.reload()
  await expect(page.locator('.cw')).toBeVisible()
  await expect(page.locator('.view-lines')).toContainText('still editing')
  await expect(page.getByRole('button', { name: '核对原请求并重试' })).toBeVisible()
  // 断线期间请求根本没有离开浏览器；重连读回后也不自动补发
  expect(posts).toHaveLength(0)

  await page.getByRole('button', { name: '核对原请求并重试' }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
  expect(posts).toHaveLength(1)
  expect(identities(posts).size).toBe(1)
  const local = await localState(page)
  expect(local.workspace!.files).toHaveLength(1)
  expect(local.drafts[0]!.text).toContain('still editing')
})

test('原命令在另一标签已确认时，本标签停止重发并重读当前 head', async ({ page, context }) => {
  await start(page, 'recovery-confirmed-elsewhere')
  await create(page)
  await edit(page, 'shared body\n')
  const posts = trackSync(page)

  expect(await setFault(page, 'drop-ack')).toBe(200)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-run-state')).toHaveText('原请求结果未知')
  const afterDrop = posts.length
  expect(afterDrop).toBeGreaterThan(0)
  expect(identities(posts).size).toBe(1)

  // 本标签里的独立客户端，且收不到通知（模拟还没被唤醒的旧加载）：它仍认为原命令未决
  await page.evaluate(async () => {
    const original = window.BroadcastChannel
    ;(window as unknown as { BroadcastChannel: unknown }).BroadcastChannel = undefined
    try {
      const { ConfirmationWorkspace } = await import('/src/workspace/confirmationWorkspace.ts' as string)
      const scenarioId = new URLSearchParams(location.search).get('scenario')!
      const data = (await (await fetch('/__i0prep/context', { headers: { 'x-i0prep-scenario': scenarioId } })).json()).data
      const reader = new ConfirmationWorkspace({ mode: 'preparation', userId: data.syntheticAccount.userId,
        courseId: data.syntheticAccount.courseId, assignmentId: data.refs.assignmentId,
        activityVersionId: data.refs.activityVersionId, attemptId: data.refs.attemptId,
        trustedRecoveryGeneration: data.recoveryGeneration, preparationEpoch: data.preparationEpoch,
        loadEpoch: 900, scenarioId })
      ;(globalThis as unknown as { reader: typeof reader }).reader = reader
      await reader.initialize()
    } finally {
      ;(window as unknown as { BroadcastChannel: unknown }).BroadcastChannel = original
    }
  })
  expect(await page.evaluate(() => {
    const reader = (globalThis as unknown as { reader: { current: { pending: unknown; outcome: { kind: string } | null } } }).reader
    return { pending: !!reader.current.pending, outcome: reader.current.outcome?.kind }
  })).toEqual({ pending: true, outcome: 'unresolved' })

  // 另一标签用同一原命令核对（同键幂等），服务返回原回执
  expect(await setFault(page, 'none')).toBe(200)
  const other = await context.newPage()
  await other.goto(page.url())
  await other.getByRole('button', { name: '核对原请求并重试' }).click()
  await expect.poll(async () => newestSync(await localState(other)).state).toBe('confirmed')

  // 本标签再核对：已确认的原命令不重发，只重新接纳同一回执并重读当前 head
  await page.evaluate(() => (globalThis as unknown as { reader: { retry: () => Promise<void> } }).reader.retry())
  const after = await page.evaluate(() => {
    const reader = (globalThis as unknown as { reader: { current: { pending: unknown; workspace: { workspaceRevision: number } | null }; dispose: () => void } }).reader
    const state = reader.current
    reader.dispose()
    return { pending: !!state.pending, revision: state.workspace?.workspaceRevision ?? null }
  })
  expect(after).toEqual({ pending: false, revision: 1 })
  // 已确认的原命令不再产生任何请求：只是本机重新接纳同一回执
  expect(posts.length, JSON.stringify(posts)).toBe(afterDrop)
  expect(identities(posts).size).toBe(1)
  const local = await localState(page)
  expect(local.workspace!.workspaceRevision).toBe(1)
  expect(local.instances[0]!.fileId).toBe(local.workspace!.files[0]!.fileId)
  expect(newestSync(local).state).toBe('confirmed')
})

test('另一标签持有原命令租约时不重发也不产生新命令', async ({ page, context }) => {
  await start(page, 'recovery-lease')
  await create(page)
  await edit(page, 'lease body\n')
  const posts = trackSync(page)
  const held = await holdAck(page)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await held.ready

  // 另一标签尝试核对同一原命令：抢租约不产生新命令，也不被当成服务拒绝
  const other = await context.newPage()
  const otherPosts: string[] = []
  // 只统计业务写命令：准备模式的登录 POST /sessions 是页面载入的正常行为
  other.on('request', r => { if (r.method() === 'POST' && r.url().includes('/api/attempts')) otherPosts.push(r.url()) })
  await other.goto(page.url())
  // 入口保持可见（租约只说明「现在抢不到」，过期后仍应能核对），点击后由本机事务给出结论
  await expect(other.getByRole('button', { name: '核对原请求并重试' })).toBeVisible()
  await other.getByRole('button', { name: '核对原请求并重试' }).click()
  await expect(other.locator('.ws-head-run [role=alert]')).toContainText('另一标签正在核对同一原请求')
  await expect(other.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
  expect(otherPosts).toEqual([])

  held.release()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
  await expect(other.locator('.ws-flow')).toContainText('确认作品 v1')
  expect(posts).toHaveLength(1)
})

test('RECOVERY_REQUIRED 停止旧重试，重读受信上下文后仍保留草稿与旧事实', async ({ page }) => {
  await start(page, 'recovery-required')
  await create(page)
  await edit(page, 'gen1 body\n')
  const posts = trackSync(page)

  expect(await setFault(page, 'drop-ack')).toBe(200)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-run-state')).toHaveText('原请求结果未知')
  expect(await setFault(page, 'none')).toBe(200)

  // 服务端恢复脚本换代际并回退作品（原命令所属代际随即失效）
  const rotated = await page.evaluate(async () => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const data = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const response = await fetch('/__i0prep/recover', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ attemptId: data.refs.attemptId, workspaceRevision: 0 }) })
    return { status: response.status, before: data.recoveryGeneration, after: (await response.json()).data.recoveryGeneration }
  })
  expect(rotated.status).toBe(200)
  expect(rotated.after).not.toBe(rotated.before)

  // 核对原请求：服务拒绝 RECOVERY_REQUIRED → 停止旧重试，只提示重读受信上下文
  await page.getByRole('button', { name: '核对原请求并重试' }).click()
  await expect(page.locator('.ws-run-state')).toHaveText('受信代际已变化')
  await expect(page.getByRole('button', { name: '核对原请求并重试' })).toHaveCount(0)
  await expect(page.locator('.ws-head-run [role=alert]')).toContainText('停止重放旧原请求')
  await expect(page.getByRole('button', { name: '重读受信上下文' })).toBeVisible()
  await expect(page.locator('.view-lines')).toContainText('gen1 body')
  expect(identities(posts).size).toBe(1)
  expect(newestSync(await localState(page)).rejected?.code).toBe('RECOVERY_REQUIRED')

  // 重读受信上下文：代际换了，但旧原请求仍然只能作为事实保留，草稿继续可编辑
  const beforeReload = posts.length
  await page.getByRole('button', { name: '重读受信上下文' }).click()
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await expect(page.locator('.ws-run-state')).toHaveText('受信代际已变化')
  await expect(page.getByRole('button', { name: '核对原请求并重试' })).toHaveCount(0)
  await expect(page.locator('.view-lines')).toContainText('gen1 body')
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
  expect(posts.length).toBe(beforeReload)

  // 刷新后结论与正文都不变：不自动补发、不改业务键
  await page.reload()
  await expect(page.locator('.view-lines')).toContainText('gen1 body')
  await expect(page.getByRole('button', { name: '核对原请求并重试' })).toHaveCount(0)
  expect(posts.length).toBe(beforeReload)
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v0')
})

test('VERSION_CONFLICT 保留正文、阻止自动覆盖，并把拒绝事实留在原命令上', async ({ page }) => {
  await start(page, 'recovery-version-conflict')
  await create(page)
  await edit(page, 'first body\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')

  // 另一处推进权威版本：本机预期版本随即过期
  expect(await syntheticUpdate(page, 'first body\n// other writer\n')).toBe(200)
  await edit(page, '// mine\n')
  const posts = trackSync(page)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-run-state')).toHaveText('确认版本冲突')
  await expect(page.locator('.ws-head-run [role=alert]')).toContainText('VERSION_CONFLICT')
  await expect(page.locator('.ws-head-run [role=alert]')).toContainText('04A')
  // 结论只解释一次：同一句中文说明不重复出现（错误码本身来自结论与服务消息两处）
  const conflictText = await page.locator('.ws-head-run [role=alert]').innerText()
  expect(conflictText.split('服务端确认版本已变化').length - 1).toBe(1)
  await expect(page.getByRole('button', { name: '核对原请求并重试' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
  await expect(page.locator('.view-lines')).toContainText('// mine')
  expect(posts).toHaveLength(1)

  // 服务端正文没有被覆盖，本机原请求带着拒绝事实保留
  const head = await page.evaluate(async () => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const data = (await (await fetch('/__i0prep/context', { headers })).json()).data
    return (await (await fetch(`/__i0prep/api/attempts/${data.refs.attemptId}`, { headers })).json()).data
  })
  expect(head.attempt.workspaceRevision).toBe(2)
  expect(head.files[0].text).toContain('other writer')
  expect(newestSync(await localState(page)).rejected?.code).toBe('VERSION_CONFLICT')

  // 刷新后仍是同一结论：正文保留、不自动重发、也不自动覆盖
  await page.reload()
  await expect(page.locator('.ws-run-state')).toHaveText('确认版本冲突')
  await expect(page.getByRole('button', { name: '核对原请求并重试' })).toHaveCount(0)
  await expect(page.locator('.view-lines')).toContainText('// mine')
  expect(posts).toHaveLength(1)
})

test('暂时性服务拒绝不封死工作区：保留原命令，明确重试后仍然只创建一次', async ({ page }) => {
  await start(page, 'recovery-retryable-reject')
  await create(page)
  await edit(page, 'retry body\n')
  const posts = trackSync(page)

  // 服务端真实的暂时不可用（503）：命令没有提交，但客户端不能把它当成功，也不能当永久拒绝
  expect(await setFault(page, 'fail-write')).toBe(200)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-run-state')).toHaveText('原请求已被服务拒绝')
  await expect(page.locator('.ws-head-run [role=alert]')).toContainText('PERSISTENCE_UNAVAILABLE')
  await expect(page.locator('.ws-head-run [role=alert]')).toContainText('可先核对再明确重试')
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v0')
  const rejected = newestSync(await localState(page))
  expect(rejected.rejected?.code).toBe('PERSISTENCE_UNAVAILABLE')
  expect(rejected.state).toBe('pending')

  // 故障排除后由学生明确核对：同键同正文，且服务端只创建一次
  expect(await setFault(page, 'none')).toBe(200)
  await page.getByRole('button', { name: '核对原请求并重试' }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
  expect(identities(posts).size).toBe(1)
  const accepted = newestSync(await localState(page))
  expect(accepted.state).toBe('confirmed')
  expect(accepted.rejected).toBeUndefined()
  expect((await localState(page)).workspace!.files).toHaveLength(1)
})

test('重放期间主动重读工作区，旧加载的回执不回灌当前工作区', async ({ page }) => {
  await start(page, 'recovery-stale-replay')
  await create(page)
  await edit(page, 'stale body\n')
  const posts = trackSync(page)
  expect(await setFault(page, 'drop-ack')).toBe(200)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-run-state')).toHaveText('原请求结果未知')
  expect(await setFault(page, 'none')).toBe(200)

  // 按住重放响应，在等待期间主动重读工作区（新 loadEpoch，旧客户端立即失效）
  const held = await holdAck(page)
  await page.getByRole('button', { name: '核对原请求并重试' }).click()
  await held.ready
  await edit(page, '// edited during replay\n')
  await page.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  held.release()

  // 新加载从权威 GET 读回同一作品；旧加载迟到的回执只留历史事实，不建立映射
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
  await expect(page.locator('.view-lines')).toContainText('// edited during replay')
  await expect.poll(async () => newestSync(await localState(page)).state).toBe('historical')
  const local = await localState(page)
  expect(local.workspace!.files).toHaveLength(1)
  expect(local.workspace!.files[0]!.text).toBe('stale body\n')
  expect(local.instances.every(i => i.fileId.startsWith('local-'))).toBe(true)
  expect(local.drafts[0]!.text).toContain('edited during replay')
  expect(identities(posts).size).toBe(1)
  expect(posts.length).toBeGreaterThanOrEqual(2)
})
