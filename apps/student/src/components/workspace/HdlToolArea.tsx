import { useId, useState, type CSSProperties } from 'react'
import type { HdlBoardProfile, HdlBuildView, HdlDiagnostic, HdlFrame, HdlInputs, HdlOperationResult, HdlSessionView } from '../../workspace/hdlContracts'

type LogicBit = '0' | '1' | 'x' | 'z'
export type HdlLight = 'on' | 'off' | 'x' | 'z' | 'unavailable'
const mono: CSSProperties = { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', overflowWrap: 'anywhere' }
const row: CSSProperties = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }
const buttonStyle: CSSProperties = { padding: '0 10px', fontSize: 12 }
const paths = { a: 'M8 8h44', b: 'M52 8v40', c: 'M52 52v40', d: 'M8 92h44', e: 'M8 52v40', f: 'M8 8v40', g: 'M8 50h44' }
const lightColors: Record<HdlLight, string> = { on: '#e8c35c', off: '#55637a', x: '#efad5d', z: '#79c7dd', unavailable: '#788394' }

/** The wire is MSB-first. Missing/invalid values never become a zero signal. */
export function hdlBit(bits: string | undefined, index: number, width: number): LogicBit | null {
  if (!bits || !new RegExp(`^[01xz]{${width}}$`).test(bits) || !Number.isInteger(index) || index < 0 || index >= width) return null
  return bits[width - 1 - index] as LogicBit
}

export function hdlLight(bit: LogicBit | null, active: 'high' | 'low'): HdlLight {
  if (bit === null) return 'unavailable'
  if (bit === 'x' || bit === 'z') return bit
  return bit === (active === 'high' ? '1' : '0') ? 'on' : 'off'
}

/** AN and cathode polarities are consumed directly; there is no numeric decoder. */
export function hdlSegmentLight(anode: LogicBit | null, segment: LogicBit | null): HdlLight {
  if (anode === null || segment === null) return 'unavailable'
  if (anode === '1') return 'off'
  if (anode === 'x' || anode === 'z') return anode
  return hdlLight(segment, 'low')
}

export function hdlInputChange(inputs: HdlInputs, signal: keyof HdlInputs, index: number, value: '0' | '1'): HdlInputs {
  const width = signal === 'switches' ? 16 : signal === 'buttons' ? 5 : 1
  if (!new RegExp(`^[01]{${width}}$`).test(inputs[signal]) || !Number.isInteger(index) || index < 0 || index >= width) {
    throw new Error('尚未取得可用的板卡输入。')
  }
  const position = width - 1 - index
  return { ...inputs, [signal]: inputs[signal].slice(0, position) + value + inputs[signal].slice(position + 1) }
}

export function hdlSessionLabel(session: HdlSessionView | null): string {
  if (!session) return '尚未装载'
  if (session.terminationConfirmed) return session.status === 'failed' ? '会话失败 · 已确认退出' : '已确认停止'
  if (session.stopRequested || session.status === 'stopping') return '等待确认退出'
  if (session.status === 'outcome_unknown') return '会话状态待核对'
  if (session.status === 'stopped') return '停止尚未确认'
  if (session.status === 'failed') return '会话失败 · 退出未确认'
  if (session.status === 'starting') return '正在装载'
  return session.pendingOperationId ? '正在处理输入' : '虚拟板运行中'
}

export function hdlResultNotice(session: HdlSessionView | null, result: HdlOperationResult | null): string | null {
  if (!result || !session) return null
  if (result.sessionId !== session.sessionId) return '以下是先前会话的历史采样，不是当前装载结果。'
  if (result.sequence !== session.confirmedSequence) return `当前会话已确认到序号 ${session.confirmedSequence}；以下保留序号 ${result.sequence} 的旧采样。`
  return null
}

function logicLabel(bit: LogicBit | null) {
  return bit === 'x' ? 'x（未知）' : bit === 'z' ? 'z（高阻）' : bit ?? '未取得'
}

