import type { ActivityView, SessionView } from './contracts'
import { apiGet } from './http'

/** 当前宿主的课程分配列表投影；没有进度或截止时间。 */
interface AssignmentSummary {
  assignmentId: string
  displayTitle?: string
  studentId: string
  activityVersionId: string
  active: boolean
  executionKind: 'textscope' | 'hdl_board'
}

export interface HomeAssignment extends AssignmentSummary {
  title: string
  goal?: string
}

export interface HomeCourse {
  courseId: string
  name?: string
  assignments: HomeAssignment[]
}

/**
 * 历次合成验证可能发布相同的活动正文到同一个学生。列表只展示一个入口，
 * 但不改变 Assignment、Attempt 或原深链。标题相同而正文/材料/帮助政策/
 * 执行配置不同的活动是不同任务，不能折叠。
 */
function distinctAssignments(rows: Array<{ assignment: HomeAssignment; activity: ActivityView }>): HomeAssignment[] {
  const visible: HomeAssignment[] = []
  const positions = new Map<string, number>()
  for (const { assignment, activity } of rows) {
    const identity = JSON.stringify([
      assignment.studentId,
      assignment.executionKind,
      assignment.displayTitle?.trim() ?? null,
      activity.content,
      activity.helpPolicy,
      activity.runtimeProfileVersionId,
      activity.execution ?? null,
    ])
    const position = positions.get(identity)
    if (position === undefined) {
      positions.set(identity, visible.length)
      visible.push(assignment)
    } else if (assignment.active || !visible[position]!.active) {
      // 服务端按 Assignment ID 稳定排序；当前可用者优先，同状态取末项。
      visible[position] = assignment
    }
  }
  return visible
}

/** 沿当前 Session 的学生课程读取；只读，不创建 Attempt 或触发学习操作。 */
export async function loadHomeCourses(session: SessionView): Promise<HomeCourse[]> {
  const options = { mode: 'real' as const, timeoutMs: 15_000 }
  return Promise.all(session.courses.filter(course => course.role === 'student').map(async ({ courseId, name }) => {
    const summaries = await apiGet<AssignmentSummary[]>(`/courses/${encodeURIComponent(courseId)}/assignments`, options)
    if (!Array.isArray(summaries) || summaries.some(item =>
      !item || typeof item.assignmentId !== 'string' || !item.assignmentId ||
      typeof item.activityVersionId !== 'string' || !item.activityVersionId ||
      item.studentId !== session.userId || typeof item.active !== 'boolean' ||
      !['textscope', 'hdl_board'].includes(item.executionKind))) {
      throw new Error('任务列表不可用，请重新读取。')
    }
    const resolved = await Promise.all(summaries.map(async summary => {
      const activity = await apiGet<ActivityView>(`/activities/${encodeURIComponent(summary.activityVersionId)}?audience=student`, options)
      const title = activity?.content?.content?.projectTitle
      if (activity?.activityVersionId !== summary.activityVersionId || activity.courseId !== courseId ||
        activity.content?.audience !== 'student' || typeof title !== 'string' || !title.trim()) {
        throw new Error('任务说明不可用，请重新读取。')
      }
      const goals = activity.content.content.goals ?? []
      const goal = goals.find(item => item.core)?.title ?? goals[0]?.title
      return { assignment: { ...summary, title, goal }, activity }
    }))
    return { courseId, name, assignments: distinctAssignments(resolved) }
  }))
}
