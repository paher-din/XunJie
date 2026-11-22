import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import { CourseBreadcrumb, CourseTiles, HomeSectionHeading, HomeStatus } from '@xunjie/ui/home'
import { ConfirmationDialog } from '@xunjie/ui/foundation'
import { SettingsStatus } from '@xunjie/ui/settings'
import { ProductShell } from '../components/ProductShell'
import { Icon } from '../icons'
import { ProductSettings, type ProductSettingsTab } from '../product/ProductSettings'
import { SchoolConnectionRow } from '../product/SchoolConnectionRows'
import { SettingsFailureBoundary } from '../product/SettingsFailureBoundary'
import { useModelSelection } from '../product/ModelSelection'
import { LearningReadCache } from '../product/learning-read-cache'
import './teacher-space.css'
import {
  latestTaskOf, loadTeacherCatalog, submissionLabel, teacherCohort,
  type SubmissionState, type TeacherCatalog, type TeacherCourse, type TeacherDraft, type TeacherRelease, type TeacherSubmission, type TeacherTask,
} from './data'
import { clearTeacherCache, readTeacherCache, writeTeacherCache, type TeacherContext } from './teacher-cache'

const PersonalModelSettings = lazy(() => import('../product/PersonalModelSettings').then(module => ({ default: module.PersonalModelSettings })))

type TeacherView = 'overview' | 'workbench'
type InboxKind = 'pending' | 'revised' | 'draft' | 'stalled'
type InboxAction = 'review' | 'design' | 'workbench'

interface InboxPerson { name: string; time: string }
interface InboxRow {
  key: string
  kind: InboxKind
  label: string
  title: string
  course: string
  people?: InboxPerson[]
  objectLabel?: string
  objectMeta?: string
  action: InboxAction
  courseId?: string
  ariaLabel: string
}

interface CoursePulseRowData {
  course: TeacherCourse
  task: TeacherTask | null
  release: TeacherRelease | null
  submitted: number
  assigned: number
  missing: number
  statusCounts: Record<SubmissionState, number>
}

