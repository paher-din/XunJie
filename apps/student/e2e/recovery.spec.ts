import { clickWorkspaceAction } from './workspaceControls'
import { expect, test } from '@playwright/test'
import { createHash } from 'node:crypto'
import { create, edit, holdAck, identities, localState, newestSync, setFault, start, syntheticUpdate, trackSync } from './helpers'

/**
 * I0_UI_04：断线重连只核或重放**原保存命令**。
 *
 * 全部走同一个 `npm run dev:prep` 进程与真实浏览器（Monaco、IndexedDB、HTTP）：
 * 丢 ACK 由 fixture 的 `/__i0prep/fault` 复现（服务照常提交，只是不下发响应），
 * 断线用浏览器离线复现；不另造假业务、不把超时当拒绝或成功。
 */

test('丢 ACK 后继续编辑、刷新，重放原命令只创建一次并恢复同一 fileId', async ({ page }) => {
  await start(page, 'recovery-drop-ack')
  await create(page)
  const frozenText = 'int main(void) { return 0; }\n'
  await edit(page, frozenText)
  const posts = trackSync(page)
  // 控制台诊断：学生界面不显示的技术事实在这里排障（第一条参数是事件名，第二条是结构化事实）
  // 页面会在测试中途刷新，句柄必须当场解析：事件到达时立刻取结构化事实。
  const diagnostics: Array<{ text: string; detail: Promise<Record<string, unknown>> }> = []
  page.on('console', message => {
    if (!message.text().includes('[i0-workspace]')) return
    const handle = message.args()[1]
    const detail = handle
      ? handle.jsonValue().then(value => value as Record<string, unknown>).catch(() => ({}))
      : Promise.resolve({} as Record<string, unknown>)
    diagnostics.push({ text: message.text(), detail })
  })

  expect(await setFault(page, 'drop-ack')).toBe(200)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  // 学生只看到一句话：结果未确认、草稿还在、可以重试；拿不到信封不等于拒绝或成功
  await expect(page.locator('.ws-run-state')).toHaveText('保存结果待确认')
  await expect(page.locator('.ws-head-run [role=alert]'))
    .toHaveText('这次保存的结果还没确认，草稿已保留。可以重试。')
  // 恢复态顶栏只留结论与操作（草稿流隐藏）；本机确认头仍停在上次已接受的 v0：
  // 断言可见状态与落盘事实，而不是被 display:none 藏起来的文本。
  await expect(page.locator('.ws-flow')).toBeHidden()
  expect((await localState(page)).workspace!.workspaceRevision).toBe(0)
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
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
  await expect(page.getByRole('button', { name: '重试上次保存' })).toBeVisible()
  expect(posts.length).toBe(afterDrop)

  // 排障需要的事实（命令键、clientId/seq、代际、冻结正文摘要）只在控制台，不进学生界面
  const pending = newestSync(await localState(page))
  const body = JSON.parse(pending.wireJson)
  const sentEvent = diagnostics.filter(entry => entry.text.includes('command.sent'))
  expect(sentEvent.length).toBeGreaterThan(0)
  const sent = await sentEvent[sentEvent.length - 1]!.detail
  expect(sent.commandKey).toBe(pending.commandKey)
  expect(sent.clientId).toBe(body.clientId)
  expect(sent.clientSeq).toBe(body.clientSeq)
  expect(sent.recoveryGeneration).toBe(body.recoveryGeneration)
  expect(sent.files).toEqual([{ label: 'main.c', bytes: 29,
    hash: createHash('sha256').update(frozenText, 'utf8').digest('hex') }])

  // 学生界面不得出现任何技术事实
  const visible = await page.locator('.ws-head').innerText()
  for (const leaked of [pending.commandKey, body.clientId, body.recoveryGeneration, '/api/', 'sync', 'hash']) {
    expect(visible).not.toContain(leaked)
  }

  // 重放：同键、同正文、同代际，服务返回原回执，不产生第二次创建
  expect(await setFault(page, 'none')).toBe(200)
  await page.getByRole('button', { name: '重试上次保存' }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
  await expect(page.getByRole('button', { name: '重试上次保存' })).toHaveCount(0)
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
  await expect(page.locator('.ws-run-state')).toHaveText('保存结果待确认')
  await expect(page.locator('.ws-flow')).toBeHidden()
  // 断线时继续编辑仍写入本机草稿
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.insertText('// still editing\n')
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')

  await context.setOffline(false)
  await page.reload()
  await expect(page.locator('.cw')).toBeVisible()
  await expect(page.locator('.view-lines')).toContainText('still editing')
  await expect(page.getByRole('button', { name: '重试上次保存' })).toBeVisible()
  // 断线期间请求根本没有离开浏览器；重连读回后也不自动补发
  expect(posts).toHaveLength(0)

  await page.getByRole('button', { name: '重试上次保存' }).click()
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
  await expect(page.locator('.ws-run-state')).toHaveText('保存结果待确认')
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
  await other.getByRole('button', { name: '重试上次保存' }).click()
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
  await expect(other.getByRole('button', { name: '重试上次保存' })).toBeVisible()
  await other.getByRole('button', { name: '重试上次保存' }).click()
  await expect(other.locator('.ws-head-run [role=alert]')).toHaveText('另一个标签页正在处理这次保存，请稍后再试。')
  await expect(other.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
  expect(otherPosts).toEqual([])

  held.release()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
  await expect(other.locator('.ws-flow')).toContainText('确认作品 v1')
  expect(posts).toHaveLength(1)
})

test('RECOVERY_REQUIRED 停止旧重试，重新读取后仍保留草稿与旧事实', async ({ page }) => {
  await start(page, 'recovery-required')
  await create(page)
  await edit(page, 'gen1 body\n')
  const posts = trackSync(page)

  expect(await setFault(page, 'drop-ack')).toBe(200)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-run-state')).toHaveText('保存结果待确认')
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

  // 核对原请求：服务拒绝 RECOVERY_REQUIRED → 停止旧重试，只提示重新读取
  await page.getByRole('button', { name: '重试上次保存' }).click()
  await expect(page.locator('.ws-run-state')).toHaveText('需要重新读取')
  await expect(page.getByRole('button', { name: '重试上次保存' })).toHaveCount(0)
  await expect(page.locator('.ws-head-run [role=alert]')).toHaveText('这里的工作区已经过期，草稿已保留。请先重新读取，再决定怎么保存。')
  await expect(page.getByRole('button', { name: '重新读取' })).toBeVisible()
  await expect(page.locator('.view-lines')).toContainText('gen1 body')
  expect(identities(posts).size).toBe(1)
  expect(newestSync(await localState(page)).rejected?.code).toBe('RECOVERY_REQUIRED')

  // 重新读取：服务已经明确拒绝过这条旧代际原命令 → 只留事实，不再要求重读、也不再挡新保存
  const beforeReload = posts.length
  await clickWorkspaceAction(page, '重新读取')
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await expect(page.locator('.ws-run-state')).toHaveText('上一次保存已过期')
  await expect(page.locator('.ws-head-run [role=alert]')).toHaveText('上一次保存没有生效，草稿还在，可以重新保存。')
  await expect(page.getByRole('button', { name: '重试上次保存' })).toHaveCount(0)
  await expect(page.locator('.view-lines')).toContainText('gen1 body')
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeEnabled()
  expect(posts.length).toBe(beforeReload)

  // 用**新的键与序号**在当前代际重新保存：服务端接受，旧原命令保持历史事实
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
  expect(posts.length).toBe(beforeReload + 1)
  expect(identities(posts).size).toBe(2)
  const syncRows = (await localState(page)).commands.filter(c => c.kind === 'workspace.sync')
  expect(syncRows.some(r => r.state === 'pending')).toBe(true)
  expect(syncRows.some(r => r.state === 'confirmed')).toBe(true)

  // 刷新后结论与正文都不变：旧命令不会复活，也不自动补发
  await page.reload()
  await expect(page.locator('.view-lines')).toContainText('gen1 body')
  await expect(page.getByRole('button', { name: '重试上次保存' })).toHaveCount(0)
  expect(posts.length).toBe(beforeReload + 1)
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
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
  await expect(page.locator('.ws-run-state')).toHaveText('作品有更新')
  // 学生只看到「作品在别处有了新的版本，请比较两个版本后再决定」；VERSION_CONFLICT 等内部说法不得出现
  await expect(page.locator('.ws-head-run [role=alert]'))
    .toHaveText('作品在别处有了新的版本，草稿已保留。请比较两个版本后再决定怎么保存。')
  // 04A 已交付：顶栏出现「比较双方正文」入口；在学生明确选择之前，保存仍被挡住且说清原因
  await expect(page.locator('.ws-head-run [role=alert]')).toBeVisible()
  expect(await page.locator('.ws-head').innerText()).not.toContain('VERSION_CONFLICT')
  await expect(page.getByRole('button', { name: '重试上次保存' })).toHaveCount(0)
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
  await expect(page.locator('.ws-run-state')).toHaveText('作品有更新')
  await expect(page.getByRole('button', { name: '重试上次保存' })).toHaveCount(0)
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
  await expect(page.locator('.ws-run-state')).toHaveText('保存未成功')
  await expect(page.locator('.ws-head-run [role=alert]')).toHaveText('服务暂时没能保存，草稿已保留。可以稍后重试。')
  await expect(page.locator('.ws-flow')).toBeHidden()
  expect((await localState(page)).workspace!.workspaceRevision).toBe(0)
  const rejected = newestSync(await localState(page))
  expect(rejected.rejected?.code).toBe('PERSISTENCE_UNAVAILABLE')
  expect(rejected.state).toBe('pending')

  // 故障排除后由学生明确核对：同键同正文，且服务端只创建一次
  expect(await setFault(page, 'none')).toBe(200)
  await page.getByRole('button', { name: '重试上次保存' }).click()
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
  await expect(page.locator('.ws-run-state')).toHaveText('保存结果待确认')
  expect(await setFault(page, 'none')).toBe(200)

  // 按住重放响应，在等待期间主动重读工作区（新 loadEpoch，旧客户端立即失效）
  const held = await holdAck(page)
  await page.getByRole('button', { name: '重试上次保存' }).click()
  await held.ready
  await edit(page, '// edited during replay\n')
  await clickWorkspaceAction(page, '重新读取')
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
