import { expect, test, type Page } from '@playwright/test'
import { PREP_TASK_PATH, PREP_URL } from './env'

/** I0_UI_03 CAS 修复：真实 UI/IndexedDB/HTTP；04A 尚未交付，冲突锁存到明确刷新。 */
async function edit(page: Page, text: string) {
  await page.locator('.monaco-editor textarea').first().focus()
  await page.keyboard.insertText(text)
}

async function localState(page: Page) {
  return page.evaluate(async () => {
    const { confirmationRepository } = await import('/src/workspace/confirmationDb.ts' as string)
    const scenarioId = new URLSearchParams(location.search).get('scenario')!
    const data = (await (await fetch('/__i0prep/context', {
      headers: { 'x-i0prep-scenario': scenarioId },
    })).json()).data
    return confirmationRepository.read({
      mode: 'preparation', userId: data.syntheticAccount.userId, courseId: data.syntheticAccount.courseId,
      assignmentId: data.refs.assignmentId, activityVersionId: data.refs.activityVersionId,
      attemptId: data.refs.attemptId, loadEpoch: 0, preparationEpoch: data.preparationEpoch,
      trustedRecoveryGeneration: data.recoveryGeneration, scenarioId,
    })
  })
}

for (const reload of ['page', 'workspace'] as const) {
  test(`草稿 CAS 冲突锁存：重复编辑/确认不能覆盖赢家或 POST，${reload} 重载赢家后可保存`, async ({ page, context }) => {
    const url = `${PREP_URL}/?scenario=draft-conflict-${crypto.randomUUID()}${PREP_TASK_PATH}`
    await page.goto(url)
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
    await page.getByRole('button', { name: '开始 Attempt', exact: true }).click()
    await expect(page.locator('.cw')).toBeVisible()
    await page.getByRole('button', { name: '新建文件', exact: true }).first().click()
    await page.getByRole('textbox', { name: '新文件名' }).fill('main.c')
    await page.getByRole('textbox', { name: '新文件名' }).press('Enter')
    await edit(page, '// base\n')
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await expect(page.locator('.ws-flow')).toContainText('确认作品 v1 · 与草稿一致')

    const other = await context.newPage()
    await other.goto(url)
    await expect(other.locator('.view-lines')).toContainText('// base')
    await expect(other.locator('.cw-protect')).toHaveAttribute('data-status', 'protected')
    await edit(other, '// other-tab-winner\n')
    await expect(other.locator('.cw-protect')).toHaveAttribute('data-status', 'protected')
    const winner = (await localState(other)).drafts[0]
    const posts: string[] = []
    page.on('request', r => {
      if (r.method() === 'POST' && r.url().includes('/api/attempts/')) posts.push(r.url())
    })

    await edit(page, '// this-tab-loser\n')
    await expect(page.locator('.cw-protect')).toHaveAttribute('data-status', 'failed')
    await expect(page.locator('.cw-protect')).toHaveAttribute('title', /冲突/)
    const conflicted = await localState(page)
    expect(conflicted.drafts[0]).toEqual(winner)
    expect(conflicted.candidates.some((c: { text: string }) => c.text.includes('this-tab-loser'))).toBe(true)

    // 同一加载里反复点击和继续编辑，不能通过吸收赢家修订绕过 CAS。
    for (const suffix of ['', '// loser-after-retry\n', '// loser-again\n']) {
      if (suffix) {
        await edit(page, suffix)
        await expect(page.locator('.cw-protect')).toHaveAttribute('data-status', 'failed')
      }
      await page.getByRole('button', { name: '确认保存', exact: true }).click()
      await expect.poll(async () => (await page.locator('.toast').count()) > 0 ||
        (await page.locator('.cw-protect').getAttribute('data-status')) === 'protected').toBe(true)
      expect((await localState(page)).drafts[0]).toEqual(winner)
      await expect(page.locator('.toast')).toContainText('未发送保存请求')
      expect(posts).toEqual([])
    }
    const retained = await localState(page)
    expect(retained.candidates.some((c: { text: string }) => c.text.includes('loser-again'))).toBe(true)
    await expect(page.locator('.view-lines')).toContainText('loser-again')

    // 学生明确刷新，读取赢家正文与修订后解除本次加载的锁；候选不清空。
    if (reload === 'page') await page.reload()
    else await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await expect(page.locator('.view-lines')).toContainText('other-tab-winner')
    await expect(page.locator('.view-lines')).not.toContainText('this-tab-loser')
    await expect(page.locator('.cw-protect')).toHaveAttribute('data-status', 'protected')
    await edit(page, '// after-explicit-reload\n')
    await expect(page.locator('.cw-protect')).toHaveAttribute('data-status', 'protected')
    await page.getByRole('button', { name: '确认保存', exact: true }).click()
    await expect(page.locator('.ws-flow')).toContainText('确认作品 v2 · 与草稿一致')
    expect(posts).toHaveLength(1)
    const reloaded = await localState(page)
    expect(reloaded.workspace.files[0].text).toContain('other-tab-winner')
    expect(reloaded.workspace.files[0].text).toContain('after-explicit-reload')
    expect(reloaded.candidates.some((c: { text: string }) => c.text.includes('loser-again'))).toBe(true)
  })
}
