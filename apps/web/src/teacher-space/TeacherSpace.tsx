import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { CourseTiles, HomeSectionHeading, HomeStatus } from '@xunjie/ui/home'
import { Button, ConfirmationDialog, SelectField } from '@xunjie/ui/foundation'
import { toast } from '@xunjie/ui/feedback'
import type { SpaceIdentity } from '@xunjie/contracts/spaces'
import { SettingsStatus } from '@xunjie/ui/settings'
import { ProductShell } from '../components/ProductShell'
import { Icon } from '../icons'
import { ProductSettings, type ProductSettingsTab } from '../product/ProductSettings'
import { SchoolConnectionRow } from '../product/SchoolConnectionRows'
import { SettingsFailureBoundary } from '../product/SettingsFailureBoundary'
import type { TeacherAgentSeed } from '../product/ProductAgent'
import type { SessionSubject } from '../product/agent-sessions'
import { TeacherCourseAgent } from './TeacherCourseAgent'
import { useModelSelection, type ModelSelectionController } from '../product/ModelSelection'
import { LearningReadCache } from '../product/learning-read-cache'
import { getSessionState, logoutSession } from '../workspace/session'
import './teacher-space.css'
import {
  latestTaskOf, loadTeacherCatalog, submissionLabel, teacherCohort,
  type SubmissionState, type TeacherCatalog, type TeacherCourse, type TeacherDraft, type TeacherRelease, type TeacherSubmission, type TeacherTask,
} from './data'
import { clearTeacherCache, readTeacherCache, writeTeacherCache, type TeacherContext } from './teacher-cache'
import { orderSubmissions, submissionGroups, waitingText as submissionWaitingText, type ReviewView } from './review-order'

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
    const statusSummary = [pendingCount ? `待审阅 ${pendingCount}` : '', revisedCount ? `待复核 ${revisedCount}` : ''].filter(Boolean).join(' · ')
    const waitingSince = group.submissions.map(item => item.submittedAt).sort()[0]
    return {
      key: `review:${group.courseId}:${group.taskId}`,
      kind: pendingCount ? 'pending' : 'revised',
      label: pendingCount ? '待审阅' : '待复核',
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
  const [view, setView] = useState<TeacherView>(() => new URLSearchParams(location.search).get('teacher') === 'workbench' || new URLSearchParams(location.search).has('course') ? 'workbench' : 'overview')
  const [courseId, setCourseId] = useState(() => new URLSearchParams(location.search).get('course'))
  useEffect(() => {
    const url = new URL(location.href)
    url.searchParams.set('teacher', view)
    if (courseId) url.searchParams.set('course', courseId)
    else url.searchParams.delete('course')
    history.replaceState(history.state, '', url)
  }, [courseId, view])
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
  const schoolIdentity = context?.identities?.find(item => item.key === context.account?.key && item.identity.kind === 'school')
  const agentSubject = useMemo<SessionSubject | undefined>(() => schoolIdentity && context
    ? { identity: schoolIdentity.identity, spaceKey: schoolIdentity.key, namespace: context.clientNamespace }
    : undefined, [schoolIdentity, context?.clientNamespace])
  const selection = useModelSelection(agentSubject?.identity, agentSubject?.spaceKey ?? '', agentSubject?.namespace ?? '', true)

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
    agentSubject={agentSubject} readOnly={context.readOnly} selection={selection} onOpenModelSettings={() => { setSettingsTab('models'); setSettingsOpen(true) }}
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
        onTab={setSettingsTab} onClose={() => setSettingsOpen(false)} identity={agentSubject?.identity} spaceKey={agentSubject?.spaceKey ?? ''} selection={selection} /> : content}
    </ProductShell> : content}
  </>
}

