import { evidenceDirectory } from './evidence'
import { test, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { teachingRunControlReceiptSchema } from '@xunjie/contracts/teaching-agent'
import { defaultLearningAdmissionPolicy } from '@xunjie/learning-space'
import { fixture, reply, until } from '../../server/tests/support/teaching-input-control.mjs'

const evidence = evidenceDirectory('wp07-200', process.env.XUNJIE_INPUT_CONTROL_EVIDENCE_DIR)
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
    if (evidence) await mkdir(evidence, { recursive: true })
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
    if (evidence) await page.screenshot({ path: join(evidence, `input-control-before-${process.platform}.png`) })
    release()
    await until(async () => (await f.api(`agent/${activity.activityId}/runs/${first.runId}`)).state === 'completed', 'Finish the captured request.')
    await page.goto(f.endpoint + '/?settings=models')
    await expect(page.getByRole('heading', { name: '个人模型设置', exact: true })).toBeVisible()
    await expect(page.getByText('正在读取配置…', { exact: true })).not.toBeVisible()
    await expect(page.getByText('正在读取当前模型…', { exact: true })).not.toBeVisible()
    if (evidence) await page.screenshot({ path: join(evidence, `input-settings-before-${process.platform}.png`) })
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
    if (evidence) await mkdir(evidence, { recursive: true })
    await f.configure()
    const saved = await f.api('agent-settings')
    if (saved.busyInputMode !== 'steering') await f.api('agent-settings', { requestId: crypto.randomUUID(), expectedVersion: saved.version, busyInputMode: 'steering' })
    await page.goto(f.endpoint + '/?settings=agent')
    const preferences = page.getByRole('radiogroup', { name: '忙碌时发送的默认方式', exact: true })
    await expect(preferences.getByRole('radio', { name: /引导当前任务/ })).toHaveAttribute('aria-checked', 'true')
    await preferences.getByRole('radio', { name: /本轮结束后处理/ }).click()
    await expect.poll(async () => (await f.api('agent-settings')).busyInputMode).toBe('queue')
    await page.reload()
    await expect(preferences.getByRole('radio', { name: /本轮结束后处理/ })).toHaveAttribute('aria-checked', 'true')
    await preferences.scrollIntoViewIfNeeded()
    if (evidence) await page.screenshot({ path: join(evidence, `input-settings-after-${process.platform}.png`) })
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
    expect(received?.input.delivery).toEqual({ version: 1, mode: 'queue', basis: { source: 'preference', preferenceVersion: (await f.api('agent-settings')).version } })
    expect(f.payloads.length).toBe(1)
    await page.getByLabel('你的问题', { exact: true }).fill('尚未发送的中文草稿\n保留下一步想法。')
    if (evidence) await page.screenshot({ path: join(evidence, `input-control-queue-${process.platform}.png`) })
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
    await queued.getByRole('button', { name: '保留草稿并收起', exact: true }).click()
    await queued.getByRole('button', { name: '编辑', exact: true }).click()
    await expect(queued.getByLabel('修改待处理内容', { exact: true })).toHaveValue('修改草稿，刷新后仍保留。')
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
    if (evidence) await page.screenshot({ path: join(evidence, `input-control-revised-${process.platform}.png`) })
  } finally { release(); await f.close() }
})

