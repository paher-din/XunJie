export interface TutoringControlsViewProps {
  identityMatches: boolean; hasAttempt: boolean; hasClient: boolean; busy: boolean
  policy: { version: string; description: string; help: string }
  state?: { limitedCheck: boolean | null; phase: string; pending: boolean; notice: string | null }
  attempt: { attemptId: string; captureRevision: number; status: string; collecting: boolean; reminders: boolean } | null
  authoritativeAssignment: { active: boolean } | null
  coverage?: { attemptId: string; captureRevision: number; intervals: Array<{ captureRevision: number; fromServerSeq: number; state: string; from: string; open: boolean; to?: string }> }
  canToggleAttempt: boolean; canToggleCapture: boolean; canToggleReminders: boolean
  onToggleAttempt: () => void; onToggleCapture: () => void; onToggleReminders: () => void; onRetry: () => void; onRefresh: () => void
}
export function TutoringControlsView({ identityMatches, hasAttempt, hasClient, busy, policy, state, attempt, authoritativeAssignment, coverage,
  canToggleAttempt, canToggleCapture, canToggleReminders, onToggleAttempt, onToggleCapture, onToggleReminders, onRetry, onRefresh }: TutoringControlsViewProps) {
  if (!identityMatches) {
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
    {!hasAttempt && <p>开始尝试并读回当前状态后，可分别调整以下控制。里程碑提醒默认关闭。</p>}
    {attempt && <>
      <p>尝试：{attempt.status === 'paused' ? '已暂停' : attempt.status === 'active' ? '进行中' : attempt.status === 'ready' ? '未开始学习' : '作品只读'}</p>
      {attempt.status === 'paused' && authoritativeAssignment?.active && <p>尝试暂停时仍可保存已有活动文件；新建、回收、恢复、新运行和新求助需恢复尝试后进行。</p>}
      {authoritativeAssignment && !authoritativeAssignment.active && <p role="status">教师已暂停活动或分配，学生恢复不能解除。仍可保存已有活动文件，不能新建、回收、恢复、新运行或新求助。</p>}
      <button type="button" className="ws-action" disabled={busy || !canToggleAttempt}
        onClick={() => { onToggleAttempt() }}>
        {attempt.status === 'paused' ? '恢复尝试' : '暂停尝试'}
      </button>
      <button type="button" className="ws-action" role="switch" aria-label="过程采集" aria-checked={attempt.collecting}
        disabled={busy || !canToggleCapture}
        onClick={() => { onToggleCapture() }}>过程采集：{attempt.collecting ? '开启' : '暂停'}</button>
      <button type="button" className="ws-action" role="switch" aria-label="里程碑提醒" aria-checked={attempt.reminders}
        disabled={busy || !canToggleReminders}
        onClick={() => { onToggleReminders() }}>里程碑提醒：{attempt.reminders ? '开启' : '关闭'}</button>
      <p>{attempt.collecting ? '过程采集开关已开启，服务端允许接收当前区间的过程数据。' : '过程采集开关已暂停，暂停期间保持采集空窗。'} 恢复不补发空窗事件。</p>
    </>}
    <p>作品保存、主动求助及必要上下文、运行和提交属于功能数据，暂停采集后仍按获准范围保存。模型故障或预算不可用不阻断获准保存。</p>
    <p>当前页面尚未自动上传逐次编辑过程，也不会主动生成里程碑提醒。</p>
    <p>尝试暂停、过程采集、里程碑提醒彼此独立。关闭提醒取消待投递提醒，主动求助仍按当前政策可用；再开启不会复活旧提醒。</p>
    {coverage && attempt && coverage.attemptId===attempt.attemptId && coverage.captureRevision===attempt.captureRevision
      ? <div data-testid="tutor-coverage"><p>服务公开的采集覆盖区间：</p>
          {coverage.intervals.map(row=><p key={`${row.captureRevision}:${row.fromServerSeq}`}>
            {row.state==='paused'?'采集空窗':'允许采集区间'} · 版本 {row.captureRevision} · {row.from} → {row.open?'当前':row.to??'结束时间缺失'}
          </p>)}
        </div>
      : <p>覆盖区间详情尚未从公开来源回取；上述空窗说明不补造区间或时间。</p>}
    {state?.notice && <p role="status" aria-live="polite">{state.notice}</p>}
    {state?.pending && <button type="button" className="ws-action" disabled={state.phase === 'sending' || state.phase === 'reading'}
      onClick={() => { onRetry() }}>核对原控制请求</button>}
    {hasClient && <button type="button" className="ws-action" disabled={state?.phase === 'sending' || state?.phase === 'reading'}
      onClick={() => { onRefresh() }}>重读学习控制</button>}
  </section>
}
