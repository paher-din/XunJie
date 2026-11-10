import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../icons'

/** 设置区块：标题 + 可选说明 + 内容。 */
export function Section({ title, desc, children }: { title: string; desc?: string; children: ReactNode }) {
  return (
    <section className="st-section">
      <header className="st-section-head">
        <h2 className="st-section-title">{title}</h2>
        {desc && <p className="st-section-desc">{desc}</p>}
      </header>
      {children}
    </section>
  )
}

/** 表单行：左侧标签 + 说明，右侧控件；stack 时标签在上、控件通栏在下（适合滑杆与单选卡组）。 */
export function Row({ label, hint, stack, children }: { label: string; hint?: string; stack?: boolean; children: ReactNode }) {
  return (
    <div className={'st-row' + (stack ? ' st-stack' : '')}>
      <div className="st-row-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="st-row-ctrl">{children}</div>
    </div>
  )
}

/** 开关：即时生效类设置的主控件。 */
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={'st-toggle' + (checked ? ' on' : '')}
      onClick={() => onChange(!checked)}
    >
      <span className="st-toggle-knob" />
    </button>
  )
}

/** 分段控件：2–3 个互斥选项。 */
export function Seg<T extends string>({
  options, value, onChange, ariaLabel,
}: {
  options: Array<{ value: T; label: string; hint?: string }>
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
}) {
  return (
    <div className="st-seg" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          className={'st-seg-item' + (o.value === value ? ' active' : '')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** 滑杆：引导强度等连续值，两端带语义标签。 */
export function Slider({
  value, onChange, minLabel, maxLabel, ariaLabel,
}: {
  value: number
  onChange: (v: number) => void
  minLabel: string
  maxLabel: string
  ariaLabel?: string
}) {
  return (
    <div className="st-slider">
      <input
        type="range"
        min={0}
        max={100}
        step={5}
        value={value}
        aria-label={ariaLabel}
        aria-valuetext={`${value}`}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ '--v': `${value}%` } as React.CSSProperties}
      />
      <div className="st-slider-ends">
        <span>{minLabel}</span>
        <span>{maxLabel}</span>
      </div>
    </div>
  )
}

/** 气泡宽度与 .st-tip 的 max-width 对应，用于贴边夹取。 */
const TIP_W = 240
/** 上方留不出三行气泡的空间时改往下弹。 */
const TIP_ABOVE_MIN = 120

/**
 * ? 说明气泡：portal 到 body 后按视口坐标定位。
 * 弹窗正文是 overflow 滚动容器，纯 CSS 的 ::after 气泡会被容器裁切（水平越界即被切掉）。
 */
export function HelpTip({ tip }: { tip: string }) {
  const anchorRef = useRef<HTMLSpanElement>(null)
  const [pos, setPos] = useState<{ left: number; bottom?: number; top?: number } | null>(null)

  const show = () => {
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const left = Math.min(Math.max(r.left + r.width / 2, 12 + TIP_W / 2), window.innerWidth - 12 - TIP_W / 2)
    // 以底边定位挂在图标上方：高度由文案撑开，无需预估行数
    setPos(r.top > TIP_ABOVE_MIN
      ? { left, bottom: window.innerHeight - r.top + 8 }
      : { left, top: r.bottom + 8 })
  }

  useEffect(() => {
    if (!pos) return
    // 视口坐标在弹出那一刻定死，滚动 / 缩放后位置就失效了，直接收起
    const hide = () => setPos(null)
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [pos])

  return (
    <>
      <span
        ref={anchorRef}
        className="st-help"
        tabIndex={0}
        onPointerEnter={show}
        onPointerLeave={() => setPos(null)}
        onFocus={show}
        onBlur={() => setPos(null)}
      >
        <Icon name="question-circle" size={14} />
      </span>
      {pos && createPortal(
        <div
          className="st-tip"
          role="tooltip"
          style={{ left: pos.left, bottom: pos.bottom, top: pos.top }}
        >
          {tip}
        </div>,
        document.body,
      )}
    </>
  )
}

/** 表单字段：标签 + ? 说明 + 输入，错误时显示错误文案。 */
export function Field({
  label, tip, error, errorId, children,
}: {
  label: string
  tip?: string
  error?: string
  errorId?: string
  children: ReactNode
}) {
  return (
    <div className={'st-field' + (error ? ' invalid' : '')}>
      <span className="st-field-label">{label}{tip && <HelpTip tip={tip} />}</span>
      {children}
      {error && <span id={errorId} className="st-field-error" role="alert">{error}</span>}
    </div>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={'st-input' + (props.className ? ' ' + props.className : '')} />
}

/** 单选卡片组：模型选择、语气、提示方式等带描述的互斥选项。 */
export function RadioCard<T extends string>({
  options, value, onChange, ariaLabel,
}: {
  options: Array<{ value: T; title: string; desc?: string; icon?: ReactNode; disabled?: boolean }>
  value: T
  onChange: (v: T) => void
  ariaLabel?: string
}) {
  return (
    <div className="st-cards" role="radiogroup" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={o.disabled}
          tabIndex={o.value === value || !options.some(item => item.value === value && !item.disabled) && o === options.find(item => !item.disabled) ? 0 : -1}
          className={'st-card' + (o.value === value ? ' active' : '')}
          onClick={() => onChange(o.value)}
          onKeyDown={event => {
            if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
            event.preventDefault()
            const available = options.filter(item => !item.disabled)
            const index = available.findIndex(item => item.value === o.value)
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? available.length - 1
              : (index + (event.key === 'ArrowUp' || event.key === 'ArrowLeft' ? -1 : 1) + available.length) % available.length
            const option = available[next]
            if (!option) return
            const buttons = [...event.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
            buttons[next]?.focus()
            onChange(option.value)
          }}
        >
          {o.icon}
          <span className="st-card-text">
            <span className="st-card-title">{o.title}</span>
            {o.desc && <span className="st-card-desc">{o.desc}</span>}
          </span>
          <span className="st-card-check" aria-hidden="true">
            <Icon name="check-circle" size={18} />
          </span>
        </button>
      ))}
    </div>
  )
}

import type { ComponentProps } from 'react'
export type SectionProps = ComponentProps<typeof Section>
export type RowProps = ComponentProps<typeof Row>
export type ToggleProps = ComponentProps<typeof Toggle>
export type SliderProps = ComponentProps<typeof Slider>
export type HelpTipProps = ComponentProps<typeof HelpTip>
export type FieldProps = ComponentProps<typeof Field>
export type TextInputProps = ComponentProps<typeof TextInput>
export type SegProps<T extends string> = Parameters<typeof Seg<T>>[0]
export type RadioCardProps<T extends string> = Parameters<typeof RadioCard<T>>[0]
