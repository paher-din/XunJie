import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { learningApi } from '../bridge/mockAdapter'
import { demoDashboard, demoTasks } from '../bridge/mockData'
import type { ProjectTask, TaskStatus } from '../bridge/types'
import { DashboardSection } from '../components/dashboard/DashboardSection'
import type { TaskDisplayStatus } from '@xunjie/ui/foundation'
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
import { displayAccountName, displayCourseName, displayProjectName } from '../lib/displayNames'
import { useHomeCourseNavigation } from '../lib/homeCourseNavigation'
import { ContinueTaskCard, TaskToolbar } from '../components/home/HomePrimitives'

const STATUS_FILTERS: Array<'全部' | TaskStatus> = ['全部', '进行中', '未开始', '已完成']
const ASSIGNMENT_FILTERS = ['全部', '已分配', '任务已暂停'] as const
import { CourseTiles as SharedCourseTiles, LearningCardGrid, HomeIntro, HomeCourseRegion, HomeSectionHeading, CourseBreadcrumb, HomeStatus, PreparationEntryCard, HomeTaskCard } from '@xunjie/ui/home'

function realCourseTone(course: HomeCourse): number {
  const kinds = new Set(course.assignments.map(task => task.executionKind))
  if (kinds.size === 0) return 2
  if (kinds.size > 1) return 2
  return kinds.has('hdl_board') ? 0 : 1
}

/**
 * 首页（已确认结构 A + 课程/任务形式 B）：
 * 学习看板（整宽，可个性化编辑；任务完成卡下半部分内嵌继续任务入口）→ 课程卡片（仅名称、待完成数、入口）→ 课程内任务卡片（截止时间优先）。
 */
export default function HomePage() {
  return PREP_BUILD ? <PreparationHomePage /> : <RealHomePage />
}

