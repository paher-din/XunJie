import { expect, test, type Page } from '@playwright/test'
import { PREP_URL } from './env'

const sidebarWidth = (page: Page) => page.locator('.sidebar').evaluate(element => element.getBoundingClientRect().width)
async function settledSidebarWidth(page: Page) {
  await page.locator('.shell').evaluate(async element => {
    await Promise.allSettled(element.getAnimations().map(animation => animation.finished))
  })
  return sidebarWidth(page)
}
async function startDrag(page: Page) {
  const separator = page.getByRole('separator', { name: '调整侧栏宽度' })
  // Let Playwright wait for the moving toggle edge before taking pointer coordinates.
  await separator.hover()
  const handle = await separator.boundingBox()
  if (!handle) throw new Error('Sidebar resize handle is missing')
  const y = handle.y + handle.height / 2
  await page.mouse.move(handle.x + handle.width / 2, y)
  await page.mouse.down()
  return y
}

async function sampleMotion(page: Page, action: () => Promise<void>) {
  const frames = page.evaluate(() => new Promise<{ edge: number; grip: number }[]>(resolve => {
    const samples: { edge: number; grip: number }[] = []
    const end = performance.now() + 450
    const sample = () => {
      const main = document.querySelector('.main')!.getBoundingClientRect()
      const grip = document.querySelector('.sidebar-resize-handle')!.getBoundingClientRect()
      samples.push({ edge: main.left, grip: grip.left + grip.width / 2 })
      if (performance.now() < end) requestAnimationFrame(sample)
      else resolve(samples)
    }
    sample()
  }))
  await action()
  return frames
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto(`${PREP_URL}/ui-catalog.html?view=preview#/foundation/shell-frame/expanded`)
  await expect(page.locator('.sidebar')).toBeVisible()
})

test('连续拖动微调松手后保持新宽度，不被浏览器的连续点击识别覆盖', async ({ page }) => {
  const handle = page.getByRole('separator', { name: '调整侧栏宽度' })
  await handle.press('End')
  await handle.press('Shift+ArrowLeft')
  await handle.press('ArrowLeft')
  await expect.poll(() => sidebarWidth(page)).toBe(300)
  for (const clickCount of [1, 2]) {
    const box = await handle.boundingBox()
    if (!box) throw new Error('Sidebar resize handle is missing')
    const x = box.x + box.width / 2, y = box.y + box.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down({ clickCount })
    await page.mouse.move(x + 3, y, { steps: 2 })
    await expect.poll(() => sidebarWidth(page)).toBe(300 + clickCount * 3)
    await page.mouse.up({ clickCount })
    expect(await settledSidebarWidth(page), `第 ${clickCount} 次微调松手后保持新位置`).toBe(300 + clickCount * 3)
  }
  const y = await startDrag(page)
  await page.mouse.move(309, y)
  await page.mouse.up()
  expect(await settledSidebarWidth(page)).toBe(309)
  // One click following a drag can also be classified as the second click.
  const box = await handle.boundingBox()
  if (!box) throw new Error('Sidebar resize handle is missing')
  await page.mouse.move(box.x + box.width / 2, y)
  await page.mouse.down({ clickCount: 2 })
  await page.mouse.up({ clickCount: 2 })
  expect(await settledSidebarWidth(page)).toBe(309)
  await handle.dblclick()
  expect(await settledSidebarWidth(page)).toBe(60)
})

test('指针捕获意外结束后松手保留已经拖出的宽度', async ({ page }) => {
  const handle = page.getByRole('separator', { name: '调整侧栏宽度' })
  const pointer = page.evaluate(() => new Promise<number>(resolve => {
    document.addEventListener('pointerdown', event => resolve(event.pointerId), { once: true })
  }))
  const y = await startDrag(page)
  const pointerId = await pointer
  await page.mouse.move(304, y, { steps: 6 })
  await expect.poll(() => sidebarWidth(page)).toBe(304)
  const lost = handle.evaluate(element => new Promise<void>(resolve => {
    element.addEventListener('lostpointercapture', () => resolve(), { once: true })
  }))
  await handle.evaluate((element, id) => element.releasePointerCapture(id), pointerId)
  await page.mouse.move(305, y)
  await lost
  await page.mouse.up()
  expect(await settledSidebarWidth(page), '松手不能把可见的新宽度撤销回拖动前的位置').toBe(304)
  await expect(page.locator('.shell')).not.toHaveAttribute('data-sidebar-resizing')
  expect(await page.locator('html').getAttribute('class')).not.toContain('xj-sidebar-resizing')
})

