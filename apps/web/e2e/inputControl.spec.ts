import { test, expect, type Dialog, type Page, type Route } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { fixture, reply, replyStudentPolicy, until } from '../../server/tests/support/session-product.mjs'
import { agentInputControlReceiptSchema, type AgentConversation, type AgentSnapshot } from '@xunjie/contracts/agent-service'
import type { AgentInputReceipt } from '@xunjie/contracts/agent-runtime'
import type { AgentSession } from '@xunjie/contracts/agent-sessions'
import { REAL_URL } from './env'

// Real installed owners and session v2; only supplier replies and intentionally lost HTTP replies are controlled.
test.use({ trace: 'off' })
test.setTimeout(120000)
type NativeFixture = Awaited<ReturnType<typeof fixture>>
const nativeReply = (f: NativeFixture, route: Route) => {
  const url = new URL(route.request().url())
  return route.fetch({ url: new URL(url.pathname + url.search, f.endpoint).href,
    headers: { ...route.request().headers(), origin: new URL(f.endpoint).origin, 'sec-fetch-site': 'same-origin' } })
}
async function conversation(f: NativeFixture, page: Page) {
  await f.configure()
  await page.route('**/api/learning/**', async route => {
    await route.fulfill({ response: await nativeReply(f, route) })
  })
  const session = await f.api<AgentSession>('agent-sessions', { requestId: randomUUID(), sessionId: randomUUID(), scenario: 'student-assistant', title: '可靠输入' })
  const base = `agent-sessions/${session.sessionId}`
  return { session, base,
    open: () => page.goto(`${REAL_URL}/?view=agent&space=personal&session=${session.sessionId}`),
    send: (text: string, mode = 'steering') => f.api<AgentInputReceipt>(base + '/inputs', { requestId: randomUUID(), sessionId: session.sessionId, text, mode, context: {} }),
    read: () => f.api<AgentConversation>(base + '/conversation'),
  }
}
const inputMessage = (page: Page, inputId: string) => page.locator(`[data-message-id="input:${inputId}"]`)

test('session v2 queues the original bytes from the busy composer and preserves the unsent Chinese draft', async ({ page }) => {
  let release!: () => void, answers = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(async (payload, response) => {
    if (replyStudentPolicy(payload, response)) return
    if (++answers === 1) await gate
    reply(response, { text: answers === 1 ? '先完成原问题。' : '本轮结束后处理排队内容。' })
  })
  try {
    const c = await conversation(f, page), first = await c.send('先解释原问题。')
    await until(() => answers === 1, 'The original answer is in flight.')
    await c.open()
    await page.getByRole('combobox', { name: '发送方式', exact: true }).click()
    await page.getByRole('option', { name: '排队处理', exact: true }).click()
    const composer = page.getByLabel('向 Agent 提问', { exact: true })
    await composer.fill('界面排队：只在完整轮结束后处理。'); await composer.press('Enter')
    const pending = await until(async () => (await c.read()).inputs.find((input: any) => input.text.startsWith('界面排队') && input.state === 'pending'), 'The real owner stores the queued input.')
    expect(pending.mode).toBe('queue'); expect(pending.runId).not.toBe(first.runId); expect(answers).toBe(1)
    const original = await f.api<{ input: unknown }>(c.base + '/requests/' + (await f.api<AgentSnapshot>(c.base + '/snapshots/' + pending.runId)).inputs[0].input.requestId)
    expect(original.input).toMatchObject({ sessionId: c.session.sessionId, text: pending.text, mode: 'queue' })
    await expect(composer).toHaveValue('')
    await composer.fill('尚未发送的中文草稿\n保留下一步想法。')
    release()
    await expect(page.getByText('本轮结束后处理排队内容。', { exact: true })).toBeVisible({ timeout: 30000 })
    await expect(composer).toHaveValue('尚未发送的中文草稿\n保留下一步想法。')
    expect(answers).toBe(2)
    expect((await c.read()).runs.every((run: any) => run.state === 'completed')).toBe(true)
    expect(f.failures).toEqual([])
  } finally { release(); await f.close() }
})