test('steering defers the old question while its Chinese response can be kept as a new supplement', async ({ page }) => {
  test.setTimeout(120000)
  const f = await fixture((_payload: unknown, response: import('node:http').ServerResponse, index: number) => index === 1
    ? reply(response, { calls: [{ id: 'prediction', name: 'student_ask', arguments: {
      question: '先说出你的预测？', source: '当前学习目标', options: [], allowText: true, skippable: true } }] })
    : reply(response, { text: '依据新的方向继续讨论，原提问没有被当作已回答。' }))
  try {
    await f.configure()
    const activity = await f.activity('引导当前任务并保留未交的回应')
    await f.send(activity, '先问我的预测。')
    await until(async () => (await f.api(`agent/${activity.activityId}/conversation`)).questions.length === 1, 'The real question is stored.')
    await page.goto(f.endpoint + '/?activity=' + activity.activityId)
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await page.getByLabel('你的回应', { exact: true }).fill('中文预测原文：先保留我的思路。')
    await page.getByLabel('你的问题', { exact: true }).fill('未发送的学习草稿。')
    await f.send(activity, '现在先改变讨论目标。')
    const card = page.getByRole('group', { name: 'Agent 的提问', exact: true })
    await expect(card).toContainText('已暂缓')
    await expect(card.getByRole('button', { name: '提交回应', exact: true })).not.toBeVisible()
    await card.getByRole('button', { name: '作为新的补充放入输入区', exact: true }).click()
    await expect(page.getByLabel('你的问题', { exact: true })).toHaveValue('未发送的学习草稿。\n\n中文预测原文：先保留我的思路。')
    expect((await f.api(`agent/${activity.activityId}/conversation`)).questions[0].response).toBeNull()
    await page.setViewportSize({ width: 640, height: 900 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await card.scrollIntoViewIfNeeded()
    if (evidence) await page.screenshot({ path: join(evidence, `input-control-deferred-dark-${process.platform}.png`) })
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  } finally { await f.close() }
})

test('stop and selected continuation keep original control identities and removed input never runs', async ({ page }) => {
  test.setTimeout(120000)
  const f = await fixture(async (_payload: unknown, response: import('node:http').ServerResponse, index: number) => {
    if (index === 1) await new Promise<void>(resolve => response.once('close', resolve))
    else reply(response, { text: '只处理你明确选择继续的输入。' })
  }, { learningAdmissionPolicy: { ...defaultLearningAdmissionPolicy, version: 'input-control-continuation-v1', maxPrincipalPhysical: 2 } })
  try {
    await f.configure()
    const activity = await f.activity('停止后选择待处理输入继续')
    await f.send(activity, '原任务正在生成。')
    await until(() => f.payloads.length === 1, 'Original generation is in flight.')
    await f.send(activity, '这条待处理内容要移除。', { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } })
    const selected = await f.send(activity, '这条输入由我选择继续。', { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } })
    await f.send(activity, '另一条暂停的引导稍后还要继续。')
    await page.goto(f.endpoint + '/?activity=' + activity.activityId)
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    const conversation = page.getByRole('region', { name: '与 Agent 的对话', exact: true })
    const removed = conversation.getByRole('article').filter({ hasText: '这条待处理内容要移除。' })
    await removed.getByRole('button', { name: '移除', exact: true }).click()
    await expect(removed).toContainText('已移除')
    const controls: string[] = []
    await page.route('**/runs/*/stop', async route => {
      controls.push(route.request().postDataJSON().requestId)
      await route.fetch(); await route.abort()
    })
    await conversation.getByRole('button', { name: '停止', exact: true }).click()
    await expect(conversation).toContainText('回答已停止', { timeout: 20000 })
    await expect(conversation).toContainText('已暂停 · 等你选择如何继续')
    await conversation.getByRole('checkbox', { name: '这条输入由我选择继续。', exact: true }).check()
    await conversation.getByRole('button', { name: '继续选中的输入', exact: true }).click()
    await expect(page.getByText('只处理你明确选择继续的输入。', { exact: true })).toBeVisible({ timeout: 20000 })
    const value = await f.api(`agent/${activity.activityId}/conversation`)
    expect(value.runs.length).toBe(2)
    expect(value.inputs.find((input: { inputId: string }) => input.inputId === selected.inputId)?.state).toBe('adopted')
    expect(f.payloads.length).toBe(2)
    expect(controls.length).toBe(1)
    expect(teachingRunControlReceiptSchema.parse(await f.api(`agent/${activity.activityId}/controls/${controls[0]}`)).operation).toBe('stop')
    await conversation.getByRole('checkbox', { name: '另一条暂停的引导稍后还要继续。', exact: true }).check()
    await conversation.getByRole('button', { name: '继续选中的输入', exact: true }).click()
    await expect.poll(async () => {
      const runs = (await f.api(`agent/${activity.activityId}/conversation`)).runs
      return runs.length === 3 && runs.at(-1)?.state === 'completed'
    }).toBe(true)
    expect((await f.api(`agent/${activity.activityId}/conversation`)).runs.length).toBe(3)
    expect(f.payloads.length).toBe(3)
    if (evidence) await page.screenshot({ path: join(evidence, `input-control-continue-${process.platform}.png`) })
  } finally { await f.close() }
})

