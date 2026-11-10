import type { ReactNode, RefObject } from 'react'
import { Icon } from '../icons'
import { CompanionButton } from './CompanionButton'
import { AccountAvatar } from './AccountAvatar'
import { AccountMenu, type AccountMenuProps } from './AccountMenu'
import { Composer } from './Composer'
import { ThemeMenu } from './ThemeMenu'
import type { ThemePreference } from './theme'

export interface SidebarNavigationProps {
  onHome: boolean
  onAgent: boolean
  history: ReactNode
  openHome: () => void
  openAgent: () => void
}

export function SidebarNavigation({ onHome, onAgent, history, openHome, openAgent }: SidebarNavigationProps) {
  return <nav className="side-nav">
    <button className={onHome ? 'sidebtn active' : 'sidebtn'} onClick={openHome}>
      <span className="navicon"><Icon name="home-2" size={20} variant={onHome ? 'bold' : 'linear'} /></span>首页
    </button>
    <div className="sideitem"><button className={onAgent ? 'sidebtn active' : 'sidebtn'} onClick={openAgent} aria-expanded={onAgent}>
      <span className="navicon"><Icon name="chat-round-dots" size={20} variant={onAgent ? 'bold' : 'linear'} /></span>Agent 对话
    </button></div>
    <div className={onAgent ? 'agent-sub open' : 'agent-sub'} inert={!onAgent} aria-hidden={!onAgent ? true : undefined}>
      <div className="agent-sub-inner">{history}</div>
    </div>
  </nav>
}

export interface ShellAccount {
  name: string
  avatar?: string | null
  subtitle: string
}
type AccountActions = Pick<AccountMenuProps, 'onProfile' | 'onSettings' | 'onLogout'>
export interface SidebarBottomProps {
  account: ShellAccount
  accountOpen: boolean
  collapsed: boolean
  settingsActive: boolean
  themeOpen: boolean
  themePreference: ThemePreference
  themeResolved: 'light' | 'dark'
  themeTip: string
  accountRef?: RefObject<HTMLDivElement | null>
  themeWrapRef?: RefObject<HTMLDivElement | null>
  themeButtonRef?: RefObject<HTMLButtonElement | null>
  onToggleAccount: () => void
  onOpenSettings: () => void
  onToggleTheme: () => void
  onThemeChange: (preference: ThemePreference) => void
  onThemeClose: () => void
  accountActions: AccountActions
}

export function SidebarBottom({ account, accountOpen, collapsed, settingsActive, themeOpen, themePreference,
  themeResolved, themeTip, accountRef, themeWrapRef, themeButtonRef, onToggleAccount, onOpenSettings,
  onToggleTheme, onThemeChange, onThemeClose, accountActions }: SidebarBottomProps) {
  const avatar = <AccountAvatar name={account.name} avatar={account.avatar} />
  return <div className="side-bottom">
    <div className="account-wrap" ref={accountRef}>
      <button className={'account-pill' + (accountOpen ? ' open' : '')} title={account.subtitle}
        aria-haspopup="menu" aria-expanded={accountOpen} onClick={onToggleAccount}>
        {avatar}<span className="account-name">{account.name}</span><Icon name="sort-vertical" size={14} className="account-chev" />
      </button>
      <AccountMenu open={accountOpen && !collapsed} anchor="pill" name={account.name} subtitle={account.subtitle} avatar={avatar} {...accountActions} />
    </div>
    <button className={'side-icon' + (settingsActive ? ' active' : '')} data-tip="设置与帮助"
      aria-label="设置与帮助" onClick={onOpenSettings}><Icon name="settings" size={16} /></button>
    <div className="theme-wrap" ref={themeWrapRef}>
      <button ref={themeButtonRef} className={'side-icon' + (themeOpen ? ' active' : '')}
        data-tip={themeTip} aria-label={themeTip} aria-haspopup="menu" aria-expanded={themeOpen} onClick={onToggleTheme}>
        <Icon name={themeResolved === 'light' ? 'sun' : 'moon'} size={16} variant="linear" tone="neutral" />
      </button>
      <ThemeMenu open={themeOpen} preference={themePreference} onChange={onThemeChange} onClose={onThemeClose} />
    </div>
  </div>
}

export function SidebarToggle({ collapsed, buttonRef, onToggle }: {
  collapsed: boolean; buttonRef?: RefObject<HTMLButtonElement | null>; onToggle: () => void
}) {
  return <button className="sidebar-toggle" ref={buttonRef} onClick={onToggle} aria-label="切换边栏"
    aria-expanded={!collapsed} title="切换边栏"><Icon name="panel-left-close" size={18} /></button>
}