function SignalDigit({ frame, index }: { frame: HdlFrame | null; index: number }) {
  const anode = hdlBit(frame?.anodes, index, 8)
  return <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
    <svg width="42" height="74" viewBox="0 0 70 104" role="img" aria-label={`AN${index}=${logicLabel(anode)}，段选=${frame?.segments ?? '未取得'}，DP=${frame?.dp ?? '未取得'}`}>
      {Object.entries(paths).map(([name, d], bitIndex) => {
        // CA(a) is bit 0 through CG(g) bit 6 in the approved Nexys4 DDR vector.
        const raw = hdlBit(frame?.segments, bitIndex, 7)
        const state = hdlSegmentLight(anode, raw)
        return <path key={name} d={d} data-segment={name} data-signal={raw ?? 'unavailable'} data-display={state}
          style={{ stroke: lightColors[state], strokeDasharray: state === 'x' || state === 'z' ? '3 3' : undefined }}
          strokeWidth="7" strokeLinecap="round" fill="none" />
      })}
      <circle cx="66" cy="93" r="3" data-segment="dp" data-signal={frame?.dp ?? 'unavailable'}
        data-display={hdlSegmentLight(anode, hdlBit(frame?.dp, 0, 1))}
        fill={lightColors[hdlSegmentLight(anode, hdlBit(frame?.dp, 0, 1))]} />
    </svg>
    <span style={{ fontSize: 10, color: '#b6bfcd' }}>AN{index}: {anode ?? '?'}</span>
  </span>
}

interface ResultProps {
  session: HdlSessionView | null
  result: HdlOperationResult | null
  pending: boolean
  currentNotice?: string | null
}

export interface HdlBoardPaneProps extends ResultProps {
  inputs: HdlInputs
  bindings?: HdlBoardProfile['bindings']
  disabled: boolean
  onInteract: (inputs: HdlInputs, advanceCycles: number) => void
  canLoad?: boolean
  onLoad?: () => void
  readBusy?: boolean
  onRead?: () => void
}

