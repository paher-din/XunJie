import { useSettings } from './settings'

/** 默认头像色号：按名字取稳定渐变（0-3），自定义头像仅无图时兜底。 */
export function avatarTone(name: string) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h % 4
}

/** 账户信息（响应式）：设置页修改昵称 / 头像后，侧栏、账号菜单、个人资料卡即时联动。 */
export function useAccount() {
  const { account } = useSettings()
  return account
}
