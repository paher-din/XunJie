import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir, release } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type ServerResponse } from 'node:http'
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
const output = process.env.XUNJIE_MODEL_SWITCH_EVIDENCE_DIR
  ? resolve(process.env.XUNJIE_MODEL_SWITCH_EVIDENCE_DIR)
  : fileURLToPath(new URL('../../../.verification/wp07-201-mac', import.meta.url))

type Runtime = Pick<ReturnType<typeof openProductRuntime>, 'install' | 'start' | 'stop'>
let school: Runtime
let schoolRoot = '', endpoint = '', cookie = '', namespace = '', tunnelBase = '', schoolConnectionId = ''
let tunnel: ChildProcess | undefined
let memberIdentity: { environmentId: string; spaceId: string; principalId: string; kind: string }
let upstream: ReturnType<typeof createServer>
const requests: { path: string; model: string; text: string; at: string }[] = []
const cases: { title: string; status?: string; duration: number }[] = []
let work: { objectId: string; contentId: string; name: string; kind: string; encoding: string; mediaType: string; value: string }

function textOf(payload: Record<string, unknown>) {
  const messages = (payload.messages ?? payload.input ?? []) as { role?: string; content?: unknown }[]
  const users = messages.filter(message => message.role === 'user')
  const message = users.at(-1)
  return message ? (typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')) : ''
}
function hasToolResult(payload: Record<string, unknown>) {
  return ((payload.messages ?? []) as { role?: string }[]).some(message => message.role === 'tool')
}
function chatReply(response: ServerResponse, text: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const chunk of [
    { id: 'switch-ui', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: 'switch-ui', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]) response.write('data: ' + JSON.stringify(chunk) + '\n\n')
  response.end('data: [DONE]\n\n')
}
function toolCallReply(response: ServerResponse) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const delta = { role: 'assistant', tool_calls: [{ index: 0, id: 'read-fixed-switch-work', type: 'function',
    function: { name: 'read_work', arguments: JSON.stringify({ objectId: work.objectId, contentId: work.contentId }) } }] }
  for (const chunk of [
    { id: 'switch-ui', choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'switch-ui', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]) response.write('data: ' + JSON.stringify(chunk) + '\n\n')
  response.end('data: [DONE]\n\n')
}

function responsesReply(response: ServerResponse, text: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  response.write('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { id: 'resp-switch-ui',
    object: 'response', status: 'completed', output: [{ id: 'msg-switch-ui', type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } } }) + '\n\n')
  response.end()
}
function messagesReply(response: ServerResponse, text: string) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const event = (type: string, value: unknown) => response.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`)
  event('message_start', { type: 'message_start', message: { id: 'msg-switch-ui', type: 'message', role: 'assistant',
    model: 'personal-messages', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } })
  event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })
  event('content_block_stop', { type: 'content_block_stop', index: 0 })
  event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 10 } })
  event('message_stop', { type: 'message_stop' })
  response.end()
}
async function openTunnel(port: number) {
  const child = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15', '-o', 'ExitOnForwardFailure=yes',
    '-R', `80:localhost:${port}`, 'nokey@localhost.run'], { stdio: ['ignore', 'pipe', 'pipe'] })
  tunnel = child
  return await new Promise<string>((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => reject(new Error('public tunnel timeout: ' + output.slice(-1000))), 30000)
    const read = (chunk: Buffer) => {
      output += chunk.toString()
      const match = output.match(/https:\/\/[a-z0-9][a-z0-9.-]*\.lhr\.life/)
      if (match) { clearTimeout(timer); resolve(match[0]) }
    }
    child.stdout!.on('data', read); child.stderr!.on('data', read)
    child.once('exit', code => { clearTimeout(timer); reject(new Error('public tunnel exited ' + code + ': ' + output.slice(-1000))) })
  })
}


async function openRuntime(directory: string, nodePath = process.execPath): Promise<Runtime> {
  if (!process.env.XUNJIE_PRODUCT_TEST_PACKAGE) return openProductRuntime({ root: directory, resources: {
    nodePath, nodeVersion: '24.21.0', postgresBin: postgresBin!, postgresVersion: '18.6',
    webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } }) as Runtime
  const product = resolve(process.env.XUNJIE_PRODUCT_TEST_PACKAGE)
  const packaged = JSON.parse(await readFile(join(product, 'resources.json'), 'utf8'))
  const execute = promisify(execFile)
  const run = async (command: string, args: string[] = []) => JSON.parse((await execute(resolve(product, packaged.nodePath),
    [join(product, 'app/cli.js'), command, '--root', directory, ...args], { windowsHide: true, timeout: 180000 })).stdout)
  return { install: (input?: { profile?: string }) => run('install', ['--profile', input?.profile ?? 'local']), start: () => run('start'), stop: () => run('stop') } as unknown as Runtime
}


async function api(route: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await fetch(endpoint + '/api/learning/' + route, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const value = await response.json()
  return { status: response.status, value, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}
async function must(route: string, body?: unknown, headers: Record<string, string> = {}) {
  const result = await api(route, body, headers)
  expect(result.status, route + ': ' + JSON.stringify(result.value)).toBe(200)
  return result.value
}
const member = () => ({ cookie, 'x-xj-space': 'school', 'x-xj-namespace': namespace })
async function createActivity(goal: string) {
  return must('activities', { requestId: randomUUID(), goal, question: '', references: [] }, member())
}
async function openActivity(page: import('@playwright/test').Page, activityId: string, title: string) {
  const [name, value] = cookie.split('=')
  await page.context().addCookies([{ name, value, url: endpoint }])
  await page.goto(endpoint + '/?space=school&activity=' + activityId)
  await expect(page.locator('#activity-title')).toHaveText(title)
  const open = page.getByRole('button', { name: '打开对话', exact: true })
  if (await open.isVisible().catch(() => false)) await open.click()
  await expect(page.getByLabel('你的问题', { exact: true })).toBeVisible()
}
async function ask(page: import('@playwright/test').Page, text: string) {
  const input = page.getByLabel('你的问题', { exact: true })
  await input.fill(text)
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(input).toHaveValue('', { timeout: 15000 })
}
async function waitAnswer(page: import('@playwright/test').Page, text: string) {
  const bubble = page.locator('.teaching-message.assistant').filter({ hasText: text })
  await expect(bubble).toBeVisible({ timeout: 90000 })
  return bubble
}
async function waitAssistantCount(page: import('@playwright/test').Page, count: number) {
  await expect(page.locator('.teaching-message.assistant')).toHaveCount(count, { timeout: 120000 })
  return page.locator('.teaching-message.assistant').last()
}
async function events(activityId: string) {
  return must('agent/' + activityId + '/events', undefined, member())
}
async function conversation(activityId: string) {
  return must('agent/' + activityId + '/conversation', undefined, member())
}
async function switchTo(page: import('@playwright/test').Page, name: string, expectedModel: string) {
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  const choices = page.getByRole('region', { name: '当前空间模型', exact: true })
  await expect(choices).toBeVisible()
  const card = choices.locator('.st-provider').filter({ hasText: name })
  await card.getByRole('button', { name: /^(授权并选用|选用)$/, exact: true }).click()
  await expect(page.getByText(`已为当前学习活动切换到「${expectedModel}」。已有消息和结果保留原出处。`, { exact: true })).toBeVisible({ timeout: 90000 })
}

async function resetToSchool() {
  const current = await must('models/selection', undefined, member())
  if (current.selected?.connection.connectionId === schoolConnectionId) return
  await must('models/selection', { requestId: randomUUID(), expectedVersion: current.version,
    source: { kind: 'school', connectionId: schoolConnectionId } }, member())
}

test.beforeAll(async () => {
  test.setTimeout(300000)
  await mkdir(output, { recursive: true })
  upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    const payload = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    const text = textOf(payload)
    const model = String(payload.model ?? '')
    requests.push({ path: request.url!, model, text, at: new Date().toISOString() })
    if (request.url === '/v1/chat/completions' && text.includes('读取固定作品') && !hasToolResult(payload)) return toolCallReply(response)
    if (text.includes('慢速')) await new Promise(done => setTimeout(done, 4000))
    if (request.url === '/v1/chat/completions') {
      const reply = text.includes('读取固定作品') ? '学校模型回答1'
        : text.includes('慢速') ? '学校模型回答2'
        : text.includes('第三问') ? '学校模型回答3'
        : text.includes('先确认原有学校回答') ? '学校模型回答4'
        : 'OK'
      return chatReply(response, reply)
    }
    const reply = model === 'personal-messages' ? '个人 Messages 模型回答' : '个人模型回答'
    if (request.url === '/v1/responses') return responsesReply(response, reply + '2')
    if (request.url === '/v1/messages' || request.url === '/anthropic/v1/messages') return messagesReply(response, reply + '4')
    response.writeHead(404); response.end()
  })
  await new Promise<void>(done => upstream.listen(0, '127.0.0.1', done))
  const port = (upstream.address() as { port: number }).port
  tunnelBase = await openTunnel(port)
  const root = await mkdtemp(join(tmpdir(), 'xj-model-switch-ui-'))
  schoolRoot = join(root, 'school')
  const hook = join(root, 'dns-hook.cjs')
  await writeFile(hook, `const dns = require('node:dns')
