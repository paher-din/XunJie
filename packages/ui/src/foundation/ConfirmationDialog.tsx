import { useRef, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Button } from './Button'
import { DestructiveButton } from './DestructiveButton'
import { useToastFeedback } from '../feedback'
import './confirmation-dialog.css'

export interface ConfirmationDialogProps {
  open: boolean
  title: string
  description: ReactNode
  confirmLabel: string
  pendingLabel: string
  busy?: boolean
  error?: string
  onClose: () => void
  onConfirm: () => void
  onReturnFocus?: () => void
}

/** A controlled confirmation; the caller owns the operation and its result. */
export function ConfirmationDialog({ open, title, description, confirmLabel, pendingLabel, busy = false, error,
  onClose, onConfirm, onReturnFocus }: ConfirmationDialogProps) {
  const cancel = useRef<HTMLButtonElement>(null)
  const previousFocus = useRef<HTMLElement | null>(null)
  useToastFeedback(open ? error : '')
  return <Dialog.Root open={open} onOpenChange={next => { if (!next && !busy) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="xj-confirm-overlay" />
      <Dialog.Content className="xj-confirm-dialog" aria-busy={busy || undefined}
        onOpenAutoFocus={event => {
          previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
          event.preventDefault(); cancel.current?.focus()
        }}
        onCloseAutoFocus={event => {
          event.preventDefault()
          if (onReturnFocus) onReturnFocus()
          else previousFocus.current?.focus()
        }}
        onEscapeKeyDown={event => { if (busy) event.preventDefault() }}
        onPointerDownOutside={event => { if (busy) event.preventDefault() }}>
        <Dialog.Title className="xj-confirm-title">{title}</Dialog.Title>
        <Dialog.Description className="xj-confirm-description">{description}</Dialog.Description>
        <div className="xj-confirm-actions">
          <Dialog.Close asChild><Button ref={cancel} type="button" variant="outline" disabled={busy}>取消</Button></Dialog.Close>
          <DestructiveButton label={busy ? pendingLabel : confirmLabel} disabled={busy} onClick={onConfirm} />
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
