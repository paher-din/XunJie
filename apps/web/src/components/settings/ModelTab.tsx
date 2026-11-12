import { useState } from 'react'
import type { ModelAttempt, ModelConnection, ModelProvider, ModelCheckPolicy } from '@xunjie/contracts/model-connections'
import { ModelProviderCard, ModelProviderModelRow, ModelProviderLogo, SettingsEmptyState, SettingsStatus, Toggle, reasoningEffortLabels, ModelTestFeedback, ModelTestButton } from '@xunjie/ui/settings'
import { Icon } from '@xunjie/ui/icons'
import { useToastFeedback } from '@xunjie/ui/feedback'
import type { ModelTestRun } from './useModelConfigurationTests'
import { captureModelSettingsOrder, inIdOrder, type ModelSettingsOrder } from './modelOrdering'
import { useSupplierChecks, type TestSupplierConnection } from './useSupplierChecks'

type SchoolModel = { kind: 'school'; connection: ModelConnection; policy: ModelCheckPolicy }
type ModelTestState = { disabled: boolean; reason: string }

/** Formal model settings presentation. No legacy Session, settings store or model transport. */
export function ModelTab({ providers, order, schoolModels = [], onSchoolCheck, attempts, loading, error, recoveryError, onRetry, readOnly = false,
  toggleState, onToggle, onNew, onEdit, onAddModel, onCheck, tests = {}, onStopTest, onConnectionTest, onRemove, active = true }: {
  providers: ModelProvider[]; attempts: ModelAttempt[]; loading: boolean; error: string
  order?: ModelSettingsOrder
  recoveryError?: string
  onRetry?(): void | Promise<void>
  readOnly?: boolean
  schoolModels?: SchoolModel[]; onSchoolCheck?(choice: SchoolModel): void
  toggleState: Record<string, 'saving' | 'unknown'>; onToggle(provider: ModelProvider, connectionId?: string): void
  onNew(): void; onEdit(provider: ModelProvider): void; onAddModel(provider: ModelProvider): void; onCheck(connection: ModelConnection): void
  tests?: Record<string, ModelTestRun>; onStopTest?(connectionId: string): void
  onConnectionTest?: TestSupplierConnection
  onRemove?(provider: ModelProvider, trigger: HTMLButtonElement): void
  active?: boolean
}) {
  useToastFeedback(error)
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({})
  const [retrying, setRetrying] = useState(false)
  const positions = order ?? captureModelSettingsOrder(providers)
  const hasConfiguration = providers.length > 0 || schoolModels.length > 0
  const retry = async () => {
    if (!onRetry || retrying) return
    setRetrying(true)
    try { await onRetry() } finally { setRetrying(false) }
  }
  const testState = (connection: ModelConnection, { allowed = true, inactiveLabel = '模型', credentialVisible = true } = {}): ModelTestState => {
    if (readOnly || loading) return { disabled: true, reason: '' }
    if (!allowed) return { disabled: true, reason: '学校未开放这个模型的测试。' }
    if (!connection.enabled) return { disabled: true, reason: `${inactiveLabel}已停用；启用后才能测试。` }
    if (!connection.hasCredential) return { disabled: true, reason: credentialVisible ? '尚未保存 API Key；保存后才能测试。' : '' }
    if (connection.adapterState !== 'ready') return { disabled: true, reason: '' }
    if (attempts.some(attempt => attempt.connection.connectionId === connection.connectionId
      && (attempt.state === 'accepted' || !attempt.physicalRequestEnded)))
      return { disabled: true, reason: '已有测试正在进行，完成前不能再次开始。' }
    return { disabled: false, reason: '' }
  }
  return <>
    <div className="st-section" aria-busy={loading || retrying || undefined}>
      <div className="product-model-settings-stack">
      {readOnly && <SettingsStatus tone="neutral" title="当前学习空间为只读"
        description="可以查看已有模型；当前副本不能添加、修改、启停或测试模型。" />}
      {loading && !hasConfiguration && <SettingsStatus tone="loading" title="正在读取模型配置"
        description="已有模型与进行中的检查不会因切换页面改变。" />}
      {recoveryError && <SettingsStatus tone="error"
        title={hasConfiguration ? '模型配置可能不是最新' : '模型配置暂时无法读取'}
        description={hasConfiguration ? `当前列表仍可查看；重新读取后再修改，避免覆盖其他位置的更新。${recoveryError}`
          : `现有配置没有被删除。检查连接或学习服务状态后重新读取。${recoveryError}`}
        action={onRetry && <button type="button" className="outline" disabled={loading || retrying}
          aria-busy={loading || retrying || undefined} onClick={() => void retry()}>
          {loading || retrying ? '正在重新读取…' : '重新读取配置'}
        </button>} />}
      {!loading && !recoveryError && !hasConfiguration ? <SettingsEmptyState icon={<Icon name="model" size={24} />}
        title="还没有可用模型" description={readOnly ? '当前学习空间还没有可用模型；只读副本不能添加供应商。'
          : '添加自己的模型供应商后，Agent 才能开始对话与模型检查。学校提供的模型会单独列在这里。'}>
        <button type="button" className="primary product-provider-add-empty" disabled={readOnly} onClick={onNew}>添加供应商</button>
      </SettingsEmptyState> : hasConfiguration ? <>
        <div className="product-model-toolbar">
          <button type="button" className="outline product-provider-add-compact" disabled={readOnly || loading} onClick={onNew}>
            <Icon name="add" size={16} />添加供应商
          </button>
        </div>
      {schoolModels.length > 0 && <ModelProviderCard name="学校" compact actions={null}>
        <div className="st-configured-models" aria-label="学校的模型">
          {schoolModels.map(choice => {
            const state = testState(choice.connection, { allowed: Boolean(onSchoolCheck) && choice.policy.checksAllowed,
              inactiveLabel: '学校模型' })
            const run = tests[choice.connection.connectionId]
            return <ModelProviderModelRow key={choice.connection.connectionId} modelId={choice.connection.modelId}
              effort={choice.connection.reasoningEffort && choice.connection.reasoningEffort !== 'auto' ? reasoningEffortLabels[choice.connection.reasoningEffort] : undefined}
              actions={<ModelTestButton kind="model" iconOnly running={run?.status === 'running'}
                disabled={state.disabled} onTest={() => onSchoolCheck?.(choice)}
                onStop={onStopTest ? () => onStopTest(choice.connection.connectionId) : undefined} />}>
              {state.reason && <p className="detail st-model-test-reason">{state.reason}</p>}
              {choice.connection.adapterState !== 'ready' && <p className="detail">{connectionRouteProblem(choice.connection)}</p>}
              {run && run.status !== 'running' && <ModelTestFeedback {...run}
                onRetry={onSchoolCheck && !testState(choice.connection, { allowed: Boolean(onSchoolCheck) && choice.policy.checksAllowed }).disabled
                  ? () => onSchoolCheck(choice) : undefined} />}
            </ModelProviderModelRow>
          })}
        </div>
      </ModelProviderCard>}
      {inIdOrder(providers, positions.providers.map(provider => provider.id), provider => provider.providerId).map(provider => <ProviderCard key={provider.providerId} provider={provider}
        order={positions.models[provider.providerId] ?? []} expanded={Boolean(expandedProviders[provider.providerId])}
        onExpand={expanded => setExpandedProviders(previous => ({ ...previous, [provider.providerId]: expanded }))}
        readOnly={readOnly} loading={loading} toggleState={toggleState} onToggle={onToggle} onEdit={onEdit} onAddModel={onAddModel} onRemove={onRemove}
        active={active} onConnectionTest={onConnectionTest} tests={tests} onCheck={onCheck} onStopTest={onStopTest} testState={testState} />)}
      </> : null}
      </div>
    </div>
  </>
}

