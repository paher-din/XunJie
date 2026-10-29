import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from '../../icons'
import './WorkspaceToolbar.css'

/** A non-modal disclosure for related workspace controls; business state stays with its caller. */
export function WorkspacePopover({ label, icon, children, closeOnAction = false, attention = false, accessibleLabel }: {
  label: string
  icon?: IconName
  children: ReactNode
  closeOnAction?: boolean
  attention?: boolean
  accessibleLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const id = useId()

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      if (!trigger.current || !panel.current) return
      const anchor = trigger.current.getBoundingClientRect()
      const box = panel.current.getBoundingClientRect()
      setPosition({
        left: Math.max(12, Math.min(anchor.right - box.width, window.innerWidth - box.width - 12)),
        top: Math.max(12, Math.min(anchor.bottom + 8, window.innerHeight - box.height - 12)),
      })
    }
    place()
    const observer = new ResizeObserver(place)
    if (panel.current) observer.observe(panel.current)
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus() }
    }
    const focusOutside = (event: FocusEvent) => {
      if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false)
    }
    panel.current?.querySelector<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)')?.focus()
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    document.addEventListener('focusin', focusOutside)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
      document.removeEventListener('focusin', focusOutside)
    }
  }, [open])

  return <>
    <button type="button" ref={trigger} className={`ws-btn ghost ws-disclosure${attention ? ' needs-attention' : ''}`}
      aria-label={accessibleLabel} aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
      {icon && <Icon name={icon} size={16} />}<span>{label}</span><Icon name="alt-arrow-down" size={12} />
    </button>
    {open && createPortal(<div id={id} ref={panel} className="ws-control-popover" role="region" aria-label={label}
      style={position} onKeyDown={event => {
        if (event.key !== 'Tab' || !panel.current || !trigger.current) return
        const controls = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled)'))
        if (event.shiftKey && event.target === controls[0]) {
          event.preventDefault(); setOpen(false); trigger.current.focus()
        } else if (!event.shiftKey && event.target === controls.at(-1)) {
          const pageControls = Array.from(document.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), input:not(:disabled), a[href], [tabindex="0"]'))
            .filter(element => element.getClientRects().length > 0 && !element.closest('[inert]') && !panel.current?.contains(element))
          const next = pageControls[pageControls.indexOf(trigger.current) + 1] ?? trigger.current
          event.preventDefault(); setOpen(false); next.focus()
        }
      }} onClick={event => {
        if (closeOnAction && (event.target as HTMLElement).closest('button:not(:disabled)')) {
          trigger.current?.focus()
          setOpen(false)
        }
      }}>
      <div className="ws-popover-heading">{label}</div>
      {children}
    </div>, document.body)}
  </>
}
