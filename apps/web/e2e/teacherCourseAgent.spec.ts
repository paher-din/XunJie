import { expect, test, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { openProductRuntime, resolveCredential } from '@xunjie/product-runtime'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
test.setTimeout(150_000)
const id = randomUUID
const firstCourse = id(), secondCourse = id(), forbiddenCourse = id()
const taskId = id(), releaseId = id(), materialId = id()
const providerCalls: string[][] = []
const toolInvocations = new Set<string>()
let readingTools = false
const roots: { root: string; runtime: ReturnType<typeof openProductRuntime> }[] = []
let provider: Server, device: string, school: string
let teacherHeaders: Record<string, string>, modelConfig: Record<string, unknown>, schoolAdmin: Record<string, string>
const personalHeaders = { 'x-xj-space': 'personal' }
const sharedProviderId = id()
let sharedProviderInput: Record<string, unknown>
let teacherIdentity: { spaceId: string; principalId: string; environmentId: string }
let skill: { skillId: string; version: number }

async function api(endpoint: string, route: string, body?: unknown, headers: Record<string, string> = {}, status = 200) {
  const response = await fetch(endpoint + '/api/learning/' + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const value = await response.json()
  expect(response.status, route + ' ' + (value?.error ?? '')).toBe(status)
  return { body: value, cookie: response.headers.get('set-cookie')?.split(';')[0] }
}

async function startRuntime(profile: 'local' | 'school') {
  const root = await mkdtemp(join(tmpdir(), 'xj-teacher-course-agent-'))
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
    postgresBin, postgresVersion: '18.6', webRoot: resolve('dist-runtime'),
    windowsPrerequisitePath: resolve('../../scripts/windows-prereq-prepare.ps1') } })
  roots.push({ root, runtime })
  await runtime.install({ profile, ...(profile === 'school' ? {
    deployment: { formatVersion: 1, modules: ['space-course', 'learning-data'], dependencies: {} },
  } : {}) })
  return { root, endpoint: (await runtime.start()).endpoint! }
}

