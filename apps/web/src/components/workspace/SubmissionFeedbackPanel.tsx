import { useEffect, useRef, useState } from 'react'
import type { ConfirmationWorkspace } from '../../workspace/confirmationWorkspace'
import type { AssignmentView } from '../../workspace/contracts'
import { SubmissionFeedbackWorkspace, type SubmissionState } from '../../workspace/submissionFeedback'
import type { SnapshotView } from '../../workspace/workspaceContracts'
import './SubmissionFeedbackPanel.css'

interface Props {
  confirmation: ConfirmationWorkspace
  snapshots: SnapshotView[]
  unconfirmedCount: number
  onReturn: () => void
  onAssignmentChange?: (assignment: AssignmentView) => void
}
const stageLabel = { ready: '尚未开始', active: '进行中', paused: '已暂停', submitted: '等待教师审阅', reviewed: '教师已审阅' }
const basisLabel = { current: '当前有效', revised: '已修订', withdrawn: '已撤回', superseded: '已被取代', unavailable: '无法回取' }
const dateLabel = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未知'

/** Uses the existing centre pane; it does not create or change a learning object while reading. */
export function SubmissionFeedbackPanel({ confirmation, snapshots, unconfirmedCount, onReturn, onAssignmentChange }: Props) {
  const [binding, setBinding] = useState<{ client: SubmissionFeedbackWorkspace; state: SubmissionState } | null>(null)
  const [snapshotId, setSnapshotId] = useState('')
  const [reflection, setReflection] = useState('')
  const [checks, setChecks] = useState<string[]>([])
  const [confirming, setConfirming] = useState(false)
  const assignmentCallback = useRef(onAssignmentChange)
  assignmentCallback.current = onAssignmentChange
  const context = confirmation.context
  useEffect(() => {
    setBinding(null); setSnapshotId(''); setReflection(''); setChecks([]); setConfirming(false)
    const client = new SubmissionFeedbackWorkspace(confirmation)
    const unsubscribe = client.subscribe(state => setBinding({ client, state }))
    void client.refresh()
    return () => { unsubscribe(); client.dispose() }
  }, [confirmation, context])
  const state = binding?.state, client = binding?.client
  useEffect(() => { if (state?.assignment) assignmentCallback.current?.(state.assignment) }, [state?.assignment])
  const recovery = state?.recovery, current = recovery?.attempt
  const snapshot = snapshots.find(item => item.snapshotId === snapshotId)
  const busy = !state || ['idle', 'reading', 'sending'].includes(state.phase)
  const canSubmit = !busy && state?.phase === 'ready' && !state.pending && state.assignment?.active &&
    !!current && ['ready', 'active'].includes(current.status)
  const matchingChecks = recovery?.runs.filter(run => run.mode === 'check' && run.snapshotId === snapshotId) ?? []
  return <section className="ws-submission" aria-label="提交与教师反馈" data-testid="submission-feedback-panel">
    <header className="ws-submission-head">
      <div><h2>提交与教师反馈</h2><p>提交一个明确的作品版本，查看反馈，再自主开始下一轮修订。</p></div>
      <div className="ws-submission-actions">
        <button type="button" className="ws-btn ghost" disabled={busy} onClick={() => { setConfirming(false); void client?.refresh() }}>重新读取反馈</button>
        <button type="button" className="ws-btn ghost" onClick={onReturn}>返回作品</button>
      </div>
    </header>
    {state?.notice && <p className="ws-submission-notice" role="status">{state.notice}</p>}
    {busy && <p role="status">{state?.phase === 'sending' ? '正在核对原请求，请稍候…' : '正在读取提交与反馈…'}</p>}
    {state?.pending && <div className="ws-submission-notice">
      <p>这次{state.pending.kind === 'submit' ? '提交' : '开始修订'}的结果尚未确认。刷新后仍核对同一请求，不会重复创建。</p>
      <button type="button" className="ws-btn solid" disabled={busy} onClick={() => { void client?.reconcile() }}>核对原提交或修订请求</button>
    </div>}
    {current && <p className="ws-submission-stage">{stageLabel[current.status]} <span>· 尝试版本 {current.attemptRevision}</span></p>}
    {state?.assignment && !state.assignment.active && <p role="status">教师已暂停本项分配，当前不能提交或开始修订。已有作品与反馈仍可查看。</p>}

    {current && ['ready', 'active', 'paused'].includes(current.status) && <section className="ws-submission-card" aria-label="提交固定作品">
      <h3>提交固定作品</h3>
      <p>选择你已冻结的确认快照。提交不会替你保存草稿、运行程序或进行课程检查。</p>
      {unconfirmedCount > 0 && <p className="ws-submission-notice">本机还有 {unconfirmedCount} 项未确认改动，不会包含在这次提交中。需要提交这些改动时，先返回作品自主保存并冻结新快照。</p>}
      <label>提交快照<select aria-label="提交快照" value={snapshotId} disabled={!canSubmit || confirming}
        onChange={event => { setSnapshotId(event.target.value); setChecks([]) }}>
        <option value="">请明确选择确认快照</option>
        {snapshots.map(item => <option key={item.snapshotId} value={item.snapshotId}>确认作品 v{item.workspaceRevision} · {dateLabel(item.createdAt)}</option>)}
      </select></label>
      {snapshot && <div className="ws-submission-manifest">
        <p>固定作品 v{snapshot.workspaceRevision} · {snapshot.files.length} 个文件</p>
        <ul>{snapshot.files.map(file => <li key={file.fileId}><span>{file.path}</span><small>文件版本 {file.documentVersion}</small></li>)}</ul>
        <details><summary>核对快照来源</summary><code>{snapshot.snapshotId}</code><code>{snapshot.hash}</code></details>
      </div>}
      <label>简短反思（按课程要求填写）<textarea aria-label="提交反思" value={reflection} maxLength={4096} rows={4}
        disabled={!canSubmit || confirming} placeholder="例如：这次作出的取舍、已验证的结果，以及仍不确定的部分。"
        onChange={event => setReflection(event.target.value)} /></label>
      {matchingChecks.length > 0 && <fieldset disabled={!canSubmit || confirming}><legend>附上这个快照的课程检查</legend>
        {matchingChecks.map(run => <label className="ws-submission-check" key={run.runId}><input type="checkbox" checked={checks.includes(run.runId)}
          onChange={event => setChecks(items => event.target.checked ? [...items, run.runId] : items.filter(id => id !== run.runId))} />
          <span>课程检查 {run.runId} · {run.outcome}</span></label>)}
        <p>检查失败或结果未知仍可提交；实际结论保留给教师审阅。</p>
      </fieldset>}
      {!confirming ? <button type="button" className="ws-btn solid" disabled={!canSubmit || !snapshot}
        onClick={() => setConfirming(true)}>提交所选作品</button>
        : <div className="ws-submission-confirm" role="group" aria-label="确认固定提交">
          <p>将固定提交作品 v{snapshot?.workspaceRevision}。提交后作品只读，教师允许且由你主动开始修订后才能继续修改。旧提交会始终保留。</p>
          <div className="ws-submission-actions"><button type="button" className="ws-btn ghost" disabled={busy} onClick={() => setConfirming(false)}>继续核对</button>
            <button type="button" className="ws-btn solid" disabled={!canSubmit || !snapshot} onClick={() => {
              if (!snapshot) return
              setConfirming(false); void client?.submit(snapshot, reflection, checks)
            }}>确认提交所选快照</button></div>
        </div>}
    </section>}

    <section className="ws-submission-card" aria-label="教师反馈">
      <h3>教师反馈</h3>
      {state?.feedbackNotice && <p role="status">{state.feedbackNotice}</p>}
      {state?.feedback && state.feedback.entries.length === 0 && <p>目前还没有教师保存的反馈。</p>}
      {state?.feedback?.entries.map(entry => <article className="ws-submission-feedback" key={`${entry.feedbackId}:${entry.threadRevision}`}>
        <div className="ws-submission-feedback-meta"><strong>{entry.kind === 'submission_review' ? '作品审阅' : '过程反馈'}</strong>
          <span>{entry.current ? '当前修订' : '历史修订'} · 第 {entry.threadRevision} 版 · {dateLabel(entry.createdAt)}</span></div>
        <p className="ws-submission-feedback-text">{entry.summary}</p>
        <p>教师理由：{entry.reason}</p>
        {entry.disputed && <p className="ws-submission-notice">这版反馈存在学生异议，尚需教师处理。</p>}
        {entry.basis.some(basis => basis.status !== 'current') && <p className="ws-submission-notice">部分原依据已变化或不可回取；这份反馈保留原评价版本，请结合教师后续修订查看。</p>}
        <details><summary>反馈来源与依据状态</summary><p>固定提交：{entry.submissionId}</p><p>反馈：{entry.feedbackId} · 线程版本 {entry.threadRevision}</p>
          {entry.basis.length === 0 ? <p>没有引用能力主张；不能从作品反馈推定独立掌握。</p>
            : entry.basis.map(basis => <p key={`${basis.claimId}:${basis.claimRevision}`}>{basis.claimId} · 原版本 {basis.claimRevision} · {basisLabel[basis.status]}</p>)}
        </details>
      </article>)}
    </section>

    {recovery && <section className="ws-submission-card" aria-label="修订许可">
      <h3>继续修订</h3>
      {recovery.reopen.actionable ? <><p>教师已允许修订本次提交。由你开始修订后恢复编辑；旧快照、提交与反馈保持不变。</p>
        {recovery.reopen.reason && <p>教师理由：{recovery.reopen.reason}</p>}
        <button type="button" className="ws-btn solid" disabled={busy || state?.phase !== 'ready' || !state.assignment?.active || !!state.pending}
          onClick={() => { void client?.resume() }}>我来开始修订</button></>
        : <p>{recovery.reopen.state === 'valid' ? '教师曾发放修订许可，但当前已不可使用；需要教师按当前状态重新发放。'
          : recovery.reopen.state === 'consumed' ? '上次修订许可已使用。你可以继续当前修订，旧提交始终保留。'
            : recovery.reopen.state === 'superseded' ? '旧修订许可已被取代，请重新读取教师当前决定。' : '目前没有教师修订许可。提交和反馈可持续查看。'}</p>}
    </section>}

    {recovery && <section className="ws-submission-card" aria-label="固定提交历史">
      <h3>固定提交历史 <small>{recovery.submissions.length} 次</small></h3>
      {recovery.submissions.length === 0 && <p>尚未提交作品。确认快照与正式提交是两个独立步骤。</p>}
      {[...recovery.submissions].reverse().map(submission => <details key={submission.submissionId} className="ws-submission-history">
        <summary>作品 v{submission.workspaceRevision} · {dateLabel(submission.submittedAt)}{submission.submissionId === recovery.latestSubmissionId ? ' · 最新提交' : ''}</summary>
        <p>提交：{submission.submissionId}</p><p>固定快照：{submission.snapshotId}</p><code>{submission.snapshotHash}</code>
        <p>{submission.hasReflection ? '包含本人提交的反思。' : '未附反思。'} 附 {submission.checkRefs.length} 项匹配课程检查。</p>
      </details>)}
    </section>}
  </section>
}
