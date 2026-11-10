// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { ProductHome, type ProductHomeProps } from './ProductHome'

it('filters independent school and personal lists without changing route or requesting a space switch', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onOpenActivity = vi.fn(), onOpenCourse = vi.fn(), onConnectSchool = vi.fn()
  const activity = { activityId: 'personal-activity', identity: { kind: 'personal' }, question: '我的个人问题', status: 'open', createdAt: '2026-01-01' } as LearningActivity
  const legacy = { ...activity, activityId: 'legacy-school-activity', identity: { kind: 'school' }, question: '迁回的历史对话' } as LearningActivity
  const props: ProductHomeProps = { accountName: '学生', personalKey: 'personal', schoolKey: 'school:one', dashboardKey: 'test-dashboard',
    personalActivities: [activity], schoolActivities: [legacy], courses: [{ courseId: 'course-1', name: '真实课程', tasks: [] }], busy: false,
    onOpenActivity, onOpenCourse, onStartConversation: vi.fn(), onRefresh: vi.fn(), onConnectSchool }
  const click = async (label: string) => act(async () => [...host.querySelectorAll('button')].find(button => button.textContent === label)!.click())
  try {
    const originalUrl = location.href
    await act(async () => root.render(<ProductHome {...props} />))
    expect(host.textContent).toContain('真实课程')
    expect(host.querySelector('[data-activity-id="legacy-school-activity"]')).not.toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-activity-id="legacy-school-activity"]')!.click())
    expect(onOpenActivity).toHaveBeenCalledWith('legacy-school-activity', 'school:one')
    expect(host.textContent).toContain('完成进度暂无统计')
    expect(host.querySelector('[aria-label="选择学校"]')).toBeNull()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-course-id="course-1"]')!.click())
    expect(onOpenCourse).toHaveBeenCalledWith('course-1')
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
    await act(async () => root.render(<ProductHome {...props} schoolKey={undefined} schoolActivities={[]} courses={[]} />))
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
