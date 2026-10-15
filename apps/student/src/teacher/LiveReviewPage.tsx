import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Icon, IconText } from '../icons'
import { useSession } from '../components/SessionEntry'
import { textHash, verifySnapshot } from '../workspace/confirmation'
import type { RunView } from '../workspace/runContracts'
import type { SnapshotView } from '../workspace/workspaceContracts'
import { useTeacher } from './context'
import { readReviewContext, teacherCommand, teacherGet } from './backend'
import { TeacherDialog } from './ui'
import type { EvidenceRef, LearnerClaim, ResourceVersion, ReviewContext } from './wire'
import './review-materials.css'
import './live-review.css'

const statuses = { ready: '尚未开始', active: '进行中', submitted: '待审阅', reviewed: '已反馈', paused: '已暂停' }
const claimStates = { insufficient: '证据不足', supported_with_assistance: '受助条件下有支持', supported_in_check: '限定检查条件下有支持', conflicting: '证据冲突' }
const assistance = { observed_help: '已观察到系统内帮助', none_observed_in_system: '系统内未观察到帮助', unknown: '帮助条件未知' }
const domains = [{ key: 'domain', title: '学科知识与技能', icon: 'book-2' }, { key: 'project', title: '项目能力', icon: 'structure' },
  { key: 'ai_collaboration', title: '人机协同与 AI 素养', icon: 'chat-square-line' }] as const
