import { useId, type ComponentType } from 'react'
import { Icon, IconText } from '../icons'
import { TeacherDialog } from '../teacher'
import type { PreviewClaimState, PreviewLearnerStatus } from './PreviewReview'
import type { TeacherRouteLinkProps } from './Settings'

export type LiveEvidenceRef = { kind: 'snapshot' | 'run' | 'message' | 'action'; id: string; attemptId: string }
  | { kind: 'coverage'; id: string; attemptId: string; captureRevision: number; fromServerSeq: number }
  | { kind: 'context' | 'claim'; id: string; revision: number }
  | { kind: 'teacher_decision'; id: string }
  | { kind: 'resource'; id: string; resourceVersionId: string; paragraphId: string }
export type LiveAssistance = 'observed_help' | 'none_observed_in_system' | 'unknown'
export type LiveReviewAction = 'confirm' | 'correct' | 'defer'
export interface LiveReviewClaim {
  claimId: string; claimRevision: number; statement: string; state: PreviewClaimState
  source: 'model_candidate' | 'teacher_judgment'; assistanceStatus: LiveAssistance
  validity: 'active' | 'contested' | 'superseded' | 'withdrawn'; basisAvailable: boolean
  evidenceIds: string[]; counterEvidenceIds: string[]; unresolved: boolean; unknown: string[]; refs: LiveEvidenceRef[]
  references: { ref: LiveEvidenceRef; status: 'available' | 'unavailable' }[]
}
export interface LiveSubmissionView {
  submissionId: string; snapshotId: string; workspaceRevision: number; submittedAt: string; reflection?: string
}
export interface LiveReviewDisplayContext {
  attempt: { attemptId: string; attemptRevision: number; status: PreviewLearnerStatus }
  submission: LiveSubmissionView | null; submissions: (LiveSubmissionView & { latest: boolean })[]
  artifact: { fileId: string; path: string; documentVersion: number; contentHash: string }[]
  runs: { runId: string; mode: 'run' | 'check'; snapshotId: string; jobStatus: string; outcome: string }[]
  competencies: Record<'domain' | 'project' | 'ai_collaboration', LiveReviewClaim[]>; learnerStateRevision: number
  help: { messages: { messageId: string; scope: { attemptId: string }; authorKind: 'student' | 'model'; jobId: string }[]
    actions: { actionId: string; scope: { attemptId: string }; disposition: string; basisRevised: boolean; receipts: { receiptKind: string }[] }[] }
  coverage: { intervals: { state: string; from: string; to?: string; open: boolean; rejections: unknown[] }[] }
  decisions: { decisionId: string; decision: LiveReviewAction; createdAt: string; reason: string; targetRef: unknown }[]
  feedback: { entries: { feedbackId: string; threadRevision: number; submissionId: string; kind: 'formative' | 'submission_review'
    current: boolean; disputed: boolean; summary: string; reason: string; createdAt: string; basis: { status: string }[] }[] }
  disputes: { disputeId: string; currentTarget: boolean; reason: string }[]
  reopen: { state: string; actionable: boolean }
}
export interface LiveRosterMember {
  member: { userId: string; displayName?: string }; workbench: { courseId: string; courseName?: string }
  assignments: { active: boolean }[]; attempts: { status: PreviewLearnerStatus }[]
}
export interface LiveAttemptRow {
  name: string; title: string; workbench: { courseId: string; courseName?: string }
  attempt: { attemptId: string; status: PreviewLearnerStatus; latestSubmission: unknown }
}
export interface LiveEvidenceChoice { ref: LiveEvidenceRef; label: string }
export type LiveFeedbackKind = 'formative' | 'submission_review'
const statuses = { ready: '尚未开始', active: '进行中', submitted: '待审阅', reviewed: '已反馈', paused: '已暂停' }
const claimStates = { insufficient: '证据不足', supported_with_assistance: '受助条件下有支持', supported_in_check: '限定检查条件下有支持', conflicting: '证据冲突' }
const assistance = { observed_help: '已观察到系统内帮助', none_observed_in_system: '系统内未观察到帮助', unknown: '帮助条件未知' }
const domains = [{ key: 'domain', title: '学科知识与技能', icon: 'book-2' }, { key: 'project', title: '项目能力', icon: 'structure' },
  { key: 'ai_collaboration', title: '人机协同与 AI 素养', icon: 'chat-square-line' }] as const
