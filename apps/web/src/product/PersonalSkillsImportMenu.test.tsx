// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
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
    root.render(createElement(PersonalSkillsSettings, { identity, spaceKey: 'personal', namespace: 'test' })); await settle()
  })
  return { host, root }
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

it('replaces the menu with a GitHub form and retains the address after Escape', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ skills: [], selections: [] })))
  const { host, root } = await render()
  try {
    await click(host, '导入 Skill'); await click(host, 'GitHub 导入')
    const dialog = host.querySelector('[role="dialog"][aria-label="GitHub 导入"]')!
    expect(dialog).not.toBeNull()
    expect(host.querySelector('[role="menu"]')).toBeNull()
    const input = dialog.querySelector<HTMLInputElement>('[aria-label="GitHub 地址"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'https://github.com/example/skills')
      input.dispatchEvent(new Event('input', { bubbles: true })); await settle()
    })
    expect(Array.from(dialog.querySelectorAll('button')).map(button => button.textContent)).toEqual(['导入'])
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle() })
    expect(host.querySelector('[role="dialog"]')).toBeNull()
    await click(host, '导入 Skill'); await click(host, 'GitHub 导入')
    expect(host.querySelector<HTMLInputElement>('[aria-label="GitHub 地址"]')!.value).toBe('https://github.com/example/skills')
  } finally { await act(async () => { root.unmount(); await settle() }); host.remove() }
})

it('keeps the popup and address available when GitHub import fails', async () => {
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
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('未找到公开仓库')
    expect(host.querySelector<HTMLInputElement>('[aria-label="GitHub 地址"]')!.value).toBe('https://github.com/example/missing')
  } finally { await act(async () => { root.unmount(); await settle() }); host.remove() }
})