/** Existing board position, now a controlled view of the actual last confirmed frame. */
export function HdlBoardPane({ session, result, inputs, bindings, pending, disabled, currentNotice, onInteract,
  canLoad, onLoad, readBusy, onRead }: HdlBoardPaneProps) {
  const [cycles, setCycles] = useState('1')
  const reasonId = useId()
  const validCycles = /^\d+$/.test(cycles) && Number(cycles) >= 1 && Number(cycles) <= 5_000_000 && Number.isSafeInteger(Number(cycles))
  const validInputs = /^[01]{16}$/.test(inputs.switches) && /^[01]{5}$/.test(inputs.buttons) && /^[01]$/.test(inputs.resetN)
  const waiting = pending || !!session?.pendingOperationId
  const active = session?.status === 'active' && !session.stopRequested && !session.terminationConfirmed
  const blocked = disabled || waiting || !active || !validInputs || !validCycles
  const blockedReason = waiting ? '正在等待当前操作确认，确认后可继续操作。'
    : !session ? '尚未装载设计，请先检查并构建，再装载到虚拟板。'
    : session.terminationConfirmed ? '会话已结束，请重新装载已构建的设计，再操作按钮和开关。'
    : !active ? `${hdlSessionLabel(session)}，请先核对板卡状态。`
    : disabled ? '板卡操作暂不可用，请先核对板卡状态。'
    : !validInputs ? '尚未取得已确认输入，请先核对板卡状态。'
    : !validCycles ? '推进周期须为 1～5000000 的整数，修正后可继续操作按钮和开关。' : null
  const bound = (signal: 'buttons' | 'resetN', index: number) => bindings?.some(binding => binding.signal === signal && index >= binding.offset && index < binding.offset + binding.width) === true
  const frame = result?.finalFrame ?? null
  const activeAnodes = frame?.anodes.match(/0/g)?.length ?? 0
  const selectedLabel = !frame ? '尚未取得位选' : /[xz]/.test(frame.anodes) ? '位选含 X/Z'
    : activeAnodes > 1 ? '多位同时有效' : activeAnodes === 0 ? '未选位' : '单个位选'
  const send = (next: HdlInputs) => { if (!blocked) onInteract(next, Number(cycles)) }
  const change = (signal: keyof HdlInputs, index: number, value: '0' | '1') => send(hdlInputChange(inputs, signal, index, value))
  return <div className="ws-boardwrap" style={{ flexWrap: 'wrap', gap: 16, padding: 18 }} aria-label="真实 HDL 虚拟板" aria-busy={waiting}>
    <div className="ws-board" style={{ padding: '18px 20px', maxWidth: '100%', minWidth: 0, overflow: 'auto' }}>
      <div className="ws-seg-row" style={{ gap: 4 }}>
        {Array.from({ length: 8 }, (_, n) => <SignalDigit key={n} frame={frame} index={7 - n} />)}
      </div>
      <div className="ws-ledrow" style={{ gap: 9 }}>
        {Array.from({ length: 16 }, (_, n) => {
          const index = 15 - n, bit = hdlBit(frame?.leds, index, 16), state = hdlLight(bit, 'high')
          return <span key={index} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 5 }}>
            <span role="img" aria-label={`LED${index}: ${logicLabel(bit)}`} title={`LED${index}: ${logicLabel(bit)}`}
              className={`ws-led${state === 'on' ? ' on' : ''}`} data-signal={bit ?? 'unavailable'}
              style={{ background: lightColors[state], border: state === 'x' || state === 'z' ? '1px dashed #fff' : undefined }} />
            <span style={{ color: '#b6bfcd', fontSize: 9 }}>{index}<br />{bit ?? '?'}</span>
          </span>
        })}
      </div>
      <div className="ws-ctlrow" role="group" aria-label="16 位拨码开关" aria-describedby={blockedReason ? reasonId : undefined} style={{ gap: 6 }}>
        {Array.from({ length: 16 }, (_, n) => {
          const index = 15 - n, bit = hdlBit(inputs.switches, index, 16)
          return <span className="ws-switch" key={index}>
            <button type="button" className={bit === '1' ? 'ws-sw on' : 'ws-sw'} aria-label={`拨码开关 SW${index}`}
              aria-pressed={bit === '1'} disabled={blocked} onClick={() => change('switches', index, bit === '1' ? '0' : '1')} />
            SW{index}
          </span>
        })}
      </div>
      <div role="group" aria-label="5 个按钮与复位" aria-describedby={blockedReason ? reasonId : undefined} style={{ ...row, marginTop: 16, justifyContent: 'center' }}>
        {Array.from({ length: 5 }, (_, index) => {
          const bit = hdlBit(inputs.buttons, index, 5)
          return <span className="ws-switch" key={index} title={bound('buttons', index) ? undefined : `当前设计未连接 BTN${index}`}>
            <span>BTN{index}: {bound('buttons', index) ? bit ?? '?' : '未绑定'}</span>
            <button type="button" className="ws-pbtn" disabled={blocked || !bound('buttons', index) || bit === '1'} aria-label={`按下 BTN${index}`} onClick={() => change('buttons', index, '1')}>按下</button>
            <button type="button" className="ws-pbtn" disabled={blocked || !bound('buttons', index) || bit === '0'} aria-label={`松开 BTN${index}`} onClick={() => change('buttons', index, '0')}>松开</button>
          </span>
        })}
        <span className="ws-switch" title={bound('resetN', 0) ? undefined : '当前设计未连接复位输入'}>
          <span>RESET_N: {bound('resetN', 0) ? inputs.resetN || '?' : '未绑定'}</span>
          <button type="button" className="ws-pbtn" disabled={blocked || !bound('resetN', 0) || inputs.resetN === '0'} aria-label="按下复位 RESET_N=0" onClick={() => change('resetN', 0, '0')}>复位</button>
          <button type="button" className="ws-pbtn" disabled={blocked || !bound('resetN', 0) || inputs.resetN === '1'} aria-label="松开复位 RESET_N=1" onClick={() => change('resetN', 0, '1')}>松开</button>
        </span>
      </div>
    </div>
    <div className="ws-board-note" style={{ maxWidth: 400, flex: '1 1 220px' }}>
      <p role="status" aria-live="polite"><b>{hdlSessionLabel(session)}</b>{waiting ? ' · 等待当前操作确认' : ''}</p>
      {blockedReason && <p id={reasonId} role="status">{blockedReason}</p>}
      <div style={row}>
        {onLoad && (!session || session.terminationConfirmed) && <button type="button" className="ws-btn ghost"
          disabled={!canLoad || waiting} onClick={onLoad}>{session ? '重新装载已构建设计' : '装载已构建设计'}</button>}
        {onRead && <button type="button" className="ws-btn ghost" disabled={readBusy} onClick={onRead}>读取板卡状态</button>}
      </div>
      <p>{result ? `保留已确认采样：操作序号 ${result.sequence} · 模拟时间 ${frame?.simTimePs} ps` : '尚无已确认信号；不会显示默认零输出。'}</p>
      {frame && <p aria-label="已确认板卡输入" style={mono}>已确认输入：SW={frame.switches} · BTN={frame.buttons} · RESET_N={frame.resetN}</p>}
      {hdlResultNotice(session, result) && <p role="status">{hdlResultNotice(session, result)}</p>}
      {currentNotice && <p role="status">{currentNotice}</p>}
      <p>{selectedLabel}。LED 高有效；AN、SEG、DP 低有效。橙色虚线 X 表示未知，蓝色虚线 Z 表示高阻。</p>
      {frame && <p style={mono}>LED={frame.leds}<br />AN={frame.anodes}<br />SEG(gfedcba)={frame.segments} · DP={frame.dp}</p>}
      <form onSubmit={event => { event.preventDefault(); send(inputs) }} style={row}>
        <label style={row}>每次推进周期
          <input aria-label="推进周期" type="number" min="1" max="5000000" step="1" value={cycles}
            aria-invalid={!validCycles} aria-describedby={blockedReason ? reasonId : undefined}
            disabled={disabled || waiting || !active} onChange={event => setCycles(event.target.value)} style={{ width: 100, padding: 6, border: '1px solid var(--line)', borderRadius: 6, background: 'var(--paper)', color: 'var(--ink)' }} />
        </label>
        <button className="ws-btn ghost" type="submit" disabled={blocked}>推进时钟</button>
      </form>
      <p>每次输入或推进都等待真实确认。按下与松开分别推进；新草稿不会改变已装载设计。</p>
      <p>输出由已装载的 HDL 决定；输入已确认但输出不变时，请检查设计是否使用该输入。标为未绑定的按钮或复位不可操作。</p>
      <details><summary>查看信号版本</summary><p style={mono}>
        {result ? <>Session: {result.sessionId}<br />Build: {result.buildId}<br />快照: {result.snapshotId}<br />板卡: {result.boardProfileVersion}<br />映射: {result.mappingVersion}<br />引擎: {result.engineVersion}<br />结果序号 / 会话版本: {result.sequence} / {result.sessionRevision}</> : '未取得真实结果。'}
      </p></details>
    </div>
  </div>
}

