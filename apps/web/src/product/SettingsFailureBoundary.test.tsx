// @vitest-environment jsdom
import { Component } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { SettingsFailureBoundary } from './SettingsFailureBoundary'

class BrokenSettings extends Component {
  render(): never {
    throw new Error('synthetic settings failure')
  }
}

it('replaces a failed settings subtree with a recoverable error state', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onBack = vi.fn()
  try {
    await act(async () => root.render(<SettingsFailureBoundary onBack={onBack}><BrokenSettings /></SettingsFailureBoundary>))
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('设置内容暂时无法打开')
    expect([...host.querySelectorAll('button')].map(item => item.textContent)).toEqual(['重新加载页面', '返回学习空间'])
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('button')]
      .find(item => item.textContent === '返回学习空间')!.click())
    expect(onBack).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    host.remove()
    consoleError.mockRestore()
    vi.unstubAllGlobals()
  }
})
