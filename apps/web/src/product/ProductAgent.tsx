import { useRef } from 'react'
import { AgentEmptyState, ChatComposerDock, PromptInput } from '@xunjie/ui/chat'
import type { ModelSelectionController } from './ModelSelection'
import { useAgentModelPicker, AgentModelFeedback } from './AgentModelPicker'
import type { PendingActivityRequest } from './first-question'
import './product-agent.css'

/** The first message starts an activity; subsequent messages use its protected workspace. */
export function ProductAgent({ question, onQuestion, onSend, pending, onRetry, onDiscard,
  onSettings, selection, busy, readOnly, error }: {
  question: string; onQuestion(value: string): void; onSend(): void
  pending: PendingActivityRequest | null; onRetry(): void; onDiscard(): void
  onSettings(): void; selection: ModelSelectionController; busy: boolean; readOnly: boolean; error: string
}) {
  const anchor = useRef<HTMLDivElement>(null)
  const picker = useAgentModelPicker(selection)

  return <div className="agent-layout product-agent">
    <div className="product-agent-body">
      <AgentEmptyState title="今天想探讨什么？" />
    </div>
    <div className="product-agent-notices">
      {pending && <div className="product-agent-pending" role="status">
        <p>上次发起的学习尚未确认，原内容已保留。</p>
        <button type="button" className="outline" disabled={busy} onClick={onRetry}>核对并继续原请求</button>
        <button type="button" className="outline" disabled={busy} onClick={onDiscard}>放弃这次请求</button>
      </div>}
      {error && <p className="learning-error" role="alert">{error}</p>}
      {readOnly && <p role="status">当前学习空间只读，无法开始新对话。</p>}
      {!picker.models.length && !readOnly && !selection.stale && <p>尚未配置模型。<button type="button" className="product-agent-settings-link" onClick={onSettings}>打开设置</button></p>}
    </div>
    <ChatComposerDock anchorRef={anchor} atBottom
      suggestions={{ items: [], show: false, onPick: () => {} }}
      followUps={{ items: [], show: false, onPick: () => {}, label: '' }}
      onBackToBottom={() => {}}
      input={<PromptInput value={question} onChange={value => onQuestion(value.slice(0, 10000))} autoFocus
        onSend={onSend} canSend={!!question.trim() && !busy && !pending && !readOnly && !picker.blocked}
        submitting={busy || !!pending || readOnly} attachments={[]} showAttachments={false}
        onAddFiles={() => {}} onRemoveAttachment={() => {}} attachmentTitle=""
        model={picker.model} models={picker.models} modelDisabled={busy || readOnly || picker.busy || picker.stale || !picker.models.length}
        onModelChange={picker.change}
        effort="" efforts={[]} onEffortChange={() => {}} showEffort={false}
        contextIndicator={<AgentModelFeedback controller={picker} />} />}
      disclaimer="从问题开始，你的学习对话会保存在当前空间" />
  </div>
}
