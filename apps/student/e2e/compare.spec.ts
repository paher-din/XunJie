import { expect, test, type Page } from '@playwright/test'
import { PREP_TASK_PATH, PREP_URL } from './env'

/**
 * I0_UI_04A：多标签与服务版本冲突的比较与选择。
 *
 * 覆盖的验收点：
 * 1. 服务 CAS 拒绝（VERSION_CONFLICT）→「比较双方正文」入口 → 只读比较（version-conflict，
 *    diff 左=本机正文 右=当前作品）→「保留本页正文」退役原命令（state=historical、rejected.code 保留）
 *    → 下一次保存用新键/新 seq/当前权威预期版本成功。
 * 2. 「采用服务端正文」先把当前作品正文写回本页草稿，再退役原命令；入口随未决清空而消失。
 * 3. 两标签本机草稿 CAS 冲突：冲突条出现 →「载入另一处正文」载入库中赢方 → 再冲突 →
 *    「用本页正文继续」遇「选择期间另一处又写入」保持冲突条（conflict-again）→ 再次选择 resolved →
 *    确认保存落为 v2。
 * 4. 键盘进入/离开比较：Enter 打开只读比较，Esc 关闭并回到编辑器。
 * 5. 恢复换代（RECOVERY_REQUIRED）：重新读取后旧代际未决命令以 recovery 比较打开（服务端回退后
 *    还没有这个文件），「保留本页正文」可退役跨代际未决命令；旧 ACK 未建立确认头（保持回退状态），
 *    之后以当前代际新键保存成功。
 *
 * 全部走同一个 `npm run dev:prep` 进程与真实浏览器（Monaco、IndexedDB、HTTP）；不造假业务，
 * 「另一处」一律由第二标签或 fixture 的合成接口充当。
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

/** 输入正文但不等待落盘；落盘结果（保护/冲突条）由调用方用 expect 等待。 */
async function type(page: Page, text: string) {
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.insertText(text)
}

/** 输入正文并等待本机草稿写入完成（保护状态恢复）。 */
async function edit(page: Page, text: string) {
  await type(page, text)
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
  instances: Array<{ fileId: string }>; drafts: Array<{ text: string }>
  commands: LocalCommand[]; candidates: Array<{ text: string; reason: string }> }

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

/** 同一原命令在传输层重试时身份必须完全相同；出现第二条身份才说明客户端新建了命令。 */
function identities(posts: Array<{ key: string; body: string }>) {
  return new Set(posts.map(p => `${p.key}\n${p.body}`))
}

/** 服务版本冲突的公共前置：v1 已确认 → 另一处推进权威 → 本页再编辑（尚未保存）。 */
async function conflictSetup(page: Page, name: string) {
  await start(page, name)
  await create(page)
  await edit(page, 'first body\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')
  expect(await syntheticUpdate(page, 'first body\n// other writer\n')).toBe(200)
  await edit(page, '// mine\n')
}

/** 读取权威 Attempt 的当前 head（不经过页面状态，直接核对服务端事实）。 */
async function serverHead(page: Page) {
  return page.evaluate(async () => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const data = (await (await fetch('/__i0prep/context', { headers })).json()).data
    return (await (await fetch(`/__i0prep/api/attempts/${data.refs.attemptId}`, { headers })).json()).data as
      { attempt: { workspaceRevision: number }; files: Array<{ text: string }> }
  })
}

