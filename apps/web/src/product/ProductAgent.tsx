import { useRef } from 'react'
import { AgentEmptyState, ChatComposerDock, PromptInput, type PromptModelOption } from '@xunjie/ui/chat'
import type { ModelSelectionController } from './ModelSelection'
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
  const choices = selection.selection?.options ?? []
  const byId = new Map<string, (typeof choices)[number]>()
  for (const choice of choices) {
    if (!choice.connection.enabled || !choice.connection.hasCredential || choice.connection.adapterState !== 'ready') continue
    const id = `${choice.kind}:${choice.connection.connectionId}`
    const previous = byId.get(id)
    if (!previous || choice.kind === 'personal' && choice.grantId) byId.set(id, choice)
  }
  const available = [...byId.values()]
  const options: PromptModelOption[] = available.map(choice => ({
    id: `${choice.kind}:${choice.connection.connectionId}`,
    name: choice.connection.name,
    note: choice.kind === 'school' ? '学校提供' : '个人连接', icon: 'model',
  }))
  const selected = selection.selection?.selected
  const selectedId = selected ? `${selected.kind}:${selected.connection.connectionId}` : ''
  const model: PromptModelOption = options.find(option => option.id === selectedId)
    ?? { id: selectedId, name: selected?.connection.name ?? '未选用模型', note: '', icon: 'model' }

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
      {!selected && !readOnly && <p>尚未选用模型。<button type="button" className="product-agent-settings-link" onClick={onSettings}>打开设置</button></p>}
    </div>
    <ChatComposerDock anchorRef={anchor} atBottom
      suggestions={{ items: [], show: false, onPick: () => {} }}
      followUps={{ items: [], show: false, onPick: () => {}, label: '' }}
      onBackToBottom={() => {}}
      input={<PromptInput value={question} onChange={value => onQuestion(value.slice(0, 10000))} autoFocus
        onSend={onSend} canSend={!!question.trim() && !busy && !pending && !readOnly}
        submitting={busy || !!pending || readOnly} attachments={[]} showAttachments={false}
        onAddFiles={() => {}} onRemoveAttachment={() => {}} attachmentTitle=""
        model={model} models={options} modelDisabled={busy || readOnly || selection.busy || selection.stale || !options.length}
        onModelChange={id => { const choice = available.find(item => `${item.kind}:${item.connection.connectionId}` === id); if (choice) void selection.choose(choice) }}
        effort="" efforts={[]} onEffortChange={() => {}} showEffort={false}
        status={selection.error ? { role: 'status', text: selection.error } : undefined} />}
      disclaimer="从问题开始，你的学习对话会保存在当前空间" />
  </div>
}
