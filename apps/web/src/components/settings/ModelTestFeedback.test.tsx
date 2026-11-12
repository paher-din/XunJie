// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ModelTestFeedback, type ModelTestFeedbackProps } from '../../../../../packages/ui/src/settings/ModelTestFeedback'

let root: Root
const button = (text: string) => [...document.querySelectorAll('button')].find(item => item.textContent === text)!
async function draw(props: Partial<ModelTestFeedbackProps> = {}) {
  await act(async () => root.render(<ModelTestFeedback status="failed" title="测试失败" {...props} />))
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root.unmount())
  document.body.innerHTML = ''
  vi.unstubAllGlobals()
})

it.each(['running', 'passed', 'cancelled'] as const)('keeps %s feedback as a plain status row', async status => {
  const onStop = vi.fn(), onRetry = vi.fn()
  await draw({ status, title: '连接测试', message: '当前结果', onStop, onRetry })
  expect(document.querySelector('.astryx-banner')).toBeNull()
  expect(document.querySelector('[role="status"]')?.textContent).toContain('连接测试当前结果')
  expect(button('重试')).toBeUndefined()
  expect(document.querySelector('details, pre, summary')).toBeNull()
  if (status === 'running') {
    await act(async () => button('停止').click())
    expect(onStop).toHaveBeenCalledOnce()
  } else {
    expect(button('停止')).toBeUndefined()
    if (status === 'cancelled') {
      await act(async () => button('重新测试').click())
      expect(onRetry).toHaveBeenCalledOnce()
    } else expect(button('重新测试')).toBeUndefined()
  }
})

it.each(['failed', 'unverified'] as const)('shows %s reason and recovery without diagnostics', async status => {
  const onRetry = vi.fn()
  await draw({ status, message: '服务拒绝了请求', suggestion: '检查 API Key 后重试。', onRetry })
  expect(document.querySelector('.astryx-banner')).not.toBeNull()
  const description = document.querySelector('.astryx-banner-description')!
  expect(description.textContent).toBe('服务拒绝了请求检查 API Key 后重试。')
  expect(document.querySelector('details, pre, summary')).toBeNull()
  expect(document.body.textContent).not.toContain('诊断详情')
  await act(async () => button('重试').click())
  expect(onRetry).toHaveBeenCalledOnce()
})

it('omits empty optional fields', async () => {
  await draw({ message: ' ', suggestion: '' })
  expect(document.querySelector('.astryx-banner-description, .astryx-banner-content, details, pre, p')).toBeNull()
  expect(document.body.textContent).toBe('测试失败')
})

it('never renders diagnostic details or copy controls', async () => {
  await draw({ message: '请求失败。', suggestion: '请重试。' })
  expect(document.querySelector('details, pre, summary')).toBeNull()
  expect(button('复制诊断')).toBeUndefined()
  expect(document.body.textContent).not.toContain('诊断详情')
})
