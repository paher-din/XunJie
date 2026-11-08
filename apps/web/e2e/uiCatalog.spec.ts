import { mkdir, writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { PREP_URL } from './env'

/** 每个登记状态在实际 Chrome 独立页面中渲染并留图，示例不得访问业务服务。 */
test('正式组件目录的每个状态可独立渲染', async ({ page }, info) => {
  test.setTimeout(600_000)
  const base = `${PREP_URL}/ui-catalog.html`
  const pageErrors: string[] = []
  const externalRequests: string[] = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', request => {
    const url = new URL(request.url())
    if (url.protocol !== 'data:' && url.protocol !== 'blob:' && url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
      externalRequests.push(`${url.origin}${url.pathname}`)
    }
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/__i0prep/api/')) externalRequests.push(url.pathname)
  })
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(base)
  const entryLinks = await page.locator('.catalog-nav a[href^="#/"]').evaluateAll(nodes =>
    nodes.map(node => (node as HTMLAnchorElement).getAttribute('href')!))
  const inventory: Array<{ name: string; importPath: string; source: string }> = JSON.parse(execFileSync(process.execPath,
    [fileURLToPath(new URL('../../../scripts/list-ui-components.mjs', import.meta.url)), '--json'], { encoding: 'utf8' }))
  expect(entryLinks.length).toBe(inventory.length)
  expect(new Set(entryLinks).size).toBe(entryLinks.length)

  const states: string[] = []
  for (const entry of entryLinks) {
    await page.goto(base + entry)
    await expect(page.locator('.catalog-nav a[aria-current="page"]'), entry).toHaveAttribute('href', entry)
    const name = await page.locator('.catalog-heading h1').innerText()
    const details = await page.locator('.catalog-details > div').first().locator('code').allTextContents()
    const item = inventory.find(candidate => candidate.name === name && candidate.importPath === details[0])
    expect(item, `${entry}: ${name} must be exported from ${details[0]}`).toBeDefined()
    expect(details[1], `${entry}: source location`).toBe(item!.source)
    const links = await page.locator('.catalog-state-list a').evaluateAll(nodes =>
      nodes.map(node => (node as HTMLAnchorElement).getAttribute('href')!))
    expect(links.length, entry).toBeGreaterThan(0)
    states.push(...links)
  }
  expect(new Set(states).size).toBe(states.length)
  const evidenceDir = info.outputPath('screens')
  await mkdir(evidenceDir, { recursive: true })
  const evidence: Array<{ state: string; theme: 'light' | 'dark'; actualTheme: string | null; screenshot: string }> = []
  for (const theme of ['light', 'dark'] as const) {
    for (const state of states) {
      await page.goto(`${base}?view=preview&theme=${theme}${state}`)
      const preview = page.locator('[data-catalog-preview]')
      await expect(preview, state).toBeVisible()
      // Hash navigation can return before React renders the new selection. Without
      // this assertion a screenshot may silently capture the preceding component.
      await expect(preview, state).toHaveAttribute('data-catalog-preview', state.slice(2))
      // The theme-menu examples deliberately apply their selected preference.
      if (!state.startsWith('#/foundation/theme-menu/')) await expect(page.locator('html'), state).toHaveAttribute('data-theme', theme)
      await expect(preview.locator('.catalog-preview-stage > *').first(), state).toBeAttached()
      await page.evaluate(async () => { await document.fonts.ready })
      // Monaco mounts asynchronously; a loading placeholder is not an editor
      // acceptance image, and a failed editor must not count as a render.
      await expect(preview.locator('.cw-editor-loading'), state).toHaveCount(0)
      await expect(preview.locator('.cw-editor-failed, .ws-compare-failed'), state).toHaveCount(0)
      const editors = preview.locator('.cw-editor')
      for (let i = 0; i < await editors.count(); i++) {
        await expect.poll(async () => (await editors.nth(i).boundingBox())?.height ?? 0, { message: `${state}: editor height` }).toBeGreaterThan(80)
      }
      await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const mascots = page.locator('.sprout-mascot')
      for (let i = 0; i < await mascots.count(); i++) await expect(mascots.nth(i), state).toHaveAttribute('data-rig-ready', 'true')
      const screenshot = `${theme}--${state.slice(2).replaceAll('/', '--')}.png`
      await page.screenshot({ path: join(evidenceDir, screenshot), animations: 'disabled', fullPage: true })
      evidence.push({ state, theme, actualTheme: await page.locator('html').getAttribute('data-theme'), screenshot: `screens/${screenshot}` })
    }
  }
  await writeFile(info.outputPath('manifest.json'), JSON.stringify({ entries: entryLinks.length, states: evidence }, null, 2))
  expect(pageErrors).toEqual([])
  expect(externalRequests).toEqual([])
})

test('宽预览默认显示开头，右侧入口显示末尾', async ({ page }) => {
  const base = `${PREP_URL}/ui-catalog.html`
  await page.setViewportSize({ width: 1440, height: 900 })
  const frame = page.locator('.catalog-frame-scroll')
  await page.goto(`${base}#/workspace/code-editor-host/editable`)
  await expect.poll(() => frame.evaluate(element => element.scrollLeft)).toBe(0)
  await page.goto(`${base}#/foundation/composer/closed`)
  await expect.poll(() => frame.evaluate(element => element.scrollLeft)).toBeGreaterThan(0)
})
