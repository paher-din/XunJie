/** Teacher-space data: real school course catalog plus labelled synthetic student work. */
export interface TeacherRelease {
  releaseId: string
  publishedAt: string
  objectives: string[]
}

export interface TeacherTask {
  taskId: string
  title: string
  summary: string
  releases: TeacherRelease[]
}

export interface TeacherCourse {
  courseId: string
  name: string
  tasks: TeacherTask[]
}

export type SubmissionState = 'pending' | 'feedback' | 'revised' | 'done'

export interface TeacherSubmission {
  submissionId: string
  courseId: string
  taskId: string
  studentId: string
  studentName: string
  submittedAt: string
  state: SubmissionState
  version: number
  progress: { done: number; total: number }
  note: string
  artifacts: { name: string; kind: string; size: string }[]
  feedback: string
}

export interface TeacherDraft {
  draftId: string
  courseId: string
  title: string
  summary: string
  updatedAt: string
  objectives: string[]
}

export interface TeacherStudent {
  studentId: string
  name: string
  progress: 'not-started' | 'working' | 'pending' | 'done'
}

export interface TeacherCatalog {
  available: boolean
  courses: TeacherCourse[]
}

export interface TeacherLatestTask {
  task: TeacherTask
  release: TeacherRelease
}

/** The newest published release is the task the course pulse should describe. */
export function latestTaskOf(course: TeacherCourse): TeacherLatestTask | null {
  let latest: TeacherLatestTask | null = null
  const publishedTime = (release: TeacherRelease | null) => {
    const time = release?.publishedAt ? new Date(release.publishedAt).getTime() : 0
    return Number.isFinite(time) ? time : 0
  }
  for (const task of course.tasks) {
    const release = task.releases.reduce<TeacherRelease | null>((newest, candidate) => {
      if (!newest) return candidate
      return publishedTime(candidate) > publishedTime(newest) ? candidate : newest
    }, null)
    if (!release) continue
    if (!latest || publishedTime(release) > publishedTime(latest.release)) {
      latest = { task, release }
    }
  }
  return latest
}

const catalogCache = new Map<string, Promise<TeacherCatalog>>

/** The school only returns the catalog to a member with course.manage; 403 means "not a teacher". */
export function loadTeacherCatalog(namespace: string, connectionKey: string): Promise<TeacherCatalog> {
  const cacheKey = namespace + ':' + connectionKey
  const cached = catalogCache.get(cacheKey)
  if (cached) return cached
  const request = fetch('/api/learning/manage/course-catalog', {
    method: 'POST', credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-xj-space': connectionKey, 'x-xj-namespace': namespace },
    body: '{}',
  }).then(async response => {
    if (response.status === 403) return { available: false, courses: [] }
    if (!response.ok) throw new Error('课程目录暂时无法读取。')
    const body = await response.json() as { courses?: unknown }
    return { available: true, courses: parseCourses(body.courses) }
  }).catch(error => {
    catalogCache.delete(cacheKey)
    throw error
  })
  catalogCache.set(cacheKey, request)
  return request
}

function parseCourses(value: unknown): TeacherCourse[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    const course = item as { courseId?: unknown; name?: unknown; tasks?: unknown }
    if (typeof course.courseId !== 'string' || typeof course.name !== 'string' || !Array.isArray(course.tasks)) return []
    return [{
      courseId: course.courseId, name: course.name,
      tasks: course.tasks.flatMap(taskValue => {
        const task = taskValue as { taskId?: unknown; title?: unknown; summary?: unknown; releases?: unknown }
        if (typeof task.taskId !== 'string' || typeof task.title !== 'string') return []
        return [{
          taskId: task.taskId, title: task.title, summary: typeof task.summary === 'string' ? task.summary : '',
          releases: Array.isArray(task.releases) ? task.releases.flatMap(releaseValue => {
            const release = releaseValue as { releaseId?: unknown; publishedAt?: unknown; objectives?: unknown }
            if (typeof release.releaseId !== 'string') return []
            return [{
              releaseId: release.releaseId, publishedAt: typeof release.publishedAt === 'string' ? release.publishedAt : '',
              objectives: Array.isArray(release.objectives) ? release.objectives.filter((item): item is string => typeof item === 'string') : [],
            }]
          }) : [],
        }]
      }),
    }]
  })
}