function TeacherWorkspace({ catalog, cohort, view, courseId, courseTab, courseTaskId, agentSubject, readOnly, selection, onOpenModelSettings, onView, onCourse, onBackToCourses }: {
  agentSubject?: SessionSubject; readOnly?: boolean
  catalog: TeacherCatalog; cohort: ReturnType<typeof teacherCohort>; selection: ModelSelectionController; onOpenModelSettings: () => void
  view: TeacherView; courseId: string | null; courseTab: TeacherTab; courseTaskId: string | null
  onView: (view: TeacherView) => void; onCourse: (id: string, tab?: TeacherTab, taskId?: string | null) => void; onBackToCourses: () => void
}) {
  const course = catalog.courses.find(item => item.courseId === courseId)
  if (course) return <CourseWorkspace key={course.courseId + ':' + (courseTaskId ?? '')} course={course} courses={catalog.courses} cohort={cohort}
    agentSubject={agentSubject} readOnly={readOnly} selection={selection} onOpenModelSettings={onOpenModelSettings} initialTab={courseTab} initialTaskId={courseTaskId} onBack={onBackToCourses} onSwitch={(id, tab) => onCourse(id, tab, null)} />
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

function CourseWorkspace({ course, courses, cohort, agentSubject, readOnly, selection, onOpenModelSettings, initialTab, initialTaskId, onBack, onSwitch }: {
  agentSubject?: SessionSubject; readOnly?: boolean
  course: TeacherCourse; courses: TeacherCourse[]; cohort: ReturnType<typeof teacherCohort>; selection: ModelSelectionController; onOpenModelSettings: () => void
  initialTab: TeacherTab; initialTaskId?: string | null
  onBack: () => void
  onSwitch: (id: string, tab: TeacherTab) => void
}) {
  const [tab, setTab] = useState<TeacherTab>(initialTab)
  const [agentSeed, setAgentSeed] = useState<TeacherAgentSeed | null>(null)
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
  return <div className={'content teacher-page' + (tab === 'agent' ? ' teacher-page--agent' : '') + (tab === 'review' ? ' content--review-workspace' : '')}>
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
      {agentSubject ? <TeacherCourseAgent subject={agentSubject} courseId={course.courseId} selection={selection}
        readOnly={!!readOnly} onSettings={onOpenModelSettings} seed={agentSeed}
        onSeedApplied={() => setAgentSeed(null)} />
        : <p role="alert" className="t-loading">无法确认当前学校账号，请重新连接学校。</p>}
    </div>}
    {tab === 'review' && <div id="t-panel-review" role="tabpanel" aria-labelledby="t-tab-review"><ReviewPane key={scopedTask?.taskId ?? 'all'} course={course} submissions={submissions} taskId={scopedTask?.taskId ?? null}
      onChange={next => setSubmissions(current => current.map(item => item.submissionId === next.submissionId ? next : item))} /></div>}
    {tab === 'design' && <div id="t-panel-design" role="tabpanel" aria-labelledby="t-tab-design"><DesignPane course={course} projects={projects} openId={designOpenId} onOpen={setDesignOpenId} onProjects={setProjects}
      onDiscuss={seed => { setAgentSeed(seed); setTab('agent') }} /></div>}
  </div>
}

const REVIEW_LIST_COLLAPSED = 'xj.teacher-review-list-collapsed.v1'

const filters: { id: ReviewView; label: string }[] = [
  { id: 'inbox', label: '待处理' }, { id: 'all', label: '全部' }, { id: 'pending', label: '待审阅' }, { id: 'revised', label: '待复核' },
  { id: 'feedback', label: '已反馈' }, { id: 'done', label: '已完成' },
]