test.beforeAll(async () => {
  // Replace only the external provider. The product runtime, persistence, conversation projection and tools are real.
  provider = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    if (response.destroyed) return
    const payload = JSON.parse(Buffer.concat(chunks).toString())
    const messages = payload.messages as { role: string; content?: unknown; tool_calls?: { id: string }[] }[]
    const user = messages.filter(message => message.role === 'user').at(-1)
    const turnText = JSON.stringify(user?.content ?? '')
    const allText = JSON.stringify(messages)
    const tools = (payload.tools ?? []).map((tool: { function: { name: string } }) => tool.function.name) as string[]
    providerCalls.push(tools)
    const messageId = id()
    const send = (delta: object, finish_reason: string | null = null) =>
      response.write('data: ' + JSON.stringify({ id: messageId, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n')
    const callTool = (name: string, input: object, callId: string) => {
      send({ role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(input) } }] })
      send({}, 'tool_calls')
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    if (turnText.includes('停止验证')) {
      send({ role: 'assistant', content: '停止前已经生成。这段文字用于确认教师端能在模型尚未完成时显示已保存的正文。' })
      await Promise.race([delay(15_000, undefined, { ref: false }), new Promise(resolve => response.once('close', resolve))])
      if (response.destroyed) return
      send({ content: '停止后不应出现。' })
      send({}, 'stop')
    } else if (readingTools || turnText.includes('目标、要求和公开材料')) {
      readingTools = true
      const calls: [string, object, string][] = [
        ['skill_load', skill, 'teacher-load'], ['skill_read', { ...skill, path: 'references/lesson.md' }, 'teacher-skill-ref'],
        ['read_course_task', {}, 'teacher-task'], ['list_design_materials', {}, 'teacher-list'],
        ['read_design_material', { materialId }, 'teacher-material'],
        ['cite_source', { toolCallId: 'teacher-material', claim: '讲义讨论进位' }, 'teacher-citation'],
      ]
      const next = calls.find(([name, , callId]) => tools.includes(name) && !toolInvocations.has(callId))
      if (next) { toolInvocations.add(next[2]); callTool(...next) }
      else {
        readingTools = false
        send({ role: 'assistant', content: '五项读取完成，讲义讨论进位。' })
        send({}, 'stop')
      }
    } else {
      const reply = turnText.includes('刚才的代号')
        ? allText.includes('琥珀') ? '刚才的代号是琥珀。' : '我没有看到代号。'
        : turnText.includes('下一条普通消息') ? '普通消息已回复。'
          : turnText.includes('验证本人模型') ? `本人模型已回复：${payload.model}。` : '确认代号'
      send({ role: 'assistant', content: reply })
      await delay(300)
      if (reply === '确认代号') send({ content: '琥珀。' })
      send({}, 'stop')
    }
    response.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 80, completion_tokens: 16, total_tokens: 96 } }) + '\n\n')
    response.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve))
  const port = (provider.address() as { port: number }).port
  const schoolRuntime = await startRuntime('school')
  school = schoolRuntime.endpoint
  schoolAdmin = { authorization: 'Bearer ' + await resolveCredential(schoolRuntime.root, 'control') }
  const loginName = 'teacher-chat-browser', password = id()
  teacherIdentity = (await api(school, 'manage/members', { requestId: id(), loginName, password }, schoolAdmin)).body
  await api(school, 'manage/member-permissions', { requestId: id(), principalId: teacherIdentity.principalId,
    permission: 'course.manage', enabled: true }, schoolAdmin)
  const cookie = (await api(school, 'login', { loginName, password })).cookie!
  const text = Buffer.from('ALU 通过进位位检测无符号溢出。')
  for (const [courseId, name] of [[firstCourse, '数字逻辑'], [secondCourse, '计算机组成']] as const) {
    const hasMaterial = courseId === firstCourse
    await api(school, 'manage/course-import', { formatVersion: 1, requestId: id(), course: { courseId, name },
      task: { taskId: hasMaterial ? taskId : id(), title: hasMaterial ? 'ALU 设计' : '课程任务', summary: '' },
      release: { releaseId: hasMaterial ? releaseId : id(), objectives: ['解释进位'], requirements: '设计并验证算术逻辑单元。',
        materials: hasMaterial ? [{ materialId, title: 'ALU 公开讲义', path: 'alu.md', mediaType: 'text/markdown',
          access: 'student', sha256: createHash('sha256').update(text).digest('hex'), byteLength: text.length }] : [],
        starterWorks: [], capabilities: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } },
      resources: hasMaterial ? [{ path: 'alu.md', contentBase64: text.toString('base64') }] : [],
    }, schoolAdmin)
  }
  modelConfig = { requestId: id(), connectionId: id(), expectedVersion: 0, name: '学生端先前配置的本机供应商',
    protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:' + port + '/v1', path: '/chat/completions', modelId: 'teacher-local-model',
    dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 32000, maxOutputTokens: 1024,
    credential: { action: 'replace', value: 'synthetic-teacher-model' },
  }
  device = (await startRuntime('local')).endpoint
  sharedProviderInput = { requestId: id(), providerId: sharedProviderId, expectedVersion: 0,
    name: modelConfig.name, protocol: modelConfig.protocol, baseUrl: modelConfig.baseUrl, enabled: true,
    credential: modelConfig.credential, models: [{ connectionId: modelConfig.connectionId, expectedVersion: 0,
      modelId: modelConfig.modelId, enabled: true, contextWindow: 32000, maxOutputTokens: 1024 }] }
  await api(device, 'models/providers', sharedProviderInput, personalHeaders)
  const pending = (await api(device, 'client/start', { requestId: id(), schoolEndpoint: school })).body
  await api(school, 'connections/approve', { requestId: pending.requestId }, { cookie })
  await api(device, 'client/complete', { requestId: pending.requestId })
  const context = (await api(device, 'context')).body
  teacherHeaders = { 'x-xj-space': context.account.key, 'x-xj-namespace': context.clientNamespace, 'x-xj-teacher-agent': '1',
    'x-xj-expected-subject': [teacherIdentity.environmentId, teacherIdentity.spaceId, teacherIdentity.principalId].join('.') }
  // No school provider is installed. The browser uses the teacher's local connections.
  const empty = (await api(device, 'models/teacher-selection', undefined, teacherHeaders)).body
  expect(empty).toMatchObject({ selected: null, options: [{ connection: { connectionId: modelConfig.connectionId } }] })
  expect((await api(device, 'models/providers', undefined, teacherHeaders)).body).toEqual(
    (await api(device, 'models/providers', undefined, personalHeaders)).body)
  await api(device, 'models/connections', { ...modelConfig, requestId: id(), connectionId: id(),
    name: '教师备用连接', modelId: 'teacher-personal-model' }, teacherHeaders)
  const imported = (await api(device, 'skills/import', { requestId: id(), source: 'local:project-lesson', packageVersion: '1', files: [
    { path: 'SKILL.md', encoding: 'utf8', content: '---\nname: 项目式备课\ndescription: 用证据准备课程\n---\n阅读 references/lesson.md。' },
    { path: 'references/lesson.md', encoding: 'utf8', content: '先列出目标、实践和评价证据。' },
  ] }, teacherHeaders)).body
  skill = { skillId: imported.skillId, version: imported.version }
})

