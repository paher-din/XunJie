// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { getModelPreset, modelAttemptSchema, type ModelAttempt, type ModelConnectionTestInput,
  type ModelConnectionTestResult, type ModelDirectory, type ModelDirectoryInput, type ModelProvider } from '@xunjie/contracts/model-connections'
import { Toaster, toast } from '@xunjie/ui/feedback'
import { ModelProviderDialog } from './ModelProviderDialog'

type Props = Parameters<typeof ModelProviderDialog>[0]
type CheckOptions = NonNullable<Parameters<Props['onCheck']>[1]>
let root: Root
let network: ReturnType<typeof vi.fn>
const originalScrollIntoView = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollIntoView')
const savedKey = 'synthetic-saved-key'
const currentKey = 'synthetic-current-key'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}
function savedProvider(model: Partial<ModelProvider['models'][number]> = {}): ModelProvider {
  return { providerId: crypto.randomUUID(), version: 3, name: '保留的供应商', protocol: model.protocol ?? 'chat-completions',
    baseUrl: model.baseUrl ?? 'https://gateway.example.invalid/v1', hasCredential: true, enabled: true,
    models: [{ connectionId: crypto.randomUUID(), version: 2, routeId: crypto.randomUUID(), name: '保留的供应商',
      modelId: 'gpt-5.2', protocol: 'chat-completions', baseUrl: 'https://gateway.example.invalid/v1', path: '/chat/completions',
      dialect: 'standard', parameterMode: 'thinking', reasoningEffort: 'medium', enabled: true,
      contextWindow: 524288, maxOutputTokens: 65536, imageInput: false, hasCredential: true, adapterState: 'ready',
      capabilities: { text: 'verified', images: 'unknown', tools: 'unknown', strictSchema: 'unknown' }, ...model }] }
}
function completedAttempt(options: CheckOptions, patch: Partial<ModelAttempt> = {}): ModelAttempt {
  return modelAttemptSchema.parse({ attemptId: crypto.randomUUID(), purpose: 'connection-check', test: options.test,
    connection: { ...options.configuration, version: 1, routeId: crypto.randomUUID(), hasCredential: true, adapterState: 'ready',
      capabilities: { text: 'verified', images: 'unknown', tools: 'unknown', strictSchema: 'unknown' } },
    limits: { maxOutputTokens: options.configuration.maxOutputTokens ?? 65536, timeoutMs: 30000 },
    state: 'completed', dispatched: true, cancelRequested: false, physicalRequestEnded: true, upstreamStopped: 'unknown',
    text: 'Synthetic test answer', usage: { state: 'final', outputTokens: 3 }, reason: 'completed',
    requestRef: crypto.randomUUID(), resultRef: crypto.randomUUID(), createdAt: '2026-11-11T00:00:00.000Z', ...patch })
}
function connectionResult(input: ModelConnectionTestInput, patch: Partial<ModelConnectionTestResult> = {}): ModelConnectionTestResult {
  return { status: 'passed', baseUrl: input.baseUrl!, protocol: input.protocol!, endpoint: input.baseUrl!.replace(/\/$/, '') + '/models',
    elapsedMs: 12, modelCount: 2, ...patch }
}
function catalogue(input: ModelDirectoryInput): ModelDirectory {
  return { models: getModelPreset(input.presetId ?? 'custom', input.variantId)?.models ?? [],
    catalogue: { status: 'ready', updatedAt: '2026-11-01T00:00:00.000Z' } }
}
const form = () => document.querySelector<HTMLElement>('.product-connection-dialog')!
const field = (name: string) => form().querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
const card = (id: string) => [...form().querySelectorAll<HTMLElement>('.st-model-choice')]
  .find(element => element.getAttribute('aria-label') === id)!
const testArea = (id = 'gpt-5.2') => form().querySelector<HTMLElement>(`[aria-label="${id}的模型测试"]`)!
const findButton = (label: string, scope: ParentNode = form()) => [...scope.querySelectorAll<HTMLButtonElement>('button')]
  .find(button => (button.getAttribute('aria-label') ?? button.textContent?.trim()) === label)!
