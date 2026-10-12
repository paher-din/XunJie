import { test, expect, type Page } from '@playwright/test'
import { PREP_URL, PREP_TASK_PATH } from './env'
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
  await input.fill(name); await input.press('Enter')
  await expect(page.locator('.monaco-editor textarea').first()).toBeAttached()
}
async function type(page: Page, text: string) {
  const input = page.locator('.monaco-editor textarea').first()
  await input.focus(); await page.keyboard.insertText(text)
}

test('学生主动创建、保存、冻结与刷新读回同一作品和快照', async ({ page }) => {
  const posts: string[] = []
  page.on('request', r => { if (r.method() === 'POST' && r.url().includes('/attempts')) posts.push(r.url()) })
  await page.goto(sceneUrl('confirm-normal'))
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  expect(posts).toEqual([])
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  await expect(page.locator('.cw')).toBeVisible()
  await create(page)
  await type(page, 'int main(void) { return 0; }\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.locator('.ws-head-run summary')).toContainText('快照详情 v1')
  await page.locator('.ws-head-run summary').click()
  const detail = await page.locator('.ws-head-run details').innerText()
  await type(page, '// newer draft\n')
  await page.waitForTimeout(550)
  await page.reload()
  await expect(page.locator('.ws-head-run summary')).toContainText('快照详情 v1')
  await page.locator('.ws-head-run summary').click()
  expect(await page.locator('.ws-head-run details').innerText()).toBe(detail)
  await expect(page.locator('.view-lines')).toContainText('newer draft')
  await expect(page.locator('.ws-flow')).toContainText('1 个文件未确认')
  expect(posts.filter(u => /\/attempts$/.test(u))).toHaveLength(1)
})

async function localState(page: Page) {
  return page.evaluate(async () => {
    const { confirmationRepository } = await import('/src/workspace/confirmationDb.ts' as string)
    const scenarioId = new URLSearchParams(location.search).get('scenario')!
    const data = (await (await fetch('/__i0prep/context', { headers: { 'x-i0prep-scenario': scenarioId } })).json()).data
    const c = { mode: 'preparation', userId: data.syntheticAccount.userId, courseId: data.syntheticAccount.courseId,
      assignmentId: data.refs.assignmentId, activityVersionId: data.refs.activityVersionId, attemptId: data.refs.attemptId,
      loadEpoch: 0, preparationEpoch: data.preparationEpoch, trustedRecoveryGeneration: data.recoveryGeneration, scenarioId }
    return confirmationRepository.read(c)
  })
}
async function holdAck(page: Page) {
  let release!: () => void, arrived!: () => void
  const wait = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { arrived = r })
  await page.route('**/api/attempts/*/sync', async route => {
    const response = await route.fetch()
    arrived(); await wait
    await route.fulfill({ response })
  })
  return { ready, release }
}

test('保存等待期间继续编辑，确认只取冻结原文且不换 model 身份', async ({ page }) => {
  await start(page, 'confirm-editing')
  await create(page); await type(page, 'old text\n')
  const held = await holdAck(page)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await held.ready
  await type(page, 'new draft\n')
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
  held.release()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
  await expect(page.locator('.ws-flow')).toContainText('1 个文件未确认')
  await expect(page.locator('.view-lines')).toContainText('new draft')
  const local = await localState(page)
  expect(local.workspace.files[0].text).toBe('old text\n')
  expect(local.drafts[0].text).toContain('new draft')
  expect(local.instances[0].clientFileKey).toContain('local-')
  expect(local.instances[0].fileId).toBe(local.workspace.files[0].fileId)
  await page.reload()
  await expect(page.locator('.view-lines')).toContainText('new draft')
  await expect(page.locator('.cw-filetab-main')).toHaveCount(1)
})