export interface SidebarRailNavigationProps {
  onHome: boolean
  onAgent: boolean
  panel: 'history' | 'search' | null
  archivedCount: number
  archiveOpen: boolean
  showEmptyArchive?: boolean
  openHome: () => void
  openAgent: (anchor: HTMLButtonElement) => void
  newConversation: () => void
  toggleArchive: (anchor: HTMLButtonElement) => void
  toggleSearch: (anchor: HTMLButtonElement) => void
}

export function SidebarRailNavigation({ onHome, onAgent, panel, archivedCount, archiveOpen, showEmptyArchive = false,
  openHome, openAgent, newConversation, toggleArchive, toggleSearch }: SidebarRailNavigationProps) {
  const showArchive = onAgent && (showEmptyArchive || archivedCount > 0)
  return <>
    <button className={'railbtn r-home' + (onHome ? ' active' : '')} onClick={openHome} title="首页" aria-label="首页">
      <Icon name="home-2" size={20} variant={onHome ? 'bold' : 'linear'} />
    </button>
    <button className={'railbtn r-agent' + (onAgent ? ' active' : '')} onClick={event => openAgent(event.currentTarget)}
      title="Agent 对话" aria-label="Agent 对话" aria-expanded={onAgent ? panel !== null : undefined}>
      <Icon name="chat-round-dots" size={20} variant={onAgent ? 'bold' : 'linear'} />
    </button>
    <button className={'railbtn r-new' + (onAgent ? '' : ' off')} onClick={newConversation} title="新对话" aria-label="新对话"
      aria-hidden={onAgent ? undefined : true} tabIndex={onAgent ? undefined : -1}><Icon name="pen-new-square" size={14} /></button>
    <button className={'railbtn r-archive' + (showArchive ? '' : ' off') + (archiveOpen && panel === 'history' ? ' active' : '')}
      onClick={event => toggleArchive(event.currentTarget)} title="已归档" aria-label="已归档"
      aria-expanded={onAgent && archiveOpen && panel === 'history'} aria-hidden={showArchive ? undefined : true}
      tabIndex={showArchive ? undefined : -1}><Icon name="archive" size={14} /></button>
    <button className={'railbtn r-search' + (onAgent ? '' : ' off')} onClick={event => toggleSearch(event.currentTarget)}
      title="搜索对话" aria-label="搜索对话" aria-hidden={onAgent ? undefined : true} tabIndex={onAgent ? undefined : -1}>
      <Icon name="minimalistic-magnifier" size={14} />
    </button>
  </>
}

export interface SidebarRailProps extends SidebarRailNavigationProps {
  account: ShellAccount
  accountOpen: boolean
  railVisible: boolean
  accountRef?: RefObject<HTMLDivElement | null>
  accountActions: AccountActions
  toggleAccount: () => void
}

export function SidebarRail({ account, accountOpen, railVisible, accountRef, accountActions, toggleAccount,
  ...navigation }: SidebarRailProps) {
  const avatar = <AccountAvatar name={account.name} avatar={account.avatar} />
  return <>
    <SidebarRailNavigation {...navigation} />
    <div className="rail-account" ref={accountRef}>
      <button className={'railbtn r-account' + (accountOpen ? ' open' : '')} onClick={toggleAccount}
        title="账户" aria-label="账户菜单" aria-haspopup="menu" aria-expanded={accountOpen && railVisible}>{avatar}</button>
      <AccountMenu open={accountOpen && railVisible} anchor="rail" name={account.name} subtitle={account.subtitle} avatar={avatar} {...accountActions} />
    </div>
  </>
}

export function RailHistoryPanel({ visible, panelRef, onClose, children }: {
  visible: boolean; panelRef?: RefObject<HTMLDivElement | null>; onClose: () => void; children: ReactNode
}) {
  return <>
    {visible && <div className="railshade" onClick={onClose} />}
    <div className={'railpanel' + (visible ? ' on' : '')} ref={panelRef} inert={!visible} aria-hidden={!visible ? true : undefined}>{children}</div>
  </>
}

export function HomeAssistant({ open, value, onChange, onSend, onToggle, onOpen, onClose }: {
  open: boolean; value: string; onChange: (value: string) => void; onSend: (text: string) => void
  onToggle: () => void; onOpen: () => void; onClose: () => void
}) {
  return <>
    <CompanionButton className="mascot" attention={open} ambient onClick={onToggle}
      aria-label="唤起 Agent 输入框" aria-expanded={open} title="唤起 Agent · ⌘ / Ctrl + J" />
    <Composer open={open} value={value} onChange={onChange} onSend={onSend} onOpen={onOpen} onClose={onClose} />
  </>
}

export { Toast } from '../feedback'
