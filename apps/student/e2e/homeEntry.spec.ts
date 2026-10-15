import { expect, test, type Page, type Route } from '@playwright/test'
import { REAL_URL } from './env'
import { loginThroughForm } from './sessionHost'

test.use({ trace: 'off' })

type Course = { courseId: string; role: 'student' | 'teacher' }
type Assignment = {
  assignmentId: string; studentId: string; activityVersionId: string; active: boolean
  executionKind: 'textscope' | 'hdl_board'
}
const error = (code: string) => ({ requestId: 'home-protocol', error: {
  code, message: 'Synthetic protocol response', retryable: false, recovery: 'Read the current authorized state',
} })
const assignment = (id: string, studentId = 'account-a', active = true, kind: Assignment['executionKind'] = 'textscope'): Assignment => ({
  assignmentId: id, studentId, activityVersionId: `activity-${id}`, active, executionKind: kind,
})

/** 只替换公开 HTTP 响应，验证正常前端接线；不冒充真实 HTTPS/数据库宿主验收。 */
async function protocol(page: Page) {
  const state: {
    identity: string | null
    courses: Record<string, Course[]>
    assignments: Record<string, Assignment[]>
    titles: Record<string, { courseId: string; title: string }>
    reads: Array<{ path: string; method: string }>
    list?: (route: Route, courseId: string, identity: string) => Promise<boolean>
  } = { identity: null, courses: {}, assignments: {}, titles: {}, reads: [] }
  page.on('request', request => {
    const path = new URL(request.url()).pathname
    if (path.startsWith('/api/') || path.startsWith('/__i0prep/')) state.reads.push({ path, method: request.method() })
  })
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url()), path = url.pathname
    let data: unknown
    if (path === '/api/sessions') {
      state.identity = route.request().postDataJSON().loginName
      data = { csrfToken: `csrf-${state.identity}` }
    } else if (path === '/api/logout') {
      state.identity = null; data = { loggedOut: true }
    } else if (!state.identity) {
      await route.fulfill({ status: 401, json: error('UNAUTHENTICATED') }); return
    } else if (path === '/api/session') {
      data = { userId: state.identity, courses: state.courses[state.identity] ?? [], csrfToken: `csrf-${state.identity}` }
    } else if (/^\/api\/courses\/[^/]+\/assignments$/.test(path)) {
      const courseId = decodeURIComponent(path.split('/')[3])
      if (await state.list?.(route, courseId, state.identity)) return
      data = state.assignments[courseId] ?? []
    } else if (path.startsWith('/api/activities/')) {
      expect(url.searchParams.get('audience')).toBe('student')
      const activityVersionId = decodeURIComponent(path.split('/')[3]), title = state.titles[activityVersionId]
      if (title) data = { activityVersionId, courseId: title.courseId, content: { audience: 'student', content: { projectTitle: title.title } } }
    }
    // 卡片只需验证进入原工作区及其 bootstrap，不另造一套工作区协议。
    if (data === undefined) await route.fulfill({ status: 403, json: error('FORBIDDEN') })
    else await route.fulfill({ json: { requestId: 'home-protocol', data } })
  })
  return state
}

async function loginHome(page: Page, account = 'account-a') {
  await page.goto(`${REAL_URL}/#/`)
  await loginThroughForm(page, account, 'synthetic-only')
  await expect(page.locator('.account-name')).toHaveText(account)
}

