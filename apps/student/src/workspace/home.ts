import type { ActivityView, SessionView } from './contracts'
import { apiGet } from './http'

/** 当前35表宿主的课程分配列表投影；没有进度或截止时间。 */
interface AssignmentSummary {
  assignmentId: string
  studentId: string
  activityVersionId: string
  active: boolean
  executionKind: 'textscope' | 'hdl_board'
}

export interface HomeAssignment extends AssignmentSummary {
  title: string
}

export interface HomeCourse {
  courseId: string
  assignments: HomeAssignment[]
}

/** 沿当前 Session 的学生课程读取；只读，不创建 Attempt 或触发学习操作。 */
export async function loadHomeCourses(session: SessionView): Promise<HomeCourse[]> {
  const options = { mode: 'real' as const, timeoutMs: 15_000 }
  return Promise.all(session.courses.filter(course => course.role === 'student').map(async ({ courseId }) => {
    const summaries = await apiGet<AssignmentSummary[]>(`/courses/${encodeURIComponent(courseId)}/assignments`, options)
    if (!Array.isArray(summaries) || summaries.some(item =>
      !item || typeof item.assignmentId !== 'string' || !item.assignmentId ||
      typeof item.activityVersionId !== 'string' || !item.activityVersionId ||
      item.studentId !== session.userId || typeof item.active !== 'boolean' ||
      !['textscope', 'hdl_board'].includes(item.executionKind))) {
      throw new Error('任务列表不可用，请重新读取。')
    }
    const assignments = await Promise.all(summaries.map(async summary => {
      const activity = await apiGet<ActivityView>(`/activities/${encodeURIComponent(summary.activityVersionId)}?audience=student`, options)
      const title = activity?.content?.content?.projectTitle
      if (activity?.activityVersionId !== summary.activityVersionId || activity.courseId !== courseId ||
        activity.content?.audience !== 'student' || typeof title !== 'string' || !title.trim()) {
        throw new Error('任务说明不可用，请重新读取。')
      }
      return { ...summary, title }
    }))
    return { courseId, assignments }
  }))
}
