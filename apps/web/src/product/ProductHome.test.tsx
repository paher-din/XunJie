// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ProductHome, type ProductHomeProps } from './ProductHome'

it('requests real spaces and never shows the previous space data under another category', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const onSpaceChange = vi.fn(), onOpenCourse = vi.fn(), onConnectSchool = vi.fn()
  const props: ProductHomeProps = { identityName: '学生', spaceKind: 'school', spaceKey: 's1', dashboardKey: 'test-dashboard',
    availableSpaces: [{ key: 's1', label: '学校一', kind: 'school' }, { key: 's2', label: '学校二', kind: 'school' }, { key: 'p', label: '个人', kind: 'personal' }],
    activities: [], courses: [{ courseId: 'course-1', name: '真实课程', tasks: [] }], busy: false,
    onOpenActivity: vi.fn(), onOpenCourse, onStartConversation: vi.fn(), onRefresh: vi.fn(), onSpaceChange, onConnectSchool }
  try {
    await act(async () => root.render(<ProductHome {...props} />))
    expect(host.textContent).toContain('真实课程')
    expect(host.textContent).toContain('完成进度暂无统计')
    expect(host.textContent).toContain('暂无学习时长统计')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-course-id="course-1"]')!.click())
    expect(onOpenCourse).toHaveBeenCalledWith('course-1')
    const select = host.querySelector<HTMLSelectElement>('select')!
    await act(async () => { select.value = 's2'; select.dispatchEvent(new Event('change', { bubbles: true })) })
    expect(onSpaceChange).toHaveBeenCalledWith('s2')
    const personal = Array.from(host.querySelectorAll('button')).find(button => button.textContent === '个人')!
    await act(async () => personal.click())
    expect(onSpaceChange).toHaveBeenCalledWith('p')
    expect(host.textContent).not.toContain('真实课程')
    expect(host.textContent).toContain('正在切换学习空间')
    await act(async () => root.render(<ProductHome {...props} spaceKind="personal" spaceKey="p" availableSpaces={[{ key: 'p', label: '个人', kind: 'personal' }]} courses={null} />))
    await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === '学校')!.click())
    expect(host.textContent).toContain('暂无学校身份')
    await act(async () => Array.from(host.querySelectorAll('button')).find(button => button.textContent === '连接学校')!.click())
    expect(onConnectSchool).toHaveBeenCalledOnce()
  } finally {
    await act(async () => root.unmount())
    localStorage.removeItem('test-dashboard')
    host.remove()
    vi.unstubAllGlobals()
  }
})
