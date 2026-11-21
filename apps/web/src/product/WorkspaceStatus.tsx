import { useSyncExternalStore } from 'react'
import { WorkspaceStatusBar } from '@xunjie/ui/workspace'
import { isTerminalExecutionState, type ExecutionQuery } from '@xunjie/contracts/execution'
import type { WorkspaceState } from '../reliable-workspace'
import { useActivitySession } from './ActivitySession'

function workStatus(state: WorkspaceState, readOnly: boolean) {
  if (readOnly) return { label: '作品只读' }
  if (state.conflict) return { label: '作品存在分歧，请核对' }
  if (state.error) return { label: '作品保存待核对' }
  if (!state.ready || !state.protection) return { label: '正在读取作品' }
  if (state.protection.unprotected) return { label: '保存中…', description: '正在保存作品到本机' }
  if (state.protection.pendingConfirmation)
    return { label: '版本待确认', description: '草稿已保存到本机，作品版本待确认' }
  return { label: '已保存', description: `作品已保存到本机（v${state.protection.revision}）` }
}

function executionStatus(queries: ExecutionQuery[], pending: boolean, unavailable: boolean) {
  const active = [...new Map(queries.map(query => [query.requestId, query])).values()]
    .filter(query => !isTerminalExecutionState(query.state))
  if (pending || (active.length > 0 && unavailable) || active.some(query => query.statusKnowledge !== 'confirmed'))
    return '工具运行待确认'
  const labels = ([['running', '工具运行中'], ['queued', '工具排队中'], ['paused', '工具已暂停']] as const).flatMap(([state, label]) => {
    const count = active.filter(query => query.state === state).length
    return count ? [`${label} ${count}`] : []
  })
  return labels.join(' · ') || undefined
}

export function WorkspaceStatus({ closed, hasTools }: { closed: boolean; hasTools: boolean }) {
  const { workspace, execution, sessions } = useActivitySession()
  const work = useSyncExternalStore(workspace.subscribe, workspace.snapshot)
  const runs = useSyncExternalStore(execution.subscribe, execution.snapshot)
  const native = useSyncExternalStore(sessions.subscribe, sessions.snapshot)
  const save = workStatus(work, workspace.isReadOnly())
  return <WorkspaceStatusBar closed={closed} workLabel={save.label} workDescription={save.description}
    attention={!!work.error || !!work.conflict}
    executionLabel={hasTools ? executionStatus([...runs.records.map(record => record.query), ...native.queries],
      native.pending.length > 0, !!runs.error || !!native.error) : undefined} />
}
