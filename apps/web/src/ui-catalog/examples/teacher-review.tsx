import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  EvidenceButton, LiveAbilityPanel, LiveAttemptTable, LiveDecisionDialog, LiveEvidenceChoices, LiveFeedbackPanel,
  LiveHelpPanel, LiveHistoricalSubmissionNotice, LiveLearnerHeading, LiveRawEvidenceDialog, LiveReviewError,
  LiveReviewHistory, LiveReviewListHeading, LiveReviewLoading, LiveReviewRoster, LiveReviewSnapshot,
  LiveReviewToolbar, LiveRevisionPanel, LiveSelectionUnavailable, LiveWorkPanel, MaterialCard,
  MaterialDocumentDialog, MaterialImportDialog, MaterialsCategories, MaterialsEmpty, MaterialsFootnote,
  MaterialsHeading, MaterialsIntro, MaterialsToolbar, PreviewAbilityPanel, PreviewDecisionDialog,
  PreviewFeedbackPanel, PreviewLearnerHeading, PreviewLearnerTable, PreviewNextActionPanel,
  PreviewObservationPanels, PreviewRawEvidenceDialog, PreviewReviewEmpty, PreviewReviewFootnote,
  PreviewReviewHeading, PreviewReviewHistory, PreviewReviewSnapshot, PreviewReviewSummary, PreviewReviewToolbar,
  PreviewUnknownPanel, PreviewWorkPanel, TeacherGeneralSettings, TeacherSettingsHeading, TeacherSettingsModelLoading,
  TeacherSettingsModelNotice, TeacherSettingsNavigation, liveEvidenceKey,
  type LiveAssistance, type LiveEvidenceChoice, type LiveEvidenceRef, type LiveFeedbackKind,
  type LiveReviewAction, type LiveReviewClaim, type LiveReviewDisplayContext, type MaterialKind,
  type MaterialViewData, type PreviewClaimState, type PreviewDecisionAction, type PreviewLearnerView,
  type ReviewEvidenceView, type TeacherRouteLinkProps, type TeacherSettingsNavLinkProps, type TeacherThemePreference,
} from '@xunjie/ui/teacher-review'
import '@xunjie/ui/styles/teacher/teacher.css'
import '@xunjie/ui/styles/teacher/review-materials.css'
import '@xunjie/ui/styles/teacher/live-review.css'
import '@xunjie/ui/styles/teacher/teacher-settings.css'
import type { CatalogEntry } from '../types'

/** 此文件只使用本地合成数据；示例操作只更新当前预览。 */
const evidence: ReviewEvidenceView[] = [
  { id: 'evidence-code', type: '作品', title: '示例代码片段', text: 'if (input == NULL) return;', source: '示例快照 · main.c', assistance: '已展示概念提示' },
  { id: 'evidence-run', type: '运行记录', title: '示例空输入检查', text: '结果：输出为空。', source: '示例运行', assistance: '' },
  { id: 'evidence-self', type: '学生自述', title: '示例方案说明', text: '我先检查空输入，再读取文件。', source: '示例提交', assistance: '' },
]
const learner: PreviewLearnerView = {
  id: 'learner-example', name: '示例同学', courseId: 'course-example', activityTitle: '示例文本项目',
  status: 'submitted', route: '文件处理', updated: '今天 09:30', submission: 'submission-example', version: 3,
  evidence, claims: [
    { id: 'claim-example', domain: 'domain', text: '能在帮助下检查空输入。', state: 'supported_with_assistance', evidenceIds: ['evidence-code', 'evidence-run'] },
    { id: 'claim-missing', domain: 'project', text: '能解释部分方案选择。', state: 'insufficient', evidenceIds: ['missing-reference'] },
  ], unknowns: ['尚未观察大文件条件。'], feedback: '', decision: '', revisionAllowed: false,
}
const learnerEmpty: PreviewLearnerView = { ...learner, status: 'active', submission: '', evidence: [], claims: [], unknowns: [] }
const learnerReviewed: PreviewLearnerView = { ...learner, id: 'learner-reviewed', name: '另一位示例同学', status: 'reviewed', feedback: '请补充解释。', decision: '示例复核：暂缓判断。' }
const resources: MaterialViewData[] = [
  { id: 'material-example', courseId: 'course-example', title: '示例项目说明', kind: 'learning', content: '# 示例项目\n用文本记录一次调查。', source: '合成课程材料', student: true, tutor: true, teacherDesign: true, version: 2 },
  { id: 'private-example', courseId: 'course-example', title: '示例教师答案', kind: 'private_answer', content: '仅用于展示可见范围的示例正文。', source: '合成私有材料', student: false, tutor: false, teacherDesign: true, version: 1 },
]
const courses = [{ id: 'course-example', title: '示例程序设计' }, { id: 'course-other', title: '示例数字逻辑' }]
const snapshot: LiveEvidenceRef = { kind: 'snapshot', id: 'snapshot-example', attemptId: 'attempt-example' }
const run: LiveEvidenceRef = { kind: 'run', id: 'run-example', attemptId: 'attempt-example' }
const liveClaim: LiveReviewClaim = {
  claimId: 'claim-example', claimRevision: 2, statement: '在帮助下检查了空输入，独立解释仍需观察。',
  state: 'supported_with_assistance', source: 'model_candidate', assistanceStatus: 'observed_help', validity: 'contested',
  basisAvailable: true, evidenceIds: ['snapshot-example'], counterEvidenceIds: ['run-example'], unresolved: true,
  unknown: ['尚未观察大文件条件。'], refs: [snapshot, run],
  references: [{ ref: snapshot, status: 'available' }, { ref: run, status: 'unavailable' }],
}
const liveContext: LiveReviewDisplayContext = {
  attempt: { attemptId: 'attempt-example', attemptRevision: 4, status: 'reviewed' },
  submission: { submissionId: 'submission-example', snapshotId: 'snapshot-example', workspaceRevision: 3, submittedAt: '2026-11-08T09:00:00Z', reflection: '我检查了空文件。' },
  submissions: [
    { submissionId: 'submission-old', snapshotId: 'snapshot-old', workspaceRevision: 2, submittedAt: '2026-11-07T09:00:00Z', latest: false },
    { submissionId: 'submission-example', snapshotId: 'snapshot-example', workspaceRevision: 3, submittedAt: '2026-11-08T09:00:00Z', latest: true },
  ],
  artifact: [{ fileId: 'file-example', path: 'main.c', documentVersion: 3, contentHash: 'sha256:example' }],
  runs: [{ runId: 'run-example', mode: 'check', snapshotId: 'snapshot-example', jobStatus: 'succeeded', outcome: 'confirmed' }],
  competencies: { domain: [liveClaim], project: [], ai_collaboration: [] }, learnerStateRevision: 2,
  help: { messages: [{ messageId: 'message-example', scope: { attemptId: 'attempt-example' }, authorKind: 'model', jobId: 'job-example' }],
    actions: [{ actionId: 'action-example', scope: { attemptId: 'attempt-example' }, disposition: 'pending', basisRevised: false, receipts: [{ receiptKind: 'displayed' }] }] },
  coverage: { intervals: [{ state: 'paused', from: '2026-11-08T08:00:00Z', to: '2026-11-08T08:10:00Z', open: false, rejections: [] }] },
  decisions: [{ decisionId: 'decision-example', decision: 'defer', createdAt: '2026-11-08T09:10:00Z', reason: '需要进一步观察。', targetRef: { kind: 'claim', id: 'claim-example', revision: 1 } }],
  feedback: { entries: [{ feedbackId: 'feedback-example', threadRevision: 1, submissionId: 'submission-example', kind: 'submission_review',
    current: true, disputed: true, summary: '请补充独立解释。', reason: '当前依据存在限制。', createdAt: '2026-11-08T09:20:00Z', basis: [{ status: 'revised' }] }] },
  disputes: [{ disputeId: 'dispute-example', currentTarget: true, reason: '希望补充一次示例演示。' }],
  reopen: { state: 'none', actionable: false },
}
const liveHistorical: LiveReviewDisplayContext = { ...liveContext,
  submission: { ...liveContext.submissions[0], reflection: '我先尝试读取文件。' },
  artifact: [{ ...liveContext.artifact[0], documentVersion: 2, contentHash: 'sha256:older-example' }], runs: [],
}
const liveEmpty: LiveReviewDisplayContext = { ...liveContext, attempt: { ...liveContext.attempt, status: 'active' }, submission: null, submissions: [], artifact: [], runs: [],
  competencies: { domain: [], project: [], ai_collaboration: [] }, help: { messages: [], actions: [] }, coverage: { intervals: [] },
  decisions: [], feedback: { entries: [] }, disputes: [] }