for (const stage of ['mapping', 'head', 'drafts', 'outbox'] as const) {
  test(`ACK ${stage} 后 abort 全回滚，刷新只重放原命令恢复同 fileId`, async ({ page }) => {
    await start(page, `confirm-abort-${stage}`)
    await create(page); await type(page, 'sent body\n')
    await page.evaluate(async stage => {
      const { setConfirmationAbortStage } = await import('/src/workspace/confirmationDb.ts' as string)
      setConfirmationAbortStage(stage)
    }, stage)
    await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
    await page.evaluate(async () => {
      const db = await import('/src/workspace/draftDb.ts' as string)
      const header = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
      const context = (await (await fetch('/__i0prep/context', { headers: header })).json()).data
      const repo = await import('/src/workspace/confirmationDb.ts' as string)
      const local = await repo.confirmationRepository.read({ mode: 'preparation', userId: context.syntheticAccount.userId, attemptId: context.refs.attemptId })
      await db.idbDraftRepository.keepCandidate(local.drafts[0].clientFileKey, 'other candidate', 'synthetic conflict')
    })
    const held = await holdAck(page)
    const originalRequests: Array<{ key: string; body: string }> = []
    page.on('request', r => {
      if (r.method() === 'POST' && r.url().endsWith('/sync')) originalRequests.push({ key: r.headers()['idempotency-key']!, body: r.postData()! })
    })
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await held.ready
    await type(page, 'kept after send\n')
    await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
    held.release()
    await expect(page.locator('.ws-head-run [role=alert]')).toContainText('本机确认记录未完成')
    const failed = await localState(page)
    expect(failed.workspace.workspaceRevision).toBe(0)
    expect(failed.instances.every((i: { fileId: string }) => i.fileId.startsWith('local-'))).toBe(true)
    expect(failed.commands.find((c: { kind: string }) => c.kind === 'workspace.sync').state).toBe('pending')
    expect(failed.drafts[0].text).toContain('kept after send')
    expect(failed.candidates[0].text).toBe('other candidate')
    expect(JSON.stringify(failed.commands)).not.toContain('csrfToken')
    await page.unroute('**/api/attempts/*/sync')
    await page.reload()
    await expect(page.getByRole('button', { name: '核对原请求并重试' })).toBeVisible()
    await page.getByRole('button', { name: '核对原请求并重试' }).click()
    await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
    await expect(page.getByRole('button', { name: '核对原请求并重试' })).toHaveCount(0)
    await expect(page.locator('.cw-filetab-main')).toHaveCount(1)
    await expect(page.locator('.view-lines')).toContainText('kept after send')
    expect(originalRequests).toHaveLength(2)
    expect(originalRequests[1]).toEqual(originalRequests[0])
    const recovered = await localState(page)
    expect(recovered.workspace.files).toHaveLength(1)
    expect(recovered.workspace.files[0].text).toBe('sent body\n')
    expect(recovered.instances[0].fileId).toBe(recovered.workspace.files[0].fileId)
    // 同 ACK 可重复接纳，仍保持同实例、原文与较新草稿。
    const again = await page.evaluate(async () => {
      const db = await import('/src/workspace/confirmationDb.ts' as string)
      const validation = await import('/src/workspace/frozenCommand.ts' as string)
      const scene = new URLSearchParams(location.search).get('scenario')!
      const all = await db.confirmationRepository.commands({ mode: 'preparation', userId: 'prep-student-01', assignmentId: 'prep-assignment-textscope-c-01', scenarioId: scene })
      const command = all.find((c: { kind: string }) => c.kind === 'workspace.sync')
      const ack = await validation.verifySyncReceipt(command, command.receipt)
      await db.confirmationRepository.acknowledge(command, ack.receipt, ack.workspace, ack.mappings, null, () => true)
      return db.confirmationRepository.read(command.context)
    })
    expect(again.workspace.files).toHaveLength(1)
    expect(again.drafts[0].text).toContain('kept after send')
    expect(again.candidates[0].text).toBe('other candidate')
  })
}