const target = { address: '3.208.46.244', family: 4 }
const original = dns.lookup
dns.lookup = function (host, options, callback) {
  if (typeof options === 'function') { callback = options; options = {} }
  if (typeof host === 'string' && host.endsWith('.lhr.life')) return process.nextTick(callback, null,
    options && options.all ? [target] : target.address, options && options.all ? undefined : target.family)
  return original.call(this, host, options, callback)
}
const promises = require('node:dns/promises'), originalPromise = promises.lookup
promises.lookup = async (host, options) => typeof host === 'string' && host.endsWith('.lhr.life')
  ? (options && options.all ? [target] : target) : originalPromise(host, options)
`)
  const wrapper = join(root, 'node-wrapper.sh')
  await writeFile(wrapper, `#!/bin/sh\nNODE_OPTIONS="--require ${hook}" exec ${process.execPath} "$@"\n`, { mode: 0o755 })
  school = await openRuntime(schoolRoot, wrapper)
  await school.install({ profile: 'school', database: { mode: 'managed' } })
  const schoolStatus = await school.start()
  endpoint = schoolStatus.endpoint!
  namespace = schoolStatus.environment.clientNamespace
  const admin = { authorization: 'Bearer ' + await resolveCredential(schoolRoot, 'control') }
  const password = randomUUID()
  memberIdentity = await must('manage/members', { requestId: randomUUID(), loginName: 'model-switch-ui', password }, admin)
  const login = await api('login', { loginName: 'model-switch-ui', password })
  expect(login.status, JSON.stringify(login.value)).toBe(200)
  cookie = login.cookie!
  const connection = (name: string, protocol: string, baseUrl: string, path: string, modelId: string) => ({ requestId: randomUUID(),
    connectionId: randomUUID(), expectedVersion: 0, name, protocol, baseUrl, path, modelId, dialect: 'standard', parameterMode: 'plain',
    enabled: true, contextWindow: 262144, maxOutputTokens: 2048, credential: { action: 'replace', value: 'synthetic-model-switch-key' } })
  const schoolDefault = connection('学校统一模型', 'chat-completions', `http://127.0.0.1:${port}/v1`, '/chat/completions', 'school-chat')
  schoolConnectionId = schoolDefault.connectionId
  await must('manage/model-default', { ...schoolDefault,
    policy: { checksAllowed: true, maxChecksPerHour: 10, maxOutputTokens: 2048, timeoutMs: 30000 } }, admin)
  await must('models/connections', connection('个人 Responses 模型', 'responses', tunnelBase + '/v1', '/responses', 'personal-responses'), { cookie, 'x-xj-namespace': namespace })
  await must('models/connections', connection('个人 Messages 模型', 'messages', tunnelBase + '/anthropic', '/v1/messages', 'personal-messages'), { cookie, 'x-xj-namespace': namespace })
  work = { objectId: randomUUID(), contentId: randomUUID(), name: '切换固定观察.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: '固定观察：总数为 37。' }
})

