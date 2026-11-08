import { useState } from 'react'
import { useHref, useLinkClickHandler } from 'react-router-dom'
import { correctPortrait, formatDay, useSettings, type PortraitCorrection } from '../../lib/settings'
import { PortraitSettingsView } from '@xunjie/ui/settings'
import type { TabProps } from '../../pages/SettingsPage'

/**
 * 学生画像 = 「Agent 眼中的我」（CONTEXT.md）：Agent 维护、学生可纠正。
 * 纠正真实生效并记入最近变更列表（docs/settings-design.md 已确认）。
 */
export function PortraitTab({ toast }: TabProps) {
  const { portrait } = useSettings()
  const agentHref = useHref('/settings/agent')
  const onAgentClick = useLinkClickHandler<HTMLAnchorElement>('/settings/agent')
  /** 待二次确认的纠正项（就地确认，与会话删除同款模式）。 */
  const [confirming, setConfirming] = useState<string | null>(null)

  const correct = (c: PortraitCorrection, label: string) => {
    correctPortrait(c)
    setConfirming(null)
    toast(`已校准画像数据：${label}`)
  }


  return <PortraitSettingsView portrait={portrait} confirming={confirming} setConfirming={setConfirming}
    correct={correct} formatDay={formatDay} agentLink={{ href: agentHref, onClick: onAgentClick, 'data-discover': 'true' }} />
}
