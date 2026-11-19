import { useEffect, useMemo, useRef, useState } from 'react'
import type { Course, CourseTask } from '@xunjie/contracts/courses'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { toast } from '@xunjie/ui/feedback'
import { ConfirmationDialog } from '@xunjie/ui/foundation'
import { ActivityCardMenu, HomeStatus, HomeTaskCard, LearningCardGrid, TaskToolbar } from '@xunjie/ui/home'
import { formatDeadline, progressPercent } from '../lib/tasks'

const taskFilters = ['全部', '进行中', '未开始', '已提交', '已关闭'] as const
type TaskStatus = Exclude<(typeof taskFilters)[number], '全部'>

export interface CourseTaskSelection {
  courseId: string
  courseName: string
  task: CourseTask
  releaseId: string
}

function preferActivity(candidate: LearningActivity, current?: LearningActivity) {
  if (!current) return true
  if (candidate.status !== current.status) return candidate.status === 'open'
  return candidate.createdAt > current.createdAt
}

/** Repeated starts of a fixed release share a home entry. Distinct releases and personal activities keep their identities. */
export function schoolActivityEntries(activities: LearningActivity[]) {
  const entries = new Map<string, LearningActivity>()
  for (const activity of activities) {
    if (activity.purpose === 'preview' || activity.identity.kind !== 'school') continue
    const { course, identity } = activity
    const key = course
      ? JSON.stringify([identity.environmentId, identity.spaceId, identity.principalId, course.courseId, course.taskId, course.releaseId])
      : activity.activityId
    if (preferActivity(activity, entries.get(key))) entries.set(key, activity)
  }
  return [...entries.values()]
}

export function courseTaskEntry(activities: LearningActivity[] | null, courseId: string, taskId: string, releaseIds: string[]): {
  activity?: LearningActivity; status?: TaskStatus; action: string
} {
  let match: LearningActivity | undefined
  for (const activity of activities ?? []) {
    const binding = activity.course
    if (activity.purpose === 'preview' || binding?.courseId !== courseId || binding.taskId !== taskId
      || !releaseIds.includes(binding.releaseId)) continue
    if (preferActivity(activity, match)) match = activity
  }
  if (!match) return { status: activities ? '未开始' : undefined, action: '开始任务' }
  return match.status === 'open' ? { activity: match, status: '进行中', action: '继续任务' }
    : { activity: match, status: '已关闭', action: '查看活动' }
}

export function courseReleaseDate(value: string) {
  return new Date(value).toLocaleDateString('zh-CN')
}

export function courseTaskProgress(total: number, completedObjectives?: readonly number[]) {
  if (!total) return
  const completed = completedObjectives?.length ?? 0
  return {
    label: `任务进度 · 已勾选 ${completed}/${total} 项`,
    percent: progressPercent({ stepsDone: completed, stepsTotal: total }),
    done: completed === total,
  }
}

