import { expect, test, type Page } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PREP_TASK_PATH, RESTART_PORT, RESTART_URL } from './env'
import { confirmSave, create, edit, setFault, trackBusinessWrites, type LocalSummary } from './helpers'

/**
 * I0_UI_07：准备进程重启 / 换 epoch 的回放。
 *
 * [客户端约束 §2](../../docs/tasks/I0_UI_CLIENT_CONTRACT.md)：「开发进程重启后 authority 重置并换
 * preparation epoch/合成受信代际；本机草稿保留，旧『已确认』缓存不能当新 head。重读并提示重新比较，
 * 旧 outbox 不自动迁代际或补发。」
 *
 * 这里**真的杀掉并重新拉起 dev:prep 进程**（独占 `RESTART_PORT`，不用 playwright.config 那两个全程
 * 存活的 webServer），因为 epoch 与 authority 都是进程级状态（`prep/authority.ts:17-24`）：只有真实
 * 重启才能证明客户端不是靠某个 dev-only 开关「配合」出来的。浏览器上下文不重建，IndexedDB 原样留着，
 * 所以这是对同一份本机存储在换代前后的对照。
 */

const STUDENT_ROOT = fileURLToPath(new URL('..', import.meta.url))

interface PrepServer { readonly epoch: string; stop(): Promise<void> }

/** 直接跑 vite 而不是 `npm run`：只留一个可杀进程，避免 npm 包装进程被杀后 vite 变成孤儿。 */
function startPrepServer(): Promise<PrepServer> {
  const child: ChildProcess = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'prep',
    '--port', RESTART_PORT, '--strictPort'], { cwd: STUDENT_ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout?.on('data', chunk => { log += String(chunk) })
  child.stderr?.on('data', chunk => { log += String(chunk) })
  return new Promise<PrepServer>((resolve, reject) => {
    const timer = setInterval(async () => {
      try {
        const response = await fetch(`${RESTART_URL}/__i0prep/context`)
        if (!response.ok) return
        clearInterval(timer)
        const epoch = ((await response.json()) as { data: { preparationEpoch: string } }).data.preparationEpoch
        resolve({
          epoch,
          stop: () => new Promise<void>(done => {
            if (child.exitCode !== null || child.signalCode !== null) { done(); return }
            child.once('exit', () => done())
            child.kill('SIGTERM')
            // Vite 偶发不把 SIGTERM 转成退出；超时后强杀，避免占住 strictPort 让后续用例全红。
            setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }, 10_000).unref()
          }),
        })
      } catch { /* 端口还没起来，继续轮询 */ }
    }, 250)
    child.once('exit', code => {
      clearInterval(timer)
      reject(new Error(`dev:prep 在 ${RESTART_PORT} 上退出（code=${code}）。端口可能被占用。\n${log.slice(-2000)}`))
    })
    setTimeout(() => { clearInterval(timer); reject(new Error(`dev:prep 60s 内没在 ${RESTART_PORT} 就绪。\n${log.slice(-2000)}`)) }, 60_000).unref()
  })
}

interface PrepContextView {
  scenarioId: string; preparationEpoch: string; recoveryGeneration: string
  syntheticAccount: { userId: string; courseId: string }
  refs: { assignmentId: string; activityVersionId: string; attemptId?: string }
}

/** 读当前页面所在进程的准备上下文（origin 相对，因此重启前后都能用同一段代码）。 */
function readContext(page: Page): Promise<PrepContextView> {
  return page.evaluate(async () => {
    const scenarioId = new URLSearchParams(location.search).get('scenario')!
    const response = await fetch('/__i0prep/context', { headers: { 'x-i0prep-scenario': scenarioId } })
    return ((await response.json()) as { data: PrepContextView }).data
  })
}

/** 把准备上下文摊成 `confirmationDb` 的读取参数；`readLocalWith` 与 `readReference` 共用同一份。 */
function commandContextOf(c: PrepContextView) {
  return {
    mode: 'preparation' as const, userId: c.syntheticAccount.userId, courseId: c.syntheticAccount.courseId,
    assignmentId: c.refs.assignmentId, activityVersionId: c.refs.activityVersionId,
    attemptId: c.refs.attemptId ?? null, loadEpoch: 0, preparationEpoch: c.preparationEpoch,
    trustedRecoveryGeneration: c.recoveryGeneration, scenarioId: c.scenarioId,
  }
}

/** 用**指定**的上下文读本机落盘事实：重启后要拿旧 epoch/旧 attemptId 去读，才知道旧记录有没有被保住。 */
async function readLocalWith(page: Page, context: PrepContextView): Promise<LocalSummary> {
  // 上下文在 Node 侧拼好再传进去：evaluate 的函数体跑在浏览器里，引用不到本文件的 helper。
  return page.evaluate(async (ctx: ReturnType<typeof commandContextOf>) => {
    const { confirmationRepository } = await import('/src/workspace/confirmationDb.ts' as string)
    return confirmationRepository.read(ctx)
  }, commandContextOf(context))
}

