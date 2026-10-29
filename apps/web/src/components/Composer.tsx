import { Icon } from '../icons'
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'

interface ComposerProps {
  /** 展开态：气泡由入口形态就地长成输入形态。 */
  open: boolean
  value: string
  onChange: (value: string) => void
  onSend: (text: string) => void
  /** 点收起的入口气泡：与点 IP、⌘ / Ctrl + J 同一条路径，开合状态由外壳接管。 */
  onOpen: () => void
  onClose: () => void
}

/**
 * 首页悬浮输入气泡：挂在 IP 左侧。收起时是「有问题，问我 ⌘J」入口，
 * 点开后同一个盒子就地长成输入气泡——右缘、尾巴与纵向中心都不动，只向左、上下延伸，
 * 像从 IP 那边挤出来。
 *
 * 几何与动效都在 app.css 的 .ask 一段（纯 CSS 过渡）：宽度 / 高度 / bottom / 圆角 / 阴影
 * 在两个形态之间过渡（开 0.35s、收 0.24s，S 曲线）；入口文字与输入区在同一个外壳里交叉
 * 淡入淡出。输入区按最终尺寸定位、由外壳 overflow: clip 随盒子扩张自右向左逐段揭开，
 * 所以文本框宽度全程不变——聚焦时也不会被浏览器挪动，光标与文字一路不抖。
 *
 * 收起态宽度由入口内容实测写进 --ask-w-closed（字体 / 缩放变化后入口依然是贴合的胶囊）；
 * 打开即聚焦，光标落在输入区最终位置上、随展开一起露出来。
 */
export function Composer({ open, value, onChange, onSend, onOpen, onClose }: ComposerProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const ctaRef = useRef<HTMLSpanElement>(null)
  const [ctaWidth, setCtaWidth] = useState(0)

  useLayoutEffect(() => {
    const el = ctaRef.current
    if (!el) return
    const sync = () => setCtaWidth(el.offsetWidth)
    sync()
    const observer = new ResizeObserver(sync)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const canSend = value.trim().length > 0

  return (
    <div
      className={'ask' + (open ? ' open' : '') + (value.trim() ? ' typed' : '')}
      style={ctaWidth ? ({ '--ask-w-closed': `${ctaWidth + 20}px` } as CSSProperties) : undefined}
    >
      <div className="ask-shell">
        <button
          type="button"
          className="ask-cta"
          onClick={onOpen}
          inert={open}
          aria-expanded={open}
          title="请教学习助手 · ⌘ / Ctrl + J"
        >
          <span className="ask-cta-text" ref={ctaRef}>
            有问题，问我 <kbd>⌘J</kbd>
          </span>
        </button>
        <form
          className="ask-form"
          inert={!open}
          onSubmit={(e) => {
            e.preventDefault()
            if (canSend) onSend(value.trim())
          }}
        >
          <span className="ask-symbol">
            <Icon name="assistant-mark" size={20} />
          </span>
          <input
            ref={inputRef}
            aria-label="向 Agent 提问"
            placeholder="询问知识、任务或学习情况…"
            autoComplete="off"
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
          <span className="ask-keys" aria-hidden="true">
            Enter 发送 · Esc 收起
          </span>
          <button
            type="button"
            className="ask-close"
            onClick={onClose}
            aria-label="收起输入框"
            title="收起（Esc）"
          >
            <Icon name="close" size={14} />
          </button>
          <button type="submit" className="ask-send" aria-label="发送消息" disabled={!canSend}>
            <Icon name="arrow-up" size={18} />
          </button>
        </form>
      </div>
      <span className="ask-tail" aria-hidden="true" />
    </div>
  )
}
