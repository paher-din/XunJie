import { apiGet, WorkspaceRequestError } from './http'

export interface ExecutionNode { nodeId: string; label: string; cReady: boolean; hdlReady: boolean }
export interface ExecutionNodesState {
  status: 'idle' | 'loading' | 'ready' | 'unsupported' | 'unavailable'
  userId: string | null; nodes: ExecutionNode[]; selectedNodeId: string; notice: string
}
const storageKey = 'xunjie-execution-node'
const empty = (): ExecutionNodesState => ({ status: 'idle', userId: null, nodes: [], selectedNodeId: '', notice: '' })
let state = empty(), epoch = 0
let pending: Promise<void> | null = null
const listeners = new Set<() => void>()
export const getExecutionNodes = () => state
export function subscribeExecutionNodes(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener) } }
function publish(next: ExecutionNodesState): void { state = next; listeners.forEach(listener => listener()) }
export function clearExecutionNodes(): void {
  epoch++; pending = null
  try { sessionStorage.removeItem(storageKey) } catch { /* A selection is never required for editing. */ }
  publish(empty())
}
function cachedNode(userId: string): string {
  try { const value = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null'); return value?.userId === userId && typeof value.nodeId === 'string' ? value.nodeId : '' }
  catch { return '' }
}
/** An empty registry or an older 404 endpoint preserves the existing local-host path. */
export function loadExecutionNodes(userId: string): Promise<void> {
  if (pending && state.userId === userId) return pending
  const current = ++epoch
  const selected = state.userId === userId ? state.selectedNodeId : cachedNode(userId)
  publish({ ...(state.userId === userId ? state : empty()), userId, status: state.userId === userId && state.status === 'ready' ? 'ready' : 'loading', selectedNodeId: selected })
  const request = (async () => {
    try {
      const value = await apiGet<unknown>('/execution-nodes', { mode: 'real', timeoutMs: 6500 })
      if (current !== epoch) return
      const nodes = (value as { nodes?: unknown } | null)?.nodes
      if (!Array.isArray(nodes) || nodes.some(n => !n || typeof n.nodeId !== 'string' || !n.nodeId || typeof n.label !== 'string' ||
        typeof n.cReady !== 'boolean' || typeof n.hdlReady !== 'boolean') || new Set(nodes.map(n => n.nodeId)).size !== nodes.length) throw new Error('节点列表不可用')
      const latestSelection = state.userId === userId ? state.selectedNodeId : selected
      publish({ status: nodes.length ? 'ready' : 'unsupported', userId, nodes, selectedNodeId: nodes.some(n => n.nodeId === latestSelection) ? latestSelection : '', notice: '' })
    } catch (error) {
      if (current !== epoch) return
      const unsupported = error instanceof WorkspaceRequestError && error.failure.kind !== 'transport' && error.failure.status === 404
      publish({ ...empty(), userId, status: unsupported ? 'unsupported' : 'unavailable', notice: unsupported ? '' : '执行电脑列表暂时无法读取；编辑与保存仍可继续。' })
    } finally { if (current === epoch) pending = null }
  })()
  pending = request
  return request
}
export function selectExecutionNode(nodeId: string): void {
  if (state.status !== 'ready' || nodeId && !state.nodes.some(node => node.nodeId === nodeId)) return
  try { sessionStorage.setItem(storageKey, JSON.stringify({ userId: state.userId, nodeId })) } catch { /* This page can still use its explicit choice. */ }
  publish({ ...state, selectedNodeId: nodeId })
}
export const selectedExecutionNode = (): string | undefined => state.status === 'ready' ? state.selectedNodeId || undefined : undefined
/** Undefined means the existing single-runner service must retain its original health check. */
export async function executionNodeReady(userId: string, kind: 'c' | 'hdl', originalControl = false): Promise<boolean | undefined> {
  await loadExecutionNodes(userId)
  if (state.userId !== userId) return false
  if (state.status === 'unsupported') return undefined
  if (state.status !== 'ready') return false
  // Existing Build/Session commands are routed by the backend to their original node.
  if (originalControl) return true
  const selected = state.nodes.find(node => node.nodeId === state.selectedNodeId)
  return kind === 'c' ? selected?.cReady === true : selected?.hdlReady === true
}