const formatDate = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未提供'
const evidenceNames: Record<LiveEvidenceRef['kind'], string> = { snapshot: '固定作品', run: '运行结果', message: '原消息', action: '帮助与展示记录',
  coverage: '采集记录', context: '学生自述', claim: '能力判断', teacher_decision: '教师决定', resource: '材料原段落' }
/** EvidenceChoices 使用此稳定键作为受控值；宿主可用它将选中值映射回原始引用。 */
export const liveEvidenceKey = (ref: LiveEvidenceRef) => JSON.stringify(Object.entries(ref).sort(([a], [b]) => a.localeCompare(b)))

export function LiveReviewListHeading({ loading, onRefresh }: { loading: boolean; onRefresh: () => void }) {
  return <div className="t-rm-page-heading"><div><div className="t-rm-eyebrow">LEARNING EVIDENCE</div><h1>学生与证据</h1><p>从真实尝试与固定提交进入审阅，作品表现与能力判断分别查看。</p></div><button type="button" className="t-rm-button" disabled={loading} onClick={onRefresh}>重新读取学生列表</button></div>
}
export function LiveLearnerHeading({ name, title, busy, reading, designPath, LinkComponent, onBack, onReload }: {
  name: string; title: string; busy: boolean; reading: boolean; designPath: string
  LinkComponent: ComponentType<TeacherRouteLinkProps>; onBack: () => void; onReload: () => void
}) {
  return <><button type="button" className="t-rm-back" onClick={onBack}><IconText name="alt-arrow-left">全部学生</IconText></button>
    <div className="t-rm-page-heading"><div><div className="t-rm-eyebrow">LEARNING EVIDENCE</div><h1>{name}<span className="t-rm-title-secondary">的学习记录</span></h1><p>{title}</p></div>
      <div className="t-live-heading-actions"><LinkComponent className="t-rm-button" to={designPath}>设计后续项目</LinkComponent>
      <button type="button" className="t-rm-button" disabled={busy || reading} onClick={onReload}>重新读取审阅</button></div></div></>
}
export function LiveHistoricalSubmissionNotice() {
  return <div className="t-rm-note"><strong>正在审阅历史提交</strong><p>作品原文固定在这次提交；能力线仍是当前有效状态。历史过程反馈不会改变最新提交的学习阶段。</p></div>
}
export function LiveReviewError({ message }: { message: string }) {
  return <p role="alert" className="t-rm-error">{message}</p>
}
export function LiveSelectionUnavailable() {
  return <p role="status" className="t-rm-error">这项尝试不在当前获准课程列表中，请重新选择。</p>
}
export function LiveReviewLoading() { return <p role="status">正在读取固定作品、有效判断与反馈…</p> }
export function LiveReviewRoster({ courseMembers, loading }: { courseMembers: LiveRosterMember[]; loading: boolean }) { const titleId = useId(); return <section className="t-rm-panel t-live-roster" aria-labelledby={titleId}>
        <div className="t-rm-section-head"><h2 id={titleId}>课程学生</h2><span className="t-rm-caption">{courseMembers.length} 条课程成员</span></div>
        {loading ? <p role="status">正在读取课程学生…</p> : courseMembers.length === 0 ? <p>当前课程没有学生成员。</p>
          : <div className="t-rm-learner-table" role="table" aria-label="课程学生">
            <div className="t-rm-learner-table-head" role="row"><span role="columnheader">学生</span><span role="columnheader">课程与班级</span><span role="columnheader">分配</span><span role="columnheader">尝试状态</span><span /></div>
            {courseMembers.map(({ member, workbench, assignments, attempts }) => <div role="row" className="t-rm-learner-row t-live-course-member" key={`${workbench.courseId}:${member.userId}`}>
              <span role="cell" className="t-rm-learner-identity"><span className="t-rm-avatar">{(member.displayName || member.userId).slice(0, 2)}</span><span><strong>{member.displayName || member.userId}</strong></span></span>
              <span role="cell" className="t-rm-learner-project"><strong>{workbench.courseName || workbench.courseId}</strong></span>
              <span role="cell">{assignments.length} 项<small>{assignments.filter(assignment => assignment.active).length} 项开放</small></span>
              <span role="cell">{attempts.length ? [...new Set(attempts.map(attempt => statuses[attempt.status]))].join('、') : '未开始'}<small>{attempts.length} 次尝试</small></span><span />
            </div>)}
          </div>}
      </section> }
