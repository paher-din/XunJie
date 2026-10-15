import { clickWorkspaceAction } from './workspaceControls'
import { expect, test, type Page } from '@playwright/test'
import { create, edit } from './helpers'
import { loginThroughForm, startSessionHost } from './sessionHost'

// 实际教学 HTTPS/SQLite，独立合成账号。沿用既有临时 TLS，不更改正常信任或配置。
// 表单凭据不能出现在 trace；失败也只留无凭据的 DOM 截图。
test.use({ ignoreHTTPSErrors: true, trace: 'off' })
test.beforeEach(() => {
  test.skip(!process.env.XUNJIE_E2E_SERVICE_NODE, 'Requires approved teaching Node 24.21.0 and existing native dependencies')
})

async function enter(page: Page, service: Awaited<ReturnType<typeof startSessionHost>>, assignment = service.assignmentId) {
  await expect.poll(async () => {
    try { return (await page.context().request.get(service.base + '/health/live')).status() } catch { return 0 }
  }, { timeout: 20_000 }).toBe(200)
  await page.goto(`${service.base}/#/task/${assignment}`)
  await expect(page.getByRole('heading', { name: '登录学习空间' })).toBeVisible()
}
async function ready(page: Page) {
  await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
}
async function exit(page: Page) {
  await clickWorkspaceAction(page, '退出')
  await expect(page.locator('.session-notice')).toContainText('已退出登录')
  await expect(page.locator('.cw')).toHaveCount(0)
}

test('HTTPS 表单登录、错误口令、获准深链、刷新与首页账号菜单退出', async ({ page }) => {
  const service = await startSessionHost()
  try {
    const writes: string[] = []
    const fixtureRequests: string[] = []
    page.on('request', request => {
      if (request.method() === 'POST') writes.push(new URL(request.url()).pathname)
      if (request.url().includes('__i0prep')) fixtureRequests.push(request.url())
    })
    await enter(page, service)
    await loginThroughForm(page, 'student', 'intentionally-incorrect')
    await expect(page.locator('.session-notice')).toContainText('账号或密码不正确')
    await expect(page.getByLabel('密码', { exact: true })).toHaveValue('')
    await page.getByRole('textbox', { name: '账号', exact: true }).fill('student')
    await page.getByLabel('密码', { exact: true }).fill(service.password)
    await page.getByLabel('密码', { exact: true }).press('Enter')
    await ready(page)
    expect(page.url()).toBe(`${service.base}/#/task/${service.assignmentId}`)
    expect(writes).toEqual(['/api/sessions', '/api/sessions'])
    await page.reload(); await ready(page)
    expect(writes).toEqual(['/api/sessions', '/api/sessions'])
    // 深链本身不授予权限，另一账号的分配由实际后端拒绝。
    await page.evaluate(id => { location.hash = `/task/${id}` }, service.otherAssignmentId)
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'unavailable')
    await expect(page.locator('.cw')).toHaveCount(0)
    await page.evaluate(() => { location.hash = '/' })
    await expect(page.locator('.account-name')).toHaveText('student')
    await page.locator('.account-pill').click()
    await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
    await expect(page.locator('.session-notice')).toContainText('已退出登录')
    expect((await page.context().request.get(service.base + '/api/session')).status()).toBe(401)
    expect(writes).toEqual(['/api/sessions', '/api/sessions', '/api/logout'])
    expect(fixtureRequests).toEqual([])
  } finally { await page.context().close(); await service.stop() }
})

test('HTTPS 退出/换账号后旧 ACK 和旧 401 不进入新会话；原账号草稿可恢复', async ({ page }) => {
  const service = await startSessionHost()
  let releaseAck = () => {}, releaseFailure = () => {}
  try {
    await enter(page, service)
    await loginThroughForm(page, 'student', service.password); await ready(page)
    await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    await expect(page.locator('.cw')).toBeVisible()
    await create(page); await edit(page, 'student-private-draft\n')
    let reached!: () => void, delivered!: () => void
    const atAuthority = new Promise<void>(r => { reached = r })
    const ackDelivered = new Promise<void>(r => { delivered = r })
    const ackHeld = new Promise<void>(r => { releaseAck = r })
    await page.route('**/api/attempts/*/sync', async route => {
      const response = await route.fetch()
      reached(); await ackHeld
      try { await route.fulfill({ response }) } finally { delivered() }
    })
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await atAuthority
    // 再编辑确保恢复的是原账号较新的本机草稿，而非冻结 ACK。
    await edit(page, 'student-newer-private-draft\n')
    // 同一旧会话另挂一个未来 401，回到同任务后仍不得踢掉新会话。
    let requested!: () => void, failureDelivered!: () => void, held = false
    const failureRequested = new Promise<void>(r => { requested = r })
    const finishedFailure = new Promise<void>(r => { failureDelivered = r })
    const failureHeld = new Promise<void>(r => { releaseFailure = r })
    await page.route(`**/api/assignments/${service.assignmentId}/bootstrap`, async route => {
      if (held) { await route.continue(); return }
      held = true; requested(); await failureHeld
      try { await route.fulfill({ status: 401, json: { requestId: 'held-expired-session', error: {
        code: 'UNAUTHENTICATED', message: 'Expired synthetic session', retryable: false, recovery: 'Login',
      } } }) } finally { failureDelivered() }
    })
    // 换一个路由再回原任务，启动旧 bootstrap 读取但不改变 Cookie。
    await page.evaluate(() => { location.hash = '/' })
    await expect(page.locator('.account-name')).toHaveText('student')
    await page.evaluate(id => { location.hash = `/task/${id}` }, service.assignmentId)
    await failureRequested
    await exit(page)
    await page.evaluate(id => { location.hash = `/task/${id}` }, service.otherAssignmentId)
    await loginThroughForm(page, 'other', service.password); await ready(page)
    await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    await expect(page.locator('.cw')).toBeVisible()
    releaseAck(); releaseFailure(); await Promise.all([ackDelivered, finishedFailure])
    const currentSession = (await (await page.context().request.get(service.base + '/api/session')).json()).data
    expect(currentSession.userId).toBe('other')
    await expect(page.locator('.cw')).toBeVisible()
    await expect(page.locator('body')).not.toContainText('student-newer-private-draft')
    await expect(page.locator('.cw-filetab')).toHaveCount(0)
    await create(page); await edit(page, 'other-account-draft\n')
    await exit(page)
    await page.evaluate(id => { location.hash = `/task/${id}` }, service.assignmentId)
    await loginThroughForm(page, 'student', service.password); await ready(page)
    await expect(page.locator('.cw')).toBeVisible()
    await expect(page.locator('.monaco-editor')).toContainText('student-newer-private-draft')
    await expect(page.locator('body')).not.toContainText('other-account-draft')
    await page.reload(); await ready(page)
    await expect(page.locator('.monaco-editor')).toContainText('student-newer-private-draft')
  } finally { releaseAck(); releaseFailure(); await page.context().close(); await service.stop() }
})

