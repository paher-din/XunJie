import { useMemo, useState } from 'react'
import { describeAluVcdRange, normalizeAluWaveRange, parseAluVcd, type AluVcd, type AluVcdChange, type AluVcdSignal,
  type AluWaveRange } from '@xunjie/contracts/alu-waveform'
import './waveform.css'

export type AluWaveformProps = {
  vcdText: string | null
  selection: AluWaveRange | null
  onChange: (selection: AluWaveRange | null) => void
  onReference?: (range: AluWaveRange, anchor: HTMLElement) => void
  sourceLabel: string
  incomplete?: boolean
  suppressed?: boolean
  loading?: boolean
  error?: string
}

/** Rendering only. The caller owns execution, resources, saved selection and references. */
export function AluWaveform(props: AluWaveformProps) {
  if (props.suppressed) return <p className="alu-waveform__message" role="status">运行后查看波形</p>
  if (props.loading) return <p className="alu-waveform__message" role="status">正在读取波形…</p>
  if (props.error) return <p className="alu-waveform__message" role="alert">{props.error}</p>
  if (props.vcdText === null) return <p className="alu-waveform__message" role="status">{props.incomplete ? '输出不完整 · 暂无波形' : '暂无波形'}</p>
  return <ParsedWaveform {...props} vcdText={props.vcdText} />
}

type RangeSignal = Pick<AluVcdSignal, 'id' | 'width' | 'code'> & { atFrom: AluVcdChange | null; changes: AluVcdChange[] }
type RangeCopy = { range: AluWaveRange; signals: RangeSignal[] }

function selectedView(parsed: AluVcd, selection: AluWaveRange | null): { copy: RangeCopy | null; error: string } {
  if (!selection || parsed.status !== 'valid') return { copy: null, error: '' }
  try {
    const normalized = normalizeAluWaveRange(parsed, selection)
    if (normalized.signalIds.length > 64) throw new Error('一次最多展示 64 条信号，请减少所选信号。')
    const copy = JSON.parse(describeAluVcdRange(parsed, normalized)) as RangeCopy
    if (copy.signals.reduce((count, signal) => count + signal.changes.length, 0) > 4096)
      throw new Error('所选范围变化过多，请缩小时间范围或减少信号。')
    return { copy, error: '' }
  } catch (error) { return { copy: null, error: error instanceof Error ? error.message : '无法读取所选波形范围。' } }
}

function ParsedWaveform(props: AluWaveformProps & { vcdText: string }) {
  const parsed = useMemo(() => parseAluVcd(props.vcdText), [props.vcdText])
  const view = useMemo(() => selectedView(parsed, props.selection), [parsed, props.selection])
  const [zoom, setZoom] = useState(1)
  const [draft, setDraft] = useState<{ source: AluVcd; key: string; fromTick: string; toTick: string; issue: string } | null>(null)
  const key = JSON.stringify(props.selection)
  const current = draft?.source === parsed && draft.key === key ? draft : { source: parsed, key,
    fromTick: props.selection?.fromTick ?? '0', toTick: props.selection?.toTick ?? parsed.lastTick, issue: '' }
  const edit = (field: 'fromTick' | 'toTick', value: string) => setDraft({ ...current, [field]: value, issue: '' })
  const choose = (range: AluWaveRange) => {
    try {
      const normalized = normalizeAluWaveRange(parsed, range)
      props.onChange(normalized)
      setDraft(null)
    } catch (error) { setDraft({ ...current, issue: error instanceof Error ? error.message : '无法选择波形范围。' }) }
  }
  if (parsed.status !== 'valid') return <p className="alu-waveform__message" role="alert">
    {parsed.status === 'incomplete' ? 'VCD 语法不完整' : 'VCD 无法解析'}：{parsed.issues[0]?.message}
  </p>
  return <section className="alu-waveform" aria-label="实验波形">
    <header className="alu-waveform__header">
      <span>{props.sourceLabel}</span>
      <span className="alu-waveform__unit">{parsed.timescale
        ? `${parsed.timescale.magnitude} ${parsed.timescale.unit} / tick` : '时间单位未声明 · 原始 tick'}</span>
      {props.incomplete && <span className="alu-waveform__incomplete" role="status">输出不完整</span>}
      {!props.incomplete && parsed.issues.some(issue => issue.code === 'recording-limited')
        && <span className="alu-waveform__incomplete" role="status">波形记录不完整</span>}
    </header>
    <details className="alu-waveform__signals" open={!props.selection}>
      <summary>信号（{new Set(props.selection?.signalIds ?? []).size}/{parsed.signals.length}）</summary>
      <fieldset aria-label="波形信号">
        {parsed.signals.map(signal => <label key={signal.id}>
          <input type="checkbox" aria-label={`选择 ${signal.id}`} checked={props.selection?.signalIds.includes(signal.id) ?? false}
            onChange={event => {
              const signalIds = event.currentTarget.checked ? [...props.selection?.signalIds ?? [], signal.id]
                : (props.selection?.signalIds ?? []).filter(id => id !== signal.id)
              if (!signalIds.length) { props.onChange(null); setDraft(null) }
              else choose({ signalIds, fromTick: props.selection?.fromTick ?? '0', toTick: props.selection?.toTick ?? parsed.lastTick })
            }} />
          <span>{signal.id}</span>
        </label>)}
      </fieldset>
    </details>
    <form className="alu-waveform__controls" aria-label="波形范围" onSubmit={event => {
      event.preventDefault()
      choose({ signalIds: props.selection?.signalIds ?? [], fromTick: current.fromTick, toTick: current.toTick })
    }}>
      <label>起始 tick<input type="text" inputMode="numeric" aria-label="起始 tick" value={current.fromTick}
        onChange={event => edit('fromTick', event.currentTarget.value)} /></label>
      <label>结束 tick<input type="text" inputMode="numeric" aria-label="结束 tick" value={current.toTick}
        onChange={event => edit('toTick', event.currentTarget.value)} /></label>
      <button type="submit" disabled={!props.selection?.signalIds.length}>查看范围</button>
      <label>缩放<select aria-label="显示缩放" value={zoom} onChange={event => setZoom(Number(event.currentTarget.value))}>
        {[1, 2, 4, 8].map(value => <option key={value} value={value}>{value}×</option>)}
      </select></label>
      {props.selection && <button type="button" onClick={() => { props.onChange(null); setDraft(null) }}>清除选择</button>}
      {props.onReference && <button type="button" disabled={!view.copy} onClick={event => {
        if (view.copy) props.onReference?.(normalizeAluWaveRange(parsed, view.copy.range), event.currentTarget)
      }}>引用波形</button>}
    </form>
    {current.issue && <p className="alu-waveform__message" role="alert">{current.issue}</p>}
    {view.error && <p className="alu-waveform__message" role="alert">{view.error}</p>}
    {view.copy && <WaveRows copy={view.copy} width={800 * zoom} />}
    {!props.selection && <p className="alu-waveform__message">{parsed.signals.length ? '选择信号查看波形' : 'VCD 中没有信号'}</p>}
  </section>
}