const STUDENT_NAMES = ['陈一鸣', '林知远', '苏念', '周予安', '郑亦然', '何知微', '许清和', '唐莞', '顾行舟', '沈砚', '江晚', '罗屿']

const STUDENT_OFFSETS = [0, 4, 2]

const STATE_CYCLE: SubmissionState[] = ['pending', 'revised', 'done', 'feedback', 'pending', 'done', 'revised', 'done', 'feedback', 'pending', 'revised', 'done']

const ARTIFACT_SETS: TeacherSubmission['artifacts'][] = [
  [{ name: 'alu.circ', kind: 'Logisim 电路', size: '18.4 KB' }, { name: '验证记录.md', kind: 'Markdown', size: '6.2 KB' }],
  [{ name: 'alu-report.pdf', kind: 'PDF', size: '1.1 MB' }],
  [{ name: 'truth-table.csv', kind: 'CSV', size: '3.8 KB' }, { name: '波形截图.png', kind: '图片', size: '842 KB' }],
]

const NOTES = [
  '完成 4 位行波进位加法与减法，进位延迟还没有测；请老师看看结构是否可行。',
  '按课上的提示改成了超前进位，附上真值表和仿真波形。',
  '只完成了加法部分，减法借位仍在调试，先提交当前版本。',
  '补齐了标志位 Z/C/V，并核对了 8 组输入输出。',
]

function seedOf(value: string) {
  let seed = 0
  for (const character of value) seed = (seed * 31 + character.charCodeAt(0)) % 9973
  return seed
}

/** Synthetic but deterministic: same catalog always yields the same demo cohort. */
export function teacherCohort(courses: TeacherCourse[]) {
  const students: TeacherStudent[] = STUDENT_NAMES.map((name, index) => ({
    studentId: 'student-' + (index + 1), name,
    progress: index < 4 ? 'done' : index < 7 ? 'pending' : index < 10 ? 'working' : 'not-started',
  }))
  const submissions: TeacherSubmission[] = []
  const drafts: TeacherDraft[] = []
  for (const [courseIndex, course] of courses.entries()) {
    const latest = latestTaskOf(course)
    if (!latest) continue
    const task = latest.task
    const release = latest.release
    const count = courseIndex === 0 ? 9 : courseIndex === 1 ? 5 : 2
    for (let index = 0; index < count; index += 1) {
      const seed = seedOf(course.courseId + index)
      const state = STATE_CYCLE[index % STATE_CYCLE.length]!
      const studentIndex = (index + (STUDENT_OFFSETS[courseIndex] ?? 0)) % STUDENT_NAMES.length
      submissions.push({
        submissionId: `${course.courseId}-submission-${index + 1}`,
        courseId: course.courseId, taskId: task.taskId,
        studentId: 'student-' + (studentIndex + 1),
        studentName: STUDENT_NAMES[studentIndex]!,
        submittedAt: new Date(Date.UTC(2026, 10, 20 - index * 2, seed % 12, (seed % 60))).toISOString(),
        state, version: 1 + (seed % 3),
        progress: { done: Math.min(release?.objectives.length ?? 4, 2 + (seed % 3)), total: release?.objectives.length ?? 4 },
        note: NOTES[seed % NOTES.length]!,
        artifacts: ARTIFACT_SETS[seed % ARTIFACT_SETS.length]!,
        feedback: state === 'pending' ? '' : state === 'done'
          ? '结构与标志位验证通过，可以收尾。'
          : '进位链解释得清楚，减法借位的边界情况还需要再验证一组。',
      })
    }
    drafts.push({
      draftId: `${course.courseId}-draft-1`, courseId: course.courseId,
      title: courseIndex === 1 ? '用超前进位优化 ALU 延迟' : `${task.title} · 复盘与迁移`,
      summary: courseIndex === 1 ? '在 4 位 ALU 的基础上比较行波进位与超前进位的延迟，并给出测量方法。' : '整理这次任务的失败点，设计一个可以迁移到新情境的小练习。',
      updatedAt: new Date(Date.UTC(2026, 10, 21 - courseIndex, 7 + courseIndex * 2, 30)).toISOString(),
      objectives: ['能说明进位延迟的来源', '用波形或计时数据比较两种结构', '给出一次可复现的测量记录'],
    })
  }
  return { students, submissions, drafts }
}

export const submissionLabel: Record<SubmissionState, string> = {
  pending: '待审阅', feedback: '已反馈', revised: '待复核', done: '已完成',
}