export function LiveReviewToolbar({ query, status, count, onQueryChange, onStatusChange }: {
  query: string; status: string; count: number; onQueryChange: (value: string) => void; onStatusChange: (value: string) => void
}) { return <div className="t-rm-toolbar"><label className="t-rm-search"><Icon name="minimalistic-magnifier" size={16} /><input aria-label="搜索学生审阅" value={query} onChange={event => onQueryChange(event.target.value)} placeholder="搜索学生或项目" /></label>
        <label className="t-rm-filter-label">状态<select aria-label="审阅状态" value={status} onChange={event => onStatusChange(event.target.value)}><option value="all">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <span className="t-rm-caption">{count} 个真实尝试</span></div> }
export function LiveAttemptTable({ filtered, loading, onSelect }: {
  filtered: LiveAttemptRow[]; loading: boolean; onSelect: (id: string) => void
}) { return <>{loading ? <p role="status">正在读取课程尝试…</p> : filtered.length === 0 ? <div className="t-rm-empty"><h2>暂无匹配的学生尝试</h2><p>尚未开始的分配不会自动生成学生作品或能力证据。</p></div>
        : <div className="t-rm-learner-table"><div className="t-rm-learner-table-head"><span>学生</span><span>项目</span><span>提交</span><span>状态</span><span /></div>
          {filtered.map(row => <button type="button" className="t-rm-learner-row" key={row.attempt.attemptId} onClick={() => onSelect(row.attempt.attemptId)}>
            <span className="t-rm-learner-identity"><span className="t-rm-avatar">{row.name.slice(0, 2)}</span><span><strong>{row.name}</strong></span></span>
            <span className="t-rm-learner-project"><strong>{row.title}</strong><small>{row.workbench.courseName || row.workbench.courseId}</small></span>
            <span>{row.attempt.latestSubmission ? '已有提交' : '尚未提交'}</span><span className={`t-rm-status t-rm-status-${row.attempt.status}`}>{statuses[row.attempt.status]}</span><Icon name="alt-arrow-right" size={16} />
          </button>)}</div>}</> }
export function LiveReviewSnapshot({ context, submissionChoice, busy, onSubmissionChange }: {
  context: LiveReviewDisplayContext; submissionChoice: string; busy: boolean; onSubmissionChange: (value: string) => void
}) { const submission = context.submission; return <div className="t-rm-snapshot"><Icon name="lock-keyhole" size={18} /><div><strong>{submission ? '本次审阅绑定固定提交' : '尚未提交 · 仅有过程记录'}</strong>
        <span>{submission?.submissionId || '没有可用于正式作品反馈的提交'} · 尝试版本 {context.attempt.attemptRevision} · 状态 {statuses[context.attempt.status]}</span></div>
        {context.submissions.length > 0 && <label className="t-rm-filter-label">审阅提交<select aria-label="审阅提交" disabled={busy} value={submissionChoice || context.submission?.submissionId || ''}
          onChange={event => onSubmissionChange(event.target.value)}>{[...context.submissions].reverse().map(item => <option key={item.submissionId} value={item.submissionId}>作品 v{item.workspaceRevision} · {formatDate(item.submittedAt)}{item.latest ? ' · 最新' : ''}</option>)}</select></label>}
      </div> }
