import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { AgentEmptyState, AgentMessage, ChatViewport, UserMessage, useFollowBottom } from '@xunjie/ui/chat'
import { CourseTiles, HomeSectionHeading, HomeStatus } from '@xunjie/ui/home'
import { ConfirmationDialog } from '@xunjie/ui/foundation'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { SettingsStatus } from '@xunjie/ui/settings'
import { ProductShell } from '../components/ProductShell'
import { Icon } from '../icons'
import { ProductSettings, type ProductSettingsTab } from '../product/ProductSettings'
import { SchoolConnectionRow } from '../product/SchoolConnectionRows'
import { SettingsFailureBoundary } from '../product/SettingsFailureBoundary'
import { ProductComposerDock, ProductPromptInput, type PromptFiles } from '../product/ProductPromptInput'
import { useModelSelection, type ModelSelectionController } from '../product/ModelSelection'
import { LearningReadCache } from '../product/learning-read-cache'
import { getSessionState, logoutSession } from '../workspace/session'
import './teacher-space.css'
import {
  latestTaskOf, loadTeacherCatalog, submissionLabel, teacherCohort,
  type SubmissionState, type TeacherCatalog, type TeacherCourse, type TeacherDraft, type TeacherRelease, type TeacherSubmission, type TeacherTask,
} from './data'
import { clearTeacherCache, readTeacherCache, writeTeacherCache, type TeacherContext } from './teacher-cache'

const PersonalModelSettings = lazy(() => import('../product/PersonalModelSettings').then(module => ({ default: module.PersonalModelSettings })))

type TeacherView = 'overview' | 'workbench'
type TeacherTab = 'agent' | 'review' | 'design'
type InboxKind = 'pending' | 'revised' | 'draft' | 'stalled'
type InboxAction = 'review' | 'design' | 'workbench'

