// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SelectField } from '@xunjie/ui/foundation'
import { WorkspacePopover } from '@xunjie/ui/workspace'

let root: Root
const settle = () => new Promise(resolve => setTimeout(resolve, 20))
async function click(element: HTMLElement) { await act(async () => { element.click(); await settle() }) }
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} })
  window.matchMedia ??= vi.fn().mockReturnValue({ matches: false, addEventListener() {}, removeEventListener() {} })
  Element.prototype.scrollIntoView ??= vi.fn()
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
})
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.unstubAllGlobals() })

it('keeps workspace controls open during selection, then Escape closes only the innermost menu', async () => {
  const action = vi.fn(), change = vi.fn()
  function Harness() {
    const [value, setValue] = useState('auto')
    return <WorkspacePopover label="运行设置" closeOnAction>
      <SelectField label="运行方式" value={value} options={[{ value: 'auto', label: '自动' }, { value: 'manual', label: '手动' }]}
        onChange={next => { setValue(next); change(next) }} />
      <button type="button" onClick={action}>开始运行</button>
    </WorkspacePopover>
  }
  await act(async () => root.render(<Harness />))
  const launcher = [...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === '运行设置')!
  await click(launcher)
  const trigger = document.querySelector<HTMLButtonElement>('[aria-label="运行方式"]')!
  await click(trigger)
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(element => element.textContent === '手动')!
  await act(async () => { option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); option.click(); await settle() })
  expect(change).toHaveBeenLastCalledWith('manual')
  expect(document.querySelector('[aria-label="运行设置"][role="region"]')).not.toBeNull()
  expect(trigger.textContent).toContain('手动')
  await click(trigger)
  await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle() })
  expect(trigger.getAttribute('aria-expanded')).toBe('false')
  expect(document.querySelector('[aria-label="运行设置"][role="region"]')).not.toBeNull()
  await act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); await settle() })
  expect(document.querySelector('[aria-label="运行设置"][role="region"]')).toBeNull()
  expect(document.activeElement).toBe(launcher)
  await click(launcher)
  await click([...document.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === '开始运行')!)
  expect(action).toHaveBeenCalledOnce()
  expect(document.querySelector('[aria-label="运行设置"][role="region"]')).toBeNull()
})