test('系统取消触摸拖动时保留已调整宽度，随后松手不会回弹', async ({ page }) => {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 248, y: 400, id: 1 }] })
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 304, y: 400, id: 1 }] })
  await expect.poll(() => sidebarWidth(page)).toBe(304)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] })
  expect(await settledSidebarWidth(page)).toBe(304)
  await expect(page.locator('.shell')).not.toHaveAttribute('data-sidebar-resizing')
  expect(await page.locator('html').getAttribute('class')).not.toContain('xj-sidebar-resizing')
})

test('Escape 主动撤销仍恢复拖动前宽度，之后松手与释放捕获不覆盖撤销', async ({ page }) => {
  await page.getByRole('separator', { name: '调整侧栏宽度' }).focus()
  const y = await startDrag(page)
  await page.mouse.move(304, y, { steps: 6 })
  await expect.poll(() => sidebarWidth(page)).toBe(304)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  expect(await settledSidebarWidth(page)).toBe(248)
  await expect(page.locator('.shell')).not.toHaveAttribute('data-sidebar-resizing')
})

test('未触发吸附时，松手后的最终宽度与松手前可见位置一致', async ({ page }) => {
  const y = await startDrag(page)
  await page.mouse.move(124, y, { steps: 6 })
  await expect(page.locator('.shell')).not.toHaveClass(/collapsed/)
  const heldWidth = await settledSidebarWidth(page)
  await page.mouse.up()
  expect(await settledSidebarWidth(page), '不能先显示临时宽度，再在松手时弹回最小值').toBe(heldWidth)
})

test('拖动中离开至沉浸模式保留最后宽度，返回不会回到旧位置', async ({ page }) => {
  const y = await startDrag(page)
  await page.mouse.move(304, y, { steps: 6 })
  await expect.poll(() => sidebarWidth(page)).toBe(304)
  await page.getByRole('button', { name: '沉浸模式', exact: true }).press('Enter')
  await page.mouse.up()
  await expect(page.getByRole('separator', { name: '调整侧栏宽度' })).toHaveCount(0)
  expect(await page.locator('html').getAttribute('class')).not.toContain('xj-sidebar-resizing')
  await page.getByRole('button', { name: '退出沉浸模式', exact: true }).click()
  expect(await settledSidebarWidth(page)).toBe(304)
})

