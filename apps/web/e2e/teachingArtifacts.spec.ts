import { evidenceDirectory, evidencePath } from './evidence'
import { test, expect, type Page } from '@playwright/test'
import { randomUUID, randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer, type ServerResponse } from 'node:http'
import { openProductRuntime, createProductRuntimeHost, createProductLearningApplication, resolveCredential, restoreProductRecovery } from '@xunjie/product-runtime'
import { aluPackage, aluCoursePackage } from '../../../components/alu-experiment/package.mjs'
import { selectProductSpace } from './support/product-ui'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires the native PostgreSQL distribution')
test.use({ trace: 'off', viewport: { width: 1440, height: 1000 } })
let root = '', endpoint = ''
let runtime: ReturnType<typeof openProductRuntime>
let host: Awaited<ReturnType<typeof createProductRuntimeHost>>
let upstream: ReturnType<typeof createServer>, modelCalls = 0
let modelHandler: (body: Record<string, any>, response: ServerResponse, index: number) => void = (_body, response) => modelReply(response, '内容已经保留。')
function modelReply(response: ServerResponse, value: string | { name: string; arguments: unknown }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const delta = typeof value === 'string' ? { role: 'assistant', content: value } : { role: 'assistant', tool_calls: [{ index: 0, id: 'artifact-call', type: 'function',
    function: { name: value.name, arguments: JSON.stringify(value.arguments) } }] }
  response.write('data: ' + JSON.stringify({ id: 'artifact-ui', choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n')
  response.write('data: ' + JSON.stringify({ id: 'artifact-ui', choices: [{ index: 0, delta: {}, finish_reason: typeof value === 'string' ? 'stop' : 'tool_calls' }] }) + '\n\n')
  response.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 30, total_tokens: 50 } }) + '\n\n')
  response.end('data: [DONE]\n\n')
}
test.beforeAll(async () => {
  upstream = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString())
    modelHandler(body, response, ++modelCalls)
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  root = await mkdtemp(join(tmpdir(), 'xj-artifacts-'))
  runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin,
    postgresVersion: '18.6', webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } })
  await runtime.install({ profile: 'local' })
  host = await createProductRuntimeHost({ root, createApplication: context => createProductLearningApplication(context) })
  endpoint = host.endpoint
})
test.afterAll(async () => {
  await host?.stop(); await runtime?.stop()
  upstream?.closeAllConnections(); if (upstream) await new Promise<void>(resolve => upstream.close(() => resolve()))
  if (root) await rm(root, { recursive: true, force: true })
})

async function activity(page: Page, firstQuestion = '探索自己的解释') {
  await page.goto(endpoint)
  await selectProductSpace(page, '个人空间')
  await page.getByRole('button', { name: 'Agent 对话', exact: true }).click()
  await page.getByLabel('向 Agent 提问', { exact: true }).fill(firstQuestion)
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.product-conversation-head h1')).toHaveText(firstQuestion)
  await page.getByRole('button', { name: '进入工作区', exact: true }).click()
  await expect(page.locator('#activity-title')).toHaveText(firstQuestion)
  // Keep the conversation collapsed initially, as in the original activity setup.
  await page.getByRole('button', { name: '收起对话', exact: true }).click()
  return new URL(page.url()).searchParams.get('activity')!
}
function payload(title = '比较学习卡') {
  return { formatVersion: 1, title, display: 'card', hostApiVersion: 1,
    html: '<h2>比较两个解释</h2><label>我的解释<textarea aria-label="我的解释"></textarea></label>',
    css: 'body{padding:16px}textarea{display:block;width:90%;min-height:100px}',
    javascript: '(async()=>{const s=await window.xunjie.read();let state=s.content;const input=document.querySelector("textarea");input.value=state.answer;input.addEventListener("input",()=>{state={...state,answer:input.value};window.xunjie.change(state).catch(()=>{});});})();',
    stateVersion: 1, stateShape: { type: 'object', properties: { answer: { type: 'string', maxLength: 4000 } } },
    initialState: { answer: '' }, semanticFields: [{ key: 'answer', meaning: '学生自己的解释' }], semanticObjects: [],
    requiredCapabilities: ['workspace.read', 'workspace.change'] }
}
async function publish(page: Page, id: string, extra = {}) {
  const response = await page.request.post(endpoint + '/api/learning/artifacts/' + id, { headers: { 'x-xj-space': 'personal' }, data: { requestId: randomUUID(), payload: payload(), ...extra } })
  expect(response.status()).toBe(200)
  return response.json()
}
async function api(page: Page, route: string, data?: unknown, space = 'personal') {
  const response = await page.request.fetch(endpoint + '/api/learning/' + route, { method: data === undefined ? 'GET' : 'POST',
    headers: { 'x-xj-space': space }, ...(data === undefined ? {} : { data }) })
  const value = await response.json()
  expect(response.status(), route + ': ' + JSON.stringify(value)).toBe(200)
  return value
}
async function model(page: Page) {
  modelCalls = 0
  const connectionId = randomUUID(), grantId = randomUUID()
  await api(page, 'models/connections', { requestId: randomUUID(), connectionId, expectedVersion: 0, name: '浏览器受控模型',
    protocol: 'chat-completions', baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, path: '/chat/completions',
    modelId: 'fixture-artifact-ui', dialect: 'standard', parameterMode: 'plain', enabled: true, contextWindow: 262144, maxOutputTokens: 8192,
    credential: { action: 'replace', value: 'synthetic-artifact-browser-key' } })
  await api(page, 'models/grants', { requestId: randomUUID(), grantId, connectionId, owner: 'self' })
  const selection = await api(page, 'models/selection')
  await api(page, 'models/selection', { requestId: randomUUID(), expectedVersion: selection.version, source: { kind: 'personal', connectionId, grantId } })
}

