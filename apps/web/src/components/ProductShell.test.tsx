// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ProductShell } from './ProductShell'

vi.mock('../lib/theme', () => ({
  THEME_OPTIONS: [{ value: 'system', label: '跟随系统' }],
  useTheme: () => ({ preference: 'system', resolved: 'light', setPreference: vi.fn() }),
  setThemePreference: vi.fn(),
}))

afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals() })

it('supports account menu keyboard navigation in both sidebar states', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const profile = vi.fn()
  const settings = vi.fn()
  await act(async () => root.render(<ProductShell immersive={false} identityName="小林" active="home"
    onHome={vi.fn()} onAgent={vi.fn()} onSettings={settings} onProfile={profile}><p>内容</p></ProductShell>))

  const sidebarTrigger = host.querySelector<HTMLButtonElement>('.account-pill')!
  await act(async () => sidebarTrigger.click())
  const menu = host.querySelector<HTMLElement>('.am-pill')!
  const items = menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
  expect(document.activeElement).toBe(items[0])
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
  expect(document.activeElement).toBe(items[1])
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(document.activeElement).toBe(sidebarTrigger)
  expect(menu.hasAttribute('inert')).toBe(true)

  await act(async () => host.querySelector<HTMLButtonElement>('.sidebar-toggle')!.click())
  const railTrigger = host.querySelector<HTMLButtonElement>('.r-account')!
  await act(async () => railTrigger.click())
  const railMenu = host.querySelector<HTMLElement>('.am-rail')!
  await act(async () => railMenu.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click())
  expect(profile).toHaveBeenCalledOnce()
  expect(settings).not.toHaveBeenCalled()
  expect(railMenu.hasAttribute('inert')).toBe(true)
  await act(async () => root.unmount())
})

it('opens and closes collapsed conversation history with keyboard focus', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onAgent = vi.fn()
  const onArchiveOpenChange = vi.fn()
  const render = (active: 'home' | 'agent') => <ProductShell immersive={false} identityName="小林" active={active}
    onHome={vi.fn()} onAgent={onAgent} onSettings={vi.fn()} onProfile={vi.fn()} archiveOpen={false}
    onArchiveOpenChange={onArchiveOpenChange} agentHistory={() => <input aria-label="搜索对话" />}><p>内容</p></ProductShell>
  await act(async () => root.render(render('agent')))
  await act(async () => host.querySelector<HTMLButtonElement>('.sidebar-toggle')!.click())

  const search = host.querySelector<HTMLButtonElement>('.r-search')!
  const archive = host.querySelector<HTMLButtonElement>('.r-archive')!
  const create = host.querySelector<HTMLButtonElement>('.r-new')!
  expect([search, archive, create].every(button => button.getAttribute('aria-hidden') !== 'true')).toBe(true)
  await act(async () => search.click())
  const panel = host.querySelector<HTMLElement>('.railpanel')!
  expect(panel.classList.contains('on')).toBe(true)
  expect(document.activeElement).toBe(panel.querySelector('input'))
  await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  expect(panel.hasAttribute('inert')).toBe(true)
  expect(document.activeElement).toBe(search)
  await act(async () => archive.click())
  expect(onArchiveOpenChange).toHaveBeenCalledWith(true)
  await act(async () => create.click())
  expect(onAgent).toHaveBeenCalledOnce()
  expect(panel.hasAttribute('inert')).toBe(true)
  await act(async () => root.render(render('home')))
  expect([search, archive, create].every(button => button.getAttribute('aria-hidden') === 'true' && button.tabIndex === -1)).toBe(true)
  await act(async () => root.unmount())
})
