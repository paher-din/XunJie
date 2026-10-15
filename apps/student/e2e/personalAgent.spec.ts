import { createHash } from 'node:crypto'
import { expect, test, type Page, type Route } from '@playwright/test'
import { REAL_URL } from './env'

// 合成 HTTP 协议验证：只验证客户端行为，不代表真实模型、HTTPS 宿主或教学效果验收。
test.use({ trace: 'off' })
const at = '2026-10-15T02:00:00.000Z'
const model = { id: 'synthetic-model', contextWindow: '16000', maxOutput: '2048', inputTypes: [], reasoningLevels: ['low', 'high', 'max'] }
const provider = { id: 'synthetic-provider', name: '合成供应商', baseUrl: 'https://synthetic.example/v1', models: [model], hasKey: true, keyHint: '••••test' }
const config = () => ({ revision: 1, enabled: true, callsEnabled: true, defaultModelId: `custom:${provider.id}:${model.id}`, providers: [structuredClone(provider)], efforts: {} as Record<string, string> })
const envelope = (route: Route, data: unknown) => route.fulfill({ json: { requestId: 'synthetic-protocol', data } })
async function install(page: Page, handle: (route: Route, path: string) => Promise<boolean | void>) {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    if (await handle(route, path)) return
    if (path === '/api/session') return envelope(route, { userId: 'alice', courses: [], csrfToken: 'synthetic-csrf' })
    if (path === '/api/agent/conversations') return envelope(route, [])
    await route.fulfill({ status: 404, json: { requestId: 'synthetic-protocol', error: { code: 'NOT_FOUND', message: 'Synthetic missing route', retryable: false, recovery: 'Retry' } } })
  })
}

test('个人模型保存等待后台确认，失败留在表单；明文凭据不进浏览器存储', async ({ page }) => {
  let current = config(), fail = true, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const writes: Record<string, unknown>[] = []
  await page.addInitScript(() => localStorage.setItem('settings.v1', JSON.stringify({ providers: [{ id: 'old', apiKey: 'synthetic-legacy-secret', models: [] }] })))
  await install(page, async (route, path) => {
    if (path !== '/api/model-settings') return false
    if (route.request().method() === 'GET') { await envelope(route, current); return true }
    const body = route.request().postDataJSON()
    writes.push(body)
    expect(route.request().headers()['x-csrf-token']).toBe('synthetic-csrf')
    if (fail) { await route.fulfill({ status: 409, json: { requestId: 'conflict', error: { code: 'VERSION_CONFLICT', message: 'Stale configuration', retryable: false, recovery: 'Read current settings' } } }); return true }
    await held
    current = { ...current, revision: current.revision + 1, providers: body.providers.map((p: typeof provider) => ({ id: p.id, name: p.name, baseUrl: p.baseUrl, models: p.models, hasKey: true, keyHint: '••••test' })) }
    await envelope(route, current); return true
  })
  await page.goto(`${REAL_URL}/#/settings/model`)
  await expect(page.getByText('个人模型已启用', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page.locator('input[type=password]')).toHaveValue('')
  await page.locator('input[type=password]').fill('synthetic-new-secret')
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('alert').last()).toContainText('保存未确认')
  await expect(page.getByRole('dialog')).toBeVisible()
  fail = false
  await page.getByRole('button', { name: '保存', exact: true }).click()
  await expect(page.getByRole('button', { name: '保存中…', exact: true })).toBeDisabled()
  await expect(page.getByRole('dialog')).toBeVisible()
  release()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  expect(writes).toHaveLength(2)
  expect((writes[1].providers as { apiKey: string }[])[0].apiKey).toBe('synthetic-new-secret')
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('secret')
  await page.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(page.locator('input[type=password]')).toHaveValue('')
})

