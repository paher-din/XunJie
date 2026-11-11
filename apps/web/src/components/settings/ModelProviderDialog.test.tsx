// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getModelPreset, type ModelDirectory, type ModelDirectoryInput, type ModelProvider, type SaveModelProvider } from '@xunjie/contracts/model-connections'
import { ModelProviderDialog } from './ModelProviderDialog'
import { Toaster, toast } from '@xunjie/ui/feedback'

let root: Root
const provider = (): ModelProvider => {
  const connectionId = crypto.randomUUID()
  return { providerId: crypto.randomUUID(), version: 1, name: '测试供应商', protocol: 'chat-completions',
    baseUrl: 'https://example.invalid/v1', enabled: true, hasCredential: false,
    models: [{ connectionId, version: 1, routeId: crypto.randomUUID(), name: '测试供应商', protocol: 'chat-completions',
      baseUrl: 'https://example.invalid/v1', path: '/chat/completions', modelId: 'custom-model', enabled: true,
      dialect: 'standard', parameterMode: 'plain', reasoningEffort: 'auto', hasCredential: false,
      adapterState: 'ready', capabilities: { text: 'unknown', images: 'unknown', tools: 'unknown', strictSchema: 'unknown' } }] }
}
const input = (name: string) => document.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
async function type(name: string, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input(name), value)
    input(name).dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const card = (id: string) => [...document.querySelectorAll<HTMLElement>('.st-model-choice')].find(item => item.getAttribute('aria-label') === id)!
async function chooseModel(id: string) {
  const item = card(id)
  if (!item) {
    await type('搜索或输入模型 ID', id); await click('添加模型'); return
  }
  const selection = item.querySelector<HTMLButtonElement>('[role="checkbox"]')
  if (selection?.getAttribute('aria-checked') === 'false') await act(async () => selection.click())
  if (item.querySelector('[aria-expanded]')?.getAttribute('aria-expanded') === 'false')
    await act(async () => item.querySelector<HTMLButtonElement>('.st-model-choice-title')!.click())
}
async function click(label: string) {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)!
  expect(button).toBeDefined()
  await act(async () => { button.click() })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
type Props = Parameters<typeof ModelProviderDialog>[0]
async function draw(saved = provider(), onProfiles: Props['onProfiles'] = vi.fn(async () => ({ profiles: [], stale: true })), overrides: Partial<Props> = {}, openSaved = true) {
  const onSave = vi.fn(async (_input: SaveModelProvider) => saved), onClose = vi.fn()
  await act(async () => root.render(<><Toaster /><ModelProviderDialog provider={saved} attempts={[]} onSave={onSave} onClose={onClose}
    onRead={vi.fn(async () => saved)} onReadCredential={vi.fn(async () => '')} onProfiles={onProfiles}
    onCheck={vi.fn()} onCancel={vi.fn()} {...overrides} /></>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  if (openSaved) await act(async () => {
    for (const button of document.querySelectorAll<HTMLButtonElement>('[aria-label="自定义模型"] .st-model-choice[data-selected] .st-model-choice-title[aria-expanded="false"]')) button.click()
  })
  return { onSave, onClose, onProfiles }
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  window.matchMedia ??= vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} })
  Element.prototype.scrollIntoView ??= vi.fn()
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})

async function selectChoice(field: string, label: string) {
  await act(async () => { document.querySelector<HTMLButtonElement>(`button[aria-label="${field}"]`)!.click() })
  await act(async () => {
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.trim() === label)
    expect(option, label).toBeDefined()
    option!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); option!.click()
  })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const selectSupplier = (label: string) => selectChoice('供应商', label)
const cachedDirectory = (input: ModelDirectoryInput): ModelDirectory => ({
  models: getModelPreset(input.presetId ?? 'custom', input.variantId)?.models ?? [],
  catalogue: { status: 'ready', updatedAt: '2026-01-01T00:00:00.000Z' },
  ...(input.presetId && input.presetId !== 'custom' ? { supplier: { status: 'needs-credential' as const } } : {}),
})

it('lists custom first and all six providers with their real access methods', async () => {
  await draw()
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="供应商"]')!.click())
  expect([...document.querySelectorAll('[role="option"]')].map(item => item.textContent?.trim()))
    .toEqual(['自定义', 'DeepSeek 官方', 'OpenCode Go', 'Command Code', '智谱', 'Kimi', '小米 MiMo'])
  await act(async () => {
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.trim() === 'Kimi')!
    option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); option.click()
  })
  expect(document.querySelector('button[aria-label="接入方式"]')?.textContent).toContain('普通 API')
  expect(input('Base URL').value).toBe('https://api.moonshot.cn/v1')
  expect(input('Base URL').readOnly).toBe(true)
})

