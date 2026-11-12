// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ModelIdInput } from '@xunjie/ui/settings'

let root: Root, host: HTMLDivElement
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)) }
const draw = async (loading: boolean, options: { value: string; label: string }[]) => act(async () => {
  root.render(<ModelIdInput label="模型 ID" value="" options={options} loading={loading} onChange={() => {}} />)
  await settle()
})
const open = async () => act(async () => {
  document.querySelector<HTMLButtonElement>('button[aria-label="展开模型 ID列表"]')!.click()
  await settle()
})

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  window.matchMedia ??= vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} })
  Element.prototype.scrollIntoView ??= vi.fn()
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

it('names an empty model list load instead of presenting it as no results', async () => {
  await draw(true, [])
  await open()
  expect(document.querySelector('.ui-select-empty')?.textContent).toContain('正在更新模型列表…')
  expect(document.querySelector('.ui-select-empty')?.hasAttribute('data-loading')).toBe(true)
})

it('keeps current choices usable while naming a background model-list refresh', async () => {
  await draw(true, [{ value: 'model-a', label: '模型 A' }])
  await open()
  expect(document.querySelector('.ui-select-item')?.textContent).toContain('模型 A')
  expect(document.querySelector('.ui-select-foot')?.textContent).toBe('正在更新模型列表…')
  expect(document.querySelector('.ui-select-foot')?.getAttribute('role')).toBe('status')
})
