import { expect, type Page } from '@playwright/test'
import { PREP_TASK_PATH, PREP_URL } from './env'

/**
 * I0 e2e 共享操作与核验 helper。
 *
 * 此前 sceneUrl/start/create/输入、setFault/localState/newestSync/syntheticUpdate/
 * trackSync/identities/holdAck 在 compare/recovery/confirmation/draftConflict 各 spec
 * 里逐份拷贝（04A 复审登记为工程债），现收拢到本模块；各 spec 只保留自己的场景组装。
 *
 * 约定与原各 spec 实现一致：全部走真实 dev:prep 进程、真实浏览器与 IndexedDB；
 * helper 只做「操作 + 等待可见状态 / 读取落盘事实」，不造业务响应。
 */

/** 每个用例一个全新合成场景（scenario），fixture 状态不跨用例共享。 */
export const sceneUrl = (name: string) => `${PREP_URL}/?scenario=${name}-${crypto.randomUUID()}${PREP_TASK_PATH}`

/** 进入准备场景并开始 Attempt，等编辑区可见。 */
export async function start(page: Page, name: string) {
  await page.goto(sceneUrl(name))
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
  await expect(page.locator('.cw')).toBeVisible()
}

/** 新建文件并等编辑器挂载。 */
export async function create(page: Page, name = 'main.c') {
  await page.getByRole('button', { name: '新建文件', exact: true }).first().click()
  const input = page.getByRole('textbox', { name: '新文件名' })
  await input.fill(name)
  await input.press('Enter')
  await expect(page.locator('.monaco-editor textarea').first()).toBeAttached()
}

/** 输入正文但不等待落盘；落盘结果（保护/冲突条）由调用方用 expect 等待。 */
export async function typeIn(page: Page, text: string) {
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.insertText(text)
}

/** 输入正文并等待本机草稿写入完成（保护状态恢复）。 */
export async function edit(page: Page, text: string) {
  await typeIn(page, text)
  await expect(page.locator('.cw-protect')).toHaveText('本机草稿已保护')
}

/** 设置/清除开发故障；只作用于当前合成场景。 */
export async function setFault(page: Page, kind: 'none' | 'drop-ack' | 'fail-write') {
  return page.evaluate(async kind => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const response = await fetch('/__i0prep/fault', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ kind }) })
    return response.status
  }, kind)
}

export interface LocalCommand { kind: string; state: string; createdAt: number; commandKey: string; wireJson: string
  rejected?: { code: string } | null; lease?: { owner: string; until: number }; context: Record<string, unknown> }
export interface LocalSummary { workspace: { workspaceRevision: number; files: Array<{ fileId: string; text: string; contentHash?: string }> } | null
  instances: Array<{ fileId: string; clientFileKey?: string }>; drafts: Array<{ text: string }>
  commands: LocalCommand[]; candidates: Array<{ text: string; reason: string }> }

/** 读取页面同源的本地落盘全量事实（确认头、草稿、实例、原命令、候选）。 */
export async function localState(page: Page): Promise<LocalSummary> {
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
export function newestSync(state: LocalSummary): LocalCommand {
  return state.commands.filter(c => c.kind === 'workspace.sync').sort((a, b) => b.createdAt - a.createdAt)[0]!
}

/** 用 fixture 的合成身份从页面内直接推进权威作品（模拟另一处已保存）。 */
export async function syntheticUpdate(page: Page, text: string) {
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

/** 读取 fixture 权威 Attempt（不经页面状态），用于核对服务端事实而不是界面自述。 */
export interface ServerHead { attempt: { attemptId: string; workspaceRevision: number; status: string; attemptRevision: number }
  files: Array<{ fileId: string; path: string; text: string; lifecycle: 'active' | 'recycled'; documentVersion: number; contentHash: string }>
  snapshots: Array<{ snapshotId: string; workspaceRevision: number; createdAt: string
    files: Array<{ fileId: string; path: string; text: string; contentHash: string; documentVersion: number }> }> }

export async function serverHead(page: Page): Promise<ServerHead> {
  return page.evaluate(async () => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const data = (await (await fetch('/__i0prep/context', { headers })).json()).data
    return (await (await fetch(`/__i0prep/api/attempts/${data.refs.attemptId}`, { headers })).json()).data
  })
}

/**
 * 开发专用：把准备 authority 里的 Attempt 切到暂停或终态。
 *
 * 05 要求「暂停/终态不可操作」，而准备 authority 只会把 Attempt 变成 ready/active；
 * 这里用同一个 dev-only 契约（POST /__i0prep/attempt-state）改状态，客户端仍必须经 GET 才看到。
 */
export async function setAttemptState(page: Page, status: 'active' | 'paused' | 'submitted' | 'reviewed') {
  return page.evaluate(async status => {
    const headers = { 'x-i0prep-scenario': new URLSearchParams(location.search).get('scenario')! }
    const data = (await (await fetch('/__i0prep/context', { headers })).json()).data
    const session = (await (await fetch('/__i0prep/api/session', { headers })).json()).data
    const response = await fetch('/__i0prep/attempt-state', { method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'x-csrf-token': session.csrfToken },
      body: JSON.stringify({ attemptId: data.refs.attemptId, status }) })
    return { status: response.status, body: (await response.json()).data }
  }, status)
}

/** 打开文件列表浮层（回收/恢复/新建入口都在里面）。 */
export async function openFileMenu(page: Page) {
  const menu = page.locator('.cw-filemenu')
  if (!(await menu.isVisible())) await page.locator('.cw-stripbtn').click()
  await expect(menu).toBeVisible()
}

/**
 * 点「确认保存」并等确认头推进到指定版本。
 *
 * 版本读数只说明服务端已接纳的这一版；它不是「本机草稿已上传」的同义词，
 * 所以断言的是工作区版本而不是按钮状态。
 */
export async function confirmSave(page: Page, revision: number) {
  await page.getByRole('button', { name: '确认保存', exact: true }).click()
  await expect(page.locator('.ws-flow')).toContainText(`确认作品 v${revision}`)
}

/** 记录业务保存请求（幂等键 + 正文），用于核对命令身份。 */
export function trackSync(page: Page) {
  const posts: Array<{ key: string; body: string }> = []
  page.on('request', r => {
    if (r.method() === 'POST' && r.url().endsWith('/sync')) posts.push({ key: r.headers()['idempotency-key']!, body: r.postData()! })
  })
  return posts
}

/**
 * 记录全部业务写命令（创建 Attempt / sync / snapshot / run / cancel）。
 *
 * 与 `trackSync` 的区别：状态闸类用例要证明的是「一条业务写命令都没离开浏览器」。
 * 登录 POST /sessions 与只读分析 POST /editor-diagnostics 不写业务作品；后者的暂停禁发另有专项断言。
 */
export function trackBusinessWrites(page: Page) {
  const writes: string[] = []
  page.on('request', request => {
    if (request.method() === 'GET') return
    const path = new URL(request.url()).pathname
    if (path.endsWith('/sessions') || path.endsWith('/editor-diagnostics')) return
    writes.push(`${request.method()} ${path}`)
  })
  return writes
}

/**
 * 业务命令身份（业务键 + 正文）。同一原命令在传输层重试、或被学生明确重放，
 * 身份都必须完全相同；只有出现第二条身份才说明客户端新建了命令。
 */
export function identities(posts: Array<{ key: string; body: string }>) {
  return new Set(posts.map(p => `${p.key}\n${p.body}`))
}

/** 按住一次写命令的响应：请求已发出（因此租约与在途状态真实存在），回执尚未到达。 */
export async function holdAck(page: Page) {
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