test('explicit response bypasses queue, consumption rejects a late edit and another queued input becomes steering', async ({ page }) => {
  test.setTimeout(120000)
  let releaseEdit!: () => void, releaseModel!: () => void
  const editGate = new Promise<void>(resolve => { releaseEdit = resolve })
  const modelGate = new Promise<void>(resolve => { releaseModel = resolve })
  const f = await fixture(async (_payload: unknown, response: import('node:http').ServerResponse, index: number) => {
    if (index === 1) reply(response, { calls: [{ id: 'first-question', name: 'student_ask', arguments: {
      question: '你预计会发生什么？', source: '当前学习目标', options: [], allowText: true, skippable: true } }] })
    else { if (index === 3) await modelGate; reply(response, { text: `明确回应与补充第 ${index} 步。` }) }
  })
  try {
    await f.configure()
    const activity = await f.activity('明确回应、采纳竞争与改为引导')
    await f.send(activity, '先问我的预测。')
    await until(async () => (await f.api(`agent/${activity.activityId}/conversation`)).questions.length === 1, 'Question is stored.')
    const queued = await f.send(activity, '待编辑并等待本轮完成。', { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } })
    const promoted = await f.send(activity, '随后改为引导的内容。', { version: 1, mode: 'queue', basis: { source: 'explicit', preferenceVersion: 0 } })
    await page.goto(f.endpoint + '/?activity=' + activity.activityId)
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    const conversation = page.getByRole('region', { name: '与 Agent 的对话', exact: true })
    const edited = conversation.getByRole('article').filter({ has: page.locator(`[data-input-id="${queued.inputId}"]`) })
    await edited.getByRole('button', { name: '编辑', exact: true }).click()
    await edited.getByLabel('修改待处理内容', { exact: true }).fill('晚提交的修改草稿必须保留。')
    await page.route(`**/inputs/${queued.inputId}/control`, async route => { await editGate; await route.continue() })
    await edited.getByRole('button', { name: '保存修改', exact: true }).click()
    await page.getByLabel('你的回应', { exact: true }).fill('我预计为 1，先保留明确预测。')
    await page.getByRole('button', { name: '提交回应', exact: true }).click()
    await until(() => f.payloads.length === 3, 'The explicit response runs first; only then does the original queued input get consumed.')
    releaseEdit()
    await expect(edited.getByRole('alert')).toContainText('已采用')
    await expect(edited.getByLabel('修改待处理内容', { exact: true })).toHaveValue('晚提交的修改草稿必须保留。')
    const changing = conversation.getByRole('article').filter({ has: page.locator(`[data-input-id="${promoted.inputId}"]`) })
    await changing.getByRole('button', { name: '改为引导', exact: true }).click()
    await expect(changing).toContainText('已转为新的引导输入')
    releaseModel()
    await expect(page.getByText('明确回应与补充第 4 步。', { exact: true })).toBeVisible({ timeout: 20000 })
    const value = await f.api(`agent/${activity.activityId}/conversation`)
    expect(value.runs.length).toBe(2)
    expect(value.inputs.find((input: { inputId: string }) => input.inputId === queued.inputId)?.version).toBe(1)
    expect(value.questions[0].state).toBe('answered')
    expect(f.payloads.length).toBe(4)
  } finally { releaseEdit(); releaseModel(); await f.close() }
})
