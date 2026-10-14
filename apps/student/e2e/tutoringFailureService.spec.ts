import { test, expect } from '@playwright/test'
import { create, edit, openFileMenu } from './helpers'
import { loginThroughForm, startSessionHost } from './sessionHost'

// The temporary self-signed certificate is an isolated test condition. Normal
// application TLS verification and OS/browser trust stores are never changed.
test.use({ ignoreHTTPSErrors: true, trace: 'off' })

test('模型不可用终态不产生教学投递，既有 C 结果可读且学生仍可保存', async ({ page }) => {
  test.skip(!process.env.XUNJIE_E2E_SERVICE_NODE, 'Requires the approved teaching runtime and native dependencies')
  const host = await startSessionHost({ runs: true })
  try {
    await page.goto(`${host.base}/#/task/${host.assignmentId}`)
    await loginThroughForm(page, 'student', host.password)
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
    const created = page.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/api/assignments/${host.assignmentId}/attempts`)
    await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    const createdResponse = await created
    expect(createdResponse.status()).toBe(200)
    const attemptId = (await createdResponse.json()).data.result.attemptId as string
    await expect(page.locator('.cw')).toBeVisible()

    await create(page)
    await edit(page, 'int main(void){return 0;}\n')
    await openFileMenu(page)
    await page.locator('.cw-filemenu').getByRole('menuitem', { name: '新建文件', exact: true }).click()
    const fileName = page.getByRole('textbox', { name: '新文件名' })
    await fileName.fill('sample.txt')
    await fileName.press('Enter')
    await edit(page, 'one two one\n')
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await expect(page.locator('.cw')).toContainText('文件版本 v1')
    await page.getByRole('button', { name: '冻结确认作品', exact: true }).click()
    await expect(page.getByText('已冻结快照 v1', { exact: true })).toBeVisible()
    const existingRun = await host.control({ kind: 'history', attemptId, outcome: 'check' })
    expect(existingRun.status).toBe('succeeded')

    await host.control({ kind: 'provider', mode: 'unavailable' })
    let helpUrl: string | undefined
    page.on('request', request => {
      if (request.method() === 'POST' && /\/api\/attempts\/[^/]+\/help$/.test(new URL(request.url()).pathname)) helpUrl = request.url()
    })
    await page.getByRole('button', { name: '就项目求助', exact: true }).click()
    await page.getByRole('textbox', { name: '就这个任务提问' }).fill('供应商不可用时请保留我的作品。')
    await page.getByRole('button', { name: '发送辅导问题', exact: true }).click()
    await expect(page.getByTestId('tutor-job')).toContainText('failed', { timeout: 20_000 })
    await expect(page.getByTestId('tutor-message')).toHaveCount(0)

    expect(helpUrl).toBeTruthy()
    expect(new URL(helpUrl!).pathname.split('/')[3]).toBe(attemptId)
    const records = await page.context().request.get(`${host.base}/api/attempts/${attemptId}/teaching-records`)
    expect(records.status()).toBe(200)
    expect((await records.json()).data.actions).toHaveLength(0)
    const previousResult = await page.context().request.get(`${host.base}/api/attempts/${attemptId}/runs/${existingRun.runId}`)
    expect(previousResult.status()).toBe(200)
    const run = (await previousResult.json()).data
    expect(run.runId).toBe(existingRun.runId)
    expect(run.snapshotId).toBe(existingRun.snapshotId)
    expect(run.diagnostics.status).toBe('available')

    await page.getByRole('button', { name: '收起辅导', exact: true }).click()
    await edit(page, '/* student continues after model failure */\n')
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await expect(page.locator('.cw')).toContainText('文件版本 v2')
    const confirmed = await page.context().request.get(`${host.base}/api/attempts/${attemptId}`)
    expect(confirmed.status()).toBe(200)
    const head = (await confirmed.json()).data
    const continued = head.files.find((file: { path: string }) => file.path === 'sample.txt')
    expect(continued.documentVersion).toBe(2)
    expect(continued.text).toContain('student continues after model failure')
    expect(head.snapshots).toHaveLength(1)
  } finally {
    await host.stop()
  }
})