test('session v2 pending edits survive reload and a lost control reply while original request recovery stays unchanged', async ({ page }) => {
  let release!: () => void, answers = 0
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(async (payload, response) => {
    if (replyStudentPolicy(payload, response)) return
    if (++answers === 1) await gate
    reply(response, { text: answers === 1 ? '原回答完成。' : '采用修改后的排队内容。' })
  })
  try {
    const c = await conversation(f, page); await c.send('先处理原任务。')
    await until(() => answers === 1, 'The original answer remains in flight.')
    const queued = await c.send('收到时的原文。', 'queue'), original = await f.api(c.base + '/requests/' + queued.requestId)
    await c.open()
    const message = inputMessage(page, queued.inputId)
    await message.getByRole('button', { name: '编辑这条消息', exact: true }).click()
    await message.getByLabel('修改这条消息', { exact: true }).fill('修改草稿，刷新后仍保留。')
    // Playwright otherwise accepts beforeunload, explicitly discarding a pending local write.
    // Stay when warned, then refresh once the actual transaction permits leaving.
    const stay = async (dialog: Dialog) => { expect(dialog.type()).toBe('beforeunload'); await dialog.dismiss() }
    page.on('dialog', stay)
    try { await expect(async () => { await page.reload({ timeout: 2000 }) }).toPass({ timeout: 10000 }) }
    finally { page.off('dialog', stay) }
    await expect(message.getByLabel('修改这条消息', { exact: true })).toHaveValue('修改草稿，刷新后仍保留。')
    let dropped = false
    const controls: any[] = []
    await page.route(`**/${c.base}/inputs/${queued.inputId}/control`, async route => {
      controls.push(route.request().postDataJSON())
      const response = await nativeReply(f, route)
      if (!dropped) { dropped = true; await route.abort(); return }
      await route.fulfill({ response })
    })
    await message.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByRole('button', { name: '核对并重试', exact: true }).click()
    await expect(message).toContainText('修改草稿，刷新后仍保留。')
    await expect(message.getByLabel('修改这条消息', { exact: true })).toHaveValue('修改草稿，刷新后仍保留。')
    expect(dropped).toBe(true); expect(controls).toHaveLength(2); expect(controls[1]).toEqual(controls[0])
    const saved = (await f.api<AgentSnapshot>(c.base + '/snapshots/' + queued.runId)).inputs.find(input => input.inputId === queued.inputId)!
    expect(saved.version).toBe(2); expect(saved.input.text).toBe('修改草稿，刷新后仍保留。')
    const receipt = agentInputControlReceiptSchema.parse(await f.api(c.base + '/inputs/' + queued.inputId + '/control', controls[0]))
    expect(receipt.input.version).toBe(2)
    expect(await f.api(c.base + '/requests/' + queued.requestId)).toEqual(original)
    await message.getByRole('button', { name: '取消', exact: true }).click()
    await expect(message).toContainText('修改草稿，刷新后仍保留。')
    const composer = page.getByLabel('向 Agent 提问', { exact: true })
    await composer.fill('另一个未发送的草稿。'); await composer.focus(); release()
    await expect(page.getByText('采用修改后的排队内容。', { exact: true })).toBeVisible({ timeout: 30000 })
    await expect(composer).toHaveValue('另一个未发送的草稿。'); await expect(composer).toBeFocused()
    expect(answers).toBe(2)
  } finally { release(); await f.close() }
})