const choices: LiveEvidenceChoice[] = [{ ref: snapshot, label: '固定作品 v3' }, { ref: run, label: '示例课程检查' }]
const historicalChoices: LiveEvidenceChoice[] = [{ ref: { kind: 'snapshot', id: 'snapshot-old', attemptId: 'attempt-example' }, label: '固定作品 v2' }]
const roster = [{ member: { userId: 'student-example', displayName: '示例同学' }, workbench: { courseId: 'course-example', courseName: '示例程序设计' },
  assignments: [{ active: true }], attempts: [{ status: 'reviewed' as const }] }]
const attempts = [{ name: '示例同学', title: '示例文本项目', workbench: { courseId: 'course-example', courseName: '示例程序设计' },
  attempt: { attemptId: 'attempt-example', status: 'reviewed' as const, latestSubmission: {} } }]

const DemoContext = createContext({ path: '/example/settings', navigate: (_path: string) => {}, notify: (_message: string) => {} })
function Stage({ children }: { children: ReactNode }) {
  const [path, setPath] = useState('/example/settings')
  const [message, setMessage] = useState('')
  return <DemoContext.Provider value={{ path, navigate: value => { setPath(value); setMessage(`示例跳转：${value}`) }, notify: setMessage }}>
    <div className="teacher-shell" style={{ display: 'block', width: '100%', height: 'auto', minHeight: '100vh', overflow: 'visible' }}>
      <main className="t-main" style={{ height: 'auto', minHeight: '100vh', overflow: 'visible', padding: 24 }}>
        <div className="t-rm-page t-live-review"><p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 20 }}>示例数据 · 操作仅在当前预览中生效</p>
          {children}<output aria-live="polite" style={{ display: 'block', marginTop: 16 }}>{message}</output></div>
      </main>
    </div>
  </DemoContext.Provider>
}
function LocalLink({ to, className, children }: TeacherRouteLinkProps) {
  const { navigate } = useContext(DemoContext)
  return <a href={`#${encodeURIComponent(to)}`} className={className} onClick={event => { event.preventDefault(); navigate(to) }}>{children}</a>
}
function LocalNavLink({ to, end, className, children }: TeacherSettingsNavLinkProps) {
  const { path, navigate } = useContext(DemoContext)
  const active = end ? path === to : path === to || path.startsWith(`${to}/`)
  return <a href={`#${encodeURIComponent(to)}`} className={className({ isActive: active })} aria-current={active ? 'page' : undefined}
    onClick={event => { event.preventDefault(); navigate(to) }}>{children}</a>
}
function NotifyButton({ children }: { children: (notify: (message: string) => void) => ReactNode }) {
  const { notify } = useContext(DemoContext)
  return <>{children(notify)}</>
}
function StageAction({ children }: { children: (notify: (message: string) => void) => ReactNode }) {
  return <Stage><NotifyButton>{children}</NotifyButton></Stage>
}
function ReviewSide({ children }: { children: ReactNode }) {
  return <aside className="t-rm-review-side" style={{ maxWidth: 360 }}>{children}</aside>
}

function EvidenceExample() { return <StageAction>{notify => <EvidenceButton evidence={evidence[0]} onOpen={item => notify(`打开示例引用：${item.title}`)} />}</StageAction> }

function LiveAbilityExample({ mode }: { mode: 'write' | 'readonly' | 'empty' }) {
  const context = mode === 'empty' ? liveEmpty : mode === 'readonly'
    ? { ...liveContext, competencies: { ...liveContext.competencies, domain: [{ ...liveClaim, basisAvailable: false }] } } : liveContext
  return <StageAction>{notify => <LiveAbilityPanel context={context} canWrite={mode === 'write'} onOpenEvidence={ref => notify(`查看示例依据：${ref.id}`)}
    onDecision={(id, revision, action) => notify(`示例操作：${action} · ${id} v${revision}`)} />}</StageAction>
}
function LiveAbilityWrite() { return <LiveAbilityExample mode="write" /> }
function LiveAbilityReadonly() { return <LiveAbilityExample mode="readonly" /> }
function LiveAbilityEmpty() { return <LiveAbilityExample mode="empty" /> }
function LiveAttemptExample({ mode }: { mode: 'rows' | 'empty' | 'loading' }) {
  return <StageAction>{notify => <LiveAttemptTable filtered={mode === 'rows' ? attempts : []} loading={mode === 'loading'} onSelect={id => notify(`选择示例尝试：${id}`)} />}</StageAction>
}
function LiveAttemptRows() { return <LiveAttemptExample mode="rows" /> }
function LiveAttemptEmpty() { return <LiveAttemptExample mode="empty" /> }
function LiveAttemptLoading() { return <LiveAttemptExample mode="loading" /> }
function LiveChoiceExample({ mode }: { mode: 'ready' | 'readonly' | 'empty' }) {
  const [values, setValues] = useState<string[]>(mode === 'readonly' ? [liveEvidenceKey(snapshot)] : [])
  return <Stage><LiveEvidenceChoices values={values} onChange={setValues} availableRefs={mode === 'empty' ? [] : choices} canWrite={mode !== 'readonly'} /></Stage>
}
function LiveChoicesReady() { return <LiveChoiceExample mode="ready" /> }
function LiveChoicesReadonly() { return <LiveChoiceExample mode="readonly" /> }
function LiveChoicesEmpty() { return <LiveChoiceExample mode="empty" /> }
function LiveFeedbackExample({ mode }: { mode: 'ready' | 'historical' | 'readonly' | 'missing' | 'saving' }) {
  const [feedbackId, setFeedbackId] = useState('')
  const [feedbackKind, setFeedbackKind] = useState<LiveFeedbackKind>(mode === 'historical' ? 'formative' : 'submission_review')
  const [summary, setSummary] = useState('')
  const [reason, setReason] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const context = mode === 'missing' ? liveEmpty : mode === 'historical' ? liveHistorical : liveContext
  return <StageAction>{notify => <ReviewSide><LiveFeedbackPanel context={context} canWrite={mode !== 'readonly' && mode !== 'saving'}
    selectedLatest={mode !== 'historical'} busy={mode === 'saving'} feedbackId={feedbackId} feedbackKind={feedbackKind} summary={summary} reason={reason}
    evidence={selected} availableRefs={mode === 'missing' ? [] : mode === 'historical' ? historicalChoices : choices} onFeedbackSelect={id => { setFeedbackId(id); setSummary(id ? '请补充独立解释。' : ''); setReason('') }}
    setFeedbackKind={setFeedbackKind} setSummary={setSummary} setReason={setReason} setEvidence={setSelected}
    onSave={() => notify('示例反馈已留在本地预览')} /></ReviewSide>}</StageAction>
}
function LiveFeedbackReady() { return <LiveFeedbackExample mode="ready" /> }
function LiveFeedbackHistorical() { return <LiveFeedbackExample mode="historical" /> }
function LiveFeedbackReadonly() { return <LiveFeedbackExample mode="readonly" /> }
function LiveFeedbackMissing() { return <LiveFeedbackExample mode="missing" /> }
function LiveFeedbackSaving() { return <LiveFeedbackExample mode="saving" /> }
function LiveHelpExample({ empty }: { empty: boolean }) {
  return <StageAction>{notify => <LiveHelpPanel context={empty ? liveEmpty : liveContext} onOpenEvidence={ref => notify(`查看示例记录：${ref.id}`)} />}</StageAction>
}
function LiveHelpRecords() { return <LiveHelpExample empty={false} /> }
function LiveHelpEmpty() { return <LiveHelpExample empty /> }
function LiveHistoryRecords() { return <Stage><LiveReviewHistory context={liveContext} /></Stage> }
function LiveHistoryEmpty() { return <Stage><LiveReviewHistory context={liveEmpty} /></Stage> }
function LiveRosterExample({ mode }: { mode: 'rows' | 'empty' | 'loading' }) {
  return <Stage><LiveReviewRoster courseMembers={mode === 'rows' ? roster : []} loading={mode === 'loading'} /></Stage>
}
function LiveRosterRows() { return <LiveRosterExample mode="rows" /> }
function LiveRosterEmpty() { return <LiveRosterExample mode="empty" /> }
function LiveRosterLoading() { return <LiveRosterExample mode="loading" /> }
function LiveSnapshotExample({ empty }: { empty: boolean }) {
  const [value, setValue] = useState('')
  const context = empty ? liveEmpty : value === liveHistorical.submission?.submissionId ? liveHistorical : liveContext
  return <Stage><LiveReviewSnapshot context={context} submissionChoice={value} busy={false} onSubmissionChange={setValue} /></Stage>
}
function LiveSnapshotSubmitted() { return <LiveSnapshotExample empty={false} /> }
function LiveSnapshotEmpty() { return <LiveSnapshotExample empty /> }
function LiveToolbarExample() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  return <Stage><LiveReviewToolbar query={query} status={status} count={1} onQueryChange={setQuery} onStatusChange={setStatus} /></Stage>
}
function LiveRevisionExample({ mode }: { mode: 'ready' | 'historical' | 'consumed' }) {
  const [reason, setReason] = useState('')
  const context = mode === 'historical' ? liveHistorical : mode === 'consumed' ? { ...liveContext, reopen: { state: 'consumed', actionable: false } } : liveContext
  return <StageAction>{notify => <ReviewSide><LiveRevisionPanel context={context} canWrite selectedLatest={mode !== 'historical'}
    reopenReason={reason} setReopenReason={setReason} onAllowRevision={() => notify('示例修订操作已触发')} /></ReviewSide>}</StageAction>
}
function LiveRevisionReady() { return <LiveRevisionExample mode="ready" /> }
function LiveRevisionHistorical() { return <LiveRevisionExample mode="historical" /> }
function LiveRevisionConsumed() { return <LiveRevisionExample mode="consumed" /> }
function LiveWorkExample({ empty }: { empty: boolean }) {
  return <StageAction>{notify => <LiveWorkPanel context={empty ? liveEmpty : liveContext} onOpenEvidence={ref => notify(`打开示例依据：${ref.id}`)} />}</StageAction>
}
function LiveWorkSubmitted() { return <LiveWorkExample empty={false} /> }
function LiveWorkEmpty() { return <LiveWorkExample empty /> }

