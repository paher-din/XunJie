import { expect, test } from '@playwright/test'
import { startSessionHost, loginThroughForm } from './sessionHost'
import { create, edit, confirmSave } from './helpers'

test.use({ trace: 'off', ignoreHTTPSErrors: true })
test('actual HTTPS/SQLite and private VM: analyze an unsaved C draft without a Run, snapshot or save', async ({ page }) => {
  test.skip(!process.env.XUNJIE_E2E_SERVICE_NODE || !process.env.XUNJIE_E2E_DIAGNOSTICS_CONFIG, 'Requires approved private VM and Node24')
  const host = await startSessionHost({ diagnosticsConfig: process.env.XUNJIE_E2E_DIAGNOSTICS_CONFIG })
  try {
    await page.goto(`${host.base}/#/task/${host.assignmentId}`)
    await loginThroughForm(page, 'student', host.password)
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
    const attempt = page.waitForResponse(response => response.url().endsWith('/attempts') && response.request().method() === 'POST')
    await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    const attemptId = (await (await attempt).json()).data.result.attemptId
    await create(page, 'main.c'); await edit(page, 'int value = 1;\n'); await confirmSave(page, 1)
    const before = await host.control({ kind: 'inspect', attemptId })
    const received = page.waitForResponse(response => response.url().endsWith('/editor-diagnostics') &&
      response.request().postDataJSON().files.some((file: { text: string }) => file.text.includes('= ;')))
    await page.locator('.monaco-editor textarea').first().focus()
    await page.keyboard.press('ControlOrMeta+a'); await page.keyboard.insertText('int value = ;\n')
    const result = await (await received).json()
    expect(result.data.status).toBe('ready'); expect(result.data.provider).toBe('gcc')
    expect(result.data.diagnostics[0].range).toEqual({ startLine: 1, startColumn: 13, endLine: 1, endColumn: 14 })
    await expect(page.getByLabel('编辑检查', { exact: true }).locator('summary')).toContainText('1 个错误')
    await expect(page.locator('.squiggly-error')).toHaveCount(1)
    await page.getByLabel('编辑检查', { exact: true }).locator('summary').click()
    await page.locator('.cw').screenshot({ path: test.info().outputPath('actual-editor-diagnostics.png') })
    const after = await host.control({ kind: 'inspect', attemptId })
    expect(after.attempt?.files).toEqual(before.attempt?.files)
    expect(after.database).toEqual(before.database)
    expect(after.attempt?.runs).toEqual([])
    expect(after.attempt?.snapshots).toEqual([])
  } finally { await host.stop() }
})
