import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { setThemePreference, useTheme } from '../lib/theme'
import { useSession } from '../components/SessionEntry'
import { logoutSession } from '../workspace/session'
import { TeacherContext, useTeacher } from './context'
import { loadTeacherWorkbenchData, onTeacherCommandsChanged, pendingTeacherCommands, resourceFromWire, retryTeacherCommands, teacherCommand } from './backend'
import type { DesignResult } from './wire'
import { TeacherDialog, TeacherEmpty, ProjectCard } from '@xunjie/ui/teacher'
import {
  TeacherActivityDetail, TeacherAttentionPanel, TeacherCommandNotice, TeacherCourseFilter,
  TeacherCoursesSection, TeacherDesignCard, TeacherOverviewColumns, TeacherOverviewStats, TeacherPageHeading,
  TeacherPageLoading, TeacherPageRegion, TeacherPreviewNotice, TeacherProjectGrid, TeacherProjectsToolbar, TeacherScopeNotice, TeacherShellFrame,
  TeacherSidebar, TeacherToast, TeacherTopbar,
} from '@xunjie/ui/teacher-shell'
import type { TeacherFixedActivityView } from '@xunjie/ui/teacher-shell'
import type { DesignDraft, TeacherActivity, TeacherData, TeacherLearner, TeacherResource, TeacherWorkspace } from './types'
import './teacher.css'
import { ExecutionNodeSelect } from '../components/workspace/ExecutionNodeSelect'

const DesignPage = lazy(() => import('./DesignPage'))
const ReviewPage = lazy(() => import('./ReviewPage'))
const LiveDesignPage = lazy(() => import('./LiveDesignPage'))
const LiveReviewPage = lazy(() => import('./LiveReviewPage'))
const MaterialsPage = lazy(() => import('./MaterialsPage'))
const TeacherSettingsPage = lazy(() => import('./TeacherSettingsPage'))
const PREVIEW_KEY = 'xunjie.teacher.preview.v1'
const emptyData = (): TeacherData => ({ courses: [], activities: [], drafts: [], resources: [], learners: [] })

function readPreview(initial: () => TeacherData): TeacherData {
  try {
    const raw = sessionStorage.getItem(PREVIEW_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as TeacherData
      if (['courses', 'activities', 'drafts', 'resources', 'learners'].every(key => Array.isArray(parsed[key as keyof TeacherData])) &&
        parsed.courses.every(course => typeof course?.id === 'string' && typeof course.title === 'string') &&
        parsed.drafts.every(draft => typeof draft?.title === 'string' && Array.isArray(draft.goals) && Array.isArray(draft.milestones) && Array.isArray(draft.rubric)) &&
        parsed.learners.every(learner => Array.isArray(learner?.claims) && Array.isArray(learner.evidence) && Array.isArray(learner.unknowns))) return parsed
    }
  } catch { /* Unavailable/corrupt preview storage cannot block the preview. */ }
  return initial()
}