test('session v2 steering cancels the original question without adopting an unsent Chinese response', async ({ page }) => {
  let answers = 0
  const f = await fixture((payload, response) => {
    if (replyStudentPolicy(payload, response)) return
    if (++answers === 1) reply(response, { calls: [{ id: 'prediction', name: 'student_ask', arguments: {
      question: '先说出你的预测？', source: '当前学习目标', options: [], allowText: true, skippable: true } }] })
    else reply(response, { text: '依据新的方向继续讨论，原提问没有被当作已回答。' })
  })
  try {
    const c = await conversation(f, page); await c.send('先问我的预测。')
    const wait = await until(async () => (await c.read()).waits.find((wait: any) => wait.kind === 'user' && wait.state === 'pending'), 'The question has its original real wait.')
    await c.open()
    await page.getByLabel('回应 Agent 的问题', { exact: true }).fill('中文预测原文：先保留我的思路。')
    const composer = page.getByLabel('向 Agent 提问', { exact: true })
    await composer.fill('未发送的学习草稿。')
    await c.send('现在先改变讨论目标。')
    await expect(page.getByText('依据新的方向继续讨论，原提问没有被当作已回答。', { exact: true })).toBeVisible({ timeout: 30000 })
    await expect(page.getByRole('region', { name: 'Agent 的问题', exact: true })).not.toBeVisible()
    const cancelled = (await c.read()).waits.find((item: any) => item.waitId === wait.waitId)
    expect(cancelled?.state).toBe('cancelled'); expect(cancelled?.response).toBeNull()
    const late = await f.raw(c.base + `/waits/${wait.waitId}/responses`, { requestId: randomUUID(), expectedVersion: wait.version,
      answer: { kind: 'text', text: '中文预测原文：先保留我的思路。' } })
    expect(late.status).toBe(409)
    await page.reload(); await expect(composer).toHaveValue('未发送的学习草稿。')
    expect(JSON.stringify((await c.read()).messages)).not.toContain('中文预测原文')
    expect(answers).toBe(2)
  } finally { await f.close() }
})

test('session v2 removal and an uncertain stop reply retain their identities without starting the removed input', async ({ page }) => {
  let started = false
  const f = await fixture(async (payload, response) => {
    if (replyStudentPolicy(payload, response)) return
    started = true; await new Promise<void>(resolve => response.once('close', resolve))
  })
  try {
    const c = await conversation(f, page), first = await c.send('原任务正在生成。')
    await until(() => started, 'The actual answer request is in flight.')
    const queued = await c.send('这条待处理内容要移除。', 'queue')
    await c.open()
    await inputMessage(page, queued.inputId).getByRole('button', { name: '移除待处理消息', exact: true }).click()
    await expect(inputMessage(page, queued.inputId)).not.toBeVisible()
    const controls: any[] = []
    await page.route(`**/${c.base}/runs/${first.runId}/stop`, async route => {
      controls.push(route.request().postDataJSON()); const response = await nativeReply(f, route)
      if (controls.length === 1) await route.abort(); else await route.fulfill({ response })
    })
    const composer = page.getByLabel('向 Agent 提问', { exact: true })
    await composer.fill('停止期间保留的中文草稿。')
    await page.getByRole('button', { name: '停止回答', exact: true }).click()
    await page.getByRole('button', { name: '核对并重试', exact: true }).click()
    await expect.poll(async () => (await c.read()).runs.find((run: any) => run.runId === first.runId)?.state).toBe('stopped')
    expect(controls).toHaveLength(2); expect(controls[1]).toEqual(controls[0])
    expect((await c.read()).inputs.find((input: any) => input.inputId === queued.inputId)?.state).toBe('removed')
    await page.reload(); await expect(composer).toHaveValue('停止期间保留的中文草稿。')
    expect((await c.read()).messages.filter((message: any) => message.role === 'assistant' && message.text)).toHaveLength(0)
  } finally { await f.close() }
})

