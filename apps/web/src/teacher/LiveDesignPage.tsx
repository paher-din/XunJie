import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useSession } from '../components/SessionEntry'
import { useTeacher } from './context'
import { readBlueprintPreview, saveBlueprint, teacherCommand, teacherGet } from './backend'
import type { ActivityView, BlueprintContent, BlueprintDraft, BlueprintPreview, DesignCheckReport, DesignResult, GoalRef, TeacherConcern, TeacherWorkbench } from './wire'
import './design.css'
import './live-design.css'
import DesignAgentPanel from './DesignAgentPanel'
import { LiveBriefSection, LiveGoalsSection, LiveMilestonesSection, LiveSupportSection, LiveDesignChecks, LiveDesignDialogs, LiveReleaseSummary, LiveDesignNavigation, LiveDesignSectionHeading, LiveDesignFooter, LiveDesignHeading, LiveDesignTopline, FollowUpDesignSource, DesignUnavailable, LiveDesignNotices, FollowUpDesignHeading, FollowUpDesignActions, FollowUpDesignError } from '@xunjie/ui/teacher-design'
export { LiveDesignField as Field, DesignLinkedChoices as LinkedChoices, LiveRolePreview as RolePreview } from '@xunjie/ui/teacher-design'

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
const concernKinds: { code: TeacherConcern['code']; title: string; path: string }[] = [
  { code: 'meaning', title: '问题意义', path: 'problem' }, { code: 'difficulty', title: '难度与先备', path: 'studentBackground' },
  { code: 'time', title: '时间安排', path: 'timeConstraints' }, { code: 'solution_space', title: '解法空间', path: 'routes' },
  { code: 'rubric_ambiguity', title: '量规歧义', path: 'rubricCriteria' },
]
interface Released { activityVersionId: string; sourceRevision: number; activityControlRevision: number; title: string }
interface ReleaseResult { activityVersionId: string; sourceRevision: number; activityControlRevision: number; checks: DesignCheckReport; unverified: DesignCheckReport['unverified'] }
interface AssignmentResult { assignments: { assignmentId: string; studentId: string; activityVersionId: string; assignmentRevision: number; status: 'active' | 'paused' }[] }
const uid = () => crypto.randomUUID()
const encoded = encodeURIComponent
const fingerprint = (value: unknown) => JSON.stringify(value)
const emptyContent = (): BlueprintContent => ({ routes: [], goals: [], tasks: [], observations: [], rubricCriteria: [], milestones: [], resources: [] })
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请核对当前版本后重试。'
const goalRef = (goal: Goal): GoalRef => ({ competencyId: goal.competencyId, competencyVersion: goal.competencyVersion })

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
  if (!workbenches.length || (draftId !== 'new' && !original)) return <DesignUnavailable title={workspace.loading ? '正在读取项目设计…' : '暂时无法打开这份设计'} description={workspace.error || '请重新读取任教课程，或从项目列表打开已有草稿。'} projectsPath={`${workspace.base}/projects`} onRefresh={workspace.refresh} Link={Link} />
  if (fromActivityId) {
    if (!sourceWorkbench || !sourceActivity || (search.get('course') && search.get('course') !== sourceWorkbench.courseId)) return <DesignUnavailable title="无法读取后续项目的来源活动" description="来源活动须属于当前账号的任教课程。请重新读取后，从学生审阅或固定活动重新打开。" projectsPath={`${workspace.base}/projects`} onRefresh={workspace.refresh} Link={Link} />
    return <CopyActivityDesign key={sourceActivity.activityVersionId} activity={sourceActivity} workbench={sourceWorkbench} />
  }
  return <LiveDesignEditor key={`${draftId}:${initialCourseId}`} initial={original} initialCourseId={initialCourseId} />
}

export function CopyActivityDesign({ activity, workbench }: { activity: ActivityView; workbench: TeacherWorkbench }) {
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
  return <div className="td-page tld-page"><FollowUpDesignHeading base={workspace.base} courseName={courseName} Link={Link} />
    {error && <FollowUpDesignError error={error} />}
    <FollowUpDesignSource activity={activity} source={source} locked={locked} busy={busy} onCopy={()=>{void copy()}} />
    <FollowUpDesignActions base={workspace.base} busy={busy} onRefresh={workspace.refresh} Link={Link} />
  </div>
}

