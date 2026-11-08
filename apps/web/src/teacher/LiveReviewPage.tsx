import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useSession } from '../components/SessionEntry'
import { textHash, verifySnapshot } from '../workspace/confirmation'
import type { RunView } from '../workspace/runContracts'
import type { SnapshotView } from '../workspace/workspaceContracts'
import { useTeacher } from './context'
import { readReviewContext, teacherCommand, teacherGet } from './backend'
import { LiveReviewRoster, LiveReviewToolbar, LiveAttemptTable, LiveReviewSnapshot, LiveWorkPanel,
  LiveAbilityPanel, LiveHelpPanel, LiveReviewHistory, LiveFeedbackPanel, LiveRevisionPanel,
  LiveRawEvidenceDialog, LiveDecisionDialog, LiveReviewListHeading, LiveLearnerHeading, LiveHistoricalSubmissionNotice,
  LiveReviewError, LiveSelectionUnavailable, LiveReviewLoading,
  liveEvidenceKey } from '@xunjie/ui/teacher-review'
import type { EvidenceRef, LearnerClaim, ResourceVersion, ReviewContext } from './wire'
import './review-materials.css'
import './live-review.css'

const claimStates = { insufficient: '证据不足', supported_with_assistance: '受助条件下有支持', supported_in_check: '限定检查条件下有支持', conflicting: '证据冲突' }
const assistance = { observed_help: '已观察到系统内帮助', none_observed_in_system: '系统内未观察到帮助', unknown: '帮助条件未知' }
const formatDate = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未提供'
const mergeRefs = (refs: EvidenceRef[]) => [...new Map(refs.map(ref => [liveEvidenceKey(ref), ref])).values()]
const explain = (error: unknown) => error instanceof Error ? error.message : '操作没有完成，请重新读取状态。'
const evidenceNames: Record<EvidenceRef['kind'], string> = { snapshot: '固定作品', run: '运行结果', message: '原消息', action: '帮助与展示记录',
  coverage: '采集记录', context: '学生自述', claim: '能力判断', teacher_decision: '教师决定', resource: '材料原段落' }
type RawEvidence = { title: string; content: string; record?: string }
type LearnerProjection = { context: { courseId: string; studentId: string; contextRevision: number; source: 'self_report'; goals: string; constraints: string }
  claims: LearnerClaim[]; decisions: ReviewContext['decisions'] }

function correctionBasis(claim: LearnerClaim, additionalRefs: EvidenceRef[]) {
  const refs = mergeRefs([...claim.refs, ...additionalRefs])
  const evidenceIds = [...new Set([...claim.evidenceIds, ...additionalRefs.filter(ref => !claim.counterEvidenceIds.includes(ref.id)).map(ref => ref.id)])]
  if (refs.length > 64 || evidenceIds.length > 64) throw new Error('合并原依据后超出当前记录的 64 项限额，请减少新增依据；原证据与反证不会被删减。')
  if ([...claim.evidenceIds, ...claim.counterEvidenceIds].some(id => !refs.some(ref => ref.id === id)))
    throw new Error('原判断缺少完整引用，当前无法保留原证据与反证；请重新读取后复核。')
  return { refs, evidenceIds, counterEvidenceIds: [...claim.counterEvidenceIds] }
}

async function referencedSnapshot(source: ReviewContext, snapshotId: string) {
  const attempt = source.attempt
  const snapshot = await verifySnapshot(await teacherGet<SnapshotView>(`/attempts/${encodeURIComponent(attempt.attemptId)}/snapshots/${encodeURIComponent(snapshotId)}`), attempt.attemptId, attempt.activityVersionId)
  if (snapshot.snapshotId !== snapshotId) throw new Error('返回快照与原引用不符。')
  const submitted = source.submissions.find(item => item.snapshotId === snapshotId)
  if (submitted && (snapshot.hash !== submitted.snapshotHash || snapshot.workspaceRevision !== submitted.workspaceRevision)) throw new Error('原快照与固定提交摘要不符。')
  return snapshot
}