test('按住拖动时平滑吸附，反向拖动直接展开，并恢复之前的宽度', async ({ page }) => {
  const shell = page.locator('.shell')
  const handle = page.getByRole('separator', { name: '调整侧栏宽度' })
  const y = await startDrag(page)
  await page.mouse.move(312, y, { steps: 8 })
  await expect.poll(() => sidebarWidth(page)).toBe(312)
  await expect(shell).toHaveAttribute('data-sidebar-resizing', 'true')
  await page.mouse.move(152, y, { steps: 8 })
  await expect(shell).not.toHaveClass(/collapsed/)
  await expect.poll(() => sidebarWidth(page)).toBe(152)
  await page.mouse.move(128, y, { steps: 4 })
  await expect(shell).not.toHaveClass(/collapsed/)
  await expect.poll(() => sidebarWidth(page)).toBe(152)
  await page.mouse.move(88, y, { steps: 4 })
  await expect(shell).toHaveClass(/collapsed/)
  await expect(shell).toHaveAttribute('data-sidebar-resizing', 'true')
  await expect.poll(() => sidebarWidth(page)).toBe(60)
  await page.mouse.move(104, y)
  await expect(shell).toHaveClass(/collapsed/)
  await page.mouse.move(300, y, { steps: 8 })
  await expect(shell).not.toHaveClass(/collapsed/)
  await expect.poll(() => sidebarWidth(page)).toBe(300)
  await page.mouse.up()
  await expect(shell).not.toHaveAttribute('data-sidebar-resizing')

  const collapseY = await startDrag(page)
  await page.mouse.move(124, collapseY, { steps: 10 })
  const frames = await sampleMotion(page, () => page.mouse.move(92, collapseY, { steps: 4 }))
  await expect(shell).toHaveClass(/collapsed/)
  await expect(shell).toHaveAttribute('data-sidebar-resizing', 'true')
  await expect(page.locator('.main')).toHaveCSS('margin-left', '60px')
  expect(frames.some(frame => frame.edge > 61 && frame.edge < 91)).toBe(true)
  expect(frames.every(frame => Math.abs(frame.edge - frame.grip) < 1)).toBe(true)
  for (let i = 1; i < frames.length; i++) {
    expect(frames[i - 1].edge - frames[i].edge).toBeLessThan(40)
    expect(frames[i].edge).toBeLessThanOrEqual(frames[i - 1].edge + 0.5)
  }
  await page.mouse.up()
  await page.getByRole('button', { name: '切换导航' }).click()
  await expect.poll(() => sidebarWidth(page)).toBe(300)
  await expect(handle).toHaveAttribute('aria-valuenow', '300')

  await handle.press('Enter')
  await expect(shell).toHaveClass(/collapsed/)
  const expandY = await startDrag(page)
  await page.mouse.move(280, expandY, { steps: 10 })
  await page.mouse.up()
  await expect(shell).not.toHaveClass(/collapsed/)
  await expect.poll(() => sidebarWidth(page)).toBe(280)
  expect(await page.locator('html').getAttribute('class')).not.toContain('xj-sidebar-resizing')

  const narrowY = await startDrag(page)
  await page.mouse.move(124, narrowY, { steps: 8 })
  await page.mouse.up()
  await expect.poll(() => sidebarWidth(page)).toBe(152)
  await expect(shell).not.toHaveClass(/collapsed/)

  const reverseY = await startDrag(page)
  await page.mouse.move(88, reverseY)
  await expect(shell).toHaveClass(/collapsed/)
  // Reverse before the 240ms magnetic transition has finished, keeping capture.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  const reverseFrames = await sampleMotion(page, () => page.mouse.move(220, reverseY, { steps: 2 }))
  expect(reverseFrames.some(frame => frame.edge > 153 && frame.edge < 219)).toBe(true)
  expect(reverseFrames.every(frame => Math.abs(frame.edge - frame.grip) < 1)).toBe(true)
  await expect(shell).not.toHaveClass(/collapsed/)
  await expect(shell).toHaveAttribute('data-sidebar-resizing', 'true')
  await expect.poll(() => sidebarWidth(page)).toBe(220)
  await page.mouse.up()
})

test('宽度上限随窗口收紧，键盘和双击可操作，沉浸模式移除手柄', async ({ page }) => {
  const handle = page.getByRole('separator', { name: '调整侧栏宽度' })
  const y = await startDrag(page)
  await page.mouse.move(900, y, { steps: 10 })
  await page.mouse.up()
  await expect.poll(() => sidebarWidth(page)).toBe(360)
  await page.setViewportSize({ width: 800, height: 800 })
  await expect.poll(() => sidebarWidth(page)).toBe(320)
  await expect(handle).toHaveAttribute('aria-valuemax', '320')
  await page.setViewportSize({ width: 1280, height: 800 })
  await expect.poll(() => sidebarWidth(page)).toBe(360)
  await handle.press('Home')
  await expect(handle).toHaveAttribute('aria-valuenow', '60')
  await expect(handle).toBeFocused()
  await handle.press('ArrowRight')
  await expect.poll(() => sidebarWidth(page)).toBe(360)
  await handle.press('Shift+ArrowLeft')
  await expect.poll(() => sidebarWidth(page)).toBe(310)
  await handle.press('Enter')
  await handle.press('Enter')
  await expect.poll(() => sidebarWidth(page)).toBe(310)
  await handle.dblclick()
  await expect(page.locator('.shell')).toHaveClass(/collapsed/)
  await handle.dblclick()
  await expect.poll(() => sidebarWidth(page)).toBe(310)
  await page.getByRole('button', { name: '沉浸模式', exact: true }).click()
  await expect(handle).toHaveCount(0)
  await page.getByRole('button', { name: '退出沉浸模式', exact: true }).click()
  await expect.poll(() => sidebarWidth(page)).toBe(310)
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await handle.press('Home')
  expect(await page.locator('.main').evaluate(element => element.getBoundingClientRect().left)).toBe(60)
  expect(await page.locator('.shell').evaluate(element => element.getAnimations().length)).toBe(0)
})