test('真实首页读取本人两课程与固定标题，暂停可查看，卡片沿原路由返回后可再进入', async ({ page }) => {
  const state = await protocol(page)
  state.courses['account-a'] = [
    { courseId: 'course-c', role: 'student' }, { courseId: 'course-hdl', role: 'student' },
    { courseId: 'teacher-course', role: 'teacher' },
  ]
  state.assignments['course-c'] = [assignment('assigned-c')]
  state.assignments['course-hdl'] = [assignment('assigned-hdl', 'account-a', true, 'hdl_board'), assignment('paused-hdl', 'account-a', false, 'hdl_board')]
  state.titles = {
    'activity-assigned-c': { courseId: 'course-c', title: '固定 C 项目标题' },
    'activity-assigned-hdl': { courseId: 'course-hdl', title: '固定 HDL 项目标题' },
    'activity-paused-hdl': { courseId: 'course-hdl', title: '已暂停的 HDL 项目' },
  }
  await loginHome(page)
  await expect(page.getByRole('button', { name: /课程 course-c/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /课程 course-hdl/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /teacher-course/ })).toHaveCount(0)
  await expect(page.locator('.db, .db-continue, .progress, .deadline')).toHaveCount(0)
  await expect(page.locator('.content')).not.toContainText(/学习看板|设计演示|截止|进度|%/)
  expect(state.reads.some(read => read.path.includes('teacher-course'))).toBe(false)
  expect(state.reads.filter(read => read.path !== '/api/sessions').every(read => read.method === 'GET')).toBe(true)

  await page.getByRole('button', { name: /课程 course-c/ }).click()
  for (let visit = 0; visit < 2; visit++) {
    await page.getByRole('button', { name: /固定 C 项目标题.*进入任务/ }).click()
    await expect(page).toHaveURL(`${REAL_URL}/#/task/assigned-c`)
    await expect(page.locator('.ts-badge')).toContainText('不可用')
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page.getByRole('button', { name: /固定 C 项目标题.*进入任务/ })).toBeVisible()
  }
  await page.getByRole('button', { name: '全部课程', exact: true }).click()
  await page.getByRole('button', { name: /课程 course-hdl/ }).click()
  await expect(page.getByRole('button', { name: /已暂停的 HDL 项目.*任务已暂停.*查看任务/ })).toBeVisible()
  for (const [title, id] of [['固定 HDL 项目标题', 'assigned-hdl'], ['已暂停的 HDL 项目', 'paused-hdl']]) {
    await page.getByRole('button', { name: new RegExp(title) }).click()
    await expect(page).toHaveURL(`${REAL_URL}/#/task/${id}`)
    await expect(page.locator('.ts-badge')).toContainText('不可用')
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible()
  }
  for (const id of ['assigned-c', 'assigned-hdl', 'paused-hdl']) {
    expect(state.reads.some(read => read.path === `/api/assignments/${id}/bootstrap`)).toBe(true)
  }
  expect(state.reads.some(read => read.path.startsWith('/__i0prep/'))).toBe(false)
})

test('没有学生课程或课程没有分配时显示真实空态，不补演示任务', async ({ page }) => {
  const state = await protocol(page)
  state.courses['account-a'] = [{ courseId: 'teacher-only', role: 'teacher' }]
  await loginHome(page)
  await expect(page.getByText('暂无获准的学生课程与任务', { exact: true })).toBeVisible()
  expect(state.reads.some(read => read.path.includes('/assignments'))).toBe(false)
  state.courses['account-a'] = [{ courseId: 'empty-course', role: 'student' }]
  await page.reload()
  await page.getByRole('button', { name: /课程 empty-course/ }).click()
  await expect(page.getByText('此课程暂无分配任务', { exact: true })).toBeVisible()
  await expect(page.locator('.task-card, .db-continue')).toHaveCount(0)
  expect(state.reads.some(read => read.path.startsWith('/api/activities/'))).toBe(false)
  expect(state.reads.some(read => read.path.startsWith('/__i0prep/'))).toBe(false)
})

