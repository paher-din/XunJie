// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { Markdown } from './Markdown'
import { useSmoothStreamText } from './useSmoothStreamText'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: ReturnType<typeof createRoot> | undefined
afterEach(() => { if (root) act(() => root!.unmount()); root = undefined; document.body.replaceChildren(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers() })
const text = '| 名称 | 数值 |\n| --- | ---: |\n| 示例 | 42 |'
function mount(value = text) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root!.render(<Markdown text={value} variant="astryx" />))
  return host
}
it('copies the fixed table Markdown only after clipboard acknowledgement and reports rejection', async () => {
  const writeText = vi.fn().mockRejectedValueOnce(new Error('denied')).mockResolvedValueOnce(undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  const host = mount()
  const button = host.querySelector('button')!
  await act(async () => button.click())
  expect(host.textContent).toContain('复制失败')
  expect(button.getAttribute('aria-label')).toBe('复制表格为 Markdown')
  await act(async () => button.click())
  expect(button.getAttribute('aria-label')).toBe('已复制表格')
  expect(writeText).toHaveBeenLastCalledWith(text)
})
it('uses Astryx prose and Python highlighting while preserving code bytes and safe text', () => {
  const host = mount('**说明**\n\n~~~python\ndef calculate(value):\n    return value + 1\n~~~\n\n![图片](https://example.com/x.png)')
  expect(host.querySelector('strong')?.textContent).toBe('说明')
  expect(host.querySelector('.ast-token-keyword')).not.toBeNull()
  expect(host.querySelector('pre code')?.textContent).toBe('def calculate(value):\n    return value + 1')
  expect(host.querySelector('img')).toBeNull()
})
it('allows copying a closed tilde fence during later streaming content', () => {
  const host = mount()
  act(() => root!.render(<Markdown text={'~~~python\nprint(1)\n~~~'} variant="astryx" live />))
  expect(host.querySelector('button')?.disabled).toBe(false)
})
it('keeps streamed emoji intact and immediately exposes the complete answer on stop', () => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16))
  vi.stubGlobal('cancelAnimationFrame', window.clearTimeout)
  function Stream({ text, live }: { text: string; live: boolean }) {
    return <output>{useSmoothStreamText(text, live)}</output>
  }
  const host = document.createElement('div')
  document.body.append(host); root = createRoot(host)
  const answer = '开始😀👩‍💻解释边界条件。'.repeat(8)
  act(() => root!.render(<Stream text={answer} live />))
  for (let index = 0; index < 12; index++) {
    act(() => vi.advanceTimersByTime(20))
    const shown = host.textContent ?? ''
    expect(answer.startsWith(shown)).toBe(true)
    expect(/[\uD800-\uDBFF]$/.test(shown)).toBe(false)
  }
  act(() => root!.render(<Stream text={answer} live={false} />))
  expect(host.textContent).toBe(answer)
})

it('drains normal completion at a bounded cadence, segments only received batches, and stops scheduling when caught up', () => {
  vi.useFakeTimers()
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => window.setTimeout(() => callback(performance.now()), 16))
  vi.stubGlobal('cancelAnimationFrame', window.clearTimeout)
  const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment')
  let renders = 0
  function Stream({ live }: { live: boolean }) {
    renders++
    return <output>{useSmoothStreamText(answer, live, { drainOnComplete: true, animateOnMount: true })}</output>
  }
  const answer = '第一行内容。\n第二行内容😀。\n'.repeat(40)
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<Stream live />))
  act(() => vi.advanceTimersByTime(500))
  const first = host.textContent!
  expect(first.length).toBeGreaterThan(0)
  expect(first.length).toBeLessThan(answer.length)
  expect(renders).toBeLessThanOrEqual(17)
  expect(segment).toHaveBeenCalledTimes(1)
  act(() => root!.render(<Stream live={false} />))
  expect(host.textContent).toBe(first)
  act(() => vi.advanceTimersByTime(10000))
  expect(host.textContent).toBe(answer)
  expect(vi.getTimerCount()).toBe(0)
})

it('renders restored history immediately without replaying its text', () => {
  const segment = vi.spyOn(Intl.Segmenter.prototype, 'segment')
  function History() { return <output>{useSmoothStreamText('已保存的完整回答😀', false, { drainOnComplete: true, animateOnMount: false })}</output> }
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  act(() => root!.render(<History />))
  expect(host.textContent).toBe('已保存的完整回答😀')
  expect(segment).not.toHaveBeenCalled()
})
