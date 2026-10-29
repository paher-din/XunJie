import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionView } from '../workspace/contracts'
import { loadTeacherData } from './live'

const session: SessionView = { userId: 'teacher', csrfToken: 'csrf', courses: [
  { courseId: 'synthetic-robert-course-c', role: 'teacher' },
  { courseId: 'empty/course', role: 'teacher' },
  { courseId: 'student-course', role: 'student' },
] }
const assignment = (assignmentId: string, studentId: string, activityVersionId = 'activity', executionKind = 'textscope') => ({
  assignmentId, studentId, activityVersionId, assignmentRevision: 1, active: true,
  executionKind, runtimeProfileVersion: 'profile',
})
const activity = (courseId = 'synthetic-robert-course-c', activityVersionId = 'activity') => ({
  activityVersionId, courseId, sourceRevision: 7, activityControlRevision: 1, status: 'active',
  runtimeProfileVersionId: 'profile',
  content: { audience: 'teacher-validator', content: { projectTitle: '固定项目', problem: '真实任务说明' },
    materials: [{ status: 'available', title: '教师私有材料', text: 'private-body-must-not-enter-list' }] },
})
function transport(data: Record<string, unknown>) {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(init.method).toBe('GET')
    expect(init.credentials).toBe('same-origin')
    expect(init.signal).toBeInstanceOf(AbortSignal)
    if (!Object.hasOwn(data, url)) throw new Error(`Unexpected read ${url}`)
    return new Response(JSON.stringify({ requestId: 'teacher-read', data: data[url] }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}
afterEach(() => vi.unstubAllGlobals())

describe('教师真实只读适配器（HTTP协议替身）', () => {
  it('只读任教课程、同一固定活动只读一次，保留真实分配数与未知进展并丢弃私有材料', async () => {
    const fetcher = transport({
      '/api/courses/synthetic-robert-course-c/assignments': [assignment('a1', 's1'), assignment('a2', 's2')],
      '/api/courses/empty%2Fcourse/assignments': [],
      '/api/activities/activity?audience=teacher-validator': activity(),
    })
    const result = await loadTeacherData(session)
    expect(fetcher.mock.calls.map(call => call[0])).toEqual([
      '/api/courses/synthetic-robert-course-c/assignments', '/api/courses/empty%2Fcourse/assignments',
      '/api/activities/activity?audience=teacher-validator',
    ])
    expect(result.courses).toMatchObject([
      { id: 'synthetic-robert-course-c', title: 'synthetic-robert-course-c', kind: 'c', term: '' },
      { id: 'empty/course', title: 'empty/course', kind: 'unknown' },
    ])
    expect(result.activities).toEqual([{ id: 'activity', courseId: 'synthetic-robert-course-c', title: '固定项目',
      description: '真实任务说明', status: 'active', version: 7, assigned: 2, submitted: -1, reviewed: -1, due: '' }])
    expect(result).toMatchObject({ resources: [], drafts: [], learners: [] })
    expect(JSON.stringify(result)).not.toContain('private-body')
  })

  it('混合执行种类如实标记，缺失来源修订不虚构版本号', async () => {
    const cActivity = activity('mixed', 'c-activity')
    const hdlActivity = { ...activity('mixed', 'hdl-activity'), sourceRevision: undefined, status: 'paused' }
    transport({
      '/api/courses/mixed/assignments': [assignment('c', 's1', 'c-activity'), assignment('h', 's2', 'hdl-activity', 'hdl_board')],
      '/api/activities/c-activity?audience=teacher-validator': cActivity,
      '/api/activities/hdl-activity?audience=teacher-validator': hdlActivity,
    })
    const result = await loadTeacherData({ ...session, courses: [{ courseId: 'mixed', role: 'teacher' }] })
    expect(result.courses[0]?.kind).toBe('mixed')
    expect(result.activities[1]).toMatchObject({ status: 'paused', version: 0, submitted: -1, reviewed: -1 })
  })

  it('非法分配、重复记录、活动归属或预览身份不符都拒绝接纳', async () => {
    const onlyCourse: SessionView = { ...session, courses: [session.courses[0]!] }
    const a = assignment('a1', 's1')
    const cases = [
      { list: { items: [a] }, view: activity() },
      { list: [{ ...a, active: 'true' }], view: activity() },
      { list: [{ ...a, assignmentRevision: 0 }], view: activity() },
      { list: [a, a], view: activity() },
      { list: [a], view: activity('another-course') },
      { list: [a], view: { ...activity(), activityVersionId: 'another-activity' } },
      { list: [a], view: { ...activity(), status: 'completed' } },
      { list: [a], view: { ...activity(), content: { ...activity().content, audience: 'student' } } },
      { list: [a], view: { ...activity(), content: { ...activity().content, content: { projectTitle: '' } } } },
    ]
    for (const candidate of cases) {
      const fetcher = transport({
        '/api/courses/synthetic-robert-course-c/assignments': candidate.list,
        '/api/activities/activity?audience=teacher-validator': candidate.view,
      })
      await expect(loadTeacherData(onlyCourse)).rejects.toThrow()
      expect(fetcher.mock.calls.every(([url]) => url.startsWith('/api/'))).toBe(true)
    }
  })

  it('非教师会话、服务端失败、非法信封及断网保持失败，不回退合成数据', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    await expect(loadTeacherData({ ...session, courses: [{ courseId: 'student-course', role: 'student' }] }))
      .rejects.toThrow('没有任教课程')
    expect(fetcher).not.toHaveBeenCalled()
    const onlyCourse = { ...session, courses: [session.courses[0]!] }
    const responses: Array<() => Promise<Response>> = [
      async () => new Response(JSON.stringify({ requestId: 'failure', error: {
        code: 'DEPENDENCY_UNAVAILABLE', message: 'Offline', retryable: true, recovery: 'Retry',
      } }), { status: 503 }),
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
      async () => { throw new Error('Network offline') },
    ]
    for (const response of responses) {
      const failing = vi.fn(async (_url: string, _init: RequestInit) => response())
      vi.stubGlobal('fetch', failing)
      await expect(loadTeacherData(onlyCourse)).rejects.toThrow()
      expect(failing).toHaveBeenCalledTimes(1)
      expect(failing.mock.calls[0]?.[0]).toBe('/api/courses/synthetic-robert-course-c/assignments')
    }
  })
})
