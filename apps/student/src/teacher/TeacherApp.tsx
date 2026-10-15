import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { Icon } from '../icons'
import { XunjieLogo } from '../brand/XunjieLogo'
import { setThemePreference, useTheme } from '../lib/theme'
import { useSession } from '../components/SessionEntry'
import { logoutSession } from '../workspace/session'
import { TeacherContext, useTeacher } from './context'
import { loadTeacherWorkbenchData, onTeacherCommandsChanged, pendingTeacherCommands, resourceFromWire, retryTeacherCommands, teacherCommand } from './backend'
import type { DesignResult } from './wire'
import { CourseMark, TeacherBadge, TeacherButton, TeacherDialog, TeacherEmpty } from './ui'
import type { DesignDraft, TeacherActivity, TeacherData, TeacherLearner, TeacherResource, TeacherWorkspace } from './types'
import './teacher.css'

const DesignPage = lazy(() => import('./DesignPage'))
const ReviewPage = lazy(() => import('./ReviewPage'))
const LiveDesignPage = lazy(() => import('./LiveDesignPage'))
const LiveReviewPage = lazy(() => import('./LiveReviewPage'))
const MaterialsPage = lazy(() => import('./MaterialsPage'))
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
  return <TeacherContext.Provider value={context}>
    <div className={`teacher-shell${collapsed ? ' t-collapsed' : ''}`}>
      <a className="t-skip" href="#teacher-main" onClick={event => { event.preventDefault(); scrollRegion.current?.focus() }}>跳到主要内容</a>
      <aside className="t-sidebar" aria-label="教师导航">
        <Link className="t-brand" to={base}><XunjieLogo label="循阶" /><span>循阶<span>教师工作台</span></span></Link>
        <div className="t-space"><span className="t-space-icon"><Icon name="learning-space" size={20} /></span><div>教学空间<small>{preview ? '2026 秋季学期' : '我的任教课程'}</small></div><TeacherBadge>教师</TeacherBadge></div>
        <div className="t-nav-label">工作空间</div>
        <nav>
          <NavLink aria-label="教学概览" end to={base}><Icon name="home-2" size={19} /><span>教学概览</span></NavLink>
          <NavLink aria-label="项目与活动" to={`${base}/projects`}><Icon name="folder-with-files" size={19} /><span>项目与活动</span></NavLink>
          <NavLink aria-label="学生与审阅" to={`${base}/review`}><Icon name="clipboard-check" size={19} /><span>学生与审阅</span>{preview && data.learners.some(item => item.status === 'submitted') && <small>{data.learners.filter(item => item.status === 'submitted').length}</small>}</NavLink>
          <NavLink aria-label="课程材料" to={`${base}/materials`}><Icon name="book-2" size={19} /><span>课程材料</span></NavLink>
        </nav>
        <div className="t-nav-label t-course-label">我的课程</div>
        <div className="t-sidebar-courses">{data.courses.map(course => <button key={course.id} className={courseId === course.id ? 'selected' : ''} onClick={() => setCourseId(courseId === course.id ? 'all' : course.id)} aria-pressed={courseId === course.id} title={course.title}>
          <span className={`t-course-dot ${course.kind === 'hdl' ? 'hdl' : ''}`} /><span>{course.title}</span>
        </button>)}</div>
        <div className="t-sidebar-bottom">
          <NavLink aria-label="工作台设置" to={`${base}/settings`}><Icon name="settings" size={19} /><span>工作台设置</span></NavLink>
          <Link aria-label="学生空间入口" to="/"><Icon name="arrow-left" size={18} /><span>学生空间入口</span></Link>
          <div className="t-account"><span className="t-avatar">教</span><div>{preview ? '教师预览' : session.session?.displayName || '教师账号'}<small>{preview ? '隔离合成数据' : session.session?.userId}</small></div>
            {preview ? <Link to="/teacher" title="登录真实工作台" aria-label="登录真实工作台"><Icon name="logout-2" /></Link> : <button className="t-icon-button" title="退出登录" aria-label="退出登录" onClick={() => { void logoutSession() }}><Icon name="logout-2" /></button>}
          </div>
        </div>
      </aside>
      <main className="t-main" id="teacher-main" ref={scrollRegion} tabIndex={-1}>
        <header className="t-topbar"><div className="t-breadcrumb"><button className="t-icon-button" aria-label={collapsed ? '展开导航' : '收起导航'} aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}><Icon name="panel-left-close" size={18} /></button><span>教师工作台</span><span className="t-slash">/</span><strong>{sectionNames[section] ?? '页面'}</strong></div>
          <div className="t-topbar-actions"><label className="t-course-select"><span className="t-sr-only">当前课程</span><select aria-label="当前课程" value={courseId} onChange={event => setCourseId(event.target.value)}><option value="all">全部课程</option>{data.courses.map(course => <option key={course.id} value={course.id}>{course.title}</option>)}</select></label><button className="t-icon-button" aria-label={resolved === 'dark' ? '切换浅色模式' : '切换深色模式'} onClick={() => setThemePreference(resolved === 'dark' ? 'light' : 'dark')}><Icon name={resolved === 'dark' ? 'sun' : 'moon'} size={18} /></button></div>
        </header>
        {preview && <div className="t-preview-note"><span><Icon name="info-circle" size={15} />交互预览 · 数据为合成示例，操作仅保存在本机</span><Link to="/teacher">进入真实工作台<Icon name="arrow-right" size={14} /></Link></div>}
        {!preview && teacher && <div className="t-command-note"><span>{pendingCount ? `${pendingCount} 个原教师操作待核对，编辑暂时保留。` : '教师操作使用当前课程版本；网络结果未知时保留原请求。'}</span><TeacherButton disabled={retrying} onClick={() => { void context.retryPending?.() }}>核对原教师操作</TeacherButton></div>}
        <div className="t-page" key={section}>
          {!teacher ? <TeacherEmpty title="当前账号没有教师课程">请使用课程提供的教师账号登录。课程角色由教学服务确认。</TeacherEmpty> : <Suspense fallback={<div className="t-loading" role="status">正在打开工作台…</div>}>
            <Routes>
              <Route index element={<OverviewPage />} />
              <Route path="projects" element={<ProjectsPage />} />
              <Route path="design/:draftId" element={preview ? <DesignPage /> : <LiveDesignPage />} />
              <Route path="review" element={preview ? <ReviewPage /> : <LiveReviewPage />} />
              <Route path="materials" element={<MaterialsPage />} />
              <Route path="settings" element={<TeacherSettings />} />
              <Route path="*" element={<TeacherEmpty title="没有找到这个页面"><Link to={base}>返回教学概览</Link></TeacherEmpty>} />
            </Routes>
          </Suspense>}
        </div>
      </main>
      {toast && <div className="t-toast" role="status"><Icon name="check-circle" size={17} />{toast}<button aria-label="关闭提示" onClick={() => setToast('')}><Icon name="close" size={15} /></button></div>}
    </div>
  </TeacherContext.Provider>
}

