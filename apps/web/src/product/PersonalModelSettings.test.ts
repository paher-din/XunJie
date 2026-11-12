import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { createRequire } from 'node:module'
import { act, createElement, Fragment } from 'react'
import type { Root } from 'react-dom/client'
import type { ModelAttempt, ModelConnection, ModelProvider, SaveModelProvider } from '@xunjie/contracts/model-connections'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import type { ModelSelectionController } from './ModelSelection'
import { LearningReadCache } from './learning-read-cache'

// Use the real React/Radix tree. Only the browser host, transport and polling clock
// are controlled; SSR cannot exercise the interleaved actions behind STD-02/SPC-02.
const { JSDOM } = createRequire(import.meta.url)('jsdom')
let dom: ReturnType<typeof JSDOM>, root: Root
let PersonalModelSettings: typeof import('./PersonalModelSettings').PersonalModelSettings
let createRoot: typeof import('react-dom/client').createRoot
let feedback: typeof import('@xunjie/ui/feedback')
const identity: SpaceIdentity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), kind: 'personal', name: '测试用户' }
const initial: ModelConnection = { connectionId: crypto.randomUUID(), name: '原配置', baseUrl: 'https://synthetic.invalid/v1',
  protocol: 'chat-completions', path: '/chat/completions', modelId: 'synthetic', dialect: 'standard', parameterMode: 'plain', enabled: true,
  version: 1, routeId: crypto.randomUUID(), hasCredential: true, adapterState: 'ready',
  capabilities: { text: 'unknown', images: 'unknown', tools: 'unknown', strictSchema: 'unknown' } }
let server: ModelConnection, saves: SaveModelProvider[], checks: ModelAttempt[], rejectCheck: boolean
let rejectSave: '' | 'before' | 'after' | 'invalid' | 'forbidden' | 'identity-conflict'
let holdRead: Promise<void> | undefined, holdSave: Promise<void> | undefined
let readFailure: boolean
const originalKey = 'synthetic-saved-key'
let serverKey: string, credentialFailure: boolean
let receipts: Map<string, { input: string; result: ModelProvider }>
let extraModels: ModelConnection[]
let deleted: boolean, loseDeleteReceipt: boolean, deleteRequests: { requestId: string; expectedVersion: number }[]
let connectionStatus: 'passed' | 'failed', holdConnection: Promise<void> | undefined
const providerOf = (model: ModelConnection): ModelProvider => ({ providerId: model.connectionId, version: model.version,
  name: model.name, baseUrl: model.baseUrl, protocol: model.protocol, enabled: model.providerEnabled ?? true,
  hasCredential: model.hasCredential, models: [model, ...structuredClone(extraModels)] })
const selection: ModelSelectionController = { selection: { version: 0, selected: null, options: [] }, error: '', busy: false, stale: false,
  reload: vi.fn(async () => {}), choose: vi.fn(async () => {}) }
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const alerts = () => [...document.querySelectorAll('[data-sonner-toast][data-type="error"], [role="alert"]')].map(element => element.textContent).join('\n')
function button(label: string, scope: ParentNode = document) {
  const element = [...scope.querySelectorAll('button')].find(element => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === label)
  expect(element, `button ${label}`).toBeDefined()
  return element!
}
const click = async (label: string, scope?: ParentNode) => {
  await act(async () => { button(label, scope).click(); await settle() })
  await act(async () => { await settle() })
  if (label === '编辑') await act(async () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[role="dialog"] .st-model-choice[data-selected] .st-model-choice-title[aria-expanded="false"]')) button.click()
    await settle()
  })
}
const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
async function type(label: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field(label), value)
    field(label).dispatchEvent(new dom.window.Event('input', { bubbles: true })); await settle()
  })
}
const poll = async () => {
  await act(async () => { vi.advanceTimersByTime(15000); await settle() })
  await act(async () => { await settle() })
}
async function mount(subject = identity) {
  await act(async () => { root.render(createElement(Fragment, null, createElement(feedback.Toaster), createElement(PersonalModelSettings, { identity: subject, spaceKey: 'personal', namespace: 'test', onBack() {}, selection }))); await settle() })
  await act(async () => { await settle() })
}

it('lists the school as a supplier and checks its model without selecting or granting it', async () => {
  const previous = selection.selection
  selection.selection = { version: 0, selected: null, options: [{ kind: 'school', connection: { ...initial, name: '学校统一服务' },
    policy: { checksAllowed: true, maxChecksPerHour: 4, maxOutputTokens: 64, timeoutMs: 10000 } }] }
  try {
    await mount()
    const card = [...document.querySelectorAll('.st-provider')].find(item => item.querySelector('.st-provider-name')?.textContent === '学校')!
    expect(card).toBeDefined()
    expect(card.querySelector('.st-provider-url')).toBeNull()
    expect(card.querySelector('[role="switch"]')).toBeNull()
    expect(document.querySelector('[aria-label="当前空间模型"]')).toBeNull()
    await click('模型测试', card)
    expect(document.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toContain('模型测试未完成：检查频次或并发已达上限')
    const check = vi.mocked(fetch).mock.calls.find(([url, init]) => String(url).endsWith('/models/checks') && init?.method === 'POST')!
    expect(JSON.parse(check[1]!.body as string).source).toEqual({ school: { connectionId: initial.connectionId, version: initial.version } })
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).includes('/models/grants'))).toBe(false)
  } finally { selection.selection = previous }
})

