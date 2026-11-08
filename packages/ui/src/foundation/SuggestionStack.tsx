import { Icon } from '../icons'
import { useEffect, useState, type CSSProperties } from 'react'

/** 退场时长：与 .suggest-stack.leaving 的 transition 一致，播完才卸载。 */
const EXIT_MS = 150

/**
 * 建议 / 追问问题：浮在输入框上方的一叠卡片。
 * 折叠时只露出最上面一张加两层露边，指针进入或键盘聚焦时整叠展开；
 * 左槽 40px 常驻 ↳（超过 3 条时在箭头左侧补总数）；
 * 点击卡片把该问题填进输入框、不发送（由调用方接管草稿与焦点）。
 * 几何与入场动效都在 app.css 的 .suggest-stack 一段里（纯 CSS），这里只传条数与卡序。
 * show 变 false 时不立即卸载：先挂 .leaving 播 150ms 淡出下沉（容器级 transition，
 * 中途 show 回 true 能平滑接回），播完再脱流。
 *
 * 展开由 .open 类驱动而非 CSS :hover（2026-10-11）：换挡（点「回到底部」）会让叠层正好
 * 出现在停着的指针底下；浏览器重排后自己补发 mouseenter / mouseover，:hover 与 mouseenter
 * 都会立刻命中、叠层凭空弹开。改挂 mousemove——只有指针真的动了才算「学生在看这一叠」。
 */
export function SuggestionStack({
  items,
  onPick,
  label = '建议问题',
  show = true,
}: {
  items: string[]
  onPick: (text: string) => void
  /** 无障碍标签：初始建议为「建议问题」，追问选项为「追问建议」。 */
  label?: string
  /** 是否显示；false 时播完退场动画再卸载。 */
  show?: boolean
}) {
  const [mounted, setMounted] = useState(show)
  const [armed, setArmed] = useState(false)
  const leaving = mounted && !show
  useEffect(() => {
    if (show) {
      setMounted(true)
      return
    }
    if (!mounted) return
    const t = window.setTimeout(() => setMounted(false), EXIT_MS)
    return () => window.clearTimeout(t)
  }, [show, mounted])
  if (!mounted || items.length === 0) return null

  return (
    <div
      className={'suggest-stack' + (armed ? ' open' : '') + (leaving ? ' leaving' : '')}
      role="group"
      aria-label={label}
      style={{ '--ss-n': items.length } as CSSProperties}
      onMouseMove={() => setArmed(true)}
      onMouseLeave={() => setArmed(false)}
      onFocus={() => setArmed(true)}
      onBlur={() => setArmed(false)}
    >
      <span className="ss-gutter" aria-hidden="true">
        <span className="ss-count">{items.length}</span>
        <Icon name="insert-prompt" />
      </span>
      <div className="ss-cards">
        {items.map((text, i) => (
          <button
            key={text}
            type="button"
            className="ss-card"
            title={text}
            style={{ '--i': i } as CSSProperties}
            onClick={() => onPick(text)}
          >
            <span className="ss-text">{text}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
