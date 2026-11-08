import { PREP_BUILD } from '../../workspace/mode'
import { testProviderConnection, testResultText } from '../../lib/connectionTest'
import { ProviderSettingsDialog, type ProviderSettingsDialogProps, type ProviderConnectionInput, type ProviderConnectionResult } from '@xunjie/ui/settings'

export type ProviderDialogProps = Omit<ProviderSettingsDialogProps, 'preparation' | 'onTest'>

/** Network and mode remain in the old adapter; the package receives display results. */
export async function checkProviderForSettings(input: ProviderConnectionInput): Promise<ProviderConnectionResult> {
  const result = await testProviderConnection(input)
  return { ...testResultText(result), ...(result.ok && result.models ? { models: result.models } : {}) }
}

export function ProviderDialog(props: ProviderDialogProps) {
  return <ProviderSettingsDialog {...props} preparation={PREP_BUILD} onTest={checkProviderForSettings} />
}