function ProviderCard({ provider, order, expanded, onExpand, readOnly, loading, toggleState, onToggle, onEdit, onAddModel, onRemove, active,
  onConnectionTest, tests, onCheck, onStopTest, testState }: {
  provider: ModelProvider; order: ModelSettingsOrder['models'][string]; expanded: boolean; onExpand(expanded: boolean): void
  readOnly: boolean
  loading: boolean; toggleState: Record<string, 'saving' | 'unknown'>; onToggle(provider: ModelProvider, connectionId?: string): void
  onEdit(provider: ModelProvider): void; onAddModel(provider: ModelProvider): void
  onRemove?: ((provider: ModelProvider, trigger: HTMLButtonElement) => void) | undefined
  active: boolean; onConnectionTest?: TestSupplierConnection
  tests: Record<string, ModelTestRun>; onCheck(connection: ModelConnection): void
  onStopTest?(connectionId: string): void
  testState(connection: ModelConnection, options?: { allowed?: boolean; inactiveLabel?: string; credentialVisible?: boolean }): ModelTestState
}) {
  const inactive = !provider.enabled
  const busy = readOnly || loading || Boolean(toggleState[provider.providerId])
  const models = inIdOrder(provider.models, order.map(model => model.id), model => model.connectionId)
  const visible = expanded ? models : models.slice(0, 4)
  const providerNote = inactive ? '供应商已停用；启用后才能测试模型并用于新对话。'
    : !provider.hasCredential ? '尚未保存 API Key；连接测试和模型测试暂不可用。' : ''
  const saved = provider.models.find(model => model.hasCredential) ?? provider.credentialConnection
  const supplier = useSupplierChecks({ presetId: provider.presetId ?? 'custom',
    ...(provider.variantId ? { variantId: provider.variantId } : {}), baseUrl: provider.baseUrl, protocol: provider.protocol,
    credential: { action: 'keep' }, ...(saved ? { savedCredential: { connectionId: saved.connectionId, version: saved.version } } : {}) },
  onConnectionTest, undefined, { notificationLabel: provider.name, active })
  const connectionRunning = supplier.connection?.status === 'running'
  return <ModelProviderCard name={provider.name} compact inactive={inactive} busy={busy}
        logo={provider.presetId ? <ModelProviderLogo providerId={provider.presetId} /> : undefined}
        actions={<SavedProviderActions provider={provider} disabled={busy} onEdit={() => onEdit(provider)}
          onRemove={onRemove} onToggle={() => onToggle(provider)}
          connectionTest={onConnectionTest ? { running: connectionRunning, disabled: busy || !provider.hasCredential,
            onTest: () => void supplier.runConnection(), onStop: supplier.stopConnection } : undefined} />}
        footer={<>
          {toggleState[provider.providerId] === 'saving' && <span className="st-provider-save-state" role="status">正在保存开关…</span>}
          {toggleState[provider.providerId] === 'unknown' && <span className="st-provider-save-state" role="alert">开关结果未确认</span>}
          <button type="button" className="st-provider-text-action" disabled={busy} onClick={() => onAddModel(provider)}><Icon name="add" size={14} />添加模型</button>
          {models.length > 4 && <button type="button" className="st-provider-text-action" aria-expanded={expanded} onClick={() => onExpand(!expanded)}>{expanded ? '收起' : `全部（${models.length}）`}</button>}
          {toggleState[provider.providerId] === 'unknown' && <button type="button" className="st-provider-text-action" onClick={() => onToggle(provider)}>核对开关提交</button>}
        </>}>
        {providerNote && <p className="detail st-provider-note" role="status">{providerNote}</p>}
        {visible.length > 0 ? <div className="st-configured-models" aria-label={`${provider.name}的模型`}>
        {visible.map(connection => {
          const state = inactive ? { disabled: true, reason: '' } : testState(connection, { credentialVisible: provider.hasCredential })
          const run = tests[connection.connectionId]
          return <ModelProviderModelRow key={connection.connectionId} modelId={connection.modelId}
            effort={connection.reasoningEffort && connection.reasoningEffort !== 'auto' ? reasoningEffortLabels[connection.reasoningEffort] : undefined}
            actions={<><ModelTestButton kind="model" iconOnly running={run?.status === 'running'}
            disabled={state.disabled} onTest={() => onCheck(connection)}
            onStop={onStopTest ? () => onStopTest(connection.connectionId) : undefined} />
            <Toggle checked={connection.modelEnabled ?? connection.enabled} label={`启用模型 ${connection.modelId}`} disabled={inactive || busy}
              onChange={() => onToggle(provider, connection.connectionId)} /></>}>
            {state.reason && <p className="detail st-model-test-reason">{state.reason}</p>}
            {connection.adapterState !== 'ready' && <p className="detail">{connectionRouteProblem(connection)}</p>}
            {run && run.status !== 'running' && <ModelTestFeedback {...run}
              onRetry={!state.disabled ? () => onCheck(connection) : undefined} />}
          </ModelProviderModelRow>
        })}</div> : <p className="st-provider-empty detail">还没有模型；添加模型后才能用于对话。</p>}
        {supplier.connection && supplier.connection.status !== 'running' && <div className="st-provider-connection-feedback">
          <ModelTestFeedback {...supplier.connection}
            onRetry={!busy && provider.hasCredential ? () => void supplier.runConnection() : undefined} />
        </div>}
      </ModelProviderCard>
}

