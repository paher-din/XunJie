import { test, expect } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createProductLearningApplication, createProductRuntimeHost, openProductRuntime, resolveCredential } from '@xunjie/product-runtime'
import { accumulatorPackage } from '../../../components/state-accumulator/package.mjs'
import { aggregationPackage } from '../../../components/table-aggregation/package.mjs'
import type { ExecutionQuery } from '@xunjie/contracts/execution'
import { componentStateName } from '@xunjie/contracts/components'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
const sessionHelper = process.env.XUNJIE_NATIVE_SESSION_HELPER
test.skip(!postgresBin, 'Requires native PostgreSQL 18.6')
test.use({ trace: 'off' })
const evidence = process.env.XUNJIE_TEACHING_TOOLS_EVIDENCE
  ?? fileURLToPath(new URL('../../../docs/student-agent-implementation/evidence/wp07-198', import.meta.url))
let runtime: ReturnType<typeof openProductRuntime>
let host: Awaited<ReturnType<typeof createProductRuntimeHost>>
let root = '', endpoint = ''
let upstream: ReturnType<typeof createServer>
let answer: (payload: ModelPayload, response: ServerResponse) => Promise<void> | void
const modelErrors: string[] = []
const exec = promisify(execFile)
interface ModelPayload { messages: { role: string; content?: string; tool_call_id?: string }[] }

function signal() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

function reply(response: ServerResponse, value: { text: string } | { call: { id: string; name: string; arguments: unknown } }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const delta = 'text' in value ? { role: 'assistant', content: value.text }
    : { role: 'assistant', tool_calls: [{ index: 0, id: value.call.id, type: 'function',
      function: { name: value.call.name, arguments: JSON.stringify(value.call.arguments) } }] }
  for (const chunk of [
    { id: 'tools-ui', choices: [{ index: 0, delta, finish_reason: null }] },
    { id: 'tools-ui', choices: [{ index: 0, delta: {}, finish_reason: 'call' in value ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } },
  ]) response.write('data: ' + JSON.stringify(chunk) + '\n\n')
  response.end('data: [DONE]\n\n')
}

async function api(request: import('@playwright/test').APIRequestContext, route: string, body?: unknown,
  headers: Record<string, string> = { 'x-xj-space': 'personal' }) {
  const response = await request.fetch(endpoint + '/api/learning/' + route, {
    method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { data: body }),
  })
  const value = await response.json()
  expect(response.status(), route + ': ' + JSON.stringify(value)).toBe(200)
  return value
}

