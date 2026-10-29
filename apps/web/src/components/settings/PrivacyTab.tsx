import { useState } from 'react'
import { Icon } from '../../icons'
import { learningApi } from '../../bridge/mockAdapter'
import { clearCache, formatBytes, resetLayouts, storageUsageBytes, useSettings } from '../../lib/settings'
import { Section, Row } from './controls'
import type { TabProps } from '../../pages/SettingsPage'

/** 二次确认的通用小组件：点「执行」→ 就地确认 → 执行并 toast。 */
function ConfirmAction({
  label, icon, confirmText, onRun, danger,
}: {
  label: string
  icon: React.ReactNode
  confirmText: string
  onRun: () => void
  danger?: boolean
}) {
  const [confirming, setConfirming] = useState(false)
  if (confirming) {
    return (
      <span className="st-cf-inline">
        {confirmText}
        <button className={danger ? 'st-cf-yes' : 'st-cf-yes primary-yes'} onClick={() => { setConfirming(false); onRun() }}>确认</button>
        <button className="st-cf-no" onClick={() => setConfirming(false)}>取消</button>
      </span>
    )
  }
  return (
    <button className={'outline st-xs' + (danger ? ' danger' : '')} onClick={() => setConfirming(true)}>
      {icon}{label}
    </button>
  )
}

/**
 * 数据与隐私：学习过程记录归课程管理（学生无删除权，CONTEXT.md 教师主导原则）；
 * 导出 / 清缓存 / 重置布局真实生效。
 */
export function PrivacyTab({ toast }: TabProps) {
  const settings = useSettings()
  const [usage, setUsage] = useState(() => storageUsageBytes())
  const [exporting, setExporting] = useState(false)

  const exportData = async () => {
    setExporting(true)
    // 真实导出：设置（API Key 脱敏）+ 会话摘要 + 本地布局快照
    const conversations = await learningApi.listConversations()
    const payload = {
      exportedAt: new Date().toISOString(),
      product: '循阶 · 本地学习空间',
      account: { name: settings.account.name },
      agentPersonalization: settings.agent,
      portrait: settings.portrait,
      providers: settings.providers.map((p) => ({
        ...p,
        apiKey: p.apiKey ? `${p.apiKey.slice(0, 6)}…（已脱敏）` : '',
      })),
      conversations,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `循阶数据导出-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
    setExporting(false)
    toast('数据已导出为 JSON 文件')
  }

  return (
    <>
      <Section title="学习过程记录">
        <div className="st-panel st-records-note">
          <Icon name="clipboard-text" size={18} tone="neutral" />
          <p>
            学习过程记录由教学团队统一归档管理。为保障学情分析与教学评价的完整性，个人无法直接清除历史过程数据；如有勘误需求请联系任课教师。你可随时导出个人数据副本。
          </p>
        </div>
        <div className="st-panel">
          <Row label="导出我的数据" hint="包含画像、配置与对话摘要（敏感凭据已脱敏）">
            <button className="outline st-xs" disabled={exporting} onClick={exportData}>
              <Icon name="download-minimalistic" size={14} />
              {exporting ? '正在导出…' : '导出 JSON'}
            </button>
          </Row>
        </div>
      </Section>

      <Section title="本地数据">
        <div className="st-panel">
          <Row label="本地存储占用">
            <span className="st-mono">{formatBytes(usage)}</span>
          </Row>
          <Row label="清除缓存" hint="不影响个人设置与模型配置">
            <ConfirmAction
              label="清除缓存"
              icon={<Icon name="trash-bin-trash" size={13} />}
              confirmText="确认清除？"
              onRun={() => {
                clearCache()
                setUsage(storageUsageBytes())
                toast('缓存已清除')
              }}
            />
          </Row>
          <Row label="重置看板与工作区布局" hint="恢复为系统默认排布">
            <ConfirmAction
              label="重置布局"
              icon={<Icon name="restart" size={13} />}
              confirmText="确认重置？"
              danger
              onRun={() => {
                const n = resetLayouts()
                setUsage(storageUsageBytes())
                toast(n > 0 ? `已重置 ${n} 项布局` : '当前已是默认布局')
              }}
            />
          </Row>
        </div>
      </Section>
    </>
  )
}