test.afterAll(async () => {
  provider?.closeAllConnections()
  await Promise.all(roots.reverse().map(async ({ root, runtime }) => {
    try { await runtime.stop() } finally { await rm(root, { recursive: true, force: true }) }
  }))
  if (provider?.listening) await new Promise<void>(resolve => provider.close(() => resolve()))
})

const composer = (page: Page) => page.getByRole('textbox', { name: '向教师 Agent 提问' })
const send = async (page: Page, text?: string) => {
  if (text) await composer(page).fill(text)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
}

test('教师工作台使用未登录时配置的本机模型和本机技能', async ({ page }) => {
  await api(device, 'agent-sessions?courseId=' + firstCourse, undefined, { ...teacherHeaders, 'x-xj-agent-contract': '3' })
  await page.goto(device)
  await page.getByRole('button', { name: '工作台', exact: true }).click()
  await page.getByRole('button', { name: /数字逻辑/ }).click()
  await expect(page).toHaveURL(new RegExp(firstCourse))
  await expect(page.getByText('今天想探讨什么？')).toBeVisible()
  await expect(composer(page)).toBeInViewport()
  await expect(page.getByText('当前教师模型不可用。')).toBeVisible()
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await page.getByRole('menuitemradio', { name: /teacher-local-model/ }).click()
  let releaseInput!: () => void
  const pendingResponse = new Promise<void>(resolve => { releaseInput = resolve })
  await page.route('**/agent-sessions/start', async route => {
    await pendingResponse
    await route.continue()
  }, { times: 1 })
  try {
    const firstMessage = '我们把这次讨论的代号定为琥珀，请确认。'
    const request = page.waitForRequest('**/agent-sessions/start')
    await send(page, firstMessage)
    expect((await request).postDataJSON().input.text).toBe(firstMessage)
    await expect(page.locator('.chat-message.user .bubble')).toHaveText(firstMessage)
    await expect(composer(page)).toHaveValue('')
    await expect(page.getByText(/正在发送…|正在准备附件…|原问题已保留。/)).toHaveCount(0)
  } finally { releaseInput() }
  await expect(page.getByText('确认代号琥珀。', { exact: true })).toBeVisible()
  await expect(page.locator('.chat-message.user .bubble')).toHaveCount(1)
  await expect.poll(() => page.locator('.chat-wrap').evaluate(scroll => {
    const main = scroll.closest('.main')!
    return Math.round(main.getBoundingClientRect().right - scroll.getBoundingClientRect().right
      - parseFloat(getComputedStyle(main).borderRightWidth))
  })).toBe(0)
  await send(page, '刚才的代号是什么？')
  await expect(page.getByText('刚才的代号是琥珀。', { exact: true })).toBeVisible()
  await send(page, '停止验证')
  await expect(page.locator('[data-state=streaming]').getByText(/停止前已经生成/)).toBeVisible()
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.locator('[data-state=stopped]').getByText(/停止前已经生成/)).toBeVisible()
  await page.reload()
  await expect(page.getByText('刚才的代号是琥珀。', { exact: true })).toHaveCount(1)
  await expect(page.getByText('停止后不应出现。', { exact: true })).toHaveCount(0)

  await page.getByRole('tab', { name: '任务设计' }).click()
  await page.getByRole('button', { name: '和 Agent 讨论ALU 设计' }).click()
  await expect(page.getByText(/本条消息参考发布任务/)).toBeVisible()
  await page.getByRole('button', { name: '选择技能' }).click()
  await page.getByRole('option', { name: /项目式备课/ }).click()
  const received = page.waitForRequest(request => /\/agent-sessions\/[^/]+\/inputs$/.test(request.url()) && request.method() === 'POST')
  await send(page)
  expect((await received).postDataJSON().context).toEqual({
    teacherTarget: { kind: 'release', taskId, releaseId }, teacherSkill: { skillId: skill.skillId, version: skill.version },
  })
  const session = (await api(device, 'agent-sessions?courseId=' + firstCourse, undefined, {
    ...teacherHeaders, 'x-xj-agent-contract': '3',
  })).body.items[0]
  const readHistory = async () => (await api(device, `agent-sessions/${session.sessionId}/conversation`, undefined, {
    ...teacherHeaders, 'x-xj-agent-contract': '3',
  })).body
  await expect.poll(async () => {
    const turn = (await readHistory()).turns.at(-1)
    return turn?.state === 'failed' ? 'failed: ' + turn.reason : turn?.state
  }, { timeout: 25_000 }).toBe('completed')
  const history = await readHistory()
  const tools = Object.fromEntries(history.tools.map((tool: { name: string; result: { data?: unknown; outcome?: string } }) => [tool.name, tool.result]))
  for (const name of ['skill_load', 'skill_read', 'read_course_task', 'list_design_materials', 'read_design_material'])
    expect(tools[name]?.outcome, name + ' · ' + [...toolInvocations].join(', ')).toBe('success')
  expect(tools.read_design_material.data.text).toContain('无符号溢出')
  expect(history.citations).toHaveLength(1)
  await expect(page.getByText('五项读取完成，讲义讨论进位。', { exact: true })).toBeVisible()
  const trace = page.getByRole('button', { name: /思考与执行/ }).last()
  if (await trace.getAttribute('aria-expanded') === 'false') await trace.click()
  await expect(page.getByText('阅读公开材料 · ALU 公开讲义', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: /讲义讨论进位/ }).click()
  await expect(page.getByRole('region', { name: 'ALU 公开讲义' }).getByText(/无符号溢出/)).toBeVisible()
  await page.getByRole('button', { name: '返回对话' }).click()

  const callCount = providerCalls.length
  await send(page, '下一条普通消息')
  await expect(page.getByText('普通消息已回复。', { exact: true })).toBeVisible()
  expect(providerCalls.slice(callCount).flat()).not.toContain('skill_load')

  // Drop the response after the school commits the input. Reload must query the original receipt.
  const inputRoute = /\/agent-sessions\/[^/]+\/inputs$/
  await page.route(inputRoute, async route => {
    expect((await route.fetch()).status()).toBe(200)
    await route.abort()
  }, { times: 1 })
  const disconnected = page.waitForEvent('requestfailed', request => inputRoute.test(request.url()))
  await send(page, '核对丢失回执')
  await disconnected
  await page.reload()
  await expect(page.getByText('核对丢失回执', { exact: true })).toHaveCount(1)
  await expect(composer(page)).toHaveValue('')
  expect((await readHistory()).inputs.filter((input: { text: string }) => input.text === '核对丢失回执')).toHaveLength(1)

  await page.getByRole('button', { name: '切换课程，当前数字逻辑' }).click()
  await page.getByRole('menuitemradio', { name: /计算机组成/ }).click()
  await expect(page.getByText('今天想探讨什么？')).toBeVisible()
  await expect(page.getByText('刚才的代号是琥珀。', { exact: true })).toHaveCount(0)
  await api(device, 'agent-sessions?courseId=' + forbiddenCourse, undefined,
    { ...teacherHeaders, 'x-xj-agent-contract': '3' }, 403)
  await page.getByRole('button', { name: '切换课程，当前计算机组成' }).click()
  await page.getByRole('menuitemradio', { name: /数字逻辑/ }).click()
  await expect(page.getByText('刚才的代号是琥珀。', { exact: true })).toBeVisible()

  const { 'x-xj-teacher-agent': _teacher, ...studentHeaders } = teacherHeaders
  const studentSelection = (await api(device, 'models/selection', undefined, studentHeaders)).body
  await page.getByRole('button', { name: '切换模型', exact: true }).click()
  await page.getByRole('menuitemradio', { name: /teacher-personal-model/ }).click()
  await expect.poll(async () => (await api(device, 'models/teacher-selection', undefined, teacherHeaders)).body.selected?.kind).toBe('personal')
  expect((await api(device, 'models/selection', undefined, studentHeaders)).body).toEqual(studentSelection)
  const saved = (await api(device, 'models/teacher-selection', undefined, teacherHeaders)).body.selected.connection
  await api(device, 'models/connections', { ...modelConfig, requestId: id(), connectionId: saved.connectionId,
    expectedVersion: saved.version, enabled: false, name: saved.name, modelId: saved.modelId,
    credential: { action: 'keep' },
  }, teacherHeaders)
  await page.reload()
  await expect(page.getByText('当前教师模型不可用。')).toBeVisible()
  await expect(page.getByText('刚才的代号是琥珀。', { exact: true })).toBeVisible()
  await composer(page).fill('保留这条草稿')
  await expect(page.getByRole('button', { name: '发送消息', exact: true })).toBeDisabled()
  await api(school, 'manage/member-permissions', { requestId: id(), principalId: teacherIdentity.principalId,
    permission: 'course.manage', enabled: false }, schoolAdmin)
  await api(device, 'agent-sessions?courseId=' + firstCourse, undefined,
    { ...teacherHeaders, 'x-xj-agent-contract': '3' }, 403)
})

