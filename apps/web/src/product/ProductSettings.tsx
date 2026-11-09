import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { AccountAvatar } from '@xunjie/ui/foundation'
import { XunjieLogo } from '@xunjie/ui/brand'
import { Icon, IconText, type IconName } from '@xunjie/ui/icons'
import { Section, SettingsEmptyState } from '@xunjie/ui/settings'
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
const descriptions: Record<ProductSettingsTab, string> = {
  account: '查看当前身份，管理你的学习空间。', portrait: '了解当前空间中的学生画像。',
  agent: '调整对话方式，管理 Agent 使用的 Skills。', models: '选择当前空间使用的模型，管理供应商连接。',
  school: '连接学校，在不同学习空间之间切换。', privacy: '了解学习内容的保存与对话整理方式。', about: '面向高校课程的 AI 项目学习空间。',
}

/** Business operations and identity changes remain owned by the caller. */
export function ProductSettings({ identityName, onBack, schoolControls, modelSettings, initialTab = 'account', onTabChange }: ProductSettingsProps) {
  const [active, setActive] = useState<ProductSettingsTab>(initialTab)
  const id = useId()
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => setActive(initialTab), [initialTab])
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0
    if (window.matchMedia?.('(max-width: 760px)').matches) document.getElementById(`${id}-${active}-nav`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  }, [active, id])
  const select = (tab: ProductSettingsTab) => { setActive(tab); onTabChange?.(tab) }

  // SettingsLayout keys its body by the active tab. Reuse its visual structure,
  // keeping these panes mounted so drafts and in-flight operations survive navigation.
  return <div className="settings student-settings product-settings">
    <aside className="st-nav">
      <p className="st-title">设置</p>
      <nav aria-label="设置导航">
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
          <p>{descriptions[active]}</p>
        </header>
        <section id={`${id}-account`} aria-labelledby={`${id}-account-nav`}
          hidden={active !== 'account'} inert={active !== 'account'} className="product-settings-pane">
          <Section title="身份信息">
            <div className="product-settings-identity">
              <AccountAvatar name={identityName} />
              <dl><div><dt>当前身份</dt><dd>{identityName}</dd></div></dl>
            </div>
          </Section>
          <div className="product-settings-links">
            <button type="button" onClick={() => select('school')}><IconText name="link" size={18}>学校连接</IconText><Icon name="alt-arrow-right" size={16} /></button>
            <button type="button" onClick={() => select('models')}><IconText name="model" size={18}>模型设置</IconText><Icon name="alt-arrow-right" size={16} /></button>
          </div>
        </section>
        <section id={`${id}-school`} aria-labelledby={`${id}-school-nav`}
          hidden={active !== 'school'} inert={active !== 'school'} className="product-settings-pane product-settings-school">
          {schoolControls ?? <p className="product-settings-empty">当前没有可用的学校连接操作。</p>}
        </section>
        <section id={`${id}-portrait`} aria-labelledby={`${id}-portrait-nav`} hidden={active !== 'portrait'} inert={active !== 'portrait'}>
          <SettingsEmptyState icon={<Icon name="user-id" size={24} />} title="暂无画像信息" description="当前空间还没有可展示的学生画像。">
            <button type="button" className="outline" onClick={onBack}>返回学习空间</button>
          </SettingsEmptyState>
        </section>
        <section id={`${id}-personal`} aria-labelledby={`${id}-${active === 'agent' ? 'agent' : 'models'}-nav`}
          hidden={active !== 'agent' && active !== 'models'} inert={active !== 'agent' && active !== 'models'}
          data-settings-section={active} className="product-settings-pane product-settings-model">
          {modelSettings ?? <p className="product-settings-empty" role="status">个人设置暂不可用。</p>}
        </section>
        <section id={`${id}-privacy`} aria-labelledby={`${id}-privacy-nav`} hidden={active !== 'privacy'} inert={active !== 'privacy'}>
          <Section title="学习空间"><p className="product-settings-copy">个人空间与学校空间分别保存学习内容。</p>
            <button type="button" className="outline" onClick={() => select('school')}>管理学校连接</button></Section>
          <Section title="对话整理"><dl className="product-settings-facts">
            <div><dt>归档</dt><dd>从对话列表收起，可在归档箱恢复。</dd></div>
            <div><dt>删除对话入口</dt><dd>移除侧栏中的对话入口，学习活动和作品仍保留。</dd></div>
          </dl></Section>
        </section>
        <section id={`${id}-about`} aria-labelledby={`${id}-about-nav`} hidden={active !== 'about'} inert={active !== 'about'}>
          <div className="st-brand"><XunjieLogo format="stacked" className="st-brand-logo" label="循阶" /></div>
        </section>
      </div>
    </div>
  </div>
}
