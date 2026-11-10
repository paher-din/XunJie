import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from 'react'
import { Toaster as Sonner, toast, type ToasterProps } from 'sonner'
import { Icon } from '../icons'
import './sonner.css'

export { toast }
export type ToastKind = 'error' | 'success' | 'info' | 'warning'

/** Mount once at the application root; colors follow the host's theme tokens. */
export function Toaster(props: ToasterProps) {
  return <Sonner position="top-center" offset={24} mobileOffset={16} visibleToasts={3} closeButton
    duration={5000} gap={8} className="xj-toaster" containerAriaLabel="通知" customAriaLabel="通知"
    icons={{ success: <Icon name="check-circle" tone="neutral" size={18} />, info: <Icon name="info-circle" tone="neutral" size={18} />,
      warning: <Icon name="danger-triangle" tone="neutral" size={18} />, error: <Icon name="danger-triangle" tone="neutral" size={18} />,
      close: <Icon name="close" size={12} /> }}
    style={{ '--normal-bg': 'var(--inverse)', '--normal-text': 'var(--on-inverse)',
      '--normal-border': 'var(--inverse)', '--border-radius': '8px' } as CSSProperties}
    toastOptions={{ closeButtonAriaLabel: '关闭通知' }} {...props} />
}

/** Bridge existing operation state without repeating feedback on polling or re-renders. */
export function useToastFeedback(message: string | null | undefined, kind: ToastKind = 'error') {
  const id = useId()
  const previous = useRef<{ message: string; kind: ToastKind } | null>(null)
  useEffect(() => {
    if (!message) {
      if (previous.current) toast.dismiss(id)
      previous.current = null
      return
    }
    if (previous.current?.message === message && previous.current.kind === kind) return
    previous.current = { message, kind }
    toast[kind](message, { id, duration: kind === 'error' ? 8000 : 5000 })
  }, [message, kind, id])
}

/** Compatibility for controlled student surfaces; all rendering is owned by Sonner. */
export function Toast({ children, role = 'status' }: { children: ReactNode; role?: 'status' | 'alert' }) {
  const id = useId()
  const previous = useRef<{ children: ReactNode; role: string } | null>(null)
  useEffect(() => {
    if (!children) { if (previous.current) toast.dismiss(id); previous.current = null; return }
    if (previous.current?.children === children && previous.current.role === role) return
    previous.current = { children, role }
    const options = { id, duration: role === 'alert' ? 8000 : 5000 }
    if (role === 'alert') toast.error(children, options)
    else toast(children, options)
  }, [children, role, id])
  return null
}
