import type { ModelAttempt, ModelConnection } from '@xunjie/contracts/model-connections'
import { Section, ModelProviderCard } from '@xunjie/ui/settings'
import { Icon } from '@xunjie/ui/icons'

const states: Record<ModelAttempt['state'], string> = { accepted: '检查已接收，尚未开始', dispatched: '正在检查',
  completed: '检查已完成', incomplete: '检查未完整结束', failed: '检查失败', cancelled: '已停止本机检查', unknown: '检查结果待核实' }
const capabilities = { unknown: '尚未验证', declared: '服务声明', verified: '已验证', unsupported: '不支持' }

/** Formal model settings presentation. No legacy Session, settings store or model transport. */
export function ModelTab({ connections, attempts, loading, error, onNew, onEdit, onCheck, onCancel, onReload }: {
  connections: ModelConnection[]; attempts: ModelAttempt[]; loading: boolean; error: string
  onNew(): void; onEdit(connection: ModelConnection): void; onCheck(connection: ModelConnection): void
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
      {!loading && !error && connections.length === 0 && <p className="detail">尚未添加供应商。添加后可配置模型并检查连接。</p>}
      {connections.map(connection => <ModelProviderCard key={connection.connectionId} name={connection.name} address={connection.baseUrl}
        credentialLabel={connection.hasCredential ? '密钥已保存' : '尚未保存密钥'}
        actions={<button type="button" className="outline st-xs" onClick={() => onEdit(connection)}>编辑</button>}>
        <div className="st-provider-models"><span className="st-model-chip">{connection.modelId}</span>
          <span className="st-status-pill">{connection.enabled ? '已配置' : '已停用'}</span>
        </div>
        <div className="st-provider-test"><button type="button" className="outline st-xs" disabled={loading || !connection.enabled || !connection.hasCredential || connection.adapterState !== 'ready'
          || attempts.some(attempt => attempt.connection.connectionId === connection.connectionId && (attempt.state === 'accepted' || !attempt.physicalRequestEnded))}
          onClick={() => onCheck(connection)}>连接检查</button>
          {connection.adapterState !== 'ready' && <span>{connection.capabilities.text === 'unsupported' ? '该目标路线不支持所选协议' : '当前协议、地址或型号组合不可用，请核对配置'}</span>}</div>
        <details>
          <summary>SDK 与能力</summary>
          <p className="detail">{connection.protocol} · 版本 {connection.version}</p>
          <p className="detail">SDK 路径：{connection.path} · {connection.dialect} · {connection.parameterMode === 'thinking' ? '思考模式' : '普通文本'}</p>
          <p className="detail">图像：{capabilities[connection.capabilities.images]} · 工具：{capabilities[connection.capabilities.tools]} · strict schema：{capabilities[connection.capabilities.strictSchema]}</p>
        </details>
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
