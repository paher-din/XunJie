import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { AccountAvatar, RailHistoryPanel, ShellFrame, SidebarNavigation, SidebarRailNavigation, SidebarToggle, useShellNavigation } from '@xunjie/ui/foundation'
import { Icon } from '../icons'
import { THEME_OPTIONS, useTheme } from '../lib/theme'
import { ThemeMenu } from './ThemeMenu'
import './product-shell.css'

export interface ProductShellProps {
  children: ReactNode
  immersive: boolean
  accountName: string
  onHome: () => void
  onAgent: () => void
  onSettings: () => void
  onProfile: () => void
  active?: 'home' | 'agent' | 'settings'
  avatar?: string | null
  agentHistory?: (close: () => void, visible: boolean) => ReactNode
  archivedCount?: number
  archiveOpen?: boolean
  onArchiveOpenChange?: (open: boolean) => void
}

function ProductThemeButton({ visible, rail = false }: { visible: boolean; rail?: boolean }) {
  const { preference, resolved } = useTheme()
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const label = THEME_OPTIONS.find(option => option.value === preference)?.label ?? '跟随系统'
  const tip = preference === 'system'
    ? `外观 · 跟随系统（当前${resolved === 'dark' ? '深色' : '浅色'}）`
    : `外观 · ${label}`
  const close = useCallback(() => {
    setOpen(false)
    if (visible) triggerRef.current?.focus({ preventScroll: true })
  }, [visible])

  useLayoutEffect(() => { if (!visible) setOpen(false) }, [visible])
  useEffect(() => {
    if (!open || !visible) return
    const outside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, visible])

  return <div className="theme-wrap" ref={wrapRef}>
    <button type="button" ref={triggerRef} className={(rail ? 'railbtn' : 'side-icon') + (open ? ' active' : '')}
      aria-label={tip} data-tip={rail ? undefined : tip} title={tip} aria-haspopup="menu"
      aria-expanded={open && visible} onClick={() => setOpen(value => !value)}>
      <Icon name={resolved === 'light' ? 'sun' : 'moon'} size={16} variant="linear" tone="neutral" />
    </button>
    <div inert={!open || !visible}><ThemeMenu open={open && visible} onClose={close} /></div>
  </div>
}

function ProductAccount({ name, avatar, visible, rail, onProfile, onSettings }: {
  name: string; avatar?: string | null; visible: boolean; rail?: boolean
  onProfile: () => void; onSettings: () => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => { if (!visible) setOpen(false) }, [visible])
  useEffect(() => {
    if (!open || !visible) return
    const items = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
    items()[0]?.focus()
    const outside = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        setOpen(false)
        triggerRef.current?.focus({ preventScroll: true })
      } else if (event.key === 'Tab') {
        setOpen(false)
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const list = items()
        const index = list.indexOf(document.activeElement as HTMLButtonElement)
        list[(index + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus()
      }
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', keydown)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', keydown)
    }
  }, [open, visible])

  const accountAvatar = <AccountAvatar name={name} avatar={avatar} />
  const choose = (action: () => void) => { setOpen(false); triggerRef.current?.focus({ preventScroll: true }); action() }
  return <div className={rail ? 'rail-account' : 'account-wrap'} ref={wrapRef}>
    <button type="button" ref={triggerRef} className={rail ? 'railbtn r-account' + (open ? ' open' : '') : 'account-pill' + (open ? ' open' : '')}
      aria-label={rail ? '账户菜单' : undefined} title={name} aria-haspopup="menu" aria-expanded={open && visible}
      onClick={() => setOpen(value => !value)}>
      {accountAvatar}{!rail && <><span className="account-name">{name}</span><Icon name="sort-vertical" size={14} className="account-chev" /></>}
    </button>
    <div ref={menuRef} className={'account-menu am-' + (rail ? 'rail' : 'pill') + (open && visible ? ' on' : '')}
      role="menu" aria-label="账户" aria-hidden={!open || !visible} inert={!open || !visible}>
      <div className="am-head">{accountAvatar}<span className="am-who"><span className="am-name">{name}</span></span></div>
      <div className="am-sep" />
      <button type="button" className="account-menu-item" role="menuitem" onClick={() => choose(onProfile)}>
        <Icon name="user-rounded" size={16} /><span className="am-label">个人资料</span><Icon name="alt-arrow-right" size={14} className="am-chev" />
      </button>
      <button type="button" className="account-menu-item" role="menuitem" onClick={() => choose(onSettings)}>
        <Icon name="settings" size={16} /><span className="am-label">设置</span>
      </button>
    </div>
  </div>
}

