import { expect, test, type Page, type Route } from '@playwright/test'
import { REAL_URL } from './env'
import { loginThroughForm } from './sessionHost'

test.use({ trace: 'off' })

type Course = { courseId: string; role: 'student' | 'teacher'; name?: string }
type Assignment = {
  assignmentId: string; studentId: string; activityVersionId: string; active: boolean
  displayTitle?: string
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
    names: Record<string, string>
    courses: Record<string, Course[]>
    assignments: Record<string, Assignment[]>
    titles: Record<string, { courseId: string; title: string; goal?: string }>
    reads: Array<{ path: string; method: string }>
    list?: (route: Route, courseId: string, identity: string) => Promise<boolean>
  } = { identity: null, names: {}, courses: {}, assignments: {}, titles: {}, reads: [] }
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
      data = { userId: state.identity, displayName: state.names[state.identity], courses: state.courses[state.identity] ?? [], csrfToken: `csrf-${state.identity}` }
    } else if (path === '/api/agent/conversations') {
      data = []
    } else if (/^\/api\/courses\/[^/]+\/assignments$/.test(path)) {
      const courseId = decodeURIComponent(path.split('/')[3])
      if (await state.list?.(route, courseId, state.identity)) return
      data = state.assignments[courseId] ?? []
    } else if (path.startsWith('/api/activities/')) {
      expect(url.searchParams.get('audience')).toBe('student')
      const activityVersionId = decodeURIComponent(path.split('/')[3]), title = state.titles[activityVersionId]
      if (title) data = { activityVersionId, courseId: title.courseId, content: { audience: 'student', content: {
        projectTitle: title.title, goals: title.goal ? [{ title: title.goal, core: true }] : [],
      } } }
    }
    // 卡片只需验证进入原工作区及其 bootstrap，不另造一套工作区协议。
    if (data === undefined) await route.fulfill({ status: 403, json: error('FORBIDDEN') })
    else await route.fulfill({ json: { requestId: 'home-protocol', data } })
  })
  return state
}

async function loginHome(page: Page, account = 'account-a', displayName = account) {
  await page.goto(`${REAL_URL}/#/`)
  await loginThroughForm(page, account, 'synthetic-only')
  await expect(page.locator('.account-name')).toHaveText(displayName)
}

