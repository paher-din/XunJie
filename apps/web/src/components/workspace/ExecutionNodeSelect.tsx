import { useEffect, useSyncExternalStore } from 'react'
import { getExecutionNodes, loadExecutionNodes, selectExecutionNode, subscribeExecutionNodes } from '../../workspace/executionNodes'
import { ExecutionNodeSelect as ExecutionNodeSelectView } from '@xunjie/ui/workspace'

/** Shares the workspace toolbar's existing field/button styles. The selection belongs to this browser tab. */
export function ExecutionNodeSelect({ userId, kind, busy, onChange }: { userId: string; kind: 'c' | 'hdl' | 'any'; busy: boolean; onChange?: () => void }) {
  const state = useSyncExternalStore(subscribeExecutionNodes, getExecutionNodes)
  useEffect(() => { void loadExecutionNodes(userId) }, [userId])
  return <ExecutionNodeSelectView state={state} identityCurrent={state.userId === userId} kind={kind} busy={busy}
    onSelect={nodeId => { selectExecutionNode(nodeId); onChange?.() }}
    onRefresh={() => { void loadExecutionNodes(userId).then(() => onChange?.()) }} />
}