test('混合 EOL/BOM/非 BMP 草稿经真实保存与 snapshot GET 字节不变', async ({ page }) => {
  await start(page, 'confirm-original')
  await create(page)
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
  const raw = '\uFEFF中文😀\r\nsecond\rthird\n\n'
  const seeded = await page.evaluate(async text => {
    const db = await import('/src/workspace/draftDb.ts' as string)
    const confirmation = await import('/src/workspace/confirmationDb.ts' as string)
    const scenarioId = new URLSearchParams(location.search).get('scenario')!
    const data = (await (await fetch('/__i0prep/context', { headers: { 'x-i0prep-scenario': scenarioId } })).json()).data
    const c = { mode: 'preparation', userId: data.syntheticAccount.userId, attemptId: data.refs.attemptId, scenarioId }
    const draft = (await confirmation.confirmationRepository.read(c)).drafts[0]
    return db.idbDraftRepository.saveDraft({ ...draft, text }, draft.draftRevision)
  }, raw)
  expect(seeded.ok).toBe(true)
  await page.reload()
  await expect(page.locator('.view-lines')).toContainText('中文😀')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.locator('.ws-head-run summary')).toContainText('快照详情 v1')
  const state = await localState(page)
  expect(state.workspace.files[0].text).toBe(raw)
  const snapshot = await page.evaluate(async () => {
    const scenarioId = new URLSearchParams(location.search).get('scenario')!
    const headers = { 'x-i0prep-scenario': scenarioId }
    const context = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const id = context.refs.attemptId
    const head = (await (await fetch(`/__i0prep/api/attempts/${id}`, { headers })).json()).data
    return (await (await fetch(`/__i0prep/api/attempts/${id}/snapshots/${head.snapshots[0].snapshotId}`, { headers })).json()).data
  })
  expect(snapshot.files[0].text).toBe(raw)
  expect(snapshot.files[0].contentHash).toBe(state.workspace.files[0].contentHash)
})

test('另一标签推进 head 后迟到旧 ACK 只记历史，不回退头或映射', async ({ page, context }) => {
  await start(page, 'confirm-two-tabs')
  await create(page); await type(page, 'first body\n')
  const held = await holdAck(page)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await held.ready
  const other = await context.newPage()
  await other.goto(page.url())
  // 新标签读取确认 head，不把尚未落本机的旧 ACK 当最新状态；原请求仍只能重放。
  await expect(other.locator('.cw')).toBeVisible()
  await expect(other.getByRole('button', { name: '核对原请求并重试' })).toBeVisible()
  // 在另一标签通过公开客户端核原命令（同键服务端幂等）；测试仅释放 lease，模拟原标签崩溃失去发件租约。
  await other.evaluate(async () => {
    const db = await import('/src/workspace/confirmationDb.ts' as string)
    const scenarioId = new URLSearchParams(location.search).get('scenario')!
    const rows = await db.confirmationRepository.commands({ mode: 'preparation', userId: 'prep-student-01', assignmentId: 'prep-assignment-textscope-c-01', scenarioId })
    const original = rows.find((r: { kind: string; state: string }) => r.kind === 'workspace.sync' && r.state === 'pending')
    await db.confirmationRepository.release(original.commandKey, original.lease.owner)
  })
  await other.getByRole('button', { name: '核对原请求并重试' }).click()
  await expect(other.getByRole('button', { name: '核对原请求并重试' })).toHaveCount(0)
  await type(other, '// second head\n')
  await other.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(other.locator('.ws-flow')).toContainText('确认作品 v2')
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v2')
  held.release()
  await expect(page.getByRole('button', { name: '核对原请求并重试' })).toHaveCount(0)
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v2')
  const local = await localState(page)
  expect(local.workspace.workspaceRevision).toBe(2)
  expect(local.workspace.files[0].text).toContain('second head')
  expect(local.instances[0].fileId).toBe(local.workspace.files[0].fileId)
  const writes = local.commands.filter((r: { kind: string }) => r.kind === 'workspace.sync').sort((a: { createdAt: number }, b: { createdAt: number }) => a.createdAt - b.createdAt)
  expect(writes[0].state).toBe('historical')
  expect(JSON.parse(writes[0].wireJson).clientId).not.toBe(JSON.parse(writes[1].wireJson).clientId)
})

