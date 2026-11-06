import { useEffect, useId, useRef, useState } from 'react'
import { ALU_CONTROL_LIMITS, ALU_CONTROLS, type AluControl } from './state'

const widths: Record<AluControl, number> = { A: 4, B: 4, M: 1, S: 2, Cin: 1 }
const labels: Record<AluControl, string> = { A: 'A（无符号 4 位）', B: 'B（无符号 4 位）',
  M: 'M（模式，0/1）', S: 'S（操作选择，0–3）', Cin: 'Cin（进位输入，0/1）' }

/** Numeric editing is a second view of the same input state as the switches, not another draft. */
export function NumericEditor({ values, disabled, onChange }: {
  values: Record<AluControl, number>
  disabled: boolean
  onChange: (control: AluControl, value: number) => void
}) {
  const id = useId()
  const [drafts, setDrafts] = useState<Record<AluControl, string>>(() =>
    Object.fromEntries(ALU_CONTROLS.map(control => [control, String(values[control])])) as Record<AluControl, string>)
  const [errors, setErrors] = useState<Partial<Record<AluControl, string>>>({})
  const focused = useRef<AluControl | null>(null)
  useEffect(() => {
    setDrafts(previous => {
      const next = { ...previous }
      for (const control of ALU_CONTROLS) if (focused.current !== control) next[control] = String(values[control])
      return next
    })
  }, [values.A, values.B, values.M, values.S, values.Cin])
  const edit = (control: AluControl, raw: string) => {
    setDrafts(previous => ({ ...previous, [control]: raw }))
    if (!/^\d{1,2}$/.test(raw)) {
      setErrors(previous => ({ ...previous, [control]: `请输入 0–${ALU_CONTROL_LIMITS[control]} 的整数。` }))
      return
    }
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 0 || value > ALU_CONTROL_LIMITS[control]) {
      setErrors(previous => ({ ...previous, [control]: `超出范围：只能输入 0–${ALU_CONTROL_LIMITS[control]}。` }))
      return
    }
    setErrors(previous => ({ ...previous, [control]: undefined }))
    onChange(control, value)
  }
  return <section className="alu-numeric" aria-label="ALU 数值输入">
    <h3>数值编辑</h3>
    <p className="alu-hint">与开关是同一份输入；非法或未完成的文本留在编辑框，不改变端口值，也不触发仿真。</p>
    <div className="alu-numeric-grid">
      {ALU_CONTROLS.map(control => {
        const error = errors[control]
        const binary = values[control].toString(2).padStart(widths[control], '0')
        return <label key={control} className="alu-numeric-field">
          <span>{labels[control]}</span>
          <input id={`${id}-${control}`} type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="off"
            value={drafts[control]} disabled={disabled} aria-invalid={!!error}
            aria-describedby={`${id}-${control}-hint${error ? ` ${id}-${control}-error` : ''}`}
            onFocus={() => { focused.current = control }}
            onBlur={() => { focused.current = null; if (!error) setDrafts(previous => ({ ...previous, [control]: String(values[control]) })) }}
            onChange={event => edit(control, event.target.value)} />
          <span id={`${id}-${control}-hint`} className="alu-numeric-hint">
            0–{ALU_CONTROL_LIMITS[control]} · 二进制 {binary}
          </span>
          {error && <span id={`${id}-${control}-error`} className="alu-field-error" role="alert">{error}</span>}
        </label>
      })}
    </div>
  </section>
}
