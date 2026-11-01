import { useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react'
import { XunjieLogo } from '../brand/XunjieLogo'

const NARROW_NAV_QUERY = '(width < 1024px)'
function subscribeNarrowNavigation(notify: () => void) {
  const media = window.matchMedia(NARROW_NAV_QUERY)
  media.addEventListener('change', notify)
  return () => media.removeEventListener('change', notify)
}
const narrowNavigation = () => window.matchMedia(NARROW_NAV_QUERY).matches
const serverNavigation = () => false

/** Explicit choices last for this mounted shell; no persisted navigation preference. */
export function useShellNavigation() {
  const narrow = useSyncExternalStore(subscribeNarrowNavigation, narrowNavigation, serverNavigation)
  const [override, setOverride] = useState<boolean | null>(null)
  const collapsed = override ?? narrow
  return { collapsed, toggle: () => setOverride(!collapsed) }
}

export interface ShellFrameProps {
  children: ReactNode
  collapsed: boolean
  immersive: boolean
  navigation: ReactNode
  bottom: ReactNode
  rail: ReactNode
  toggle: ReactNode
  mainRef?: RefObject<HTMLElement | null>
  overlays?: ReactNode
  className?: string
}

/** Shared presentation only: callers own navigation, identity and page behavior. */
export function ShellFrame({
  children, collapsed, immersive, navigation, bottom, rail, toggle,
  mainRef, overlays, className = '',
}: ShellFrameProps) {
  const sidebarHidden = collapsed || immersive
  const railVisible = collapsed && !immersive
  return (
    <div className={('shell' + (immersive ? ' immersive' : '') + (collapsed ? ' collapsed' : '') + ' ' + className).trim()}>
      <aside className="sidebar" inert={sidebarHidden} aria-hidden={sidebarHidden ? true : undefined}>
        <div className="brand xunjie-brand">
          <XunjieLogo format="horizontal" label="循阶" />
        </div>
        {navigation}
        {bottom}
      </aside>
      <main className="main" ref={mainRef}>
        {children}
      </main>
      {!immersive && toggle}
      <div className={'rail' + (railVisible ? ' on' : '')} inert={!railVisible} aria-hidden={!railVisible ? true : undefined}>
        {rail}
      </div>
      {overlays}
    </div>
  )
}
