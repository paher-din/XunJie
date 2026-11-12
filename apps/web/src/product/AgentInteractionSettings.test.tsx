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
    expect(host.textContent).toContain('正在保存发送方式')
    await act(async () => {
      root.render(<AgentInteractionSettings controller={{ ...controller, error: '交互设置尚未保存' }} />)
      finish()
    })
    expect(cards[0].getAttribute('aria-checked')).toBe('true')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('交互设置尚未保存')
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})

it('covers loading, read-only and unreadable interaction settings', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const reload = vi.fn()
  try {
    await act(async () => root.render(<AgentInteractionSettings controller={{
      settings: null, loading: true, writable: true, busy: false, error: '', save: vi.fn(), reload,
    } as unknown as AgentInteractionController} />))
    expect(host.textContent).toContain('正在读取发送方式')
    expect(host.querySelectorAll('[role="radio"]')).toHaveLength(0)

    await act(async () => root.render(<AgentInteractionSettings controller={{
      settings: { busyInputMode: 'steering' }, loading: false, writable: false, busy: false, error: '', save: vi.fn(), reload,
    } as unknown as AgentInteractionController} />))
    expect(host.textContent).toContain('当前学习空间为只读')
    expect([...host.querySelectorAll<HTMLButtonElement>('[role="radio"]')].every(item => item.disabled)).toBe(true)

    await act(async () => root.render(<AgentInteractionSettings controller={{
      settings: { busyInputMode: 'queue' }, loading: true, writable: true, busy: false, error: '', save: vi.fn(), reload,
    } as unknown as AgentInteractionController} />))
    expect(host.textContent).toContain('正在重新读取发送方式')
    expect(host.querySelector('[aria-checked="true"]')?.textContent).toContain('排队处理')

    await act(async () => root.render(<AgentInteractionSettings controller={{
      settings: null, loading: false, writable: true, busy: false, error: '交互设置暂时无法读取', save: vi.fn(), reload,
    } as unknown as AgentInteractionController} />))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('发送方式暂时无法读取')
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === '重新读取')!.click())
    expect(reload).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.unstubAllGlobals()
  }
})
