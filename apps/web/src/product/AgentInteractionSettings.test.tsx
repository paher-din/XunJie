// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { AgentInteractionSettings, type AgentInteractionController } from './AgentInteraction'

it('shows the selected mode immediately and restores the saved mode if saving fails', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  let finish!: () => void
  const save = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  const controller = {
    settings: { busyInputMode: 'steering' }, writable: true, busy: false, error: '', save, reload: vi.fn(),
  } as unknown as AgentInteractionController
  try {
    await act(async () => root.render(<AgentInteractionSettings controller={controller} />))
    const cards = host.querySelectorAll<HTMLButtonElement>('[role="radio"]')
    await act(async () => cards[1].click())
    expect(save).toHaveBeenCalledWith('queue')
    expect(cards[1].getAttribute('aria-checked')).toBe('true')
    expect(host.textContent).not.toContain('正在保存交互设置')
    await act(async () => {
      root.render(<AgentInteractionSettings controller={{ ...controller, error: '交互设置尚未保存' }} />)
      finish()
    })
    expect(cards[0].getAttribute('aria-checked')).toBe('true')
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('交互设置尚未保存')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
