import { useRef, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import type { IconName } from '../icons'
import { SettingsLayout } from '../components/settings/SettingsLayout'
import { AccountTab } from '../components/settings/AccountTab'
import { PortraitTab } from '../components/settings/PortraitTab'
import { AgentTab } from '../components/settings/AgentTab'
import { LegacyModelTab as ModelTab } from '../components/settings/LegacyModelTab'
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
    <SettingsLayout
      tabs={TABS}
      active={active}
      onSelect={(id) => navigate(`/settings/${id}`)}
      version={APP_VERSION}
      toast={toast}
    >
      {active === 'account' && <AccountTab toast={showToast} />}
      {active === 'portrait' && <PortraitTab toast={showToast} />}
      {active === 'agent' && <AgentTab />}
      {active === 'model' && <ModelTab toast={showToast} inlineFeedback />}
      {active === 'privacy' && <PrivacyTab toast={showToast} />}
      {active === 'about' && <AboutTab toast={showToast} />}
    </SettingsLayout>
  )
}

export type TabProps = { toast: (msg: string) => void }
