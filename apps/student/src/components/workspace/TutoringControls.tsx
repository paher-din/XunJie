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
  if (context && (!policyMatches || activity.courseId !== context.courseId || assignment.studentId !== context.userId)) {
    return <section className="ts-section" aria-label="帮助政策与学习控制" data-testid="tutoring-controls">
      <h3>帮助政策与学习控制</h3><p>当前活动或分配尚未核对，暂时不能查看或修改控制，请重新载入。</p>
    </section>
  }
  return <section className="ts-section" aria-label="帮助政策与学习控制" data-testid="tutoring-controls">
    <h3>帮助政策与学习控制</h3>
    <p>政策版本：{policy.version}</p>
    <p>{policy.description}</p>
    <p>{policy.help} 不提供整份可直接提交的答案。</p>
    <p role="status" data-testid="limited-check-state" data-state={state?.limitedCheck === true ? 'limited' : state?.limitedCheck === false ? 'not-limited' : 'unknown'}>
      {state?.limitedCheck === true
        ? '当前处于限定帮助检查，系统内辅导暂不可用；执行失联或取消未确认不会自行解除。'
        : state?.limitedCheck === false
          ? '当前未处于限定帮助检查；主动求助仍须符合活动政策、尝试阶段和教师分配状态。'
          : '限定检查状态尚未核对，不能视为允许求助；作品保存和独立控制按各自权限继续。'}
    </p>
    {!confirmation?.context.attemptId && <p>开始尝试并读回当前状态后，可分别调整以下控制。里程碑提醒默认关闭。</p>}
    {attempt && <>
      <p>尝试：{attempt.status === 'paused' ? '已暂停' : attempt.status === 'active' ? '进行中' : attempt.status === 'ready' ? '未开始学习' : '作品只读'}</p>
      {attempt.status === 'paused' && authoritativeAssignment?.active && <p>尝试暂停时仍可保存已有活动文件；新建、回收、恢复、新运行和新求助需恢复尝试后进行。</p>}
      {authoritativeAssignment && !authoritativeAssignment.active && <p role="status">教师已暂停活动或分配，学生恢复不能解除。仍可保存已有活动文件，不能新建、回收、恢复、新运行或新求助。</p>}
      <button type="button" className="ws-action" disabled={busy || !controlAllowed(attempt, authoritativeAssignment,
        { kind: attempt.status === 'paused' ? 'resume' : 'pause' })}
        onClick={() => { void client?.set({ kind: attempt.status === 'paused' ? 'resume' : 'pause' }) }}>
        {attempt.status === 'paused' ? '恢复尝试' : '暂停尝试'}
      </button>
      <button type="button" className="ws-action" role="switch" aria-label="过程采集" aria-checked={attempt.collecting}
        disabled={busy || !controlAllowed(attempt, authoritativeAssignment, { kind: 'capture', value: !attempt.collecting })}
        onClick={() => { void client?.set({ kind: 'capture', value: !attempt.collecting }) }}>过程采集：{attempt.collecting ? '开启' : '暂停'}</button>
      <button type="button" className="ws-action" role="switch" aria-label="里程碑提醒" aria-checked={attempt.reminders}
        disabled={busy || !controlAllowed(attempt, authoritativeAssignment, { kind: 'reminders', value: !attempt.reminders })}
        onClick={() => { void client?.set({ kind: 'reminders', value: !attempt.reminders }) }}>里程碑提醒：{attempt.reminders ? '开启' : '关闭'}</button>
      <p>{attempt.collecting ? '当前采集后续过程。' : '当前停止逐次过程上传和被动分析；暂停期间是采集空窗。'} 恢复仅记录后续过程，不补发空窗事件。</p>
    </>}
    <p>作品保存、主动求助及必要上下文、运行和提交属于功能数据，暂停采集后仍按获准范围保存。模型故障或预算不可用不阻断获准保存。</p>
    <p>尝试暂停、过程采集、里程碑提醒彼此独立。关闭提醒取消待投递提醒，主动求助仍按当前政策可用；再开启不会复活旧提醒。</p>
    {coverage && attempt && coverage.attemptId===attempt.attemptId && coverage.captureRevision===attempt.captureRevision
      ? <div data-testid="tutor-coverage"><p>服务公开的采集覆盖区间：</p>
          {coverage.intervals.map(row=><p key={`${row.captureRevision}:${row.fromServerSeq}`}>
            {row.state==='paused'?'采集空窗':'采集中'} · 版本 {row.captureRevision} · {row.from} → {row.open?'当前':row.to??'结束时间缺失'}
          </p>)}
        </div>
      : <p>覆盖区间详情尚未从公开来源回取；上述空窗说明不补造区间或时间。</p>}
    {state?.notice && <p role="status" aria-live="polite">{state.notice}</p>}
    {state?.pending && <button type="button" className="ws-action" disabled={state.phase === 'sending' || state.phase === 'reading'}
      onClick={() => { void client?.retry() }}>核对原控制请求</button>}
    {client && <button type="button" className="ws-action" disabled={state?.phase === 'sending' || state?.phase === 'reading'}
      onClick={() => { void client.refresh() }}>重读学习控制</button>}
  </section>
}