export function RealHomePage() {
  const session = useSession()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const snapshot = useQuery({
    queryKey: ['home', 'real', session.epoch, session.session?.userId],
    queryFn: () => loadHomeCourses(session.session!),
    enabled: session.status === 'authenticated' && !!session.session,
  })
  const courses = snapshot.data ?? []
  const selected = courses.find(course => course.courseId === searchParams.get('course'))
  const navigation = useHomeCourseNavigation(selected?.courseId ?? null, snapshot.isSuccess)
  const [statusFilter, setStatusFilter] = useState<typeof ASSIGNMENT_FILTERS[number]>('全部')
  const [query, setQuery] = useState('')
  const search = query.trim().toLowerCase()
  const visibleTasks = selected?.assignments.filter(task =>
    (statusFilter === '全部' || statusFilter === (task.active ? '已分配' : '任务已暂停')) &&
    `${displayProjectName(task.title, task.displayTitle)} ${task.title} ${task.goal ?? ''} ${displayCourseName(selected.courseId, selected.name)} ${selected.courseId}`.toLowerCase().includes(search)) ?? []
  const allTasks = courses.flatMap(course => course.assignments.map(task => ({ ...task, courseId: course.courseId, courseName: course.name })))
  const entryTask = !snapshot.isError && allTasks.find(task => task.active)
  const now = new Date()
  const hour = now.getHours()
  const greeting = hour < 12 ? '上午好' : hour < 18 ? '下午好' : '晚上好'
  return <div className="content home-page">
    <HomeIntro title={<>{greeting}，{displayAccountName(session.session!.userId, session.session!.displayName)}</>} date={<>{now.getMonth() + 1} 月 {now.getDate()} 日</>} />
    <DashboardSection key={session.session?.userId} storageKey={`dashboard.layout.v3:real:${session.session?.userId}`}
      data={demoDashboard} tasks={demoTasks} demoStatistics
      taskCount={snapshot.isSuccess ? allTasks.length : undefined} now={now}
      continueSlot={entryTask && <ContinueTaskCard
        tag={<>项目任务 · {displayCourseName(entryTask.courseId, entryTask.courseName)}</>}
        title={displayProjectName(entryTask.title, entryTask.displayTitle)}
        description={entryTask.goal || undefined}
        meta="当前获准任务" metaClassName="db-side" action="进入任务"
        onOpen={() => navigate('/task/' + encodeURIComponent(entryTask.assignmentId))}
      />} />
    <HomeCourseRegion selected={!!selected} regionRef={navigation.regionRef}>
    <HomeSectionHeading headingRef={navigation.headingRef} title={<>{selected ? '课程与任务' : '我的课程'}</>} count={<>{selected ? `${selected.assignments.length} 个任务` : `${courses.length} 门`}</>} refresh={{ disabled: snapshot.isFetching, onRefresh: () => { void snapshot.refetch() } }} />
    {snapshot.isPending ? <HomeStatus kind="loading" message="正在读取课程与任务…" />
      : snapshot.isError ? <HomeStatus kind="error" message="暂时无法读取课程与任务，请重试。已有任务链接仍可使用。" retry={{ disabled: snapshot.isFetching, onRetry: () => { void snapshot.refetch() } }} />
      : selected ? <>
        <CourseBreadcrumb title={displayCourseName(selected.courseId, selected.name)} onBack={keyboard => navigation.setCourse(null, keyboard)} />
        <TaskToolbar filters={ASSIGNMENT_FILTERS} value={statusFilter} onFilter={setStatusFilter} query={query} onQuery={setQuery} />
        {selected.assignments.length === 0 ? <HomeStatus kind="empty" message="此课程暂无分配任务" />
          : visibleTasks.length === 0 ? <HomeStatus kind="empty" message="此课程没有匹配的任务" searchIcon />
          : <LearningCardGrid>{registerItem => <>{visibleTasks.map((task, index) => <TaskCard key={task.assignmentId}
              task={{ name: displayProjectName(task.title, task.displayTitle), goal: task.goal, status: task.active ? '已分配' : '任务已暂停' }}
              action={task.active ? '进入任务' : '查看任务'} index={index}
              registerItem={registerItem} onOpen={() => navigate('/task/' + encodeURIComponent(task.assignmentId))} />)}</>}</LearningCardGrid>}
      </> : courses.length === 0 ? <HomeStatus kind="empty" message="暂无获准的学生课程与任务" />
        : <CourseTiles courses={courses.map(course => course.courseId)} tasks={[]}
          titleOf={id => displayCourseName(id, courses.find(course => course.courseId === id)?.name)}
          summaryOf={id => `${courses.find(course => course.courseId === id)!.assignments.length} 个分配任务`}
          toneOf={id => realCourseTone(courses.find(course => course.courseId === id)!)}
          onOpen={navigation.setCourse} />}
    </HomeCourseRegion>
  </div>
}

