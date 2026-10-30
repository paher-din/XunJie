import * as Dialog from '@radix-ui/react-dialog'
import { useNavigate } from 'react-router-dom'
import { Icon, type IconName } from '../icons'
import { useAccount } from '../lib/account'
import { useSettings } from '../lib/settings'
import { AccountAvatar } from './AccountAvatar'

interface ProfileCardProps {
  open: boolean
  onClose: () => void
  /** 动作占位提示（Mock 阶段统一走外壳 toast）。 */
  onAction: (msg: string) => void
}

/** 引导偏好文案 → 图标（新增偏好回退 check-circle）。 */
const PREF_ICONS: Record<string, IconName> = {
  先演示后实践: 'play-circle',
  喜欢类比解释: 'analogy',
  '单次约 60 分钟': 'clock-circle',
}
const IDENT: Array<[string, string]> = [
  ['学号', '2026010817'],
  ['院系', '数字技术学院'],
  ['专业', '计算机科学'],
]
const ACCOUNT: Array<[string, string]> = [
  ['学习空间', '本地学习空间'],
  ['有效期', '2026.09 – 2027.07'],
  ['加入日期', '2026-09-01'],
]
const RECORDS: Array<{ n: string; unit: string; label: [string, string]; icon: IconName }> = [
  { n: '3', unit: '件', label: ['个人项目', '作品'], icon: 'folder-with-files' },
  { n: '2', unit: '条', label: ['教师', '反馈'], icon: 'chat-square-line' },
  { n: '47', unit: '次', label: ['Agent ', '学习问答'], icon: 'chat-round-question-mark' },
]

/** 个人资料：身份侧栏 + 学生画像，作品与交流独立呈现。画像与账户名随设置页实时联动。 */
export function ProfileCard({ open, onClose, onAction }: ProfileCardProps) {
  const navigate = useNavigate()
  const { name } = useAccount()
  const { portrait } = useSettings()
  const go = (path: string) => {
    onClose()
    navigate(path)
  }
  const act = (msg: string) => {
    onClose()
    onAction(msg)
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay pc-overlay" />
        <Dialog.Content className="pcard" aria-describedby={undefined}>
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
                <AccountAvatar />
                <div className="pc-intro">
                  <div className="pc-name-row">
                    <Dialog.Title className="pc-name">{name}</Dialog.Title>
                    <span className="pc-student">学生</span>
                    <span className="pc-term"><Icon name="calendar" size={15} />2026 秋季学期</span>
                  </div>
                  <p className="pc-role">
                    <span>数字技术学院</span><span>计算机科学</span><span>2026 级</span>
                  </p>
                </div>
              </div>
            </header>

            <div className="pc-cols">
              <section className="pc-identity" aria-labelledby="pc-identity-title">
                <h2 className="pc-section-title" id="pc-identity-title">身份信息</h2>
                <dl className="pc-kvs">
                  {IDENT.map(([k, v]) => (
                    <div className="pc-kv" key={k}><dt>{k}</dt><dd>{v}</dd></div>
                  ))}
                </dl>
                <div className="pc-account-head">
                  <h3>学习账户</h3>
                  <span className="pc-local"><i aria-hidden="true" />本机账户</span>
                </div>
                <dl className="pc-kvs pc-account-kvs">
                  {ACCOUNT.map(([k, v]) => (
                    <div className="pc-kv" key={k}><dt>{k}</dt><dd>{v}</dd></div>
                  ))}
                </dl>
              </section>

              <section className="pc-portrait" aria-labelledby="pc-portrait-title">
                <div className="pc-section-head">
                  <h2 className="pc-section-title" id="pc-portrait-title">学生画像</h2>
                  <p className="pc-maint">
                    <Icon name="assistant-mark" size={14} />
                    <span>由教学 Agent 维护</span>
                    <span className="pc-meta-sep" aria-hidden="true">·</span>
                    <time dateTime={portrait.updatedAt}>{Number(portrait.updatedAt.slice(5, 7))} 月 {Number(portrait.updatedAt.slice(8, 10))} 日更新</time>
                  </p>
                </div>
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
              </section>
            </div>

            <section className="pc-records" aria-labelledby="pc-records-title">
              <h2 className="pc-section-title" id="pc-records-title">作品与交流</h2>
              <div className="pc-band">
                {RECORDS.map(({ n, unit, label, icon }) => (
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

          <footer className="pc-foot">
            <button className="pc-danger" onClick={() => act('退出登录将在后续版本提供')}>
              <Icon name="logout-2" size={17} />退出登录
            </button>
            <div className="pc-acts">
              <button className="outline" onClick={() => go('/settings/account')}>
                <Icon name="settings" size={17} />账号设置
              </button>
              <button className="primary" onClick={() => go('/settings/portrait')}>
                <Icon name="pen" size={17} />编辑资料
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