test('g2 回退头读取后 g1 ACK 到达，只保留旧请求事实与草稿', async ({ page }) => {
  await start(page, 'confirm-generation')
  await create(page); await type(page, 'g1 body\n')
  const held = await holdAck(page)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await held.ready
  const rotated = await page.evaluate(async () => {
    const scenarioId = new URLSearchParams(location.search).get('scenario')!
    const headers = { 'x-i0prep-scenario': scenarioId }
    const data = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const response = await fetch('/__i0prep/recover', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ attemptId: data.refs.attemptId, workspaceRevision: 0 }) })
    return { status: response.status, before: data.recoveryGeneration, after: (await response.json()).data.recoveryGeneration }
  })
  expect(rotated.status).toBe(200); expect(rotated.after).not.toBe(rotated.before)
  await page.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v0')
  await expect(page.locator('.ws-head-run [role=alert]')).toContainText('须重新比较')
  held.release()
  await expect.poll(async () => (await localState(page)).commands.find((r: { kind: string }) => r.kind === 'workspace.sync').state).toBe('historical')
  const local = await localState(page)
  expect(local.workspace.workspaceRevision).toBe(0)
  expect(local.workspace.files).toHaveLength(0)
  expect(local.instances.every((i: { fileId: string }) => i.fileId.startsWith('local-'))).toBe(true)
  expect(local.drafts[0].text).toContain('g1 body')
  await expect(page.locator('.view-lines')).toContainText('g1 body')
})

test('同身份退出再进入后迟到 ACK 不接纳到当前加载', async ({ page }) => {
  await start(page, 'confirm-logout')
  await create(page); await type(page, 'before logout\n')
  const held = await holdAck(page)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await held.ready
  await page.getByRole('button', { name: '结束准备会话', exact: true }).click()
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1')
  held.release()
  await expect.poll(async () => (await localState(page)).commands.find((r: { kind: string }) => r.kind === 'workspace.sync').state).toBe('historical')
  const local = await localState(page)
  expect(local.instances.every((i: { fileId: string }) => i.fileId.startsWith('local-'))).toBe(true)
  expect(local.drafts[0].text).toContain('before logout')
  // GET 可读服务已确认成果，但旧加载的 ACK 不私自建立当前文件映射。
  expect(local.workspace.workspaceRevision).toBe(1)
})

test('摘要不符的 snapshot GET 不显示快照成功，原请求保留', async ({ page }) => {
  await start(page, 'confirm-hash-reject')
  await create(page); await type(page, 'confirmed\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')
  await page.route('**/api/attempts/*/snapshots/*', async route => {
    const response = await route.fetch(), body = await response.json()
    body.data.files[0].text += 'corrupted'
    await route.fulfill({ response, json: body })
  })
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.locator('.ws-head-run [role=alert]')).toContainText('摘要不符')
  await expect(page.locator('.ws-head-run summary')).toHaveCount(0)
  expect((await localState(page)).commands.find((r: { kind: string }) => r.kind === 'snapshot.create').state).toBe('pending')
})

test('v1 增量升级保留草稿，跨标签序号事务不复用，中断原命令只跳号', async ({ page, context }) => {
  await page.goto(PREP_URL)
  const result = await page.evaluate(async () => {
    const key = 'preparation\0synthetic-seq-account\0synthetic-seq-attempt\0file-local'
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('xunjie-i0-workspace', 1)
      request.onupgradeneeded = () => {
        for (const [store, keyPath] of [['drafts', 'clientFileKey'], ['ui', 'scopeKey'], ['instances', 'clientFileKey'], ['confirmed', 'clientFileKey'], ['candidates', 'id']]) {
          request.result.createObjectStore(store!, { keyPath, autoIncrement: store === 'candidates' })
        }
      }
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const db = request.result, tx = db.transaction('drafts', 'readwrite')
        tx.objectStore('drafts').put({ clientFileKey: key, fileId: 'file-local', text: '\uFEFFlegacy\r\n😀', draftRevision: 8, updatedAt: 1 })
        tx.oncomplete = () => { db.close(); resolve() }; tx.onabort = () => reject(tx.error)
      }
    })
    const { idbDraftRepository } = await import('/src/workspace/draftDb.ts' as string)
    const { confirmationRepository } = await import('/src/workspace/confirmationDb.ts' as string)
    const c = { mode: 'preparation', userId: 'synthetic-seq-account', attemptId: 'synthetic-seq-attempt' }
    const seq = await confirmationRepository.reserveSeq(c, 'synthetic-shared-client')
    return { draft: await idbDraftRepository.loadDraft(key), seq }
  })
  expect(result.draft.text).toBe('\uFEFFlegacy\r\n😀')
  expect(result.draft.draftRevision).toBe(8)
  expect(result.seq).toBe(1)
  const other = await context.newPage(); await other.goto(PREP_URL)
  const reserve = (p: Page) => p.evaluate(async () => {
    const { confirmationRepository } = await import('/src/workspace/confirmationDb.ts' as string)
    return confirmationRepository.reserveSeq({ mode: 'preparation', userId: 'synthetic-seq-account', attemptId: 'synthetic-seq-attempt' }, 'synthetic-shared-client')
  })
  const seqs = await Promise.all([reserve(page), reserve(other)])
  expect(seqs.sort()).toEqual([2, 3])
  // 序号 3 已提交，若紧接着保护原命令失败，也不能回退到 3。
  const next = await page.evaluate(async () => {
    const { confirmationRepository } = await import('/src/workspace/confirmationDb.ts' as string)
    try { await confirmationRepository.persist({ commandKey: 'synthetic-interrupted', wireJson: '{}', context: {} }, () => false) } catch {}
    if (await confirmationRepository.command('synthetic-interrupted') !== null) throw new Error('失败命令被写入')
    return confirmationRepository.reserveSeq({ mode: 'preparation', userId: 'synthetic-seq-account', attemptId: 'synthetic-seq-attempt' }, 'synthetic-shared-client')
  })
  expect(next).toBe(4)
})

