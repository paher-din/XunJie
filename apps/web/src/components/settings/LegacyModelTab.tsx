import { useState } from 'react'
import { MODELS, MODEL_KEY, MODEL_CHANGE_EVENT } from '../PromptInput'
import {
  saveProvider, removeProvider, useSettings, type ModelProvider, type ProviderModel,
} from '../../lib/settings'
import {
  getModelSettings, loadModelSettings, personalModelOptions, reasoningOptions,
  saveModelSettings, useModelSettings,
} from '../../lib/modelSettings'
import {
  testProviderConnection, testSchoolConnection, testResultText, type TestResult,
} from '../../lib/connectionTest'
import { PREP_BUILD } from '../../workspace/mode'
import { checkProviderForSettings } from './ProviderDialog'
import { LegacyModelSettingsView } from '@xunjie/ui/settings'
import { toast } from '@xunjie/ui/feedback'
import type { TabProps } from '../../pages/SettingsPage'

const EFFORTS = ['低', '高', '最高'] as const

export function LegacyModelTab({ inlineFeedback = false }: TabProps & { inlineFeedback?: boolean }) {
  const local = useSettings()
  const remote = useModelSettings()
  const [prepModel, setPrepModel] = useState(() => localStorage.getItem(MODEL_KEY) ?? MODELS[0].id)
  const [providerDlg, setProviderDlg] = useState<{ provider: ModelProvider | null } | null>(null)
  const [modelDlg, setModelDlg] = useState<{
    provider: ModelProvider
    model: ProviderModel | null
  } | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, TestResult>>({})
  const [confirmingDel, setConfirmingDel] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [savedRevision, setSavedRevision] = useState<number | null>(null)

  const providers = PREP_BUILD ? local.providers : remote.data?.providers ?? []
  const modelId = PREP_BUILD ? prepModel : remote.data?.defaultModelId ?? ''
  const strengths = PREP_BUILD ? [...EFFORTS] : reasoningOptions(remote.data)
  const disabled = !PREP_BUILD && (!remote.data || remote.saving || remote.loading)
  const options = PREP_BUILD
    ? [
        ...MODELS,
        ...providers.flatMap(p => p.models.map(m => ({
          id: `custom:${p.id}:${m.id}`,
          name: m.id,
          note: p.name,
          icon: 'model' as const,
        }))),
      ]
    : personalModelOptions(remote.data)

  const act = async (fn: () => Promise<void>) => {
    setNotice('')
    try {
      await fn()
    } catch (e) {
      setNotice(e instanceof Error ? e.message : '操作未完成，请重试。')
    }
  }

  // Only an acknowledged save can produce the student page's success message.
  // Keep this presentation state local; the shared store and teacher UI are unchanged.
  const persistSettings = async (patch: Parameters<typeof saveModelSettings>[0], notify = true) => {
    if (inlineFeedback) {
      setNotice('')
      setSavedRevision(null)
    }
    await saveModelSettings(patch)
    if (notify) toast.success('已保存')
    if (inlineFeedback) setSavedRevision(getModelSettings().data?.revision ?? null)
  }

  const pickModel = (id: string) => {
    if (PREP_BUILD) {
      setPrepModel(id)
      localStorage.setItem(MODEL_KEY, id)
      window.dispatchEvent(new Event(MODEL_CHANGE_EVENT))
      return
    }
    void act(() => persistSettings({ defaultModelId: id }))
  }

  const replaceProviders = async (next: ModelProvider[]) => {
    const current = getModelSettings().data
    const ids = next.flatMap(p => p.models.map(m => `custom:${p.id}:${m.id}`))
    const currentDefault = current?.defaultModelId
    const defaultModelId = currentDefault && ids.includes(currentDefault)
      ? currentDefault
      : ids[0] ?? ''
    const hasDefaultCredential = next.some(p => {
      const hasKey = Boolean(p.apiKey?.trim() || (p.hasKey && !p.clearKey))
      return hasKey && p.models.some(m => `custom:${p.id}:${m.id}` === defaultModelId)
    })
    const enabled = ids.length > 0 && hasDefaultCredential
      ? current?.enabled ?? false
      : false

    await persistSettings({ providers: next, defaultModelId, enabled }, false)
  }

  const persistProvider = async (p: ModelProvider) => {
    if (PREP_BUILD) {
      saveProvider({ ...p, apiKey: '' })
      return
    }
    const next = providers.some(x => x.id === p.id)
      ? providers.map(x => x.id === p.id ? {...x,...p} : x)
      : [...providers, p]
    await replaceProviders(next)
  }

  const runTest = async (p: ModelProvider | 'school') => {
    const id = p === 'school' ? 'school' : p.id
    setTestingId(id)
    const result = p === 'school'
      ? await testSchoolConnection()
      : await testProviderConnection(p)
    setResults(previous => ({ ...previous, [id]: result }))
    setTestingId(null)
    toast[result.ok ? 'success' : 'error'](testResultText(result).text)
  }


  return <LegacyModelSettingsView preparation={PREP_BUILD} inlineFeedback={inlineFeedback} remote={remote}
    notice={notice} savedRevision={savedRevision} providers={providers} modelId={modelId} strengths={strengths}
    disabled={disabled} options={options} confirmingDel={confirmingDel} setConfirmingDel={setConfirmingDel}
    pickModel={pickModel}
    configActions={{
      saving: remote.saving, enabled: Boolean(remote.data?.enabled),
      reloadDisabled: remote.loading || remote.saving,
      toggleDisabled: disabled || (!remote.data?.enabled && options.length === 0),
      onReload: () => {
        if (inlineFeedback) { setNotice(''); setSavedRevision(null) }
        void loadModelSettings()
      },
      onToggle: () => void act(() => persistSettings({ enabled: !remote.data?.enabled })),
    }}
    testingId={testingId} testResults={Object.fromEntries(Object.entries(results).map(([id, result]) => [id, testResultText(result)]))}
    onTest={p => void runTest(p)}
    onEffortChange={level => {
                  if (!PREP_BUILD && modelId && !disabled) {
                    void act(() => persistSettings({
                      efforts: { ...remote.data?.efforts, [modelId]: level },
                    }))
                  }
                }}
    onRemoveProvider={p => void act(async () => {
      if (PREP_BUILD) removeProvider(p.id)
      else await replaceProviders(providers.filter(x => x.id !== p.id))
      setConfirmingDel(null)
      toast.success('供应商已移除')
    })}
    onRemoveModel={(p, m) => void act(async () => {
      await persistProvider({ ...p, models: p.models.filter(x => x.id !== m.id) })
      toast.success('模型已移除')
    })}
    onEditProvider={p => setProviderDlg({ provider: p })}
    onEditModel={(p, m) => setModelDlg({ provider: p, model: m })}
    onNewProvider={() => setProviderDlg({ provider: null })}
    dialogs={{
      preparation: PREP_BUILD, providerDialog: providerDlg, modelDialog: modelDlg,
      onCloseProvider: () => setProviderDlg(null), onCloseModel: () => setModelDlg(null),
      onSaveProvider: async p => {
        await persistProvider(p)
        toast.success('供应商已保存')
      },
      onSaveModel: async m => {
        if (!modelDlg) return
        const { provider, model } = modelDlg
        const models = model
          ? provider.models.map(x => x.id === model.id ? m : x)
          : [...provider.models, m]
        await persistProvider({ ...provider, models })
        toast.success('模型已保存')
      },
      onTestProvider: checkProviderForSettings,
    }} />
}