test('an Agent conversation retains card input after reload and opens the same revision in the workspace tool tab', async ({ page }) => {
  const created = await api(page, 'activities', { requestId: randomUUID(), goal: '对话卡片进入工具区', question: '', references: [] })
  const id = created.activityId
  await page.goto(endpoint + '/?space=personal&view=agent&activity=' + id)
  await expect(page.locator('.product-conversation-head h1')).toHaveText('对话卡片进入工具区')
  const published = await publish(page, id, { payload: payload('从对话打开的比较卡') })
  const card = page.locator(`.product-conversation .teaching-artifact-card[data-artifact-id="${published.artifactId}"]`)
  await expect(card).toHaveAttribute('data-revision-id', published.revisionId)
  const input = card.frameLocator('iframe').getByRole('textbox', { name: '我的解释', exact: true })
  await expect(input).toBeEditable()
  await input.fill('对话内填写并保留的中文解释')
  await expect.poll(async () => (await api(page, 'workspaces/' + id)).files.some((file: { name: string; value: string }) =>
    file.name === `components/artifact-${published.artifactId}.json`
    && JSON.parse(file.value).content.answer === '对话内填写并保留的中文解释')).toBe(true)
  await page.reload()
  await expect(input).toHaveValue('对话内填写并保留的中文解释')
  await input.fill('进入工具区前继续补充的解释')
  await card.getByRole('button', { name: '在工具区打开', exact: true }).click()
  await expect(page).toHaveURL(url => url.searchParams.get('activity') === id
    && url.searchParams.get('artifact') === published.artifactId && !url.searchParams.has('view'))
  await expect(page.locator('#activity-title')).toHaveText('对话卡片进入工具区')
  await expect(page.getByRole('tab', { name: /^从对话打开的比较卡/ })).toHaveAttribute('aria-selected', 'true')
  const center = page.locator(`.teaching-artifact-center[data-artifact-id="${published.artifactId}"]`)
  await expect(center).toHaveAttribute('data-revision-id', published.revisionId)
  const centerInput = center.frameLocator('iframe').getByRole('textbox', { name: '我的解释', exact: true })
  await expect(centerInput).toBeEditable()
  await expect(centerInput).toHaveValue('进入工具区前继续补充的解释')
})

test('a checked card activates in its activity and retains unshelved input after refresh and center close', async ({ page }) => {
  const id = await activity(page)
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  const composer = page.getByRole('textbox', { name: '你的问题', exact: true })
  await composer.fill('候选到达时仍在写的问题')
  await publish(page, id)
  const card = page.locator('.teaching-artifact-card').first()
  const input = card.frameLocator('iframe').getByRole('textbox', { name: '我的解释' })
  await expect(input).toBeEditable()
  await expect(composer).toBeFocused()
  await expect(composer).toHaveValue('候选到达时仍在写的问题')
  await input.fill('尚未收纳的中文解释')
  await expect.poll(async () => {
    const work = await (await page.request.get(endpoint + '/api/learning/workspaces/' + id, { headers: { 'x-xj-space': 'personal' } })).json()
    if ((await card.locator('[role="alert"]').count()) > 0) throw new Error(await card.innerText())
    return work.files.some((file: { value: string }) => file.value.includes('尚未收纳的中文解释'))
  }).toBe(true)
  if (evidenceDirectory()) await page.screenshot({ path: evidencePath('screenshots/teachingArtifacts/artifact-inline-after.png'), fullPage: true })
  await page.reload()
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await expect(input).toHaveValue('尚未收纳的中文解释')
  await card.getByRole('button', { name: '收纳', exact: true }).click()
  await card.getByRole('button', { name: '在工具区打开', exact: true }).click()
  await expect(page.locator('.teaching-artifact-center').frameLocator('iframe').getByRole('textbox', { name: '我的解释' })).toHaveValue('尚未收纳的中文解释')
  await page.locator('.teaching-artifact-center').getByRole('button', { name: '关闭页面', exact: true }).click()
  await expect(page.locator('.teaching-artifact-center')).toHaveCount(0)
  await expect(input).toHaveValue('尚未收纳的中文解释')
})