async function configureModel(request: import('@playwright/test').APIRequestContext,
  headers: Record<string, string> = { 'x-xj-space': 'personal' }) {
  const connectionId = randomUUID(), grantId = randomUUID()
  const port = (upstream.address() as { port: number }).port
  await api(request, 'models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0,
    name: '工具往返时序', protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${port}/v1`, path: '/chat/completions',
    modelId: 'fixture-tools-ui', dialect: 'standard', parameterMode: 'plain', enabled: true,
    contextWindow: 262144, maxOutputTokens: 8192, credential: { action: 'replace', value: 'synthetic-tools-ui-key' } }, headers)
  await api(request, 'models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' }, headers)
  const selection = await api(request, 'models/selection', undefined, headers)
  await api(request, 'models/selection', { requestId: randomUUID(), expectedVersion: selection.version,
    source: { kind: 'personal', connectionId, grantId } }, headers)
}

test.beforeAll(async () => {
  await mkdir(evidence, { recursive: true })
  upstream = createServer(async (request, response) => {
    try {
      const chunks = []
      for await (const chunk of request) chunks.push(chunk)
      await answer(JSON.parse(Buffer.concat(chunks).toString()), response)
    } catch (error) { modelErrors.push(String(error)); response.destroy() }
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  root = await mkdtemp(join(tmpdir(), 'xj-teaching-tools-ui-'))
  const sessionHelperSha256 = sessionHelper ? createHash('sha256').update(await readFile(sessionHelper)).digest('hex') : undefined
  runtime = openProductRuntime({ root, resources: {
    nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
    webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)),
    windowsSessionHelper: sessionHelper, windowsSessionHelperSha256: sessionHelperSha256,
  } })
  await runtime.install({ profile: 'local' })
  host = await createProductRuntimeHost({ root, createApplication: context => createProductLearningApplication(context) })
  endpoint = host.endpoint
})

test.afterAll(async () => {
  let failure: unknown
  try { await host?.stop(); await runtime?.stop() }
  catch (error) { failure = error }
  finally {
    upstream?.closeAllConnections()
    if (upstream) await new Promise<void>(resolve => upstream.close(() => resolve()))
    // A failed maintenance assertion remains a test failure. Only this mkdtemp fixture's
    // database is stopped here, so a failing test cannot leave PostgreSQL running afterward.
    if (failure && root && postgresBin) await exec(join(postgresBin, process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl'),
      ['stop', '-D', join(root, 'pgdata'), '-m', 'fast', '-w', '-t', '30']).catch(() => {})
    if (root) await rm(root, { recursive: true, force: true })
  }
  if (failure) throw failure
})

test.afterEach(async ({ page }, info) => {
  if (info.status === info.expectedStatus) return
  const url = new URL(page.url())
  const activityId = url.searchParams.get('activity')
  if (!activityId) return
  const response = await page.request.get(endpoint + '/api/learning/agent/' + activityId + '/conversation', {
    headers: { 'x-xj-space': url.searchParams.get('space') ?? 'personal' },
  }).catch(() => null)
  if (response?.ok()) await info.attach('persisted-conversation', { body: await response.body(), contentType: 'application/json' })
})

test('the formal conversation shows the real fixed work read and retains it after editing and reload', async ({ page, request }) => {
  test.skip(process.env.XUNJIE_CAPTURE_TEACHING_BASELINE === '1', 'Capture the unchanged baseline alone')
  const work = { objectId: randomUUID(), contentId: randomUUID(), name: '观察记录.txt', kind: 'text', encoding: 'utf8',
    mediaType: 'text/plain', value: '固定观察：总数为 37。' }
  let calls = 0
  const dispatched = signal(), release = signal()
  answer = async (payload, response) => {
    calls++
    if (calls === 1) {
      dispatched.resolve()
      await release.promise
      reply(response, { call: { id: 'read-fixed-observation', name: 'read_work',
        arguments: { objectId: work.objectId, contentId: work.contentId } } })
    } else {
      const feedback = payload.messages.find(message => message.role === 'tool')
      expect(feedback?.tool_call_id).toBe('read-fixed-observation')
      expect(feedback?.content).toContain('37')
      expect(feedback?.content).not.toContain('999')
      reply(response, { text: '读取固定观察后，可依据其中的总数 37 解释；编辑后的 999 属于另一个版本。' })
    }
  }
  await configureModel(request)
  const activity = await api(request, 'activities', { requestId: randomUUID(), goal: '核对固定作品来源', question: '', references: [] })
  await api(request, 'workspaces/' + activity.activityId, { requestId: randomUUID(), baseRevision: 0, files: [work] })
  await page.goto(endpoint + '/?space=personal&activity=' + activity.activityId)
  await expect(page.locator('#activity-title')).toHaveText('核对固定作品来源')
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await page.getByLabel('你的问题', { exact: true }).fill('请读取本次固定作品，并解释总数。')
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  try {
    await dispatched.promise
    await api(request, 'workspaces/' + activity.activityId, { requestId: randomUUID(), baseRevision: 1,
      files: [{ ...work, contentId: randomUUID(), value: '后续观察：总数改为 999。' }] })
  } finally { release.resolve() }
  const record = page.locator('.teaching-tool-record').filter({ hasText: '观察记录.txt' })
  await expect(record.locator('.teaching-tool-status')).toHaveText('已完成', { timeout: 25000 })
  await record.locator(':scope > summary').click()
  await record.getByText('实际结果', { exact: true }).click()
  await expect(record.locator('.teaching-tool-data').last()).toContainText('固定观察：总数为 37。')
  await expect(record.locator('.teaching-tool-data').last()).not.toContainText('999')
  await expect(record.locator('.teaching-tool-source')).toContainText('观察记录.txt')
  await expect(record.getByRole('button', { name: '定位来源', exact: true })).toBeVisible()
  await expect(page.locator('.teaching-message.assistant')).toContainText('总数 37')
  await record.scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(evidence, `tools-read-after-${process.platform}.png`) })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.setViewportSize({ width: 900, height: 900 })
  await record.scrollIntoViewIfNeeded()
  await expect(record).toBeInViewport()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: join(evidence, `tools-read-dark-narrow-${process.platform}.png`) })
  await page.reload()
  await expect(page.locator('#activity-title')).toHaveText('核对固定作品来源')
  const reopen = page.getByRole('button', { name: '打开对话', exact: true })
  await reopen.click()
  await expect(page.locator('.teaching-tool-status')).toHaveText('已完成', { timeout: 20000 })
  expect(calls).toBe(2)
  expect(modelErrors).toEqual([])
})

test('capture the existing formal conversation baseline before UI changes', async ({ page }) => {
  test.skip(process.env.XUNJIE_CAPTURE_TEACHING_BASELINE !== '1', 'Opt-in baseline capture before editing the UI')
  await page.goto(endpoint)
  await page.getByLabel('学习目标', { exact: true }).fill('读取作品并解释课程工具结果')
  await page.getByLabel('起始问题', { exact: true }).fill('请根据固定的表格解释聚合结果。')
  await page.getByRole('button', { name: '建立并开始对话', exact: true }).click()
  await expect(page.locator('#activity-title')).toHaveText('读取作品并解释课程工具结果')
  await expect(page.getByText('尚未选择模型，问题与草稿已保留。')).toBeVisible({ timeout: 20000 })
  await page.screenshot({ path: join(evidence, `tools-before-${process.platform}.png`) })
})

test('real native and browser operations retain results; a disconnected browser waits and can be stopped', async ({ page, context, browser }) => {
  test.setTimeout(120000)
  test.skip(process.env.XUNJIE_CAPTURE_TEACHING_BASELINE === '1', 'Capture the unchanged baseline alone')
  const admin = { authorization: 'Bearer ' + await resolveCredential(root, 'control') }
  const native = await api(page.request, 'manage/component-import', { requestId: randomUUID(),
    ...await accumulatorPackage({ version: 1 }) }, admin)
  const table = await api(page.request, 'manage/component-import', { requestId: randomUUID(), ...await aggregationPackage() }, admin)
  const courseId = randomUUID(), taskId = randomUUID(), releaseId = randomUUID()
  await api(page.request, 'manage/course-import', { formatVersion: 1, requestId: randomUUID(),
    course: { courseId, name: '真实工具往返' }, task: { taskId, title: '观察固定输入与真实结果', summary: '' },
    release: { releaseId, objectives: ['核对实际状态与等待'], requirements: '连续输入 1、2、2，核对状态 1、3、1。',
      materials: [], starterWorks: [], capabilities: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
      components: [
        { key: 'counter', definition: native, configuration: { title: '四态累加模拟' }, materialIds: [] },
        { key: 'table', definition: table, configuration: { title: '表格聚合' }, materialIds: [] },
      ] }, resources: [] }, admin)
  const loginName = 'tools-chrome-' + randomUUID(), password = randomUUID()
  const member = await api(page.request, 'manage/members', { requestId: randomUUID(), loginName, password }, admin)
  await api(page.request, 'manage/course-access', { requestId: randomUUID(), courseId, principalId: member.principalId, active: true }, admin)
  await api(page.request, 'login', { loginName, password }, {})
  const activity = await api(page.request, 'course-activities', { requestId: randomUUID(), releaseId }, {})
  await configureModel(page.request, {})
  const states: number[] = []
  let calls = 0
  answer = (payload, response) => {
    calls++
    if (calls === 1) {
      reply(response, { call: { id: 'start-real-session', name: 'course_operation',
        arguments: { componentKey: 'counter', operationId: 'start_session', parameters: {} } } })
      return
    }
    const feedback = payload.messages.filter(message => message.role === 'tool').at(-1)
    const result = JSON.parse(feedback?.content ?? '{}') as { query: ExecutionQuery }
    expect(result.query.session).toBeTruthy()
    const observation = result.query.session!.observation as { value: number }
    states.push(observation.value)
    expect(observation.value).toBe([0, 1, 3, 1][states.length - 1])
    if (states.length < 4) reply(response, { call: { id: 'advance-' + states.length, name: 'course_operation',
      arguments: { componentKey: 'counter', operationId: 'advance', requestId: result.query.requestId,
        expectedSeq: result.query.session!.appliedSeq, parameters: { value: [1, 2, 2][states.length - 1] } } } })
    else reply(response, { text: '原生会话已按固定输入推进，实际状态依次为 1、3、1。' })
  }
  await page.goto(endpoint + '/?space=school&activity=' + activity.activityId)
  await expect(page.locator('#activity-title')).toHaveText('观察固定输入与真实结果')
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await page.getByLabel('你的问题', { exact: true }).fill('请启动四态累加模拟，依次输入 1、2、2，并解释真实状态。')
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(page.locator('.teaching-message.assistant')).toContainText('实际状态依次为 1、3、1', { timeout: 30000 })
    .catch(async error => { throw new Error(error.message + '\n' + JSON.stringify({ modelErrors,
      conversation: await api(page.request, 'agent/' + activity.activityId + '/conversation', undefined, {}) })) })
  await expect(page.locator('.teaching-tool-record')).toHaveCount(4)
  const last = page.locator('.teaching-tool-record').last()
  await last.locator(':scope > summary').click()
  await last.getByText('参数', { exact: true }).click()
  await expect(last.locator('.teaching-tool-data')).toContainText('数值2')
  await last.getByRole('button', { name: '定位原结果', exact: true }).click()
  await expect(page.locator('.native-session-observation strong')).toHaveText('1', { timeout: 20000 })
  await expect(page.frameLocator('.component-view iframe').getByText('组件已就绪')).toBeVisible()
  await page.screenshot({ path: join(evidence, `tools-native-after-${process.platform}.png`) })
  const previous = page.locator('.teaching-tool-record').nth(2)
  await previous.locator(':scope > summary').click()
  await previous.getByRole('button', { name: '定位原结果', exact: true }).click()
  const previousObservation = page.getByRole('list', { name: '已确认观察' }).getByRole('listitem').filter({ hasText: '第 2 次' })
  await expect(previousObservation).toContainText('状态 3')
  await expect(previousObservation).toBeFocused()
  await page.reload()
  await expect(page.locator('#activity-title')).toHaveText('观察固定输入与真实结果')
  const reopen = page.getByRole('button', { name: '打开对话', exact: true })
  await reopen.click()
  await page.getByRole('tab', { name: '四态累加模拟', exact: true }).click()
  await expect(page.locator('.native-session-observation strong')).toHaveText('1')
  await expect(page.locator('.native-session-history li')).toHaveCount(3)
  expect(states).toEqual([0, 1, 3, 1])
  expect(calls).toBe(5)

  await page.getByRole('tab', { name: '表格聚合', exact: true }).click()
  const tableView = page.frameLocator('.component-view iframe')
  await tableView.getByLabel('得分 第1行', { exact: true }).fill('89')
  await tableView.getByLabel('得分 第1行', { exact: true }).fill('88')
  await expect.poll(async () => {
    const work = await api(page.request, 'workspaces/' + activity.activityId, undefined, {})
    const file = work.files.find((item: { name: string }) => item.name === componentStateName('table'))
    return file ? (JSON.parse(file.value).content.table.rows[0][2] as string) : null
  }).toBe('88')
  let finiteCalls = 0
  answer = (payload, response) => {
    finiteCalls++
    if (finiteCalls === 1) reply(response, { call: { id: 'real-browser-aggregation', name: 'course_operation',
      arguments: { componentKey: 'table', operationId: 'aggregate',
        parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } } })
    else {
      expect(JSON.stringify(payload)).toContain('83.33333333333333')
      reply(response, { text: '已读取真实聚合结果，12 行数据分成 3 组，总平均分约为 83.33。' })
    }
  }
  await page.getByLabel('你的问题', { exact: true }).fill('请按固定表格按小组计算得分平均值，并解释实际结果。')
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  await expect(page.locator('.teaching-message.assistant').last()).toContainText('已读取真实聚合结果', { timeout: 30000 })
  const calculation = page.locator('.teaching-tool-record').last()
  await expect(calculation.locator('.teaching-tool-status')).toHaveText('已完成')
  await calculation.locator(':scope > summary').click()
  await calculation.getByText('实际结果', { exact: true }).click()
  await expect(calculation.locator('.teaching-tool-data')).toContainText('83.33333333333333')
  await calculation.getByRole('button', { name: '定位原结果', exact: true }).click()
  await expect(page.locator('.execution-panel')).toContainText('总计 83.333333，共 3 组。')
  await page.screenshot({ path: join(evidence, `tools-browser-result-${process.platform}.png`) })
  expect(finiteCalls).toBe(2)

  // Drop the actual acceptance response after the production owner commits it. No tool
  // result is substituted: the original broker must stop its durable, unstarted command.
  const lostAcceptance = signal()
  const acceptRoute = '**/executions/**/agent/*/accept'
  await page.route(acceptRoute, async route => {
    const actual = await route.fetch()
    expect(actual.status()).toBe(200)
    await route.abort('connectionreset')
    lostAcceptance.resolve()
  })
  let lostCalls = 0
  answer = (_payload, response) => {
    lostCalls++
    reply(response, { call: { id: 'lost-acceptance', name: 'course_operation', arguments: {
      componentKey: 'table', operationId: 'aggregate', parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' },
    } } })
  }
  await page.getByLabel('你的问题', { exact: true }).fill('核对接收回包丢失后的原计算，不要换身份重跑。')
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  await lostAcceptance.promise
  await expect(page.getByText('等待浏览器连接或操作结果…', { exact: true })).toBeVisible({ timeout: 20000 })
  const lostCommand = (await api(page.request, 'agent/' + activity.activityId + '/conversation', undefined, {})).tools.at(-1).commandId
  await page.getByRole('region', { name: '与 Agent 的对话' }).getByRole('button', { name: '停止', exact: true }).click()
  await expect(page.getByText('回答已停止，已发生的内容仍保留。')).toBeVisible({ timeout: 20000 })
  await page.unroute(acceptRoute)
  await expect.poll(async () => (await api(page.request, `executions/${activity.activityId}/${lostCommand}`, undefined, {}))?.state)
    .toBe('cancelled')
  await expect(page.locator('.teaching-tool-record').last().locator('.teaching-tool-status')).toHaveText('已取消')
  expect(lostCalls).toBe(1)
  await page.reload()
  await expect(page.locator('#activity-title')).toHaveText('观察固定输入与真实结果')
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await page.getByRole('tab', { name: '表格聚合', exact: true }).click()
  await expect(page.locator('.execution-records > li')).toHaveCount(2)
  await expect(page.locator('.execution-records > li').first()).toContainText('已取消')
  await page.screenshot({ path: join(evidence, `tools-lost-acceptance-stopped-${process.platform}.png`) })

  // Lose the real claim response after it commits, then disconnect before local acceptance.
  // A new browser profile must query the original record, never claim another node's task.
  let browserCalls = 0
  answer = (_payload, response) => {
    browserCalls++
    if (browserCalls === 1) reply(response, { call: { id: 'wait-for-original-browser', name: 'course_operation',
      arguments: { componentKey: 'table', operationId: 'aggregate',
        parameters: { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' } } } })
    else reply(response, { text: '浏览器已接受任务；计算结果尚未到达。' })
  }
  await page.getByLabel('你的问题', { exact: true }).fill('请按固定表格按小组计算得分平均值。')
  const disconnected = signal()
  await page.route('**/executions/**/agent/*/claim', async route => {
    const actual = await route.fetch()
    expect(actual.status()).toBe(200)
    await route.abort('connectionreset')
    await page.close()
    disconnected.resolve()
  })
  await page.getByRole('button', { name: '发送问题', exact: true }).click()
  await disconnected.promise
  const otherProfile = await browser.newContext()
  try {
    await otherProfile.addCookies(await context.cookies())
    const waitingPage = await otherProfile.newPage()
    await waitingPage.goto(endpoint + '/?space=school&activity=' + activity.activityId)
    await expect(waitingPage.locator('#activity-title')).toHaveText('观察固定输入与真实结果')
    await waitingPage.getByRole('button', { name: '打开对话', exact: true }).click()
    const waiting = waitingPage.getByText('等待浏览器连接或操作结果…', { exact: true })
    await expect(waiting).toBeVisible({ timeout: 25000 })
    await expect(waitingPage.locator('.teaching-tool-record').last().locator('.teaching-tool-status'))
      .toHaveText(/已接受，等待结果|效果未知/)
    await waitingPage.getByLabel('你的问题', { exact: true }).fill('等待期间继续保留的新问题。')
    await expect(waitingPage.getByRole('button', { name: '补充当前任务', exact: true })).toBeEnabled()
    await expect.poll(async () => (await api(waitingPage.request, 'drafts/' + activity.activityId, undefined, {})).question)
      .toBe('等待期间继续保留的新问题。')
    await waiting.scrollIntoViewIfNeeded()
    await waitingPage.screenshot({ path: join(evidence, `tools-waiting-after-${process.platform}.png`) })
    await waitingPage.reload()
    await expect(waitingPage.locator('#activity-title')).toHaveText('观察固定输入与真实结果')
    await waitingPage.getByRole('button', { name: '打开对话', exact: true }).click()
    await expect(waiting).toBeVisible({ timeout: 20000 })
    await expect(waitingPage.getByLabel('你的问题', { exact: true })).toHaveValue('等待期间继续保留的新问题。')
    await waitingPage.getByRole('region', { name: '与 Agent 的对话' }).getByRole('button', { name: '停止', exact: true }).click()
    await expect(waitingPage.getByText('回答已停止，已发生的内容仍保留。')).toBeVisible({ timeout: 20000 })
    await expect(waitingPage.getByLabel('你的问题', { exact: true })).toHaveValue('等待期间继续保留的新问题。')
    await expect(waitingPage.getByRole('button', { name: '发送问题', exact: true })).toBeEnabled()
    await waitingPage.screenshot({ path: join(evidence, `tools-wait-stopped-${process.platform}.png`) })
  } finally { await otherProfile.close() }
  expect(browserCalls).toBeLessThanOrEqual(2)
  expect(modelErrors).toEqual([])
})
