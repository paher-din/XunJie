import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** 小用量显示实际数值，大容量沿用以万为单位的显示。 */
const tokenCount = (n: number) => {
  if (n < 10_000) return n.toLocaleString('zh-CN')
  const v = n / 10_000
  return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + '万'
}

/** 卡片尺寸用于贴边定位与视口夹取（宽与 .ctx-tip 的 width 对应）。 */
const TIP_W = 264
const TIP_H = 108

interface TipPos {
  left: number
  top?: number
  bottom?: number
}

/** 输入框工具行的 14px 容量环。用量或窗口未知时仅显示轨道和已知信息。 */
export function ContextRing({ tokens, limit, lowerBound = false, usageLabel = '已用' }: {
  tokens?: number; limit?: number; lowerBound?: boolean; usageLabel?: string
}) {
  const [pos, setPos] = useState<TipPos | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)

  // 默认悬在圈正上方，上方放不下时落到下方；水平以圈为中心并夹取进视口
  const show = useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const width = Math.min(TIP_W, window.innerWidth - 24)
    const left = Math.min(Math.max(12, r.left + r.width / 2 - width / 2), window.innerWidth - width - 12)
    setPos(r.top >= TIP_H + 22 ? { left, bottom: window.innerHeight - r.top + 10 }
      : { left, top: Math.min(r.bottom + 10, window.innerHeight - TIP_H - 12) })
  }, [])

  useEffect(() => {
    if (!pos) return
    const hide = () => setPos(null)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [pos])

  const percent = tokens !== undefined && limit ? (tokens / limit) * 100 : undefined
  const percentText = percent === undefined ? '' : lowerBound ? `≥ ${(Math.floor(percent * 10) / 10).toFixed(1)}%`
    : percent > 0 && percent < 0.1 ? '<0.1%' : `${percent.toFixed(1)}%`
  const fill = Math.min(100, percent ?? 0)
  const usage = tokens === undefined ? '暂无用量' : `${usageLabel} ${lowerBound ? '至少 ' : ''}${tokenCount(tokens)} tokens`
  const capacity = limit ? `上限 ${tokenCount(limit)} tokens` : '上限未配置'

  return (
    <>
      <span
        ref={anchorRef}
        className="ctx-ring"
        role="img"
        aria-label={`上下文容量，${usage}，${capacity}`}
        tabIndex={0}
        onPointerEnter={show}
        onPointerLeave={() => setPos(null)}
        onFocus={show}
        onBlur={() => setPos(null)}
        onKeyDown={event => { if (event.key === 'Escape') setPos(null) }}
      >
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <circle
            cx="7"
            cy="7"
            r="5.5"
            fill="none"
            stroke="var(--progress-bg)"
            strokeWidth="2.5"
          />
          {fill > 0 && <circle
            cx="7"
            cy="7"
            r="5.5"
            fill="none"
            stroke="var(--progress-fill)"
            strokeWidth="2.5"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${fill} 100`}
            transform="rotate(-90 7 7)"
          />}
        </svg>
      </span>
      {pos &&
        createPortal(
          <div className="ctx-tip" style={pos} role="tooltip">
            <div className="ctx-tip-row"><span className="ctx-tip-title">上下文容量</span>
              {percentText && <span className="ctx-tip-num">{percentText}</span>}
            </div>
            <div className="ctx-tip-detail">{usage} · {capacity}</div>
            {percent !== undefined && <div className="ctx-tip-bar"><span style={{ width: fill + '%' }} /></div>}
          </div>,
          document.body,
        )}
    </>
  )
}
