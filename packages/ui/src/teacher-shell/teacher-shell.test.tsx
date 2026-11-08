// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TeacherActivityDetail, TeacherProjectsToolbar, TeacherSidebar } from './index'
import type { TeacherLinkProps } from './index'

let container: HTMLDivElement
let root: ReturnType<typeof createRoot>
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); container.remove() })

it('侧栏由宿主提供链接、课程选择和账户动作', () => {
  const Link = ({ to, children, end: _end, ...rest }: TeacherLinkProps) => <a href={to} {...rest}>{children}</a>
  const selectCourse = vi.fn(), logout = vi.fn()
  act(() => root.render(<TeacherSidebar Link={Link} NavLink={Link}
    links={{ overview: '/overview', projects: '/projects', review: '/review', materials: '/materials', settings: '/settings', studentSpace: '/student', liveWorkspace: '/live' }}
    spaceCaption="我的任教课程" courses={[{ id: 'c1', title: '第一门课', kind: 'c' }]}
    selectedCourseId="c1" onSelectCourse={selectCourse} pendingReviewCount={2} showStudentSpace
    account={{ name: '陈老师', detail: '教师账号', action: { kind: 'button', label: '退出登录', onClick: logout } }} />))
  expect(container.querySelector('a[aria-label="项目与活动"]')?.getAttribute('href')).toBe('/projects')
  expect(container.querySelector('a[aria-label="学生与审阅"] small')?.textContent).toBe('2')
  const course = container.querySelector('.t-sidebar-courses button') as HTMLButtonElement
  expect(course.getAttribute('aria-pressed')).toBe('true')
  act(() => course.click())
  expect(selectCourse).toHaveBeenCalledWith('c1')
  act(() => (container.querySelector('button[aria-label="退出登录"]') as HTMLButtonElement).click())
  expect(logout).toHaveBeenCalledOnce()
})

it('项目筛选和清除搜索只通知宿主，由宿主决定新状态', () => {
  const select = vi.fn(), updateQuery = vi.fn()
  act(() => root.render(<TeacherProjectsToolbar tabs={[{ id: 'all', label: '全部', count: 3 }, { id: 'draft', label: '草稿', count: 1 }]}
    selectedTab="draft" onSelectTab={select} query="词语" onQueryChange={updateQuery} />))
  expect(container.querySelector('.t-tabs .active')?.textContent).toBe('草稿1')
  act(() => (container.querySelector('.t-tabs button') as HTMLButtonElement).click())
  act(() => (container.querySelector('button[aria-label="清除搜索"]') as HTMLButtonElement).click())
  expect(select).toHaveBeenCalledWith('all')
  expect(updateQuery).toHaveBeenCalledWith('')
  expect((container.querySelector('input') as HTMLInputElement).value).toBe('词语')
})

it('真实固定材料和预览快照分别显示，隐藏或不可用材料不会冒充正文', () => {
  const common = { statusLabel: '已开放', statusTone: 'progress' as const, description: '活动描述', activityId: 'activity',
    assigned: 1, versionLabel: '版本', showPreviewSummaryNote: false, onClose: () => {} }
  const real = renderToStaticMarkup(<TeacherActivityDetail {...common} fixed={{ routes: [], goals: [], tasks: [], milestones: [], rubric: [],
    helpPolicy: '帮助政策', assignments: [{ id: 'a', name: '学生甲', active: false }], materials: [
      { status: 'available', id: 'm1', title: '材料', text: '公开正文' }, { status: 'redacted', id: 'm2' }, { status: 'unavailable', id: 'm3' },
    ] }} />)
  expect(real).toContain('未填写')
  expect(real).toContain('公开正文')
  expect(real).toContain('按角色隐藏')
  expect(real).toContain('该版本材料不可用')
  expect(real).toContain('学生甲 · 分配暂停')
  expect(real).not.toContain('本机预览固定于蓝图')
  const preview = renderToStaticMarkup(<TeacherActivityDetail {...common} snapshot={{ revision: 3, audience: '受众', deliverable: '产物',
    choices: '选择', foundation: '基础', duration: '一课时', goals: [], milestones: [], rubric: [], helpPolicy: '预览帮助', materials: [] }} previewAssignments={[]} />)
  expect(preview).toContain('本机预览固定于蓝图 revision 3')
  expect(preview).toContain('本版本没有关联材料。')
  expect(preview).toContain('分配关系已在本机预览固定。')
  expect(preview).not.toContain('固定材料 · 教师视角')
})