function LiveDecisionExample({ action, readonly, withError }: { action: LiveReviewAction; readonly?: boolean; withError?: boolean }) {
  const [open, setOpen] = useState(true)
  const [reason, setReason] = useState('')
  const [replacement, setReplacement] = useState(liveClaim.statement)
  const [state, setState] = useState<PreviewClaimState>(liveClaim.state)
  const [help, setHelp] = useState<LiveAssistance>(liveClaim.assistanceStatus)
  const [unknown, setUnknown] = useState(liveClaim.unknown.join('\n'))
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState(withError ? '请填写理由并选择原始依据。' : '')
  return <StageAction>{notify => <><button type="button" className="t-rm-button" onClick={() => setOpen(true)}>打开示例复核</button>
    <LiveDecisionDialog decision={open ? { action, claim: liveClaim } : null} context={liveContext} canWrite={!readonly} busy={false}
      decisionReason={reason} replacement={replacement} replacementState={state} replacementAssistance={help} replacementUnknown={unknown}
      decisionEvidence={selected} availableRefs={choices} error={error} setDecisionReason={setReason} setReplacement={setReplacement}
      setReplacementState={setState} setReplacementAssistance={setHelp} setReplacementUnknown={setUnknown} setDecisionEvidence={setSelected}
      onClose={() => setOpen(false)} onSave={() => { if (!reason.trim() || !selected.length) { setError('请填写理由并选择原始依据。'); return }
        setError(''); setOpen(false); notify('示例判断已留在本地预览') }} /></>}</StageAction>
}
function LiveDecisionCorrect() { return <LiveDecisionExample action="correct" /> }
function LiveDecisionConfirm() { return <LiveDecisionExample action="confirm" /> }
function LiveDecisionDefer() { return <LiveDecisionExample action="defer" /> }
function LiveDecisionReadonly() { return <LiveDecisionExample action="correct" readonly /> }
function LiveDecisionError() { return <LiveDecisionExample action="confirm" withError /> }
function LiveRawExample() {
  const [open, setOpen] = useState(true)
  return <Stage><button type="button" className="t-rm-button" onClick={() => setOpen(true)}>打开示例依据</button>
    <LiveRawEvidenceDialog raw={open ? { title: '示例原始依据', content: '这里是合成的原始记录。', record: JSON.stringify(snapshot, null, 2) } : null}
      onClose={() => setOpen(false)} /></Stage>
}
function LiveHistorical() { return <Stage><LiveHistoricalSubmissionNotice /></Stage> }
function LiveLearner() { return <StageAction>{notify => <LiveLearnerHeading name="示例同学" title="示例文本项目" busy={false} reading={false}
  designPath="/example/design" LinkComponent={LocalLink} onBack={() => notify('返回示例学生列表')} onReload={() => notify('重新读取示例数据')} />}</StageAction> }
function LiveError() { return <Stage><LiveReviewError message="示例读取失败，请重新读取。" /></Stage> }
function LiveListHeading() { return <StageAction>{notify => <LiveReviewListHeading loading={false} onRefresh={() => notify('重新读取示例列表')} />}</StageAction> }
function LiveListLoading() { return <Stage><LiveReviewListHeading loading onRefresh={() => {}} /></Stage> }
function LiveLoading() { return <Stage><LiveReviewLoading /></Stage> }
function LiveSelection() { return <Stage><LiveSelectionUnavailable /></Stage> }