it('autofills Kimi official output and MiMo toggle without inventing strength levels', async () => {
  const { onSave } = await draw()
  await selectSupplier('Kimi'); await chooseModel('kimi-k3.1-pro')
  expect(input('模型 ID的最大输出 token').value).toBe('1M')
  expect(document.querySelector('[aria-label="模型 ID的默认思考强度"]')!.textContent).toContain('最高 · max')
  await selectSupplier('小米 MiMo'); await chooseModel('mimo-v2.6-pro')
  const reasoning = document.querySelector<HTMLButtonElement>('[aria-label="模型 ID的默认思考强度"]')!
  expect(reasoning.textContent).toContain('开启思考')
  await act(async () => reasoning.click())
  const list = document.getElementById(reasoning.getAttribute('aria-controls')!)!
  expect([...list.querySelectorAll('[role="option"]')].map(option => option.textContent?.trim())).toEqual(['模型默认', '关闭思考', '开启思考'])
  await act(async () => {
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.trim() === '开启思考')!
    option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); option.click()
  })
  expect(input('模型 ID的最大输出 token').value).toBe('128K')
  await type('模型 ID的上下文窗口', '512k'); await click('保存')
  expect(onSave.mock.calls[0][0].models[0]).toMatchObject({ maxOutputTokens: 131072, contextWindow: 524288, reasoningEffort: 'enabled' })
})

it('saves the per-model route for a provider whose Claude model uses Messages', async () => {
  const { onSave } = await draw()
  await selectSupplier('Command Code'); await chooseModel('claude-sonnet-4-6'); await click('保存')
  expect(onSave.mock.calls[0][0]).toMatchObject({ presetId: 'command-code', protocol: 'chat-completions', baseUrl: 'https://api.commandcode.ai/provider/v1' })
  expect(onSave.mock.calls[0][0].models[0]).toMatchObject({ protocol: 'messages', baseUrl: 'https://api.commandcode.ai/provider' })
})

