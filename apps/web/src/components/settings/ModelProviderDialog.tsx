import { useEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { modelBaseUrlError, modelConfigurationSchema, saveModelProviderSchema, resolveModelProfile, modelReasoningError,
  formatModelTokenCount, parseModelTokenCount, modelTokenCountError, resolveModelCapacity,
  modelProviderPresets, getModelPreset, resolvePresetModelRoute,
  type ModelPresetId, type ModelDirectoryEntry, type ModelDirectoryRefresh,
  type ModelConfiguration, type ModelProvider, type ModelProfile, type ModelAttempt, type ModelCheckInput, type SaveModelProvider, type ReasoningEffort } from '@xunjie/contracts/model-connections'
import { ConnectionModelFields, Field, SettingsSelect, ModelProviderLogo } from '@xunjie/ui/settings'
import { ProviderIdentityFields } from './ProviderIdentityFields'
import { Icon } from '../../icons'
import { useModelDirectory, type ReadModelDirectory } from './useModelDirectory'

type ModelInput = SaveModelProvider['models'][number]
type ModelDraft = Omit<ModelInput, 'contextWindow' | 'maxOutputTokens'> & { contextWindow?: string | undefined; maxOutputTokens?: string | undefined }
type Draft = Omit<SaveModelProvider, 'requestId' | 'expectedVersion' | 'credential' | 'models'> & { models: ModelDraft[] }
const paths = { 'chat-completions': '/chat/completions', responses: '/responses', messages: '/v1/messages' } as const
const newModel = (): ModelDraft => ({ connectionId: crypto.randomUUID(), expectedVersion: 0, modelId: '', enabled: true })
const fromProvider = (provider: ModelProvider | null): Draft => provider ? {
  providerId: provider.providerId, name: provider.name, baseUrl: provider.baseUrl, protocol: provider.protocol, enabled: provider.enabled,
  ...(provider.presetId ? { presetId: provider.presetId } : {}), ...(provider.variantId ? { variantId: provider.variantId } : {}),
  models: provider.models.map(model => ({ connectionId: model.connectionId, expectedVersion: model.version, modelId: model.modelId,
    protocol: model.protocol, baseUrl: model.baseUrl,
    enabled: model.modelEnabled ?? model.enabled, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    ...(model.reasoningSource === 'manual' ? { reasoningLevels: model.reasoningLevels ?? [] } : {}),
    ...(model.contextWindow === undefined ? {} : { contextWindow: formatModelTokenCount(model.contextWindow) }),
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: formatModelTokenCount(model.maxOutputTokens) }) })),
} : { providerId: crypto.randomUUID(), name: '', baseUrl: '', protocol: 'chat-completions', enabled: true, models: [newModel()] }

const scopeOf = (draft: Pick<Draft, 'presetId' | 'variantId'>) => `${draft.presetId ?? 'custom'}:${draft.variantId ?? ''}`
const profileRouteKey = (route: { protocol: string; baseUrl: string; modelId: string }) => JSON.stringify([route.protocol, route.baseUrl, route.modelId.trim()])
function refreshMessage(state: ModelDirectoryRefresh | undefined, source: 'supplier' | 'catalogue'): string {
  if (!state) return ''
  const retry = state.retryAt && new Date(state.retryAt).getTime() > Date.now()
    ? `请在 ${new Date(state.retryAt).toLocaleTimeString('zh-CN', { hour12: false })} 后重试。` : '请稍后重试。'
  if (state.error === 'unauthorized') return source === 'supplier' ? '密钥无效或不属于当前接入方式，请核对 API Key 后更新。'
    : `公共模型资料暂时不可用，当前配置可继续使用。${retry}`
  if (state.error === 'rate-limited') return `${source === 'supplier' ? '供应商' : '模型资料源'}暂时限流，已保留当前列表。${retry}`
  if (state.error) return `模型资料暂未更新，当前列表和填写已保留。${retry}`
  if (state.status === 'needs-credential') return '填写 API Key 后可获取此账号的模型列表；也可直接填写模型 ID。'
  return ''
}

