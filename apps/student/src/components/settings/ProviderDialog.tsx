import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Icon } from '../../icons'
import { emptyProviderModel, type ModelProvider, type ProviderModel } from '../../lib/settings'
import { testProviderConnection, testResultText, type TestResult } from '../../lib/connectionTest'
import { Field, ModelFields, TextInput } from './controls'

interface ProviderDialogProps {
  open: boolean
  onClose: () => void
  /** 编辑时传入既有供应商；新建为 null。 */
  provider: ModelProvider | null
  onSave: (p: ModelProvider) => void
}

/**
 * 自定义供应商表单：名称 / Base URL / API Key / 模型卡（一张卡一个模型，`ModelFields` 全量细项），表单显式保存。
 * 模型能力不必等保存后再去卡片补；已存好的模型在卡片上直接改，不用回到这里。
 */
export function ProviderDialog({ open, onClose, provider, onSave }: ProviderDialogProps) {
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? '')
  const [models, setModels] = useState<ProviderModel[]>(provider ? provider.models : [emptyProviderModel()])
  const [errors, setErrors] = useState<{ name?: string; baseUrl?: string; models?: string }>({})
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)

  const modelIds = models.map((m) => m.id.trim()).filter(Boolean)

  const dirty = !provider
    || name !== provider.name || baseUrl !== provider.baseUrl || apiKey !== provider.apiKey
    || JSON.stringify(models) !== JSON.stringify(provider.models)

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    const r = await testProviderConnection({ baseUrl, apiKey })
    setTestResult(r)
    setTesting(false)
  }

  const patchModel = (index: number, patch: Partial<ProviderModel>) => {
    setErrors((e) => ({ ...e, models: undefined }))
    setModels((ms) => ms.map((m, i) => (i === index ? { ...m, ...patch } : m)))
  }

  const submit = () => {
    const errs: typeof errors = {}
    if (!name.trim()) errs.name = '请填写供应商名称'
    if (!/^https?:\/\/.+/.test(baseUrl.trim())) errs.baseUrl = '请填写合法的 Base URL（需以 http:// 或 https:// 开头）'
    if (modelIds.length === 0) errs.models = '请至少添加一个模型'
    else if (new Set(modelIds).size !== modelIds.length) errs.models = '模型 ID 不能重复'
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    onSave({
      id: provider?.id ?? `p-${Date.now().toString(36)}`,
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(),
      models: models
        .filter((m) => m.id.trim())
        .map((m) => ({ ...m, id: m.id.trim(), contextWindow: m.contextWindow.trim(), maxOutput: m.maxOutput.trim() })),
    })
    onClose()
  }

  const result = testResult ? testResultText(testResult) : null

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
            <Field label="名称" error={errors.name}>
              <TextInput value={name} placeholder="例如：DeepSeek 官方" onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Base URL" tip="兼容 OpenAI 规范的服务端点，通常以 /v1 结尾" error={errors.baseUrl}>
              <TextInput value={baseUrl} placeholder="https://api.example.com/v1" className="st-mono-input" onChange={(e) => setBaseUrl(e.target.value)} />
            </Field>
            <Field label="API Key" tip="仅保存在本地设备，不上传至云端">
              <TextInput type="password" value={apiKey} placeholder="sk-…" className="st-mono-input" onChange={(e) => setApiKey(e.target.value)} />
            </Field>

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
          </div>
          <div className="st-dialog-foot">
            <button type="button" className="outline" disabled={testing || !baseUrl.trim()} onClick={runTest}>
              {testing ? <span className="st-spinner" aria-hidden="true" /> : <Icon name="refresh" size={15} />}
              {testing ? '测试中…' : '连接测试'}
            </button>
            <div className="st-dialog-foot-right">
              <Dialog.Close asChild><button type="button" className="outline">取消</button></Dialog.Close>
              <button type="button" className="primary" disabled={provider != null && !dirty} onClick={submit}>保存</button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