test('a narrowed revision forks while later input remains usable and synchronizes on the original page', async ({ page }) => {
  const id = await activity(page)
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  const first = await publish(page, id), original = page.locator(`[data-artifact-id="${first.artifactId}"]`).first()
  const answer = original.frameLocator('iframe').getByRole('textbox', { name: '我的解释', exact: true })
  await expect(answer).toBeEditable()
  await answer.fill('原先的解释')
  await page.locator('#activity-title').click()
  let arrived!: () => void, release!: () => void
  const received = new Promise<void>(resolve => { arrived = resolve }), held = new Promise<void>(resolve => { release = resolve })
  await page.route('**/api/learning/artifacts/*/adopt', async route => {
    const response = await route.fetch()
    arrived(); await held; await route.fulfill({ response })
  })
  const revised = payload('缩小了回答上限的修订')
  revised.stateShape.properties.answer.maxLength = 20
  revised.initialState.answer = '新版初值'
  await publish(page, id, { artifactId: first.artifactId, parentRevisionId: first.revisionId, payload: revised })
  try {
    await received
    const later = '接收期间继续输入的解释，长度超过新版上限，必须保留原页和全部文字。'
    await answer.fill(later)
    await page.locator('#activity-title').click()
    release()
    await expect(page.locator('.teaching-artifact-card[data-artifact-id]')).toHaveCount(2)
    await expect(original).toHaveAttribute('data-revision-id', first.revisionId)
    await expect(answer).toHaveValue(later)
    await expect.poll(async () => {
      const work = await (await page.request.get(endpoint + '/api/learning/workspaces/' + id, { headers: { 'x-xj-space': 'personal' } })).json()
      return work.files.some((file: { name: string; value: string }) => file.name === `components/artifact-${first.artifactId}.json`
        && JSON.parse(file.value).content.answer === later)
    }).toBe(true)
    const fork = page.locator('.teaching-artifact-card[data-artifact-id]').filter({ has: page.getByRole('heading', { name: '缩小了回答上限的修订', exact: true }) })
    await expect(fork.frameLocator('iframe').getByRole('textbox', { name: '我的解释', exact: true })).toHaveValue('新版初值')
    await page.reload()
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await expect(answer).toHaveValue(later)
    await expect(page.locator('.teaching-artifact-card[data-artifact-id]')).toHaveCount(2)
  } finally { release(); await page.unroute('**/api/learning/artifacts/*/adopt') }
})

test('a compatible revision preserves new input and Chinese composition that arrives while adoption is awaiting its original receipt', async ({ page }) => {
  const id = await activity(page)
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  const first = await publish(page, id)
  const card = page.locator(`[data-artifact-id="${first.artifactId}"]`).first()
  const input = card.frameLocator('iframe').getByRole('textbox', { name: '我的解释' })
  await expect(input).toBeEditable()
  await input.fill('修订前的解释')
  const composer = page.getByRole('textbox', { name: '你的问题', exact: true })
  await composer.fill('请改善页面')
  let release!: () => void, received!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { received = resolve })
  await page.route('**/api/learning/artifacts/' + id + '/adopt', async route => {
    const response = await route.fetch(); received(); await held; await route.fulfill({ response })
  })
  try {
    const second = await publish(page, id, { artifactId: first.artifactId, parentRevisionId: first.revisionId, payload: payload('改进的比较卡') })
    await started
    await input.fill('采用等待期间继续写的解释')
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Input.imeSetComposition', { text: '正在组合', selectionStart: 4, selectionEnd: 4 })
    release()
    await expect(card).toHaveAttribute('data-revision-id', first.revisionId)
    await cdp.send('Input.insertText', { text: '中文补充' })
    const expected = await input.inputValue()
    await composer.focus()
    await expect(card).toHaveAttribute('data-revision-id', second.revisionId)
    await expect(input).toHaveValue(expected)
    await page.reload(); await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await expect(input).toHaveValue(expected)
  } finally { release(); await page.unroute('**/api/learning/artifacts/' + id + '/adopt') }
})

test('an incompatible revision opens a separate instance while the original answer stays usable', async ({ page }) => {
  const id = await activity(page)
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  const first = await publish(page, id)
  const original = page.locator(`[data-artifact-id="${first.artifactId}"]`).first()
  const input = original.frameLocator('iframe').getByRole('textbox', { name: '我的解释' })
  await expect(input).toBeEditable(); await input.fill('不能映射的原解释仍保留')
  await page.getByRole('textbox', { name: '你的问题', exact: true }).focus()
  await publish(page, id, { artifactId: first.artifactId, parentRevisionId: first.revisionId, payload: { ...payload('新版选择卡'),
    html: '<h2>从另一个角度比较</h2><label><input type="checkbox" aria-label="我的选择">我的选择</label>',
    javascript: '(async()=>{const {content}=await xunjie.read();const input=document.querySelector("input");input.checked=content.choice;input.addEventListener("change",()=>xunjie.change({choice:input.checked}).catch(()=>{}));})();',
    initialState: { choice: false }, stateShape: { type: 'object', properties: { choice: { type: 'boolean' } } },
    semanticFields: [{ key: 'choice', meaning: '学生明确选择的比较方向' }] } })
  await expect(page.locator('.teaching-artifact-card')).toHaveCount(2)
  await expect(input).toHaveValue('不能映射的原解释仍保留')
  await expect(original).toHaveAttribute('data-revision-id', first.revisionId)
  const next = page.locator('.teaching-artifact-card').filter({ hasText: '新版选择卡' })
  const choice = next.frameLocator('iframe').getByRole('checkbox', { name: '我的选择' })
  await choice.check()
  await page.reload(); await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await expect(input).toHaveValue('不能映射的原解释仍保留')
  await expect(choice).toBeChecked()
  await expect(original).toContainText('已另开一页')
})

