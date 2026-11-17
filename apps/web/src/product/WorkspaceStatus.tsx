import { useSyncExternalStore } from 'react'
import { WorkspaceStatusBar } from '@xunjie/ui/workspace'
import type { WorkspaceState } from '../reliable-workspace'
import { useActivitySession } from './ActivitySession'
import { executionSummary } from './workspace-status-presentation'

export function workspaceSaveLabel(state: WorkspaceState, readOnly: boolean) {
  if (readOnly) return '作品只读'
  if (!state.ready) return '正在读取作品'
  if (state.conflict) return '作品存在分歧，请核对'
  if (state.error) return '作品保存待核对'
  if (!state.protection) return '作品自动保存'
  if (state.protection.unprotected) return '正在保护作品修改'
  if (state.protection.pendingConfirmation) return '草稿已在本机保存 · 版本待确认'
  return `作品已在本机保存 · v${state.protection.revision}`
}
export function WorkspaceStatus({ closed, hasTools, onWorks, onTools, onGuide }: {
  closed: boolean; hasTools: boolean; onWorks(): void; onTools(): void; onGuide(): void
}) {
  const { workspace, execution, sessions } = useActivitySession()
  const work = useSyncExternalStore(workspace.subscribe, workspace.snapshot)
  const runs = useSyncExternalStore(execution.subscribe, execution.snapshot)
  const native = useSyncExternalStore(sessions.subscribe, sessions.snapshot)
  const queries = [...runs.records.flatMap(record => record.query ? [record.query] : []), ...native.queries]
  return <WorkspaceStatusBar closed={closed} workLabel={workspaceSaveLabel(work, workspace.isReadOnly())}
    attention={!!work.error || !!work.conflict} onWorks={onWorks} onGuide={onGuide} onTools={hasTools ? onTools : undefined}
    executionLabel={hasTools ? executionSummary(queries, !!runs.error || !!native.error || native.pending.length > 0, runs.ready && native.ready) : undefined} />
}
