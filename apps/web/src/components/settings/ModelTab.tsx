import type { ModelAttempt, ModelConnection, ModelProvider, ModelCheckPolicy } from '@xunjie/contracts/model-connections'
import { ModelProviderCard, ModelProviderModelRow, ModelProviderLogo, Toggle, reasoningEffortLabels, ModelTestFeedback, ModelTestButton } from '@xunjie/ui/settings'
import { Icon } from '@xunjie/ui/icons'
import { useToastFeedback } from '@xunjie/ui/feedback'
import type { ModelTestRun } from './useModelConfigurationTests'

type SchoolModel = { kind: 'school'; connection: ModelConnection; policy: ModelCheckPolicy }

/** Formal model settings presentation. No legacy Session, settings store or model transport. */
export function ModelTab({ providers, schoolModels = [], onSchoolCheck, attempts, loading, error, recoveryError, onRetrySelection, toggleState, onToggle, onNew, onEdit, onAddModel, onCheck, tests = {}, onStopTest }: {
  providers: ModelProvider[]; attempts: ModelAttempt[]; loading: boolean; error: string
  recoveryError?: string
  onRetrySelection?: () => void
  schoolModels?: SchoolModel[]; onSchoolCheck?(choice: SchoolModel): void
  toggleState: Record<string, 'saving' | 'unknown'>; onToggle(provider: ModelProvider, connectionId?: string): void
  onNew(): void; onEdit(provider: ModelProvider): void; onAddModel(provider: ModelProvider): void; onCheck(connection: ModelConnection): void
  tests?: Record<string, ModelTestRun>; onStopTest?(connectionId: string): void
}) {
  useToastFeedback(error)
  useToastFeedback(recoveryError)
  const checkDisabled = (connection: ModelConnection, allowed = true) => loading || !allowed || !connection.enabled || !connection.hasCredential
    || connection.adapterState !== 'ready' || attempts.some(attempt => attempt.connection.connectionId === connection.connectionId
      && (attempt.state === 'accepted' || !attempt.physicalRequestEnded))
  return <>
    <div className="st-section">
      {recoveryError && <p className="detail">{recoveryError}</p>}
      {onRetrySelection && <button type="button" className="outline" onClick={onRetrySelection}>重试</button>}
      {loading && <p role="status">正在读取配置…</p>}
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
            {tests[choice.connection.connectionId] && <ModelTestFeedback {...tests[choice.connection.connectionId]!}
              onRetry={onSchoolCheck && !checkDisabled(choice.connection, choice.policy.checksAllowed) ? () => onSchoolCheck(choice) : undefined} />}
          </ModelProviderModelRow>)}
        </div>
      </ModelProviderCard>}
      {providers.map(provider => <ModelProviderCard key={provider.providerId} name={provider.name} compact
        logo={provider.presetId ? <ModelProviderLogo providerId={provider.presetId} /> : undefined}
        actions={<><button type="button" className="st-provider-text-action" disabled={Boolean(toggleState[provider.providerId])} onClick={() => onEdit(provider)}>编辑</button>
          <Toggle checked={provider.enabled} label={`启用供应商 ${provider.name}`} disabled={Boolean(toggleState[provider.providerId])} onChange={() => onToggle(provider)} /></>}
        footer={<><button type="button" className="st-provider-text-action" disabled={Boolean(toggleState[provider.providerId])} onClick={() => onAddModel(provider)}><Icon name="add" size={14} />添加模型</button>
          {!provider.enabled && <span className="detail">供应商已停用</span>}
          {toggleState[provider.providerId] === 'saving' && <span role="status" className="detail">正在保存…</span>}
          {toggleState[provider.providerId] === 'unknown' && <button type="button" className="st-provider-text-action" onClick={() => onToggle(provider)}>核对开关提交</button>}
        </>}>
        {provider.models.length > 0 && <div className="st-configured-models" aria-label={`${provider.name}的模型`}>
        {provider.models.map(connection => <ModelProviderModelRow key={connection.connectionId} modelId={connection.modelId}
          effort={connection.reasoningEffort && connection.reasoningEffort !== 'auto' ? reasoningEffortLabels[connection.reasoningEffort] : undefined}
          actions={<><ModelTestButton kind="model" iconOnly running={tests[connection.connectionId]?.status === 'running'}
          disabled={checkDisabled(connection)}
          onTest={() => onCheck(connection)} onStop={onStopTest ? () => onStopTest(connection.connectionId) : undefined} />
          <Toggle checked={connection.modelEnabled ?? connection.enabled} label={`启用模型 ${connection.modelId}`} disabled={Boolean(toggleState[provider.providerId])}
            onChange={() => onToggle(provider, connection.connectionId)} /></>}>
          {connection.adapterState !== 'ready' && <p className="detail">{connection.capabilities.text === 'unsupported' ? '该目标路线不支持所选协议' : '当前协议、地址或型号组合不可用，请核对配置'}</p>}
        {tests[connection.connectionId] && <ModelTestFeedback {...tests[connection.connectionId]!}
          onRetry={!checkDisabled(connection) ? () => onCheck(connection) : undefined} />}
        </ModelProviderModelRow>)}</div>}
      </ModelProviderCard>)}
    </div>
  </>
}
