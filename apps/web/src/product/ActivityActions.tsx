import { useState, useSyncExternalStore } from 'react'
import { useActivitySession } from './ActivitySession'
import type { ActionPhase } from '../reliable-workspace/action-store'

const labels: Record<ActionPhase, string> = { unprotected: '尚未可靠保留', 'waiting-dependencies': '等待本次内容',
  ready: '等待接收方', dispatched: '已发出，正在核实', accepted: '接收方已接受', cancelled: '已取消', failed: '未被接受' }
/** These are explicit action facts, not routine editing/save status or generated Agent answers. */
export function ActivityActions() {
  const { actions } = useActivitySession()
  const state = useSyncExternalStore(actions.subscribe, actions.snapshot)
  const [failure, setFailure] = useState('')
  const attempt = async (operation: () => Promise<unknown>) => {
    try { await operation(); setFailure('') }
    catch { setFailure('操作尚未完成，原动作与当前草稿仍保留。请稍后重试或复制原内容。') }
  }
  if (!state.items.length && !state.previous.length && !state.error) return null
  return <section aria-label="待发与接收记录" className="learning-action-records">
    <h3>待发与接收记录</h3>
    {state.error && <p role="alert" className="learning-error">{state.error}</p>}
    {failure && <p role="alert" className="learning-error">{failure}</p>}
    {state.items.map(item => {
      // A stop is only reported as cancelled once the original authority confirmed it.
      const cancelled = ['accepted', 'cancelled', 'failed'].includes(item.phase)
      const cancelPending = item.cancelRequested && !cancelled
      return <article key={item.input.requestId} className="learning-action-record">
        <p role="status">{cancelPending ? '已记录取消请求，正在核实接收方状态' : labels[item.phase]}</p>
        <pre>{item.input.draft.question || '（本次未填写问题）'}</pre>
        <details><summary>查看这次固定内容</summary>
          {item.input.draft.references.map(reference => <div key={reference.referenceId}><strong>{reference.sourceName}</strong><pre>{reference.copy}</pre></div>)}
          {item.input.works.map(file => <div key={file.objectId}><strong>{file.name}</strong><pre>{file.value}</pre></div>)}
          {item.remote?.receipt && <p className="detail">{item.remote.receipt.detail || '接收方已核实原请求。'}</p>}
        </details>
        {item.error && <p role="alert" className="learning-error">{item.error}</p>}
        <div className="action-controls">
          {!cancelled && !cancelPending && <button type="button"
            onClick={() => void attempt(() => actions.cancel(item.input.requestId))}>取消这次动作</button>}
          {item.history && ['ready', 'dispatched'].includes(item.phase) && <button type="button"
            onClick={() => void attempt(() => actions.reconnect(item.input.requestId))}>核对并继续原动作</button>}
          {['cancelled', 'failed'].includes(item.phase) && <button type="button"
            onClick={() => void attempt(() => actions.recover(item.input.requestId))}>恢复为独立草稿</button>}
        </div>
        {item.recovered && <div className="learning-recovered-draft">
          <label>取回的问题<textarea readOnly value={item.recovered.question} /></label>
          {item.recovered.references.map(reference => <pre key={reference.referenceId}>{reference.copy}</pre>)}
          <button type="button" onClick={() => void attempt(() => actions.mergeRecovered(item.input.requestId))}>明确合并到当前问题</button>
        </div>}
        {item.phase === 'accepted' && <p className="detail">已被接受的动作不承诺撤回；后续修改仍保留在当前草稿。</p>}
      </article>})}
    {!!state.previous.length && <details><summary>旧环境中保留的动作（{state.previous.length}）</summary>
      <p className="detail">这些动作不会自动发送。接回前会核对原空间、接收方和原请求；不会重新运行实验。</p>
      {state.previous.map(item => <div key={item.key}><pre>{item.input.draft.question}</pre>
        <button type="button" onClick={() => void attempt(() => actions.reconnect(item.input.requestId, item.scope))}>核实并接回原动作</button>
      </div>)}
    </details>}
  </section>
}
