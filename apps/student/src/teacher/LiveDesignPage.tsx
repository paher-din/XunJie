import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { Icon, IconText } from '../icons'
import { useSession } from '../components/SessionEntry'
import { useTeacher } from './context'
import { readBlueprintPreview, saveBlueprint, teacherCommand, teacherGet } from './backend'
import type { ActivityView, BlueprintContent, BlueprintDraft, BlueprintPreview, DesignCheckReport, DesignResult, GoalRef, TeacherConcern, TeacherWorkbench } from './wire'
import './design.css'
import './live-design.css'

const sections = [
  { id: 'brief', title: '项目简报', subtitle: '从已确认的课程范例开始', icon: 'file-text' },
  { id: 'goals', title: '目标与证据', subtitle: '保留目标、任务与观察之间的联系', icon: 'route' },
  { id: 'milestones', title: '里程碑与量规', subtitle: '让评价回到具体表现', icon: 'checklist' },
  { id: 'support', title: '帮助与资源', subtitle: '核对帮助政策与材料范围', icon: 'book-2' },
] as const
type Section = typeof sections[number]['id']
type Role = BlueprintPreview['audience']
type Goal = BlueprintContent['goals'][number]
const roles: { id: Role; title: string }[] = [{ id: 'student', title: '学生视角' }, { id: 'tutor', title: '辅导视角' }, { id: 'teacher-validator', title: '教师 / 验证器' }]
const domains: { id: Goal['domain']; title: string }[] = [{ id: 'domain', title: '学科能力' }, { id: 'project', title: '项目能力' }, { id: 'ai_collaboration', title: 'AI 协作能力' }]
const concernKinds: { code: TeacherConcern['code']; title: string; path: string }[] = [
  { code: 'meaning', title: '问题意义', path: 'problem' }, { code: 'difficulty', title: '难度与先备', path: 'studentBackground' },
  { code: 'time', title: '时间安排', path: 'timeConstraints' }, { code: 'solution_space', title: '解法空间', path: 'routes' },
  { code: 'rubric_ambiguity', title: '量规歧义', path: 'rubricCriteria' },
]
const blockingNames: Record<string, string> = {
  missing_field: '内容尚未补齐', missing_domain: '缺少能力线', missing_goal_observation: '核心目标缺少观察安排',
  missing_link: '缺少关联', duplicate_reference: '引用重复', invalid_reference: '引用已失效', inconsistent_goal_link: '目标关联不一致',
  unavailable_resource: '材料版本不可用', forbidden_resource: '材料用途权限不允许', missing_version: '缺少已确认的政策或规则', runtime_not_ready: '执行环境未就绪',
}
interface Released { activityVersionId: string; sourceRevision: number; activityControlRevision: number; title: string }
interface ReleaseResult { activityVersionId: string; sourceRevision: number; activityControlRevision: number; checks: DesignCheckReport; unverified: DesignCheckReport['unverified'] }
interface AssignmentResult { assignments: { assignmentId: string; studentId: string; activityVersionId: string; assignmentRevision: number; status: 'active' | 'paused' }[] }
const uid = () => crypto.randomUUID()
const encoded = encodeURIComponent
const fingerprint = (value: unknown) => JSON.stringify(value)
const emptyContent = (): BlueprintContent => ({ routes: [], goals: [], tasks: [], observations: [], rubricCriteria: [], milestones: [], resources: [] })
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请核对当前版本后重试。'
const goalRef = (goal: Goal): GoalRef => ({ competencyId: goal.competencyId, competencyVersion: goal.competencyVersion })

