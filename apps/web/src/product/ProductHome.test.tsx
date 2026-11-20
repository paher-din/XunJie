// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { HomeNavigationProvider } from '../lib/homeCourseNavigation'
import { ProductHome, type ProductHomeProps } from './ProductHome'

it('filters independent school and personal lists without changing route or requesting a space switch', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onOpenActivity = vi.fn(), onOpenCourse = vi.fn(), onOpenTask = vi.fn(), onConnectSchool = vi.fn()
  const activity = { activityId: 'personal-activity', identity: { kind: 'personal' }, question: '我的个人问题', status: 'open', createdAt: '2026-01-01' } as LearningActivity
  const legacy = { ...activity, activityId: 'legacy-school-activity', identity: { kind: 'school' }, question: '迁回的历史对话' } as LearningActivity
  const courseEntry: LearningActivity = {
    ...legacy, activityId: 'course-new', createdAt: '2026-01-03',
    course: {
      associationId: 'association-1', courseId: 'course-1', courseName: '真实课程', taskId: 'task-1', taskTitle: '课程任务',
      releaseId: 'release-1', contentDigest: 'test-release', objectives: [], requirements: '', materials: [],
      starterWorks: [], capabilities: [], helpPolicy: { version: 1, questions: 'allowed', scope: 'course' },
    },
  }
  const release = { releaseId: 'release-1', contentDigest: 'test-release', objectives: [], publishedAt: '2026-01-02' }
  const task = { taskId: 'task-1', title: '课程任务', summary: '任务简介',
    releases: [{ ...release, releaseId: 'release-2', publishedAt: '2026-01-04' }, release] }
  const props: ProductHomeProps = { accountName: '学生', personalKey: 'personal', schoolKey: 'school:one', dashboardKey: 'test-dashboard',
    personalActivities: [activity], schoolActivities: [legacy, courseEntry],
    courses: [{ courseId: 'course-1', name: '真实课程', tasks: [task] }], busy: false,
    onOpenActivity, onOpenCourse, onOpenTask, readTaskSubmission: async () => false,
    onStartConversation: vi.fn(), onRefresh: vi.fn(), onConnectSchool }
  const click = async (label: string) => act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === label)!.click())
  const render = async (next: ProductHomeProps) => act(async () => root.render(<MemoryRouter><HomeNavigationProvider scope="test">
    <ProductHome {...next} />
  </HomeNavigationProvider></MemoryRouter>))
  try {
    const originalUrl = location.href
    await render(props)
    expect(host.textContent).toContain('真实课程')
    expect(host.querySelector('[aria-label="我的学习活动"]')).toBeNull()
    expect(host.textContent).toContain('完成进度暂无统计')
    expect(host.querySelector('[aria-label="选择学校"]')).toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-course-id="course-1"]')!.click())
    expect(onOpenCourse).toHaveBeenCalledWith('course-1')
    await render({ ...props, selectedCourseId: 'course-1' })
    expect(host.querySelector('.course-region h2')?.textContent).toContain('课程与任务')
    const taskCard = host.querySelector<HTMLButtonElement>('.course-region button[aria-haspopup="dialog"]')!
    expect(taskCard.textContent).toContain('继续任务')
    await act(async () => taskCard.click())
    expect(onOpenTask).toHaveBeenCalledExactlyOnceWith({ courseId: 'course-1', courseName: '真实课程', task, releaseId: 'release-1' })
    await render(props)
    expect(host.querySelector('[aria-label="我的学习活动"]')).toBeNull()
    await click('个人')
    expect(location.href).toBe(originalUrl)
    expect(host.textContent).not.toContain('真实课程')
    expect(host.textContent).not.toContain('迁回的历史对话')
    expect(host.textContent).toContain('我的个人问题')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-activity-id="personal-activity"]')!.click())
    expect(onOpenActivity).toHaveBeenCalledWith('personal-activity', 'personal')
    await click('学校')
    expect(host.textContent).toContain('真实课程')
    expect(host.textContent).not.toContain('我的个人问题')
    await render({ ...props, schoolKey: undefined, schoolActivities: [], courses: [] })
    expect(host.textContent).not.toContain('真实课程')
    expect(host.textContent).toContain('尚未绑定学校')
    await click('连接学校')
    expect(onConnectSchool).toHaveBeenCalledOnce()
    await click('个人')
    expect(host.textContent).toContain('我的个人问题')
  } finally {
    await act(async () => root.unmount())
    localStorage.removeItem('test-dashboard')
    host.remove()
    vi.unstubAllGlobals()
  }
})
