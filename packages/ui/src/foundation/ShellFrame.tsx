import { useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type RefObject } from 'react'
import { XunjieLogo } from '../brand/XunjieLogo'
import { useSidebarResize } from './useSidebarResize'

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
  return { collapsed, toggle: () => setOverride(!collapsed), setCollapsed: setOverride }
}

export interface ShellFrameProps {
  children: ReactNode
  collapsed: boolean
  onCollapsedChange?: (collapsed: boolean) => void
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
  children, collapsed, onCollapsedChange, immersive, navigation, bottom, rail, toggle,
  mainRef, overlays, className = '',
}: ShellFrameProps) {
  const sidebarHidden = collapsed || immersive
  const railVisible = collapsed && !immersive
  const shellRef = useRef<HTMLDivElement>(null)
  const resize = useSidebarResize(shellRef, collapsed, immersive, onCollapsedChange)
  return (
    <div ref={shellRef} style={{ '--sidebar-width': `${resize.width}px`, '--sidebar-edge': `${resize.edge}px`,
      '--sidebar-openness': resize.openness, '--sidebar-min-width': `${resize.minWidth}px` } as CSSProperties}
      data-sidebar-resizable={!!onCollapsedChange || undefined}
      data-sidebar-resizing={resize.resizing || undefined}
      data-sidebar-snapping={resize.snapping || undefined} onTransitionEnd={resize.onTransitionEnd}
      className={('shell' + (immersive ? ' immersive' : '') + (collapsed ? ' collapsed' : '') + ' ' + className).trim()}>
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
      {resize.handle}
      <div className={'rail' + (railVisible ? ' on' : '')} inert={!railVisible} aria-hidden={!railVisible ? true : undefined}>
        {rail}
      </div>
      {overlays}
    </div>
  )
}