function Field({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return <label className="td-field"><span className="td-field-title">{title}</span>{children}{hint && <span className="td-hint">{hint}</span>}</label>
}
function LinkedChoices({ title, options, value, onChange }: { title: string; options: { id: string; title: string }[]; value: string[]; onChange: (value: string[]) => void }) {
  return <fieldset className="tld-links"><legend>{title}</legend>{options.length ? options.map(option => <label key={option.id}><input type="checkbox" checked={value.includes(option.id)} onChange={event => onChange(event.target.checked ? [...value, option.id] : value.filter(id => id !== option.id))} /><span>{option.title || '尚未命名'}</span></label>) : <p className="td-hint">先在前面的章节添加对应内容。</p>}{value.filter(id => !options.some(option => option.id === id)).map(id => <label className="tld-invalid-link" key={id}><input type="checkbox" checked onChange={() => onChange(value.filter(valueId => valueId !== id))} /><span>失效引用：{id}</span></label>)}</fieldset>
}
function repeatedTitle(title: string, index: number, removable: boolean, onRemove: () => void) {
  return <div className="td-repeat-heading"><span className="td-mini-index">{String(index + 1).padStart(2, '0')}</span><strong>{title}</strong><button type="button" className="td-icon-btn" disabled={!removable} title={removable ? '移除此项' : '请先取消其他条目对此项的关联'} aria-label={`移除${title} ${index + 1}`} onClick={onRemove}><Icon name="close" /></button></div>
}

export default function LiveDesignPage() {
  const workspace = useTeacher()
  const { draftId = 'new' } = useParams<{ draftId: string }>()
  const [search] = useSearchParams()
  const location = useLocation()
  const workbenches = workspace.data.workbenches ?? []
  const savedReceipt = (location.state as { teacherSavedDraft?: BlueprintDraft } | null)?.teacherSavedDraft
  const original = workbenches.flatMap(w => w.drafts).find(draft => draft.blueprintId === draftId)
    ?? (savedReceipt?.blueprintId === draftId && workbenches.some(w => w.courseId === savedReceipt.courseId) ? savedReceipt : undefined)
  const fromActivityId = draftId === 'new' ? search.get('from') : null
  const sourceWorkbench = fromActivityId ? workbenches.find(w => w.activities.some(activity => activity.activityVersionId === fromActivityId)) : undefined
  const sourceActivity = sourceWorkbench?.activities.find(activity => activity.activityVersionId === fromActivityId)
  const requestedCourse = search.get('course') || workspace.courseId
  const initialCourseId = original?.courseId ?? workbenches.find(w => w.courseId === requestedCourse)?.courseId ?? workbenches[0]?.courseId ?? ''
  if (!workbenches.length || (draftId !== 'new' && !original)) return <div className="td-empty"><Icon name="folder-search" size={36} /><h1>{workspace.loading ? '正在读取项目设计…' : '暂时无法打开这份设计'}</h1><p>{workspace.error || '请重新读取任教课程，或从项目列表打开已有草稿。'}</p><button type="button" className="td-btn" onClick={workspace.refresh}>重新读取</button><Link className="td-btn" to={`${workspace.base}/projects`}>返回项目与活动</Link></div>
  if (fromActivityId) {
    if (!sourceWorkbench || !sourceActivity || (search.get('course') && search.get('course') !== sourceWorkbench.courseId)) return <div className="td-empty"><Icon name="folder-search" size={36} /><h1>无法读取后续项目的来源活动</h1><p>来源活动须属于当前账号的任教课程。请重新读取后，从学生审阅或固定活动重新打开。</p><button type="button" className="td-btn" onClick={workspace.refresh}>重新读取</button><Link className="td-btn" to={`${workspace.base}/projects`}>返回项目与活动</Link></div>
    return <CopyActivityDesign key={sourceActivity.activityVersionId} activity={sourceActivity} workbench={sourceWorkbench} />
  }
  return <LiveDesignEditor key={`${draftId}:${initialCourseId}`} initial={original} initialCourseId={initialCourseId} />
}

function CopyActivityDesign({ activity, workbench }: { activity: ActivityView; workbench: TeacherWorkbench }) {
  const workspace = useTeacher()
  const session = useSession()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const account = session.session?.userId ?? ''
  const source = workbench.drafts.find(draft => draft.blueprintId === activity.sourceBlueprintId)
  const courseName = workspace.data.courses.find(course => course.id === workbench.courseId)?.title ?? workbench.courseId
  const locked = busy || !!workspace.pendingCommand || !account || !source || workspace.loading || !!workspace.error
  async function copy() {
    if (locked || !source) return
    setBusy(true); setError('')
    try {
      const result = await teacherCommand<DesignResult>(account, 'POST', `/courses/${encoded(workbench.courseId)}/blueprints`, {
        mode: 'copy', recoveryGeneration: workbench.recoveryGeneration,
        sourceBlueprintId: source.blueprintId, expectedSourceRevision: source.revision,
      })
      if (result.kind !== 'draft' || result.draft.courseId !== workbench.courseId || result.draft.blueprintId === source.blueprintId
        || result.draft.source?.courseId !== workbench.courseId || result.draft.source.blueprintId !== source.blueprintId || result.draft.source.revision !== source.revision) throw new Error('复制回执的来源关联不完整，请核对原操作后重新读取。')
      workspace.refresh(); workspace.notify(`已复制为独立后续项目，来源 v${source.revision} 保留。`)
      navigate(`${workspace.base}/design/${encoded(result.draft.blueprintId)}`, { replace: true, state: { teacherSavedDraft: result.draft } })
    } catch (cause) { setError(errorText(cause)) }
    finally { setBusy(false) }
  }
  return <div className="td-page tld-page"><div className="td-topline"><Link className="td-back" to={`${workspace.base}/projects`}>项目与活动</Link><span>创建后续项目</span></div><header className="td-heading"><div><p className="td-eyebrow">FOLLOW-UP PROJECT</p><h1>从已有项目，设计下一步</h1><p>{courseName} · 保留来源，独立修订目标与活动安排。</p></div></header>
    {error && <div className="td-notice tld-error" role="alert">{error} 若结果未知，请先核对原教师操作。</div>}
    <section className="tld-release"><div><span className="td-draft-tag">固定活动 · v{activity.sourceRevision ?? '未知'}</span><h2>{activity.content.content.projectTitle || activity.activityVersionId}</h2><p>{activity.content.content.problem}</p><p className="tld-id">{activity.activityVersionId}</p></div></section>
    {source ? <section className="tld-release"><div><span className="td-draft-tag">复制来源 · 当前保存 v{source.revision}</span><h2>{source.content.projectTitle || '尚未填写标题'}</h2><p>{source.content.problem}</p><p className="tld-id">{source.blueprintId}</p><p>{activity.sourceRevision !== source.revision ? `该活动固定自来源草稿 v${activity.sourceRevision ?? '未知'}；来源草稿现为 v${source.revision}。本次复制当前保存的 v${source.revision}，包含期间的设计调整。` : '复制当前保存的来源蓝图，保留目标、任务、观察、量规、材料及课程配置的关联。'}</p><p>点击后创建一份独立草稿，再按反馈修改、检查、确认与分配。原活动和学生已有尝试保持原版本。</p></div><button type="button" className="td-btn td-btn-primary" disabled={locked} onClick={() => { void copy() }}>{busy ? '正在复制…' : '复制为后续项目'}</button></section> : <div className="td-notice" role="status">该活动未返回可读取的来源蓝图，当前无法保留正式复制关系。请重新读取工作台，或联系课程负责人核对来源。</div>}
    <div className="td-heading-actions tld-follow-up-actions"><button type="button" className="td-btn" disabled={busy} onClick={workspace.refresh}>重新读取来源版本</button><Link className="td-btn" to={`${workspace.base}/projects`}>返回项目与活动</Link></div>
  </div>
}

function LiveDesignEditor({ initial, initialCourseId }: { initial?: BlueprintDraft; initialCourseId: string }) {
  const workspace = useTeacher()
  const { data, base, notify } = workspace
  const session = useSession()
  const account = session.session?.userId ?? ''
  const navigate = useNavigate()
  const workbenches = data.workbenches ?? []
  const initialWorkbench = workbenches.find(w => w.courseId === initialCourseId)!
  const firstPreset = initialWorkbench.presets[0]
  const [courseId, setCourseId] = useState(initialCourseId)
  const [generation, setGeneration] = useState(initialWorkbench.recoveryGeneration)
  const [presetId, setPresetId] = useState(firstPreset?.id ?? '')
  const [draft, setDraft] = useState<BlueprintDraft | undefined>(initial)
  const [content, setContent] = useState<BlueprintContent>(() => structuredClone(initial?.content ?? firstPreset?.content ?? emptyContent()))
  const [baseline, setBaseline] = useState<BlueprintContent>(() => structuredClone(initial?.content ?? firstPreset?.content ?? emptyContent()))
  const [section, setSection] = useState<Section>('brief')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [report, setReport] = useState<DesignCheckReport | null>(null)
  const [concerns, setConcerns] = useState<TeacherConcern[]>([])
  const [checkedConcerns, setCheckedConcerns] = useState('')
  const [previews, setPreviews] = useState<Partial<Record<Role, BlueprintPreview>>>({})
  const [role, setRole] = useState<Role>('student')
  const [visitedRoles, setVisitedRoles] = useState<Role[]>([])
  const [acknowledged, setAcknowledged] = useState(false)
  const [modal, setModal] = useState<'preview' | 'assign' | null>(null)
  const [students, setStudents] = useState<string[]>([])
  const [assignments, setAssignments] = useState<AssignmentResult['assignments']>([])
  const [released, setReleased] = useState<Released | null>(() => {
    const existing = initial ? initialWorkbench.activities.find(a => a.sourceBlueprintId === initial.blueprintId && a.sourceRevision === initial.revision) : undefined
    return existing ? { activityVersionId: existing.activityVersionId, sourceRevision: existing.sourceRevision!, activityControlRevision: existing.activityControlRevision, title: existing.content.content.projectTitle ?? existing.activityVersionId } : null
  })
  const dialog = useRef<HTMLDialogElement>(null)
  const workbench = workbenches.find(w => w.courseId === courseId)!
  const course = data.courses.find(c => c.id === courseId)
  const selectedPreset = workbench.presets.find(p => p.id === presetId)
  const policy = workbench.presets.find(p => p.helpPolicy.versionId === content.helpPolicyVersionId)?.helpPolicy
  const dirty = !draft || fingerprint(content) !== fingerprint(draft.content)
  const checksCurrent = !!draft && !!report && report.blueprintId === draft.blueprintId && report.revision === draft.revision && !dirty && checkedConcerns === fingerprint(concerns)
  const ready = checksCurrent && report.blocking.length === 0 && report.designConcerns.every(concern => concern.status === 'teacher_recorded')
  const locked = !!busy || !!workspace.pendingCommand || !account || workspace.loading || !!workspace.error
  const version = draft ? `v${draft.revision}` : '尚未保存'
  const remoteDraft = workbench.drafts.find(d => d.blueprintId === draft?.blueprintId)
  const remoteChanged = !!draft && !!remoteDraft && remoteDraft.revision > draft.revision
  const generationChanged = generation !== workbench.recoveryGeneration
  useEffect(() => {
    const node = dialog.current
    if (!node) return
    if (modal && !node.open) node.showModal()
    else if (!modal && node.open) node.close()
  }, [modal])

  async function run(label: string, action: () => Promise<void>, readOnly = false) {
    if (locked && (!readOnly || !!busy || !!workspace.pendingCommand || !account)) return
    setBusy(label); setError('')
    try { await action() } catch (cause) { setError(errorText(cause)) }
    finally { setBusy('') }
  }
  function change(next: BlueprintContent) {
    setContent(next); setAcknowledged(false); setPreviews({}); setVisitedRoles([])
  }
  function patch<K extends keyof BlueprintContent>(key: K, value: BlueprintContent[K]) { change({ ...content, [key]: value }) }
  function changeGoal(id: string, patch: Partial<Goal>) {
    const known = [...workbench.drafts.map(d => d.content), ...workbench.presets.map(p => p.content), ...workbench.activities.map(a => a.content.content)]
      .flatMap(c => c.goals).filter(g => g.competencyId === id).reduce((max, goal) => Math.max(max, goal.competencyVersion), 0)
    const before = baseline.goals.find(goal => goal.competencyId === id)
    const goals = content.goals.map(goal => {
      if (goal.competencyId !== id) return goal
      const next = { ...goal, ...patch }
      if (before) next.competencyVersion = next.title === before.title && next.domain === before.domain ? before.competencyVersion : Math.max(before.competencyVersion, known) + 1
      return next
    })
    const goal = goals.find(item => item.competencyId === id)!
    const relink = (refs: GoalRef[]) => refs.map(ref => ref.competencyId === id ? goalRef(goal) : ref)
    change({ ...content, goals, tasks: content.tasks.map(t => ({ ...t, goalRefs: relink(t.goalRefs) })), observations: content.observations.map(o => ({ ...o, goalRefs: relink(o.goalRefs) })), rubricCriteria: content.rubricCriteria.map(r => ({ ...r, goalRefs: relink(r.goalRefs) })) })
  }
  const linkedGoals = (refs: GoalRef[], onChange: (value: GoalRef[]) => void) => <LinkedChoices title="关联目标" options={content.goals.map(g => ({ id: g.competencyId, title: `${domains.find(d => d.id === g.domain)?.title} · ${g.title || '目标待补充'}` }))} value={refs.map(g => g.competencyId)} onChange={ids => onChange(ids.flatMap(id => { const goal = content.goals.find(g => g.competencyId === id); const originalRef = refs.find(ref => ref.competencyId === id); return goal ? [goalRef(goal)] : originalRef ? [originalRef] : [] }))} />
  const taskOptions = content.tasks.map(task => ({ id: task.taskId, title: task.title }))
  function textField(key: 'projectTitle' | 'problem' | 'audience' | 'artifact' | 'studentBackground' | 'timeConstraints', title: string, rows?: number) {
    return <Field title={title}>{rows ? <textarea rows={rows} value={content[key] ?? ''} onChange={event => patch(key, event.target.value)} /> : <input value={content[key] ?? ''} onChange={event => patch(key, event.target.value)} />}</Field>
  }
  async function save() {
    if (generationChanged) { setError('数据库恢复代际已变化，请重新读取已存版本后继续。'); return }
    await run('正在保存…', async () => {
      const next = await saveBlueprint(account, generation, courseId, content, draft)
      setDraft(next); setContent(structuredClone(next.content)); setBaseline(structuredClone(next.content)); setReport(null); setAcknowledged(false)
      notify(`草稿 ${next.blueprintId} 已保存为 v${next.revision}`)
      workspace.refresh()
      if (!draft) navigate(`${base}/design/${encoded(next.blueprintId)}`, { replace: true, state: { teacherSavedDraft: next } })
    })
  }
  async function reload() {
    await run('正在重新读取…', async () => {
      const latest = await teacherGet<TeacherWorkbench>(`/courses/${encoded(courseId)}/teacher-workbench`)
      if (latest.courseId !== courseId || !latest.recoveryGeneration) throw new Error('读取回执的课程或恢复代际不匹配。')
      setGeneration(latest.recoveryGeneration)
      if (draft) {
        const next = latest.drafts.find(value => value.blueprintId === draft.blueprintId)
        if (!next) throw new Error('当前草稿未出现在教师工作台，请返回项目列表重新打开。')
        setDraft(next); setContent(structuredClone(next.content)); setBaseline(structuredClone(next.content))
      }
      setReport(null); setPreviews({}); setVisitedRoles([]); setAcknowledged(false)
      const existing = latest.activities.find(a => a.activityVersionId === released?.activityVersionId)
      if (existing) setReleased({ activityVersionId: existing.activityVersionId, sourceRevision: existing.sourceRevision!, activityControlRevision: existing.activityControlRevision, title: existing.content.content.projectTitle ?? existing.activityVersionId })
      workspace.refresh(); notify('已读取服务器保存版本。')
    }, true)
  }
  async function check() {
    if (generationChanged) { setError('数据库恢复代际已变化，请重新读取已存版本后继续。'); return }
    if (!draft || dirty) { setError('请先保存当前设计，再检查该保存版本。'); return }
    await run('正在检查…', async () => {
      const result = await teacherCommand<DesignResult>(account, 'POST', `/blueprints/${encoded(draft.blueprintId)}/checks`, { recoveryGeneration: generation, expectedRevision: draft.revision, concerns })
      if (result.kind !== 'checks' || result.report.blueprintId !== draft.blueprintId || result.report.revision !== draft.revision) throw new Error('设计检查回执未指向当前保存版本。')
      setReport(result.report); setCheckedConcerns(fingerprint(concerns)); setAcknowledged(false)
      notify(result.report.blocking.length ? `仍有 ${result.report.blocking.length} 项阻断需要处理。` : '服务端检查完成，请核对三种角色的内容。')
    })
  }
  async function openPreview() {
    if (!draft || !ready) return
    await run('正在读取角色预览…', async () => {
      const results = await Promise.all(roles.map(item => readBlueprintPreview(draft.blueprintId, item.id)))
      if (results.some((p, index) => p.blueprintId !== draft.blueprintId || p.revision !== draft.revision || p.audience !== roles[index].id)) throw new Error('草稿已更新，请重新读取后检查与预览。')
      setPreviews(Object.fromEntries(results.map(p => [p.audience, p]))); setRole('student'); setVisitedRoles(['student']); setAcknowledged(false); setModal('preview')
    })
  }
  async function release() {
    if (generationChanged) { setError('数据库恢复代际已变化，请重新读取已存版本后继续。'); return }
    if (!draft || !ready || !acknowledged || visitedRoles.length !== roles.length) return
    await run('正在确认固定版本…', async () => {
      const result = await teacherCommand<ReleaseResult>(account, 'POST', `/blueprints/${encoded(draft.blueprintId)}/releases`, { recoveryGeneration: generation, expectedRevision: draft.revision, confirmed: true, concerns })
      if (!result.activityVersionId || result.sourceRevision !== draft.revision || !Number.isSafeInteger(result.activityControlRevision)) throw new Error('固定活动回执与当前版本不匹配，请重新读取。')
      setReleased({ ...result, title: content.projectTitle ?? result.activityVersionId }); setStudents([]); setAssignments([]); setModal('assign')
      workspace.refresh(); notify(`活动版本已固定：${result.activityVersionId}`)
    })
  }
  async function assign() {
    if (generationChanged) { setError('数据库恢复代际已变化，请重新读取已存版本后继续。'); return }
    if (!released || !students.length) return
    await run('正在分配…', async () => {
      const result = await teacherCommand<AssignmentResult>(account, 'POST', `/activities/${encoded(released.activityVersionId)}/assignments`, { recoveryGeneration: generation, expectedActivityControlRevision: released.activityControlRevision, studentIds: students })
      if (!Array.isArray(result.assignments) || result.assignments.some(a => a.activityVersionId !== released.activityVersionId || !students.includes(a.studentId))) throw new Error('分配回执范围不匹配，请重新读取。')
      setAssignments(result.assignments); workspace.refresh(); notify(`已分配给 ${result.assignments.length} 位学生。`)
    })
  }
  const currentPreview = previews[role]
  return <div className="td-page tld-page">
    <div className="td-topline"><Link className="td-back" to={`${base}/projects`}>项目与活动</Link><span>项目设计</span><span className="td-draft-tag">{version}</span></div>
    <header className="td-heading"><div><p className="td-eyebrow">PROJECT DESIGN</p><h1>{content.projectTitle || '设计一份值得探索的项目'}</h1><p>围绕真实问题，把学习目标、实践和证据连起来。</p></div><div className="td-heading-actions"><span className={`td-save-state${dirty ? ' is-dirty' : ''}`}><span />{busy || (dirty ? '有尚未保存的设计' : `服务器已保存 · ${version}`)}</span><button type="button" className="td-btn" disabled={!!busy || !!workspace.pendingCommand || !account || !draft} onClick={() => { void reload() }}>重新读取已存版本</button><button type="button" className="td-btn td-btn-primary" disabled={locked || !dirty || remoteChanged} onClick={() => { void save() }}>保存草稿</button></div></header>
    {draft?.source && <p className="td-source"><Icon name="copy" />复制来源：<Link to={`${base}/design/${encoded(draft.source.blueprintId)}`}>{draft.source.blueprintId}</Link> · v{draft.source.revision}</p>}
    {error && <div className="td-notice tld-error" role="alert"><Icon name="info-circle" /><span>{error} 若结果未知，请先核对原教师操作；保留当前页面与编辑内容。</span></div>}
    {remoteChanged && <div className="td-notice" role="status"><Icon name="info-circle" /><span>服务器存在更新的草稿版本。当前编辑仍保留；“重新读取已存版本”会用服务器内容替换当前编辑。</span></div>}
    {generationChanged && <div className="td-notice" role="status"><Icon name="info-circle" /><span>数据库恢复代际已变化，当前编辑仍保留。请重新读取已存版本；尚未保存的新设计请返回项目列表重新开始。</span></div>}
    <div className="td-layout"><main className="td-editor"><nav className="td-steps" aria-label="项目设计章节">{sections.map((item, index) => <button type="button" key={item.id} className={section === item.id ? 'is-current' : ''} aria-current={section === item.id ? 'step' : undefined} onClick={() => setSection(item.id)}><span className="td-step-number">0{index + 1}</span>{item.title}</button>)}</nav><div className="td-editor-body"><div className="td-section-heading"><span className="td-section-icon"><Icon name={sections.find(s => s.id === section)!.icon} size={20} /></span><div><h2>{sections.find(s => s.id === section)!.title}</h2><p>{sections.find(s => s.id === section)!.subtitle}</p></div></div>
      <fieldset className="td-fields" disabled={locked || generationChanged}>
        {section === 'brief' && <>
          <div className="td-form-pair"><Field title="任教课程"><select value={courseId} disabled={!!draft} onChange={event => { const next = workbenches.find(w => w.courseId === event.target.value)!; setCourseId(next.courseId); setGeneration(next.recoveryGeneration); setPresetId(next.presets[0]?.id ?? ''); change(emptyContent()); setBaseline(emptyContent()); setReport(null); setReleased(null); setConcerns([]) }}>{data.courses.map(c => <option value={c.id} key={c.id}>{c.title}</option>)}</select></Field><Field title="已确认的课程范例" hint="范例沿用本课程已确认的帮助、检查与运行配置。"><select value={presetId} disabled={!!draft} onChange={event => setPresetId(event.target.value)}>{!workbench.presets.length && <option value="">暂无已确认范例</option>}{workbench.presets.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></Field></div>
          {!draft && <div className="tld-preset-note"><p>当前起点来自真实课程范例。更换范例会替换本页尚未保存的设计。</p><button type="button" className="td-btn" disabled={!selectedPreset} onClick={() => { if (selectedPreset) { change(structuredClone(selectedPreset.content)); setBaseline(structuredClone(selectedPreset.content)); setReport(null) } }}>应用所选范例</button></div>}
          {textField('projectTitle', '项目标题')}{textField('problem', '驱动问题', 4)}<div className="td-form-pair">{textField('audience', '项目受众', 2)}{textField('artifact', '最终产物', 2)}</div><Field title="留给学生的选择空间" hint="每行一条可选择路线。"><textarea rows={3} value={content.routes.join('\n')} onChange={event => patch('routes', event.target.value.split('\n'))} /></Field>{textField('studentBackground', '前置基础', 3)}{textField('timeConstraints', '时间与资源限制', 2)}
        </>}
        {section === 'goals' && <>
          <div className="td-inline-note"><Icon name="lightbulb" /><p>目标、任务与观察分别编辑。改动目标内容会形成新的目标版本，并同步本设计中的引用；原有活动保持固定。</p></div>
          {content.goals.map((goal, index) => <div className="td-repeat" key={goal.competencyId}>{repeatedTitle('学习目标', index, ![...content.tasks, ...content.observations, ...content.rubricCriteria].some(item => item.goalRefs.some(ref => ref.competencyId === goal.competencyId)), () => patch('goals', content.goals.filter(g => g.competencyId !== goal.competencyId)))}<div className="td-form-pair"><Field title="能力线"><select value={goal.domain} onChange={event => changeGoal(goal.competencyId, { domain: event.target.value as Goal['domain'] })}>{domains.map(domain => <option value={domain.id} key={domain.id}>{domain.title}</option>)}</select></Field><Field title="目标版本"><input readOnly value={`v${goal.competencyVersion}`} /></Field></div><Field title="学习目标"><textarea rows={2} value={goal.title} onChange={event => changeGoal(goal.competencyId, { title: event.target.value })} /></Field><label className="tld-checkbox"><input type="checkbox" checked={goal.core} onChange={event => changeGoal(goal.competencyId, { core: event.target.checked })} />核心目标，需要关联可观察表现</label></div>)}
          <button type="button" className="td-add" onClick={() => patch('goals', [...content.goals, { competencyId: uid(), competencyVersion: 1, title: '', domain: 'domain', core: true }])}><IconText name="add">添加学习目标</IconText></button>
          <div className="td-subheading td-subheading-separated"><h3>实践任务</h3><p>每个任务关联对应目标，让学生知道为什么做。</p></div>
          {content.tasks.map((task, index) => <div className="td-repeat" key={task.taskId}>{repeatedTitle('实践任务', index, !content.observations.some(o => o.taskIds.includes(task.taskId)) && !content.milestones.some(m => m.taskIds.includes(task.taskId)), () => patch('tasks', content.tasks.filter(t => t.taskId !== task.taskId)))}<Field title="任务名称"><input value={task.title} onChange={event => patch('tasks', content.tasks.map(t => t.taskId === task.taskId ? { ...t, title: event.target.value } : t))} /></Field>{linkedGoals(task.goalRefs, refs => patch('tasks', content.tasks.map(t => t.taskId === task.taskId ? { ...t, goalRefs: refs } : t)))}</div>)}
          <button type="button" className="td-add" onClick={() => patch('tasks', [...content.tasks, { taskId: uid(), title: '', goalRefs: [] }])}><IconText name="add">添加实践任务</IconText></button>
          <div className="td-subheading td-subheading-separated"><h3>可观察表现</h3><p>描述凭什么判断，关联产生表现的任务与目标。</p></div>
          {content.observations.map((observation, index) => <div className="td-repeat" key={observation.observationId}>{repeatedTitle('可观察表现', index, !content.rubricCriteria.some(r => r.observationIds.includes(observation.observationId)), () => patch('observations', content.observations.filter(o => o.observationId !== observation.observationId)))}<Field title="表现与证据描述"><textarea rows={3} value={observation.description} onChange={event => patch('observations', content.observations.map(o => o.observationId === observation.observationId ? { ...o, description: event.target.value } : o))} /></Field>{linkedGoals(observation.goalRefs, refs => patch('observations', content.observations.map(o => o.observationId === observation.observationId ? { ...o, goalRefs: refs } : o)))}<LinkedChoices title="来自哪些实践任务" options={taskOptions} value={observation.taskIds} onChange={ids => patch('observations', content.observations.map(o => o.observationId === observation.observationId ? { ...o, taskIds: ids } : o))} /></div>)}
          <button type="button" className="td-add" onClick={() => patch('observations', [...content.observations, { observationId: uid(), description: '', goalRefs: [], taskIds: [] }])}><IconText name="add">添加可观察表现</IconText></button>
        </>}
        {section === 'milestones' && <>
          <div className="td-subheading"><h3>学习里程碑</h3><p>允许回看修订，每一步关联实际任务。</p></div>{content.milestones.map((milestone, index) => <div className="td-repeat" key={milestone.milestoneId}>{repeatedTitle('里程碑', index, true, () => patch('milestones', content.milestones.filter(m => m.milestoneId !== milestone.milestoneId)))}<Field title="里程碑名称"><input value={milestone.title} onChange={event => patch('milestones', content.milestones.map(m => m.milestoneId === milestone.milestoneId ? { ...m, title: event.target.value } : m))} /></Field><LinkedChoices title="包含的实践任务" options={taskOptions} value={milestone.taskIds} onChange={ids => patch('milestones', content.milestones.map(m => m.milestoneId === milestone.milestoneId ? { ...m, taskIds: ids } : m))} /></div>)}<button type="button" className="td-add" onClick={() => patch('milestones', [...content.milestones, { milestoneId: uid(), title: '', taskIds: [] }])}><IconText name="add">添加里程碑</IconText></button>
          <div className="td-subheading td-subheading-separated"><h3>评价量规</h3><p>评价依据指向观察，三条能力线保持各自的证据。</p></div>{content.rubricCriteria.map((criterion, index) => <div className="td-repeat" key={criterion.criterionId}>{repeatedTitle('评价维度', index, true, () => patch('rubricCriteria', content.rubricCriteria.filter(r => r.criterionId !== criterion.criterionId)))}<Field title="判定描述与证据要求"><textarea rows={3} value={criterion.description} onChange={event => patch('rubricCriteria', content.rubricCriteria.map(r => r.criterionId === criterion.criterionId ? { ...r, description: event.target.value } : r))} /></Field>{linkedGoals(criterion.goalRefs, refs => patch('rubricCriteria', content.rubricCriteria.map(r => r.criterionId === criterion.criterionId ? { ...r, goalRefs: refs } : r)))}<LinkedChoices title="依据哪些可观察表现" options={content.observations.map(o => ({ id: o.observationId, title: o.description }))} value={criterion.observationIds} onChange={ids => patch('rubricCriteria', content.rubricCriteria.map(r => r.criterionId === criterion.criterionId ? { ...r, observationIds: ids } : r))} /></div>)}<button type="button" className="td-add" onClick={() => patch('rubricCriteria', [...content.rubricCriteria, { criterionId: uid(), description: '', goalRefs: [], observationIds: [] }])}><IconText name="add">添加评价维度</IconText></button>
        </>}
        {section === 'support' && <>
          <Field title="已确认的帮助政策" hint="沿用课程已确认的政策版本。当前接口不支持创建新政策，修改此项须先由课程负责人确认。"><textarea readOnly rows={4} value={policy?.description ?? `政策版本：${content.helpPolicyVersionId || '尚未选择'}`} /></Field><div className="td-inline-note"><Icon name="shield-check" /><p>{policy?.helpAllowed ? '允许按课程政策求助。' : '当前政策未开放日常求助。'} 整份代做与限定检查中的辅导均未开放。</p></div><div className="td-subheading"><h3>关联材料版本</h3><p>用途权限与学生、辅导可见性分别核对，材料版本固定后不会随草稿变化。</p></div>
          {workbench.resources.length ? <div className="td-resource-list">{workbench.resources.map(resource => { const selected = content.resources.some(r => r.resourceVersionId === resource.resourceVersionId); return <label className="td-resource-option" key={resource.resourceVersionId}><input type="checkbox" checked={selected} disabled={!selected && !resource.teacherDesignAllowed} onChange={event => patch('resources', event.target.checked ? [...content.resources, { resourceVersionId: resource.resourceVersionId }] : content.resources.filter(r => r.resourceVersionId !== resource.resourceVersionId))} /><Icon name={resource.material.kind === 'learning_material' ? 'file-text' : 'lock-keyhole'} size={20} /><span><strong>{resource.material.title}</strong><span>{resource.material.kind === 'learning_material' ? '学习材料' : resource.material.kind === 'private_answer' ? '教师私有答案' : '验证资产'}</span><span>学生{resource.material.visibility.student ? '可见' : '不可见'} · 辅导{resource.material.visibility.tutor ? '可见' : '不可见'} · 教师设计{resource.teacherDesignAllowed ? '允许使用' : '未获用途授权'}</span><small className="tld-id">{resource.resourceVersionId}</small></span></label> })}</div> : <div className="td-inline-empty">暂无材料。<Link to={`${base}/materials`}>前往课程材料</Link></div>}
          {content.resources.filter(ref => !workbench.resources.some(r => r.resourceVersionId === ref.resourceVersionId)).map(ref => <div className="td-notice" key={ref.resourceVersionId}><span>未读到关联材料 {ref.resourceVersionId}</span><button type="button" className="td-btn" onClick={() => patch('resources', content.resources.filter(r => r.resourceVersionId !== ref.resourceVersionId))}>取消关联</button></div>)}
          <details className="tld-config"><summary>查看沿用的课程配置</summary><dl><dt>帮助政策</dt><dd>{content.helpPolicyVersionId || '未选择'}</dd><dt>检查规则</dt><dd>{content.checkRuleVersionId || '未选择'}</dd><dt>运行配置</dt><dd>{content.runtimeProfileVersionId || '未选择'}</dd>{content.digitalLogicConfigVersionId && <><dt>数字逻辑配置</dt><dd>{content.digitalLogicConfigVersionId}</dd></>}</dl></details>
        </>}
      </fieldset><footer className="td-editor-footer"><span>设计 AI 预算未开放；当前为手工编辑与真实服务端检查。</span><div>{section !== 'brief' && <button type="button" className="td-btn" onClick={() => setSection(sections[sections.findIndex(s => s.id === section) - 1].id)}>上一节</button>}{section !== 'support' ? <button type="button" className="td-btn" onClick={() => setSection(sections[sections.findIndex(s => s.id === section) + 1].id)}>下一节</button> : <button type="button" className="td-btn td-btn-primary" disabled={locked || dirty || remoteChanged} onClick={() => { void check() }}>运行设计检查</button>}</div></footer></div></main>
      <aside className="td-rail" aria-label="设计检查与分配"><div className="td-checks"><div className={`td-check-summary${ready ? ' is-ready' : ''}`}><Icon name={ready ? 'check-circle' : 'checklist'} size={28} /><h3>{ready ? '已通过结构检查' : checksCurrent ? '还有设计需要补齐' : '保存后，检查这份设计'}</h3><p>{checksCurrent ? `${version} 的真实服务端检查结果。` : '编辑或设计疑点变化后，需要重新检查。'}</p></div>
        <div className="td-check-group"><div className="td-check-group-title"><span className="td-check-dot block" /><strong>阻断项</strong><span>{checksCurrent ? report.blocking.length : '—'}</span></div>{checksCurrent && report.blocking.length ? report.blocking.map((item, index) => <button type="button" className="td-check-item" key={`${item.path}:${index}`} onClick={() => setSection(item.path.startsWith('goals') || item.path.startsWith('tasks') || item.path.startsWith('observations') ? 'goals' : item.path.startsWith('milestones') || item.path.startsWith('rubric') ? 'milestones' : item.path.startsWith('resources') || item.path.endsWith('VersionId') ? 'support' : 'brief')}><span>{blockingNames[item.code] ?? item.code}<small className="tld-path">{item.path}</small></span><Icon name="alt-arrow-right" /></button>) : <p>{checksCurrent ? '没有结构阻断。' : '尚无当前版本的检查结果。'}</p>}</div>
        <div className="td-check-group"><div className="td-check-group-title"><span className="td-check-dot question" /><strong>设计疑点</strong><span>{concerns.length}</span></div><p>意义、难度和量规是否合适，由教师判断。可记录试评发现与处理方式。</p><fieldset className="td-fields" disabled={locked}>{concernKinds.map(kind => { const concern = concerns.find(c => c.code === kind.code); const update = (field: 'reason' | 'resolution', value: string) => { const next = { ...(concern ?? { code: kind.code, path: kind.path, reason: '' }), [field]: value }; setConcerns(current => [...current.filter(c => c.code !== kind.code), next].filter(c => c.reason.trim() || c.resolution?.trim())); setAcknowledged(false) }; return <details className="tld-concern" key={kind.code}><summary>{kind.title}{concern ? ' · 已记录' : ''}</summary><Field title={`${kind.title}：发现的疑点`}><textarea rows={2} value={concern?.reason ?? ''} onChange={event => update('reason', event.target.value)} /></Field><Field title={`${kind.title}：处理方式`}><textarea rows={2} value={concern?.resolution ?? ''} onChange={event => update('resolution', event.target.value)} /></Field></details> })}</fieldset>{checksCurrent && report.designConcerns.some(c => c.status === 'requires_teacher') && <p className="tld-error">请补充上述疑点的处理方式后重新检查。</p>}</div>
        <div className="td-check-group"><div className="td-check-group-title"><span className="td-check-dot pending" /><strong>待验证</strong><span>2</span></div><p>学习效果与工作量估计仍为未知。结构检查与执行环境就绪不代表教学效果。</p>{report?.execution && <p>数字逻辑配置结构已核对；实际电路行为仍需验证。</p>}</div>
        <button type="button" className="td-btn td-check-preview" disabled={locked || dirty || remoteChanged} onClick={() => { void check() }}>运行设计检查</button><button type="button" className="td-btn td-btn-primary td-check-preview tld-preview-button" disabled={locked || !ready || released?.sourceRevision === draft?.revision} onClick={() => { void openPreview() }}>预览并确认版本<Icon name="arrow-right" /></button>
      </div><div className="td-rail-footnote"><Icon name="lock-keyhole" /><span>真实保存与分配使用当前账号、课程及恢复代际。</span></div></aside></div>
    {released && <section className="tld-release" aria-label="固定活动与分配回执"><div><span className="td-draft-tag">已固定 · v{released.sourceRevision}</span><h2>{released.title}</h2><p>活动 {released.activityVersionId}</p><p>继续编辑草稿会产生新版本，已固定的活动内容保持原样。</p></div><button type="button" className="td-btn td-btn-primary" disabled={locked} onClick={() => { setModal('assign'); setStudents([]); setAssignments([]) }}>选择学生并分配</button>{assignments.length > 0 && <div className="tld-receipts" role="status"><strong>已收到 {assignments.length} 条分配回执</strong>{assignments.map(a => <p key={a.assignmentId}>{workbench.members.find(m => m.userId === a.studentId)?.displayName || a.studentId} · {a.assignmentId} · v{a.assignmentRevision}</p>)}</div>}</section>}
    <dialog ref={dialog} className="td-dialog" aria-labelledby="tld-dialog-title" onCancel={event => { if (busy) event.preventDefault(); else setModal(null) }} onClose={() => setModal(null)}><div className="td-dialog-shell"><header className="td-dialog-header"><div><p className="td-eyebrow">{modal === 'assign' ? 'ACTIVITY ASSIGNMENT' : 'ROLE PREVIEW'}</p><h2 id="tld-dialog-title">{modal === 'assign' ? '分配已固定的活动' : '核对三个角色的内容'}</h2></div><button type="button" className="td-icon-btn" disabled={!!busy} aria-label="关闭对话框" onClick={() => setModal(null)}><Icon name="close" /></button></header><div className="td-dialog-body">
      {error && <div className="td-notice tld-error" role="alert">{error}</div>}
      {modal === 'preview' && currentPreview && <><div className="td-preview-toolbar"><div className="td-role-switch" aria-label="选择预览角色">{roles.map(item => <button type="button" key={item.id} disabled={!!busy} aria-pressed={role === item.id} onClick={() => { setRole(item.id); setVisitedRoles(current => current.includes(item.id) ? current : [...current, item.id]) }}>{item.title}</button>)}</div><span className="td-version">服务端投影 · v{currentPreview.revision}</span></div><RolePreview preview={currentPreview} courseName={course?.title ?? courseId} policyDescription={policy?.description} /><div className="td-preview-confirm"><label><input type="checkbox" checked={acknowledged} disabled={!!busy || visitedRoles.length !== roles.length} onChange={event => setAcknowledged(event.target.checked)} /><span>我已核对三个角色的内容与材料可见范围，并确认保存版本 {version}</span></label><p>{visitedRoles.length !== roles.length ? '请分别查看学生、辅导与教师 / 验证器视角。' : '确认会生成固定活动版本；下一步选择本课程学生。'}</p></div></>}
      {modal === 'assign' && released && <><div className="td-assignment-summary"><strong>{released.title}</strong><span>{course?.title} · 固定 v{released.sourceRevision}</span><span className="tld-id">{released.activityVersionId}</span></div><div className="td-selection-heading"><span>{workbench.members.length} 位课程学生</span><button type="button" className="td-link-button" disabled={!!busy} onClick={() => setStudents(students.length === workbench.members.length ? [] : workbench.members.map(member => member.userId))}>{students.length === workbench.members.length ? '取消全选' : '选择全部'}</button></div>{workbench.members.map(member => <label className="td-learner-option" key={member.userId}><input type="checkbox" disabled={!!busy} checked={students.includes(member.userId)} onChange={event => setStudents(event.target.checked ? [...students, member.userId] : students.filter(id => id !== member.userId))} /><span className="td-learner-avatar">{(member.displayName || member.userId).slice(0, 1)}</span><span><strong>{member.displayName || member.userId}</strong><span>{member.userId}</span></span></label>)}{!workbench.members.length && <div className="td-inline-empty">这门课程还没有可分配的学生成员。</div>}{assignments.length > 0 && <div className="td-notice tld-assignment-result" role="status"><Icon name="check-circle" /><div><strong>已分配给 {assignments.length} 位学生</strong>{assignments.map(a => <p className="tld-id" key={a.assignmentId}>{a.studentId} · {a.assignmentId}</p>)}</div></div>}</>}
    </div><footer className="td-dialog-footer"><button type="button" className="td-btn" disabled={!!busy} onClick={() => setModal(null)}>{assignments.length ? '完成' : '继续编辑'}</button>{modal === 'preview' ? <button type="button" className="td-btn td-btn-primary" disabled={locked || !ready || !acknowledged || visitedRoles.length !== roles.length} onClick={() => { void release() }}>{busy || '确认活动版本'}</button> : <button type="button" className="td-btn td-btn-primary" disabled={locked || !students.length || !!assignments.length} onClick={() => { void assign() }}>{busy || `分配活动 · ${students.length} 人`}</button>}</footer></div></dialog>
  </div>
}

function RolePreview({ preview, courseName, policyDescription }: { preview: BlueprintPreview; courseName: string; policyDescription?: string }) {
  const c = preview.content
  const goalTitles = (refs: GoalRef[]) => refs.map(ref => c.goals.find(goal => goal.competencyId === ref.competencyId && goal.competencyVersion === ref.competencyVersion)?.title ?? `${ref.competencyId} v${ref.competencyVersion}`).join('；')
  const taskTitles = (ids: string[]) => ids.map(id => c.tasks.find(task => task.taskId === id)?.title ?? id).join('；')
  return <article className="td-role-preview"><div className="td-preview-course">{courseName} · {c.timeConstraints || '时长待教师确定'}</div><h3>{c.projectTitle || '尚未填写标题'}</h3><p>{c.problem}</p><dl><dt>项目受众</dt><dd>{c.audience}</dd><dt>最终产物</dt><dd>{c.artifact}</dd><dt>选择空间</dt><dd>{c.routes.join('\n')}</dd><dt>前置基础</dt><dd>{c.studentBackground}</dd></dl><h4>学习目标</h4>{c.goals.map(goal => <div className="td-preview-item" key={goal.competencyId}><strong>{domains.find(d => d.id === goal.domain)?.title} · {goal.title}</strong><p>v{goal.competencyVersion}{goal.core ? ' · 核心目标' : ''}</p></div>)}<h4>实践任务</h4>{c.tasks.map(task => <div className="td-preview-item" key={task.taskId}><strong>{task.title}</strong><p>对应目标：{goalTitles(task.goalRefs)}</p></div>)}<h4>可观察表现</h4>{c.observations.map(o => <div className="td-preview-item" key={o.observationId}><strong>{o.description}</strong><p>任务：{taskTitles(o.taskIds)}</p><p>目标：{goalTitles(o.goalRefs)}</p></div>)}<h4>里程碑</h4>{c.milestones.map(m => <div className="td-preview-item" key={m.milestoneId}><strong>{m.title}</strong><p>{taskTitles(m.taskIds)}</p></div>)}<h4>评价量规</h4>{c.rubricCriteria.map(r => <div className="td-preview-item" key={r.criterionId}><strong>{r.description}</strong><p>目标：{goalTitles(r.goalRefs)}</p><p>观察：{r.observationIds.map(id => c.observations.find(o => o.observationId === id)?.description ?? id).join('；')}</p></div>)}<h4>帮助政策</h4><p>{policyDescription || c.helpPolicyVersionId || '未提供政策说明'}</p><h4>{roles.find(role => role.id === preview.audience)?.title}可见材料</h4>{preview.materials.length ? preview.materials.map((material, index) => material.status === 'available' ? <details className="td-preview-resource" key={material.resourceVersionId}><summary><Icon name="file-text" />{material.title}</summary><p>{material.text}</p><small className="tld-id">{material.resourceVersionId}</small></details> : <p className="td-hint" key={index}>{material.status === 'redacted' ? '有材料未向该角色开放。' : '有材料版本当前不可用。'}</p>) : <p className="td-hint">没有关联材料。</p>}</article>
}
