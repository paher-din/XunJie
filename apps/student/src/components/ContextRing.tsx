import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** 上下文窗口上限（演示值）：30 万 token。 */
export const CONTEXT_LIMIT = 300_000

/** 万为单位：整数不带小数（30 万），非整数保留一位（21.4 万）。 */
const wan = (n: number) => {
  const v = n / 10_000
  return (Number.isInteger(v) ? String(v) : v.toFixed(1)) + '万'
}

/** 卡片尺寸用于贴边定位与视口夹取（宽与 .ctx-tip 的 width 对应）。 */
const TIP_W = 264
const TIP_H = 76

interface TipPos {
  left: number
  top: number
}

/**
 * 输入框工具行的上下文容量环：14px SVG 进度圈（已用 / 30 万上限），
 * 悬停时以 portal 在圈正上方弹出「上下文容量」卡片（标题 + 等宽数值 + 进度条），
 * 上方放不下落到下方、水平以圈为中心夹取进视口；卡片不参与指针交互，滚动 / 缩放时直接收起。
 */
export function ContextRing({ tokens }: { tokens: number }) {
  const [pos, setPos] = useState<TipPos | null>(null)
  const anchorRef = useRef<HTMLSpanElement>(null)

  // 默认悬在圈正上方，上方放不下时落到下方；水平以圈为中心并夹取进视口
  const show = useCallback(() => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    let top = r.top - TIP_H - 10
    if (top < 12) top = Math.min(r.bottom + 10, window.innerHeight - TIP_H - 12)
    let left = r.left + r.width / 2 - TIP_W / 2
    left = Math.min(Math.max(12, left), window.innerWidth - TIP_W - 12)
    setPos({ left, top })
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

  const pct = Math.min(100, (tokens / CONTEXT_LIMIT) * 100)

  return (
    <>
      <span
        ref={anchorRef}
        className="ctx-ring"
        role="img"
        aria-label={`上下文已用 ${wan(tokens)}，上限 ${wan(CONTEXT_LIMIT)}`}
        onPointerEnter={show}
        onPointerLeave={() => setPos(null)}
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
          <circle
            cx="7"
            cy="7"
            r="5.5"
            fill="none"
            stroke="var(--progress-fill)"
            strokeWidth="2.5"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${pct} 100`}
            transform="rotate(-90 7 7)"
          />
        </svg>
      </span>
      {pos &&
        createPortal(
          <div className="ctx-tip" style={{ left: pos.left, top: pos.top }} role="tooltip">
            <div className="ctx-tip-row">
              <span className="ctx-tip-title">上下文容量</span>
              <span className="ctx-tip-num">
                {wan(tokens)}/{wan(CONTEXT_LIMIT)}（{pct.toFixed(1)}%）
              </span>
            </div>
            <div className="ctx-tip-bar">
              <span style={{ width: pct + '%' }} />
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}