test('真实首页读取本人两课程与固定标题，暂停可查看，卡片沿原路由返回后可再进入', async ({ page }) => {
  const state = await protocol(page)
  state.courses['account-a'] = [
    { courseId: 'course-hdl', role: 'student' }, { courseId: 'course-c', role: 'student' },
    { courseId: 'teacher-course', role: 'teacher' },
  ]
  state.assignments['course-c'] = [assignment('assigned-c')]
  state.assignments['course-hdl'] = [assignment('assigned-hdl', 'account-a', true, 'hdl_board'), assignment('paused-hdl', 'account-a', false, 'hdl_board')]
  state.titles = {
    'activity-assigned-c': { courseId: 'course-c', title: '固定 C 项目标题', goal: '公开 C 项目的实际目标' },
    'activity-assigned-hdl': { courseId: 'course-hdl', title: '固定 HDL 项目标题' },
    'activity-paused-hdl': { courseId: 'course-hdl', title: '已暂停的 HDL 项目' },
  }
  await loginHome(page)
  await expect(page.getByRole('button', { name: /课程 course-c/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /课程 course-hdl/ })).toBeVisible()
  // 故意将 HDL 排在 C 前面，图案仍必须按真实任务类型匹配。
  await expect(page.getByRole('button', { name: /课程 course-c/ }).locator('[data-icon="code-square"]')).toBeVisible()
  await expect(page.getByRole('button', { name: /课程 course-hdl/ }).locator('[data-icon="virtual-board"]')).toBeVisible()
  await expect(page.getByRole('button', { name: /teacher-course/ })).toHaveCount(0)
  await expect(page.locator('.intro h1')).toHaveText(/(上午好|下午好|晚上好)，account-a/)
  const dashboard = page.locator('.dash-section')
  await expect(dashboard.getByRole('heading', { name: '学习看板' })).toBeVisible()
  await expect(dashboard.locator('.period')).toHaveText('演示统计')
  await expect(dashboard.locator('.db-side').filter({ hasText: '真实分配' })).toHaveText('真实分配 3 个任务')
  await expect(dashboard.locator('.db-big')).toHaveText('3 / 8 个任务 · 37.5%')
  await expect(dashboard.locator('.db-hm-col').first()).toBeVisible()
  await expect(dashboard).not.toContainText(/暂无统计|NaN|undefined/)
  await expect(page.locator('.db-continue h3')).toHaveText('固定 HDL 项目标题')
  await dashboard.getByRole('button', { name: '每周', exact: true }).click()
  await expect(dashboard.locator('.db-wkline')).toBeVisible()
  await dashboard.getByRole('button', { name: '每日', exact: true }).click()
  await dashboard.getByRole('button', { name: '编辑', exact: true }).click()
  await expect(dashboard.locator('.db-tray')).toContainText('成长等级')
  await dashboard.locator('.t-item').filter({ hasText: '成长等级' }).getByRole('button').click()
  await expect(dashboard.locator('.db-card')).toHaveCount(3)
  await expect(dashboard).toContainText(/1,?240 XP/)
  await dashboard.locator('.db-card').filter({ has: page.locator('.db-xp-row') }).getByRole('button', { name: '移出看板' }).click()
  await dashboard.getByRole('button', { name: '完成', exact: true }).click()
  await expect(dashboard.locator('.db-card')).toHaveCount(2)
  expect(state.reads.some(read => read.path.includes('teacher-course'))).toBe(false)
  expect(state.reads.filter(read => read.path !== '/api/sessions').every(read => read.method === 'GET')).toBe(true)

  await page.getByRole('button', { name: /课程 course-c/ }).click()
  await expect(page.locator('.task-card .status.pending')).toHaveText('已分配')
  await expect(page.locator('.task-card')).toHaveCount(1)
  await expect(page.locator('.task-card p')).toHaveText('公开 C 项目的实际目标')
  await expect(page.locator('.task-card .progress, .task-card .deadline')).toHaveCount(0)
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('不存在的标题')
  await expect(page.getByText('此课程没有匹配的任务', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '清除搜索', exact: true }).click()
  await expect(page.getByRole('textbox', { name: '搜索任务', exact: true })).toBeFocused()
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('公开 C 项目的实际目标')
  await expect(page.locator('.task-card')).toHaveCount(1)
  await page.getByRole('button', { name: '清除搜索', exact: true }).click()
  for (let visit = 0; visit < 2; visit++) {
    await page.getByRole('button', { name: /固定 C 项目标题.*进入任务/ }).click()
    await expect(page).toHaveURL(`${REAL_URL}/#/task/assigned-c`)
    await expect(page.locator('.ts-badge')).toContainText('不可用')
    await page.getByRole('button', { name: '返回', exact: true }).click()
    await expect(page.getByRole('button', { name: /固定 C 项目标题.*进入任务/ })).toBeVisible()
  }
  await page.getByRole('button', { name: '全部课程', exact: true }).click()
  await page.getByRole('button', { name: /课程 course-hdl/ }).click()
  await expect(page.getByRole('button', { name: /任务已暂停.*已暂停的 HDL 项目.*查看任务/ })).toBeVisible()
  await page.locator('.filters').getByRole('button', { name: '任务已暂停', exact: true }).click()
  await expect(page.locator('.task-card')).toHaveCount(1)
  await expect(page.locator('.task-card')).toContainText('已暂停的 HDL 项目')
  await page.locator('.filters').getByRole('button', { name: '全部', exact: true }).click()
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
  await page.goto(`${REAL_URL}/#/`)
  await loginThroughForm(page, 'account-a', 'synthetic-only')
  await expect(page).toHaveURL(/#\/teacher$/)
  expect(state.reads.some(read => read.path.includes('/assignments'))).toBe(false)
  // The approved teacher-only default is the teacher workspace. Exercise the
  // student empty state with an authenticated account that has no course roles.
  state.courses['account-a'] = []
  await page.goto(`${REAL_URL}/#/`)
  await expect(page.locator('.account-name')).toHaveText('account-a')
  await expect(page.getByText('暂无获准的学生课程与任务', { exact: true })).toBeVisible()
  await expect(page.locator('.dash-section .db-side').filter({ hasText: '真实分配' })).toHaveText('真实分配 0 个任务')
  await expect(page.locator('.dash-section .period')).toHaveText('演示统计')
  expect(state.reads.some(read => read.path.includes('/assignments'))).toBe(false)
  state.courses['account-a'] = [
    { courseId: 'empty-course', role: 'student' },
    { courseId: 'empty-hdl-course', role: 'student', name: '数字逻辑与部件设计' },
    { courseId: 'empty-c-course', role: 'student', name: '程序设计基础' },
  ]
  await page.reload()
  await expect(page.getByRole('button', { name: /课程 empty-course/ }).locator('[data-icon="structure"]')).toBeVisible()
  await expect(page.getByRole('button', { name: /数字逻辑与部件设计/ }).locator('[data-icon="structure"]')).toBeVisible()
  await expect(page.getByRole('button', { name: /程序设计基础/ }).locator('[data-icon="structure"]')).toBeVisible()
  await page.getByRole('button', { name: /课程 empty-course/ }).click()
  await expect(page.getByText('此课程暂无分配任务', { exact: true })).toBeVisible()
  await expect(page.locator('.task-card, .db-continue')).toHaveCount(0)
  expect(state.reads.some(read => read.path.startsWith('/api/activities/'))).toBe(false)
  expect(state.reads.some(read => read.path.startsWith('/__i0prep/'))).toBe(false)
})

test('首页读取后端姓名课程和任务标题，搜索及原ID路由保持，缺字段回退原表示', async ({ page }) => {
  const state = await protocol(page)
  const account = 'learner-371', course = 'course-218'
  state.names[account] = '陈明'
  state.courses[account] = [
    { courseId: course, role: 'student', name: '程序分析实践' },
    { courseId: 'course-762', role: 'student', name: '计算机系统基础' },
  ]
  state.assignments[course] = [{ ...assignment('display-c', account), displayTitle: '词频分析项目' }]
  state.titles['activity-display-c'] = { courseId: course, title: '原固定活动标题', goal: '原固定目标' }
  await loginHome(page, account, '陈明')
  await expect(page.locator('.intro h1')).toHaveText(/，陈明$/)
  await expect(page.locator('.account-pill .avatar')).toHaveText('陈')
  await expect(page.locator('.db-continue .course-tag')).toHaveText('项目任务 · 程序分析实践')
  await expect(page.locator('.db-continue h3')).toHaveText('词频分析项目')
  await expect(page.locator('.content')).not.toContainText('原固定活动标题')
  await expect(page.getByRole('button', { name: /计算机系统基础.*查看任务/ })).toBeVisible()
  await page.locator('.account-pill').click()
  await expect(page.getByRole('menu').filter({ visible: true }).locator('.am-name')).toHaveText('陈明')
  await page.locator('.account-pill').click()
  await page.getByRole('button', { name: /程序分析实践.*查看任务/ }).click()
  await expect(page).toHaveURL(`${REAL_URL}/#/?course=${course}`)
  await expect(page.locator('.course-breadcrumb strong')).toHaveText('程序分析实践')
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('程序分析实践')
  await expect(page.locator('.task-card')).toHaveCount(1)
  await page.getByRole('textbox', { name: '搜索任务', exact: true }).fill('词频分析')
  await expect(page.locator('.task-card h3')).toHaveText('词频分析项目')
  await page.locator('.task-card').click()
  await expect(page).toHaveURL(`${REAL_URL}/#/task/display-c`)
  await expect(page.locator('.ts-badge')).toContainText('不可用')
  expect(state.identity).toBe(account)
  expect(state.reads.some(read => read.path === `/api/courses/${course}/assignments`)).toBe(true)
  expect(state.reads.some(read => read.path === '/api/assignments/display-c/bootstrap')).toBe(true)
  delete state.names[account]
  state.courses[account] = [{ courseId: course, role: 'student' }]
  state.assignments[course] = [assignment('display-c', account)]
  await page.goto(`${REAL_URL}/#/?course=${course}`)
  await page.reload()
  await expect(page.locator('.account-name')).toHaveText(account)
  await expect(page.locator('.intro h1')).toHaveText(/，learner-371$/)
  await expect(page.locator('.course-breadcrumb strong')).toHaveText(`课程 ${course}`)
  await expect(page.locator('.task-card h3')).toHaveText('原固定活动标题')
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
  await expect(page.getByRole('alert').filter({hasText:'暂时无法读取课程与任务'})).toContainText('暂时无法读取课程与任务，请重试')
  await expect(page.locator('.course-tile, .task-card, .db-continue')).toHaveCount(0)
  await expect(page.locator('.dash-section .db-side').filter({ hasText: '真实分配' })).toHaveCount(0)
  expect(state.reads.filter(read => read.path === '/api/courses/course-c/assignments')).toHaveLength(1)
  unavailable = false
  await page.getByRole('button', { name: '重试', exact: true }).click()
  await expect(page.getByRole('button', { name: /课程 course-c/ })).toBeVisible()
  await expect(page.locator('.dash-section .db-side').filter({ hasText: '真实分配' })).toHaveText('真实分配 1 个任务')
  expect(state.reads.filter(read => read.path === '/api/courses/course-c/assignments')).toHaveLength(2)
  await page.getByRole('button', { name: /课程 course-c/ }).click()
  await expect(page.getByRole('button', { name: /恢复后的真实任务.*进入任务/ })).toBeVisible()
  expect(state.reads.some(read => read.path.startsWith('/__i0prep/'))).toBe(false)
})

test('列表401重新登录，首页真实退出换账号后拒收迟到旧列表', async ({ page }) => {
  // 故意禁用 abort 优化，验证账号代次与查询隔离仍拒收旧响应。
  await page.addInitScript(() => { AbortController.prototype.abort = () => {} })
  const state = await protocol(page)
  state.names = { 'account-a': '周然', 'account-b': '王青' }
  state.courses['account-a'] = [{ courseId: 'course-a', role: 'student', name: '程序设计甲班' }]
  state.courses['account-b'] = [{ courseId: 'course-b', role: 'student', name: '程序设计乙班' }]
  state.assignments['course-a'] = [{ ...assignment('task-a'), displayTitle: '账号 A 原任务' }]
  state.assignments['course-b'] = [{ ...assignment('task-b', 'account-b'), displayTitle: '账号 B 新任务' }]
  state.titles = {
    'activity-task-a': { courseId: 'course-a', title: '账号 A 固定活动' },
    'activity-task-b': { courseId: 'course-b', title: '账号 B 固定活动' },
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
    await loginHome(page, 'account-a', '周然')
    await page.getByRole('button', { name: /程序设计甲班/ }).click()
    await expect(page.getByRole('button', { name: /账号 A 原任务/ })).toBeVisible()
    expired = true
    await page.getByRole('button', { name: '刷新任务', exact: true }).click()
    await expect(page.locator('.session-notice')).toContainText('登录已失效')
    await expect(page.locator('.task-card')).toHaveCount(0)
    await loginThroughForm(page, 'account-a', 'synthetic-only')
    await expect(page.getByRole('button', { name: /账号 A 原任务/ })).toBeVisible()
    await page.locator('.dash-section').getByRole('button', { name: '编辑', exact: true }).click()
    await page.locator('.t-item').filter({ hasText: '成长等级' }).getByRole('button').click()
    await page.locator('.dash-section').getByRole('button', { name: '完成', exact: true }).click()
    await expect(page.locator('.dash-section .db-card')).toHaveCount(3)
    hold = true
    await page.getByRole('button', { name: '刷新任务', exact: true }).click()
    await started
    await page.locator('.account-pill').click()
    await page.getByRole('menuitem', { name: '退出登录', exact: true }).click()
    await expect(page.locator('.session-notice')).toContainText('已退出登录')
    await loginThroughForm(page, 'account-b', 'synthetic-only')
    await expect(page.locator('.account-name')).toHaveText('王青')
    await expect(page.locator('.intro h1')).toHaveText(/，王青$/)
    await expect(page.locator('.dash-section .db-card')).toHaveCount(2)
    await expect(page.locator('.dash-section .db-side').filter({ hasText: '真实分配' })).toHaveText('真实分配 1 个任务')
    await page.getByRole('button', { name: /程序设计乙班/ }).click()
    await expect(page.getByRole('button', { name: /账号 B 新任务/ })).toBeVisible()
    release(); await finished
    await expect(page.getByRole('button', { name: /账号 A 原任务/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /账号 B 新任务/ })).toBeVisible()
    await expect(page.locator('.account-name')).toHaveText('王青')
    await expect(page.locator('.content')).not.toContainText('程序设计甲班')
    await expect(page.getByRole('heading', { name: '登录学习空间' })).toHaveCount(0)
    expect(state.reads.filter(read => read.path === '/api/logout' && read.method === 'POST')).toHaveLength(1)
  } finally { release() }
})