const activeToasts = () => toast.getToasts()
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0) }) }
async function click(label: string, scope: ParentNode = form()) {
  const button = findButton(label, scope)
  expect(button, label).toBeDefined()
  expect(button.disabled, label).toBe(false)
  await act(async () => { button.click() })
  await settle()
}
async function type(label: string, value: string) {
  expect(field(label), label).not.toBeNull()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field(label), value)
    field(label).dispatchEvent(new Event('input', { bubbles: true }))
  })
}
async function select(label: string, choice: string) {
  await click(label)
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(item => item.textContent?.trim() === choice)!
  expect(option, choice).toBeDefined()
  await act(async () => {
    option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }))
    option.click()
  })
  await settle()
}
async function draw(overrides: Partial<Props> = {}) {
  const provider = savedProvider()
  const callbacks = {
    onClose: vi.fn(), onSave: vi.fn<Props['onSave']>(async () => provider), onRead: vi.fn<Props['onRead']>(async () => provider),
    onReadCredential: vi.fn<Props['onReadCredential']>(async () => savedKey),
    onProfiles: vi.fn<Props['onProfiles']>(async () => ({ profiles: [], stale: false })),
    onDirectory: vi.fn<NonNullable<Props['onDirectory']>>(async input => catalogue(input)),
    onCheck: vi.fn<Props['onCheck']>(async (_source, options) => completedAttempt(options!)),
    onCancel: vi.fn<Props['onCancel']>(async () => {}),
    onConnectionTest: vi.fn<NonNullable<Props['onConnectionTest']>>(async input => connectionResult(input)),
  }
  await act(async () => root.render(<><Toaster /><ModelProviderDialog provider={provider} attempts={[]} {...callbacks} {...overrides} /></>))
  await settle()
  return callbacks
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  vi.stubGlobal('matchMedia', vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} }))
  network = vi.fn(() => { throw new Error('UI integration tests must not access the network') })
  vi.stubGlobal('fetch', network)
  Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => { toast.dismiss(); root.unmount() })
  document.body.innerHTML = ''
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  if (originalScrollIntoView) Object.defineProperty(Element.prototype, 'scrollIntoView', originalScrollIntoView)
  else Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  expect(network).not.toHaveBeenCalled()
})

it.each([
  ['chat-completions', 'OpenAI 兼容', 'https://current.example.invalid/v1'],
  ['responses', 'OpenAI Responses', 'https://current.example.invalid/v1'],
  ['messages', 'Anthropic 兼容', 'https://current.example.invalid'],
] as const)('tests a %s connection with current credentials before naming a supplier or choosing a model', async (protocol, label, baseUrl) => {
  const { onConnectionTest, onCheck, onSave } = await draw({ provider: null })
  await click(label)
  await type('Base URL', baseUrl)
  await type('API Key', `  ${currentKey}  `)
  expect(field('连接名称').value).toBe('')
  expect(field('模型 ID')).toBeNull()
  await click('连接测试')
  expect(onConnectionTest).toHaveBeenCalledOnce()
  const [request, signal] = onConnectionTest.mock.calls[0]!
  expect(request).toEqual({ presetId: 'custom', baseUrl, protocol, credential: { action: 'replace', value: currentKey } })
  expect(signal.aborted).toBe(false)
  expect(onCheck).not.toHaveBeenCalled()
  expect(onSave).not.toHaveBeenCalled()
  expect(form().querySelector('.st-connection-test')?.textContent).toContain('连接测试通过')
  expect(document.querySelectorAll('[data-sonner-toast][data-type="success"]')).toHaveLength(1)
  expect(activeToasts()).toHaveLength(1)
  expect(document.body.textContent).not.toContain(currentKey)
})

