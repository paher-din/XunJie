import { Seg7 } from '../../components/workspace/CenterToolArea'
import type { AluControl } from './state'
import type { AluBoardMapping } from './mapping'

export type AluReading =
  | { state: 'none' | 'waiting' | 'incomplete'; f?: string; cout?: string }
  | { state: 'binary' | 'unknown'; f: string; cout: string }

const widthOf: Record<AluControl, number> = { A: 4, B: 4, M: 1, S: 2, Cin: 1 }
const groups: Array<{ title: string; signal: string; control: AluControl }> = [
  { title: 'A', signal: 'A[3:0]', control: 'A' },
  { title: 'B', signal: 'B[3:0]', control: 'B' },
  { title: 'M', signal: 'M', control: 'M' },
  { title: 'S', signal: 'S[1:0]', control: 'S' },
  { title: 'Cin', signal: 'Cin', control: 'Cin' },
]

function bitOf(value: number, width: number, index: number) {
  return (value >> (width - 1 - index)) & 1
}

function flipBit(value: number, width: number, index: number) {
  return value ^ (1 << (width - 1 - index))
}

function bitLabel(bit: string | undefined) {
  if (bit === 'x') return 'X（未知）'
  if (bit === 'z') return 'Z（高阻）'
  return bit ?? '未取得'
}

function hexOf(f: string) {
  return /^[01]{4}$/.test(f) ? Number.parseInt(f, 2) : null
}

export function AluBoard({ values, reading, mapping, disabled, waiting, onChange }: {
  values: Record<AluControl, number>
  reading: AluReading
  mapping: AluBoardMapping
  disabled: boolean
  waiting: boolean
  onChange: (control: AluControl, value: number) => void
}) {
  const binary = reading.state === 'binary'
  const known = binary || reading.state === 'unknown'
  const f = known ? reading.f ?? '' : ''
  const cout = known ? reading.cout ?? '' : ''
  const show = known && !waiting
  const hex = binary && show && f ? hexOf(f) : null
  const fBits = (index: number) => show ? f[3 - index] : undefined
  const coutBit = show ? cout[0] : undefined
  const usedSwitches = new Set(Object.values(mapping.inputs).flat())
  const unusedSwitches = Array.from({ length: 16 }, (_, index) => 15 - index).filter(index => !usedSwitches.has(index))
  return <section className="alu-board-wrap" aria-label="ALU 虚拟板">
    <div className="ws-board alu-board">
      <div className="alu-board-title">4 位 ALU · 组合逻辑</div>
      <div className="alu-output-row">
        <div className="alu-seg">
          {hex === null ? <div className="alu-seg-blank" aria-label="F 暂无数值显示">—</div> : <Seg7 n={hex} />}
          <span className="alu-seg-label">F</span>
        </div>
        <div className="alu-output-copy">
          <p><b>F</b> <span className="alu-mono">{show ? (f || '未取得') : '—'}</span>{hex !== null ? <span className="alu-muted">（0x{hex.toString(16).toUpperCase()} · {Number.parseInt(f, 2)}）</span> : null}</p>
          <p><b>Cout</b> <span className="alu-mono">{show ? (cout || '未取得') : '—'}</span></p>
          <p className="alu-board-status" role="status">
            {waiting ? '等待观察；旧读数不冒充新输入。'
              : reading.state === 'unknown' ? '输出含 X/Z，不能当作零。'
              : reading.state === 'incomplete' ? '观察不完整，未显示为成功。'
              : reading.state === 'none' ? '尚未取得当前输入的观察。'
              : '已取得观察；请结合输入自行核对。'}
          </p>
        </div>
      </div>
      <div className="ws-ledrow alu-led-row" aria-label="F 与 Cout 输出灯">
        {[3, 2, 1, 0].map((index, position) => {
          const bit = fBits(index)
          const state = bit === '1' ? 'on' : bit === '0' ? 'off' : bit === 'x' ? 'x' : bit === 'z' ? 'z' : 'unavailable'
          return <span key={index} className="alu-led-cell">
            <span className={`ws-led alu-led-${state}`} data-signal={bit ?? 'unavailable'} role="img"
              aria-label={`F${index} · LED${mapping.outputs.F[position]}: ${bitLabel(bit)}`} />
            <span>F{index} · LED{mapping.outputs.F[position]}</span>
            <span className="alu-bit">{bit ?? '?'}</span>
          </span>
        })}
        <span className="alu-led-gap" aria-hidden="true" />
        <span className="alu-led-cell">
          <span className={`ws-led alu-led-${coutBit === '1' ? 'on' : coutBit === '0' ? 'off' : coutBit === 'x' ? 'x' : coutBit === 'z' ? 'z' : 'unavailable'}`}
            data-signal={coutBit ?? 'unavailable'} role="img" aria-label={`Cout · LED${mapping.outputs.Cout[0]}: ${bitLabel(coutBit)}`} />
          <span>Cout · LED{mapping.outputs.Cout[0]}</span>
          <span className="alu-bit">{coutBit ?? '?'}</span>
        </span>
      </div>
      <div className="alu-switch-groups">
        {groups.map(group => {
          const width = widthOf[group.control]
          return <div className="alu-switch-group" key={group.control} role="group" aria-label={group.title}>
            <div className="alu-switch-head"><b>{group.title}</b><span>{group.signal} · {mapping.inputs[group.control].map(sw => `SW${sw}`).join(' / ')}</span></div>
            <div className="alu-switch-row">
              {mapping.inputs[group.control].map((sw, position) => {
                const bit = bitOf(values[group.control], width, position)
                return <span className="ws-switch alu-switch" key={sw}>
                  <button type="button" className={bit ? 'ws-sw on' : 'ws-sw'} disabled={disabled}
                    aria-label={`${group.title} 位 ${width - 1 - position}，SW${sw}，当前 ${bit}`}
                    aria-pressed={bit === 1} onClick={() => onChange(group.control, flipBit(values[group.control], width, position))} />
                  <span>SW{sw}</span>
                  <span className="alu-bit">{bit}</span>
                </span>
              })}
            </div>
            <span className="alu-group-value">{group.title}={values[group.control]}</span>
          </div>
        })}
      </div>
      <p className="alu-unused">{unusedSwitches.length ? `${unusedSwitches.map(sw => `SW${sw}`).join('、')}、` : ''}按钮、复位与时钟本活动未绑定，不参与实验。</p>
    </div>
  </section>
}