async function syntheticUpdate(page: Page, text: string) {
  return page.evaluate(async text => {
    const scenarioId = new URLSearchParams(location.search).get('scenario')!, headers = { 'x-i0prep-scenario': scenarioId }
    const c = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const head = (await (await fetch(`/__i0prep/api/attempts/${c.refs.attemptId}`, { headers })).json()).data
    const file = head.files[0]
    const response = await fetch(`/__i0prep/api/attempts/${c.refs.attemptId}/sync`, { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ recoveryGeneration: c.recoveryGeneration, expectedWorkspaceRevision: head.attempt.workspaceRevision,
        clientId: crypto.randomUUID(), clientSeq: 1, operations: [{ kind: 'update', fileId: file.fileId, baseVersion: file.documentVersion, text }] }) })
    return response.status
  }, text)
}

test('同一对象两次 GET 逆序返回，旧读不覆盖较新已接纳 head', async ({ page }) => {
  await start(page, 'confirm-read-order')
  await create(page); await type(page, 'v1\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')
  await page.evaluate(async () => {
    const { ConfirmationWorkspace } = await import('/src/workspace/confirmationWorkspace.ts' as string)
    const scenarioId = new URLSearchParams(location.search).get('scenario')!, headers = { 'x-i0prep-scenario': scenarioId }
    const c = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const reader = new ConfirmationWorkspace({ mode: 'preparation', userId: c.syntheticAccount.userId, courseId: c.syntheticAccount.courseId,
      assignmentId: c.refs.assignmentId, activityVersionId: c.refs.activityVersionId, attemptId: c.refs.attemptId,
      trustedRecoveryGeneration: c.recoveryGeneration, preparationEpoch: c.preparationEpoch, loadEpoch: 100, scenarioId })
    ;(globalThis as unknown as { reader: typeof reader }).reader = reader
    await reader.initialize()
  })
  let release!: () => void, arrived!: () => void, reads = 0
  const held = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { arrived = r })
  await page.route('**/api/attempts/*', async route => {
    if (route.request().method() !== 'GET' || ++reads !== 1) return route.continue()
    const response = await route.fetch(); arrived(); await held; await route.fulfill({ response })
  })
  const earlier = page.evaluate(() => (globalThis as unknown as { reader: { readHead: () => Promise<unknown> } }).reader.readHead())
  await ready
  expect(await syntheticUpdate(page, 'v2\n')).toBe(200)
  await page.evaluate(() => (globalThis as unknown as { reader: { readHead: () => Promise<unknown> } }).reader.readHead())
  release(); await earlier
  const current = await page.evaluate(() => {
    const r = (globalThis as unknown as { reader: { current: unknown; dispose: () => void } }).reader
    const state = r.current; r.dispose(); return state
  }) as { workspace: { workspaceRevision: number; files: Array<{ text: string }> } }
  expect(current.workspace.workspaceRevision).toBe(2)
  expect(current.workspace.files[0]?.text).toBe('v2\n')
})