it.each(['passed', 'failed'] as const)('ignores a late %s connection result after the key changes, including its toast', async status => {
  const old = deferred<ModelConnectionTestResult>(), fresh = deferred<ModelConnectionTestResult>()
  const onConnectionTest = vi.fn<NonNullable<Props['onConnectionTest']>>()
    .mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise)
  await draw({ onConnectionTest })
  await click('连接测试')
  const [oldInput, oldSignal] = onConnectionTest.mock.calls[0]!
  await type('API Key', currentKey)
  expect(oldSignal.aborted).toBe(true)
  expect(form().querySelector('.st-connection-test')?.textContent).not.toContain('正在测试连接')
  await click('连接测试')
  expect(onConnectionTest.mock.calls[1]![0].credential).toEqual({ action: 'replace', value: currentKey })
  await act(async () => { old.resolve(connectionResult(oldInput, { status,
    diagnostic: { code: 'authentication', message: '旧密钥结果不得出现', suggestion: '旧建议不得出现' } })) })
  await settle()
  expect(document.body.textContent).not.toContain('旧密钥结果不得出现')
  expect(document.body.textContent).not.toContain('旧建议不得出现')
  expect(form().querySelector('.st-connection-test')?.textContent).toContain('正在测试连接')
  expect(activeToasts()).toHaveLength(0)
  await act(async () => { fresh.resolve(connectionResult(onConnectionTest.mock.calls[1]![0])) })
  await settle()
  expect(form().querySelector('.st-connection-test')?.textContent).toContain('连接测试通过')
  expect(activeToasts()).toHaveLength(1)
})

it('removes a completed connection result when editing its key without announcing the old result again', async () => {
  const { onConnectionTest } = await draw()
  await click('连接测试')
  expect(form().querySelector('.st-connection-test')?.textContent).toContain('连接测试通过')
  await act(async () => { toast.dismiss() })
  await type('API Key', currentKey)
  await type('连接名称', '名称修改也不应重复通知')
  await settle()
  expect(form().querySelector('.st-connection-test')?.textContent).not.toContain('连接测试通过')
  expect(activeToasts()).toHaveLength(0)
  expect(onConnectionTest).toHaveBeenCalledOnce()
})

it('tests the current card despite an invalid sibling draft, using its actual output limit and selected effort', async () => {
  const { onCheck, onConnectionTest, onSave } = await draw({ addModel: true })
  await type('API Key', currentKey)
  await type('模型 ID的最大输出 token', '96k')
  await select('模型 ID的默认思考强度', '高 · high')
  await type('搜索或输入模型 ID', 'unfinished-model'); await click('添加模型')
  await type('模型 ID 2的上下文窗口', '0.1K')
  expect(field('模型 ID 2的上下文窗口').getAttribute('aria-invalid')).toBe('true')
  await click('模型测试', testArea())
  expect(onCheck).toHaveBeenCalledOnce()
  const [source, options] = onCheck.mock.calls[0]!
  expect(source).toMatchObject({ credential: { action: 'replace', value: currentKey }, draft: {
    modelId: 'gpt-5.2', protocol: 'chat-completions', baseUrl: 'https://gateway.example.invalid/v1',
    path: '/chat/completions', maxOutputTokens: 98304, contextWindow: 524288, reasoningEffort: 'high', imageInput: false,
  } })
  expect(options!.configuration).toEqual('draft' in source ? source.draft : undefined)
  expect(options!.test.item).toBe('text')
  expect(options!.signal.aborted).toBe(false)
  expect(testArea().textContent).toContain('模型测试通过')
  expect(testArea().querySelector('.st-test-stages, .st-model-test-diagnostic')).toBeNull()
  expect(testArea().textContent).not.toContain('图片：')
  expect(testArea('unfinished-model').querySelector('.st-model-test-feedback')).toBeNull()
  expect(field('模型 ID 2的上下文窗口').value).toBe('0.1K')
  expect(onConnectionTest).not.toHaveBeenCalled()
  expect(onSave).not.toHaveBeenCalled()
  expect(document.querySelectorAll('[data-sonner-toast][data-type="success"]')).toHaveLength(1)
  await type('连接名称', '重绘不应再次通知')
  await settle()
  expect(activeToasts()).toHaveLength(1)
})