function WaveRows({ copy, width }: { copy: RangeCopy; width: number }) {
  return <>
    <div className="alu-waveform__bounds"><span>{copy.range.fromTick} tick</span><span>{copy.range.toTick} tick</span></div>
    <div className="alu-waveform__scroll" tabIndex={0} role="region" aria-label="波形，可横向滚动">
      <div style={{ width }}>
        {copy.signals.map(signal => <div className="alu-waveform__row" key={signal.id}>
          <div className="alu-waveform__name">{signal.id}</div>
          {copy.range.fromTick === copy.range.toTick
            ? <p className="alu-waveform__point">{copy.range.fromTick} tick：{signal.atFrom?.value ?? '未取得'}</p>
            : <SignalPlot signal={signal} range={copy.range} width={width} />}
        </div>)}
      </div>
    </div>
    <details className="alu-waveform__events">
      <summary>原始变化</summary>
      {copy.signals.map(signal => <div key={signal.id}>
        <p className="alu-waveform__name">{signal.id}</p>
        <table aria-label={`${signal.id} 原始变化`}>
          <thead><tr><th scope="col">原始 tick</th><th scope="col">四态值</th></tr></thead>
          <tbody>
            <tr><td>{copy.range.fromTick}（起点保持{signal.atFrom ? `，记录于 ${signal.atFrom.timeTick}` : ''}）</td>
              <td>{signal.atFrom?.value ?? '未取得'}</td></tr>
            {signal.changes.map((change, index) => <tr key={index}><td>{change.timeTick}</td><td>{change.value}</td></tr>)}
          </tbody>
        </table>
      </div>)}
    </details>
  </>
}

function SignalPlot({ signal, range, width }: { signal: RangeSignal; range: AluWaveRange; width: number }) {
  const start = BigInt(range.fromTick), span = BigInt(range.toTick) - start
  // Only the bounded pixel quotient is converted to Number, never an original time fact.
  const position = (tick: string) => Number(((BigInt(tick) - start) * BigInt(width * 1024)) / span) / 1024
  const segments: { left: string; right: string; value: string | null }[] = []
  let left = range.fromTick, value = signal.atFrom?.value ?? null
  for (const change of signal.changes) {
    if (change.timeTick === range.fromTick) continue // atFrom already holds the final value at this tick.
    segments.push({ left, right: change.timeTick, value })
    left = change.timeTick
    value = change.value
  }
  segments.push({ left, right: range.toTick, value })
  return <svg width={width} height={40} viewBox={`0 0 ${width} 40`} role="img"
    aria-label={`${signal.id}，${range.fromTick} 至 ${range.toTick} tick；精确事件见原始变化`}>
    {signal.width === 1 && <g className="alu-waveform__levels" aria-hidden="true"><text x={4} y={8}>1</text><text x={4} y={38}>0</text></g>}
    {segments.map((segment, index) => {
      const x = position(segment.left), right = position(segment.right)
      const kind = segment.value === null ? 'missing' : segment.value.includes('X') ? 'unknown'
        : segment.value.includes('Z') ? 'highz' : 'binary'
      const binaryBit = signal.width === 1 && (segment.value === '0' || segment.value === '1')
      const y = segment.value === '1' ? 10 : 30
      return <g key={index} className={`alu-waveform__trace alu-waveform__trace--${kind}`}>
        <title>{segment.left} 至 {segment.right} tick：{segment.value ?? '未取得'}</title>
        {binaryBit ? <path d={`M${x},${y}H${right}`} />
          : <rect x={x} y={8} width={right - x} height={24} />}
        {!binaryBit && right - x >= 56 && <text x={(x + right) / 2} y={25} textAnchor="middle">
          {segment.value === null ? '未取得' : segment.value.length <= 24 ? segment.value : `${signal.width} 位`}
        </text>}
      </g>
    })}
    {signal.changes.map((change, index) => <line key={index} className="alu-waveform__edge"
      x1={position(change.timeTick)} x2={position(change.timeTick)} y1={8} y2={32}>
      <title>{change.timeTick} tick：{change.value}</title>
    </line>)}
  </svg>
}