export function PreparationHomePage() {
  const snapshot = useQuery({
    queryKey: ['home'],
    queryFn: () => learningApi.getHomeSnapshot(),
  })
  const navigate = useNavigate()
  // 选中课程放在 URL 查询串里：工作区返回（历史回退）时能恢复到课程任务视图
  const [searchParams] = useSearchParams()
  const [statusFilter, setStatusFilter] = useState<'全部' | TaskStatus>('全部')
  const [query, setQuery] = useState('')

  const courseParam = searchParams.get('course')
  const course = courseParam && snapshot.data?.tasks.some(task => task.course === courseParam) ? courseParam : null
  const navigation = useHomeCourseNavigation(course, !!snapshot.data)

  if (!snapshot.data) return null
  const { tasks, dashboard } = snapshot.data
  const now = new Date(snapshot.data.now)

  const courses = [...new Set(tasks.map((t) => t.course))]
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
    <div className="content home-page">
      <HomeIntro title={<>{greeting}，Robert</>} date={<>
          {now.getMonth() + 1} 月 {now.getDate()} 日
        </>} />

      {PREP_BUILD && (
        <PreparationEntryCard flag={PREP_ENTRY_LABEL} title={PREP_ENTRY_COURSE} description={PREP_ENTRY_GOAL} note={PREP_ENTRY_NOTE} action="进入准备工作区" onOpen={() => navigate(PREP_TASK_ROUTE)} />
      )}

      <DashboardSection
        data={dashboard}
        tasks={tasks}
        now={now}
        continueSlot={
          continueTask && (
            <ContinueTaskCard
              tag={<>{continueTask.mode === 'resume' ? '继续学习' : '建议开始'} ·{' '}{continueTask.task.course}</>}
              title={continueTask.task.name}
              description={continueTask.mode === 'resume' ? continueTask.task.last : continueTask.task.goal}
              meta={<>{progressPercent(continueTask.task)}%</>} metaClassName="pct"
              action={continueTask.mode === 'resume' ? '继续任务' : '开始任务'}
              onOpen={() => navigate('/task/' + continueTask.task.id)}
            />
          )
        }
      />

      <HomeCourseRegion selected={!!course} regionRef={navigation.regionRef}>
        <HomeSectionHeading headingRef={navigation.headingRef} title={<>{course ? '课程与任务' : '我的课程'}</>} count={<>
              {course
                ? tasks.filter((t) => t.course === course).length + ' 个任务'
                : courses.length + ' 门'}
            </>} />

        {course === null ? (
          <CourseTiles
            courses={sortedCourses}
            toneOf={(c) => courses.indexOf(c)}
            tasks={tasks}
            onOpen={navigation.setCourse}
          />
        ) : (
          <>
            <CourseBreadcrumb title={course} onBack={keyboard => navigation.setCourse(null, keyboard)} />
            <TaskToolbar filters={STATUS_FILTERS} value={statusFilter} onFilter={setStatusFilter} query={query} onQuery={setQuery} />
            {visibleTasks.length > 0 ? (
              <TaskCards
                tasks={visibleTasks}
                now={now}
                onOpen={(t) => navigate('/task/' + t.id)}
              />
            ) : (
              <HomeStatus kind="empty" message="此课程没有匹配的任务" searchIcon />
            )}
          </>
        )}
      </HomeCourseRegion>
    </div>
  )
}

/**
 * 课程卡片组（参考 fluidfunctionalism Card 的 2-D fluid hover）：整组共享一块
 * 高亮，弹性滑向指针最近的卡片；卡片 = 封面图 + 名称 + 待完成数 +「查看任务」。
 */
export function CourseTiles({
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
  onOpen: (course: string, keyboard: boolean) => void
  titleOf?: (course: string) => string
  summaryOf?: (course: string) => string
}) {
  return <SharedCourseTiles courses={courses} toneOf={toneOf} onOpen={onOpen} titleOf={titleOf}
    summaryOf={id => summaryOf ? summaryOf(id) : pendingCount(tasks, id) > 0 ? pendingCount(tasks, id) + ' 个待完成' : '暂无待完成任务'} />
}

/**
 * 课程内任务卡片组：与课程卡片组共用同一套 2-D fluid hover——整组共享一块高亮，
 * 弹性滑向指针最近的卡片；卡片自身不做位移 / 描边 hover，反馈交给高亮。
 */
export function TaskCards({
  tasks,
  now,
  onOpen,
}: {
  tasks: ProjectTask[]
  now: Date
  onOpen: (task: ProjectTask) => void
}) {
  return (
    <LearningCardGrid>{registerItem => <>{tasks.map((t, i) => (
        <TaskCard
          key={t.id}
          task={{ ...t, progress: { percent: progressPercent(t), done: t.status === '已完成' } }}
          index={i}
          overdue={isOverdue(t, now)}
          onOpen={() => onOpen(t)}
          registerItem={registerItem}
        />
      ))}</>}</LearningCardGrid>
  )
}

export function TaskCard({
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
  const action = explicitAction ?? (task.status === '未开始' ? '开始任务' : task.status === '进行中' ? '继续任务' : '查看任务')
  return <HomeTaskCard title={task.name} goal={task.goal} index={index} register={registerItem} onOpen={onOpen} action={action}
    status={task.status} overdue={overdue} progress={task.progress}
    footer={task.deadlineAt ? '截止 ' + formatDeadline(task.deadlineAt) : undefined} />
}