export function LiveWorkPanel({ context, onOpenEvidence }: {
  context: LiveReviewDisplayContext; onOpenEvidence: (ref: LiveEvidenceRef) => void
}) { const submission = context.submission; return <section className="t-rm-panel"><div className="t-rm-section-head"><h2>固定作品与运行</h2><span className="t-rm-caption">作品表现</span></div>
          {submission ? <><p>确认作品 v{submission.workspaceRevision} · {formatDate(submission.submittedAt)}</p>
            <button type="button" className="t-rm-reference" onClick={() => { void onOpenEvidence({ kind: 'snapshot', id: submission.snapshotId, attemptId: context.attempt.attemptId }) }}><IconText name="code-square">查看固定作品原文</IconText></button>
            {context.artifact.map(file => <div className="t-rm-observation" key={file.fileId}><p>{file.path} · 文件版本 {file.documentVersion}</p><small className="t-rm-mono">{file.contentHash}</small></div>)}
            <div className="t-rm-note"><strong>学生提交反思</strong><p className="t-live-prewrap">{submission.reflection || '这次提交未附反思；缺失保持未知。'}</p></div>
          </> : <p>尚未固定提交，不把当前工作区当成正式提交作品。</p>}
          {context.runs.filter(run => !submission || run.snapshotId === submission.snapshotId).map(run => <button type="button" key={run.runId} className="t-rm-evidence-row" onClick={() => { void onOpenEvidence({ kind: 'run', id: run.runId, attemptId: context.attempt.attemptId }) }}>
            <span><strong>{run.mode === 'check' ? '课程检查' : '普通运行'} · {run.outcome}</strong><small>{run.runId} · 原快照 {run.snapshotId} · 作业 {run.jobStatus}</small></span><Icon name="alt-arrow-right" size={16} /></button>)}
          <p>运行退出成功、课程检查结果与学生个人能力分别判断。失败、缺失和执行未知不算通过。</p>
        </section> }