it('refreshes model information when the model pane is entered, while hidden settings do not trigger it', async () => {
  await act(async () => { root.render(null); await settle() })
  vi.mocked(fetch).mockClear()
  await act(async () => {
    root.render(createElement('section', { hidden: true, 'data-settings-section': 'account' },
      createElement(PersonalModelSettings, { identity, spaceKey: 'personal', namespace: 'test', onBack() {}, selection })))
    await settle()
  })
  const requests = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/models/directory'))
  const configurations = () => vi.mocked(fetch).mock.calls.filter(([url]) => /\/models\/(providers|checks)$/.test(String(url)))
  const agentSettings = () => vi.mocked(fetch).mock.calls.filter(([url]) => /\/(skills|agent-settings)$/.test(String(url)))
  expect(requests()).toHaveLength(0)
  expect(configurations()).toHaveLength(0)
  expect(agentSettings()).toHaveLength(0)
  await poll()
  expect(configurations()).toHaveLength(0)
  const pane = document.querySelector('section')!
  await act(async () => { pane.hidden = false; pane.dataset.settingsSection = 'models'; await settle() })
  expect(requests().some(([, init]) => JSON.parse(init!.body as string).refresh === true)).toBe(true)
  expect(configurations()).toHaveLength(2)
  expect(agentSettings()).toHaveLength(0)
  const before = requests().length
  await act(async () => { pane.hidden = true; pane.dataset.settingsSection = 'account'; await settle() })
  const beforeConfigurations = configurations().length
  await poll()
  expect(configurations()).toHaveLength(beforeConfigurations)
  expect(requests()).toHaveLength(before)
  await act(async () => { pane.hidden = false; pane.dataset.settingsSection = 'models'; await settle() })
  expect(requests().length).toBeGreaterThan(before)
  await act(async () => { pane.dataset.settingsSection = 'agent'; await settle() })
  expect(agentSettings()).toHaveLength(2)
})

it('does not notify the account pane when a model read fails after leaving model settings', async () => {
  await act(async () => { root.render(null); await settle() })
  let release!: () => void
  holdRead = new Promise(resolve => { release = resolve })
  await act(async () => {
    root.render(createElement(Fragment, null, createElement(feedback.Toaster),
      createElement('section', { 'data-settings-section': 'models' },
        createElement(PersonalModelSettings, { identity, spaceKey: 'personal', namespace: 'test', onBack() {}, selection }))))
    await settle()
  })
  const pane = document.querySelector('section')!
  await act(async () => { pane.hidden = true; pane.dataset.settingsSection = 'account'; await settle() })
  readFailure = true
  await act(async () => { release(); await settle() })
  holdRead = undefined
  expect(alerts()).not.toContain('连接或相应适配器不可用')
})

it('keeps idle settings quiet and refreshes after returning to the window', async () => {
  const count = () => vi.mocked(fetch).mock.calls.filter(([path]) => /\/models\/(providers|checks)$/.test(String(path))).length
  const before = count()
  await act(async () => { vi.advanceTimersByTime(4000); await settle() })
  expect(count()).toBe(before)
  await act(async () => { window.dispatchEvent(new dom.window.Event('focus')); await settle() })
  expect(count()).toBe(before + 2)
})

