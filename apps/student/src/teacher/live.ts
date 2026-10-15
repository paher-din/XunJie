import { displayCourseName } from '../lib/displayNames'
import type { SessionView } from '../workspace/contracts'
import { apiGet } from '../workspace/http'
import type { TeacherActivity, TeacherCourse, TeacherData } from './types'

interface AssignmentSummary {
  assignmentId: string
  studentId: string
  activityVersionId: string
  assignmentRevision: number
  active: boolean
  executionKind: 'textscope' | 'hdl_board'
  runtimeProfileVersion: string
}

const requestOptions = { mode: 'real' as const, timeoutMs: 15_000 }
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const id = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 128
const revision = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

function teacherCourses(session: SessionView): string[] {
  if (!object(session) || !id(session.userId) || !id(session.csrfToken) || !Array.isArray(session.courses)) {
    throw new Error('教师会话响应不合法，请重新登录。')
  }
  const roles = new Map<string, string>()
  for (const course of session.courses) {
    if (!object(course) || !id(course.courseId) || (course.role !== 'teacher' && course.role !== 'student') ||
      (roles.has(course.courseId) && roles.get(course.courseId) !== course.role)) {
      throw new Error('教师课程归属不合法，请重新读取会话。')
    }
    roles.set(course.courseId, course.role)
  }
  const courses = [...roles].filter(([, role]) => role === 'teacher').map(([courseId]) => courseId)
  if (!courses.length) throw new Error('当前会话没有任教课程。')
  return courses
}

function assignments(value: unknown): AssignmentSummary[] {
  if (!Array.isArray(value) || value.some(item => !object(item) ||
    !id(item.assignmentId) || !id(item.studentId) || !id(item.activityVersionId) ||
    !revision(item.assignmentRevision) || typeof item.active !== 'boolean' ||
    (item.executionKind !== 'textscope' && item.executionKind !== 'hdl_board') || !id(item.runtimeProfileVersion))) {
    throw new Error('教师分配列表响应不合法，请重新读取。')
  }
  return value as AssignmentSummary[]
}

function courseKind(items: AssignmentSummary[]): TeacherCourse['kind'] {
  const kinds = new Set(items.map(item => item.executionKind))
  return kinds.size > 1 ? 'mixed' : kinds.has('textscope') ? 'c' : kinds.has('hdl_board') ? 'hdl' : 'unknown'
}

function activity(value: unknown, courseId: string, items: AssignmentSummary[]): TeacherActivity {
  const first = items[0]!
  if (!object(value) || value.activityVersionId !== first.activityVersionId || value.courseId !== courseId ||
    (value.status !== 'active' && value.status !== 'paused') || !revision(value.activityControlRevision) ||
    (value.sourceRevision !== undefined && !revision(value.sourceRevision)) ||
    value.runtimeProfileVersionId !== first.runtimeProfileVersion || !object(value.content) ||
    value.content.audience !== 'teacher-validator' || !object(value.content.content) ||
    typeof value.content.content.projectTitle !== 'string' || !value.content.content.projectTitle.trim() ||
    (value.content.content.problem !== undefined && typeof value.content.content.problem !== 'string')) {
    throw new Error('教师活动响应与课程、固定版本或预览身份不匹配，请重新读取。')
  }
  return {
    id: first.activityVersionId,
    courseId,
    title: value.content.content.projectTitle,
    description: typeof value.content.content.problem === 'string' ? value.content.content.problem : '',
    status: value.status as 'active' | 'paused',
    version: typeof value.sourceRevision === 'number' ? value.sourceRevision : 0,
    assigned: new Set(items.map(item => item.studentId)).size,
    submitted: -1,
    reviewed: -1,
    due: '',
  }
}

/** 只读取会话已授权的任教课程；缺少的进展/材料/草稿/复核接口保持空缺。 */
export async function loadTeacherData(session: SessionView): Promise<TeacherData> {
  const ids = teacherCourses(session)
  const lists = await Promise.all(ids.map(async courseId => ({
    courseId,
    items: assignments(await apiGet<unknown>(`/courses/${encodeURIComponent(courseId)}/assignments`, requestOptions)),
  })))
  const assignmentIds = new Set<string>()
  const groups = new Map<string, { courseId: string; items: AssignmentSummary[] }>()
  for (const { courseId, items } of lists) {
    for (const item of items) {
      if (assignmentIds.has(item.assignmentId)) throw new Error('教师分配列表包含重复记录，请重新读取。')
      assignmentIds.add(item.assignmentId)
      const previous = groups.get(item.activityVersionId)
      if (previous && (previous.courseId !== courseId ||
        previous.items[0]!.executionKind !== item.executionKind ||
        previous.items[0]!.runtimeProfileVersion !== item.runtimeProfileVersion)) {
        throw new Error('教师分配中的固定活动归属或执行配置不一致，请重新读取。')
      }
      if (previous) previous.items.push(item)
      else groups.set(item.activityVersionId, { courseId, items: [item] })
    }
  }
  const activities = await Promise.all([...groups].map(async ([activityId, group]) =>
    activity(await apiGet<unknown>(`/activities/${encodeURIComponent(activityId)}?audience=teacher-validator`, requestOptions),
      group.courseId, group.items)))
  return {
    courses: lists.map(({ courseId, items }) => {
      const name = displayCourseName(courseId, session.courses.find(course => course.courseId === courseId)?.name)
      return { id: courseId, title: name === `课程 ${courseId}` ? courseId : name,
        code: courseId, term: '', kind: courseKind(items) }
    }),
    activities,
    resources: [],
    drafts: [],
    learners: [],
  }
}