interface InboxPerson { name: string; time: string; submittedAt?: string }
interface InboxRow {
  key: string
  kind: InboxKind
  label: string
  title: string
  course?: string
  people?: InboxPerson[]
  objectLabel?: string
  objectMeta?: string
  statusSummary?: string
  waitingSince?: string
  action: InboxAction
  courseId?: string
  targetId?: string
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

const waitingText = (iso?: string) => {
  if (!iso) return ''
  const time = new Date(iso).getTime()
  if (!Number.isFinite(time)) return ''
  const hours = Math.max(0, Math.floor((Date.now() - time) / 3_600_000))
  if (hours < 1) return '不足 1 小时'
  if (hours < 24) return `最久等待 ${hours} 小时`
  return `最久等待 ${Math.floor(hours / 24)} 天`
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

/** One row is one task; pending and revised submissions stay in the same reviewing context. */
function reviewInboxRows(courses: TeacherCourse[], submissions: TeacherSubmission[]): InboxRow[] {
  const groups = new Map<string, { courseId: string; taskId: string; people: Map<string, string>; submissions: TeacherSubmission[] }>()
  for (const submission of submissions) {
    if (submission.state !== 'pending' && submission.state !== 'revised') continue
    const key = `${submission.courseId}:${submission.taskId}`
    let group = groups.get(key)
    if (!group) {
      group = { courseId: submission.courseId, taskId: submission.taskId, people: new Map(), submissions: [] }
      groups.set(key, group)
    }
    group.submissions.push(submission)
    const prior = group.people.get(submission.studentName)
    if (!prior || submission.submittedAt > prior) group.people.set(submission.studentName, submission.submittedAt)
  }
  return [...groups.values()].map<InboxRow>(group => {
    const pendingCount = group.submissions.filter(item => item.state === 'pending').length
    const revisedCount = group.submissions.length - pendingCount
    const statusSummary = [revisedCount ? `待复核 ${revisedCount}` : '', pendingCount ? `待审阅 ${pendingCount}` : ''].filter(Boolean).join(' · ')
    const waitingSince = group.submissions.map(item => item.submittedAt).sort()[0]
    return {
      key: `review:${group.courseId}:${group.taskId}`,
      kind: revisedCount ? 'revised' : 'pending',
      label: revisedCount ? '待复核' : '待审阅',
      title: taskTitleOf(courses, group.taskId),
      course: courseName(courses, group.courseId),
      people: [...group.people.entries()].map(([name, submittedAt]) => ({ name, time: timeText(submittedAt), submittedAt })),
      objectLabel: `${group.submissions.length} 份提交`,
      statusSummary,
      waitingSince,
      action: 'review',
      courseId: group.courseId,
      targetId: group.taskId,
      ariaLabel: `${statusSummary}，${taskTitleOf(courses, group.taskId)}（${courseName(courses, group.courseId)}）`,
    }
  }).sort((a, b) => (a.waitingSince ?? '').localeCompare(b.waitingSince ?? ''))
}

export function TeacherSpace() {
  const initialCache = useMemo(() => readTeacherCache(), [])
  const [context, setContext] = useState<TeacherContext | null>(initialCache?.context ?? null)
  const [catalog, setCatalog] = useState<TeacherCatalog | null>(initialCache?.catalog ?? null)
  const [error, setError] = useState('')
  const [view, setView] = useState<TeacherView>(() => new URLSearchParams(location.search).get('teacher') === 'workbench' ? 'workbench' : 'overview')
  const [courseId, setCourseId] = useState<string | null>(null)
  const [courseTab, setCourseTab] = useState<TeacherTab>('agent')
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
  const schoolIdentity = context?.identities?.find(item => item.identity.kind === 'school')
  // The course Agent runs on the device's personal model selection, the same one the settings page edits.
  const personalIdentity = context?.identities?.find(item => item.identity.kind === 'personal')
  const settingsIdentity = personalIdentity?.identity ?? schoolIdentity?.identity
  const settingsKey = personalIdentity?.key ?? schoolIdentity?.key ?? 'personal'
  const selection = useModelSelection(settingsIdentity, settingsKey, context?.clientNamespace ?? '')

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
    selection={selection} onOpenModelSettings={() => { setSettingsTab('models'); setSettingsOpen(true) }}
    onView={next => { setView(next); if (next === 'overview') setCourseId(null); setCourseTaskId(null) }}
    onCourse={(id, tab = 'agent', taskId = null) => { setCourseId(id); setCourseTab(tab); setCourseTaskId(taskId); setView('workbench') }}
    onBackToCourses={() => { setCourseId(null); setCourseTaskId(null) }} />

  return <>
    {catalog?.available && context?.account ? <ProductShell immersive={false} brandRole="教师" accountName={context.account.accountName}
      accountSubtitle="教师 · 教学空间"
      active={settingsOpen ? 'settings' : undefined}
      onHome={() => { setSettingsOpen(false); setView('overview'); setCourseId(null); setCourseTaskId(null) }}
      onAgent={() => {}}
      onSettings={() => setSettingsOpen(true)}
      onProfile={() => { setSettingsTab('account'); setSettingsOpen(true) }}
      onLogout={() => {
        clearTeacherCache()
        void logoutSession().then(() => {
          if (getSessionState().status === 'login') location.replace('/')
        })
      }}
      navItems={[{ id: 'overview', label: '教学概览', icon: 'home-2', activeIcon: 'home-2' },
        { id: 'workbench', label: '工作台', icon: 'workbench', activeIcon: 'workbench' }]}
      onNavItem={id => { setSettingsOpen(false); setView(id as TeacherView); setCourseId(null); setCourseTaskId(null) }}
      activeNavItem={settingsOpen ? undefined : view}>
      {settingsOpen ? <TeacherSettingsPage context={context} account={context.account} tab={settingsTab}
        onTab={setSettingsTab} onClose={() => setSettingsOpen(false)} identity={settingsIdentity} spaceKey={settingsKey} selection={selection} /> : content}
    </ProductShell> : content}
  </>
}

function TeacherWorkspace({ catalog, cohort, view, courseId, courseTab, courseTaskId, selection, onOpenModelSettings, onView, onCourse, onBackToCourses }: {
  catalog: TeacherCatalog; cohort: ReturnType<typeof teacherCohort>; selection: ModelSelectionController; onOpenModelSettings: () => void
  view: TeacherView; courseId: string | null; courseTab: TeacherTab; courseTaskId: string | null
  onView: (view: TeacherView) => void; onCourse: (id: string, tab?: TeacherTab, taskId?: string | null) => void; onBackToCourses: () => void
}) {
  const course = catalog.courses.find(item => item.courseId === courseId)
  if (course) return <CourseWorkspace key={course.courseId + ':' + (courseTaskId ?? '')} course={course} courses={catalog.courses} cohort={cohort}
    selection={selection} onOpenModelSettings={onOpenModelSettings} initialTab={courseTab} initialTaskId={courseTaskId} onBack={onBackToCourses} onSwitch={(id, tab) => onCourse(id, tab, null)} />
  return view === 'overview'
    ? <Overview courses={catalog.courses} cohort={cohort} onCourse={onCourse} onWorkbench={() => onView('workbench')} />
    : <Workbench courses={catalog.courses} cohort={cohort} onCourse={onCourse} />
}

function Overview({ courses, cohort, onCourse, onWorkbench }: {
  courses: TeacherCourse[]; cohort: ReturnType<typeof teacherCohort>
  onCourse: (id: string, tab?: 'review' | 'design', taskId?: string | null) => void; onWorkbench: () => void
}) {
  const [inboxFilter, setInboxFilter] = useState<'all' | 'review' | 'draft' | 'stalled'>('all')
  const submittedStudents = new Set(cohort.submissions.map(item => item.studentId))
  const stalled = cohort.students.filter(student => !submittedStudents.has(student.studentId))
  const reviewRows = reviewInboxRows(courses, cohort.submissions)
  const inboxRows: InboxRow[] = [
    ...reviewRows,
    ...stalled.map(student => ({
      key: `stalled:${student.studentId}`,
      kind: 'stalled' as const,
      label: '待跟进',
      title: student.name,
      objectLabel: '暂无提交记录',
      action: 'workbench' as const,
      ariaLabel: `查看课程：${student.name}暂无提交记录`,
    })),
    ...cohort.drafts.map(draft => ({
      key: `draft:${draft.draftId}`,
      kind: 'draft' as const,
      label: '待发布',
      title: draft.title,
      course: courseName(courses, draft.courseId),
      objectLabel: '未发布',
      objectMeta: `更新于 ${timeText(draft.updatedAt)}`,
      action: 'design' as const,
      courseId: draft.courseId,
      targetId: draft.draftId,
      ariaLabel: `设计${draft.title}（${courseName(courses, draft.courseId)}）`,
    })),
  ]
  const inboxGroups: { id: 'review' | 'stalled' | 'draft'; label: string; rows: InboxRow[] }[] = [
    { id: 'review', label: '作业审阅', rows: reviewRows },
    { id: 'stalled', label: '学生跟进', rows: inboxRows.filter(row => row.kind === 'stalled') },
    { id: 'draft', label: '任务草稿', rows: inboxRows.filter(row => row.kind === 'draft') },
  ]
  const inboxFilters: { id: 'all' | 'review' | 'draft' | 'stalled'; label: string; count: number }[] = [
    { id: 'all', label: '全部', count: inboxRows.length },
    ...inboxGroups.map(group => ({ id: group.id, label: group.label, count: group.rows.length })),
  ]
  const visibleGroups = (inboxFilter === 'all' ? inboxGroups : inboxGroups.filter(group => group.id === inboxFilter)).filter(group => group.rows.length > 0)
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
    else if (row.courseId) onCourse(row.courseId, row.action, row.targetId)
  }

  return <div className="content teacher-page teacher-page--overview">
    <section className="t-board-summary" aria-labelledby="t-board-title">
      <div className="t-overview-card t-pulse-card">
        <div className="t-pulse-head">
          <div className="t-pulse-heading">
            <HomeSectionHeading title={<span id="t-board-title">课程进展</span>} />
          </div>
          <div className="t-pulse-key" aria-label="状态颜色">
            <span data-state="done"><i className="t-pulse-key-done" />已完成</span>
            <span data-state="revised"><i className="t-pulse-key-revised" />待复核</span>
            <span data-state="pending"><i className="t-pulse-key-pending" />待审阅</span>
            <span data-state="feedback"><i className="t-pulse-key-feedback" />已反馈</span>
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
        <header className="t-module-head t-rhythm-head">
          <h3 id="t-rhythm-title">提交与反馈</h3>
          <div className="t-rhythm-key" aria-label="图例：蓝色为已反馈，灰色为待反馈">
            <span><i className="t-rhythm-key-covered" aria-hidden="true" />已反馈</span>
            <span><i className="t-rhythm-key-pending" aria-hidden="true" />待反馈</span>
          </div>
        </header>
        <div className="t-rhythm">
          <FeedbackRing covered={feedbackCovered} total={feedbackTotal} />
          <WeekBars submissions={cohort.submissions} />
        </div>
      </article>
    </section>

    <section className="t-overview-card t-inbox-card" aria-labelledby="t-pending-title">
      <div className="t-inbox-head">
        <HomeSectionHeading title={<span id="t-pending-title">待处理</span>} count={`${inboxRows.length} 项`} />
        {inboxRows.length > 0 && <div className="t-inbox-filters" role="group" aria-label="筛选待处理事项">
          {inboxFilters.filter(filter => filter.id === 'all' || filter.count > 0).map(filter => <button key={filter.id} type="button"
            className={`t-inbox-filter${inboxFilter === filter.id ? ' on' : ''}`} aria-pressed={inboxFilter === filter.id}
            onClick={() => setInboxFilter(filter.id)}>{filter.label}<small>{filter.count}</small></button>)}
        </div>}
      </div>
      {inboxRows.length === 0 ? <p className="t-inbox-empty">当前没有待处理的提交、待发布草稿或需要跟进的学生。</p>
        : <div className="t-inbox-list" key={inboxFilter}>
          {visibleGroups.map(group => <section className="t-inbox-group" aria-label={group.label} key={group.id}>
            {inboxFilter === 'all' && <div className="t-inbox-group-head"><span>{group.label}</span></div>}
            <ul className="t-inbox-group-list">
              {group.rows.map(row => {
                const people = row.people ?? []
                const fullNames = people.map(person => person.name).join('、')
                const names = people.length > 3 ? `${people.slice(0, 2).map(person => person.name).join('、')} 等 ${people.length} 人` : fullNames
                const actionLabel = row.kind === 'draft' ? '继续设计' : row.kind === 'stalled' ? '查看课程' : '去处理'
                const timeLabel = row.kind === 'draft' ? row.objectMeta : row.kind === 'stalled' ? '—' : waitingText(row.waitingSince)
                const timeTitle = row.kind === 'draft' ? row.objectMeta : row.kind === 'stalled' ? '无提交时间' : row.waitingSince ? `最早未处理提交 ${timeText(row.waitingSince)}` : undefined
                const objectLabel = row.objectLabel ?? ''
                return <li key={row.key}>
                  <button type="button" className="t-inbox-item" data-kind={row.kind} aria-label={row.ariaLabel} onClick={() => openInboxRow(row)}>
                    <span className="t-inbox-item-main">
                      <strong className="t-inbox-item-name" title={row.title}>{row.title}</strong>
                      {row.course && <span className="t-inbox-item-course">{row.course}</span>}
                    </span>
                    <span className="t-inbox-item-context">
                      <span className="t-inbox-item-context-top"><strong>{objectLabel}</strong>{row.statusSummary && <small>{row.statusSummary}</small>}</span>
                      {people.length > 0 && <small className="t-inbox-item-context-sub" title={people.length > 3 ? fullNames : undefined}>{names}</small>}
                    </span>
                    <span className={`t-inbox-item-time t-inbox-item-time-${row.kind}`} title={timeTitle}>{timeLabel}</span>
                    <span className={`t-inbox-item-action${row.kind === 'draft' ? ' quiet' : ''}`}>{actionLabel}<Icon name="alt-arrow-right" size={15} /></span>
                  </button>
                </li>
              })}
            </ul>
          </section>)}
        </div>}
    </section>

    <p className="t-data-note">课程与任务来自学校发布的真实目录；学生、提交、草稿为界面预览用的示例数据，接入审阅接口后替换。</p>
  </div>
}

function Fraction({ numerator, denominator }: { numerator: number; denominator: number }) {
  return <span className="t-fraction">
    <span className="t-fraction-num">{numerator}</span>
    <span className="t-fraction-den">/{denominator}</span>
  </span>
}

function CoursePulseRow({ item, onOpen, onTask }: { item: CoursePulseRowData; onOpen: () => void; onTask: () => void }) {
  const percent = item.task ? percentOf(item.submitted, item.assigned) : null
  const meter = pulseMeter(item)
  const release = item.release?.publishedAt ? releaseAgeText(item.release.publishedAt) : '—'
  const justPublished = Boolean(item.task && item.submitted === 0 && item.release?.publishedAt && isFreshRelease(item.release.publishedAt))
  const percentLabel = percent == null ? '' : `，约 ${percent}%`
  const statusGroups = [
    ...PULSE_STATES.map(state => ({ state, label: PULSE_STATE_LABELS[state], count: item.statusCounts[state] })),
    { state: 'missing' as const, label: '未提交', count: item.missing },
  ]
  const statusSummary = statusGroups.map(group => `${group.label} ${group.count}`).join('，')
  const ariaLabel = `${item.course.name}：${item.task ? `任务${item.task.title}，已提交 ${item.submitted}/${item.assigned}${percentLabel}；${statusSummary}` : '尚未发布任务'}`
  return <div className="t-pulse-row">
    <span className="t-pulse-copy">
      <button type="button" className="t-pulse-course" title={item.course.name} onClick={onOpen}>{item.course.name}</button>
      {item.task
        ? <button type="button" className="t-pulse-task" title={item.task.title}
          aria-label={`打开任务：${item.task.title}（${item.course.name}）`} onClick={onTask}>
          <span className="t-pulse-task-title">{item.task.title}</span>
          <Icon name="alt-arrow-right" size={13} />
        </button>
        : <span className="t-pulse-empty">尚未发布任务</span>}
    </span>
    <button type="button" className="t-pulse-energy" aria-label={`打开${ariaLabel}`} onClick={onOpen}>
      <span className="t-pulse-meter" aria-hidden="true">
        {meter.map((state, index) => <span key={index} className="t-pulse-meter-cell" data-state={state} />)}
      </span>
      <span className="t-pulse-meta">
        <span className="t-pulse-meta-left">
          <small className="t-pulse-release">{justPublished ? '尚无提交' : release}</small>
          {item.task && <small className="t-pulse-counts" aria-hidden="true">
            {statusGroups.map(group => <span key={group.state} data-state={group.state}><i />{group.count}</span>)}
          </small>}
        </span>
        {item.task
          ? justPublished ? <b>刚发布</b> : <b>{percent != null && <i>{percent}% · </i>}<Fraction numerator={item.submitted} denominator={item.assigned} /></b>
          : <b>—</b>}
      </span>
    </button>
  </div>
}

function FeedbackRing({ covered, total }: { covered: number; total: number }) {
  const percent = percentOf(covered, total)
  const pending = Math.max(0, total - covered)
  const radius = 44
  const circumference = 2 * Math.PI * radius
  const offset = circumference * (1 - (percent ?? 0) / 100)
  const pendingLabel = pending > 0 ? `待反馈 ${pending}` : '全部反馈'
  const ariaLabel = percent == null ? '反馈覆盖：暂无提交' : `反馈覆盖 ${percent}%，${covered}/${total} 份提交已反馈，${pending} 份待反馈`
  return <div className="t-pulse-feedback">
    <div className="t-pulse-ring" role="img" aria-label={ariaLabel}>
      <svg viewBox="0 0 96 96" aria-hidden="true">
        <circle className="t-pulse-ring-track" cx="48" cy="48" r={radius} />
        {percent != null && <circle className="t-pulse-ring-value" cx="48" cy="48" r={radius}
          style={{ strokeDasharray: circumference, strokeDashoffset: offset }} />}
      </svg>
      <div className="t-pulse-ring-copy" aria-hidden="true">
        <b>{percent == null ? '—' : `${percent}%`}</b>
        <small className="t-pulse-ring-label">
          <span className="t-pulse-ring-label-base">已反馈</span>
          {percent != null && <span className="t-pulse-ring-label-peek">{pendingLabel}</span>}
        </small>
      </div>
    </div>
    <p className="t-pulse-feedback-total" aria-hidden="true"><b><Fraction numerator={covered} denominator={total} /></b></p>
  </div>
}

function WeekBars({ submissions }: { submissions: TeacherSubmission[] }) {
  const groups = [0, 1, 2].map(week => {
    const start = Date.UTC(2026, 10, 2 + week * 7)
    const end = start + 7 * 86400000
    const owns = submissions.filter(item => {
      const time = new Date(item.submittedAt).getTime()
      return time >= start && time < end
    })
    return { total: owns.length, covered: owns.filter(item => item.state !== 'pending').length }
  })
  const max = Math.max(1, ...groups.map(group => group.total))
  const description = groups.map((group, index) => `${['11-02', '11-09', '11-16'][index]} 提交 ${group.total}、已反馈 ${group.covered}`).join('；')
  return <div className="t-week-bars" role="img" aria-label={`近三周提交与反馈覆盖：${description}`}>
    {groups.map((group, index) => {
      const barHeight = group.total ? Math.max(12, Math.round(group.total / max * 80)) : 0
      const coveredHeight = group.total ? Math.max(10, Math.round(group.covered / group.total * 100)) : 0
      return <div key={index} className="t-week">
        <div className="t-week-plot">
          <b style={{ bottom: `calc(${barHeight}% + 6px)` }}><Fraction numerator={group.covered} denominator={group.total} /></b>
          <span className="t-week-bar" style={{ height: `${barHeight}%` }}>
            {group.covered > 0 && <i style={{ height: `${coveredHeight}%` }} />}
          </span>
        </div>
        <small>{['11-02', '11-09', '11-16'][index]}</small>
      </div>
    })}
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
          summaryOf={id => `${cohort.submissions.filter(item => item.courseId === id && item.state === 'pending').length} 份待审阅 · ${courses[indexOf(id)]!.tasks.length} 个任务 · ${cohort.students.length} 名学生`}
          actionOf={() => '进入课程'} onOpen={id => onCourse(id)} />}
    </section>
  </div>
}

