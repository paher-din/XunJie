import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { modelBaseUrlError, modelConfigurationSchema, saveModelProviderSchema, resolveModelProfile, modelReasoningConfigurationError, modelAllowsImages,
  formatModelTokenCount, parseModelTokenCount, modelTokenCountError, resolveModelCapacity,
  modelProviderPresets, getModelPreset, resolvePresetModelRoute,
  type ModelPresetId, type ModelDirectoryEntry, type ModelDirectoryRefresh,
  type ModelConfiguration, type ModelProvider, type ModelProfile, type ModelAttempt, type SaveModelProvider, type ReasoningEffort } from '@xunjie/contracts/model-connections'
import { ConnectionModelFields, Field, TextInput, SettingsSelect, SettingsStatus, ModelProviderLogo, ModelChoiceCard, ModelTestFeedback, ModelTestButton } from '@xunjie/ui/settings'
import { ProviderIdentityFields } from './ProviderIdentityFields'
import { Icon } from '../../icons'
import { toast, useToastFeedback } from '@xunjie/ui/feedback'
import { ConfirmationDialog } from '@xunjie/ui/foundation'
import { useModelDirectory, type ReadModelDirectory } from './useModelDirectory'
import { useModelConfigurationTests, type CheckModelConfiguration } from './useModelConfigurationTests'
import { useSupplierChecks, type TestSupplierConnection } from './useSupplierChecks'
import { inIdOrder, reconcileModelChoices, type ModelChoicePosition } from './modelOrdering'

type ModelInput = SaveModelProvider['models'][number]
type ModelDraft = Omit<ModelInput, 'contextWindow' | 'maxOutputTokens'> & { contextWindow?: string | undefined; maxOutputTokens?: string | undefined }
type ModelChoice = ModelDirectoryEntry & { connectionId?: string }
type Draft = Omit<SaveModelProvider, 'requestId' | 'expectedVersion' | 'credential' | 'models'> & { models: ModelDraft[] }
const paths = { 'chat-completions': '/chat/completions', responses: '/responses', messages: '/v1/messages' } as const
const newModel = (): ModelDraft => ({ connectionId: crypto.randomUUID(), expectedVersion: 0, modelId: '', enabled: true, imageInput: false })
const fromProvider = (provider: ModelProvider | null): Draft => provider ? {
  providerId: provider.providerId, name: provider.name, baseUrl: provider.baseUrl, protocol: provider.protocol, enabled: provider.enabled,
  ...(provider.presetId ? { presetId: provider.presetId } : {}), ...(provider.variantId ? { variantId: provider.variantId } : {}),
  models: provider.models.map(model => ({ connectionId: model.connectionId, expectedVersion: model.version, modelId: model.modelId,
    protocol: model.protocol, baseUrl: model.baseUrl,
    enabled: model.modelEnabled ?? model.enabled, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    ...(model.imageInput === undefined ? {} : { imageInput: model.imageInput }),
    ...(model.reasoningSource === 'manual' ? { reasoningLevels: model.reasoningLevels ?? [] } : {}),
    ...(model.contextWindow === undefined ? {} : { contextWindow: formatModelTokenCount(model.contextWindow) }),
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: formatModelTokenCount(model.maxOutputTokens) }) })),
} : { providerId: crypto.randomUUID(), name: '', baseUrl: '', protocol: 'chat-completions', enabled: true, models: [] }

const scopeOf = (draft: Pick<Draft, 'presetId' | 'variantId'>) => `${draft.presetId ?? 'custom'}:${draft.variantId ?? ''}`
const profileRouteKey = (route: { protocol: string; baseUrl: string; modelId: string }) => JSON.stringify([route.protocol, route.baseUrl, route.modelId.trim()])
function refreshMessage(state: ModelDirectoryRefresh | undefined, source: 'supplier' | 'catalogue'): string {
  if (!state?.error) return ''
  const subject = source === 'supplier' ? '供应商模型列表' : '公共模型资料（models.dev）'
  const status = state.httpStatus ? `（HTTP ${state.httpStatus}）` : ''
  const retained = '当前列表和填写已保留。'
  const retry = state.retryAt && new Date(state.retryAt).getTime() > Date.now()
    ? `请在 ${new Date(state.retryAt).toLocaleTimeString('zh-CN', { hour12: false })} 后重试。` : '可点击“更新模型资料”重试。'
  if (state.httpStatus === 404) return `${subject}接口不存在${status}。${source === 'supplier' ? '请核对 Base URL，或手动填写模型 ID。' : '请稍后重试。'}${retained}`
  if (state.httpStatus === 405) return `${subject}接口不支持列表查询${status}。${source === 'supplier' ? '可手动填写模型 ID。' : '请稍后重试。'}${retained}`
  if (state.error === 'unauthorized') return source === 'supplier'
    ? `供应商拒绝读取模型列表${status}，请核对当前接入方式的 API Key 和账号权限。${retained}`
    : `${subject}拒绝访问${status}。${retained}${retry}`
  if (state.error === 'rate-limited') return `${source === 'supplier' ? '供应商' : '公共模型资料源'}暂时限流${status}，${source === 'supplier' ? '模型列表' : '资料'}未更新。${retained}${retry}`
  if (state.error === 'timeout') return `${subject}请求超时。${retained}${retry}`
  if (state.error === 'offline') return `${subject}连接失败，请检查网络或代理设置。${retained}${retry}`
  if (state.error === 'invalid-response') return `${subject}返回了无法识别的数据${status}。${source === 'supplier' ? '请核对接入地址，或手动填写模型 ID。' : ''}${retained}${retry}`
  return `${subject}${state.httpStatus && state.httpStatus >= 500 ? '服务暂时异常' : '请求未成功'}${status}。${retained}${retry}`
}

