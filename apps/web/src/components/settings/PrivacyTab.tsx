import { useState } from 'react'
import { learningApi } from '../../bridge/mockAdapter'
import { clearCache, formatBytes, resetLayouts, storageUsageBytes, useSettings } from '../../lib/settings'
import type { TabProps } from '../../pages/SettingsPage'

import { PrivacySettingsView } from '@xunjie/ui/settings'
export { ConfirmAction } from '@xunjie/ui/settings'

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

  return <PrivacySettingsView usage={formatBytes(usage)} exporting={exporting} exportData={exportData}
    onClearCache={() => {
                clearCache()
                setUsage(storageUsageBytes())
                toast('缓存已清除')
              }} onResetLayouts={() => {
                const n = resetLayouts()
                setUsage(storageUsageBytes())
                toast(n > 0 ? `已重置 ${n} 项布局` : '当前已是默认布局')
              }} />
}
