import type { Dispatch, SetStateAction } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Icon } from '../icons'
import { Field } from './controls'
import { ModelFields } from './ModelFields'
import { ProviderIdentityFields } from './ProviderIdentityFields'
import { emptyProviderModel } from './modelPresentation'
import type { ProviderModel } from './types'

export interface ProviderModelOption {
  id: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
  inputTypes?: ProviderModel['inputTypes']
  reasoningLevels?: string[]
}
export interface ProviderDialogViewProps {
  open: boolean
  onClose: () => void
  provider: { hasKey?: boolean } | null
  preparation: boolean
  name: string
  setName: (value: string) => void
  baseUrl: string
  setBaseUrl: (value: string) => void
  apiKey: string
  setApiKey: (value: string) => void
  clearKey: boolean
  setClearKey: (value: boolean) => void
  saving: boolean
  saveError: string
  models: ProviderModel[]
  setModels: Dispatch<SetStateAction<ProviderModel[]>>
  errors: { name?: string; baseUrl?: string; models?: string }
  testing: boolean
  testResult: { ok: boolean; models?: ProviderModelOption[] } | null
  result: { ok: boolean; text: string } | null
  dirty: boolean
  patchModel: (index: number, patch: Partial<ProviderModel>) => void
  runTest: () => Promise<void>
  submit: () => Promise<void>
}
/** Controlled supplier form; preparation flag and test results are supplied, never inferred or fetched. */
export function ProviderDialogView({ open, onClose, provider, preparation, name, setName, baseUrl, setBaseUrl, apiKey,
  setApiKey, clearKey, setClearKey, saving, saveError, models, setModels, errors, testing, testResult,
  result, dirty, patchModel, runTest, submit }: ProviderDialogViewProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay pc-overlay" />
        <Dialog.Content className="st-dialog" aria-describedby={undefined}>
          <div className="st-dialog-head">
            <Dialog.Title className="st-dialog-title">{provider ? '编辑供应商' : '添加供应商'}</Dialog.Title>
            <Dialog.Close asChild>
              <button className="pc-x" aria-label="关闭"><Icon name="close" size={18} /></button>
            </Dialog.Close>
          </div>
          <div className="st-dialog-body">
            <ProviderIdentityFields name={name} baseUrl={baseUrl} apiKey={apiKey} hasKey={provider?.hasKey}
              errors={errors} onName={setName} onBaseUrl={setBaseUrl} onApiKey={value => { setApiKey(value); setClearKey(false) }} />

            {provider?.hasKey && !preparation && <label><input type="checkbox" checked={clearKey} onChange={e => { setClearKey(e.target.checked); setApiKey('') }} />清除已保存密钥</label>}
            {saveError && <p role="alert">{saveError}</p>}
            <div className="st-field">
              <span className="st-field-label">模型配置</span>
              {models.map((m, i) => (
                <div className="st-model-card" key={i}>
                  <ModelFields
                    model={m}
                    onPatch={(patch) => patchModel(i, patch)}
                    onRemove={() => setModels(models.filter((_, j) => j !== i))}
                  />
                </div>
              ))}
              <div>
                <button type="button" className="outline st-xs" onClick={() => setModels([...models, emptyProviderModel()])}>
                  <Icon name="add" size={14} />添加模型
                </button>
              </div>
              {errors.models && <span className="st-field-error">{errors.models}</span>}
            </div>

            {result && (
              <p className={'st-test-result' + (result.ok ? ' ok' : ' fail')} role="status">
                <Icon name={result.ok ? 'check-circle' : 'danger-triangle'} size={15} />
                {result.text}
              </p>
            )}
            {testResult?.ok && testResult.models && testResult.models.length>0 && (
              <Field label="供应商可用模型" tip="从真实模型列表选择，使用可调用 ID；供应商提供的能力字段会同步填写。">
                <select className="st-input" aria-label="供应商可用模型" value="" onChange={e=>{
                  const found=testResult.models?.find(m=>m.id===e.target.value);if(!found)return;
                  const next={id:found.id,contextWindow:String(found.contextWindow??''),maxOutput:String(found.maxOutputTokens??''),
                    inputTypes:found.inputTypes??[],reasoningLevels:found.reasoningLevels??[]};
                  setModels(current=>current.length===1&&!current[0]?.id?[next]:current.some(m=>m.id===next.id)
                    ?current.map(m=>m.id===next.id?next:m):[...current,next]);
                }}>
                  <option value="">选择并导入模型能力…</option>
                  {testResult.models.map(m=><option key={m.id} value={m.id}>{m.name??m.id} · {m.id}</option>)}
                </select>
              </Field>
            )}
          </div>
          <div className="st-dialog-foot">
            <button type="button" className="outline" disabled={testing || !baseUrl.trim()} onClick={runTest}>
              {testing ? <span className="st-spinner" aria-hidden="true" /> : <Icon name="refresh" size={15} />}
              {testing ? '测试中…' : '连接测试'}
            </button>
            <div className="st-dialog-foot-right">
              <Dialog.Close asChild><button type="button" className="outline">取消</button></Dialog.Close>
              <button type="button" className="primary" disabled={saving || (provider != null && !dirty)} onClick={() => void submit()}>{saving ? '保存中…' : '保存'}</button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