export function ModelProviderDialog({ provider, addModel = false, onClose, onSave, onRead, onReadCredential, onProfiles, onDirectory, onCheck, onConnectionTest }: {
  provider: ModelProvider | null; attempts: ModelAttempt[]; addModel?: boolean; onClose(): void
  onSave(input: SaveModelProvider): Promise<ModelProvider>; onRead(providerId: string): Promise<ModelProvider | null>
  onReadCredential(connectionId: string, version: number): Promise<string>
  onProfiles(input: { baseUrl: string; protocol: ModelConfiguration['protocol']; modelIds: string[]; refresh?: boolean }): Promise<{ profiles: ModelProfile[]; stale: boolean }>
  onDirectory?: ReadModelDirectory | undefined
  onCheck: CheckModelConfiguration; onCancel(attempt: ModelAttempt): Promise<void>
  onConnectionTest?: TestSupplierConnection
}) {
  const [draft, setDraft] = useState<Draft>(() => fromProvider(provider))
  const currentDraft = useRef(draft)
  useLayoutEffect(() => { currentDraft.current = draft }, [draft])
  const editableModelIds = useRef(new Set(draft.models.map(model => model.connectionId)))
  const [profiles, setProfiles] = useState<Map<string, ModelProfile>>(() => new Map()), [refresh, setRefresh] = useState(0), [profileBusy, setProfileBusy] = useState(false)
  const [profileNotice, setProfileNotice] = useState('')
  const [apiKey, setApiKey] = useState(''), [saving, setSaving] = useState(false), [dirty, setDirty] = useState(false)
  const [closeConfirm, setCloseConfirm] = useState(false)
  const [lookupKey, setLookupKey] = useState<string | undefined>(provider?.hasCredential ? undefined : '')
  const [credentialReady, setCredentialReady] = useState(!provider?.hasCredential), [credentialError, setCredentialError] = useState('')
  const [credentialRetry, setCredentialRetry] = useState(0), [addressTouched, setAddressTouched] = useState(false)
  const [error, storeError] = useState('')
  const errorToast = useRef<string | number | undefined>(undefined)
  const setError = (message: string) => {
    storeError(message)
    if (message) errorToast.current = toast.error(message, { id: errorToast.current, duration: 8000 })
    else if (errorToast.current !== undefined) toast.dismiss(errorToast.current)
  }
  const [recovery, setRecovery] = useState<'conflict' | 'unknown' | null>(null), [latest, setLatest] = useState<ModelProvider | null>(null)
  const [reading, setReading] = useState(false), [notice, setNotice] = useState('')
  const dialogContent = useRef<HTMLDivElement>(null)
  const epoch = useRef(0), live = useRef(true), baseline = useRef(provider)
  const credentialDrafts = useRef(new Map<string, string>()), scope = scopeOf(draft), scopeRef = useRef(scope); scopeRef.current = scope
  const savedScope = useRef(scopeOf(fromProvider(provider)))
  const providerDrafts = useRef(new Map<string, Draft>()), modelDrafts = useRef(new Map<string, ModelDraft>())
  const presetModelDrafts = useRef(new Map<string, ModelDraft>())
  const removedModelDrafts = useRef(new Map<string, ModelDraft>())
  // Persist join order independently of positions frozen for this editing session.
  const memberOrders = useRef(new Map([[scope, draft.models.map(model => model.connectionId)]]))
  const choiceOrders = useRef(new Map<string, ModelChoicePosition[]>())
  const [manualPriorities, setManualPriorities] = useState<Record<string, string[]>>({})
  const [revealModel, setRevealModel] = useState<{ scope: string; key: string } | null>(null)
  const [modelQuery, setModelQuery] = useState('')
  const [expandedModels, setExpandedModels] = useState(() => new Set<string>())
  const preset = useMemo(() => modelProviderPresets.find(item => item.id === draft.presetId), [draft.presetId])
  const variant = useMemo(() => getModelPreset(draft.presetId ?? 'custom', draft.variantId), [draft.presetId, draft.variantId])
  const savedKey = provider?.models.find(model => model.hasCredential) ?? provider?.credentialConnection
  const tests = useModelConfigurationTests(onCheck)
  const supplier = useSupplierChecks({ presetId: draft.presetId ?? 'custom', ...(draft.variantId ? { variantId: draft.variantId } : {}),
    baseUrl: draft.baseUrl, protocol: draft.protocol, credential: apiKey.trim() ? { action: 'replace', value: apiKey.trim() } : { action: 'clear' } }, onConnectionTest, onDirectory)
  useEffect(() => { tests.invalidate() }, [supplier.key])
  const choiceScope = preset ? scope : supplier.key
  const directory = useModelDirectory(onDirectory, {
    presetId: draft.presetId ?? 'custom', ...(draft.variantId ? { variantId: draft.variantId } : {}),
    ...(!modelBaseUrlError(draft.baseUrl, draft.protocol) ? { baseUrl: draft.baseUrl, protocol: draft.protocol } : {}),
    credential: lookupKey === undefined ? { action: 'keep' } : lookupKey.trim() ? { action: 'replace', value: lookupKey.trim() } : { action: 'clear' },
    ...(scope === savedScope.current && savedKey ? { savedCredential: { connectionId: savedKey.connectionId, version: savedKey.version } } : {}),
    ...(!preset ? { source: 'catalogue' as const } : {}),
  })
  const entries: readonly ModelDirectoryEntry[] = useMemo(() => {
    const all = new Map((directory.data?.models ?? variant?.models ?? []).map(model => [model.modelId, model]))
    for (const model of supplier.fetched?.models ?? []) all.set(model.modelId, { ...all.get(model.modelId), ...model })
    return [...all.values()]
  }, [directory.data?.models, variant, supplier.fetched?.models])
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
  useToastFeedback(directoryNotice || profileNotice)
  useToastFeedback(notice, 'info')
  const modelChoices = useMemo(() => {
    const choices = new Map<string, ModelChoice>((preset ? entries : supplier.fetched?.models ?? []).map(entry => [entry.modelId, entry]))
    for (const [key, model] of presetModelDrafts.current) if (key.startsWith(choiceScope + ':') && !choices.has(model.modelId))
      choices.set(model.modelId, { modelId: model.modelId, connectionId: model.connectionId })
    for (const [key, model] of removedModelDrafts.current) if (key.startsWith(scope + ':') && !choices.has(model.modelId))
      choices.set(model.modelId, { modelId: model.modelId, connectionId: model.connectionId })
    for (const model of draft.models) if ((model.modelId.trim() || !preset && editableModelIds.current.has(model.connectionId)) && !choices.has(model.modelId))
      choices.set(model.modelId, { modelId: model.modelId })
    if (preset) return [...choices.values()]
    return [...choices.values()].flatMap(entry => {
      const selected = draft.models.filter(model => model.modelId === entry.modelId)
      return selected.length ? selected.map(model => ({ ...entry, connectionId: model.connectionId })) : [entry]
    })
  }, [entries, draft.models, choiceScope, scope, preset, supplier.fetched?.models])
  const configuredModels = draft.models.filter(model => !preset || model.expectedVersion > 0 || model.modelId.trim())
  const rowKeyOf = (modelId: string, connectionId?: string) => !preset && connectionId && editableModelIds.current.has(connectionId)
    ? `custom:${connectionId}` : `model:${modelId}`
  const expansionKeyOf = (model: ModelDraft) => `${scope}:${rowKeyOf(model.modelId, model.connectionId)}`
  const choiceRows = modelChoices.map(entry => {
    const model = draft.models.find(model => entry.connectionId ? model.connectionId === entry.connectionId : model.modelId === entry.modelId)
    const connectionId = model?.connectionId ?? entry.connectionId
    return { entry, model, key: rowKeyOf(entry.modelId, connectionId), modelId: entry.modelId, candidate: !model,
      editableId: !preset && Boolean(connectionId && editableModelIds.current.has(connectionId)) }
  })
  const initialKeys = configuredModels.flatMap(model => choiceRows.filter(row => row.model?.connectionId === model.connectionId).map(row => row.key))
  const nextChoiceOrder = reconcileModelChoices(choiceOrders.current.get(scope), inIdOrder(choiceRows, initialKeys, row => row.key)
    .map(({ key, modelId, candidate }) => ({ key, modelId, candidate })))
  const priorities = manualPriorities[scope] ?? []
  const choiceOrder = inIdOrder(nextChoiceOrder, priorities, row => row.key).map(row => priorities.includes(row.key) ? { ...row, candidate: false } : row)
  const orderedChoices = inIdOrder(choiceRows, choiceOrder.map(row => row.key), row => row.key)
  // Field labels follow the unfiltered on-screen order, never the saved join order.
  const fieldIndexes = new Map(orderedChoices.filter(row => row.model).map((row, index) => [row.model!.connectionId, index]))
  useLayoutEffect(() => {
    choiceOrders.current.set(scope, choiceOrder)
    if (!memberOrders.current.has(scope)) memberOrders.current.set(scope, draft.models.map(model => model.connectionId))
  })
  useLayoutEffect(() => {
    if (!revealModel || revealModel.scope !== scope) return
    const card = [...(dialogContent.current?.querySelectorAll<HTMLElement>('[data-model-choice-key]') ?? [])]
      .find(card => card.dataset.modelChoiceKey === revealModel.key)
    card?.querySelector('.st-model-choice-head')?.scrollIntoView({ block: 'nearest' })
  }, [revealModel, scope])
  const matchesModelQuery = (modelId: string, name = '') => `${modelId} ${name}`.toLowerCase().includes(modelQuery.trim().toLowerCase())
  const pending = useRef<{ input: SaveModelProvider; generation: number } | null>(null), submitting = useRef(false)
  const returnFocus = useRef(document.activeElement as HTMLElement | null)
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
    const model = provider?.models.find(model => model.hasCredential) ?? provider?.credentialConnection
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
  const changed = () => { epoch.current++; setDirty(true); setNotice(''); if (!recovery) setError('') }
  const change = (patch: Partial<Draft>) => { changed(); setDraft(previous => ({ ...previous, ...patch })) }
  const changeModel = (id: string, patch: Partial<ModelDraft>) => { tests.invalidate(id); change({ models: draft.models.map(model => model.connectionId === id ? { ...model, ...patch } : model) }) }
  const expandModel = (key: string, expanded: boolean) => setExpandedModels(previous => {
    const next = new Set(previous); if (expanded) next.add(key); else next.delete(key); return next
  })
  const selectModel = (modelId: string, selected: boolean, manual = false) => {
    const key = `${choiceScope}:${modelId}`, existing = draft.models.find(model => model.modelId === modelId)
    if (!selected) {
      if (!existing) return false
      presetModelDrafts.current.set(key, existing)
      if (existing.expectedVersion > 0) removedModelDrafts.current.set(`${scope}:${existing.connectionId}`, existing)
      tests.invalidate(existing.connectionId)
      const remaining = draft.models.filter(model => model.connectionId !== existing.connectionId)
      change({ models: remaining }); expandModel(expansionKeyOf(existing), false)
      return true
    }
    let selectedModel = existing
    if (!selectedModel) {
      const remembered = presetModelDrafts.current.get(key) ?? [...removedModelDrafts.current]
        .find(([key, model]) => key.startsWith(scope + ':') && model.modelId === modelId)?.[1]
      const empty = draft.models.find(model => !model.modelId.trim())
      const model: ModelDraft = remembered ?? { ...(empty ?? newModel()), modelId, ...(preset ? { protocol: undefined, baseUrl: undefined,
        contextWindow: undefined, maxOutputTokens: undefined, reasoningEffort: undefined, reasoningLevels: undefined } : {}) }
      const others = draft.models.filter(item => item.connectionId !== model.connectionId && (item.modelId.trim() || item.expectedVersion > 0))
      if (others.length >= 64) { setError('每个供应商最多配置 64 个模型。'); return false }
      const order = memberOrders.current.get(scope) ?? draft.models.map(model => model.connectionId)
      const restore = model.expectedVersion > 0 && order.includes(model.connectionId)
      const nextOrder = restore ? order : [model.connectionId, ...order.filter(id => id !== model.connectionId)]
      memberOrders.current.set(scope, nextOrder)
      if (manual && !preset) editableModelIds.current.add(model.connectionId)
      if (manual && !restore) {
        const rowKey = rowKeyOf(modelId, model.connectionId)
        setManualPriorities(previous => ({ ...previous, [scope]: [rowKey, ...(previous[scope] ?? []).filter(key => key !== rowKey)] }))
      }
      change({ models: inIdOrder([...others, model], nextOrder, model => model.connectionId) })
      selectedModel = model
    }
    removedModelDrafts.current.delete(`${scope}:${selectedModel.connectionId}`)
    if (manual) {
      expandModel(expansionKeyOf(selectedModel), true)
      setRevealModel({ scope, key: rowKeyOf(modelId, selectedModel.connectionId) })
    }
    void directory.ensureFresh(); return true
  }
  const profileOf = (model: ModelDraft): ModelProfile => {
    const route = { ...modelRoute(model), modelId: model.modelId, presetId: draft.presetId, variantId: draft.variantId }
    // Keep invalid manual declarations editable; validation below explains the
    // problem without letting profile resolution unmount the entire form.
    let fallback = resolveModelProfile(route)
    if (model.reasoningLevels !== undefined) {
      try { fallback = resolveModelProfile({ ...route, reasoningLevels: model.reasoningLevels }) } catch { /* retain the reference profile */ }
    }
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
    if (model.reasoningLevels !== undefined) return { ...base, efforts: ['auto', ...new Set(model.reasoningLevels)], source: 'manual',
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
  const imageOf = (model: ModelDraft) => {
    if (model.imageInput !== undefined) return model.imageInput
    const route = modelRoute(model)
    const saved = provider?.models.find(saved => saved.connectionId === model.connectionId && saved.modelId === model.modelId
      && saved.baseUrl === route.baseUrl && saved.protocol === route.protocol)
    return saved ? modelAllowsImages(saved) : false
  }
  const inputOf = (model: ModelDraft): ModelInput => ({ ...model, ...modelRoute(model), ...capacityOf(model),
    ...(effortOf(model) ? { reasoningEffort: effortOf(model) } : {}) })
  const chooseModel = (model: ModelDraft, modelId: string) => {
    if (model.modelId.trim() === modelId.trim()) { changeModel(model.connectionId, { modelId }); return }
    modelDrafts.current.set(`${scope}:${model.connectionId}:${model.modelId.trim()}`, model)
    const remembered = modelDrafts.current.get(`${scope}:${model.connectionId}:${modelId.trim()}`)
    changeModel(model.connectionId, remembered ? { ...remembered, modelId, expectedVersion: model.expectedVersion } : {
      modelId, contextWindow: undefined, maxOutputTokens: undefined, reasoningEffort: undefined, reasoningLevels: undefined,
      imageInput: false,
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
    changed(); setDraft(next); setAddressTouched(false); setCredentialError(''); setModelQuery('')
    const secret = credentialDrafts.current.get(destination)
    setApiKey(secret ?? ''); setLookupKey(secret ?? (destination === savedScope.current && provider?.hasCredential ? undefined : ''))
    setCredentialReady(secret !== undefined || destination !== savedScope.current || !provider?.hasCredential)
  }
  const routeOf = (model: ModelDraft): ModelConfiguration => {
    const profile = profileOf(model), old = provider?.models.find(saved => saved.connectionId === model.connectionId)
    const route = modelRoute(model), effort = effortOf(model)
    return { connectionId: model.connectionId, name: draft.name.trim() || model.modelId.trim() || '模型测试', ...route, path: paths[route.protocol],
      ...(draft.presetId ? { presetId: draft.presetId } : {}), ...(draft.variantId ? { variantId: draft.variantId } : {}),
      modelId: model.modelId, enabled: draft.enabled && model.enabled, dialect: effort === undefined && old ? old.dialect : profile.dialect,
      parameterMode: effort === undefined ? old?.parameterMode ?? 'plain' : !['auto', 'none'].includes(effort) ? 'thinking' : 'plain',
      ...(effort ? { reasoningEffort: effort } : {}), reasoningLevels: model.reasoningLevels ?? profile.efforts.filter(level => level !== 'auto'),
      ...capacityOf(model), imageInput: imageOf(model) }
  }
  const testedRoutes = useRef(new Map<string, string>())
  const routeSignatures = JSON.stringify(draft.models.map(model => {
    const { name: _name, ...configuration } = routeOf(model)
    return [model.connectionId, JSON.stringify(configuration)]
  }))
  useEffect(() => {
    const next = new Map<string, string>(JSON.parse(routeSignatures))
    for (const [id, signature] of testedRoutes.current) if (next.get(id) !== signature) tests.expire(id)
    testedRoutes.current = next
  }, [routeSignatures])
  const credential = () => apiKey.trim() ? { action: 'replace' as const, value: apiKey.trim() } : { action: 'clear' as const }
  const valid = () => {
    setAddressTouched(true)
    if (addressIssue) { setError(addressIssue); return false }
    if (!configuredModels.length && !provider || preset && configuredModels.some(model => !model.modelId.trim())) {
      setError(configuredModels.length ? '原配置中还有模型未匹配，请继续选择型号。' : '请至少选择一个模型，或手动添加模型 ID。'); return false
    }
    const missingModelId = !preset && configuredModels.find(model => !model.modelId.trim())
    if (missingModelId) {
      setModelQuery(''); expandModel(expansionKeyOf(missingModelId), true)
      setError('请填写模型 ID。'); return false
    }
    const invalidCapacity = configuredModels.find(model => modelTokenCountError(model.contextWindow) || modelTokenCountError(model.maxOutputTokens))
    if (invalidCapacity) {
      setModelQuery('')
      expandModel(expansionKeyOf(invalidCapacity), true)
      setError('请检查上下文窗口和最大输出的填写。'); return false
    }
    const duplicate = new Set(configuredModels.map(model => model.modelId.trim())).size !== configuredModels.length
    const unsupported = configuredModels.find(model => { const entry = entries.find(item => item.modelId === model.modelId.trim());
      return entry?.protocols && !entry.protocols.includes(modelRoute(model).protocol) })
    if (unsupported) { setError(`当前接入方式尚未提供 ${unsupported.modelId} 的兼容协议，请选择其他型号或使用自定义连接。`); return false }
    const invalidReasoning = configuredModels.find(model => modelReasoningConfigurationError(routeOf(model), capacityOf(model).maxOutputTokens))
    const reasoning = invalidReasoning && modelReasoningConfigurationError(routeOf(invalidReasoning), capacityOf(invalidReasoning).maxOutputTokens)
    if (invalidReasoning) { setModelQuery(''); expandModel(expansionKeyOf(invalidReasoning), true) }
    if (duplicate || reasoning) { setError(duplicate ? '同一供应商内的模型 ID 不能重复。' : reasoning!); return false }
    return true
  }
  const test = async (model: ModelDraft) => {
    if (!credentialReady) return
    const route = modelRoute(model)
    const issue = modelBaseUrlError(route.baseUrl, route.protocol) ?? (!apiKey.trim() ? '请填写 API Key。' : undefined)
      ?? (!model.modelId.trim() ? '请填写模型 ID。' : undefined)
      ?? modelTokenCountError(model.contextWindow) ?? modelTokenCountError(model.maxOutputTokens)
      ?? modelReasoningConfigurationError(routeOf(model), capacityOf(model).maxOutputTokens)
    if (issue) { tests.fail(model.connectionId, issue); return }
    try {
      const configuration = modelConfigurationSchema.parse(routeOf(model))
      await tests.run(configuration, { draft: configuration, credential: credential() })
    } catch { tests.fail(model.connectionId, '请核对当前模型的地址、协议和参数。') }
  }
  const submit = async (operation: NonNullable<typeof pending.current>) => {
    if (submitting.current) return
    const wasUnknown = recovery === 'unknown'; submitting.current = true; pending.current = operation; setSaving(true); setError('')
    try {
      const saved = await onSave(operation.input)
      if (live.current) {
        pending.current = null; baseline.current = saved; setRecovery(null); setLatest(null)
        const savedScope = scopeOf(operation.input)
        for (const removed of operation.input.removedModels ?? []) {
          const key = `${savedScope}:${removed.connectionId}`
          const remembered = removedModelDrafts.current.get(key)
          if (remembered) removedModelDrafts.current.set(key, { ...remembered, expectedVersion: removed.expectedVersion + 1 })
          for (const [key, remembered] of presetModelDrafts.current) if (remembered.connectionId === removed.connectionId)
            presetModelDrafts.current.set(key, { ...remembered, expectedVersion: removed.expectedVersion + 1 })
          if (!currentDraft.current.models.some(model => model.connectionId === removed.connectionId))
            memberOrders.current.set(savedScope, (memberOrders.current.get(savedScope) ?? []).filter(id => id !== removed.connectionId))
        }
        toast.success('供应商已保存')
        if (operation.generation === epoch.current) { setApiKey(''); onClose() }
        else {
          setDraft(previous => {
            const models = previous.models.map(model => {
              const removed = operation.input.removedModels?.find(removed => removed.connectionId === model.connectionId)
              return { ...model, expectedVersion: saved.models.find(saved => saved.connectionId === model.connectionId)?.version
                ?? (removed ? removed.expectedVersion + 1 : model.expectedVersion) }
            })
            for (const item of fromProvider(saved).models) if (!models.some(model => model.connectionId === item.connectionId)
              && !removedModelDrafts.current.has(`${scopeOf(previous)}:${item.connectionId}`)) models.push(item)
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
      const removedModels = (base?.models ?? []).filter(model => removedModelDrafts.current.has(`${scope}:${model.connectionId}`))
        .map(model => ({ connectionId: model.connectionId, expectedVersion: model.version }))
      const removedIds = new Set(removedModels.map(model => model.connectionId))
      const models: ModelInput[] = configuredModels.map(model => {
        const saved = base?.models.find(saved => saved.connectionId === model.connectionId)
        return { ...inputOf(model), enabled: saved ? saved.modelEnabled ?? saved.enabled : model.enabled, expectedVersion: saved?.version ?? model.expectedVersion }
      })
      // Preserve models added by another editor while applying this editor's explicit changes.
      for (const saved of base?.models ?? []) if (!models.some(model => model.connectionId === saved.connectionId) && !removedIds.has(saved.connectionId))
        models.push(inputOf(fromProvider({ ...base!, models: [saved] }).models[0]!))
      const input = saveModelProviderSchema.parse({ ...draft, models, ...(removedModels.length ? { removedModels } : {}), enabled: base?.enabled ?? draft.enabled,
        requestId: crypto.randomUUID(), expectedVersion: base?.version ?? 0, credential: credential() })
      await submit({ input, generation: epoch.current })
    } catch { setError('请检查地址、协议、模型及密钥填写，当前输入已保留。') }
  }
  const readLatest = async () => {
    if (reading || submitting.current || pending.current) return
    setReading(true)
    try {
      const saved = await onRead(draft.providerId)
      if (live.current) {
        setLatest(saved)
        setError(saved ? '' : '未找到原配置，当前草稿已保留，请稍后重新读取。')
        if (saved) setNotice('请核对最新版本与当前草稿；确认后才会按当前草稿保存。')
      }
    } catch { if (live.current) { setError('无法读取最新版本，当前草稿和密钥操作已保留。请重新读取后再确认。'); setLatest(null) } }
    finally { if (live.current) setReading(false) }
  }
  const refreshDirectory = async () => {
    if (onDirectory) await directory.refresh()
    setRefresh(value => value + 1)
  }
  const renderModelFields = (model: ModelDraft, index: number, showModelId = true) => {
    const profile = profileOf(model)
    const run = tests.runs[model.connectionId]
    return <><ConnectionModelFields modelId={model.modelId} idLabel={index === 0 ? '模型 ID' : `模型 ID ${index + 1}`} showModelId={showModelId}
      effort={effortOf(model) ?? 'auto'} efforts={profile.efforts} source={profile.source} manualLevels={model.reasoningLevels}
      contextWindow={model.contextWindow} maxOutputTokens={model.maxOutputTokens}
      referenceContext={profile.contextWindow} referenceOutput={profile.maxOutputTokens} error={modelReasoningConfigurationError(routeOf(model), capacityOf(model).maxOutputTokens)}
      imageInput={imageOf(model)} onImageInput={imageInput => changeModel(model.connectionId, { imageInput })}
      onId={modelId => chooseModel(model, modelId)} onEffort={value => changeModel(model.connectionId, { reasoningEffort: value as ReasoningEffort })}
      onLevels={value => changeModel(model.connectionId, { reasoningLevels: value as ModelInput['reasoningLevels'] })}
      onCapacity={patch => changeModel(model.connectionId, patch)} />
      <div className="st-model-test" aria-label={`${model.modelId || '当前模型'}的模型测试`}>
        <ModelTestButton kind="model" running={run?.status === 'running'} disabled={!credentialReady}
          onTest={() => void test(model)} onStop={() => tests.stop(model.connectionId)} />
        {run && ['failed', 'unverified'].includes(run.status) && <ModelTestFeedback {...run} onRetry={() => void test(model)} />}
      </div></>
  }
  const addManualModel = () => {
    const modelId = modelQuery.trim()
    if (!modelId || modelId.length > 200) { setError('模型 ID 需为 1–200 个字符。'); return }
    if (!selectModel(modelId, true, true)) return
    setModelQuery('')
    dialogContent.current?.querySelector<HTMLInputElement>('.st-model-list-search input')?.focus({ preventScroll: true })
  }
  const testRunning = Object.values(tests.runs).some(run => run.status === 'running') || supplier.connection?.status === 'running'
  const requestClose = () => {
    if (saving) { setNotice('正在保存供应商，完成后再关闭。'); return }
    if (dirty || recovery || testRunning) { setCloseConfirm(true); return }
    onClose()
  }
  const closeDescription = [
    dirty ? '当前草稿还没有保存。' : '',
    recovery ? '原保存结果还没有核对；关闭不会撤销可能已经生效的原请求。' : '',
    testRunning ? '正在进行的连接或模型测试会停止。' : '',
  ].filter(Boolean).join('')
  return <><Dialog.Root open onOpenChange={open => { if (!open) requestClose() }}><Dialog.Portal>
    <Dialog.Overlay className="overlay pc-overlay" /><Dialog.Content ref={dialogContent} className="st-dialog product-connection-dialog" aria-describedby={undefined}
      aria-busy={saving || reading || undefined}
      onOpenAutoFocus={event => {
        if (!addModel) return
        event.preventDefault(); dialogContent.current?.querySelector<HTMLInputElement>('.st-model-list-search input')?.focus()
      }}
      onEscapeKeyDown={event => {
        // Radix handles Escape on document capture, before the nested Base UI menu.
        if (event.isComposing || closeConfirm || dialogContent.current?.querySelector('[role="combobox"][aria-expanded="true"], [role="tooltip"][data-open]')) event.preventDefault()
        else if (!closeConfirm) { event.preventDefault(); requestClose() }
      }}
      onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus() }}>
      <div className="st-dialog-head"><Dialog.Title className="st-dialog-title">{provider ? '编辑供应商' : '添加供应商'}</Dialog.Title>
        <button type="button" className="pc-x" aria-label="关闭" onClick={requestClose}><Icon name="close" size={18} /></button></div>
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
        {!credentialReady && !credentialError && <SettingsStatus tone="loading" title="正在读取已保存的密钥"
          description="读取完成前不能保存或测试；当前草稿会保留。" />}
        {credentialError && <SettingsStatus tone="error" title="已保存的密钥未能读取"
          description={credentialError} action={<button type="button" className="outline"
            onClick={() => setCredentialRetry(value => value + 1)}>重新读取密钥</button>} />}
        <div className="st-connection-test">
          <ModelTestButton kind="connection" running={supplier.connection?.status === 'running'} disabled={!credentialReady || !onConnectionTest}
            onTest={() => void supplier.runConnection()} onStop={supplier.stopConnection} />
          {supplier.connection && ['failed', 'unverified'].includes(supplier.connection.status) && <ModelTestFeedback {...supplier.connection}
            onRetry={() => void supplier.runConnection()} />}
        </div>
        <div className="st-route-list-head"><span className="st-field-label">模型</span><button type="button" className="st-model-directory-refresh" aria-busy={directory.visibleBusy}
          disabled={onDirectory ? directory.busy || retryBlocked : profileBusy || Boolean(addressIssue) || !draft.models.some(model => model.modelId.trim())}
          title={retryBlocked ? `可在 ${new Date(manualReadyAt).toLocaleTimeString('zh-CN', { hour12: false })} 再次更新` : undefined}
          onClick={() => void refreshDirectory()}>{directory.visibleBusy ? '正在更新…'
            : retryBlocked ? directoryFailed ? '稍后重试' : '刚刚更新' : '更新模型资料'}<Icon name="refresh" size={14} /></button></div>
        <div className="st-directory-feedback" aria-live="polite" aria-atomic="true">
          {(directoryNotice || profileNotice) && <p className="detail">
            {directoryNotice || profileNotice}
          </p>}
        </div>
        <div className="st-model-picker">
          <div className="st-model-list-search-row"><div className="st-model-list-search"><Icon name="minimalistic-magnifier" size={16} /><TextInput aria-label="搜索或输入模型 ID" placeholder="搜索模型或输入 ID"
            value={modelQuery} onChange={event => setModelQuery(event.target.value)} onFocus={() => { setLookupKey(apiKey); void directory.ensureFresh() }}
            onKeyDown={event => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && modelQuery.trim()) { event.preventDefault(); addManualModel() }
            }} /></div><button type="button" className="outline st-model-list-add" disabled={!modelQuery.trim()} onClick={addManualModel}><Icon name="add" size={16} />添加模型</button>
          {!preset && <button type="button" className="outline st-model-list-add st-model-list-fetch" aria-busy={supplier.fetched?.busy ?? false}
            disabled={!credentialReady || !onDirectory || supplier.fetched?.busy}
            title={!onDirectory ? '模型列表服务暂不可用' : undefined}
            onClick={() => void supplier.fetchModels()}><Icon name="download-minimalistic" size={16} />{supplier.fetched?.busy ? '正在拉取…' : '拉取模型'}</button>}</div>
          {!preset && supplier.fetched?.error && <ModelTestFeedback status="failed" title="拉取模型未完成" {...supplier.fetched.error}
            onRetry={() => void supplier.fetchModels()} />}
          <div className="st-model-choice-list" role="group" aria-label={preset ? '预设模型' : '自定义模型'}>
            {orderedChoices.filter(({ entry }) => matchesModelQuery(entry.modelId, entry.name)).map(({ entry, model, key, editableId }) => {
              const index = model ? fieldIndexes.get(model.connectionId)! : -1
              return <ModelChoiceCard key={key} modelId={entry.modelId} name={entry.name} choiceKey={key}
                selected={Boolean(model)} expanded={expandedModels.has(`${scope}:${key}`)}
                onSelect={selected => selectModel(entry.modelId, selected)}
                onExpand={expanded => expandModel(`${scope}:${key}`, expanded)} invalid={Boolean(model && (modelTokenCountError(model.contextWindow) || modelTokenCountError(model.maxOutputTokens)))}
                action={editableId && model?.expectedVersion === 0 ? <button type="button" className="st-iconbtn" aria-label={`移除模型 ${index + 1}`}
                  onClick={() => {
                    change({ models: draft.models.filter(item => item.connectionId !== model.connectionId) })
                    dialogContent.current?.querySelector<HTMLInputElement>('.st-model-list-search input')?.focus({ preventScroll: true })
                  }}><Icon name="close" size={14} /></button> : undefined}>
                {model && renderModelFields(model, index, editableId)}
              </ModelChoiceCard>
            })}
            {!modelChoices.some(entry => matchesModelQuery(entry.modelId, entry.name))
              && (modelQuery.trim() || preset || supplier.fetched && !supplier.fetched.busy && !supplier.fetched.error)
              && <p className="st-model-list-empty" role="status">{modelQuery.trim() ? '没有匹配的型号' : preset ? '暂无模型列表' : '供应商未返回模型，可手动输入模型 ID 添加'}</p>}
          </div>
        </div>
        {recovery && error && <p className="detail">{error}</p>}
        {notice && <p className="detail">{notice}</p>}
        {recovery === 'unknown' && <button type="button" className="outline" disabled={saving} aria-busy={saving || undefined}
          onClick={() => { if (pending.current) void submit(pending.current) }}>{saving ? '正在核对…' : '核对原提交'}</button>}
        {recovery === 'conflict' && <>
          <button type="button" className="outline" disabled={reading || saving} aria-busy={reading || undefined}
            onClick={() => void readLatest()}>{reading ? '正在读取…' : '读取最新版本'}</button>
          {latest && <div className="detail" role="region" aria-label="配置冲突核对">
            <p>已保存版本 {latest.version} · {latest.hasCredential ? '密钥已保存' : '尚未保存密钥'}</p>
            <p>名称：已保存「{latest.name}」；当前草稿「{draft.name}」</p>
            <p>地址：已保存「{latest.baseUrl}」；当前草稿「{draft.baseUrl}」</p>
            <p>模型：已保存「{latest.models.map(model => model.modelId).join('、')}」；当前草稿「{draft.models.map(model => model.modelId).join('、')}」</p>
            <p>{apiKey.trim() ? '保存后使用输入框中的当前密钥。' : '输入框已清空，保存后移除密钥。'}</p>
            <button type="button" className="outline" disabled={saving || reading} aria-busy={saving || undefined}
              onClick={() => void save(latest)}>{saving ? '正在保存…' : '确认按当前草稿重试'}</button>
          </div>}
        </>}
      </div>
      <div className="st-dialog-foot">
        <div className="st-dialog-foot-right">
          <button type="button" className="outline" disabled={saving} onClick={requestClose}>取消</button>
          <button type="button" className="primary" disabled={saving || !credentialReady || recovery !== null}
            aria-busy={saving || undefined} onClick={() => void save()}>
            {saving && <span className="st-spinner" aria-hidden="true" />}{saving ? '正在保存…' : '保存'}
          </button></div></div>
    </Dialog.Content></Dialog.Portal></Dialog.Root>
    <ConfirmationDialog open={closeConfirm} title={dirty ? '放弃未保存的修改？' : '关闭供应商设置？'}
      description={closeDescription} confirmLabel={dirty ? '放弃修改' : '关闭'}
      onClose={() => setCloseConfirm(false)} onConfirm={() => { setCloseConfirm(false); onClose() }} />
  </>
}