function CourseWorkspace({ course, courses, cohort, selection, onOpenModelSettings, initialTab, initialTaskId, onBack, onSwitch }: {
  course: TeacherCourse; courses: TeacherCourse[]; cohort: ReturnType<typeof teacherCohort>; selection: ModelSelectionController; onOpenModelSettings: () => void
  initialTab: TeacherTab; initialTaskId?: string | null
  onBack: () => void
  onSwitch: (id: string, tab: TeacherTab) => void
}) {
  const [tab, setTab] = useState<TeacherTab>(initialTab)
  const [agentSeed, setAgentSeed] = useState<{ text: string; nonce: number } | null>(null)
  const [courseMenu, setCourseMenu] = useState(false)
  const menuWrap = useRef<HTMLDivElement>(null)
  const menuTrigger = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!courseMenu) return
    const outside = (event: PointerEvent) => { if (!menuWrap.current?.contains(event.target as Node)) setCourseMenu(false) }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setCourseMenu(false)
      menuTrigger.current?.focus({ preventScroll: true })
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('keydown', escape)
    }
  }, [courseMenu])
  const pagesRef = useRef<HTMLDivElement>(null)
  const [glider, setGlider] = useState<{ left: number; width: number } | null>(null)
  useLayoutEffect(() => {
    const pages = pagesRef.current
    if (!pages) return
    const measure = () => {
      const active = pages.querySelector<HTMLElement>('[data-tab-active]')
      if (active) setGlider({ left: Math.round(active.offsetLeft), width: Math.round(active.offsetWidth) })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(pages)
    return () => observer.disconnect()
  }, [tab, course.courseId])
  const [taskScope, setTaskScope] = useState<string | null>(initialTaskId ?? null)
  const [designOpenId, setDesignOpenId] = useState<string | null>(initialTab === 'design' ? initialTaskId ?? null : null)
  const [submissions, setSubmissions] = useState<TeacherSubmission[]>(() => cohort.submissions.filter(item => item.courseId === course.courseId))
  const [projects, setProjects] = useState<TeacherDraft[]>(() => cohort.drafts.filter(item => item.courseId === course.courseId))
  const scopedTask = taskScope ? course.tasks.find(item => item.taskId === taskScope) : undefined
  const scopedCount = scopedTask ? submissions.filter(item => item.taskId === scopedTask.taskId).length : 0
  const tabIds: Record<TeacherTab, string> = { agent: 't-tab-agent', review: 't-tab-review', design: 't-tab-design' }
  const tabOrder: TeacherTab[] = ['agent', 'review', 'design']
  const onTabKey = (current: TeacherTab) => (event: { key: string; preventDefault: () => void }) => {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return
    event.preventDefault()
    const next = tabOrder[(tabOrder.indexOf(current) + (event.key === 'ArrowRight' ? 1 : tabOrder.length - 1)) % tabOrder.length]
    setTab(next)
    requestAnimationFrame(() => document.getElementById(tabIds[next])?.focus())
  }
  return <div className={'content teacher-page' + (tab === 'agent' ? ' teacher-page--agent' : '')}>
    <header className="t-tabbar">
      <button type="button" className="t-tabbar-back" aria-label="返回课程列表" onClick={onBack}>
        <Icon name="alt-arrow-left" size={16} />
      </button>
      <div className="t-tabbar-pages" role="tablist" aria-label="课程工作区" ref={pagesRef}>
      {glider && (
        <span className="t-btab-glider" aria-hidden="true" style={{ width: glider.width, transform: `translateX(${glider.left}px)` }}>
          <span className="t-btab-glider-edge" />
          <svg className="t-btab-glider-arc is-left" viewBox="0 0 13 14" width="13" height="14" aria-hidden="true">
            <path className="arc-fill" d="M 0 13 A 12 12 0 0 0 12 1 L 13 1 L 13 13 L 0 13 Z" />
            <path className="arc-fill" d="M 1 13 L 13 13 L 13 14 L 1 14 Z" />
            <path className="arc-line" d="M 12 1 A 12 12 0 0 1 0 13" />
          </svg>
          <svg className="t-btab-glider-arc is-right" viewBox="0 0 13 14" width="13" height="14" aria-hidden="true">
            <path className="arc-fill" d="M 13 13 A 12 12 0 0 1 1 1 L 0 1 L 0 13 L 13 13 Z" />
            <path className="arc-fill" d="M 0 13 L 12 13 L 12 14 L 0 14 Z" />
            <path className="arc-line" d="M 1 1 A 12 12 0 0 0 13 13" />
          </svg>
        </span>
      )}
      <div className="t-tabbar-course" ref={menuWrap} role="presentation" data-tab-active={tab === 'agent' ? '' : undefined}>
        <button type="button" role="tab" id="t-tab-agent" aria-selected={tab === 'agent'} aria-controls="t-panel-agent"
          aria-label={`${course.name} · 教师 Agent`}
          tabIndex={tab === 'agent' ? 0 : -1} className={'t-btab t-btab-course' + (tab === 'agent' ? ' on' : '')}
          onClick={() => { setCourseMenu(false); setTab('agent') }} onKeyDown={onTabKey('agent')}>
          <span className="t-tab-icon t-tab-icon-course" aria-hidden="true"><Icon name="course-agent" variant="linear" tone="neutral" size={16} /></span>
          <span className="t-btab-course-name">{course.name}</span>
        </button>
        <button type="button" ref={menuTrigger} className={'t-tab-toggle' + (courseMenu ? ' open' : '')}
          aria-haspopup="menu" aria-expanded={courseMenu} aria-label={`切换课程，当前${course.name}`}
          onClick={() => setCourseMenu(value => !value)}>
          <Icon name="alt-arrow-down" size={14} />
        </button>
        <div className={'t-tab-menu' + (courseMenu ? ' on' : '')} role="menu" aria-label="切换课程" inert={!courseMenu}
          onKeyDown={event => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
            event.preventDefault()
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
            const index = items.indexOf(document.activeElement as HTMLButtonElement)
            const step = event.key === 'ArrowDown' ? 1 : -1
            const next = index < 0 ? (step > 0 ? items[0] : items[items.length - 1]) : items[(index + step + items.length) % items.length]
            next?.focus()
          }}>
          {courses.map(item => <button key={item.courseId} type="button" role="menuitemradio" aria-checked={item.courseId === course.courseId}
            className={'t-tab-menu-item' + (item.courseId === course.courseId ? ' on' : '')}
            onClick={() => {
              setCourseMenu(false)
              if (item.courseId !== course.courseId) onSwitch(item.courseId, tab)
              else menuTrigger.current?.focus({ preventScroll: true })
            }}>
            <span className="t-tab-menu-label">{item.name}</span>
            {item.courseId === course.courseId && <Icon name="check" size={14} />}
          </button>)}
        </div>
      </div>
      <button type="button" role="tab" id="t-tab-review" aria-selected={tab === 'review'} aria-controls="t-panel-review"
        tabIndex={tab === 'review' ? 0 : -1} className={'t-btab t-btab-review' + (tab === 'review' ? ' on' : '')}
        data-tab-active={tab === 'review' ? '' : undefined} onClick={() => setTab('review')} onKeyDown={onTabKey('review')}>
        <span className="t-tab-icon t-tab-icon-review" aria-hidden="true"><Icon name="student-review" variant="linear" tone="neutral" size={16} /></span>
        <span className="t-btab-label">作业审阅</span>
      </button>
      <button type="button" role="tab" id="t-tab-design" aria-selected={tab === 'design'} aria-controls="t-panel-design"
        tabIndex={tab === 'design' ? 0 : -1} className={'t-btab t-btab-design' + (tab === 'design' ? ' on' : '')}
        data-tab-active={tab === 'design' ? '' : undefined} onClick={() => setTab('design')} onKeyDown={onTabKey('design')}>
        <span className="t-tab-icon t-tab-icon-design" aria-hidden="true"><Icon name="task-design" variant="linear" tone="neutral" size={16} /></span>
        <span className="t-btab-label">任务设计</span>
      </button>
      </div>
    </header>
    {scopedTask && tab === 'review' && <div className="t-task-focus">
      <div className="t-task-focus-main">
        <span>当前任务</span>
        <strong>{scopedTask.title}</strong>
        <small>{scopedCount} 份提交</small>
      </div>
      <button type="button" className="t-task-focus-clear" onClick={() => setTaskScope(null)}>查看全部任务</button>
    </div>}
    {tab === 'agent' && <div id="t-panel-agent" role="tabpanel" aria-labelledby="t-tab-agent" className="t-agent-panel">
      <TeacherAgentPane course={course} selection={selection} onOpenModelSettings={onOpenModelSettings} seed={agentSeed} onSeedApplied={() => setAgentSeed(null)} />
    </div>}
    {tab === 'review' && <div id="t-panel-review" role="tabpanel" aria-labelledby="t-tab-review"><ReviewPane key={scopedTask?.taskId ?? 'all'} course={course} submissions={submissions} taskId={scopedTask?.taskId ?? null}
      onChange={next => setSubmissions(current => current.map(item => item.submissionId === next.submissionId ? next : item))} /></div>}
    {tab === 'design' && <div id="t-panel-design" role="tabpanel" aria-labelledby="t-tab-design"><DesignPane course={course} projects={projects} openId={designOpenId} onOpen={setDesignOpenId} onProjects={setProjects}
      onDiscuss={title => { setAgentSeed({ text: `帮我看看任务「${title.trim() || '未命名任务'}」的目标和评价证据。`, nonce: Date.now() }); setTab('agent') }} /></div>}
  </div>
}