it('shows the cached suppliers immediately while a revisit is still checking the server', async () => {
  const cache = new LearningReadCache()
  cache.set('personal', JSON.stringify(['model-settings', 'test', identity.environmentId, identity.spaceId, identity.principalId]),
    { providers: [providerOf(server)], attempts: [] })
  await act(async () => { root.render(null); await settle() })
  holdRead = new Promise(() => {})
  await act(async () => {
    root.render(createElement(PersonalModelSettings, { identity, spaceKey: 'personal', namespace: 'test', onBack() {}, selection, cache }))
    await settle()
  })
  expect(document.querySelector('.st-provider-name')?.textContent).toBe('原配置')
  expect(document.body.textContent).not.toContain('正在读取模型')
})

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://settings.invalid', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement',
    'Element', 'Node', 'NodeFilter', 'Event', 'MouseEvent', 'FocusEvent', 'CustomEvent', 'MutationObserver', 'DocumentFragment'])
    vi.stubGlobal(name, dom.window[name])
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  vi.stubGlobal('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window))
  vi.stubGlobal('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  dom.window.matchMedia ??= vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} })
  dom.window.HTMLElement.prototype.scrollIntoView ??= vi.fn()
  ;({ createRoot } = await import('react-dom/client'))
  feedback = await import('@xunjie/ui/feedback')
  ;({ PersonalModelSettings } = await import('./PersonalModelSettings'))
})
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  server = structuredClone(initial); saves = []; checks = []; receipts = new Map(); rejectCheck = true
  extraModels = []
  deleted = false; loseDeleteReceipt = false; deleteRequests = []; connectionStatus = 'passed'; holdConnection = undefined
  rejectSave = ''; holdRead = undefined; holdSave = undefined; readFailure = false; serverKey = originalKey; credentialFailure = false
  vi.mocked(selection.reload).mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn(async (input: string, options: RequestInit = {}) => {
    const path = input.split('/models/')[1], method = options.method ?? 'GET'
    if (input === '/api/learning/agent-settings' && method === 'GET') return response({ version: 0, busyInputMode: 'steering' })
    if (input === '/api/learning/skills' && method === 'GET') return response({ skills: [], selections: [] })
    if (method === 'GET') {
      const value = path === 'providers' ? deleted ? [] : [providerOf(structuredClone(server))] : structuredClone(checks)
      await holdRead
      return readFailure ? response({ error: 'unavailable' }, 503) : response(value)
    }
    const body = JSON.parse(options.body as string)
    if (path === 'providers/test-connection') {
      await (options.signal ? Promise.race([holdConnection, new Promise((_, reject) => {
        options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      })]) : holdConnection)
      return response({ status: connectionStatus, baseUrl: server.baseUrl, endpoint: server.baseUrl + '/models', protocol: server.protocol, elapsedMs: 50,
        ...(connectionStatus === 'failed' ? { diagnostic: { code: 'authentication', message: '当前密钥没有权限。', suggestion: '请检查账号权限。' } } : {}) })
    }
    if (path === `providers/${server.connectionId}/delete`) {
      deleteRequests.push(body); deleted = true
      if (loseDeleteReceipt) { loseDeleteReceipt = false; throw new TypeError('synthetic delete ACK loss') }
      return response({ providerId: server.connectionId })
    }
    if (path === 'directory') return response({ models: [], catalogue: { status: 'ready' } })
    if (path.endsWith('/credential')) return credentialFailure ? response({ error: 'unavailable' }, 503)
      : body.version !== server.version ? response({ error: 'conflict' }, 409)
        : response({ connectionId: server.connectionId, version: server.version, value: serverKey })
    if (path === 'profiles') return response({ profiles: [{ modelId: server.modelId, dialect: 'standard', efforts: ['auto'], source: 'unknown' }], stale: false })
    if (path === 'providers') {
      saves.push(structuredClone(body)); const failure = rejectSave; rejectSave = ''
      if (failure === 'before') throw new TypeError('synthetic transport loss')
      if (failure === 'invalid' || failure === 'forbidden' || failure === 'identity-conflict') return response({ error: failure }, failure === 'forbidden' ? 403 : 409)
      const prior = receipts.get(body.requestId)
      if (prior) return prior.input === JSON.stringify(body) ? response(prior.result) : response({ error: 'identity-conflict' }, 409)
      if (body.expectedVersion !== server.version) return response({ error: 'conflict' }, 409)
      const { requestId: _id, expectedVersion: _version, credential, models, providerId, enabled, ...configuration } = body
      const { expectedVersion: _modelVersion, enabled: modelEnabled, ...model } = models[0]
      server = { ...server, ...configuration, ...model, providerId, providerEnabled: enabled, modelEnabled, enabled: enabled && modelEnabled, version: server.version + 1,
        hasCredential: credential.action === 'keep' ? server.hasCredential : credential.action === 'replace' }
      extraModels = models.slice(1).map(({ expectedVersion, ...item }: SaveModelProvider['models'][number]) => ({ ...server, ...item,
        version: expectedVersion + 1, routeId: extraModels.find(old => old.connectionId === item.connectionId)?.routeId ?? crypto.randomUUID(),
        modelEnabled: item.enabled, enabled: enabled && item.enabled }))
      if (credential.action !== 'keep') serverKey = credential.action === 'replace' ? credential.value : ''
      receipts.set(body.requestId, { input: JSON.stringify(body), result: providerOf(structuredClone(server)) })
      await holdSave
      if (failure === 'after') throw new TypeError('synthetic ACK loss')
      return response(providerOf(server))
    }
    if (path === 'checks') {
      if (rejectCheck) return response({ error: 'resource-busy' }, 409)
      const accepted: ModelAttempt = { attemptId: body.attemptId, purpose: 'connection-check', connection: server, limits: body.limits,
        state: 'accepted', dispatched: false, cancelRequested: false, physicalRequestEnded: true, upstreamStopped: 'unknown',
        text: '', usage: { state: 'unknown' }, reason: '', requestRef: crypto.randomUUID(), resultRef: null, createdAt: new Date().toISOString() }
      checks = [accepted]; return response(accepted)
    }
    if (path.endsWith('/dispatch')) { checks = [{ ...checks[0], state: 'completed', dispatched: true }]; return response(checks[0]) }
    throw new Error('Unexpected route: ' + path)
  }))
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  await mount()
})
afterEach(async () => {
  await act(async () => { feedback.toast.dismiss(); root.unmount(); await settle() })
  document.body.innerHTML = ''; vi.useRealTimers()
})
afterAll(() => { dom.window.close(); vi.unstubAllGlobals() })

