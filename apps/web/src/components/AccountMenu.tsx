import { AccountMenu as AccountMenuView, type AccountAnchor } from '@xunjie/ui/foundation'
import { useAccount } from '../lib/account'
import { AccountAvatar } from './AccountAvatar'
import { useSession } from './SessionEntry'
import { PREP_BUILD } from '../workspace/mode'
import { displayAccountName } from '../lib/displayNames'

export type { AccountAnchor } from '@xunjie/ui/foundation'

/** 旧会话的账户适配器；展示和交互由正式组件库负责。 */
export function AccountMenu({ open, anchor, onProfile, onSettings, onLogout }: {
  open: boolean; anchor: AccountAnchor; onProfile: () => void; onSettings: () => void; onLogout: () => void
}) {
  const account = useAccount()
  const session = useSession()
  const name = !PREP_BUILD && session.session ? displayAccountName(session.session.userId, session.session.displayName) : account.name
  const subtitle = !PREP_BUILD && session.session ? '课程账号 · 学习空间' : '学生 · 本地学习空间'
  return <AccountMenuView open={open} anchor={anchor} name={name} subtitle={subtitle} avatar={<AccountAvatar />}
    onProfile={onProfile} onSettings={onSettings} onLogout={onLogout} />
}