function MaterialCardExample({ isPrivate, preview }: { isPrivate: boolean; preview: boolean }) {
  const resource = resources[isPrivate ? 1 : 0]
  return <StageAction>{notify => <div className="t-rm-material-list"><MaterialCard resource={resource} preview={preview} onOpen={item => notify(`打开示例材料：${item.title}`)} /></div>}</StageAction>
}
function MaterialCardPreview() { return <MaterialCardExample isPrivate={false} preview /> }
function MaterialCardPrivate() { return <MaterialCardExample isPrivate preview={false} /> }
function MaterialDocumentExample({ preview }: { preview: boolean }) {
  const [open, setOpen] = useState(true)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open && dialog.current && !dialog.current.open) dialog.current.showModal() }, [open])
  return <Stage><button type="button" className="t-rm-button" onClick={() => setOpen(true)}>打开示例材料</button>
    <MaterialDocumentDialog opened={open ? resources[preview ? 0 : 1] : null} preview={preview} courses={courses}
      contentDialog={dialog} onClosed={() => setOpen(false)} /></Stage>
}
function MaterialDocumentPreview() { return <MaterialDocumentExample preview /> }
function MaterialDocumentLive() { return <MaterialDocumentExample preview={false} /> }
function MaterialImportExample({ mode }: { mode: 'file' | 'paste' | 'private' | 'reading' | 'saving' | 'error' | 'live' }) {
  const [open, setOpen] = useState(true)
  const [title, setTitle] = useState(mode === 'error' ? '' : '示例课程材料')
  const [course, setCourse] = useState('course-example')
  const [kind, setKind] = useState<MaterialKind>(mode === 'private' ? 'private_answer' : 'learning')
  const [source, setSource] = useState('合成示例')
  const [tab, setTab] = useState<'file' | 'paste'>(mode === 'file' || mode === 'reading' ? 'file' : 'paste')
  const [content, setContent] = useState(mode === 'file' || mode === 'reading' ? '' : '这是一段合成的课程材料。')
  const [filename, setFilename] = useState('')
  const [student, setStudent] = useState(false)
  const [tutor, setTutor] = useState(false)
  const [teacherDesign, setTeacherDesign] = useState(false)
  const [error, setError] = useState(mode === 'error' ? '请填写资料名称。' : '')
  const dialog = useRef<HTMLDialogElement>(null)
  const file = useRef<HTMLInputElement>(null)
  const saving = mode === 'saving'
  const reading = mode === 'reading'
  useEffect(() => { if (open && dialog.current && !dialog.current.open) dialog.current.showModal() }, [open])
  useEffect(() => { if (kind === 'private_answer' || kind === 'validation') { setStudent(false); setTutor(false) } }, [kind])
  function close() { if (!saving) { dialog.current?.close(); setOpen(false) } }
  return <StageAction>{notify => <><button type="button" className="t-rm-button" onClick={() => setOpen(true)}>打开示例导入</button>
    <MaterialImportDialog importDialog={dialog} fileInput={file} importing={open} preview={mode !== 'live'} saving={saving}
      reading={reading} title={title} importCourseId={course} kind={kind} source={source} importTab={tab}
      content={content} filename={filename} student={student} tutor={tutor} teacherDesign={teacherDesign}
      contentLimit={mode === 'live' ? 256 * 1024 : 1024 * 1024} limitLabel={mode === 'live' ? '256 KiB' : '1 MiB'} error={error} courses={courses}
      setTitle={setTitle} setImportCourseId={setCourse} setKind={setKind} setSource={setSource} setImportTab={setTab}
      setContent={setContent} setStudent={setStudent} setTutor={setTutor} setTeacherDesign={setTeacherDesign}
      onFileChange={() => { setFilename('示例.md'); setContent('这是模拟读取的合成正文。') }} closeImport={close}
      onClosed={() => setOpen(false)} onSubmit={() => { if (!title.trim() || !content.trim()) { setError('请填写资料名称、所属课程和正文。'); return }
        setError(''); close(); notify('示例材料已留在本地预览') }} /></>}</StageAction>
}
function MaterialImportFile() { return <MaterialImportExample mode="file" /> }
function MaterialImportPaste() { return <MaterialImportExample mode="paste" /> }
function MaterialImportPrivate() { return <MaterialImportExample mode="private" /> }
function MaterialImportReading() { return <MaterialImportExample mode="reading" /> }
function MaterialImportSaving() { return <MaterialImportExample mode="saving" /> }
function MaterialImportError() { return <MaterialImportExample mode="error" /> }
function MaterialImportLive() { return <MaterialImportExample mode="live" /> }
function MaterialsCategoriesExample({ empty }: { empty: boolean }) {
  const [kind, setKind] = useState('all')
  return <Stage><div className="t-rm-material-layout"><MaterialsCategories resources={empty ? [] : resources} kindFilter={kind} onChange={setKind} />
    <section className="t-rm-material-main"><p className="t-rm-caption">当前示例分类：{kind}</p></section></div></Stage>
}
function MaterialsCategoriesReady() { return <MaterialsCategoriesExample empty={false} /> }
function MaterialsCategoriesEmpty() { return <MaterialsCategoriesExample empty /> }
function MaterialsEmptyExample({ hasMaterials, canImport }: { hasMaterials: boolean; canImport: boolean }) {
  return <StageAction>{notify => <MaterialsEmpty count={hasMaterials ? 2 : 0} canImport={canImport} limitLabel="1 MiB"
    onReset={() => notify('已重置示例筛选')} onImport={() => notify('打开示例导入')} />}</StageAction>
}
function MaterialsNoResult() { return <MaterialsEmptyExample hasMaterials canImport /> }
function MaterialsNoItems() { return <MaterialsEmptyExample hasMaterials={false} canImport /> }
function MaterialsNoCourse() { return <MaterialsEmptyExample hasMaterials={false} canImport={false} /> }
function MaterialsFootPreview() { return <Stage><MaterialsFootnote preview /></Stage> }
function MaterialsFootLive() { return <Stage><MaterialsFootnote preview={false} /></Stage> }
function MaterialsHeadingReady() { return <StageAction>{notify => <MaterialsHeading canImport onImport={() => notify('打开示例导入')} />}</StageAction> }
function MaterialsHeadingDisabled() { return <Stage><MaterialsHeading canImport={false} onImport={() => {}} /></Stage> }
function MaterialsIntroReady() { return <Stage><MaterialsIntro count={2} /></Stage> }
function MaterialsIntroEmpty() { return <Stage><MaterialsIntro count={0} /></Stage> }
function MaterialsToolbarExample() {
  const [query, setQuery] = useState('')
  const [visibility, setVisibility] = useState('all')
  return <Stage><MaterialsToolbar query={query} visibility={visibility} onQueryChange={setQuery} onVisibilityChange={setVisibility} /></Stage>
}

