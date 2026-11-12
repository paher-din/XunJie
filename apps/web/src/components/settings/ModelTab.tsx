import { useState } from 'react'
import type { ModelAttempt, ModelConnection, ModelProvider, ModelCheckPolicy } from '@xunjie/contracts/model-connections'
import { ModelProviderCard, ModelProviderModelRow, ModelProviderLogo, Toggle, reasoningEffortLabels, ModelTestFeedback, ModelTestButton } from '@xunjie/ui/settings'
import { Icon } from '@xunjie/ui/icons'
import { useToastFeedback } from '@xunjie/ui/feedback'
import type { ModelTestRun } from './useModelConfigurationTests'
import { captureModelSettingsOrder, inIdOrder, type ModelSettingsOrder } from './modelOrdering'
import { useSupplierChecks, type TestSupplierConnection } from './useSupplierChecks'

type SchoolModel = { kind: 'school'; connection: ModelConnection; policy: ModelCheckPolicy }

/** Formal model settings presentation. No legacy Session, settings store or model transport. */
export function ModelTab({ providers, order, schoolModels = [], onSchoolCheck, attempts, loading, error, recoveryError, onRetrySelection, toggleState, onToggle, onNew, onEdit, onAddModel, onCheck, tests = {}, onStopTest, onConnectionTest, onRemove, active = true }: {
  providers: ModelProvider[]; attempts: ModelAttempt[]; loading: boolean; error: string
  order?: ModelSettingsOrder
  recoveryError?: string
  onRetrySelection?: () => void
  schoolModels?: SchoolModel[]; onSchoolCheck?(choice: SchoolModel): void
  toggleState: Record<string, 'saving' | 'unknown'>; onToggle(provider: ModelProvider, connectionId?: string): void
  onNew(): void; onEdit(provider: ModelProvider): void; onAddModel(provider: ModelProvider): void; onCheck(connection: ModelConnection): void
  tests?: Record<string, ModelTestRun>; onStopTest?(connectionId: string): void
  onConnectionTest?: TestSupplierConnection
  onRemove?(provider: ModelProvider, trigger: HTMLButtonElement): void
  active?: boolean
}) {
  useToastFeedback(error)
  useToastFeedback(recoveryError)
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({})
  const positions = order ?? captureModelSettingsOrder(providers)
  const checkDisabled = (connection: ModelConnection, allowed = true) => loading || !allowed || !connection.enabled || !connection.hasCredential
    || connection.adapterState !== 'ready' || attempts.some(attempt => attempt.connection.connectionId === connection.connectionId
      && (attempt.state === 'accepted' || !attempt.physicalRequestEnded))
  return <>
    <div className="st-section">
      {recoveryError && <p className="detail">{recoveryError}</p>}
      {onRetrySelection && <button type="button" className="outline" onClick={onRetrySelection}>重试</button>}
      <button type="button" className="product-provider-add" onClick={onNew}>
        <span className="product-provider-add-icon"><Icon name="add" size={22} /></span>
        <span>添加供应商</span>
      </button>
      {schoolModels.length > 0 && <ModelProviderCard name="学校" compact actions={null}>
        <div className="st-configured-models" aria-label="学校的模型">
          {schoolModels.map(choice => <ModelProviderModelRow key={choice.connection.connectionId} modelId={choice.connection.modelId}
            effort={choice.connection.reasoningEffort && choice.connection.reasoningEffort !== 'auto' ? reasoningEffortLabels[choice.connection.reasoningEffort] : undefined}
            actions={<ModelTestButton kind="model" iconOnly running={tests[choice.connection.connectionId]?.status === 'running'}
              disabled={checkDisabled(choice.connection, Boolean(onSchoolCheck) && choice.policy.checksAllowed)}
              onTest={() => onSchoolCheck?.(choice)} onStop={onStopTest ? () => onStopTest(choice.connection.connectionId) : undefined} />}>
            {!choice.connection.enabled && <p className="detail">学校已停用</p>}
            {tests[choice.connection.connectionId] && ['failed', 'unverified'].includes(tests[choice.connection.connectionId]!.status) && <ModelTestFeedback {...tests[choice.connection.connectionId]!}
              onRetry={onSchoolCheck && !checkDisabled(choice.connection, choice.policy.checksAllowed) ? () => onSchoolCheck(choice) : undefined} />}
          </ModelProviderModelRow>)}
        </div>
      </ModelProviderCard>}
      {inIdOrder(providers, positions.providers.map(provider => provider.id), provider => provider.providerId).map(provider => <ProviderCard key={provider.providerId} provider={provider}
        order={positions.models[provider.providerId] ?? []} expanded={Boolean(expandedProviders[provider.providerId])}
        onExpand={expanded => setExpandedProviders(previous => ({ ...previous, [provider.providerId]: expanded }))}
        loading={loading} toggleState={toggleState} onToggle={onToggle} onEdit={onEdit} onAddModel={onAddModel} onRemove={onRemove}
        active={active} onConnectionTest={onConnectionTest} tests={tests} onCheck={onCheck} onStopTest={onStopTest} checkDisabled={checkDisabled} />)}
    </div>
  </>
}

