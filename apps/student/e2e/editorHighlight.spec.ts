import { expect, test } from '@playwright/test'
import { start, create, edit } from './helpers'

// Real editor DOM in an isolated synthetic workspace; no real learner records.
for (const [path, text, keyword, number] of [
  ['main.c', 'int count = 42; // sample', 'int', '42'],
  ['top.v', 'module top; wire led = 1; endmodule', 'module', '1'],
  ['top.sv', 'module top; logic led = 1; endmodule', 'module', '1'],
] as const) {
  test(`${path}: visible syntax colors in light and dark themes`, async ({ page }) => {
    await start(page, 'syntax-highlight')
    await create(page, path)
    await edit(page, text)
    const line = page.locator('.monaco-editor .view-line').first()
    await expect(line).toContainText(text)
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme }, theme)
      await expect.poll(() => line.evaluate((element, [keyword, number]) => {
        const spans = [...element.querySelectorAll('span')]
        const color = (word: string) => {
          const span = spans.find(span => span.textContent?.trim() === word)
          return span ? getComputedStyle(span).color : null
        }
        const key = color(keyword), numeric = color(number)
        return key !== null && numeric !== null && key !== numeric
      }, [keyword, number])).toBe(true)
    }
  })
}
