import { expect, test } from '@playwright/test'
import { REAL_URL } from './env'
import { loginThroughForm } from './sessionHost'

test.use({ trace: 'off' })
const expired = { requestId: 'auth-protocol', error: {
  code: 'UNAUTHENTICATED', message: 'No synthetic session', retryable: false, recovery: 'Login',
} }

test('登录入口键盘与浅深主题；限流、错误信封和断网保留真实失败', async ({ page }, info) => {
  let failure: 'limit' | 'malformed' | 'offline' = 'limit'
  let submissions = 0
  await page.route('**/api/session', route => route.fulfill({ status: 401, json: expired }))
  await page.route('**/api/sessions', async route => {
    submissions += 1
    if (failure === 'offline') { await route.abort('failed'); return }
    if (failure === 'malformed') { await route.fulfill({ json: { csrfToken: 'untrusted' } }); return }
    await route.fulfill({ status: 429, json: { ...expired, error: { ...expired.error, code: 'RATE_LIMITED' } } })
  })
  await page.goto(`${REAL_URL}/#/task/authorized-link`)
  await expect(page.getByRole('textbox', { name: '账号', exact: true })).toBeFocused()
  await page.screenshot({ path: info.outputPath('login-light.png') })
  // 登录页沿用系统主题响应，仅读取既有主题设置。
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: info.outputPath('login-dark.png') })
  await page.getByRole('textbox', { name: '账号', exact: true }).fill('synthetic-login')
  await page.keyboard.press('Tab')
  await expect(page.getByLabel('密码', { exact: true })).toBeFocused()
  await page.keyboard.insertText('synthetic-only')
  await page.keyboard.press('Enter')
  await expect(page.locator('.session-notice')).toContainText('登录尝试过于频繁')
  expect(submissions).toBe(1)
  await expect(page.getByLabel('密码', { exact: true })).toHaveValue('')
  failure = 'malformed'
  await loginThroughForm(page, 'synthetic-login', 'synthetic-only')
  await expect(page.locator('.session-notice')).toContainText('登录服务暂时无法连接')
  failure = 'offline'
  await loginThroughForm(page, 'synthetic-login', 'synthetic-only')
  await expect(page.locator('.session-notice')).toContainText('登录服务暂时无法连接')
  expect(submissions).toBe(3)
  await expect(page.locator('.cw')).toHaveCount(0)
  expect(page.url()).toBe(`${REAL_URL}/#/task/authorized-link`)
  // 实际 DOM/localStorage 不保存本次凭据；测试口令仅合成。
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('synthetic-only')
})

test('会话入口等待有上限，超时不冒充登录成功或自动重试', async ({ page }) => {
  await page.clock.install()
  let begun!: () => void, release!: () => void, submissions = 0
  const started = new Promise<void>(r => { begun = r })
  const held = new Promise<void>(r => { release = r })
  await page.route('**/api/session', route => route.fulfill({ status: 401, json: expired }))
  await page.route('**/api/sessions', async route => {
    submissions += 1; begun(); await held
    await route.abort('failed').catch(() => {})
  })
  try {
    await page.goto(`${REAL_URL}/#/task/authorized-link`)
    await expect(page.locator('.session-notice')).toContainText('请登录后继续')
    await loginThroughForm(page, 'synthetic-login', 'synthetic-only')
    await started
    await page.clock.fastForward(15_001)
    await expect(page.locator('.session-notice')).toContainText('登录服务暂时无法连接')
    await expect(page.getByRole('button', { name: '登录', exact: true })).toBeEnabled()
    expect(submissions).toBe(1)
    await expect(page.locator('.cw')).toHaveCount(0)
  } finally { release() }
})

test('取消请求失效时仍靠会话代次拒收旧 Session 成功与旧 401', async ({ page }) => {
  // 故意禁用取消优化，证明正确性仍由代次/上下文守卫保证。
  await page.addInitScript(() => { AbortController.prototype.abort = () => {} })
  let identity: string | null = null, holdSession = false
  let sessionReached!: () => void, bootstrapReached!: () => void, release!: () => void
  let sessionDelivered!: () => void, bootstrapDelivered!: () => void
  const oldSession = new Promise<void>(r => { sessionReached = r })
  const oldBootstrap = new Promise<void>(r => { bootstrapReached = r })
  const held = new Promise<void>(r => { release = r })
  const delivered = Promise.all([
    new Promise<void>(r => { sessionDelivered = r }), new Promise<void>(r => { bootstrapDelivered = r }),
  ])
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    let data: unknown
    if (path === '/api/sessions') {
      identity = route.request().postDataJSON().loginName
      data = { csrfToken: `csrf-${identity}` }
    } else if (path === '/api/logout') {
      identity = null; data = { loggedOut: true }
    } else if (path === '/api/session' && identity) {
      data = { userId: identity, courses: [{ courseId: 'protocol-course', role: 'student' }], csrfToken: `csrf-${identity}` }
      if (holdSession) {
        holdSession = false; sessionReached(); await held
        await route.fulfill({ json: { requestId: 'old-session-read', data } }); sessionDelivered(); return
      }
    } else if (path === '/api/assignments/authorized-link/bootstrap') {
      bootstrapReached(); await held
      await route.fulfill({ status: 401, json: expired }); bootstrapDelivered(); return
    }
    if (data === undefined) await route.fulfill({ status: 401, json: expired })
    else await route.fulfill({ json: { requestId: 'auth-protocol', data } })
  })
  try {
    await page.goto(`${REAL_URL}/#/task/authorized-link`)
    await expect(page.locator('.session-notice')).toContainText('请登录后继续')
    await loginThroughForm(page, 'account-a', 'synthetic-only')
    await oldBootstrap
    holdSession = true
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await oldSession
    await page.getByRole('button', { name: '退出', exact: true }).click()
    await expect(page.locator('.session-notice')).toContainText('已退出登录')
    await page.evaluate(() => { location.hash = '/' })
    await loginThroughForm(page, 'account-b', 'synthetic-only')
    await expect(page.locator('.account-name')).toHaveText('account-b')
    release(); await delivered
    await expect(page.locator('.account-name')).toHaveText('account-b')
    await expect(page.getByRole('heading', { name: '登录学习空间' })).toHaveCount(0)
  } finally { release() }
})