function ScopeNotice() {
  const { preview, error, loading, refresh } = useTeacher()
  if (preview) return null
  return <div className={`t-scope-note${error ? ' error' : ''}`} role={error ? 'alert' : 'status'}><Icon name={error ? 'danger-triangle' : 'info-circle'} size={18} /><div>{error ? '课程数据未能读取' : loading ? '正在读取任教课程…' : '已连接当前教学服务'}<p>{error || '设计、分配与反馈由服务端保存。学生进展来自实际尝试，能力判断保留证据与未知。'}</p></div><TeacherButton onClick={refresh} disabled={loading} icon="refresh">重新读取</TeacherButton></div>
}

function OverviewPage() {
  const { data, base, preview, courseId, loading, error } = useTeacher()
  const navigate = useNavigate()
  const courses = data.courses.filter(course => courseId === 'all' || course.id === courseId)
  const activities = data.activities.filter(activity => courseId === 'all' || activity.courseId === courseId)
  const learners = data.learners.filter(learner => courseId === 'all' || learner.courseId === courseId)
  const drafts = data.drafts.filter(draft => courseId === 'all' || draft.courseId === courseId)
  const pending = learners.filter(learner => learner.status === 'submitted')
  const today = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date())
  return <>
    <div className="t-heading"><div><div className="t-eyebrow">{today} <span>·</span> {preview ? '秋季学期 · 交互预览' : '教学空间'}</div><h1>让每一次实践，都有下一步。</h1><p>从项目设计到作品反馈，把注意力放在学生的具体表现上。</p></div><TeacherButton primary icon="add" disabled={!data.courses.length || loading} onClick={() => navigate(`${base}/design/new`)}>设计新项目</TeacherButton></div>
    <ScopeNotice />
    <section className="t-stats" aria-label="教学摘要">
      {[
        { label: '任教课程', value: !preview && (loading || error) ? '—' : courses.length, unit: '门', icon: 'book-2' as const, note: preview ? '按课程组织项目与教学反馈' : '来自当前教师会话' },
        { label: '开放活动', value: !preview && (loading || error) ? '—' : activities.filter(item => item.status === 'active').length, unit: '个', icon: 'folder-with-files' as const, note: '固定版本，要求清晰可追溯' },
        { label: '等待审阅', value: loading || error ? '—' : pending.length, unit: '份', icon: 'clipboard-check' as const, note: '实际固定提交；分配不代表开始学习' },
        { label: '设计草稿', value: loading || error ? '—' : drafts.length, unit: '个', icon: 'pen-new-square' as const, note: '继续完善你的下一个项目' },
      ].map(stat => <div className="t-stat" key={stat.label}><div><span>{stat.label}</span><Icon name={stat.icon} size={18} /></div><strong>{stat.value}<small>{stat.unit}</small></strong><p>{stat.note}</p></div>)}
    </section>
    <div className="t-overview-columns">
      <section className="t-panel"><div className="t-section-heading"><h2>需要你关注</h2><Link to={`${base}/review`}>查看全部<Icon name="alt-arrow-right" size={15} /></Link></div>
        {pending.length ? <div className="t-attention-list">{pending.map(learner => <Link key={learner.id} className="t-attention-row" to={`${base}/review?learner=${encodeURIComponent(learner.id)}`}><span className={`t-avatar t-avatar-${data.courses.findIndex(course => course.id === learner.courseId) % 2}`}>{learner.name[0]}</span><div><strong>{learner.name}<TeacherBadge tone="pending">待审阅</TeacherBadge></strong><p>{learner.activityTitle} · 固定提交 v{learner.version}</p></div><Icon name="alt-arrow-right" size={17} /></Link>)}</div> : <div className="t-inline-empty"><Icon name="clipboard-check" size={24} /><p>当前没有等待审阅的提交</p></div>}
        <div className="t-panel-foot"><Icon name="info-circle" size={15} /><span>作品结果、实际帮助与能力判断分别查看。</span></div>
      </section>
      <section className="t-panel t-design-card"><div className="t-section-heading"><h2>下一次好项目，从这里开始</h2><span className="t-quiet-icon"><Icon name="lightbulb" size={23} /></span></div><p>把课程目标、探索空间和评价依据，放进同一份可编辑的项目蓝图。</p>
        <div className="t-design-steps"><span><i>01</i>提供材料</span><Icon name="arrow-right" size={14} /><span><i>02</i>完善蓝图</span><Icon name="arrow-right" size={14} /><span><i>03</i>预览分配</span></div>
        {drafts[0] ? <Link className="t-resume-draft" to={`${base}/design/${drafts[0].id}`}><span><Icon name="file-text" size={19} /><span><strong>{drafts[0].title}</strong><small>{preview ? '本机预览草稿' : '课程草稿'} · revision {drafts[0].revision}</small></span></span><Icon name="arrow-right" size={18} /></Link> : <TeacherButton icon="add" disabled={!data.courses.length || loading} onClick={() => navigate(`${base}/design/new`)}>从新项目开始</TeacherButton>}
      </section>
    </div>
    <section><div className="t-section-heading t-course-heading"><div><h2>我的课程</h2><p>围绕课程组织活动、材料与教学反馈。</p></div><Link to={`${base}/projects`}>管理项目<Icon name="alt-arrow-right" size={15} /></Link></div>
      <div className="t-courses-grid">{courses.map(course => {
        const list = activities.filter(activity => activity.courseId === course.id)
        return <article className="t-course-card" key={course.id}><div className={`t-course-cover ${course.kind === 'hdl' ? 'hdl' : ''}`}><CourseMark kind={course.kind} /><span>{course.code || 'COURSE'}</span><div className="t-course-geometry" aria-hidden="true" /></div><div className="t-course-card-body"><div><h3>{course.title}</h3><TeacherBadge>{list.length} 个活动</TeacherBadge></div><p>{course.term || course.id}</p><div className="t-course-card-bottom"><span>{preview ? `${data.learners.filter(learner => learner.courseId === course.id).length} 位合成学生` : `${list.reduce((sum, item) => sum + item.assigned, 0)} 条实际分配`}</span><TeacherButton onClick={() => navigate(`${base}/projects?course=${encodeURIComponent(course.id)}`)}>查看活动<Icon name="arrow-right" size={14} /></TeacherButton></div></div></article>
      })}</div>{!courses.length && <TeacherEmpty title="暂无可显示的任教课程">课程信息以当前教学服务的会话和授权为准。</TeacherEmpty>}
    </section>
  </>
}