it('starts image testing only after text completes and retains the text pass when image testing fails', async () => {
  const text = deferred<ModelAttempt>(), images = deferred<ModelAttempt>()
  const onCheck = vi.fn<Props['onCheck']>(async (_source, options) => options!.test.item === 'text' ? text.promise : images.promise)
  await draw({ onCheck })
  await type('模型 ID的最大输出 token', '96K')
  await select('模型 ID的默认思考强度', '高 · high')
  await click('模型 ID的图片理解')
  expect(findButton('模型 ID的图片理解').getAttribute('aria-pressed')).toBe('true')
  await click('模型测试', testArea())
  expect(onCheck).toHaveBeenCalledOnce()
  const textOptions = onCheck.mock.calls[0]![1]!
  expect(textOptions.test.item).toBe('text')
  expect(textOptions.configuration).toMatchObject({ maxOutputTokens: 98304, reasoningEffort: 'high', imageInput: true })
  await act(async () => { textOptions.onAttempt!(completedAttempt(textOptions, {
    state: 'dispatched', physicalRequestEnded: false, resultRef: null, text: '', usage: { state: 'unknown' }, reason: '',
  })) })
  expect(testArea().textContent).toContain('正在测试文本与默认思考参数')
  expect(onCheck).toHaveBeenCalledOnce()
  expect(activeToasts()).toHaveLength(0)
  await act(async () => { text.resolve(completedAttempt(textOptions)) })
  expect(onCheck).toHaveBeenCalledTimes(2)
  const imageOptions = onCheck.mock.calls[1]![1]!
  expect(imageOptions.test).toEqual({ runId: textOptions.test.runId, item: 'images' })
  expect(imageOptions.configuration).toEqual(textOptions.configuration)
  expect(imageOptions.signal).toBe(textOptions.signal)
  expect(testArea().textContent).toContain('正在测试图片理解')
  expect(activeToasts()).toHaveLength(0)
  await act(async () => { images.resolve(completedAttempt(imageOptions, {
    state: 'failed', reason: 'upstream-unsupported', text: '',
    diagnostic: { code: 'image-rejected', message: '当前服务不接受图片输入。', suggestion: '关闭图片理解或换用支持图片的模型。', field: 'imageInput' },
    upstream: { httpStatus: 400, errorCode: 'unsupported_image', requestId: 'synthetic-image-request' },
  })) })
  await settle()
  expect(testArea().textContent).toContain('文本通过，图片测试未通过')
  expect(testArea().querySelector('.st-test-stages')).toBeNull()
  expect(testArea().querySelector('.astryx-banner-description')?.textContent)
    .toBe('当前服务不接受图片输入。关闭图片理解或换用支持图片的模型。')
  const diagnostic = testArea().querySelector('details')!
  expect(diagnostic.open).toBe(false)
  await act(async () => { diagnostic.querySelector('summary')!.click() })
  expect(diagnostic.open).toBe(true)
  expect(diagnostic.querySelector('pre')?.textContent).toContain('HTTP：400')
  expect(diagnostic.querySelector('pre')?.textContent).toContain('synthetic-image-request')
  expect(field('模型 ID的最大输出 token').value).toBe('96K')
  expect(findButton('模型 ID的默认思考强度').textContent).toContain('高 · high')
  expect(document.querySelectorAll('[data-sonner-toast][data-type="error"]')).toHaveLength(1)
  expect(document.querySelector('[data-sonner-toast][data-type="success"]')).toBeNull()
  expect(onCheck).toHaveBeenCalledTimes(2)
})

it('notifies an admission rejection without keeping a model result card and allows a later test', async () => {
  const onCheck = vi.fn<Props['onCheck']>(async (_source, options) => completedAttempt(options!))
    .mockRejectedValueOnce(Object.assign(new Error('检查频次或并发已达上限，请稍后再试。'), { code: 'resource-busy' }))
  await draw({ onCheck })
  await click('模型测试', testArea())
  expect(testArea().querySelector('.st-model-test-feedback')).toBeNull()
  expect(document.querySelectorAll('[data-sonner-toast][data-type="error"]')).toHaveLength(1)
  const notification = activeToasts()[0]
  expect(notification && 'title' in notification ? notification.title : '').toContain('检查频次或并发已达上限')
  await click('模型测试', testArea())
  expect(onCheck).toHaveBeenCalledTimes(2)
  expect(testArea().textContent).toContain('模型测试通过')
})