it('selects multiple preset models and retains their independent edits across collapse, deselection and search', async () => {
  const { onSave } = await draw(provider(), undefined, { provider: null })
  await selectSupplier('DeepSeek 官方')
  await click('保存')
  expect(onSave).not.toHaveBeenCalled()
  await chooseModel('deepseek-flash'); await type('模型 ID的上下文窗口', '512k')
  const identity = card('deepseek-flash').querySelector('[aria-controls]')!.getAttribute('aria-controls')
  await act(async () => card('deepseek-flash').querySelector<HTMLButtonElement>('.st-model-choice-title')!.click())
  expect(input('模型 ID的上下文窗口')).toBeNull()
  await chooseModel('deepseek-flash')
  expect(input('模型 ID的上下文窗口').value).toBe('512k')
  expect(card('deepseek-flash').querySelector('[aria-controls]')!.getAttribute('aria-controls')).toBe(identity)
  await act(async () => card('deepseek-flash').querySelector<HTMLButtonElement>('[role="checkbox"]')!.click())
  expect(card('deepseek-flash').getAttribute('data-selected')).toBeNull()
  await chooseModel('deepseek-v4-pro'); await type('模型 ID的最大输出 token', '128k')
  await chooseModel('deepseek-flash')
  expect(input('模型 ID的上下文窗口').value).toBe('512k')
  await type('搜索或输入模型 ID', 'v4-pro')
  expect(card('deepseek-flash')).toBeUndefined()
  await click('保存')
  const models = onSave.mock.calls[0][0].models
  expect(models.map(model => model.modelId)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  expect(models[1].maxOutputTokens).toBe(131072)
  expect(models[0].contextWindow).toBe(524288)
  expect(new Set(models.map(model => model.connectionId)).size).toBe(2)
})

it('adds model IDs from the search field with Enter or the adjacent button without duplicating a selected model', async () => {
  const { onSave } = await draw(provider(), undefined, { provider: null, onDirectory: vi.fn(async query => cachedDirectory(query)) })
  await selectSupplier('DeepSeek 官方')
  await type('搜索或输入模型 ID', '  private-model  ')
  await act(async () => input('搜索或输入模型 ID').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
  expect(input('搜索或输入模型 ID').value).toBe('')
  expect(card('private-model').getAttribute('data-selected')).toBe('true')
  await type('模型 ID的上下文窗口', '512K')
  await type('搜索或输入模型 ID', 'private-model'); await click('添加模型')
  expect(input('模型 ID的上下文窗口').value).toBe('512K')
  await type('搜索或输入模型 ID', 'second-private-model'); await click('添加模型')
  await click('保存')
  expect(onSave.mock.calls[0][0].models.map(model => model.modelId)).toEqual(['second-private-model', 'private-model'])
  expect(onSave.mock.calls[0][0].models[1].contextWindow).toBe(524288)
})

it('uses the same search/add row for custom models and saves filtered-out drafts with their own capacities', async () => {
  const { onSave } = await draw(provider(), undefined, { provider: null })
  await type('连接名称', '自定义供应商'); await type('Base URL', 'https://example.invalid/v1')
  expect(document.querySelectorAll('.st-model-choice')).toHaveLength(0)
  expect(document.querySelector('[aria-label="自定义模型"]')!.textContent).toBe('')
  await type('搜索或输入模型 ID', 'custom-alpha'); await click('保存')
  expect(onSave).not.toHaveBeenCalled()
  expect(input('模型 ID')).toBeNull()
  await type('搜索或输入模型 ID', 'custom-alpha'); await click('添加模型')
  expect(input('模型 ID').value).toBe('custom-alpha')
  await type('模型 ID的上下文窗口', '512K')
  await type('搜索或输入模型 ID', 'custom-beta'); await click('添加模型')
  expect(input('模型 ID').value).toBe('custom-beta')
  await type('模型 ID的最大输出 token', '128K')
  await type('搜索或输入模型 ID', 'custom-alpha')
  expect(input('模型 ID')).toBeNull()
  await click('保存')
  expect(onSave.mock.calls[0][0].models.map(model => model.modelId)).toEqual(['custom-beta', 'custom-alpha'])
  expect(onSave.mock.calls[0][0].models[1].contextWindow).toBe(524288)
  expect(onSave.mock.calls[0][0].models[0].maxOutputTokens).toBe(131072)
});

it.each(['custom', 'deepseek'] as const)('reopens saved %s models collapsed, retains disabled state and reveals an invalid field before saving', async preset => {
  const saved = provider()
  if (preset === 'deepseek') { saved.presetId = 'deepseek'; saved.variantId = 'api'; saved.baseUrl = 'https://api.deepseek.com/v1' }
  saved.models[0] = { ...saved.models[0], modelId: 'deepseek-flash', baseUrl: saved.baseUrl, enabled: false, modelEnabled: false,
    contextWindow: 524288, maxOutputTokens: 65536 }
  const { onSave } = await draw(saved, undefined, {}, false)
  expect(card('deepseek-flash').getAttribute('data-selected')).toBe('true')
  expect(input('模型 ID的上下文窗口')).toBeNull()
  await chooseModel('deepseek-flash')
  expect(input('模型 ID的上下文窗口').value).toBe('512K')
  await type('模型 ID的上下文窗口', '0.1K')
  await act(async () => card('deepseek-flash').querySelector<HTMLButtonElement>('.st-model-choice-title')!.click())
  await type('搜索或输入模型 ID', 'no-match')
  await click('保存')
  expect(onSave).not.toHaveBeenCalled()
  expect(input('模型 ID的上下文窗口').value).toBe('0.1K')
  await type('模型 ID的上下文窗口', '768k'); await click('保存')
  expect(onSave.mock.calls[0][0].models[0]).toMatchObject({ connectionId: saved.models[0].connectionId,
    expectedVersion: 1, enabled: false, contextWindow: 786432, maxOutputTokens: 65536 })
})

it('Escape closes only the supplier menu and model cards retain their collapsed configuration', async () => {
  const { onClose } = await draw()
  await type('连接名称', '未保存的供应商名称')
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="供应商"]')!.click())
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(onClose).not.toHaveBeenCalled()
  expect(document.querySelector('[role="combobox"][aria-expanded="true"]')).toBeNull()
  await selectSupplier('DeepSeek 官方')
  await chooseModel('my-private-model'); await type('模型 ID的上下文窗口', '512k')
  await act(async () => card('my-private-model').querySelector<HTMLButtonElement>('.st-model-choice-title')!.click())
  expect(input('模型 ID的上下文窗口')).toBeNull()
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="供应商"]')!.click())
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(onClose).not.toHaveBeenCalled()
  await chooseModel('my-private-model')
  expect(input('模型 ID的上下文窗口').value).toBe('512k')
  expect(input('连接名称').value).toBe('未保存的供应商名称')
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="模型 ID的默认思考强度"]')!.click())
  await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(onClose).not.toHaveBeenCalled()
  expect(document.querySelector('[role="combobox"][aria-expanded="true"]')).toBeNull()
  await act(async () => input('模型 ID的上下文窗口').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })))
  expect(onClose).toHaveBeenCalledOnce()
})

