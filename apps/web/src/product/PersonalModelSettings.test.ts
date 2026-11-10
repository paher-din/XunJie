import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { createRequire } from 'node:module'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import type { ModelAttempt, ModelConnection, ModelProvider, SaveModelProvider } from '@xunjie/contracts/model-connections'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import type { ModelSelectionController } from './ModelSelection'

// Use the real React/Radix tree. Only the browser host, transport and polling clock
// are controlled; SSR cannot exercise the interleaved actions behind STD-02/SPC-02.
const { JSDOM } = createRequire(import.meta.url)('jsdom')
let dom: ReturnType<typeof JSDOM>, root: Root
let PersonalModelSettings: typeof import('./PersonalModelSettings').PersonalModelSettings
let createRoot: typeof import('react-dom/client').createRoot
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
const providerOf = (model: ModelConnection): ModelProvider => ({ providerId: model.connectionId, version: model.version,
  name: model.name, baseUrl: model.baseUrl, protocol: model.protocol, enabled: model.providerEnabled ?? true,
  hasCredential: model.hasCredential, models: [model, ...structuredClone(extraModels)] })
const selection: ModelSelectionController = { selection: { version: 0, selected: null, options: [] }, error: '', busy: false, stale: false,
  reload: vi.fn(async () => {}), choose: vi.fn(async () => {}), revoke: vi.fn(async () => {}) }
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
const alerts = () => [...document.querySelectorAll('[role="alert"]')].map(element => element.textContent).join('\n')
function button(label: string, scope: ParentNode = document) {
  const element = [...scope.querySelectorAll('button')].find(element => element.textContent?.trim() === label)
  expect(element, `button ${label}`).toBeDefined()
  return element!
}
const click = async (label: string, scope?: ParentNode) => { await act(async () => { button(label, scope).click(); await settle() }) }
const field = (label: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
async function type(label: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(field(label), value)
    field(label).dispatchEvent(new dom.window.Event('input', { bubbles: true })); await settle()
  })
}
const poll = async () => { await act(async () => { vi.advanceTimersByTime(1000); await settle() }) }
async function mount(subject = identity) {
  await act(async () => { root.render(createElement(PersonalModelSettings, { identity: subject, spaceKey: 'personal', namespace: 'test', onBack() {}, selection })); await settle() })
}