export function LiveDesignEditor({ initial, initialCourseId }: { initial?: BlueprintDraft; initialCourseId: string }) {
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
  const resolveGoalRefs = (refs: GoalRef[], ids: string[]): GoalRef[] => ids.flatMap(id => {
    const goal = content.goals.find(g => g.competencyId === id)
    const originalRef = refs.find(ref => ref.competencyId === id)
    return goal ? [goalRef(goal)] : originalRef ? [originalRef] : []
  })
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
    <LiveDesignTopline base={base} Link={Link} version={version} />
    <LiveDesignHeading content={content} dirty={dirty} version={version} busy={busy} reloadDisabled={!!busy || !!workspace.pendingCommand || !account || !draft} locked={locked} remoteChanged={remoteChanged} onReload={()=>{void reload()}} onSave={()=>{void save()}} />
    <DesignAgentPanel key={`${account}:${courseId}:${draft?.blueprintId ?? 'new'}`} account={account} workbench={workbench} draft={draft} content={content}
      disabled={locked || generationChanged || remoteChanged} dirty={dirty} onAdopt={next => {
        setDraft(next); setContent(structuredClone(next.content)); setBaseline(structuredClone(next.content)); setReport(null)
        setPreviews({}); setVisitedRoles([]); setAcknowledged(false); workspace.refresh(); notify('模型候选已明确采用到草稿，请完善关联后重新检查。')
        if (!draft) navigate(`${base}/design/${encoded(next.blueprintId)}`, { replace: true, state: { teacherSavedDraft: next } })
      }} />
    <LiveDesignNotices source={draft?.source} base={base} Link={Link} error={error} remoteChanged={remoteChanged} generationChanged={generationChanged} />
    <div className="td-layout"><main className="td-editor"><LiveDesignNavigation section={section} setSection={setSection} /><div className="td-editor-body"><LiveDesignSectionHeading section={section} />
      <fieldset className="td-fields" disabled={locked || generationChanged}>
        {section === 'brief' && <LiveBriefSection content={content} patch={patch} draft={draft} courseId={courseId} presetId={presetId} data={data} workbench={workbench} selectedPreset={selectedPreset} setPresetId={setPresetId} onCourseChange={value => { const next = workbenches.find(w => w.courseId === value)!; setCourseId(next.courseId); setGeneration(next.recoveryGeneration); setPresetId(next.presets[0]?.id ?? ''); change(emptyContent()); setBaseline(emptyContent()); setReport(null); setReleased(null); setConcerns([]) }} onApplyPreset={() => { if (selectedPreset) { change(structuredClone(selectedPreset.content)); setBaseline(structuredClone(selectedPreset.content)); setReport(null) } }} />}
        {section === 'goals' && <LiveGoalsSection content={content} patch={patch} uid={uid} changeGoal={changeGoal} resolveGoalRefs={resolveGoalRefs} canRemoveGoal={id => ![...content.tasks, ...content.observations, ...content.rubricCriteria].some(item => item.goalRefs.some(ref => ref.competencyId === id))} canRemoveTask={id => !content.observations.some(o => o.taskIds.includes(id)) && !content.milestones.some(m => m.taskIds.includes(id))} canRemoveObservation={id => !content.rubricCriteria.some(r => r.observationIds.includes(id))} />}
        {section === 'milestones' && <LiveMilestonesSection content={content} patch={patch} uid={uid} resolveGoalRefs={resolveGoalRefs} />}
        {section === 'support' && <LiveSupportSection content={content} patch={patch} workbench={workbench} policy={policy} base={base} Link={Link} />}
      </fieldset><LiveDesignFooter section={section} setSection={setSection} locked={locked} dirty={dirty} remoteChanged={remoteChanged} onCheck={()=>{void check()}} /></div></main>
      <LiveDesignChecks ready={ready} checksCurrent={checksCurrent} version={version} report={report} concerns={concerns} concernKinds={concernKinds}
 locked={locked} dirty={dirty} remoteChanged={remoteChanged} released={released} draft={draft}
 onBlockingSelect={path => setSection(path.startsWith('goals') || path.startsWith('tasks') || path.startsWith('observations') ? 'goals' : path.startsWith('milestones') || path.startsWith('rubric') ? 'milestones' : path.startsWith('resources') || path.endsWith('VersionId') ? 'support' : 'brief')} onConcernChange={(code, field, value) => {
 const kind = concernKinds.find(item => item.code === code)!
 const concern = concerns.find(c => c.code === code)
 const next = { ...(concern ?? {code, path:kind.path, reason:''}), [field]:value }
 setConcerns(current => [...current.filter(c => c.code !== code), next].filter(c => c.reason.trim() || c.resolution?.trim()))
 setAcknowledged(false)
 }} onCheck={() => {void check()}} onPreview={() => {void openPreview()}} /></div>
    {released && <LiveReleaseSummary released={released} locked={locked} onSelectStudents={() => { setModal('assign'); setStudents([]); setAssignments([]) }} assignments={assignments} members={workbench.members} />}
    <LiveDesignDialogs dialog={dialog} modal={modal} setModal={setModal} busy={busy} error={error} currentPreview={currentPreview}
 role={role} onRoleSelect={value => {setRole(value);setVisitedRoles(current=>current.includes(value)?current:[...current,value])}}
 course={course} courseId={courseId} policy={policy} acknowledged={acknowledged} setAcknowledged={setAcknowledged} visitedRoles={visitedRoles}
 version={version} released={released} members={workbench.members} students={students} setStudents={setStudents} assignments={assignments}
 locked={locked} ready={ready} onRelease={()=>{void release()}} onAssign={()=>{void assign()}} />
  </div>
}
