import { createHash } from 'node:crypto'
import { expect, test, type Page } from '@playwright/test'
import { start, create, edit, confirmSave, serverHead, setAttemptState } from './helpers'
import { installHdlProtocolFixture } from './hdlProtocolFixture'
import { loginThroughForm } from './sessionHost'
import { openWorkspaceMenu } from './workspaceControls'

// Desktop Chrome emulates a Windows UA even on macOS. Monaco binds modifiers
// from that UA; Playwright's ControlOrMeta instead follows the host OS.
async function replaceDraft(page: Page, text: string) {
  const selectAll = await page.evaluate(() => navigator.userAgent.includes('Macintosh') ? 'Meta+a' : 'Control+a')
  const input = page.locator('.monaco-editor textarea').first()
  await expect(input).toHaveAttribute('aria-autocomplete', 'both')
  await input.focus()
  await page.keyboard.press(selectAll)
  await page.keyboard.press('Backspace')
  await page.keyboard.insertText(text)
  await expect(page.locator('.monaco-editor .view-line').first()).toHaveText(text.split('\n')[0]!)
}

test('normal mode diagnostics keep their selected node and discard late results after a switch; offline does not save drafts', async ({ page }) => {
  const protocol = await installHdlProtocolFixture(page)
  let robertReady = false, release!: () => void, arrived!: () => void, completed!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), requested = new Promise<void>(resolve => { arrived = resolve })
  const delivered = new Promise<void>(resolve => { completed = resolve }), requests: string[] = []
  await page.route('**/api/execution-nodes', route => route.fulfill({ json: { requestId: 'node-registry', data: { nodes: [
    { nodeId: 'robert', label: 'Robert 的电脑', cReady: robertReady, hdlReady: true },
    { nodeId: 'member', label: '成员的电脑', cReady: true, hdlReady: true },
  ] } } }))
  await page.route('**/api/attempts/*/editor-diagnostics', async route => {
    const node = route.request().headers()['x-xunjie-execution-node']!
    requests.push(node)
    const body = route.request().postDataJSON(), sources = body.files.map((file: { fileId: string; documentVersion: number; text: string }) => ({ ...file,
      path: protocol.head!.files.find(source => source.fileId === file.fileId)!.path, hash: createHash('sha256').update(file.text).digest('hex') }))
    const sourceHash = createHash('sha256').update(JSON.stringify(sources.sort((a: { path: string }, b: { path: string }) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
      .map((file: { fileId: string; path: string; documentVersion: number; hash: string }) => [file.fileId, file.path, file.documentVersion, file.hash]))).digest('hex')
    const source = sources.find((file: { fileId: string }) => file.fileId === body.fileId)
    if (node === 'member') { arrived(); await held }
    await route.fulfill({ json: { requestId: 'node-diagnostic', data: { status: 'ready', provider: 'gcc', sourceHash,
      diagnostics: [{ fileId: source.fileId, path: source.path, contentHash: source.hash, severity: 'error', message: `SYNTHETIC ${node} diagnostic`, line: 1 }] } } })
    if (node === 'member') completed()
  })
  try {
    await page.goto(protocol.cUrl)
    await loginThroughForm(page, protocol.loginName, protocol.password)
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
    await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    await create(page, 'main.c'); await edit(page, 'int value = 1;\n'); await confirmSave(page, 1)
    const saved = protocol.head!.files[0]!.text, selector = page.getByRole('combobox', { name: '执行电脑', exact: true })
    const check = page.getByLabel('编辑检查', { exact: true })
    await replaceDraft(page, 'int value = ;\n')
    await expect(check.locator('summary')).toContainText('暂不可用')
    expect(requests).toHaveLength(0)
    await openWorkspaceMenu(page, '执行电脑设置')
    await selector.selectOption('member'); await requested
    await selector.selectOption('robert')
    await expect(check.locator('summary')).toContainText('暂不可用')
    release(); await delivered
    await expect(page.locator('.squiggly-error')).toHaveCount(0)
    robertReady = true
    await page.locator('.ws-execution-node').getByRole('button', { name: '刷新', exact: true }).click()
    await expect(check.locator('summary')).toContainText('1 个错误')
    await check.locator('summary').click()
    await expect(check).toContainText('SYNTHETIC robert diagnostic')
    await expect(check).not.toContainText('SYNTHETIC member diagnostic')
    expect(requests).toEqual(['member', 'robert'])
    expect(protocol.head!.files[0]!.text).toBe(saved)
    expect(protocol.head!.jobs).toHaveLength(0)
    expect(protocol.head!.snapshots).toHaveLength(0)
  } finally { release() }
})

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
    await replaceDraft(page, bad)
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
    await replaceDraft(page, bad + '// held old result')
    await expect(page.locator('.squiggly-error')).toHaveCount(0)
    await ready
    await replaceDraft(page, good)
    release!()
    await expect(check.locator('summary')).toContainText('检查完成，未发现问题')
    await expect(page.locator('.squiggly-error')).toHaveCount(0)
    expect(calls).toBeGreaterThanOrEqual(3)
    expect((await serverHead(page)).files[0]!.text).toBe(good)
    await setAttemptState(page, 'paused')
    await page.reload()
    await expect(check.locator('summary')).toHaveText('编辑检查已暂停')
    const pausedCalls = calls
    await replaceDraft(page, bad)
    // Observe the debounce/retry window without replacing React's in-flight Performance clock.
    await page.waitForTimeout(2000)
    expect(calls).toBe(pausedCalls)
    await expect(page.locator('.squiggly-error')).toHaveCount(0)
  })
}