/** Only geometry is scaled; full decimal timestamps are kept in labels and tables. */
export function hdlTracePositions(frames: readonly HdlFrame[], width = 960): number[] {
  if (frames.length === 0) return []
  const times = frames.map(frame => BigInt(frame.simTimePs))
  const span = times[times.length - 1] - times[0]
  return times.map((time, index) => span > 0n
    ? Number((time - times[0]) * BigInt(width * 1000) / span) / 1000
    : frames.length > 1 ? index * width / (frames.length - 1) : 0)
}

const traceSignals = [
  { label: 'RESET_N', field: 'resetN', index: 0, width: 1 },
  { label: 'LED15', field: 'leds', index: 15, width: 16 },
  { label: 'LED0', field: 'leds', index: 0, width: 16 },
  { label: 'DP', field: 'dp', index: 0, width: 1 },
] as const
const tracePageSize = 16

/** Finite sampled wave and original bit vectors. No local clock or generated frame. */
export function HdlTracePane({ session, result, pending, currentNotice }: ResultProps) {
  const [page, setPage] = useState(0)
  const frameCount = result?.frames.length ?? 0
  const lastPage = Math.max(0, Math.ceil(frameCount / tracePageSize) - 1)
  const actualPage = Math.min(page, lastPage)
  const start = actualPage * tracePageSize
  const frames = result?.frames.slice(start, start + tracePageSize) ?? []
  const positions = hdlTracePositions(frames)
  return <section className="ws-wave" aria-label="真实 HDL 有限波形" aria-busy={pending} style={{ padding: 18 }}>
    <p role="status">{hdlSessionLabel(session)}{pending ? ' · 正在等待新结果，以下保留上次确认窗口' : ''}</p>
    {hdlResultNotice(session, result) && <p role="status">{hdlResultNotice(session, result)}</p>}
    {currentNotice && <p role="status">{currentNotice}</p>}
    {!result ? <p>尚无已确认波形；等候结果不代表零信号。</p> : <>
      <p>操作序号 {result.sequence} · 本批覆盖：{result.coverage === 'complete' ? 'complete（完整）' : 'incomplete（不完整）'} · 采样数 {result.sampleCount} · 返回 {frameCount} 帧 · 丢帧 {result.droppedFrames}</p>
      <p style={mono}>本批模拟窗口：{result.frames[0]?.simTimePs}～{result.frames.at(-1)?.simTimePs} ps</p>
      <div style={row}>
        <button type="button" className="ws-btn ghost" disabled={actualPage === 0} onClick={() => setPage(actualPage - 1)}>上一采样窗口</button>
        <span>显示第 {start + 1}～{start + frames.length} 帧 / {frameCount}</span>
        <button type="button" className="ws-btn ghost" disabled={actualPage === lastPage} onClick={() => setPage(actualPage + 1)}>下一采样窗口</button>
      </div>
      <div style={{ overflowX: 'auto', marginTop: 12 }}>
        <svg width="1080" height="260" viewBox="0 0 1080 260" role="img" aria-label={`操作 ${result.sequence} 的有限采样波形`}>
          {traceSignals.map((signal, rowIndex) => {
            const middle = 36 + rowIndex * 45
            return <g key={signal.label}>
              <text x="0" y={middle + 4} fill="var(--ink-soft)" fontSize="12">{signal.label}</text>
              {frames.map((frame, index) => {
                const bit = hdlBit(frame[signal.field], signal.index, signal.width)
                const x = 94 + positions[index], nextX = 94 + (positions[index + 1] ?? 980)
                const y = bit === '1' ? middle - 10 : bit === '0' ? middle + 10 : middle
                const nextBit = frames[index + 1] ? hdlBit(frames[index + 1][signal.field], signal.index, signal.width) : bit
                const nextY = nextBit === '1' ? middle - 10 : nextBit === '0' ? middle + 10 : middle
                return <g key={index} data-sample-time={frame.simTimePs} data-signal={bit ?? 'unavailable'}>
                  <path d={`M${x} ${y}H${nextX}${index + 1 < frames.length ? `V${nextY}` : ''}`}
                    fill="none" stroke={bit === 'x' ? lightColors.x : bit === 'z' ? lightColors.z : 'var(--accent)'}
                    strokeWidth="1.6" strokeDasharray={bit === 'x' || bit === 'z' || bit === null ? '3 3' : undefined} />
                  {(bit === 'x' || bit === 'z' || bit === null) && <text x={x + 2} y={middle - 5} fill="var(--ink-soft)" fontSize="11">{bit ?? '?'}</text>}
                </g>
              })}
            </g>
          })}
          {frames.length > 0 && <>
            <text x="94" y="232" fill="var(--ink-soft)" fontSize="11">{frames[0].simTimePs} ps</text>
            <text x="1054" y="252" textAnchor="end" fill="var(--ink-soft)" fontSize="11">{frames.at(-1)!.simTimePs} ps</text>
          </>}
        </svg>
      </div>
      <p className="ws-pane-note">连线只连接本批采样点，不能证明采样点之间的完整波形。窗口与丢帧限制保持原记录。</p>
      <div style={{ overflowX: 'auto' }}><table aria-label="原始四态采样" style={{ ...mono, fontSize: 12, borderSpacing: '12px 8px', textAlign: 'left' }}>
        <thead><tr>{['模拟时间 / ps', 'SW[15:0]', 'BTN[4:0]', 'RESET_N', 'LED[15:0]', 'AN[7:0]', 'SEG[6:0]', 'DP'].map(label => <th key={label}>{label}</th>)}</tr></thead>
        <tbody>{frames.map((frame, index) => <tr key={index}>
          {[frame.simTimePs, frame.switches, frame.buttons, frame.resetN, frame.leds, frame.anodes, frame.segments, frame.dp].map((value, cell) => <td key={cell} style={{ whiteSpace: 'nowrap' }}>{value}</td>)}
        </tr>)}</tbody>
      </table></div>
      <details><summary>查看波形来源</summary><p style={mono}>Session: {result.sessionId}<br />Build: {result.buildId}<br />快照: {result.snapshotId}<br />Operation: {result.operationId}<br />会话版本: {result.sessionRevision}<br />结果 hash: {result.resultHash}</p></details>
    </>}
  </section>
}

