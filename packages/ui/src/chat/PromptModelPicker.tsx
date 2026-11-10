import { useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from '../icons'

export interface PromptModelOption { id: string; name: string; note: string; icon: IconName }

/** Shared model picker; the caller supplies available models and persists selection. */
export function PromptModelPicker({ model, models, onChange, disabled = false, open: controlledOpen, onOpenChange }: {
  model: PromptModelOption; models: readonly PromptModelOption[]; onChange(id: string): void
  disabled?: boolean; open?: boolean; onOpenChange?(open: boolean): void
}) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  const [closing, setClosing] = useState(false)
  const [visible, setVisible] = useState(open)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const setOpen = (value: boolean) => { setLocalOpen(value); onOpenChange?.(value) }
  useEffect(() => {
    if (open && !disabled) { setVisible(true); setClosing(false); return }
    setClosing(true)
    const timer = window.setTimeout(() => { setVisible(false); setClosing(false) }, 140)
    return () => clearTimeout(timer)
  }, [open, disabled])
  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); button.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [open, onOpenChange])
  const choose = (id: string) => { onChange(id); setOpen(false); button.current?.focus() }
  return <div className="prompt-model" ref={root}>
    <button ref={button} type="button" className={open ? 'prompt-model-btn open' : 'prompt-model-btn'}
      aria-label="切换模型" disabled={disabled} aria-expanded={open && !disabled} aria-haspopup="menu" onClick={() => setOpen(!open)}>
      <span className="prompt-model-swap" key={model.id}><Icon className="prompt-model-icon" name={model.icon} />
        <span className="prompt-model-label">{model.name}</span></span>
      <Icon name="alt-arrow-down" size={12} className="caret" />
    </button>
    {visible && <div className={closing ? 'prompt-model-menu closing' : 'prompt-model-menu'} role="menu" aria-label="模型" inert={closing || disabled}>
      {models.map(option => <div key={option.id} role="menuitemradio" aria-checked={option.id === model.id}
        tabIndex={0} className="prompt-model-item" onClick={() => choose(option.id)} onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(option.id) }
        }}>
        <Icon className="mi-icon" name={option.icon} size={20} />
        <span className="mi-copy"><span className="mi-name">{option.name}</span><span className="mi-note">{option.note}</span></span>
        <span className="mi-check">{option.id === model.id && <Icon name="check" size={14} />}</span>
      </div>)}
    </div>}
  </div>
}