test.afterEach(async ({}, info) => {
  cases.push({ title: info.title, ...(info.status ? { status: info.status } : {}), duration: info.duration })
})
test.afterAll(async ({}, info) => {
  tunnel?.kill('SIGTERM')
  await school?.stop().catch(() => {})
  upstream?.closeAllConnections(); if (upstream) await new Promise(done => upstream.close(done))
  await writeFile(join(output, 'model-switch-browser-' + process.platform + '.json'), JSON.stringify({
    platform: process.platform, os: release(), browser: 'installed Chrome', channel: info.project.use.channel,
    measuredAt: new Date().toISOString(), topology: 'single school profile; local synthetic school default plus public-tunnel synthetic personal connections',
    provider: { model: 'synthetic public tunnel', protocols: ['chat-completions', 'responses', 'messages'] }, endpoint, tunnelBase,
    memberIdentity, cases, requests,
  }, null, 2))
  const fixtureName = schoolRoot.split('/').at(-2) ?? ''
  if (!/^xj-model-switch-ui-[A-Za-z0-9]+$/.test(fixtureName)) throw new Error('cleanup boundary mismatch: ' + schoolRoot)
  if (schoolRoot) await rm(join(schoolRoot, '..'), { recursive: true, force: true })
})

test('school and personal models switch both ways while prior questions, answers, work and tool results keep their provenance', async ({ page }) => {
  test.setTimeout(180000)
  await resetToSchool()
  const activity = await createActivity('模型切换与学习延续')
  const activityId = activity.activityId
  await must('workspaces/' + activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] }, member())
  await openActivity(page, activityId, '模型切换与学习延续')

  await ask(page, '请读取固定作品并解释总数。')
  const toolRecords = page.locator('[aria-label="工具记录"]')
  await expect(toolRecords).toContainText('已完成', { timeout: 30000 })
  const schoolAnswer = await waitAnswer(page, '学校模型回答1')
  await expect(schoolAnswer.getByText('来源：学校模型 · school-chat · chat-completions', { exact: true })).toBeVisible()
  await expect(toolRecords).toContainText('切换固定观察.txt')
  await page.screenshot({ path: join(output, 'model-switch-school-before-darwin.png') })

  await switchTo(page, '个人 Responses 模型', 'personal-responses')
  await page.screenshot({ path: join(output, 'model-switch-school-to-personal-darwin.png') })
  await page.getByRole('button', { name: '返回学习空间', exact: true }).click()
  await expect(page.locator('#activity-title')).toHaveText('模型切换与学习延续')
  await page.reload()
  await openActivity(page, activityId, '模型切换与学习延续')
  await expect(schoolAnswer).toBeVisible()
  await expect(toolRecords).toContainText('切换固定观察.txt')

  await ask(page, '这是个人模型下的继续提问。')
  const personalAnswer = await waitAssistantCount(page, 2)
  await expect(personalAnswer.getByText('来源：个人模型 · personal-responses · responses', { exact: true })).toBeVisible()
  await expect(schoolAnswer).toBeVisible()
  await page.screenshot({ path: join(output, 'model-switch-personal-answer-darwin.png') })

  await switchTo(page, '学校统一模型', 'school-chat')
  await page.screenshot({ path: join(output, 'model-switch-personal-to-school-darwin.png') })
  await page.getByRole('button', { name: '返回学习空间', exact: true }).click()
  await page.reload()
  await openActivity(page, activityId, '模型切换与学习延续')
  await ask(page, '回到学校模型后的第三问。')
  const schoolAgain = await waitAnswer(page, '学校模型回答3')
  await expect(schoolAgain.getByText('来源：学校模型 · school-chat · chat-completions', { exact: true })).toBeVisible()

  await switchTo(page, '个人 Messages 模型', 'personal-messages')
  await page.getByRole('button', { name: '返回学习空间', exact: true }).click()
  await page.reload()
  await openActivity(page, activityId, '模型切换与学习延续')
  await ask(page, '这是个人 Messages 协议下的第四问。')
  const messagesAnswer = await waitAssistantCount(page, 4)
  await expect(messagesAnswer.getByText('来源：个人模型 · personal-messages · messages', { exact: true })).toBeVisible()
  await expect(schoolAnswer).toBeVisible()
  await expect(personalAnswer).toBeVisible()
  await expect(schoolAgain).toBeVisible()
  await expect(toolRecords).toContainText('切换固定观察.txt')
  await page.screenshot({ path: join(output, 'model-switch-all-protocols-darwin.png') })

  const eventsValue = await events(activityId)
  const switchEvents = eventsValue.filter((event: { kind: string }) => event.kind.startsWith('model-switch-'))
  expect(switchEvents.filter((event: { kind: string }) => event.kind === 'model-switch-completed')).toHaveLength(3)
  const conversationValue = await conversation(activityId)
  const assistant = conversationValue.messages.filter((message: { role: string }) => message.role === 'assistant')
  expect(assistant.map((message: { modelSource?: string }) => message.modelSource)).toEqual(['school', 'personal', 'school', 'personal'])
  expect(conversationValue.tools).toHaveLength(1)
  expect(conversationValue.tools[0].name).toBe('read_work')
  expect(conversationValue.tools[0].outcome).toBe('completed')
  expect(requests.filter(item => item.text.includes('读取固定作品')).length).toBe(2)
})

