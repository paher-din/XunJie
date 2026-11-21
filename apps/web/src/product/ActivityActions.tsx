import { useSyncExternalStore } from 'react'
import { toast } from '@xunjie/ui/feedback'
import { Button } from '@xunjie/ui/foundation'
import { Icon } from '@xunjie/ui/icons'
import { isExecutionAction } from '@xunjie/contracts/execution'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { useActivitySession } from './ActivitySession'
import type { ActionPhase } from '../reliable-workspace/action-store'
import { stateLabel } from '../tool-execution/ledger'

const labels: Record<ActionPhase, string> = { unprotected: '尚未可靠保留', 'waiting-dependencies': '等待本次内容',
  ready: '等待接收方', dispatched: '已发出，正在核实', accepted: '接收方已接受', cancelled: '已取消', failed: '未被接受' }
/** These are explicit action facts, not routine editing/save status or generated Agent answers. */
export function ActivityActions({ activity }: { activity: LearningActivity }) {
  const { actions, execution, workspace } = useActivitySession()
  const state = useSyncExternalStore(actions.subscribe, actions.snapshot)
  const runs = useSyncExternalStore(execution.subscribe, execution.snapshot).records
  const attempt = async (operation: () => Promise<unknown>) => {
    if (workspace.isReadOnly()) return
    try { await operation() }
    catch { toast.error('操作尚未完成，原动作与当前草稿仍保留。请稍后重试或复制原内容。') }
  }
  const visibleItems = state.items.filter(item => isExecutionAction(item.input) || item.phase !== 'accepted')
  if (!visibleItems.length && !state.previous.length && !state.error) return null
  const queries = new Map(runs.map(run => [run.requestId, run.query]))
  const records = visibleItems.map(item => {
    const query = queries.get(item.input.requestId)
    const needsAttention = Boolean(item.error) || query?.statusKnowledge === 'unknown' || query?.state === 'failed'
      || (item.phase !== 'accepted' && item.phase !== 'cancelled')
    return { item, query, needsAttention }
  }).sort((left, right) => Number(right.needsAttention) - Number(left.needsAttention))
  const showAttention = Boolean(state.error) || records.some(record => record.needsAttention)
  const record = ({ item, query }: (typeof records)[number]) => {
    const input = item.input
    const isExecution = isExecutionAction(input)
    const name = isExecution
      ? activity.course?.components?.find(binding => binding.key === input.execution.instance.key)?.configuration.title
        ?? (input.execution.operation.effect === 'input' ? '工具输入' : '工具运行')
      : input.draft.question || '未填写问题'
    // A stop is only reported as cancelled once the original authority confirmed it.
    const settled = ['accepted', 'cancelled', 'failed'].includes(item.phase)
    const cancelPending = item.cancelRequested && !settled
    const status = cancelPending && !query ? '已记录取消请求，正在核实接收方状态' : query ? stateLabel(query) : labels[item.phase]
    const failed = query?.statusKnowledge !== 'unknown' && (Boolean(item.error) || query?.state === 'failed' || item.phase === 'failed')
    return <details key={input.requestId} className="learning-action-record">
      <summary className="learning-action-summary">
        <span className="learning-action-name" title={name}>{name}</span>
        <span className="learning-action-status" role="status" data-failed={failed || undefined}>{status}</span>
        <Icon name="alt-arrow-down" size={13} className="learning-action-chevron" />
      </summary>
      <div className="learning-action-detail">
        {isExecution ? <>
          <h3>本次固定输入</h3>
          <p className="detail">操作：{input.execution.instance.key} · {input.execution.operation.operationId}</p>
          <p className="detail">参数：{JSON.stringify(input.execution.parameters)}</p>
          <p className="detail">依据作品：{input.execution.basis.works.map(file => file.name).join('、') || '无'}</p>
          <p className="detail">方案：{input.execution.plan.planId} v{input.execution.plan.planVersion} · {input.execution.plan.location}</p>
          <p className="detail">发起者：{input.execution.initiator.kind}</p>
        </> : <>
          <h3>本次固定内容</h3>
          <p className="learning-action-question">{name}</p>
          {input.draft.references.map(reference => <div key={reference.referenceId}><strong>{reference.sourceName}</strong><pre>{reference.copy}</pre></div>)}
          {input.works.map(file => <div key={file.objectId}><strong>{file.name}</strong><pre>{file.value}</pre></div>)}
        </>}
        {query?.reason && <p className="detail">{query.reason.code}：{query.reason.detail}</p>}
        {item.localAcceptance?.receipt && <p className="detail">{item.localAcceptance.receipt.detail}</p>}
        {item.remote?.receipt && <p className="detail">{item.remote.receipt.receiver.receiverId.startsWith('teaching-agent:')
          ? item.remote.receipt.state === 'accepted' ? 'Agent 已接收这次学习请求，进展和回应保留在学习对话中。'
            : '这次学习请求已取消，原输入仍保留。'
          : item.remote.receipt.detail || '接收方已核实原请求。'}</p>}
        {item.error && <p role="alert" className="learning-error">{item.error}</p>}
        {!workspace.isReadOnly() && <div className="action-controls">
          {!settled && !cancelPending && <Button type="button" variant="outline"
            onClick={() => void attempt(() => actions.cancel(input.requestId))}>取消这次动作</Button>}
          {!isExecution && item.history && ['ready', 'dispatched'].includes(item.phase) && <Button type="button" variant="outline"
            onClick={() => void attempt(() => actions.reconnect(input.requestId))}>核对并继续原动作</Button>}
          {!isExecution && ['cancelled', 'failed'].includes(item.phase) && <Button type="button" variant="outline"
            onClick={() => void attempt(() => actions.recover(input.requestId))}>恢复为独立草稿</Button>}
        </div>}
        {item.recovered && <div className="learning-recovered-draft">
          <label>取回的问题<textarea readOnly value={item.recovered.question} /></label>
          {item.recovered.references.map(reference => <pre key={reference.referenceId}>{reference.copy}</pre>)}
          <Button type="button" variant="outline" onClick={() => void attempt(() => actions.mergeRecovered(input.requestId))}>明确合并到当前问题</Button>
        </div>}
        {item.phase === 'accepted' && <p className="detail">{isExecution
          ? '执行已被接收；完成、失败与停止是另外的执行事实，见工具区的运行记录。'
          : '已被接受的动作不承诺撤回；后续修改仍保留在当前草稿。'}</p>}
      </div>
    </details>
  }
  return <details className="learning-action-records">
    <summary className="learning-action-history-toggle">
      <Icon name="clock-circle" size={16} variant="linear" />
      <span>待发与接收记录</span>
      {showAttention && <span className="learning-action-attention" role="status">待核对</span>}
      <Icon name="alt-arrow-down" size={13} className="learning-action-chevron" />
    </summary>
    <section aria-label="待发与接收记录" className="learning-action-history">
      {state.error && <p role="alert" className="learning-error">{state.error}</p>}
      {records.map(record)}
      {!!state.previous.length && <details className="learning-action-record learning-action-previous">
        <summary className="learning-action-summary">
          <span>旧环境中保留的动作（{state.previous.length}）</span>
          <Icon name="alt-arrow-down" size={13} className="learning-action-chevron" />
        </summary>
        <div className="learning-action-detail">
          <p className="detail">这些动作不会自动发送。接回前会核对原空间、接收方和原请求；不会重新运行实验。</p>
          {state.previous.map(item => <div key={item.key}><pre>{isExecutionAction(item.input)
            ? item.input.execution.operation.operationId : item.input.draft.question}</pre>
            {!isExecutionAction(item.input) && <Button type="button" variant="outline"
              onClick={() => void attempt(() => actions.reconnect(item.input.requestId, item.scope))}>核实并接回原动作</Button>}
          </div>)}
        </div>
      </details>}
    </section>
  </details>
}