function ReviewPane({ course, submissions, taskId, onChange }: {
  course: TeacherCourse; submissions: TeacherSubmission[]; taskId?: string | null; onChange: (submission: TeacherSubmission) => void
}) {
  const scoped = taskId ? submissions.filter(item => item.taskId === taskId) : submissions
  const hasPending = scoped.some(item => item.state === 'pending')
  const hasRevised = scoped.some(item => item.state === 'revised')
  // 默认进处理队列；待审阅与待复核都属待处理，不能被漏在默认视图外。
  const initialFilter: ReviewView = hasPending || hasRevised ? 'inbox' : 'all'
  const matchesFilter = (item: TeacherSubmission, value: ReviewView) => value === 'all' || (value === 'inbox'
    ? item.state === 'pending' || item.state === 'revised'
    : item.state === value)
  const visibleFor = (items: TeacherSubmission[], status: ReviewView, search: string) => {
    const normalizedQuery = search.trim().toLocaleLowerCase()
    return orderSubmissions(items.filter(item => matchesFilter(item, status)
      && (!normalizedQuery || item.studentName.toLocaleLowerCase().includes(normalizedQuery))), status)
  }
  const initialVisible = visibleFor(scoped, initialFilter, '')
  const [filter, setFilter] = useState<ReviewView>(initialFilter)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState(() => initialVisible[0]?.submissionId)
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(scoped.map(item => [item.submissionId, item.feedback])))
  const [saved, setSaved] = useState<{ id: string; message: string } | null>(null)
  const [listCollapsed, setListCollapsed] = useState(() => {
    try { return window.localStorage.getItem(REVIEW_LIST_COLLAPSED) === '1' } catch { return false }
  })
  const toggleList = () => {
    const next = !listCollapsed
    setListCollapsed(next)
    try { window.localStorage.setItem(REVIEW_LIST_COLLAPSED, next ? '1' : '0') } catch { /* Keep the toggle usable when storage is unavailable. */ }
  }
  const visible = visibleFor(scoped, filter, query)
  const groups = submissionGroups(visible, filter)
  const showGroupTitles = groups.length > 1
  const inboxCleared = filter === 'inbox' && !query.trim() && visible.length === 0
  const selected = visible.find(item => item.submissionId === selectedId) ?? visible[0]
  const selectedIndex = selected ? visible.findIndex(item => item.submissionId === selected.submissionId) : -1
  const feedback = selected ? drafts[selected.submissionId] ?? selected.feedback : ''
  const primaryState: SubmissionState | null = selected
    ? selected.state === 'revised' ? 'done' : selected.state === 'done' ? 'done' : 'feedback'
    : null
  const primaryLabel = selected?.state === 'revised' ? '完成复核' : selected?.state === 'pending' ? '保存反馈' : '更新反馈'
  const primaryDisabled = !selected || !feedback.trim() || ((selected.state === 'feedback' || selected.state === 'done') && feedback === selected.feedback)
  const revisionDisabled = !selected || !feedback.trim()

  const selectSubmission = (id: string) => { setSelectedId(id); setSaved(null) }
  const changeView = (nextFilter: ReviewView, nextQuery: string) => {
    const nextVisible = visibleFor(scoped, nextFilter, nextQuery)
    setFilter(nextFilter)
    setQuery(nextQuery)
    setSaved(null)
    // 搜索或切换筛选时，原选中仍在结果里就保持；否则落到队列第一条。
    setSelectedId(current => nextVisible.some(item => item.submissionId === current) ? current : nextVisible[0]?.submissionId)
  }
  const selectRelative = (step: number) => {
    const next = visible[selectedIndex + step]
    if (next) selectSubmission(next.submissionId)
  }
  const save = (state: SubmissionState, intent: 'review' | 'revise' = 'review') => {
    if (!selected || !feedback.trim()) return
    const next = { ...selected, feedback, state }
    const nextScoped = scoped.map(item => item.submissionId === next.submissionId ? next : item)
    const nextVisible = visibleFor(nextScoped, filter, query)
    const message = intent === 'revise' ? '已退回修改，等待学生重新提交'
      : state === 'done' ? '复核已完成'
        : selected.state === 'feedback' || selected.state === 'done' ? '反馈已更新' : '反馈已记录在此预览'
    // 仍留在当前视图就保持选中；移出视图后接原位置的下一条，避免跳回队首。
    const kept = nextVisible.find(item => item.submissionId === next.submissionId)
    const nextId = kept?.submissionId ?? nextVisible[Math.min(selectedIndex, nextVisible.length - 1)]?.submissionId
    onChange(next)
    setSelectedId(nextId)
    setSaved({ id: next.submissionId, message })
    toast.success(message)
  }

  if (scoped.length === 0) return <div className="t-review-empty">
    <Icon name="folder-search" size={28} />
    <h3>{taskId ? '这个任务还没有提交' : '还没有学生提交'}</h3>
    <p>{taskId ? '学生提交后，会按状态出现在这里。' : '发布任务后，学生的提交会按状态进入这里。'}</p>
  </div>

  return <div className={'t-review' + (listCollapsed ? ' is-list-collapsed' : '')}>
    <aside className={'t-review-list' + (listCollapsed ? ' is-collapsed' : '')} aria-label="提交清单">
      <div className="t-review-list-head">
        <h2>提交清单</h2>
        <div className="t-review-list-head-end">
          <span className="t-review-list-count">{visible.length} / {scoped.length}</span>
          <button type="button" className="t-review-list-toggle"
            aria-label={listCollapsed ? '展开提交清单' : '收起提交清单'}
            title={listCollapsed ? '展开提交清单' : '收起提交清单'}
            aria-expanded={!listCollapsed} aria-controls="t-review-list-body" onClick={toggleList}>
            <Icon name={listCollapsed ? 'alt-arrow-right' : 'panel-left-close'} size={16} />
          </button>
        </div>
      </div>
      <div id="t-review-list-body" className="t-review-list-body" hidden={listCollapsed}>
        <div className="t-review-tools">
          <div className="t-review-search">
            <Icon name="minimalistic-magnifier" size={15} />
            <input aria-label="搜索学生" placeholder="搜索学生" value={query} onChange={event => changeView(filter, event.target.value)} />
            {query && <button type="button" aria-label="清空搜索" onClick={() => changeView(filter, '')}><Icon name="close" size={13} /></button>}
          </div>
          <SelectField className="t-review-filter" label="按状态筛选" value={filter}
            options={filters.map(item => ({
              value: item.id,
              label: `${item.label} ${item.id === 'all' ? scoped.length : scoped.filter(entry => matchesFilter(entry, item.id)).length}`,
            }))}
            onChange={value => changeView(value as ReviewView, query)} />
        </div>
        <div className="t-submission-list">
          {visible.length === 0 ? <div className="t-list-empty">
            <strong>{inboxCleared ? '待处理已清空' : '没有符合条件的提交'}</strong>
            <span>{inboxCleared ? '新的提交与复核会回到这里。' : '换个关键词或状态试试。'}</span>
            {inboxCleared && <button type="button" className="t-list-empty-link" onClick={() => changeView('all', '')}>查看全部提交</button>}
          </div> : groups.map(group => <div key={group.id} className="t-submission-group">
            {showGroupTitles && <div className="t-review-group">
              <span className="t-review-group-dot" data-state={group.id} aria-hidden="true" />
              <span>{group.label}</span>
              <small>{group.items.length}</small>
            </div>}
            {group.items.map(item => {
              const hasDraft = (drafts[item.submissionId] ?? item.feedback) !== item.feedback
              const queued = item.state === 'pending' || item.state === 'revised'
              return <button key={item.submissionId} type="button"
                className={'t-submission-row' + (selected?.submissionId === item.submissionId ? ' on' : '')} aria-current={selected?.submissionId === item.submissionId ? 'true' : undefined}
                onClick={() => selectSubmission(item.submissionId)}>
                <span className="t-submission-avatar" aria-hidden="true">{item.studentName.slice(0, 1)}</span>
                <span className="t-submission-main">
                  <span className="t-submission-title"><strong>{item.studentName}</strong>{hasDraft && <span className="t-draft-mark" title="有未保存反馈">草稿</span>}</span>
                  <small title={`提交于 ${timeText(item.submittedAt)}`}>
                    {queued ? submissionWaitingText(item.submittedAt) : `提交 ${timeText(item.submittedAt).split(' ')[0]}`}
                    <span>·</span>v{item.version}
                  </small>
                </span>
                <span className={`t-state t-state-${item.state}`}>{submissionLabel[item.state]}</span>
              </button>
            })}
          </div>)}
        </div>
      </div>
    </aside>
    {selected ? <section className="t-review-detail" aria-label="提交详情">
      <header className="t-detail-head">
        <div className="t-detail-heading"><h2>{selected.studentName}的提交</h2><p>{taskTitleOf([course], selected.taskId)}</p></div>
        <div className="t-detail-head-side">
          <span className={`t-state t-state-${selected.state}`}>{submissionLabel[selected.state]}</span>
          <div className="t-detail-nav" aria-label="切换提交">
            <button type="button" aria-label="上一份提交" disabled={selectedIndex <= 0} onClick={() => selectRelative(-1)}><Icon name="alt-arrow-left" size={15} /></button>
            <button type="button" aria-label="下一份提交" disabled={selectedIndex < 0 || selectedIndex >= visible.length - 1} onClick={() => selectRelative(1)}><Icon name="alt-arrow-right" size={15} /></button>
          </div>
        </div>
      </header>
      <dl className="t-meta">
        <div><dt>提交时间</dt><dd>{timeText(selected.submittedAt)}</dd></div>
        <div><dt>提交版本</dt><dd>v{selected.version}</dd></div>
        <div><dt>目标进度</dt><dd>{selected.progress.done} / {selected.progress.total}</dd></div>
        <div><dt>附件</dt><dd>{selected.artifacts.length} 个</dd></div>
      </dl>
      <div className="t-submission-content">
        <section className="t-detail-section" aria-labelledby="t-student-note">
          <h3 id="t-student-note"><Icon name="clipboard-text" size={16} />学生说明</h3>
          <p className="t-student-note">{selected.note || '学生没有填写提交说明。'}</p>
        </section>
        <section className="t-detail-section" aria-labelledby="t-submission-files">
          <h3 id="t-submission-files"><Icon name="paperclip" size={16} />提交附件<span>{selected.artifacts.length}</span></h3>
          {selected.artifacts.length ? <ul className="t-artifacts">
            {selected.artifacts.map(artifact => <li key={artifact.name}>
              <span className="t-artifact-icon"><Icon name={artifact.kind === 'CSV' ? 'file-spreadsheet' : artifact.kind === '图片' ? 'file-image' : artifact.kind === 'Logisim 电路' ? 'file-code' : 'file-text'} size={18} /></span>
              <span className="t-artifact-copy"><strong>{artifact.name}</strong><small>{artifact.kind} · {artifact.size}</small></span>
            </li>)}
          </ul> : <p className="t-detail-empty-copy">本次提交没有附件。</p>}
        </section>
      </div>
      <section className="t-feedback" aria-labelledby="t-feedback-title">
        <div className="t-feedback-head">
          <div><h3 id="t-feedback-title">教师反馈</h3><span>关联当前提交 v{selected.version}</span></div>
          {saved?.id === selected.submissionId && <span role="status" className="t-saved"><Icon name="check-circle" size={14} />{saved.message}</span>}
        </div>
        <textarea aria-label="反馈" value={feedback} rows={4} placeholder="写清楚学生做对了什么、下一步改哪里。"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          onChange={event => {
            const value = event.target.value
            setDrafts(current => ({ ...current, [selected.submissionId]: value }))
            setSaved(null)
          }}
          onKeyDown={event => {
            if (event.nativeEvent.isComposing || !(event.metaKey || event.ctrlKey) || event.key !== 'Enter') return
            event.preventDefault()
            if (!primaryDisabled && primaryState) save(primaryState)
          }} />
        <div className="t-feedback-footer">
          <span className="t-feedback-hint">{feedback.trim() ? '⌘ / Ctrl + Enter' : '先填写反馈'}</span>
          <div className="t-actions">
            <Button type="button" variant="outline" disabled={revisionDisabled} onClick={() => save('feedback', 'revise')}><Icon name="undo-left-round" size={14} />允许修订</Button>
            <Button type="button" variant="primary" disabled={primaryDisabled} aria-keyshortcuts="Meta+Enter Control+Enter"
              onClick={() => primaryState && save(primaryState)}><Icon name="check" size={14} />{primaryLabel}</Button>
          </div>
        </div>
      </section>
      <p className="t-preview-note"><Icon name="info-circle" size={13} />审阅写接口尚未接入学校，这里的反馈与状态只保存在本次预览。</p>
    </section> : <section className="t-review-detail t-review-detail--empty" aria-label="提交详情">
      <Icon name="folder-search" size={28} />
      <h2>{inboxCleared ? '待处理已清空' : '没有匹配的提交'}</h2>
      <p>{inboxCleared ? '新的提交与复核会回到这里。' : '调整搜索词或状态，找到需要审阅的内容。'}</p>
      <Button type="button" variant="outline" onClick={() => changeView('all', '')}>查看全部提交</Button>
    </section>}
  </div>
}

