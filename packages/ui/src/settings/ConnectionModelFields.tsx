import { Field, TextInput } from './controls'

export const reasoningEffortLabels: Record<string, string> = {
  auto: '模型默认', none: '关闭思考', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高',
}
const levels = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Model controls shared by real settings and the catalogue; the caller owns metadata and persistence. */
export function ConnectionModelFields({ modelId, effort, efforts, manualLevels, source, contextWindow, maxOutputTokens,
  referenceContext, referenceOutput, idLabel = '模型 ID', error, onId, onEffort, onLevels, onCapacity }: {
  modelId: string; effort: string; efforts: readonly string[]; manualLevels?: readonly string[] | undefined
  source: 'catalogue' | 'manual' | 'profile' | 'unknown'; contextWindow?: number | undefined; maxOutputTokens?: number | undefined
  referenceContext?: number | undefined; referenceOutput?: number | undefined; idLabel?: string; error?: string | undefined
  onId(value: string): void; onEffort(value: string): void; onLevels(value: string[] | undefined): void
  onCapacity(patch: { contextWindow?: number | undefined; maxOutputTokens?: number | undefined }): void
}) {
  const options = efforts.includes(effort) ? efforts : [...efforts, effort]
  return <>
    <Field label="模型 ID"><TextInput aria-label={idLabel} className="st-mono-input" value={modelId}
      placeholder="填写供应商提供的模型 ID" onChange={event => onId(event.target.value)} /></Field>
    <Field label="思考强度" error={error} tip="模型默认由供应商决定；可选档位来自模型资料或手动配置，实际支持情况以供应商为准">
      <select className="st-input" aria-label={`${idLabel}的思考强度`} value={effort} onChange={event => onEffort(event.target.value)}>
        {options.map(value => <option key={value} value={value}>{reasoningEffortLabels[value] ?? value}{value !== 'auto' && value !== 'none' ? ` · ${value}` : ''}</option>)}
      </select>
    </Field>
    <details className="st-route-options"><summary>模型选项</summary>
      <div className="st-model-cols">
        <Field label="上下文窗口"><TextInput aria-label={`${idLabel}的上下文窗口`} type="number" min={1} max={10000000}
          value={contextWindow ?? ''} placeholder={referenceContext ? `参考 ${referenceContext}` : '按供应商文档填写'}
          onChange={event => onCapacity({ contextWindow: event.target.value ? Number(event.target.value) : undefined })} /></Field>
        <Field label="最大输出 token"><TextInput aria-label={`${idLabel}的最大输出 token`} type="number" min={1} max={1000000}
          value={maxOutputTokens ?? ''} placeholder={referenceOutput ? `参考 ${referenceOutput}` : '按供应商文档填写'}
          onChange={event => onCapacity({ maxOutputTokens: event.target.value ? Number(event.target.value) : undefined })} /></Field>
      </div>
      {(referenceContext || referenceOutput) && <button type="button" className="outline st-xs" onClick={() => onCapacity({
        ...(referenceContext ? { contextWindow: referenceContext } : {}), ...(referenceOutput ? { maxOutputTokens: referenceOutput } : {}),
      })}>填入参考容量</button>}
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