function ProjectsPage() {
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
  return <>
    <div className="t-heading"><div><div className="t-eyebrow">PROJECTS & ACTIVITIES</div><h1>项目与活动</h1><p>从一个真实问题开始，让目标、任务和评价彼此连接。</p></div><TeacherButton primary icon="add" disabled={!data.courses.length} onClick={() => navigate(`${base}/design/new`)}>设计新项目</TeacherButton></div>
    <ScopeNotice />
    {effectiveCourse !== 'all' && <div className="t-course-filter">当前课程：{data.courses.find(course => course.id === effectiveCourse)?.title ?? effectiveCourse}<button onClick={() => { setCourseId('all'); navigate(`${base}/projects`) }}>清除页面筛选<Icon name="close" size={13} /></button></div>}
    <div className="t-toolbar"><div className="t-tabs" aria-label="活动状态">{[['all', '全部'], ['active', '已开放'], ['draft', '草稿'], ['paused', '已暂停']].map(([key, label]) => <button key={key} aria-pressed={key === tab} className={key === tab ? 'active' : ''} onClick={() => setTab(key)}>{label}<small>{all.filter(item => (effectiveCourse === 'all' || item.courseId === effectiveCourse) && (key === 'all' || item.status === key)).length}</small></button>)}</div><label className="t-search"><Icon name="minimalistic-magnifier" size={17} /><input aria-label="搜索项目" placeholder="搜索项目名称或内容" value={query} onChange={event => setQuery(event.target.value)} />{query && <button aria-label="清除搜索" onClick={() => setQuery('')}><Icon name="close" size={14} /></button>}</label></div>
    <div className="t-project-grid">{filtered.map(activity => <article className="t-project-card" key={activity.id}>
      <div className="t-project-card-top"><CourseMark kind={data.courses.find(course => course.id === activity.courseId)?.kind ?? 'unknown'} /><TeacherBadge tone={activity.status === 'active' ? 'progress' : activity.status === 'draft' ? 'neutral' : 'pending'}>{activity.status === 'active' ? '已开放' : activity.status === 'draft' ? '草稿' : '已暂停'}</TeacherBadge></div><div className="t-eyebrow">{data.courses.find(course => course.id === activity.courseId)?.title}</div><h2>{activity.title}</h2><p>{activity.description}</p><div className="t-project-metadata"><span><Icon name="copy" size={14} />{activity.version ? `${activity.draft ? '草稿 revision' : '来源 revision'} ${activity.version}` : '固定活动版本'}</span>{activity.due && <span><Icon name="calendar" size={14} />{activity.due}</span>}</div>
      {!activity.draft && <div className="t-project-numbers"><span><b>{activity.assigned}</b>已分配</span><span><b>{activity.submitted < 0 ? '—' : activity.submitted}</b>已提交</span><span><b>{activity.reviewed < 0 ? '—' : activity.reviewed}</b>已审阅</span></div>}
      <div className="t-project-card-footer"><span>{activity.draft ? '继续编辑，确认后创建固定版本' : '已开始的尝试保持原活动版本'}</span><TeacherButton onClick={() => activity.draft ? navigate(`${base}/design/${activity.id}`) : setSelected(activity)}>{activity.draft ? '继续设计' : '活动详情'}<Icon name="arrow-right" size={14} /></TeacherButton></div>
    </article>)}</div>
    {!filtered.length && <TeacherEmpty title={query ? '没有找到匹配的项目' : '这里还没有项目'}>{query ? '试试其他关键词，或切换活动状态。' : preview ? '设计一个新项目，先明确问题、目标与可观察表现。' : '设计一个新项目，保存后预览并分配给课程学生。'}</TeacherEmpty>}
    <TeacherDialog open={!!selected} onOpenChange={open => { if (!open) setSelected(null) }} title={selected?.title ?? '活动详情'} description="活动正文已固定。修改教学设计应创建新版本。">{selected && <ActivityDetail activity={selected} onClose={() => setSelected(null)} />}</TeacherDialog>
  </>
}