test('一体化学校运行时使用教师本人的已选模型生成回答', async () => {
  const { root, endpoint } = await startRuntime('local')
  const admin = { authorization: 'Bearer ' + await resolveCredential(root, 'control') }
  const password = id(), loginName = 'teacher-personal-model'
  const identity = (await api(endpoint, 'manage/members', { requestId: id(), loginName, password }, admin)).body
  await api(endpoint, 'manage/member-permissions', { requestId: id(), principalId: identity.principalId,
    permission: 'course.manage', enabled: true }, admin)
  const cookie = (await api(endpoint, 'login', { loginName, password })).cookie!
  const courseId = id()
  await api(endpoint, 'manage/course-import', { formatVersion: 1, requestId: id(), course: { courseId, name: '模型联调课程' },
    task: { taskId: id(), title: '验证模型', summary: '' },
    release: { releaseId: id(), objectives: ['解释课堂示例'], requirements: '完成课堂示例。',
      materials: [], starterWorks: [], capabilities: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' } },
    resources: [],
  }, admin)
  await writeFile(join(root, 'teacher-chat.json'), JSON.stringify({
    grants: [{ spaceId: identity.spaceId, principalId: identity.principalId, courseId }],
    budget: { maxSteps: 8, maxToolCalls: 8, maxInputTokens: 96000, maxOutputTokens: 8000, maxCallMs: 25000, hardDeadlineMs: 60000 },
  }), { mode: 0o600 })
  const headers = { cookie, 'x-xj-space': 'school', 'x-xj-agent-contract': '3', 'x-xj-teacher-agent': '1' }
  const connectionId = id(), modelId = 'teacher-personal-fixture'
  await api(endpoint, 'models/connections', { ...modelConfig, requestId: id(), connectionId, modelId }, headers)
  await api(endpoint, 'models/teacher-selection', {
    requestId: id(), expectedVersion: 0, source: { kind: 'personal', owner: 'self', connectionId },
  }, headers)
  const sessionId = id()
  await api(endpoint, 'agent-sessions', { requestId: id(), sessionId, scenario: 'teacher-assistant', courseId }, headers)
  await api(endpoint, `agent-sessions/${sessionId}/inputs`, { requestId: id(), sessionId, text: '验证本人模型', context: {} }, headers)
  await expect.poll(async () => {
    const result = (await api(endpoint, `agent-sessions/${sessionId}/conversation`, undefined, headers)).body
    return result.messages.find((message: { role: string; state: string }) => message.role === 'assistant' && message.state === 'settled')?.text
  }).toBe(`本人模型已回复：${modelId}。`)
})

test('跨账号及解绑后共用本机供应商并各自保存模型选择', async () => {
  const bound = (await api(device, 'context')).body.account.key as string
  await api(device, 'connections/revoke', { connectionId: bound.slice('school:'.length) }, { 'x-xj-space': bound })
  expect((await api(device, 'context')).body.account).toBeNull()
  const unbound = (await api(device, 'models/providers', undefined, personalHeaders)).body
  expect(unbound.map((provider: { name: string }) => provider.name)).toContain('教师备用连接')

  const loginName = 'shared-model-second-account', password = id()
  await api(school, 'manage/members', { requestId: id(), loginName, password }, schoolAdmin)
  const cookie = (await api(school, 'login', { loginName, password })).cookie!
  const pending = (await api(device, 'client/start', { requestId: id(), schoolEndpoint: school })).body
  await api(school, 'connections/approve', { requestId: pending.requestId }, { cookie })
  await api(device, 'client/complete', { requestId: pending.requestId })
  const headers = { 'x-xj-space': (await api(device, 'context')).body.account.key }
  expect((await api(device, 'models/providers', undefined, headers)).body).toEqual(unbound)
  const ownSelection = (await api(device, 'models/selection', undefined, personalHeaders)).body

  const edited = (await api(device, 'models/providers', { ...sharedProviderInput, requestId: id(),
    expectedVersion: 1, name: '从第二个账号编辑的本机供应商', credential: { action: 'keep' },
    models: [{ ...(sharedProviderInput.models as Record<string, unknown>[])[0], expectedVersion: 1 }],
  }, headers)).body
  expect(edited).toMatchObject({ providerId: sharedProviderId, version: 2, hasCredential: true })
  expect((await api(device, 'models/providers', undefined, personalHeaders)).body).toContainEqual(edited)
  const choice = (await api(device, 'models/selection', {
    requestId: id(), expectedVersion: 0, source: { kind: 'personal', owner: 'self', connectionId: modelConfig.connectionId },
  }, headers)).body
  expect(choice.selected.connection.connectionId).toBe(modelConfig.connectionId)
  const personalAfter = (await api(device, 'models/selection', undefined, personalHeaders)).body
  expect(personalAfter).toMatchObject({ version: ownSelection.version, selected: ownSelection.selected })
  const attemptId = id()
  await api(device, 'models/checks', { attemptId, purpose: 'connection-check',
    source: { connectionId: modelConfig.connectionId, version: edited.models[0].version },
    limits: { maxOutputTokens: 64, timeoutMs: 10000 },
  }, headers)
  await api(device, 'models/checks/' + attemptId + '/dispatch', {}, headers)
  await expect.poll(async () => (await api(device, 'models/checks/' + attemptId, undefined, headers)).body.state).toBe('completed')
})
