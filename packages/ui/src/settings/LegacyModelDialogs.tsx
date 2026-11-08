import { ProviderSettingsDialog, type ProviderSettingsData, type ProviderConnectionInput, type ProviderConnectionResult } from './ProviderSettingsDialog'
import { ModelSettingsDialog } from './ModelSettingsDialog'
import type { ProviderModel } from './types'

export interface LegacyModelDialogsProps {
  preparation: boolean
  providerDialog: { provider: ProviderSettingsData | null } | null
  modelDialog: { provider: ProviderSettingsData; model: ProviderModel | null } | null
  onCloseProvider: () => void
  onCloseModel: () => void
  onSaveProvider: (provider: ProviderSettingsData) => void | Promise<void>
  onSaveModel: (model: ProviderModel) => void | Promise<void>
  onTestProvider: (input: ProviderConnectionInput) => Promise<ProviderConnectionResult>
}

/** Concrete dialog composition; conditional mounting retains form reset on close/reopen. */
export function LegacyModelDialogs({ preparation, providerDialog, modelDialog, onCloseProvider, onCloseModel,
  onSaveProvider, onSaveModel, onTestProvider }: LegacyModelDialogsProps) {
  return <>
    {providerDialog && <ProviderSettingsDialog open provider={providerDialog.provider} preparation={preparation}
      onClose={onCloseProvider} onSave={onSaveProvider} onTest={onTestProvider} />}
    {modelDialog && <ModelSettingsDialog open providerName={modelDialog.provider.name} model={modelDialog.model}
      siblings={modelDialog.provider.models.filter(x => x.id !== modelDialog.model?.id).map(x => x.id)}
      onClose={onCloseModel} onSave={onSaveModel} />}
  </>
}
