import type { ModelProvider } from '@xunjie/contracts/model-connections'

const modelIds = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
export const compareModelIds = (left: string, right: string) => modelIds.compare(left, right) || (left < right ? -1 : left > right ? 1 : 0)

export function inIdOrder<T>(items: readonly T[], ids: readonly string[], idOf: (item: T) => string): T[] {
  const remaining = new Map(items.map(item => [idOf(item), item]))
  const ordered: T[] = []
  for (const id of ids) {
    const item = remaining.get(id)
    if (item) { ordered.push(item); remaining.delete(id) }
  }
  return [...ordered, ...remaining.values()]
}

type ProviderPosition = { id: string; enabled: boolean }
type ModelPosition = ProviderPosition & { modelId: string }
export type ModelSettingsOrder = { providers: ProviderPosition[]; models: Record<string, ModelPosition[]> }
const modelPositions = (provider: ModelProvider): ModelPosition[] => provider.models.map(model => ({
  id: model.connectionId, modelId: model.modelId, enabled: model.modelEnabled ?? model.enabled,
}))
const compareModels = (left: ModelPosition, right: ModelPosition) => Number(right.enabled) - Number(left.enabled)
  || compareModelIds(left.modelId, right.modelId) || compareModelIds(left.id, right.id)

/** Capture a visit without modifying the provider's persisted model join order. */
export function captureModelSettingsOrder(providers: readonly ModelProvider[]): ModelSettingsOrder {
  return {
    // The service supplies join/disable chronology within each group.
    providers: providers.map(provider => ({ id: provider.providerId, enabled: provider.enabled }))
      .sort((left, right) => Number(right.enabled) - Number(left.enabled)),
    models: Object.fromEntries(providers.map(provider => [provider.providerId, modelPositions(provider).sort(compareModels)])),
  }
}

/** Existing rows stay put for the visit. Only additions and removals change its layout. */
export function reconcileModelSettingsOrder(previous: ModelSettingsOrder, providers: readonly ModelProvider[]): ModelSettingsOrder {
  const currentIds = new Set(providers.map(provider => provider.providerId))
  const positions = previous.providers.filter(provider => currentIds.has(provider.id))
  for (const provider of providers) if (!positions.some(position => position.id === provider.providerId)) {
    const position = { id: provider.providerId, enabled: provider.enabled }
    const disabled = position.enabled ? positions.findIndex(item => !item.enabled) : -1
    positions.splice(disabled < 0 ? positions.length : disabled, 0, position)
  }
  return { providers: positions, models: Object.fromEntries(providers.map(provider => {
    const incoming = modelPositions(provider), ids = new Set(incoming.map(model => model.id))
    const rows = (previous.models[provider.providerId] ?? []).filter(model => ids.has(model.id))
    for (const model of incoming) if (!rows.some(row => row.id === model.id)) {
      const after = rows.findIndex(row => compareModels(row, model) > 0)
      rows.splice(after < 0 ? rows.length : after, 0, model)
    }
    return [provider.providerId, rows]
  })) }
}

export type ModelChoicePosition = { key: string; modelId: string; candidate: boolean }

/** Checkbox changes preserve positions; newly discovered candidates join the natural-ID order. */
export function reconcileModelChoices(previous: readonly ModelChoicePosition[] | undefined, incoming: readonly ModelChoicePosition[]): ModelChoicePosition[] {
  const byKey = new Map(incoming.map(choice => [choice.key, choice]))
  if (!previous) return [...incoming.filter(choice => !choice.candidate),
    ...incoming.filter(choice => choice.candidate).sort((left, right) => compareModelIds(left.modelId, right.modelId))]
  const rows = previous.filter(choice => byKey.has(choice.key)).map(choice => ({ ...choice, modelId: byKey.get(choice.key)!.modelId }))
  for (const choice of incoming) if (!rows.some(row => row.key === choice.key)) {
    const after = choice.candidate
      ? rows.findIndex(row => row.candidate && compareModelIds(row.modelId, choice.modelId) > 0)
      : rows.findIndex(row => row.candidate)
    rows.splice(after < 0 ? rows.length : after, 0, choice)
  }
  return rows
}
