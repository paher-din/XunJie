import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { modelBaseUrlError, modelConfigurationSchema, saveModelProviderSchema, resolveModelProfile, modelReasoningError,
  type ModelConfiguration, type ModelProvider, type ModelProfile, type ModelAttempt, type ModelCheckInput, type SaveModelProvider, type ReasoningEffort } from '@xunjie/contracts/model-connections'
import { ConnectionModelFields } from '@xunjie/ui/settings'
import { ProviderIdentityFields } from './ProviderIdentityFields'
import { Icon } from '../../icons'

type ModelInput = SaveModelProvider['models'][number]
type Draft = Omit<SaveModelProvider, 'requestId' | 'expectedVersion' | 'credential'>
const paths = { 'chat-completions': '/chat/completions', responses: '/responses', messages: '/v1/messages' } as const
const newModel = (): ModelInput => ({ connectionId: crypto.randomUUID(), expectedVersion: 0, modelId: '', enabled: true, reasoningEffort: 'auto' })
const fromProvider = (provider: ModelProvider | null): Draft => provider ? {
  providerId: provider.providerId, name: provider.name, baseUrl: provider.baseUrl, protocol: provider.protocol, enabled: provider.enabled,
  models: provider.models.map(model => ({ connectionId: model.connectionId, expectedVersion: model.version, modelId: model.modelId,
    enabled: model.modelEnabled ?? model.enabled, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
    ...(model.reasoningSource === 'manual' ? { reasoningLevels: model.reasoningLevels ?? [] } : {}),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }) })),
} : { providerId: crypto.randomUUID(), name: '', baseUrl: '', protocol: 'chat-completions', enabled: true, models: [newModel()] }

