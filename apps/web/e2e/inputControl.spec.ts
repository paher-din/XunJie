import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { fixture, reply, until } from '../../server/tests/support/teaching-input-control.mjs'

const evidence = process.env.XUNJIE_INPUT_CONTROL_EVIDENCE_DIR
  ?? fileURLToPath(new URL('../../../docs/student-agent-implementation/evidence/wp07-200', import.meta.url))
test.use({ trace: 'off' })

test('baseline: capture the existing busy composer and personal settings before input control UI', async ({ page }) => {
  test.skip(process.env.XUNJIE_CAPTURE_INPUT_CONTROL_BASELINE !== '1', 'Historical capture only, never product acceptance')
  test.setTimeout(120000)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(async (_payload: unknown, response: import('node:http').ServerResponse) => {
    await gate; reply(response, { text: '原有对话继续保留。' })
  })
  try {
    await mkdir(evidence, { recursive: true })
    await f.configure()
    const activity = await f.activity('核对运行中补充和排队')
    const first = await f.send(activity, '先解释当前问题。')
    await until(() => f.payloads.length === 1, 'The real model transport starts before capture.')
    await page.goto(f.endpoint + '/?activity=' + activity.activityId)
    await expect(page.locator('#activity-title')).toHaveText('核对运行中补充和排队')
    await page.getByRole('button', { name: '打开对话', exact: true }).click({ timeout: 10000 })
    await expect(page.getByRole('region', { name: '与 Agent 的对话', exact: true })).toBeVisible()
    await expect(page.getByRole('region', { name: '与 Agent 的对话', exact: true })).toContainText('先解释当前问题。')
    await expect(page.getByRole('region', { name: '与 Agent 的对话', exact: true })).toContainText('Agent 正在生成回答')
    await page.screenshot({ path: join(evidence, `input-control-before-${process.platform}.png`) })
    release()
    await until(async () => (await f.api(`agent/${activity.activityId}/runs/${first.runId}`)).state === 'completed', 'Finish the captured request.')
    await page.goto(f.endpoint + '/?settings=models')
    await expect(page.getByRole('heading', { name: '个人模型设置', exact: true })).toBeVisible()
    await expect(page.getByText('正在读取配置…', { exact: true })).not.toBeVisible()
    await expect(page.getByText('正在读取当前模型…', { exact: true })).not.toBeVisible()
    await page.screenshot({ path: join(evidence, `input-settings-before-${process.platform}.png`) })
  } finally { release(); await f.close() }
})

test('personal interaction settings persist and the busy composer freezes the chosen queue mode', async ({ page }) => {
  test.setTimeout(120000)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(async (_payload: unknown, response: import('node:http').ServerResponse, index: number) => {
    if (index === 1) await gate
    reply(response, { text: index === 1 ? '先完成原问题。' : '本轮结束后处理排队内容。' })
  })
  try {
    await mkdir(evidence, { recursive: true })
    await f.configure()
    await page.goto(f.endpoint + '/?settings=models')
    const preferences = page.getByRole('radiogroup', { name: '忙碌时发送的默认方式', exact: true })
    await expect(preferences.getByRole('radio', { name: /引导当前任务/ })).toHaveAttribute('aria-checked', 'true')
    await preferences.getByRole('radio', { name: /本轮结束后处理/ }).click()
    await expect.poll(async () => (await f.api('agent-settings')).busyInputMode).toBe('queue')
    await page.reload()
    await expect(preferences.getByRole('radio', { name: /本轮结束后处理/ })).toHaveAttribute('aria-checked', 'true')
    await preferences.scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(evidence, `input-settings-after-${process.platform}.png`) })
    const activity = await f.activity('在忙碌时可靠补充与排队')
    await f.send(activity, '先解释原问题。')
    await until(() => f.payloads.length === 1, 'The actual model request is in flight.')
    await page.goto(f.endpoint + '/?activity=' + activity.activityId)
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await expect(page.getByLabel('本次发送方式', { exact: true })).toHaveValue('queue')
    await page.getByLabel('你的问题', { exact: true }).fill('界面排队：只在完整轮结束后处理。')
    await page.getByRole('button', { name: '排队发送', exact: true }).click()
    await expect.poll(async () => {
      const value = await f.api(`agent/${activity.activityId}/conversation`)
      return value.inputs.find((input: { input: { draft: { question: string } } }) => input.input.draft.question.startsWith('界面排队'))?.state
    }).toBe('pending')
    const received = (await f.api(`agent/${activity.activityId}/conversation`)).inputs.at(-1)
    expect(received.input.delivery).toEqual({ version: 1, mode: 'queue', basis: { source: 'preference', preferenceVersion: 1 } })
    expect(f.payloads.length).toBe(1)
    await page.getByLabel('你的问题', { exact: true }).fill('尚未发送的中文草稿\n保留下一步想法。')
    await page.screenshot({ path: join(evidence, `input-control-queue-${process.platform}.png`) })
    release()
    await expect(page.getByText('本轮结束后处理排队内容。', { exact: true })).toBeVisible({ timeout: 20000 })
    await expect(page.getByLabel('你的问题', { exact: true })).toHaveValue('尚未发送的中文草稿\n保留下一步想法。')
    expect(f.payloads.length).toBe(2)
  } finally { release(); await f.close() }
})