test('a switch requested during a slow answer waits for the original call, keeps duplicate identity and rejects a competing request before continuing on the new model', async ({ page }) => {
  test.setTimeout(180000)
  await resetToSchool()
  const activity = await createActivity('在途切换与重复请求')
  const activityId = activity.activityId
  await openActivity(page, activityId, '在途切换与重复请求')
  await ask(page, '请慢速回答这个在途切换问题。')
  await expect(page.getByText('Agent 正在生成回答…', { exact: true })).toBeVisible({ timeout: 15000 })

  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  const choices = page.getByRole('region', { name: '当前空间模型', exact: true })
  const card = choices.locator('.st-provider').filter({ hasText: '个人 Responses 模型' })
  await card.getByRole('button', { name: /^(授权并选用|选用)$/, exact: true }).click()
  await expect(page.getByText('当前回答或工具仍在收尾；切换请求已保留，完成后将继续核对。', { exact: true })).toBeVisible({ timeout: 60000 })
  await page.screenshot({ path: join(output, 'model-switch-inflight-paused-darwin.png') })

  const switchEventsBefore = await events(activityId)
  const paused = switchEventsBefore.filter((event: { kind: string }) => event.kind === 'model-switch-paused')
  expect(paused).toHaveLength(1)
  const pausedRequestId = (paused[0] as { body: { requestId: string } }).body.requestId
  const selection = await must('models/selection', undefined, { cookie, 'x-xj-namespace': namespace })
  const repeated = await must('agent/' + activityId + '/model-switches', { requestId: pausedRequestId, selectionVersion: selection.version }, member())
  expect(repeated.state).toBe('paused')
  expect(repeated.requestId).toBe(pausedRequestId)
  const competing = await api('agent/' + activityId + '/model-switches', { requestId: randomUUID(), selectionVersion: selection.version }, member())
  expect(competing.status).toBe(409)

  await page.getByRole('button', { name: '返回学习空间', exact: true }).click()
  await page.reload()
  await openActivity(page, activityId, '在途切换与重复请求')
  const schoolAnswer = await waitAnswer(page, '学校模型回答2')
  await expect(schoolAnswer.getByText('来源：学校模型 · school-chat · chat-completions', { exact: true })).toBeVisible({ timeout: 30000 })
  await expect.poll(async () => (await events(activityId)).filter((event: { kind: string }) => event.kind === 'model-switch-completed').length,
    { timeout: 30000 }).toBe(1)
  await ask(page, '切换完成后的继续提问。')
  const personalAnswer = await waitAssistantCount(page, 2)
  await expect(personalAnswer.getByText('来源：个人模型 · personal-responses · responses', { exact: true })).toBeVisible()
  expect(requests.filter(item => item.text.includes('在途切换问题')).length).toBe(1)
  await page.screenshot({ path: join(output, 'model-switch-inflight-continued-darwin.png') })
})