function PreviewAbilityExample({ mode }: { mode: 'ready' | 'readonly' | 'empty' }) {
  return <StageAction>{notify => <PreviewAbilityPanel selected={mode === 'empty' ? learnerEmpty : learner} preview={mode !== 'readonly'}
    onOpen={id => notify(`打开示例引用：${id}`)} onDecision={(action, id) => notify(`示例决定：${action} · ${id}`)} />}</StageAction>
}
function PreviewAbilityReady() { return <PreviewAbilityExample mode="ready" /> }
function PreviewAbilityReadonly() { return <PreviewAbilityExample mode="readonly" /> }
function PreviewAbilityEmpty() { return <PreviewAbilityExample mode="empty" /> }
function PreviewFeedbackExample({ mode }: { mode: 'ready' | 'missing' | 'readonly' }) {
  const [feedback, setFeedback] = useState('')
  return <StageAction>{notify => <ReviewSide><PreviewFeedbackPanel selected={mode === 'missing' ? learnerEmpty : learner} preview={mode !== 'readonly'} feedback={feedback}
    onFeedbackChange={setFeedback} onSave={() => notify('示例反馈已留在本地预览')} /></ReviewSide>}</StageAction>
}
function PreviewFeedbackReady() { return <PreviewFeedbackExample mode="ready" /> }
function PreviewFeedbackMissing() { return <PreviewFeedbackExample mode="missing" /> }
function PreviewFeedbackReadonly() { return <PreviewFeedbackExample mode="readonly" /> }
function PreviewLearner() { return <StageAction>{notify => <PreviewLearnerHeading selected={learner} onBack={() => notify('返回示例学生列表')} />}</StageAction> }
function PreviewTable() { return <StageAction>{notify => <PreviewLearnerTable learners={[learner, learnerReviewed]} onSelect={id => notify(`选择示例学生：${id}`)} />}</StageAction> }
function PreviewNextExample({ mode }: { mode: 'pending' | 'ready' | 'allowed' | 'readonly' }) {
  const [allowed, setAllowed] = useState(mode === 'allowed')
  const selected = { ...(mode === 'pending' ? learner : learnerReviewed), revisionAllowed: allowed }
  return <StageAction>{notify => <ReviewSide><PreviewNextActionPanel selected={selected} preview={mode !== 'readonly'} designPath="/example/design" LinkComponent={LocalLink}
    onRevision={() => { setAllowed(true); notify('示例修订许可已更新') }} /></ReviewSide>}</StageAction>
}
function PreviewNextPending() { return <PreviewNextExample mode="pending" /> }
function PreviewNextReady() { return <PreviewNextExample mode="ready" /> }
function PreviewNextAllowed() { return <PreviewNextExample mode="allowed" /> }
function PreviewNextReadonly() { return <PreviewNextExample mode="readonly" /> }
function PreviewObservations({ empty }: { empty: boolean }) {
  return <StageAction>{notify => <PreviewObservationPanels selected={empty ? learnerEmpty : learner} onOpen={id => notify(`打开示例引用：${id}`)} />}</StageAction>
}
function PreviewObservationsReady() { return <PreviewObservations empty={false} /> }
function PreviewObservationsEmpty() { return <PreviewObservations empty /> }
function PreviewEmptyExample({ mode }: { mode: 'unavailable' | 'empty' | 'filtered' }) {
  return <StageAction>{notify => <PreviewReviewEmpty unavailable={mode === 'unavailable'} hasLearners={mode === 'filtered'} hasFilters={mode === 'filtered'}
    onReset={() => notify('已重置示例筛选')} />}</StageAction>
}
function PreviewUnavailable() { return <PreviewEmptyExample mode="unavailable" /> }
function PreviewNoStudents() { return <PreviewEmptyExample mode="empty" /> }
function PreviewNoMatches() { return <PreviewEmptyExample mode="filtered" /> }
function PreviewFoot() { return <Stage><PreviewReviewFootnote /></Stage> }
function PreviewHeading() { return <Stage><PreviewReviewHeading /></Stage> }
function PreviewHistoryReady() { return <Stage><ReviewSide><PreviewReviewHistory selected={learnerReviewed} /></ReviewSide></Stage> }
function PreviewHistoryEmpty() { return <Stage><ReviewSide><PreviewReviewHistory selected={learner} /></ReviewSide></Stage> }
function PreviewSnapshotReady() { return <Stage><PreviewReviewSnapshot selected={learner} /></Stage> }
function PreviewSnapshotEmpty() { return <Stage><PreviewReviewSnapshot selected={learnerEmpty} /></Stage> }
function PreviewSummaryReady() { return <Stage><PreviewReviewSummary learners={[learner, learnerReviewed]} progressUnavailable={false} /></Stage> }
function PreviewSummaryUnavailable() { return <Stage><PreviewReviewSummary learners={[]} progressUnavailable /></Stage> }
function PreviewToolbarExample() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  return <Stage><PreviewReviewToolbar query={query} status={status} progressUnavailable={false} count={2} onQueryChange={setQuery} onStatusChange={setStatus} /></Stage>
}
function PreviewToolbarUnavailable() {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  return <Stage><PreviewReviewToolbar query={query} status={status} progressUnavailable count={0} onQueryChange={setQuery} onStatusChange={setStatus} /></Stage>
}
function PreviewUnknownReady() { return <Stage><PreviewUnknownPanel selected={learner} /></Stage> }
function PreviewUnknownEmpty() { return <Stage><PreviewUnknownPanel selected={learnerEmpty} /></Stage> }
function PreviewWorkExample({ empty }: { empty: boolean }) {
  return <StageAction>{notify => <PreviewWorkPanel selected={empty ? learnerEmpty : learner} onOpen={id => notify(`打开示例引用：${id}`)} />}</StageAction>
}
function PreviewWorkReady() { return <PreviewWorkExample empty={false} /> }
function PreviewWorkEmpty() { return <PreviewWorkExample empty /> }

function PreviewRawExample() {
  const [open, setOpen] = useState(true)
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open && dialog.current && !dialog.current.open) dialog.current.showModal() }, [open])
  return <Stage><button type="button" className="t-rm-button" onClick={() => setOpen(true)}>打开示例引用</button>
    <PreviewRawEvidenceDialog raw={open ? evidence[0] : null} rawDialog={dialog} onClosed={() => setOpen(false)} /></Stage>
}
function PreviewDecisionExample({ action, readonly, withError }: { action: PreviewDecisionAction; readonly?: boolean; withError?: boolean }) {
  const [open, setOpen] = useState(true)
  const [reason, setReason] = useState('')
  const [references, setReferences] = useState<string[]>(withError ? [] : ['evidence-code'])
  const [correction, setCorrection] = useState(learner.claims[0].text)
  const [correctedState, setCorrectedState] = useState<PreviewClaimState>('supported_with_assistance')
  const [error, setError] = useState(withError ? '请填写理由，并选择至少一条原始证据。' : '')
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open && dialog.current && !dialog.current.open) dialog.current.showModal() }, [open])
  function close() { dialog.current?.close(); setOpen(false) }
  return <StageAction>{notify => <><button type="button" className="t-rm-button" onClick={() => setOpen(true)}>打开示例决定</button>
    <PreviewDecisionDialog decisionDialog={dialog} decision={open ? { action, claim: action === 'revision' ? undefined : learner.claims[0] } : null}
      selected={learner} preview={!readonly} reason={reason} references={references} correction={correction} correctedState={correctedState}
      formError={error} setReason={setReason} setReferences={setReferences} setCorrection={setCorrection} setCorrectedState={setCorrectedState}
      closeDecision={close} onClosed={() => setOpen(false)} onSubmit={() => { if (!reason.trim() || !references.length) { setError('请填写理由，并选择至少一条原始证据。'); return }
        setError(''); close(); notify('示例决定已留在本地预览') }} /></>}</StageAction>
}
function PreviewDecisionConfirm() { return <PreviewDecisionExample action="confirm" /> }
function PreviewDecisionCorrect() { return <PreviewDecisionExample action="correct" /> }
function PreviewDecisionRevision() { return <PreviewDecisionExample action="revision" /> }
function PreviewDecisionReadonly() { return <PreviewDecisionExample action="correct" readonly /> }
function PreviewDecisionError() { return <PreviewDecisionExample action="confirm" withError /> }
function GeneralSettingsExample({ preview }: { preview: boolean }) {
  const [theme, setTheme] = useState<TeacherThemePreference>('system')
  return <StageAction>{notify => <TeacherGeneralSettings preview={preview} preference={theme} onPreferenceChange={setTheme}
    onExportPreview={() => notify('示例导出操作已触发')} />}</StageAction>
}
function GeneralPreview() { return <GeneralSettingsExample preview /> }
function GeneralLive() { return <GeneralSettingsExample preview={false} /> }
function SettingsHeading() { return <Stage><TeacherSettingsHeading /></Stage> }
function SettingsLoading() { return <Stage><TeacherSettingsModelLoading /></Stage> }
function SettingsModelNotice() { return <Stage><TeacherSettingsModelNotice LinkComponent={LocalLink} /></Stage> }
function SettingsNavigation() { return <Stage><div className="t-settings-layout"><TeacherSettingsNavigation base="/example" LinkComponent={LocalNavLink} />
  <div className="t-settings-content st-body-in"><p>示例设置内容</p></div></div></Stage> }

const reviewImport = '@xunjie/ui/teacher-review'
const exampleSource = 'apps/web/src/ui-catalog/examples/teacher-review.tsx'
const previewSource = 'packages/ui/src/teacher-review/PreviewReview.tsx'
const liveSource = 'packages/ui/src/teacher-review/LiveReview.tsx'
const materialsSource = 'packages/ui/src/teacher-review/Materials.tsx'
const settingsSource = 'packages/ui/src/teacher-review/Settings.tsx'
const teacherStyles = '@xunjie/ui/styles/teacher/teacher.css'
const reviewStyles = '@xunjie/ui/styles/teacher/review-materials.css'
const liveStyles = '@xunjie/ui/styles/teacher/live-review.css'
const settingsStyles = '@xunjie/ui/styles/teacher/teacher-settings.css'

