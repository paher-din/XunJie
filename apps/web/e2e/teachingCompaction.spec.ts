import { evidenceDirectory } from './evidence'
import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelConnection } from '@xunjie/contracts/model-connections'
import { fixture, reply, until } from '../../server/tests/support/teaching-input-control.mjs'

test.use({ trace: 'off' })
const output = evidenceDirectory('wp08-220-chrome', process.env.XUNJIE_COMPACTION_EVIDENCE)

test('formal long conversation preserves history, draft and controls across compaction and restart', async ({ page, browser }) => {
  test.setTimeout(180000)
  if (output) await mkdir(output, { recursive: true })
  let releaseSummary!: () => void, releaseLast!: () => void, startedSummary = false, holdLast = false
  const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve })
  const lastGate = new Promise<void>(resolve => { releaseLast = resolve })
  const f = await fixture(async (payload, response) => {
    let source: { sourceDigest: string; retainedDigest: string; retained: { id: string }[]; messages: { eventId: string }[] } | undefined
    for (const message of payload.messages as { content: unknown }[]) {
      const texts = typeof message.content === 'string' ? [message.content]
        : Array.isArray(message.content) ? message.content.map(part => part.text) : []
      for (const text of texts) {
        try { const value = JSON.parse(text); if (value.kind === 'xunjie.context-compaction') source = value } catch { /* student text */ }
      }
    }
    if (source) {
      startedSummary = true; await summaryGate
      reply(response, { text: JSON.stringify({ version: 1, sourceDigest: source.sourceDigest, retainedDigest: source.retainedDigest,
        retainedIds: source.retained.map(item => item.id), facts: [{ text: '原观测是 37，原因仍未知。', sources: [source.messages[0].eventId] }],
        inferences: [], contradictions: [], unknowns: [], unfinished: [] }) })
    } else {
      if (holdLast) await lastGate
      reply(response, { text: startedSummary ? '沿原观测 37 继续，原因仍需核实。' : '历史观测 37，保留未知原因。' })
    }
  })
  try {
    await f.configure()
    const activity = await f.activity('长对话保留原始依据')
    for (let index = 0; index < 7; index++) {
      const accepted = await f.send(activity, `历史记录 ${index + 1}：` + 'observation 37; cause unconfirmed. '.repeat(280))
      await until(async () => (await f.api(`agent/${activity.activityId}/runs/${accepted.runId}`)).state === 'completed', 'Historical turn completes.')
    }
    await page.goto(f.endpoint + '/?space=personal&activity=' + activity.activityId)
    await expect(page.locator('#activity-title')).toHaveText('长对话保留原始依据')
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    const question = page.getByLabel('你的问题', { exact: true })
    await question.fill('请继续解释原观测，未知原因不要说成结论。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await until(() => startedSummary, 'Real RunDriver begins its summary request.')
    await question.fill('尚未发送的中文草稿')
    await question.focus()
    await question.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    await page.keyboard.press('Enter')
    await expect(question).toHaveValue(/尚未发送的中文草稿/)
    await question.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    if (output) await page.screenshot({ path: join(output, `summary-pending-${process.platform}.png`) })
    releaseSummary()
    await expect(page.locator('.teaching-message.assistant').last()).toContainText('沿原观测 37 继续', { timeout: 30000 })
    await expect(question).toBeFocused()
    await expect(question).toHaveValue(/尚未发送的中文草稿/)
    await expect(page.locator('.teaching-message.student')).toHaveCount(8)
    await expect(page.locator('.teaching-message.assistant')).toHaveCount(8)
    await expect(page.getByRole('region', { name: '与 Agent 的对话' })).not.toContainText('retainedDigest')
    const events = await f.api(`agent/${activity.activityId}/events`)
    expect(events.filter((event: { kind: string }) => event.kind === 'context-compacted')).toHaveLength(1)
    const conversation = await f.api(`agent/${activity.activityId}/conversation`)
    expect(f.payloads).toHaveLength(9)
    if (output) await page.screenshot({ path: join(output, `conversation-after-${process.platform}.png`) })
    await page.reload()
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await expect(question).toHaveValue(/尚未发送的中文草稿/)
    await expect(page.locator('.teaching-message.student')).toHaveCount(8)
    expect(f.payloads).toHaveLength(9)
    await f.restart()
    await page.goto(f.endpoint + '/?space=personal&activity=' + activity.activityId)
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await expect(page.locator('.teaching-message.assistant').last()).toContainText('沿原观测 37 继续')
    expect(await f.api(`agent/${activity.activityId}/conversation`)).toEqual(conversation)
    expect(f.payloads).toHaveLength(9)

    const existing = (await f.api('models/connections') as ModelConnection[])[0]
    const connectionId = randomUUID(), grantId = randomUUID()
    await f.api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
      name: '继续学习模型', protocol: existing.protocol, baseUrl: existing.baseUrl, path: existing.path,
      modelId: 'fixture-compaction-successor', dialect: existing.dialect, parameterMode: existing.parameterMode,
      enabled: true, contextWindow: 262144, maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-compaction-key' } })
    await f.api('models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' })
    await page.getByRole('button', { name: '切换模型', exact: true }).click()
    const models = page.getByRole('region', { name: '当前空间模型' })
    await models.getByRole('button', { name: '重新读取选用', exact: true }).click()
    await models.locator('.st-provider').filter({ hasText: '继续学习模型' }).getByRole('button', { name: /选用$/ }).click()
    await expect(page.getByText('已为当前学习活动切换到「fixture-compaction-successor」。已有消息和结果保留原出处。', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '返回学习空间', exact: true }).click()
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    holdLast = true
    await question.fill('继续当前问题，但允许我停止。')
    await page.getByRole('button', { name: '发送问题', exact: true }).click()
    await until(() => f.payloads.length === 10, 'The explicitly selected model receives the follow-up.')
    await question.fill('停止期间保留的新草稿')
    await page.getByRole('button', { name: '停止', exact: true }).click()
    releaseLast()
    await expect(page.getByText('回答已停止，已发生的内容仍保留。')).toBeVisible({ timeout: 30000 })
    await expect(question).toHaveValue('停止期间保留的新草稿')
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.setViewportSize({ width: 900, height: 900 })
    if (output) await page.screenshot({ path: join(output, `controls-after-${process.platform}.png`) })
    expect(f.failures).toEqual([])
    if (output) await writeFile(join(output, `chrome-${process.platform}.json`), JSON.stringify({ measuredAt: new Date().toISOString(),
      platform: process.platform, browser: browser.version(), channel: process.env.XUNJIE_E2E_BROWSER_CHANNEL,
      headed: true, modelRequests: f.payloads.length, compactions: 1, completeHistory: true, draftAndFocus: true,
      compositionEventsOnly: true, restartPureRead: true, originalModelSelection: true, stop: true }, null, 2) + '\n')
  } finally { releaseSummary(); releaseLast(); await f.close() }
})
