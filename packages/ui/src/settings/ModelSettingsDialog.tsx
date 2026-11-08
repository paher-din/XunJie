import type { ProviderModel } from './types'
import { useState } from 'react'
import { emptyProviderModel, modelConfigurationError } from './modelPresentation'
import { ModelDialogView } from './ModelDialogView'

export interface ModelSettingsDialogProps {
  open: boolean
  onClose: () => void
  providerName: string
  /** 编辑时传入既有模型；新增为 null。 */
  model: ProviderModel | null
  /** 同供应商下其他模型的 ID：重名要在弹窗内报错，不能让弹窗关掉后丢掉用户填的细项。 */
  siblings: string[]
  onSave: (m: ProviderModel) => void | Promise<void>
}

/**
 * 单个模型的增改弹窗：表单与供应商弹窗里的模型卡共用 `ModelFields`（完整细项，无折叠区）。
 * 入口在供应商卡片上——不进供应商弹窗也能补模型或改已配好的模型。
 */
export function ModelSettingsDialog({ open, onClose, providerName, model, siblings, onSave }: ModelSettingsDialogProps) {
  const [draft, setDraft] = useState<ProviderModel>(model ?? emptyProviderModel())
  const [idError, setIdError] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    if (saving) return
    const id = draft.id.trim()
    if (!id) {
      setIdError('请填写模型 ID')
      return
    }
    if (siblings.includes(id)) {
      setIdError('该供应商下已有同名模型')
      return
    }
    const invalid=modelConfigurationError(draft)
    if(invalid){setIdError(invalid);return}
    setSaving(true)
    try { await onSave({ ...draft, id, contextWindow: draft.contextWindow.trim(), maxOutput: draft.maxOutput.trim() })
    onClose()
    } catch { setIdError('保存未确认，请重试。') } finally { setSaving(false) }
  }

  return <ModelDialogView open={open} onClose={onClose} providerName={providerName} model={model} draft={draft}
    setDraft={setDraft} idError={idError} setIdError={setIdError} saving={saving} submit={submit} />
}
