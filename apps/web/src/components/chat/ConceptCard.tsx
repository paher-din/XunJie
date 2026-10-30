import { useState } from 'react'
import type { ConceptCard as ConceptCardData, WaveRow, WaveSpec } from '../../bridge/types'

/**
 * 概念讲解卡：结构化要点 + 时序波形图示，嵌在正文段落之间（已确认 2026-10-10，
 * docs/agent-page-design.md「教学专属块」）。随正文画出（2026-10-12）：讲到依附的那一段就立壳，
 * 要点一条一条写出来（行高靠展开长，不靠插）、波形一次到位但各行按档依次描线、读图提示收尾。
 * 动作按阶段给：生成中只挂呼吸点，被叫停就停在半张卡（什么都不给），落定才齐全。
 * 「收纳」按场景分流：对话页钉到右缘对照（pinned，portal 由父级处理）；
 * 工作区收进工作区卡片体系（随工作区轮次接，届时由父级换 onTogglePin 的实现）。
 */
export function ConceptCard({
  card,
  stage = 'ready',
  pinned,
  onTogglePin,
}: {
  card: ConceptCardData
  /** 卡片处在哪个阶段：drawing 生成中 / paused 这条被叫停 / ready 落定。 */
  stage?: 'drawing' | 'paused' | 'ready'
  pinned?: boolean
  /** 收纳 / 取消收纳；不传则不提供收纳动作。 */
  onTogglePin?: () => void
}) {
  const [open, setOpen] = useState(true)
  const drawing = stage === 'drawing'
  // 还没落任何内容的那一拍不摆一只空 body——与正文「只有标记、还没有内容就先当不存在」同一口径
  const hasBody = card.points.length > 0 || !!card.wave || !!card.note
  const body = open && hasBody
  return (
    <div className={'concept-card' + (body ? '' : ' closed')}>
      <div className="concept-head">
        <span className="concept-cap">概念讲解</span>
        <span className="concept-title">{card.title}</span>
        {drawing ? (
          <span className="concept-live">
            <span className="turn-dots">
              <i />
              <i />
              <i />
            </span>
            <span>生成中</span>
          </span>
        ) : (
          stage === 'ready' && (
            <button className="concept-fold" onClick={() => setOpen((v) => !v)}>
              {open ? '收起' : '展开'}
            </button>
          )
        )}
      </div>
      {body && (
        <>
          <div className="concept-body">
            <ul className="concept-points">
              {/* span 是折叠动画的那一格：0fr → 1fr 得有内容能被压到 0 高，长出来的才是高度而不是跳动 */}
              {card.points.map((p, i) => (
                <li key={i}>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
            {card.wave && <Waveform spec={card.wave} />}
            {card.note && (
              <div className="concept-note">
                <span>{card.note}</span>
              </div>
            )}
          </div>
          {stage === 'ready' && onTogglePin && (
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

/** 时序波形：WaveSpec 数据直接映射成 SVG，无运行时依赖。整块到位，各行按 90ms 一档依次描出来。 */
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
            {/* pathLength 把长度归一成 1：dasharray 1 就是实线，描图只动 dashoffset；行与行隔 90ms 描 */}
            <path
              className={'concept-wave-line' + (r.clk ? ' clk' : '')}
              d={rowPath(r, y)}
              pathLength={1}
              style={{ animationDelay: `${i * 90}ms` }}
            />
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
