import { useEffect, useId, useState, type ReactNode } from 'react'
import { AccountAvatar } from '@xunjie/ui/foundation'
import { XunjieLogo } from '@xunjie/ui/brand'
import { IconText, type IconName } from '@xunjie/ui/icons'
import { Section } from '@xunjie/ui/settings'
import './product-settings.css'

export type ProductSettingsTab = 'account' | 'portrait' | 'agent' | 'models' | 'school' | 'privacy' | 'about'

export interface ProductSettingsProps {
  identityName: string
  onBack: () => void
  schoolControls: ReactNode
  modelSettings: ReactNode
  /** Initial selection only; use "models" when opening from a learning activity. */
  initialTab?: ProductSettingsTab
  onTabChange?: (tab: ProductSettingsTab) => void
}

const tabs: ReadonlyArray<{ id: ProductSettingsTab; label: string; icon: IconName }> = [
  { id: 'account', label: '账户', icon: 'user-rounded' },
  { id: 'portrait', label: '学生画像', icon: 'user-id' },
  { id: 'agent', label: 'Agent 个性化', icon: 'assistant-mark' },
  { id: 'models', label: '模型', icon: 'model' },
  { id: 'school', label: '学校连接', icon: 'link' },
  { id: 'privacy', label: '数据与隐私', icon: 'shield-check' },
  { id: 'about', label: '关于', icon: 'info-circle' },
]

/** Business operations and identity changes remain owned by the caller. */
export function ProductSettings({ identityName, onBack, schoolControls, modelSettings, initialTab = 'account', onTabChange }: ProductSettingsProps) {
  const [active, setActive] = useState<ProductSettingsTab>(initialTab)
  const id = useId()
  useEffect(() => setActive(initialTab), [initialTab])

  // SettingsLayout keys its body by the active tab. Reuse its visual structure,
  // keeping these panes mounted so drafts and in-flight operations survive navigation.
  return <div className="settings student-settings product-settings">
    <aside className="st-nav">
      <h1 className="st-title">设置</h1>
      <nav aria-label="设置导航">
        {tabs.map(tab => <button key={tab.id} type="button" id={`${id}-${tab.id}-nav`}
          className={active === tab.id ? 'st-nav-item active' : 'st-nav-item'}
          aria-current={active === tab.id ? 'page' : undefined}
          aria-controls={`${id}-${tab.id === 'agent' || tab.id === 'models' ? 'personal' : tab.id}`} onClick={() => { setActive(tab.id); onTabChange?.(tab.id) }}>
          <IconText name={tab.icon} size={17}>{tab.label}</IconText>
        </button>)}
      </nav>
      <button type="button" className="st-nav-item product-settings-back" onClick={onBack}>
        <IconText name="alt-arrow-left" size={17}>返回学习空间</IconText>
      </button>
    </aside>
    <div className="st-body">
      <div className="st-body-in">
        <section id={`${id}-account`} aria-labelledby={`${id}-account-nav`}
          hidden={active !== 'account'} inert={active !== 'account'} className="product-settings-pane">
          <Section title="身份信息">
            <div className="product-settings-identity">
              <AccountAvatar name={identityName} />
              <dl><div><dt>当前身份</dt><dd>{identityName}</dd></div></dl>
            </div>
          </Section>
        </section>
        <section id={`${id}-school`} aria-labelledby={`${id}-school-nav`}
          hidden={active !== 'school'} inert={active !== 'school'} className="product-settings-pane product-settings-school">
          {schoolControls ?? <p className="product-settings-empty">当前没有可用的学校连接操作。</p>}
        </section>
        <section id={`${id}-portrait`} aria-labelledby={`${id}-portrait-nav`} hidden={active !== 'portrait'} inert={active !== 'portrait'}>
          <Section title="学生画像"><div className="st-panel product-settings-empty">暂无画像信息</div></Section>
        </section>
        <section id={`${id}-personal`} aria-labelledby={`${id}-${active === 'agent' ? 'agent' : 'models'}-nav`}
          hidden={active !== 'agent' && active !== 'models'} inert={active !== 'agent' && active !== 'models'}
          data-settings-section={active} className="product-settings-pane product-settings-model">
          {modelSettings ?? <p className="product-settings-empty" role="status">个人设置暂不可用。</p>}
        </section>
        <section id={`${id}-privacy`} aria-labelledby={`${id}-privacy-nav`} hidden={active !== 'privacy'} inert={active !== 'privacy'}>
          <Section title="学习空间"><div className="st-panel product-settings-empty">个人空间与学校空间分别保存学习内容。</div></Section>
        </section>
        <section id={`${id}-about`} aria-labelledby={`${id}-about-nav`} hidden={active !== 'about'} inert={active !== 'about'}>
          <div className="st-brand"><XunjieLogo format="stacked" className="st-brand-logo" label="循阶" />
            <p className="st-brand-slogan">面向高校课程的 AI 项目学习空间</p></div>
        </section>
      </div>
    </div>
  </div>
}
