import { expect, test, type Page } from '@playwright/test'
import { COUNTER_TASK_PATH, PREP_TASK_PATH, PREP_URL, isLoopback } from './env'

/**
 * I0-A 准备模式的浏览器检查（01 的范围）。
 *
 * 全部断言落在真实 Vite 页面的可见正文、状态与实际发出的请求上；不拦截网络造成功响应，
 * 也不在测试里另建一套假业务。fixture 由 `npm run dev:prep` 的开发进程提供。
 */

/** 记录页面发出的所有请求 URL，用于断言走了准备端点、且没有外发。 */
function trackRequests(page: Page): string[] {
  const urls: string[] = []
  page.on('request', (r) => urls.push(r.url()))
  return urls
}

function prepUrl(path = PREP_TASK_PATH): string {
  return PREP_URL + path
}

test.describe('准备入口与模式', () => {
  test('首页准备入口明确标合成，点击进入 C 中心容器而非工具包占位', async ({ page }) => {
    const urls = trackRequests(page)
    await page.goto(prepUrl('/#/'))

    const entry = page.locator('.prep-entry')
    await expect(entry).toBeVisible()
    await expect(entry.locator('.prep-entry-flag')).toContainText('准备场景（合成）')
    await expect(entry.locator('.prep-entry-note')).toContainText('不是正式分配')
    await expect(entry.locator('.prep-entry-note')).toContainText('不写入学习记录')

    await entry.getByRole('button', { name: '进入准备工作区' }).click()
    await expect(page).toHaveURL(/#\/task\/i0-prep-textscope-c$/)

    // 落在既有中心容器里，不是原「工具包待接入」整块占位
    await expect(page.locator('.ws-toolkit-pending')).toHaveCount(0)
    await expect(page.getByRole('tablist', { name: '工具' })).toBeVisible()
    await expect(page.locator('.ts-pane-head')).toContainText('C 正文区')
    await expect(page.locator('.ts-pending-pill')).toHaveText('编辑待 02 接入')
    // 正文区不假称已可保存
    await expect(page.locator('.ts-pane-lead')).toContainText('还没有任何保存能力')

    // 初始化确实打了准备 fixture 的读取端点
    expect(urls.some((u) => u.includes('/__i0prep/context'))).toBe(true)
    expect(urls.some((u) => u.includes('/__i0prep/api/sessions'))).toBe(true)
    expect(urls.some((u) => u.includes('/__i0prep/api/session'))).toBe(true)
    expect(urls.some((u) => u.includes('/__i0prep/api/assignments/prep-assignment-textscope-c-01'))).toBe(true)
    expect(urls.some((u) => u.includes('/__i0prep/api/activities/prep-activity-version-textscope-c-01?audience=student'))).toBe(true)
    expect(urls.some((u) => u.includes('/__i0prep/api/resources/prep-resource-brief-01'))).toBe(true)

    // 载入不创建 Attempt、不开始学习：没有任何写命令
    expect(urls.filter((u) => u.includes('/attempts'))).toEqual([])
    expect(urls.filter((u) => u.includes('/sync') || u.includes('/snapshots') || u.includes('/runs'))).toEqual([])
  })

  test('顶栏标识准备模式与合成身份，并如实记录 U-07 登录缺口', async ({ page }) => {
    await page.goto(prepUrl())

    const badge = page.locator('.ts-badge')
    await expect(badge).toHaveAttribute('data-status', 'ready')
    await expect(badge).toContainText('准备场景（合成）')
    await expect(badge.locator('.ts-badge-meta')).toContainText(/loadEpoch \d+/)

    await page.getByRole('button', { name: '任务信息' }).click()
    const info = page.locator('.ts-taskinfo')
    // preparation epoch 在阅读位置完整展示（顶栏不重复，避免窄视口溢出）
    await expect(info).toContainText(/prep-epoch-[0-9a-f]+/)
    await expect(info).toContainText('合成身份与合成材料，不是正式分配，不写入学习记录')
    // 身份来自合成 Session，不是设置页昵称
    await expect(info).toContainText('prep-student-01')
    await expect(info).toContainText('prep-course-c17（student）')
    // 真实登录 UI 未交付，缺口如实显示，不自建页面
    await expect(info).toContainText('未交付（U-07）')
    // 固定活动版本与运行时 profile 保留归属
    await expect(info).toContainText('prep-activity-version-textscope-c-01')
    await expect(info).toContainText('c17-gcc15.3.0-textscope-v1')
    // 准备场景不复用数字逻辑演示的任务数据
    await expect(info).not.toContainText('可交互数字计数器')
  })

  test('刷新后重新读取同一份权威内容', async ({ page }) => {
    const urls = trackRequests(page)
    await page.goto(prepUrl())
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')

    const firstRound = urls.filter((u) => u.includes('/__i0prep/api/session')).length
    expect(firstRound).toBeGreaterThan(0)

    await page.reload()
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
    const afterReload = urls.filter((u) => u.includes('/__i0prep/api/session')).length
    expect(afterReload).toBeGreaterThan(firstRound)

    await page.getByRole('button', { name: '任务信息' }).click()
    await expect(page.locator('.ts-taskinfo')).toContainText('TextScope 文本统计工具')
    await expect(page.locator('.ts-material')).toHaveCount(4)
  })
})

test.describe('活动要求与材料', () => {
  test('三条并列能力线与活动要求按 student 视角呈现', async ({ page }) => {
    await page.goto(prepUrl())
    await page.getByRole('button', { name: '任务信息' }).click()
    const info = page.locator('.ts-taskinfo')

    await expect(info).toContainText('学科知识与技能')
    await expect(info).toContainText('项目能力')
    await expect(info).toContainText('人机协同与 AI 素养')
    await expect(info).toContainText('用 C 完成文本读入、切词与计数')
    await expect(info).toContainText('帮助策略')
    await expect(info).toContainText('不给整份实现=true')
  })

  test('材料按 visibility 分状态呈现，redacted / unavailable 不泄露任何正文', async ({ page }) => {
    await page.goto(prepUrl())
    await page.getByRole('button', { name: '任务信息' }).click()

    const materials = page.locator('.ts-material')
    await expect(materials).toHaveCount(4)
    await expect(materials.nth(0).locator('.ts-material-status')).toHaveText('available')
    await expect(materials.nth(1).locator('.ts-material-status')).toHaveText('available')
    await expect(materials.nth(2).locator('.ts-material-status')).toHaveText('redacted')
    await expect(materials.nth(3).locator('.ts-material-status')).toHaveText('unavailable')

    await expect(materials.nth(0)).toContainText('TextScope 任务说明')
    await expect(materials.nth(0)).toContainText('段')
    await expect(materials.nth(2)).toContainText('服务端已裁剪：不返回 ID、标题或正文，客户端不补造内容。')
    await expect(materials.nth(3)).toContainText('固定版本与当前草稿不一致或缺失')

    // 私有答案与不可用材料的 ID / 标题 / 正文都不得出现在页面里
    const html = await page.locator('.ts-taskinfo').innerHTML()
    expect(html).not.toContain('参考实现')
    expect(html).not.toContain('永远不应该出现在学生响应里')
    expect(html).not.toContain('已过期的补充材料')
    expect(html).not.toContain('prep-resource-private-answer-01')
    expect(html).not.toContain('prep-resource-stale-01')
  })
})

test.describe('C 场景不触发模拟构建与主动教学', () => {
  test('没有模拟构建 / 烧录入口，也没有引导层与浮动 IP', async ({ page }) => {
    await page.goto(prepUrl())
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')

    await expect(page.getByRole('button', { name: '检查并构建' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /烧录到虚拟板/ })).toHaveCount(0)
    await expect(page.locator('.ws-ip')).toHaveCount(0)
    await expect(page.locator('.ws-intro-veil')).toHaveCount(0)
    await expect(page.locator('.ws-chatpane')).toHaveCount(0)

    // 顶栏运行簇如实说明只读边界与后续归属
    const run = page.locator('.ws-head-run')
    await expect(run).toContainText('只读载入')
    await expect(run).toContainText('保存待 03')
    await expect(run).toContainText('运行待 06')
  })

  test('C 容器里保留的 board / wave 明确标为数字逻辑演示', async ({ page }) => {
    await page.goto(prepUrl())
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')

    await page.getByRole('tab', { name: '虚拟板' }).click()
    await expect(page.locator('.ws-demo-banner')).toContainText('数字逻辑演示 · 与当前 C 活动无关')
    await expect(page.locator('.ws-board-note')).toContainText('板卡行为由界面脚本模拟')

    await page.getByRole('tab', { name: '波形' }).click()
    await expect(page.locator('.ws-demo-banner')).toContainText('数字逻辑演示 · 与当前 C 活动无关')
    await expect(page.locator('.ws-wave')).toContainText('波形为静态示意')
  })
})

test.describe('原数字逻辑演示保留', () => {
  test('首次进入仍有原任务卡入场，演示身份明确', async ({ page }) => {
    await page.goto(prepUrl(COUNTER_TASK_PATH))
    const veil = page.locator('.ws-intro-veil')
    await expect(veil).toBeVisible()
    await expect(veil).toContainText('可交互数字计数器')
    await veil.getByRole('button', { name: /开始任务|进入任务/ }).click()
    await expect(veil).toHaveCount(0)

    await page.getByRole('button', { name: '任务信息' }).click()
    await expect(page.locator('.ws-demo-flag')).toContainText('演示数据')
    await expect(page.locator('.ws-taskinfo')).toContainText('可交互数字计数器')
  })

  test('静态代码、板卡与波形仍可访问且各自标演示', async ({ page }) => {
    // 跳过入场卡与引导脚本，直接检查三个工具页的可见状态
    await page.addInitScript(() => {
      sessionStorage.setItem('ws-seen:counter', '1')
      sessionStorage.setItem('ws-guide:counter', '99')
    })
    await page.goto(prepUrl(COUNTER_TASK_PATH))

    await expect(page.getByRole('tab')).toHaveCount(3)

    await page.getByRole('tab', { name: '虚拟板' }).click()
    const segBefore = await page.locator('.ws-seg-row').innerHTML()
    await page.getByRole('button', { name: '计数' }).click()
    expect(await page.locator('.ws-seg-row').innerHTML()).not.toBe(segBefore)
    await expect(page.locator('.ws-board-note')).toContainText('板卡行为由界面脚本模拟，未接仿真器')

    await page.getByRole('tab', { name: '波形' }).click()
    await expect(page.locator('.ws-wave')).toContainText('波形为静态示意')

    await page.getByRole('tab', { name: '设计' }).click()
    await expect(page.locator('.ws-editor')).toContainText('module')
    await expect(page.locator('.ws-editor-note')).toContainText('静态演示代码')

    // 原模拟构建保留其演示标识
    await page.getByRole('button', { name: '检查并构建' }).click()
    await expect(page.locator('.toast')).toContainText('模拟')
  })
})

test.describe('准备模式不外发', () => {
  test('provider 连接测试不请求外部服务，学校测试明确标模拟', async ({ page }) => {
    const urls = trackRequests(page)
    await page.goto(prepUrl('/#/settings/model'))

    // 用唯一的 baseUrl 过滤：学校块的模型 chip 里也会出现供应商名，按名字过滤会命中两块
    const customProvider = page.locator('.st-provider', { hasText: 'api.deepseek.com' })
    await expect(customProvider).toHaveCount(1)
    await customProvider.getByRole('button', { name: '连接测试' }).click()
    await expect(customProvider.locator('.st-test-result')).toContainText('准备场景不发起外部供应商请求')
    await expect(customProvider.locator('.st-test-result')).toContainText('I0-A 不调用真实教学模型')

    const school = page.locator('.st-provider', { hasText: 'llm-gateway.edu.cn' })
    await expect(school).toHaveCount(1)
    await school.getByRole('button', { name: '连接测试' }).click()
    await expect(school.locator('.st-test-result')).toContainText('连接成功（模拟，未发起真实请求）')

    const external = urls.filter((u) => !isLoopback(u))
    expect(external).toEqual([])
  })
})