function ActivityDetail({ activity, onClose }: { activity: TeacherActivity; onClose: () => void }) {
  const { data, preview } = useTeacher()
  const snapshot = activity.snapshot
  const workbench = data.workbenches?.find(w => w.courseId === activity.courseId)
  const fixed = workbench?.activities.find(a => a.activityVersionId === activity.id)
  return <div className="t-activity-detail">
    <TeacherBadge tone={activity.status === 'active' ? 'progress' : 'pending'}>{activity.status === 'active' ? '已开放' : '已暂停'}</TeacherBadge>
    <p>{activity.description}</p>
    <dl><dt>活动标识</dt><dd>{activity.id}</dd><dt>课程</dt><dd>{data.courses.find(course => course.id === activity.courseId)?.title}</dd><dt>已分配</dt><dd>{activity.assigned} 位学生</dd><dt>版本</dt><dd>{activity.version ? `来源蓝图 revision ${activity.version}` : '不可变活动版本'}</dd></dl>
    {fixed && <div className="t-fixed-design">
      <h3>固定活动要求</h3><dl><dt>项目受众</dt><dd>{fixed.content.content.audience || '未填写'}</dd><dt>最终产物</dt><dd>{fixed.content.content.artifact || '未填写'}</dd><dt>选择空间</dt><dd>{fixed.content.content.routes.join('；')}</dd></dl>
      <h3>目标与版本</h3>{fixed.content.content.goals.map(g => <div className="t-fixed-item" key={g.competencyId}><strong>{g.title}</strong><small>{g.domain} · v{g.competencyVersion}</small></div>)}
      <h3>任务与里程碑</h3>{fixed.content.content.tasks.map(t => <p key={t.taskId}>{t.title}</p>)}{fixed.content.content.milestones.map(m => <p key={m.milestoneId}>{m.title}</p>)}
      <h3>评价依据</h3>{fixed.content.content.rubricCriteria.map(r => <p key={r.criterionId}>{r.description}</p>)}
      <h3>帮助政策</h3><p>{fixed.helpPolicy.description}</p>
      <h3>固定材料 · 教师视角</h3>{fixed.content.materials.map((m, index) => m.status === 'available' ? <details key={m.resourceVersionId}><summary>{m.title}</summary><pre className="t-rm-document-content">{m.text}</pre><small>{m.resourceVersionId}</small></details> : <p key={index}>{m.status === 'redacted' ? '按角色隐藏' : '该版本材料不可用'}</p>)}
      <h3>已分配学生</h3>{workbench?.assignments.filter(a => a.activityVersionId === fixed.activityVersionId).map(a => <p key={a.assignmentId}>{workbench.members.find(m => m.userId === a.studentId)?.displayName || a.studentId} · {a.active ? '分配有效' : '分配暂停'}</p>)}
    </div>}
    {snapshot && <div className="t-fixed-design">
      <h3>固定活动要求</h3><p>本机预览固定于蓝图 revision {snapshot.revision}。后续草稿编辑不会改写此处的要求和材料版本。</p>
      <dl><dt>项目受众</dt><dd>{snapshot.audience}</dd><dt>最终产物</dt><dd>{snapshot.deliverable}</dd><dt>选择空间</dt><dd>{snapshot.choices}</dd><dt>前置基础</dt><dd>{snapshot.foundation}</dd><dt>预计时长</dt><dd>{snapshot.duration}</dd></dl>
      <h3>目标与可观察表现</h3>{snapshot.goals.map(goal => <div className="t-fixed-item" key={goal.id}><strong>{goal.title}</strong><p>{goal.evidence}</p></div>)}
      <h3>里程碑</h3>{snapshot.milestones.map(item => <div className="t-fixed-item" key={item.id}><strong>{item.title}</strong><p>{item.evidence}</p></div>)}
      <h3>评价量规</h3>{snapshot.rubric.map(item => <div className="t-fixed-item" key={item.id}><strong>{item.criterion}</strong><p>{item.description}</p></div>)}
      <h3>帮助政策</h3><p>{snapshot.helpPolicy}</p>
      <h3>固定材料版本 · 教师视角</h3>{activity.resourceVersions?.length ? activity.resourceVersions.map(resource => <details key={resource.id}><summary>{resource.title} · v{resource.version}</summary><p>{resource.content}</p><small>学生{resource.student ? '可见' : '不可见'} · 辅导{resource.tutor ? '可用' : '不可用'} · 设计 AI {resource.teacherDesign ? '可用' : '不可用'}</small></details>) : <p>本版本没有关联材料。</p>}
    </div>}
    {activity.studentIds && <section className="t-fixed-assignments"><h3>已分配学生</h3><p>分配关系已在本机预览固定。分配不会代学生创建或开始尝试。</p><ul>{activity.studentIds.map(id => <li key={id}><span>{data.learners.find(learner => learner.id === id)?.name ?? id}</span><small>{id}</small><TeacherBadge>等待学生开始</TeacherBadge></li>)}</ul></section>}
    {!snapshot && preview && <p className="t-detail-note">这是预置活动摘要。完整版本回看可通过设计草稿的“预览与分配”创建。</p>}
    <div className="t-dialog-footer"><TeacherButton primary onClick={onClose}>完成</TeacherButton></div>
  </div>
}

