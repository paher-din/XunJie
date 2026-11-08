import { WorkspacePopover } from './WorkspacePopover'
export interface ExecutionNodesDisplay {
  status: 'idle' | 'loading' | 'ready' | 'unsupported' | 'unavailable'
  selectedNodeId: string
  nodes: Array<{ nodeId: string; label: string; cReady: boolean; hdlReady: boolean }>
  notice: string | null
}
export interface ExecutionNodeSelectProps {
  state: ExecutionNodesDisplay; identityCurrent: boolean; kind: 'c' | 'hdl' | 'any'; busy: boolean
  onSelect: (nodeId: string) => void; onRefresh: () => void
}
export function ExecutionNodeSelect({ state, identityCurrent, kind, busy, onSelect, onRefresh }: ExecutionNodeSelectProps) {
  if (!identityCurrent || state.status === 'idle' || state.status === 'unsupported') return null
  const selected = state.nodes.find(node => node.nodeId === state.selectedNodeId)
  const ready = kind === 'c' ? selected?.cReady : kind === 'hdl' ? selected?.hdlReady : selected?.cReady || selected?.hdlReady
  const notice = state.notice || (state.status === 'loading' ? '正在读取执行电脑…' : !selected ? '请选择自己的执行电脑' : ready ? '执行电脑已连接' : '执行电脑未就绪；仍可编辑和保存')
  const suffix = state.notice ? ' · 状态待核对' : state.status === 'loading' ? ' · 读取中' : ready ? '' : ' · 未就绪'
  return <WorkspacePopover label={selected ? `${selected.label}${suffix}` : '选择执行电脑'} accessibleLabel="执行电脑设置" icon="laptop" attention={!ready || !!state.notice}>
    <p role="status">{notice}</p>
    <div className="ws-execution-node">
    <select className="st-input" aria-label="执行电脑" value={state.selectedNodeId} disabled={busy || state.status !== 'ready'}
      onChange={event => { onSelect(event.target.value) }}>
      <option value="">选择执行电脑</option>
      {state.nodes.map(node => <option key={node.nodeId} value={node.nodeId}>{node.label}</option>)}
    </select>
    <button className="textbtn" disabled={busy || state.status === 'loading'} onClick={() => { onRefresh() }}>刷新</button>
    </div>
  </WorkspacePopover>
}