it.each(['custom', 'deepseek'] as const)('removes a saved %s model explicitly without changing the retained model enable switch', async preset => {
  const saved = provider()
  saved.enabled = false
  saved.models[0] = { ...saved.models[0], modelId: 'deepseek-flash', enabled: false, modelEnabled: true }
  saved.models.push({ ...saved.models[0], connectionId: crypto.randomUUID(), modelId: 'deepseek-v4-pro', modelEnabled: false })
  if (preset === 'deepseek') {
    saved.presetId = 'deepseek'; saved.variantId = 'api'; saved.baseUrl = 'https://api.deepseek.com/v1'
    saved.models = saved.models.map(model => ({ ...model, baseUrl: saved.baseUrl }))
  }
  const { onSave } = await draw(saved, undefined, {}, false)
  const checkbox = () => card('deepseek-flash').querySelector<HTMLButtonElement>('[role="checkbox"]')!
  expect(checkbox().getAttribute('aria-checked')).toBe('true')
  expect(card('deepseek-v4-pro').querySelector('[role="checkbox"]')!.getAttribute('aria-checked')).toBe('true')
  expect(document.querySelectorAll('.st-model-choice-title[aria-expanded="true"]')).toHaveLength(0)
  await act(async () => checkbox().click())
  expect(checkbox().getAttribute('aria-checked')).toBe('false')
  expect(onSave).not.toHaveBeenCalled()
  await click('保存')
  const input = onSave.mock.calls[0][0]
  expect(input.removedModels).toEqual([{ connectionId: saved.models[0].connectionId, expectedVersion: saved.models[0].version }])
  expect(input.models.map(model => [model.modelId, model.enabled])).toEqual([['deepseek-v4-pro', false]])
  expect(input.enabled).toBe(false)
})

it('restores a deselected saved model draft and preserves its independent disabled state', async () => {
  const saved = provider()
  saved.models[0] = { ...saved.models[0], enabled: false, modelEnabled: false }
  const { onSave } = await draw(saved)
  await type('模型 ID的上下文窗口', '512K')
  const checkbox = () => card('custom-model').querySelector<HTMLButtonElement>('[role="checkbox"]')!
  await act(async () => checkbox().click())
  await type('API Key', 'synthetic-new-key')
  expect(checkbox().getAttribute('aria-checked')).toBe('false')
  await act(async () => checkbox().click())
  expect(input('模型 ID的上下文窗口')).toBeNull()
  await chooseModel('custom-model')
  expect(input('模型 ID的上下文窗口').value).toBe('512K')
  await click('保存')
  expect(onSave.mock.calls[0][0].models[0]).toMatchObject({ connectionId: saved.models[0].connectionId,
    expectedVersion: saved.models[0].version, enabled: false, contextWindow: 524288 })
  expect(onSave.mock.calls[0][0].removedModels).toBeUndefined()
})

it('allows an existing supplier to remove its last model without disabling the supplier', async () => {
  const saved = provider()
  const { onSave } = await draw(saved, undefined, {}, false)
  await act(async () => card('custom-model').querySelector<HTMLButtonElement>('[role="checkbox"]')!.click())
  await click('保存')
  expect(onSave.mock.calls[0][0]).toMatchObject({ models: [], enabled: true,
    removedModels: [{ connectionId: saved.models[0].connectionId, expectedVersion: saved.models[0].version }] })
})

it('retains custom ids, per-model edits, and separate secret drafts when switching providers', async () => {
  const onDirectory = vi.fn(async (query: ModelDirectoryInput) => cachedDirectory(query))
  await draw(provider(), undefined, { onDirectory })
  await selectSupplier('DeepSeek 官方'); await type('API Key', 'synthetic-deepseek-only')
  await chooseModel('private-alias'); await type('模型 ID的上下文窗口', '512k')
  await selectSupplier('Kimi')
  expect(input('API Key').value).toBe('')
  expect(onDirectory.mock.calls.filter(([query]) => query.presetId === 'kimi').every(([query]) => query.credential?.action !== 'replace')).toBe(true)
  await type('API Key', 'synthetic-kimi-only')
  await selectSupplier('DeepSeek 官方')
  expect(input('API Key').value).toBe('synthetic-deepseek-only')
  expect(card('private-alias').getAttribute('data-selected')).toBe('true')
  expect(input('模型 ID的上下文窗口').value).toBe('512k')
})

