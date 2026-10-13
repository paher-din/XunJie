import { expect, test } from '@playwright/test'
import { REAL_URL } from './env'

/**
 * 真实模式（普通 `npm run dev`）的边界核对。
 *
 * 依据 docs/tasks/I0_UI_CLIENT_CONTRACT.md §2：普通 dev 用真实 transport，真实初始化不足时
 * 显示不可用，**不能自动改用 fixture**。H-01（正常业务宿主与同源 HTTPS 入口）与 H-02（本人分配
 * 发现入口）尚未交接，因此真实模式现在没有可用的工作区初始化——这里断言的是「如实没有」，
 * 不是「已经接通」。
 */

test.describe('真实模式', () => {
  test('不挂载准备 fixture，也不暴露准备入口与准备页面', async ({ page, request }) => {
    const ctx = await request.get(REAL_URL + '/__i0prep/context', {
      headers: { Accept: 'application/json' },
    })
    const ctxBody = await ctx.text()
    expect(ctxBody).not.toContain('i0-prep-textscope-c')
    expect(ctxBody).not.toContain('preparationEpoch')
    expect(ctxBody).not.toContain('syntheticAccount')

    await page.goto(REAL_URL + '/#/')
    await expect(page.locator('.prep-entry')).toHaveCount(0)

    // 准备场景路由在真实模式下不可达，落回原工作区的「没有找到这个任务」
    await page.goto(REAL_URL + '/#/task/i0-prep-textscope-c')
    await expect(page.locator('.ws-missing')).toContainText('没有找到这个任务')
  })

  test('真实 /api 没有可回退的数据源（H-01 缺口如实暴露）', async ({ request }) => {
    const res = await request.get(REAL_URL + '/api/session', {
      headers: { Accept: 'application/json' },
    })
    const body = await res.text()
    // 断言「拿不到可用会话」，不用「状态码 >= 400 或不是信封」这类恒真条件：
    // 无论开发服务器落回 SPA HTML（200）还是真实后端回 401 信封，都不得出现可用的会话字段，
    // 也不得出现准备 fixture 的合成身份或端点。
    expect(body).not.toContain('csrfToken')
    expect(body).not.toContain('"userId"')
    expect(body).not.toContain('prep-student-01')
    expect(body).not.toContain('__i0prep')
    expect(body).not.toContain('i0-prep-textscope-c')
    if (res.status() === 200) {
      // 200 只可能是 Vite 落回的 SPA HTML，不能是 JSON 会话信封
      expect(res.headers()['content-type'] ?? '').not.toContain('application/json')
    } else {
      expect(res.status()).toBeGreaterThanOrEqual(400)
    }
  })

  test('原数字逻辑演示在真实模式下同样保留', async ({ page }) => {
    await page.goto(REAL_URL + '/#/task/counter')
    await expect(page.locator('.ws-intro-veil')).toContainText('可交互数字计数器')
    await page.locator('.ws-intro-veil').getByRole('button', { name: /开始任务|进入任务/ }).click()
    await page.getByRole('button', { name: '任务信息' }).click()
    await expect(page.locator('.ws-demo-flag')).toContainText('演示数据')
    await expect(page.getByRole('button', { name: '检查并构建' })).toBeVisible()
  })
})