export function ModelProviderDialog({ provider, attempts, addModel = false, onClose, onSave, onRead, onReadCredential, onProfiles, onCheck, onCancel }: {
  provider: ModelProvider | null; attempts: ModelAttempt[]; addModel?: boolean; onClose(): void
  onSave(input: SaveModelProvider): Promise<ModelProvider>; onRead(providerId: string): Promise<ModelProvider | null>
  onReadCredential(connectionId: string, version: number): Promise<string>
  onProfiles(input: { baseUrl: string; protocol: ModelConfiguration['protocol']; modelIds: string[]; refresh?: boolean }): Promise<{ profiles: ModelProfile[]; stale: boolean }>
  onCheck(source: ModelCheckInput['source']): Promise<ModelAttempt>; onCancel(attempt: ModelAttempt): Promise<void>
}) {
  const [draft, setDraft] = useState<Draft>(() => {
    const value = fromProvider(provider)
    if (addModel) value.models.push(newModel())
    return value
  })
  const [profiles, setProfiles] = useState<ModelProfile[]>([]), [refresh, setRefresh] = useState(0), [profileBusy, setProfileBusy] = useState(false)
  const [profileNotice, setProfileNotice] = useState('')
  const [apiKey, setApiKey] = useState(''), [saving, setSaving] = useState(false)
  const [credentialReady, setCredentialReady] = useState(!provider?.hasCredential), [credentialError, setCredentialError] = useState('')
  const [credentialRetry, setCredentialRetry] = useState(0), [addressTouched, setAddressTouched] = useState(false)
  const [error, setError] = useState(''), [checking, setChecking] = useState(false), [result, setResult] = useState<ModelAttempt | null>(null)
  const [checkId, setCheckId] = useState(draft.models[0]!.connectionId)
  const [recovery, setRecovery] = useState<'conflict' | 'unknown' | null>(null), [latest, setLatest] = useState<ModelProvider | null>(null)
  const [reading, setReading] = useState(false), [notice, setNotice] = useState('')
  const epoch = useRef(0), live = useRef(true), baseline = useRef(provider)
  const refreshed = useRef(0)
  const pending = useRef<{ input: SaveModelProvider; generation: number } | null>(null), submitting = useRef(false)
  const returnFocus = useRef(document.activeElement as HTMLElement | null)
  const currentResult = attempts.find(item => item.attemptId === result?.attemptId) ?? result
  const addressIssue = modelBaseUrlError(draft.baseUrl, draft.protocol)
  const profileKey = JSON.stringify([draft.baseUrl, draft.protocol, draft.models.map(model => model.modelId.trim())])
  useEffect(() => { live.current = true; return () => { live.current = false; epoch.current++ } }, [])
  useEffect(() => {
    const model = provider?.models.find(model => model.hasCredential)
    if (!model) return
    let active = true
    setCredentialReady(false); setCredentialError('')
    void onReadCredential(model.connectionId, model.version).then(value => {
      if (active) { setApiKey(value); setCredentialReady(true) }
    }).catch(() => { if (active) setCredentialError('未能读取已保存的密钥。请重试；若配置已更新，请关闭后重新打开。') })
    return () => { active = false }
  }, [provider, onReadCredential, credentialRetry])
  useEffect(() => {
    let active = true
    setProfiles([]); setProfileNotice('')
    const [baseUrl, protocol, ids] = JSON.parse(profileKey) as [string, ModelConfiguration['protocol'], string[]]
    const modelIds = ids.filter(Boolean)
    if (modelBaseUrlError(baseUrl, protocol) || !modelIds.length) { setProfileBusy(false); return }
    setProfileBusy(true)
    const timer = setTimeout(() => {
      const force = refresh > refreshed.current
      refreshed.current = refresh
      void onProfiles({ baseUrl, protocol, modelIds, refresh: force }).then(value => {
        if (active) { setProfiles(value.profiles); setProfileNotice(value.stale ? '模型资料暂未更新，仍可使用已有资料或手动配置。' : '') }
      }).catch(() => { if (active) setProfileNotice('暂时无法获取模型资料，仍可手填模型 ID 和档位。') })
        .finally(() => { if (active) setProfileBusy(false) })
    }, 400)
    return () => { active = false; clearTimeout(timer) }
  }, [profileKey, refresh, onProfiles])
  const changed = () => { epoch.current++; setResult(null); setNotice(''); if (!recovery) setError('') }
  const change = (patch: Partial<Draft>) => { changed(); setDraft(previous => ({ ...previous, ...patch })) }
  const changeModel = (id: string, patch: Partial<ModelInput>) => change({ models: draft.models.map(model => model.connectionId === id ? { ...model, ...patch } : model) })
  const profileOf = (model: ModelInput): ModelProfile => {
    const fallback = resolveModelProfile({ ...draft, ...model })
    if (model.reasoningLevels !== undefined) return { modelId: model.modelId, dialect: fallback.dialect, efforts: fallback.efforts, source: 'manual' }
    const found = profiles.find(profile => profile.modelId === model.modelId.trim())
    if (found) return found
    const saved = provider?.baseUrl === draft.baseUrl && provider.protocol === draft.protocol
      ? provider.models.find(saved => saved.connectionId === model.connectionId && saved.modelId === model.modelId) : undefined
    if (saved?.reasoningLevels) return { modelId: model.modelId, dialect: fallback.dialect,
      efforts: ['auto', ...saved.reasoningLevels], source: saved.reasoningSource ?? 'unknown' }
    return { modelId: model.modelId, dialect: fallback.dialect, efforts: fallback.efforts, source: fallback.source === 'known' ? 'profile' : 'unknown' }
  }
  const routeOf = (model: ModelInput): ModelConfiguration => {
    const profile = profileOf(model), old = provider?.models.find(saved => saved.connectionId === model.connectionId)
    return { connectionId: model.connectionId, name: draft.name, baseUrl: draft.baseUrl, protocol: draft.protocol, path: paths[draft.protocol],
      modelId: model.modelId, enabled: draft.enabled && model.enabled, dialect: model.reasoningEffort === undefined && old ? old.dialect : profile.dialect,
      parameterMode: model.reasoningEffort && !['auto', 'none'].includes(model.reasoningEffort) ? 'thinking'
        : model.reasoningEffort === 'none' ? 'plain' : old?.parameterMode ?? 'plain',
      ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}), reasoningLevels: profile.efforts.filter(level => level !== 'auto'),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }) }
  }
  const credential = () => apiKey.trim() ? { action: 'replace' as const, value: apiKey.trim() } : { action: 'clear' as const }
  const valid = () => {
    setAddressTouched(true)
    if (addressIssue) return false
    const duplicate = new Set(draft.models.map(model => model.modelId.trim())).size !== draft.models.length
    const reasoning = draft.models.map(model => modelReasoningError(routeOf(model), model.maxOutputTokens)).find(Boolean)
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
      const models = draft.models.map(model => {
        const saved = base?.models.find(saved => saved.connectionId === model.connectionId)
        return { ...model, enabled: saved ? saved.modelEnabled ?? saved.enabled : model.enabled, expectedVersion: saved?.version ?? model.expectedVersion }
      })
      // Preserve models added by another editor while applying this editor's explicit changes.
      for (const saved of base?.models ?? []) if (!models.some(model => model.connectionId === saved.connectionId))
        models.push(fromProvider({ ...base!, models: [saved] }).models[0]!)
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
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}><Dialog.Portal>
    <Dialog.Overlay className="overlay pc-overlay" /><Dialog.Content className="st-dialog product-connection-dialog" aria-describedby={undefined}
      onCloseAutoFocus={event => { event.preventDefault(); if (returnFocus.current?.isConnected) returnFocus.current.focus() }}>
      <div className="st-dialog-head"><Dialog.Title className="st-dialog-title">{provider ? '编辑供应商' : '添加供应商'}</Dialog.Title>
        <Dialog.Close asChild><button type="button" className="pc-x" aria-label="关闭"><Icon name="close" size={18} /></button></Dialog.Close></div>
      <div className="st-dialog-body">
        <ProviderIdentityFields name={draft.name} baseUrl={draft.baseUrl} apiKey={apiKey} snapshotCredential apiKeyDisabled={!credentialReady}
          errors={{ baseUrl: addressTouched ? addressIssue : undefined }} onBaseUrlBlur={() => setAddressTouched(true)}
          protocol={{ value: draft.protocol,
            options: [{ value: 'chat-completions', label: 'OpenAI 兼容' }, { value: 'responses', label: 'OpenAI Responses' }, { value: 'messages', label: 'Anthropic 兼容' }],
            placeholder: draft.protocol === 'messages' ? 'https://api.example.com' : 'https://api.example.com/v1',
            onChange: value => { change({ protocol: value as Draft['protocol'] }); if (draft.baseUrl) setAddressTouched(true) } }}
          onName={name => change({ name })} onBaseUrl={baseUrl => change({ baseUrl })} onApiKey={value => { changed(); setApiKey(value) }} />
        {credentialError && <div><p role="alert">{credentialError}</p><button type="button" className="outline" onClick={() => setCredentialRetry(value => value + 1)}>重新读取密钥</button></div>}
        <div className="st-route-list-head"><h3>模型</h3><button type="button" className="outline st-xs" disabled={profileBusy || Boolean(addressIssue) || !draft.models.some(model => model.modelId.trim())}
          onClick={() => setRefresh(value => value + 1)}>{profileBusy ? '读取资料中…' : '更新模型资料'}</button></div>
        {profileNotice && <p className="detail" role="status">{profileNotice}</p>}
        <div className="st-route-list">{draft.models.map((model, index) => {
          const profile = profileOf(model)
          return <section className="st-route-editor" key={model.connectionId} aria-label={`模型配置 ${index + 1}`}>
            {draft.models.length > 1 && <div className="st-route-editor-head"><span>模型 {index + 1}</span>
              {model.expectedVersion === 0 && <button type="button" className="st-iconbtn" aria-label={`移除模型 ${index + 1}`}
                onClick={() => change({ models: draft.models.filter(item => item.connectionId !== model.connectionId) })}><Icon name="close" size={14} /></button>}</div>}
            <ConnectionModelFields modelId={model.modelId} idLabel={index === 0 ? '模型 ID' : `模型 ID ${index + 1}`} effort={model.reasoningEffort ?? 'auto'}
              efforts={profile.efforts} source={profile.source} manualLevels={model.reasoningLevels} contextWindow={model.contextWindow} maxOutputTokens={model.maxOutputTokens}
              referenceContext={profile.contextWindow} referenceOutput={profile.maxOutputTokens} error={modelReasoningError(routeOf(model), model.maxOutputTokens)}
              onId={modelId => changeModel(model.connectionId, { modelId })} onEffort={value => changeModel(model.connectionId, { reasoningEffort: value as ReasoningEffort })}
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
