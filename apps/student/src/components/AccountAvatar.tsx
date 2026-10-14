import { avatarTone, useAccount } from '../lib/account'
import { useSession } from './SessionEntry'
import { PREP_BUILD } from '../workspace/mode'

/**
 * 账户头像：自定义头像（图片）优先，未设置时为渐变泡泡 + 首字母
 * （渐变按名字哈希取色，2026-10-01 定稿形态）。
 */
export function AccountAvatar({ className = '' }: { className?: string }) {
  const account = useAccount()
  const session = useSession()
  const name = !PREP_BUILD && session.session ? session.session.userId : account.name
  const avatar = !PREP_BUILD && session.session ? null : account.avatar
  if (avatar) {
    return (
      <span className={`avatar has-image ${className}`.trim()} aria-hidden="true">
        <img src={avatar} alt="" />
      </span>
    )
  }
  return (
    <span className={`avatar tone-${avatarTone(name)} ${className}`.trim()} aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}
