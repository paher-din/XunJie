import * as Dialog from '@radix-ui/react-dialog'
import { Icon, type IconName } from '../icons'
import type { ReactNode } from 'react'

export interface ProfileCardProps {
  open: boolean
  name: string
  avatar: ReactNode
  roleLabel?: string
  term?: string
  roleDetails?: readonly string[]
  identity?: ReadonlyArray<readonly [string, string]>
  accountFacts?: ReadonlyArray<readonly [string, string]>
  accountLabel?: string
  portrait?: { updatedAt: string; tags: readonly string[]; strengths: readonly string[]; growths: readonly string[]; prefs: readonly string[] } | null
  records?: ReadonlyArray<{ n: string; unit: string; label: readonly [string, string]; icon: IconName }>
  onClose: () => void
  onCloseAutoFocus?: (event: Event) => void
  onLogout?: () => void
  onAccountSettings?: () => void
  onEditProfile?: () => void
}

/** 引导偏好文案 → 图标（新增偏好回退 check-circle）。 */
const PREF_ICONS: Record<string, IconName> = {
  先演示后实践: 'play-circle',
  喜欢类比解释: 'analogy',
  '单次约 60 分钟': 'clock-circle',
}
/** 个人资料：身份侧栏 + 学生画像，作品与交流独立呈现。画像与账户名随设置页实时联动。 */
export function ProfileCard({ open, name, avatar, roleLabel, term, roleDetails = [], identity = [], accountFacts = [],
  accountLabel, portrait, records = [], onClose, onCloseAutoFocus, onLogout, onAccountSettings, onEditProfile }: ProfileCardProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay pc-overlay" />
        <Dialog.Content className="pcard" aria-describedby={undefined} onCloseAutoFocus={onCloseAutoFocus}>
          <div className="pc-toolbar">
            <p className="pc-caption">个人资料</p>
            <Dialog.Close asChild>
              <button className="pc-x" aria-label="关闭个人资料">
                <Icon name="close" size={18} />
              </button>
            </Dialog.Close>
          </div>
          <div className="pc-scroll">
            <header className="pc-head">
              <div className="pc-top">
                {avatar}
                <div className="pc-intro">
                  <div className="pc-name-row">
                    <Dialog.Title className="pc-name">{name}</Dialog.Title>
                    {roleLabel && <span className="pc-student">{roleLabel}</span>}
                    {term && <span className="pc-term"><Icon name="calendar" size={15} />{term}</span>}
                  </div>
                  <p className="pc-role">
                    {roleDetails.map(detail => <span key={detail}>{detail}</span>)}
                  </p>
                </div>
              </div>
            </header>

            <div className="pc-cols">
              <section className="pc-identity" aria-labelledby="pc-identity-title">
                <h2 className="pc-section-title" id="pc-identity-title">身份信息</h2>
                <dl className="pc-kvs">
                  {identity.map(([k, v]) => (
                    <div className="pc-kv" key={k}><dt>{k}</dt><dd>{v}</dd></div>
                  ))}
                </dl>
                {(accountLabel || accountFacts.length > 0) && <><div className="pc-account-head">
                  <h3>学习账户</h3>
                  {accountLabel && <span className="pc-local"><i aria-hidden="true" />{accountLabel}</span>}
                </div>
                <dl className="pc-kvs pc-account-kvs">
                  {accountFacts.map(([k, v]) => (
                    <div className="pc-kv" key={k}><dt>{k}</dt><dd>{v}</dd></div>
                  ))}
                </dl></>}
              </section>

              <section className="pc-portrait" aria-labelledby="pc-portrait-title">
                <div className="pc-section-head">
                  <h2 className="pc-section-title" id="pc-portrait-title">学生画像</h2>
                  {portrait && <p className="pc-maint">
                    <Icon name="assistant-mark" size={14} />
                    <span>由教学 Agent 维护</span>
                    <span className="pc-meta-sep" aria-hidden="true">·</span>
                    <time dateTime={portrait.updatedAt}>{Number(portrait.updatedAt.slice(5, 7))} 月 {Number(portrait.updatedAt.slice(8, 10))} 日更新</time>
                  </p>}
                </div>
                {portrait ? <>
                <div className="pc-tags">
                  {portrait.tags.map((t) => <span className="pc-tag" key={t}>{t}</span>)}
                </div>

                <div className="pc-abilities">
                  <section className="pc-ability pc-strength">
                    <h3><Icon name="star" tone="neutral" size={17} />擅长</h3>
                    <ul>{portrait.strengths.map((s) => <li key={s}>{s}</li>)}</ul>
                  </section>
                  <section className="pc-ability pc-growth">
                    <h3><Icon name="graph-up" tone="neutral" size={17} />待加强</h3>
                    <ul>{portrait.growths.map((g) => <li key={g}>{g}</li>)}</ul>
                  </section>
                </div>

                <div className="pc-guidance">
                  <h3>引导偏好</h3>
                  <div className="pc-prefs">
                    {portrait.prefs.map((text) => (
                      <span className="pc-pref" key={text}>
                        <Icon name={PREF_ICONS[text] ?? 'check-circle'} tone="neutral" size={17} />{text}
                      </span>
                    ))}
                  </div>
                </div>
                </> : <p className="pc-empty">暂无画像信息</p>}
              </section>
            </div>

            <section className="pc-records" aria-labelledby="pc-records-title">
              <h2 className="pc-section-title" id="pc-records-title">作品与交流</h2>
              <div className="pc-band">
                {records.length === 0 ? <p className="pc-empty">暂无作品与交流统计</p> : records.map(({ n, unit, label, icon }) => (
                  <div className="pc-stat" key={label.join('')}>
                    <span className="pc-stat-icon"><Icon name={icon} variant="linear" tone="neutral" size={21} /></span>
                    <div>
                      <p className="pc-stat-value">{n}<span>{unit}</span></p>
                      <p className="pc-stat-label">{label.map((part) => <span key={part}>{part}</span>)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          </div>

          {(onLogout || onAccountSettings || onEditProfile) && <footer className="pc-foot">
            {onLogout && <button className="pc-danger" onClick={onLogout}>
              <Icon name="logout-2" size={17} />退出登录
            </button>}
            <div className="pc-acts">
              {onAccountSettings && <button className="outline" onClick={onAccountSettings}>
                <Icon name="settings" size={17} />账号设置
              </button>}
              {onEditProfile && <button className="primary" onClick={onEditProfile}>
                <Icon name="pen" size={17} />编辑资料
              </button>}
            </div>
          </footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
