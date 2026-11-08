import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  DesignAnchor, PreviewDesignField, LiveDesignField, DesignLinkedChoices, DesignCheckGroup, DesignRepeatHeading,
  DesignValue, DesignAgentView, PreviewBriefSection, PreviewGoalsSection, PreviewMilestonesSection, PreviewSupportSection,
  PreviewDesignSupport, PreviewDesignDialogs, PreviewRoleArticle, LiveBriefSection, LiveGoalsSection,
  LiveMilestonesSection, LiveSupportSection, LiveDesignChecks, LiveDesignDialogs, LiveReleaseSummary, LiveRolePreview,
  PreviewDesignNavigation, PreviewDesignSectionHeading, PreviewDesignFooter, PreviewDesignHeading, PreviewDesignTopline,
  LiveDesignNavigation, LiveDesignSectionHeading, LiveDesignFooter, LiveDesignHeading, LiveDesignTopline,
  FollowUpDesignSource, DesignUnavailable, PreviewDesignSource, PreviewDesignReadOnlyNotice, LiveDesignNotices,
  FollowUpDesignHeading, FollowUpDesignActions, FollowUpDesignError,
  type PreviewDraftDisplay, type PreviewResourceDisplay, type LiveContentDisplay, type LivePreviewDisplay,
  type PreviewSection, type PreviewRole, type LiveRole, type DesignLinkProps, type LiveConcernDisplay,
  type DesignAgentMode, type DesignAgentViewProps, type PreviewSuggestionDisplay,
} from '@xunjie/ui/teacher-design'
import '@xunjie/ui/styles/teacher/teacher.css'
import '@xunjie/ui/styles/teacher/design.css'
import '@xunjie/ui/styles/teacher/live-design.css'
import '@xunjie/ui/styles/teacher/design-agent.css'
import type { CatalogEntry, CatalogState } from '../types'

const courses = [{ id: 'example-c', title: '示例程序设计' }, { id: 'example-hdl', title: '示例数字逻辑' }]
const learners = [{ id: 'example-lin', name: '示例小林' }, { id: 'example-zhou', name: '示例小周' }]
const members = learners.map(item => ({ userId: item.id, displayName: item.name }))
const resources: PreviewResourceDisplay[] = [
  { id: 'example-resource', title: '示例公开材料', kind: 'learning', content: '比较两种方案，并记录边界条件。', source: '目录本地样本', student: true, tutor: true, teacherDesign: true, version: 1 },
  { id: 'example-private', title: '示例教师核对材料', kind: 'private_answer', content: '只供教师核对的示例说明。', source: '目录本地样本', student: false, tutor: false, teacherDesign: false, version: 2 },
]
function makeDraft(): PreviewDraftDisplay {
  return { id: 'example-draft', courseId: courses[0].id, title: '校园用水观察项目', problem: '怎样用证据解释不同时间的用水差异？', audience: '示例校园环保小组',
    deliverable: '观察报告和可复现的数据分析', choices: '选择观察地点与比较方法', foundation: '读懂表格，解释简单统计', duration: '示例两周',
    goals: [{ id: 'example-g1', domain: 'domain', title: '解释数据差异', evidence: '使用图表与原始记录说明判断' },
      { id: 'example-g2', domain: 'project', title: '规划观察过程', evidence: '保留修订后的计划' },
      { id: 'example-g3', domain: 'ai_collaboration', title: '核验获得的帮助', evidence: '说明采纳与独立核验过程' }],
    milestones: [{ id: 'example-m1', title: '提出比较方案', evidence: '方案与取舍说明' }],
    rubric: [{ id: 'example-r1', criterion: '证据支持判断', description: '区分观察、推断与尚未确认的原因' }],
    helpPolicy: '示例政策：允许讨论概念，作品结论须自行核验。', resourceIds: ['example-resource'], revision: 2, savedAt: 'example-saved' }
}
function makeContent(): LiveContentDisplay {
  const goalRef = { competencyId: 'example-goal', competencyVersion: 1 }
  return { projectTitle: '示例校园用水观察', problem: '怎样用证据解释用水差异？', audience: '示例环保小组', artifact: '报告与数据分析',
    studentBackground: '已接触简单统计', timeConstraints: '示例两周', routes: ['比较不同地点', '比较不同时段'],
    goals: [{ ...goalRef, domain: 'domain', title: '解释数据差异', core: true }],
    tasks: [{ taskId: 'example-task', title: '收集与比较观察数据', goalRefs: [goalRef] }],
    observations: [{ observationId: 'example-observation', description: '解释一项反例与验证过程', goalRefs: [goalRef], taskIds: ['example-task'] }],
    rubricCriteria: [{ criterionId: 'example-criterion', description: '结论有可追溯的依据', goalRefs: [goalRef], observationIds: ['example-observation'] }],
    milestones: [{ milestoneId: 'example-milestone', title: '提交初步比较', taskIds: ['example-task'] }], resources: [{ resourceVersionId: 'example-resource' }],
    helpPolicyVersionId: 'example-policy-v1', checkRuleVersionId: 'example-check-v1', runtimeProfileVersionId: 'example-runtime-v1' }
}
const policy = { description: '示例课程政策：允许概念提示，保留独立解释。', helpAllowed: true }
const workbench = {
  presets: [{ id: 'example-preset', title: '示例已确认范例' }],
  resources: resources.map(item => ({ resourceVersionId: item.id, teacherDesignAllowed: item.teacherDesign,
    material: { kind: item.kind === 'private_answer' ? 'private_answer' as const : 'learning_material' as const, title: item.title, visibility: { student: item.student, tutor: item.tutor } } })),
}
const suggestion: PreviewSuggestionDisplay = { key: 'problem', title: '让问题连接明确情境', before: makeDraft().problem, after: '请用一项反例解释结论适用的边界。' }
const released = { activityVersionId: 'example-activity-v2', sourceRevision: 2, title: '示例固定活动' }
const receipts = [{ assignmentId: 'example-assignment', studentId: members[0].userId, assignmentRevision: 1 }]
function roleProjection(role: LiveRole, empty = false): LivePreviewDisplay {
  return { audience: role, revision: 2, content: makeContent(), materials: empty ? [] : [
    { status: 'available', resourceVersionId: 'example-resource', title: '示例公开材料', text: '本地示例材料正文。' },
    ...(role === 'teacher-validator' ? [{ status: 'available' as const, resourceVersionId: 'example-private', title: '示例教师材料', text: '只供教师视角的示例内容。' }] : [{ status: 'redacted' as const }]),
    { status: 'unavailable' },
  ] }
}

