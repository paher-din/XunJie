import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Icon } from '../../icons'
import { emptyProviderModel, type ProviderModel } from '../../lib/settings'
import { ModelFields } from './controls'

interface ModelDialogProps {
  open: boolean
  onClose: () => void
  providerName: string
  /** 编辑时传入既有模型；新增为 null。 */
  model: ProviderModel | null
  /** 同供应商下其他模型的 ID：重名要在弹窗内报错，不能让弹窗关掉后丢掉用户填的细项。 */
  siblings: string[]
  onSave: (m: ProviderModel) => void
}

/**
 * 单个模型的增改弹窗：表单与供应商弹窗里的模型卡共用 `ModelFields`（完整细项，无折叠区）。
 * 入口在供应商卡片上——不进供应商弹窗也能补模型或改已配好的模型。
 */
export function ModelDialog({ open, onClose, providerName, model, siblings, onSave }: ModelDialogProps) {
  const [draft, setDraft] = useState<ProviderModel>(model ?? emptyProviderModel())
  const [idError, setIdError] = useState('')

  const submit = () => {
    const id = draft.id.trim()
    if (!id) {
      setIdError('请填写模型 ID')
      return
    }
    if (siblings.includes(id)) {
      setIdError('该供应商下已有同名模型')
      return
    }
    onSave({ ...draft, id, contextWindow: draft.contextWindow.trim(), maxOutput: draft.maxOutput.trim() })
    onClose()
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay pc-overlay" />
        <Dialog.Content className="st-dialog" aria-describedby={undefined}>
          <div className="st-dialog-head">
            <Dialog.Title className="st-dialog-title">{model ? '编辑模型' : '添加模型'}</Dialog.Title>
            <Dialog.Close asChild>
              <button className="pc-x" aria-label="关闭"><Icon name="close" size={18} /></button>
            </Dialog.Close>
          </div>
          <div className="st-dialog-body">
            <p className="st-mini-note st-dlg-target">{model ? '所属：' : '添加到：'}{providerName}</p>
            <ModelFields
              model={draft}
              idError={idError}
              onPatch={(patch) => { setIdError(''); setDraft((d) => ({ ...d, ...patch })) }}
            />
          </div>
          <div className="st-dialog-foot">
            <span />
            <div className="st-dialog-foot-right">
              <Dialog.Close asChild><button type="button" className="outline">取消</button></Dialog.Close>
              <button type="button" className="primary" onClick={submit}>{model ? '保存' : '添加'}</button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