export interface HdlRunClusterProps {
  build: HdlBuildView | null
  session: HdlSessionView | null
  busy: boolean
  readBusy?: boolean
  unknown?: boolean
  notice?: string | null
  snapshotLabel?: string
  canBuild: boolean
  canLoad: boolean
  canStop: boolean
  onBuild: () => void
  onLoad: () => void
  onStop: () => void
  onRefresh: () => void
}

const buildLabels = { queued: '构建排队中', running: '正在构建', succeeded: '构建成功', failed: '构建失败', cancelled: '构建已取消', outcome_unknown: '构建结果待核对' }
function buildLabel(build: HdlBuildView): string {
  if (build.result) return buildLabels[build.result.status]
  return build.status === 'queued' || build.status === 'running' ? buildLabels[build.status] : '构建结果待读取'
}

export function HdlRunCluster({ build, session, busy, readBusy = busy, unknown, notice, snapshotLabel, canBuild, canLoad, canStop, onBuild, onLoad, onStop, onRefresh }: HdlRunClusterProps) {
  return <>
    <span className="ws-run-state" role="status" aria-live="polite" title={notice ?? undefined}>
      {unknown ? 'HDL 操作结果待核对' : session ? hdlSessionLabel(session) : build ? buildLabel(build) : '尚未构建'}
    </span>
    {snapshotLabel && <span className="ws-flow" title="构建固定所选确认快照；不会自动选择最新草稿。">{snapshotLabel}</span>}
    <span className="ws-run-actions" role="group" aria-label="真实 HDL 构建与会话操作" aria-busy={busy}>
      <button type="button" className="ws-btn ghost" style={buttonStyle} disabled={busy || !canBuild} onClick={onBuild}>检查并构建</button>
      <button type="button" className="ws-btn solid" style={buttonStyle} disabled={busy || !canLoad} onClick={onLoad}>{session && !session.terminationConfirmed ? '替换装载' : '装载到虚拟板'}</button>
      <button type="button" className="ws-btn ghost" style={buttonStyle} disabled={!canStop} onClick={onStop}>停止 HDL</button>
      <button type="button" className="ws-btn ghost" style={buttonStyle} disabled={readBusy} onClick={onRefresh}>核对 HDL 状态</button>
    </span>
  </>
}

