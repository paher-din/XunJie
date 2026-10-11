import { useRef, useState } from 'react'
import { Icon } from '../../icons'
import { AccountAvatar } from '../AccountAvatar'
import { setAccountAvatar, setAccountName, storageUsageBytes, formatBytes, useSettings } from '../../lib/settings'
import { Section, Row, Field, TextInput } from './controls'
import type { TabProps } from '../../pages/SettingsPage'

/** 账户：头像昵称（真实）+ 学习空间（展示）+ 账号安全（密码表单真实校验、绑定与登录状态展示）。 */
export function AccountTab({ toast }: TabProps) {
  const { account } = useSettings()
  const [name, setName] = useState(account.name)
  const fileRef = useRef<HTMLInputElement>(null)
  const [pwd, setPwd] = useState({ current: '', next: '', confirm: '' })
  const [pwdError, setPwdError] = useState<Partial<Record<'current' | 'next' | 'confirm', string>>>({})
  const nameDirty = name.trim() !== account.name

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

  return (
    <>
      <Section title="个人资料">
        <div className="st-account-id">
          <button type="button" className="st-avatar-btn" onClick={() => fileRef.current?.click()} title="更换头像">
            <AccountAvatar className="st-avatar" />
            <span className="st-avatar-edit"><Icon name="pen" size={12} /></span>
          </button>
          <div className="st-account-fields">
            <Field label="昵称">
              <div className="st-inline">
                <TextInput value={name} maxLength={20} onChange={(e) => setName(e.target.value)} />
                <button
                  className="primary st-save"
                  disabled={!nameDirty || !name.trim()}
                  onClick={() => {
                    setAccountName(name)
                    toast('昵称已更新')
                  }}
                >
                  保存
                </button>
              </div>
            </Field>
            {account.avatar && (
              <p className="st-mini-note">
                <button type="button" className="st-linkbtn" onClick={() => { setAccountAvatar(null); toast('已恢复默认头像') }}>
                  恢复默认头像
                </button>
              </p>
            )}
          </div>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) pickAvatar(f)
            e.target.value = ''
          }}
        />
      </Section>

      <Section title="学习空间">
        <div className="st-panel">
          <Row label="存储位置">
            <span className="st-mono">~/循阶学习空间</span>
          </Row>
          <Row label="空间占用">
            <span className="st-mono">{formatBytes(storageUsageBytes())}</span>
          </Row>
          <Row label="课程学期周期">
            <span className="st-mono">2026.09 – 2027.07</span>
          </Row>
        </div>
      </Section>

      <Section title="账号安全">
        <div className="st-panel">
          <div className="st-subhead"><Icon name="lock-keyhole" size={16} tone="neutral" />修改密码</div>
          <div className="st-form">
            <Field label="当前密码" error={pwdError.current}>
              <TextInput
                type="password"
                value={pwd.current}
                autoComplete="current-password"
                onChange={(e) => setPwd({ ...pwd, current: e.target.value })}
              />
            </Field>
            <Field label="新密码" tip="8 位以上，需包含字母和数字组合" error={pwdError.next}>
              <TextInput
                type="password"
                value={pwd.next}
                autoComplete="new-password"
                onChange={(e) => setPwd({ ...pwd, next: e.target.value })}
              />
            </Field>
            <Field label="确认新密码" error={pwdError.confirm}>
              <TextInput
                type="password"
                value={pwd.confirm}
                autoComplete="new-password"
                onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && submitPwd()}
              />
            </Field>
            <div>
              <button className="primary" disabled={!pwd.current && !pwd.next && !pwd.confirm} onClick={submitPwd}>
                更新密码
              </button>
            </div>
          </div>
        </div>
        <div className="st-panel">
          <Row label="绑定学校账号">
            <span className="st-bound">
              <Icon name="check-circle" size={15} tone="green" />
              <span className="st-mono">robert@stu.edu.cn</span>
              <button className="outline st-xs" onClick={() => toast('当前为演示模式，暂不支持修改绑定账号')}>换绑</button>
            </span>
          </Row>
          <Row label="本机登录状态">
            <span className="st-bound">
              <Icon name="laptop" size={16} tone="neutral" />
              <span>本机设备 · 在线</span>
              <span className="st-online"><i />在线</span>
            </span>
          </Row>
        </div>
      </Section>
    </>
  )
}
