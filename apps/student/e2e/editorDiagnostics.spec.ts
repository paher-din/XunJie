import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'
import { start, create, edit, confirmSave, serverHead, setAttemptState } from './helpers'

// Isolated protocol response verifies rendering/expiry. The real compiler is tested on the execution node.
for (const [path, good, bad, provider] of [
  ['main.c', 'int value = 1;\n', 'int value = ;\n', 'gcc'],
  ['top.sv', 'module top; wire led = 1; endmodule\n', 'module top; wire led = ; endmodule\n', 'iverilog'],
] as const) {
  test(`${path}: unsaved diagnostics, hover, immediate clearing and late-response rejection`, async ({ page }) => {
    await start(page, 'editor-diagnostics')
    await create(page, path); await edit(page, good); await confirmSave(page, 1)
    const head = await serverHead(page)
    let release: (() => void) | undefined, arrived: (() => void) | undefined
    let hold = false, calls = 0
    await page.route('**/api/attempts/*/editor-diagnostics', async route => {
      calls++
      const body = route.request().postDataJSON()
      const files = body.files.map((draft: { fileId: string; documentVersion: number; text: string }) => ({ ...draft,
        path: head.files.find(file => file.fileId === draft.fileId)!.path,
        hash: createHash('sha256').update(draft.text).digest('hex') }))
      const sourceHash = createHash('sha256').update(JSON.stringify(files.sort((a: { path: string }, b: { path: string }) =>
        Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))).map((file: { fileId: string; path: string; documentVersion: number; hash: string }) =>
          [file.fileId, file.path, file.documentVersion, file.hash]))).digest('hex')
      const source = files.find((file: { fileId: string }) => file.fileId === body.fileId)
      const diagnostics = source.text.includes('= ;') ? [{ fileId: source.fileId, path: source.path, contentHash: source.hash,
        severity: 'error', message: 'SYNTHETIC expected expression', line: 1,
        ...(provider === 'gcc' ? { range: { startLine: 1, startColumn: 13, endLine: 1, endColumn: 14 } } : {}) }] : []
      if (hold) { hold = false; arrived?.(); await new Promise<void>(resolve => { release = resolve }) }
      await route.fulfill({ json: { requestId: 'synthetic-editor-check', data: { status: 'ready', provider, sourceHash, diagnostics } } })
    })
    const replace = async (text: string) => {
      await page.locator('.monaco-editor textarea').first().focus()
      await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText(text)
    }
    await replace(bad)
    const check = page.getByLabel('编辑检查', { exact: true })
    await expect(check.locator('summary')).toContainText('1 个错误')
    await expect(page.locator('.squiggly-error')).toHaveCount(1)
    await check.locator('summary').click()
    await expect(check).toContainText('SYNTHETIC expected expression')
    await page.locator('.cw').screenshot({ path: test.info().outputPath('editor-diagnostics.png') })
    // Monaco's decoration has pointer-events:none; the editor receives a real mouse move at its location.
    const issueBox = await page.locator('.squiggly-error').boundingBox()
    expect(issueBox).not.toBeNull()
    await page.mouse.move(issueBox!.x + issueBox!.width / 2, issueBox!.y + issueBox!.height / 2)
    await expect(page.locator('.monaco-hover:visible').filter({ hasText: 'SYNTHETIC expected expression' })).toBeVisible()
    const ready = new Promise<void>(resolve => { arrived = resolve })
    hold = true
    await replace(bad + '// held old result')
    await expect(page.locator('.squiggly-error')).toHaveCount(0)
    await ready
    await replace(good)
    release!()
    await expect(check.locator('summary')).toContainText('检查完成，未发现问题')
    await expect(page.locator('.squiggly-error')).toHaveCount(0)
    expect(calls).toBeGreaterThanOrEqual(3)
    expect((await serverHead(page)).files[0]!.text).toBe(good)
    await setAttemptState(page, 'paused')
    await page.reload()
    await expect(check.locator('summary')).toHaveText('编辑检查已暂停')
    const pausedCalls = calls
    await replace(bad)
    // Observe the debounce/retry window without replacing React's in-flight Performance clock.
    await page.waitForTimeout(2000)
    expect(calls).toBe(pausedCalls)
    await expect(page.locator('.squiggly-error')).toHaveCount(0)
  })
}