async function messageText(message: ReviewContext['help']['messages'][number]) {
  const envelope = message.envelope
  const body = envelope.kind === 'student_help' && envelope.body && typeof envelope.body === 'object'
    ? envelope.body as Record<string, unknown> : null
  const content = envelope.kind === 'student_question' ? envelope.question : body?.content
  if (typeof content !== 'string' || await textHash(content) !== message.contentHash) throw new Error('原消息正文与保存的摘要不符，不能核实。')
  if (envelope.kind === 'student_help' && envelope.bodyJsonText !== undefined && await textHash(envelope.bodyJsonText) !== message.resultHash)
    throw new Error('原辅导记录与保存的结果摘要不符，不能核实。')
  return content
}

async function readReferencedEvidence(ref: EvidenceRef, anchor: ReviewContext): Promise<RawEvidence> {
  const title = evidenceNames[ref.kind]
  const source = 'attemptId' in ref ? await readReviewContext(ref.attemptId) : anchor
  if (source.attempt.courseId !== anchor.attempt.courseId || source.attempt.studentId !== anchor.attempt.studentId ||
    'attemptId' in ref && source.attempt.attemptId !== ref.attemptId) throw new Error('原引用的课程、学生或尝试归属不符。')
  const originalRecord = (value: unknown) => JSON.stringify({ reference: ref, record: value }, null, 2)
  if (ref.kind === 'snapshot') {
    const snapshot = await referencedSnapshot(source, ref.id)
    return { title: `${title} v${snapshot.workspaceRevision}`, content: snapshot.files.map(file => `── ${file.path} · 文件版本 ${file.documentVersion} ──\n${file.text}`).join('\n\n') || '这个固定快照没有文件。',
      record: originalRecord({ snapshotId: snapshot.snapshotId, attemptId: snapshot.attemptId, hash: snapshot.hash, createdAt: snapshot.createdAt }) }
  }
  if (ref.kind === 'run') {
    const run = await teacherGet<RunView>(`/attempts/${encodeURIComponent(ref.attemptId)}/runs/${encodeURIComponent(ref.id)}`)
    const listed = source.runs.find(item => item.runId === ref.id)
    if (run.runId !== ref.id || run.diagnostics.runId !== ref.id || run.diagnostics.snapshotId !== run.snapshotId || run.diagnostics.snapshotHash !== run.snapshotHash)
      throw new Error('运行结果与原引用不符。')
    if (listed && listed.snapshotId !== run.snapshotId) throw new Error('运行引用与原尝试中的快照不符。')
    const snapshot = await referencedSnapshot(source, run.snapshotId)
    if (snapshot.hash !== run.snapshotHash) throw new Error('运行结果与原快照摘要不符。')
    const diagnostics = run.diagnostics
    return { title: run.mode === 'check' ? '原课程检查结果' : '原运行结果', content: diagnostics.status === 'unavailable'
      ? '这个运行的诊断正文当前不可用。不可用不代表运行成功。'
      : [`结果：${diagnostics.verdict || '未提供'}${diagnostics.failureKind ? `\n失败类型：${diagnostics.failureKind}` : ''}`,
        `标准输出\n${diagnostics.stdout || '没有标准输出。'}`, `错误输出\n${diagnostics.stderr || '没有错误输出。'}`].join('\n\n'), record: originalRecord(run) }
  }
  if (ref.kind === 'message' || ref.kind === 'action') {
    const action = ref.kind === 'action' ? source.help.actions.find(item => item.actionId === ref.id) : undefined
    if (ref.kind === 'action' && !action) throw new Error('当前接口无法回取这条帮助记录。')
    const message = source.help.messages.find(item => item.messageId === (action?.messageId ?? ref.id))
    if (!message || message.scope.attemptId !== ref.attemptId || message.scope.courseId !== anchor.attempt.courseId || message.scope.studentId !== anchor.attempt.studentId)
      throw new Error('当前接口无法回取归属一致的原消息。')
    if (action && (action.scope.attemptId !== ref.attemptId || action.scope.courseId !== anchor.attempt.courseId || action.scope.studentId !== anchor.attempt.studentId || action.contentHash !== message.contentHash))
      throw new Error('帮助记录与原消息的归属或摘要不符。')
    const content = await messageText(message)
    return { title: action ? title : message.authorKind === 'student' ? '学生原消息' : '系统内辅导原文', content: action
      ? `${content}\n\n实际展示：${action.receipts.some(receipt => receipt.receiptKind === 'displayed' || receipt.receiptKind === 'acknowledged') ? '有展示或确认回执' : '未知，不能由投递推定已展示'}\n当前记录状态：${action.disposition}${action.basisRevised ? '\n这次帮助的依据后来已修订。' : ''}` : content,
      record: originalRecord(action ? { message, action } : message) }
  }
  if (ref.kind === 'coverage') {
    const interval = source.coverage.intervals.find(item => item.attemptId === ref.attemptId && item.captureRevision === ref.captureRevision && item.fromServerSeq === ref.fromServerSeq)
    if (!interval || ref.id !== `coverage:${ref.attemptId}:${ref.captureRevision}:${ref.fromServerSeq}`) throw new Error('当前接口无法回取这段采集记录。')
    return { title, content: `${interval.state === 'paused' ? '采集空窗' : '允许采集区间'}\n${formatDate(interval.from)} → ${interval.open ? '尚未结束' : interval.to ? formatDate(interval.to) : '结束时间未知'}\n未接纳记录：${interval.rejections.length} 条。采集空窗与未接纳记录保留为证据缺口。`, record: originalRecord(interval) }
  }
  if (ref.kind === 'resource') {
    const resource = await teacherGet<ResourceVersion>(`/resources/${encodeURIComponent(ref.resourceVersionId)}`)
    const paragraph = resource.material.paragraphs.find(item => item.paragraphId === ref.paragraphId)
    if (resource.courseId !== anchor.attempt.courseId || resource.resourceVersionId !== ref.resourceVersionId ||
      ref.id !== `resource:${ref.resourceVersionId}:${ref.paragraphId}` || !paragraph) throw new Error('材料版本或原段落与引用不符。')
    if (await textHash(resource.material.text) !== resource.material.contentHash || await textHash(paragraph.text) !== paragraph.contentHash ||
      resource.material.text.slice(paragraph.start, paragraph.end) !== paragraph.text) throw new Error('材料原文与保存的摘要不符。')
    return { title: `${resource.material.title} · 第 ${paragraph.ordinal} 段`, content: paragraph.text,
      record: originalRecord({ courseId: resource.courseId, resourceVersionId: resource.resourceVersionId, contentHash: resource.material.contentHash, paragraph }) }
  }
  const current = await teacherGet<LearnerProjection>(`/attempts/${encodeURIComponent(anchor.attempt.attemptId)}/learner-state`)
  if (current.context.courseId !== anchor.attempt.courseId || current.context.studentId !== anchor.attempt.studentId) throw new Error('返回的学习记录归属不符。')
  if (ref.kind === 'context') {
    if (ref.id !== current.context.studentId || ref.revision !== current.context.contextRevision) throw new Error('当前接口无法回取该修订，不能用当前学生自述代替历史原文。')
    return { title: `${title} · 版本 ${ref.revision}`, content: `学生填写的目标\n${current.context.goals || '未填写'}\n\n学生填写的约束\n${current.context.constraints || '未填写'}`, record: originalRecord(current.context) }
  }
  if (ref.kind === 'claim') {
    const claim = current.claims.find(item => item.claimId === ref.id && item.claimRevision === ref.revision)
    if (!claim) throw new Error('当前接口无法回取该修订，不能用当前能力判断代替历史原文。')
    if (claim.courseId !== anchor.attempt.courseId || claim.studentId !== anchor.attempt.studentId) throw new Error('原能力判断归属不符。')
    return { title: `${title} · 版本 ${ref.revision}`, content: `${claim.statement}\n\n${claimStates[claim.state]} · ${assistance[claim.assistanceStatus]}\n${claim.unknown.map(value => `未知：${value}`).join('\n')}`, record: originalRecord(claim) }
  }
  const decision = current.decisions.find(item => item.decisionId === ref.id)
  if (!decision) throw new Error('当前接口无法回取这条教师决定。')
  if (decision.courseId !== anchor.attempt.courseId || decision.studentId !== anchor.attempt.studentId) throw new Error('原教师决定归属不符。')
  return { title, content: `${decision.decision === 'confirm' ? '确认' : decision.decision === 'correct' ? '纠正' : '暂缓'}能力判断\n${decision.reason}\n\n保存于 ${formatDate(decision.createdAt)} · 原判断版本 ${decision.targetRef.revision}`, record: originalRecord(decision) }
}
type Decision = { claim: LearnerClaim; action: 'confirm' | 'correct' | 'defer' }
type FeedbackResult = { feedbackId: string; threadRevision: number; feedbackRevision: number; submissionId: string;
  kind: 'formative' | 'submission_review'; attemptRevision: number; decisionEpoch: number; reviewed: boolean }