export function LiveAbilityPanel({ context, canWrite, onOpenEvidence, onDecision }: {
  context: LiveReviewDisplayContext; canWrite: boolean; onOpenEvidence: (ref: LiveEvidenceRef) => void
  onDecision: (id: string, revision: number, action: LiveReviewAction) => void
}) { return <section className="t-rm-panel t-rm-ability-panel"><div className="t-rm-section-head"><h2>三条能力线</h2><span className="t-rm-caption">当前有效状态 · 版本 {context.learnerStateRevision}</span></div>
          {domains.map((domain, index) => <div className="t-rm-domain" key={domain.key}><div className="t-rm-domain-heading"><span className="t-rm-domain-number">0{index + 1}</span><Icon name={domain.icon} size={18} /><h3>{domain.title}</h3></div>
            {context.competencies[domain.key].length === 0 ? <p className="t-rm-unobserved">暂无这一能力线的有效主张。没有观察不等于失败，也不由作品完成推定掌握。</p>
              : context.competencies[domain.key].map(claim => <article className="t-rm-claim" key={`${claim.claimId}:${claim.claimRevision}`}>
                <span className={`t-rm-claim-state t-rm-claim-${claim.state}`}>{claimStates[claim.state]}</span><p>{claim.statement}</p>
                <p className="t-rm-caption">{claim.source === 'teacher_judgment' ? '教师判断' : '模型候选'} · {assistance[claim.assistanceStatus]} · {claim.validity === 'contested' ? '存在争议' : '当前有效'} · 版本 {claim.claimRevision}</p>
                {!claim.basisAvailable && <p className="t-rm-error">原依据不可回取，不能把这条主张当成已核实事实。</p>}
                {claim.references.map((item, i) => <div className="t-live-reference" key={i}><button type="button" className="t-rm-reference" onClick={() => { void onOpenEvidence(item.ref) }}>查看{evidenceNames[item.ref.kind]}</button>
                  <span className="t-rm-caption">{claim.counterEvidenceIds.includes(item.ref.id) ? '原反证 · ' : ''}{item.status === 'available' ? '引用存在，原文需核实' : '当前依据不可用'}</span>
                  <details><summary className="t-rm-caption">引用标识</summary><pre className="t-live-json">{JSON.stringify(item.ref, null, 2)}</pre></details></div>)}
                <p className="t-rm-caption">反证引用：{claim.counterEvidenceIds.length ? claim.counterEvidenceIds.join('、') : '尚无'}；{claim.unresolved ? '仍有未决问题' : '未标记未决问题'}</p>
                {claim.unknown.map((text, i) => <p key={i} className="t-rm-caption">未知：{text}</p>)}
                <div className="t-rm-claim-actions"><button type="button" disabled={!canWrite} onClick={() => onDecision(claim.claimId, claim.claimRevision, 'confirm')}>确认</button><button type="button" disabled={!canWrite} onClick={() => onDecision(claim.claimId, claim.claimRevision, 'correct')}>纠正</button><button type="button" disabled={!canWrite} onClick={() => onDecision(claim.claimId, claim.claimRevision, 'defer')}>暂缓</button></div>
              </article>)}
          </div>)}
        </section> }
export function LiveHelpPanel({ context, onOpenEvidence }: {
  context: LiveReviewDisplayContext; onOpenEvidence: (ref: LiveEvidenceRef) => void
}) { return <section className="t-rm-panel"><div className="t-rm-section-head"><h2>实际帮助与记录缺口</h2><span className="t-rm-caption">过程条件</span></div>
          {context.help.messages.length === 0 && <p>没有可回取的教学消息，不能据此证明学生没有获得其他帮助。</p>}
          {context.help.messages.map(message => <button type="button" className="t-rm-evidence-row" key={message.messageId} onClick={() => { void onOpenEvidence({ kind: 'message', id: message.messageId, attemptId: message.scope.attemptId }) }}>
            <span><strong>{message.authorKind === 'student' ? '学生主动消息' : '辅导消息'}</strong><small>{message.messageId} · 来源作业 {message.jobId}</small></span><Icon name="alt-arrow-right" size={16} /></button>)}
          {context.help.actions.map(action => <details key={action.actionId}><summary>{action.actionId} · {action.disposition} · {action.receipts.some(receipt => receipt.receiptKind === 'displayed' || receipt.receiptKind === 'acknowledged') ? '有实际展示回执' : '是否展示未知'}</summary><p className="t-rm-caption">{action.basisRevised ? '该帮助的依据后来已修订。' : '没有标记依据后来修订。'} 投递与展示是不同事实。</p><button type="button" className="t-rm-reference" onClick={() => { void onOpenEvidence({ kind: 'action', id: action.actionId, attemptId: action.scope.attemptId }) }}>查看帮助与展示原记录</button></details>)}
          {context.coverage.intervals.map((interval, i) => <p className="t-rm-caption" key={i}>{interval.state === 'paused' ? '采集空窗' : '允许采集区间'} · {formatDate(interval.from)} → {interval.open ? '当前' : interval.to ? formatDate(interval.to) : '结束时间未知'}{interval.rejections.length ? ` · ${interval.rejections.length} 条未接纳记录` : ''}</p>)}
        </section> }
