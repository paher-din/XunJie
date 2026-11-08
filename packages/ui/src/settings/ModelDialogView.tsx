import type { Dispatch, SetStateAction } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Icon } from '../icons'
import { ModelFields } from './ModelFields'
import type { ProviderModel } from './types'

export interface ModelDialogViewProps {
  open: boolean
  onClose: () => void
  providerName: string
  model: ProviderModel | null
  draft: ProviderModel
  setDraft: Dispatch<SetStateAction<ProviderModel>>
  idError: string
  setIdError: (error: string) => void
  saving: boolean
  submit: () => Promise<void>
}
/** Controlled form; validation and persistence stay in the application controller. */
export function ModelDialogView({ open, onClose, providerName, model, draft, setDraft, idError, setIdError, saving, submit }: ModelDialogViewProps) {
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
              <button type="button" className="primary" disabled={saving} onClick={() => void submit()}>{model ? '保存' : '添加'}</button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