it('validates unused declared efforts locally and sends only the selected default after the declaration is fixed', async () => {
  const provider = savedProvider({ modelId: 'custom-reasoner', protocol: 'messages', baseUrl: 'https://messages.example.invalid',
    path: '/v1/messages', reasoningEffort: 'high', reasoningSource: 'manual', reasoningLevels: ['minimal', 'high'] })
  const { onCheck, onConnectionTest } = await draw({ provider })
  expect(findButton('模型 ID的默认思考强度').textContent).toContain('高 · high')
  expect(activeToasts()).toHaveLength(0)
  await click('模型测试', testArea('custom-reasoner'))
  expect(onCheck).not.toHaveBeenCalled()
  expect(onConnectionTest).not.toHaveBeenCalled()
  expect(testArea('custom-reasoner').textContent).toContain('配置校验未通过')
  expect(testArea('custom-reasoner').textContent).toContain('思考档位 minimal：Messages 标准协议没有 minimal effort')
  await click('最低 · minimal', card('custom-reasoner'))
  expect(onCheck).not.toHaveBeenCalled()
  await click('模型测试', testArea('custom-reasoner'))
  expect(onCheck).toHaveBeenCalledOnce()
  expect(onCheck.mock.calls[0]![1]).toMatchObject({ test: { item: 'text' },
    configuration: { reasoningEffort: 'high', reasoningLevels: ['high'] } })
  expect(testArea('custom-reasoner').textContent).toContain('模型测试通过')
})

it('invalidates a pending test when late metadata changes its resolved configuration', async () => {
  const metadata = deferred<Awaited<ReturnType<Props['onProfiles']>>>()
  const checked = deferred<ModelAttempt>()
  let pending!: CheckOptions
  await draw({ provider: null, onProfiles: async () => metadata.promise,
    onCheck: async (_source, options) => { pending = options!; return checked.promise } })
  await type('Base URL', 'https://gateway.example.invalid/v1')
  await type('API Key', currentKey)
  await type('搜索或输入模型 ID', 'metadata-model'); await click('添加模型')
  await act(async () => { await vi.advanceTimersByTimeAsync(400) })
  await click('模型测试', testArea('metadata-model'))
  expect(pending.configuration.maxOutputTokens).toBe(65536)
  await act(async () => { metadata.resolve({ profiles: [{ modelId: 'metadata-model', dialect: 'standard',
    source: 'catalogue', efforts: ['auto'], maxOutputTokens: 8192 }], stale: false }); await vi.advanceTimersByTimeAsync(0) })
  expect(pending.signal.aborted).toBe(true)
  expect(testArea('metadata-model').textContent).toContain('模型配置已更新')
  await act(async () => { checked.resolve(completedAttempt(pending)); await vi.advanceTimersByTimeAsync(0) })
  expect(testArea('metadata-model').textContent).not.toContain('模型测试通过')
})

it('keeps mixed toggle and effort declarations editable and rejects them locally', async () => {
  const callbacks = await draw()
  await click('模型 ID的手动配置')
  await click('开启思考 · enabled')
  expect(form().textContent).toContain('enabled 表示思考开关，不能与思考强度档位混合声明。')
  await click('模型测试', testArea())
  expect(callbacks.onCheck).not.toHaveBeenCalled()
  expect(testArea().textContent).toContain('配置校验未通过')
  await click('开启思考 · enabled')
  await click('模型测试', testArea())
  expect(callbacks.onCheck).toHaveBeenCalledOnce()
  expect(testArea().textContent).toContain('模型测试通过')
})

it('aborts the text request on Stop and never starts image testing even if text completes late', async () => {
  const text = deferred<ModelAttempt>()
  const onCheck = vi.fn<Props['onCheck']>(() => text.promise)
  const { onCancel } = await draw({ onCheck })
  await click('模型 ID的图片理解')
  const trigger = findButton('模型测试', testArea())
  await act(async () => trigger.focus())
  await click('模型测试', testArea())
  expect(findButton('停止模型测试', testArea())).toBe(trigger)
  expect(document.activeElement).toBe(trigger)
  const options = onCheck.mock.calls[0]![1]!
  expect(options.test.item).toBe('text')
  await click('停止模型测试', testArea())
  expect(options.signal.aborted).toBe(true)
  await act(async () => { text.resolve(completedAttempt(options)) })
  await settle()
  expect(onCheck).toHaveBeenCalledOnce()
  expect(testArea().textContent).toContain('模型测试已停止')
  expect(testArea().textContent).not.toContain('图片：')
  expect(findButton('模型测试', testArea()).disabled).toBe(false)
  expect(findButton('模型 ID的图片理解').getAttribute('aria-pressed')).toBe('true')
  expect(onCancel).not.toHaveBeenCalled()
  expect(activeToasts()).toHaveLength(0)
})