test('整批保存被拒绝时服务端不部分创建，草稿和原命令保留', async ({ page }) => {
  await start(page, 'confirm-reject')
  await create(page); await type(page, 'original\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')
  await type(page, 'changed\n')
  await page.locator('.cw-stripbtn').click()
  await page.getByRole('menuitem', { name: '新建文件', exact: true }).click()
  await page.getByRole('textbox', { name: '新文件名' }).fill('extra.c')
  await page.getByRole('textbox', { name: '新文件名' }).press('Enter')
  await type(page, 'new file\n')
  await page.route('**/api/attempts/*/sync', async route => {
    const body = JSON.parse(route.request().postData()!)
    body.operations.find((o: { kind: string }) => o.kind === 'update').baseVersion = 999
    await route.continue({ postData: JSON.stringify(body) })
  })
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-head-run [role=alert]')).toContainText('VERSION_CONFLICT')
  const authoritative = await page.evaluate(async () => {
    const scenario = new URLSearchParams(location.search).get('scenario')!, headers = { 'x-i0prep-scenario': scenario }
    const context = (await (await fetch('/__i0prep/context', { headers })).json()).data
    return (await (await fetch(`/__i0prep/api/attempts/${context.refs.attemptId}`, { headers })).json()).data
  })
  expect(authoritative.files).toHaveLength(1)
  expect(authoritative.files[0].text).toBe('original\n')
  const local = await localState(page)
  expect(local.drafts.some((d: { text: string }) => d.text.includes('new file'))).toBe(true)
  const pending = local.commands.find((r: { kind: string; state: string }) => r.kind === 'workspace.sync' && r.state === 'pending')
  expect(pending).toBeTruthy()
  expect(JSON.parse(pending.wireJson).operations.find((o: { kind: string }) => o.kind === 'update').baseVersion).toBe(1)
})

test('同 revision 的不同确认摘要不可按到达顺序接纳', async ({ page }) => {
  await start(page, 'confirm-same-revision')
  await create(page); await type(page, 'original\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')
  const hash = await page.evaluate(async () => {
    const { textHash } = await import('/src/workspace/confirmation.ts' as string)
    return textHash('contradiction\n')
  })
  await page.route('**/api/attempts/*', async route => {
    if (route.request().method() !== 'GET') return route.continue()
    const response = await route.fetch(), body = await response.json()
    body.data.files[0].text = 'contradiction\n'; body.data.files[0].contentHash = hash
    await route.fulfill({ response, json: body })
  })
  await page.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(page.locator('.ws-head-run [role=alert]')).toContainText('同版本确认清单冲突')
  const local = await localState(page)
  expect(local.workspace.workspaceRevision).toBe(1)
  expect(local.workspace.files[0].text).toBe('original\n')
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeDisabled()
})

test('另一标签安装 g2 后旧 g1 ACK 和旧 GET 都不能回退持久确认头', async ({ page, context }) => {
  await start(page, 'confirm-generation-tabs')
  await create(page); await type(page, 'g1 body\n')
  const held = await holdAck(page)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await held.ready
  const oldContext = (await localState(page)).commands.find((c: { kind: string }) => c.kind === 'workspace.sync').context
  await page.evaluate(async () => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const data = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const response = await fetch('/__i0prep/recover', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ attemptId: data.refs.attemptId, workspaceRevision: 0 }) })
    if (!response.ok) throw new Error('recovery failed')
  })
  const other = await context.newPage()
  await other.goto(page.url())
  await expect(other.locator('.ws-flow')).toContainText('确认作品 v0')
  held.release()
  await expect.poll(async () => (await localState(other)).commands.find((r: { kind: string }) => r.kind === 'workspace.sync').state).toBe('historical')
  const current = await localState(other)
  expect(current.workspace.workspaceRevision).toBe(0)
  expect(current.instances.every((i: { fileId: string }) => i.fileId.startsWith('local-'))).toBe(true)
  const staleRead = await page.evaluate(async c => {
    const { confirmationRepository } = await import('/src/workspace/confirmationDb.ts' as string)
    try { await confirmationRepository.installHead(c, { attemptId: c.attemptId, workspaceRevision: 0, files: [] }, () => true); return 'accepted' }
    catch { return 'rejected' }
  }, oldContext)
  expect(staleRead).toBe('rejected')
  expect((await localState(other)).workspace.workspaceRevision).toBe(0)
})