/** Product presentation consumes real data and callbacks; it owns no business services or routing. */
export function ProductShell({ children, immersive, accountName, avatar, onHome, onAgent, onSettings, onProfile, active,
  agentHistory, archivedCount = 0, archiveOpen = false, onArchiveOpenChange }: ProductShellProps) {
  const { collapsed, toggle, setCollapsed } = useShellNavigation()
  const toggleRef = useRef<HTMLButtonElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const railPanelRef = useRef<HTMLDivElement>(null)
  const railTriggerRef = useRef<HTMLButtonElement | null>(null)
  const [railPanel, setRailPanel] = useState<'history' | 'search' | null>(null)
  const railVisible = collapsed && !immersive
  const railPanelVisible = railVisible && active === 'agent' && railPanel !== null
  const closeRailPanel = useCallback(() => {
    setRailPanel(null)
    const trigger = railTriggerRef.current
    if (trigger?.isConnected && !trigger.closest('[inert]')) trigger.focus({ preventScroll: true })
  }, [])

  useLayoutEffect(() => {
    const focused = document.activeElement
    if (!focused?.closest('[inert]') || !mainRef.current?.parentElement?.contains(focused)) return
    if (immersive) {
      const main = mainRef.current
      if (main) { main.tabIndex = -1; main.focus({ preventScroll: true }) }
    } else toggleRef.current?.focus({ preventScroll: true })
  }, [collapsed, immersive, railPanelVisible])

  useEffect(() => { if (!railVisible || active !== 'agent') setRailPanel(null) }, [railVisible, active])
  useEffect(() => {
    if (!railPanelVisible) return
    const target = archiveOpen ? railPanelRef.current?.querySelector<HTMLElement>('button')
      : railPanelRef.current?.querySelector<HTMLElement>('input[aria-label="搜索对话"]')
    target?.focus({ preventScroll: true })
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); closeRailPanel() } }
    document.addEventListener('keydown', escape)
    return () => document.removeEventListener('keydown', escape)
  }, [railPanelVisible, railPanel, archiveOpen, closeRailPanel])

  return <ShellFrame className="product-shell" collapsed={collapsed} onCollapsedChange={setCollapsed} immersive={immersive} mainRef={mainRef}
    navigation={<SidebarNavigation onHome={active === 'home'} onAgent={active === 'agent'} history={agentHistory?.(() => {}, !collapsed && !immersive && active === 'agent')} openHome={onHome} openAgent={onAgent} />}
    bottom={<div className="side-bottom">
      <ProductAccount name={accountName} avatar={avatar} visible={!collapsed && !immersive} onProfile={onProfile} onSettings={onSettings} />
      <button type="button" className={'side-icon' + (active === 'settings' ? ' active' : '')} data-tip="设置与帮助" aria-label="设置与帮助" onClick={onSettings}><Icon name="settings" size={16} /></button>
      <ProductThemeButton visible={!collapsed && !immersive} />
    </div>}
    toggle={<SidebarToggle collapsed={collapsed} buttonRef={toggleRef} onToggle={toggle} />}
    rail={<>
      <nav aria-label="主导航">
        <SidebarRailNavigation onHome={active === 'home'} onAgent={active === 'agent'} panel={railPanel}
          archivedCount={archivedCount} archiveOpen={archiveOpen} showEmptyArchive
          openHome={() => { setRailPanel(null); onHome() }}
          openAgent={anchor => {
            if (active !== 'agent') { setRailPanel(null); onAgent(); return }
            if (railPanel) closeRailPanel()
            else { railTriggerRef.current = anchor; onArchiveOpenChange?.(false); setRailPanel('history') }
          }}
          newConversation={() => { setRailPanel(null); onArchiveOpenChange?.(false); onAgent() }}
          toggleArchive={anchor => {
            railTriggerRef.current = anchor
            if (archiveOpen && railPanel === 'history') { onArchiveOpenChange?.(false); closeRailPanel() }
            else { onArchiveOpenChange?.(true); setRailPanel('history') }
          }}
          toggleSearch={anchor => {
            railTriggerRef.current = anchor
            if (railPanel === 'search') closeRailPanel()
            else { onArchiveOpenChange?.(false); setRailPanel('search') }
          }} />
      </nav>
      <div className="product-rail-bottom">
        <ProductThemeButton visible={railVisible} rail />
        <ProductAccount name={accountName} avatar={avatar} visible={railVisible} rail onProfile={onProfile} onSettings={onSettings} />
      </div>
    </>}
    overlays={<RailHistoryPanel visible={railPanelVisible} panelRef={railPanelRef} onClose={closeRailPanel}>
      {agentHistory?.(closeRailPanel, railPanelVisible)}
    </RailHistoryPanel>}>{children}</ShellFrame>
}

export default ProductShell
