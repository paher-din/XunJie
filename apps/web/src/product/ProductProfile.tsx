import { useRef } from 'react'
import { AccountAvatar, ProfileCard } from '@xunjie/ui/foundation'
import './product-settings.css'

/** Missing profile facts stay unknown, while the shared profile layout remains familiar. */
export function ProductProfile({ accountName, schoolName, onClose, onSettings }: {
  accountName: string; schoolName?: string; onClose(): void; onSettings(): void
}) {
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  return <ProfileCard open name={accountName} avatar={<AccountAvatar name={accountName} />}
    identity={schoolName ? [['学校', schoolName]] : []} onClose={onClose}
    onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }) }}
    onAccountSettings={onSettings} />
}