function connectionRouteProblem(connection: ModelConnection) {
  return connection.capabilities.text === 'unsupported'
    ? '该目标路线不支持所选协议' : '当前协议、地址或型号组合不可用，请核对配置'
}

function SavedProviderActions({ provider, disabled, onEdit, onRemove, onToggle, connectionTest }: {
  provider: ModelProvider; disabled: boolean; onEdit(): void; onToggle(): void
  onRemove?: ((provider: ModelProvider, trigger: HTMLButtonElement) => void) | undefined
  connectionTest?: { running: boolean; disabled: boolean; onTest(): void; onStop(): void } | undefined
}) {
  return <>
    <div className="st-provider-manage-actions">
      <button type="button" className="st-provider-text-action" disabled={disabled} onClick={onEdit}>编辑</button>
      {onRemove && <button type="button" className="st-provider-text-action st-provider-delete" disabled={disabled}
        aria-label={`删除供应商 ${provider.name}`} title="删除供应商" onClick={event => onRemove(provider, event.currentTarget)}>
        <Icon name="trash-bin-trash" size={16} tone="neutral" />
      </button>}
    </div>
    {connectionTest && <ModelTestButton kind="connection" iconOnly running={connectionTest.running}
      disabled={connectionTest.disabled} onTest={connectionTest.onTest} onStop={connectionTest.onStop} />}
    <Toggle checked={provider.enabled} label={`启用供应商 ${provider.name}`} disabled={disabled} onChange={onToggle} />
  </>
}