export function ModelProviderDialog({ provider, attempts, addModel = false, onClose, onSave, onRead, onReadCredential, onProfiles, onDirectory, onCheck, onCancel }: {
  provider: ModelProvider | null; attempts: ModelAttempt[]; addModel?: boolean; onClose(): void
  onSave(input: SaveModelProvider): Promise<ModelProvider>; onRead(providerId: string): Promise<ModelProvider | null>
  onReadCredential(connectionId: string, version: number): Promise<string>
  onProfiles(input: { baseUrl: string; protocol: ModelConfiguration['protocol']; modelIds: string[]; refresh?: boolean }): Promise<{ profiles: ModelProfile[]; stale: boolean }>
  onDirectory?: ReadModelDirectory | undefined
  onCheck(source: ModelCheckInput['source']): Promise<ModelAttempt>; onCancel(attempt: ModelAttempt): Promise<void>
}) {
  const [draft, setDraft] = useState<Draft>(() => {
    const value = fromProvider(provider)
    if (addModel) value.models.push(newModel())
    return value
  })
  const [profiles, setProfiles] = useState<Map<string, ModelProfile>>(() => new Map()), [refresh, setRefresh] = useState(0), [profileBusy, setProfileBusy] = useState(false)
  const [profileNotice, setProfileNotice] = useState('')
  const [apiKey, setApiKey] = useState(''), [saving, setSaving] = useState(false)
  const [lookupKey, setLookupKey] = useState<string | undefined>(provider?.hasCredential ? undefined : '')
  const [credentialReady, setCredentialReady] = useState(!provider?.hasCredential), [credentialError, setCredentialError] = useState('')
  const [credentialRetry, setCredentialRetry] = useState(0), [addressTouched, setAddressTouched] = useState(false)
  const [error, setError] = useState(''), [checking, setChecking] = useState(false), [result, setResult] = useState<ModelAttempt | null>(null)
  const [checkId, setCheckId] = useState(draft.models[0]!.connectionId)
  const [recovery, setRecovery] = useState<'conflict' | 'unknown' | null>(null), [latest, setLatest] = useState<ModelProvider | null>(null)
  const [reading, setReading] = useState(false), [notice, setNotice] = useState('')
  const dialogContent = useRef<HTMLDivElement>(null)
  const epoch = useRef(0), live = useRef(true), baseline = useRef(provider)
  const credentialDrafts = useRef(new Map<string, string>()), scope = scopeOf(draft), scopeRef = useRef(scope); scopeRef.current = scope
  const savedScope = useRef(scopeOf(fromProvider(provider)))
  const providerDrafts = useRef(new Map<string, Draft>()), modelDrafts = useRef(new Map<string, ModelDraft>())
  const preset = useMemo(() => modelProviderPresets.find(item => item.id === draft.presetId), [draft.presetId])
  const variant = useMemo(() => getModelPreset(draft.presetId ?? 'custom', draft.variantId), [draft.presetId, draft.variantId])
  const savedKey = provider?.models.find(model => model.hasCredential)
  const directory = useModelDirectory(onDirectory, {
    presetId: draft.presetId ?? 'custom', ...(draft.variantId ? { variantId: draft.variantId } : {}),
    ...(!modelBaseUrlError(draft.baseUrl, draft.protocol) ? { baseUrl: draft.baseUrl, protocol: draft.protocol } : {}),
    credential: lookupKey === undefined ? { action: 'keep' } : lookupKey.trim() ? { action: 'replace', value: lookupKey.trim() } : { action: 'clear' },
    ...(scope === savedScope.current && savedKey ? { savedCredential: { connectionId: savedKey.connectionId, version: savedKey.version } } : {}),
  })
  const entries: readonly ModelDirectoryEntry[] = directory.data?.models ?? variant?.models ?? []
  const directoryStamp = [directory.data?.catalogue.updatedAt, directory.data?.supplier?.updatedAt].join('|')
  const [retryNow, setRetryNow] = useState(Date.now)
  const refreshStates = [directory.data?.supplier, directory.data?.catalogue].filter((state): state is ModelDirectoryRefresh => Boolean(state))
  const refreshable = refreshStates.filter(state => state.status !== 'needs-credential')
  const manualReadyAt = refreshable.length ? Math.min(...refreshable.map(state => state.error ? state.retryAt ? Date.parse(state.retryAt) : 0
    : Math.max(state.lastAttemptAt ? Date.parse(state.lastAttemptAt) : 0, state.updatedAt ? Date.parse(state.updatedAt) : 0) + 3000)) : 0
  const retryBlocked = manualReadyAt > Math.max(retryNow, Date.now())
  useEffect(() => {
    if (manualReadyAt <= Date.now()) return
    const timer = setTimeout(() => setRetryNow(Date.now()), manualReadyAt - Date.now() + 20)
    return () => clearTimeout(timer)
  }, [manualReadyAt])
  const directoryNotice = directory.error || [...new Set([refreshMessage(directory.data?.supplier, 'supplier'), refreshMessage(directory.data?.catalogue, 'catalogue')].filter(Boolean))].join(' ')
  const directoryFailed = Boolean(directory.error || refreshStates.some(state => state.error))
  const modelOptions = useMemo(() => entries.map(entry => ({ value: entry.modelId, label: entry.name || entry.modelId })), [entries])
  const pending = useRef<{ input: SaveModelProvider; generation: number } | null>(null), submitting = useRef(false)
  const returnFocus = useRef(document.activeElement as HTMLElement | null)
  const currentResult = attempts.find(item => item.attemptId === result?.attemptId) ?? result
  const addressIssue = modelBaseUrlError(draft.baseUrl, draft.protocol)
  const modelRoute = (model: ModelDraft) => {
    if (model.protocol && model.baseUrl) return { protocol: model.protocol, baseUrl: model.baseUrl }
    const entry = entries.find(item => item.modelId === model.modelId.trim())
    if (preset) {
      if (entry?.protocol && variant?.baseUrls[entry.protocol]) return { protocol: entry.protocol, baseUrl: variant.baseUrls[entry.protocol]! }
      const automatic = resolvePresetModelRoute(preset.id, draft.variantId, model.modelId.trim(), entry?.protocols)
      if (automatic) return automatic
    }
    return { protocol: draft.protocol, baseUrl: draft.baseUrl }
  }
  const profileKey = JSON.stringify(draft.models.map(model => ({ ...modelRoute(model), modelId: model.modelId.trim() })))
  useEffect(() => { live.current = true; return () => { live.current = false; epoch.current++ } }, [])
  useEffect(() => {
    const model = provider?.models.find(model => model.hasCredential)
    if (!model) return
    let active = true
    if (scopeRef.current === savedScope.current) { setCredentialReady(false); setCredentialError('') }
    void onReadCredential(model.connectionId, model.version).then(value => {
      if (active) {
        credentialDrafts.current.set(savedScope.current, value)
        if (scopeRef.current === savedScope.current) { setApiKey(value); setLookupKey(value); setCredentialReady(true) }
      }
    }).catch(() => { if (active && scopeRef.current === savedScope.current) setCredentialError('未能读取已保存的密钥。请重试；若配置已更新，请关闭后重新打开。') })
    return () => { active = false }
  }, [provider, onReadCredential, credentialRetry])
  useEffect(() => {
    let active = true
    setProfileNotice('')
    const routes = (JSON.parse(profileKey) as { baseUrl: string; protocol: ModelConfiguration['protocol']; modelId: string }[])
      .filter(route => route.modelId && !modelBaseUrlError(route.baseUrl, route.protocol))
    if (!routes.length) { setProfileBusy(false); return }
    setProfileBusy(true)
    const timer = setTimeout(() => {
      const groups = new Map<string, typeof routes>()
      for (const route of routes) { const key = JSON.stringify([route.baseUrl, route.protocol]); groups.set(key, [...(groups.get(key) ?? []), route]) }
      void Promise.all([...groups.values()].map(async group => {
        const route = group[0]!
        const value = await onProfiles({ baseUrl: route.baseUrl, protocol: route.protocol, modelIds: group.map(item => item.modelId), refresh: false })
        return { route, ...value }
      })).then(values => {
        if (active) {
          setProfiles(previous => { const next = new Map(previous); for (const value of values) for (const profile of value.profiles)
            next.set(profileRouteKey({ ...value.route, modelId: profile.modelId }), profile); return next })
        }
      }).catch(() => { if (active) setProfileNotice('暂时无法获取模型资料，仍可手填模型 ID 和档位。') })
        .finally(() => { if (active) setProfileBusy(false) })
    }, 400)
    return () => { active = false; clearTimeout(timer) }
  }, [profileKey, refresh, onProfiles, directoryStamp])
  const changed = () => { epoch.current++; setResult(null); setNotice(''); if (!recovery) setError('') }
  const change = (patch: Partial<Draft>) => { changed(); setDraft(previous => ({ ...previous, ...patch })) }
  const changeModel = (id: string, patch: Partial<ModelDraft>) => change({ models: draft.models.map(model => model.connectionId === id ? { ...model, ...patch } : model) })
  const profileOf = (model: ModelDraft): ModelProfile => {
    const route = { ...modelRoute(model), modelId: model.modelId, presetId: draft.presetId, variantId: draft.variantId }
    const fallback = resolveModelProfile({ ...route, ...(model.reasoningLevels ? { reasoningLevels: model.reasoningLevels } : {}) })
    const found = profiles.get(profileRouteKey(route)), entry = entries.find(item => item.modelId === model.modelId.trim())
    const saved = provider?.models.find(saved => saved.connectionId === model.connectionId && saved.modelId === model.modelId
      && saved.baseUrl === route.baseUrl && saved.protocol === route.protocol)
    const base: ModelProfile = { ...found, modelId: model.modelId, dialect: fallback.dialect,
      efforts: entry?.efforts ? ['auto', ...entry.efforts.filter(value => value !== 'auto')] : found?.efforts ?? (saved?.reasoningLevels ? ['auto', ...saved.reasoningLevels] : fallback.efforts),
      source: entry?.efforts ? 'profile' : found?.source ?? saved?.reasoningSource ?? (fallback.source === 'known' ? 'profile' : 'unknown'),
      ...(entry?.contextWindow ? { contextWindow: entry.contextWindow } : {}),
      ...(entry?.maxOutputTokens ? { maxOutputTokens: entry.maxOutputTokens } : {}),
      ...(entry?.defaultEffort ?? found?.defaultEffort ?? fallback.defaultEffort ? { defaultEffort: entry?.defaultEffort ?? found?.defaultEffort ?? fallback.defaultEffort } : {}),
      reasoningKind: entry?.reasoningKind ?? found?.reasoningKind ?? fallback.reasoningKind }
    if (model.reasoningLevels !== undefined) return { ...base, efforts: fallback.efforts, source: 'manual',
      reasoningKind: model.reasoningLevels.some(value => !['none', 'enabled'].includes(value)) ? 'effort' : 'toggle' }
    if (base.defaultEffort && !base.efforts.includes(base.defaultEffort)) delete base.defaultEffort
    return base
  }
  const effortOf = (model: ModelDraft) => {
    if (model.reasoningEffort !== undefined) return model.reasoningEffort
    const route = modelRoute(model)
    const saved = provider?.models.find(saved => saved.connectionId === model.connectionId && saved.modelId === model.modelId
      && saved.baseUrl === route.baseUrl && saved.protocol === route.protocol)
    return saved ? saved.reasoningEffort : profileOf(model).defaultEffort ?? 'auto'
  }
  const capacityOf = (model: ModelDraft) => resolveModelCapacity({
    contextWindow: parseModelTokenCount(model.contextWindow) ?? undefined,
    maxOutputTokens: parseModelTokenCount(model.maxOutputTokens) ?? undefined,
  }, profileOf(model))
  const inputOf = (model: ModelDraft): ModelInput => ({ ...model, ...modelRoute(model), ...capacityOf(model),
    ...(effortOf(model) ? { reasoningEffort: effortOf(model) } : {}) })
  const chooseModel = (model: ModelDraft, modelId: string) => {
    if (model.modelId.trim() === modelId.trim()) { changeModel(model.connectionId, { modelId }); return }
    modelDrafts.current.set(`${scope}:${model.connectionId}:${model.modelId.trim()}`, model)
    const remembered = modelDrafts.current.get(`${scope}:${model.connectionId}:${modelId.trim()}`)
    changeModel(model.connectionId, remembered ? { ...remembered, modelId, expectedVersion: model.expectedVersion } : {
      modelId, contextWindow: undefined, maxOutputTokens: undefined, reasoningEffort: undefined, reasoningLevels: undefined,
      protocol: undefined, baseUrl: undefined,
    })
  }
  const choosePreset = (presetId: ModelPresetId, variantId?: string) => {
    const definition = modelProviderPresets.find(item => item.id === presetId)
    const selected = getModelPreset(presetId, variantId)
    const destination = scopeOf({ presetId, variantId: selected?.id })
    if (destination === scope) return
    providerDrafts.current.set(scope, draft); credentialDrafts.current.set(scope, apiKey)
    const remembered = providerDrafts.current.get(destination)
    const preferred = selected && resolvePresetModelRoute(presetId, selected.id, selected.models[0]?.modelId ?? '')
    const next: Draft = remembered ?? { ...draft, presetId, variantId: selected?.id,
      name: !draft.name || draft.name === preset?.name ? definition?.name ?? draft.name : draft.name,
      ...(preferred ?? {}),
      models: presetId === 'custom' ? draft.models.map(model => ({ ...model, ...inputOf(model),
        contextWindow: formatModelTokenCount(capacityOf(model).contextWindow), maxOutputTokens: formatModelTokenCount(capacityOf(model).maxOutputTokens) }))
        : draft.models.map(model => ({ connectionId: model.connectionId, expectedVersion: model.expectedVersion, modelId: '', enabled: model.enabled })),
    }
    changed(); setDraft(next); setAddressTouched(false); setCredentialError('')
    const secret = credentialDrafts.current.get(destination)
    setApiKey(secret ?? ''); setLookupKey(secret ?? (destination === savedScope.current && provider?.hasCredential ? undefined : ''))
    setCredentialReady(secret !== undefined || destination !== savedScope.current || !provider?.hasCredential)
  }
  const routeOf = (model: ModelDraft): ModelConfiguration => {
    const profile = profileOf(model), old = provider?.models.find(saved => saved.connectionId === model.connectionId)
    const route = modelRoute(model), effort = effortOf(model)
    return { connectionId: model.connectionId, name: draft.name, ...route, path: paths[route.protocol],
      ...(draft.presetId ? { presetId: draft.presetId } : {}), ...(draft.variantId ? { variantId: draft.variantId } : {}),
      modelId: model.modelId, enabled: draft.enabled && model.enabled, dialect: effort === undefined && old ? old.dialect : profile.dialect,
      parameterMode: effort === undefined ? old?.parameterMode ?? 'plain' : !['auto', 'none'].includes(effort) ? 'thinking' : 'plain',
      ...(effort ? { reasoningEffort: effort } : {}), reasoningLevels: profile.efforts.filter(level => level !== 'auto'),
      ...capacityOf(model) }
  }
  const credential = () => apiKey.trim() ? { action: 'replace' as const, value: apiKey.trim() } : { action: 'clear' as const }
  const valid = () => {
    setAddressTouched(true)
    if (addressIssue) return false
    if (draft.models.some(model => modelTokenCountError(model.contextWindow) || modelTokenCountError(model.maxOutputTokens))) {
      setError('请检查上下文窗口和最大输出的填写。'); return false
    }
    const duplicate = new Set(draft.models.map(model => model.modelId.trim())).size !== draft.models.length
    const unsupported = draft.models.find(model => { const entry = entries.find(item => item.modelId === model.modelId.trim());
      return entry?.protocols && !entry.protocols.includes(modelRoute(model).protocol) })
    if (unsupported) { setError(`当前接入方式尚未提供 ${unsupported.modelId} 的兼容协议，请选择其他型号或使用自定义连接。`); return false }
    const reasoning = draft.models.map(model => modelReasoningError(routeOf(model), capacityOf(model).maxOutputTokens)).find(Boolean)
    if (duplicate || reasoning) { setError(duplicate ? '同一供应商内的模型 ID 不能重复。' : reasoning!); return false }
    return true
  }
  const checkModel = draft.models.find(model => model.connectionId === checkId) ?? draft.models[0]!
  const test = async () => {
    if (!credentialReady || !valid()) return
    const generation = epoch.current; setChecking(true); if (!recovery) setError('')
    try {
      const checked = await onCheck({ draft: modelConfigurationSchema.parse(routeOf(checkModel)), credential: credential() })
      if (live.current && generation === epoch.current) setResult(checked)
    } catch { if (live.current && generation === epoch.current) setError('检查未确认，请核对输入、凭据和原检查记录。') }
    finally { if (live.current) setChecking(false) }
  }
  const submit = async (operation: NonNullable<typeof pending.current>) => {
    if (submitting.current) return
    const wasUnknown = recovery === 'unknown'; submitting.current = true; pending.current = operation; setSaving(true); setError('')
    try {
      const saved = await onSave(operation.input)
      if (live.current) {
        pending.current = null; baseline.current = saved; setRecovery(null); setLatest(null)
        if (operation.generation === epoch.current) { setApiKey(''); onClose() }
        else {
          setDraft(previous => {
            const models = previous.models.map(model => ({ ...model,
              expectedVersion: saved.models.find(saved => saved.connectionId === model.connectionId)?.version ?? model.expectedVersion }))
            for (const item of fromProvider(saved).models) if (!models.some(model => model.connectionId === item.connectionId)) models.push(item)
            return { ...previous, models }
          })
          setNotice('原提交已确认，后续输入尚未保存。')
        }
      }
    } catch (error) {
      if (!live.current) return
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'conflict') {
        pending.current = null; setRecovery('conflict'); setLatest(null)
        setError('版本冲突，当前草稿和密钥操作已保留。请读取最新版本，核对后确认重试。')
      } else if (!wasUnknown && (code === 'invalid' || code === 'forbidden')) {
        pending.current = null; setRecovery(null)
        setError(code === 'invalid' ? '保存被拒绝，请检查地址、协议、模型及密钥填写。' : '原空间资格已失效，请重新登录原空间。')
      } else {
        setRecovery('unknown')
        setError(code === 'identity-conflict' ? '原提交身份与内容冲突，当前输入已保留；请核对原提交，不创建新提交。'
          : code === 'forbidden' ? '原空间资格已失效，保存结果尚未确认；请恢复原空间资格后核对原提交。'
            : '保存结果尚未确认，当前输入已保留。请核对原提交后再保存后续修改。')
      }
    } finally { submitting.current = false; if (live.current) setSaving(false) }
  }
  const save = async (confirmed?: ModelProvider) => {
    if (submitting.current || pending.current || recovery && !confirmed || !credentialReady || !valid()) return
    try {
      const base = confirmed ?? baseline.current
      const models: ModelInput[] = draft.models.map(model => {
        const saved = base?.models.find(saved => saved.connectionId === model.connectionId)
        return { ...inputOf(model), enabled: saved ? saved.modelEnabled ?? saved.enabled : model.enabled, expectedVersion: saved?.version ?? model.expectedVersion }
      })
      // Preserve models added by another editor while applying this editor's explicit changes.
      for (const saved of base?.models ?? []) if (!models.some(model => model.connectionId === saved.connectionId))
        models.push(inputOf(fromProvider({ ...base!, models: [saved] }).models[0]!))
      const input = saveModelProviderSchema.parse({ ...draft, models, enabled: base?.enabled ?? draft.enabled, requestId: crypto.randomUUID(), expectedVersion: base?.version ?? 0, credential: credential() })
      await submit({ input, generation: epoch.current })
    } catch { setError('请检查地址、协议、模型及密钥填写，当前输入已保留。') }
  }
  const readLatest = async () => {
    if (reading || submitting.current || pending.current) return
    setReading(true)
    try {
      const saved = await onRead(draft.providerId)
      if (live.current) { setLatest(saved); setError(saved ? '请核对最新版本与当前草稿；确认后才会按当前草稿保存。' : '未找到原配置，当前草稿已保留，请稍后重新读取。') }
    } catch { if (live.current) { setError('无法读取最新版本，当前草稿和密钥操作已保留。请重新读取后再确认。'); setLatest(null) } }
    finally { if (live.current) setReading(false) }
  }
  const refreshDirectory = async () => {
    if (onDirectory) await directory.refresh()
    setRefresh(value => value + 1)
  }
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="overlay pc-overlay" /><Dialog.Content ref={dialogContent} className="st-dialog product-connection-dialog" aria-describedby={undefined}
      onEscapeKeyDown={event => {
        // Radix handles Escape on document capture, before the nested Base UI menu.
        if (event.isComposing || dialogContent.current?.querySelector('[role="combobox"][aria-expanded="true"]')) event.preventDefault()
      }}
      onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus() }}>
      <div className="st-dialog-head"><Dialog.Title className="st-dialog-title">{provider ? '编辑供应商' : '添加供应商'}</Dialog.Title>
        <Dialog.Close asChild><button type="button" className="pc-x" aria-label="关闭"><Icon name="close" size={18} /></button></Dialog.Close></div>
      <div className="st-dialog-body">
        <Field label="供应商"><SettingsSelect label="供应商" value={draft.presetId ?? 'custom'} onChange={value => choosePreset(value as ModelPresetId)}
          options={[{ value: 'custom', label: '自定义', icon: <ModelProviderLogo providerId="custom" /> },
            ...modelProviderPresets.map((item, index) => ({ value: item.id, label: item.name, dividerBefore: index === 0,
              icon: <ModelProviderLogo providerId={item.id} /> }))]} /></Field>
        {preset && preset.variants.length > 1 && <Field label="接入方式"><SettingsSelect label="接入方式"
          value={variant?.id ?? preset.variants[0]!.id} options={preset.variants.map(item => ({ value: item.id, label: item.name }))}
          onChange={value => choosePreset(preset.id, value)} /></Field>}
        <ProviderIdentityFields name={draft.name} baseUrl={draft.baseUrl} apiKey={apiKey} snapshotCredential apiKeyDisabled={!credentialReady} baseUrlReadOnly={Boolean(preset)}
          errors={{ baseUrl: addressTouched ? addressIssue : undefined }} onBaseUrlBlur={() => setAddressTouched(true)}
          protocol={preset ? undefined : { value: draft.protocol,
            options: [{ value: 'chat-completions', label: 'OpenAI 兼容' }, { value: 'responses', label: 'OpenAI Responses' }, { value: 'messages', label: 'Anthropic 兼容' }],
            placeholder: draft.protocol === 'messages' ? 'https://api.example.com' : 'https://api.example.com/v1',
            onChange: value => { change({ protocol: value as Draft['protocol'], models: draft.models.map(model => ({ ...model, protocol: undefined, baseUrl: undefined })) }); if (draft.baseUrl) setAddressTouched(true) } }}
          onName={name => change({ name })} onBaseUrl={baseUrl => change({ baseUrl, models: draft.models.map(model => ({ ...model, protocol: undefined, baseUrl: undefined })) })}
          onApiKey={value => { changed(); setApiKey(value); credentialDrafts.current.set(scope, value) }} onApiKeyBlur={() => setLookupKey(apiKey)} />
        {credentialError && <div><p role="alert">{credentialError}</p><button type="button" className="outline" onClick={() => setCredentialRetry(value => value + 1)}>重新读取密钥</button></div>}
        <div className="st-route-list-head"><h3>模型</h3><button type="button" className="outline st-xs"
          disabled={onDirectory ? directory.busy || retryBlocked : profileBusy || Boolean(addressIssue) || !draft.models.some(model => model.modelId.trim())}
          title={retryBlocked ? `可在 ${new Date(manualReadyAt).toLocaleTimeString('zh-CN', { hour12: false })} 再次更新` : undefined}
          onClick={() => void refreshDirectory()}>{directory.visibleBusy ? '正在更新…' : retryBlocked ? directoryFailed ? '稍后重试' : '刚刚更新' : '更新模型资料'}</button></div>
        <div className="st-directory-feedback" aria-live="polite" aria-atomic="true">
          {(directoryNotice || profileNotice || directory.visibleBusy) && <p className={directoryFailed ? 'detail st-directory-error' : 'detail'} role={directoryFailed ? 'alert' : 'status'}>
            {directoryNotice || profileNotice || '正在更新资料，当前列表可继续使用。'}
          </p>}
        </div>
        <div className="st-route-list">{draft.models.map((model, index) => {
          const profile = profileOf(model)
          return <section className="st-route-editor" key={model.connectionId} aria-label={`模型配置 ${index + 1}`}>
            {draft.models.length > 1 && <div className="st-route-editor-head"><span>模型 {index + 1}</span>
              {model.expectedVersion === 0 && <button type="button" className="st-iconbtn" aria-label={`移除模型 ${index + 1}`}
                onClick={() => change({ models: draft.models.filter(item => item.connectionId !== model.connectionId) })}><Icon name="close" size={14} /></button>}</div>}
            <ConnectionModelFields modelId={model.modelId} idLabel={index === 0 ? '模型 ID' : `模型 ID ${index + 1}`} effort={effortOf(model) ?? 'auto'}
              efforts={profile.efforts} source={profile.source} manualLevels={model.reasoningLevels} contextWindow={model.contextWindow} maxOutputTokens={model.maxOutputTokens}
              reasoningKind={profile.reasoningKind} models={preset ? modelOptions : undefined} modelsLoading={directory.visibleBusy}
              onOpenModels={() => { setLookupKey(apiKey); void directory.ensureFresh() }}
              referenceContext={profile.contextWindow} referenceOutput={profile.maxOutputTokens} error={modelReasoningError(routeOf(model), capacityOf(model).maxOutputTokens)}
              onId={modelId => chooseModel(model, modelId)} onEffort={value => changeModel(model.connectionId, { reasoningEffort: value as ReasoningEffort })}
              onLevels={value => changeModel(model.connectionId, { reasoningLevels: value as ModelInput['reasoningLevels'] })}
              onCapacity={patch => changeModel(model.connectionId, patch)} />
          </section>
        })}</div>
        <button type="button" className="outline st-route-add" disabled={draft.models.length >= 64} onClick={() => change({ models: [...draft.models, newModel()] })}><Icon name="add" size={16} />添加模型</button>
        <p className="detail">一次文本检查不会验证图像、工具或 strict schema 能力。</p>
        {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
        {recovery === 'unknown' && <button type="button" className="outline" disabled={saving} onClick={() => { if (pending.current) void submit(pending.current) }}>核对原提交</button>}
        {recovery === 'conflict' && <>
          <button type="button" className="outline" disabled={reading || saving} onClick={() => void readLatest()}>{reading ? '读取中…' : '读取最新版本'}</button>
          {latest && <div className="detail" role="region" aria-label="配置冲突核对">
            <p>已保存版本 {latest.version} · {latest.hasCredential ? '密钥已保存' : '尚未保存密钥'}</p>
            <p>名称：已保存「{latest.name}」；当前草稿「{draft.name}」</p>
            <p>地址：已保存「{latest.baseUrl}」；当前草稿「{draft.baseUrl}」</p>
            <p>模型：已保存「{latest.models.map(model => model.modelId).join('、')}」；当前草稿「{draft.models.map(model => model.modelId).join('、')}」</p>
            <p>{apiKey.trim() ? '保存后使用输入框中的当前密钥。' : '输入框已清空，保存后移除密钥。'}</p>
            <button type="button" className="outline" disabled={saving || reading} onClick={() => void save(latest)}>确认按当前草稿重试</button>
          </div>}
        </>}
        {currentResult && <p role="status">{currentResult.state === 'completed' ? '检查已完成' : currentResult.state === 'cancelled' ? '已停止本机检查' : '检查结果待核实'} · {currentResult.usage.state === 'unknown' ? '用量未知' : '已记录用量'}</p>}
      </div>
      <div className="st-dialog-foot"><div className="st-route-check">
        {draft.models.length > 1 && <select className="st-input" aria-label="检查模型" value={checkModel.connectionId} onChange={event => setCheckId(event.target.value)}>
          {draft.models.map((model, index) => <option key={model.connectionId} value={model.connectionId}>{model.modelId || `模型 ${index + 1}`}</option>)}</select>}
        <button type="button" className="outline" disabled={checking || !credentialReady || !draft.enabled || !checkModel.enabled} onClick={() => void test()}>{checking ? '正在检查…' : '保存前检查'}</button></div>
        {currentResult && !currentResult.physicalRequestEnded && <button type="button" className="outline" onClick={() => void onCancel(currentResult)}>停止检查</button>}
        <div className="st-dialog-foot-right"><Dialog.Close asChild><button type="button" className="outline">取消</button></Dialog.Close>
          <button type="button" className="primary" disabled={saving || !credentialReady || recovery !== null} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button></div></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
}
