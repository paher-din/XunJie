import { useEffect, useSyncExternalStore } from 'react'
import { getExecutionNodes, loadExecutionNodes, selectExecutionNode, subscribeExecutionNodes } from '../../workspace/executionNodes'

/** Shares the workspace toolbar's existing field/button styles. The selection belongs to this browser tab. */
export function ExecutionNodeSelect({ userId, kind, busy, onChange }: { userId: string; kind: 'c' | 'hdl' | 'any'; busy: boolean; onChange?: () => void }) {
  const state = useSyncExternalStore(subscribeExecutionNodes, getExecutionNodes)
  useEffect(() => { void loadExecutionNodes(userId) }, [userId])
  if (state.userId !== userId || state.status === 'idle' || state.status === 'unsupported') return null
  const selected = state.nodes.find(node => node.nodeId === state.selectedNodeId)
  const ready = kind === 'c' ? selected?.cReady : kind === 'hdl' ? selected?.hdlReady : selected?.cReady || selected?.hdlReady
  const notice = state.notice || (state.status === 'loading' ? '正在读取执行电脑…' : !selected ? '请选择自己的执行电脑' : ready ? '执行电脑已连接' : '执行电脑未就绪；仍可编辑和保存')
  return <div className="ws-execution-node">
    <select className="st-input" aria-label="执行电脑" value={state.selectedNodeId} disabled={busy || state.status !== 'ready'}
      onChange={event => { selectExecutionNode(event.target.value); onChange?.() }}>
      <option value="">选择执行电脑</option>
      {state.nodes.map(node => <option key={node.nodeId} value={node.nodeId}>{node.label}</option>)}
    </select>
    <span className="ws-execution-status" role="status" title={notice}>{notice}</span>
    <button className="textbtn" disabled={busy || state.status === 'loading'} onClick={() => { void loadExecutionNodes(userId).then(() => onChange?.()) }}>刷新</button>
  </div>
}
