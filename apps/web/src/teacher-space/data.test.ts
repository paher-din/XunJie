import { afterEach, expect, it, vi } from 'vitest'
import { latestTaskOf, loadTeacherCatalog, teacherCohort, type TeacherCourse } from './data'

afterEach(() => { vi.unstubAllGlobals() })

const release = (releaseId: string, publishedAt: string, objectives = ['目标']) => ({ releaseId, publishedAt, objectives })
const task = (taskId: string, releases = [release('release-' + taskId, '2026-11-20T00:00:00.000Z')]) => ({
  taskId, title: taskId, summary: '', releases,
})
const course = (courseId: string, tasks = [task('task-' + courseId)]): TeacherCourse => ({ courseId, name: courseId, tasks })

it('picks the newest usable release across tasks and ignores unreleased or invalid dates', () => {
  expect(latestTaskOf(course('empty', [task('draft', [])]))).toBeNull()
  const older = task('older', [release('old', '2026-11-18T00:00:00.000Z')])
  const invalid = task('invalid', [release('bad', 'not-a-date')])
  const newest = task('newest', [
    release('stale', '2026-11-19T00:00:00.000Z'),
    release('latest', '2026-11-21T00:00:00.000Z'),
  ])
  expect(latestTaskOf(course('mixed', [older, invalid, newest]))).toMatchObject({
    task: { taskId: 'newest' }, release: { releaseId: 'latest' },
  })
  const tie = course('tie', [
    task('first', [release('one', '2026-11-20T00:00:00.000Z')]),
    task('second', [release('two', '2026-11-20T00:00:00.000Z')]),
  ])
  expect(latestTaskOf(tie)).toMatchObject({ task: { taskId: 'first' }, release: { releaseId: 'one' } })
})

it('builds a deterministic cohort only for courses with a published task', () => {
  const withWork = course('course-a')
  const withoutWork = course('course-b', [task('draft', [])])
  const first = teacherCohort([withWork, withoutWork])
  const second = teacherCohort([withWork, withoutWork])
  expect(first).toEqual(second)
  expect(first.submissions).toHaveLength(9)
  expect(first.submissions.every(item => item.courseId === 'course-a' && item.taskId === 'task-course-a')).toBe(true)
  expect(first.drafts).toHaveLength(1)
  expect(first.students).toHaveLength(12)
})

it('does not turn a catalog 403 into a session-long denial', async () => {
  const namespace = 'catalog-' + Math.random()
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response('{}', { status: 403 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ courses: [{ courseId: 'c', name: '课程', tasks: [] }] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    }))
  vi.stubGlobal('fetch', fetchMock)
  await expect(loadTeacherCatalog(namespace, 'school:connection')).resolves.toEqual({ available: false, courses: [] })
  await expect(loadTeacherCatalog(namespace, 'school:connection')).resolves.toMatchObject({ available: true })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