/**
 * 新 authority 下客户端还能不能沿用旧的 Attempt 引用。
 *
 * `commands()` 按 owner（mode/account/assignment/scenario）过滤、**不按 epoch**，所以旧 epoch 的原命令
 * 重启后仍读得到——那是「保留原命令可核对」的要求，不是漏隔离。真正挡住自动沿用的是 reference 记录：
 * epoch 或代际变了就报 `changed`，attemptId 归零，必须重读（`confirmationDb.ts:161-168`）。
 */
function readReference(page: Page, context: PrepContextView) {
  return page.evaluate(async (ctx: ReturnType<typeof commandContextOf>) => {
    const { confirmationRepository } = await import('/src/workspace/confirmationDb.ts' as string)
    return confirmationRepository.reference(ctx)
  }, commandContextOf(context))
}

test('准备进程重启后旧确认缓存不装成新 head，草稿保留且原命令不自动迁代际', async ({ page }) => {
  const scenario = `restart-${crypto.randomUUID()}`
  const servers: PrepServer[] = []
  const start = async (): Promise<PrepServer> => { const server = await startPrepServer(); servers.push(server); return server }
  try {
    const first = await start()
    await page.goto(`${RESTART_URL}/?scenario=${scenario}${PREP_TASK_PATH}`)
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
    await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    await expect(page.locator('.cw')).toBeVisible()

    await create(page, 'main.c')
    await edit(page, 'int main(void) { return 0; }\n')
    await confirmSave(page, 1)

    const contextBefore = await readContext(page)
    expect(contextBefore.refs.attemptId).toBeTruthy()
    expect(contextBefore.preparationEpoch).toBe(first.epoch)
    const localBefore = await readLocalWith(page, contextBefore)
    expect(localBefore.workspace?.workspaceRevision).toBe(1)

    // 留一条**未决原命令**跨越重启：ACK 被丢掉，服务侧已提交，客户端只能保留原命令等待核对。
    expect(await setFault(page, 'drop-ack')).toBe(200)
    await edit(page, 'pending across restart\n')
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await expect(page.getByRole('button', { name: '重试上次保存', exact: true })).toBeVisible()
    const pendingBefore = (await readLocalWith(page, contextBefore)).commands
      .filter(c => c.kind === 'workspace.sync' && c.state === 'pending')
    expect(pendingBefore).toHaveLength(1)
    const commandBefore = pendingBefore[0]!

    const writes = trackBusinessWrites(page)
    await first.stop()
    const second = await start()
    // 真的换代了，否则后面的断言只是在重复同一个进程的状态。
    expect(second.epoch).not.toBe(first.epoch)

    await page.reload()
    const contextAfter = await readContext(page)
    expect(contextAfter.preparationEpoch).toBe(second.epoch)
    expect(contextAfter.preparationEpoch).not.toBe(contextBefore.preparationEpoch)
    expect(contextAfter.recoveryGeneration).not.toBe(contextBefore.recoveryGeneration)

    // 旧确认缓存没有被当成新 head：新 authority 下本机确认头是空的，界面回到「开始 Attempt」，
    // 顶栏也不再宣称确认作品 v1。
    expect((await readLocalWith(page, contextAfter)).workspace).toBeNull()
    await expect(page.getByRole('button', { name: '开始 Attempt', exact: true })).toBeVisible()
    await expect(page.locator('.ws-flow')).not.toContainText('确认作品 v1')

    // 原命令不自动迁代际、不自动补发：重启后没有任何业务写命令离开浏览器，
    // 旧命令仍是原 commandKey/原 wireJson、仍 pending，且仍带旧 epoch 与旧代际。
    expect(writes).toEqual([])
    const commandAfter = (await readLocalWith(page, contextBefore)).commands
      .find(c => c.commandKey === commandBefore.commandKey)!
    expect(commandAfter.state).toBe('pending')
    expect(commandAfter.wireJson).toBe(commandBefore.wireJson)
    expect(commandAfter.context.preparationEpoch).toBe(contextBefore.preparationEpoch)
    expect(commandAfter.context.trustedRecoveryGeneration).toBe(contextBefore.recoveryGeneration)
    // 换 epoch 后旧 Attempt 引用不再可用：必须重读，不能拿旧 attemptId 继续发命令。
    expect(await readReference(page, contextAfter)).toEqual({ attemptId: null, changed: true })
    expect(await readReference(page, contextBefore)).toEqual({ attemptId: contextBefore.refs.attemptId, changed: false })

    // 本机草稿保留：换 epoch 不清空学生没确认的正文，旧 attempt 的草稿仍可按旧上下文读回。
    const draftsAfter = (await readLocalWith(page, contextBefore)).drafts.map(d => d.text)
    expect(draftsAfter.some(text => text.includes('pending across restart'))).toBe(true)
  } finally {
    // 断言失败也要回收：端口被占会让后续整轮 e2e 起不来。
    await Promise.all(servers.map(server => server.stop()))
  }
})