const dateText = (iso: string) => {
  const date = new Date(iso)
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日`
}

const timeText = (iso: string) => {
  const date = new Date(iso)
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const releaseAgeText = (iso: string) => {
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return '发布日期未知'
  const days = Math.max(0, Math.floor((Date.now() - time) / 86_400_000))
  return days === 0 ? '今天发布' : `发布 ${days} 天`
}

const isFreshRelease = (iso: string) => {
  const time = new Date(iso).getTime()
  return Number.isFinite(time) && Date.now() - time < 2 * 86_400_000
}

const percentOf = (part: number, total: number) => total ? Math.round(part / total * 100) : null

const PULSE_STATES: SubmissionState[] = ['done', 'revised', 'pending', 'feedback']
const PULSE_STATE_LABELS: Record<SubmissionState, string> = {
  done: '已完成', revised: '待复核', pending: '待审阅', feedback: '已反馈',
}

const PULSE_SEGMENTS = 40
/** Allocate the 40 fixed-height segments by status share; the exact numbers stay beside the bar. */
function pulseMeter(item: CoursePulseRowData) {
  if (!item.task || item.assigned <= 0) return Array.from({ length: PULSE_SEGMENTS }, () => 'missing' as const)
  const groups = [...PULSE_STATES.map(state => ({ state, count: item.statusCounts[state] })), { state: 'missing' as const, count: item.missing }]
  const raw = groups.map(group => group.count / item.assigned * PULSE_SEGMENTS)
  const cells = raw.map(value => Math.floor(value))
  let remainder = PULSE_SEGMENTS - cells.reduce((sum, value) => sum + value, 0)
  const fractions = raw.map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index)
  for (let index = 0; index < fractions.length && remainder > 0; index += 1) {
    cells[fractions[index]!.index] += 1
    remainder -= 1
  }
  return groups.flatMap((group, index) => Array.from({ length: cells[index] ?? 0 }, () => group.state))
}

/** One row is one decision unit: a task with its waiting submissions, or one draft. */
function reviewInboxRows(courses: TeacherCourse[], submissions: TeacherSubmission[], kind: 'pending' | 'revised'): InboxRow[] {
  const groups = new Map<string, { courseId: string; taskId: string; latest: string; people: Map<string, string> }>()
  for (const submission of submissions) {
    if (submission.state !== kind) continue
    const key = `${submission.courseId}:${submission.taskId}`
    let group = groups.get(key)
    if (!group) {
      group = { courseId: submission.courseId, taskId: submission.taskId, latest: submission.submittedAt, people: new Map() }
      groups.set(key, group)
    }
    if (submission.submittedAt > group.latest) group.latest = submission.submittedAt
    const prior = group.people.get(submission.studentName)
    if (!prior || submission.submittedAt > prior) group.people.set(submission.studentName, submission.submittedAt)
  }
  return [...groups.values()]
    .sort((a, b) => b.latest.localeCompare(a.latest))
    .map(group => ({
      key: `${kind}:${group.courseId}:${group.taskId}`,
      kind,
      label: kind === 'pending' ? '待审阅' : '待复核',
      title: taskTitleOf(courses, group.taskId),
      course: courseName(courses, group.courseId),
      people: [...group.people.entries()].map(([name, submittedAt]) => ({ name, time: timeText(submittedAt) })),
      action: 'review',
      courseId: group.courseId,
      ariaLabel: `${kind === 'pending' ? '审阅' : '复核'}${taskTitleOf(courses, group.taskId)}（${courseName(courses, group.courseId)}）`,
    }))
}

export function TeacherSpace() {
  const initialCache = useMemo(() => readTeacherCache(), [])
  const [context, setContext] = useState<TeacherContext | null>(initialCache?.context ?? null)
  const [catalog, setCatalog] = useState<TeacherCatalog | null>(initialCache?.catalog ?? null)
  const [error, setError] = useState('')
  const [view, setView] = useState<TeacherView>(() => new URLSearchParams(location.search).get('teacher') === 'workbench' ? 'workbench' : 'overview')
  const [courseId, setCourseId] = useState<string | null>(null)
  const [courseTab, setCourseTab] = useState<'review' | 'design'>('review')
  const [courseTaskId, setCourseTaskId] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<ProductSettingsTab>('account')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    fetch('/api/learning/context', { credentials: 'same-origin' }).then(async response => {
      if (!response.ok) throw new Error('教学空间暂时无法连接。')
      const value = await response.json() as TeacherContext
      if (cancelled) return
      const changed = initialCache && (value.clientNamespace !== initialCache.context.clientNamespace
        || value.account?.key !== initialCache.context.account?.key)
      if (changed) { setCatalog(null); clearTeacherCache() }
      if (!value.account) { setCatalog(null); clearTeacherCache() }
      setError(''); setContext(value)
    }).catch(reason => {
      if (cancelled) return
      // A failed context check invalidates the painted cache; it must not keep
      // showing a previous account's workspace behind an error.
      clearTeacherCache(); setContext(null); setCatalog(null)
      setError(reason instanceof Error ? reason.message : '教学空间暂时无法连接。')
    })
    return () => { cancelled = true }
  }, [attempt, initialCache])

  useEffect(() => {
    if (!context?.account?.key) return
    let cancelled = false
    loadTeacherCatalog(context.clientNamespace, context.account.key)
      .then(value => {
        if (cancelled) return
        setCatalog(value)
        if (value.available) writeTeacherCache(context, value)
        else clearTeacherCache()
      })
      .catch(reason => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '课程目录暂时无法读取。')
      })
    return () => { cancelled = true }
  }, [context, attempt])

  // A non-teacher account belongs to the student surface, including after logout.
  useEffect(() => {
    if (context && !context.account) location.replace('/')
  }, [context])
  useEffect(() => {
    if (catalog && !catalog.available) location.replace('/')
  }, [catalog])

  const cohort = useMemo(() => teacherCohort(catalog?.courses ?? []), [catalog])

  const retry = () => { clearTeacherCache(); setError(''); setContext(null); setCatalog(null); setAttempt(value => value + 1) }
  const content = !context ? <div className="content teacher-page">
    {error ? <div role="alert" className="t-inline-error"><p>{error}</p><button type="button" className="outline" onClick={retry}>重试</button></div>
      : <p role="status" className="t-loading">正在打开教学空间…</p>}
  </div> : !context.account ? <div className="content teacher-page">
    <p role="status" className="t-loading">正在返回学生端…</p>
  </div> : !catalog ? <div className="content teacher-page">
    {error ? <div role="alert" className="t-inline-error"><p>{error}</p><button type="button" className="outline" onClick={retry}>重试</button></div>
      : <p role="status" className="t-loading">正在打开教学空间…</p>}
  </div> : !catalog.available ? <div className="content teacher-page">
    <p role="status" className="t-loading">正在返回学生端…</p>
  </div> : <TeacherWorkspace catalog={catalog} cohort={cohort} view={view} courseId={courseId} courseTab={courseTab} courseTaskId={courseTaskId}
    onView={next => { setView(next); if (next === 'overview') setCourseId(null); setCourseTaskId(null) }}
    onCourse={(id, tab = 'review', taskId = null) => { setCourseId(id); setCourseTab(tab); setCourseTaskId(taskId); setView('workbench') }}
    onBackToCourses={() => { setCourseId(null); setCourseTaskId(null) }} />

  return <>
    {catalog?.available && context?.account ? <ProductShell immersive={false} brandRole="教师" accountName={context.account.accountName}
      active={settingsOpen ? 'settings' : undefined}
      onHome={() => { setSettingsOpen(false); setView('overview'); setCourseId(null); setCourseTaskId(null) }}
      onAgent={() => {}}
      onSettings={() => setSettingsOpen(true)}
      navItems={[{ id: 'overview', label: '教学概览', icon: 'home-2', activeIcon: 'home-2' },
        { id: 'workbench', label: '工作台', icon: 'workbench', activeIcon: 'workbench' }]}
      onNavItem={id => { setSettingsOpen(false); setView(id as TeacherView); setCourseId(null); setCourseTaskId(null) }}
      activeNavItem={settingsOpen ? undefined : view}>
      {settingsOpen ? <TeacherSettingsPage context={context} account={context.account} tab={settingsTab}
        onTab={setSettingsTab} onClose={() => setSettingsOpen(false)} /> : content}
    </ProductShell> : content}
  </>
}

function TeacherWorkspace({ catalog, cohort, view, courseId, courseTab, courseTaskId, onView, onCourse, onBackToCourses }: {
  catalog: TeacherCatalog; cohort: ReturnType<typeof teacherCohort>
  view: TeacherView; courseId: string | null; courseTab: 'review' | 'design'; courseTaskId: string | null
  onView: (view: TeacherView) => void; onCourse: (id: string, tab?: 'review' | 'design', taskId?: string | null) => void; onBackToCourses: () => void
}) {
  const course = catalog.courses.find(item => item.courseId === courseId)
  if (course) return <CourseWorkspace key={course.courseId + courseTab + (courseTaskId ?? '')} course={course} cohort={cohort} initialTab={courseTab} initialTaskId={courseTaskId} onBack={onBackToCourses} />
  return view === 'overview'
    ? <Overview courses={catalog.courses} cohort={cohort} onCourse={onCourse} onWorkbench={() => onView('workbench')} />
    : <Workbench courses={catalog.courses} cohort={cohort} onCourse={onCourse} />
}

function Overview({ courses, cohort, onCourse, onWorkbench }: {
  courses: TeacherCourse[]; cohort: ReturnType<typeof teacherCohort>
  onCourse: (id: string, tab?: 'review' | 'design', taskId?: string | null) => void; onWorkbench: () => void
}) {
  const pending = cohort.submissions.filter(item => item.state === 'pending')
  const revised = cohort.submissions.filter(item => item.state === 'revised')
  const submittedStudents = new Set(cohort.submissions.map(item => item.studentId))
  const stalled = cohort.students.filter(student => !submittedStudents.has(student.studentId))
  const inboxRows: InboxRow[] = [
    ...reviewInboxRows(courses, cohort.submissions, 'pending'),
    ...reviewInboxRows(courses, cohort.submissions, 'revised'),
    ...cohort.drafts.map(draft => ({
      key: `draft:${draft.draftId}`,
      kind: 'draft' as const,
      label: '待发布',
      title: draft.title,
      course: courseName(courses, draft.courseId),
      objectLabel: '任务草稿',
      objectMeta: `${timeText(draft.updatedAt)} 更新`,
      action: 'design' as const,
      courseId: draft.courseId,
      ariaLabel: `设计${draft.title}（${courseName(courses, draft.courseId)}）`,
    })),
    ...(stalled.length ? [{
      key: 'stalled',
      kind: 'stalled' as const,
      label: '待跟进',
      title: '尚未提交任何作业',
      course: `${courses.length} 门在教课程`,
      people: stalled.map(student => ({ name: student.name, time: '' })),
      action: 'workbench' as const,
      ariaLabel: `查看工作台：${stalled.map(student => student.name).join('、')}均未提交`,
    }] : []),
  ]
  const inboxCount = pending.length + revised.length + cohort.drafts.length
  const feedbackTotal = cohort.submissions.length
  const feedbackCovered = cohort.submissions.filter(item => item.state !== 'pending').length
  const coursePulse: CoursePulseRowData[] = courses.map(course => {
    const latest = latestTaskOf(course)
    const assigned = cohort.students.length
    const emptyCounts: Record<SubmissionState, number> = { done: 0, revised: 0, pending: 0, feedback: 0 }
    if (!latest) return { course, task: null, release: null, submitted: 0, assigned, missing: assigned, statusCounts: emptyCounts }
    const latestSubmissions = new Map<string, TeacherSubmission>()
    for (const item of cohort.submissions) {
      if (item.courseId === course.courseId && item.taskId === latest.task.taskId) latestSubmissions.set(item.studentId, item)
    }
    const statusCounts = { ...emptyCounts }
    for (const item of latestSubmissions.values()) statusCounts[item.state] += 1
    const submitted = latestSubmissions.size
    return {
      course, task: latest.task, release: latest.release, submitted, assigned,
      missing: Math.max(0, assigned - submitted), statusCounts,
    }
  })
  const openInboxRow = (row: InboxRow) => {
    if (row.action === 'workbench') onWorkbench()
    else if (row.courseId) onCourse(row.courseId, row.action)
  }

  return <div className="content teacher-page teacher-page--overview">
    <section className="t-board-summary" aria-labelledby="t-board-title">
      <div className="t-overview-card t-pulse-card">
        <div className="t-pulse-head">
          <div className="t-pulse-heading">
            <HomeSectionHeading title={<span id="t-board-title">课程进展</span>} count={`${courses.length} 门`} />
          </div>
          <div className="t-pulse-key" aria-label="状态颜色">
            <span><i className="t-pulse-key-done" />已完成</span>
            <span><i className="t-pulse-key-revised" />待复核</span>
            <span><i className="t-pulse-key-pending" />待审阅</span>
            <span><i className="t-pulse-key-feedback" />已反馈</span>
          </div>
        </div>
        {coursePulse.length === 0 ? <p className="t-inbox-empty">当前没有在教课程。</p>
          : <div className="t-pulse-list">
            {coursePulse.map(item => <CoursePulseRow key={item.course.courseId} item={item}
              onOpen={() => onCourse(item.course.courseId)}
              onTask={() => item.task && onCourse(item.course.courseId, 'review', item.task.taskId)} />)}
          </div>}
      </div>
      <article className="t-overview-card t-module t-rhythm-card" aria-labelledby="t-rhythm-title">
        <header className="t-module-head"><h3 id="t-rhythm-title">提交与反馈</h3></header>
        <div className="t-rhythm">
          <WeekBars submissions={cohort.submissions} />
          <FeedbackRing covered={feedbackCovered} total={feedbackTotal} />
        </div>
      </article>
    </section>

    <section className="t-overview-card t-inbox-card" aria-labelledby="t-pending-title">
      <HomeSectionHeading title={<span id="t-pending-title">待处理</span>} count={`${inboxCount} 项`} />
      {inboxRows.length === 0 ? <p className="t-inbox-empty">当前没有待处理的提交、待发布草稿或需要跟进的学生。</p>
        : <div className="t-inbox">
          <table className="t-inbox-table">
            <caption className="t-inbox-caption">待处理的提交、任务草稿与待跟进学生</caption>
            <thead>
              <tr>
                <th scope="col">状态</th>
                <th scope="col">事项</th>
                <th scope="col">课程</th>
                <th scope="col">待处理对象</th>
                <th scope="col" aria-label="操作"></th>
              </tr>
            </thead>
            <tbody>
              {inboxRows.map(row => <tr key={row.key} className="t-inbox-row" onClick={() => openInboxRow(row)}>
                <td><span className={`t-state t-state-${row.kind}`}>{row.label}</span></td>
                <td>
                  <span className="t-inbox-task">
                    <strong title={row.title}>{row.title}</strong>
                  </span>
                </td>
                <td className="t-inbox-course">{row.course}</td>
                <td>
                  <span className="t-inbox-object">
                    {row.people?.length
                      ? row.people.map(person => <span className="t-inbox-person" key={person.name}>
                        <strong>{person.name}</strong>{person.time && <small>{person.time}</small>}
                      </span>)
                      : <span className="t-inbox-object-label"><strong>{row.objectLabel}</strong>{row.objectMeta && <small>{row.objectMeta}</small>}</span>}
                  </span>
                </td>
                <td className="t-inbox-action">
                  <button type="button" className="t-inbox-open" aria-label={row.ariaLabel}
                    onClick={event => { event.stopPropagation(); openInboxRow(row) }}>
                    <Icon name="alt-arrow-right" size={15} />
                  </button>
                </td>
              </tr>)}
            </tbody>
          </table>
        </div>}
    </section>

    <p className="t-data-note">课程与任务来自学校发布的真实目录；学生、提交、草稿为界面预览用的示例数据，接入审阅接口后替换。</p>
  </div>
}

function CoursePulseRow({ item, onOpen, onTask }: { item: CoursePulseRowData; onOpen: () => void; onTask: () => void }) {
  const percent = item.task ? percentOf(item.submitted, item.assigned) : null
  const meter = pulseMeter(item)
  const release = item.release?.publishedAt ? releaseAgeText(item.release.publishedAt) : '—'
  const justPublished = Boolean(item.task && item.submitted === 0 && item.release?.publishedAt && isFreshRelease(item.release.publishedAt))
  const percentLabel = percent == null ? '' : `，约 ${percent}%`
  const statusSummary = [...PULSE_STATES.map(state => `${PULSE_STATE_LABELS[state]} ${item.statusCounts[state]}`), `未提交 ${item.missing}`].join('，')
  const ariaLabel = `${item.course.name}：${item.task ? `任务${item.task.title}，已提交 ${item.submitted}/${item.assigned}${percentLabel}；${statusSummary}` : '尚未发布任务'}`
  return <div className="t-pulse-row">
    <span className="t-pulse-copy">
      <button type="button" className="t-pulse-course" onClick={onOpen}>{item.course.name}</button>
      {item.task
        ? <button type="button" className="t-pulse-task" title={item.task.title}
          aria-label={`打开任务：${item.task.title}（${item.course.name}）`} onClick={onTask}>
          <span className="t-pulse-task-title">{item.task.title}</span>
          <Icon name="alt-arrow-right" size={13} />
        </button>
        : <span className="t-pulse-empty">尚未发布任务</span>}
    </span>
    <button type="button" className="t-pulse-energy" aria-label={`打开${ariaLabel}`} onClick={onOpen}>
      <span className="t-pulse-meter" aria-hidden="true" title={statusSummary}>
        {meter.map((state, index) => <span key={index} className="t-pulse-meter-cell" data-state={state} />)}
      </span>
      <span className="t-pulse-meta">
        <small>{justPublished ? '尚无提交' : release}</small>
        {item.task
          ? justPublished ? <b>刚发布</b> : <b>{percent != null && <i>{percent}% · </i>}{item.submitted}/{item.assigned}</b>
          : <b>—</b>}
      </span>
    </button>
  </div>
}

function FeedbackRing({ covered, total }: { covered: number; total: number }) {
  const percent = percentOf(covered, total)
  const radius = 24
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - (percent ?? 0) / 100)
  return <div className="t-pulse-feedback">
    <div className="t-pulse-feedback-copy">
      <strong>反馈覆盖</strong>
      <span>{total ? `${covered}/${total} 份提交` : '暂无提交'}</span>
    </div>
    <div className="t-pulse-ring" role="img" aria-label={percent == null ? '反馈覆盖：暂无提交' : `反馈覆盖 ${percent}%，${covered}/${total} 份提交已反馈`}>
      <svg viewBox="0 0 56 56" aria-hidden="true">
        <circle className="t-pulse-ring-track" cx="28" cy="28" r={radius} />
        {percent != null && <circle className="t-pulse-ring-value" cx="28" cy="28" r={radius}
          style={{ strokeDasharray: circumference, strokeDashoffset: offset }} />}
      </svg>
      <b>{percent == null ? '—' : `${percent}%`}</b>
    </div>
  </div>
}

function WeekBars({ submissions }: { submissions: TeacherSubmission[] }) {
  const groups = [0, 1, 2].map(week => {
    const start = Date.UTC(2026, 10, 2 + week * 7)
    const end = start + 7 * 86400000
    return submissions.filter(item => {
      const time = new Date(item.submittedAt).getTime()
      return time >= start && time < end
    }).length
  })
  const max = Math.max(1, ...groups)
  return <div className="t-week-bars" role="img" aria-label={`近三周提交：${groups.join('、')} 份`}>
    {groups.map((value, index) => <div key={index} className="t-week">
      <span className="t-week-bar" style={{ height: `${Math.max(6, Math.round(value / max * 100))}%` }} />
      <small>{['11-02', '11-09', '11-16'][index]}</small>
      <b>{value}</b>
    </div>)}
  </div>
}

function Workbench({ courses, cohort, onCourse }: { courses: TeacherCourse[]; cohort: ReturnType<typeof teacherCohort>; onCourse: (id: string) => void }) {
  const indexOf = (id: string) => Math.max(0, courses.findIndex(course => course.courseId === id))
  return <div className="content teacher-page">
    <section className="t-section t-section-flush">
      <HomeSectionHeading title="我的课程" count={`${courses.length} 门`} />
      {courses.length === 0 ? <HomeStatus kind="empty" message="学校还没有可管理的课程。" />
        : <CourseTiles courses={courses.map(course => course.courseId)} toneOf={id => indexOf(id)}
          titleOf={id => courses[indexOf(id)]!.name}
          summaryOf={id => `${courses[indexOf(id)]!.tasks.length} 个任务 · ${cohort.students.length} 名学生 · ${cohort.submissions.filter(item => item.courseId === id && item.state === 'pending').length} 份待审阅`}
          actionOf={() => '进入课程'} onOpen={id => onCourse(id)} />}
    </section>
  </div>
}

function CourseWorkspace({ course, cohort, initialTab, initialTaskId, onBack }: {
  course: TeacherCourse; cohort: ReturnType<typeof teacherCohort>; initialTab: 'review' | 'design'
  initialTaskId?: string | null
  onBack: () => void
}) {
  const [tab, setTab] = useState<'review' | 'design'>(initialTab)
  const [taskScope, setTaskScope] = useState<string | null>(initialTaskId ?? null)
  const [submissions, setSubmissions] = useState<TeacherSubmission[]>(() => cohort.submissions.filter(item => item.courseId === course.courseId))
  const [projects, setProjects] = useState<TeacherDraft[]>(() => cohort.drafts.filter(item => item.courseId === course.courseId))
  const scopedTask = taskScope ? course.tasks.find(item => item.taskId === taskScope) : undefined
  const scopedCount = scopedTask ? submissions.filter(item => item.taskId === scopedTask.taskId).length : 0
  return <div className="content teacher-page">
    <CourseBreadcrumb title={course.name} onBack={() => onBack()} />
    <p className="t-course-meta">{course.tasks.length} 个任务 · {cohort.students.length} 名学生 · {course.tasks.reduce((sum, task) => sum + task.releases.length, 0)} 个发布版本</p>
    <div className="t-tabs" role="tablist" aria-label="课程工作区">
      <button type="button" role="tab" id="t-tab-review" aria-selected={tab === 'review'} aria-controls="t-panel-review"
        tabIndex={tab === 'review' ? 0 : -1} className={tab === 'review' ? 'on' : ''} onClick={() => setTab('review')}
        onKeyDown={event => { if (event.key !== 'ArrowRight') return; event.preventDefault(); setTab('design'); requestAnimationFrame(() => document.getElementById('t-tab-design')?.focus()) }}>作业审阅</button>
      <button type="button" role="tab" id="t-tab-design" aria-selected={tab === 'design'} aria-controls="t-panel-design"
        tabIndex={tab === 'design' ? 0 : -1} className={tab === 'design' ? 'on' : ''} onClick={() => setTab('design')}
        onKeyDown={event => { if (event.key !== 'ArrowLeft') return; event.preventDefault(); setTab('review'); requestAnimationFrame(() => document.getElementById('t-tab-review')?.focus()) }}>任务设计</button>
    </div>
    {scopedTask && tab === 'review' && <div className="t-task-focus">
      <div className="t-task-focus-main">
        <span>当前任务</span>
        <strong>{scopedTask.title}</strong>
        <small>{scopedCount} 份提交</small>
      </div>
      <button type="button" className="t-task-focus-clear" onClick={() => setTaskScope(null)}>查看全部任务</button>
    </div>}
    {tab === 'review'
      ? <div id="t-panel-review" role="tabpanel" aria-labelledby="t-tab-review"><ReviewPane key={scopedTask?.taskId ?? 'all'} course={course} submissions={submissions} taskId={scopedTask?.taskId ?? null}
        onChange={next => setSubmissions(current => current.map(item => item.submissionId === next.submissionId ? next : item))} /></div>
      : <div id="t-panel-design" role="tabpanel" aria-labelledby="t-tab-design"><DesignPane course={course} projects={projects} onProjects={setProjects} /></div>}
  </div>
}

const filters: { id: 'all' | SubmissionState; label: string }[] = [
  { id: 'all', label: '全部' }, { id: 'pending', label: '待审阅' }, { id: 'revised', label: '待复核' },
  { id: 'feedback', label: '已反馈' }, { id: 'done', label: '已完成' },
]

function ReviewPane({ course, submissions, taskId, onChange }: {
  course: TeacherCourse; submissions: TeacherSubmission[]; taskId?: string | null; onChange: (submission: TeacherSubmission) => void
}) {
  const scoped = taskId ? submissions.filter(item => item.taskId === taskId) : submissions
  const [filter, setFilter] = useState<'all' | SubmissionState>('pending')
  const [selectedId, setSelectedId] = useState(() => scoped.find(item => item.state === 'pending')?.submissionId ?? scoped[0]?.submissionId)
  const visible = filter === 'all' ? scoped : scoped.filter(item => item.state === filter)
  const selected = scoped.find(item => item.submissionId === selectedId) ?? visible[0]
  const [feedback, setFeedback] = useState(selected?.feedback ?? '')
  const [saved, setSaved] = useState('')

  useEffect(() => { setFeedback(selected?.feedback ?? ''); setSaved('') }, [selectedId])

  if (scoped.length === 0) return <div className="t-review-empty">
    <h3>{taskId ? '这个任务还没有提交' : '还没有学生提交'}</h3>
    <p>{taskId ? '学生提交后，会按状态出现在这里。' : '发布任务后，学生的提交会按状态进入这里。'}</p>
  </div>

  const save = (state: SubmissionState) => {
    if (!selected) return
    onChange({ ...selected, feedback, state, version: state === 'revised' ? selected.version + 1 : selected.version })
    setSaved(state === 'revised' ? '已标记为允许修订' : '反馈已记录在此预览')
  }

  return <div className="t-review">
    <aside className="t-review-list" aria-label="提交清单">
      <div className="t-filter" role="group" aria-label="按状态筛选">
        {filters.map(item => <button key={item.id} type="button" className={filter === item.id ? 'on' : ''} aria-pressed={filter === item.id}
          onClick={() => setFilter(item.id)}>{item.label}<small>{item.id === 'all' ? scoped.length : scoped.filter(entry => entry.state === item.id).length}</small></button>)}
      </div>
      <div className="t-submission-list">
        {visible.length === 0 ? <p className="t-list-empty">这个状态没有提交。</p> : visible.map(item => <button key={item.submissionId} type="button"
          className={'t-submission-row' + (selected?.submissionId === item.submissionId ? ' on' : '')} aria-current={selected?.submissionId === item.submissionId ? 'true' : undefined}
          onClick={() => { setSelectedId(item.submissionId); setSaved('') }}>
          <span className="t-submission-main"><strong>{item.studentName}</strong><small>{timeText(item.submittedAt)} · v{item.version}</small></span>
          <span className={`t-state t-state-${item.state}`}>{submissionLabel[item.state]}</span>
        </button>)}
      </div>
    </aside>
    {selected && <section className="t-review-detail" aria-label="提交详情">
      <header className="t-detail-head">
        <div><h2>{selected.studentName}的提交</h2><p>{taskTitleOf([course], selected.taskId)}</p></div>
        <span className={`t-state t-state-${selected.state}`}>{submissionLabel[selected.state]}</span>
      </header>
      <dl className="t-meta">
        <div><dt>提交时间</dt><dd>{timeText(selected.submittedAt)}</dd></div>
        <div><dt>版本</dt><dd>v{selected.version}</dd></div>
        <div><dt>目标进度</dt><dd>{selected.progress.done} / {selected.progress.total}</dd></div>
        <div><dt>附件</dt><dd>{selected.artifacts.length} 个</dd></div>
      </dl>
      <div className="t-evidence">
        <h3>学生说明</h3>
        <p>{selected.note}</p>
        <ul className="t-artifacts">
          {selected.artifacts.map(artifact => <li key={artifact.name}><Icon name="file-text" size={16} />
            <span><strong>{artifact.name}</strong><small>{artifact.kind} · {artifact.size}</small></span></li>)}
        </ul>
      </div>
      <label className="t-feedback">
        <span>反馈</span>
        <textarea value={feedback} rows={6} placeholder="写清楚学生做对了什么、下一步改哪里。"
          onChange={event => { setFeedback(event.target.value); setSaved('') }} />
      </label>
      <div className="t-actions">
        <button type="button" className="primary" onClick={() => save(selected.state === 'revised' ? 'done' : 'feedback')}>
          {selected.state === 'revised' ? '完成复核' : '保存反馈'}
        </button>
        <button type="button" className="outline" onClick={() => save('revised')}>允许修订</button>
        {saved && <span role="status" className="t-saved">{saved}</span>}
      </div>
      <p className="t-preview-note">审阅写接口尚未接入学校，这里的反馈与状态只保存在本次预览。</p>
    </section>}
  </div>
}

const initialMessages = [
  { role: 'agent' as const, text: '我们从这门课已经发布的任务开始。你希望学生在这次任务里真正学会什么？' },
  { role: 'teacher' as const, text: '想让他们能解释进位延迟，而不只是把电路连对。' },
  { role: 'agent' as const, text: '那评价证据应该包含一次比较：行波进位和超前进位的延迟差异。目标可以先写成三条，我把蓝图放在右边。' },
]

function DesignPane({ course, projects, onProjects }: {
  course: TeacherCourse; projects: TeacherDraft[]; onProjects: (projects: TeacherDraft[]) => void
}) {
  const published = course.tasks.filter(task => task.releases.length > 0)
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState<TeacherDraft | null>(null)
  const [messages, setMessages] = useState(initialMessages)
  const [input, setInput] = useState('')
  const [publishOpen, setPublishOpen] = useState(false)
  const [scope, setScope] = useState<'course' | 'selected'>('course')
  const [publishedNote, setPublishedNote] = useState('')

  const openDraft = (project: TeacherDraft) => { setOpenId(project.draftId); setDraft(project); setPublishedNote('') }
  const newDraft = () => {
    const project: TeacherDraft = { draftId: 'draft-' + Date.now(), courseId: course.courseId, title: '未命名任务', summary: '', updatedAt: new Date().toISOString(), objectives: [''] }
    onProjects([project, ...projects]); setOpenId(project.draftId); setDraft(project); setPublishedNote('')
  }
  const send = () => {
    const text = input.trim()
    if (!text) return
    setMessages(current => [...current, { role: 'teacher' as const, text },
      { role: 'agent' as const, text: '我先把这条意见收进蓝图：它会影响任务说明和评价证据。需要我改成更具体的学生动作吗？' }])
    setInput('')
  }
  const updateDraft = (patch: Partial<TeacherDraft>) => {
    if (!draft) return
    const next = { ...draft, ...patch }
    setDraft(next)
    onProjects(projects.map(item => item.draftId === next.draftId ? next : item))
  }

  if (draft && openId) return <div className="t-designer">
    <header className="t-designer-head">
      <button type="button" className="t-back-link" onClick={() => { setDraft(null); setOpenId(null) }}><Icon name="alt-arrow-left" size={15} />任务列表</button>
      <div className="t-designer-title"><h2>{draft.title || '未命名任务'}</h2><span className="t-state t-state-draft">草稿</span></div>
      <div className="t-designer-actions">
        <button type="button" className="outline" onClick={() => setPublishedNote('草稿已保存在此预览')}>保存草稿</button>
        <button type="button" className="primary" onClick={() => setPublishOpen(true)}>发布</button>
      </div>
    </header>
    {publishedNote && <p role="status" className="t-saved">{publishedNote}</p>}
    <div className="t-designer-body">
      <section className="t-agent" aria-label="教师 Agent 对话">
        <header><Icon name="chat-round-dots" size={17} /><h3>教师 Agent</h3><small>示例回复</small></header>
        <div className="t-agent-thread">
          {messages.map((message, index) => <div key={index} className={`t-message t-message-${message.role}`}>
            {message.role === 'agent' && <span className="t-agent-mark"><Icon name="structure" size={14} /></span>}
            <p>{message.text}</p>
          </div>)}
        </div>
        <div className="t-agent-compose">
          <textarea rows={2} value={input} placeholder="说说你的设计意图，或让 Agent 改一条目标…" onChange={event => setInput(event.target.value)}
            onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() } }} />
          <button type="button" className="primary" onClick={send} disabled={!input.trim()}>发送</button>
        </div>
        <p className="t-preview-note">教师 Agent 由其他成员接入，这里的对话是合成示例。</p>
      </section>
      <section className="t-blueprint" aria-label="任务蓝图">
        <header><h3>任务蓝图</h3><span>随对话成稿</span></header>
        <label className="t-field"><span>任务标题</span><input value={draft.title} onChange={event => updateDraft({ title: event.target.value })} /></label>
        <label className="t-field"><span>任务说明</span><textarea rows={4} value={draft.summary} placeholder="学生要解决什么问题、交付什么。"
          onChange={event => updateDraft({ summary: event.target.value })} /></label>
        <div className="t-field-group">
          <span className="t-field-label">学习目标</span>
          {draft.objectives.map((objective, index) => <div key={index} className="t-objective-row">
            <input value={objective} placeholder={`目标 ${index + 1}`} onChange={event => {
              const next = draft.objectives.slice(); next[index] = event.target.value; updateDraft({ objectives: next })
            }} />
            <button type="button" className="t-icon-btn" aria-label={`删除目标 ${index + 1}`} onClick={() => updateDraft({ objectives: draft.objectives.filter((_, item) => item !== index) })}>
              <Icon name="close" size={14} />
            </button>
          </div>)}
          <button type="button" className="t-add-objective" onClick={() => updateDraft({ objectives: [...draft.objectives, ''] })}><Icon name="add" size={14} />添加目标</button>
        </div>
        <dl className="t-meta t-blueprint-meta">
          <div><dt>课程</dt><dd>{course.name}</dd></div>
          <div><dt>发放</dt><dd>发布时选择</dd></div>
          <div><dt>评价证据</dt><dd>说明、附件、目标进度</dd></div>
        </dl>
      </section>
    </div>
    {publishOpen && <div className="t-dialog-layer">
      <div className="t-dialog" role="dialog" aria-modal="true" aria-labelledby="t-publish-title">
        <h2 id="t-publish-title">发布任务</h2>
        <p className="t-dialog-text">发布后，学生会在课程首页看到这个任务。先选择谁可以拿到它。</p>
        <fieldset className="t-scope">
          <legend>发放范围</legend>
          <label><input type="radio" name="scope" checked={scope === 'course'} onChange={() => setScope('course')} />本课程全部学生<span>12 人</span></label>
          <label><input type="radio" name="scope" checked={scope === 'selected'} onChange={() => setScope('selected')} />指定学生<span>按课程访问名单选择</span></label>
        </fieldset>
        <p className="t-preview-note">发布只在此预览中生效；学校发布接口接入后，这里会写入 release 与 course_access。</p>
        <div className="t-dialog-actions">
          <button type="button" className="outline" onClick={() => setPublishOpen(false)}>取消</button>
          <button type="button" className="primary" onClick={() => {
            setPublishOpen(false)
            setPublishedNote(scope === 'course' ? '已按本课程全部学生发布（预览）' : '已按指定学生发布（预览）')
          }}>确认发布</button>
        </div>
      </div>
    </div>}
  </div>

  return <div className="t-projects">
    <header className="t-projects-head">
      <h2>{course.name}的任务</h2>
      <button type="button" className="primary" onClick={newDraft}>新建任务</button>
    </header>
    <div className="t-project-group">
      <h3>已发布<small>{published.length}</small></h3>
      {published.map(task => <div key={task.taskId} className="t-project-row">
        <span className="t-project-mark"><Icon name="check-circle" size={17} /></span>
        <span className="t-project-main"><strong>{task.title}</strong><small>{task.releases[0] ? `发布于 ${dateText(task.releases[0].publishedAt)} · ${task.releases[0].objectives.length} 个目标` : '未发布'}</small></span>
        <span className="t-state t-state-done">已发布</span>
      </div>)}
    </div>
    <div className="t-project-group">
      <h3>草稿<small>{projects.length}</small></h3>
      {projects.length === 0 ? <p className="t-list-empty">还没有草稿。新建任务后，Agent 会和你一起把蓝图成稿。</p>
        : projects.map(project => <button key={project.draftId} type="button" className="t-project-row" onClick={() => openDraft(project)}>
          <span className="t-project-mark"><Icon name="pen-new-square" size={17} /></span>
          <span className="t-project-main"><strong>{project.title}</strong><small>{project.summary || '尚未填写任务说明'} · 更新于 {dateText(project.updatedAt)}</small></span>
          <span className="t-state t-state-draft">草稿</span>
        </button>)}
    </div>
  </div>
}

function courseName(courses: TeacherCourse[], id: string) {
  return courses.find(course => course.courseId === id)?.name ?? '课程'
}
function taskTitleOf(courses: TeacherCourse[], id: string) {
  for (const course of courses) {
    const task = course.tasks.find(item => item.taskId === id)
    if (task) return task.title
  }
  return '任务'
}

function TeacherSettingsPage({ context, account, tab, onTab, onClose }: {
  context: TeacherContext; account: { key: string; accountName: string; schoolName?: string }
  tab: ProductSettingsTab; onTab: (tab: ProductSettingsTab) => void; onClose: () => void
}) {
  const schoolIdentity = context.identities?.find(item => item.identity.kind === 'school')
  // The teacher workspace is a local surface. Its model configuration belongs to
  // the device's personal space, not to the school's optional model service.
  const personalIdentity = context.identities?.find(item => item.identity.kind === 'personal')
  const settingsIdentity = personalIdentity?.identity ?? schoolIdentity?.identity
  const settingsKey = personalIdentity?.key ?? schoolIdentity?.key ?? 'personal'
  const selection = useModelSelection(settingsIdentity, settingsKey, context.clientNamespace)
  const cache = useMemo(() => new LearningReadCache(), [context.clientNamespace, settingsKey])
  const [mode, setMode] = useState<'disconnect' | 'replace' | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const school = (account.schoolName ?? account.accountName).replace(/学习空间/g, '教学空间')

  const request = async (route: string, body: unknown) => {
    const response = await fetch('/api/learning/' + route, { method: 'POST', credentials: 'same-origin', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-xj-space': account.key, 'x-xj-namespace': context.clientNamespace },
      body: JSON.stringify(body) })
    if (!response.ok) {
      const value = await response.json().catch(() => ({})) as { error?: string }
      throw new Error(value.error === 'forbidden' ? '当前账号已失效，请重新登录学校。' : '操作尚未完成，请稍后重试。')
    }
  }

  const revoke = async () => {
    setBusy(true); setError('')
    try {
      const connectionId = account.key.startsWith('school:') ? account.key.slice(7) : ''
      if (!connectionId) throw new Error('当前设备没有可解绑的学校连接。')
      await request('connections/revoke', { connectionId })
      if (mode === 'replace') location.assign('/?settings=school')
      else location.replace('/')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作尚未完成，请稍后重试。'); setBusy(false) }
  }

  const closeDialog = () => { if (!busy) { setMode(null); setError('') } }

  return <>
    <ProductSettings accountName={account.accountName} schoolName={school} readOnly={context.readOnly}
      spaceLabel="教学空间" accountState={{ status: 'ready' }} hiddenTabs={['portrait']} initialTab={tab} onTabChange={onTab}
      schoolControls={<TeacherSchoolConnection school={school} busy={busy}
        onRebind={() => { setError(''); setMode('replace') }}
        onDisconnect={() => { setError(''); setMode('disconnect') }} />}
      modelSettings={settingsIdentity ? <SettingsFailureBoundary key={context.clientNamespace + settingsKey + settingsIdentity.principalId} onBack={onClose}><Suspense
        fallback={<SettingsStatus tone="loading" title="正在读取个人设置" />}><PersonalModelSettings identity={settingsIdentity}
        spaceKey={settingsKey} namespace={context.clientNamespace} selection={selection} readOnly={context.readOnly} cache={cache} />
      </Suspense></SettingsFailureBoundary> : null} />
    <ConfirmationDialog open={!!mode} title={mode === 'replace' ? '换绑学校？' : '断开学校连接？'}
      description={<>{mode === 'replace' && '先解绑当前账号，再绑定新的学校账号。'}断开后，将无法在此访问<strong>「{school}」</strong>的教学内容。本机数据会保留，重新绑定原账号后可继续教学。</>}
      confirmLabel={mode === 'replace' ? '确认解绑并换绑' : '确认断开'} busy={busy} error={error}
      onClose={closeDialog} onConfirm={() => void revoke()} />
  </>
}

function TeacherSchoolConnection({ school, busy, onRebind, onDisconnect }: {
  school: string; busy: boolean; onRebind: () => void; onDisconnect: () => void
}) {
  return <section className="product-school" tabIndex={-1} aria-busy={busy || undefined}>
    <h2>学校连接</h2>
    <div className="product-school-list"><SchoolConnectionRow name={school} busy={busy}
      onRebind={() => onRebind()} onDisconnect={() => onDisconnect()} /></div>
  </section>
}
