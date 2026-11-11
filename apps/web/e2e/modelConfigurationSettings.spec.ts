import { test, expect, type Page } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { openProductRuntime } from '@xunjie/product-runtime'

const postgresBin = process.env.XUNJIE_PRODUCT_POSTGRES_BIN
test.skip(!postgresBin, 'Requires bundled PostgreSQL')
let runtime: ReturnType<typeof openProductRuntime>, root: string, endpoint: string, baseUrl: string
const generated: Record<string, unknown>[] = []
let lists = 0, cancelled = 0
const supplier = createServer(async (request, response) => {
  if (request.method === 'GET') {
    lists++
    if (request.url?.startsWith('/missing/')) { response.writeHead(404); response.end(JSON.stringify({ error: { message: 'No model-list route' } })); return }
    if (request.headers.authorization === 'Bearer synthetic-bad-key') {
      response.writeHead(401, { 'content-type': 'application/json', 'request-id': 'synthetic-auth' })
      response.end(JSON.stringify({ error: { code: 'invalid_api_key', message: 'Rejected synthetic-bad-key' } })); return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    if (request.url?.startsWith('/sorting/')) {
      response.end(JSON.stringify({ data: ['model-d', 'candidate-10', 'model-c', 'candidate-2'].map(id => ({ id })) })); return
    }
    response.end(JSON.stringify({ data: [{ id: 'gpt-5.2', name: '示例推理模型', context_window: 131072, max_output_tokens: 32768,
      supported_reasoning_levels: ['none', 'low', 'medium', 'high', 'xhigh'] }, { id: 'fixture-no-images' }, { id: 'fixture-wait' }] })); return
  }
  const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk))
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')); generated.push(input)
  const image = JSON.stringify(input).includes('data:image/png;base64,')
  if (input.model === 'fixture-no-images' && image) {
    response.writeHead(400, { 'content-type': 'application/json', 'request-id': 'image-request-42' })
    response.end(JSON.stringify({ error: { code: 'unsupported_parameter', param: 'image_url', message: 'This route does not accept image input.' } })); return
  }
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  if (input.model === 'fixture-wait') {
    response.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }) + '\n\n')
    response.on('close', () => { cancelled++ }); return
  }
  response.end('data: ' + JSON.stringify({ id: 'synthetic-config-test', choices: [{ index: 0,
    delta: { role: 'assistant', content: image ? '图中是红色的正方形。' : '你好，模型连接正常。' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
})
test.beforeAll(async () => {
  const installation = JSON.parse(await readFile(join(homedir(), 'Library/Application Support/XunJie/environments/default/installation.json'), 'utf8'))
  await new Promise<void>(resolve => supplier.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(supplier.address() as { port: number }).port}/v1`
  root = await mkdtemp(join(tmpdir(), 'xj-configuration-ui-'))
  runtime = openProductRuntime({ root, resources: { ...installation.resources, nodePath: process.execPath, nodeVersion: '24.21.0',
    postgresBin, postgresVersion: '18.6', webRoot: resolve('dist-runtime') } })
  await runtime.install({ profile: 'local' }); endpoint = (await runtime.start()).endpoint!
})
test.afterAll(async () => {
  await runtime?.stop(); supplier.closeAllConnections(); await new Promise<void>(resolve => supplier.close(() => resolve()))
  if (root) await rm(root, { recursive: true, force: true })
})
async function openEditor(page: Page) {
  await page.goto(endpoint + '/?settings=models')
  await page.getByRole('button', { name: '添加供应商', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.locator('.st-model-choice')).toHaveCount(0)
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl)
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-ui-key')
  return dialog
}

test('custom supplier reads lists without generation, adds selected models, and tests the actual text/image configuration', async ({ page }) => {
  await page.setViewportSize({ width: 913, height: 742 })
  const dialog = await openEditor(page), before = generated.length, listBefore = lists
  await dialog.getByRole('button', { name: '连接测试', exact: true }).hover()
  await expect(page.getByRole('tooltip')).toHaveText('验证地址、协议和密钥')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toBeHidden()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '连接测试', exact: true }).press('Shift+Tab')
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('button', { name: '连接测试', exact: true })).toBeFocused()
  await expect(page.getByRole('tooltip')).toHaveText('验证地址、协议和密钥')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toBeHidden()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '连接测试', exact: true }).click()
  await expect(dialog.getByText('连接测试通过', { exact: true })).toBeVisible()
  await expect(dialog.locator('.st-connection-test .st-model-test-message, .st-connection-test details')).toHaveCount(0)
  expect(generated).toHaveLength(before)
  await dialog.getByRole('button', { name: '拉取模型', exact: true }).click()
  await expect(dialog.locator('.st-model-choice')).toHaveCount(3)
  await expect(page.getByRole('listbox')).toHaveCount(0)
  const choice = dialog.getByRole('checkbox', { name: '选择模型 gpt-5.2', exact: true })
  await expect(choice).not.toBeChecked()
  await expect(dialog.getByRole('button', { name: '展开 gpt-5.2 的配置', exact: true })).toBeVisible()
  await choice.press('Space')
  await expect(choice).toBeChecked()
  await expect(choice).toBeFocused()
  await expect(dialog.getByRole('region', { name: 'gpt-5.2的配置', exact: true })).toBeHidden()
  await dialog.getByRole('button', { name: '展开 gpt-5.2 的配置', exact: true }).click()
  expect(lists).toBeGreaterThanOrEqual(listBefore + 2)
  expect(generated).toHaveLength(before)
  const model = dialog.getByRole('region', { name: 'gpt-5.2的配置', exact: true })
  await model.getByRole('textbox', { name: '模型 ID的最大输出 token', exact: true }).fill('8K')
  await model.getByRole('combobox', { name: '模型 ID的默认思考强度', exact: true }).click()
  await page.getByRole('option', { name: '高 · high', exact: true }).click()
  await model.getByRole('button', { name: '模型 ID的图片理解', exact: true }).click()
  await model.getByRole('button', { name: '模型测试', exact: true }).hover()
  await expect(page.getByRole('tooltip')).toHaveText('验证模型与默认思考参数、能力配置')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('tooltip')).toBeHidden()
  await expect(dialog).toBeVisible()
  await model.getByRole('button', { name: '模型测试', exact: true }).click()
  await expect(model.getByText('模型测试通过', { exact: true })).toBeVisible()
  await expect(model.locator('.st-test-stages, .st-model-test-diagnostic')).toHaveCount(0)
  expect(generated).toHaveLength(before + 2)
  for (const payload of generated.slice(before)) {
    expect(payload.model).toBe('gpt-5.2'); expect(payload.max_completion_tokens).toBe(8192); expect(payload.reasoning_effort).toBe('high')
  }
  expect(JSON.stringify(generated[before])).not.toContain('data:image/png;base64,')
  expect(JSON.stringify(generated[before + 1])).toContain('data:image/png;base64,')
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('配置测试示例')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '保存前检查', exact: true })).toHaveCount(0)
  await expect(dialog.getByRole('region', { name: 'gpt-5.2的配置', exact: true })).toBeHidden()
  await dialog.getByRole('button', { name: '展开 gpt-5.2 的配置', exact: true }).click()
  await expect(dialog.getByRole('button', { name: '模型 ID的图片理解', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await expect(dialog.getByRole('textbox', { name: '模型 ID的最大输出 token', exact: true })).toHaveValue('8K')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(dialog).toBeVisible()
})

test('auth/list errors give actionable diagnostics, edits invalidate results, and image failure preserves the text result', async ({ page }) => {
  const dialog = await openEditor(page), before = generated.length
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-bad-key')
  await dialog.getByRole('button', { name: '连接测试', exact: true }).click()
  await expect(dialog.getByText('连接测试未通过', { exact: true })).toBeVisible()
  await expect(dialog.getByText(/密钥|API [Kk]ey/).filter({ hasText: /核对|检查|无效|拒绝/ }).first()).toBeVisible()
  expect(await dialog.textContent()).not.toContain('synthetic-bad-key')
  await dialog.getByLabel('API Key', { exact: true }).fill('synthetic-ui-key')
  await expect(dialog.getByText('连接测试未通过', { exact: true })).toHaveCount(0)
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl.replace('/v1', '/missing/v1'))
  await dialog.getByRole('button', { name: '连接测试', exact: true }).click()
  await expect(dialog.getByText('未能完成轻量验证', { exact: true })).toBeVisible()
  expect(generated).toHaveLength(before)
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl)
  await dialog.getByRole('textbox', { name: '搜索或输入模型 ID', exact: true }).fill('fixture-no-images')
  await dialog.getByRole('button', { name: '添加模型', exact: true }).click()
  await dialog.getByRole('button', { name: '模型 ID的图片理解', exact: true }).click()
  await dialog.getByRole('button', { name: '模型测试', exact: true }).click()
  await expect(dialog.getByText('文本通过，图片测试未通过', { exact: true })).toBeVisible()
  await expect(dialog.getByRole('button', { name: '模型 ID的图片理解', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await dialog.getByText('诊断详情', { exact: true }).click()
  await expect(dialog.getByLabel('诊断内容', { exact: true })).toContainText('image_url')
  await expect(dialog.getByLabel('诊断内容', { exact: true })).toContainText('image-request-42')
})

test('stopping the text stage cancels its real request and never starts the image stage', async ({ page }) => {
  const dialog = await openEditor(page), before = generated.length, stopped = cancelled
  await dialog.getByRole('textbox', { name: '搜索或输入模型 ID', exact: true }).fill('fixture-wait')
  await dialog.getByRole('button', { name: '添加模型', exact: true }).click()
  await dialog.getByRole('button', { name: '模型 ID的图片理解', exact: true }).click()
  const trigger = dialog.getByRole('button', { name: '模型测试', exact: true })
  const idleBox = await trigger.boundingBox()
  await trigger.click()
  await expect.poll(() => generated.length).toBe(before + 1)
  const stop = dialog.getByRole('button', { name: '停止模型测试', exact: true })
  await expect(stop).toBeFocused()
  expect(await stop.boundingBox()).toMatchObject({ width: idleBox!.width, height: idleBox!.height })
  await page.mouse.move(0, 0)
  await stop.hover()
  await expect(page.getByRole('tooltip')).toHaveText('停止本次测试')
  await page.keyboard.press('Escape')
  await stop.press('Enter')
  await expect(dialog.getByText('模型测试已停止', { exact: true })).toBeVisible()
  await expect.poll(() => cancelled).toBe(stopped + 1)
  expect(generated).toHaveLength(before + 1)
  expect(JSON.stringify(generated[before])).not.toContain('data:image/png;base64,')
})

test('saved model membership is independent of switches, opens collapsed, and can remove every model while keeping the supplier key', async ({ page }) => {
  const dialog = await openEditor(page)
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('成员勾选回归')
  for (const id of ['member-first', 'member-retained']) {
    await dialog.getByRole('textbox', { name: '搜索或输入模型 ID', exact: true }).fill(id)
    await dialog.getByRole('button', { name: '添加模型', exact: true }).click()
  }
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  const provider = page.locator('.st-provider').filter({ hasText: '成员勾选回归' })
  await provider.getByRole('switch', { name: '启用模型 member-retained', exact: true }).click()
  await expect(provider.getByRole('switch', { name: '启用模型 member-retained', exact: true })).not.toBeChecked()
  await provider.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(dialog.locator('.st-model-choice-title[aria-expanded="true"]')).toHaveCount(0)
  await expect(dialog.getByRole('checkbox', { name: '选择模型 member-retained', exact: true })).toBeChecked()
  const removeFirst = dialog.getByRole('checkbox', { name: '选择模型 member-first', exact: true })
  await removeFirst.press('Space')
  await expect(removeFirst).not.toBeChecked()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(provider.getByRole('switch', { name: '启用模型 member-first', exact: true })).toHaveCount(0)
  await expect(provider.getByRole('switch', { name: '启用模型 member-retained', exact: true })).not.toBeChecked()
  await provider.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(dialog.locator('.st-model-choice-title[aria-expanded="true"]')).toHaveCount(0)
  await dialog.getByRole('checkbox', { name: '选择模型 member-retained', exact: true }).press('Space')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(provider).toBeVisible()
  await expect(provider.getByRole('switch', { name: /^启用模型 / })).toHaveCount(0)
  await provider.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(dialog.getByLabel('API Key', { exact: true })).toHaveValue('synthetic-ui-key')
  await expect(dialog.locator('.st-model-choice')).toHaveCount(0)
  await dialog.getByRole('textbox', { name: '搜索或输入模型 ID', exact: true }).fill('member-readded')
  await dialog.getByRole('button', { name: '添加模型', exact: true }).click()
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await expect(provider.getByRole('switch', { name: '启用模型 member-readded', exact: true })).toBeChecked()
})

test('configuration cards keep checkbox positions, reveal manual additions, and reopen in persisted join order', async ({ page }) => {
  await page.setViewportSize({ width: 913, height: 742 })
  const dialog = await openEditor(page)
  await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill('配置排序')
  await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl.replace('/v1', '/sorting/v1'))
  const add = async (id: string) => {
    await dialog.getByRole('textbox', { name: '搜索或输入模型 ID', exact: true }).fill(id)
    await dialog.getByRole('button', { name: '添加模型', exact: true }).click()
  }
  await add('saved-B'); await add('saved-A')
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  const provider = page.locator('.st-provider').filter({ hasText: '配置排序' })
  await provider.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(dialog.locator('.st-model-choice-title[aria-expanded="true"]')).toHaveCount(0)
  await dialog.getByRole('button', { name: '拉取模型', exact: true }).click()
  const rows = dialog.locator('.st-model-choice')
  const ids = () => rows.evaluateAll(rows => rows.map(row => row.getAttribute('aria-label')))
  const original = ['saved-A', 'saved-B', 'candidate-2', 'candidate-10', 'model-c', 'model-d']
  await expect.poll(ids).toEqual(original)
  const checkbox = (id: string) => dialog.getByRole('checkbox', { name: `选择模型 ${id}`, exact: true })
  for (const id of ['model-c', 'model-d']) {
    await checkbox(id).focus()
    const before = await checkbox(id).boundingBox()
    await checkbox(id).press('Space')
    await expect(checkbox(id)).toBeChecked()
    await expect(checkbox(id)).toBeFocused()
    expect(await checkbox(id).boundingBox()).toEqual(before)
    await expect(dialog.locator('.st-model-choice-title[aria-expanded="true"]')).toHaveCount(0)
    expect(await ids()).toEqual(original)
  }
  await checkbox('saved-A').press('Space'); await checkbox('saved-A').press('Space')
  expect(await ids()).toEqual(original)
  await dialog.getByRole('button', { name: '拉取模型', exact: true }).click()
  await expect.poll(ids).toEqual(original)
  await add('manual-z')
  await expect(rows.first()).toHaveAttribute('aria-label', 'manual-z')
  await expect(rows.first().getByRole('button', { name: '收起 manual-z 的配置', exact: true })).toBeInViewport()
  await expect(dialog.getByRole('textbox', { name: '搜索或输入模型 ID', exact: true })).toBeFocused()
  await add('saved-A')
  expect(await ids()).toEqual(['manual-z', ...original])
  await dialog.getByRole('button', { name: '保存', exact: true }).click()
  await provider.getByRole('button', { name: '编辑', exact: true }).click()
  await expect.poll(ids).toEqual(['manual-z', 'model-d', 'model-c', 'saved-A', 'saved-B'])
  await expect(dialog.locator('.st-model-choice-title[aria-expanded="true"]')).toHaveCount(0)
  await page.setViewportSize({ width: 1466, height: 742 })
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(dialog).toBeVisible()
})

test('settings apply provider chronology and model switch groups only on the next page visit', async ({ page }) => {
  test.setTimeout(90000)
  await page.setViewportSize({ width: 1466, height: 742 })
  await page.goto(endpoint + '/?settings=models')
  const dialog = page.getByRole('dialog')
  for (const name of ['先加入', '后加入', '最后加入']) {
    await page.getByRole('button', { name: '添加供应商', exact: true }).click()
    await dialog.getByRole('textbox', { name: '连接名称', exact: true }).fill(name)
    await dialog.getByRole('textbox', { name: 'Base URL', exact: true }).fill(baseUrl)
    for (const id of name === '先加入' ? ['model-10', 'model-2', 'model-1'] : ['model-1']) {
      await dialog.getByRole('textbox', { name: '搜索或输入模型 ID', exact: true }).fill(id)
      await dialog.getByRole('button', { name: '添加模型', exact: true }).click()
    }
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeHidden()
  }
  const providers = page.locator('.product-personal-model .st-provider').filter({
    has: page.locator('.st-provider-name').filter({ hasText: /^(先加入|后加入|最后加入)$/ }),
  })
  const names = () => providers.locator('.st-provider-name').allTextContents()
  const first = providers.filter({ hasText: '先加入' })
  const modelIds = () => first.locator('.st-provider-model-name').allTextContents()
  const toggle = async (name: string) => {
    const control = (name.startsWith('启用模型') ? first : page).getByRole('switch', { name, exact: true })
    await control.click(); await expect(control).toBeEnabled()
  }
  const nextVisit = async () => {
    await page.getByRole('navigation', { name: '设置导航' }).getByRole('button', { name: '账户', exact: true }).click()
    await page.getByRole('navigation', { name: '设置导航' }).getByRole('button', { name: '模型', exact: true }).click()
    await expect(page.getByText('正在读取配置…', { exact: true })).toBeHidden()
  }
  const poll = () => page.waitForResponse(response => response.url().endsWith('/models/providers') && response.request().method() === 'GET')
  await expect.poll(names).toEqual(['先加入', '后加入', '最后加入'])
  await expect.poll(modelIds).toEqual(['model-1', 'model-2', 'model-10'])
  await toggle('启用模型 model-1')
  await toggle('启用供应商 后加入'); await toggle('启用供应商 先加入')
  await poll()
  expect(await names()).toEqual(['先加入', '后加入', '最后加入'])
  expect(await modelIds()).toEqual(['model-1', 'model-2', 'model-10'])
  await first.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(dialog.locator('.st-model-choice-title[aria-expanded="true"]')).toHaveCount(0)
  await expect.poll(() => dialog.locator('.st-model-choice').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label'))))
    .toEqual(['model-1', 'model-2', 'model-10'])
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  expect(await modelIds()).toEqual(['model-1', 'model-2', 'model-10'])
  await nextVisit()
  await expect.poll(names).toEqual(['最后加入', '后加入', '先加入'])
  await expect.poll(modelIds).toEqual(['model-2', 'model-10', 'model-1'])
  await toggle('启用供应商 先加入'); await poll()
  expect(await names()).toEqual(['最后加入', '后加入', '先加入'])
  await nextVisit()
  await expect.poll(names).toEqual(['先加入', '最后加入', '后加入'])
  await toggle('启用供应商 先加入'); await poll()
  await nextVisit()
  await expect.poll(names).toEqual(['最后加入', '后加入', '先加入'])
  await page.reload()
  await expect.poll(names).toEqual(['最后加入', '后加入', '先加入'])
})
