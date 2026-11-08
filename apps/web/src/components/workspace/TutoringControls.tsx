import { TutoringControlsView } from '@xunjie/ui/workspace'
import { useEffect, useRef, useState } from 'react'
import type { ActivityView, AssignmentView } from '../../workspace/contracts'
import type { ConfirmationWorkspace } from '../../workspace/confirmationWorkspace'
import { describeTutoringPolicy, controlAllowed, TutoringControlsWorkspace, type ControlsState } from '../../workspace/tutoringControls'
import type { TutorCoverage } from '../../workspace/tutoringContracts'

export interface TutoringControlsProps {
  confirmation: ConfirmationWorkspace | null
  activity: ActivityView
  assignment: AssignmentView
  coverage?: TutorCoverage
  /** 主页面用权威分配更新已有保存/新建/运行守卫，不能以旧 init.active 代替。 */
  onAssignmentChange?: (assignment: AssignmentView) => void
}
/** 插入既有任务/消息槽；自身不创建页面、布局、模型请求或后台采集。 */
export function TutoringControls({ confirmation, activity, assignment, onAssignmentChange, coverage }: TutoringControlsProps) {
  const [binding, setBinding] = useState<{ client: TutoringControlsWorkspace; state: ControlsState } | null>(null)
  const onAssignmentRef = useRef(onAssignmentChange)
  onAssignmentRef.current = onAssignmentChange
  const context = confirmation?.context
  useEffect(() => {
    setBinding(null)
    if (!confirmation || !context?.attemptId) return
    const client = new TutoringControlsWorkspace(confirmation)
    const unsubscribe = client.subscribe(state => setBinding({ client, state }))
    void client.refresh()
    const observeConfirmation = confirmation.subscribe(snapshot => {
      const next = snapshot.attempt, known = client.current.attempt
      if (next && known && (next.attemptRevision !== known.attemptRevision || next.decisionEpoch !== known.decisionEpoch ||
        next.captureRevision !== known.captureRevision || next.status !== known.status)) void client.refresh()
    })
    // 标签间只广播需重读，不广播政策、开关或私有数据，也不自动发送命令。
    const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('xunjie-i0-tutor-controls')
    if (channel) channel.onmessage = () => { void client.refresh() }
    let previous = client.current.phase
    const broadcast = client.subscribe(state => {
      if (previous === 'sending' && state.phase === 'ready') channel?.postMessage({ changed: true })
      previous = state.phase
    })
    // Ending a check does not necessarily change Attempt revisions. Re-read its public flag rather than
    // infer completion from elapsed time or a Job status; paused attempts remain readable.
    const timer = window.setInterval(() => { void client.refresh() }, 2500)
    return () => { clearInterval(timer); broadcast(); observeConfirmation(); unsubscribe(); client.dispose(); channel?.close() }
  }, [confirmation, context])
  const current = binding?.client.context === context ? binding : null
  const state = current?.state, client = current?.client, attempt = state?.attempt ?? null
  const authoritativeAssignment = state?.assignment ?? null
  useEffect(() => {
    if (authoritativeAssignment) onAssignmentRef.current?.(authoritativeAssignment)
  }, [authoritativeAssignment])
  const policyMatches = activity.activityVersionId === context?.activityVersionId && assignment.assignmentId === context?.assignmentId
  const policy = describeTutoringPolicy(activity)
  const busy = !state || ['idle', 'reading', 'sending', 'unavailable'].includes(state.phase) || !!state.pending || !policyMatches
  return <TutoringControlsView identityMatches={!context || (policyMatches && activity.courseId === context.courseId && assignment.studentId === context.userId)}
    hasAttempt={!!confirmation?.context.attemptId} hasClient={!!client} busy={busy} policy={policy} state={state && { phase: state.phase, limitedCheck: state.limitedCheck, pending: !!state.pending, notice: state.notice }}
    attempt={attempt} authoritativeAssignment={authoritativeAssignment} coverage={coverage}
    canToggleAttempt={!!attempt && controlAllowed(attempt, authoritativeAssignment, { kind: attempt.status === 'paused' ? 'resume' : 'pause' })}
    canToggleCapture={!!attempt && controlAllowed(attempt, authoritativeAssignment, { kind: 'capture', value: !attempt.collecting })}
    canToggleReminders={!!attempt && controlAllowed(attempt, authoritativeAssignment, { kind: 'reminders', value: !attempt.reminders })}
    onToggleAttempt={() => { if (attempt) void client?.set({ kind: attempt.status === 'paused' ? 'resume' : 'pause' }) }}
    onToggleCapture={() => { if (attempt) void client?.set({ kind: 'capture', value: !attempt.collecting }) }}
    onToggleReminders={() => { if (attempt) void client?.set({ kind: 'reminders', value: !attempt.reminders }) }}
    onRetry={() => { void client?.retry() }} onRefresh={() => { void client?.refresh() }} />
}
