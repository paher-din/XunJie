import { useState } from 'react'
import { emptyProviderModel, modelConfigurationError } from './modelPresentation'
import type { ProviderModel } from './types'
import type { ProviderModelOption } from './ProviderDialogView'
import { ProviderDialogView } from './ProviderDialogView'

export interface ProviderSettingsDialogProps {
  open: boolean
  onClose: () => void
  /** 编辑时传入既有供应商；新建为 null。 */
  provider: ProviderSettingsData | null
  onSave: (p: ProviderSettingsData) => void | Promise<void>
  preparation: boolean
  onTest: (input: ProviderConnectionInput) => Promise<ProviderConnectionResult>
}

/**
 * 自定义供应商表单：名称 / Base URL / API Key / 模型卡（一张卡一个模型，`ModelFields` 全量细项），表单显式保存。
 * 模型能力不必等保存后再去卡片补；已存好的模型在卡片上直接改，不用回到这里。
 */
export function ProviderSettingsDialog({ open, onClose, provider, onSave, preparation, onTest }: ProviderSettingsDialogProps) {
  const [name, setName] = useState(provider?.name ?? '')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? '')
  const [apiKey, setApiKey] = useState('')
  const [clearKey, setClearKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [models, setModels] = useState<ProviderModel[]>(provider ? provider.models : [emptyProviderModel()])
  const [errors, setErrors] = useState<{ name?: string; baseUrl?: string; models?: string }>({})
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<ProviderConnectionResult | null>(null)

  const modelIds = models.map((m) => m.id.trim()).filter(Boolean)

  const dirty = !provider
    || name !== provider.name || baseUrl !== provider.baseUrl || !!apiKey || clearKey
    || JSON.stringify(models) !== JSON.stringify(provider.models)

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    const r = await onTest({ baseUrl, apiKey, ...(provider && baseUrl === provider.baseUrl && !apiKey && !clearKey ? { id: provider.id } : {}) })
    setTestResult(r)
    setTesting(false)
  }

  const patchModel = (index: number, patch: Partial<ProviderModel>) => {
    setErrors((e) => ({ ...e, models: undefined }))
    setModels((ms) => ms.map((m, i) => (i === index ? { ...m, ...patch } : m)))
  }

  const submit = async () => {
    if (saving) return
    const errs: typeof errors = {}
    if (!name.trim()) errs.name = '请填写供应商名称'
    if (!/^https:\/\/.+/.test(baseUrl.trim())) errs.baseUrl = '请填写公网 HTTPS Base URL'
    if (modelIds.length === 0) errs.models = '请至少添加一个模型'
    else if (new Set(modelIds).size !== modelIds.length) errs.models = '模型 ID 不能重复'
    const invalid=models.map(modelConfigurationError).find(Boolean)
    if(invalid)errs.models=invalid
    setErrors(errs)
    if (Object.keys(errs).length > 0) return
    setSaving(true); setSaveError('')
    try { await onSave({
      id: provider?.id ?? `p-${Date.now().toString(36)}`,
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      apiKey: apiKey.trim(), clearKey,
      models: models
        .filter((m) => m.id.trim())
        .map((m) => ({ ...m, id: m.id.trim(), contextWindow: m.contextWindow.trim(), maxOutput: m.maxOutput.trim() })),
    })
    setApiKey(''); onClose()
    } catch { setSaveError('保存未确认，请重试或重新读取配置。') } finally { setSaving(false) }
  }

  const result = testResult

  return <ProviderDialogView open={open} onClose={onClose} provider={provider} preparation={preparation}
    name={name} setName={setName} baseUrl={baseUrl} setBaseUrl={setBaseUrl} apiKey={apiKey} setApiKey={setApiKey}
    clearKey={clearKey} setClearKey={setClearKey} saving={saving} saveError={saveError} models={models} setModels={setModels}
    errors={errors} testing={testing} testResult={testResult} result={result} dirty={dirty}
    patchModel={patchModel} runTest={runTest} submit={submit} />
}

/** Editable form data, not a transport client or persisted model-settings store. */
export interface ProviderSettingsData {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  hasKey?: boolean
  keyHint?: string
  clearKey?: boolean
  models: ProviderModel[]
}
export interface ProviderConnectionInput { baseUrl: string; apiKey: string; id?: string }
export interface ProviderConnectionResult { ok: boolean; text: string; models?: ProviderModelOption[] }