export function SchoolCourseTasks({ course, activities, busy, readSubmission, onOpen, onOpenActivity, onStatus }: {
  course: Course
  activities: LearningActivity[] | null
  busy: boolean
  readSubmission: (activity: LearningActivity, signal: AbortSignal) => Promise<boolean>
  onOpen: (selection: CourseTaskSelection) => void
  onOpenActivity: (id: string) => void
  onStatus?: (activity: LearningActivity) => Promise<void>
}) {
  const toolbar = useRef<HTMLDivElement>(null)
  const confirmTrigger = useRef<HTMLButtonElement | null>(null)
  const statusPending = useRef(false)
  const [closing, setClosing] = useState<LearningActivity | null>(null)
  const [updatingStatus, setUpdatingStatus] = useState(false)
  const [statusError, setStatusError] = useState('')
  const [filter, setFilter] = useState<(typeof taskFilters)[number]>('全部')
  const [query, setQuery] = useState('')
  const term = query.trim().toLocaleLowerCase()
  const rows = useMemo(() => course.tasks.map(task => {
    const entry = courseTaskEntry(activities, course.courseId, task.taskId, task.releases.map(release => release.releaseId))
    const release = task.releases.find(item => item.releaseId === entry.activity?.course?.releaseId) ?? task.releases[0]
    return { task, entry, release }
  }), [activities, course])
  const [submissions, setSubmissions] = useState<{ rows: typeof rows; values: Record<string, boolean> }>()
  useEffect(() => {
    const controller = new AbortController()
    for (const { entry: { activity } } of rows) {
      if (!activity) continue
      void readSubmission(activity, controller.signal).then(submitted => {
        if (controller.signal.aborted) return
        setSubmissions(current => ({
          rows, values: { ...(current?.rows === rows ? current.values : {}), [activity.activityId]: submitted },
        }))
      }).catch(() => { /* Without a receipt list the submission status is unknown. */ })
    }
    return () => controller.abort()
  }, [rows, readSubmission])

  async function updateStatus(activity: LearningActivity) {
    if (!onStatus || statusPending.current || busy) return
    statusPending.current = true
    setUpdatingStatus(true)
    setStatusError('')
    try {
      await onStatus(activity)
      setClosing(null)
      toast.success(activity.status === 'closed' ? '活动已重新开始。' : '活动已关闭，作品与记录保留。')
    } catch (error) {
      const message = error instanceof Error && error.name !== 'ZodError'
        ? error.message : '活动状态响应不完整，请刷新列表核对后重试。'
      if (activity.status === 'open') setStatusError(message)
      else toast.error(message)
    } finally {
      statusPending.current = false
      setUpdatingStatus(false)
    }
  }

  const now = Date.now()
  const tasks = rows.map(({ task, entry, release }) => {
    const submitted = entry.activity
      ? (submissions?.rows === rows ? submissions.values[entry.activity.activityId] : undefined)
      : entry.status === '未开始' ? false : undefined
    const due = release?.deadlineAt ? Date.parse(release.deadlineAt) : Infinity
    const status = submitted ? '已提交' as const : entry.status
    return { task, entry, release, submitted, due, status }
  }).filter(({ task, release, status }) => (filter === '全部' || filter === status)
    && (!term || [task.title, task.summary, ...(release?.objectives ?? []), course.name].some(value => value.toLocaleLowerCase().includes(term))))
    .sort((a, b) => Number(!!a.submitted) - Number(!!b.submitted) || a.due - b.due)

  return <>
    <div ref={toolbar}><TaskToolbar filters={taskFilters} value={filter} onFilter={setFilter} query={query} onQuery={setQuery} /></div>
    {tasks.length === 0 ? <HomeStatus kind="empty" message={course.tasks.length === 0 ? '此课程暂无已发布的任务。' : '此课程没有匹配的任务'} searchIcon />
      : <LearningCardGrid>{tasks.map(({ task, entry, release, submitted, due, status }) => {
        const activity = entry.activity
        return <HomeTaskCard key={task.taskId} title={task.title} goal={task.summary || release?.objectives[0]} status={release ? status : undefined}
          activityId={activity?.activityId}
          opensDialog={!!release} disabled={!release || busy}
          menu={activity && onStatus && <ActivityCardMenu title={task.title} closed={activity.status === 'closed'} disabled={busy} statusPending={updatingStatus}
            onOpen={() => onOpenActivity(activity.activityId)} onChangeStatus={trigger => {
              if (activity.status === 'closed') void updateStatus(activity)
              else { confirmTrigger.current = trigger; setStatusError(''); setClosing(activity) }
            }} />}
          overdue={submitted === false && due < now}
          progress={release && entry.status ? courseTaskProgress(release.objectives.length, entry.activity?.completedObjectives) : undefined}
          footer={release?.deadlineAt ? <time dateTime={release.deadlineAt}>截止 {formatDeadline(release.deadlineAt)}</time>
            : release ? '无截止时间' : undefined}
          action={release ? entry.action : '尚未发布'} onOpen={() => {
            if (release) onOpen({ courseId: course.courseId, courseName: course.name, task, releaseId: release.releaseId })
          }} />
      })}</LearningCardGrid>}
    <ConfirmationDialog open={!!closing} title="关闭活动" confirmLabel="关闭活动" busy={updatingStatus} error={statusError}
      description={<>关闭「{closing?.course?.taskTitle}」后会停止活动的运行。已有作品和学习记录会保留，你可以重新开始。</>}
      onClose={() => { setClosing(null); setStatusError('') }} onConfirm={() => { if (closing) void updateStatus(closing) }}
      onReturnFocus={() => {
        if (confirmTrigger.current?.isConnected) confirmTrigger.current.focus()
        else toolbar.current?.querySelector<HTMLInputElement>('input')?.focus()
      }} />
  </>
}