test('unknown adoption and shelf acknowledgements recover after reload by querying the durable original requests', async ({ page }) => {
  const id = await activity(page)
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  let blocked = false, accepted!: () => void
  const committed = new Promise<void>(resolve => { accepted = resolve })
  const adoptionIds: string[] = [], shelfIds: string[] = [], queried: string[] = []
  await page.route('**/api/learning/artifacts/' + id + '/receipts/*', async route => {
    queried.push(route.request().url().split('/').at(-1)!)
    if (blocked) await route.abort('failed'); else await route.continue()
  })
  await page.route('**/api/learning/artifacts/' + id + '/adopt', async route => {
    adoptionIds.push(route.request().postDataJSON().requestId)
    const response = await route.fetch(); expect(response.status()).toBe(200)
    blocked = true; accepted(); await route.abort('failed')
  })
  await publish(page, id); await committed
  await page.reload(); await page.getByRole('button', { name: '打开对话', exact: true }).click()
  const card = page.locator('.teaching-artifact-card').first()
  await expect.poll(() => queried.filter(requestId => requestId === adoptionIds[0]).length).toBeGreaterThan(2)
  await expect(card.locator('iframe')).toHaveCount(0)
  blocked = false
  const input = card.frameLocator('iframe').getByRole('textbox', { name: '我的解释' })
  await expect(input).toBeEditable()
  expect(adoptionIds).toHaveLength(1)
  expect(queried.filter(requestId => requestId === adoptionIds[0]).length).toBeGreaterThan(1)
  await input.fill('原采用回执恢复后的解释')
  let shelved!: () => void
  const shelfCommitted = new Promise<void>(resolve => { shelved = resolve })
  await page.route('**/api/learning/artifacts/' + id + '/shelf', async route => {
    shelfIds.push(route.request().postDataJSON().requestId)
    const response = await route.fetch(); expect(response.status()).toBe(200)
    blocked = true; shelved(); await route.abort('failed')
  })
  await card.getByRole('button', { name: '收纳', exact: true }).click(); await shelfCommitted
  await page.reload(); await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await expect.poll(() => queried.filter(requestId => requestId === shelfIds[0]).length).toBeGreaterThan(1)
  blocked = false
  await expect(card.getByRole('button', { name: '取消收纳', exact: true })).toBeEnabled()
  await expect(input).toHaveValue('原采用回执恢复后的解释')
  expect(shelfIds).toHaveLength(1)
  expect(queried).toContain(shelfIds[0])
})

test('failed browser protection retains later input, survives conversation collapse and resumes the original changes without a stuck queue', async ({ page }) => {
  const id = await activity(page)
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await publish(page, id)
  const card = page.locator('.teaching-artifact-card').first()
  const input = card.frameLocator('iframe').getByRole('textbox', { name: '我的解释' })
  await expect(input).toBeEditable()
  await page.evaluate(() => {
    Object.assign(window, { artifactStorageBlocked: true })
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function(...args) {
      if (this.name === 'workspaces' && (window as unknown as { artifactStorageBlocked: boolean }).artifactStorageBlocked)
        throw new DOMException('Controlled workspace storage refusal', 'QuotaExceededError')
      return Reflect.apply(original, this, args)
    }
  })
  await input.fill('存储故障时的第一份输入')
  await expect(card.locator('[role="alert"]').first()).toBeVisible()
  await input.fill('存储故障后继续写的最终中文解释')
  await card.getByRole('button', { name: '在工具区打开', exact: true }).click()
  await expect(page.locator('.teaching-artifact-center')).toHaveCount(0)
  await expect(input).toHaveValue('存储故障后继续写的最终中文解释')
  await page.getByRole('button', { name: '收起对话', exact: true }).click()
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await expect(input).toHaveValue('存储故障后继续写的最终中文解释')
  await page.evaluate(() => { Object.assign(window, { artifactStorageBlocked: false }) })
  await expect.poll(async () => {
    const work = await (await page.request.get(endpoint + '/api/learning/workspaces/' + id, { headers: { 'x-xj-space': 'personal' } })).json()
    return work.files.some((file: { value: string }) => file.value.includes('存储故障后继续写的最终中文解释'))
  }).toBe(true)
  await card.getByRole('button', { name: '在工具区打开', exact: true }).click()
  await expect(page.locator('.teaching-artifact-center').frameLocator('iframe').getByRole('textbox', { name: '我的解释' }))
    .toHaveValue('存储故障后继续写的最终中文解释')
})