it.each(['failed', 'incomplete'] as const)('does not issue an image request after a %s text attempt', async state => {
  const onCheck = vi.fn<Props['onCheck']>(async (_source, options) => completedAttempt(options!, {
    state, reason: state === 'failed' ? 'upstream-http' : 'max_tokens', text: 'Synthetic partial answer', usage: { state: 'partial', outputTokens: 7 },
  }))
  await draw({ onCheck })
  await click('模型 ID的图片理解')
  await click('模型测试', testArea())
  expect(onCheck).toHaveBeenCalledOnce()
  expect(onCheck.mock.calls[0]![1]!.test.item).toBe('text')
  expect(testArea().textContent).toContain(state === 'failed' ? '文本测试未通过' : '文本测试未完整结束')
  expect(testArea().textContent).not.toContain('图片：')
  expect(document.querySelector('[data-sonner-toast][data-type="success"]')).toBeNull()
  expect(activeToasts()).toHaveLength(1)
})

async function pickFetched(id: string) {
  const checkbox = card(id)?.querySelector<HTMLButtonElement>('[role="checkbox"]')
  expect(checkbox, id).toBeDefined()
  await act(async () => { checkbox!.click() })
  await settle()
}

it('keeps a new custom list empty, separates catalogue data, and offers retry and manual entry after a failed or empty fetch', async () => {
  let count = 0
  const onDirectory = vi.fn<NonNullable<Props['onDirectory']>>(async query => query.source === 'supplier'
    ? ++count === 1 ? { models: [], catalogue: { status: 'idle' }, supplier: { status: 'failed', error: 'unauthorized',
      diagnostic: { code: 'authentication', message: '供应商拒绝了当前密钥', suggestion: '请核对 API Key 后重试' } } }
      : { models: [], catalogue: { status: 'idle' }, supplier: { status: 'ready' } }
    : { models: [{ modelId: 'catalogue-only' }], catalogue: { status: 'ready' } })
  const { onSave } = await draw({ provider: null, onDirectory })
  expect(form().querySelector('[aria-label="自定义模型"]')!.textContent).toBe('')
  expect(card('catalogue-only')).toBeUndefined()
  await type('Base URL', 'https://supplier.example.invalid/v1'); await type('API Key', currentKey)
  await click('拉取模型')
  expect(form().textContent).toContain('供应商拒绝了当前密钥')
  expect(form().querySelectorAll('.st-model-choice')).toHaveLength(0)
  await click('重试')
  expect(form().textContent).toContain('供应商未返回模型')
  await type('搜索或输入模型 ID', 'handwritten-model'); await click('添加模型')
  expect(card('handwritten-model').getAttribute('data-selected')).toBe('true')
  expect(onSave).not.toHaveBeenCalled()
})

it('retains candidates and their edits on a failed refresh and invalidates them when the address changes', async () => {
  let count = 0
  const onDirectory = vi.fn<NonNullable<Props['onDirectory']>>(async query => query.source !== 'supplier' ? catalogue(query)
    : ++count === 1 ? { models: [{ modelId: 'candidate-one' }, { modelId: 'candidate-two' }], catalogue: { status: 'idle' }, supplier: { status: 'ready' } }
      : { models: [], catalogue: { status: 'idle' }, supplier: { status: 'failed', error: 'timeout' } })
  await draw({ onDirectory })
  await click('拉取模型'); await pickFetched('candidate-one')
  await type('模型 ID 2的最大输出 token', '32K')
  await click('拉取模型')
  expect(form().textContent).toContain('拉取模型未完成')
  expect(card('candidate-two')).toBeDefined()
  expect(field('模型 ID 2的最大输出 token').value).toBe('32K')
  await type('Base URL', 'https://new-supplier.example.invalid/v1')
  expect(card('candidate-two')).toBeUndefined()
  expect(card('candidate-one').getAttribute('data-selected')).toBe('true')
  expect(field('模型 ID 2的最大输出 token').value).toBe('32K')
})

