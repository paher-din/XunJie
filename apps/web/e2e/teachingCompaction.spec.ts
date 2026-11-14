import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import type { ModelConnection } from '@xunjie/contracts/model-connections'
import type { AgentConversation } from '@xunjie/contracts/agent-service'
import type { AgentEvent, AgentInputReceipt, AgentRun } from '@xunjie/contracts/agent-runtime'
import type { AgentSession } from '@xunjie/contracts/agent-sessions'
import { fixture, reply, replyStudentPolicy, until } from '../../server/tests/support/session-product.mjs'
import { REAL_URL } from './env'

test.use({ trace: 'off' })

test('real session v2 compaction preserves complete visible history, draft and controls across restart and a native route change', async ({ page }) => {
  test.setTimeout(180000)
  let releaseSummary!: () => void, releaseLast!: () => void, summaries = 0, answers = 0, holdLast = false
  const summaryGate = new Promise<void>(resolve => { releaseSummary = resolve }), lastGate = new Promise<void>(resolve => { releaseLast = resolve })
  const f = await fixture(async (payload, response) => {
    if (replyStudentPolicy(payload, response)) return
    if (payload.messages.some((message: any) => message.role === 'system' && typeof message.content === 'string' && message.content.startsWith('CONVERSATION_COMPACTION_V1\n'))) {
      const content = payload.messages.at(-1)!.content
      const source = JSON.parse(typeof content === 'string' ? content : content.map((part: any) => part.text ?? '').join(''))
      summaries++; await summaryGate
      reply(response, { text: JSON.stringify({ version: 1, sourceDigest: source.sourceDigest, retainedDigest: source.retainedDigest,
        retainedIds: source.retained.map((item: any) => item.id), facts: [{ text: '原观测是 37，原因仍未知。', sources: [source.messages[0].eventId] }],
        inferences: [], contradictions: [], unknowns: [], unfinished: [] }) })
      return
    }
    answers++
    if (holdLast) await lastGate
    reply(response, { text: summaries ? '沿原观测 37 继续，原因仍需核实。' : '历史观测 37，保留未知原因。' })
  })
  try {
    await f.configure()
    const session = await f.api<AgentSession>('agent-sessions', { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant', title: '长对话保留原始依据' })
    await page.route('**/api/learning/**', async route => {
      const url = new URL(route.request().url())
      await route.fulfill({ response: await route.fetch({ url: new URL(url.pathname + url.search, f.endpoint).href,
        headers: { ...route.request().headers(), origin: new URL(f.endpoint).origin, 'sec-fetch-site': 'same-origin' } }) })
    })
    const base = `agent-sessions/${session.sessionId}`, read = () => f.api<AgentConversation>(base + '/conversation')
    const open = () => page.goto(`${REAL_URL}/?view=agent&space=personal&session=${session.sessionId}`)
    for (let index = 0; index < 7; index++) {
      const accepted = await f.api<AgentInputReceipt>(base + '/inputs', { requestId: randomUUID(), sessionId: session.sessionId, mode: 'steering', context: {},
        text: `历史记录 ${index + 1}：` + 'observation 37; cause unconfirmed. '.repeat(280) })
      await until(async () => (await f.api<AgentRun>(base + '/runs/' + accepted.runId)).state === 'completed', 'The original historical Run finishes.')
    }
    expect(answers).toBe(7); expect(summaries).toBe(0)
    await open()
    const composer = page.getByLabel('向 Agent 提问', { exact: true }), visible = page.getByRole('region', { name: '与 Agent 的对话', exact: true })
    await composer.fill('请继续解释原观测，未知原因不要说成结论。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await until(() => summaries === 1, 'The real common pipeline begins its fixed summary operation.')
    await expect(composer).toHaveValue('')
    await composer.fill('尚未发送的中文草稿'); await composer.focus()
    await composer.evaluate(element => element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })))
    await expect(composer).toHaveValue('尚未发送的中文草稿')
    expect((await read()).inputs).toHaveLength(8)
    expect((await read()).messages.some((message: any) => message.text.includes('retainedDigest'))).toBe(false)
    releaseSummary()
    await expect(visible.locator('.chat-message.agent').last()).toContainText('沿原观测 37 继续', { timeout: 30000 })
    await expect(composer).toBeFocused(); await expect(composer).toHaveValue('尚未发送的中文草稿')
    await expect(visible.locator('[data-message-id]')).toHaveCount(16)
    await expect(visible).not.toContainText('retainedDigest')
    const events = await f.api<AgentEvent[]>(base + '/events'), before = await read()
    expect(events.filter((event: any) => event.kind === 'context-compacted')).toHaveLength(1)
    const count = f.payloads.length
    await page.reload(); await expect(composer).toHaveValue('尚未发送的中文草稿')
    await expect(visible.locator('[data-message-id]')).toHaveCount(16)
    expect(f.payloads).toHaveLength(count)
    await f.restart(); await open()
    await expect(visible.locator('[data-message-id]')).toHaveCount(16)
    await expect(composer).toHaveValue('尚未发送的中文草稿')
    expect(await read()).toEqual(before); expect(f.payloads).toHaveLength(count)

    const existing = (await f.api('models/connections') as ModelConnection[])[0], connectionId = randomUUID(), grantId = randomUUID()
    await f.api('models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '继续学习模型',
      protocol: existing.protocol, baseUrl: existing.baseUrl, path: existing.path, modelId: 'fixture-compaction-successor',
      dialect: existing.dialect, parameterMode: existing.parameterMode, enabled: true, contextWindow: 262144, maxOutputTokens: 2048,
      credential: { action: 'replace', value: 'synthetic-compaction-key' } })
    await f.api('models/grants', { requestId: randomUUID(), connectionId, grantId, owner: 'self' })
    await page.reload(); await expect(composer).toHaveValue('尚未发送的中文草稿')
    await page.getByRole('button', { name: '切换模型', exact: true }).click()
    const switched = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/models/selection') && response.request().method() === 'POST')
    await page.getByRole('menuitemradio').filter({ hasText: '继续学习模型' }).click()
    expect((await switched).status()).toBe(200)
    holdLast = true
    await composer.fill('继续当前问题，但允许我停止。')
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    await until(() => answers === 9, 'The selected native route receives the actual answer request.')
    expect(f.payloads.at(-1)?.model).toBe('fixture-compaction-successor')
    expect(JSON.stringify(f.payloads.at(-1))).toContain('原观测是 37')
    const running = (await read()).runs.find((run: any) => run.state === 'running')
    await expect(composer).toHaveValue(''); await composer.fill('停止期间保留的新草稿')
    await page.getByRole('button', { name: '停止回答', exact: true }).click(); releaseLast()
    await expect.poll(async () => (await f.api<AgentRun>(base + '/runs/' + running!.runId)).state).toBe('stopped')
    await expect(composer).toHaveValue('停止期间保留的新草稿')
    await expect(page.getByRole('button', { name: '停止回答', exact: true })).not.toBeVisible()
    expect(summaries).toBe(1); expect(f.failures).toEqual([])
  } finally { releaseSummary(); releaseLast(); await f.close() }
})
