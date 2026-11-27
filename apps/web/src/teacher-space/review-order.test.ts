import { expect, it } from 'vitest'
import type { TeacherSubmission } from './data'
import { orderSubmissions, submissionGroups, waitingText, type ReviewView } from './review-order'

const submission = (overrides: Partial<TeacherSubmission> & { submissionId: string }): TeacherSubmission => ({
  courseId: 'course', taskId: 'task', studentId: overrides.submissionId, studentName: '学生',
  submittedAt: '2026-11-20T09:00:00+08:00', state: 'pending', version: 1,
  progress: { done: 1, total: 1 }, note: '', artifacts: [], feedback: '',
  ...overrides,
})

const orderedNames = (items: TeacherSubmission[], view: ReviewView) => orderSubmissions(items, view).map(item => item.studentName)

it('queues first reviews before revisions and keeps both oldest-first', () => {
  const items = [
    submission({ submissionId: 'p-late', studentName: '林', submittedAt: '2026-11-20T09:00:00+08:00' }),
    submission({ submissionId: 'r-early', studentName: '郑', submittedAt: '2026-11-12T09:00:00+08:00', state: 'revised' }),
    submission({ submissionId: 'p-early', studentName: '陈', submittedAt: '2026-11-10T09:00:00+08:00' }),
    submission({ submissionId: 'r-late', studentName: '许', submittedAt: '2026-11-18T09:00:00+08:00', state: 'revised' }),
  ]
  expect(orderedNames(items, 'inbox')).toEqual(['陈', '林', '郑', '许'])
})

it('puts the queue above the archive in the all view and reads archive states newest-first', () => {
  const items = [
    submission({ submissionId: 'f-early', studentName: '苏', submittedAt: '2026-11-14T09:00:00+08:00', state: 'feedback' }),
    submission({ submissionId: 'd-late', studentName: '周', submittedAt: '2026-11-16T09:00:00+08:00', state: 'done' }),
    submission({ submissionId: 'p-early', studentName: '陈', submittedAt: '2026-11-10T09:00:00+08:00' }),
    submission({ submissionId: 'f-late', studentName: '何', submittedAt: '2026-11-19T09:00:00+08:00', state: 'feedback' }),
    submission({ submissionId: 'r-late', studentName: '许', submittedAt: '2026-11-18T09:00:00+08:00', state: 'revised' }),
    submission({ submissionId: 'd-early', studentName: '唐', submittedAt: '2026-11-11T09:00:00+08:00', state: 'done' }),
  ]
  expect(orderedNames(items, 'all')).toEqual(['陈', '许', '何', '苏', '周', '唐'])
})

it('uses the same in-group rule for a single-state filter', () => {
  const archived = [
    submission({ submissionId: 'f-late', studentName: '何', submittedAt: '2026-11-19T09:00:00+08:00', state: 'feedback' }),
    submission({ submissionId: 'f-early', studentName: '苏', submittedAt: '2026-11-14T09:00:00+08:00', state: 'feedback' }),
  ]
  expect(orderedNames(archived, 'feedback')).toEqual(['何', '苏'])
  const queued = [
    submission({ submissionId: 'p-late', studentName: '林', submittedAt: '2026-11-20T09:00:00+08:00' }),
    submission({ submissionId: 'p-early', studentName: '陈', submittedAt: '2026-11-10T09:00:00+08:00' }),
  ]
  expect(orderedNames(queued, 'pending')).toEqual(['陈', '林'])
})

it('breaks same-minute ties by version, then name, then submission id', () => {
  const same = '2026-11-20T09:00:00+08:00'
  expect(orderedNames([
    submission({ submissionId: 'v1', studentName: '甲', submittedAt: same, version: 1 }),
    submission({ submissionId: 'v3', studentName: '乙', submittedAt: same, version: 3 }),
  ], 'pending')).toEqual(['乙', '甲'])
  expect(orderedNames([
    submission({ submissionId: 'z', studentName: 'Anton', submittedAt: same }),
    submission({ submissionId: 'a', studentName: 'Bella', submittedAt: same }),
  ], 'pending')).toEqual(['Anton', 'Bella'])
  expect(orderSubmissions([
    submission({ submissionId: 'b', studentName: '甲', submittedAt: same }),
    submission({ submissionId: 'a', studentName: '甲', submittedAt: same }),
  ], 'pending').map(item => item.submissionId)).toEqual(['a', 'b'])
})

it('groups only non-empty states and never mutates the input', () => {
  const items = [
    submission({ submissionId: 'p', studentName: '林' }),
    submission({ submissionId: 'r', studentName: '郑', submittedAt: '2026-11-12T09:00:00+08:00', state: 'revised' }),
  ]
  expect(submissionGroups(items, 'inbox').map(group => group.id)).toEqual(['pending', 'revised'])
  expect(submissionGroups(items, 'pending').map(group => group.id)).toEqual(['pending'])
  expect(submissionGroups([], 'all')).toEqual([])
  expect(items.map(item => item.submissionId)).toEqual(['p', 'r'])
})

it('describes waiting in local calendar days', () => {
  const now = new Date(2026, 10, 27, 15, 0).getTime()
  expect(waitingText(new Date(2026, 10, 27, 9, 0).toISOString(), now)).toBe('今天提交')
  expect(waitingText(new Date(2026, 10, 26, 22, 0).toISOString(), now)).toBe('等待 1 天')
  expect(waitingText(new Date(2026, 10, 8, 10, 0).toISOString(), now)).toBe('等待 19 天')
  expect(waitingText('not-a-date', now)).toBe('提交时间未知')
})