test('真实模式独立聊天走发送、编辑hash、重试、停止和继续协议，设置选择等待ACK', async ({ page }) => {
  let current = config(), conversationId = 'synthetic-conversation', turnSeq = 0, polling = 0, stopped = false
  let holdReply = false
  let messages: { role: 'user' | 'agent'; text: string; at: string; phase?: 'settled' | 'stopped' }[] = []
  const starts: { mode: string; requestKey: string; text?: string }[] = []
  const view = (phase: string) => ({ conversationId, turnId: `synthetic-turn-${turnSeq}`, message: { role: 'agent', text: phase === 'settled' ? '这是合成协议回答' : '实际已收到的部分', at, phase } })
  await install(page, async (route, path) => {
    if (path === '/api/model-settings') {
      if (route.request().method() === 'POST') { const body = route.request().postDataJSON(); current = { ...current, ...body, revision: current.revision + 1, providers: current.providers } }
      await envelope(route, current); return true
    }
    if (path === `/api/agent/conversations/${conversationId}/edit`) {
      const body = route.request().postDataJSON(), original = messages[body.messageIndex]
      expect(body.expectedMessageHash).toBe(createHash('sha256').update(JSON.stringify([original.role, original.text, original.at])).digest('hex'))
      messages = [...messages.slice(0, body.messageIndex), { role: 'user', text: body.text, at }]
      holdReply = true; await envelope(route, { id: conversationId }); return true
    }
    if (path === '/api/agent/turns') {
      const body = route.request().postDataJSON(); starts.push(body)
      expect(body).not.toHaveProperty('apiKey'); expect(body).not.toHaveProperty('assignmentId')
      expect(route.request().headers()['x-csrf-token']).toBe('synthetic-csrf')
      turnSeq++; polling = 0; stopped = false
      if (body.mode === 'send') messages.push({ role: 'user', text: body.text, at })
      else if (messages.at(-1)?.role === 'agent') messages.pop()
      if (body.mode === 'resume') holdReply = false
      await envelope(route, view('streaming')); return true
    }
    if (/\/api\/agent\/turns\/[^/]+\/stop$/.test(path)) { stopped = true; await envelope(route, view('stopped')); return true }
    if (/\/api\/agent\/turns\/[^/]+$/.test(path)) {
      polling++
      const phase = stopped ? 'stopped' : !holdReply && polling > 1 ? 'settled' : 'streaming'
      if (phase !== 'streaming') messages.push({ role: 'agent', text: phase === 'settled' ? '这是合成协议回答' : '实际已收到的部分', at, phase })
      await envelope(route, view(phase)); return true
    }
    if (path === `/api/agent/conversations/${conversationId}`) { await envelope(route, { id: conversationId, title: '合成会话', updatedAt: at, pinned: false, archived: false, contextTokens: 10, messages }); return true }
    return false
  })
  await page.goto(`${REAL_URL}/#/agent`)
  await expect(page.getByRole('button', { name: '切换模型' })).toContainText(model.id)
  await page.getByRole('button', { name: '切换思考强度' }).click()
  await page.getByRole('menuitemradio', { name: '低', exact: true }).click()
  await expect.poll(() => current.efforts[current.defaultModelId]).toBe('低')
  await page.getByRole('textbox', { name: '向 Agent 提问' }).fill('第一个合成问题')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.locator('.chat-message.agent')).toContainText('这是合成协议回答')
  await expect(page).toHaveURL(`${REAL_URL}/#/agent/${conversationId}`)
  await expect(page.locator('.chat-message.user')).toHaveCount(1)
  await page.getByRole('button', { name: '编辑这条消息' }).click()
  await page.getByRole('textbox', { name: '修改这条消息' }).fill('改过的合成问题')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await expect(page.getByRole('button', { name: '停止生成', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '停止生成', exact: true }).click()
  await expect(page.getByRole('button', { name: '继续生成', exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续生成', exact: true }).click()
  await expect(page.locator('.chat-message.agent')).toContainText('这是合成协议回答')
  expect(starts.map(s => s.mode)).toEqual(['send', 'retry', 'resume'])
  expect(new Set(starts.map(s => s.requestKey)).size).toBe(3)
  await expect(page.locator('.chat-message.user')).toHaveCount(1)
  await expect(page.locator('.chat-message.user')).toContainText('改过的合成问题')
})

test('切换路由停止旧回合并拒收迟到回答', async ({ page }) => {
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  let started = false, stopped = false
  const oldView = (phase: string) => ({ conversationId: 'old-conversation', turnId: 'old-turn', message: { role: 'agent', text: '迟到的旧回答', phase } })
  await install(page, async (route, path) => {
    if (path === '/api/model-settings') { await envelope(route, config()); return true }
    if (path === '/api/agent/turns') { started = true; await held; await envelope(route, oldView('streaming')); return true }
    if (path === '/api/agent/turns/old-turn/stop') { stopped = true; await envelope(route, oldView('stopped')); return true }
    if (path === '/api/agent/turns/old-turn') { await envelope(route, oldView(stopped ? 'stopped' : 'streaming')); return true }
    return false
  })
  await page.goto(`${REAL_URL}/#/agent`)
  await page.getByRole('textbox', { name: '向 Agent 提问' }).fill('等待中的原问题')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect.poll(() => started).toBe(true)
  await page.getByRole('button', { name: '新对话', exact: true }).first().click()
  release()
  await expect.poll(() => stopped).toBe(true)
  await expect(page.locator('.chat-message')).toHaveCount(0)
  await expect(page).toHaveURL(`${REAL_URL}/#/agent`)
})


test('轮询断网保留原问题和已经收到的正文，不回退演示回复', async ({ page }) => {
  await install(page, async (route, path) => {
    if (path === '/api/model-settings') { await envelope(route, config()); return true }
    if (path === '/api/agent/turns') {
      await envelope(route, { conversationId: 'accepted-conversation', turnId: 'accepted-turn', message: { role: 'agent', text: '仅有这一部分真实接收正文', phase: 'streaming' } }); return true
    }
    if (path === '/api/agent/turns/accepted-turn') { await route.abort('failed'); return true }
    return false
  })
  await page.goto(`${REAL_URL}/#/agent`)
  await page.getByRole('textbox', { name: '向 Agent 提问' }).fill('断网前发送的原问题')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect(page.getByRole('alert')).toBeVisible()
  await expect(page.locator('.chat-message.user')).toContainText('断网前发送的原问题')
  await expect(page.locator('.chat-message.agent')).toContainText('仅有这一部分真实接收正文')
  await expect(page.locator('.chat-disclaimer')).not.toContainText('模拟')
})


test('退出换账号后拒收旧配置回包，清除会话与模型展示', async ({ page }) => {
  let account: string | null = 'alice', holdRead = false, oldReadStarted = false, release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  await page.addInitScript(() => { AbortController.prototype.abort = () => {} })
  await install(page, async (route, path) => {
    if (path === '/api/session') {
      if (account) await envelope(route, { userId: account, courses: [], csrfToken: 'synthetic-csrf' })
      else await route.fulfill({ status: 401, json: { requestId: 'synthetic', error: { code: 'UNAUTHENTICATED', message: 'Login required', retryable: false, recovery: 'Login' } } })
      return true
    }
    if (path === '/api/logout') { account = null; await envelope(route, { loggedOut: true }); return true }
    if (path === '/api/sessions') { account = route.request().postDataJSON().loginName; await envelope(route, { csrfToken: 'synthetic-csrf' }); return true }
    if (path === '/api/model-settings') {
      const value = account === 'alice' ? config() : { revision: 0, enabled: false, callsEnabled: true, defaultModelId: '', providers: [], efforts: {} }
      if (holdRead) { holdRead = false; oldReadStarted = true; await held }
      await envelope(route, value); return true
    }
    if (path === '/api/agent/conversations') { await envelope(route, account === 'alice' ? [{ id: 'alice-only', title: 'Alice 独有会话', updatedAt: at, pinned: false, archived: false }] : []); return true }
    return false
  })
  await page.goto(`${REAL_URL}/#/settings/model`)
  await expect(page.locator('.st-provider-name', { hasText: '合成供应商' })).toBeVisible()
  holdRead = true
  await page.getByRole('button', { name: '重新读取配置' }).click()
  await expect.poll(() => oldReadStarted).toBe(true)
  await page.locator('.account-pill').click()
  await page.getByRole('menuitem', { name: '退出登录' }).click()
  await page.getByRole('textbox', { name: '账号', exact: true }).fill('bob')
  await page.getByLabel('密码', { exact: true }).fill('synthetic-only')
  await page.getByRole('button', { name: '登录', exact: true }).click()
  await expect(page.getByText('个人模型未启用', { exact: true })).toBeVisible()
  release()
  await expect(page.getByText('合成供应商', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Alice 独有会话', { exact: true })).toHaveCount(0)
  await expect(page.locator('.account-name')).toHaveText('bob')
})


test('首轮完成补上会话地址时排队问题只发送一次并继续显示', async ({ page }) => {
  let allowFirst = false, turn = 0
  const starts: { conversationId: string | null; text: string }[] = []
  const messages: { role: string; text: string; at: string; phase?: string }[] = []
  const response = (phase: string) => ({ conversationId: 'queued-conversation', turnId: `queued-turn-${turn}`, message: { role: 'agent', text: `合成回答 ${turn}`, at, phase } })
  await install(page, async (route, path) => {
    if (path === '/api/model-settings') { await envelope(route, config()); return true }
    if (path === '/api/agent/turns') {
      const body = route.request().postDataJSON(); starts.push(body); turn++
      messages.push({ role: 'user', text: body.text, at })
      await envelope(route, response('streaming')); return true
    }
    if (/\/api\/agent\/turns\//.test(path)) {
      const phase = turn === 1 && !allowFirst ? 'streaming' : 'settled'
      if (phase === 'settled') messages.push({ role: 'agent', text: `合成回答 ${turn}`, at, phase })
      await envelope(route, response(phase)); return true
    }
    if (path === '/api/agent/conversations/queued-conversation') { await envelope(route, { id: 'queued-conversation', title: '排队测试', updatedAt: at, messages, contextTokens: 1 }); return true }
    return false
  })
  await page.goto(`${REAL_URL}/#/agent`)
  const input = page.getByRole('textbox', { name: '向 Agent 提问' })
  await input.fill('第一个问题')
  await page.getByRole('button', { name: '发送消息', exact: true }).click()
  await expect.poll(() => starts.length).toBe(1)
  await input.fill('排队的第二个问题')
  await input.press('Enter')
  await expect(page.locator('.queue-tip')).toContainText('已加入队列')
  allowFirst = true
  await expect.poll(() => starts.length).toBe(2)
  await expect(page.locator('.chat-message.agent').last()).toContainText('合成回答 2')
  await expect(page.locator('.chat-message.user')).toHaveCount(2)
  expect(starts[1].conversationId).toBe('queued-conversation')
})


test('服务端未返回实际用量时不显示零用量或演示容量环', async ({ page }) => {
  await install(page, async (route, path) => {
    if (path === '/api/model-settings') { await envelope(route, config()); return true }
    if (path === '/api/agent/conversations/unknown-usage') {
      await envelope(route, { id: 'unknown-usage', title: '用量未知的会话', updatedAt: at, messages: [
        { role: 'user', text: '已有原问题', at }, { role: 'agent', text: '已有模型回答', at, phase: 'settled' },
      ] }); return true
    }
    return false
  })
  await page.goto(`${REAL_URL}/#/agent/unknown-usage`)
  await expect(page.locator('.chat-message.agent')).toContainText('已有模型回答')
  await expect(page.locator('.ctx-ring')).toHaveCount(0)
  await expect(page.locator('.chat-disclaimer')).not.toContainText('实际用量')
})