const DemoContext = createContext<(text: string) => void>(() => {})
function LocalLink({ to, children, className }: DesignLinkProps) {
  const report = useContext(DemoContext)
  return <a href={`#example-${encodeURIComponent(to)}`} className={className} onClick={event => { event.preventDefault(); report(`示例跳转：${to}`) }}>{children}</a>
}
function Stage({ children, rail = false }: { children: ReactNode; rail?: boolean }) {
  const [message, setMessage] = useState('')
  return <DemoContext.Provider value={setMessage}><div className="teacher-shell" style={{ display: 'block', width: '100%', height: 'auto', minHeight: 320, padding: 24, overflow: 'visible' }}>
    <p style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 16 }}>合成示例 · 操作仅影响当前预览，不请求业务服务</p>
    <div className="td-page" style={{ maxWidth: rail ? 420 : 1080, margin: '0 auto' }}>{children}</div>
    <output aria-live="polite" style={{ display: 'block', marginTop: 16 }}>{message}</output>
  </div></DemoContext.Provider>
}
function useLocalAction() {
  const [message, setMessage] = useState('')
  return { message, action: (text: string) => () => setMessage(text) }
}
function PrimitiveDemo({ kind, alternate = false }: { kind: 'anchor' | 'preview-field' | 'live-field' | 'choices' | 'checks' | 'repeat' | 'value'; alternate?: boolean }) {
  const [text, setText] = useState('示例值'), [selected, setSelected] = useState(alternate ? ['example-goal', 'missing'] : ['example-goal'])
  const [section, setSection] = useState<PreviewSection>('brief'), [removed, setRemoved] = useState(false)
  return <Stage>
    {kind === 'anchor' && <><DesignAnchor to="#example-anchor-target">跳到本地示例说明</DesignAnchor><p id="example-anchor-target">这里是示例锚点目标。</p></>}
    {kind === 'preview-field' && <PreviewDesignField title="项目标题" required hint="示例必填字段"><input value={text} disabled={alternate} onChange={event => setText(event.target.value)} /></PreviewDesignField>}
    {kind === 'live-field' && <LiveDesignField title="设计说明" hint="展示型说明，不触发保存"><textarea value={text} readOnly={alternate} onChange={event => setText(event.target.value)} /></LiveDesignField>}
    {kind === 'choices' && <><DesignLinkedChoices title="关联目标" options={alternate ? [] : [{ id: 'example-goal', title: '解释示例数据' }, { id: 'example-next', title: '核验结论' }]} value={selected} onChange={setSelected} /><output>当前引用：{selected.join('、') || '无'}</output></>}
    {kind === 'checks' && <><DesignCheckGroup title="阻断项" count={alternate ? 0 : 1} tone="block" empty="没有结构阻断" items={alternate ? [] : [{ title: '补充目标证据', section: 'goals' as const }]} onSelect={setSection} /><output>示例章节：{section}</output></>}
    {kind === 'repeat' && (removed ? <button className="td-btn" onClick={() => setRemoved(false)}>恢复示例条目</button> : <DesignRepeatHeading title="学习目标" index={0} removable={!alternate} onRemove={() => setRemoved(true)} />)}
    {kind === 'value' && <DesignValue value={alternate ? { routes: [], custom: null } : { projectTitle: '示例项目', goals: [{ title: '解释证据', core: true }], custom: '未知字段按原键展示' }} />}
  </Stage>
}
type ChromePart = 'navigation' | 'section-heading' | 'footer' | 'heading' | 'topline'
function ChromeDemo({ live = false, part, alternate = false }: { live?: boolean; part: ChromePart; alternate?: boolean }) {
  const [section, setSection] = useState<PreviewSection>(alternate ? 'support' : 'brief')
  const [dirty, setDirty] = useState(!alternate), { message, action } = useLocalAction()
  const common = { section, setSection }
  return <Stage>
    {part === 'navigation' && (live ? <LiveDesignNavigation {...common} /> : <PreviewDesignNavigation {...common} />)}
    {part === 'section-heading' && <><label>示例章节 <select value={section} onChange={event => setSection(event.target.value as PreviewSection)}>{['brief', 'goals', 'milestones', 'support'].map(id => <option key={id} value={id}>{id}</option>)}</select></label>{live ? <LiveDesignSectionHeading section={section} /> : <PreviewDesignSectionHeading section={section} />}</>}
    {part === 'footer' && (live ? <LiveDesignFooter {...common} locked={alternate} dirty={false} remoteChanged={false} onCheck={action('已触发本地示例检查')} /> : <PreviewDesignFooter {...common} setAssistantTab={action('已切换到本地示例检查')} />)}
    {part === 'heading' && (live ? <LiveDesignHeading content={makeContent()} dirty={dirty} version="v2" busy={alternate ? '示例等待中…' : ''} reloadDisabled={alternate} locked={alternate} remoteChanged={false}
      onReload={() => { setDirty(false); action('已读取本地示例版本')() }} onSave={() => { setDirty(false); action('仅保存到本地示例状态')() }} />
      : <PreviewDesignHeading draft={makeDraft()} dirty={dirty} revisionLabel="v2" preview={!alternate} save={() => setDirty(false)} openPreview={action('已触发示例预览入口')} />)}
    {part === 'topline' && (live ? <LiveDesignTopline base="/example" Link={LocalLink} version="v2" /> : <PreviewDesignTopline base="/example" Link={LocalLink} />)}
    <output>{message || `示例章节：${section}`}</output>
  </Stage>
}
function PreviewSectionDemo({ section, alternate = false }: { section: PreviewSection; alternate?: boolean }) {
  const [draft, setDraft] = useState(() => {
    const value = makeDraft()
    if (alternate && section === 'goals') value.goals = []
    if (!alternate && section === 'milestones') {
      value.milestones.push({ id: 'example-m2', title: '核验反例', evidence: '反例记录' })
      value.rubric.push({ id: 'example-r2', criterion: '解释边界', description: '说明结论的适用范围' })
    }
    return value
  }), sequence = useRef(10)
  const patch = <K extends keyof PreviewDraftDisplay>(key: K, value: PreviewDraftDisplay[K]) => setDraft(current => ({ ...current, [key]: value }))
  return <Stage><fieldset className="td-fields" disabled={alternate && section === 'brief'}>
    {section === 'brief' && <PreviewBriefSection draft={draft} patch={patch} data={{ courses }} onCourseChange={courseId => setDraft(current => ({ ...current, courseId, resourceIds: [] }))} />}
    {section === 'goals' && <PreviewGoalsSection draft={draft} patch={patch} />}
    {section === 'milestones' && <PreviewMilestonesSection draft={draft} patch={patch} uid={() => `example-row-${++sequence.current}`} />}
    {section === 'support' && <PreviewSupportSection draft={draft} patch={patch} courseResources={alternate ? [] : resources} base="/example" Link={LocalLink} />}
  </fieldset><output>本地示例：{draft.title} · {draft.goals.length} 个目标 · {draft.milestones.length} 个里程碑</output></Stage>
}
function LiveSectionDemo({ section, alternate = false }: { section: PreviewSection; alternate?: boolean }) {
  const [content, setContent] = useState(() => {
    const value = makeContent()
    if (alternate && section === 'goals') value.tasks[0].goalRefs.push({ competencyId: 'missing-goal', competencyVersion: 1 })
    if (alternate && section === 'support') value.resources.push({ resourceVersionId: 'missing-resource' })
    if (alternate && section === 'milestones') { value.milestones = []; value.rubricCriteria = [] }
    return value
  })
  const [courseId, setCourseId] = useState(courses[0].id), [presetId, setPresetId] = useState('example-preset'), sequence = useRef(10)
  const patch = <K extends keyof LiveContentDisplay>(key: K, value: LiveContentDisplay[K]) => setContent(current => ({ ...current, [key]: value }))
  const resolveGoalRefs = (refs: typeof content.tasks[number]['goalRefs'], ids: string[]) => ids.flatMap(id => {
    const goal = content.goals.find(item => item.competencyId === id), old = refs.find(item => item.competencyId === id)
    return goal ? [{ competencyId: id, competencyVersion: goal.competencyVersion }] : old ? [old] : []
  })
  const common = { content, patch, uid: () => `example-row-${++sequence.current}`, resolveGoalRefs }
  return <Stage><fieldset className="td-fields">
    {section === 'brief' && <LiveBriefSection content={content} patch={patch} draft={alternate ? { revision: 2 } : undefined} courseId={courseId} presetId={presetId} data={{ courses }} workbench={workbench}
      selectedPreset={{ id: 'example-preset' }} setPresetId={setPresetId} onCourseChange={id => { setCourseId(id); setContent(makeContent()) }} onApplyPreset={() => setContent(makeContent())} />}
    {section === 'goals' && <LiveGoalsSection {...common} changeGoal={(id, next) => patch('goals', content.goals.map(goal => goal.competencyId === id ? { ...goal, ...next } : goal))}
      canRemoveGoal={id => ![...content.tasks, ...content.observations, ...content.rubricCriteria].some(item => item.goalRefs.some(ref => ref.competencyId === id))}
      canRemoveTask={id => !content.observations.some(item => item.taskIds.includes(id)) && !content.milestones.some(item => item.taskIds.includes(id))}
      canRemoveObservation={id => !content.rubricCriteria.some(item => item.observationIds.includes(id))} />}
    {section === 'milestones' && <LiveMilestonesSection {...common} />}
    {section === 'support' && <LiveSupportSection content={content} patch={patch} workbench={alternate ? { ...workbench, resources: [] } : workbench} policy={alternate ? undefined : policy} base="/example" Link={LocalLink} />}
  </fieldset><output>本地示例：{content.goals.length} 个目标 · {content.tasks.length} 个任务 · {content.observations.length} 个观察</output></Stage>
}
function SupportDemo({ mode }: { mode: 'assistant' | 'checks' | 'conflict' | 'readonly' }) {
  const [tab, setTab] = useState<'assistant' | 'checks'>(mode === 'checks' ? 'checks' : 'assistant'), [prompt, setPrompt] = useState('')
  const [shown, setShown] = useState(mode === 'conflict'), { message, action } = useLocalAction()
  return <Stage rail><PreviewDesignSupport preview={mode !== 'readonly'} assistantTab={tab} setAssistantTab={setTab} blocks={[{ title: '补充观察证据', section: 'goals' }]} questions={[]}
    setSection={section => action(`已定位示例章节：${section}`)()} prompt={prompt} setPrompt={setPrompt} suggestion={shown ? suggestion : null} conflicts={mode === 'conflict'} ready={false}
    setModal={action('已触发本地建议对比入口')} showSuggestion={() => setShown(true)} openPreview={action('已触发本地角色预览入口')} /><output>{message}</output></Stage>
}
function ChecksDemo({ mode }: { mode: 'unchecked' | 'blocked' | 'ready' }) {
  const [concerns, setConcerns] = useState<LiveConcernDisplay[]>([]), [checked, setChecked] = useState(mode !== 'unchecked'), [blocked, setBlocked] = useState(mode === 'blocked')
  const { message, action } = useLocalAction()
  return <Stage rail><LiveDesignChecks ready={checked && !blocked} checksCurrent={checked} version="v2" report={checked ? { blocking: blocked ? [{ code: 'missing_link', path: 'tasks.0.goalRefs' }] : [],
    designConcerns: concerns.map(item => ({ status: item.resolution ? 'teacher_recorded' : 'requires_teacher' })) } : null}
    concerns={concerns} concernKinds={[{ code: 'meaning', title: '项目意义', path: 'problem' }, { code: 'rubric_ambiguity', title: '量规歧义', path: 'rubricCriteria' }]}
    locked={false} dirty={false} remoteChanged={false} released={null} draft={{ revision: 2 }} onBlockingSelect={path => action(`定位示例字段：${path}`)()}
    onConcernChange={(code, field, value) => setConcerns(current => {
      const existing = current.find(item => item.code === code) ?? { code, path: 'example', reason: '' }
      return [...current.filter(item => item.code !== code), { ...existing, [field]: value }]
    })} onCheck={() => { setChecked(true); setBlocked(false); action('本地示例检查完成，不代表教学效果')() }} onPreview={action('已触发示例角色核对')} /><output>{message}</output></Stage>
}
function RoleDemo({ live = false, empty = false }: { live?: boolean; empty?: boolean }) {
  const [role, setRole] = useState<LiveRole>('student')
  return <Stage><label>示例角色 <select value={role} onChange={event => setRole(event.target.value as LiveRole)}>
    <option value="student">学生</option><option value="tutor">辅导</option><option value="teacher-validator">教师 / 验证器</option></select></label>
    {live ? <LiveRolePreview preview={roleProjection(role, empty)} courseName={courses[0].title} policyDescription={policy.description} />
      : <PreviewRoleArticle draft={makeDraft()} course={courses[0]} role={role === 'teacher-validator' ? 'teacher' : role} visibleResources={empty ? [] : resources.filter(item => role === 'teacher-validator' || (role === 'student' ? item.student : item.tutor))} />}
  </Stage>
}
function PreviewDialogDemo({ initial }: { initial: 'preview' | 'assign' | 'suggestion' | 'conflict' | 'empty' }) {
  const [modal, setModal] = useState<'preview' | 'assign' | 'suggestion' | null>(initial === 'conflict' ? 'suggestion' : initial === 'empty' ? 'assign' : initial)
  const [draft, setDraft] = useState(makeDraft), [role, setRole] = useState<PreviewRole>('student'), [ack, setAck] = useState(false), [students, setStudents] = useState<string[]>([])
  const dialog = useRef<HTMLDialogElement>(null), { message, action } = useLocalAction()
  useEffect(() => { const node = dialog.current; if (modal && node && !node.open) node.showModal(); else if (!modal && node?.open) node.close() }, [modal])
  useEffect(() => () => { if (dialog.current?.open) dialog.current.close() }, [])
  return <Stage><button className="td-btn" onClick={() => setModal(initial === 'suggestion' || initial === 'conflict' ? 'suggestion' : initial === 'assign' || initial === 'empty' ? 'assign' : 'preview')}>打开原生示例弹窗</button>
    <PreviewDesignDialogs dialog={dialog} modal={modal} setModal={setModal} suggestion={suggestion} draft={draft} conflicts={initial === 'conflict'} preview
      adoptSuggestion={() => { setDraft(current => ({ ...current, problem: suggestion.after })); setModal(null); action('已在本地示例采用建议')() }} role={role} setRole={setRole} revisionLabel="v2" dirty={false} course={courses[0]}
      visibleResources={resources.filter(item => role === 'teacher' || (role === 'student' ? item.student : item.tutor))} acknowledged={ack} setAcknowledged={setAck} ready blocks={[]}
      setAssistantTab={action('返回本地示例检查')} learners={initial === 'empty' ? [] : learners} students={students} setStudents={setStudents} releaseDisabled={!students.length}
      onConfirmPreview={() => { setStudents([]); setModal('assign') }} onRelease={() => { action(`仅在本地示例分配给 ${students.length} 人`)(); setModal(null) }} /><output>{message}</output>
  </Stage>
}
function LiveDialogDemo({ initial }: { initial: 'preview' | 'assign' | 'busy' | 'empty' | 'receipts' }) {
  const [modal, setModal] = useState<'preview' | 'assign' | null>(initial === 'preview' ? 'preview' : 'assign'), [role, setRole] = useState<LiveRole>('student')
  const [visited, setVisited] = useState<LiveRole[]>(['student']), [ack, setAck] = useState(false), [students, setStudents] = useState<string[]>([])
  const [assignments, setAssignments] = useState(initial === 'receipts' ? receipts : []), [busy, setBusy] = useState(initial === 'busy' ? '示例等待中…' : '')
  const dialog = useRef<HTMLDialogElement>(null), { message, action } = useLocalAction()
  useEffect(() => { const node = dialog.current; if (modal && node && !node.open) node.showModal(); else if (!modal && node?.open) node.close() }, [modal])
  useEffect(() => { if (!busy) return; const timer = window.setTimeout(() => setBusy(''), 1800); return () => window.clearTimeout(timer) }, [busy])
  useEffect(() => () => { if (dialog.current?.open) dialog.current.close() }, [])
  return <Stage><button className="td-btn" onClick={() => setModal(initial === 'preview' ? 'preview' : 'assign')}>打开原生示例弹窗</button>
    <LiveDesignDialogs dialog={dialog} modal={modal} setModal={setModal} busy={busy} error="" currentPreview={roleProjection(role)} role={role}
      onRoleSelect={value => { setRole(value); setVisited(current => current.includes(value) ? current : [...current, value]) }} course={courses[0]} courseId={courses[0].id} policy={policy}
      acknowledged={ack} setAcknowledged={setAck} visitedRoles={visited} version="v2" released={released} members={initial === 'empty' ? [] : members} students={students} setStudents={setStudents}
      assignments={assignments} locked={Boolean(busy)} ready onRelease={() => { setStudents([]); setModal('assign'); action('仅在本地示例确认版本')() }}
      onAssign={() => { setAssignments(students.map((id, index) => ({ assignmentId: `example-receipt-${index}`, studentId: id, assignmentRevision: 1 }))); action('已生成本地示例回执')() }} /><output>{message}</output>
  </Stage>
}
function AgentDemo({ mode }: { mode: 'request' | 'running' | 'proposal' | 'stale' | 'rubric' | 'error' }) {
  const candidateExample = mode === 'proposal' || mode === 'stale'
  const [designMode, setDesignMode] = useState<DesignAgentMode>(candidateExample ? 'candidates' : mode === 'rubric' ? 'rubric_trial' : 'patch'), [request, setRequest] = useState('请帮助检查示例项目的问题是否清楚。')
  const [fields, setFields] = useState<('problem' | 'goals')[]>(['problem']), [selected, setSelected] = useState<string[]>([]), [samples, setSamples] = useState<string[]>([])
  const [candidate, setCandidate] = useState<number>(), [restoreId, setRestoreId] = useState(''), [status, setStatus] = useState(mode), [adopted, setAdopted] = useState(false)
  const { message, action } = useLocalAction()
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => { const details = panel.current?.querySelector('details'); if (details) details.open = true }, [])
  const hasProposal = ['proposal', 'stale', 'rubric'].includes(status)
  const proposal: DesignAgentViewProps['proposal'] = hasProposal ? { baseRevision: candidateExample ? 0 : 2, body: designMode === 'rubric_trial' ? { kind: 'rubric_trial', ambiguities: ['示例量规应补充反例依据'] }
    : designMode === 'candidates' ? { kind: 'candidates', candidates: [{ projectTitle: '本地示例候选 A', problem: '请解释数据差异' }, { projectTitle: '本地示例候选 B', problem: '请核验边界情形' }] }
      : { kind: designMode, problem: '请用本地示例证据解释结论。' },
    rationale: '用于演示对照与明确采用。', affectedReferences: ['example-resource'], diff: [{ path: 'problem', before: '旧示例问题', after: '新示例问题' }] } : null
  return <Stage><div ref={panel}><DesignAgentView hasDraft={!candidateExample} dirty={false} blocked={adopted} active={status === 'running'} disabled={false} busy={false} mode={designMode} setMode={setDesignMode}
    request={request} setRequest={setRequest} fields={fields} setFields={setFields} availableFields={['problem', 'goals']} selected={selected} setSelected={setSelected} samples={samples} setSamples={setSamples}
    paragraphs={[{ paragraphId: 'example-p1', title: '示例获准材料', ordinal: 0, private: false, text: '保留观察数据和反例。' }]} error={status === 'error' ? '示例错误：原任务结果尚未确认。' : ''}
    canRecover={status === 'error'} run={status === 'request' ? null : { jobId: 'example-job' }} job={status === 'request' ? null : { status: status === 'running' ? 'running' : status === 'error' ? 'outcome_unknown' : 'succeeded' }}
    restoreId={restoreId} setRestoreId={setRestoreId} proposal={proposal} candidate={candidate} setCandidate={setCandidate} stale={status === 'stale'} canAdopt={hasProposal && status !== 'stale' && proposal?.body.kind !== 'rubric_trial' && (proposal?.body.kind !== 'candidates' || candidate !== undefined) && !adopted}
    onGenerate={() => { setStatus('proposal'); action('仅生成本地预置候选，未调用模型')() }} onCancel={() => { setStatus('request'); action('已取消本地示例等待')() }}
    onAdopt={() => { setAdopted(true); action('仅在当前示例采用所选候选')() }} onReload={() => { setStatus('proposal'); action('已读取本地示例候选')() }} onRestore={() => { setStatus('proposal'); action(`已恢复本地示例任务：${restoreId}`)() }} /></div><output>{message}</output>
  </Stage>
}
function NoticeDemo({ kind, alternate = false }: { kind: 'unavailable' | 'preview-source' | 'readonly' | 'live-notices' | 'follow-heading' | 'follow-actions' | 'follow-error' | 'follow-source' | 'release'; alternate?: boolean }) {
  const [error, setError] = useState(true), [shown, setShown] = useState(true), { message, action } = useLocalAction()
  return <Stage>
    {kind === 'unavailable' && (error ? <DesignUnavailable title={alternate ? '正在读取项目设计…' : '示例设计无法读取'} description="本地示例状态；点击重新读取可恢复。" projectsPath="/example/projects" Link={LocalLink} onRefresh={alternate ? undefined : () => setError(false)} /> : <p role="status">已恢复本地示例。</p>)}
    {kind === 'preview-source' && <PreviewDesignSource source={{ id: 'example-lin', name: '示例小林', activityTitle: '示例原项目' }} base="/example" Link={LocalLink} />}
    {kind === 'readonly' && <PreviewDesignReadOnlyNotice />}
    {kind === 'live-notices' && <LiveDesignNotices source={{ blueprintId: 'example-source', revision: 1 }} base="/example" Link={LocalLink} error={alternate ? '示例读取失败' : ''} remoteChanged={!alternate} generationChanged={alternate} />}
    {kind === 'follow-heading' && <FollowUpDesignHeading base="/example" courseName={courses[0].title} Link={LocalLink} />}
    {kind === 'follow-actions' && <FollowUpDesignActions base="/example" busy={alternate} onRefresh={action('已读取本地示例来源')} Link={LocalLink} />}
    {kind === 'follow-error' && (shown ? <><FollowUpDesignError error="示例复制结果未知。" /><button className="td-btn" onClick={() => setShown(false)}>清除本地示例错误</button></> : <p role="status">本地示例错误已清除</p>)}
    {kind === 'follow-source' && <FollowUpDesignSource activity={{ activityVersionId: 'example-activity', sourceRevision: 1, content: { content: makeContent() } }}
      source={alternate ? undefined : { blueprintId: 'example-source', revision: 2, content: makeContent() }} locked={false} busy={false} onCopy={action('仅在本地示例复制草稿，未发送命令')} />}
    {kind === 'release' && <LiveReleaseSummary released={released} locked={false} onSelectStudents={action('已触发本地学生选择入口')} assignments={alternate ? [] : receipts} members={members} />}
    <output>{message}</output>
  </Stage>
}

