import { useState } from 'react'
import type { ConceptCard as ConceptCardData, WaveRow, WaveSpec } from '../../bridge/types'

/**
 * 概念讲解卡：结构化要点 + 时序波形图示，嵌在正文段落之间（已确认 2026-10-10，
 * docs/agent-page-design.md「教学专属块」）。只在落定后挂载。
 * 「收纳」按场景分流：对话页钉到右缘对照（pinned，portal 由父级处理）；
 * 工作区收进工作区卡片体系（随工作区轮次接，届时由父级换 onTogglePin 的实现）。
 */
export function ConceptCard({
  card,
  pinned,
  onTogglePin,
}: {
  card: ConceptCardData
  pinned?: boolean
  /** 收纳 / 取消收纳；不传则不提供收纳动作。 */
  onTogglePin?: () => void
}) {
  const [open, setOpen] = useState(true)
  return (
    <div className={'concept-card' + (open ? '' : ' closed')}>
      <div className="concept-head">
        <span className="concept-cap">概念讲解</span>
        <span className="concept-title">{card.title}</span>
        <button className="concept-fold" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开'}
        </button>
      </div>
      {open && (
        <>
          <div className="concept-body">
            <ul className="concept-points">
              {card.points.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
            {card.wave && <Waveform spec={card.wave} />}
            {card.note && <div className="concept-note">{card.note}</div>}
          </div>
          {onTogglePin && (
            <div className="concept-foot">
              <button className="concept-keep" onClick={onTogglePin}>
                {pinned ? '取消收纳' : '收纳'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/* 波形几何与评审原型（docs/prototypes/agent-blocks/concept.html）同一份坐标 */
const X0 = 60
const X1 = 356
const ROW = 30
const AMP = 8
const CLK_HALF = 16

function clkSegs(): [number, number][] {
  const segs: [number, number][] = []
  let level = 0
  for (let x = X0 + CLK_HALF; x < X1; x += CLK_HALF) {
    segs.push([x, level])
    level = 1 - level
  }
  return segs
}

function rowPath(row: WaveRow, y: number): string {
  const hi = y - AMP
  const lo = y + AMP
  const segs = row.clk ? clkSegs() : (row.segs ?? [])
  let d = `M${X0},${hi}`
  let cur = 1
  for (const [x, lv] of segs) {
    d += ` L${x},${cur ? hi : lo} L${x},${lv ? hi : lo}`
    cur = lv
  }
  return d + ` L${X1},${cur ? hi : lo}`
}

/** 时序波形：WaveSpec 数据直接映射成 SVG，无运行时依赖。 */
function Waveform({ spec }: { spec: WaveSpec }) {
  const H = spec.rows.length * ROW + 14
  return (
    <svg className="concept-wave" viewBox={`0 0 364 ${H}`} role="img" aria-label="时序波形图">
      {spec.highlight && (
        <rect
          className="concept-wave-hl"
          x={spec.highlight[0]}
          y={4}
          width={spec.highlight[1] - spec.highlight[0]}
          height={H - 16}
        />
      )}
      {(spec.markers ?? []).map((x) => (
        <line key={x} className="concept-wave-marker" x1={x} y1={4} x2={x} y2={H - 14} />
      ))}
      {spec.rows.map((r, i) => {
        const y = i * ROW + ROW / 2 + 5
        return (
          <g key={r.name}>
            <text className="concept-wave-name" x={8} y={y + 3.5}>
              {r.name}
            </text>
            <path className={'concept-wave-line' + (r.clk ? ' clk' : '')} d={rowPath(r, y)} />
          </g>
        )
      })}
      {(spec.labels ?? []).map((l, i) => (
        <text
          key={i}
          className="concept-wave-label"
          x={l.x}
          y={H - 2}
          dx={l.dx ?? 0}
          textAnchor="middle"
        >
          {l.text}
        </text>
      ))}
    </svg>
  )
}
