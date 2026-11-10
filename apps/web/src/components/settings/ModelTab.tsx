import type { ModelAttempt, ModelConnection, ModelProvider } from '@xunjie/contracts/model-connections'
import { Section, ModelProviderCard, Toggle, reasoningEffortLabels } from '@xunjie/ui/settings'
import { Icon } from '@xunjie/ui/icons'

const states: Record<ModelAttempt['state'], string> = { accepted: '检查已接收，尚未开始', dispatched: '正在检查',
  completed: '检查已完成', incomplete: '检查未完整结束', failed: '检查失败', cancelled: '已停止本机检查', unknown: '检查结果待核实' }
const capabilities = { unknown: '尚未验证', declared: '服务声明', verified: '已验证', unsupported: '不支持' }

/** Formal model settings presentation. No legacy Session, settings store or model transport. */
export function ModelTab({ providers, attempts, loading, error, toggleState, onToggle, onNew, onEdit, onAddModel, onCheck, onCancel, onReload }: {
  providers: ModelProvider[]; attempts: ModelAttempt[]; loading: boolean; error: string
  toggleState: Record<string, 'saving' | 'unknown'>; onToggle(provider: ModelProvider, connectionId?: string): void
  onNew(): void; onEdit(provider: ModelProvider): void; onAddModel(provider: ModelProvider): void; onCheck(connection: ModelConnection): void
  onCancel(attempt: ModelAttempt): void; onReload(): void
}) {
  return <>
    <Section title="模型供应商">
      <div className="skill-actions">
        <button type="button" className="primary" onClick={onNew}><Icon name="add" size={16} />添加供应商</button>
        <button type="button" className="outline" onClick={onReload} disabled={loading}>重新读取配置</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">正在读取配置…</p>}
      {!loading && !error && providers.length === 0 && <p className="detail">尚未添加供应商。添加后可配置模型并检查连接。</p>}
      {providers.map(provider => <ModelProviderCard key={provider.providerId} name={provider.name} address={provider.baseUrl}
        credentialLabel={provider.hasCredential ? '密钥已保存' : '尚未保存密钥'}
        actions={<><button type="button" className="outline st-xs" disabled={Boolean(toggleState[provider.providerId])} onClick={() => onEdit(provider)}>编辑</button>
          <Toggle checked={provider.enabled} label={`启用供应商 ${provider.name}`} disabled={Boolean(toggleState[provider.providerId])} onChange={() => onToggle(provider)} /></>}>
        <div className="st-configured-models" aria-label={`${provider.name}的模型`}>
        {provider.models.map(connection => <div className="st-configured-model" key={connection.connectionId}>
        <div className="st-configured-model-head"><span className="st-model-chip">{connection.modelId}</span>
          <span className="st-configured-model-effort">{reasoningEffortLabels[connection.reasoningEffort ?? 'auto']}</span>
          <Toggle checked={connection.modelEnabled ?? connection.enabled} label={`启用模型 ${connection.modelId}`} disabled={Boolean(toggleState[provider.providerId])}
            onChange={() => onToggle(provider, connection.connectionId)} />
        </div>
        <div className="st-provider-test"><button type="button" className="outline st-xs" disabled={loading || !connection.enabled || !connection.hasCredential || connection.adapterState !== 'ready'
          || attempts.some(attempt => attempt.connection.connectionId === connection.connectionId && (attempt.state === 'accepted' || !attempt.physicalRequestEnded))}
          onClick={() => onCheck(connection)}>连接检查</button>
          {connection.adapterState !== 'ready' && <span>{connection.capabilities.text === 'unsupported' ? '该目标路线不支持所选协议' : '当前协议、地址或型号组合不可用，请核对配置'}</span>}</div>
        <details>
          <summary>连接与能力</summary>
          <p className="detail">{connection.protocol} · 版本 {connection.version}</p>
          <p className="detail">图像：{capabilities[connection.capabilities.images]} · 工具：{capabilities[connection.capabilities.tools]} · strict schema：{capabilities[connection.capabilities.strictSchema]}</p>
        </details></div>)}</div>
        <div className="st-provider-bottom"><button type="button" className="outline st-xs" disabled={Boolean(toggleState[provider.providerId])} onClick={() => onAddModel(provider)}><Icon name="add" size={14} />添加模型</button>
          {!provider.enabled && <span className="detail">供应商已停用</span>}
          {toggleState[provider.providerId] === 'saving' && <span role="status" className="detail">正在保存…</span>}
          {toggleState[provider.providerId] === 'unknown' && <button type="button" className="outline st-xs" onClick={() => onToggle(provider)}>核对开关提交</button>}
        </div>
      </ModelProviderCard>)}
      <p className="detail">配置由原持有方保留，跨空间使用需单独授权。未配置或检查失败不影响建立活动、编辑作品和保留问题。</p>
    </Section>
    {attempts.length > 0 && <details>
      <summary>连接检查记录（{attempts.length}）</summary>
      <p className="detail">检查仅使用有限合成文本，不读取作品，也不会触发学习对话。</p>
      {attempts.map(attempt => <article className="st-panel model-check-record" key={attempt.attemptId}>
        <strong>{attempt.connection.name} · {attempt.connection.modelId}</strong>
        <p role="status">{states[attempt.state]}</p>
        {attempt.text && <p className="preserve-lines">{attempt.text}</p>}
        <p className="detail">{attempt.usage.state === 'unknown' ? '用量未知' : `${attempt.usage.state === 'final' ? '最终用量' : '部分用量'} · 输入 ${attempt.usage.inputTokens ?? '未知'} / 输出 ${attempt.usage.outputTokens ?? '未知'}`}</p>
        {attempt.reason && !['stop', 'completed'].includes(attempt.reason) && <p className="detail">{attempt.reason === 'upstream-unsupported' ? '上游明确不支持本次模型或参数组合' : attempt.reason}</p>}
        {attempt.cancelRequested && <p className="detail">上游是否停止计算及费用仍未知。</p>}
        {(attempt.state === 'accepted' || ['dispatched', 'unknown'].includes(attempt.state) && !attempt.physicalRequestEnded) && <button type="button" className="outline st-xs" onClick={() => onCancel(attempt)}>停止检查</button>}
      </article>)}
    </details>}
  </>
}
