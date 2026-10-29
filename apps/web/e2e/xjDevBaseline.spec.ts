import { expect, test, request as playwrightRequest, type Page } from '@playwright/test'
import { randomUUID, createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { confirmSave, edit, openFileMenu } from './helpers'
import { loginThroughForm } from './sessionHost'

/**
 * XJ-DEV 浏览器验收：对运行中的本地全栈环境（tools/xj-dev）走真实 UI 闭环。
 *
 * 运行前提：`node tools/xj-dev/xj-dev.mjs up` 已启动一套**干净基线**（学生尝试尚未提交；
 * 已有提交/反馈的环境请先 down 后删除对应环境目录再 up），然后在本工作树的 apps/web 下：
 *   XUNJIE_XJ_DEV_URL=https://127.0.0.1:<网关端口> npx playwright test xjDevBaseline
 *
 * 覆盖：HTTPS 单一入口页面与登录表单、课程与任务进入、作品编辑/保存/冻结/提交、
 * 教师写正式反馈（真实接口）、学生端读取反馈、Vite HMR 经网关的实际热更新。
 *
 * 基线密码不进入仓库：从本工作树环境的 secrets/baseline-accounts.json 读取
 * （路径派生与 tools/xj-dev/src/paths.mjs 的 toolHome/environmentId 保持一致）。
 */
function baselinePassword(loginName: string): string {
  let current = realpathSync(resolve(process.cwd()))
  while (!existsSync(join(current, '.git'))) {
    const parent = dirname(current)
    if (parent === current) throw new Error('不在 Git 工作树内，无法派生 xj-dev 环境身份')
    current = parent
  }
  const environmentId = createHash('sha256').update(current + '\0').digest('hex').slice(0, 12)
  const home = process.env.XJ_DEV_HOME ? resolve(process.env.XJ_DEV_HOME) : join(homedir(), '.xunjie', 'xj-dev')
  const file = join(home, 'envs', environmentId, 'secrets', 'baseline-accounts.json')
  const accounts = JSON.parse(readFileSync(file, 'utf8')) as { loginName: string; password: string }[]
  const account = accounts.find(item => item.loginName === loginName)
  if (!account) throw new Error(`基线凭据文件缺少 ${loginName}：${file}`)
  return account.password
}
test.use({ ignoreHTTPSErrors: true })
test.setTimeout(180_000)

const BASE = process.env.XUNJIE_XJ_DEV_URL

test.beforeEach(() => {
  test.skip(!BASE, '需要运行中的 xj-dev 环境：XUNJIE_XJ_DEV_URL=https://127.0.0.1:<网关端口>')
})

async function enterWorkspace(page: Page, base: string) {
  await page.goto(`${base}/`)
  await expect(page.getByRole('heading', { name: '登录学习空间' })).toBeVisible()
  const loggedIn = page.waitForResponse(response =>
    response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/sessions' && response.status() === 200)
  await loginThroughForm(page, 'synthetic-student', baselinePassword('synthetic-student'))
  await loggedIn
  const session = await page.context().request.get(`${base}/api/session`)
  expect(session.status()).toBe(200)
  const courses = (await session.json()).data.courses as { courseId: string }[]
  expect(courses.some(course => course.courseId === 'synthetic-textscope-c')).toBe(true)
  const assignments = await page.context().request.get(`${base}/api/courses/synthetic-textscope-c/assignments`)
  expect(assignments.status()).toBe(200)
  const assignmentId = (await assignments.json()).data[0].assignmentId as string
  const bootstrap = await page.context().request.get(`${base}/api/assignments/${assignmentId}/bootstrap`)
  expect(bootstrap.status()).toBe(200)
  const data = (await bootstrap.json()).data
  const attempt = await page.context().request.get(`${base}/api/attempts/${data.currentAttemptId}`)
  const attemptData = (await attempt.json()).data
  test.skip(!['ready', 'active', 'paused'].includes(attemptData.attempt.status as string),
    `学生尝试已处于 ${attemptData.attempt.status}：浏览器验收需要干净基线（down 后删除环境目录再 up）`)
  await page.goto(`${base}/#/task/${assignmentId}`)
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await expect(page.locator('.cw')).toBeVisible()
  return {
    attemptId: data.currentAttemptId as string,
    generation: data.recoveryGeneration as string,
    workspaceRevision: attemptData.attempt.workspaceRevision as number,
  }
}

test('学生经 HTTPS 网关完成登录→课程→保存→提交，教师写反馈、学生读到，HMR 经网关连通', async ({ page }) => {
  const base = BASE!
  const hmr: { url: string; connected: boolean }[] = []
  page.on('websocket', socket => {
    const record = { url: socket.url(), connected: false }
    socket.on('framereceived', frame => {
      if (typeof frame.payload === 'string' && frame.payload.includes('"connected"')) record.connected = true
    })
    hmr.push(record)
  })

  // HMR 实机编辑证明：改组件源码，页面经网关热更新且不整页刷新（window 标记存活）。
  // 选 XunjieLogo：登录页可见、只导出组件，是 react-refresh 可接纳的热更新边界。
  const hmrSource = new URL('../src/brand/XunjieLogo.tsx', import.meta.url)
  const hmrOriginal = readFileSync(hmrSource, 'utf8')
  const hmrTarget = 'className={`xunjie-logo ${className}`.trim()}'
  await page.goto(`${base}/`)
  await expect(page.locator('svg.xunjie-logo').first()).toBeVisible()
  await page.evaluate(() => { (window as unknown as Record<string, unknown>).__hmrMarker = 'alive' })
  try {
    writeFileSync(hmrSource, hmrOriginal.replace(hmrTarget, 'className={`xunjie-logo hmr-proof ${className}`.trim()}'))
    await expect(page.locator('svg.xunjie-logo.hmr-proof').first()).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__hmrMarker)).toBe('alive')
  } finally {
    writeFileSync(hmrSource, hmrOriginal)
  }

  // 学生：登录 → 课程/任务 → 编辑保存 → 冻结 → 提交（全部经网关 UI）。
  const { attemptId, generation, workspaceRevision } = await enterWorkspace(page, base)
  const fileName = `browser-acceptance-${Date.now().toString(36)}.txt`
  await openFileMenu(page)
  await page.locator('.cw-filemenu').getByRole('menuitem', { name: '新建文件', exact: true }).click()
  const nameInput = page.getByRole('textbox', { name: '新文件名' })
  await nameInput.fill(fileName)
  await nameInput.press('Enter')
  await expect(page.locator('.monaco-editor textarea').first()).toBeAttached()
  await edit(page, '浏览器验收：经单一 HTTPS 入口保存。\n')
  await confirmSave(page, workspaceRevision + 1)
  await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
  await expect(page.getByText(`已冻结快照 v${workspaceRevision + 1}`, { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '提交与反馈', exact: true }).click()
  const panel = page.getByTestId('submission-feedback-panel')
  await expect(panel).toBeVisible()
  const snapshotSelect = panel.getByRole('combobox', { name: '提交快照', exact: true })
  // 面板异步刷新快照列表，等刚冻结的版本出现后再选。
  let snapshotValue = ''
  await expect(async () => {
    snapshotValue = await snapshotSelect.locator('option').evaluateAll(
      (options, revision) => options.find(option => option.textContent?.includes(`确认作品 v${revision} ·`))?.getAttribute('value') ?? '',
      workspaceRevision + 1)
    expect(snapshotValue, `冻结快照 v${workspaceRevision + 1} 出现在提交选项中`).not.toBe('')
  }).toPass()
  await snapshotSelect.selectOption(snapshotValue)
  await panel.getByRole('button', { name: '提交所选作品', exact: true }).click()
  await page.getByRole('button', { name: '确认提交所选快照', exact: true }).click()
  await expect(panel).toContainText('等待教师审阅')

  // 教师：真实接口写正式作品反馈（教师真实 UI 由 LiveReviewPage 覆盖；此处核对服务端链路）。
  const teacher = await playwrightRequest.newContext({ ignoreHTTPSErrors: true })
  const teacherLogin = await teacher.post(`${base}/api/sessions`, {
    headers: { origin: base },
    data: { loginName: 'synthetic-teacher', password: baselinePassword('synthetic-teacher') },
  })
  expect(teacherLogin.status()).toBe(200)
  const teacherCsrf = (await teacherLogin.json()).data.csrfToken as string
  const attemptNow = await teacher.get(`${base}/api/attempts/${attemptId}`)
  const attemptBody = (await attemptNow.json()).data
  const submissions = attemptBody.submissions as { submissionId: string }[]
  const submissionId = submissions[submissions.length - 1].submissionId
  const learnerState = await teacher.get(`${base}/api/attempts/${attemptId}/learner-state`)
  const feedbackView = await teacher.get(`${base}/api/attempts/${attemptId}/feedback`)
  const saved = await teacher.post(`${base}/api/attempts/${attemptId}/feedback`, {
    headers: { 'x-csrf-token': teacherCsrf, 'idempotency-key': randomUUID(), origin: base },
    data: {
      recoveryGeneration: generation,
      kind: 'submission_review',
      submissionId,
      expectedFeedbackRevision: (await feedbackView.json()).data.feedbackRevision,
      expectedStateRevision: (await learnerState.json()).data.learnerStateRevision,
      expectedAttemptRevision: attemptBody.attempt.attemptRevision,
      summary: '浏览器验收反馈：作品链路完整。',
      reason: 'xj-dev 浏览器端到端验收',
      evidenceRefs: [],
    },
  })
  expect(saved.status(), await saved.text()).toBe(200)
  await teacher.dispose()

  // 学生：重新加载后在提交面板读到教师反馈。
  await page.reload()
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
  await page.getByRole('button', { name: '提交与反馈', exact: true }).click()
  const reloaded = page.getByTestId('submission-feedback-panel')
  await expect(reloaded).toContainText('教师已审阅')
  await expect(reloaded).toContainText('作品审阅')
  await expect(reloaded).toContainText('浏览器验收反馈：作品链路完整。')

  // HMR：Vite 开发通道经网关建立（同一来源，无第二端口暴露给浏览器）。
  expect(hmr.some(socket => socket.url.startsWith(base.replace('https://', 'wss://')) && socket.connected),
    `HMR 通道未建立，所见 websocket：${hmr.map(socket => socket.url).join(', ') || '无'}`).toBe(true)
})
