import { test, expect, type Page } from '@playwright/test'
import { PREP_URL } from './env'

const panel = (page: Page) => page.locator('.guidance-presentation')
const count = (page: Page) => page.getByTestId('receipt-count')
const action = (page: Page, name = '继续探索') => panel(page).getByRole('button', { name, exact: true })
const preview = async (page: Page) => {
  await page.goto(`${PREP_URL}/#/dev/guidance`)
  await expect(panel(page)).toBeVisible()
}
async function withinViewport(page: Page) {
  await expect.poll(async () => {
    const rect = await panel(page).boundingBox(), viewport = page.viewportSize()!
    return !!rect && rect.x >= 0 && rect.y >= 0 && rect.x + rect.width <= viewport.width + 1 && rect.y + rect.height <= viewport.height + 1
  }).toBe(true)
}

test('real mascot and text/card slot; only explicit actions create receipts; no business requests', async ({ page }) => {
  await preview(page)
  const writes: string[] = []
  page.on('request', request => { if (/\/api\/|\/__i0prep\//.test(request.url())) writes.push(`${request.method()} ${request.url()}`) })
  await expect(panel(page).locator('svg')).toHaveCount(1)
  await expect(panel(page)).toContainText('先看看你选择的对象')
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: /重复渲染/ }).click()
  await page.waitForTimeout(2400) // finite cue delay + lifetime must not imply acknowledgement
  await expect(count(page)).toHaveText('0')
  const workspaceClicks = await page.getByTestId('workspace-clicks').textContent()
  await action(page).click()
  await expect(count(page)).toHaveText('1')
  await expect(page.getByRole('list', { name: '操作回执' })).toContainText('"presentationId":"preview-1","actionId":"continue"')
  await expect(page.getByTestId('workspace-clicks')).toHaveText(workspaceClicks!)
  await page.getByRole('button', { name: '交互卡片', exact: true }).click()
  await panel(page).getByRole('textbox', { name: '我的预测' }).fill('改变一个条件再比较')
  await expect(count(page)).toHaveText('1')
  await action(page).click()
  await expect(count(page)).toHaveText('2')
  await expect(page.getByRole('list', { name: '操作回执' })).toContainText('"presentationId":"preview-2"')
  expect(writes).toEqual([])
})

test('hide, restore, quiet reopen, busy and waiting are externally controlled', async ({ page }) => {
  await preview(page)
  await action(page, '暂不').click()
  await expect(panel(page).locator('.guidance-bubble')).toHaveCount(0)
  await action(page, '重新打开引导').click()
  await expect(panel(page).locator('.guidance-bubble')).toBeVisible()
  await expect(count(page)).toHaveText('2')
  await page.getByLabel('展示状态', { exact: true }).selectOption('busy')
  await expect(panel(page)).toContainText('正在处理')
  await expect(action(page)).toBeDisabled()
  await page.getByLabel('展示状态', { exact: true }).selectOption('waiting')
  await expect(panel(page)).toContainText('等待你的操作')
  await action(page, '关闭').click()
  await expect(panel(page)).toHaveCount(0)
  await page.getByLabel('展示状态', { exact: true }).selectOption('showing')
  await expect(panel(page)).toBeVisible()
  await expect(count(page)).toHaveText('3')
})

test('keyboard actions work and new/replaced guidance never steals editing focus', async ({ page }) => {
  await preview(page)
  const input = page.getByRole('textbox', { name: '工作区输入' })
  await input.fill('正在编辑')
  // External update without moving focus, as a parent update would do.
  await page.getByRole('button', { name: '替换展示项', exact: true }).evaluate(button => (button as HTMLButtonElement).click())
  await expect(input).toBeFocused()
  await expect(panel(page)).toHaveAttribute('data-presentation-id', 'preview-2')
  await action(page).focus()
  await page.keyboard.press('Enter')
  await expect(count(page)).toHaveText('1')
  await action(page, '暂不').focus()
  await page.keyboard.press('Space')
  await expect(count(page)).toHaveText('2')
})

test('pointer or keyboard press on old item cannot respond to replacement or restored item', async ({ page }) => {
  await preview(page)
  const box = (await action(page).boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.getByRole('button', { name: '替换展示项', exact: true }).evaluate(button => (button as HTMLButtonElement).click())
  await expect(panel(page)).toHaveAttribute('data-presentation-id', 'preview-2')
  await page.mouse.up()
  await expect(count(page)).toHaveText('0')
  await action(page).focus()
  await page.keyboard.down('Space')
  await page.getByRole('button', { name: '替换展示项', exact: true }).evaluate(button => (button as HTMLButtonElement).click())
  await page.keyboard.up('Space')
  await expect(count(page)).toHaveText('0')
  const old = await action(page).elementHandle()
  await page.getByLabel('展示状态', { exact: true }).selectOption('hidden')
  await page.getByLabel('展示状态', { exact: true }).selectOption('showing')
  await old!.evaluate(button => (button as HTMLButtonElement).click())
  await expect(count(page)).toHaveText('0')
  await action(page).click()
  await expect(count(page)).toHaveText('1')
  await expect(page.getByRole('list', { name: '操作回执' })).toContainText('preview-3')
})

test('scrolling, moved, hidden, removed and invalid anchors quietly reflow without focus or scroll changes', async ({ page }) => {
  await preview(page)
  await expect(panel(page)).toHaveAttribute('data-placement', 'target')
  const before = await panel(page).boundingBox()
  await page.getByRole('button', { name: '移动目标', exact: true }).click()
  await expect.poll(async () => (await panel(page).boundingBox())!.x).not.toBe(before!.x)
  const input = page.getByRole('textbox', { name: '工作区输入' })
  await input.focus()
  await page.getByRole('button', { name: '切换目标可见性', exact: true }).evaluate(button => (button as HTMLButtonElement).click())
  await expect(panel(page)).toHaveAttribute('data-placement', 'rest')
  await expect(input).toBeFocused()
  await page.getByRole('button', { name: '切换目标可见性', exact: true }).click()
  await expect(panel(page)).toHaveAttribute('data-placement', 'target')
  await page.getByTestId('target-scroll').evaluate(element => { element.scrollTop = 700 })
  await expect(panel(page)).toHaveAttribute('data-placement', 'rest')
  const scroll = await page.getByTestId('target-scroll').evaluate(element => element.scrollTop)
  await page.waitForTimeout(150)
  expect(await page.getByTestId('target-scroll').evaluate(element => element.scrollTop)).toBe(scroll)
  await page.getByRole('button', { name: '移除或恢复目标', exact: true }).click()
  await expect(panel(page)).toHaveAttribute('data-placement', 'rest')
  await page.getByLabel('目标类型', { exact: true }).selectOption('invalid')
  await expect(panel(page)).toHaveAttribute('data-placement', 'rest')
  await page.getByLabel('目标类型', { exact: true }).selectOption('none')
  await withinViewport(page)
  await expect(count(page)).toHaveText('0')
})

test('narrow viewport and long text/card keep contents scrollable and actions reachable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await preview(page)
  await page.getByRole('button', { name: '切换长内容', exact: true }).click()
  await withinViewport(page)
  await expect.poll(() => panel(page).locator('.guidance-content').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true)
  await action(page).click()
  await page.getByRole('button', { name: '交互卡片', exact: true }).click()
  await withinViewport(page)
  await panel(page).getByRole('textbox', { name: '我的预测' }).fill('底部输入可到达')
  await action(page).click()
  await expect(count(page)).toHaveText('2')
  await page.setViewportSize({ width: 320, height: 700 })
  await withinViewport(page)
  await action(page, '关闭').click()
  await expect(panel(page)).toHaveCount(0)
})

test('reduced motion keeps real mascot static and actions usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await preview(page)
  await expect(panel(page).locator('svg')).toHaveAttribute('data-reduced-motion', 'true')
  await expect(panel(page).locator('svg')).toHaveAttribute('data-running', 'false')
  await action(page).click()
  await expect(count(page)).toHaveText('1')
})