type ReopenResult = { grantId: string; submissionId: string; attemptRevision: number; status: 'reviewed'; supersededGrantIds: string[] }

export default function LiveReviewPage() {
  const { data, base, courseId, notify, refresh, loading, error: workspaceError, pendingCommand } = useTeacher()
  const session = useSession()
  const account = session.session?.userId ?? ''
  const [params, setParams] = useSearchParams()
  const selectedId = params.get('learner')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [submissionChoice, setSubmissionChoice] = useState('')
  const [reload, setReload] = useState(0)
  const [view, setView] = useState<{ key: string; value: ReviewContext } | null>(null)
  const [reading, setReading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [requiresRead, setRequiresRead] = useState(false)
  const [error, setError] = useState('')
  const [raw, setRaw] = useState<RawEvidence | null>(null)
  const [feedbackKind, setFeedbackKind] = useState<'formative' | 'submission_review'>('submission_review')
  const [feedbackId, setFeedbackId] = useState('')
  const [summary, setSummary] = useState('')
  const [reason, setReason] = useState('')
  const [evidence, setEvidence] = useState<string[]>([])
  const [reopenReason, setReopenReason] = useState('')
  const [decision, setDecision] = useState<Decision | null>(null)
  const [decisionReason, setDecisionReason] = useState('')
  const [decisionEvidence, setDecisionEvidence] = useState<string[]>([])
  const [replacement, setReplacement] = useState('')
  const [replacementState, setReplacementState] = useState<LearnerClaim['state']>('insufficient')
  const [replacementAssistance, setReplacementAssistance] = useState<LearnerClaim['assistanceStatus']>('unknown')
  const [replacementUnknown, setReplacementUnknown] = useState('')
  const workbenches = (data.workbenches ?? []).filter(w => !courseId || courseId === 'all' || w.courseId === courseId)
  const courseMembers = workbenches.flatMap(workbench => workbench.members.map(member => ({ member, workbench,
    assignments: workbench.assignments.filter(assignment => assignment.studentId === member.userId),
    attempts: workbench.attempts.filter(attempt => attempt.studentId === member.userId),
  })))
  const rows = workbenches.flatMap(w => w.attempts.map(attempt => ({ attempt, workbench: w,
    name: w.members.find(member => member.userId === attempt.studentId)?.displayName || attempt.studentId,
    title: w.activities.find(activity => activity.activityVersionId === attempt.activityVersionId)?.content.content.projectTitle || attempt.activityVersionId })))
  const selected = rows.find(row => row.attempt.attemptId === selectedId)
  const key = JSON.stringify([account, session.epoch, selectedId, submissionChoice, selected?.workbench.recoveryGeneration])
  const currentKey = useRef(key)
  currentKey.current = key
  const readSequence = useRef(0)
  const rawSequence = useRef(0)
  const context = view?.key === key ? view.value : null
  const submission = context?.submission
  const latest = context?.submissions.find(item => item.latest)
  const selectedLatest = !!submission && submission.submissionId === latest?.submissionId
  const canWrite = !!account && !!context && !busy && !reading && !requiresRead && !workspaceError && !pendingCommand &&
    session.status === 'authenticated' && !!session.session?.courses.some(c => c.courseId === context.attempt.courseId && c.role === 'teacher')
  const availableRefs: { ref: EvidenceRef; label: string }[] = context ? [
    ...(submission ? [{ ref: { kind: 'snapshot' as const, id: submission.snapshotId, attemptId: context.attempt.attemptId }, label: `固定作品 v${submission.workspaceRevision}` }] : []),
    ...context.runs.filter(run => !submission || run.snapshotId === submission.snapshotId).map(run => ({ ref: { kind: 'run' as const, id: run.runId, attemptId: context.attempt.attemptId }, label: `${run.mode === 'check' ? '课程检查' : '普通运行'} · ${run.runId}` })),
    ...context.help.messages.map(message => ({ ref: { kind: 'message' as const, id: message.messageId, attemptId: context.attempt.attemptId }, label: `${message.authorKind === 'student' ? '学生消息' : '辅导消息'} · ${message.messageId}` })),
  ] : []
  const chosenRefs = (values: string[]) => availableRefs.filter(item => values.includes(liveEvidenceKey(item.ref))).map(item => item.ref)
  const fixedRef = availableRefs.find(item => item.ref.kind === 'snapshot')

  function select(id: string | null) {
    setSubmissionChoice(''); setView(null); setRaw(null)
    setParams(previous => { const next = new URLSearchParams(previous); if (id) next.set('learner', id); else next.delete('learner'); return next })
  }
  useEffect(() => {
    setFeedbackId(''); setSummary(''); setReason(''); setEvidence([]); setReopenReason(''); setFeedbackKind('submission_review')
    setDecision(null); setRaw(null); setBusy(false)
    rawSequence.current++
  }, [selectedId, submissionChoice, account, session.epoch])
  useEffect(() => {
    const seq = ++readSequence.current, captured = key
    setView(null); setError(''); setRequiresRead(false)
    if (!selected || !account) { setReading(false); return }
    setReading(true)
    void readReviewContext(selected.attempt.attemptId, submissionChoice || undefined).then(value => {
      if (currentKey.current !== captured || seq !== readSequence.current) return
      if (!value || value.attempt.attemptId !== selected.attempt.attemptId || value.attempt.courseId !== selected.workbench.courseId ||
        value.attempt.studentId !== selected.attempt.studentId || !Array.isArray(value.submissions) || !value.competencies ||
        !Array.isArray(value.feedback?.entries)) throw new Error('审阅上下文归属或内容不完整，未接纳响应。')
      if (submissionChoice && value.submission?.submissionId !== submissionChoice) throw new Error('返回的固定提交与当前选择不符。')
      setView({ key: captured, value })
    }).catch(cause => { if (currentKey.current === captured && seq === readSequence.current) { setError(explain(cause)); setRequiresRead(true) } })
      .finally(() => { if (currentKey.current === captured && seq === readSequence.current) setReading(false) })
    return () => { readSequence.current++ }
  }, [key, reload])

  async function openEvidence(ref: EvidenceRef) {
    if (!context) return
    const seq = ++rawSequence.current, captured = key
    setRaw({ title: evidenceNames[ref.kind], content: '正在按原引用读取依据…' })
    try {
      const value = await readReferencedEvidence(ref, context)
      if (currentKey.current !== captured || seq !== rawSequence.current) return
      setRaw(value)
    } catch (cause) { if (currentKey.current === captured && seq === rawSequence.current) setRaw({ title: '原始依据未能核实', content: explain(cause), record: JSON.stringify(ref, null, 2) }) }
  }
  async function perform(action: () => Promise<void>, success: string) {
    if (!canWrite) return
    const captured = key
    setBusy(true); setError('')
    try {
      await action()
      if (currentKey.current !== captured) return
      setDecision(null); setEvidence([]); setFeedbackId(''); setSummary(''); setReason(''); setReopenReason('')
      setRequiresRead(true); notify(success); refresh(); setReload(value => value + 1)
    } catch (cause) {
      if (currentKey.current !== captured) return
      setError(`${explain(cause)} 请核对原教师操作或重新读取状态后再作决定。`); setRequiresRead(true)
    } finally { if (currentKey.current === captured) setBusy(false) }
  }
  function saveFeedback() {
    if (!context || !selected || !submission || !summary.trim() || !reason.trim() || !fixedRef || !evidence.includes(liveEvidenceKey(fixedRef.ref))) {
      setError('请填写反馈和理由，并明确选择所审阅的固定作品作为依据。'); return
    }
    const id = context.attempt.attemptId
    const body = { recoveryGeneration: selected.workbench.recoveryGeneration, kind: feedbackKind,
      expectedFeedbackRevision: context.feedback.feedbackRevision, expectedStateRevision: context.learnerStateRevision,
      expectedAttemptRevision: context.attempt.attemptRevision, submissionId: submission.submissionId,
      summary: summary.trim(), reason: reason.trim(), evidenceRefs: chosenRefs(evidence), ...(feedbackId ? { feedbackId } : {}) }
    void perform(async () => {
      const result = await teacherCommand<FeedbackResult>(account, 'POST', `/attempts/${encodeURIComponent(id)}/feedback`, body)
      if (!result || !result.feedbackId || result.submissionId !== submission.submissionId || result.kind !== feedbackKind ||
        result.feedbackRevision !== context.feedback.feedbackRevision + 1 || !Number.isSafeInteger(result.threadRevision) ||
        !Number.isSafeInteger(result.attemptRevision) || !Number.isSafeInteger(result.decisionEpoch)) throw new Error('正式反馈回执未确认当前提交与反馈版本。')
    }, feedbackId ? '教师反馈已追加修订，旧版保留。' : '教师反馈已保存，正在重读学生记录。')
  }
  function allowRevision() {
    if (!context || !selected || !latest || !selectedLatest || !reopenReason.trim()) { setError('请选择最新提交并填写允许修订的理由。'); return }
    void perform(async () => {
      const result = await teacherCommand<ReopenResult>(account, 'POST', `/attempts/${encodeURIComponent(context.attempt.attemptId)}/reopen`, {
        recoveryGeneration: selected.workbench.recoveryGeneration, expectedAttemptRevision: context.attempt.attemptRevision,
        submissionId: latest.submissionId, reason: reopenReason.trim() })
      if (!result?.grantId || result.submissionId !== latest.submissionId || result.status !== 'reviewed' ||
        result.attemptRevision !== context.attempt.attemptRevision + 1) throw new Error('修订许可回执未确认当前最新提交。')
    }, '已允许修订，学生仍需本人主动开始。')
  }
  function beginDecision(claim: LearnerClaim, action: Decision['action']) {
    setDecision({ claim, action }); setDecisionReason(''); setDecisionEvidence([]); setReplacement(claim.statement)
    setReplacementState(claim.state); setReplacementAssistance(claim.assistanceStatus); setReplacementUnknown(claim.unknown.join('\n')); setError('')
  }
  function saveDecision() {
    if (!context || !selected || !decision || !decisionReason.trim() || chosenRefs(decisionEvidence).length === 0 ||
      decision.action === 'correct' && !replacement.trim()) { setError('请填写理由、选择原始依据；纠正时还需填写新的具体判断。'); return }
    const claim = decision.claim, additionalRefs = chosenRefs(decisionEvidence)
    let basis: ReturnType<typeof correctionBasis> | null = null
    try { if (decision.action === 'correct') basis = correctionBasis(claim, additionalRefs) }
    catch (cause) { setError(explain(cause)); return }
    const body = { recoveryGeneration: selected.workbench.recoveryGeneration, expectedStateRevision: context.learnerStateRevision,
      targetRef: { kind: 'claim', id: claim.claimId, revision: claim.claimRevision }, decision: decision.action,
      reason: decisionReason.trim(), evidenceRefs: basis?.refs ?? additionalRefs, ...(basis ? { replacement: {
        competencyId: claim.competencyId, competencyVersion: claim.competencyVersion, domain: claim.domain, scope: claim.scope,
        statement: replacement.trim(), state: replacementState, evidenceIds: basis.evidenceIds, counterEvidenceIds: basis.counterEvidenceIds,
        assistanceStatus: replacementAssistance, unresolved: claim.unresolved || replacementState === 'insufficient' || replacementState === 'conflicting' || !!replacementUnknown.trim(),
        unknown: replacementUnknown.split('\n').map(item => item.trim()).filter(Boolean),
      } } : {}) }
    void perform(async () => {
      const result = await teacherCommand<{ decisionId: string; learnerStateRevision: number }>(account, 'POST', `/attempts/${encodeURIComponent(context.attempt.attemptId)}/reviews`, body)
      if (!result?.decisionId || result.learnerStateRevision !== context.learnerStateRevision + 1) throw new Error('教师判断回执未确认新的学习状态版本。')
    }, '教师判断已保存，相关有效状态正在重读。')
  }

  if (!selected) {
    const filtered = rows.filter(row => (status === 'all' || row.attempt.status === status) && `${row.name} ${row.title} ${row.attempt.studentId}`.toLowerCase().includes(query.toLowerCase()))
    return <div className="t-rm-page t-live-review"><LiveReviewListHeading loading={loading} onRefresh={refresh} />
      {workspaceError && <LiveReviewError message={workspaceError} />}
      <LiveReviewRoster courseMembers={courseMembers} loading={loading} />
      <LiveReviewToolbar query={query} status={status} count={rows.length} onQueryChange={setQuery} onStatusChange={setStatus} />
      {selectedId && <LiveSelectionUnavailable />}
      <LiveAttemptTable filtered={filtered} loading={loading} onSelect={select} />
    </div>
  }
  return <div className="t-rm-page t-live-review">
    <LiveLearnerHeading name={selected.name} title={selected.title} busy={busy} reading={reading} LinkComponent={Link}
      onBack={() => select(null)} onReload={() => { setReload(value => value + 1); refresh() }}
      designPath={`${base}/design/new?course=${encodeURIComponent(selected.workbench.courseId)}&from=${encodeURIComponent(selected.attempt.activityVersionId)}`} />
    {error && <LiveReviewError message={error} />}
    {reading && <LiveReviewLoading />}
    {context && <>
      <LiveReviewSnapshot context={context} submissionChoice={submissionChoice} busy={busy} onSubmissionChange={value => { setSubmissionChoice(value); setRaw(null) }} />
      {!selectedLatest && submission && <LiveHistoricalSubmissionNotice />}
      <div className="t-rm-review-grid"><main className="t-rm-review-main">
        <LiveWorkPanel context={context} onOpenEvidence={openEvidence} />
        <LiveAbilityPanel context={context} canWrite={canWrite} onOpenEvidence={openEvidence}
          onDecision={(id, revision, action) => { const claim = Object.values(context.competencies).flat().find(item => item.claimId === id && item.claimRevision === revision); if (claim) beginDecision(claim, action) }} />
        <LiveHelpPanel context={context} onOpenEvidence={openEvidence} />
        <LiveReviewHistory context={context} />
      </main><aside className="t-rm-review-side">
        <LiveFeedbackPanel context={context} canWrite={canWrite} selectedLatest={selectedLatest} busy={busy}
          feedbackId={feedbackId} feedbackKind={feedbackKind} summary={summary} reason={reason} evidence={evidence} availableRefs={availableRefs}
          onFeedbackSelect={value => { setFeedbackId(value); const entry = context.feedback.entries.find(item => item.feedbackId === value && item.current); setSummary(entry?.summary ?? ''); setReason(''); setFeedbackKind(entry?.kind ?? 'submission_review') }}
          setFeedbackKind={setFeedbackKind} setSummary={setSummary} setReason={setReason} setEvidence={setEvidence} onSave={saveFeedback} />
        <LiveRevisionPanel context={context} canWrite={canWrite} selectedLatest={selectedLatest} reopenReason={reopenReason} setReopenReason={setReopenReason} onAllowRevision={allowRevision} />
      </aside></div>
    </>}
    <LiveRawEvidenceDialog raw={raw} onClose={() => { rawSequence.current++; setRaw(null) }} />
    {context && <LiveDecisionDialog decision={decision} context={context} canWrite={canWrite} busy={busy}
      decisionReason={decisionReason} replacement={replacement} replacementState={replacementState} replacementAssistance={replacementAssistance}
      replacementUnknown={replacementUnknown} decisionEvidence={decisionEvidence} availableRefs={availableRefs} error={error}
      setDecisionReason={setDecisionReason} setReplacement={setReplacement} setReplacementState={setReplacementState}
      setReplacementAssistance={setReplacementAssistance} setReplacementUnknown={setReplacementUnknown} setDecisionEvidence={setDecisionEvidence}
      onClose={() => setDecision(null)} onSave={saveDecision} />}
  </div>
}