test('列表故障保持失败并可明确重试，恢复后只展示原接口任务', async ({ page }) => {
  const state = await protocol(page)
  state.courses['account-a'] = [{ courseId: 'course-c', role: 'student' }]
  state.assignments['course-c'] = [assignment('retry-c')]
  state.titles['activity-retry-c'] = { courseId: 'course-c', title: '恢复后的真实任务' }
  let unavailable = true
  state.list = async route => {
    if (!unavailable) return false
    await route.fulfill({ status: 503, json: error('DEPENDENCY_UNAVAILABLE') }); return true
  }
  await loginHome(page)
  await expect(page.getByRole('alert')).toContainText('暂时无法读取课程与任务，请重试')
  await expect(page.locator('.course-tile, .task-card, .db-continue')).toHaveCount(0)
  expect(state.reads.filter(read => read.path === '/api/courses/course-c/assignments')).toHaveLength(1)
  unavailable = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('button', { name: /课程 course-c/ })).toBeVisible()
  expect(state.reads.filter(read => read.path === '/api/courses/course-c/assignments')).toHaveLength(2)
  await page.getByRole('button', { name: /课程 course-c/ }).click()
  await expect(page.getByRole('button', { name: /恢复后的真实任务.*进入任务/ })).toBeVisible()
  expect(state.reads.some(read => read.path.startsWith('/__i0prep/'))).toBe(false)
})

test('列表401重新登录，首页真实退出换账号后拒收迟到旧列表', async ({ page }) => {
  // 故意禁用 abort 优化，验证账号代次与查询隔离仍拒收旧响应。
  await page.addInitScript(() => { AbortController.prototype.abort = () => {} })
  const state = await protocol(page)
  state.courses['account-a'] = [{ courseId: 'course-a', role: 'student' }]
  state.courses['account-b'] = [{ courseId: 'course-b', role: 'student' }]
  state.assignments['course-a'] = [assignment('task-a')]
  state.assignments['course-b'] = [assignment('task-b', 'account-b')]
  state.titles = {
    'activity-task-a': { courseId: 'course-a', title: '账号 A 原任务' },
    'activity-task-b': { courseId: 'course-b', title: '账号 B 新任务' },
  }
  let expired = false, hold = false, reached!: () => void, release!: () => void, delivered!: () => void
  const started = new Promise<void>(resolve => { reached = resolve })
  const held = new Promise<void>(resolve => { release = resolve })
  const finished = new Promise<void>(resolve => { delivered = resolve })
  state.list = async (route, courseId) => {
    if (expired) { expired = false; await route.fulfill({ status: 401, json: error('UNAUTHENTICATED') }); return true }
    if (!hold) return false
    hold = false
    const data = state.assignments[courseId]
    reached(); await held
    await route.fulfill({ json: { requestId: 'late-old-home', data } }); delivered(); return true
  }
  try {
    await loginHome(page)
    await page.getByRole('button', { name: /课程 course-a/ }).click()
    await expect(page.getByRole('button', { name: /账号 A 原任务/ })).toBeVisible()
    expired = true
    await page.getByRole('button', { name: '刷新任务', exact: true }).click()
    await expect(page.locator('.session-notice')).toContainText('登录已失效')
    await expect(page.locator('.task-card')).toHaveCount(0)
    await loginThroughForm(page, 'account-a', 'synthetic-only')
    await expect(page.getByRole('button', { name: /账号 A 原任务/ })).toBeVisible()
    hold = true
    await page.getByRole('button', { name: '刷新任务', exact: true }).click()
    await started
    await page.locator('.account-pill').click()
    await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
    await expect(page.locator('.session-notice')).toContainText('已退出登录')
    await loginThroughForm(page, 'account-b', 'synthetic-only')
    await expect(page.locator('.account-name')).toHaveText('account-b')
    await page.getByRole('button', { name: /课程 course-b/ }).click()
    await expect(page.getByRole('button', { name: /账号 B 新任务/ })).toBeVisible()
    release(); await finished
    await expect(page.getByRole('button', { name: /账号 A 原任务/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /账号 B 新任务/ })).toBeVisible()
    await expect(page.locator('.account-name')).toHaveText('account-b')
    await expect(page.getByRole('heading', { name: '登录学习空间' })).toHaveCount(0)
    expect(state.reads.filter(read => read.path === '/api/logout' && read.method === 'POST')).toHaveLength(1)
  } finally { release() }
})