test('a personal page reads only explicit authorized note versions and preserves text and object references across revision', async ({ page }) => {
  const id = await activity(page), materialId = randomUUID()
  await api(page, 'materials/' + id, { requestId: randomUUID(), materialId, name: '自己的材料.txt', mediaType: 'text/plain',
    dataBase64: Buffer.from('第一版固定的个人材料').toString('base64') })
  await api(page, `materials/${id}/${materialId}`, { requestId: randomUUID(), materialId, expectedVersion: 1,
    dataBase64: Buffer.from('第二版不会替换原读取依据').toString('base64') })
  const foreign = await api(page, 'activities', { requestId: randomUUID(), goal: '另一活动', question: '', references: [] })
  const foreignId = randomUUID()
  await api(page, 'materials/' + foreign.activityId, { requestId: randomUUID(), materialId: foreignId, name: '别处.txt', mediaType: 'text/plain',
    dataBase64: Buffer.from('另一活动的内容不得读取').toString('base64') })
  const fixedText = '这是固定页面中的原句', objectSummary = '独立于屏幕位置的比较对象'
  const authored = { ...payload('资料与引用卡'),
    html: `<p>${fixedText}</p><button id="note">读取固定笔记</button><button id="missing">省略版本</button><button id="foreign">读取另一活动</button><output></output><button id="text">引用文字</button><button id="object">引用图中对象</button>`,
    requiredCapabilities: ['workspace.read', 'workspace.change', 'materials.read', 'reference.select'],
    semanticObjects: [{ id: 'diagram', meaning: '比较图中的对象', summary: objectSummary }],
    javascript: `(async()=>{await xunjie.read();const output=document.querySelector('output');const read=async input=>{try{const value=await xunjie.materials.read(input);output.textContent=value.text;}catch(error){output.textContent=error.message;}};document.querySelector('#note').onclick=()=>read({materialId:'${materialId}',version:1});document.querySelector('#missing').onclick=()=>read({materialId:'${materialId}'});document.querySelector('#foreign').onclick=()=>read({materialId:'${foreignId}',version:1});document.querySelector('#text').onclick=()=>xunjie.reference.select({text:'${fixedText}'}).catch(()=>{});document.querySelector('#object').onclick=()=>xunjie.reference.select({objectId:'diagram'}).catch(()=>{});})();` }
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  const first = await publish(page, id, { payload: authored })
  const card = page.locator('.teaching-artifact-card').first(), view = card.frameLocator('iframe')
  await view.getByRole('button', { name: '读取固定笔记', exact: true }).click()
  await expect(view.locator('output')).toHaveText('第一版固定的个人材料')
  await view.getByRole('button', { name: '省略版本', exact: true }).click()
  await expect(view.locator('output')).toHaveText('invalid-input')
  await view.getByRole('button', { name: '读取另一活动', exact: true }).click()
  await expect(view.locator('output')).toHaveText('forbidden')
  await view.getByRole('button', { name: '引用文字', exact: true }).click()
  await view.getByRole('button', { name: '引用图中对象', exact: true }).click()
  await expect(page.getByRole('region', { name: '上下文引用' })).toContainText(fixedText)
  await expect(page.getByRole('region', { name: '上下文引用' })).toContainText(objectSummary)
  await expect.poll(async () => (await api(page, 'drafts/' + id)).references.length).toBe(2)
  const before = (await api(page, 'drafts/' + id)).references
  await page.getByRole('textbox', { name: '你的问题', exact: true }).focus()
  const revised = await publish(page, id, { artifactId: first.artifactId, parentRevisionId: first.revisionId, payload: { ...authored,
    html: authored.html.replace(fixedText, '新版的说明'), javascript: authored.javascript.replace(fixedText, '新版的说明'),
    semanticObjects: [{ id: 'diagram', meaning: '比较图中的对象', summary: '新版对象说明' }] } })
  await expect(card).toHaveAttribute('data-revision-id', revised.revisionId)
  expect((await api(page, 'drafts/' + id)).references).toEqual(before)
})

