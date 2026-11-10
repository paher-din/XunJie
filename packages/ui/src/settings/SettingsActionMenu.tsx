import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import './settings-action-menu.css'

export interface SettingsActionMenuItem {
  id: string
  label: string
  icon?: ReactNode
  disabled?: boolean
  keepOpen?: boolean
  onSelect(): void
}

/** A compact settings action menu; the caller owns the action and its state. */
export function SettingsActionMenu({ label, icon, items, disabled = false, open: controlledOpen, onOpenChange, panel, panelLabel }: {
  label: string; icon?: ReactNode; items: readonly SettingsActionMenuItem[]; disabled?: boolean
  open?: boolean; onOpenChange?(open: boolean): void; panel?: ReactNode; panelLabel?: string
}) {
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const [present, setPresent] = useState(open), [retainedPanel, setRetainedPanel] = useState(panel)
  const visiblePanel = open ? panel : retainedPanel
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next)
    onOpenChange?.(next)
  }
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), menuId = useId()
  const enabledItems = () => Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? [])
  useEffect(() => {
    if (open) { setPresent(true); setRetainedPanel(panel) }
  }, [open, panel])
  useEffect(() => {
    if (open || !present) return
    const timer = window.setTimeout(() => { setPresent(false); setRetainedPanel(undefined) }, 140)
    return () => window.clearTimeout(timer)
  }, [open, present])
  useEffect(() => {
    if (!open) return
    enabledItems()[0]?.focus()
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    const focusOutside = (event: FocusEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false) }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', focusOutside)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', focusOutside) }
  }, [open])
  const keyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return }
    if (panel) return
    if (event.key === 'Tab') { setOpen(false); return }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const buttons = enabledItems(), index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (!buttons.length) return
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
    buttons[next]?.focus()
  }
  return <div className="st-action-menu" ref={root}>
    <button ref={trigger} type="button" className="outline st-action-menu-trigger" disabled={disabled}
      aria-haspopup={panel ? 'dialog' : 'menu'} aria-expanded={open} aria-controls={open ? menuId : undefined} onClick={() => setOpen(!open)}>{icon}{label}</button>
    {(open || present) && <div id={menuId} role={visiblePanel ? 'dialog' : 'menu'} aria-label={visiblePanel ? panelLabel ?? label : label}
      aria-hidden={!open || undefined} inert={!open} data-state={open ? 'open' : 'closed'}
      className={'st-action-menu-popup' + (visiblePanel ? ' st-action-menu-panel' : '')} onKeyDown={keyDown}>
      {visiblePanel ?? items.map((item, index) => <button type="button" role="menuitem" className="st-action-menu-item" key={item.id} disabled={item.disabled}
        style={{ animationDelay: `${Math.min(30 + index * 35, 100)}ms` }}
        onClick={() => { if (!item.keepOpen) setOpen(false); item.onSelect() }}>{item.icon}<span>{item.label}</span></button>)}
    </div>}
  </div>
}