it('ignores late refresh responses after changing provider and keeps manually edited fields', async () => {
  let release!: (value: ModelDirectory) => void
  const delayed = new Promise<ModelDirectory>(resolve => { release = resolve })
  const onDirectory = vi.fn(async (query: ModelDirectoryInput) => query.presetId === 'deepseek' && query.refresh ? delayed : cachedDirectory(query))
  await draw(provider(), undefined, { onDirectory })
  await selectSupplier('DeepSeek 官方')
  await selectSupplier('小米 MiMo'); await chooseModel('mimo-v2.6-pro'); await type('模型 ID的上下文窗口', '512k')
  await act(async () => { release(cachedDirectory({ presetId: 'deepseek' })); await Promise.resolve() })
  expect(card('mimo-v2.6-pro').getAttribute('data-selected')).toBe('true')
  expect(input('模型 ID的上下文窗口').value).toBe('512k')
  expect(document.querySelector('[aria-label="模型 ID的默认思考强度"]')!.textContent).toContain('开启思考')
})

it('opening the model list keeps a previous failure visible while its retry is pending', async () => {
  let retry = false, release!: (value: ModelDirectory) => void
  const pending = new Promise<ModelDirectory>(resolve => { release = resolve })
  const onDirectory = vi.fn(async (query: ModelDirectoryInput) => {
    if (!query.refresh) return cachedDirectory(query)
    if (retry) return pending
    throw Object.assign(new Error('forbidden'), { code: 'forbidden' })
  })
  await draw(provider(), undefined, { onDirectory })
  await selectSupplier('DeepSeek 官方')
  const previous = document.querySelector('[data-sonner-toast][data-type="error"]')?.textContent
  expect(previous).toContain('当前空间无法读取模型资料')
  retry = true
  try {
    await act(async () => input('搜索或输入模型 ID').focus())
    expect(document.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toBe(previous)
  } finally {
    await act(async () => release(cachedDirectory({ presetId: 'deepseek' })))
  }
})

it('explains a supplier model-list 404 on add-model entry while allowing the draft to be saved', async () => {
  const onDirectory = vi.fn(async (query: ModelDirectoryInput) => ({ ...cachedDirectory(query),
    supplier: { status: 'failed' as const, error: 'unavailable' as const, httpStatus: 404,
      retryAt: new Date(Date.now() + 60000).toISOString() } }));
  const { onSave } = await draw(provider(), undefined, { addModel: true, onDirectory });
  const message = document.querySelector('[data-sonner-toast][data-type="error"]')?.textContent;
  expect(message).toContain('供应商模型列表接口不存在（HTTP 404）');
  expect(message).toContain('手动填写模型 ID');
  expect(document.activeElement).toBe(input('搜索或输入模型 ID'));
  await chooseModel('manually-added-model'); await click('保存');
  expect(onSave.mock.calls[0][0].models.map(model => model.modelId)).toEqual(['manually-added-model', 'custom-model']);
});

it('identifies the public catalogue timeout separately from the supplier model list', async () => {
  const onDirectory = vi.fn(async (query: ModelDirectoryInput) => ({ ...cachedDirectory(query),
    catalogue: { status: 'failed' as const, error: 'timeout' as const } }));
  await draw(provider(), undefined, { onDirectory });
  expect(document.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toContain('公共模型资料（models.dev）请求超时');
});

it('manual refresh bypasses the automatic interval, merges repeated clicks and explains a retryable failure', async () => {
  let release!: (value: ModelDirectory) => void
  const pending = new Promise<ModelDirectory>(resolve => { release = resolve })
  const onDirectory = vi.fn(async (query: ModelDirectoryInput) => query.manual ? pending : cachedDirectory(query))
  await draw(provider(), undefined, { onDirectory })
  await selectSupplier('DeepSeek 官方'); await chooseModel('deepseek-flash')
  await type('模型 ID的上下文窗口', '512k')
  await click('更新模型资料')
  expect(onDirectory.mock.calls.filter(([query]) => query.manual)).toHaveLength(1)
  const updateButton = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '更新模型资料')!
  await act(async () => { updateButton.click(); updateButton.click() })
  expect(onDirectory.mock.calls.filter(([query]) => query.manual)).toHaveLength(1)
  const retryAt = new Date(Date.now() + 150).toISOString()
  await act(async () => release({ ...cachedDirectory({ presetId: 'deepseek' }),
    catalogue: { status: 'failed', error: 'rate-limited', retryAt }, supplier: { status: 'failed', error: 'rate-limited', retryAt } }))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(document.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toContain('供应商暂时限流')
  expect(document.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toContain('后重试')
  expect(input('模型 ID的上下文窗口').value).toBe('512k')
  expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '稍后重试')?.disabled).toBe(true)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) })
  expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === '更新模型资料')?.disabled).toBe(false)
})
afterEach(async () => {
  await act(async () => { toast.dismiss(); root.unmount() })
  document.body.innerHTML = ''; vi.unstubAllGlobals()
})

