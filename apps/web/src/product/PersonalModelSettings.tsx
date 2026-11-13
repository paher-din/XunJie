import { useCallback, useEffect, useRef, useState } from 'react'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { modelAttemptSchema, modelProviderSchema, modelProfilesSchema, modelCredentialValueSchema, modelDirectorySchema,
  modelConnectionTestResultSchema, deleteModelProviderResultSchema, modelDiagnosticSchema, resolveModelCapacity, type ModelAttempt, type ModelProvider, type ModelCheckInput, type SaveModelProvider } from '@xunjie/contracts/model-connections'
import { ModelTab } from '../components/settings/ModelTab'
import { ModelProviderDialog } from '../components/settings/ModelProviderDialog'
import { captureModelSettingsOrder, reconcileModelSettingsOrder } from '../components/settings/modelOrdering'
import { toast } from '@xunjie/ui/feedback'
import { ConfirmationDialog } from '@xunjie/ui/foundation'
import { z } from 'zod'
import { type ModelSelectionController } from './ModelSelection'
import { AgentInteractionSettings, useAgentInteraction } from './AgentInteraction'
import { PersonalSkillsSettings } from './PersonalSkillsSettings'
import type { ReadModelDirectory } from '../components/settings/useModelDirectory'
import { useModelConfigurationTests, type ModelCheckOptions } from '../components/settings/useModelConfigurationTests'
import type { LearningReadCache } from './learning-read-cache'

const failures: Record<string, string> = { conflict: '配置已被更新，当前输入保留，请核对后重新读取。', 'identity-conflict': '原检查身份与内容冲突，请查询原记录。',
  forbidden: '原空间资格已失效，请重新登录原空间。', 'resource-busy': '检查频次或并发已达上限，请稍后再试。',
  unavailable: '连接或相应适配器不可用，请检查配置。', invalid: '请检查地址、协议、模型及密钥填写。', maintenance: '模型服务正在维护，请稍后重试。' }