test('unmount cancels animation/geometry frames, timers and visibility subscriptions; old controls stay inert', async ({ page }) => {
  await page.addInitScript(() => {
    const frames = new Set<number>(), timers = new Set<number>(), subscriptions = new Set<EventListenerOrEventListenerObject>()
    const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window)
    window.requestAnimationFrame = callback => { const id = raf(time => { frames.delete(id); callback(time) }); frames.add(id); return id }
    window.cancelAnimationFrame = id => { frames.delete(id); caf(id) }
    const timeout = window.setTimeout.bind(window), clear = window.clearTimeout.bind(window)
    window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => { const id = timeout(() => { timers.delete(id); if (typeof callback === 'function') callback(...args) }, delay); timers.add(id); return id }) as typeof window.setTimeout
    window.clearTimeout = id => { if (typeof id === 'number') timers.delete(id); clear(id) }
    const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document)
    document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean) => { if (type === 'visibilitychange') subscriptions.add(listener); add(type, listener, options) }) as typeof document.addEventListener
    document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: EventListenerOptions | boolean) => { if (type === 'visibilitychange') subscriptions.delete(listener); remove(type, listener, options) }) as typeof document.removeEventListener
    Object.assign(window, { guidanceResources: () => ({ frames: frames.size, timers: timers.size, subscriptions: subscriptions.size }) })
  })
  await preview(page)
  const old = await action(page).elementHandle()
  await page.getByRole('button', { name: '卸载组件', exact: true }).click()
  await expect(panel(page)).toHaveCount(0)
  await old!.evaluate(button => (button as HTMLButtonElement).click())
  const resources = () => page.evaluate(() => (window as unknown as { guidanceResources: () => object }).guidanceResources())
  await expect.poll(resources).toEqual({ frames: 0, timers: 0, subscriptions: 0 })
  await expect(count(page)).toHaveText('0')
  await page.getByRole('button', { name: '挂载组件', exact: true }).click()
  await action(page).click()
  await expect(count(page)).toHaveText('1')
})