export function LiveReviewHistory({ context }: { context: LiveReviewDisplayContext }) { return <section className="t-rm-panel"><h2>教师决定与反馈历史</h2>
          {context.decisions.length === 0 && context.feedback.entries.length === 0 && <p>尚无教师保存的决定或反馈。</p>}
          {context.decisions.map(item => <details key={item.decisionId}><summary>{item.decision === 'confirm' ? '确认' : item.decision === 'correct' ? '纠正' : '暂缓'}判断 · {formatDate(item.createdAt)}</summary><p>{item.reason}</p><pre className="t-live-json">{JSON.stringify(item.targetRef, null, 2)}</pre></details>)}
          {context.feedback.entries.map(item => <article className="t-live-history" key={`${item.feedbackId}:${item.threadRevision}`}><strong>{item.kind === 'submission_review' ? '作品审阅' : '过程反馈'} · 第 {item.threadRevision} 版{item.current ? ' · 当前修订' : ' · 历史修订'}</strong>
            <p className="t-live-prewrap">{item.summary}</p><p>理由：{item.reason}</p><p className="t-rm-caption">提交 {item.submissionId} · {formatDate(item.createdAt)}{item.disputed ? ' · 有学生异议' : ''}</p>
            {item.basis.some(basis => basis.status !== 'current') && <p className="t-rm-error">部分原依据已变化、撤回或不可回取，请复核后决定是否修订反馈。</p>}</article>)}
          {context.disputes.map(item => <div className="t-rm-note" key={item.disputeId}><strong>学生异议 · {item.currentTarget ? '针对当前版本' : '历史对象'}</strong><p>{item.reason}</p></div>)}
        </section> }
export function LiveEvidenceChoices({ values, onChange, availableRefs, canWrite, legend = '选择原始依据' }: {
  values: string[]; onChange: (values: string[]) => void; availableRefs: LiveEvidenceChoice[]; canWrite: boolean; legend?: string
}) { return <fieldset className="t-rm-evidence-checks" disabled={!canWrite}><legend>{legend}</legend>
  {availableRefs.map(item => <label key={liveEvidenceKey(item.ref)}><input type="checkbox" checked={values.includes(liveEvidenceKey(item.ref))}
    onChange={event => onChange(event.target.checked ? [...values, liveEvidenceKey(item.ref)] : values.filter(value => value !== liveEvidenceKey(item.ref)))} />
    <span>{item.label}<small>{item.ref.id}</small></span></label>)}
  {availableRefs.length === 0 && <p className="t-rm-caption">没有可用原始依据，当前不能保存正式决定。</p>}
  </fieldset> }