test('session v2 explicit response precedes queue adoption; a late edit is rejected and a queued input can steer', async ({ page }) => {
  let releaseEdit!: () => void, releaseModel!: () => void, answers = 0
  const editGate = new Promise<void>(resolve => { releaseEdit = resolve }), modelGate = new Promise<void>(resolve => { releaseModel = resolve })
  const f = await fixture(async (payload, response) => {
    if (replyStudentPolicy(payload, response)) return
    const index = ++answers
    if (index === 1) reply(response, { calls: [{ id: 'first-question', name: 'student_ask', arguments: {
      question: '你预计会发生什么？', source: '当前学习目标', options: [], allowText: true, skippable: true } }] })
    else { if (index === 3) await modelGate; reply(response, { text: `明确回应与补充第 ${index} 步。` }) }
  })
  try {
    const c = await conversation(f, page); await c.send('先问我的预测。')
    const wait = await until(async () => (await c.read()).waits.find((wait: any) => wait.state === 'pending'), 'The original question is pending.')
    const queued = await c.send('待编辑并等待本轮完成。', 'queue'), promoted = await c.send('随后改为引导的内容。', 'queue')
    await c.open()
    const edited = inputMessage(page, queued.inputId)
    await edited.getByRole('button', { name: '编辑这条消息', exact: true }).click()
    await edited.getByLabel('修改这条消息', { exact: true }).fill('晚提交的修改草稿必须保留。')
    await page.route(`**/${c.base}/inputs/${queued.inputId}/control`, async route => { await editGate; await route.fallback() })
    await edited.getByRole('button', { name: '发送', exact: true }).click()
    // The in-flight edit keeps UI mutations serialized; resolve the original wait through the same public Node seam.
    await f.api(c.base + `/waits/${wait.waitId}/responses`, { requestId: randomUUID(), expectedVersion: wait.version,
      answer: { kind: 'text', text: '我预计为 1，先保留明确预测。' } })
    await until(() => answers === 3, 'The explicit response finishes before the queued successor starts.')
    const lateEdit = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/inputs/${queued.inputId}/control`))
    releaseEdit()
    expect((await lateEdit).status()).toBe(409)
    await expect(edited.getByLabel('修改这条消息', { exact: true })).toHaveValue('晚提交的修改草稿必须保留。')
    await inputMessage(page, promoted.inputId).getByRole('button', { name: '引导当前回答', exact: true }).click()
    releaseModel()
    await expect(page.getByText('明确回应与补充第 4 步。', { exact: true })).toBeVisible({ timeout: 30000 })
    const value = await c.read()
    expect(value.waits.find((item: any) => item.waitId === wait.waitId)?.state).toBe('consumed')
    expect(value.inputs.find((input: any) => input.inputId === queued.inputId)?.version).toBe(1)
    expect(value.inputs.find((input: any) => input.inputId === promoted.inputId)?.mode).toBe('steering')
    expect(value.runs.filter((run: any) => run.state === 'completed')).toHaveLength(2)
  } finally { releaseEdit(); releaseModel(); await f.close() }
})

test('session v2 sends the exact explicit Chinese response to its original wait even when the composer mode is queue', async ({ page }) => {
  let answers = 0
  const f = await fixture((payload, response) => {
    if (replyStudentPolicy(payload, response)) return
    if (++answers === 1) reply(response, { calls: [{ id: 'explicit-prediction', name: 'student_ask', arguments: {
      question: '你预计会发生什么？', source: '当前学习目标', options: [], allowText: true, skippable: true } }] })
    else reply(response, { text: answers === 2 ? '先解释你明确提交的预测。' : '最后处理原来排队的问题。' })
  })
  try {
    const c = await conversation(f, page), first = await c.send('先询问我的预测。')
    const wait = await until(async () => (await c.read()).waits.find((wait: any) => wait.state === 'pending'), 'The original question is pending.')
    const queued = await c.send('本轮结束以后再处理的内容。', 'queue')
    await c.open()
    await page.getByRole('combobox', { name: '发送方式', exact: true }).click()
    await page.getByRole('option', { name: '排队处理', exact: true }).click()
    const request = page.waitForRequest(request => new URL(request.url()).pathname.endsWith(`/waits/${wait.waitId}/responses`) && request.method() === 'POST')
    await page.getByLabel('回应 Agent 的问题', { exact: true }).fill('我预计为 1，先保留明确预测。')
    await page.getByRole('button', { name: '发送回应', exact: true }).click()
    expect((await request).postDataJSON()).toMatchObject({ expectedVersion: wait.version, answer: { kind: 'text', text: '我预计为 1，先保留明确预测。' } })
    await expect(page.getByText('最后处理原来排队的问题。', { exact: true })).toBeVisible({ timeout: 30000 })
    const value = await c.read(), resolved = value.waits.find((item: any) => item.waitId === wait.waitId)
    expect(resolved?.state).toBe('consumed'); expect(resolved?.runId).toBe(first.runId)
    expect(resolved?.response).toEqual({ kind: 'text', text: '我预计为 1，先保留明确预测。' })
    expect(value.inputs).toHaveLength(2)
    expect(value.runs.find((run: any) => run.runId === queued.runId)?.previousRunId).toBe(first.runId)
    expect(answers).toBe(3)
  } finally { await f.close() }
})