type DesignFilter = 'all' | 'published' | 'draft'
type DesignCheck = { id: 'title' | 'summary' | 'objectives'; label: string; done: boolean }
type DesignEntry = {
  id: string; kind: 'published' | 'draft'; title: string; summary: string; updatedAt: string; objectiveCount: number
  task?: TeacherTask; release?: TeacherRelease; project?: TeacherDraft
}

const designSignature = (draft: Pick<TeacherDraft, 'title' | 'summary' | 'objectives'>) => JSON.stringify({
  title: draft.title, summary: draft.summary, objectives: draft.objectives,
})

function DesignPane({ course, projects, openId, onOpen, onProjects, onDiscuss }: {
  course: TeacherCourse; projects: TeacherDraft[]; openId: string | null
  onOpen: (id: string | null) => void; onProjects: (projects: TeacherDraft[]) => void
  onDiscuss: (seed: TeacherAgentSeed) => void
}) {
  const [filter, setFilter] = useState<DesignFilter>('all')
  const [query, setQuery] = useState('')
  const draft = openId ? projects.find(project => project.draftId === openId) ?? null : null
  const entries = useMemo<DesignEntry[]>(() => [
    ...course.tasks.flatMap(task => {
      const release = task.releases[0]
      if (!release) return []
      return [{ id: task.taskId, kind: 'published' as const, title: task.title, summary: task.summary,
        updatedAt: release.publishedAt, objectiveCount: release.objectives.length, task, release }]
    }),
    ...projects.map(project => ({ id: project.draftId, kind: 'draft' as const, title: project.title || '未命名任务',
      summary: project.summary, updatedAt: project.updatedAt, objectiveCount: project.objectives.filter(item => item.trim()).length, project })),
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), [course.tasks, projects])
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleEntries = entries.filter(entry => (filter === 'all' || entry.kind === filter)
    && (!normalizedQuery || `${entry.title} ${entry.summary}`.toLocaleLowerCase().includes(normalizedQuery)))

  const newDraft = () => {
    const project: TeacherDraft = { draftId: 'draft-' + Date.now(), courseId: course.courseId, title: '', summary: '', updatedAt: new Date().toISOString(), objectives: [''] }
    onProjects([project, ...projects])
    onOpen(project.draftId)
  }

  if (draft) return <DraftDesigner key={draft.draftId} course={course} draft={draft} onBack={() => onOpen(null)}
    onChange={patch => onProjects(projects.map(item => item.draftId === draft.draftId ? { ...item, ...patch } : item))}
    onDiscuss={onDiscuss} />

  return <div className="t-projects">
    <header className="t-projects-head">
      <h2>任务设计</h2>
      <Button type="button" variant="primary" onClick={newDraft}><Icon name="add" size={15} />新建任务</Button>
    </header>
    <div className="t-project-toolbar">
      <div className="t-project-filters" role="group" aria-label="按状态筛选任务">
        {([['all', '全部'], ['published', '已发布'], ['draft', '草稿']] as const).map(([id, label]) => <button key={id} type="button"
          className={filter === id ? 'on' : ''} aria-pressed={filter === id} onClick={() => setFilter(id)}>
          {label}<small>{id === 'all' ? entries.length : entries.filter(entry => entry.kind === id).length}</small>
        </button>)}
      </div>
      <div className="t-project-search">
        <Icon name="minimalistic-magnifier" size={15} />
        <input aria-label="搜索任务" placeholder="搜索任务" value={query} onChange={event => setQuery(event.target.value)} />
        {query && <button type="button" aria-label="清空任务搜索" onClick={() => setQuery('')}><Icon name="close" size={13} /></button>}
      </div>
    </div>
    {visibleEntries.length ? <div className="t-project-list">
      {visibleEntries.map(entry => {
        const content = <>
          <span className="t-project-title"><strong>{entry.title}</strong><span className={`t-state ${entry.kind === 'published' ? 't-state-done' : 't-state-draft'}`}>{entry.kind === 'published' ? '已发布' : '草稿'}</span></span>
          <span className="t-project-summary">{entry.summary || '尚未填写任务说明'}</span>
          <small className="t-project-meta">{entry.kind === 'published' ? `发布于 ${dateText(entry.updatedAt)}` : `更新于 ${dateText(entry.updatedAt)}`}<span>·</span>{entry.objectiveCount} 个学习目标</small>
        </>
        return <article key={entry.id} className="t-project-row">
          <span className={`t-project-mark ${entry.kind === 'published' ? 'is-published' : ''}`}><Icon name={entry.kind === 'published' ? 'check-circle' : 'pen-new-square'} size={17} /></span>
          {entry.kind === 'draft' ? <button type="button" className="t-project-main" aria-label={`继续设计：${entry.title}`}
            onClick={() => entry.project && onOpen(entry.project.draftId)}>{content}</button>
            : <div className="t-project-main">{content}</div>}
          {entry.kind === 'published' && entry.task && entry.release ? <div className="t-project-actions">
            <Button type="button" variant="outline" aria-label={`和 Agent 讨论${entry.title}`} onClick={() => onDiscuss({
              text: `帮我梳理任务「${entry.title}」的目标、要求和公开材料。`,
              target: { kind: 'release', taskId: entry.task!.taskId, releaseId: entry.release!.releaseId, title: entry.title },
            })}><Icon name="chat-round-dots" size={15} />和 Agent 讨论</Button>
          </div> : <span className="t-project-row-arrow" aria-hidden="true"><Icon name="alt-arrow-right" size={16} /></span>}
        </article>
      })}
    </div> : <div className="t-projects-empty">
      <span className="t-projects-empty-icon"><Icon name={entries.length ? 'folder-search' : 'checklist'} size={24} /></span>
      <h3>{entries.length ? '没有匹配的任务' : '从第一份任务开始'}</h3>
      <p>{entries.length ? '换个关键词，或查看其他任务状态。' : '整理任务说明与学习目标，再发布给学生。'}</p>
      <Button type="button" variant="outline" onClick={() => {
        if (entries.length) { setFilter('all'); setQuery('') } else newDraft()
      }}>{entries.length ? '清除筛选' : '新建任务'}</Button>
    </div>}
  </div>
}

