import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { AluBoard } from './AluBoard'
import { parseAluBoardMapping } from './mapping'

const mapping = { version: 1 as const,
  inputs: { A: [3, 2, 1, 0], B: [7, 6, 5, 4], M: [8], S: [10, 9], Cin: [11] },
  outputs: { F: [3, 2, 1, 0], Cout: [4] } }
const values = { A: 8, B: 0, M: 0, S: 0, Cin: 0 }
const render = (patch: Partial<Parameters<typeof AluBoard>[0]> = {}) => renderToStaticMarkup(
  <AluBoard values={values} reading={{ state: 'binary', f: '1000', cout: '1' }}
    disabled={false} waiting={false} onChange={vi.fn()} {...{ mapping }} {...patch} />)

describe('the ALU board displays the selected observation and published wiring', () => {
  it('keeps MSB-first output strings aligned with the actual F bit numbers', () => {
    const html = render()
    expect(html).toMatch(/data-signal="1"[^>]*aria-label="F3[^\"]*: 1"/)
    expect(html).toMatch(/data-signal="0"[^>]*aria-label="F0[^\"]*: 0"/)
    const mixed = render({ reading: { state: 'unknown', f: 'x01z', cout: 'z' } })
    expect(mixed).toMatch(/data-signal="x"[^>]*aria-label="F3[^\"]*: X（未知）"/)
    expect(mixed).toMatch(/data-signal="z"[^>]*aria-label="F0[^\"]*: Z（高阻）"/)
  })

  it('hides the old seven-segment digit, hexadecimal value and lights while waiting', () => {
    const html = render({ waiting: true })
    expect(html).toContain('等待观察')
    expect(html).toContain('F 暂无数值显示')
    expect(html).not.toContain('<svg')
    expect(html).not.toContain('0x8')
    expect(html).not.toContain('data-signal="1"')
  })

  it('lights the middle segment for hexadecimal eight so it cannot be mistaken for zero', () => {
    expect(render().match(/stroke:#dfe9fb/g)).toHaveLength(7)
    expect(render({ reading: { state: 'binary', f: '0000', cout: '0' } }).match(/stroke:#dfe9fb/g)).toHaveLength(6)
  })

  it('uses the course mapping for every input and output label', () => {
    const custom = { version: 1 as const,
      inputs: { A: [15, 14, 13, 12], B: [11, 10, 9, 8], M: [7], S: [6, 5], Cin: [4] },
      outputs: { F: [12, 9, 7, 2], Cout: [15] } }
    const html = render({ ...{ mapping: custom } })
    expect(html).toContain('A 位 3，SW15，当前 1')
    expect(html).toContain('Cin 位 0，SW4，当前 0')
    expect(html).toContain('F3 · LED12: 1')
    expect(html).toContain('F2 · LED9: 0')
    expect(html).toContain('Cout · LED15: 1')
    expect(html).not.toContain('SW15…SW12、按钮')
  })

  it('rejects missing, duplicated, out-of-range and incompatible published wiring', () => {
    expect(parseAluBoardMapping(mapping)).toEqual(mapping)
    expect(parseAluBoardMapping(undefined)).toBeNull()
    expect(parseAluBoardMapping({ ...mapping, version: 2 })).toBeNull()
    expect(parseAluBoardMapping({ ...mapping, inputs: { ...mapping.inputs, A: [3, 2, 1] } })).toBeNull()
    expect(parseAluBoardMapping({ ...mapping, inputs: { ...mapping.inputs, Cin: [8] } })).toBeNull()
    expect(parseAluBoardMapping({ ...mapping, outputs: { ...mapping.outputs, Cout: [3] } })).toBeNull()
    expect(parseAluBoardMapping({ ...mapping, outputs: { ...mapping.outputs, Cout: [16] } })).toBeNull()
  })
})