const importPath = '@xunjie/ui/teacher-design'
const exampleSource = 'apps/web/src/ui-catalog/examples/teacher-design.tsx'
const dependencies = ['@xunjie/ui/styles.css', '@xunjie/ui/styles/teacher/teacher.css', '@xunjie/ui/styles/teacher/design.css', '@xunjie/ui/styles/teacher/live-design.css', '@xunjie/ui/styles/teacher/design-agent.css', '本地受控示例；不接 TeacherContext、router、store 或业务服务']
function state(id: string, name: string, component: CatalogState['component'], height = 700): CatalogState { return { id, name, component, viewport: 'wide', height } }
function entry(name: string, source: string, description: string, props: string[], states: CatalogState[]): CatalogEntry {
  return { id: name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase(), name, description, importPath,
    source: `packages/ui/src/teacher-design/${source}.tsx`, exampleSource, props, dependencies, states }
}
const primitiveStates = (kind: Parameters<typeof PrimitiveDemo>[0]['kind']) => [state('interactive', '交互', () => <PrimitiveDemo kind={kind} />), state('alternate', '空态 / 受限', () => <PrimitiveDemo kind={kind} alternate />)]
const chromeStates = (part: ChromePart, live = false) => [state('interactive', '交互', () => <ChromeDemo part={part} live={live} />), state('alternate', '末节 / 已保存 / 受限', () => <ChromeDemo part={part} live={live} alternate />)]
const sectionStates = (section: PreviewSection, live = false) => [state('editable', '本地编辑', () => live ? <LiveSectionDemo section={section} /> : <PreviewSectionDemo section={section} />),
  state('alternate', live ? { brief: '已存草稿限制', goals: '失效目标引用', milestones: '空列表 / 添加', support: '缺失材料与政策' }[section]
    : { brief: '只读字段', goals: '待填写目标', milestones: '最少一项限制', support: '无课程材料' }[section],
  () => live ? <LiveSectionDemo section={section} alternate /> : <PreviewSectionDemo section={section} alternate />)]