test('已确认文件在 g2 回退后仍可打开原草稿，不能当新文件补发', async ({ page }) => {
  await start(page, 'confirm-detached-draft')
  await create(page); await type(page, 'confirmed body\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')
  await type(page, 'retained newer draft\n')
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
  await page.evaluate(async () => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const data = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    await fetch('/__i0prep/recover', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ attemptId: data.refs.attemptId, workspaceRevision: 0 }) })
  })
  await page.reload()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v0')
  await expect(page.locator('.view-lines')).toContainText('retained newer draft')
  const posts: string[] = []
  page.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/sync')) posts.push(r.url()) })
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-head-run [role=alert]')).toContainText('需要重新比较')
  expect(posts).toEqual([])
})

test('快照 GET 清单的 ID 顺序不覆盖刚冻结的快照', async ({ page }) => {
  await start(page, 'confirm-snapshot-order')
  await create(page); await type(page, 'v1\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.locator('.ws-head-run summary')).toContainText('快照详情 v1')
  await type(page, 'v2\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v2 · 与草稿一致')
  await page.route('**/api/attempts/*', async route => {
    const response = await route.fetch(), body = await response.json()
    body.data.snapshots.reverse()
    await route.fulfill({ response, json: body })
  })
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.locator('.ws-head-run summary')).toContainText('快照详情 v2')
  await page.reload()
  await expect(page.locator('.ws-head-run summary')).toContainText('快照详情 v2')
})

test('首次创建 ACK 未绑定 Attempt 时也不能覆盖另一标签已接纳 g2', async ({ page, context }) => {
  await page.goto(sceneUrl('confirm-create-generation'))
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  let release!: () => void, arrived!: () => void
  const wait = new Promise<void>(r => { release = r }), ready = new Promise<void>(r => { arrived = r })
  await page.route('**/api/assignments/*/attempts', async route => {
    const response = await route.fetch()
    arrived(); await wait; await route.fulfill({ response })
  })
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  await ready
  await page.evaluate(async () => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const data = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const response = await fetch('/__i0prep/recover', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ attemptId: data.refs.attemptId, workspaceRevision: 0 }) })
    if (!response.ok) throw new Error('recovery failed')
  })
  const other = await context.newPage()
  await other.goto(page.url())
  await expect(other.locator('.ws-flow')).toContainText('确认作品 v0')
  release()
  await expect.poll(async () => (await localState(other)).commands.find((c: { kind: string }) => c.kind === 'attempt.create').state).toBe('historical')
  expect((await localState(other)).workspace.workspaceRevision).toBe(0)
  await other.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(other.locator('.ws-flow')).toContainText('确认作品 v0')
  await expect(other.locator('.ws-head-run [role=alert]')).toHaveCount(0)
})

test('创建事务已提交但 UI 还在 await 时切换 g2，旧后续读取不能退休 g2', async ({ page, context }) => {
  await page.goto(sceneUrl('confirm-create-after-commit'))
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await page.evaluate(async () => {
    const { confirmationRepository: repo } = await import('/src/workspace/confirmationDb.ts' as string)
    const original = repo.command.bind(repo)
    const gate = window as unknown as { ackHeld: boolean; releaseAck: () => void }
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    gate.releaseAck = release
    repo.command = async (key: string) => {
      const row = await original(key)
      if (row?.kind === 'attempt.create' && row.state === 'confirmed') { gate.ackHeld = true; await held }
      return row
    }
  })
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { ackHeld: boolean }).ackHeld)).toBe(true)
  await page.evaluate(async () => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const data = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    await fetch('/__i0prep/recover', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ attemptId: data.refs.attemptId, workspaceRevision: 0 }) })
  })
  const other = await context.newPage()
  await other.goto(page.url())
  await expect(other.locator('.ws-flow')).toContainText('确认作品 v0')
  await page.evaluate(() => (window as unknown as { releaseAck: () => void }).releaseAck())
  await expect(page.locator('.ws-head-run [role=alert]')).toBeVisible()
  expect((await localState(other)).workspace.workspaceRevision).toBe(0)
  await other.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(other.locator('.ws-flow')).toContainText('确认作品 v0')
  await expect(other.locator('.ws-head-run [role=alert]')).toHaveCount(0)
})