test('legacy script actually renders through the generic component and advances/collects', async ({ page }) => {
  await preview(page)
  await page.getByRole('button', { name: '旧脚本适配', exact: true }).click()
  await expect(panel(page)).toContainText('旧脚本仍可提供文字')
  await expect(page.locator('.ws-bubble')).toHaveCount(0)
  const identity = await panel(page).getAttribute('data-presentation-id')
  await action(page, '下一步').click()
  await expect(page.getByRole('list', { name: '操作回执' })).toContainText(`"presentationId":"${identity}"`)
  await expect(panel(page)).toContainText('为什么会跳多数？')
  await action(page, '收纳').click()
  await expect(panel(page)).toContainText('卡片已收进左侧')
  await action(page, '开始动手').click()
  await expect(panel(page).locator('.guidance-bubble')).toHaveCount(0)
})


test('legacy text replacement at the same index invalidates an already pressed next button', async ({ page }) => {
  await preview(page)
  await page.getByRole('button', { name: '旧脚本适配', exact: true }).click()
  const identity = await panel(page).getAttribute('data-presentation-id')
  const box = (await action(page, '下一步').boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.getByRole('button', { name: '替换旧脚本文字', exact: true }).evaluate(button => (button as HTMLButtonElement).click())
  await expect(panel(page)).toContainText('同一索引的新提示')
  await expect(panel(page)).not.toHaveAttribute('data-presentation-id', identity!)
  await page.mouse.up()
  await expect(count(page)).toHaveText('0')
  await expect(panel(page)).toContainText('同一索引的新提示')
  await action(page, '下一步').click()
  await expect(panel(page)).toContainText('为什么会跳多数？')
})


test('position targets, CSS transforms, hidden ancestors and clipped targets resolve from live geometry', async ({ page }) => {
  await preview(page)
  const target = page.getByRole('button', { name: '观察对象', exact: true })
  const before = await panel(page).boundingBox()
  await target.evaluate(element => { element.style.transform = 'translateX(100px)' })
  await expect.poll(async () => (await panel(page).boundingBox())!.x).not.toBe(before!.x)
  await target.evaluate(element => { element.parentElement!.style.opacity = '0' })
  await expect(panel(page)).toHaveAttribute('data-placement', 'rest')
  await target.evaluate(element => { element.parentElement!.style.opacity = '1' })
  await expect(panel(page)).toHaveAttribute('data-placement', 'target')
  await page.getByLabel('目标类型', { exact: true }).selectOption('position')
  await expect(panel(page)).toHaveAttribute('data-placement', 'target')
  await withinViewport(page)
  await expect(count(page)).toHaveText('0')
})
