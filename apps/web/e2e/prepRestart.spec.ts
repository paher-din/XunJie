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
function startPrepServer(servers: PrepServer[], readyTimeoutMs = 60_000): Promise<PrepServer> {
  const child: ChildProcess = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--mode', 'prep',
    '--port', RESTART_PORT, '--strictPort'], { cwd: STUDENT_ROOT,
      env: { ...process.env, XUNJIE_VITE_CACHE_DIR: `.playwright/node_modules/.vite-restart-${RESTART_PORT}` }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = '', epoch = '', stopping: Promise<void> | null = null
  child.stdout?.on('data', chunk => { log += String(chunk) })
  child.stderr?.on('data', chunk => { log += String(chunk) })
  const server: PrepServer = {
    get epoch() { return epoch },
    stop: () => stopping ??= new Promise<void>(done => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) { done(); return }
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      killTimer.unref()
      child.once('exit', () => { clearTimeout(killTimer); done() })
      child.kill('SIGTERM')
    }),
  }
  // spawn 后立即登记：就绪失败或断言中断也必须回收这个进程。
  servers.push(server)
  return new Promise<PrepServer>((resolve, reject) => {
    let settled = false
    let pollTimer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      clearTimeout(pollTimer); clearTimeout(deadline)
      child.off('exit', onExit); child.off('error', onError)
    }
    const fail = async (message: string) => {
      if (settled) return
      settled = true; cleanup()
      await server.stop()
      reject(new Error(`${message}\n${log.slice(-2000)}`))
    }
    const onExit = (code: number | null) => { void fail(`dev:prep 在 ${RESTART_PORT} 上退出（code=${code}）。端口可能被占用。`) }
    const onError = (error: Error) => { void fail(`dev:prep 启动失败：${error.message}`) }
    const deadline = setTimeout(() => { void fail(`dev:prep ${readyTimeoutMs}ms 内没在 ${RESTART_PORT} 就绪。`) }, readyTimeoutMs)
    child.once('exit', onExit); child.once('error', onError)
    const poll = async () => {
      try {
        const response = await fetch(`${RESTART_URL}/__i0prep/context`, { signal: AbortSignal.timeout(2000) })
        if (response.ok) {
          const data = ((await response.json()) as { data: { preparationEpoch: string } }).data
          if (settled) return
          epoch = data.preparationEpoch
          settled = true; cleanup(); resolve(server); return
        }
      } catch { /* 端口还没起来，继续轮询 */ }
      if (!settled) pollTimer = setTimeout(() => { void poll() }, 250)
    }
    pollTimer = setTimeout(() => { void poll() }, 250)
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

test('启动超时回收子进程，随后可以在同一 strictPort 启动', async () => {
  const servers: PrepServer[] = []
  try {
    await expect(startPrepServer(servers, 1)).rejects.toThrow('就绪')
    expect(servers).toHaveLength(1)
    expect((await startPrepServer(servers)).epoch).toBeTruthy()
  } finally {
    await Promise.all(servers.map(server => server.stop()))
  }
})

test('准备进程重启后旧确认缓存不装成新 head，草稿保留且原命令不自动迁代际', async ({ page }) => {
  const scenario = `restart-${crypto.randomUUID()}`
  const servers: PrepServer[] = []
  const start = () => startPrepServer(servers)
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
    const failedSave = page.waitForEvent('requestfailed', { predicate: request => request.method() === 'POST' && request.url().endsWith('/sync') })
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    // The pending row renders before its original POST; begin the zero-write
    // observation only once that send has actually failed and retry is available.
    await expect(page.getByRole('button', { name: '重试上次保存', exact: true })).toBeEnabled()
    await failedSave
    await expect.poll(async () => (await readLocalWith(page, contextBefore)).commands
      .find(c => c.kind === 'workspace.sync' && c.state === 'pending')?.lease).toBeUndefined()
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
    await expect.poll(() => readReference(page, contextAfter)).toEqual({ attemptId: null, changed: false })
    expect(await readReference(page, contextBefore)).toEqual({ attemptId: null, changed: true })

    // 本机草稿保留：换 epoch 不清空学生没确认的正文，旧 attempt 的草稿仍可按旧上下文读回。
    const draftsAfter = (await readLocalWith(page, contextBefore)).drafts.map(d => d.text)
    expect(draftsAfter.some(text => text.includes('pending across restart'))).toBe(true)

    // 受信重读后可以继续学习：学生主动创建新 Attempt 并保存，不被旧引用永久锁住。
    await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    await expect(page.locator('.cw')).toBeVisible()
    await create(page, 'main.c')
    await edit(page, 'new epoch work\n')
    await confirmSave(page, 1)
    const current = await readContext(page)
    const newLocal = await readLocalWith(page, current)
    expect(newLocal.workspace?.files[0]?.text).toBe('new epoch work\n')
    expect(await readReference(page, current)).toEqual({ attemptId: current.refs.attemptId, changed: false })
    const retained = await readLocalWith(page, contextBefore)
    expect(retained.commands.find(c => c.commandKey === commandBefore.commandKey)).toEqual(commandAfter)
    expect(retained.drafts.map(d => d.text)).toEqual(draftsAfter)

    // 旧标签迟到 GET 也不能把旧引用重新装回来（直接用旧已确认头尝试安装）。
    const lateRead = await page.evaluate(async ({ ctx, workspace }) => {
      const { confirmationRepository } = await import('/src/workspace/confirmationDb.ts' as string)
      try { await confirmationRepository.installHead(ctx, workspace!, () => true); return 'accepted' }
      catch (error) { return String(error) }
    }, { ctx: commandContextOf(contextBefore), workspace: localBefore.workspace })
    expect(lateRead).toContain('代际')
    expect(await readReference(page, current)).toEqual({ attemptId: current.refs.attemptId, changed: false })

  } finally {
    // 断言失败也要回收：端口被占会让后续整轮 e2e 起不来。
    await Promise.all(servers.map(server => server.stop()))
  }
})