const formatDate = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '时间未提供'
const refKey = (ref: EvidenceRef) => JSON.stringify(Object.entries(ref).sort(([a], [b]) => a.localeCompare(b)))
const mergeRefs = (refs: EvidenceRef[]) => [...new Map(refs.map(ref => [refKey(ref), ref])).values()]
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
  const chosenRefs = (values: string[]) => availableRefs.filter(item => values.includes(refKey(item.ref))).map(item => item.ref)
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
    if (!context || !selected || !submission || !summary.trim() || !reason.trim() || !fixedRef || !evidence.includes(refKey(fixedRef.ref))) {
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
  function renderEvidenceChoices(values: string[], onChange: (values: string[]) => void, legend = '选择原始依据') {
    return <fieldset className="t-rm-evidence-checks" disabled={!canWrite}><legend>{legend}</legend>
      {availableRefs.map(item => <label key={refKey(item.ref)}><input type="checkbox" checked={values.includes(refKey(item.ref))}
        onChange={event => onChange(event.target.checked ? [...values, refKey(item.ref)] : values.filter(value => value !== refKey(item.ref)))} />
        <span>{item.label}<small>{item.ref.id}</small></span></label>)}
      {availableRefs.length === 0 && <p className="t-rm-caption">没有可用原始依据，当前不能保存正式决定。</p>}
    </fieldset>
  }

  if (!selected) {
    const filtered = rows.filter(row => (status === 'all' || row.attempt.status === status) && `${row.name} ${row.title} ${row.attempt.studentId}`.toLowerCase().includes(query.toLowerCase()))
    return <div className="t-rm-page t-live-review"><div className="t-rm-page-heading"><div><div className="t-rm-eyebrow">LEARNING EVIDENCE</div><h1>学生与证据</h1><p>从真实尝试与固定提交进入审阅，作品表现与能力判断分别查看。</p></div><button type="button" className="t-rm-button" disabled={loading} onClick={refresh}>重新读取学生列表</button></div>
      {workspaceError && <p role="alert" className="t-rm-error">{workspaceError}</p>}
      <section className="t-rm-panel t-live-roster" aria-labelledby="course-students-title">
        <div className="t-rm-section-head"><h2 id="course-students-title">课程学生</h2><span className="t-rm-caption">{courseMembers.length} 条课程成员</span></div>
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
      </section>
      <div className="t-rm-toolbar"><label className="t-rm-search"><Icon name="minimalistic-magnifier" size={16} /><input aria-label="搜索学生审阅" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索学生或项目" /></label>
        <label className="t-rm-filter-label">状态<select aria-label="审阅状态" value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option>{Object.entries(statuses).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <span className="t-rm-caption">{rows.length} 个真实尝试</span></div>
      {selectedId && <p role="status" className="t-rm-error">这项尝试不在当前获准课程列表中，请重新选择。</p>}
      {loading ? <p role="status">正在读取课程尝试…</p> : filtered.length === 0 ? <div className="t-rm-empty"><h2>暂无匹配的学生尝试</h2><p>尚未开始的分配不会自动生成学生作品或能力证据。</p></div>
        : <div className="t-rm-learner-table"><div className="t-rm-learner-table-head"><span>学生</span><span>项目</span><span>提交</span><span>状态</span><span /></div>
          {filtered.map(row => <button type="button" className="t-rm-learner-row" key={row.attempt.attemptId} onClick={() => select(row.attempt.attemptId)}>
            <span className="t-rm-learner-identity"><span className="t-rm-avatar">{row.name.slice(0, 2)}</span><span><strong>{row.name}</strong></span></span>
            <span className="t-rm-learner-project"><strong>{row.title}</strong><small>{row.workbench.courseName || row.workbench.courseId}</small></span>
            <span>{row.attempt.latestSubmission ? '已有提交' : '尚未提交'}</span><span className={`t-rm-status t-rm-status-${row.attempt.status}`}>{statuses[row.attempt.status]}</span><Icon name="alt-arrow-right" size={16} />
          </button>)}</div>}
    </div>
  }
  return <div className="t-rm-page t-live-review">
    <button type="button" className="t-rm-back" onClick={() => select(null)}><IconText name="alt-arrow-left">全部学生</IconText></button>
    <div className="t-rm-page-heading"><div><div className="t-rm-eyebrow">LEARNING EVIDENCE</div><h1>{selected.name}<span className="t-rm-title-secondary">的学习记录</span></h1><p>{selected.title}</p></div>
      <div className="t-live-heading-actions"><Link className="t-rm-button" to={`${base}/design/new?course=${encodeURIComponent(selected.workbench.courseId)}&from=${encodeURIComponent(selected.attempt.activityVersionId)}`}>设计后续项目</Link>
      <button type="button" className="t-rm-button" disabled={busy || reading} onClick={() => { setReload(value => value + 1); refresh() }}>重新读取审阅</button></div></div>
    {error && <p role="alert" className="t-rm-error">{error}</p>}
    {reading && <p role="status">正在读取固定作品、有效判断与反馈…</p>}
    {context && <>
      <div className="t-rm-snapshot"><Icon name="lock-keyhole" size={18} /><div><strong>{submission ? '本次审阅绑定固定提交' : '尚未提交 · 仅有过程记录'}</strong>
        <span>{submission?.submissionId || '没有可用于正式作品反馈的提交'} · 尝试版本 {context.attempt.attemptRevision} · 状态 {statuses[context.attempt.status]}</span></div>
        {context.submissions.length > 0 && <label className="t-rm-filter-label">审阅提交<select aria-label="审阅提交" disabled={busy} value={submissionChoice || context.submission?.submissionId || ''}
          onChange={event => { setSubmissionChoice(event.target.value); setRaw(null) }}>{[...context.submissions].reverse().map(item => <option key={item.submissionId} value={item.submissionId}>作品 v{item.workspaceRevision} · {formatDate(item.submittedAt)}{item.latest ? ' · 最新' : ''}</option>)}</select></label>}
      </div>
      {!selectedLatest && submission && <div className="t-rm-note"><strong>正在审阅历史提交</strong><p>作品原文固定在这次提交；能力线仍是当前有效状态。历史过程反馈不会改变最新提交的学习阶段。</p></div>}
      <div className="t-rm-review-grid"><main className="t-rm-review-main">
        <section className="t-rm-panel"><div className="t-rm-section-head"><h2>固定作品与运行</h2><span className="t-rm-caption">作品表现</span></div>
          {submission ? <><p>确认作品 v{submission.workspaceRevision} · {formatDate(submission.submittedAt)}</p>
            <button type="button" className="t-rm-reference" onClick={() => { void openEvidence({ kind: 'snapshot', id: submission.snapshotId, attemptId: context.attempt.attemptId }) }}><IconText name="code-square">查看固定作品原文</IconText></button>
            {context.artifact.map(file => <div className="t-rm-observation" key={file.fileId}><p>{file.path} · 文件版本 {file.documentVersion}</p><small className="t-rm-mono">{file.contentHash}</small></div>)}
            <div className="t-rm-note"><strong>学生提交反思</strong><p className="t-live-prewrap">{submission.reflection || '这次提交未附反思；缺失保持未知。'}</p></div>
          </> : <p>尚未固定提交，不把当前工作区当成正式提交作品。</p>}
          {context.runs.filter(run => !submission || run.snapshotId === submission.snapshotId).map(run => <button type="button" key={run.runId} className="t-rm-evidence-row" onClick={() => { void openEvidence({ kind: 'run', id: run.runId, attemptId: context.attempt.attemptId }) }}>
            <span><strong>{run.mode === 'check' ? '课程检查' : '普通运行'} · {run.outcome}</strong><small>{run.runId} · 原快照 {run.snapshotId} · 作业 {run.jobStatus}</small></span><Icon name="alt-arrow-right" size={16} /></button>)}
          <p>运行退出成功、课程检查结果与学生个人能力分别判断。失败、缺失和执行未知不算通过。</p>
        </section>
        <section className="t-rm-panel t-rm-ability-panel"><div className="t-rm-section-head"><h2>三条能力线</h2><span className="t-rm-caption">当前有效状态 · 版本 {context.learnerStateRevision}</span></div>
          {domains.map((domain, index) => <div className="t-rm-domain" key={domain.key}><div className="t-rm-domain-heading"><span className="t-rm-domain-number">0{index + 1}</span><Icon name={domain.icon} size={18} /><h3>{domain.title}</h3></div>
            {context.competencies[domain.key].length === 0 ? <p className="t-rm-unobserved">暂无这一能力线的有效主张。没有观察不等于失败，也不由作品完成推定掌握。</p>
              : context.competencies[domain.key].map(claim => <article className="t-rm-claim" key={`${claim.claimId}:${claim.claimRevision}`}>
                <span className={`t-rm-claim-state t-rm-claim-${claim.state}`}>{claimStates[claim.state]}</span><p>{claim.statement}</p>
                <p className="t-rm-caption">{claim.source === 'teacher_judgment' ? '教师判断' : '模型候选'} · {assistance[claim.assistanceStatus]} · {claim.validity === 'contested' ? '存在争议' : '当前有效'} · 版本 {claim.claimRevision}</p>
                {!claim.basisAvailable && <p className="t-rm-error">原依据不可回取，不能把这条主张当成已核实事实。</p>}
                {claim.references.map((item, i) => <div className="t-live-reference" key={i}><button type="button" className="t-rm-reference" onClick={() => { void openEvidence(item.ref) }}>查看{evidenceNames[item.ref.kind]}</button>
                  <span className="t-rm-caption">{claim.counterEvidenceIds.includes(item.ref.id) ? '原反证 · ' : ''}{item.status === 'available' ? '引用存在，原文需核实' : '当前依据不可用'}</span>
                  <details><summary className="t-rm-caption">引用标识</summary><pre className="t-live-json">{JSON.stringify(item.ref, null, 2)}</pre></details></div>)}
                <p className="t-rm-caption">反证引用：{claim.counterEvidenceIds.length ? claim.counterEvidenceIds.join('、') : '尚无'}；{claim.unresolved ? '仍有未决问题' : '未标记未决问题'}</p>
                {claim.unknown.map((text, i) => <p key={i} className="t-rm-caption">未知：{text}</p>)}
                <div className="t-rm-claim-actions"><button type="button" disabled={!canWrite} onClick={() => beginDecision(claim, 'confirm')}>确认</button><button type="button" disabled={!canWrite} onClick={() => beginDecision(claim, 'correct')}>纠正</button><button type="button" disabled={!canWrite} onClick={() => beginDecision(claim, 'defer')}>暂缓</button></div>
              </article>)}
          </div>)}
        </section>
        <section className="t-rm-panel"><div className="t-rm-section-head"><h2>实际帮助与记录缺口</h2><span className="t-rm-caption">过程条件</span></div>
          {context.help.messages.length === 0 && <p>没有可回取的教学消息，不能据此证明学生没有获得其他帮助。</p>}
          {context.help.messages.map(message => <button type="button" className="t-rm-evidence-row" key={message.messageId} onClick={() => { void openEvidence({ kind: 'message', id: message.messageId, attemptId: message.scope.attemptId }) }}>
            <span><strong>{message.authorKind === 'student' ? '学生主动消息' : '辅导消息'}</strong><small>{message.messageId} · 来源作业 {message.jobId}</small></span><Icon name="alt-arrow-right" size={16} /></button>)}
          {context.help.actions.map(action => <details key={action.actionId}><summary>{action.actionId} · {action.disposition} · {action.receipts.some(receipt => receipt.receiptKind === 'displayed' || receipt.receiptKind === 'acknowledged') ? '有实际展示回执' : '是否展示未知'}</summary><p className="t-rm-caption">{action.basisRevised ? '该帮助的依据后来已修订。' : '没有标记依据后来修订。'} 投递与展示是不同事实。</p><button type="button" className="t-rm-reference" onClick={() => { void openEvidence({ kind: 'action', id: action.actionId, attemptId: action.scope.attemptId }) }}>查看帮助与展示原记录</button></details>)}
          {context.coverage.intervals.map((interval, i) => <p className="t-rm-caption" key={i}>{interval.state === 'paused' ? '采集空窗' : '允许采集区间'} · {formatDate(interval.from)} → {interval.open ? '当前' : interval.to ? formatDate(interval.to) : '结束时间未知'}{interval.rejections.length ? ` · ${interval.rejections.length} 条未接纳记录` : ''}</p>)}
        </section>
        <section className="t-rm-panel"><h2>教师决定与反馈历史</h2>
          {context.decisions.length === 0 && context.feedback.entries.length === 0 && <p>尚无教师保存的决定或反馈。</p>}
          {context.decisions.map(item => <details key={item.decisionId}><summary>{item.decision === 'confirm' ? '确认' : item.decision === 'correct' ? '纠正' : '暂缓'}判断 · {formatDate(item.createdAt)}</summary><p>{item.reason}</p><pre className="t-live-json">{JSON.stringify(item.targetRef, null, 2)}</pre></details>)}
          {context.feedback.entries.map(item => <article className="t-live-history" key={`${item.feedbackId}:${item.threadRevision}`}><strong>{item.kind === 'submission_review' ? '作品审阅' : '过程反馈'} · 第 {item.threadRevision} 版{item.current ? ' · 当前修订' : ' · 历史修订'}</strong>
            <p className="t-live-prewrap">{item.summary}</p><p>理由：{item.reason}</p><p className="t-rm-caption">提交 {item.submissionId} · {formatDate(item.createdAt)}{item.disputed ? ' · 有学生异议' : ''}</p>
            {item.basis.some(basis => basis.status !== 'current') && <p className="t-rm-error">部分原依据已变化、撤回或不可回取，请复核后决定是否修订反馈。</p>}</article>)}
          {context.disputes.map(item => <div className="t-rm-note" key={item.disputeId}><strong>学生异议 · {item.currentTarget ? '针对当前版本' : '历史对象'}</strong><p>{item.reason}</p></div>)}
        </section>
      </main><aside className="t-rm-review-side">
        <section className="t-rm-panel"><h2>{feedbackId ? '修订教师反馈' : '给学生反馈'}</h2><p>反馈写入真实教学服务。正式作品审阅只针对最新固定提交，旧版反馈保留。</p>
          <label className="t-rm-field"><span>反馈线程</span><select aria-label="反馈线程" value={feedbackId} disabled={!canWrite || !submission} onChange={event => {
            setFeedbackId(event.target.value)
            const entry = context.feedback.entries.find(item => item.feedbackId === event.target.value && item.current)
            setSummary(entry?.summary ?? ''); setReason(''); setFeedbackKind(entry?.kind ?? 'submission_review')
          }}><option value="">新增一条反馈</option>{context.feedback.entries.filter(item => item.current && item.submissionId === submission?.submissionId).map(item => <option key={item.feedbackId} value={item.feedbackId}>修订第 {item.threadRevision} 版 · {item.kind === 'submission_review' ? '作品审阅' : '过程反馈'}</option>)}</select></label>
          <label className="t-rm-field"><span>反馈类型</span><select aria-label="反馈类型" value={feedbackKind} disabled={!canWrite} onChange={event => setFeedbackKind(event.target.value as typeof feedbackKind)}><option value="submission_review" disabled={!selectedLatest || !['submitted', 'reviewed'].includes(context.attempt.status)}>正式作品审阅</option><option value="formative">过程反馈（不改变阶段）</option></select></label>
          <label className="t-rm-field"><span>反馈正文</span><textarea aria-label="教师反馈正文" rows={6} maxLength={16384} value={summary} disabled={!canWrite || !submission} onChange={event => setSummary(event.target.value)} placeholder="给出具体表现和可以继续行动的建议" /></label>
          <label className="t-rm-field"><span>反馈理由</span><textarea aria-label="教师反馈理由" maxLength={512} value={reason} disabled={!canWrite || !submission} onChange={event => setReason(event.target.value)} /></label>
          {renderEvidenceChoices(evidence, setEvidence)}
          <button type="button" className="t-rm-button t-rm-button-primary t-rm-full" disabled={!canWrite || !submission || feedbackKind === 'submission_review' && (!selectedLatest || !['submitted', 'reviewed'].includes(context.attempt.status))} onClick={saveFeedback}>{busy ? '正在保存…' : feedbackId ? '保存反馈修订' : '保存教师反馈'}</button>
        </section>
        <section className="t-rm-panel"><h2>允许学生修订</h2><p>许可针对最新已审阅提交。学生主动开始修订后恢复编辑，不由教师替学生继续。</p>
          <p>当前许可：{context.reopen.state === 'none' ? '从未发放' : context.reopen.actionable ? '可由学生使用' : context.reopen.state === 'consumed' ? '已由学生使用' : '已发放但当前不可用'}</p>
          <label className="t-rm-field"><span>允许修订的理由</span><textarea aria-label="允许修订理由" maxLength={512} value={reopenReason} disabled={!canWrite || !selectedLatest || context.attempt.status !== 'reviewed'} onChange={event => setReopenReason(event.target.value)} /></label>
          <button type="button" className="t-rm-button t-rm-full" disabled={!canWrite || !selectedLatest || context.attempt.status !== 'reviewed'} onClick={allowRevision}>允许修订本次提交</button>
        </section>
      </aside></div>
    </>}
    <TeacherDialog open={!!raw} onOpenChange={open => { if (!open) { rawSequence.current++; setRaw(null) } }} title={raw?.title || '原始证据'} description="只读原始引用；不会替学生保存、修改或运行作品。">
      <pre className="t-rm-raw-content">{raw?.content}</pre>
      {raw?.record && <details className="t-live-raw-record"><summary>原始记录与引用标识</summary><pre className="t-live-json">{raw.record}</pre></details>}
    </TeacherDialog>
    {decision && context && <TeacherDialog open onOpenChange={open => { if (!open && !busy) setDecision(null) }} title={`${decision.action === 'confirm' ? '确认' : decision.action === 'correct' ? '纠正' : '暂缓'}能力判断`}
      description={`原判断版本 ${decision.claim.claimRevision} · 学习状态版本 ${context.learnerStateRevision}。保存后追加记录，旧判断保留。`}>
      <div><p>{decision.claim.statement}</p><label className="t-rm-field"><span>复核理由</span><textarea aria-label="能力复核理由" maxLength={512} value={decisionReason} disabled={!canWrite} onChange={event => setDecisionReason(event.target.value)} /></label>
        {decision.action === 'correct' && <><label className="t-rm-field"><span>纠正后的判断</span><textarea aria-label="纠正后的判断" maxLength={16384} value={replacement} disabled={!canWrite} onChange={event => setReplacement(event.target.value)} /></label>
          <label className="t-rm-field"><span>支持状态</span><select value={replacementState} disabled={!canWrite} onChange={event => setReplacementState(event.target.value as typeof replacementState)}>{Object.entries(claimStates).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="t-rm-field"><span>帮助条件</span><select value={replacementAssistance} disabled={!canWrite} onChange={event => setReplacementAssistance(event.target.value as typeof replacementAssistance)}>{Object.entries(assistance).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label className="t-rm-field"><span>仍未知的部分（每行一项）</span><textarea value={replacementUnknown} disabled={!canWrite} onChange={event => setReplacementUnknown(event.target.value)} /></label>
          <div className="t-rm-note t-live-preserved"><strong>保留原判断的证据与反证</strong><p>原证据 {decision.claim.evidenceIds.length} 项、原反证 {decision.claim.counterEvidenceIds.length} 项及其引用、帮助与采集依据会完整保留。下方选择会追加教师复核依据；已列为反证的内容仍保留为反证。</p>
            <details><summary>查看保留的引用标识</summary><pre className="t-live-json">{JSON.stringify({ evidenceIds: decision.claim.evidenceIds, counterEvidenceIds: decision.claim.counterEvidenceIds, references: decision.claim.refs }, null, 2)}</pre></details></div></>}
        {renderEvidenceChoices(decisionEvidence, setDecisionEvidence, decision.action === 'correct' ? '新增教师复核依据' : '选择原始依据')}{error && <p role="alert" className="t-rm-error">{error}</p>}
      </div><footer className="t-rm-dialog-footer"><button type="button" className="t-rm-button" disabled={busy} onClick={() => setDecision(null)}>取消</button><button type="button" className="t-rm-button t-rm-button-primary" disabled={!canWrite} onClick={saveDecision}>保存教师判断</button></footer>
    </TeacherDialog>}
  </div>
}
