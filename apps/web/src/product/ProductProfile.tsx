import { useRef } from 'react'
import { AccountAvatar, ProfileCard } from '@xunjie/ui/foundation'
import './product-settings.css'

/** Missing profile facts stay unknown, while the shared profile layout remains familiar. */
export function ProductProfile({ identityName, spaceKind, onClose, onSettings }: {
  identityName: string; spaceKind?: 'personal' | 'school'; onClose(): void; onSettings(): void
}) {
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const space = spaceKind === 'school' ? '学校空间' : spaceKind === 'personal' ? '个人空间' : undefined
  return <ProfileCard open name={identityName} avatar={<AccountAvatar name={identityName} />}
    roleLabel={space} identity={space ? [['学习空间', space]] : []} onClose={onClose}
    onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true }) }}
    onAccountSettings={onSettings} />
}
