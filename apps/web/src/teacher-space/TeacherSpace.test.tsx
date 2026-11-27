// @vitest-environment jsdom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TeacherSpace } from './TeacherSpace'

vi.mock('../components/ProductShell', () => ({
  ProductShell: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}))

const accountA = { key: 'school:a', accountName: '教师甲', schoolName: '学校甲' }
const accountB = { key: 'school:b', accountName: '教师乙', schoolName: '学校乙' }
const catalogA = { available: true, courses: [{ courseId: 'a', name: '甲的课程', tasks: [] }] }
const catalogB = { available: true, courses: [{ courseId: 'b', name: '乙的课程', tasks: [] }] }
const taskCourse = {
  courseId: 'course-tasks', name: '任务课程', tasks: ['一', '二', '三', '四'].map((suffix, index) => ({
    taskId: `task-${index + 1}`, title: `任务${suffix}`, summary: '',
    releases: [{ releaseId: `release-${index + 1}`, publishedAt: '2026-11-20T00:00:00.000Z', objectives: ['目标'] }],
  })),
}

let root: Root, host: HTMLDivElement
let catalogStatus: number, namespace: string
const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return [] }
  })
  history.replaceState(null, '', '/?teacher=overview')
  sessionStorage.clear()
  localStorage.clear()
  catalogStatus = 200
  namespace = 'namespace-b'
  host = document.createElement('div'); document.body.append(host); root = createRoot(host)
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/learning/context') return new Response(JSON.stringify({
      clientNamespace: namespace, account: accountB, identities: [],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url === '/api/learning/manage/course-catalog') {
      return catalogStatus === 403 ? new Response('{}', { status: 403 })
        : new Response(JSON.stringify({ courses: catalogB.courses }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error('Unexpected ' + url)
  }))
})

afterEach(async () => {
  await act(async () => { root.unmount(); await settle() })
  host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

it('never leaves a previous account catalog on screen after the live context names another account', async () => {
  sessionStorage.setItem('xj.teacher-space.v1', JSON.stringify({
    context: { clientNamespace: 'namespace-a', account: accountA }, catalog: catalogA, savedAt: Date.now(),
  }))
  await act(async () => { root.render(<TeacherSpace />); await settle() })
  expect(host.textContent).toContain('乙的课程')
  expect(host.textContent).not.toContain('甲的课程')
  expect(host.textContent).not.toContain('教师甲')
  const saved = JSON.parse(sessionStorage.getItem('xj.teacher-space.v1')!) as { context: { account: { key: string } }; catalog: { courses: { name: string }[] } }
  expect(saved.context.account.key).toBe('school:b')
  expect(saved.catalog.courses[0]?.name).toBe('乙的课程')
})

it('does not paint the old workspace when the live context read fails, and retries cleanly', async () => {
  let fail = true
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/learning/context') {
      if (fail) { fail = false; return new Response('{}', { status: 503 }) }
      return new Response(JSON.stringify({ clientNamespace: 'namespace-b', account: accountB, identities: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } })
    }
    return new Response(JSON.stringify({ courses: catalogB.courses }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  sessionStorage.setItem('xj.teacher-space.v1', JSON.stringify({
    context: { clientNamespace: 'namespace-a', account: accountA }, catalog: catalogA, savedAt: Date.now(),
  }))
  await act(async () => { root.render(<TeacherSpace />); await settle() })
  expect(host.textContent).toContain('教学空间暂时无法连接')
  expect(host.textContent).not.toContain('甲的课程')
  expect(sessionStorage.getItem('xj.teacher-space.v1')).toBeNull()
  const retry = [...host.querySelectorAll('button')].find(item => item.textContent === '重试')
  expect(retry).toBeDefined()
  await act(async () => { retry!.click(); await settle() })
  expect(host.textContent).toContain('乙的课程')
})

it('shows the student-surface fallback when the catalog refuses a non-teacher account', async () => {
  catalogStatus = 403
  namespace = 'namespace-c'
  await act(async () => { root.render(<TeacherSpace />); await settle() })
  expect(host.textContent).toContain('正在返回学生端…')
})

it('adds the task scope to the library and keeps three recent shortcuts', async () => {
  history.replaceState(null, '', '/?teacher=workbench&course=course-tasks')
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/learning/context') return new Response(JSON.stringify({
      clientNamespace: 'namespace-tasks', account: accountB,
      identities: [{ key: accountB.key, identity: {
        environmentId: '00000000-0000-4000-8000-000000000001', spaceId: '00000000-0000-4000-8000-000000000002',
        principalId: '00000000-0000-4000-8000-000000000003', kind: 'school', name: accountB.schoolName,
      } }],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
    if (url === '/api/learning/manage/course-catalog') return new Response(JSON.stringify({ courses: [taskCourse] }), {
      status: 200, headers: { 'content-type': 'application/json' },
    })
    if (url === '/api/learning/manage/teacher-course-read') return new Response('{}', { status: 403 })
    if (url.startsWith('/api/learning/releases/')) {
      const releaseId = url.split('/').pop()!
      return new Response(JSON.stringify({ materials: [
        { materialId: `material-${releaseId}`, title: `${releaseId}.md`, mediaType: 'text/plain', byteLength: 128 },
      ] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error('Unexpected ' + url)
  }))
  await act(async () => { root.render(<TeacherSpace />); await settle() })
  const libraryTab = host.querySelector<HTMLButtonElement>('#t-tab-library')
  expect(libraryTab).not.toBeNull()
  await act(async () => { libraryTab!.click(); await settle(); await settle() })

  expect(host.querySelectorAll('.t-library h3').length).toBe(0)
  expect(host.querySelectorAll('.t-library-row').length).toBe(4)
  const quickLabels = () => [...host.querySelectorAll('.t-task-filter-tab')].map(item => item.textContent)
  expect(quickLabels()).toEqual(['任务一', '任务二', '任务三'])
  const more = host.querySelector<HTMLButtonElement>('.t-task-more-trigger')!
  await act(async () => { more.click(); await settle() })
  const menu = host.querySelector('.t-task-more-menu.on')
  expect(menu?.textContent).toContain('任务四')
  expect(menu?.textContent).not.toContain('任务一')
  const fourth = [...menu!.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
    .find(item => item.textContent === '任务四')!
  await act(async () => { fourth.click(); await settle() })

  expect(quickLabels()).toEqual(['任务四', '任务一', '任务二'])
  expect(host.querySelectorAll('.t-library-row').length).toBe(1)
  expect(host.textContent).toContain('release-4.md')
  expect(localStorage.getItem('xj.teacher-task-recents.v1:course-tasks')).toBe(JSON.stringify(['task-4', 'task-1', 'task-2']))
  expect(host.querySelector('.t-task-more-menu.on')).toBeNull()
})
