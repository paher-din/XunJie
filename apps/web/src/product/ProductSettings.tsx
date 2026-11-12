import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AccountAvatar } from '@xunjie/ui/foundation'
import { XunjieLogo } from '@xunjie/ui/brand'
import { Icon, IconText, type IconName } from '@xunjie/ui/icons'
import { Section, SettingsEmptyState } from '@xunjie/ui/settings'
import './product-settings.css'

export type ProductSettingsTab = 'account' | 'portrait' | 'agent' | 'models' | 'about'

export interface ProductSettingsProps {
  accountName: string
  schoolName?: string
  isLocal?: boolean
  onBack: () => void
  schoolControls: ReactNode
  accountFeedback?: ReactNode
  modelSettings: ReactNode
  /** Initial selection only; use "models" when opening from a learning activity. */
  initialTab?: ProductSettingsTab
  focusSchool?: boolean
  onTabChange?: (tab: ProductSettingsTab) => void
}

const tabs: ReadonlyArray<{ id: ProductSettingsTab; label: string; icon: IconName }> = [
  { id: 'account', label: '账户', icon: 'user-rounded' },
  { id: 'portrait', label: '学生画像', icon: 'user-id' },
  { id: 'agent', label: 'Agent 个性化', icon: 'assistant-mark' },
  { id: 'models', label: '模型', icon: 'model' },
  { id: 'about', label: '关于', icon: 'info-circle' },
]
/** Business operations and identity changes remain owned by the caller. */
export function ProductSettings({ accountName, schoolName, isLocal = false, onBack, schoolControls, accountFeedback, modelSettings, initialTab = 'account', focusSchool = false, onTabChange }: ProductSettingsProps) {
  const [active, setActive] = useState<ProductSettingsTab>(initialTab)
  const [personalVisited, setPersonalVisited] = useState(initialTab === 'agent' || initialTab === 'models')
  const activeTabIndex = Math.max(0, tabs.findIndex(tab => tab.id === active))
  const id = useId()
  const body = useRef<HTMLDivElement>(null)
  const school = useRef<HTMLDivElement>(null)
  useEffect(() => setActive(initialTab), [initialTab])
  useEffect(() => { if (active === 'agent' || active === 'models') setPersonalVisited(true) }, [active])
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0
    if (window.matchMedia?.('(max-width: 760px)').matches) document.getElementById(`${id}-${active}-nav`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [active, id])
  const select = (tab: ProductSettingsTab) => { setActive(tab); onTabChange?.(tab) }
  const revealSchool = () => {
    school.current?.focus({ preventScroll: true })
    school.current?.scrollIntoView?.({ block: 'start' })
  }
  useEffect(() => {
    if (!focusSchool || active !== 'account') return
    const frame = requestAnimationFrame(revealSchool)
    return () => cancelAnimationFrame(frame)
  }, [active, focusSchool])
  // SettingsLayout keys its body by the active tab. Reuse its visual structure,
  // keeping these panes mounted so drafts and in-flight operations survive navigation.
  return <div className="settings student-settings product-settings">
    <aside className="st-nav">
      <p className="st-title">设置</p>
      <nav aria-label="设置导航" style={{ '--product-settings-tab-index': activeTabIndex } as CSSProperties}>
        {tabs.map(tab => <button key={tab.id} type="button" id={`${id}-${tab.id}-nav`}
          className={active === tab.id ? 'st-nav-item active' : 'st-nav-item'}
          aria-current={active === tab.id ? 'page' : undefined}
          aria-controls={`${id}-${tab.id === 'agent' || tab.id === 'models' ? 'personal' : tab.id}`} onClick={() => select(tab.id)}>
          <IconText name={tab.icon} size={17}>{tab.label}</IconText>
        </button>)}
      </nav>
      <button type="button" className="st-nav-item product-settings-back" onClick={onBack}>
        <IconText name="alt-arrow-left" size={17}>返回学习空间</IconText>
      </button>
    </aside>
    <div className="st-body" ref={body}>
      <div className="st-body-in">
        <header className="product-settings-heading" key={active}>
          <h1>{tabs.find(tab => tab.id === active)?.label}</h1>
        </header>
        <section id={`${id}-account`} aria-labelledby={`${id}-account-nav`}
          hidden={active !== 'account'} inert={active !== 'account'} className="product-settings-pane">
          <div className="product-settings-identity">
            <div className="product-settings-current">
              <AccountAvatar name={accountName} />
              <div className="product-settings-account">
                {isLocal ? <><span>本地</span><strong>个人学习空间</strong></> : <><strong>{accountName}</strong>{schoolName && <span>{schoolName}</span>}</>}
              </div>
            </div>
          </div>
          <div className="product-settings-school" ref={school} tabIndex={-1} role="region" aria-label="学校连接">
            {accountFeedback}
            {schoolControls ?? <p className="product-settings-empty" role="status" aria-label="正在读取学校连接" />}
          </div>
        </section>
        <section id={`${id}-portrait`} aria-labelledby={`${id}-portrait-nav`} hidden={active !== 'portrait'} inert={active !== 'portrait'} className="product-settings-pane">
          <SettingsEmptyState icon={<Icon name="user-id" size={24} />} title="暂无画像信息" description="当前空间还没有可展示的学生画像。" />
        </section>
        <section id={`${id}-personal`} aria-labelledby={`${id}-${active === 'agent' ? 'agent' : 'models'}-nav`}
          hidden={active !== 'agent' && active !== 'models'} inert={active !== 'agent' && active !== 'models'}
          data-settings-section={active} className="product-settings-pane product-settings-model">
          {(personalVisited || active === 'agent' || active === 'models') && (modelSettings ?? <p className="product-settings-empty" role="status">个人设置暂不可用。</p>)}
        </section>
        <section id={`${id}-about`} aria-labelledby={`${id}-about-nav`} hidden={active !== 'about'} inert={active !== 'about'} className="product-settings-pane">
          <div className="st-brand"><XunjieLogo format="stacked" className="st-brand-logo" label="循阶" /></div>
          <Section title="数据与隐私">
            <h3 className="product-settings-subheading">对话整理</h3>
            <dl className="product-settings-facts">
              <div><dt>归档</dt><dd>从对话列表收起，可在归档箱恢复。</dd></div>
              <div><dt>删除对话入口</dt><dd>移除侧栏中的对话入口，学习活动和作品仍保留。</dd></div>
            </dl>
          </Section>
          <Section title="项目仓库">
            <a className="product-settings-repository" href="https://github.com/paher-din/XunJie" target="_blank" rel="noreferrer">
              <IconText name="brand-github" size={16}>https://github.com/paher-din/XunJie</IconText>
            </a>
          </Section>
        </section>
      </div>
    </div>
  </div>
}
