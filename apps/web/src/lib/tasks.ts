import type { ProjectTask, TaskStatus } from '../bridge/types'

/** 已完成之外的都算待完成（未开始 + 进行中）。 */
export const isPending = (t: ProjectTask) => t.status !== '已完成'

/** 单任务进度：任务完成百分比，不是知识掌握率。 */
export function progressPercent(t: ProjectTask): number {
  return t.stepsTotal > 0 ? Math.round((t.stepsDone / t.stepsTotal) * 100) : 0
}

/** 逾期：未完成且截止时间早于快照时间。 */
export function isOverdue(t: ProjectTask, now: Date): boolean {
  return isPending(t) && t.deadlineAt !== null && Date.parse(t.deadlineAt) < now.getTime()
}

/**
 * 任务排序（已确认规则，见 docs/home-design.md）：
 * 未完成任务按截止时间从近到远（逾期自然排在前面），无截止时间的随后，
 * 已完成任务置底；相同截止时间保持稳定顺序。
 */
export function sortTasks(tasks: ProjectTask[]): ProjectTask[] {
  return [...tasks].sort((a, b) => {
    const doneA = isPending(a) ? 0 : 1
    const doneB = isPending(b) ? 0 : 1
    if (doneA !== doneB) return doneA - doneB
    if (doneA === 1) return 0
    const da = a.deadlineAt ? Date.parse(a.deadlineAt) : Infinity
    const db = b.deadlineAt ? Date.parse(b.deadlineAt) : Infinity
    return da - db
  })
}

/** 课程内待完成任务数（未开始 + 进行中）。 */
export function pendingCount(tasks: ProjectTask[], course: string): number {
  return tasks.filter((t) => t.course === course && isPending(t)).length
}

/**
 * 继续任务选择（已确认规则）：
 * 优先恢复最近一次学习且尚未完成的任务；没有学习记录时，
 * 以截止时间优先推荐未完成任务（建议开始）；没有未完成任务时返回 null。
 */
export function selectContinueTask(
  tasks: ProjectTask[],
): { task: ProjectTask; mode: 'resume' | 'suggest' } | null {
  const pending = tasks.filter(isPending)
  const studied = pending
    .filter((t) => t.lastStudiedAt !== null)
    .sort((a, b) => Date.parse(b.lastStudiedAt!) - Date.parse(a.lastStudiedAt!))
  if (studied.length > 0) return { task: studied[0], mode: 'resume' }
  const sorted = sortTasks(pending)
  return sorted.length > 0 ? { task: sorted[0], mode: 'suggest' } : null
}

/** 截止时间显示：「9月30日 23:59」。无截止时间的任务留空，不回退到活动时间。 */
export function formatDeadline(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

/** 状态筛选 + 名称/课程搜索。 */
export function filterTasks(
  tasks: ProjectTask[],
  statusFilter: '全部' | TaskStatus,
  query: string,
): ProjectTask[] {
  return tasks.filter(
    (t) =>
      (statusFilter === '全部' || t.status === statusFilter) &&
      (t.name + t.course).includes(query),
  )
}