type PendingToggle = { input: SaveModelProvider; label: string }
type PersonalModelSettingsProps = {
  identity: SpaceIdentity; spaceKey: string; namespace: string; onBack(): void; selection: ModelSelectionController; readOnly?: boolean
  activityId?: string; courseId?: string
  cache?: LearningReadCache
}
type ModelSettingsSnapshot = { providers: ModelProvider[]; attempts: ModelAttempt[] }
export function PersonalModelSettings(props: PersonalModelSettingsProps) {
  const { identity, namespace, spaceKey } = props
  // A subject change must discard old drafts, errors and late async responses together.
  return <PersonalModelSettingsBody key={JSON.stringify([namespace, spaceKey, identity.environmentId, identity.spaceId, identity.principalId])} {...props} />
}
function PersonalModelSettingsBody({ identity, spaceKey, namespace, onBack, selection, activityId, courseId, readOnly = false, cache }: PersonalModelSettingsProps) {
  const displayVisit = useRef(0)
  const cacheKey = JSON.stringify(['model-settings', namespace, identity.environmentId, identity.spaceId, identity.principalId])
  const initial = useRef(cache?.peek<ModelSettingsSnapshot>(spaceKey, cacheKey))
  const loaded = useRef(!!initial.current)
  const [view, setView] = useState(() => ({ providers: initial.current?.providers ?? [],
    order: captureModelSettingsOrder(initial.current?.providers ?? []), visit: -1 }))
  const providers = view.providers
  const setProviders = useCallback((update: ModelProvider[] | ((previous: ModelProvider[]) => ModelProvider[]), freshList = false) => {
    const visit = displayVisit.current
    setView(previous => {
      const providers = typeof update === 'function' ? update(previous.providers) : update
      const capture = freshList && previous.visit !== visit
      if (!capture && JSON.stringify(previous.providers) === JSON.stringify(providers)) return previous
      return { providers, visit: capture ? visit : previous.visit,
        order: capture ? captureModelSettingsOrder(providers) : reconcileModelSettingsOrder(previous.order, providers) }
    })
  }, [])
  const [attempts, setAttempts] = useState<ModelAttempt[]>(initial.current?.attempts ?? [])
  useEffect(() => {
    if (loaded.current) cache?.set(spaceKey, cacheKey, { providers, attempts })
  }, [providers, attempts, cache, spaceKey, cacheKey])
  const [dialog, setDialog] = useState<{ provider: ModelProvider | null; addModel?: boolean } | null>(null)
  const [removing, setRemoving] = useState<{ provider: ModelProvider; requestId: string } | null>(null)
  const [deleting, setDeleting] = useState(false), [deleteError, setDeleteError] = useState('')
  const deleteRunning = useRef(false), deleteTrigger = useRef<HTMLButtonElement | null>(null)
  const [toggleState, setToggleState] = useState<Record<string, 'saving' | 'unknown'>>({})
  const togglePending = useRef(new Map<string, PendingToggle>())
  const toggleRunning = useRef(new Set<string>())
  const [loading, setLoading] = useState(false), [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState<{ key: string; message: string } | null>(null)
  const reads = useRef(0)
  // Pending polls must not prevent a completed read from publishing.
  const appliedRead = useRef(0)
  const live = useRef(true)
  const rootElement = useRef<HTMLDivElement>(null), [modelsVisible, setModelsVisible] = useState(false), [agentVisible, setAgentVisible] = useState(false)
  useEffect(() => {
    const pane = rootElement.current?.closest<HTMLElement>('[data-settings-section]')
    if (!pane) { setModelsVisible(true); setAgentVisible(true); return }
    const observe = () => {
      setModelsVisible(!pane.hidden && pane.dataset.settingsSection === 'models')
      setAgentVisible(!pane.hidden && pane.dataset.settingsSection === 'agent')
    }
    observe()
    const observer = new MutationObserver(observe)
    observer.observe(pane, { attributes: true, attributeFilter: ['hidden', 'data-settings-section'] })
    return () => observer.disconnect()
  }, [])
  const interaction = useAgentInteraction(identity, spaceKey, namespace, !readOnly, agentVisible)
  useEffect(() => { live.current = true; return () => { live.current = false } }, [])
  const request = useCallback(async (route: string, body?: unknown, signal?: AbortSignal) => {
    const path = route.startsWith('../') ? '/api/learning/' + route.slice(3) : '/api/learning/models/' + route
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(35000)]) : AbortSignal.timeout(35000),
      headers: { 'content-type': 'application/json', 'x-xj-space': spaceKey, 'x-xj-namespace': namespace,
        'x-xj-expected-subject': [identity.environmentId, identity.spaceId, identity.principalId].join('.') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json()
    if (!response.ok) {
      const diagnostic = modelDiagnosticSchema.safeParse(result.diagnostic)
      throw Object.assign(new Error(diagnostic.success ? diagnostic.data.message : failures[result.error] ?? '原请求结果尚未确认，请查询检查记录。'),
        { code: result.error, ...(diagnostic.success ? { diagnostic: diagnostic.data } : {}) })
    }
    return result as unknown
  }, [identity.environmentId, identity.spaceId, identity.principalId, spaceKey, namespace])
  const readDirectory = useCallback<ReadModelDirectory>(async (input, signal) => modelDirectorySchema.parse(await request('directory', input, signal)), [request])
  const testConnection = useCallback<NonNullable<React.ComponentProps<typeof ModelProviderDialog>['onConnectionTest']>>(
    async (input, signal) => modelConnectionTestResultSchema.parse(await request('providers/test-connection', input, signal)), [request])
  const reload = useCallback(async (visible = false) => {
    const generation = ++reads.current
    if (visible && !loaded.current) setLoading(true)
    try {
      await Promise.all([
        request('providers').then(value => {
          if (!live.current || generation < appliedRead.current) return
          const providers = z.array(modelProviderSchema).parse(value)
          appliedRead.current = generation
          loaded.current = true
          setProviders(providers, true)
        }),
        request('checks').then(value => {
          if (!live.current || generation < appliedRead.current) return
          const attempts = z.array(modelAttemptSchema).parse(value)
          appliedRead.current = generation
          setAttempts(previous => JSON.stringify(previous) === JSON.stringify(attempts) ? previous : attempts)
        }),
      ])
      if (!live.current || generation < appliedRead.current) return
      setLoadError('')
    } catch (error) {
      if (live.current && generation >= appliedRead.current) {
        appliedRead.current = generation
        setLoadError(error instanceof Error ? error.message : '暂时无法读取原配置。')
      }
    }
    finally { if (live.current && visible) setLoading(false) }
  }, [request, setProviders, cache, spaceKey, cacheKey])
  useEffect(() => {
    if (!modelsVisible) return
    displayVisit.current++
    void reload(true)
    return () => {
      // A response started in the model pane cannot notify another settings pane.
      appliedRead.current = ++reads.current
    }
  }, [reload, modelsVisible])
  const fastRefresh = !!loadError || !!removing || Object.keys(toggleState).length > 0
    || attempts.some(attempt => ['accepted', 'dispatched'].includes(attempt.state) || attempt.state === 'unknown' && !attempt.physicalRequestEnded)
  useEffect(() => {
    if (!modelsVisible) return
    let pending = false
    const refresh = () => {
      if (document.hidden || pending) return
      pending = true
      void reload().finally(() => { pending = false })
    }
    const timer = setInterval(refresh, fastRefresh ? 1000 : 15000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [reload, modelsVisible, fastRefresh])
  const check = async (source: ModelCheckInput['source'], options?: ModelCheckOptions) => {
    const attemptId = crypto.randomUUID()
    const publish = (attempt: ModelAttempt) => {
      if (live.current) setAttempts(previous => [attempt, ...previous.filter(item => item.attemptId !== attemptId)])
      options?.onAttempt?.(attempt)
    }
    const stop = () => { void request('checks/' + attemptId + '/cancel', {}).catch(() => {}) }
    options?.signal.addEventListener('abort', stop, { once: true })
    const settle = async (initial: ModelAttempt) => {
      let result = initial
      publish(result)
      if (options?.signal.aborted) {
        await request('checks/' + attemptId + '/cancel', {}); result = modelAttemptSchema.parse(await request('checks/' + attemptId)); publish(result); return result
      }
      if (result.state === 'accepted') { result = modelAttemptSchema.parse(await request('checks/' + attemptId + '/dispatch', {})); publish(result) }
      while (['accepted', 'dispatched'].includes(result.state) || result.state === 'unknown' && !result.physicalRequestEnded) {
        if (options?.signal.aborted) {
          await request('checks/' + attemptId + '/cancel', {}); result = modelAttemptSchema.parse(await request('checks/' + attemptId)); publish(result); return result
        }
        await new Promise<void>(resolve => { const timer = setTimeout(done, 750)
          function done() { clearTimeout(timer); options?.signal.removeEventListener('abort', done); resolve() }
          options?.signal.addEventListener('abort', done, { once: true })
        })
        result = modelAttemptSchema.parse(await request('checks/' + attemptId)); publish(result)
      }
      return result
    }
    try {
      // Keep the accepted identity recoverable even when the dialog closes during the POST.
      return await settle(modelAttemptSchema.parse(await request('checks', { attemptId, purpose: 'connection-check', source,
        ...(options ? { test: options.test } : {}), limits: { maxOutputTokens: options ? resolveModelCapacity(options.configuration).maxOutputTokens : 64,
          timeoutMs: options ? 120000 : 20000 } })))
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? String(error.code) : ''
      if (['invalid', 'forbidden', 'resource-busy', 'conflict', 'identity-conflict', 'maintenance', 'unavailable'].includes(code)) throw error
      // Query before continuing the same idempotent dispatch, never create a second attempt.
      try { return await settle(modelAttemptSchema.parse(await request('checks/' + attemptId))) }
      catch { throw error }
    } finally { options?.signal.removeEventListener('abort', stop) }
  }
  const savedTests = useModelConfigurationTests(check)
  const testedConfigurations = useRef(new Map<string, string>())
  useEffect(() => {
    const next = new Map<string, string>()
    const connections = [...providers.flatMap(provider => provider.models),
      ...(selection.selection?.options.filter(choice => choice.kind === 'school').map(choice => choice.connection) ?? [])]
    for (const connection of connections) next.set(connection.connectionId, JSON.stringify([
      connection.version, connection.routeId, connection.baseUrl, connection.protocol, connection.modelId,
      connection.dialect, connection.parameterMode, connection.reasoningEffort, connection.reasoningLevels,
      connection.contextWindow, connection.maxOutputTokens, connection.imageInput, connection.enabled, connection.hasCredential,
    ]))
    for (const [id, signature] of testedConfigurations.current) {
      if (next.get(id) !== signature) savedTests.expire(id)
    }
    testedConfigurations.current = next
  }, [providers, selection.selection])
  const cancel = async (attempt: ModelAttempt) => { await request('checks/' + attempt.attemptId + '/cancel', {}); await reload() }
  const readProvider = async (providerId: string) => {
    const generation = ++reads.current
    const configurations = z.array(modelProviderSchema).parse(await request('providers'))
    if (live.current && generation >= appliedRead.current) {
      appliedRead.current = generation
      setProviders(configurations, true)
    }
    return configurations.find(item => item.providerId === providerId) ?? null
  }
  const save = async (input: SaveModelProvider) => {
    const saved = modelProviderSchema.parse(await request('providers', input))
    for (const model of input.models) savedTests.invalidate(model.connectionId)
    // The POST receipt is authoritative; a subsequent read failure cannot undo it.
    if (live.current) {
      // Invalidate every read started before this receipt, including explicit reads.
      appliedRead.current = ++reads.current
      setProviders(previous => previous.some(item => item.providerId === saved.providerId)
        ? previous.map(item => item.providerId === saved.providerId ? saved : item) : [saved, ...previous])
      void reload()
      void selection.reload().catch(() => {})
    }
    return saved
  }
  const toggle = async (provider: ModelProvider, connectionId?: string) => {
    const id = provider.providerId
    if (toggleRunning.current.has(id)) return
    const pending = togglePending.current.get(id)
    const wasUnknown = Boolean(pending)
    const input = pending?.input ?? {
      requestId: crypto.randomUUID(), providerId: id, expectedVersion: provider.version, name: provider.name,
      protocol: provider.protocol, baseUrl: provider.baseUrl, enabled: connectionId ? provider.enabled : !provider.enabled,
      ...(provider.presetId ? { presetId: provider.presetId } : {}), ...(provider.variantId ? { variantId: provider.variantId } : {}),
      credential: { action: 'keep' as const }, models: provider.models.map(model => ({
        connectionId: model.connectionId, expectedVersion: model.version, modelId: model.modelId,
        protocol: model.protocol, baseUrl: model.baseUrl,
        enabled: connectionId === model.connectionId ? !(model.modelEnabled ?? model.enabled) : model.modelEnabled ?? model.enabled,
        ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}),
        ...(model.reasoningSource === 'manual' ? { reasoningLevels: model.reasoningLevels ?? [] } : {}),
        ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
        ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
        ...(model.imageInput === undefined ? {} : { imageInput: model.imageInput }),
      })),
    }
    const label = pending?.label ?? (connectionId
      ? `模型${input.models.find(model => model.connectionId === connectionId)?.enabled ? '已启用' : '已停用'}`
      : `供应商${input.enabled ? '已启用' : '已停用'}`)
    togglePending.current.set(id, { input, label }); toggleRunning.current.add(id)
    setToggleState(previous => ({ ...previous, [id]: 'saving' }))
    try {
      await save(input); togglePending.current.delete(id)
      if (live.current) { setToggleState(previous => { const next = { ...previous }; delete next[id]; return next }); setActionError(null); toast.success(label) }
    } catch (error) {
      const code = error instanceof Error && 'code' in error ? error.code : undefined
      if (code === 'conflict' || !wasUnknown && (code === 'invalid' || code === 'forbidden')) {
        togglePending.current.delete(id)
        if (live.current) { setToggleState(previous => { const next = { ...previous }; delete next[id]; return next }); void reload() }
      } else if (live.current) setToggleState(previous => ({ ...previous, [id]: 'unknown' }))
      if (live.current) setActionError({ key: 'toggle:' + id, message: error instanceof Error ? error.message : '开关结果未确认，请核对原提交。' })
    } finally { toggleRunning.current.delete(id) }
  }
  const remove = async () => {
    if (!removing || readOnly || deleteRunning.current) return
    const { provider, requestId } = removing
    deleteRunning.current = true; setDeleting(true); setDeleteError('')
    try {
      const result = deleteModelProviderResultSchema.parse(await request('providers/' + provider.providerId + '/delete', { requestId, expectedVersion: provider.version }))
      if (result.providerId !== provider.providerId) throw new Error('删除回执不匹配，请重试核对原请求。')
      if (!live.current) return
      appliedRead.current = ++reads.current
      setProviders(previous => previous.filter(item => item.providerId !== provider.providerId))
      for (const model of provider.models) savedTests.invalidate(model.connectionId)
      setRemoving(null); setDeleteError(''); setActionError(null)
      toast.success(`已删除供应商「${provider.name}」`)
      void reload(); void selection.reload().catch(() => {})
    } catch (error) {
      if (!live.current) return
      const message = error instanceof Error ? error.message : '删除结果尚未确认，请重试核对原请求。'
      if (error instanceof Error && 'code' in error && error.code === 'conflict') {
        setRemoving(null); setDeleteError(''); toast.error(message); void reload()
      } else setDeleteError(message)
    } finally { deleteRunning.current = false; if (live.current) setDeleting(false) }
  }
  const readProfiles = useCallback(async (input: Parameters<React.ComponentProps<typeof ModelProviderDialog>['onProfiles']>[0]) =>
    modelProfilesSchema.parse(await request('profiles', input)), [request])
  const readCredential = useCallback(async (connectionId: string, version: number) => {
    const saved = modelCredentialValueSchema.parse(await request('connections/' + connectionId + '/credential', { version }))
    if (saved.connectionId !== connectionId || saved.version !== version) throw new Error('配置已更新，请重新打开。')
    return saved.value
  }, [request])
  return <div ref={rootElement} className="content product-model-settings">
    <div className="sectionhead"><h1>个人设置</h1><button type="button" className="outline" onClick={onBack}>返回学习空间</button></div>
    <div className="st-body-in"><div className="product-personal-agent"><AgentInteractionSettings controller={interaction} />
      <PersonalSkillsSettings identity={identity} spaceKey={spaceKey} namespace={namespace} activityId={activityId} courseId={courseId} readOnly={readOnly} active={agentVisible} cache={cache} /></div>
      <div className="product-personal-model">
      <div role="region" aria-label="个人连接配置"><ModelTab providers={providers} order={view.order} attempts={attempts} loading={loading} error={modelsVisible ? actionError?.message ?? '' : ''}
      readOnly={readOnly} tests={savedTests.runs} onStopTest={savedTests.stop}
      active={modelsVisible} onConnectionTest={testConnection}
      onRemove={readOnly ? undefined : (provider, trigger) => {
        deleteTrigger.current = trigger; setDeleteError(''); setRemoving({ provider, requestId: crypto.randomUUID() })
      }}
      recoveryError={modelsVisible ? [loadError, selection.error].filter(Boolean).join('；') : ''}
      toggleState={toggleState} onToggle={(provider, connectionId) => void toggle(provider, connectionId)}
      schoolModels={selection.selection?.options.filter(choice => choice.kind === 'school') ?? []}
      onSchoolCheck={choice => void savedTests.run(choice.connection, { school: { connectionId: choice.connection.connectionId, version: choice.connection.version } })}
      onRetry={async () => {
        await Promise.all([reload(true), selection.stale && selection.error ? selection.reload() : undefined])
      }}
      onNew={() => setDialog({ provider: null })} onEdit={provider => setDialog({ provider })} onAddModel={provider => setDialog({ provider, addModel: true })}
      onCheck={connection => void savedTests.run(connection, { connectionId: connection.connectionId, version: connection.version })} /></div></div></div>
    {dialog && <ModelProviderDialog provider={dialog.provider} addModel={dialog.addModel} attempts={attempts} onClose={() => setDialog(null)} onSave={save} onRead={readProvider} onReadCredential={readCredential} onProfiles={readProfiles} onDirectory={readDirectory}
      onConnectionTest={testConnection}
      onCheck={check} onCancel={cancel} />}
    <ConfirmationDialog open={!!removing} title={`删除「${removing?.provider.name ?? ''}」？`}
      description={deleting ? '正在移除这个供应商及其模型配置，完成前请保留此窗口。历史对话会保留。'
        : '将移除这个供应商及其模型配置，历史对话保留。'}
      confirmLabel="删除" busy={deleting} error={deleteError}
      onClose={() => { if (!deleting) { setRemoving(null); setDeleteError('') } }} onConfirm={() => void remove()}
      onReturnFocus={() => {
        if (deleteTrigger.current?.isConnected) deleteTrigger.current.focus()
        else rootElement.current?.querySelector<HTMLButtonElement>('.product-provider-add, .product-provider-add-empty, .product-provider-add-compact')?.focus()
      }} />
  </div>
}
