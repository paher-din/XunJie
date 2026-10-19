import { useRef, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { IconText, type IconName } from '../icons'
import { AccountTab } from '../components/settings/AccountTab'
import { PortraitTab } from '../components/settings/PortraitTab'
import { AgentTab } from '../components/settings/AgentTab'
import { ModelTab } from '../components/settings/ModelTab'
import { PrivacyTab } from '../components/settings/PrivacyTab'
import { AboutTab, APP_VERSION } from '../components/settings/AboutTab'

/**
 * 设置页（docs/settings-design.md，2026-10-10 已确认）：
 * 左侧竖向导航 + 右侧内容区，六个标签页各有子路由，可直达。
 * 核心设置真实生效并持久化（lib/settings.ts），其余展示性。
 */

export type SettingsTabId = 'account' | 'portrait' | 'agent' | 'model' | 'privacy' | 'about'

const TABS: Array<{ id: SettingsTabId; label: string; icon: IconName }> = [
  { id: 'account', label: '账户', icon: 'user-rounded' },
  { id: 'portrait', label: '学生画像', icon: 'user-id' },
  { id: 'agent', label: 'Agent 个性化', icon: 'assistant-mark' },
  { id: 'model', label: '模型', icon: 'model' },
  { id: 'privacy', label: '数据与隐私', icon: 'shield-check' },
  { id: 'about', label: '关于', icon: 'info-circle' },
]

export default function SettingsPage() {
  const { tab } = useParams()
  const navigate = useNavigate()
  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | undefined>(undefined)

  if (!TABS.some((t) => t.id === tab)) return <Navigate to="/settings/account" replace />
  const active = tab as SettingsTabId

  function showToast(text: string) {
    setToast(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2600)
  }

  return (
    <div className="settings student-settings">
      <aside className="st-nav">
        <h1 className="st-title">设置</h1>
        <nav aria-label="设置导航">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={'st-nav-item' + (t.id === active ? ' active' : '')}
              aria-current={t.id === active ? 'page' : undefined}
              onClick={() => navigate(`/settings/${t.id}`)}
            >
              <IconText name={t.icon} size={17}>{t.label}</IconText>
            </button>
          ))}
        </nav>
        <div className="st-nav-foot">循阶 v{APP_VERSION}</div>
      </aside>
      <div className="st-body">
        <div className="st-body-in" key={active}>
          {active === 'account' && <AccountTab toast={showToast} />}
          {active === 'portrait' && <PortraitTab toast={showToast} />}
          {active === 'agent' && <AgentTab />}
          {active === 'model' && <ModelTab toast={showToast} inlineFeedback />}
          {active === 'privacy' && <PrivacyTab toast={showToast} />}
          {active === 'about' && <AboutTab toast={showToast} />}
        </div>
      </div>
      {toast && (
        <div className="toast" role="status">
          {toast}
        </div>
      )}
    </div>
  )
}

export type TabProps = { toast: (msg: string) => void }
