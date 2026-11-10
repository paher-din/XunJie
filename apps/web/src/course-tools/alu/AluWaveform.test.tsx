// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AluWaveform, type AluWaveformProps } from './AluWaveform'

const vcd = `$timescale 10 ps $end
$scope module tb $end
$var wire 4 ! F [3:0] $end
$var reg 1 # late $end
$upscope $end
$enddefinitions $end
#9007199254740993
bx01 !
#9007199254740994
bz10 !
1#
#9007199254740995
b1 !
#9007199254740996
`
const range = { signalIds: ['tb.F[3:0]', 'tb.late'], fromTick: '9007199254740992', toTick: '9007199254740996' }
const defaults: AluWaveformProps = { vcdText: vcd, selection: range, sourceLabel: '作品 42 · 输入 A=3', onChange: () => {} }
let root: Root | null = null
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
const mount = async (patch: Partial<AluWaveformProps> = {}) => {
  await act(async () => root!.render(<AluWaveform {...defaults} {...patch} />))
}
const input = async (label: string, value: string) => {
  const field = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('a waveform only presents retained VCD facts', () => {
  it('reveals no source, waveform or output while suppressed, including errors and loading', () => {
    const html = renderToStaticMarkup(<AluWaveform {...defaults} suppressed incomplete loading error="secret output XX01" />)
    expect(html).toContain('运行后查看波形')
    for (const hidden of ['XX01', '作品 42', 'tb.F', 'secret', '<svg', '<input', '<button']) expect(html).not.toContain(hidden)
  })

  it('shows exact large ticks, four-state values, unacquired starts and known incomplete output', async () => {
    const onChange = vi.fn()
    await mount({ incomplete: true, onChange })
    expect(container.textContent).toContain('作品 42 · 输入 A=3')
    expect(container.textContent).toContain('10 ps / tick')
    expect(container.textContent).toContain('输出不完整')
    expect(container.textContent).toContain('9007199254740992')
    expect(container.textContent).toContain('9007199254740996')
    expect(container.textContent).toContain('未取得')
    expect(container.textContent).toContain('XX01')
    expect(container.textContent).toContain('ZZ10')
    expect(container.textContent).toContain('0001')
    expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(2)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('changes original tick/signal selection only through callbacks and keeps display zoom local', async () => {
    const onChange = vi.fn(), onReference = vi.fn()
    await mount({ onChange, onReference })
    const zoom = container.querySelector<HTMLButtonElement>('[role="combobox"][aria-label="显示缩放"]')!
    await act(async () => zoom.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })))
    const list = document.getElementById(zoom.getAttribute('aria-controls')!)
    expect(list).not.toBeNull()
    const option = Array.from(list!.querySelectorAll<HTMLElement>('[role="option"]')).find(node => node.textContent === '2×')!
    await act(async () => { option.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 })); option.click() })
    expect(container.querySelector('svg[role="img"]')?.getAttribute('width')).toBe('1600')
    expect(onChange).not.toHaveBeenCalled()
    await input('起始 tick', '9007199254740993')
    await input('结束 tick', '9007199254740994')
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    const updated = { ...range, fromTick: '9007199254740993', toTick: '9007199254740994' }
    expect(onChange).toHaveBeenLastCalledWith(updated)
    expect(container.querySelector('svg[role="img"]')?.getAttribute('aria-label')).toContain('9007199254740992 至 9007199254740996')
    await mount({ selection: updated, onChange, onReference })
    const reference = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '引用波形')!
    await act(async () => reference.click())
    expect(onReference).toHaveBeenLastCalledWith(updated, reference)
    const late = container.querySelector<HTMLInputElement>('input[aria-label="选择 tb.late"]')!
    await act(async () => late.click())
    expect(onChange).toHaveBeenLastCalledWith({ ...updated, signalIds: ['tb.F[3:0]'] })
    expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(2)
  })

  it('separates missing data, undeclared units, malformed VCD and incomplete retained output', async () => {
    await mount({ vcdText: null, incomplete: true })
    expect(container.textContent).toContain('输出不完整')
    expect(container.textContent).toContain('暂无波形')
    await mount({ vcdText: vcd.replace('$timescale 10 ps $end\n', '') })
    expect(container.textContent).toContain('时间单位未声明')
    expect(container.textContent).not.toContain('10 ps')
    await mount({ vcdText: vcd + 'damaged' })
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('VCD 无法解析')
    expect(container.querySelector('svg[role="img"]')).toBeNull()
    expect(container.textContent).not.toContain('XX01')
    await mount({ loading: true })
    expect(container.textContent).toBe('正在读取波形…')
    await mount({ error: '读取失败' })
    expect(container.textContent).toBe('读取失败')
  })

  it('rejects invalid tick edits and replaces transient edits when the source changes', async () => {
    const onChange = vi.fn()
    await mount({ onChange })
    await input('起始 tick', '-1')
    await act(async () => container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('非负十进制整数')
    expect(onChange).not.toHaveBeenCalled()
    expect(container.querySelectorAll('svg[role="img"]')).toHaveLength(2)
    const nextRange = { signalIds: ['tb.G[3:0]'], fromTick: '9007199254740993', toTick: '9007199254740994' }
    await mount({ onChange, selection: nextRange, vcdText: vcd.replace(' F ', ' G ').replace('bx01 !', 'b10 !') })
    expect(container.querySelector<HTMLInputElement>('input[aria-label="起始 tick"]')?.value).toBe('9007199254740993')
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.textContent).toContain('tb.G[3:0]')
    expect(container.textContent).not.toContain('XX01')
    expect(onChange).not.toHaveBeenCalled()
  })

  it('keeps a point selection exact and exposes a known Icarus recording limit', async () => {
    const selection = { ...range, fromTick: '9007199254740994', toTick: '9007199254740994' }
    await mount({ selection, vcdText: vcd + '$comment Dump file limit (1024 bytes) exceeded. $end\n' })
    expect(container.querySelector('svg[role="img"]')).toBeNull()
    expect(container.textContent).toContain('9007199254740994 tick：ZZ10')
    expect(container.textContent).toContain('9007199254740994 tick：1')
    expect(container.textContent).toContain('波形记录不完整')
  })

  it('refuses excessive display data explicitly instead of silently drawing a sampled waveform', async () => {
    const text = `$scope module tb $end\n$var wire 1 ! clock $end\n$upscope $end\n$enddefinitions $end\n`
      + Array.from({ length: 5000 }, (_, index) => `#${index}\n${index % 2}!\n`).join('')
    const onReference = vi.fn()
    await mount({ vcdText: text, selection: { signalIds: ['tb.clock'], fromTick: '0', toTick: '4999' }, onReference })
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/变化过多.*缩小/)
    expect(container.querySelector('svg[role="img"]')).toBeNull()
    const reference = Array.from(container.querySelectorAll('button')).find(button => button.textContent === '引用波形')!
    expect(reference.disabled).toBe(true)
    await act(async () => reference.click())
    expect(onReference).not.toHaveBeenCalled()
  })
})