it.each(['passed', 'failed'] as const)('tests the saved supplier with a credential reference and shows %s only in Sonner', async status => {
  connectionStatus = status
  const card = document.querySelector('[aria-label="个人连接配置"] .st-provider')!
  await click('连接测试', card)
  const submitted = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith('/providers/test-connection'))!
  expect(JSON.parse(submitted[1]!.body as string)).toMatchObject({ baseUrl: server.baseUrl, protocol: server.protocol,
    credential: { action: 'keep' }, savedCredential: { connectionId: server.connectionId, version: server.version } })
  expect(JSON.stringify(submitted)).not.toContain(originalKey)
  expect(vi.mocked(fetch).mock.calls.some(([url, init]) => String(url).endsWith('/credential') || String(url).endsWith('/checks') && init?.method === 'POST')).toBe(false)
  expect(card.querySelector('.st-model-test-feedback')).toBeNull()
  expect(document.querySelector(`[data-sonner-toast][data-type="${status === 'passed' ? 'success' : 'error'}"]`)?.textContent)
    .toContain(status === 'passed' ? '原配置：连接测试通过' : '原配置：连接测试未通过')
  if (status === 'failed') expect(alerts()).toContain('请检查账号权限。')
})

it('stops a supplier test through the same button and keeps its layout and focus', async () => {
  holdConnection = new Promise(() => {})
  const trigger = button('连接测试')
  await act(async () => { trigger.focus(); await settle() })
  await click('连接测试')
  expect(button('停止连接测试')).toBe(trigger)
  await click('停止连接测试')
  expect(button('连接测试')).toBe(trigger)
  expect(document.activeElement).toBe(trigger)
  expect(document.querySelector('[data-sonner-toast][data-type="info"]')?.textContent).toContain('连接测试已停止')
})

it('cancels deletion without a request, then removes the supplier and refreshes model choices', async () => {
  const trigger = button('删除供应商 原配置'); trigger.focus()
  await click('删除供应商 原配置'); await click('取消')
  expect(deleteRequests).toHaveLength(0)
  expect(document.activeElement).toBe(trigger)
  await click('删除供应商 原配置'); await click('删除', document.querySelector('[role="dialog"]')!)
  expect(deleteRequests).toHaveLength(1)
  expect(deleteRequests[0]).toMatchObject({ expectedVersion: server.version })
  expect(document.querySelector('[aria-label="个人连接配置"] .st-provider')).toBeNull()
  expect(selection.reload).toHaveBeenCalledOnce()
  expect(document.activeElement).toBe(button('添加供应商'))
})

