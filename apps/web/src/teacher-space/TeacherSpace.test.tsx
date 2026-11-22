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

let root: Root, host: HTMLDivElement
let catalogStatus: number, namespace: string
const settle = async () => { for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setTimeout(resolve, 0)) }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  history.replaceState(null, '', '/?teacher=overview')
  sessionStorage.clear()
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