function DesignChecklist({ checks, onSelect }: { checks: DesignCheck[]; onSelect?: (id: DesignCheck['id']) => void }) {
  return <ul className="t-design-checklist">{checks.map(check => {
    const content = <><Icon name={check.done ? 'check-circle' : 'info-circle'} size={15} /><span>{check.label}</span><small>{check.done ? '已完成' : '待完善'}</small></>
    return <li key={check.id} className={check.done ? 'is-done' : ''}>{onSelect
      ? <button type="button" onClick={() => onSelect(check.id)}>{content}</button> : <div>{content}</div>}</li>
  })}</ul>
}

function DraftDesigner({ course, draft, onBack, onChange, onDiscuss }: {
  course: TeacherCourse; draft: TeacherDraft; onBack: () => void
  onChange: (patch: Partial<TeacherDraft>) => void; onDiscuss: (seed: TeacherAgentSeed) => void
}) {
  const [publishOpen, setPublishOpen] = useState(false)
  const [scope, setScope] = useState<'course' | 'selected'>('course')
  const [publishedNote, setPublishedNote] = useState('')
  const [savedSignature, setSavedSignature] = useState(() => designSignature(draft))
  const cancelPublishRef = useRef<HTMLButtonElement>(null)
  const publishButtonRef = useRef<HTMLButtonElement>(null)
  const signature = designSignature(draft)
  const dirty = signature !== savedSignature
  const objectiveCount = draft.objectives.filter(item => item.trim()).length
  const checks: DesignCheck[] = [
    { id: 'title', label: '填写任务标题', done: !!draft.title.trim() },
    { id: 'summary', label: '说明问题与交付结果', done: !!draft.summary.trim() },
    { id: 'objectives', label: '至少添加 1 个学习目标', done: objectiveCount > 0 },
  ]
  const completedCount = checks.filter(check => check.done).length
  const ready = completedCount === checks.length

  const updateDraft = (patch: Partial<TeacherDraft>) => {
    setPublishedNote('')
    onChange({ ...patch, updatedAt: new Date().toISOString() })
  }
  const saveDraft = () => {
    if (!dirty) return
    onChange({ updatedAt: new Date().toISOString() })
    setSavedSignature(signature)
    setPublishedNote('草稿已保存在此预览')
  }
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== 's') return
      event.preventDefault()
      saveDraft()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [dirty, signature])
  const focusCheck = (id: DesignCheck['id']) => {
    if (id === 'objectives' && draft.objectives.length === 0) updateDraft({ objectives: [''] })
    setTimeout(() => document.getElementById(`t-draft-${id === 'objectives' ? 'objective-0' : id}-${draft.draftId}`)?.focus(), 0)
  }
  const moveObjective = (from: number, to: number) => {
    if (to < 0 || to >= draft.objectives.length) return
    const next = draft.objectives.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved!)
    updateDraft({ objectives: next })
    setTimeout(() => document.getElementById(`t-draft-objective-${to}-${draft.draftId}`)?.focus(), 0)
  }

  return <div className="t-designer">
    <header className="t-designer-head">
      <div className="t-designer-heading">
        <button type="button" className="t-back-link" onClick={onBack}><Icon name="alt-arrow-left" size={15} />任务列表</button>
        <div className="t-designer-title"><h2>{draft.title.trim() || '未命名任务'}</h2><span className="t-state t-state-draft">草稿</span></div>
      </div>
      <div className="t-designer-actions">
        {(dirty || publishedNote) && <span role="status" className={`t-designer-save-state${publishedNote ? ' is-saved' : ''}`}>
          {publishedNote && <Icon name="check-circle" size={14} />}{publishedNote || '有未保存的更改'}
        </span>}
        <Button type="button" variant="outline" onClick={() => onDiscuss({
          text: `帮我看看这份任务草稿的目标和评价证据。\n\n任务：${draft.title.trim() || '未命名任务'}${draft.summary.trim() ? '\n说明：' + draft.summary : ''}${objectiveCount ? '\n目标：' + draft.objectives.filter(item => item.trim()).join('、') : ''}`,
        })}><Icon name="chat-round-dots" size={15} />和 Agent 讨论</Button>
        <Button type="button" variant="outline" disabled={!dirty} aria-keyshortcuts="Meta+S Control+S" onClick={saveDraft}>保存草稿</Button>
        <Button ref={publishButtonRef} type="button" variant="primary" onClick={() => setPublishOpen(true)}>发布任务</Button>
      </div>
    </header>
    <div className="t-designer-body">
      <div className="t-designer-main">
        <section className="t-editor-section" aria-labelledby={`t-basic-title-${draft.draftId}`}>
          <header className="t-editor-section-head"><div><h3 id={`t-basic-title-${draft.draftId}`}>基本信息</h3><p>让学生清楚理解要解决的问题，以及最终需要交付什么。</p></div></header>
          <label className="t-field" htmlFor={`t-draft-title-${draft.draftId}`}><span className="t-field-heading">任务标题<small>必填</small></span>
            <input id={`t-draft-title-${draft.draftId}`} value={draft.title} placeholder="例如：设计并验证 4 位 ALU"
              onChange={event => updateDraft({ title: event.target.value })} />
          </label>
          <label className="t-field" htmlFor={`t-draft-summary-${draft.draftId}`}><span className="t-field-heading">任务说明<small>必填</small></span>
            <textarea id={`t-draft-summary-${draft.draftId}`} rows={5} value={draft.summary} placeholder="说明学生要解决的真实问题、需要完成的实践，以及最终交付的成果。"
              onChange={event => updateDraft({ summary: event.target.value })} />
            <span className="t-field-hint">先写问题和情境，再写交付要求；具体评价方式由学习目标承接。</span>
          </label>
        </section>
        <section className="t-editor-section" aria-labelledby={`t-goals-title-${draft.draftId}`}>
          <header className="t-editor-section-head"><div><h3 id={`t-goals-title-${draft.draftId}`}>学习目标</h3><p>用可观察的表现描述学生完成实践后应能做到什么。</p></div><span>{objectiveCount} 项</span></header>
          <div className="t-objective-list">
            {draft.objectives.map((objective, index) => <div key={index} className="t-objective-row">
              <span className="t-objective-index" aria-hidden="true">{index + 1}</span>
              <input id={`t-draft-objective-${index}-${draft.draftId}`} aria-label={`学习目标 ${index + 1}`} value={objective}
                placeholder="例如：能用波形数据比较两种电路结构" onChange={event => {
                  const next = draft.objectives.slice(); next[index] = event.target.value; updateDraft({ objectives: next })
                }} />
              <div className="t-objective-actions">
                <button type="button" className="t-icon-btn" aria-label={`上移目标 ${index + 1}`} title="上移" disabled={index === 0}
                  onClick={() => moveObjective(index, index - 1)}><Icon name="arrow-up" size={14} /></button>
                <button type="button" className="t-icon-btn" aria-label={`下移目标 ${index + 1}`} title="下移" disabled={index === draft.objectives.length - 1}
                  onClick={() => moveObjective(index, index + 1)}><Icon name="arrow-down" size={14} /></button>
                <button type="button" className="t-icon-btn t-icon-btn-danger" aria-label={`删除目标 ${index + 1}`} title="删除" disabled={draft.objectives.length === 1}
                  onClick={() => updateDraft({ objectives: draft.objectives.filter((_, item) => item !== index) })}><Icon name="trash-bin-trash" size={14} /></button>
              </div>
            </div>)}
          </div>
          <Button type="button" variant="outline" className="t-add-objective" onClick={() => {
            const index = draft.objectives.length
            updateDraft({ objectives: [...draft.objectives, ''] })
            setTimeout(() => document.getElementById(`t-draft-objective-${index}-${draft.draftId}`)?.focus(), 0)
          }}><Icon name="add" size={14} />添加学习目标</Button>
        </section>
      </div>
      <aside className="t-designer-rail" aria-label="任务发布信息">
        <section className="t-readiness">
          <header><h3>发布准备</h3><span>{completedCount} / {checks.length}</span></header>
          <DesignChecklist checks={checks} onSelect={focusCheck} />
          <p>{ready ? '内容已齐备，可以打开发布设置。' : '点击待完善项，直接回到对应内容。'}</p>
        </section>
        <dl className="t-design-facts">
          <div><dt>所属课程</dt><dd>{course.name}</dd></div>
          <div><dt>发放范围</dt><dd>发布时选择</dd></div>
          <div><dt>评价证据</dt><dd>说明、附件、目标进度</dd></div>
        </dl>
      </aside>
    </div>
    <Dialog.Root open={publishOpen} onOpenChange={setPublishOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="t-publish-overlay" />
        <Dialog.Content className="t-publish-dialog" onOpenAutoFocus={event => { event.preventDefault(); cancelPublishRef.current?.focus() }}
          onCloseAutoFocus={event => { event.preventDefault(); publishButtonRef.current?.focus() }}>
          <div className="t-publish-head"><div><Dialog.Title>发布任务</Dialog.Title><Dialog.Description>核对任务内容与发放范围。发布后，学生会在课程首页看到这个任务。</Dialog.Description></div>
            <Dialog.Close asChild><button type="button" className="t-icon-btn" aria-label="关闭发布对话框"><Icon name="close" size={16} /></button></Dialog.Close>
          </div>
          <div className="t-publish-summary"><span><Icon name="clipboard-check" size={20} /></span><div><strong>{draft.title.trim() || '未命名任务'}</strong><small>{course.name} · {objectiveCount} 个学习目标</small></div></div>
          <section className="t-publish-check" aria-labelledby={`t-publish-check-${draft.draftId}`}>
            <h3 id={`t-publish-check-${draft.draftId}`}>发布前检查<span>{completedCount} / {checks.length}</span></h3>
            <DesignChecklist checks={checks} />
            {!ready && <p role="alert">还有 {checks.length - completedCount} 项待完善，返回草稿补充后即可发布。</p>}
          </section>
          <fieldset className="t-scope"><legend>发放范围</legend>
            <label><input type="radio" name={`scope-${draft.draftId}`} checked={scope === 'course'} onChange={() => setScope('course')} /><span><strong>本课程全部学生</strong><small>12 人</small></span></label>
            <label className="is-disabled"><input type="radio" name={`scope-${draft.draftId}`} disabled checked={scope === 'selected'} onChange={() => setScope('selected')} /><span><strong>指定学生</strong><small>学生名单接入后可用</small></span></label>
          </fieldset>
          <p className="t-preview-note"><Icon name="info-circle" size={13} />发布仅用于当前预览，不会同步到学校。</p>
          <div className="t-dialog-actions">
            <Dialog.Close asChild><Button ref={cancelPublishRef} type="button" variant="outline">返回编辑</Button></Dialog.Close>
            <Button type="button" variant="primary" disabled={!ready || scope !== 'course'} onClick={() => {
              setPublishOpen(false)
              setPublishedNote('已按本课程全部学生发布（预览）')
            }}>确认发布</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
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
        spaceKey={settingsKey} namespace={context.clientNamespace} selection={selection} readOnly={context.readOnly} cache={cache} teacher />
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
