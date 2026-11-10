// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { Toaster, toast } from '@xunjie/ui/feedback'
import { PersonalSkillsSettings } from './PersonalSkillsSettings'

const identity: SpaceIdentity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(),
  principalId: crypto.randomUUID(), name: '测试者', kind: 'personal' }
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 0)); await new Promise(resolve => setTimeout(resolve, 0)) }
const click = async (host: HTMLElement, text: string) => act(async () => {
  const button = Array.from(host.querySelectorAll('button')).find(item => item.textContent === text)
  expect(button).toBeDefined(); button!.click(); await settle()
})
const render = async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(createElement('div', null, createElement(Toaster), createElement(PersonalSkillsSettings, { identity, spaceKey: 'personal', namespace: 'test' }))); await settle()
  })
  return { host, root }
}
afterEach(() => { toast.dismiss(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('retains the GitHub form through exit and can reopen before exit finishes without losing the address', async () => {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback))
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ skills: [], selections: [] })))
  const { host, root } = await render()
  try {
    await click(host, '导入 Skill'); await click(host, 'GitHub 导入')
    const dialog = host.querySelector('[role="dialog"][aria-label="GitHub 导入"]')!
    expect(dialog).not.toBeNull()
    expect(host.querySelector('[role="menu"]')).toBeNull()
    const input = dialog.querySelector<HTMLInputElement>('[aria-label="GitHub 地址"]')!
    await act(async () => {
      input.focus()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://github.com/example/skills')
      input.dispatchEvent(new Event('input', { bubbles: true })); await settle()
    })
    expect(Array.from(dialog.querySelectorAll('button')).map(button => button.textContent)).toEqual(['导入'])
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle() })
    expect(host.querySelector('[role="dialog"]')).toBe(dialog)
    expect(dialog.getAttribute('aria-hidden')).toBe('true')
    expect(dialog.hasAttribute('inert')).toBe(true)
    const trigger = host.querySelector<HTMLButtonElement>('[aria-haspopup]')!
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    expect(document.activeElement).toBe(trigger)
    await act(async () => { for (const frame of frames.splice(0)) frame(performance.now()); await settle() })
    expect(document.activeElement).toBe(trigger)
    await click(host, '导入 Skill'); await click(host, 'GitHub 导入')
    expect(host.querySelector<HTMLInputElement>('[aria-label="GitHub 地址"]')!.value).toBe('https://github.com/example/skills')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)) })
    expect(host.querySelector('[role="dialog"]')?.hasAttribute('inert')).toBe(false)
    await act(async () => { document.body.dispatchEvent(new Event('pointerdown', { bubbles: true })); await settle() })
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-hidden')).toBe('true')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 160)) })
    expect(host.querySelector('.st-action-menu-popup')).toBeNull()
  } finally { await act(async () => { root.unmount(); await settle() }); host.remove() }
})

it('keeps the popup and address available when GitHub import fails', async () => {
  const feedback = vi.spyOn(toast, 'error')
  vi.stubGlobal('fetch', vi.fn(async (_route: string, options: RequestInit) => options.method === 'POST'
    ? Response.json({ error: 'github-not-found' }, { status: 404 })
    : Response.json({ skills: [], selections: [] })))
  const { host, root } = await render()
  try {
    await click(host, '导入 Skill'); await click(host, 'GitHub 导入')
    const input = host.querySelector<HTMLInputElement>('[aria-label="GitHub 地址"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://github.com/example/missing')
      input.dispatchEvent(new Event('input', { bubbles: true })); await settle()
    })
    await act(async () => { input.closest('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); await settle() })
    await act(async () => { await settle() })
    expect(feedback).toHaveBeenCalledWith(expect.stringContaining('未找到公开仓库'), expect.any(Object))
    expect(host.querySelector('[data-sonner-toast][data-type="error"]')?.textContent).toContain('未找到公开仓库')
    expect(host.querySelector<HTMLInputElement>('[aria-label="GitHub 地址"]')!.value).toBe('https://github.com/example/missing')
  } finally { await act(async () => { root.unmount(); await settle() }); host.remove() }
})