export interface LiveFeedbackPanelProps {
  context: LiveReviewDisplayContext; canWrite: boolean; selectedLatest: boolean; busy: boolean
  feedbackId: string; feedbackKind: LiveFeedbackKind; summary: string; reason: string
  evidence: string[]; availableRefs: LiveEvidenceChoice[]
  onFeedbackSelect: (id: string) => void; setFeedbackKind: (kind: LiveFeedbackKind) => void
  setSummary: (value: string) => void; setReason: (value: string) => void
  setEvidence: (values: string[]) => void; onSave: () => void
}
export function LiveFeedbackPanel({ context, canWrite, selectedLatest, busy, feedbackId, feedbackKind, summary, reason,
  evidence, availableRefs, onFeedbackSelect, setFeedbackKind, setSummary, setReason, setEvidence, onSave }: LiveFeedbackPanelProps) {
  const submission = context.submission
  return <section className="t-rm-panel"><h2>{feedbackId ? '修订教师反馈' : '给学生反馈'}</h2><p>反馈写入真实教学服务。正式作品审阅只针对最新固定提交，旧版反馈保留。</p>
          <label className="t-rm-field"><span>反馈线程</span><select aria-label="反馈线程" value={feedbackId} disabled={!canWrite || !submission} onChange={event => onFeedbackSelect(event.target.value)}><option value="">新增一条反馈</option>{context.feedback.entries.filter(item => item.current && item.submissionId === submission?.submissionId).map(item => <option key={item.feedbackId} value={item.feedbackId}>修订第 {item.threadRevision} 版 · {item.kind === 'submission_review' ? '作品审阅' : '过程反馈'}</option>)}</select></label>
          <label className="t-rm-field"><span>反馈类型</span><select aria-label="反馈类型" value={feedbackKind} disabled={!canWrite} onChange={event => setFeedbackKind(event.target.value as typeof feedbackKind)}><option value="submission_review" disabled={!selectedLatest || !['submitted', 'reviewed'].includes(context.attempt.status)}>正式作品审阅</option><option value="formative">过程反馈（不改变阶段）</option></select></label>
          <label className="t-rm-field"><span>反馈正文</span><textarea aria-label="教师反馈正文" rows={6} maxLength={16384} value={summary} disabled={!canWrite || !submission} onChange={event => setSummary(event.target.value)} placeholder="给出具体表现和可以继续行动的建议" /></label>
          <label className="t-rm-field"><span>反馈理由</span><textarea aria-label="教师反馈理由" maxLength={512} value={reason} disabled={!canWrite || !submission} onChange={event => setReason(event.target.value)} /></label>
          <LiveEvidenceChoices values={evidence} onChange={setEvidence} availableRefs={availableRefs} canWrite={canWrite} />
          <button type="button" className="t-rm-button t-rm-button-primary t-rm-full" disabled={!canWrite || !submission || feedbackKind === 'submission_review' && (!selectedLatest || !['submitted', 'reviewed'].includes(context.attempt.status))} onClick={onSave}>{busy ? '正在保存…' : feedbackId ? '保存反馈修订' : '保存教师反馈'}</button>
        </section>
}
export function LiveRevisionPanel({ context, canWrite, selectedLatest, reopenReason, setReopenReason, onAllowRevision }: {
  context: LiveReviewDisplayContext; canWrite: boolean; selectedLatest: boolean; reopenReason: string
  setReopenReason: (value: string) => void; onAllowRevision: () => void
}) { return <section className="t-rm-panel"><h2>允许学生修订</h2><p>许可针对最新已审阅提交。学生主动开始修订后恢复编辑，不由教师替学生继续。</p>
          <p>当前许可：{context.reopen.state === 'none' ? '从未发放' : context.reopen.actionable ? '可由学生使用' : context.reopen.state === 'consumed' ? '已由学生使用' : '已发放但当前不可用'}</p>
          <label className="t-rm-field"><span>允许修订的理由</span><textarea aria-label="允许修订理由" maxLength={512} value={reopenReason} disabled={!canWrite || !selectedLatest || context.attempt.status !== 'reviewed'} onChange={event => setReopenReason(event.target.value)} /></label>
          <button type="button" className="t-rm-button t-rm-full" disabled={!canWrite || !selectedLatest || context.attempt.status !== 'reviewed'} onClick={onAllowRevision}>允许修订本次提交</button>
        </section> }