function ProviderCard({ provider, order, expanded, onExpand, loading, toggleState, onToggle, onEdit, onAddModel, onRemove, active,
  onConnectionTest, tests, onCheck, onStopTest, checkDisabled }: {
  provider: ModelProvider; order: ModelSettingsOrder['models'][string]; expanded: boolean; onExpand(expanded: boolean): void
  loading: boolean; toggleState: Record<string, 'saving' | 'unknown'>; onToggle(provider: ModelProvider, connectionId?: string): void
  onEdit(provider: ModelProvider): void; onAddModel(provider: ModelProvider): void
  onRemove?: ((provider: ModelProvider, trigger: HTMLButtonElement) => void) | undefined
  active: boolean; onConnectionTest?: TestSupplierConnection
  tests: Record<string, ModelTestRun>; onCheck(connection: ModelConnection): void
  onStopTest?(connectionId: string): void
  checkDisabled(connection: ModelConnection, allowed?: boolean): boolean
}) {
  const inactive = !provider.enabled
  const busy = loading || Boolean(toggleState[provider.providerId])
  const models = inIdOrder(provider.models, order.map(model => model.id), model => model.connectionId)
  const visible = expanded ? models : models.slice(0, 4)
  return <ModelProviderCard name={provider.name} compact inactive={inactive}
        logo={provider.presetId ? <ModelProviderLogo providerId={provider.presetId} /> : undefined}
        actions={<SavedProviderActions provider={provider} disabled={busy}
          active={active} onEdit={() => onEdit(provider)} onRemove={onRemove} onToggle={() => onToggle(provider)} onConnectionTest={onConnectionTest} />}
        footer={<><button type="button" className="st-provider-text-action" disabled={busy} onClick={() => onAddModel(provider)}><Icon name="add" size={14} />添加模型</button>
          {models.length > 4 && <button type="button" className="st-provider-text-action" aria-expanded={expanded} onClick={() => onExpand(!expanded)}>{expanded ? '收起' : `全部（${models.length}）`}</button>}
          {toggleState[provider.providerId] === 'unknown' && <button type="button" className="st-provider-text-action" onClick={() => onToggle(provider)}>核对开关提交</button>}
        </>}>
        {visible.length > 0 && <div className="st-configured-models" aria-label={`${provider.name}的模型`}>
        {visible.map(connection => <ModelProviderModelRow key={connection.connectionId} modelId={connection.modelId}
          effort={connection.reasoningEffort && connection.reasoningEffort !== 'auto' ? reasoningEffortLabels[connection.reasoningEffort] : undefined}
          actions={<><ModelTestButton kind="model" iconOnly running={tests[connection.connectionId]?.status === 'running'}
          disabled={inactive || checkDisabled(connection)}
          onTest={() => onCheck(connection)} onStop={onStopTest ? () => onStopTest(connection.connectionId) : undefined} />
          <Toggle checked={connection.modelEnabled ?? connection.enabled} label={`启用模型 ${connection.modelId}`} disabled={inactive || busy}
            onChange={() => onToggle(provider, connection.connectionId)} /></>}>
          {connection.adapterState !== 'ready' && <p className="detail">{connection.capabilities.text === 'unsupported' ? '该目标路线不支持所选协议' : '当前协议、地址或型号组合不可用，请核对配置'}</p>}
        {tests[connection.connectionId] && ['failed', 'unverified'].includes(tests[connection.connectionId]!.status) && <ModelTestFeedback {...tests[connection.connectionId]!}
          onRetry={!inactive && !checkDisabled(connection) ? () => onCheck(connection) : undefined} />}
        </ModelProviderModelRow>)}</div>}
      </ModelProviderCard>
}

function SavedProviderActions({ provider, disabled, active, onEdit, onRemove, onToggle, onConnectionTest }: {
  provider: ModelProvider; disabled: boolean; active: boolean; onEdit(): void; onToggle(): void
  onRemove?: ((provider: ModelProvider, trigger: HTMLButtonElement) => void) | undefined
  onConnectionTest: TestSupplierConnection | undefined
}) {
  const saved = provider.models.find(model => model.hasCredential) ?? provider.credentialConnection
  const supplier = useSupplierChecks({ presetId: provider.presetId ?? 'custom',
    ...(provider.variantId ? { variantId: provider.variantId } : {}), baseUrl: provider.baseUrl, protocol: provider.protocol,
    credential: { action: 'keep' }, ...(saved ? { savedCredential: { connectionId: saved.connectionId, version: saved.version } } : {}) },
  onConnectionTest, undefined, { notificationLabel: provider.name, active })
  const running = supplier.connection?.status === 'running'
  return <>
    <div className="st-provider-manage-actions">
      <button type="button" className="st-provider-text-action" disabled={disabled} onClick={onEdit}>编辑</button>
      {onRemove && <button type="button" className="st-provider-text-action st-provider-delete" disabled={disabled}
        aria-label={`删除供应商 ${provider.name}`} title="删除供应商" onClick={event => onRemove(provider, event.currentTarget)}>
        <Icon name="trash-bin-trash" size={16} tone="neutral" />
      </button>}
    </div>
    {onConnectionTest && <ModelTestButton kind="connection" iconOnly running={running} disabled={disabled || !provider.hasCredential}
      onTest={() => void supplier.runConnection()} onStop={supplier.stopConnection} />}
    <Toggle checked={provider.enabled} label={`启用供应商 ${provider.name}`} disabled={disabled} onChange={onToggle} />
  </>
}
