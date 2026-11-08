import { useState } from 'react'
import { updateAgent, useSettings } from '../../lib/settings'
import { AgentSettingsView } from '@xunjie/ui/settings'

/**
 * Agent 个性化 = 「我眼中的 Agent」（CONTEXT.md）：学生直接设定称呼、引导强度、
 * 提示方式与语气，即时生效；右侧实时预览 Agent 说话方式的变化。
 */
export function AgentTab() {
  const { agent, account } = useSettings()
  const [nickname, setNickname] = useState(agent.nickname)
  const nickDirty = nickname.trim() !== agent.nickname


  return <AgentSettingsView agent={agent} account={account} nickname={nickname} setNickname={setNickname}
    nickDirty={nickDirty}
    onAgentChange={updateAgent} />
}