export function LiveRawEvidenceDialog({ raw, onClose }: { raw: { title: string; content: string; record?: string } | null; onClose: () => void }) {
  return <TeacherDialog open={!!raw} onOpenChange={open => { if (!open) onClose() }} title={raw?.title || '原始证据'} description="只读原始引用；不会替学生保存、修改或运行作品。">
      <pre className="t-rm-raw-content">{raw?.content}</pre>
      {raw?.record && <details className="t-live-raw-record"><summary>原始记录与引用标识</summary><pre className="t-live-json">{raw.record}</pre></details>}
    </TeacherDialog>
}
export interface LiveDecisionDialogProps {
  decision: { action: LiveReviewAction; claim: Pick<LiveReviewClaim, 'claimRevision' | 'statement' | 'evidenceIds' | 'counterEvidenceIds' | 'refs'> } | null
  context: LiveReviewDisplayContext; canWrite: boolean; busy: boolean; decisionReason: string; replacement: string
  replacementState: PreviewClaimState; replacementAssistance: LiveAssistance; replacementUnknown: string
  decisionEvidence: string[]; availableRefs: LiveEvidenceChoice[]; error: string
  setDecisionReason: (value: string) => void; setReplacement: (value: string) => void
  setReplacementState: (value: PreviewClaimState) => void; setReplacementAssistance: (value: LiveAssistance) => void
  setReplacementUnknown: (value: string) => void; setDecisionEvidence: (value: string[]) => void
  onClose: () => void; onSave: () => void
}
export function LiveDecisionDialog({ decision, context, canWrite, busy, decisionReason, replacement, replacementState,
  replacementAssistance, replacementUnknown, decisionEvidence, availableRefs, error, setDecisionReason, setReplacement,
  setReplacementState, setReplacementAssistance, setReplacementUnknown, setDecisionEvidence, onClose, onSave }: LiveDecisionDialogProps) {
  if (!decision) return null
  return <TeacherDialog open onOpenChange={open => { if (!open && !busy) onClose() }} title={`${decision.action === 'confirm' ? '确认' : decision.action === 'correct' ? '纠正' : '暂缓'}能力判断`}
      description={`原判断版本 ${decision.claim.claimRevision} · 学习状态版本 ${context.learnerStateRevision}。保存后追加记录，旧判断保留。`}>
      <div><p>{decision.claim.statement}</p><label className="t-rm-field"><span>复核理由</span><textarea aria-label="能力复核理由" maxLength={512} value={decisionReason} disabled={!canWrite} onChange={event => setDecisionReason(event.target.value)} /></label>
        {decision.action === 'correct' && <><label className="t-rm-field"><span>纠正后的判断</span><textarea aria-label="纠正后的判断" maxLength={16384} value={replacement} disabled={!canWrite} onChange={event => setReplacement(event.target.value)} /></label>
          <label className="t-rm-field"><span>支持状态</span><select value={replacementState} disabled={!canWrite} onChange={event => setReplacementState(event.target.value as typeof replacementState)}>{Object.entries(claimStates).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="t-rm-field"><span>帮助条件</span><select value={replacementAssistance} disabled={!canWrite} onChange={event => setReplacementAssistance(event.target.value as typeof replacementAssistance)}>{Object.entries(assistance).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="t-rm-field"><span>仍未知的部分（每行一项）</span><textarea value={replacementUnknown} disabled={!canWrite} onChange={event => setReplacementUnknown(event.target.value)} /></label>
          <div className="t-rm-note t-live-preserved"><strong>保留原判断的证据与反证</strong><p>原证据 {decision.claim.evidenceIds.length} 项、原反证 {decision.claim.counterEvidenceIds.length} 项及其引用、帮助与采集依据会完整保留。下方选择会追加教师复核依据；已列为反证的内容仍保留为反证。</p>
            <details><summary>查看保留的引用标识</summary><pre className="t-live-json">{JSON.stringify({ evidenceIds: decision.claim.evidenceIds, counterEvidenceIds: decision.claim.counterEvidenceIds, references: decision.claim.refs }, null, 2)}</pre></details></div></>}
        <LiveEvidenceChoices values={decisionEvidence} onChange={setDecisionEvidence} availableRefs={availableRefs} canWrite={canWrite} legend={decision.action === 'correct' ? '新增教师复核依据' : '选择原始依据'} />{error && <p role="alert" className="t-rm-error">{error}</p>}
      </div><footer className="t-rm-dialog-footer"><button type="button" className="t-rm-button" disabled={busy} onClick={onClose}>取消</button><button type="button" className="t-rm-button t-rm-button-primary" disabled={!canWrite} onClick={onSave}>保存教师判断</button></footer>
    </TeacherDialog>
}