test('服务版本冲突：比较 → 保留本页正文 → 退役原命令并以新键在当前权威预期版本上保存', async ({ page }) => {
  await conflictSetup(page, 'compare-keep-mine')
  const posts = trackSync(page)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-run-state')).toHaveText('作品有更新')
  await expect(page.locator('.ws-head-run [role=alert]'))
    .toHaveText('作品在别处有了新的版本，草稿已保留。请比较两个版本后再决定怎么保存。')
  expect(posts).toHaveLength(1)

  // 打开只读比较：source=version-conflict，diff 左=本机正文（mine）、右=当前作品（other writer）
  await page.getByRole('button', { name: '比较双方正文' }).click()
  const compare = page.locator(".ws-compare[data-source='version-conflict']")
  await expect(compare).toBeVisible()
  const file = compare.locator(".ws-compare-file[data-path='main.c']")
  await expect(file).toBeVisible()
  const diff = file.locator('.ws-compare-diff')
  await expect(diff.locator('.view-lines').first()).toContainText('mine')
  await expect(diff.locator('.view-lines').last()).toContainText('other writer')

  // 保留本页正文：草稿不动，退役冲突原命令，回到编辑器
  await page.getByRole('button', { name: '保留本页正文' }).click()
  await expect(page.locator('.toast')).toHaveText('已保留本页正文，可以重新保存了。')
  await expect(page.locator('.ws-compare')).toHaveCount(0)
  await expect(page.locator('.view-lines')).toContainText('mine')

  // 落盘事实：原命令退役为 historical，VERSION_CONFLICT 拒绝事实保留
  const retired = newestSync(await localState(page))
  expect(retired.state).toBe('historical')
  expect(retired.rejected?.code).toBe('VERSION_CONFLICT')

  // 重新保存：新键、新 seq、当前权威预期版本（比较打开时已重读 head，本机确认头在 v2）
  await expect(page.getByRole('button', { name: '确认保存', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v3 · 与草稿一致')
  expect(posts).toHaveLength(2)
  expect(identities(posts).size).toBe(2)
  expect(posts[1]!.key).not.toBe(posts[0]!.key)
  const rejectedBody = JSON.parse(posts[0]!.body), retryBody = JSON.parse(posts[1]!.body)
  expect(rejectedBody.expectedWorkspaceRevision).toBe(1)
  expect(retryBody.expectedWorkspaceRevision).toBe(2)
  expect(retryBody.clientSeq).toBe(rejectedBody.clientSeq + 1)
  expect(retryBody.operations[0].text).toContain('// mine')

  // 服务端最终正文是本页正文（没有丢学生的字，也没有覆盖成另一处版本）
  const head = await serverHead(page)
  expect(head.attempt.workspaceRevision).toBe(3)
  expect(head.files[0].text).toContain('// mine')
})

test('服务版本冲突：采用服务端正文写回本页草稿，原命令退役且比较入口消失', async ({ page }) => {
  await conflictSetup(page, 'compare-adopt-server')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-run-state')).toHaveText('作品有更新')

  await page.getByRole('button', { name: '比较双方正文' }).click()
  await expect(page.locator(".ws-compare[data-source='version-conflict']")).toBeVisible()
  await page.getByRole('button', { name: '采用服务端正文' }).click()
  await expect(page.locator('.toast')).toHaveText('已采用当前作品的正文，可以重新保存了。')
  await expect(page.locator('.ws-compare')).toHaveCount(0)

  // 本页草稿已被写回为当前作品的正文
  await expect(page.locator('.view-lines')).toContainText('other writer')
  // 未决清空：比较入口消失；原命令退役且拒绝事实保留
  await expect(page.getByRole('button', { name: '比较双方正文' })).toHaveCount(0)
  const retired = newestSync(await localState(page))
  expect(retired.state).toBe('historical')
  expect(retired.rejected?.code).toBe('VERSION_CONFLICT')
})

test('两标签本机草稿冲突：冲突条选择、选择期间另一处又写入、再次选择后保存', async ({ page, context }) => {
  const url = `${PREP_URL}/?scenario=compare-draft-conflict-${crypto.randomUUID()}${PREP_TASK_PATH}`
  await page.goto(url)
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  await expect(page.locator('.cw')).toBeVisible()
  await page.getByRole('button', { name: '新建文件', exact: true }).first().click()
  await page.getByRole('textbox', { name: '新文件名' }).fill('main.c')
  await page.getByRole('textbox', { name: '新文件名' }).press('Enter')
  await edit(page, '// base\n')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')

  // B 标签编辑并等它落盘成为赢家
  const other = await context.newPage()
  await other.goto(url)
  await expect(other.locator('.view-lines')).toContainText('// base')
  await edit(other, '// other-tab-winner\n')
  await expect(other.locator('.cw-protect')).toHaveAttribute('data-status', 'protected')

  // A 再编辑：CAS 落后于 B 的新修订 → 冲突条出现；库中草稿仍是赢家，败方正文留候选
  await type(page, '// this-tab-loser\n')
  await expect(page.locator('.ws-draft-conflicts')).toBeVisible()
  await expect(page.locator('.ws-draft-conflict[data-fileid]')).toHaveCount(1)
  await expect(page.locator('.ws-draft-conflict-path')).toHaveText('main.c')
  await expect(page.locator('.cw-protect')).toHaveAttribute('data-status', 'failed')
  const conflicted = await localState(page)
  expect(conflicted.drafts[0]!.text).toContain('other-tab-winner')
  expect(conflicted.candidates.some(c => c.text.includes('this-tab-loser'))).toBe(true)

  // 载入另一处正文：编辑器换成库中赢方，冲突条消失，保护恢复；候选保留
  await page.getByRole('button', { name: '载入另一处正文' }).click()
  await expect(page.locator('.toast')).toHaveText('已按你的选择更新了草稿。')
  await expect(page.locator('.ws-draft-conflicts')).toHaveCount(0)
  await expect(page.locator('.cw-protect')).toHaveAttribute('data-status', 'protected')
  await expect(page.locator('.view-lines')).toContainText('other-tab-winner')
  const afterStored = await localState(page)
  expect(afterStored.drafts[0]!.text).toContain('other-tab-winner')
  expect(afterStored.candidates.some(c => c.text.includes('this-tab-loser'))).toBe(true)

  // B 又写入一次新赢家修订（先等 B 落盘，再让 A 编辑，冲突再现是确定性的）
  await edit(other, '// b2\n')
  await expect(other.locator('.cw-protect')).toHaveAttribute('data-status', 'protected')
  await type(page, '// a2\n')
  await expect(page.locator('.ws-draft-conflicts')).toBeVisible()
  await expect(page.locator('.cw-protect')).toHaveAttribute('data-status', 'failed')

  // 「选择期间另一处又写入」发生在 resolveConflict 读取库中修订与重新 CAS 之间的核对窗口里；
  // B 标签的 400ms 节流写无法可靠命中这个毫秒级窗口，因此按本套件注入 keepCandidate 的同一做法，
  // 用同一仓库的真实 CAS 写入在该窗口内充当「另一处又写入」（一次性钩子，随即恢复原实现）。
  await page.evaluate(async () => {
    const { idbDraftRepository } = await import('/src/workspace/draftDb.ts' as string)
    const repo = idbDraftRepository as unknown as {
      saveDraft: (record: { clientFileKey: string; fileId: string; text: string; draftRevision: number; updatedAt: number },
        expected: number | null) => Promise<unknown>
    }
    const original = repo.saveDraft.bind(repo)
    repo.saveDraft = async (record, expected) => {
      repo.saveDraft = original
      await original({ ...record, text: '// during-choice-writer\n', draftRevision: (expected ?? 0) + 1 }, expected)
      return original(record, expected)
    }
  })
  await page.getByRole('button', { name: '用本页正文继续' }).click()
  await expect(page.locator('.toast')).toHaveText('选择期间另一处又写入了新的修订，请重新选择。')
  await expect(page.locator('.ws-draft-conflicts')).toBeVisible()
  await expect(page.locator('.cw-protect')).toHaveAttribute('data-status', 'failed')
  const again = await localState(page)
  expect(again.drafts[0]!.text).toContain('during-choice-writer')
  expect(again.candidates.some(c => c.text.includes('a2'))).toBe(true)

  // A 再改一次文本后再选「用本页正文继续」：对库中最新修订重新 CAS 成功 → resolved
  await type(page, '// final answer\n')
  await page.getByRole('button', { name: '用本页正文继续' }).click()
  await expect(page.locator('.toast')).toHaveText('已按你的选择更新了草稿。')
  await expect(page.locator('.ws-draft-conflicts')).toHaveCount(0)
  await expect(page.locator('.cw-protect')).toHaveAttribute('data-status', 'protected')

  // 冲突解决后可正常保存：v2，权威正文包含 A 的最终文本
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v2 · 与草稿一致')
  const head = await serverHead(page)
  expect(head.attempt.workspaceRevision).toBe(2)
  expect(head.files[0].text).toContain('final answer')
})

test('键盘进入/离开比较：Enter 打开只读比较，Esc 关闭并回到编辑器', async ({ page }) => {
  await conflictSetup(page, 'compare-keyboard')
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-run-state')).toHaveText('作品有更新')

  const entry = page.getByRole('button', { name: '比较双方正文' })
  await entry.focus()
  await page.keyboard.press('Enter')
  await expect(page.locator(".ws-compare[data-source='version-conflict']")).toBeVisible()

  await page.keyboard.press('Escape')
  await expect(page.locator('.ws-compare')).toHaveCount(0)
  // 回到编辑器：草稿正文原样保留，未决仍在（入口恢复）
  await expect(page.locator('.view-lines')).toContainText('mine')
  await expect(entry).toBeVisible()
})

test('恢复换代后比较：旧代际未决命令以 recovery 比较并退役，确认头保持回退状态，新代际保存成功', async ({ page }) => {
  await start(page, 'compare-recovery')
  await create(page)
  await edit(page, 'recovery body\n')
  const posts = trackSync(page)

  // 原命令已发出但丢 ACK；随后服务端恢复脚本换代际并回退作品
  expect(await setFault(page, 'drop-ack')).toBe(200)
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-run-state')).toHaveText('保存结果待确认')
  expect(await setFault(page, 'none')).toBe(200)
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

  // 核对原请求：服务拒绝 RECOVERY_REQUIRED → 停止旧重试
  await page.getByRole('button', { name: '重试上次保存' }).click()
  await expect(page.locator('.ws-run-state')).toHaveText('需要重新读取')
  expect(newestSync(await localState(page)).rejected?.code).toBe('RECOVERY_REQUIRED')

  // 重新读取：新代际上下文，旧未决命令只留事实；旧 ACK 没有建立确认头，本机保持回退状态
  await page.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await expect(page.locator('.ws-run-state')).toHaveText('上一次保存已过期')
  expect((await localState(page)).workspace!.workspaceRevision).toBe(0)

  // 打开比较：旧代际被拒命令 → source=recovery；服务端回退后还没有这个文件
  await page.getByRole('button', { name: '比较双方正文' }).click()
  const compare = page.locator(".ws-compare[data-source='recovery']")
  await expect(compare).toBeVisible()
  const file = compare.locator(".ws-compare-file[data-path='main.c']")
  await expect(file).toBeVisible()
  await expect(file.locator('.ws-compare-missing')).toHaveText('服务端还没有这个文件。')

  // 跨代际未决命令可由学生明确退役（保留本页正文）
  await page.getByRole('button', { name: '保留本页正文' }).click()
  await expect(page.locator('.toast')).toHaveText('已保留本页正文，可以重新保存了。')
  await expect(page.locator('.ws-compare')).toHaveCount(0)

  // 当前代际新键保存成功：丢 ACK 的原命令与重放同键（1 个身份），新保存是新键（第 2 个身份）
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')
  expect(posts).toHaveLength(3)
  expect(identities(posts).size).toBe(2)
  const syncRows = (await localState(page)).commands.filter(c => c.kind === 'workspace.sync')
  expect(syncRows.every(r => r.state === 'historical' || r.state === 'confirmed')).toBe(true)
  expect(syncRows.find(r => r.rejected?.code === 'RECOVERY_REQUIRED')?.state).toBe('historical')
  const head = await serverHead(page)
  expect(head.attempt.workspaceRevision).toBe(1)
  expect(head.files[0].text).toContain('recovery body')
})
