import { AccountAvatar as AccountAvatarView } from '@xunjie/ui/foundation'
import { useAccount } from '../lib/account'
import { useSession } from './SessionEntry'
import { PREP_BUILD } from '../workspace/mode'
import { displayAccountName } from '../lib/displayNames'

/** 从旧会话读取账户；头像本身由正式组件库负责。 */
export function AccountAvatar({ className = '' }: { className?: string }) {
  const account = useAccount()
  const session = useSession()
  const name = !PREP_BUILD && session.session ? displayAccountName(session.session.userId, session.session.displayName) : account.name
  const avatar = !PREP_BUILD && session.session ? null : account.avatar
  return <AccountAvatarView name={name} avatar={avatar} className={className} />
}
