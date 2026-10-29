import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../icons'
import { smartModelDefaults, type ProviderModel } from '../../lib/settings'

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
  label, tip, error, children,
}: {
  label: string
  tip?: string
  error?: string
  children: ReactNode
}) {
  return (
    <div className={'st-field' + (error ? ' invalid' : '')}>
      <span className="st-field-label">
        {label}
        {tip && <HelpTip tip={tip} />}
      </span>
      {children}
      {error && <span className="st-field-error">{error}</span>}
    </div>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={'st-input' + (props.className ? ' ' + props.className : '')} />
}

const INPUT_TYPES: Array<{ id: 'image' | 'video' | 'pdf'; label: string }> = [
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
  { id: 'pdf', label: 'PDF' },
]

/**
 * 一个模型的完整表单：智能配置开关、模型 ID、上下文窗口 / 最大输出、输入类型、推理等级。
 * 供应商弹窗的模型卡与卡片上的「添加 / 编辑模型」弹窗共用同一份——两处能力必须对齐，
 * 否则从供应商里接进来的模型就得再进一次弹窗才配得全。
 */
export function ModelFields({
  model, onPatch, onRemove, idError,
}: {
  model: ProviderModel
  onPatch: (patch: Partial<ProviderModel>) => void
  /** 一张卡对应一个模型时给出移除入口；单模型弹窗不传。 */
  onRemove?: () => void
  idError?: string
}) {
  const [smart, setSmart] = useState(true)
  const [addingLevel, setAddingLevel] = useState(false)
  const [levelDraft, setLevelDraft] = useState('')

  /** ID 命中参照表、且窗口与上限还没被填过时才回填，手写过的值不覆盖。 */
  const changeId = (v: string) => {
    const preset = smart ? smartModelDefaults(v) : null
    onPatch(preset && !model.contextWindow && !model.maxOutput ? { id: v, ...preset } : { id: v })
  }

  const addLevel = () => {
    const v = levelDraft.trim()
    if (v && !model.reasoningLevels.includes(v)) {
      onPatch({ reasoningLevels: [...model.reasoningLevels, v] })
    }
    setLevelDraft('')
    setAddingLevel(false)
  }

  return (
    <>
      <div className="st-smart-row">
        <span className="st-field-label">
          智能配置
          <HelpTip tip="按已知精确模型 ID 填写参考值；连接测试可导入供应商返回的实际能力" />
        </span>
        <Toggle checked={smart} onChange={setSmart} label="智能配置" />
      </div>
      <Field label="模型 ID" error={idError}>
        <div className="st-model-row">
          <TextInput
            value={model.id}
            placeholder="模型 ID，例如 deepseek-flash"
            className="st-mono-input"
            onChange={(e) => changeId(e.target.value)}
          />
          {onRemove && (
            <button type="button" className="st-iconbtn" aria-label="移除模型" onClick={onRemove}>
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
      </Field>
      <div className="st-model-cols">
        <Field label="上下文窗口" tip="输入与输出共用此容量；发送前保守核算，不自动截断历史。留空使用16384。">
          <TextInput
            type="number"
            min={1}
            value={model.contextWindow}
            placeholder="如 131072"
            onChange={(e) => onPatch({ contextWindow: e.target.value })}
          />
        </Field>
        <Field label="最大输出 Token" tip="实际请求的 max_tokens，包含模型思考与正文；需小于上下文窗口。留空使用4096。">
          <TextInput
            type="number"
            min={1}
            value={model.maxOutput}
            placeholder="如 30000"
            onChange={(e) => onPatch({ maxOutput: e.target.value })}
          />
        </Field>
      </div>
      <div className="st-field">
        <span className="st-field-label">输入类型</span>
        <div className="st-checks">
          <span className="st-check checked locked">
            <Icon name="check" size={13} className="st-check-mark" />文本<Icon name="lock-keyhole" size={12} />
          </span>
          {INPUT_TYPES.map((t) => {
            const on = model.inputTypes.includes(t.id)
            return (
              <button
                key={t.id}
                type="button"
                className={'st-check' + (on ? ' checked' : '')}
                aria-pressed={on}
                onClick={() => onPatch({
                  inputTypes: on ? model.inputTypes.filter((x) => x !== t.id) : [...model.inputTypes, t.id],
                })}
              >
                {on && <Icon name="check" size={13} className="st-check-mark" />}{t.label}
              </button>
            )
          })}
        </div>
      </div>
      <div className="st-field">
        <span className="st-field-label">推理等级（从低到高）</span>
        <div className="st-checks">
          {model.reasoningLevels.map((l, i) => (
            <span className="st-check checked" key={l}>
              {l}
              <button
                type="button"
                className="st-check-x"
                aria-label={`移除${l}`}
                onClick={() => onPatch({ reasoningLevels: model.reasoningLevels.filter((_, j) => j !== i) })}
              >
                <Icon name="close" size={11} />
              </button>
            </span>
          ))}
          {addingLevel ? (
            <input
              className="st-input st-level-input"
              value={levelDraft}
              autoFocus
              placeholder="如 low"
              onChange={(e) => setLevelDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addLevel()
                if (e.key === 'Escape') { setAddingLevel(false); setLevelDraft('') }
              }}
              onBlur={addLevel}
            />
          ) : (
            <button type="button" className="st-check st-check-add" aria-label="添加推理等级" onClick={() => setAddingLevel(true)}>
              <Icon name="add" size={13} />
            </button>
          )}
        </div>
      </div>
    </>
  )
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
          className={'st-card' + (o.value === value ? ' active' : '')}
          onClick={() => onChange(o.value)}
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
