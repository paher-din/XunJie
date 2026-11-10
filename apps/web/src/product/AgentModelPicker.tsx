import { useEffect, useRef, useState } from 'react'
import { PromptModelPicker, type PromptModelOption } from '@xunjie/ui/chat'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { teachingModelSwitchSchema } from '@xunjie/contracts/teaching-agent'
import { learningRequest, workspaceScope } from './learningTransport'
import type { Choice, ModelSelectionController, Selection } from './ModelSelection'

export const modelChoiceId = (choice: Choice) => `${choice.kind}:${choice.connection.connectionId}`

export function useAgentModelPicker(selection: ModelSelectionController, activity?: LearningActivity, spaceKey = '', namespace = '') {
  const scope = activity ? workspaceScope(namespace, activity) : ''
  const current = useRef(scope)
  current.current = scope
  const [switchState, setSwitchState] = useState({ scope, busy: false, error: '', notice: '' })
  const pending = useRef<{ scope: string; requestId: string; selectionVersion: number } | null>(null)
  useEffect(() => { current.current = scope; return () => { if (current.current === scope) current.current = '' } }, [scope])
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
  const switchModel = async (operation: NonNullable<typeof pending.current>) => {
    if (!activity || current.current !== operation.scope) return
    setSwitchState({ scope, busy: true, error: '', notice: '' })
    try {
      const result = teachingModelSwitchSchema.parse(await learningRequest(activity, spaceKey, namespace,
        `agent/${activity.activityId}/model-switches`, { requestId: operation.requestId, selectionVersion: operation.selectionVersion }))
      if (current.current !== operation.scope) return
      if (result.state !== 'completed' && result.reason !== 'segment-busy')
        throw new Error('模型切换未完成，请重试。')
      pending.current = null
      setSwitchState({ scope, busy: false, error: '', notice: result.state === 'completed' ? '' : '当前回答完成后使用新模型。' })
    } catch {
      if (current.current === operation.scope) setSwitchState({ scope, busy: false, error: '模型切换未确认，请重试。', notice: '' })
    }
  }
  const onSelected = async (saved: Selection) => {
    if (!activity || current.current !== scope) return
    pending.current = { scope, requestId: crypto.randomUUID(), selectionVersion: saved.version }
    await switchModel(pending.current)
  }
  const change = (id: string) => {
    const choice = byId.get(id)
    if (choice) void selection.choose(choice, onSelected)
  }
  const own = switchState.scope === scope ? switchState : null
  return { model, models, change, busy: selection.busy || !!own?.busy, stale: selection.stale,
    error: own?.error || selection.error, notice: own?.notice ?? '',
    retry: () => { if (pending.current?.scope === scope) void switchModel(pending.current); else void selection.reload() },
    blocked: selection.busy || !!own?.busy || !!own?.error }
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
  return <>{controller.error ? <span className="product-model-feedback" role="alert">{controller.error}
    <button type="button" onClick={controller.retry} disabled={controller.busy}>重试</button></span>
    : controller.notice ? <span className="product-model-feedback" role="status">{controller.notice}</span> : null}</>
}
