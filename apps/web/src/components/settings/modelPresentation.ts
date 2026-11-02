import type { ProviderModel } from '../../lib/settings'

/** Presentation references only; never evidence that a configured endpoint supports a capability. */
export function emptyProviderModel(): ProviderModel {
  return { id: '', contextWindow: '', maxOutput: '', inputTypes: [], reasoningLevels: [] }
}
export function smartModelDefaults(id: string) {
  return /^deepseek-(?:flash|v4-pro)$/.test(id)
    ? { contextWindow: '1048576', maxOutput: '393216' } : { contextWindow: '', maxOutput: '' }
}
export function modelConfigurationError(model: ProviderModel): string {
  for (const value of [model.contextWindow, model.maxOutput])
    if (value && (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))) return '上下文和输出上限须为有效正整数。'
  if ((Number(model.maxOutput) || 4096) >= (Number(model.contextWindow) || 16384)) return '最大输出必须小于上下文窗口，才能为输入保留空间。'
  if (model.reasoningLevels.some(level => !['low', 'high', 'max'].includes(level))) return '思考等级仅支持 low、high、max。'
  if (new Set(model.reasoningLevels).size !== model.reasoningLevels.length) return '思考等级不能重复。'
  return ''
}