export interface HdlBuildPaneProps {
  build: HdlBuildView | null
  busy?: boolean
  notice?: string | null
  canHelp?: boolean
  onDiagnostic?: (diagnostic: HdlDiagnostic, build: HdlBuildView) => void
  onHelp?: () => void
  onRead: () => void
}

export function HdlBuildPane({ build, busy, notice, canHelp, onDiagnostic, onHelp, onRead }: HdlBuildPaneProps) {
  const result = build?.result
  return <section aria-label="真实 HDL 构建诊断" style={{ padding: '12px 16px', borderTop: '1px solid var(--line)', fontSize: 13 }}>
    <div style={row}>
      <b role="status">{build ? buildLabel(build) : '尚无构建结果'}</b>
      <button type="button" className="ws-btn ghost" style={buttonStyle} disabled={busy} onClick={onRead}>读取构建结果</button>
      {onHelp && <button type="button" className="ws-btn ghost" style={buttonStyle} disabled={busy || !canHelp} onClick={onHelp}>引用此次构建求助</button>}
    </div>
    {notice && <p role="status">{notice}</p>}
    {build && !result && <p>真实结果尚未返回，不能据此判断编译成功或失败。</p>}
    {build && result && <>
      <p>诊断来自此次确认快照；之后的草稿不会改变它。{result.terminationConfirmed ? '' : '构建隔离单元退出尚未确认。'}</p>
      {result.diagnostics.length === 0 ? <p>此次返回未列诊断。</p> : <ul style={{ paddingLeft: 20 }}>
        {result.diagnostics.map((diagnostic, index) => <li key={index} style={{ paddingBlock: 4 }}>
          <b>{diagnostic.severity === 'error' ? '错误' : '警告'}</b>：{diagnostic.message}
          <br /><span>{diagnostic.path ?? '源文件位置未提供'}{diagnostic.location === 'line-only' && diagnostic.line ? ` · 第 ${diagnostic.line} 行（整行定位）` : ' · 无法精确定位'}</span>
          {onDiagnostic && <button type="button" className="ws-btn ghost" style={{ ...buttonStyle, marginLeft: 8 }}
            disabled={diagnostic.location !== 'line-only' || !diagnostic.line || (!diagnostic.path && !diagnostic.fileId)}
            onClick={() => onDiagnostic(diagnostic, build)}>查看诊断源行</button>}
        </li>)}
      </ul>}
      <details><summary>查看构建来源与日志</summary>
        <p style={mono}>Build: {result.buildId}<br />快照: {result.snapshotId}<br />引擎: {result.engineVersion}<br />板卡: {result.board.boardProfileVersion}<br />映射: {result.board.mappingVersion}</p>
        {result.stdout && <pre style={{ ...mono, whiteSpace: 'pre-wrap' }}>stdout{`\n${result.stdout}`}</pre>}
        {result.stderr && <pre style={{ ...mono, whiteSpace: 'pre-wrap' }}>stderr{`\n${result.stderr}`}</pre>}
      </details>
    </>}
  </section>
}