test('native streamed tool arguments produce one static themed preview and then one usable card in the original conversation', async ({ page }) => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const authored = Object.assign({ html: '' }, payload('模型生成的学习卡'), { artifactId: null, parentRevisionId: null, mapping: [] })
  // Preserve HTML as the first native JSON field; it remains incomplete until the explicit gate opens.
  authored.html = '<h2>逐渐形成的比较页面</h2><label>我的解释<textarea aria-label="我的解释"></textarea></label><p>' + '先形成自己的解释，再查看观察依据。'.repeat(20) + '</p>'
  modelHandler = (body, response, index) => {
    if (index > 1) { modelReply(response, '页面已完成，你可以写下自己的解释。'); return }
    const tool = body.tools.find((tool: any) => tool.function.name === 'generate_teaching_artifact')
    const serialized = JSON.stringify(authored), split = serialized.indexOf(',"formatVersion"')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (value: unknown) => response.write('data: ' + JSON.stringify(value) + '\n\n')
    send({ id: 'stream-ui', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'stream-card', type: 'function',
      function: { name: tool.function.name, arguments: serialized.slice(0, split) } }] }, finish_reason: null }] })
    void gate.then(() => {
      send({ id: 'stream-ui', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: serialized.slice(split) } }] }, finish_reason: null }] })
      send({ id: 'stream-ui', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
      send({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 100, total_tokens: 120 } })
      response.end('data: [DONE]\n\n')
    })
  }
  await model(page)
  const id = await activity(page, '请生成一个能填写解释的比较页面')
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  try {
    const preview = page.locator('.teaching-artifact-preview')
    await expect(preview).toHaveCount(1, { timeout: 20000 })
    await expect(preview.locator('iframe')).toHaveAttribute('sandbox', '')
    await expect(preview.frameLocator('iframe').getByRole('textbox', { name: '我的解释' })).toBeDisabled()
    expect(await api(page, 'artifacts/' + id)).toHaveLength(0)
    expect((await api(page, 'workspaces/' + id)).files).toHaveLength(0)
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    const color = await page.evaluate(() => {
      const element = document.createElement('i'); element.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--paper')
      document.body.append(element); const value = getComputedStyle(element).backgroundColor; element.remove(); return value
    })
    await expect.poll(() => preview.frameLocator('iframe').locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe(color)
    if (evidenceDirectory()) await page.screenshot({ path: evidencePath('screenshots/teachingArtifacts/artifact-streaming-dark.png'), fullPage: true })
    release()
    const card = page.locator('.teaching-artifact-card:not(.teaching-artifact-preview)')
    const input = card.frameLocator('iframe').getByRole('textbox', { name: '我的解释' })
    await expect(input).toBeEditable({ timeout: 20000 })
    await expect(preview).toHaveCount(0)
    await expect(card).toHaveCount(1)
    await input.fill('模型生成页面内的解释')
    await expect.poll(async () => (await api(page, 'workspaces/' + id)).files.some((file: { value: string }) => file.value.includes('模型生成页面内的解释'))).toBe(true)
    expect(modelCalls).toBe(2)
  } finally { release() }
})

test('automatic and ordinary input responses do not consume a Wait, while omitted questionId queues a question and an explicit binding answers once', async ({ page }) => {
  modelHandler = (_body, response, index) => modelReply(response, index === 1 ? { name: 'student_ask', arguments: {
    question: '请用自己的话解释你的比较依据。', source: '学生正在比较两个解释', options: [], allowText: true, skippable: true } } : '回应与补充问题已保留。')
  await model(page)
  const id = await activity(page, '先向我提出一个需要明确回答的问题')
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await expect.poll(async () => (await api(page, `agent/${id}/conversation`)).questions.filter((question: { state: string }) => question.state === 'pending').length).toBe(1)
  const question = (await api(page, `agent/${id}/conversation`)).questions[0]
  await page.getByRole('combobox', { name: '本次发送方式', exact: true }).selectOption('queue')
  const autoId = randomUUID(), inputId = randomUUID(), queuedId = randomUUID(), answerId = randomUUID()
  await publish(page, id, { payload: { ...payload('明确回应卡'),
    html: '<label>我的解释<textarea aria-label="我的解释"></textarea></label><output id="automatic"></output><output id="effect"></output><button id="follow">稍后讨论另一问题</button><button id="answer">明确回答原问题</button>',
    requiredCapabilities: ['workspace.read', 'workspace.change', 'student.respond'],
    javascript: `(async()=>{const {content}=await xunjie.read();const input=document.querySelector('textarea');input.value=content.answer;const automatic=document.querySelector('#automatic'),effect=document.querySelector('#effect');xunjie.respond({requestId:'${autoId}',text:'不应自动回应',questionId:'${question.questionId}'}).then(()=>automatic.textContent='unexpected').catch(error=>automatic.textContent=error.message);input.addEventListener('input',()=>{xunjie.change({answer:input.value}).catch(()=>{});xunjie.respond({requestId:'${inputId}',text:'普通输入不能消费提问',questionId:'${question.questionId}'}).then(()=>automatic.textContent='unexpected').catch(error=>automatic.textContent='input:'+error.message);});document.querySelector('#follow').onclick=()=>xunjie.respond({requestId:'${queuedId}',text:'稍后讨论的补充问题'}).then(()=>effect.textContent='queued').catch(error=>effect.textContent=error.message);document.querySelector('#answer').onclick=()=>xunjie.respond({requestId:'${answerId}',text:'这是显式绑定的回应',questionId:'${question.questionId}'}).then(()=>effect.textContent='answered').catch(error=>effect.textContent=error.message);})();` } })
  const view = page.locator('.teaching-artifact-card').frameLocator('iframe')
  await expect(view.locator('#automatic')).toHaveText('forbidden')
  await view.getByRole('textbox', { name: '我的解释' }).fill('只是在编辑页面中的解释')
  await expect(view.locator('#automatic')).toHaveText('input:forbidden')
  let conversation = await api(page, `agent/${id}/conversation`)
  expect(conversation.runs).toHaveLength(1)
  expect(conversation.questions.find((item: { questionId: string }) => item.questionId === question.questionId).response).toBeNull()
  await view.getByRole('button', { name: '稍后讨论另一问题', exact: true }).click()
  await expect(view.locator('#effect')).toHaveText('queued')
  await expect.poll(async () => (await api(page, `agent/${id}/conversation`)).inputs.some((input: { requestId: string }) => input.requestId === queuedId)).toBe(true)
  conversation = await api(page, `agent/${id}/conversation`)
  expect(conversation.questions.find((item: { questionId: string }) => item.questionId === question.questionId).state).toBe('pending')
  expect(conversation.questions.find((item: { questionId: string }) => item.questionId === question.questionId).response).toBeNull()
  await view.getByRole('button', { name: '明确回答原问题', exact: true }).click()
  await expect(view.locator('#effect')).toHaveText('answered')
  await expect.poll(async () => (await api(page, `agent/${id}/conversation`)).questions.find((item: { questionId: string }) => item.questionId === question.questionId).response?.requestId).toBe(answerId)
  await view.getByRole('button', { name: '明确回答原问题', exact: true }).click()
  conversation = await api(page, `agent/${id}/conversation`)
  expect(conversation.messages.filter((message: { kind: string }) => message.kind === 'student-response')).toHaveLength(1)
})

