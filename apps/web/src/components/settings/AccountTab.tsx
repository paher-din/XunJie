import { useRef, useState } from 'react'
import { useAccount } from '../../lib/account'
import { useSession } from '../SessionEntry'
import { displayAccountName } from '../../lib/displayNames'
import { PREP_BUILD } from '../../workspace/mode'
import { setAccountAvatar, setAccountName, storageUsageBytes, formatBytes, useSettings } from '../../lib/settings'
import { AccountSettingsView } from '@xunjie/ui/settings'
import type { TabProps } from '../../pages/SettingsPage'

/** 账户：头像昵称（真实）+ 学习空间（展示）+ 账号安全（密码表单真实校验、绑定与登录状态展示）。 */
export function AccountTab({ toast }: TabProps) {
  const { account } = useSettings()
  const [name, setName] = useState(account.name)
  const fileRef = useRef<HTMLInputElement>(null)
  const [pwd, setPwd] = useState({ current: '', next: '', confirm: '' })
  const [pwdError, setPwdError] = useState<Partial<Record<'current' | 'next' | 'confirm', string>>>({})
  const nameDirty = name.trim() !== account.name
  const avatarAccount = useAccount()
  const session = useSession()
  const avatarName = !PREP_BUILD && session.session
    ? displayAccountName(session.session.userId, session.session.displayName) : avatarAccount.name
  const avatarImage = !PREP_BUILD && session.session ? null : avatarAccount.avatar

  /** 头像读取并压到 128px 方图（dataURL），避免 localStorage 膨胀。 */
  const pickAvatar = (file: File) => {
    if (!file.type.startsWith('image/')) {
      toast('请选择图片文件')
      return
    }
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      const size = 128
      canvas.width = canvas.height = size
      const ctx = canvas.getContext('2d')!
      const side = Math.min(img.width, img.height)
      ctx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, size, size)
      URL.revokeObjectURL(url)
      setAccountAvatar(canvas.toDataURL('image/png'))
      toast('头像已更新')
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      toast('图片读取失败，请重新选择')
    }
    img.src = url
  }

  const submitPwd = () => {
    const errors: typeof pwdError = {}
    if (!pwd.current) errors.current = '请输入当前密码'
    if (pwd.next.length < 8) errors.next = '密码长度至少为 8 位'
    else if (!/[a-zA-Z]/.test(pwd.next) || !/\d/.test(pwd.next)) errors.next = '需同时包含字母和数字'
    if (pwd.confirm !== pwd.next) errors.confirm = '两次输入的密码不一致'
    setPwdError(errors)
    if (Object.keys(errors).length > 0) return
    // Mock 边界：本地学习空间暂无真实密码体系，校验通过后仅提示成功
    setPwd({ current: '', next: '', confirm: '' })
    toast('密码已更新')
  }

  return <AccountSettingsView account={account} name={name} setName={setName} nameDirty={nameDirty}
    avatarData={{ name: avatarName, avatar: avatarImage }} fileRef={fileRef} pwd={pwd} setPwd={setPwd} pwdError={pwdError}
    usage={formatBytes(storageUsageBytes())} pickAvatar={pickAvatar} submitPwd={submitPwd}
    onSaveName={() => { setAccountName(name); toast('昵称已更新') }}
    onResetAvatar={() => { setAccountAvatar(null); toast('已恢复默认头像') }}
    onChangeBinding={() => toast('当前为演示模式，暂不支持修改绑定账号')} />
}
