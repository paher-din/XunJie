import { useId } from 'react'
import { formatModelTokenCount, modelCapacityDefaults, modelTokenCountError } from '@xunjie/contracts/model-connections'
import { Field, TextInput } from './controls'
import { ModelIdInput, type SettingsChoice } from './SettingsSelect'

export const reasoningEffortLabels: Record<string, string> = {
  auto: '模型默认', none: '关闭思考', enabled: '开启思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高',
}
const levels = ['none', 'enabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Model controls shared by real settings and the catalogue; the caller owns metadata and persistence. */
export function ConnectionModelFields({ modelId, effort, efforts, manualLevels, source, contextWindow, maxOutputTokens,
  referenceContext, referenceOutput, idLabel = '模型 ID', error, onId, onEffort, onLevels, onCapacity, models, modelsLoading, onOpenModels, reasoningKind }: {
  modelId: string; effort: string; efforts: readonly string[]; manualLevels?: readonly string[] | undefined
  source: 'catalogue' | 'manual' | 'profile' | 'unknown'; contextWindow?: string | number | undefined; maxOutputTokens?: string | number | undefined
  referenceContext?: number | undefined; referenceOutput?: number | undefined; idLabel?: string; error?: string | undefined
  models?: readonly SettingsChoice[] | undefined; modelsLoading?: boolean | undefined; onOpenModels?(): void
  reasoningKind?: 'effort' | 'toggle' | 'none' | undefined
  onId(value: string): void; onEffort(value: string): void; onLevels(value: string[] | undefined): void
  onCapacity(patch: { contextWindow?: string | undefined; maxOutputTokens?: string | undefined }): void
}) {
  const options = efforts.includes(effort) ? efforts : [...efforts, effort]
  const capacityId = useId()
  const contextValue = contextWindow ?? formatModelTokenCount(referenceContext ?? modelCapacityDefaults.contextWindow)
  const outputValue = maxOutputTokens ?? formatModelTokenCount(referenceOutput ?? modelCapacityDefaults.maxOutputTokens)
  const contextError = modelTokenCountError(contextValue), outputError = modelTokenCountError(outputValue)
  return <>
    <Field label="模型 ID">{models ? <ModelIdInput label={idLabel} value={modelId} options={models} onChange={onId}
      loading={modelsLoading} onOpen={onOpenModels} /> : <TextInput aria-label={idLabel} className="st-mono-input" value={modelId}
      placeholder="填写供应商提供的模型 ID" onChange={event => onId(event.target.value)} />}</Field>
    <Field label={reasoningKind === 'toggle' ? '思考' : '思考强度'} error={error} tip="模型默认由供应商决定；可选项来自模型资料或手动配置，实际支持情况以供应商为准">
      <select className="st-input" aria-label={`${idLabel}的思考强度`} value={effort} onChange={event => onEffort(event.target.value)}>
        {options.map(value => <option key={value} value={value}>{reasoningEffortLabels[value] ?? value}{!['auto', 'none', 'enabled'].includes(value) ? ` · ${value}` : ''}</option>)}
      </select>
    </Field>
    <div className="st-model-cols">
      <Field label="上下文窗口" tip="支持纯数字和 K / M 后缀，不区分大小写。1K = 1024，1M = 1048576。留空时使用模型资料，没有资料则使用 256K。"
        error={contextError} errorId={`${capacityId}-context`}>
        <TextInput aria-label={`${idLabel}的上下文窗口`} className="st-mono-input" type="text" inputMode="text" spellCheck={false}
          aria-invalid={Boolean(contextError)} aria-describedby={contextError ? `${capacityId}-context` : undefined}
          value={contextValue} placeholder={formatModelTokenCount(referenceContext ?? modelCapacityDefaults.contextWindow)}
          onChange={event => onCapacity({ contextWindow: event.target.value })} />
      </Field>
      <Field label="最大输出 token" tip="支持纯数字和 K / M 后缀。留空时使用模型资料，没有资料则使用 64K。"
        error={outputError} errorId={`${capacityId}-output`}>
        <TextInput aria-label={`${idLabel}的最大输出 token`} className="st-mono-input" type="text" inputMode="text" spellCheck={false}
          aria-invalid={Boolean(outputError)} aria-describedby={outputError ? `${capacityId}-output` : undefined}
          value={outputValue} placeholder={formatModelTokenCount(referenceOutput ?? modelCapacityDefaults.maxOutputTokens)}
          onChange={event => onCapacity({ maxOutputTokens: event.target.value })} />
      </Field>
    </div>
    <details className="st-route-options"><summary>模型选项</summary>
      <label className="st-route-manual"><input type="checkbox" checked={manualLevels !== undefined}
        onChange={event => onLevels(event.target.checked ? efforts.filter(value => value !== 'auto') : undefined)} />手动配置思考档位</label>
      {manualLevels !== undefined ? <div className="st-checks" role="group" aria-label={`${idLabel}的可用思考档位`}>
        {levels.map(level => <button type="button" key={level} className={'st-check' + (manualLevels.includes(level) ? ' checked' : '')}
          aria-pressed={manualLevels.includes(level)} onClick={() => onLevels(manualLevels.includes(level)
            ? manualLevels.filter(value => value !== level) : levels.filter(value => value === level || manualLevels.includes(value)))}>
          {reasoningEffortLabels[level]} · {level}
        </button>)}
      </div> : source === 'unknown' && <p className="detail">尚无此型号的思考档位资料，可按供应商文档手动配置。</p>}
    </details>
  </>
}