test('a page with real course execution permission cannot start an experiment or Agent from load or ordinary text input', async ({ page }) => {
  const control = await resolveCredential(root, 'control')
  const manage = async (route: string, data: unknown) => {
    const response = await page.request.post(endpoint + '/api/learning/manage/' + route, { headers: { authorization: 'Bearer ' + control }, data })
    expect(response.status()).toBe(200); return response.json()
  }
  const definition = await manage('component-import', { ...await aluPackage(), requestId: randomUUID() })
  const course = await aluCoursePackage(); course.requestId = randomUUID(); course.release.components![0].definition = definition
  await manage('course-import', course)
  const loginName = 'artifact-gesture-' + randomUUID(), password = randomUUID()
  const member = await manage('members', { requestId: randomUUID(), loginName, password })
  await manage('course-access', { requestId: randomUUID(), courseId: course.course.courseId, principalId: member.principalId, active: true })
  expect((await page.request.post(endpoint + '/api/learning/login', { data: { loginName, password } })).status()).toBe(200)
  const activity = await api(page, 'course-activities', { requestId: randomUUID(), releaseId: course.release.releaseId }, 'school')
  const id = activity.activityId, requestId = randomUUID(), respondId = randomUUID()
  await page.goto(endpoint + '/?space=school&activity=' + id)
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await api(page, 'artifacts/' + id, { requestId: randomUUID(), payload: { ...payload('只允许明确动作的实验卡'),
    html: '<label>我的解释<textarea aria-label="我的解释"></textarea></label><output id="execute"></output><output id="respond"></output>',
    requiredCapabilities: ['workspace.read', 'workspace.change', 'execution.submit', 'student.respond'],
    javascript: `(async()=>{const {content}=await xunjie.read();const input=document.querySelector('textarea');input.value=content.answer;const attempt=prefix=>{xunjie.execution.submit({requestId:'${requestId}',componentKey:'alu',operationId:'run-single',parameters:{A:0,B:0,M:0,S:0,Cin:0}}).then(()=>document.querySelector('#execute').textContent='unexpected').catch(error=>document.querySelector('#execute').textContent=prefix+error.message);xunjie.respond({requestId:'${respondId}',text:'不能自动向Agent发问'}).then(()=>document.querySelector('#respond').textContent='unexpected').catch(error=>document.querySelector('#respond').textContent=prefix+error.message);};attempt('load:');input.addEventListener('input',()=>{xunjie.change({answer:input.value}).catch(()=>{});attempt('input:');});})();` } }, 'school')
  const view = page.locator('.teaching-artifact-card').frameLocator('iframe')
  await expect(view.locator('#execute')).toHaveText('load:forbidden')
  await expect(view.locator('#respond')).toHaveText('load:forbidden')
  await view.getByRole('textbox', { name: '我的解释' }).fill('普通输入不能触发实验')
  await expect(view.locator('#execute')).toHaveText('input:forbidden')
  await expect(view.locator('#respond')).toHaveText('input:forbidden')
  expect((await api(page, `agent/${id}/conversation`, undefined, 'school')).runs).toHaveLength(0)
  const executions = await api(page, 'executions/' + id + '/history', undefined, 'school')
  expect(executions.entries).toHaveLength(0)
})

