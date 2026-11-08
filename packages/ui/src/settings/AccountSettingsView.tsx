import type { Dispatch, RefObject, SetStateAction } from 'react'
import { Icon } from '../icons'
import { AccountAvatar, type AccountAvatarProps } from '../foundation/AccountAvatar'
import { Section, Row, Field, TextInput } from './controls'

export interface PasswordFields { current: string; next: string; confirm: string }
export interface AccountSettingsViewProps {
  account: { name: string; avatar: string | null }
  name: string
  setName: (value: string) => void
  nameDirty: boolean
  avatarData: Pick<AccountAvatarProps, 'name' | 'avatar'>
  fileRef: RefObject<HTMLInputElement | null>
  pwd: PasswordFields
  setPwd: Dispatch<SetStateAction<PasswordFields>>
  pwdError: Partial<Record<keyof PasswordFields, string>>
  usage: string
  pickAvatar: (file: File) => void
  submitPwd: () => void
  onSaveName: () => void
  onResetAvatar: () => void
  onChangeBinding: () => void
}

/** Controlled legacy account presentation; file handling, persistence and demo outcomes stay with the caller. */
export function AccountSettingsView({ account, name, setName, nameDirty, avatarData, fileRef, pwd, setPwd, pwdError,
  usage, pickAvatar, submitPwd, onSaveName, onResetAvatar, onChangeBinding }: AccountSettingsViewProps) {
  return (
    <>
      <Section title="个人资料">
        <div className="st-account-id">
          <button type="button" className="st-avatar-btn" onClick={() => fileRef.current?.click()} title="更换头像">
            <AccountAvatar {...avatarData} className="st-avatar" />
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
                    onSaveName()
                  }}
                >
                  保存
                </button>
              </div>
            </Field>
            {account.avatar && (
              <p className="st-mini-note">
                <button type="button" className="st-linkbtn" onClick={() => { onResetAvatar() }}>
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
            <span className="st-mono">{usage}</span>
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
              <button className="outline st-xs" onClick={() => onChangeBinding()}>换绑</button>
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