export default function TeacherApp({ preview = false, initialData }: { preview?: boolean; initialData?: () => TeacherData }) {
  const [data, setData] = useState<TeacherData>(() => preview && initialData ? readPreview(initialData) : emptyData())
  const [courseId, setCourseId] = useState('all')
  const [toast, setToast] = useState('')
  const [loading, setLoading] = useState(!preview)
  const [error, setError] = useState('')
  const [refreshKey, setRefreshKey] = useState(0)
  const [collapsed, setCollapsed] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [pendingCount, setPendingCount] = useState(0)
  const session = useSession()
  const { resolved } = useTheme()
  const location = useLocation()
  const navigate = useNavigate()
  const base = preview ? '/teacher/preview' : '/teacher'
  const scrollRegion = useRef<HTMLElement>(null)
  const stateRef = useRef(data)
  stateRef.current = data
  const notify = useCallback((message: string) => setToast(message), [])
  useEffect(() => {
    const update = () => {
      try { setPendingCount(session.session ? pendingTeacherCommands(session.session.userId).length : 0) }
      catch (cause) { notify(cause instanceof Error ? cause.message : '原教师请求无法读取。') }
    }
    update(); return onTeacherCommandsChanged(update)
  }, [session.session, notify])
  useEffect(() => {
    if (!toast) return
    const timeout = window.setTimeout(() => setToast(''), 5000)
    return () => clearTimeout(timeout)
  }, [toast])
  useEffect(() => { scrollRegion.current?.scrollTo({ top: 0 }) }, [location.pathname, location.search])
  useEffect(() => {
    if (!preview) return
    try { sessionStorage.setItem(PREVIEW_KEY, JSON.stringify(data)) }
    catch { notify('当前浏览器无法保存预览；本次操作仅在此页面内保留。') }
  }, [data, preview, notify])
  useEffect(() => {
    if (preview || !session.session) return
    let current = true
    setLoading(true)
    setError('')
    void loadTeacherWorkbenchData(session.session).then(next => { if (current) setData(next) })
      .catch((cause: unknown) => { if (current) setError(cause instanceof Error ? cause.message : '教师数据读取失败，请重试。') })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [preview, session.session, refreshKey, location.pathname])
  const requirePreview = useCallback(() => {
    if (preview) return true
    notify('此操作尚未接入当前教学宿主。')
    return false
  }, [preview, notify])
  const saveDraft = useCallback((draft: DesignDraft) => {
    if (!requirePreview()) return
    const existing = stateRef.current.drafts.find(item => item.id === draft.id)
    if (existing && existing.revision !== draft.revision) { notify('草稿已更新，请重新读取当前版本，避免覆盖。'); return }
    const next = { ...structuredClone(draft), revision: existing ? existing.revision + 1 : Math.max(1, draft.revision), savedAt: new Date().toISOString() }
    setData(current => ({ ...current, drafts: [...current.drafts.filter(item => item.id !== draft.id), next] }))
    notify('项目草稿已保存到本机预览。')
  }, [requirePreview, notify])
  const saveResource = useCallback(async (resource: TeacherResource) => {
    const privateAsset = resource.kind === 'private_answer' || resource.kind === 'validation'
    const safe = { ...resource, student: !privateAsset && resource.student, tutor: !privateAsset && resource.tutor }
    if (!preview) {
      const account = session.session?.userId
      const workbench = stateRef.current.workbenches?.find(w => w.courseId === resource.courseId)
      if (!account || !workbench) throw new Error('请先重新读取当前任教课程。')
      const result = await teacherCommand<DesignResult>(account, 'POST', `/courses/${encodeURIComponent(resource.courseId)}/resources`, {
        recoveryGeneration: workbench.recoveryGeneration, teacherDesignAllowed: safe.teacherDesign,
        material: { format: safe.format ?? 'paste', title: safe.title, content: safe.content,
          kind: safe.kind === 'private_answer' ? 'private_answer' : safe.kind === 'validation' ? 'validation_asset' : 'learning_material',
          visibility: { student: safe.student, tutor: safe.tutor } },
      })
      if (result.kind !== 'material') throw new Error('材料回执缺少固定版本，请核对原教师操作。')
      const actual = resourceFromWire(result.resourceVersion)
      setData(current => ({ ...current, resources: [...current.resources.filter(item => item.id !== actual.id), actual] }))
      setRefreshKey(key => key + 1)
      notify('课程材料已保存为固定版本。')
      return
    }
    setData(current => ({ ...current, resources: [...current.resources.filter(item => item.id !== safe.id), safe] }))
    notify('材料已保存到本机预览。')
  }, [preview, session.session, notify])
  const saveReview = useCallback((learner: TeacherLearner) => {
    if (!requirePreview()) return
    setData(current => {
      const learners = current.learners.map(item => item.id === learner.id ? structuredClone(learner) : item)
      return { ...current, learners, activities: current.activities.map(activity => activity.id === learner.activityId ? {
        ...activity, submitted: learners.filter(item => item.activityId === activity.id && ['submitted', 'reviewed'].includes(item.status)).length,
        reviewed: learners.filter(item => item.activityId === activity.id && item.status === 'reviewed').length,
      } : activity) }
    })
    notify('审阅记录已保存到本机预览，未发送给真实学生。')
  }, [requirePreview, notify])
  const releaseDraft = useCallback((draft: DesignDraft, studentIds: string[]) => {
    if (!requirePreview()) return
    const id = `preview-release-${draft.id}-${draft.revision}`
    if (stateRef.current.activities.some(item => item.id === id)) { notify('此版本已有本机预览分配，未重复创建。'); return }
    const selectedStudents = [...new Set(studentIds.filter(studentId => stateRef.current.learners.some(item => item.id === studentId && item.courseId === draft.courseId)))]
    const assigned = selectedStudents.length
    const resourceVersions = stateRef.current.resources.filter(resource => resource.courseId === draft.courseId && draft.resourceIds.includes(resource.id))
    const activity: TeacherActivity = { id, courseId: draft.courseId, title: draft.title, description: draft.problem, status: 'active', version: draft.revision, assigned, submitted: 0, reviewed: 0, due: '',
      snapshot: structuredClone(draft), studentIds: selectedStudents, resourceVersions: structuredClone(resourceVersions) }
    setData(current => ({ ...current, activities: current.activities.some(item => item.id === id) ? current.activities : [...current.activities, activity] }))
    notify(`预览版本已固定，分配给 ${assigned} 位合成学生。未写入教学服务。`)
  }, [requirePreview, notify])
  const context: TeacherWorkspace = { preview, base, data, courseId, setCourseId, notify, saveDraft, saveResource, saveReview, releaseDraft,
    refresh: () => setRefreshKey(key => key + 1), loading, error, pendingCommand: retrying || pendingCount > 0,
    retryPending: async () => {
      if (!session.session || retrying) return
      if (!pendingTeacherCommands(session.session.userId).length) { notify('当前没有待核对的教师操作。'); return }
      setRetrying(true)
      try { await retryTeacherCommands(session.session.userId); setRefreshKey(key => key + 1); navigate(`${base}/projects`); notify('原教师操作已核对，请从项目或学生列表打开服务器当前版本。') }
      catch (cause) { notify(cause instanceof Error ? cause.message : '核对未完成，请保留原请求。') }
      finally { setRetrying(false) }
    } }
  const section = location.pathname.slice(base.length).split('/')[1] || 'overview'
  const sectionNames: Record<string, string> = { overview: '教学概览', projects: '项目与活动', design: '项目设计', review: '学生与审阅', materials: '课程材料', settings: '工作台设置' }
  const teacher = preview || session.session?.courses.some(course => course.role === 'teacher')
  const links = { overview: base, projects: `${base}/projects`, review: `${base}/review`, materials: `${base}/materials`,
    settings: `${base}/settings`, studentSpace: '/', liveWorkspace: '/teacher' }
  return <TeacherContext.Provider value={context}>
    <TeacherShellFrame collapsed={collapsed} mainRef={scrollRegion} onSkipToMain={() => scrollRegion.current?.focus()}
      sidebar={<TeacherSidebar Link={Link} NavLink={NavLink} links={links} spaceCaption={preview ? '2026 秋季学期' : '我的任教课程'}
        courses={data.courses} selectedCourseId={courseId} onSelectCourse={id => setCourseId(courseId === id ? 'all' : id)}
        pendingReviewCount={preview ? data.learners.filter(item => item.status === 'submitted').length : 0}
        showStudentSpace={Boolean(preview || session.session?.courses.some(course => course.role === 'student'))}
        account={{ name: preview ? '教师预览' : session.session?.displayName || '教师账号', detail: preview ? '隔离合成数据' : '教师账号',
          action: preview ? { kind: 'link', to: links.liveWorkspace, label: '登录真实工作台' } : { kind: 'button', label: '退出登录', onClick: () => { void logoutSession() } } }} />}
      toast={toast ? <TeacherToast message={toast} onClose={() => setToast('')} /> : null}>
      <TeacherTopbar title={sectionNames[section] ?? '页面'} collapsed={collapsed} onToggleNavigation={() => setCollapsed(value => !value)}
        courses={data.courses} selectedCourseId={courseId} onCourseChange={setCourseId} dark={resolved === 'dark'}
        onToggleTheme={() => setThemePreference(resolved === 'dark' ? 'light' : 'dark')}
        tool={!preview && teacher && section === 'design' && session.session ? <ExecutionNodeSelect userId={session.session.userId} kind="any" busy={retrying || pendingCount > 0} /> : null} />
      {preview && <TeacherPreviewNotice Link={Link} liveWorkspaceTo={links.liveWorkspace} />}
      {!preview && teacher && <TeacherCommandNotice pendingCount={pendingCount} retrying={retrying} onRetry={() => { void context.retryPending?.() }} />}
      <TeacherPageRegion key={section}>
        {!teacher ? <TeacherEmpty title="当前账号没有教师课程">请使用课程提供的教师账号登录。课程角色由教学服务确认。</TeacherEmpty> : <Suspense fallback={<TeacherPageLoading />}>
          <Routes>
            <Route index element={<OverviewPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="design/:draftId" element={preview ? <DesignPage /> : <LiveDesignPage />} />
            <Route path="review" element={preview ? <ReviewPage /> : <LiveReviewPage />} />
            <Route path="materials" element={<MaterialsPage />} />
            <Route path="settings/*" element={<TeacherSettingsPage />} />
            <Route path="*" element={<TeacherEmpty title="没有找到这个页面"><Link to={base}>返回教学概览</Link></TeacherEmpty>} />
          </Routes>
        </Suspense>}
      </TeacherPageRegion>
    </TeacherShellFrame>
  </TeacherContext.Provider>
}

export function ScopeNotice() {
  const { preview, error, loading, refresh } = useTeacher()
  if (preview) return null
  return <TeacherScopeNotice error={error} loading={loading} onRefresh={refresh} />
}

export function OverviewPage() {
  const { data, base, preview, courseId, loading, error } = useTeacher()
  const navigate = useNavigate()
  const courses = data.courses.filter(course => courseId === 'all' || course.id === courseId)
  const activities = data.activities.filter(activity => courseId === 'all' || activity.courseId === courseId)
  const learners = data.learners.filter(learner => courseId === 'all' || learner.courseId === courseId)
  const drafts = data.drafts.filter(draft => courseId === 'all' || draft.courseId === courseId)
  const pending = learners.filter(learner => learner.status === 'submitted')
  const today = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())
  const createProject = () => navigate(`${base}/design/new`)
  const createDisabled = !data.courses.length || loading
  const courseCards = courses.map(course => {
    const list = activities.filter(activity => activity.courseId === course.id)
    return { ...course, activityCount: list.length, summary: preview
      ? `${data.learners.filter(learner => learner.courseId === course.id).length} 位合成学生`
      : `${list.reduce((sum, item) => sum + item.assigned, 0)} 条实际分配` }
  })
  return <>
    <TeacherPageHeading eyebrow={<>{today} <span>·</span> {preview ? '秋季学期 · 交互预览' : '教学空间'}</>}
      title="让每一次实践，都有下一步。" description="从项目设计到作品反馈，把注意力放在学生的具体表现上。"
      actionDisabled={createDisabled} onCreateProject={createProject} />
    <ScopeNotice />
    <TeacherOverviewStats stats={[
      { label: '任教课程', value: !preview && (loading || error) ? '—' : courses.length, unit: '门', icon: 'book-2', note: preview ? '按课程组织项目与教学反馈' : '来自当前教师会话' },
      { label: '开放活动', value: !preview && (loading || error) ? '—' : activities.filter(item => item.status === 'active').length, unit: '个', icon: 'folder-with-files', note: '固定版本，要求清晰可追溯' },
      { label: '等待审阅', value: loading || error ? '—' : pending.length, unit: '份', icon: 'clipboard-check', note: '实际固定提交；分配不代表开始学习' },
      { label: '设计草稿', value: loading || error ? '—' : drafts.length, unit: '个', icon: 'pen-new-square', note: '继续完善你的下一个项目' },
    ]} />
    <TeacherOverviewColumns>
      <TeacherAttentionPanel Link={Link} reviewTo={`${base}/review`} items={pending.map(learner => ({
        id: learner.id, name: learner.name, activityTitle: learner.activityTitle,
        avatarIndex: data.courses.findIndex(course => course.id === learner.courseId) % 2,
        to: `${base}/review?learner=${encodeURIComponent(learner.id)}`,
      }))} />
      <TeacherDesignCard Link={Link} draft={drafts[0] ? { title: drafts[0].title, revision: drafts[0].revision,
        sourceLabel: preview ? '本机预览草稿' : '课程草稿', to: `${base}/design/${drafts[0].id}` } : undefined}
        disabled={createDisabled} onCreateProject={createProject} />
    </TeacherOverviewColumns>
    <TeacherCoursesSection Link={Link} projectsTo={`${base}/projects`} courses={courseCards}
      onViewCourse={id => navigate(`${base}/projects?course=${encodeURIComponent(id)}`)} />
  </>
}

export function ProjectsPage() {
  const { data, base, courseId, setCourseId, preview } = useTeacher()
  const location = useLocation()
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState('all')
  const [selected, setSelected] = useState<TeacherActivity | null>(null)
  const effectiveCourse = new URLSearchParams(location.search).get('course') || courseId
  useEffect(() => {
    const requested = new URLSearchParams(location.search).get('course')
    if (requested && data.courses.some(course => course.id === requested)) {
      setCourseId(requested)
      navigate(`${base}/projects`, { replace: true })
    }
  }, [location.search, data.courses, setCourseId, base, navigate])
  const all = useMemo(() => [
    ...data.activities.map(activity => ({ ...activity, draft: false })),
    ...data.drafts.map(draft => ({ id: draft.id, courseId: draft.courseId, title: draft.title, description: draft.problem, status: 'draft' as const, version: draft.revision, assigned: 0, submitted: 0, reviewed: 0, due: '', draft: true })),
  ], [data.activities, data.drafts])
  const filtered = all.filter(item => (effectiveCourse === 'all' || item.courseId === effectiveCourse) && (tab === 'all' || item.status === tab) && `${item.title} ${item.description}`.toLowerCase().includes(query.toLowerCase()))
  const tabs = [['all', '全部'], ['active', '已开放'], ['draft', '草稿'], ['paused', '已暂停']].map(([id, label]) => ({
    id, label, count: all.filter(item => (effectiveCourse === 'all' || item.courseId === effectiveCourse) && (id === 'all' || item.status === id)).length,
  }))
  return <>
    <TeacherPageHeading eyebrow="PROJECTS & ACTIVITIES" title="项目与活动" description="从一个真实问题开始，让目标、任务和评价彼此连接。"
      actionDisabled={!data.courses.length} onCreateProject={() => navigate(`${base}/design/new`)} />
    <ScopeNotice />
    {effectiveCourse !== 'all' && <TeacherCourseFilter courseTitle={data.courses.find(course => course.id === effectiveCourse)?.title ?? effectiveCourse} onClear={() => { setCourseId('all'); navigate(`${base}/projects`) }} />}
    <TeacherProjectsToolbar tabs={tabs} selectedTab={tab} onSelectTab={setTab} query={query} onQueryChange={setQuery} />
    <TeacherProjectGrid>{filtered.map(activity => <ProjectCard key={activity.id}
      courseKind={data.courses.find(course => course.id === activity.courseId)?.kind ?? 'unknown'}
      courseTitle={data.courses.find(course => course.id === activity.courseId)?.title}
      statusTone={activity.status === 'active' ? 'progress' : activity.status === 'draft' ? 'neutral' : 'pending'}
      statusLabel={activity.status === 'active' ? '已开放' : activity.status === 'draft' ? '草稿' : '已暂停'}
      title={activity.title} description={activity.description}
      versionLabel={activity.version ? `${activity.draft ? '草稿 revision' : '来源 revision'} ${activity.version}` : '固定活动版本'}
      due={activity.due}
      numbers={activity.draft ? undefined : { assigned: activity.assigned,
        submitted: activity.submitted < 0 ? '—' : activity.submitted, reviewed: activity.reviewed < 0 ? '—' : activity.reviewed }}
      footer={activity.draft ? '继续编辑，确认后创建固定版本' : '已开始的尝试保持原活动版本'}
      actionLabel={activity.draft ? '继续设计' : '活动详情'}
      onAction={() => activity.draft ? navigate(`${base}/design/${activity.id}`) : setSelected(activity)}
    />)}</TeacherProjectGrid>
    {!filtered.length && <TeacherEmpty title={query ? '没有找到匹配的项目' : '这里还没有项目'}>{query ? '试试其他关键词，或切换活动状态。' : preview ? '设计一个新项目，先明确问题、目标与可观察表现。' : '设计一个新项目，保存后预览并分配给课程学生。'}</TeacherEmpty>}
    <TeacherDialog open={!!selected} onOpenChange={open => { if (!open) setSelected(null) }} title={selected?.title ?? '活动详情'} description="活动正文已固定。修改教学设计应创建新版本。">{selected && <ActivityDetail activity={selected} onClose={() => setSelected(null)} />}</TeacherDialog>
  </>
}

export function ActivityDetail({ activity, onClose }: { activity: TeacherActivity; onClose: () => void }) {
  const { data, preview } = useTeacher()
  const snapshot = activity.snapshot
  const workbench = data.workbenches?.find(w => w.courseId === activity.courseId)
  const fixed = workbench?.activities.find(a => a.activityVersionId === activity.id)
  const fixedView: TeacherFixedActivityView | undefined = fixed && {
    audience: fixed.content.content.audience, artifact: fixed.content.content.artifact, routes: fixed.content.content.routes,
    goals: fixed.content.content.goals.map(goal => ({ id: goal.competencyId, title: goal.title, domain: goal.domain, version: goal.competencyVersion })),
    tasks: fixed.content.content.tasks.map(task => ({ id: task.taskId, title: task.title })),
    milestones: fixed.content.content.milestones.map(milestone => ({ id: milestone.milestoneId, title: milestone.title })),
    rubric: fixed.content.content.rubricCriteria.map(item => ({ id: item.criterionId, description: item.description })),
    helpPolicy: fixed.helpPolicy.description,
    materials: fixed.content.materials.map((material, index) => material.status === 'available'
      ? { status: material.status, id: material.resourceVersionId, title: material.title, text: material.text }
      : { status: material.status, id: String(index) }),
    assignments: (workbench?.assignments ?? []).filter(assignment => assignment.activityVersionId === fixed.activityVersionId)
      .map(assignment => ({ id: assignment.assignmentId, name: workbench?.members.find(member => member.userId === assignment.studentId)?.displayName || assignment.studentId, active: assignment.active })),
  }
  return <TeacherActivityDetail statusLabel={activity.status === 'active' ? '已开放' : '已暂停'} statusTone={activity.status === 'active' ? 'progress' : 'pending'}
    description={activity.description} activityId={activity.id} courseTitle={data.courses.find(course => course.id === activity.courseId)?.title}
    assigned={activity.assigned} versionLabel={activity.version ? `来源蓝图 revision ${activity.version}` : '不可变活动版本'} fixed={fixedView}
    snapshot={snapshot ? { revision: snapshot.revision, audience: snapshot.audience, deliverable: snapshot.deliverable, choices: snapshot.choices,
      foundation: snapshot.foundation, duration: snapshot.duration, goals: snapshot.goals, milestones: snapshot.milestones, rubric: snapshot.rubric,
      helpPolicy: snapshot.helpPolicy, materials: activity.resourceVersions ?? [] } : undefined}
    previewAssignments={activity.studentIds?.map(id => ({ id, name: data.learners.find(learner => learner.id === id)?.name ?? id }))}
    showPreviewSummaryNote={!snapshot && preview} onClose={onClose} />
}
