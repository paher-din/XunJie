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
  await draw({ status, title: '连接测试', message: '当前结果', details: 'HTTP 200', children: <p>示例分项</p>, onStop, onRetry })
  expect(document.querySelector('.astryx-banner')).toBeNull()
  expect(document.querySelector('[role="status"]')?.textContent).toContain('连接测试当前结果')
  expect(button('重试')).toBeUndefined()
  if (status === 'passed') {
    expect(document.querySelector('details')).toBeNull()
    expect(document.body.textContent).not.toContain('示例分项')
  }
  if (status === 'running') {
    await act(async () => button('停止').click())
    expect(onStop).toHaveBeenCalledOnce()
  } else expect(button('停止')).toBeUndefined()
})

it.each(['failed', 'unverified'] as const)('shows %s reason and recovery before expanding diagnostics', async status => {
  const onRetry = vi.fn()
  await draw({ status, message: '服务拒绝了请求', suggestion: '检查 API Key 后重试。', details: 'HTTP 401\ntrace', onRetry,
    children: <button type="button">修改配置</button> })
  expect(document.querySelector('.astryx-banner')).not.toBeNull()
  const description = document.querySelector('.astryx-banner-description')!
  expect(description.textContent).toBe('服务拒绝了请求检查 API Key 后重试。')
  expect(description.closest('details')).toBeNull()
  expect(button('修改配置').closest('details')).toBeNull()
  expect(document.querySelector('details')?.open).toBe(false)
  expect(document.querySelector('pre')?.textContent).toBe('HTTP 401\ntrace')
  await act(async () => button('重试').click())
  expect(onRetry).toHaveBeenCalledOnce()
})

it('omits empty optional fields and diagnostics', async () => {
  await draw({ message: ' ', suggestion: '', details: '\n', children: false })
  expect(document.querySelector('.astryx-banner-description, .astryx-banner-content, details, p')).toBeNull()
  expect(document.body.textContent).toBe('测试失败')
})

it('copies the exact diagnostic and acknowledges success only after the copy action', async () => {
  const writeText = vi.fn(async (_text: string) => {})
  vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText } } }))
  const details = '  HTTP 502\n' + 'long diagnostic '.repeat(200)
  await draw({ details })
  await draw({ details })
  expect(writeText).not.toHaveBeenCalled()
  expect(document.body.textContent).not.toContain('诊断已复制')
  await act(async () => document.querySelector('summary')!.click())
  expect(document.querySelector('details')?.open).toBe(true)
  await act(async () => button('复制诊断').click())
  expect(writeText).toHaveBeenCalledExactlyOnceWith(details)
  expect(document.querySelector('[role="status"]')?.textContent).toBe('诊断已复制')
  expect(button('已复制')).toBeDefined()
  await draw({ details: 'new result' })
  expect(button('复制诊断')).toBeDefined()
  expect(document.querySelector('details')?.open).toBe(false)
})

it('keeps diagnostics selectable when clipboard access fails', async () => {
  vi.stubGlobal('navigator', Object.create(navigator, { clipboard: { value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } } }))
  await draw({ details: 'HTTP 403' })
  await act(async () => button('复制诊断').click())
  expect(document.querySelector('[role="status"]')?.textContent).toContain('复制失败')
  expect(document.querySelector('pre')?.textContent).toBe('HTTP 403')
})