it('refreshes model information when the model pane is entered, while hidden settings do not trigger it', async () => {
  await act(async () => { root.render(null); await settle() })
  vi.mocked(fetch).mockClear()
  await act(async () => {
    root.render(createElement('section', { hidden: true, 'data-settings-section': 'account' },
      createElement(PersonalModelSettings, { identity, spaceKey: 'personal', namespace: 'test', onBack() {}, selection })))
    await settle()
  })
  const requests = () => vi.mocked(fetch).mock.calls.filter(([url]) => String(url).endsWith('/models/directory'))
  expect(requests()).toHaveLength(0)
  const pane = document.querySelector('section')!
  await act(async () => { pane.hidden = false; pane.dataset.settingsSection = 'models'; await settle() })
  expect(requests().some(([, init]) => JSON.parse(init!.body as string).refresh === true)).toBe(true)
  const before = requests().length
  await act(async () => { pane.hidden = true; pane.dataset.settingsSection = 'account'; await settle() })
  expect(requests()).toHaveLength(before)
  await act(async () => { pane.hidden = false; pane.dataset.settingsSection = 'models'; await settle() })
  expect(requests().length).toBeGreaterThan(before)
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
  ;({ createRoot } = await import('react-dom/client'))
  ;({ PersonalModelSettings } = await import('./PersonalModelSettings'))
})
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  server = structuredClone(initial); saves = []; checks = []; receipts = new Map(); rejectCheck = true
  extraModels = []
  rejectSave = ''; holdRead = undefined; holdSave = undefined; readFailure = false; serverKey = originalKey; credentialFailure = false
  vi.mocked(selection.reload).mockReset().mockResolvedValue(undefined)
  vi.stubGlobal('fetch', vi.fn(async (input: string, options: RequestInit = {}) => {
    const path = input.split('/models/')[1], method = options.method ?? 'GET'
    if (input === '/api/learning/agent-settings' && method === 'GET') return response({ version: 0, busyInputMode: 'steering' })
    if (input === '/api/learning/skills' && method === 'GET') return response({ skills: [], selections: [] })
    if (method === 'GET') {
      const value = path === 'providers' ? [providerOf(structuredClone(server))] : structuredClone(checks)
      await holdRead
      return readFailure ? response({ error: 'unavailable' }, 503) : response(value)
    }
    const body = JSON.parse(options.body as string)
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
  await act(async () => { root.unmount(); await settle() })
  document.body.innerHTML = ''; vi.useRealTimers()
})
afterAll(() => { dom.window.close(); vi.unstubAllGlobals() })

describe('personal model settings recovery through real React controls', () => {
  it('keeps provider and model switches independent without reading or resending the key', async () => {
    const toggle = async (label: string) => { await act(async () => { document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click(); await settle() }) }
    await toggle('启用供应商 原配置')
    expect(server.enabled).toBe(false); expect(server.providerEnabled).toBe(false); expect(server.modelEnabled).toBe(true)
    expect(document.querySelector('[aria-label="启用模型 synthetic"]')!.getAttribute('aria-checked')).toBe('true')
    expect(button('连接检查').disabled).toBe(true)
    await toggle('启用模型 synthetic'); await toggle('启用供应商 原配置')
    expect(server.providerEnabled).toBe(true); expect(server.modelEnabled).toBe(false); expect(server.enabled).toBe(false)
    expect(saves.every(input => input.credential.action === 'keep')).toBe(true)
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).endsWith('/credential'))).toBe(false)
  })

  it('adds a second model with its own effort and retains the existing model in one save', async () => {
    await click('添加模型'); await type('模型 ID 2', 'gpt-5.2')
    await act(async () => {
      const select = document.querySelector<HTMLSelectElement>('[aria-label="模型 ID 2的思考强度"]')!
      select.value = 'high'; select.dispatchEvent(new dom.window.Event('change', { bubbles: true })); await settle()
    })
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('方言')
    expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('参数模式')
    await click('保存')
    expect(saves[0].models.map(model => [model.modelId, model.reasoningEffort])).toEqual([['synthetic', undefined], ['gpt-5.2', 'high']])
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
    expect(button('保存前检查').disabled).toBe(true)
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
      expect(card.textContent).toContain('chat-completions · 版本 2')
      expect(card.textContent).toContain('已确认配置')
      rejectCheck = false
      await click('连接检查', card)
      const submittedSource = () => JSON.parse(vi.mocked(fetch).mock.calls.filter(([path, options]) =>
        String(path).endsWith('/models/checks') && options?.method === 'POST').at(-1)![1]!.body as string).source
      expect(submittedSource()).toEqual({ connectionId: initial.connectionId, version: 2 })
      await act(async () => { releaseOld(); await settle() })
      expect(card.textContent).toContain('chat-completions · 版本 2')
      await click('连接检查', card)
      expect(submittedSource()).toEqual({ connectionId: initial.connectionId, version: 2 })
      await act(async () => { releaseFresh(); await settle() }); holdRead = undefined
      server = { ...initial, name: '恢复的配置' }; await poll()
      expect(card.textContent).toContain('chat-completions · 版本 1')
      expect(card.textContent).toContain('恢复的配置')
      expect(card.textContent).not.toContain('已确认配置')
    } finally {
      await act(async () => { releaseOld(); releaseFresh(); await settle() }); holdRead = undefined
    }
  })

  it('preserves an action error through late reads, two polls and explicit reads; clears it on successful related retry', async () => {
    let release!: () => void; holdRead = new Promise(resolve => { release = resolve })
    await poll(); await click('连接检查')
    expect(alerts()).toContain('检查频次或并发已达上限')
    await act(async () => { release(); await settle() }); holdRead = undefined
    await poll(); await poll(); await click('重新读取配置')
    expect(alerts()).toContain('检查频次或并发已达上限')
    rejectCheck = false; await click('连接检查')
    expect(alerts()).not.toContain('检查频次或并发已达上限')
  })

  it('publishes completed polling reads while newer reads are pending, without accepting older snapshots afterward', async () => {
    let releaseFirst!: () => void, releaseSecond!: () => void, releaseLast!: () => void
    server = { ...server, name: '较早读取' }
    holdRead = new Promise(resolve => { releaseFirst = resolve }); await poll()
    server = { ...server, name: '已完成读取' }
    holdRead = new Promise(resolve => { releaseSecond = resolve }); await poll()
    server = { ...server, name: '仍在读取' }
    holdRead = new Promise(resolve => { releaseLast = resolve }); await poll()
    try {
      await act(async () => { releaseSecond(); await settle() })
      const card = document.querySelector('[aria-label="个人连接配置"] .st-provider')!
      expect(card.textContent).toContain('已完成读取')
      await act(async () => { releaseFirst(); await settle() })
      expect(card.textContent).toContain('已完成读取')
      expect(card.textContent).not.toContain('较早读取')
      await act(async () => { releaseLast(); await settle() })
      expect(card.textContent).toContain('仍在读取')
    } finally {
      await act(async () => { releaseFirst(); releaseSecond(); releaseLast(); await settle() }); holdRead = undefined
    }
  })

  it('clears recovered read errors without erasing an action failure', async () => {
    await click('连接检查'); readFailure = true; await poll()
    expect(alerts()).toContain('连接或相应适配器不可用')
    readFailure = false; await poll()
    expect(alerts()).not.toContain('连接或相应适配器不可用')
    expect(alerts()).toContain('检查频次或并发已达上限')
  })

  it('drops old subject errors, drafts and late responses after an identity change', async () => {
    await click('连接检查'); await click('编辑'); await type('连接名称', '旧主体草稿')
    let release!: () => void; holdRead = new Promise(resolve => { release = resolve }); await poll()
    server = { ...server, name: '新主体配置' }
    await mount({ ...identity, principalId: crypto.randomUUID() })
    await act(async () => { release(); await settle() }); holdRead = undefined
    expect(alerts()).toBe(''); expect(document.querySelector('[role="dialog"]')).toBeNull()
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