interface TeacherAgentMessage { role: 'user' | 'agent'; text: string; at?: string }
interface TeacherAgentFile { id: string; name: string; size: number }
/** 预览期只在本次页面会话内保留课程对话、输入草稿与待发附件；接入教师 Agent 后由服务端会话替换。 */
const teacherAgentThreads = new Map<string, TeacherAgentMessage[]>()
const teacherAgentDrafts = new Map<string, string>()
const teacherAgentFiles = new Map<string, TeacherAgentFile[]>()

function TeacherAgentPane({ course, selection, onOpenModelSettings, seed, onSeedApplied }: {
  course: TeacherCourse; selection: ModelSelectionController; onOpenModelSettings: () => void
  seed: { text: string; nonce: number } | null; onSeedApplied: () => void
}) {
  const [messages, setMessages] = useState<TeacherAgentMessage[]>(() => teacherAgentThreads.get(course.courseId) ?? [])
  const [input, setInputState] = useState(() => teacherAgentDrafts.get(course.courseId) ?? '')
  const [files, setFileState] = useState<TeacherAgentFile[]>(() => teacherAgentFiles.get(course.courseId) ?? [])
  const shellRef = useRef<HTMLDivElement>(null)
  const updateInput = (value: string) => {
    setInputState(value)
    teacherAgentDrafts.set(course.courseId, value)
  }
  const updateFiles = (next: (current: TeacherAgentFile[]) => TeacherAgentFile[]) => {
    setFileState(current => {
      const value = next(current)
      teacherAgentFiles.set(course.courseId, value)
      return value
    })
  }
  const fileController: PromptFiles = {
    items: files, busy: false, error: '',
    add: list => updateFiles(current => [...current, ...list.map((file, index) => ({
      id: `${Date.now().toString(36)}-${index}-${file.name}`, name: file.name, size: file.size,
    }))]),
    remove: id => updateFiles(current => current.filter(item => item.id !== id)),
  }
  const scrollerRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const oursRef = useRef(-1)
  const arrivingRef = useRef(false)
  const distanceRef = useRef(0)
  const [atBottom, setAtBottom] = useState(true)
  useFollowBottom({ scroller: scrollerRef, stick: stickRef, ours: oursRef })
  // 切回页签时对话页重挂：有历史就落在最新一条，不从最早一条读起。
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }, [])
  const focusInput = () => requestAnimationFrame(() => shellRef.current?.querySelector<HTMLTextAreaElement>('.prompt-input textarea')?.focus({ preventScroll: true }))
  const scrollToBottom = (behavior: ScrollBehavior = 'auto') => {
    const scroller = scrollerRef.current
    if (scroller) scroller.scrollTo({ top: scroller.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : behavior })
  }
  const onChatScroll = () => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    const previous = distanceRef.current
    distanceRef.current = distance
    const ours = oursRef.current
    if (ours >= 0 && scroller.scrollTop > ours - 1.5) return
    // 平滑回底途中位置仍在收近，继续等；反向变大就是学生接手
    if (arrivingRef.current) {
      if (distance > 4 && distance <= previous + 2) return
      arrivingRef.current = false
    }
    const stick = stickRef.current ? distance < 80 : distance < 40
    stickRef.current = stick
    setAtBottom(stick)
  }
  const backToBottom = () => {
    stickRef.current = true
    arrivingRef.current = true
    oursRef.current = -1
    setAtBottom(true)
    scrollToBottom('smooth')
  }
  const jumpToMessage = (element: HTMLElement, last: boolean) => {
    if (last) { backToBottom(); return }
    const scroller = scrollerRef.current
    if (!scroller) return
    stickRef.current = false
    arrivingRef.current = false
    oursRef.current = -1
    setAtBottom(false)
    const wrapRect = scroller.getBoundingClientRect()
    const rect = element.getBoundingClientRect()
    scroller.scrollTo({ top: scroller.scrollTop + rect.top - wrapRect.top - (scroller.clientHeight - rect.height) / 2,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  useEffect(() => {
    if (!seed) return
    updateInput(seed.text)
    stickRef.current = true
    setAtBottom(true)
    onSeedApplied()
    focusInput()
  }, [seed])
  const send = (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    const reply = '收到。我会把这一点放进这次任务的目标与评价证据里，并检查现在发布的任务说明有没有说清学生要做的动作。'
    const at = new Date().toISOString()
    const next: TeacherAgentMessage[] = [...messages,
      { role: 'user', text: trimmed, at },
      { role: 'agent', text: reply, at }]
    setMessages(next)
    teacherAgentThreads.set(course.courseId, next)
    updateInput('')
    updateFiles(() => [])
    stickRef.current = true
    setAtBottom(true)
    requestAnimationFrame(() => scrollToBottom())
  }
  return <div className="t-agent-shell" ref={shellRef}>
    {messages.length === 0
      ? <div className="product-agent-body"><AgentEmptyState title="今天想探讨什么？" /></div>
      : <ChatViewport scrollerRef={scrollerRef} onJump={jumpToMessage} onScroll={onChatScroll} padSuggestions={false} queued={false} busy={false}>
        {messages.map((message, index) => message.role === 'user'
          ? <UserMessage key={index} text={message.text} at={message.at} />
          : <AgentMessage key={index} message={{ role: 'agent', text: message.text, at: message.at }} reveal={index === messages.length - 1} />)}
      </ChatViewport>}
    <ProductComposerDock atBottom={atBottom} onBackToBottom={backToBottom}
      disclaimer="教师 Agent · 当前为界面预览，回复为合成示例">
      <ProductPromptInput selection={selection} readOnly={false} onModelSettings={onOpenModelSettings}
        value={input} onChange={updateInput} onSend={() => send(input)} canSend={!!input.trim()} autoFocus
        submitting={false} busy={false} files={fileController}
        textareaProps={{ 'aria-label': '向教师 Agent 提问' }} />
    </ProductComposerDock>
  </div>
}

const filters: { id: 'all' | 'inbox' | SubmissionState; label: string }[] = [
  { id: 'inbox', label: '待处理' }, { id: 'all', label: '全部' }, { id: 'pending', label: '待审阅' }, { id: 'revised', label: '待复核' },
  { id: 'feedback', label: '已反馈' }, { id: 'done', label: '已完成' },
]

function ReviewPane({ course, submissions, taskId, onChange }: {
  course: TeacherCourse; submissions: TeacherSubmission[]; taskId?: string | null; onChange: (submission: TeacherSubmission) => void
}) {
  const scoped = taskId ? submissions.filter(item => item.taskId === taskId) : submissions
  const hasPending = scoped.some(item => item.state === 'pending')
  const hasRevised = scoped.some(item => item.state === 'revised')
  const initialFilter: 'all' | 'inbox' | SubmissionState = taskId
    ? hasPending || hasRevised ? 'inbox' : 'all'
    : 'pending'
  const initialVisible = initialFilter === 'all' ? scoped : initialFilter === 'inbox'
    ? scoped.filter(item => item.state === 'pending' || item.state === 'revised')
    : scoped.filter(item => item.state === initialFilter)
  const initialSelected = [...initialVisible].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))[0] ?? scoped[0]
  const [filter, setFilter] = useState<'all' | 'inbox' | SubmissionState>(initialFilter)
  const [selectedId, setSelectedId] = useState(() => initialSelected?.submissionId)
  const visible = filter === 'all' ? scoped : filter === 'inbox'
    ? scoped.filter(item => item.state === 'pending' || item.state === 'revised')
    : scoped.filter(item => item.state === filter)
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
        {filters.filter(item => taskId || item.id !== 'inbox').map(item => <button key={item.id} type="button" className={filter === item.id ? 'on' : ''} aria-pressed={filter === item.id}
          onClick={() => { setFilter(item.id); setSaved('') }}>{item.label}<small>{item.id === 'all' ? scoped.length : item.id === 'inbox'
            ? scoped.filter(entry => entry.state === 'pending' || entry.state === 'revised').length
            : scoped.filter(entry => entry.state === item.id).length}</small></button>)}
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

function DesignPane({ course, projects, openId, onOpen, onProjects, onDiscuss }: {
  course: TeacherCourse; projects: TeacherDraft[]; openId: string | null
  onOpen: (id: string | null) => void; onProjects: (projects: TeacherDraft[]) => void
  onDiscuss: (title: string) => void
}) {
  const published = course.tasks.filter(task => task.releases.length > 0)
  const draft = openId ? projects.find(project => project.draftId === openId) ?? null : null
  const [publishOpen, setPublishOpen] = useState(false)
  const [scope, setScope] = useState<'course' | 'selected'>('course')
  const [publishedNote, setPublishedNote] = useState('')

  const openDraft = (project: TeacherDraft) => { onOpen(project.draftId); setPublishedNote('') }
  const newDraft = () => {
    const project: TeacherDraft = { draftId: 'draft-' + Date.now(), courseId: course.courseId, title: '未命名任务', summary: '', updatedAt: new Date().toISOString(), objectives: [''] }
    onProjects([project, ...projects]); onOpen(project.draftId); setPublishedNote('')
  }
  const updateDraft = (patch: Partial<TeacherDraft>) => {
    if (!draft) return
    const next = { ...draft, ...patch }
    onProjects(projects.map(item => item.draftId === next.draftId ? next : item))
  }

  if (draft && openId) return <div className="t-designer">
    <header className="t-designer-head">
      <button type="button" className="t-back-link" onClick={() => { onOpen(null); setPublishedNote('') }}><Icon name="alt-arrow-left" size={15} />任务列表</button>
      <div className="t-designer-title"><h2>{draft.title || '未命名任务'}</h2><span className="t-state t-state-draft">草稿</span></div>
      <div className="t-designer-actions">
        <button type="button" className="outline" onClick={() => onDiscuss(draft.title)}><Icon name="chat-round-dots" size={15} />和 Agent 讨论</button>
        <button type="button" className="outline" onClick={() => setPublishedNote('草稿已保存在此预览')}>保存草稿</button>
        <button type="button" className="primary" onClick={() => setPublishOpen(true)}>发布</button>
      </div>
    </header>
    {publishedNote && <p role="status" className="t-saved">{publishedNote}</p>}
    <div className="t-designer-body">
      <section className="t-blueprint" aria-label="任务蓝图">
        <header><h3>任务蓝图</h3><span>草稿内容</span></header>
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
      {projects.length === 0 ? <p className="t-list-empty">还没有草稿。新建任务后，在这里填写任务说明与学习目标。</p>
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

function TeacherSettingsPage({ context, account, tab, onTab, onClose, identity, spaceKey, selection }: {
  context: TeacherContext; account: { key: string; accountName: string; schoolName?: string }
  tab: ProductSettingsTab; onTab: (tab: ProductSettingsTab) => void; onClose: () => void
  identity?: SpaceIdentity; spaceKey: string; selection: ReturnType<typeof useModelSelection>
}) {
  const settingsIdentity = identity
  const settingsKey = spaceKey
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
      clearTeacherCache()
      try { sessionStorage.removeItem('xj.works-context.v1') } catch { /* Optional reopening hint only. */ }
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