test('a lost switch reply is explicit, keeps the activity readable after reload and a product process restart, and can be reapplied', async ({ page }) => {
  test.setTimeout(180000)
  await resetToSchool()
  const activity = await createActivity('网络中断与进程重启')
  const activityId = activity.activityId
  await openActivity(page, activityId, '网络中断与进程重启')
  await ask(page, '先确认原有学校回答。')
  await waitAnswer(page, '学校模型回答4')

  let aborted = 0
  await page.route('**/agent/*/model-switches', async route => { aborted += 1; await route.abort('failed') })
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  const choices = page.getByRole('region', { name: '当前空间模型', exact: true })
  const card = choices.locator('.st-provider').filter({ hasText: '个人 Responses 模型' })
  await card.getByRole('button', { name: /^(授权并选用|选用)$/, exact: true }).click()
  await expect(page.getByText(/切换结果尚未确认/)).toBeVisible({ timeout: 20000 })
  await page.unroute('**/agent/*/model-switches')
  await page.screenshot({ path: join(output, 'model-switch-network-lost-darwin.png') })
  expect(aborted).toBeGreaterThan(0)

  await page.getByRole('button', { name: '返回学习空间', exact: true }).click()
  await page.reload()
  await expect(page.locator('#activity-title')).toHaveText('网络中断与进程重启')
  const open = page.getByRole('button', { name: '打开对话', exact: true })
  if (await open.isVisible().catch(() => false)) await open.click()
  await expect(page.getByText('学校模型回答4', { exact: true })).toBeVisible()
  await page.screenshot({ path: join(output, 'model-switch-reload-after-lost-darwin.png') })

  const oldEndpoint = endpoint
  await school.stop()
  endpoint = (await school.start()).endpoint ?? endpoint
  expect(endpoint).toBe(oldEndpoint)
  await page.goto(endpoint + '/?space=school&activity=' + activityId)
  await expect(page.locator('#activity-title')).toHaveText('网络中断与进程重启')
  if (await page.getByRole('button', { name: '打开对话', exact: true }).isVisible().catch(() => false))
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await expect(page.getByText('学校模型回答4', { exact: true })).toBeVisible()
  await page.screenshot({ path: join(output, 'model-switch-after-restart-darwin.png') })

  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await page.getByRole('button', { name: '将当前选用应用到学习活动', exact: true }).click()
  await expect(page.getByText('已为当前学习活动切换到「personal-responses」。已有消息和结果保留原出处。', { exact: true })).toBeVisible({ timeout: 90000 })
  await page.getByRole('button', { name: '返回学习空间', exact: true }).click()
  await page.reload()
  await openActivity(page, activityId, '网络中断与进程重启')
  await ask(page, '重试切换后的继续提问。')
  const personalAnswer = await waitAssistantCount(page, 2)
  await expect(personalAnswer.getByText('来源：个人模型 · personal-responses · responses', { exact: true })).toBeVisible()
  const eventsValue = await events(activityId)
  expect(eventsValue.filter((event: { kind: string }) => event.kind === 'model-switch-completed')).toHaveLength(1)
})