export const teacherDesignEntries: CatalogEntry[] = [
  entry('DesignAnchor', 'controls', '普通锚点，不依赖路由。', ['to, className?, children'], [state('anchor', '页内锚点', () => <PrimitiveDemo kind="anchor" />)]),
  entry('PreviewDesignField', 'controls', '预览字段与必填标记。', ['title, hint?, required?, children'], primitiveStates('preview-field')),
  entry('LiveDesignField', 'controls', '真实设计字段展示。', ['title, hint?, children'], primitiveStates('live-field')),
  entry('DesignLinkedChoices', 'controls', '关联勾选、空列表和失效引用。', ['title, options, value, onChange'], primitiveStates('choices')),
  entry('DesignCheckGroup', 'controls', '检查条目定位与空态。', ['title, count, tone, empty, items, onSelect'], primitiveStates('checks')),
  entry('DesignRepeatHeading', 'controls', '条目移除入口及受限说明。', ['title, index, removable, onRemove'], primitiveStates('repeat')),
  entry('DesignValue', 'DesignValue', '递归展示建议数据及空值。', ['value: unknown'], primitiveStates('value')),
  entry('PreviewDesignNavigation', 'DesignChrome', '预览章节选择。', ['section, setSection'], chromeStates('navigation')),
  entry('LiveDesignNavigation', 'DesignChrome', '真实设计章节选择。', ['section, setSection'], chromeStates('navigation', true)),
  entry('PreviewDesignSectionHeading', 'DesignChrome', '预览章节标题与计数。', ['section'], chromeStates('section-heading')),
  entry('LiveDesignSectionHeading', 'DesignChrome', '真实设计章节标题。', ['section'], chromeStates('section-heading', true)),
  entry('PreviewDesignFooter', 'DesignChrome', '预览前后章节和检查入口。', ['section, setSection, setAssistantTab'], chromeStates('footer')),
  entry('LiveDesignFooter', 'DesignChrome', '真实设计章节和检查操作。', ['section, setSection, locked, dirty, remoteChanged, onCheck'], chromeStates('footer', true)),
  entry('PreviewDesignHeading', 'DesignChrome', '预览标题、保存与分配入口。', ['draft, dirty, revisionLabel, preview, save, openPreview'], chromeStates('heading')),
  entry('LiveDesignHeading', 'DesignChrome', '真实设计保存状态与操作。', ['content, dirty, version, busy, reloadDisabled, locked, remoteChanged, onReload, onSave'], chromeStates('heading', true)),
  entry('PreviewDesignTopline', 'DesignChrome', '预览返回链接与草稿标记。', ['base, Link?'], [state('local-link', '本地链接', () => <ChromeDemo part="topline" />)]),
  entry('LiveDesignTopline', 'DesignChrome', '真实设计返回链接与版本。', ['base, Link?, version'], [state('local-link', '本地链接', () => <ChromeDemo part="topline" live />)]),
  entry('PreviewBriefSection', 'PreviewSections', '预览课程与简报字段。', ['draft, patch, data.courses, onCourseChange'], sectionStates('brief')),
  entry('PreviewGoalsSection', 'PreviewSections', '三条能力线与证据。', ['draft, patch'], sectionStates('goals')),
  entry('PreviewMilestonesSection', 'PreviewSections', '预览里程碑与量规增删。', ['draft, patch, uid'], sectionStates('milestones')),
  entry('PreviewSupportSection', 'PreviewSections', '帮助政策与材料用途。', ['draft, patch, courseResources, base, Link?'], sectionStates('support')),
  entry('LiveBriefSection', 'LiveSections', '真实设计结构的课程范例与简报。', ['content, patch, draft?, courseId, presetId, data, workbench', 'selectedPreset, setPresetId, onCourseChange, onApplyPreset'], sectionStates('brief', true)),
  entry('LiveGoalsSection', 'LiveSections', '目标、任务、观察和关联编辑。', ['content, patch, uid, changeGoal, resolveGoalRefs', 'canRemoveGoal, canRemoveTask, canRemoveObservation'], sectionStates('goals', true)),
  entry('LiveMilestonesSection', 'LiveSections', '里程碑、量规与证据关联。', ['content, patch, uid, resolveGoalRefs'], sectionStates('milestones', true)),
  entry('LiveSupportSection', 'LiveSections', '政策与材料版本的权限展示。', ['content, patch, workbench, policy?, base, Link?'], sectionStates('support', true)),
  entry('PreviewDesignSupport', 'PreviewDesignSupport', '固定示例建议、检查与键盘 tabs。', ['preview, assistantTab, setAssistantTab, blocks, questions, setSection', 'prompt, setPrompt, suggestion, conflicts, ready, setModal, showSuggestion, openPreview'],
    ['assistant', 'checks', 'conflict', 'readonly'].map(mode => state(mode, mode === 'assistant' ? '助手' : mode === 'checks' ? '检查' : mode === 'conflict' ? '建议冲突' : '只读', () => <SupportDemo mode={mode as Parameters<typeof SupportDemo>[0]['mode']} />))),
  entry('LiveDesignChecks', 'LiveDesignChecks', '结构阻断、教师疑点与待验证。', ['ready, checksCurrent, version, report, concerns, concernKinds', 'locked, dirty, remoteChanged, released, draft, onBlockingSelect, onConcernChange, onCheck, onPreview'],
    (['unchecked', 'blocked', 'ready'] as const).map(mode => state(mode, mode === 'unchecked' ? '尚未检查' : mode === 'blocked' ? '有阻断' : '结构已齐备', () => <ChecksDemo mode={mode} />))),
  entry('PreviewRoleArticle', 'PreviewRoleArticle', '合成预览的角色可见内容。', ['draft, course?, role, visibleResources'], [state('roles', '角色与材料', () => <RoleDemo />), state('empty', '无材料', () => <RoleDemo empty />)]),
  entry('LiveRolePreview', 'LiveRolePreview', '投影结构及可见 / 隐藏 / 不可用材料。', ['preview, courseName, policyDescription?'], [state('roles', '三种角色投影', () => <RoleDemo live />), state('empty', '无材料', () => <RoleDemo live empty />)]),
  entry('PreviewDesignDialogs', 'PreviewDesignDialogs', '原生 dialog：建议对比、角色核对与合成分配。', ['dialog ref, modal, setModal, suggestion, draft, conflicts, preview', 'role, setRole, visibleResources, acknowledged, setAcknowledged, ready', 'learners, students, setStudents, releaseDisabled, onConfirmPreview, onRelease'],
    (['preview', 'suggestion', 'conflict', 'assign', 'empty'] as const).map(initial => state(initial, { preview: '角色核对', suggestion: '建议对比', conflict: '建议冲突', assign: '合成学生选择', empty: '无合成学生' }[initial], () => <PreviewDialogDemo initial={initial} />, 800))),
  entry('LiveDesignDialogs', 'LiveDesignDialogs', '原生 dialog：三角色核对、课程学生与本地示例回执。', ['dialog ref, modal, setModal, busy, error, currentPreview, role, onRoleSelect', 'acknowledged, setAcknowledged, visitedRoles, version, released, members', 'students, setStudents, assignments, locked, ready, onRelease, onAssign'],
    (['preview', 'assign', 'busy', 'empty', 'receipts'] as const).map(initial => state(initial, { preview: '三角色核对', assign: '课程学生选择', busy: '等待约两秒后解除', empty: '无课程成员', receipts: '本地示例回执' }[initial], () => <LiveDialogDemo initial={initial} />, 800))),
  entry('LiveReleaseSummary', 'LiveReleaseSummary', '固定活动与分配回执。', ['released, locked, onSelectStudents, assignments, members'], [state('receipts', '有回执', () => <NoticeDemo kind="release" />), state('empty', '尚未分配', () => <NoticeDemo kind="release" alternate />)]),
  entry('FollowUpDesignSource', 'FollowUpDesignSource', '固定活动和当前来源草稿的版本区别。', ['activity, source?, locked, busy, onCopy'], [state('source', '来源版本已变化', () => <NoticeDemo kind="follow-source" />), state('unavailable', '来源不可读取', () => <NoticeDemo kind="follow-source" alternate />)]),
  entry('DesignUnavailable', 'DesignEntryStates', '无法打开与可重试空态。', ['title, description, projectsPath, onRefresh?, Link?'], [state('retry', '失败 / 本地重试', () => <NoticeDemo kind="unavailable" />), state('loading', '读取中', () => <NoticeDemo kind="unavailable" alternate />)]),
  entry('PreviewDesignSource', 'DesignEntryStates', '合成后续设计来源说明。', ['source, base, Link?'], [state('source', '示例来源', () => <NoticeDemo kind="preview-source" />)]),
  entry('PreviewDesignReadOnlyNotice', 'DesignEntryStates', '原只读与待接线语义。', ['无属性'], [state('readonly', '只读说明', () => <NoticeDemo kind="readonly" />)]),
  entry('LiveDesignNotices', 'DesignEntryStates', '来源、服务错误与版本 / 代际变化。', ['source?, base, Link?, error, remoteChanged, generationChanged'], [state('remote-change', '远端版本变化', () => <NoticeDemo kind="live-notices" />), state('generation-error', '恢复代际变化 / 错误', () => <NoticeDemo kind="live-notices" alternate />)]),
  entry('FollowUpDesignHeading', 'DesignEntryStates', '后续项目页头及返回链接。', ['base, courseName, Link?'], [state('heading', '示例页头', () => <NoticeDemo kind="follow-heading" />)]),
  entry('FollowUpDesignActions', 'DesignEntryStates', '来源刷新和返回操作。', ['base, busy, onRefresh, Link?'], [state('ready', '可操作', () => <NoticeDemo kind="follow-actions" />), state('busy', '刷新受限', () => <NoticeDemo kind="follow-actions" alternate />)]),
  entry('FollowUpDesignError', 'DesignEntryStates', '保留原请求的失败说明。', ['error'], [state('error', '结果未知', () => <NoticeDemo kind="follow-error" />)]),
  entry('DesignAgentView', 'DesignAgentView', '获准段落、任务恢复、候选选择、差异与显式采用。', ['mode, request, fields, selected, samples, paragraphs 与对应 setter', 'hasDraft, dirty, blocked, active, disabled, busy, error, canRecover', 'run, job, restoreId, proposal, candidate, stale, canAdopt 与操作回调'],
    (['request', 'running', 'proposal', 'stale', 'rubric', 'error'] as const).map(mode => state(mode, { request: '请求表单', running: '任务进行中', proposal: '候选与差异', stale: '候选已过时', rubric: '量规试评', error: '原请求结果未知' }[mode], () => <AgentDemo mode={mode} />, 850))),
]
