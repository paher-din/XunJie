import { useId } from 'react'
import { formatModelTokenCount, modelCapacityDefaults, modelTokenCountError } from '@xunjie/contracts/model-connections'
import { Field, TextInput, Toggle } from './controls'
import { Icon } from '../icons'
import { ModelIdInput, SettingsSelect, type SettingsChoice } from './SettingsSelect'
import './connection-model-fields.css'

export const reasoningEffortLabels: Record<string, string> = {
  auto: '模型默认', none: '关闭思考', enabled: '开启思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高',
}
const levels = ['none', 'enabled', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Model controls shared by real settings and the catalogue; the caller owns metadata and persistence. */
export function ConnectionModelFields({ modelId, effort, efforts, manualLevels, source, contextWindow, maxOutputTokens,
  referenceContext, referenceOutput, idLabel = '模型 ID', error, onId, onEffort, onLevels, onCapacity, models, modelsLoading, onOpenModels, showModelId = true,
  imageInput, onImageInput }: {
  modelId: string; effort: string; efforts: readonly string[]; manualLevels?: readonly string[] | undefined
  source: 'catalogue' | 'manual' | 'profile' | 'unknown'; contextWindow?: string | number | undefined; maxOutputTokens?: string | number | undefined
  referenceContext?: number | undefined; referenceOutput?: number | undefined; idLabel?: string; error?: string | undefined
  models?: readonly SettingsChoice[] | undefined; modelsLoading?: boolean | undefined; onOpenModels?(): void
  showModelId?: boolean
  imageInput?: boolean; onImageInput?(value: boolean): void
  onId(value: string): void; onEffort(value: string): void; onLevels(value: string[] | undefined): void
  onCapacity(patch: { contextWindow?: string | undefined; maxOutputTokens?: string | undefined }): void
}) {
  const options = efforts.includes(effort) ? efforts : [...efforts, effort]
  const capacityId = useId()
  const contextValue = contextWindow ?? formatModelTokenCount(referenceContext ?? modelCapacityDefaults.contextWindow)
  const outputValue = maxOutputTokens ?? formatModelTokenCount(referenceOutput ?? modelCapacityDefaults.maxOutputTokens)
  const contextError = modelTokenCountError(contextValue), outputError = modelTokenCountError(outputValue)
  return <>
    {showModelId && <Field label="模型 ID">{models ? <ModelIdInput label={idLabel} value={modelId} options={models} onChange={onId}
      loading={modelsLoading} onOpen={onOpenModels} /> : <TextInput aria-label={idLabel} className="st-mono-input" value={modelId}
      placeholder="填写供应商提供的模型 ID" onChange={event => onId(event.target.value)} />}</Field>}
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
    {onImageInput && <div className="st-field">
      <span className="st-field-label">模型能力</span>
      <div className="st-checks" role="group" aria-label={`${idLabel}的模型能力`}>
        <span className="st-check checked locked" aria-label="文本，始终启用"><Icon name="check" size={13} />文本<Icon name="lock-keyhole" size={12} /></span>
        <button type="button" className={'st-check' + (imageInput ? ' checked' : '')} aria-pressed={imageInput === true}
          aria-label={`${idLabel}的图片理解`} title="允许此模型接收图片，包括截图和 PDF 页面图"
          onClick={() => onImageInput(!imageInput)}>{imageInput && <Icon name="check" size={13} />}图片</button>
      </div>
    </div>}
    <Field label="默认思考强度" error={error} errorId={`${capacityId}-reasoning`} tip="模型默认由供应商决定；可选项来自模型资料或手动配置，实际支持情况以供应商为准">
      <SettingsSelect label={`${idLabel}的默认思考强度`} value={effort} onChange={onEffort} aria-invalid={Boolean(error)}
        aria-describedby={error ? `${capacityId}-reasoning` : undefined}
        options={options.map(value => ({ value, label: (reasoningEffortLabels[value] ?? value) + (!['auto', 'none', 'enabled'].includes(value) ? ` · ${value}` : '') }))} />
    </Field>
    <div className="st-field st-reasoning-levels">
      <span className="st-field-label">思考档位</span>
      {manualLevels === undefined && source === 'unknown' && <p className="detail">尚无此型号的思考档位资料，可按供应商文档手动配置。</p>}
      <div className="st-reasoning-manual"><label htmlFor={`${capacityId}-manual`}>手动配置</label><Toggle id={`${capacityId}-manual`} checked={manualLevels !== undefined} label={`${idLabel}的手动配置`}
        onChange={checked => onLevels(checked ? efforts.filter(value => value !== 'auto') : undefined)} /></div>
      {manualLevels !== undefined ? <div className="st-checks" role="group" aria-label={`${idLabel}的可用思考档位`}>
        {levels.map(level => <button type="button" key={level} className={'st-check' + (manualLevels.includes(level) ? ' checked' : '')}
          aria-pressed={manualLevels.includes(level)} onClick={() => onLevels(manualLevels.includes(level)
            ? manualLevels.filter(value => value !== level) : levels.filter(value => value === level || manualLevels.includes(value)))}>
          {reasoningEffortLabels[level]} · {level}
        </button>)}
      </div> : null}
    </div>
  </>
}
