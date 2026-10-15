import { Icon, IconText, type IconName } from '../icons'
import { useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { learningApi } from '../bridge/mockAdapter'
import { demoDashboard, demoTasks } from '../bridge/mockData'
import type { ProjectTask, TaskStatus } from '../bridge/types'
import { DashboardSection } from '../components/dashboard/DashboardSection'
import { FluidHighlight } from '../components/FluidHighlight'
import { ProgressBar } from '../components/ProgressBar'
import { StatusChip, type TaskDisplayStatus } from '../components/StatusChip'
import { useFluidHover, useRegisterFluidHoverItem } from '../lib/fluidHover'
import {
  filterTasks,
  formatDeadline,
  isOverdue,
  pendingCount,
  progressPercent,
  selectContinueTask,
  sortTasks,
} from '../lib/tasks'
import { PREP_BUILD } from '../workspace/mode'
import { PREP_ENTRY_COURSE, PREP_ENTRY_GOAL, PREP_ENTRY_LABEL, PREP_ENTRY_NOTE, PREP_TASK_ROUTE } from '../workspace/prepEntry'
import { useSession } from '../components/SessionEntry'
import { loadHomeCourses, type HomeCourse } from '../workspace/home'
import { displayAccountName, displayCourseName } from '../lib/displayNames'

const STATUS_FILTERS: Array<'全部' | TaskStatus> = ['全部', '进行中', '未开始', '已完成']
const ASSIGNMENT_FILTERS = ['全部', '已分配', '任务已暂停'] as const
const COURSE_ICONS: IconName[] = ['virtual-board', 'code-square', 'structure']

// 已交本机课程的装饰映射用于尚无本人分配的课程；不按列表顺序猜课程类型。
const KNOWN_COURSE_TONES: Record<string, number> = {
  'synthetic-robert-course-c': 1,
  'synthetic-robert-course-hdl': 0,
}

function realCourseTone(course: HomeCourse): number {
  const kinds = new Set(course.assignments.map(task => task.executionKind))
  if (kinds.size === 0) return KNOWN_COURSE_TONES[course.courseId] ?? 2
  if (kinds.size > 1) return 2
  return kinds.has('hdl_board') ? 0 : 1
}

/** 课程封面插画（动画风），放在 app/public/courses/ 下；缺图时回退课程色占位块。 */
const COURSE_COVERS: Record<string, string> = {
  数字逻辑与部件设计: '/courses/digital-logic.png',
  程序设计基础: '/courses/programming-basics.png',
  数据结构: '/courses/data-structures.png',
}

/**
 * 首页（已确认结构 A + 课程/任务形式 B）：
 * 学习看板（整宽，可个性化编辑；任务完成卡下半部分内嵌继续任务入口）→ 课程卡片（仅名称、待完成数、入口）→ 课程内任务卡片（截止时间优先）。
 */
export default function HomePage() {
  return PREP_BUILD ? <PreparationHomePage /> : <RealHomePage />
}

function RealHomePage() {
  const session = useSession()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const snapshot = useQuery({
    queryKey: ['home', 'real', session.epoch, session.session?.userId],
    queryFn: () => loadHomeCourses(session.session!),
    enabled: session.status === 'authenticated' && !!session.session,
  })
  const courses = snapshot.data ?? []
  const selected = courses.find(course => course.courseId === searchParams.get('course'))
  const [statusFilter, setStatusFilter] = useState<typeof ASSIGNMENT_FILTERS[number]>('全部')
  const [query, setQuery] = useState('')
  const search = query.trim().toLowerCase()
  const visibleTasks = selected?.assignments.filter(task =>
    (statusFilter === '全部' || statusFilter === (task.active ? '已分配' : '任务已暂停')) &&
    `${task.title} ${task.goal ?? ''} ${displayCourseName(selected.courseId)} ${selected.courseId}`.toLowerCase().includes(search)) ?? []
  const allTasks = courses.flatMap(course => course.assignments.map(task => ({ ...task, courseId: course.courseId })))
  const entryTask = !snapshot.isError && allTasks.find(task => task.active)
  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好'
  const cardsRef = useRef<HTMLDivElement>(null)
  const hover = useFluidHover(cardsRef)
  return <div className="content">
    <div className="intro">
      <h1>{greeting}，{displayAccountName(session.session!.userId)}</h1>
      <span className="date">{now.getMonth() + 1} 月 {now.getDate()} 日</span>
    </div>
    <DashboardSection key={session.session?.userId} storageKey={`dashboard.layout.v3:real:${session.session?.userId}`}
      data={demoDashboard} tasks={demoTasks} demoStatistics
      taskCount={snapshot.isSuccess ? allTasks.length : undefined} now={now}
      continueSlot={entryTask && <div className="db-continue">
        <span className="course-tag"><i className="dot" />项目任务 · {displayCourseName(entryTask.courseId)}</span>
        <h3>{entryTask.title}</h3>
        {entryTask.goal && <p>{entryTask.goal}</p>}
        <div className="db-continue-foot">
          <span className="db-side">当前获准任务</span>
          <button className="primary" onClick={() => navigate('/task/' + encodeURIComponent(entryTask.assignmentId))}>
            <IconText name="arrow-right" position="end">进入任务</IconText>
          </button>
        </div>
      </div>} />
    <div>
    <div className="sectionhead">
      <h2>{selected ? '课程与任务' : '我的课程'}<small>{selected ? `${selected.assignments.length} 个任务` : `${courses.length} 门`}</small></h2>
      <button className="outline" type="button" disabled={snapshot.isFetching} onClick={() => { void snapshot.refetch() }}>刷新任务</button>
    </div>
    {snapshot.isPending ? <p role="status">正在读取课程与任务…</p>
      : snapshot.isError ? <div className="empty" role="alert">
        <p>暂时无法读取课程与任务，请重试。已有任务链接仍可使用。</p>
        <button type="button" disabled={snapshot.isFetching} onClick={() => { void snapshot.refetch() }}>重试</button>
      </div>
      : selected ? <>
        <div className="course-breadcrumb">
          <button onClick={() => setSearchParams({})}><IconText name="alt-arrow-left">全部课程</IconText></button>
          <span>/</span><strong>{displayCourseName(selected.courseId)}</strong>
        </div>
        <TaskToolbar filters={ASSIGNMENT_FILTERS} value={statusFilter} onFilter={setStatusFilter} query={query} onQuery={setQuery} />
        {selected.assignments.length === 0 ? <div className="empty">此课程暂无分配任务</div>
          : visibleTasks.length === 0 ? <div className="empty"><Icon name="folder-search" size={22} />此课程没有匹配的任务</div>
          : <div className="task-card-grid" ref={cardsRef} {...hover.handlers}>
            <FluidHighlight activeIndex={hover.activeIndex} rects={hover.itemRects} className="card-grid-highlight" />
            {visibleTasks.map((task, index) => <TaskCard key={task.assignmentId}
              task={{ name: task.title, goal: task.goal, status: task.active ? '已分配' : '任务已暂停' }}
              action={task.active ? '进入任务' : '查看任务'} index={index}
              registerItem={hover.registerItem} onOpen={() => navigate('/task/' + encodeURIComponent(task.assignmentId))} />)}
          </div>}
      </> : courses.length === 0 ? <div className="empty">暂无获准的学生课程与任务</div>
        : <CourseTiles courses={courses.map(course => course.courseId)} tasks={[]}
          titleOf={displayCourseName}
          summaryOf={id => `${courses.find(course => course.courseId === id)!.assignments.length} 个分配任务`}
          toneOf={id => realCourseTone(courses.find(course => course.courseId === id)!)}
          onOpen={id => setSearchParams({ course: id })} />}
    </div>
  </div>
}

function PreparationHomePage() {
  const snapshot = useQuery({
    queryKey: ['home'],
    queryFn: () => learningApi.getHomeSnapshot(),
  })
  const navigate = useNavigate()
  // 选中课程放在 URL 查询串里：工作区返回（历史回退）时能恢复到课程任务视图
  const [searchParams, setSearchParams] = useSearchParams()
  const setCourse = (c: string | null) => setSearchParams(c ? { course: c } : {})
  const [statusFilter, setStatusFilter] = useState<'全部' | TaskStatus>('全部')
  const [query, setQuery] = useState('')

  if (!snapshot.data) return null
  const { tasks, dashboard } = snapshot.data
  const now = new Date(snapshot.data.now)

  const courses = [...new Set(tasks.map((t) => t.course))]
  const courseParam = searchParams.get('course')
  const course = courseParam && courses.includes(courseParam) ? courseParam : null
  // 零待完成课程保留显示，排在有待完成任务的课程之后；同组保持原顺序。
  const sortedCourses = [...courses].sort(
    (a, b) => Number(pendingCount(tasks, a) === 0) - Number(pendingCount(tasks, b) === 0),
  )
  const hour = now.getHours()
  const greeting = hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好'
  const continueTask = selectContinueTask(tasks)

  const visibleTasks = course
    ? sortTasks(filterTasks(tasks.filter((t) => t.course === course), statusFilter, query))
    : []

  return (
    <div className="content">
      <div className="intro">
        <h1>{greeting}，Robert</h1>
        <span className="date">
          {now.getMonth() + 1} 月 {now.getDate()} 日
        </span>
      </div>

      {PREP_BUILD && (
        <section className="prep-entry">
          <div className="prep-entry-body">
            <p className="prep-entry-flag">
              <Icon name="shield-check" size={15} tone="neutral" />
              {PREP_ENTRY_LABEL}
            </p>
            <h2>{PREP_ENTRY_COURSE}</h2>
            <p>{PREP_ENTRY_GOAL}</p>
            <p className="prep-entry-note">{PREP_ENTRY_NOTE}</p>
          </div>
          <button className="primary" onClick={() => navigate(PREP_TASK_ROUTE)}>
            <IconText name="arrow-right" position="end">进入准备工作区</IconText>
          </button>
        </section>
      )}

      <DashboardSection
        data={dashboard}
        tasks={tasks}
        now={now}
        continueSlot={
          continueTask && (
            <div className="db-continue">
              <span className="course-tag">
                <i className="dot" />
                {continueTask.mode === 'resume' ? '继续学习' : '建议开始'} ·{' '}
                {continueTask.task.course}
              </span>
              <h3>{continueTask.task.name}</h3>
              <p>
                {continueTask.mode === 'resume' ? continueTask.task.last : continueTask.task.goal}
              </p>
              <div className="db-continue-foot">
                <span className="pct">{progressPercent(continueTask.task)}%</span>
                <button
                  className="primary"
                  onClick={() => navigate('/task/' + continueTask.task.id)}
                >
                  <IconText name="arrow-right" position="end">{continueTask.mode === 'resume' ? '继续任务' : '开始任务'}</IconText>
                </button>
              </div>
            </div>
          )
        }
      />

      <div>
        <div className="sectionhead">
          <h2>
            {course ? '课程与任务' : '我的课程'}
            <small>
              {course
                ? tasks.filter((t) => t.course === course).length + ' 个任务'
                : courses.length + ' 门'}
            </small>
          </h2>
        </div>

        {course === null ? (
          <CourseTiles
            courses={sortedCourses}
            toneOf={(c) => courses.indexOf(c)}
            tasks={tasks}
            onOpen={setCourse}
          />
        ) : (
          <>
            <div className="course-breadcrumb">
              <button onClick={() => setCourse(null)}><IconText name="alt-arrow-left">全部课程</IconText></button>
              <span>/</span>
              <strong>{course}</strong>
            </div>
            <TaskToolbar filters={STATUS_FILTERS} value={statusFilter} onFilter={setStatusFilter} query={query} onQuery={setQuery} />
            {visibleTasks.length > 0 ? (
              <TaskCards
                tasks={visibleTasks}
                now={now}
                onOpen={(t) => navigate('/task/' + t.id)}
              />
            ) : (
              <div className="empty">
                {/* b2（2026-10-10 定稿）：I024 落地——任务无结果配 folder-search 小图标 */}
                <Icon name="folder-search" size={22} />
                此课程没有匹配的任务
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** 两种数据来源共用 Design 原筛选与搜索控件。 */
function TaskToolbar<T extends string>({ filters, value, onFilter, query, onQuery }: {
  filters: readonly T[]; value: T; onFilter: (value: T) => void; query: string; onQuery: (value: string) => void
}) {
  const searchRef = useRef<HTMLInputElement>(null)
  return <div className="task-toolbar">
    <div className="filters">{filters.map(filter => <button key={filter}
      className={value === filter ? 'filter active' : 'filter'} onClick={() => onFilter(filter)}>{filter}</button>)}</div>
    <label className="search">
      <Icon name="minimalistic-magnifier" size={14} />
      <input ref={searchRef} aria-label="搜索任务" placeholder="搜索任务或课程…" value={query} onChange={event => onQuery(event.target.value)} />
      {query !== '' && <button type="button" className="search-clear" aria-label="清除搜索"
        onClick={() => { onQuery(''); searchRef.current?.focus() }}><Icon name="close" size={12} /></button>}
    </label>
  </div>
}

/**
 * 课程卡片组（参考 fluidfunctionalism Card 的 2-D fluid hover）：整组共享一块
 * 高亮，弹性滑向指针最近的卡片；卡片 = 封面图 + 名称 + 待完成数 +「查看任务」。
 */
function CourseTiles({
  courses,
  toneOf,
  tasks,
  onOpen,
  titleOf = course => course,
  summaryOf,
}: {
  courses: string[]
  toneOf: (course: string) => number
  tasks: ProjectTask[]
  onOpen: (course: string) => void
  titleOf?: (course: string) => string
  summaryOf?: (course: string) => string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const hover = useFluidHover(ref)
  return (
    <div className="course-tiles" ref={ref} {...hover.handlers}>
      <FluidHighlight
        activeIndex={hover.activeIndex}
        rects={hover.itemRects}
        className="card-grid-highlight"
      />
      {courses.map((c, i) => (
        <CourseTile
          key={c}
          course={titleOf(c)}
          index={i}
          tone={toneOf(c)}
          summary={summaryOf ? summaryOf(c) : pendingCount(tasks, c) > 0 ? pendingCount(tasks, c) + ' 个待完成' : '暂无待完成任务'}
          onOpen={() => onOpen(c)}
          registerItem={hover.registerItem}
        />
      ))}
    </div>
  )
}

function CourseTile({
  course,
  index,
  tone,
  summary,
  onOpen,
  registerItem,
}: {
  course: string
  index: number
  tone: number
  summary: string
  onOpen: () => void
  registerItem: (index: number, el: HTMLElement | null) => void
}) {
  const tileRef = useRef<HTMLButtonElement>(null)
  useRegisterFluidHoverItem(registerItem, index, tileRef)
  const [imgFailed, setImgFailed] = useState(false)
  const cover = COURSE_COVERS[course]
  return (
    <button ref={tileRef} className="course-tile" onClick={onOpen}>
      {cover && !imgFailed ? (
        <img className="course-cover" src={cover} alt="" onError={() => setImgFailed(true)} />
      ) : (
        <span className={`course-cover-ph course-${tone}`} aria-hidden>
          <Icon name={COURSE_ICONS[tone] ?? 'virtual-board'} size={48} />
        </span>
      )}
      <span className="course-tile-body">
        <h3>{course}</h3>
        <p>{summary}</p>
        <span className="course-tile-foot">
          <span className="cb-primary">查看任务</span>
        </span>
      </span>
    </button>
  )
}

/**
 * 课程内任务卡片组：与课程卡片组共用同一套 2-D fluid hover——整组共享一块高亮，
 * 弹性滑向指针最近的卡片；卡片自身不做位移 / 描边 hover，反馈交给高亮。
 */
function TaskCards({
  tasks,
  now,
  onOpen,
}: {
  tasks: ProjectTask[]
  now: Date
  onOpen: (task: ProjectTask) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const hover = useFluidHover(ref)
  return (
    <div className="task-card-grid" ref={ref} {...hover.handlers}>
      <FluidHighlight
        activeIndex={hover.activeIndex}
        rects={hover.itemRects}
        className="card-grid-highlight"
      />
      {tasks.map((t, i) => (
        <TaskCard
          key={t.id}
          task={{ ...t, progress: { percent: progressPercent(t), done: t.status === '已完成' } }}
          index={i}
          overdue={isOverdue(t, now)}
          onOpen={() => onOpen(t)}
          registerItem={hover.registerItem}
        />
      ))}
    </div>
  )
}

function TaskCard({
  task,
  index,
  overdue = false,
  action: explicitAction,
  onOpen,
  registerItem,
}: {
  task: { name: string; goal?: string; status: TaskDisplayStatus; deadlineAt?: string | null
    progress?: { percent: number; done: boolean } }
  index: number
  overdue?: boolean
  action?: string
  onOpen: () => void
  registerItem: (index: number, el: HTMLElement | null) => void
}) {
  const cardRef = useRef<HTMLButtonElement>(null)
  useRegisterFluidHoverItem(registerItem, index, cardRef)
  const action = explicitAction ?? (
    task.status === '未开始' ? '开始任务' : task.status === '进行中' ? '继续任务' : '查看任务')
  return (
    <button ref={cardRef} className={`task-card${task.progress ? '' : ' task-card-without-progress'}`} onClick={onOpen}>
      <div>
        <StatusChip status={task.status} />
        {overdue && <span className="status overdue">已逾期</span>}
      </div>
      <h3>{task.name}</h3>
      {task.goal && <p>{task.goal}</p>}
      {task.progress && <><div className="progresslabel">
        <span>任务进度</span>
        <span>{task.progress.percent}%</span>
      </div>
      <ProgressBar percent={task.progress.percent} done={task.progress.done} /></>}
      <div className="card-foot">
        <span className={task.deadlineAt ? 'deadline' : undefined}>
          {task.deadlineAt ? '截止 ' + formatDeadline(task.deadlineAt) : ''}
        </span>
        <span className="action"><IconText name="arrow-right" position="end">{action}</IconText></span>
      </div>
    </button>
  )
}