test('an actual isolated restore reopens the original card read-only with zero client recovery writes', async ({ page }) => {
  test.setTimeout(120000)
  const id = await activity(page)
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  await publish(page, id)
  const card = page.locator('.teaching-artifact-card').first(), input = card.frameLocator('iframe').getByRole('textbox', { name: '我的解释' })
  await expect(input).toBeEditable(); await input.fill('还原副本中的原始中文输入')
  await expect.poll(async () => (await api(page, 'workspaces/' + id)).files.some((file: { value: string }) => file.value.includes('还原副本中的原始中文输入'))).toBe(true)
  const directory = await mkdtemp(join(tmpdir(), 'xj-artifact-readonly-')), key = randomBytes(32)
  let restored: Awaited<ReturnType<typeof restoreProductRecovery>> | undefined
  let copy: Awaited<ReturnType<typeof createProductRuntimeHost>> | undefined
  try {
    const backup = await host.recovery.backup({ directory, key, leaveClosed: true })
    const copyRoot = join(directory, 'restored')
    const resources = { nodePath: process.execPath, nodeVersion: '24.21.0', postgresBin, postgresVersion: '18.6',
      webRoot: process.env.XUNJIE_PRODUCT_WEB_ROOT ?? fileURLToPath(new URL('../dist-runtime', import.meta.url)),
      windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) }
    restored = await restoreProductRecovery({ root: copyRoot, resources, backupDirectory: join(directory, backup.backupId), key })
    for (const owner of restored.owners) await owner.close?.(); restored = undefined
    copy = await createProductRuntimeHost({ root: copyRoot, createApplication: context => createProductLearningApplication(context) })
    await page.addInitScript(() => {
      Object.assign(window, { artifactRecoveryWrites: 0 })
      for (const method of ['put', 'add', 'delete', 'clear'] as const) {
        const original = IDBObjectStore.prototype[method]
        IDBObjectStore.prototype[method] = function(...args: any[]) {
          const state = window as unknown as { artifactRecoveryWrites: number }
          if (['workspaces', 'workOperations', 'drafts', 'draftCandidates', 'studentResponses', 'agentControls', 'actions', 'candidates'].includes(this.name)) state.artifactRecoveryWrites++
          return Reflect.apply(original, this, args)
        }
      }
    })
    const writes: string[] = []
    page.on('request', request => { if (request.method() === 'POST' && request.url().startsWith(copy!.endpoint + '/api/learning/')) writes.push(request.url()) })
    let unavailableConversations = 0
    await page.route(/\/api\/learning\/agent\/[^/]+\/conversation(?:\?|$)/, route => {
      unavailableConversations++
      return route.fulfill({ status: 503, json: { error: 'unavailable' } })
    })
    await page.goto(copy.endpoint + '/?activity=' + id)
    await expect(page.getByText('这是还原校验副本，作品与学习对话只读，不会启动 Agent 或实验；请由维护者完成接管后继续。').first()).toBeVisible()
    await page.getByRole('button', { name: '打开对话', exact: true }).click()
    await expect(input).toHaveValue('还原副本中的原始中文输入')
    await expect(input).toBeDisabled()
    expect(unavailableConversations).toBeGreaterThan(0)
    await expect(card.getByRole('button', { name: '收纳', exact: true })).toHaveCount(0)
    // Invoke the public SDK in the opaque frame; the restored owner must reject before retaining a write.
    const browserFrame = await card.locator('iframe').elementHandle().then(handle => handle!.contentFrame())
    const code = await browserFrame!.evaluate(async () => {
      const sdk = (window as unknown as { xunjie: { change(value: unknown): Promise<unknown> } }).xunjie
      try { await sdk.change({ answer: '不允许覆盖只读原文' }); return 'unexpected' } catch (cause) { return (cause as Error).message }
    })
    expect(code).toBe('forbidden')
    expect(await page.evaluate(() => (window as unknown as { artifactRecoveryWrites: number }).artifactRecoveryWrites)).toBe(0)
    expect(writes).toEqual([])
  } finally {
    for (const owner of restored?.owners ?? []) await owner.close?.()
    await copy?.stop(); await host.recovery.resume(); await rm(directory, { recursive: true, force: true })
  }
})

test('a revision missing workspace.read fails its browser check and preserves the active page', async ({ page }) => {
  const id = await activity(page)
  await page.getByRole('button', { name: '打开对话', exact: true }).click()
  const original = await publish(page, id)
  const card = page.locator(`[data-artifact-id="${original.artifactId}"]`).first()
  const input = card.frameLocator('iframe').getByRole('textbox', { name: '我的解释' })
  await expect(input).toBeEditable()
  await input.fill('缺失能力的新版不能隐藏这份原输入')
  await expect.poll(async () => (await api(page, 'workspaces/' + id)).files.some((file: { value: string }) =>
    file.value.includes('缺失能力的新版不能隐藏这份原输入'))).toBe(true)
  await page.getByRole('textbox', { name: '你的问题', exact: true }).focus()
  const before = await api(page, 'workspaces/' + id)
  const candidate = await publish(page, id, { artifactId: original.artifactId, parentRevisionId: original.revisionId,
    payload: { ...payload('遗漏读取能力的修订'), requiredCapabilities: ['workspace.change'] } })
  await expect.poll(async () => (await api(page, `artifacts/${id}/candidates/${candidate.candidateId}`)).status).toBe('check-failed')
  const report = await api(page, `artifacts/${id}/candidates/${candidate.candidateId}`)
  expect(report.checks.find((check: { code: string }) => check.code === 'browser-roundtrip').passed).toBe(false)
  expect((await api(page, `artifacts/${id}/${original.artifactId}`)).activeRevisionId).toBe(original.revisionId)
  expect(await api(page, 'workspaces/' + id)).toEqual(before)
  await expect(card).toHaveAttribute('data-revision-id', original.revisionId)
  await expect(input).toBeEditable()
  await expect(input).toHaveValue('缺失能力的新版不能隐藏这份原输入')
  await input.fill('检查失败后原页面继续可编辑')
  await expect.poll(async () => (await api(page, 'workspaces/' + id)).files.some((file: { value: string }) =>
    file.value.includes('检查失败后原页面继续可编辑'))).toBe(true)
})
