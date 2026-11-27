import { evidenceDirectory } from './evidence'
import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication, resolveCredential } from '@xunjie/product-runtime'
import { fixedPdf } from '../../server/tests/fixtures/pdf-material.mjs'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
const output = evidenceDirectory('197')
let runtime: ReturnType<typeof openProductRuntime>
let host: Awaited<ReturnType<typeof createProductRuntimeHost>>
let upstream: ReturnType<typeof createServer>
let endpoint = '', root = ''
let richReply = ''
let thinkingReply = false
let toolEachReply = false
let skillTool: { skillId: string; version: number } | undefined
let holdFirstFinal = false
let finishFirstFinal: (() => void) | undefined
let translationCalls = 0
let slowReplyIndex = 2
let progressiveReply = false, providerEnded = false
let finishStream: () => void = () => {}
const replies: string[] = []
const modelMessages: unknown[] = []
const dispatched: { model: string; reasoning_effort?: string }[] = []

test.beforeEach(async () => {
  thinkingReply = false
  toolEachReply = false
  skillTool = undefined
  holdFirstFinal = false
  finishFirstFinal = undefined
  translationCalls = 0
  slowReplyIndex = 2
  richReply = ''; progressiveReply = false; providerEnded = false; finishStream = () => {}
  replies.length = 0
  modelMessages.length = 0
  dispatched.length = 0
  if (output) await mkdir(output, { recursive: true })
  upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const { model, reasoning_effort } = payload
    if (payload.messages?.some((message: { role: string; content: unknown }) => message.role === 'system'
      && typeof message.content === 'string' && message.content.includes('把用户提供的技能说明准确翻译成简体中文'))) {
      translationCalls++
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: JSON.stringify({ description: '阅读已选定的依据。' }) }, finish_reason: null }] }) + '\n\n')
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
      response.end('data: [DONE]\n\n'); return
    }
    if (payload.messages?.some((message: { role: string; content: unknown }) => message.role === 'system'
      && typeof message.content === 'string' && message.content.includes('STUDENT_INPUT_POLICY_V2'))) {
      const raw = payload.messages.filter((message: { role: string }) => message.role === 'user').at(-1)?.content
      const source = JSON.parse(typeof raw === 'string' ? raw : raw.map((part: { text?: string }) => part.text ?? '').join(''))
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const decision = JSON.stringify({ inputDigest: source.inputDigest, creationAuthorization: 'ordinary' })
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: decision }, finish_reason: null }] }) + '\n\n')
      response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n')
      response.end('data: [DONE]\n\n'); return
    }
    dispatched.push({ model, reasoning_effort })
    modelMessages.push(payload.messages)
    if (toolEachReply) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (value: unknown) => response.write('data: ' + JSON.stringify(value) + '\n\n')
      const questionNumber = Math.ceil(dispatched.length / 2)
      const last = payload.messages?.at(-1) as { role?: string; content?: unknown } | undefined
      const lastText = typeof last?.content === 'string' ? last.content : Array.isArray(last?.content)
        ? last.content.map((part: { text?: string }) => part.text ?? '').join('') : JSON.stringify(last?.content ?? '')
      const materializedToolResult = last?.role === 'user' && lastText.trimStart().startsWith('本步材料')
        && payload.messages?.some((message: { role: string }) => message.role === 'tool')
      if (last?.role === 'tool' || materializedToolResult || (last?.role === 'user'
        && lastText.trimStart().startsWith('此前工具与等待的原始事实') && lastText.includes('list_learning_tasks'))) {
        if (holdFirstFinal && questionNumber === 1) {
          await new Promise<void>(resolve => { finishFirstFinal = resolve })
        }
        const text = '界面回答' + questionNumber
        replies.push(text)
        send({ id: 'multi-turn-' + questionNumber, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
        send({ id: 'multi-turn-' + questionNumber, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        send({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })
        response.end('data: [DONE]\n\n')
      } else {
        send({ id: 'multi-turn-' + questionNumber, choices: [{ index: 0, delta: { role: 'assistant',
          reasoning_content: '正在分析第 ' + questionNumber + ' 个问题。' }, finish_reason: null }] })
        send({ id: 'multi-turn-' + questionNumber, choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
          id: 'multi-turn-facts-' + questionNumber, type: 'function', function: { name: 'list_learning_tasks',
            arguments: JSON.stringify({}) } }] }, finish_reason: null }] })
        send({ id: 'multi-turn-' + questionNumber, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
        response.end('data: [DONE]\n\n')
      }
      return
    }
    if (skillTool) {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (value: unknown) => response.write('data: ' + JSON.stringify(value) + '\n\n')
      send({ id: 'skill-load', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0,
        id: 'skill-load-call', type: 'function', function: { name: 'skill_load', arguments: JSON.stringify({ ...skillTool, path: 'SKILL.md' }) } }] }, finish_reason: null }] })
      send({ id: 'skill-load', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      skillTool = undefined
      response.end('data: [DONE]\n\n')
      return
    }
    const index = replies.length;
    const text = richReply || '界面回答' + (index + 1)
    replies.push(text)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (value: unknown) => response.write('data: ' + JSON.stringify(value) + '\n\n')
    const reply = () => {
      send({ id: 'ui-' + index, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
      send({ id: 'ui-' + index, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      send({ choices: [], usage: { prompt_tokens: 20000, completion_tokens: 100, total_tokens: 20100 } })
      response.end('data: [DONE]\n\n')
    }
    if (thinkingReply && index === 0) {
      send({ id: 'ui-thinking', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: '先核对已知条件，再比较可行的方法。'.repeat(80) }, finish_reason: null }] })
      await new Promise(resolve => setTimeout(resolve, 5000))
      send({ id: 'ui-thinking', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'thinking-facts', type: 'function',
        function: { name: 'list_learning_tasks', arguments: JSON.stringify({}) } }] }, finish_reason: null }] })
      send({ id: 'ui-thinking', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      response.end('data: [DONE]\n\n')
    } else if (progressiveReply) {
      const finish = new Promise<void>(resolve => { finishStream = resolve })
      const parts = text.match(/[\s\S]{1,55}/g) ?? []
      for (const part of parts) {
        if (response.destroyed) return
        send({ id: 'ui-stream', choices: [{ index: 0, delta: { role: 'assistant', content: part }, finish_reason: null }] })
        await new Promise(resolve => setTimeout(resolve, 90))
      }
      await finish
      providerEnded = true
      send({ id: 'ui-stream', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
      response.end('data: [DONE]\n\n')
    } else if (index === slowReplyIndex) {
      // Long enough to clear the credential withholding window, then a slow tail for stop.
      send({ id: 'ui-' + index, choices: [{ index: 0, delta: { role: 'assistant',
        content: '这是正在生成的界面回答，内容会逐步出现' }, finish_reason: null }] })
      const tail = setTimeout(() => {
        send({ id: 'ui-' + index, choices: [{ index: 0, delta: { content: '，并在结束后完整保留。' }, finish_reason: null }] })
        send({ id: 'ui-' + index, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
        response.end('data: [DONE]\n\n')
      }, 30000)
      tail.unref()
    } else reply()
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  root = await mkdtemp(join(tmpdir(), 'xj-teaching-ui-'))
  runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
  await runtime.install({ profile: 'local' })
  host = await createProductRuntimeHost({ root, createApplication: context => createProductLearningApplication(context) })
  endpoint = host.endpoint
})
test.afterEach(async () => {
  await host?.stop(); await runtime?.stop()
  upstream?.closeAllConnections(); if (upstream) await new Promise(resolve => upstream.close(resolve))
  if (root) await rm(root, { recursive: true, force: true })
})

async function configureModel(request: import('@playwright/test').APIRequestContext,
  headers: Record<string, string> = { 'content-type': 'application/json', 'x-xj-space': 'personal' }, thinking = false) {
  const connectionId = randomUUID()
  const port = (upstream.address() as { port: number }).port
  const saved = await request.post(endpoint + '/api/learning/models/connections', { headers, data: {
    requestId: randomUUID(), connectionId, expectedVersion: 0, name: '界面模型', protocol: 'chat-completions',
    baseUrl: `http://127.0.0.1:${port}/v1`, path: '/chat/completions', modelId: 'fixture-ui', dialect: thinking ? 'deepseek' : 'standard',
    parameterMode: thinking ? 'thinking' : 'plain', enabled: true,
    ...(thinking ? { reasoningLevels: ['low', 'high', 'max'], reasoningEffort: 'high' } : {}), contextWindow: 262144, maxOutputTokens: 8192,
    credential: { action: 'replace', value: 'synthetic-ui-key' } } })
  expect(saved.status()).toBe(200)
  expect((await request.post(endpoint + '/api/learning/models/selection', { headers,
    data: { requestId: randomUUID(), expectedVersion: 0, source: { kind: 'personal', connectionId, owner: 'self' } } })).status()).toBe(200)
}

async function conversationOf(request: import('@playwright/test').APIRequestContext, sessionId: string) {
  const context = await (await request.get(endpoint + '/api/learning/context')).json()
  const response = await request.get(`${endpoint}/api/learning/agent-sessions/${sessionId}/conversation?after=0`, {
    headers: { 'x-xj-space': 'personal', 'x-xj-namespace': context.clientNamespace, 'x-xj-agent-contract': '3' },
  })
  const value = await response.json()
  if (!response.ok() || !Array.isArray(value.turns)) throw new Error(`conversation ${sessionId} returned ${response.status()} ${JSON.stringify(value)}`)
  return value
}

async function prepareFirstQuestion(page: import('@playwright/test').Page, goal: string, question: string) {
  const firstQuestion = `${goal}。\n${question}`
  await page.getByRole('button', { name: 'Agent 对话', exact: true }).click()
  await page.getByLabel('向 Agent 提问', { exact: true }).fill(firstQuestion)
  return firstQuestion
}

async function sendFirstQuestion(page: import('@playwright/test').Page, firstQuestion: string) {
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.product-conversation-head h1')).toHaveText(firstQuestion)
}

test('a missing model keeps the activity and first question and offers the real settings entry', async ({ page }) => {
  await page.goto(endpoint)
  const firstQuestion = await prepareFirstQuestion(page, '缺模型时保留活动', '还没有模型时，这个问题应当保留。')
  await sendFirstQuestion(page, firstQuestion)
  await expect(page.getByText('尚未配置模型。')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.product-conversation .chat-message.user > .bubble')).toHaveText(firstQuestion)
  if (output) await page.screenshot({ path: join(output, `teaching-missing-model-${process.platform}.png`), fullPage: false })
  await page.getByRole('button', { name: '打开设置', exact: true }).click()
  await expect(page.getByRole('region', { name: '个人连接配置', exact: true })).toBeVisible({ timeout: 20000 })
  await expect(page.getByRole('region', { name: '当前空间模型', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  const provider = page.getByRole('dialog', { name: '添加供应商', exact: true })
  await expect(provider).toBeVisible()
  const modelId = 'fixture-model'
  await provider.getByRole('textbox', { name: '搜索或输入模型 ID', exact: true }).fill(modelId)
  await provider.getByRole('button', { name: '添加模型', exact: true }).click()
  const modelSettings = provider.getByRole('button', { name: new RegExp(`${modelId} 的配置`) })
  if (await modelSettings.getAttribute('aria-expanded') !== 'true') await modelSettings.click()
  await expect(provider.getByLabel('模型 ID的上下文窗口', { exact: true })).toBeVisible()
  await expect(provider.getByLabel('模型 ID的最大输出 token', { exact: true })).toBeVisible()
  await provider.getByLabel('模型 ID的上下文窗口', { exact: true }).scrollIntoViewIfNeeded()
  if (output) await page.screenshot({ path: join(output, `teaching-model-settings-${process.platform}.png`), fullPage: false })
})

test('the formal home and activity conversation persist a first question, a follow-up, reload and stop', async ({ page, request }) => {
  test.setTimeout(120_000)
  await configureModel(request, undefined, true)
  const headers = { 'content-type': 'application/json', 'x-xj-space': 'personal' }
  const port = (upstream.address() as { port: number }).port
  expect((await request.post(endpoint + '/api/learning/models/connections', { headers, data: {
    requestId: randomUUID(), connectionId: randomUUID(), expectedVersion: 0, name: '切换界面模型',
    protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${port}/v1`, path: '/chat/completions',
    modelId: 'fixture-ui-switched', dialect: 'deepseek', parameterMode: 'thinking', enabled: true,
    reasoningLevels: ['low', 'high', 'max'], reasoningEffort: 'high',
    contextWindow: 131072, maxOutputTokens: 8192, credential: { action: 'replace', value: 'synthetic-ui-switched-key' } } })).status()).toBe(200)
  await page.goto(endpoint)
  const firstQuestion = await prepareFirstQuestion(page, '界面持久学习对话', '请解释界面中的第一个学习问题。')
  const effort = page.getByRole('button', { name: '切换思考强度', exact: true })
  const model = page.getByRole('button', { name: '切换模型', exact: true })
  const ring = page.getByRole('img', { name: /^上下文容量/ })
  await expect(ring).toHaveAccessibleName('上下文容量，暂无用量，上限 26.2万 tokens')
  await expect(effort).toHaveText('高')
  await effort.press('Enter')
  await page.getByRole('menuitemradio', { name: '低', exact: true }).press('Enter')
  await expect(effort).toHaveText('低')
  await page.getByRole('button', { name: '发送消息', exact: true }).scrollIntoViewIfNeeded()
  if (output) await page.screenshot({ path: join(output, `teaching-home-${process.platform}.png`), fullPage: false })
  await sendFirstQuestion(page, firstQuestion)
  await expect(page.getByRole('region', { name: '与 Agent 的对话' })).toBeVisible()
  await expect(page.getByText('界面回答1', { exact: true })).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.product-conversation .chat-message.user > .bubble')).toHaveText(firstQuestion)
  await expect(page.locator('.product-conversation .prompt-input')).toBeVisible()
  await expect(page.getByText(/本次问题的 Skills/)).toHaveCount(0)
  await expect(page.getByText(/^来源：(?:个人模型|学校模型|原模型)/)).toHaveCount(0)
  expect(dispatched[0]).toEqual({ model: 'fixture-ui', reasoning_effort: 'low' })
  await ring.hover()
  await expect(page.getByRole('tooltip')).toContainText('上次调用 2万 tokens · 上限 26.2万 tokens')
  const capture = process.env.XUNJIE_COMPOSER_SCREENSHOT
  if (capture) {
    await page.locator('.product-conversation').screenshot({ path: capture, animations: 'disabled' })
  }
  const followUp = page.locator('.product-conversation textarea')
  await followUp.fill('切换模型时应保留草稿。')
  await model.click()
  const modelMenu = page.getByRole('menu', { name: '模型', exact: true })
  await expect(modelMenu.getByRole('menuitemradio', { name: 'fixture-ui 界面模型', exact: true })).toHaveAttribute('aria-checked', 'true')
  await modelMenu.getByRole('menuitemradio', { name: 'fixture-ui-switched 切换界面模型', exact: true }).click()
  await expect(model.locator('.prompt-model-label')).toHaveText('fixture-ui-switched', { timeout: 20000 })
  await expect(followUp).toHaveValue('切换模型时应保留草稿。')
  await expect(ring).toHaveAccessibleName('上下文容量，暂无用量，上限 13.1万 tokens')
  await effort.click()
  await page.getByRole('menuitemradio', { name: '最高', exact: true }).click()
  await expect(effort).toHaveText('最高')
  await followUp.fill('')
  expect(await page.locator('.main').evaluate(element => element.scrollHeight - element.clientHeight)).toBe(0)
  if (output) await page.screenshot({ path: join(output, `teaching-conversation-${process.platform}.png`), fullPage: false })

  await page.reload()
  await expect(page.getByText('界面回答1', { exact: true })).toBeVisible({ timeout: 20000 })
  await expect(page.getByText(/^来源：(?:个人模型|学校模型|原模型)/)).toHaveCount(0)

  let releaseInput!: () => void
  const pendingResponse = new Promise<void>(resolve => { releaseInput = resolve })
  await page.route(/\/agent-sessions\/[^/]+\/inputs$/, async route => {
    await pendingResponse
    await route.continue()
  }, { times: 1 })
  try {
    const secondQuestion = '这是界面中的第二个问题。'
    const nextRequest = page.waitForRequest(/\/agent-sessions\/[^/]+\/inputs$/)
    await page.getByLabel('向 Agent 提问', { exact: true }).fill(secondQuestion)
    await page.getByRole('button', { name: '发送消息', exact: true }).click()
    expect((await nextRequest).postDataJSON().text).toBe(secondQuestion)
    await expect(page.locator('.chat-message.user .bubble').last()).toHaveText(secondQuestion)
    await expect(followUp).toHaveValue('')
    await expect(page.getByText(/正在发送…|正在准备附件…/)).toHaveCount(0)
  } finally { releaseInput() }
  await expect(page.getByText('界面回答2', { exact: true })).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.chat-message.user .bubble')).toHaveCount(2)
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toHaveCount(0)
  expect(dispatched[1]).toEqual({ model: 'fixture-ui-switched', reasoning_effort: 'max' })
  await expect(page.getByText(/^来源：(?:个人模型|学校模型|原模型)/)).toHaveCount(0)

  await page.getByLabel('向 Agent 提问', { exact: true }).fill('请生成一个可以被停止的回答。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('正在生成回复')).toBeVisible({ timeout: 20000 })
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('生成期间继续输入的新草稿。')
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
  // The migrated composer keeps one primary action: a draft turns it into a steer
  // send, so clear the draft before using the stop control in the same slot.
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('')
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续生成', exact: true })).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('回答已停止，已发生的内容仍保留。', { exact: true })).toHaveCount(0)
  await expect(page.getByText('选择要继续处理的输入', { exact: true })).toHaveCount(0)
  await expect(page.locator('.chat-message.agent .turn-caret')).toHaveCount(0)
  await expect(page.locator('.chat-message.user').filter({ hasText: '请生成一个可以被停止的回答。' })).toBeVisible()
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('停止后继续输入的新草稿。')
  await expect(page.getByLabel('向 Agent 提问', { exact: true })).toHaveValue('停止后继续输入的新草稿。')
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
  if (output) await page.screenshot({ path: join(output, `teaching-stopped-${process.platform}.png`), fullPage: false })
  expect(replies.length).toBe(2)
})

test('editing a generating message stops the task before opening its editor', async ({ page, request }) => {
  test.setTimeout(90_000)
  slowReplyIndex = 0
  await configureModel(request)
  await page.goto(endpoint)
  const firstQuestion = await prepareFirstQuestion(page, '停止后编辑界面验收', '这条消息只有停止后才出现操作。')
  await sendFirstQuestion(page, firstQuestion)
  await expect(page.getByText('正在生成回复')).toBeVisible({ timeout: 20000 })
  const sessionId = new URL(page.url()).searchParams.get('session')!
  const student = page.locator('.product-conversation .chat-message.user').last()
  const edit = student.getByRole('button', { name: '编辑这条消息', exact: true })
  await expect(edit).toBeVisible()
  await expect(student.getByRole('button', { name: '移除这条消息', exact: true })).toHaveCount(0)
  let releaseStop!: () => void
  const stopGate = new Promise<void>(resolve => { releaseStop = resolve })
  await page.route('**/runs/*/stop', async route => { await stopGate; await route.continue() })
  try {
    await edit.click()
    await expect(student.getByLabel('修改这条消息', { exact: true })).toHaveCount(0)
    releaseStop()
  } finally { releaseStop() }
  await expect(page.getByText('回答已停止，已发生的内容仍保留。', { exact: true })).toHaveCount(0)
  await expect.poll(async () => (await conversationOf(request, sessionId)).turns.at(-1)?.state).toBe('stopped')
  await expect(student.getByLabel('修改这条消息', { exact: true })).toHaveValue(firstQuestion)
  await expect(student.getByRole('button', { name: '取消', exact: true })).toBeVisible()
  await expect(student.getByLabel('修改这条消息', { exact: true })).toHaveAttribute('rows', '1')
  const revised = '停止后修订的原问题。'
  await student.getByLabel('修改这条消息', { exact: true }).fill(revised)
  await student.getByRole('button', { name: '发送', exact: true }).click()
  await expect(student.locator('.bubble')).toHaveText(revised, { timeout: 20000 })
  await expect(student.getByRole('button', { name: '编辑这条消息', exact: true })).toBeVisible()
  await expect.poll(async () => (await conversationOf(request, sessionId)).turns.length).toBe(2)
  await expect(page.locator('.prompt-input').getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  await expect(page.getByText('选择要继续处理的输入', { exact: true })).toHaveCount(0)
})

test('editing a completed turn replaces its answer in place and survives reload', async ({ page, request }) => {
  test.setTimeout(60_000)
  slowReplyIndex = -1
  await configureModel(request)
  await page.goto(`${endpoint}/?space=personal&view=agent`)
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('完成后编辑原问题')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('界面回答1', { exact: true })).toBeVisible({ timeout: 20000 })
  const sessionId = new URL(page.url()).searchParams.get('session')!

  const student = page.locator('.product-conversation .chat-message.user').last()
  const edit = student.getByRole('button', { name: '编辑这条消息', exact: true })
  await expect(edit).toBeVisible()
  await expect(student.getByRole('button', { name: '移除这条消息', exact: true })).toHaveCount(0)
  await edit.click()
  const editor = student.getByLabel('修改这条消息', { exact: true })
  await expect(editor).toHaveValue('完成后编辑原问题')
  await editor.fill('完成后修订的问题')
  await student.getByRole('button', { name: '发送', exact: true }).click()
  await expect(student.locator('.bubble')).toHaveText('完成后修订的问题', { timeout: 20000 })
  await expect.poll(async () => {
    const value = await conversationOf(request, sessionId)
    return value.turns.length >= 2 && value.turns.at(-1)?.state === 'completed'
  }, { timeout: 45_000 }).toBe(true)
  await expect(page.locator('.product-conversation .chat-message.user')).toHaveCount(1)
  await expect(page.locator('.product-conversation .chat-message.agent')).toHaveCount(1)
  await expect(page.getByText('界面回答1', { exact: true })).toHaveCount(0)
  await expect(page.getByText('界面回答2', { exact: true })).toBeVisible()
  expect(JSON.stringify(modelMessages[1])).not.toContain('界面回答1')
  expect(JSON.stringify(modelMessages[1])).toContain('完成后修订的问题')
  await host.stop()
  host = await createProductRuntimeHost({ root, createApplication: context => createProductLearningApplication(context) })
  endpoint = host.endpoint
  await page.goto(`${endpoint}/?space=personal&view=agent&session=${sessionId}`)
  await expect(page.locator('.product-conversation .chat-message.user')).toHaveCount(1)
  await expect(page.locator('.product-conversation .chat-message.agent')).toHaveCount(1)
  await expect(page.getByText('界面回答1', { exact: true })).toHaveCount(0)
  if (output) await page.screenshot({ path: join(output, `teaching-completed-edit-${process.platform}.png`), fullPage: false })
})

test('the composer main action switches from stop to continue to send without footer controls', async ({ page, request }) => {
  test.setTimeout(90000)
  slowReplyIndex = 0
  await configureModel(request)
  await page.goto(`${endpoint}/?space=personal&view=agent`)
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('测试统一操作按钮')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const stop = page.locator('.prompt-input').getByRole('button', { name: '停止生成', exact: true })
  await expect(stop).toBeEnabled({ timeout: 20000 })
  await expect(page.locator('.session-conversation').getByRole('button', { name: '停止', exact: true })).toHaveCount(0)
  const stopped = page.waitForResponse(response => response.url().endsWith('/stop') && response.request().method() === 'POST')
  await stop.click()
  expect((await stopped).status()).toBe(200)
  const resume = page.locator('.prompt-input').getByRole('button', { name: '继续生成', exact: true })
  await expect(resume).toBeEnabled({ timeout: 20000 })
  await expect(page.getByText('选择要继续处理的输入', { exact: true })).toHaveCount(0)
  slowReplyIndex = 1
  const continued = page.waitForResponse(response => response.url().endsWith('/continue') && response.request().method() === 'POST')
  await resume.click()
  const continuedResponse = await continued
  expect(continuedResponse.status()).toBe(200)
  await expect(page.locator('.prompt-input').getByRole('button', { name: '停止生成', exact: true })).toBeEnabled({ timeout: 20_000 })
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('新的问题草稿')
  await expect(page.locator('.prompt-input').getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
})

test('standalone chat pins the chosen skill and fixed text/PDF attachments on the first and next messages', async ({ page, request }) => {
  test.setTimeout(120_000)
  await configureModel(request)
  const context = await (await request.get(`${endpoint}/api/learning/context`)).json()
  const headers = { 'x-xj-space': 'personal', 'x-xj-namespace': context.clientNamespace }
  const imported = await request.post(`${endpoint}/api/learning/skills/import`, { headers, data: {
    requestId: randomUUID(), source: 'controlled-test', packageVersion: '1',
    files: [{ path: 'SKILL.md', encoding: 'utf8', content: '---\nname: inspect-evidence\ndescription: Read the fixed evidence\n---\nCheck the evidence first.' }],
  } })
  const importedBody = await imported.text()
  expect(imported.status(), importedBody).toBe(200)
  const importedSkill = JSON.parse(importedBody)
  const skill = { skillId: importedSkill.skillId, version: importedSkill.version }

  await page.goto(`${endpoint}/?space=personal&view=agent`)
  const first = page.getByLabel('向 Agent 提问', { exact: true })
  await page.getByRole('button', { name: '添加', exact: true }).click()
  await expect(page.getByRole('menu', { name: '添加' })).toBeVisible()
  await expect(page.getByRole('menu', { name: '添加' }).getByText('添加', { exact: true })).toBeVisible()
  const menuWidth = await page.getByRole('menu', { name: '添加' }).evaluate(element => (element as HTMLElement).offsetWidth)
  const promptWidth = await page.locator('.prompt-input').evaluate(element => (element as HTMLElement).offsetWidth)
  expect(menuWidth).toBe(promptWidth)
  await page.waitForTimeout(300)
  if (output) await page.screenshot({ path: join(output, `agent-add-menu-${process.platform}.png`), fullPage: false })
  await page.getByRole('menuitem', { name: /技能/ }).click()
  await first.fill('/inspect')
  await expect(page.getByRole('option', { name: /inspect-evidence/ })).toBeEnabled()
  await first.press('Enter')
  await expect(first).toHaveValue('')
  await expect(page.getByRole('button', { name: '移除技能 inspect-evidence' })).toHaveCount(0)
  await expect(page.locator('.prompt-editor [data-astryx-token]').first()).toContainText('inspect-evidence')
  await first.fill('请先 /ins 再解释。')
  await first.evaluate(element => { const input = element as HTMLTextAreaElement; input.setSelectionRange(7, 7) })
  await first.press('p')
  await expect(page.getByRole('listbox', { name: '选择技能' })).toBeVisible()
  await first.press('Enter')
  await expect(first).toHaveValue('请先  再解释。')
  await expect(page.locator('.prompt-editor [data-astryx-token]')).toHaveCount(1)
  await first.fill('')

  if (output) await page.screenshot({ path: join(output, `agent-skill-chip-${process.platform}.png`), fullPage: false })
  const pickFile = async (file: string | { name: string; mimeType: string; buffer: Buffer }) => {
    await page.getByRole('button', { name: '添加', exact: true }).click()
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('menuitem', { name: /^附件/ }).click()
    await (await chooser).setFiles(file)
  }
  await pickFile({ name: 'example.c', mimeType: 'text/plain', buffer: Buffer.from('int answer = 42;') })
  await expect(page.getByRole('button', { name: '移除附件 example.c' })).toBeVisible()
  await expect.poll(() => page.locator('.prompt-attachments').evaluate(element => element.clientHeight)).toBeGreaterThan(50)
  await page.waitForTimeout(300)
  if (output) await page.screenshot({ path: join(output, `agent-text-attachment-${process.platform}.png`), fullPage: false })
  await page.reload()
  await expect(page.getByRole('button', { name: '移除附件 example.c' })).toBeVisible()
  await expect(page.locator('.prompt-editor [data-astryx-token]').first()).toContainText('inspect-evidence')
  const sendFixedMessage = async (text: string) => {
    await first.fill(text)
    await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeEnabled()
    skillTool = skill
    const sent = page.waitForResponse(response => response.request().method() === 'POST' && /\/agent-sessions\/[^/]+\/inputs$/.test(response.url()))
    await first.press('Enter')
    const received = await sent
    expect(received.status(), await received.text()).toBe(200)
    const { sessionId, requestId } = await received.json()
    const original = await request.get(`${endpoint}/api/learning/agent-sessions/${sessionId}/requests/${requestId}`, {
      headers: { ...headers, 'x-xj-agent-contract': '3' },
    })
    expect(original.status()).toBe(200)
    return (await original.json()).input.context
  }
  const inputContext = await sendFixedMessage('请读这个代码文件。')
  expect(inputContext.skills).toMatchObject([skill])
  expect(inputContext.materials).toHaveLength(1)
  expect(inputContext.materials[0]).toMatchObject({ kind: 'personal-material' })
  await expect(page.getByText('界面回答1', { exact: true })).toBeVisible({ timeout: 25000 })
  await expect(page.getByText('发送记录', { exact: true })).toHaveCount(0)
  await expect(page.getByText(/已纳入下一步|发送时的依据与版本/)).toHaveCount(0)
  await page.waitForTimeout(400)
  if (output) await page.screenshot({ path: join(output, `agent-first-message-${process.platform}.png`), fullPage: false })
  const skillRead = page.locator('.agent-trace-item').filter({ hasText: '读取技能 · inspect-evidence' }).first()
  const executionGroup = page.locator('.agent-trace-group-trigger').first()
  if (await executionGroup.getAttribute('aria-expanded') !== 'true') await executionGroup.click()
  await expect(skillRead).toBeVisible()
  await expect(skillRead.locator('.agent-trace-description')).toHaveCount(0)
  await expect(skillRead.getByLabel('固定 Skill 原文')).toHaveCount(0)
  await skillRead.locator(':scope > .agent-trace-trigger').click()
  await expect(skillRead.locator('.agent-skill-summary')).toHaveText('Read the fixed evidence')
  await page.reload()
  if (await executionGroup.getAttribute('aria-expanded') !== 'true') await executionGroup.click()
  await skillRead.locator(':scope > .agent-trace-trigger').click()
  await expect(skillRead.locator('.agent-skill-summary')).toHaveText('Read the fixed evidence')
  expect(translationCalls).toBe(0)
  await expect(skillRead).not.toContainText('Check the evidence first.')
  await expect(skillRead.getByRole('button', { name: '复制技能原文', exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: '添加', exact: true }).click()
  await page.getByRole('menuitem', { name: /技能/ }).click()
  const followUpSkill = page.getByRole('option', { name: /inspect-evidence/ })
  // Main now enables imported personal skills by default. Explicitly choose the
  // pinned version for this draft instead of accidentally toggling that default off.
  if (await followUpSkill.getAttribute('aria-selected') === 'true') {
    await followUpSkill.click()
    await page.getByRole('button', { name: '添加', exact: true }).click()
    await page.getByRole('menuitem', { name: /技能/ }).click()
  }
  await followUpSkill.click()
  await expect(page.locator('.prompt-editor [data-astryx-token]').first()).toContainText('inspect-evidence')
  await pickFile({ name: 'experiment.pdf', mimeType: 'application/pdf', buffer: fixedPdf() })
  await expect(page.getByRole('button', { name: '移除附件 experiment.pdf' })).toBeVisible()
  await expect.poll(() => page.locator('.prompt-attachments').evaluate(element => element.clientHeight)).toBeGreaterThan(50)
  await page.waitForTimeout(300)
  if (output) await page.screenshot({ path: join(output, `agent-pdf-attachment-${process.platform}.png`), fullPage: false })
  const finalContext = await sendFixedMessage('再看一下这份 PDF。')
  expect(finalContext).toMatchObject({ skills: [skill] })
  expect(finalContext?.materials.filter((item: { kind: string }) => item.kind === 'pdf')).toHaveLength(1)
  await expect(page.getByText('界面回答2', { exact: true })).toBeVisible({ timeout: 25000 })
  await expect(page.getByRole('button', { name: '移除技能 inspect-evidence' })).toHaveCount(0)
})

test('a course activity streams through the fixed help policy in the formal workspace conversation', async ({ page }) => {
  const control = await resolveCredential(root, 'control')
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID()
  const manage = async (path: string, body: unknown) => {
    const response = await page.request.post(endpoint + '/api/learning/manage/' + path, {
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + control }, data: body })
    expect(response.status()).toBe(200)
    return response.json()
  }
  await manage('course-import', { formatVersion: 1, requestId: randomUUID(),
    course: { courseId, name: '课程问答验收' }, task: { taskId, title: '课程问答任务', summary: '固定帮助范围' },
    release: { releaseId, objectives: ['解释课程概念'], requirements: '结合课堂内容回答。', materials: [], starterWorks: [],
      capabilities: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } }, resources: [] })
  const loginName = 'teaching-chrome-' + randomUUID(), password = randomUUID()
  const member = await manage('members', { requestId: randomUUID(), loginName, password })
  await manage('course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true })
  const login = await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })
  expect(login.status()).toBe(200)
  const setCookie = login.headers()['set-cookie']
  expect(setCookie, 'school login must set a browser session cookie').toBeTruthy()
  const rawCookie = setCookie!.split(';')[0]!
  const separator = rawCookie.indexOf('=')
  await page.context().addCookies([{ name: rawCookie.slice(0, separator), value: rawCookie.slice(separator + 1), url: endpoint }])
  const created = await page.request.post(endpoint + '/api/learning/course-activities', { data: { requestId: randomUUID(), releaseId } })
  expect(created.status()).toBe(200)
  const activityId = (await created.json()).activityId as string
  await configureModel(page.request, { 'content-type': 'application/json' })
  progressiveReply = true
  richReply = Array.from({ length: 24 }, (_, index) => `课程说明 ${index + 1}：先写出预期，再和试验观察比较。`).join('\n\n')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto(endpoint + '/?space=school&activity=' + activityId)
  const browserContext = await page.evaluate(async () => (await fetch('/api/learning/context')).json())
  expect(browserContext.identities?.map((item: { key: string }) => item.key), JSON.stringify(browserContext)).toContain('school')
  await expect(page.locator('#activity-title')).toHaveText('课程问答任务')
  const open = page.getByRole('button', { name: '打开对话', exact: true })
  await expect(open).toBeVisible()
  await open.click()
  const panel = page.getByRole('complementary', { name: '问题与引用' })
  await expect(panel).toBeVisible()
  await page.getByRole('textbox', { name: '你的问题', exact: true }).fill('课程允许问答时，请解释本任务的核心概念。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const reply = panel.locator('.chat-message.agent .turn-body')
  try {
    await expect(reply).toContainText('课程说明 1：', { timeout: 20000 })
    expect(providerEnded).toBe(false)
    await expect(reply).toContainText('课程说明 12：')
    expect(providerEnded).toBe(false)
  } finally { finishStream() }
  await expect(reply).toContainText('课程说明 24：')
  await expect(panel.locator('.turn-caret')).toHaveCount(0)
  await expect(panel.locator('.chat-message.user').filter({ hasText: '课程允许问答时' })).toHaveCount(1)
  await page.reload()
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await expect(reply).toContainText('课程说明 24：')
  await expect(panel.locator('.turn-caret')).toHaveCount(0)
  if (output) await page.screenshot({ path: join(output, `teaching-course-${process.platform}.png`), fullPage: false })
})

test('a product process restart reopens the persisted conversation in the same Chrome session', async ({ page, request }) => {
  await configureModel(request)
  const expected = '界面回答' + (replies.length + 1)
  await page.goto(endpoint)
  const firstQuestion = await prepareFirstQuestion(page, '重启恢复对话', '重启之后这个问题和回答还在吗？')
  await sendFirstQuestion(page, firstQuestion)
  await expect(page.getByText(expected, { exact: true })).toBeVisible({ timeout: 20000 })
  const sessionId = new URL(page.url()).searchParams.get('session')!
  await host.stop()
  host = await createProductRuntimeHost({ root, createApplication: context => createProductLearningApplication(context) })
  endpoint = host.endpoint
  await page.goto(endpoint + '/?space=personal&view=agent&session=' + sessionId)
  await expect(page.locator('.product-conversation-head h1')).toHaveText(firstQuestion)
  await expect(page.locator('.product-conversation .chat-message.user > .bubble')).toHaveText(firstQuestion)
  await expect(page.getByText(expected, { exact: true })).toBeVisible({ timeout: 20000 })
  if (output) await page.screenshot({ path: join(output, `teaching-restart-${process.platform}.png`), fullPage: false })
})


test('rich answers keep the standalone composer fixed while messages scroll and menus remain usable', async ({ page, request }) => {
  test.setTimeout(90000)
  richReply = '# 检查输入边界\n\n' + Array.from({ length: 22 }, (_, index) => `${index + 1}. 检查输入边界并比较预期与实际结果，保留每一次观察。`).join('\n\n')
    + '\n\n```python\nprint("hello")\n```\n\n| 输入 | 预期 |\n| --- | ---: |\n| 空文本 | 0 |'
  await configureModel(request)
  await page.goto(endpoint)
  const first = await prepareFirstQuestion(page, '富文本与固定输入区', '给我步骤、代码和表格。')
  await sendFirstQuestion(page, first)
  await expect(page.getByRole('button', { name: '复制表格为 Markdown', exact: true })).toBeVisible({ timeout: 20000 })
  const surface = page.locator('.product-conversation')
  const dock = surface.locator('.prompt-input')
  const original = await dock.boundingBox()
  await surface.locator('.chat-wrap').evaluate(element => { element.scrollTop = 0 })
  const afterScroll = (await dock.boundingBox())!
  expect(afterScroll.y + afterScroll.height).toBeCloseTo(original!.y + original!.height, 0)
  await surface.getByRole('button', { name: '添加', exact: true }).click()
  const menu = surface.getByRole('menu', { name: '添加', exact: true })
  await expect(menu).toBeVisible()
  await expect.poll(async () => Math.abs((await menu.boundingBox())!.width - (await dock.boundingBox())!.width)).toBeLessThan(3)
  await expect(menu.getByRole('menuitem', { name: /附件/ })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: /技能/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(surface.getByRole('button', { name: '切换模型', exact: true })).toBeVisible()
  await expect(surface.getByRole('img', { name: /上下文容量/ })).toBeVisible()
  await expect(surface.getByText('发送记录', { exact: true })).toHaveCount(0)
  await expect(surface.getByRole('combobox', { name: '发送方式' })).toHaveCount(0)
  await page.setViewportSize({ width: 1000, height: 760 })
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' })
  await surface.getByRole('button', { name: '切换模型', exact: true }).click()
  const models = page.getByRole('menu', { name: '模型', exact: true })
  await expect(models).toBeVisible()
  await expect.poll(async () => {
    const outer = (await surface.boundingBox())!, inner = (await models.boundingBox())!
    return inner.x >= outer.x && inner.x + inner.width <= outer.x + outer.width
  }).toBe(true)
  await page.keyboard.press('Escape')
  expect(await surface.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
  if (output) await page.screenshot({ path: join(output, `agent-all-ui-${process.platform}.png`) })
})


test('persisted answer deltas become visible before provider completion without repeatedly downloading history', async ({ page, request }) => {
  test.setTimeout(90000)
  progressiveReply = true
  richReply = Array.from({ length: 24 }, (_, index) => `第${index + 1}条：先检查这一处输入边界，写下你的预期，再比较实际观察和结果。`).join('\n\n')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await configureModel(request)
  let fullReads = 0, deltaReads = 0, metadataPages = 0
  page.on('request', request => {
    const url = new URL(request.url())
    if (!/\/agent-sessions\/[^/]+\/conversation$/.test(url.pathname)) return
    const after = Number(url.searchParams.get('after') ?? '0')
    if (after > 0) deltaReads++
    else { fullReads++; metadataPages++ }
  })
  await page.goto(endpoint)
  const first = await prepareFirstQuestion(page, '持续输出验收', '请逐条解释输入边界。')
  await sendFirstQuestion(page, first)
  const body = page.locator('.product-conversation .chat-message.agent .turn-body').last()
  try {
    await expect(body).toBeVisible({ timeout: 25000 })
    const firstLength = (await body.innerText()).length
    expect(firstLength).toBeGreaterThan(0)
    expect(providerEnded).toBe(false)
    const readsAtFirst = fullReads
    await expect.poll(async () => (await body.innerText()).length).toBeGreaterThan(firstLength + 20)
    expect(fullReads).toBeLessThanOrEqual(readsAtFirst + 1)
    await expect.poll(() => deltaReads).toBeGreaterThan(1)
    finishStream()
    await expect(body).toContainText('第24条', { timeout: 20000 })
    await expect(page.locator('.product-conversation .turn-caret')).toHaveCount(0)
    expect(fullReads).toBeLessThanOrEqual(2)
    expect(metadataPages).toBeGreaterThan(0)
  } finally { finishStream() }
})

test('a completed burst drains progressively while a reloaded historical answer is immediately complete', async ({ page, request }) => {
  richReply = Array.from({ length: 25 }, (_, index) => `第${index + 1}条：比较预期与实际输出，保留这一行的验证结果。`).join('\n\n')
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await configureModel(request)
  await page.goto(endpoint)
  const first = await prepareFirstQuestion(page, '完成缓冲验收', '给我完整的逐条说明。')
  await sendFirstQuestion(page, first)
  const body = page.locator('.product-conversation .chat-message.agent .turn-body').last()
  await expect(body).toBeVisible({ timeout: 20000 })
  const length = (await body.innerText()).replace(/\s/g, '').length
  expect(length).toBeGreaterThan(0)
  expect(length).toBeLessThan(richReply.replace(/\s/g, '').length)
  await expect(body).toContainText('第25条')
  await expect(page.locator('.product-conversation .turn-caret')).toHaveCount(0)
  await page.reload()
  await expect(body).toBeVisible()
  expect(await body.innerText()).toContain('第25条')
  expect(await page.locator('.product-conversation .turn-caret').count()).toBe(0)
})


test('thinking streams while active and automatically collapses before the answer, preserving reload history', async ({ page, request }) => {
  thinkingReply = true
  await configureModel(request, undefined, true)
  await page.goto(`${endpoint}/?space=personal&view=agent`)
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('请先分析再解释。')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  const thinking = page.locator('.agent-thinking').first(), trigger = thinking.locator('.agent-thinking-trigger')
  await expect(trigger).toContainText('正在思考', { timeout: 20000 })
  await expect(trigger).toHaveAttribute('aria-expanded', 'true')
  await expect(thinking.locator('.agent-thinking-content')).toContainText('先核对已知条件')
  await expect.poll(() => thinking.locator('.agent-thinking-content').evaluate(element =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop))).toBeLessThan(4)
  await expect(page.getByText('界面回答2', { exact: true })).toBeVisible({ timeout: 20000 })
  const group = page.getByLabel('思考与执行记录', { exact: true }).first()
  await expect(group.locator('.agent-trace-group-trigger')).toHaveAttribute('aria-expanded', 'true')
  await expect(group.locator('.agent-thinking')).toHaveCount(1)
  await expect(group.locator('.teaching-tool-record[data-tool-name="list_learning_tasks"]')).toBeVisible()
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
  await trigger.click()
  await expect(thinking.locator('.agent-thinking-content')).toContainText('先核对已知条件')
  await page.reload()
  await page.locator('.agent-trace-group-trigger').first().click()
  await expect(page.locator('.agent-thinking')).toHaveCount(1)
  await expect(trigger).toHaveAttribute('aria-expanded', 'false')
})

test('each turn keeps its own thinking and execution group after that turn student message', async ({ page, request }) => {
  test.setTimeout(90_000)
  toolEachReply = true
  await configureModel(request)
  await page.goto(`${endpoint}/?space=personal&view=agent`)
  const input = page.getByLabel('向 Agent 提问', { exact: true })

  await input.fill('第一轮问题')
  await input.press('Enter')
  await expect(page.getByText('界面回答1', { exact: true })).toBeVisible({ timeout: 20000 })
  await expect(page.getByLabel('思考与执行记录', { exact: true })).toHaveCount(1)

  const followUp = page.getByLabel('向 Agent 提问', { exact: true })
  await followUp.fill('第二轮问题')
  await followUp.press('Enter')
  await expect(page.getByText('界面回答2', { exact: true })).toBeVisible({ timeout: 20000 })
  await expect(page.getByLabel('思考与执行记录', { exact: true })).toHaveCount(2)

  const activityId = new URL(page.url()).searchParams.get('session')!
  const conversation = await conversationOf(request, activityId)
  expect(conversation.turns).toHaveLength(2)
  const [firstTurn, secondTurn] = conversation.turns
  const firstGroup = page.locator(`.session-conversation > div[data-turn-id="${firstTurn.turnId}"]`)
  const secondGroup = page.locator(`.session-conversation > div[data-turn-id="${secondTurn.turnId}"]`)
  await expect(firstGroup.locator('.agent-trace-group-trigger')).toBeVisible()
  await expect(firstGroup.locator(`.teaching-tool-record[data-run-id="${firstTurn.turnId}"]`)).toBeVisible()
  await expect(secondGroup.locator(`.teaching-tool-record[data-run-id="${secondTurn.turnId}"]`)).toBeVisible()

  const positions = await page.locator('.session-conversation').evaluate((root, turns) => {
    const children = [...root.children].filter(child => child.getAttribute('data-turn-id'))
    const indexOfMessage = (turnId: string, role: string) => children.findIndex(child =>
      child.getAttribute('data-turn-id') === turnId && !!child.querySelector('.chat-message.' + role))
    const traceCount = (turnId: string) => children.filter(child => child.getAttribute('data-turn-id') === turnId)
      .reduce((count, child) => count + child.querySelectorAll('.agent-trace-group-trigger').length, 0)
    return {
      firstStudent: indexOfMessage(turns[0], 'user'),
      firstAssistant: indexOfMessage(turns[0], 'agent'),
      firstTrace: traceCount(turns[0]),
      secondStudent: indexOfMessage(turns[1], 'user'),
      secondAssistant: indexOfMessage(turns[1], 'agent'),
      secondTrace: traceCount(turns[1]),
    }
  }, [firstTurn.turnId, secondTurn.turnId])
  expect(positions.firstStudent).toBeGreaterThanOrEqual(0)
  expect(positions.firstTrace).toBe(1)
  expect(positions.firstAssistant).toBeGreaterThan(positions.firstStudent)
  expect(positions.firstAssistant).toBeLessThan(positions.secondStudent)
  expect(positions.secondStudent).toBeLessThan(positions.secondAssistant)
  expect(positions.secondTrace).toBe(1)
  if (output) await page.screenshot({ path: join(output, `teaching-two-turn-traces-${process.platform}.png`), fullPage: false })
})

test('a second steer while running moves the shared trace after its newest student message', async ({ page, request }) => {
  test.setTimeout(90_000)
  toolEachReply = true
  holdFirstFinal = true
  await configureModel(request)
  await page.goto(`${endpoint}/?space=personal&view=agent`)
  await page.getByLabel('向 Agent 提问', { exact: true }).fill('第一轮问题')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByLabel('思考与执行记录', { exact: true })).toHaveCount(1, { timeout: 20000 })
  await expect(page.locator('.teaching-tool-record[data-tool-name="list_learning_tasks"]')).toBeVisible()
  const trace = page.getByLabel('思考与执行记录', { exact: true })
  await expect(trace.locator('.agent-trace-group-trigger')).toHaveAttribute('aria-expanded', 'true')

  const followUp = page.getByLabel('向 Agent 提问', { exact: true })
  await followUp.fill('第二轮方向')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByText('第二轮方向', { exact: true })).toBeVisible({ timeout: 20000 })

  try {
    const sessionId = new URL(page.url()).searchParams.get('session')!
    await expect.poll(async () => (await conversationOf(request, sessionId)).messages.filter((message: { role: string }) => message.role === 'user').length).toBe(2)
    const conversation = await conversationOf(request, sessionId)
    expect(conversation.turns).toHaveLength(1)
    const turnId = conversation.turns[0].turnId
    await expect(page.locator(`.session-conversation > div[data-turn-id="${turnId}"] .chat-message.user`)).toHaveCount(2, { timeout: 20000 })
    const latestTrace = page.getByLabel('思考与执行记录', { exact: true }).last()
    await expect(latestTrace.locator('.agent-trace-group-trigger')).toHaveAttribute('aria-expanded', 'true')
    const positions = await page.locator('.session-conversation').evaluate((root, id) => {
      const children = [...root.children].filter(child => child.getAttribute('data-turn-id') === id)
      const students = children.flatMap((child, index) => child.querySelector('.chat-message.user') ? [index] : [])
      const traces = children.flatMap((child, index) => child.querySelector('[aria-label="思考与执行记录"]') ? [index] : [])
      const latestStudent = students.at(-1)
      const latestStudentElement = latestStudent === undefined ? null : children[latestStudent]
      const latestTrace = latestStudentElement?.querySelector('[aria-label="思考与执行记录"]') ?? null
      const latestTraceAfterStudent = !!(latestStudentElement?.querySelector('.chat-message.user') && latestTrace
        && (latestStudentElement.querySelector('.chat-message.user')!.compareDocumentPosition(latestTrace) & Node.DOCUMENT_POSITION_FOLLOWING))
      return { firstStudent: students[0], latestStudent, latestTraceOwner: traces.at(-1), studentCount: students.length, traceCount: traces.length, latestTraceAfterStudent }
    }, turnId)
    expect(positions.firstStudent).toBeGreaterThanOrEqual(0)
    expect(positions.latestStudent).toBeGreaterThan(positions.firstStudent!)
    expect(positions.traceCount).toBe(1)
    expect(positions.latestTraceOwner).toBe(positions.latestStudent)
    expect(positions.latestTraceAfterStudent).toBe(true)
    if (output) await page.screenshot({ path: join(output, `teaching-steer-trace-${process.platform}.png`), fullPage: false })
  } finally {
    finishFirstFinal?.()
    finishFirstFinal = undefined
  }
})

test('Skill commands select Astryx inline tokens with keyboard navigation and preserve Chinese composition', async ({ page, request }) => {
  const context = await (await request.get(`${endpoint}/api/learning/context`)).json()
  const headers = { 'x-xj-space': 'personal', 'x-xj-namespace': context.clientNamespace }
  for (const name of ['alpha-check', 'beta-review']) {
    const response = await request.post(`${endpoint}/api/learning/skills/import`, { headers, data: {
      requestId: randomUUID(), source: 'controlled-test', packageVersion: '1',
      files: [{ path: 'SKILL.md', encoding: 'utf8', content: `---\nname: ${name}\ndescription: Check the selected evidence\n---\nRead the fixed evidence first.` }],
    } })
    expect(response.status()).toBe(200)
  }
  await page.goto(`${endpoint}/?space=personal&view=agent`)
  const input = page.getByLabel('向 Agent 提问', { exact: true })
  await input.fill('/')
  const choices = page.getByRole('listbox', { name: '选择技能', exact: true })
  await expect(choices.getByRole('option')).toHaveCount(2)
  const original = await input.getAttribute('aria-activedescendant')
  await input.press('ArrowDown')
  await expect(input).toBeFocused()
  expect(await input.getAttribute('aria-activedescendant')).not.toBe(original)
  const picked = await input.evaluate(element => document.getElementById(element.getAttribute('aria-activedescendant')!)!.querySelector('strong')!.textContent!)
  await input.press('Enter')
  await expect(input).toHaveValue('')
  await expect(choices).toHaveCount(0)
  const token = page.locator('.prompt-editor [data-astryx-token]')
  await expect(token).toHaveCount(1)
  await expect(token.filter({ hasText: picked })).toHaveCount(1)
  expect(new URL(page.url()).searchParams.has('session')).toBe(false)
  await expect(input).toBeFocused()
  const tokenBox = (await token.last().boundingBox())!, inputBox = (await input.boundingBox())!
  expect(Math.abs(tokenBox.y - inputBox.y)).toBeLessThan(6)
  await input.press('Backspace')
  await expect(token).toHaveCount(0)
  await input.fill('中文草稿')
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
  await input.press('Enter')
  // Synthetic composition does not open an OS IME: Chromium inserts a newline,
  // while the composer must leave the key to the IME rather than submit or pick a Skill.
  await expect(input).toHaveValue('中文草稿\n')
  expect(new URL(page.url()).searchParams.has('session')).toBe(false)
  await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
})
