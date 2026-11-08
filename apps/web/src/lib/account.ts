import { useSettings } from './settings'

export { avatarTone } from '@xunjie/ui/foundation'

/** 账户信息（响应式）：设置页修改昵称 / 头像后，侧栏、账号菜单、个人资料卡即时联动。 */
export function useAccount() {
  const { account } = useSettings()
  return account
}