export const teacherReviewEntries: CatalogEntry[] = [
  { id: 'evidence-button', name: 'EvidenceButton', description: '可打开的预览证据引用。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['evidence: ReviewEvidenceView', 'onOpen(evidence)'], dependencies: [teacherStyles, reviewStyles], states: [
      { id: 'reference', name: '示例引用', component: EvidenceExample },
    ] },
  { id: 'live-ability-panel', name: 'LiveAbilityPanel', description: '真实审阅的三条能力线及原始引用。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['context: LiveReviewDisplayContext', 'canWrite, onOpenEvidence, onDecision'], dependencies: [teacherStyles, reviewStyles, liveStyles], states: [
      { id: 'editable', name: '可复核', component: LiveAbilityWrite, viewport: 'wide', height: 850 },
      { id: 'readonly', name: '只读 / 依据不可用', component: LiveAbilityReadonly, viewport: 'wide', height: 850 },
      { id: 'empty', name: '无有效主张', component: LiveAbilityEmpty, viewport: 'wide', height: 650 },
    ] },
  { id: 'live-attempt-table', name: 'LiveAttemptTable', description: '真实尝试列表及加载、空状态。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['filtered: LiveAttemptRow[], loading', 'onSelect(id)'], dependencies: [teacherStyles, reviewStyles, liveStyles], states: [
      { id: 'rows', name: '有尝试', component: LiveAttemptRows, viewport: 'wide' },
      { id: 'empty', name: '无匹配', component: LiveAttemptEmpty }, { id: 'loading', name: '读取中', component: LiveAttemptLoading },
    ] },
  { id: 'live-decision-dialog', name: 'LiveDecisionDialog', description: '真实能力复核表单，包含引用与纠正状态。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['decision, context, canWrite, busy', 'reason, replacement, evidence 及对应回调'], dependencies: [teacherStyles, reviewStyles, liveStyles, 'Radix Portal；数据与操作由宿主提供'], states: [
      { id: 'correct', name: '纠正', component: LiveDecisionCorrect, height: 1300 },
      { id: 'confirm', name: '确认', component: LiveDecisionConfirm, height: 700 },
      { id: 'defer', name: '暂缓', component: LiveDecisionDefer, height: 700 },
      { id: 'readonly', name: '只读', component: LiveDecisionReadonly, height: 1300 },
      { id: 'error', name: '校验失败', component: LiveDecisionError, height: 800 },
    ] },
  { id: 'live-evidence-choices', name: 'LiveEvidenceChoices', description: '受控的真实依据选择。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['values, availableRefs, canWrite, onChange', 'legend?；使用 liveEvidenceKey 获取稳定键'], dependencies: [teacherStyles, reviewStyles, liveStyles], states: [
      { id: 'ready', name: '可选择', component: LiveChoicesReady }, { id: 'readonly', name: '只读', component: LiveChoicesReadonly },
      { id: 'empty', name: '无可用依据', component: LiveChoicesEmpty },
    ] },
  { id: 'live-feedback-panel', name: 'LiveFeedbackPanel', description: '真实教师反馈、线程和依据表单。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['context, canWrite, selectedLatest, busy', 'feedbackId, feedbackKind, summary, reason, evidence 及回调'], dependencies: [teacherStyles, reviewStyles, liveStyles, '权限和保存由宿主控制'], states: [
      { id: 'ready', name: '最新提交', component: LiveFeedbackReady, height: 1050 }, { id: 'historical', name: '历史提交', component: LiveFeedbackHistorical, height: 1050 },
      { id: 'readonly', name: '无写入权限', component: LiveFeedbackReadonly, height: 1050 }, { id: 'missing', name: '未提交 / 无依据', component: LiveFeedbackMissing, height: 1050 },
      { id: 'saving', name: '保存中', component: LiveFeedbackSaving, height: 1050 },
    ] },
  { id: 'live-help-panel', name: 'LiveHelpPanel', description: '实际帮助、展示回执与采集空窗。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['context, onOpenEvidence'], dependencies: [teacherStyles, reviewStyles, liveStyles], states: [
      { id: 'records', name: '有记录与空窗', component: LiveHelpRecords }, { id: 'empty', name: '没有可回取消息', component: LiveHelpEmpty },
    ] },
  { id: 'live-historical-submission-notice', name: 'LiveHistoricalSubmissionNotice', description: '历史提交审阅提示。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['无属性'], dependencies: [reviewStyles], states: [{ id: 'history', name: '历史提交', component: LiveHistorical }] },
  { id: 'live-learner-heading', name: 'LiveLearnerHeading', description: '真实学生详情标题与导航操作。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['name, title, busy, reading', 'designPath, LinkComponent, onBack, onReload'], dependencies: [teacherStyles, reviewStyles, liveStyles, '链接适配器由宿主提供'], states: [
      { id: 'ready', name: '详情 / 操作', component: LiveLearner, viewport: 'wide' },
    ] },
  { id: 'live-raw-evidence-dialog', name: 'LiveRawEvidenceDialog', description: '真实原始依据的只读弹窗。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['raw: { title, content, record? } | null', 'onClose'], dependencies: [teacherStyles, reviewStyles, liveStyles, 'Radix Portal'], states: [
      { id: 'open', name: '原始依据 / 关闭', component: LiveRawExample, height: 650 },
    ] },
  { id: 'live-review-error', name: 'LiveReviewError', description: '真实审阅读取失败提示。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['message: string'], dependencies: [reviewStyles], states: [{ id: 'error', name: '读取失败', component: LiveError }] },
  { id: 'live-review-history', name: 'LiveReviewHistory', description: '真实教师决定、反馈和异议历史。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['context: LiveReviewDisplayContext'], dependencies: [teacherStyles, reviewStyles, liveStyles], states: [
      { id: 'records', name: '历史 / 异议', component: LiveHistoryRecords, height: 650 }, { id: 'empty', name: '无历史', component: LiveHistoryEmpty },
    ] },
  { id: 'live-review-list-heading', name: 'LiveReviewListHeading', description: '真实学生列表标题与刷新。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['loading, onRefresh'], dependencies: [reviewStyles], states: [
      { id: 'ready', name: '可读取', component: LiveListHeading, viewport: 'wide' }, { id: 'loading', name: '读取中', component: LiveListLoading, viewport: 'wide' },
    ] },
  { id: 'live-review-loading', name: 'LiveReviewLoading', description: '固定作品及判断读取提示。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['无属性'], dependencies: [reviewStyles], states: [{ id: 'loading', name: '读取中', component: LiveLoading }] },
  { id: 'live-review-roster', name: 'LiveReviewRoster', description: '真实课程成员及其分配和尝试。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['courseMembers: LiveRosterMember[], loading'], dependencies: [teacherStyles, reviewStyles, liveStyles], states: [
      { id: 'rows', name: '课程成员', component: LiveRosterRows, viewport: 'wide' }, { id: 'empty', name: '无成员', component: LiveRosterEmpty },
      { id: 'loading', name: '读取中', component: LiveRosterLoading },
    ] },
  { id: 'live-review-snapshot', name: 'LiveReviewSnapshot', description: '固定提交状态与提交版本选择。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['context, submissionChoice, busy, onSubmissionChange'], dependencies: [reviewStyles, liveStyles], states: [
      { id: 'submitted', name: '选择提交版本', component: LiveSnapshotSubmitted, viewport: 'wide' }, { id: 'empty', name: '尚未提交', component: LiveSnapshotEmpty, viewport: 'wide' },
    ] },
  { id: 'live-review-toolbar', name: 'LiveReviewToolbar', description: '真实审阅搜索和状态筛选。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['query, status, count', 'onQueryChange, onStatusChange'], dependencies: [reviewStyles], states: [{ id: 'interactive', name: '搜索与筛选', component: LiveToolbarExample, viewport: 'wide' }] },
  { id: 'live-revision-panel', name: 'LiveRevisionPanel', description: '真实修订许可状态与理由输入。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['context, canWrite, selectedLatest', 'reopenReason, setReopenReason, onAllowRevision'], dependencies: [reviewStyles, liveStyles], states: [
      { id: 'ready', name: '可发放', component: LiveRevisionReady }, { id: 'historical', name: '历史提交禁用', component: LiveRevisionHistorical },
      { id: 'consumed', name: '许可已使用', component: LiveRevisionConsumed },
    ] },
  { id: 'live-selection-unavailable', name: 'LiveSelectionUnavailable', description: '所选尝试不在可访问列表中的提示。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['无属性'], dependencies: [reviewStyles], states: [{ id: 'unavailable', name: '尝试不可用', component: LiveSelection }] },
  { id: 'live-work-panel', name: 'LiveWorkPanel', description: '固定作品、反思和运行记录。', importPath: reviewImport, source: liveSource, exampleSource,
    props: ['context, onOpenEvidence'], dependencies: [reviewStyles, liveStyles], states: [
      { id: 'submitted', name: '固定作品 / 运行', component: LiveWorkSubmitted, height: 650 }, { id: 'empty', name: '尚未提交', component: LiveWorkEmpty },
    ] },
  { id: 'material-card', name: 'MaterialCard', description: '课程材料摘要及可见范围。', importPath: reviewImport, source: materialsSource, exampleSource,
    props: ['resource: MaterialViewData, preview, onOpen'], dependencies: [reviewStyles], states: [
      { id: 'preview', name: '预览材料', component: MaterialCardPreview }, { id: 'private', name: '真实入口 / 私有材料', component: MaterialCardPrivate },
    ] },
  { id: 'material-document-dialog', name: 'MaterialDocumentDialog', description: '材料原文与角色可见范围。', importPath: reviewImport, source: materialsSource, exampleSource,
    props: ['opened, preview, courses, contentDialog, onClosed'], dependencies: [reviewStyles, '原生 dialog：宿主负责 showModal 与关闭'], states: [
      { id: 'preview', name: '预览正文', component: MaterialDocumentPreview, height: 700 }, { id: 'live', name: '真实入口 / 私有正文', component: MaterialDocumentLive, height: 700 },
    ] },
  { id: 'material-import-dialog', name: 'MaterialImportDialog', description: '受控材料导入表单与可见范围。', importPath: reviewImport, source: materialsSource, exampleSource,
    props: ['title, course, kind, source, content, visibility 及 setter', 'importing, saving, reading, error, refs 与操作回调'],
    dependencies: [reviewStyles, '原生 dialog；文件示例使用合成正文，不读取或上传文件'], states: [
      { id: 'file', name: '选择文本', component: MaterialImportFile, height: 950 }, { id: 'paste', name: '粘贴正文', component: MaterialImportPaste, height: 950 },
      { id: 'private', name: '私有材料', component: MaterialImportPrivate, height: 950 }, { id: 'reading', name: '读取中', component: MaterialImportReading, height: 950 },
      { id: 'saving', name: '保存中', component: MaterialImportSaving, height: 950 }, { id: 'error', name: '校验错误', component: MaterialImportError, height: 950 },
      { id: 'live', name: '真实入口样式', component: MaterialImportLive, height: 950 },
    ] },
  { id: 'materials-categories', name: 'MaterialsCategories', description: '按类型选择课程材料。', importPath: reviewImport, source: materialsSource, exampleSource,
    props: ['resources, kindFilter, onChange'], dependencies: [reviewStyles], states: [
      { id: 'ready', name: '材料分类', component: MaterialsCategoriesReady, height: 560 }, { id: 'empty', name: '无材料', component: MaterialsCategoriesEmpty, height: 560 },
    ] },
  { id: 'materials-empty', name: 'MaterialsEmpty', description: '无材料与筛选无结果。', importPath: reviewImport, source: materialsSource, exampleSource,
    props: ['count, canImport, limitLabel, onReset, onImport'], dependencies: [reviewStyles], states: [
      { id: 'no-result', name: '筛选无结果', component: MaterialsNoResult }, { id: 'empty', name: '无材料', component: MaterialsNoItems },
      { id: 'no-course', name: '无课程 / 禁用导入', component: MaterialsNoCourse },
    ] },
  { id: 'materials-footnote', name: 'MaterialsFootnote', description: '预览与真实课程的材料范围说明。', importPath: reviewImport, source: materialsSource, exampleSource,
    props: ['preview: boolean'], dependencies: [reviewStyles], states: [
      { id: 'preview', name: '隔离预览', component: MaterialsFootPreview }, { id: 'live', name: '真实入口', component: MaterialsFootLive },
    ] },
  { id: 'materials-heading', name: 'MaterialsHeading', description: '材料页标题与导入入口。', importPath: reviewImport, source: materialsSource, exampleSource,
    props: ['canImport, onImport'], dependencies: [reviewStyles], states: [
      { id: 'ready', name: '可导入', component: MaterialsHeadingReady, viewport: 'wide' }, { id: 'disabled', name: '无课程 / 禁用', component: MaterialsHeadingDisabled, viewport: 'wide' },
    ] },
  { id: 'materials-intro', name: 'MaterialsIntro', description: '课程材料范围说明与数量。', importPath: reviewImport, source: materialsSource, exampleSource,
    props: ['count: number'], dependencies: [reviewStyles], states: [
      { id: 'ready', name: '有材料', component: MaterialsIntroReady, viewport: 'wide' }, { id: 'empty', name: '零材料', component: MaterialsIntroEmpty, viewport: 'wide' },
    ] },
  { id: 'materials-toolbar', name: 'MaterialsToolbar', description: '材料搜索和可见范围筛选。', importPath: reviewImport, source: materialsSource, exampleSource,
    props: ['query, visibility, onQueryChange, onVisibilityChange'], dependencies: [reviewStyles], states: [
      { id: 'interactive', name: '搜索与筛选', component: MaterialsToolbarExample, viewport: 'wide' },
    ] },
  { id: 'preview-ability-panel', name: 'PreviewAbilityPanel', description: '预览能力线、引用和判断操作。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['selected, preview, onOpen, onDecision'], dependencies: [reviewStyles], states: [
      { id: 'ready', name: '可复核 / 缺失引用', component: PreviewAbilityReady, viewport: 'wide', height: 800 },
      { id: 'readonly', name: '只读', component: PreviewAbilityReadonly, viewport: 'wide', height: 800 },
      { id: 'empty', name: '无表现', component: PreviewAbilityEmpty, viewport: 'wide', height: 650 },
    ] },
  { id: 'preview-decision-dialog', name: 'PreviewDecisionDialog', description: '预览教师决定及修订许可表单。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['decisionDialog, decision, selected, preview', 'reason, references, correction 与回调'], dependencies: [reviewStyles, '原生 dialog：宿主负责打开和关闭'], states: [
      { id: 'confirm', name: '确认', component: PreviewDecisionConfirm, height: 780 }, { id: 'correct', name: '纠正', component: PreviewDecisionCorrect, height: 1000 },
      { id: 'revision', name: '允许修订', component: PreviewDecisionRevision, height: 780 }, { id: 'readonly', name: '只读', component: PreviewDecisionReadonly, height: 1000 },
      { id: 'error', name: '校验错误', component: PreviewDecisionError, height: 780 },
    ] },
  { id: 'preview-feedback-panel', name: 'PreviewFeedbackPanel', description: '隔离预览的教师反馈。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['selected, preview, feedback, onFeedbackChange, onSave'], dependencies: [reviewStyles], states: [
      { id: 'ready', name: '填写反馈', component: PreviewFeedbackReady, height: 640 }, { id: 'missing', name: '尚未提交', component: PreviewFeedbackMissing, height: 640 },
      { id: 'readonly', name: '只读', component: PreviewFeedbackReadonly, height: 640 },
    ] },
  { id: 'preview-learner-heading', name: 'PreviewLearnerHeading', description: '预览学生详情标题和返回。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['selected: PreviewLearnerView, onBack'], dependencies: [reviewStyles], states: [{ id: 'detail', name: '学生详情', component: PreviewLearner, viewport: 'wide' }] },
  { id: 'preview-learner-table', name: 'PreviewLearnerTable', description: '预览学生进展表。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['learners: PreviewLearnerView[], onSelect'], dependencies: [reviewStyles], states: [{ id: 'rows', name: '学生列表', component: PreviewTable, viewport: 'wide' }] },
  { id: 'preview-next-action-panel', name: 'PreviewNextActionPanel', description: '预览反馈后修订与后续活动入口。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['selected, preview, designPath, LinkComponent, onRevision'], dependencies: [reviewStyles, '链接适配器由宿主提供'], states: [
      { id: 'pending', name: '等待反馈', component: PreviewNextPending, height: 620 }, { id: 'ready', name: '可允许修订', component: PreviewNextReady, height: 620 },
      { id: 'allowed', name: '已允许', component: PreviewNextAllowed, height: 620 }, { id: 'readonly', name: '只读', component: PreviewNextReadonly, height: 620 },
    ] },
  { id: 'preview-observation-panels', name: 'PreviewObservationPanels', description: '预览的实际帮助与学生自述。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['selected, onOpen'], dependencies: [reviewStyles], states: [
      { id: 'records', name: '有观察', component: PreviewObservationsReady, viewport: 'wide', height: 620 }, { id: 'empty', name: '无观察', component: PreviewObservationsEmpty, viewport: 'wide', height: 500 },
    ] },
  { id: 'preview-raw-evidence-dialog', name: 'PreviewRawEvidenceDialog', description: '预览原始引用弹窗。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['raw, rawDialog, onClosed'], dependencies: [reviewStyles, '原生 dialog：宿主负责 showModal'], states: [
      { id: 'open', name: '原始引用 / 关闭', component: PreviewRawExample, height: 700 },
    ] },
  { id: 'preview-review-empty', name: 'PreviewReviewEmpty', description: '预览学生记录空态与不可用状态。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['unavailable, hasLearners, hasFilters, onReset'], dependencies: [reviewStyles], states: [
      { id: 'unavailable', name: '未接入', component: PreviewUnavailable }, { id: 'empty', name: '无学生', component: PreviewNoStudents },
      { id: 'filtered', name: '筛选无结果', component: PreviewNoMatches },
    ] },
  { id: 'preview-review-footnote', name: 'PreviewReviewFootnote', description: '预览证据解释说明。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['无属性'], dependencies: [reviewStyles], states: [{ id: 'note', name: '说明', component: PreviewFoot }] },
  { id: 'preview-review-heading', name: 'PreviewReviewHeading', description: '预览学生进展页标题。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['无属性'], dependencies: [reviewStyles], states: [{ id: 'heading', name: '标题', component: PreviewHeading, viewport: 'wide' }] },
  { id: 'preview-review-history', name: 'PreviewReviewHistory', description: '预览复核记录。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['selected: PreviewLearnerView'], dependencies: [reviewStyles], states: [
      { id: 'records', name: '已有记录', component: PreviewHistoryReady }, { id: 'empty', name: '无记录', component: PreviewHistoryEmpty },
    ] },
  { id: 'preview-review-snapshot', name: 'PreviewReviewSnapshot', description: '预览提交快照与版本。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['selected: PreviewLearnerView'], dependencies: [reviewStyles], states: [
      { id: 'submitted', name: '固定提交', component: PreviewSnapshotReady, viewport: 'wide' }, { id: 'empty', name: '尚未提交', component: PreviewSnapshotEmpty, viewport: 'wide' },
    ] },
  { id: 'preview-review-summary', name: 'PreviewReviewSummary', description: '预览学生数量与审阅摘要。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['learners, progressUnavailable'], dependencies: [reviewStyles], states: [
      { id: 'values', name: '示例数量', component: PreviewSummaryReady, viewport: 'wide' }, { id: 'unknown', name: '尚未接入', component: PreviewSummaryUnavailable, viewport: 'wide' },
    ] },
  { id: 'preview-review-toolbar', name: 'PreviewReviewToolbar', description: '预览学生搜索和状态筛选。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['query, status, progressUnavailable, count', 'onQueryChange, onStatusChange'], dependencies: [reviewStyles], states: [
      { id: 'ready', name: '搜索与筛选', component: PreviewToolbarExample, viewport: 'wide' }, { id: 'unavailable', name: '列表未接入', component: PreviewToolbarUnavailable, viewport: 'wide' },
    ] },
  { id: 'preview-unknown-panel', name: 'PreviewUnknownPanel', description: '预览反证与未知。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['selected: PreviewLearnerView'], dependencies: [reviewStyles], states: [
      { id: 'items', name: '已记录未知项', component: PreviewUnknownReady }, { id: 'empty', name: '无记录', component: PreviewUnknownEmpty },
    ] },
  { id: 'preview-work-panel', name: 'PreviewWorkPanel', description: '预览作品与运行记录。', importPath: reviewImport, source: previewSource, exampleSource,
    props: ['selected, onOpen'], dependencies: [reviewStyles], states: [
      { id: 'records', name: '有作品与运行', component: PreviewWorkReady }, { id: 'empty', name: '无记录', component: PreviewWorkEmpty },
    ] },
  { id: 'teacher-general-settings', name: 'TeacherGeneralSettings', description: '教师通用外观与范围说明。', importPath: reviewImport, source: settingsSource, exampleSource,
    props: ['preview, preference, onPreferenceChange, onExportPreview'], dependencies: [teacherStyles, settingsStyles], states: [
      { id: 'preview', name: '隔离预览', component: GeneralPreview, viewport: 'wide', height: 800 }, { id: 'live', name: '真实入口', component: GeneralLive, viewport: 'wide', height: 750 },
    ] },
  { id: 'teacher-settings-heading', name: 'TeacherSettingsHeading', description: '教师设置页标题。', importPath: reviewImport, source: settingsSource, exampleSource,
    props: ['无属性'], dependencies: [teacherStyles, settingsStyles], states: [{ id: 'heading', name: '标题', component: SettingsHeading, viewport: 'wide' }] },
  { id: 'teacher-settings-model-loading', name: 'TeacherSettingsModelLoading', description: '教师模型设置读取状态。', importPath: reviewImport, source: settingsSource, exampleSource,
    props: ['无属性'], dependencies: [teacherStyles, settingsStyles], states: [{ id: 'loading', name: '读取中', component: SettingsLoading }] },
  { id: 'teacher-settings-model-notice', name: 'TeacherSettingsModelNotice', description: '预览中真实模型设置入口提示。', importPath: reviewImport, source: settingsSource, exampleSource,
    props: ['LinkComponent'], dependencies: [teacherStyles, settingsStyles, '链接适配器由宿主提供'], states: [{ id: 'preview', name: '模型设置提示', component: SettingsModelNotice, height: 600 }] },
  { id: 'teacher-settings-navigation', name: 'TeacherSettingsNavigation', description: '教师设置导航及当前项。', importPath: reviewImport, source: settingsSource, exampleSource,
    props: ['base, LinkComponent'], dependencies: [teacherStyles, settingsStyles, '链接和当前路径由宿主提供'], states: [{ id: 'navigation', name: '切换设置', component: SettingsNavigation }] },
]
