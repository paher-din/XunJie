import { expect, test } from '@playwright/test'
import { REAL_URL } from './env'
import { loginThroughForm } from './sessionHost'

test.use({ trace: 'off' })
const expired = { requestId: 'auth-protocol', error: {
  code: 'UNAUTHENTICATED', message: 'No synthetic session', retryable: false, recovery: 'Login',
} }

for (const scenario of [
  { selected: '学生', actual: 'student', path: '/task/authorized-link', landing: '/task/authorized-link' },
  { selected: '教师', actual: 'teacher', path: '/', landing: '/teacher' },
  { selected: '教师', actual: 'student', path: '/teacher', landing: '/' },
  { selected: '学生', actual: 'teacher', path: '/task/authorized-link', landing: '/teacher' },
] as const) {
  test(`统一登录选择${scenario.selected}，真实${scenario.actual}角色进入${scenario.landing}`, async ({ page }) => {
    let authenticated = false, bootstrapReads = 0, teacherReads = 0
    const loginBodies: unknown[] = []
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname
      let data: unknown
      if (path === '/api/sessions') { loginBodies.push(route.request().postDataJSON()); authenticated = true; data = { csrfToken: 'csrf-role' } }
      else if (path === '/api/session' && authenticated) data = { userId: 'role-account', csrfToken: 'csrf-role', courses: [{ courseId: 'role-course', role: scenario.actual }] }
      else if (!authenticated) { await route.fulfill({ status: 401, json: expired }); return }
      else if (path === '/api/model-settings') data = { revision: 0, enabled: false, callsEnabled: false, defaultModelId: '', providers: [], efforts: {} }
      else if (path === '/api/agent/conversations' || path === '/api/courses/role-course/assignments') data = []
      else if (path === '/api/courses/role-course/teacher-workbench') {
        teacherReads++; data = { courseId: 'role-course', recoveryGeneration: 'role-generation', members: [], resources: [], drafts: [], activities: [], assignments: [], attempts: [], presets: [] }
      } else if (path.endsWith('/bootstrap')) bootstrapReads++
      if (data === undefined) await route.fulfill({ status: 422, json: { ...expired, error: { ...expired.error, code: 'INVALID_REFERENCE' } } })
      else await route.fulfill({ json: { requestId: 'role-entry', data } })
    })
    await page.goto(`${REAL_URL}/#${scenario.path}`)
    await expect(page.getByRole('heading', { name: '登录学习空间' })).toBeVisible()
    await page.getByRole('group', { name: '登录身份' }).getByRole('button', { name: scenario.selected, exact: true }).click()
    await expect(page.getByRole('button', { name: scenario.selected, exact: true })).toHaveAttribute('aria-pressed', 'true')
    if (scenario.actual === 'teacher' && scenario.selected === '教师') await page.locator('.session-card').screenshot({ path: test.info().outputPath('unified-role-login.png') })
    await loginThroughForm(page, 'synthetic-role-login', 'synthetic-only')
    await expect(page).toHaveURL(`${REAL_URL}/#${scenario.landing}`)
    await expect(page.getByRole('heading', { name: '登录学习空间' })).toHaveCount(0)
    expect(loginBodies).toEqual([{ loginName: 'synthetic-role-login', password: 'synthetic-only' }])
    if (scenario.actual === 'teacher') {
      await expect(page.getByRole('navigation').getByRole('link', { name: '教学概览', exact: true })).toBeVisible()
      await expect(page.getByRole('link', { name: '学生空间入口', exact: true })).toHaveCount(0)
      expect(bootstrapReads).toBe(0)
    }
    else expect(teacherReads).toBe(0)
    // A reused session still cannot enter the other role's space by changing the URL.
    if (scenario.actual === 'student' && scenario.selected === '教师') {
      await expect(page.locator('.account-name')).toHaveText('role-account')
      await page.goto(`${REAL_URL}/#/teacher/settings`)
      await expect(page).toHaveURL(`${REAL_URL}/#/`)
      await expect(page.locator('.account-name')).toHaveText('role-account')
      expect(teacherReads).toBe(0)
    }
  })
}

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
    } else if ((path === '/api/courses/protocol-course/assignments' || path === '/api/agent/conversations') && identity) {
      data = []
    } else if (path === '/api/model-settings' && identity) {
      // AppShell reads personal settings after login; this scenario keeps models disabled.
      data = { revision: 0, enabled: false, callsEnabled: false, defaultModelId: '', providers: [], efforts: {} }
    } else if (path === '/api/assignments/authorized-link/bootstrap') {
      bootstrapReached(); await held
      await route.fulfill({ status: 401, json: expired }); bootstrapDelivered(); return
    }
    if (data === undefined) await route.fulfill(identity
      ? {status:404,json:{requestId:'auth-protocol-missing',error:{code:'NOT_FOUND',message:'Synthetic missing route',retryable:false,recovery:'Read the current authorized state'}}}
      : {status:401,json:expired})
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
