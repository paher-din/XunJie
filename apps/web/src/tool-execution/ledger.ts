import { advanceExecution, executionQuerySchema, isTerminalExecutionState, type ExecutionAction, type ExecutionQuery, type ExecutionState } from '@xunjie/contracts/execution'
import type { ExecutionAcceptance } from '@xunjie/contracts/execution'

/** One accepted command as this browser owns it. Never derived from an iframe's memory. */
export interface ExecutionRecord {
  scope: string
  requestId: string
  inputDigest: string
  executionRef: string
  action: ExecutionAction
  acceptance: ExecutionAcceptance
  query: ExecutionQuery
  /** Executor generation that owns this run; a newer page must not adopt an older generation's run. */
  generation: number
  /** Set once the executor really started; before that the run cannot have produced effects. */
  startedAt: number | null
  stoppedAt: number | null
  createdAt: number
}

export type StopDecision = 'blocked' | 'pre-start-cancel' | 'stop-worker' | 'already-terminal'

export const recordKey = (scope: string, requestId: string) => JSON.stringify([scope, requestId])

/** A queued run has not started, so nothing can have been produced yet. */
export function stopDecision(record: ExecutionRecord | null, query: ExecutionQuery | null): StopDecision {
  if (query?.statusKnowledge === 'confirmed' && isTerminalExecutionState(query.state)) return 'already-terminal'
  if (!record) return 'blocked'
  if (record.startedAt === null) return 'pre-start-cancel'
  return 'stop-worker'
}

/** Progress is only ever what the real executor observed; a lost worker is unknown knowledge, not a failure. */
export function progressQuery(current: ExecutionQuery, next: { state: ExecutionState; output?: ExecutionQuery['output']
  reason?: ExecutionQuery['reason']; confirmedSeq: number; statusKnowledge?: 'confirmed' | 'unknown' }): ExecutionQuery {
  return advanceExecution(current, executionQuerySchema.parse({ ...current, state: next.state,
    statusKnowledge: next.statusKnowledge ?? 'confirmed', confirmedSeq: next.confirmedSeq,
    reason: next.reason ?? null, output: next.output ?? null }))
}

/** A reload cannot prove the old worker kept running, and cannot prove it stopped either. */
export function abandonedQuery(current: ExecutionQuery): ExecutionQuery {
  if (current.statusKnowledge === 'confirmed' && isTerminalExecutionState(current.state)) return current
  return advanceExecution(current, executionQuerySchema.parse({ ...current, statusKnowledge: 'unknown',
    reason: { code: 'worker-terminated', detail: '原页面的执行器不再由本页持有，无法核实其状态；不会自动重启。' } }))
}

export function stateLabel(query: ExecutionQuery): string {
  const knowledge = query.statusKnowledge === 'unknown' ? '（状态待核实）' : ''
  const stop = query.stopRequested && !isTerminalExecutionState(query.state) ? ' · 已请求停止' : ''
  const labels: Record<ExecutionState, string> = { queued: '已接收，等待执行', running: '正在执行', paused: '已暂停',
    succeeded: '已完成', failed: '未完成', cancelled: '已取消' }
  return labels[query.state] + knowledge + stop
}