test('HTTPS 会话失效重新登录保留深链与草稿；退出失败可明确重试', async ({ page }) => {
  const service = await startSessionHost()
  try {
    await enter(page, service)
    await loginThroughForm(page, 'student', service.password); await ready(page)
    await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    await expect(page.locator('.cw')).toBeVisible()
    await create(page); await edit(page, 'unsynced-expired-session-draft\n')
    // 一次网络失败不是会话过期；恢复前台仍可继续本机编辑。
    await page.route('**/api/session', route => route.abort('failed'))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('.session-health')).toContainText('可继续本机编辑')
    await expect(page.locator('.cw')).toBeVisible()
    await edit(page, 'edited-while-session-check-offline\n')
    await page.unroute('**/api/session')
    await page.getByRole('button', { name: '重新核对登录', exact: true }).click()
    await expect(page.locator('.session-health')).toHaveCount(0)
    const session = (await (await page.context().request.get(service.base + '/api/session')).json()).data
    // 正常退出令当前 Cookie 失效；模拟服务端过期，UI 在下一读取接收真实 401。
    expect((await page.context().request.post(service.base + '/api/logout', {
      headers: { Origin: service.base, 'x-csrf-token': session.csrfToken }, data: {},
    })).status()).toBe(200)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expect(page.locator('.session-notice')).toContainText('登录已失效')
    await expect(page.locator('.cw')).toHaveCount(0)
    expect(page.url()).toBe(`${service.base}/#/task/${service.assignmentId}`)
    await loginThroughForm(page, 'student', service.password); await ready(page)
    await expect(page.locator('.monaco-editor')).toContainText('edited-while-session-check-offline')
    await page.route('**/api/logout', route => route.abort('failed'))
    await clickWorkspaceAction(page, '退出')
    await expect(page.locator('.session-notice')).toContainText('退出未确认')
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeDisabled()
    await expect(page.locator('.cw')).toHaveCount(0)
    await page.unroute('**/api/logout')
    await page.getByRole('button', { name: '重试退出', exact: true }).click()
    await expect(page.locator('.session-notice')).toContainText('已退出登录')
    expect((await page.context().request.get(service.base + '/api/session')).status()).toBe(401)
  } finally { await page.context().close(); await service.stop() }
})

test('HTTPS 多标签退出立即隔离；外部同账号新会话在前台恢复时重读', async ({ page }) => {
  const service = await startSessionHost()
  try {
    await enter(page, service)
    await loginThroughForm(page, 'student', service.password); await ready(page)
    const sibling = await page.context().newPage()
    await sibling.goto(page.url()); await ready(sibling)
    await exit(page)
    await expect(sibling.getByRole('heading', { name: '登录学习空间' })).toBeVisible()
    await expect(sibling.locator('.ts-badge')).toHaveCount(0)
    await loginThroughForm(page, 'other', service.password)
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'unavailable')
    await expect(sibling.locator('.session-notice')).toContainText('其他页面的登录状态已改变')
    await page.evaluate(id => { location.hash = `/task/${id}` }, service.otherAssignmentId); await ready(page)
    // 外部恢复同一账号的新 Cookie，HTTP Session/CSRF 与本机 epoch 必须重新建立。
    expect((await page.context().request.post(service.base + '/api/sessions', {
      headers: { Origin: service.base }, data: { loginName: 'other', password: service.password },
    })).status()).toBe(200)
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await ready(page)
    await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    await expect(page.locator('.cw')).toBeVisible()
    await expect(page.locator('body')).not.toContainText('student-private-draft')
    await sibling.close()
  } finally { await page.context().close(); await service.stop() }
})
