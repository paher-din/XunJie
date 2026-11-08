import type { CSSProperties, ReactNode } from 'react'
import { Icon } from '../icons'

export type AccountAnchor = 'pill' | 'rail'
export interface AccountMenuProps {
  open: boolean
  anchor: AccountAnchor
  name: string
  subtitle: string
  avatar: ReactNode
  onProfile: () => void
  onSettings: () => void
  onLogout: () => void
}

const delay = (ms: number) => ({ '--d': `${ms}ms` }) as CSSProperties

/** 仅负责菜单展示，账户和会话数据由宿主提供。 */
export function AccountMenu({ open, anchor, name, subtitle, avatar, onProfile, onSettings, onLogout }: AccountMenuProps) {
  return <div className={'account-menu am-' + anchor + (open ? ' on' : '')} role="menu" aria-hidden={!open}>
    <div className="am-head" style={delay(30)}>
      {avatar}
      <span className="am-who"><span className="am-name">{name}</span><span className="am-sub">{subtitle}</span></span>
    </div>
    <div className="am-sep" style={delay(65)} />
    <button className="account-menu-item" role="menuitem" style={delay(95)} onClick={onProfile}>
      <Icon name="user-rounded" size={16} /><span className="am-label">个人资料</span><Icon name="alt-arrow-right" size={14} className="am-chev" />
    </button>
    <button className="account-menu-item" role="menuitem" style={delay(125)} onClick={onSettings}>
      <Icon name="settings" size={16} /><span className="am-label">设置</span>
    </button>
    <div className="am-sep" style={delay(155)} />
    <button className="account-menu-item danger" role="menuitem" style={delay(185)} onClick={onLogout}>
      <Icon name="logout-2" size={16} /><span className="am-label">退出登录</span>
    </button>
  </div>
}