test('stopping an answer keeps the stopped state and the unsent draft', async ({ page }) => {
  test.setTimeout(180000)
  await resetToSchool()
  const activity = await createActivity('停止与草稿保留')
  const activityId = activity.activityId
  await openActivity(page, activityId, '停止与草稿保留')
  await ask(page, '请慢速回答停止测试。')
  await expect(page.getByText('Agent 正在生成回答…', { exact: true })).toBeVisible({ timeout: 20000 })
  const input = page.getByLabel('你的问题', { exact: true })
  await input.fill('生成期间继续输入的新草稿。')
  await expect(page.getByRole('button', { name: '等待当前回答', exact: true })).toBeDisabled()
  await expect(page.getByText('当前回答结束后再发送；问题会先保存在草稿中。', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.getByText('回答已停止，已发生的内容仍保留。', { exact: true })).toBeVisible({ timeout: 30000 })
  await expect(input).toHaveValue('生成期间继续输入的新草稿。')
  await page.screenshot({ path: join(output, 'model-switch-stopped-draft-darwin.png') })
  await page.reload()
  await openActivity(page, activityId, '停止与草稿保留')
  await expect(page.getByLabel('你的问题', { exact: true })).toHaveValue('生成期间继续输入的新草稿。', { timeout: 15000 })
})
