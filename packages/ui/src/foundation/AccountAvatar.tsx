/** 与名字稳定对应的旧版渐变，不需要读取账户状态。 */
export function avatarTone(name: string) {
  let hash = 0
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return hash % 4
}

export interface AccountAvatarProps {
  name: string
  avatar?: string | null
  className?: string
}

export function AccountAvatar({ name, avatar, className = '' }: AccountAvatarProps) {
  if (avatar) return <span className={`avatar has-image ${className}`.trim()} aria-hidden="true">
    <img src={avatar} alt="" />
  </span>
  return <span className={`avatar tone-${avatarTone(name)} ${className}`.trim()} aria-hidden="true">
    {name.slice(0, 1).toUpperCase()}
  </span>
}