test('双标签逆序接纳 epoch：迟到旧初始化不能退役已接纳的新引用', async ({ page, context }) => {
  const servers: PrepServer[] = [], scenario = `epoch-cas-${crypto.randomUUID()}`
  try {
    // 此反例需要旧文档存活：隔断 Vite HMR 的自动整页重载，不拦截业务 HTTP。
    await page.routeWebSocket('**', () => {})
    const first = await startPrepServer(servers)
    await page.goto(`${RESTART_URL}/?scenario=${scenario}${PREP_TASK_PATH}`)
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
    await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    await expect(page.locator('.cw')).toBeVisible()
    await first.stop()
    const second = await startPrepServer(servers)
    const delayedContext = commandContextOf(await readContext(page))
    expect(delayedContext.attemptId).toBeNull()
    const delayed = page.evaluate(async ctx => {
      const { confirmationRepository } = await import('/src/workspace/confirmationDb.ts' as string)
      const testWindow = window as unknown as { epochReadHeld: boolean; releaseEpochRead: () => void }
      try {
        await confirmationRepository.acceptPreparationEpoch(ctx, () => true, async () => {
          // g2 读取已成功但后续延迟；本机有效 guard 不能感知另一标签已接纳 g3。
          testWindow.epochReadHeld = true
          await new Promise<void>(resolve => { testWindow.releaseEpochRead = resolve })
          return true
        })
        return 'accepted'
      } catch (error) { return String(error) }
    }, delayedContext)
    await expect.poll(() => page.evaluate(() => (window as unknown as { epochReadHeld: boolean }).epochReadHeld)).toBe(true)
    await second.stop()
    await startPrepServer(servers)
    const newer = await context.newPage()
    await newer.goto(`${RESTART_URL}/?scenario=${scenario}${PREP_TASK_PATH}`)
    await expect(newer.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
    await newer.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    await expect(newer.locator('.cw')).toBeVisible()
    const current = await readContext(newer)
    await page.evaluate(() => (window as unknown as { releaseEpochRead: () => void }).releaseEpochRead())
    expect(await delayed).toContain('另一标签已更新受信引用')

    // g2 从未入库，不能仅靠 retired 集合排除它；当前 bootstrap 重读同样必须挡住。
    const stale = await page.evaluate(async ctx => {
      const { confirmationRepository } = await import('/src/workspace/confirmationDb.ts' as string)
      const { apiGet } = await import('/src/workspace/http.ts' as string)
      try {
        await confirmationRepository.acceptPreparationEpoch(ctx, () => true, async () => {
          const latest = await apiGet('', {
            mode: 'preparation', absolutePath: '/__i0prep/context', scenarioId: ctx.scenarioId,
          })
          return latest.preparationEpoch === ctx.preparationEpoch && latest.recoveryGeneration === ctx.trustedRecoveryGeneration
        })
        return 'accepted'
      } catch (error) { return String(error) }
    }, delayedContext)
    expect(stale).toContain('准备工作区已变化')
    expect(await readReference(newer, current)).toEqual({ attemptId: current.refs.attemptId, changed: false })
    await create(newer, 'main.c')
    await edit(newer, 'current epoch remains writable\n')
    await confirmSave(newer, 1)
    expect((await readLocalWith(newer, current)).workspace?.files[0]?.text).toBe('current epoch remains writable\n')
    await newer.close()
  } finally {
    await Promise.all(servers.map(server => server.stop()))
  }
})