it('reuses the deletion identity after a lost receipt, even when polling has already removed the card', async () => {
  loseDeleteReceipt = true
  await click('删除供应商 原配置'); await click('删除', document.querySelector('[role="dialog"]')!)
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  await poll()
  expect(document.querySelector('[aria-label="个人连接配置"] .st-provider')).toBeNull()
  await click('删除', document.querySelector('[role="dialog"]')!)
  expect(deleteRequests).toHaveLength(2)
  expect(deleteRequests[1]).toEqual(deleteRequests[0])
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

async function mountModelPane() {
  await act(async () => { root.render(null); await settle() })
  await act(async () => {
    root.render(createElement('section', { 'data-settings-section': 'models' },
      createElement(PersonalModelSettings, { identity, spaceKey: 'personal', namespace: 'test', onBack() {}, selection })))
    await settle()
  })
  await act(async () => { await settle() })
  return document.querySelector<HTMLElement>('section[data-settings-section]')!
}
async function revisit(pane: HTMLElement) {
  await act(async () => { pane.dataset.settingsSection = 'account'; await settle() })
  await act(async () => { pane.dataset.settingsSection = 'models'; await settle() })
  await act(async () => { await settle() })
}
const modelRows = () => [...document.querySelectorAll('.st-provider-model-row')].map(row => row.getAttribute('aria-label'))

it('shows at most four models until expanded, keeps transient toggles silent, and disables model controls on an inactive supplier', async () => {
  extraModels = ['model-2', 'model-3', 'model-4', 'model-5'].map(modelId => ({ ...server,
    connectionId: crypto.randomUUID(), modelId, modelEnabled: true, enabled: true }))
  await act(async () => { root.render(null); await settle() })
  await mount()
  expect(modelRows()).toEqual(['model-2', 'model-3', 'model-4', 'model-5'])
  expect(button('全部（5）')).toBeDefined()
  await click('全部（5）')
  expect(modelRows()).toEqual(['model-2', 'model-3', 'model-4', 'model-5', 'synthetic'])
  const card = document.querySelector('[aria-label="个人连接配置"] .st-provider')!
  let releaseSave!: () => void
  holdSave = new Promise<void>(resolve => { releaseSave = resolve })
  await act(async () => { document.querySelector<HTMLButtonElement>('button[aria-label="启用供应商 原配置"]')!.click(); await settle() })
  expect(card.textContent).not.toContain('正在保存')
  expect(button('启用供应商 原配置', card).hasAttribute('disabled')).toBe(true)
  expect(saves).toHaveLength(1)
  await act(async () => { releaseSave(); holdSave = undefined; await settle() })
  expect(card.classList.contains('st-provider-inactive')).toBe(true)
  expect([...card.querySelectorAll('[role="switch"]')].map(toggle => toggle.hasAttribute('disabled'))).toEqual([false, true, true, true, true, true])
  expect([...card.querySelectorAll('button[aria-label="模型测试"]')].every(item => (item as HTMLButtonElement).disabled)).toBe(true)
})

it('delays model regrouping until the next visit, preserves individual switch groups and keeps canonical dialog order', async () => {
  server.modelId = 'model-10'
  extraModels = [
    { ...server, connectionId: crypto.randomUUID(), modelId: 'model-2', modelEnabled: true },
    { ...server, connectionId: crypto.randomUUID(), modelId: 'model-1', modelEnabled: false, enabled: false },
  ]
  const pane = await mountModelPane()
  expect(modelRows()).toEqual(['model-2', 'model-10', 'model-1'])
  await click('启用模型 model-2')
  await click('启用模型 model-1')
  expect(modelRows()).toEqual(['model-2', 'model-10', 'model-1'])
  await poll()
  expect(modelRows()).toEqual(['model-2', 'model-10', 'model-1'])
  expect(saves[0]!.models.map(model => model.modelId)).toEqual(['model-10', 'model-2', 'model-1'])
  await click('编辑')
  expect([...document.querySelectorAll('[role="dialog"] .st-model-choice')].map(row => row.getAttribute('aria-label')))
    .toEqual(['model-10', 'model-2', 'model-1'])
  await click('关闭')
  expect(modelRows()).toEqual(['model-2', 'model-10', 'model-1'])
  await click('启用供应商 原配置')
  await poll()
  expect(modelRows()).toEqual(['model-2', 'model-10', 'model-1'])
  await revisit(pane)
  expect(modelRows()).toEqual(['model-1', 'model-10', 'model-2'])
  expect(document.querySelector('[aria-label="启用模型 model-1"]')!.getAttribute('aria-checked')).toBe('true')
})

it('holds provider positions across toggle receipts and polls, then applies canonical order on each new visit', async () => {
  const createProvider = (name: string): ModelProvider => ({ ...providerOf(initial), providerId: crypto.randomUUID(), name,
    models: [{ ...initial, connectionId: crypto.randomUUID(), name, modelEnabled: true }] })
  let data = ['first', 'second', 'third'].map(createProvider)
  const joinOrder = data.map(provider => provider.providerId), disabled = new Map<string, number>()
  let closes = 0
  const originalFetch = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation(async (url, options = {}) => {
    if (!String(url).endsWith('/models/providers')) return originalFetch(url, options)
    if (options.method === 'POST') {
      const input = JSON.parse(options.body as string) as SaveModelProvider
      const previous = data.find(provider => provider.providerId === input.providerId)!
      if (previous.enabled && !input.enabled) disabled.set(input.providerId, ++closes)
      const saved: ModelProvider = { ...previous, enabled: input.enabled, version: previous.version + 1,
        models: input.models.map(model => ({ ...previous.models.find(saved => saved.connectionId === model.connectionId)!,
          modelEnabled: model.enabled, enabled: input.enabled && model.enabled, version: model.expectedVersion + 1 })) }
      data = data.map(provider => provider.providerId === saved.providerId ? saved : provider).sort((left, right) =>
        Number(right.enabled) - Number(left.enabled) || (left.enabled
          ? joinOrder.indexOf(left.providerId) - joinOrder.indexOf(right.providerId)
          : disabled.get(left.providerId)! - disabled.get(right.providerId)!))
      return response(saved)
    }
    await holdRead
    return response(data)
  })
  const pane = await mountModelPane()
  const names = () => [...document.querySelectorAll('.st-provider-name')].map(row => row.textContent)
  expect(names()).toEqual(['first', 'second', 'third'])
  await click('启用供应商 second'); await click('启用供应商 first')
  await poll()
  expect(names()).toEqual(['first', 'second', 'third'])
  await revisit(pane)
  expect(names()).toEqual(['third', 'second', 'first'])
  await click('启用供应商 first'); await poll()
  expect(names()).toEqual(['third', 'second', 'first'])
  await revisit(pane)
  expect(names()).toEqual(['first', 'third', 'second'])
  await click('启用供应商 first'); await poll()
  expect(names()).toEqual(['first', 'third', 'second'])
  await revisit(pane)
  expect(names()).toEqual(['third', 'second', 'first'])
})

describe('personal model settings recovery through real React controls', () => {
  it('keeps provider and model switches independent without reading or resending the key', async () => {
    const toggle = async (label: string) => { await act(async () => { document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(); await settle() }) }
    await toggle('启用供应商 原配置')
    expect(server.enabled).toBe(false); expect(server.providerEnabled).toBe(false); expect(server.modelEnabled).toBe(true)
    expect(document.querySelector('[aria-label="启用模型 synthetic"]')!.getAttribute('aria-checked')).toBe('true')
    expect(button('模型测试').disabled).toBe(true)
    expect(button('启用模型 synthetic').disabled).toBe(true)
    await toggle('启用供应商 原配置'); await toggle('启用模型 synthetic')
    expect(server.providerEnabled).toBe(true); expect(server.modelEnabled).toBe(false); expect(server.enabled).toBe(false)
    expect(saves.every(input => input.credential.action === 'keep')).toBe(true)
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).endsWith('/credential'))).toBe(false)
  })

  it('adds a second model with its own effort and retains the existing model in one save', async () => {
    await click('添加模型'); await type('搜索或输入模型 ID', 'gpt-5.2')
    await act(async () => {
      document.querySelector('input[aria-label="搜索或输入模型 ID"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); await settle()
    })
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[aria-label="模型 ID的默认思考强度"]')!.click(); await settle()
    })
    await act(async () => {
      const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.trim() === '高 · high')!
      option.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 })); option.click(); await settle()
    })
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('方言')
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('参数模式')
    await click('保存')
    expect(saves[0].models.map(model => [model.modelId, model.reasoningEffort])).toEqual([['gpt-5.2', 'high'], ['synthetic', undefined]])
    expect(saves[0].credential).toEqual({ action: 'replace', value: originalKey })
    expect(document.querySelector('[aria-label="启用模型 gpt-5.2"]')).not.toBeNull()
    expect(document.querySelectorAll('[aria-label="个人连接配置"] .st-provider')).toHaveLength(1)
  })

  it.each(['before', 'after'] as const)('reconciles a %s-commit switch failure using the identical request', async failure => {
    rejectSave = failure
    await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="启用供应商 原配置"]')!.click(); await settle() })
    expect(document.querySelector<HTMLButtonElement>('[aria-label="启用供应商 原配置"]')!.disabled).toBe(true)
    await click('核对开关提交')
    expect(saves[1]).toEqual(saves[0]); expect(server.version).toBe(2); expect(server.providerEnabled).toBe(false)
    expect(document.querySelector<HTMLButtonElement>('[aria-label="启用供应商 原配置"]')!.disabled).toBe(false)
  })

  it('loads the saved key masked, reveals it, and saves replacement or empty input exactly as edited', async () => {
    await click('编辑')
    expect(field('API Key').value).toBe(originalKey)
    expect(field('API Key').type).toBe('password')
    const reveal = () => document.querySelector<HTMLButtonElement>('button[aria-label="显示 API Key"]')!
    await act(async () => { reveal().click(); await settle() })
    expect(field('API Key').type).toBe('text')
    expect(field('API Key').value).toBe(originalKey)
    await type('API Key', 'synthetic-new-key'); await click('保存'); await click('编辑')
    expect(field('API Key').type).toBe('password')
    expect(field('API Key').value).toBe('synthetic-new-key')
    await type('API Key', ''); await click('保存'); await click('编辑')
    expect(field('API Key').value).toBe('')
    expect(server.hasCredential).toBe(false)
    expect(serverKey).toBe('')
  })

  it('blocks save and check after a credential read failure until an explicit retry succeeds', async () => {
    credentialFailure = true; await click('编辑')
    expect(button('保存').disabled).toBe(true)
    expect(button('模型测试', document.querySelector('[role="dialog"]')!).disabled).toBe(true)
    expect(field('API Key').disabled).toBe(true)
    expect(alerts()).toContain('未能读取已保存的密钥')
    expect(saves).toHaveLength(0)
    credentialFailure = false; await click('重新读取密钥')
    expect(field('API Key').value).toBe(originalKey)
    expect(button('保存').disabled).toBe(false)
  })

  it('shows deterministic URL errors inline without sending a save, and accepts corrected input', async () => {
    await click('编辑'); await type('Base URL', 'https://synthetic.invalid/v1/chat/completions'); await click('保存')
    expect(field('Base URL').getAttribute('aria-invalid')).toBe('true')
    expect(alerts()).toContain('请去掉末尾 /chat/completions')
    expect(saves).toHaveLength(0)
    await type('Base URL', 'https://synthetic.invalid/custom')
    expect(field('Base URL').getAttribute('aria-invalid')).toBe('false')
    await click('保存'); expect(saves).toHaveLength(1)
  })

  it('checks the acknowledged version immediately and ignores pre-save reads without pinning future restored data', async () => {
    await click('编辑'); await type('连接名称', '已确认配置')
    let releaseOld!: () => void, releaseFresh!: () => void
    holdRead = new Promise(resolve => { releaseOld = resolve })
    await poll() // Capture version 1 before the save, but deliver it after the ACK.
    holdRead = new Promise(resolve => { releaseFresh = resolve })
    try {
      await click('保存')
      expect(document.querySelector('[role="dialog"]')).toBeNull()
      const card = document.querySelector('[aria-label="个人连接配置"] .st-provider')!
      expect(card.textContent).toContain('已确认配置')
      rejectCheck = false
      await click('模型测试', card)
      const submittedSource = () => JSON.parse(vi.mocked(fetch).mock.calls.filter(([path, options]) =>
        String(path).endsWith('/models/checks') && options?.method === 'POST').at(-1)![1]!.body as string).source
      expect(submittedSource()).toEqual({ connectionId: initial.connectionId, version: 2 })
      await act(async () => { releaseOld(); await settle() })
      expect(card.textContent).toContain('已确认配置')
      await click('模型测试', card)
      expect(submittedSource()).toEqual({ connectionId: initial.connectionId, version: 2 })
      await act(async () => { releaseFresh(); await settle() }); holdRead = undefined
      server = { ...initial, name: '恢复的配置' }; await poll()
      expect(card.textContent).toContain('恢复的配置')
      expect(card.textContent).not.toContain('已确认配置')
    } finally {
      await act(async () => { releaseOld(); releaseFresh(); await settle() }); holdRead = undefined
    }
  })

  it('preserves an action error through late reads and polls; clears it on successful related retry', async () => {
    const notify = vi.spyOn(feedback.toast, 'error')
    let release!: () => void; holdRead = new Promise(resolve => { release = resolve })
    await poll(); await click('模型测试')
    expect(alerts()).toContain('检查频次或并发已达上限')
    await act(async () => { release(); await settle() }); holdRead = undefined
    await poll(); await poll()
    expect(alerts()).toContain('检查频次或并发已达上限')
    expect(notify).toHaveBeenCalledTimes(1)
    rejectCheck = false; await click('模型测试')
    expect(notify).toHaveBeenCalledTimes(1)
    rejectCheck = true; await click('模型测试')
    expect(notify).toHaveBeenCalledTimes(2)
    notify.mockRestore()
  })

  it('invalidates an old test result when polling discovers a changed model configuration', async () => {
    rejectCheck = false
    await click('模型测试')
    const card = document.querySelector('[aria-label="个人连接配置"] .st-provider')!
    expect(card.querySelector('.st-model-test-feedback')).toBeNull()
    expect(document.querySelectorAll('[data-sonner-toast][data-type="success"]')).toHaveLength(1)
    await poll()
    expect(card.querySelector('.st-model-test-feedback')).toBeNull()
    server = { ...server, version: 2, maxOutputTokens: 32768 }
    await poll()
    expect(card.querySelector('.st-model-test-feedback')).toBeNull()
    expect(checks).toHaveLength(1)
  })

  it('does not stack background reads when the previous poll is slow, then picks up later changes', async () => {
    let releaseFirst!: () => void
    server = { ...server, name: '较早读取' }
    holdRead = new Promise(resolve => { releaseFirst = resolve }); await poll()
    const reads = () => vi.mocked(fetch).mock.calls.filter(([path]) => String(path).endsWith('/models/providers')).length
    const before = reads()
    server = { ...server, name: '仍在读取' }
    await poll(); await poll()
    try {
      expect(reads()).toBe(before)
      await act(async () => { releaseFirst(); await settle() }); holdRead = undefined
      const card = document.querySelector('[aria-label="个人连接配置"] .st-provider')!
      expect(card.textContent).toContain('较早读取')
      await poll()
      expect(card.textContent).toContain('仍在读取')
    } finally {
      await act(async () => { releaseFirst(); await settle() }); holdRead = undefined
    }
  })

  it('clears recovered read errors without erasing an action failure', async () => {
    await click('模型测试'); readFailure = true; await poll()
    expect(alerts()).toContain('连接或相应适配器不可用')
    readFailure = false; await poll()
    expect(document.querySelector('[aria-label="个人连接配置"]')?.textContent).not.toContain('连接或相应适配器不可用')
    expect(alerts()).toContain('检查频次或并发已达上限')
  })

  it('drops old subject errors, drafts and late responses after an identity change', async () => {
    await click('模型测试'); await click('编辑'); await type('连接名称', '旧主体草稿')
    let release!: () => void; holdRead = new Promise(resolve => { release = resolve }); await poll()
    server = { ...server, name: '新主体配置' }
    await mount({ ...identity, principalId: crypto.randomUUID() })
    await act(async () => { release(); await settle() }); holdRead = undefined
    expect(document.querySelector('[aria-label="个人连接配置"]')?.textContent).not.toContain('检查频次或并发已达上限')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).toContain('新主体配置')
    expect(document.body.textContent).not.toContain('旧主体草稿')
  })

  it.each(['unchanged', 'replace', 'clear'] as const)('refreshes and confirms CAS without closing or losing the %s input value', async action => {
    await click('编辑'); await type('连接名称', '本地草稿')
    if (action === 'replace') await type('API Key', 'synthetic-replacement')
    if (action === 'clear') await type('API Key', '')
    server = { ...server, name: '另一标签配置', modelId: 'other-model', version: 2 }; await poll()
    await click('保存'); expect(saves[0].expectedVersion).toBe(1)
    expect(alerts()).toContain('版本冲突')
    expect(button('保存').disabled).toBe(true)
    await poll(); expect(saves).toHaveLength(1)
    await click('读取最新版本')
    expect(field('连接名称').value).toBe('本地草稿')
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('另一标签配置')
    expect(document.querySelector('[role="dialog"]')!.textContent).toContain('other-model')
    expect(field('API Key').value).toBe(action === 'replace' ? 'synthetic-replacement' : action === 'clear' ? '' : originalKey)
    await click('确认按当前草稿重试')
    expect(saves[1].expectedVersion).toBe(2)
    expect(saves[1].credential).toEqual(action === 'clear' ? { action: 'clear' } : { action: 'replace', value: action === 'replace' ? 'synthetic-replacement' : originalKey })
    expect(saves[1].requestId).not.toBe(saves[0].requestId)
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(server.name).toBe('本地草稿')
  })

  it.each(['before', 'after'] as const)('resolves %s-commit transport loss using the same identity and frozen payload before saving later edits', async failure => {
    await click('编辑'); await type('连接名称', '已提交草稿'); await type('API Key', 'synthetic-original')
    rejectSave = failure; await click('保存')
    expect(alerts()).toContain('保存结果尚未确认')
    await type('连接名称', '后续草稿'); await type('API Key', 'synthetic-later'); await poll()
    expect(button('保存').disabled).toBe(true)
    await click('核对原提交')
    expect(saves[1]).toEqual(saves[0]); expect(server.version).toBe(2)
    expect(field('连接名称').value).toBe('后续草稿'); expect(field('API Key').value).toBe('synthetic-later')
    await click('保存')
    expect(saves[2].requestId).not.toBe(saves[0].requestId)
    expect(saves[2].expectedVersion).toBe(2)
    expect(saves[2].credential).toEqual({ action: 'replace', value: 'synthetic-later' })
    expect(server.version).toBe(3); expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('moves an uncommitted unknown request to explicit CAS recovery if another tab wins', async () => {
    await click('编辑'); await type('连接名称', '保留的草稿'); rejectSave = 'before'; await click('保存')
    server = { ...server, name: '其他标签的新版本', version: 2 }
    await click('核对原提交'); expect(saves[1]).toEqual(saves[0]); expect(alerts()).toContain('版本冲突')
    await click('读取最新版本'); await click('确认按当前草稿重试')
    expect(saves[2].expectedVersion).toBe(2); expect(server.name).toBe('保留的草稿')
  })

  it('requires a successful refresh and another confirmation when the remote version advances again', async () => {
    await click('编辑'); await type('连接名称', '保留的草稿'); server = { ...server, version: 2 }; await click('保存')
    readFailure = true; await click('读取最新版本')
    expect(alerts()).toContain('无法读取最新版本')
    expect(document.body.textContent).not.toContain('确认按当前草稿重试')
    expect(field('连接名称').value).toBe('保留的草稿')
    readFailure = false; await click('读取最新版本'); server = { ...server, version: 3 }
    await click('确认按当前草稿重试'); expect(saves[1].expectedVersion).toBe(2)
    expect(alerts()).toContain('版本冲突'); expect(document.body.textContent).not.toContain('确认按当前草稿重试')
    await click('读取最新版本'); await click('确认按当前草稿重试')
    expect(saves[2].expectedVersion).toBe(3); expect(server.name).toBe('保留的草稿')
  })

  it.each(['unchanged', 'clear'] as const)('confirms a lost ACK without an extra version or losing the %s input value', async action => {
    await click('编辑')
    if (action === 'clear') await type('API Key', '')
    rejectSave = 'after'; await click('保存'); await poll(); await poll()
    expect(alerts()).toContain('保存结果尚未确认')
    expect(saves).toHaveLength(1)
    await click('核对原提交')
    expect(saves[1]).toEqual(saves[0]); expect(saves[1].credential).toEqual(action === 'clear' ? { action: 'clear' } : { action: 'replace', value: originalKey })
    expect(server.version).toBe(2); expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('retains the frozen unknown submission across another transport loss and more edits', async () => {
    await click('编辑'); rejectSave = 'before'; await click('保存')
    await type('连接名称', '后续草稿'); rejectSave = 'before'; await click('核对原提交')
    expect(saves[1]).toEqual(saves[0]); expect(alerts()).toContain('保存结果尚未确认')
    await type('API Key', 'synthetic-later'); await click('核对原提交')
    expect(saves[2]).toEqual(saves[0]); expect(field('连接名称').value).toBe('后续草稿')
    expect(field('API Key').value).toBe('synthetic-later'); expect(server.version).toBe(2)
  })

  it('allows a corrected new submission after a definitive invalid rejection', async () => {
    await click('编辑'); rejectSave = 'invalid'; await click('保存')
    expect(alerts()).toContain('保存被拒绝'); await type('连接名称', '修正草稿'); await click('保存')
    expect(saves[1].requestId).not.toBe(saves[0].requestId); expect(saves[1].expectedVersion).toBe(1)
    expect(server.version).toBe(2)
  })

  it('does not discard an uncertain identity when a later reconciliation is denied', async () => {
    await click('编辑'); rejectSave = 'after'; await click('保存')
    rejectSave = 'forbidden'; await click('核对原提交')
    expect(alerts()).toContain('原空间资格已失效'); expect(button('保存').disabled).toBe(true)
    await click('核对原提交')
    expect(saves[1]).toEqual(saves[0]); expect(saves[2]).toEqual(saves[0])
    expect(server.version).toBe(2); expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('does not turn an identity conflict into a fresh blind write', async () => {
    await click('编辑'); rejectSave = 'identity-conflict'; await click('保存')
    expect(alerts()).toContain('身份'); expect(button('保存').disabled).toBe(true)
    await click('核对原提交'); expect(saves[1]).toEqual(saves[0])
  })

  it('keeps later edits after a delayed successful ACK, then uses its acknowledged version', async () => {
    await click('编辑'); await type('连接名称', '先提交')
    let release!: () => void; holdSave = new Promise(resolve => { release = resolve })
    await click('保存'); await type('连接名称', '继续编辑'); await type('API Key', 'synthetic-later')
    await act(async () => { release(); await settle() }); holdSave = undefined
    expect(field('连接名称').value).toBe('继续编辑')
    await click('保存'); expect(saves[1].expectedVersion).toBe(2)
  })

  it('does not misclassify a confirmed save as unknown when refreshing model selection fails', async () => {
    await click('编辑'); vi.mocked(selection.reload).mockRejectedValueOnce(new Error('read failed'))
    await click('保存')
    expect(document.querySelector('[role="dialog"]')).toBeNull(); expect(saves).toHaveLength(1)
  })
})