it('enforces the 64-model selection limit without opening an empty card or hiding fetched candidates', async () => {
  const provider = savedProvider()
  provider.models = Array.from({ length: 64 }, (_, index) => ({ ...provider.models[0]!, connectionId: crypto.randomUUID(), modelId: `saved-${index}` }))
  const onDirectory = vi.fn<NonNullable<Props['onDirectory']>>(async query => query.source !== 'supplier' ? catalogue(query)
    : { models: [{ modelId: 'over-limit' }], catalogue: { status: 'idle' }, supplier: { status: 'ready' } })
  await draw({ provider, onDirectory })
  await click('拉取模型')
  await click('展开 over-limit 的配置')
  expect(card('over-limit').getAttribute('data-selected')).toBeNull()
  expect(card('over-limit').querySelector('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('false')
  expect(form().querySelectorAll('.st-model-choice')).toHaveLength(65)
  expect(activeToasts().some(item => 'title' in item && item.title === '每个供应商最多配置 64 个模型。')).toBe(true)
})

it('lists fetched supplier models as unselected cards and saves only checked models while preserving existing configuration', async () => {
  const provider = savedProvider({ enabled: false, modelEnabled: false, imageInput: true })
  const pending = deferred<ModelDirectory>()
  const onDirectory = vi.fn<NonNullable<Props['onDirectory']>>(async query => query.source === 'supplier' ? pending.promise : catalogue(query))
  const { onSave, onCheck, onConnectionTest } = await draw({ provider, onDirectory })
  const baseUrl = 'https://supplier-current.example.invalid/v1'
  await type('Base URL', baseUrl)
  await click('OpenAI Responses')
  await type('API Key', `  ${currentKey}  `)
  await type('模型 ID的上下文窗口', '768k')
  await type('模型 ID的最大输出 token', '96K')
  await select('模型 ID的默认思考强度', '高 · high')
  expect(onDirectory.mock.calls.some(([query]) => query.source === 'supplier')).toBe(false)
  await click('拉取模型')
  expect(form().textContent).toContain('拉取中…')
  expect(card('fetched-alpha')).toBeUndefined()
  const supplierReads = onDirectory.mock.calls.filter(([query]) => query.source === 'supplier')
  expect(supplierReads).toHaveLength(1)
  expect(supplierReads[0]![0]).toEqual({ presetId: 'custom', baseUrl, protocol: 'responses',
    credential: { action: 'replace', value: currentKey }, source: 'supplier', refresh: true, manual: true })
  expect(supplierReads[0]![1]?.aborted).toBe(false)
  await act(async () => { pending.resolve({ models: [
    { modelId: 'gpt-5.2', name: '供应商中的已有型号', contextWindow: 32768, maxOutputTokens: 16384, efforts: ['low', 'medium', 'high'] },
    { modelId: 'fetched-alpha', name: 'Fetched Alpha' }, { modelId: 'fetched-beta', name: 'Fetched Beta' },
    { modelId: 'fetched-alpha', name: 'Fetched Alpha' },
  ], catalogue: { status: 'idle' }, supplier: { status: 'ready' } }) })
  await settle()
  expect(card('gpt-5.2').querySelector('[aria-label="已配置"]')).not.toBeNull()
  expect(form().querySelectorAll('.st-model-choice')).toHaveLength(3)
  expect(card('fetched-alpha').getAttribute('data-selected')).toBeNull()
  expect(card('fetched-alpha').querySelector('[aria-expanded]')!.getAttribute('aria-expanded')).toBe('false')
  expect(card('fetched-alpha').textContent).toContain('Fetched Alpha')
  expect(form().querySelector('[role="listbox"][aria-label="可添加的模型"]')).toBeNull()
  await pickFetched('fetched-beta')
  expect([...form().querySelectorAll('.st-model-choice')].map(item => item.getAttribute('aria-label')))
    .toEqual(['gpt-5.2', 'fetched-alpha', 'fetched-beta'])
  await pickFetched('fetched-beta')
  await pickFetched('fetched-alpha')
  expect(card('fetched-alpha').getAttribute('data-selected')).toBe('true')
  expect(onSave).not.toHaveBeenCalled()
  await type('模型 ID 2的最大输出 token', '32K')
  await pickFetched('fetched-alpha')
  expect(card('fetched-alpha').getAttribute('data-selected')).toBeNull()
  await pickFetched('fetched-alpha')
  expect(field('模型 ID 2的最大输出 token').value).toBe('32K')
  expect(field('模型 ID的上下文窗口').value).toBe('768k')
  expect(field('模型 ID的最大输出 token').value).toBe('96K')
  expect(findButton('模型 ID的默认思考强度').textContent).toContain('高 · high')
  expect(findButton('模型 ID的图片理解').getAttribute('aria-pressed')).toBe('true')
  await click('拉取模型')
  await pickFetched('fetched-beta')
  await pickFetched('fetched-beta')
  expect(card('fetched-beta').getAttribute('data-selected')).toBeNull()
  expect(form().querySelectorAll('.st-model-choice')).toHaveLength(3)
  await click('保存')
  expect(onSave).toHaveBeenCalledOnce()
  const saved = onSave.mock.calls[0]![0]
  expect(saved).toMatchObject({ providerId: provider.providerId, expectedVersion: 3, name: provider.name,
    baseUrl, protocol: 'responses', credential: { action: 'replace', value: currentKey } })
  expect(saved.models.map(model => model.modelId)).toEqual(['gpt-5.2', 'fetched-alpha'])
  expect(saved.models[0]).toMatchObject({ connectionId: provider.models[0]!.connectionId, expectedVersion: 2, enabled: false,
    protocol: 'responses', baseUrl, contextWindow: 786432, maxOutputTokens: 98304, reasoningEffort: 'high', imageInput: true })
  expect(onCheck).not.toHaveBeenCalled()
  expect(onConnectionTest).not.toHaveBeenCalled()
})

it.each(['success', 'failure'] as const)('ignores a stale supplier %s after changing source and fetches fresh data on return', async outcome => {
  const old = deferred<ModelDirectory>()
  let supplierReads = 0
  const onDirectory = vi.fn<NonNullable<Props['onDirectory']>>(async query => {
    if (query.source !== 'supplier') return catalogue(query)
    if (++supplierReads === 1) return old.promise
    return { models: [{ modelId: 'fresh-current-source' }], catalogue: { status: 'idle' }, supplier: { status: 'ready' } }
  })
  await draw({ onDirectory })
  await type('模型 ID的上下文窗口', '768K')
  await type('API Key', currentKey)
  await click('拉取模型')
  const oldSignal = onDirectory.mock.calls.find(([query]) => query.source === 'supplier')![1]!
  await select('供应商', 'DeepSeek 官方')
  expect(oldSignal.aborted).toBe(true)
  expect(findButton('拉取模型')).toBeUndefined()
  await act(async () => { old.resolve(outcome === 'success' ? {
    models: [{ modelId: 'stale-old-source-model' }], catalogue: { status: 'idle' }, supplier: { status: 'ready' },
  } : {
    models: [], catalogue: { status: 'idle' }, supplier: { status: 'failed', error: 'unauthorized', httpStatus: 401,
      diagnostic: { code: 'authentication', message: '旧来源认证错误不得显示', suggestion: '旧来源建议不得显示' } },
  }) })
  await settle()
  expect(document.body.textContent).not.toContain('stale-old-source-model')
  expect(document.body.textContent).not.toContain('旧来源认证错误不得显示')
  expect(activeToasts()).toHaveLength(0)
  await select('供应商', '自定义')
  expect(field('API Key').value).toBe(currentKey)
  expect(field('模型 ID').value).toBe('gpt-5.2')
  expect(field('模型 ID的上下文窗口').value).toBe('768K')
  await click('拉取模型')
  expect(supplierReads).toBe(2)
  expect(card('fresh-current-source')).toBeDefined()
  expect(card('stale-old-source-model')).toBeUndefined()
  expect(form().textContent).not.toContain('旧来源认证错误不得显示')
  await pickFetched('fresh-current-source')
  expect(card('fresh-current-source')).toBeDefined()
  expect(card('stale-old-source-model')).toBeUndefined()
  expect(field('模型 ID的上下文窗口').value).toBe('768K')
})
