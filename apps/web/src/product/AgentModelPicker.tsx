import { PromptModelPicker, type PromptModelOption } from '@xunjie/ui/chat'
import { useToastFeedback } from '@xunjie/ui/feedback'
import type { Choice, ModelSelectionController } from './ModelSelection'

export const modelChoiceId = (choice: Choice) => `${choice.kind}:${choice.connection.connectionId}`

export function useAgentModelPicker(selection: ModelSelectionController) {
  const byId = new Map<string, Choice>()
  for (const choice of selection.selection?.options ?? []) {
    if (!choice.connection.enabled || !choice.connection.hasCredential || choice.connection.adapterState !== 'ready') continue
    const previous = byId.get(modelChoiceId(choice))
    if (!previous || previous.kind === 'personal' && previous.grantId && choice.kind === 'personal' && !choice.grantId)
      byId.set(modelChoiceId(choice), choice)
  }
  const choices = [...byId.values()]
  const models: PromptModelOption[] = choices.map(choice => ({ id: modelChoiceId(choice), name: choice.connection.modelId,
    note: choice.kind === 'school' ? '学校' : choice.connection.name, icon: 'model' }))
  const selected = selection.selection?.selected
  const model = models.find(option => option.id === (selected && modelChoiceId(selected)))
    ?? { id: selected ? modelChoiceId(selected) : '', name: selected?.connection.modelId ?? '选择模型', note: '', icon: 'model' as const }
  const change = (id: string) => { const choice = byId.get(id); if (choice) void selection.choose(choice) }
  useToastFeedback(!selection.stale ? selection.error : '')
  return { model, models, change, busy: selection.busy, stale: selection.stale,
    error: selection.error, persistentError: selection.stale ? selection.error : '', notice: '',
    retry: () => { void selection.reload() }, blocked: selection.busy }

}

export type AgentModelPickerController = ReturnType<typeof useAgentModelPicker>
export function AgentModelPicker({ controller, disabled = false, onSettings }: {
  controller: AgentModelPickerController; disabled?: boolean; onSettings?(): void
}) {
  return <div className="product-model-picker">
    <PromptModelPicker model={controller.model} models={controller.models} onChange={controller.change}
      disabled={disabled || controller.busy || controller.stale || !controller.models.length} />
    <AgentModelFeedback controller={controller} />
    {!controller.models.length && !controller.stale && onSettings && <button type="button" className="product-agent-settings-link" onClick={onSettings}>添加模型</button>}
  </div>
}
export function AgentModelFeedback({ controller }: { controller: AgentModelPickerController }) {
  return <>{controller.error ? <span className="product-model-feedback" role={controller.persistentError ? 'alert' : undefined}>{controller.persistentError}
    <button type="button" onClick={controller.retry} disabled={controller.busy}>重试</button></span>
    : null}</>
}
