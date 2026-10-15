import { expect, test, type Page } from '@playwright/test'
import type { ModelProvider } from '../src/lib/settings'
import { REAL_URL } from './env'

// Synthetic HTTP protocol tests; no real credential, supplier request or model call.
test.use({ trace: 'off' })
type Mutation = { expectedRevision: number; enabled: boolean; defaultModelId: string; providers: ModelProvider[]; efforts: Record<string, string> }
type Configuration = Omit<Mutation, 'expectedRevision' | 'providers'> & {
  revision: number; callsEnabled: boolean; providers: Array<Omit<ModelProvider, 'apiKey'>>
}
async function installTeacher(page: Page, role: 'teacher' | 'student' = 'teacher') {
  let current: Configuration = { revision: 0, enabled: false, callsEnabled: true, defaultModelId: '', providers: [], efforts: {} }
  let failSave = true
  const writes: Mutation[] = [], paths: string[] = []
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    paths.push(path)
    let data: unknown
    if (path === '/api/session') data = { userId: `synthetic-settings-${role}`, csrfToken: 'synthetic-teacher-csrf', courses: [{ courseId: 'synthetic-course', role }] }
    else if (path === '/api/courses/synthetic-course/teacher-workbench') data = {
      courseId: 'synthetic-course', recoveryGeneration: 'synthetic-g', members: [], resources: [], drafts: [], activities: [], assignments: [], attempts: [], presets: [],
    }
    else if (path === '/api/model-settings/test') {
      expect(request.method()).toBe('POST')
      expect(request.headers()['x-csrf-token']).toBe('synthetic-teacher-csrf')
      data = { ok: true, latencyMs: 8, modelCount: 1, models: [{ id: 'teacher-model', contextWindow: 300000,
        maxOutputTokens: 131072, inputTypes: ['image'], reasoningLevels: ['low', 'high', 'max'] }] }
    }
    else if (path === '/api/model-settings') {
      if (request.method() === 'POST') {
        expect(request.headers()['x-csrf-token']).toBe('synthetic-teacher-csrf')
        const body = request.postDataJSON() as Mutation
        writes.push(body)
        expect(body.expectedRevision).toBe(current.revision)
        if (failSave) {
          await route.fulfill({ status: 409, json: { requestId: 'synthetic-conflict', error: {
            code: 'VERSION_CONFLICT', message: 'Configuration changed', retryable: false, recovery: 'Read current configuration',
          } } }); return
        }
        current = { revision: current.revision + 1, callsEnabled: true, enabled: body.enabled,
          defaultModelId: body.defaultModelId, efforts: body.efforts,
          providers: body.providers.map(p => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models, hasKey: true, keyHint: '••••test' })) }
      }
      data = current
    }
    if (data === undefined) { await route.fulfill({ status: 404, json: { requestId: 'unexpected', error: { code: 'NOT_FOUND' } } }); return }
    await route.fulfill({ json: { requestId: 'teacher-model-protocol', data } })
  })
  return { writes, paths, allowSave: () => { failSave = false }, read: () => current }
}

test('教师设置复用供应商保存、模型能力、强度、连接测试和脱敏持久读取', async ({ page }, info) => {
  const api = await installTeacher(page)
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${REAL_URL}/#/teacher/settings`)
  await page.getByRole('navigation', { name: '教师设置导航' }).getByRole('link', { name: '模型', exact: true }).click()
  await expect(page).toHaveURL(`${REAL_URL}/#/teacher/settings/model`)
  await expect(page.getByRole('heading', { name: '个人模型配置', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '添加自定义供应商', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: '添加自定义供应商', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '添加供应商', exact: true })
  await dialog.getByPlaceholder('例如：DeepSeek 官方').fill('教师合成供应商')
  await dialog.getByPlaceholder('https://api.example.com/v1').fill('https://provider.example/v1')
  await dialog.locator('input[type="password"]').fill('synthetic-teacher-api-key')
  await dialog.getByRole('button', { name: '连接测试', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('连接成功')
  await dialog.getByLabel('供应商可用模型', { exact: true }).selectOption('teacher-model')
  await expect(dialog.getByPlaceholder('如 131072')).toHaveValue('300000')
  await expect(dialog.getByPlaceholder('如 30000')).toHaveValue('131072')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog.getByRole('alert')).toContainText('保存未确认')
  await expect(dialog).toBeVisible()
  api.allowSave()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  expect(api.writes[1].providers[0].apiKey).toBe('synthetic-teacher-api-key')
  expect(api.read().providers[0].models[0]).toMatchObject({ contextWindow: '300000', maxOutput: '131072', inputTypes: ['image'], reasoningLevels: ['low', 'high', 'max'] })
  await page.getByRole('button', { name: '启用个人模型', exact: true }).click()
  await expect(page.getByText('个人模型已启用', { exact: true })).toBeVisible()
  await page.getByRole('radiogroup', { name: '思考强度', exact: true }).getByRole('radio', { name: '最高', exact: true }).click()
  await expect.poll(() => api.read().efforts[api.read().defaultModelId]).toBe('最高')
  expect(api.writes.at(-1)?.providers[0]).not.toHaveProperty('apiKey')
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('synthetic-teacher-api-key')
  await page.reload()
  await expect(page.getByRole('radio', { name: '最高', exact: true })).toHaveAttribute('aria-checked', 'true')
  await expect(page.locator('.st-provider').filter({ hasText: '教师合成供应商' })).toContainText('密钥已保存')
  for (const width of [1440, 720, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    await expect.poll(() => page.locator('.t-main').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: info.outputPath(`teacher-model-settings-${width}.png`), fullPage: true })
  }
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page.getByRole('dialog').locator('input[type="password"]')).toHaveValue('')
  expect(errors).toEqual([])
})

test('教师预览与无教师权限账号不加载个人模型配置', async ({ page }) => {
  const api = await installTeacher(page, 'student')
  await page.goto(`${REAL_URL}/#/teacher/preview/settings/model`)
  await expect(page.getByRole('heading', { name: '模型配置使用真实账号', exact: true })).toBeVisible()
  expect(api.paths.filter(path => path.startsWith('/api/model-settings'))).toEqual([])
  await page.goto(`${REAL_URL}/#/teacher/settings/model`)
  await expect(page.getByRole('heading', { name: '当前账号没有教师课程', exact: true })).toBeVisible()
  expect(api.paths.filter(path => path.startsWith('/api/model-settings'))).toEqual([])
})