test('queued input editing survives reload and lost control receipts without changing the received request', async ({ page }) => {
  test.setTimeout(120000)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const f = await fixture(async (_payload: unknown, response: import('node:http').ServerResponse, index: number) => {
    if (index === 1) await gate
    reply(response, { text: index === 1 ? '原回答完成。' : '采用修改后的排队内容。' })
  })
  try {
    await f.configure()
    const activity = await f.activity('查看和修改尚未采用的输入')
    await f.send(activity, '先处理原任务。')
    await until(() => f.payloads.length === 1, 'The original paid request stays in flight.')
    await f.send(activity, '收到时的原文。', { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } })
    await page.goto(f.endpoint + '/?activity=' + activity.activityId)
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    const queued = page.getByRole('region', { name: '与 Agent 的对话', exact: true }).getByRole('article').filter({ hasText: '收到时的原文。' })
    await expect(queued).toContainText('已收到 · 等待本轮结束')
    await queued.getByRole('button', { name: '编辑', exact: true }).click()
    await queued.getByLabel('修改待处理内容', { exact: true }).fill('修改草稿，刷新后仍保留。')
    await expect(queued).toContainText('修改草稿已在本机保留。')
    await page.reload()
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await expect(page.getByLabel('修改待处理内容', { exact: true })).toHaveValue('修改草稿，刷新后仍保留。')
    let dropped = false
    await page.route('**/inputs/*/control', async route => {
      const response = await route.fetch()
      if (!dropped) { dropped = true; await route.abort(); return }
      await route.fulfill({ response })
    })
    await page.getByRole('button', { name: '保存修改', exact: true }).click()
    await expect(queued).toContainText('当前版本：2')
    await expect(queued).toContainText('修改草稿，刷新后仍保留。')
    expect(dropped).toBe(true)
    const original = (await f.api(`agent/${activity.activityId}/events`)).find((event: { kind: string; body: { question?: string } }) =>
      event.kind === 'input' && event.body.question === '收到时的原文。')
    expect(original).toBeTruthy()
    expect(f.payloads.length).toBe(1)
    await page.getByLabel('你的问题', { exact: true }).fill('另一个未发送的草稿。')
    await page.getByLabel('你的问题', { exact: true }).focus()
    release()
    await expect(page.getByText('采用修改后的排队内容。', { exact: true })).toBeVisible({ timeout: 20000 })
    await expect(page.getByLabel('你的问题', { exact: true })).toHaveValue('另一个未发送的草稿。')
    await expect(page.getByLabel('你的问题', { exact: true })).toBeFocused()
    await expect(queued).toContainText('已纳入下一步')
    await page.screenshot({ path: join(evidence, `input-control-revised-${process.platform}.png`) })
  } finally { release(); await f.close() }
})
