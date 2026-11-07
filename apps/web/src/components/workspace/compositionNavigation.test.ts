// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { protectCompositionNavigation } from './compositionNavigation'

const disposables: (() => void)[] = []
afterEach(() => { disposables.splice(0).forEach(dispose => dispose()); document.body.replaceChildren(); vi.useRealTimers() })

function surface() {
  const host = document.createElement('div'), input = document.createElement('textarea')
  const tab = document.createElement('button')
  tab.setAttribute('role', 'tab')
  tab.textContent = 'ALU 实验'
  input.value = 'existing work'
  host.append(input)
  document.body.append(host, tab)
  const activate = vi.fn()
  tab.addEventListener('click', activate)
  input.focus()
  disposables.push(protectCompositionNavigation(host))
  const compose = () => input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  const settle = () => input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
  const choose = (target = tab) => {
    const down = new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
    target.dispatchEvent(down)
    target.click()
    return down
  }
  return { host, input, tab, activate, compose, settle, choose }
}

describe('tool navigation while the editor owns an IME composition', () => {
  it('keeps editor focus and defers the requested tab until commit or cancel settles', async () => {
    vi.useFakeTimers()
    const view = surface()
    view.compose()
    expect(view.choose().defaultPrevented).toBe(true)
    expect(view.activate).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(view.input)
    expect(view.input.value).toBe('existing work')
    view.settle()
    expect(view.activate).not.toHaveBeenCalled()
    await vi.runAllTimersAsync()
    expect(view.activate).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(view.tab)
    expect(view.input.value).toBe('existing work')
  })

  it('leaves normal navigation and clicks inside the editor unchanged', () => {
    const view = surface()
    expect(view.choose().defaultPrevented).toBe(false)
    expect(view.activate).toHaveBeenCalledTimes(1)
    view.compose()
    const internal = document.createElement('button'), internalClick = vi.fn()
    internal.setAttribute('role', 'tab')
    internal.addEventListener('click', internalClick)
    view.host.append(internal)
    expect(view.choose(internal).defaultPrevented).toBe(false)
    expect(internalClick).toHaveBeenCalledTimes(1)
  })

  it('keeps only the latest tab request and never replays a detached target', async () => {
    vi.useFakeTimers()
    const view = surface(), other = document.createElement('button'), activateOther = vi.fn()
    other.setAttribute('role', 'tab')
    other.addEventListener('click', activateOther)
    document.body.append(other)
    view.compose()
    view.choose()
    view.choose(other)
    view.settle()
    await vi.runAllTimersAsync()
    expect(view.activate).not.toHaveBeenCalled()
    expect(activateOther).toHaveBeenCalledTimes(1)
    view.input.focus()
    view.compose()
    view.choose()
    view.tab.remove()
    view.settle()
    await vi.runAllTimersAsync()
    expect(view.activate).not.toHaveBeenCalled()
  })

  it('drops pending navigation when the editor is disposed or a new composition begins', async () => {
    vi.useFakeTimers()
    const view = surface()
    view.compose()
    view.choose()
    view.settle()
    view.compose()
    await vi.runAllTimersAsync()
    expect(view.activate).not.toHaveBeenCalled()
    view.choose()
    disposables.splice(0).forEach(dispose => dispose())
    view.settle()
    await vi.runAllTimersAsync()
    expect(view.activate).not.toHaveBeenCalled()
  })
})