function TeacherSettings() {
  const { preview, data, notify } = useTeacher()
  const { preference } = useTheme()
  function exportPreview() {
    const file = new Blob([JSON.stringify({ source: 'isolated-teacher-ui-preview', exportedAt: new Date().toISOString(), data }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(file)
    const link = document.createElement('a')
    link.href = url; link.download = 'xunjie-teacher-preview.json'; link.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    notify('已导出本机预览，不包含真实教学记录。')
  }
  return <><div className="t-heading"><div><div className="t-eyebrow">WORKSPACE PREFERENCES</div><h1>工作台设置</h1><p>让工作空间适合你的教学节奏。</p></div></div><div className="t-settings-stack">
    <section className="t-panel"><div className="t-section-heading"><h2>外观</h2><Icon name="sun" size={20} /></div><div className="t-settings-row"><div><strong>显示主题</strong><p>与学生空间共享外观偏好，刷新后仍保留。</p></div><select aria-label="显示主题" value={preference} onChange={event => setThemePreference(event.target.value as 'light' | 'dark' | 'system')}><option value="light">浅色</option><option value="dark">深色</option><option value="system">跟随系统</option></select></div></section>
    <section className="t-panel"><div className="t-section-heading"><h2>数据与使用范围</h2><Icon name="shield-check" size={20} /></div><div className="t-settings-row"><div><strong>{preview ? '当前为隔离交互预览' : '当前为真实教学入口'}</strong><p>{preview ? '示例学生、作品、材料和判断均为合成数据。修改保存在当前标签页的预览存储中，不写入课程。' : '仅使用服务端会话授予的教师课程。数据读取失败会明确提示，不切换为示例数据。'}</p></div><TeacherBadge tone={preview ? 'pending' : 'progress'}>{preview ? '合成预览' : '真实课程'}</TeacherBadge></div>{preview && <div className="t-settings-row"><div><strong>导出预览内容</strong><p>保留你调整的项目蓝图、示例材料与审阅内容，便于讨论设计。</p></div><TeacherButton icon="download-minimalistic" onClick={exportPreview}>导出 JSON</TeacherButton></div>}</section>
    <section className="t-panel"><div className="t-section-heading"><h2>教学判断与证据</h2><Icon name="book-2" size={20} /></div><p className="t-settings-copy">作品表现、学科知识、项目能力、AI 协作与实际帮助分别呈现。教师正式评价需要理由与引用；没有观察时保留未知。过程空窗、系统外帮助和模型建议均不转换为独立掌握证明。</p></section>
  </div></>
}
