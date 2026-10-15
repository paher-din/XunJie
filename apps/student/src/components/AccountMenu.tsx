import { Icon } from '../icons'
import type { CSSProperties } from 'react'
import { useAccount } from '../lib/account'
import { AccountAvatar } from './AccountAvatar'
import { useSession } from './SessionEntry'
import { PREP_BUILD } from '../workspace/mode'
import { displayAccountName } from '../lib/displayNames'

/** 菜单挂点：展开态账号胶囊上方（pill）／收起态轨道头像右侧（rail）。 */
export type AccountAnchor = 'pill' | 'rail'

interface AccountMenuProps {
  open: boolean
  anchor: AccountAnchor
  onProfile: () => void
  onSettings: () => void
  onLogout: () => void
}

/** 入场级联（app.css .account-menu.on）：内容自上而下逐行浮入，收起态不播。 */
const delay = (ms: number) => ({ '--d': `${ms}ms` }) as CSSProperties

/**
 * 账号菜单（2026-10-10 改版，形态参考评审图）：身份头（头像 + 姓名 + 空间说明）
 * + 分组菜单项（个人资料 / 设置 ｜ 退出登录）。展开态与收起态共用同一份内容与动效，
 * 只有锚点不同——胶囊上方向上弹、轨道头像右侧弹出，两处头像坐标逐像素对齐。
 */
export function AccountMenu({ open, anchor, onProfile, onSettings, onLogout }: AccountMenuProps) {
  const account = useAccount()
  const session = useSession()
  const name = !PREP_BUILD && session.session ? displayAccountName(session.session.userId) : account.name
  return (
    <div className={'account-menu am-' + anchor + (open ? ' on' : '')} role="menu" aria-hidden={!open}>
      <div className="am-head" style={delay(30)}>
        <AccountAvatar />
        <span className="am-who">
          <span className="am-name">{name}</span>
          <span className="am-sub">{!PREP_BUILD && session.session ? '课程账号 · 学习空间' : '学生 · 本地学习空间'}</span>
        </span>
      </div>
      <div className="am-sep" style={delay(65)} />
      <button className="account-menu-item" role="menuitem" style={delay(95)} onClick={onProfile}>
        <Icon name="user-rounded" size={16} />
        <span className="am-label">个人资料</span>
        <Icon name="alt-arrow-right" size={14} className="am-chev" />
      </button>
      <button className="account-menu-item" role="menuitem" style={delay(125)} onClick={onSettings}>
        <Icon name="settings" size={16} />
        <span className="am-label">设置</span>
      </button>
      <div className="am-sep" style={delay(155)} />
      <button className="account-menu-item danger" role="menuitem" style={delay(185)} onClick={onLogout}>
        <Icon name="logout-2" size={16} />
        <span className="am-label">退出登录</span>
      </button>
    </div>
  )
}