it('shows fallback capacities and saves blank unknown-model fields as 256K/64K numbers', async () => {
  const { onSave, onClose } = await draw()
  expect(input('模型 ID的上下文窗口').value).toBe('256K')
  expect(input('模型 ID的最大输出 token').value).toBe('64K')
  await type('模型 ID的上下文窗口', '')
  await type('模型 ID的最大输出 token', '')
  await click('保存')
  expect(onSave.mock.calls[0][0].models[0]).toMatchObject({ contextWindow: 262144, maxOutputTokens: 65536 })
  expect(onClose).toHaveBeenCalledOnce()
})

it.each([
  ['1.5m', '64k', 1572864, 65536],
  ['262144', '1048576', 262144, 1048576],
])('saves %s / %s as exact integer tokens', async (context, output, expectedContext, expectedOutput) => {
  const { onSave } = await draw()
  await type('模型 ID的上下文窗口', context)
  await type('模型 ID的最大输出 token', output)
  await click('保存')
  expect(onSave.mock.calls[0][0].models[0]).toMatchObject({ contextWindow: expectedContext, maxOutputTokens: expectedOutput })
})

it('retains invalid text, associates inline errors and blocks saving until corrected', async () => {
  const { onSave } = await draw()
  await type('模型 ID的上下文窗口', '256KB')
  await type('模型 ID的最大输出 token', '0.1K')
  await click('保存')
  expect(onSave).not.toHaveBeenCalled()
  for (const name of ['模型 ID的上下文窗口', '模型 ID的最大输出 token']) {
    expect(input(name).getAttribute('aria-invalid')).toBe('true')
    expect(document.getElementById(input(name).getAttribute('aria-describedby')!)?.textContent).toContain('K / M')
  }
  expect(input('模型 ID的上下文窗口').value).toBe('256KB')
  expect(toast.getToasts().some(item => 'type' in item && item.type === 'error')).toBe(true)
  await act(async () => { toast.dismiss() })
  await click('保存')
  expect(toast.getToasts().some(item => 'type' in item && item.type === 'error')).toBe(true)
  expect(onSave).not.toHaveBeenCalled()
  expect(input('模型 ID的上下文窗口').value).toBe('256KB')
  await type('模型 ID的上下文窗口', '256k')
  await type('模型 ID的最大输出 token', '64K')
  await click('保存')
  expect(onSave).toHaveBeenCalledOnce()
})

it('uses supplied model metadata before fallback and preserves saved or manually edited capacities', async () => {
  const saved = provider()
  saved.models[0]!.contextWindow = 524288
  const onProfiles = vi.fn(async () => ({ profiles: [{ modelId: 'custom-model', dialect: 'standard' as const,
    efforts: ['auto' as const], source: 'catalogue' as const, contextWindow: 1048576, maxOutputTokens: 393216 }], stale: false }))
  const { onSave } = await draw(saved, onProfiles)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)) })
  expect(input('模型 ID的上下文窗口').value).toBe('512K')
  expect(input('模型 ID的最大输出 token').value).toBe('384K')
  await type('模型 ID的最大输出 token', '32k')
  await click('更新模型资料')
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 450)) })
  expect(input('模型 ID的最大输出 token').value).toBe('32k')
  await click('保存')
  expect(onSave.mock.calls[0][0].models[0]).toMatchObject({ contextWindow: 524288, maxOutputTokens: 32768 })
})
