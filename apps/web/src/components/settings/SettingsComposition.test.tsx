import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'

const { JSDOM } = createRequire(import.meta.url)('jsdom')
let dom: ReturnType<typeof JSDOM>, root: Root
let ui: typeof import('@xunjie/ui/settings')
let createRoot: typeof import('react-dom/client').createRoot
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
const model = { id: 'original', contextWindow: '1000', maxOutput: '100', inputTypes: [], reasoningLevels: [] }
const provider = { id: 'p1', name: '原供应商', baseUrl: 'https://synthetic.invalid/v1', apiKey: '', hasKey: true, models: [model] }
function button(label: string) {
  const element = [...document.querySelectorAll('button')].find(item => item.textContent?.trim() === label)
  expect(element, label).toBeDefined()
  return element!
}
async function click(label: string) { await act(async () => { button(label).click(); await settle() }) }
async function draw(element: React.ReactNode) { await act(async () => { root.render(element); await settle() }) }

beforeAll(async () => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://settings.invalid', pretendToBeVisual: true })
  for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLSelectElement', 'Node', 'NodeFilter', 'Event', 'MouseEvent', 'FocusEvent', 'CustomEvent', 'MutationObserver', 'DocumentFragment'])
    vi.stubGlobal(name, dom.window[name])
  vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window))
  vi.stubGlobal('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window))
  vi.stubGlobal('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window))
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  ;({ createRoot } = await import('react-dom/client'))
  ui = await import('@xunjie/ui/settings')
})
beforeEach(() => {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = '' })
afterAll(() => { dom.window.close(); vi.unstubAllGlobals() })

it('moves radio focus and selection with arrow keys while skipping unavailable choices', async () => {
  const onChange = vi.fn()
  await draw(createElement(ui.RadioCard, { value: 'a', onChange, ariaLabel: '交互方式',
    options: [{ value: 'a', title: '方式 A' }, { value: 'b', title: '不可用', disabled: true }, { value: 'c', title: '方式 C' }] }))
  const radios = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
  expect(radios.map(item => item.tabIndex)).toEqual([0, -1, -1])
  await act(async () => { radios[0].focus(); radios[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })) })
  expect(document.activeElement).toBe(radios[2])
  expect(onChange).toHaveBeenLastCalledWith('c')
  await act(async () => radios[2].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
  expect(document.activeElement).toBe(radios[0])
  expect(onChange).toHaveBeenLastCalledWith('a')
})

it('keeps action availability controlled and dispatches each enabled action once', async () => {
  const onReload = vi.fn(), onToggle = vi.fn()
  const props = { saving: false, enabled: true, reloadDisabled: false, toggleDisabled: false, onReload, onToggle }
  await draw(createElement(ui.ModelConfigActions, props))
  await click('重新读取配置'); await click('停用个人模型')
  expect(onReload).toHaveBeenCalledTimes(1); expect(onToggle).toHaveBeenCalledTimes(1)
  await draw(createElement(ui.ModelConfigActions, { ...props, saving: true, reloadDisabled: true, toggleDisabled: true }))
  await click('重新读取配置'); await click('保存中…')
  expect(onReload).toHaveBeenCalledTimes(1); expect(onToggle).toHaveBeenCalledTimes(1)
})

it('preserves test feedback while another request disables the row', async () => {
  const onTest = vi.fn()
  await draw(createElement(ui.ModelConnectionTestRow, { testing: false, disabled: false, result: { ok: false, text: '结果未确认' }, onTest }))
  await click('连接测试'); expect(onTest).toHaveBeenCalledTimes(1)
  await draw(createElement(ui.ModelConnectionTestRow, { testing: true, disabled: true, result: { ok: false, text: '结果未确认' }, onTest }))
  await click('测试中…'); expect(onTest).toHaveBeenCalledTimes(1)
  expect(document.querySelector('[role="status"]')?.textContent).toBe('结果未确认')
})

it('imports supplied capabilities, retains a failed save and closes only after confirmation', async () => {
  const onClose = vi.fn(), onSave = vi.fn().mockRejectedValueOnce(new Error('unconfirmed')).mockResolvedValue(undefined)
  const onTest = vi.fn(async () => ({ ok: true, text: '检查完成', models: [{ id: 'imported', name: '新模型', contextWindow: 2000, maxOutputTokens: 200 }] }))
  await draw(createElement(ui.ProviderSettingsDialog, { open: true, provider, preparation: false, onClose, onSave, onTest }))
  await click('连接测试')
  expect(onTest).toHaveBeenCalledWith({ id: 'p1', baseUrl: provider.baseUrl, apiKey: '' })
  const select = document.querySelector<HTMLSelectElement>('[aria-label="供应商可用模型"]')!
  await act(async () => { select.value = 'imported'; select.dispatchEvent(new Event('change', { bubbles: true })); await settle() })
  await click('保存')
  expect(onClose).not.toHaveBeenCalled()
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('保存未确认')
  expect(onSave.mock.calls[0][0].models.map((item: { id: string }) => item.id)).toEqual(['original', 'imported'])
  await click('保存'); expect(onClose).toHaveBeenCalledTimes(1)
})

it('unmounts a closed model form and starts the next dialog from its supplied model', async () => {
  const props = { preparation: false, providerDialog: null, modelDialog: { provider, model },
    onCloseProvider: vi.fn(), onCloseModel: vi.fn(), onSaveProvider: vi.fn(), onSaveModel: vi.fn(),
    onTestProvider: vi.fn(async () => ({ ok: true, text: '检查完成' })) }
  await draw(createElement(ui.LegacyModelDialogs, props))
  expect(document.querySelector<HTMLInputElement>('[placeholder^="模型 ID"]')?.value).toBe('original')
  await draw(createElement(ui.LegacyModelDialogs, { ...props, modelDialog: null }))
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  await draw(createElement(ui.LegacyModelDialogs, { ...props, modelDialog: { provider, model: { ...model, id: 'next' } } }))
  expect(document.querySelector<HTMLInputElement>('[placeholder^="模型 ID"]')?.value).toBe('next')
})

it('uses the adapter router handler without taking over modified link clicks', async () => {
  const { MemoryRouter, useHref, useLinkClickHandler, useLocation } = await import('react-router-dom')
  function Harness() {
    const href = useHref('/settings/agent'), onClick = useLinkClickHandler<HTMLAnchorElement>('/settings/agent')
    const location = useLocation()
    return createElement('div', null, createElement(ui.SettingsAgentLink, { href, onClick, 'data-discover': 'true' }),
      createElement('output', null, location.pathname))
  }
  await draw(createElement(MemoryRouter, { initialEntries: ['/settings/portrait'] }, createElement(Harness)))
  const link = document.querySelector('a')!
  expect(link.outerHTML).toContain('class="st-link"')
  let routerPreventedModifiedClick = true
  document.addEventListener('click', event => {
    routerPreventedModifiedClick = event.defaultPrevented
    // JSDOM cannot open a modified link in another browser tab.
    event.preventDefault()
  }, { once: true })
  await act(async () => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, ctrlKey: true })); await settle() })
  expect(routerPreventedModifiedClick).toBe(false)
  expect(document.querySelector('output')?.textContent).toBe('/settings/portrait')
  await act(async () => { link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); await settle() })
  expect(document.querySelector('output')?.textContent).toBe('/settings/agent')
})
