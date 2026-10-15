import { expect, test, type Page } from '@playwright/test'
import { REAL_URL } from './env'

const preview = '/#/teacher/preview'
const requestId = 'teacher-ui-protocol'
const failure = { requestId, error: { code: 'DEPENDENCY_UNAVAILABLE', message: 'Teacher list unavailable',
  retryable: true, recovery: 'Retry the authorized read' } }
const openDialog = (page: Page, title: string) => page.locator('dialog[open]')
  .filter({ has: page.getByRole('heading', { name: title, exact: true }) })

async function enterPreview(page: Page, path = '') {
  const apiRequests: string[] = []
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url())
  })
  await page.goto(`${REAL_URL}${preview}${path}`)
  await expect(page.locator('.t-preview-note')).toContainText('数据为合成示例')
  await expect(page.locator('.t-page h1')).toBeVisible()
  return apiRequests
}

test('教师概览按课程过滤，项目搜索与状态筛选沿真实页面工作', async ({ page }) => {
  const requests = await enterPreview(page)
  await expect(page.getByRole('heading', { name: '让每一次实践，都有下一步。' })).toBeVisible()
  await expect(page.locator('.t-course-card')).toHaveCount(2)
  await expect(page.locator('.t-attention-row')).toHaveCount(2)
  await page.screenshot({ path: test.info().outputPath('teacher-overview.png') })
  await page.getByLabel('当前课程', { exact: true }).selectOption('preview-hdl')
  await expect(page.locator('.t-course-card')).toHaveCount(1)
  await expect(page.locator('.t-attention-row')).toContainText('许同学')
  await page.getByRole('navigation').getByRole('link', { name: '项目与活动', exact: true }).click()
  await expect(page.locator('.t-project-card')).toHaveCount(1)
  await expect(page.locator('.t-project-card')).toContainText('4 位 ALU')
  await page.getByLabel('当前课程', { exact: true }).selectOption('all')
  await expect(page.locator('.t-project-card')).toHaveCount(3)
  await page.getByRole('textbox', { name: '搜索项目', exact: true }).fill('TextScope')
  await expect(page.locator('.t-project-card')).toHaveCount(2)
  await page.getByRole('textbox', { name: '搜索项目', exact: true }).fill('没有这个项目')
  await expect(page.getByRole('heading', { name: '没有找到匹配的项目' })).toBeVisible()
  await page.getByRole('button', { name: '清除搜索', exact: true }).click()
  await page.locator('.t-tabs').getByRole('button', { name: /^草稿/ }).click()
  await expect(page.locator('.t-project-card')).toHaveCount(1)
  await expect(page.locator('.t-project-card')).toContainText('TextScope Report')
  expect(requests).toEqual([])
})

test('导入私有材料默认关闭学生和辅导可见性，三个角色预览分别裁剪', async ({ page }) => {
  const requests = await enterPreview(page, '/materials')
  await expect(page.locator('.t-rm-material-card')).toHaveCount(4)
  await page.getByRole('button', { name: '导入资料', exact: true }).click()
  const form = openDialog(page, '导入课程材料')
  await expect(form).toBeVisible()
  await expect(form.getByRole('checkbox', { name: /学生可见/ })).not.toBeChecked()
  await expect(form.getByRole('checkbox', { name: /辅导 Agent 可用/ })).not.toBeChecked()
  await expect(form.getByRole('checkbox', { name: /教师设计可用/ })).not.toBeChecked()
  await form.getByRole('combobox', { name: '资料分类', exact: true }).selectOption('private_answer')
  await expect(form.getByRole('checkbox', { name: /学生可见/ })).toBeDisabled()
  await expect(form.getByRole('checkbox', { name: /辅导 Agent 可用/ })).toBeDisabled()
  await form.getByLabel(/^资料名称/).fill('教师专用边界答案')
  await form.getByLabel(/^材料来源/).fill('隔离浏览器合成材料')
  await form.getByRole('button', { name: '粘贴正文', exact: true }).click()
  await form.getByLabel(/^材料正文/).fill('PRIVATE_BROWSER_SAMPLE_20261015：仅教师侧的边界分析。')
  await form.getByRole('button', { name: '导入到本机预览', exact: true }).click()
  await expect(form).not.toBeVisible()
  const resource = page.locator('.t-rm-material-card').filter({ hasText: '教师专用边界答案' })
  await expect(resource).toContainText('仅教师侧')
  await resource.click()
  const content = openDialog(page, '教师专用边界答案')
  await expect(content).toContainText('学生：不可见')
  await expect(content).toContainText('辅导 Agent：不可用')
  await content.getByRole('button', { name: '关闭资料正文', exact: true }).click()

  await page.goto(`${REAL_URL}${preview}/design/draft-report`)
  await page.getByRole('button', { name: /帮助与资源/ }).click()
  await page.getByRole('checkbox', { name: /教师专用边界答案/ }).check()
  await page.getByRole('button', { name: '保存草稿', exact: true }).click()
  await expect(page.locator('.td-save-state')).toContainText('已保存')
  await page.getByRole('button', { name: '预览与分配', exact: true }).click()
  const roles = openDialog(page, '从不同角色，看看这份设计')
  await expect(roles).toBeVisible()
  await expect(roles.locator('summary').filter({ hasText: '教师专用边界答案' })).toHaveCount(0)
  await roles.getByRole('button', { name: '辅导视角', exact: true }).click()
  await expect(roles.locator('summary').filter({ hasText: '教师专用边界答案' })).toHaveCount(0)
  await roles.getByRole('button', { name: '教师 / 验证器', exact: true }).click()
  await roles.locator('summary').filter({ hasText: '教师专用边界答案' }).click()
  await expect(roles).toContainText('PRIVATE_BROWSER_SAMPLE_20261015')
  await roles.getByRole('button', { name: '学生视角', exact: true }).click()
  await expect(roles).not.toContainText('PRIVATE_BROWSER_SAMPLE_20261015')
  expect(requests).toEqual([])
})

test('材料异步读取期间禁止改写字段，取消后的迟到内容不污染下一份导入', async ({ page }) => {
  await page.addInitScript(() => {
    const original = File.prototype.text
    const state = window as unknown as { releaseTeacherFile?: () => void }
    File.prototype.text = function () {
      if (this.name !== 'slow-material.txt') return original.call(this)
      return new Promise<string>(resolve => {
        state.releaseTeacherFile = () => resolve('迟到的旧材料正文，不属于新表单。')
      })
    }
  })
  const requests = await enterPreview(page, '/materials')
  await page.getByRole('button', { name: '导入资料', exact: true }).click()
  const form = openDialog(page, '导入课程材料')
  await form.getByRole('textbox', { name: /^资料名称/ }).fill('原表单名称')
  await form.getByRole('textbox', { name: /^材料来源/ }).fill('原表单来源')
  await form.getByRole('button', { name: '粘贴正文', exact: true }).click()
  await form.getByRole('textbox', { name: /^材料正文/ }).fill('读取前已有的正文')
  await form.getByRole('button', { name: '上传文本', exact: true }).click()
  await form.getByLabel('选择课程材料文件', { exact: true }).setInputFiles({
    name: 'slow-material.txt', mimeType: 'text/plain', buffer: Buffer.from('synthetic delayed file'),
  })
  await expect(form.getByText('正在读取…', { exact: true })).toBeVisible()
  await expect(form.getByRole('textbox', { name: /^资料名称/ })).toBeDisabled()
  await expect(form.getByRole('textbox', { name: /^材料来源/ })).toBeDisabled()
  await expect(form.getByRole('textbox', { name: /^正文预览与编辑/ })).toBeDisabled()
  await expect(form.getByRole('button', { name: '上传文本', exact: true })).toBeDisabled()
  await expect(form.getByRole('button', { name: '粘贴正文', exact: true })).toBeDisabled()
  await expect(form.getByRole('button', { name: '导入到本机预览', exact: true })).toBeDisabled()
  await form.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '导入资料', exact: true }).click()
  await form.getByRole('textbox', { name: /^资料名称/ }).fill('新的人工材料')
  await form.getByRole('textbox', { name: /^材料来源/ }).fill('新的人工来源')
  await form.getByRole('button', { name: '粘贴正文', exact: true }).click()
  await form.getByRole('textbox', { name: /^材料正文/ }).fill('新的人工正文，不能被旧读取覆盖。')
  await page.evaluate(async () => {
    const state = window as unknown as { releaseTeacherFile?: () => void }
    if (!state.releaseTeacherFile) throw new Error('Delayed file read was not started')
    state.releaseTeacherFile()
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  })
  await expect(form.getByRole('textbox', { name: /^资料名称/ })).toHaveValue('新的人工材料')
  await expect(form.getByRole('textbox', { name: /^材料来源/ })).toHaveValue('新的人工来源')
  await expect(form.getByRole('textbox', { name: /^材料正文/ })).toHaveValue('新的人工正文，不能被旧读取覆盖。')
  await form.getByRole('button', { name: '导入到本机预览', exact: true }).click()
  const imported = page.locator('.t-rm-material-card').filter({ hasText: '新的人工材料' })
  await expect(imported).toContainText('新的人工正文，不能被旧读取覆盖。')
  await expect(page.locator('.t-rm-material-list')).not.toContainText('迟到的旧材料正文')
  expect(requests).toEqual([])
})

test('设计草稿保存后刷新恢复，核对固定版本再明确选择合成学生分配', async ({ page }) => {
  const requests = await enterPreview(page, '/design/draft-report')
  const title = 'TextScope Report · 浏览器保存与分配'
  await page.getByLabel(/^项目标题/).fill(title)
  await expect(page.locator('.td-save-state')).toContainText('未保存')
  await page.getByRole('button', { name: '保存草稿', exact: true }).click()
  await expect(page.locator('.td-save-state')).toContainText('已保存 · v4')
  await page.reload()
  await expect(page.getByLabel(/^项目标题/)).toHaveValue(title)
  await expect(page.locator('.td-save-state')).toContainText('已保存 · v4')
  await page.screenshot({ path: test.info().outputPath('teacher-design.png') })
  await page.getByRole('button', { name: '预览与分配', exact: true }).click()
  const roles = openDialog(page, '从不同角色，看看这份设计')
  await expect(roles.getByRole('button', { name: /确认版本，选择学生/ })).toBeDisabled()
  await roles.getByRole('checkbox', { name: /我已核对当前保存版本/ }).check()
  await roles.getByRole('button', { name: /确认版本，选择学生/ }).click()
  const allocation = openDialog(page, '选择合成学生')
  await allocation.getByRole('checkbox', { name: /林同学/ }).check()
  await allocation.getByRole('button', { name: /^分配到本机预览/ }).click()
  await expect(page.getByRole('status')).toContainText('分配给 1 位合成学生')
  await page.locator('.td-back').click()
  const released = page.locator('.t-project-card').filter({ hasText: title })
    .filter({ has: page.getByRole('button', { name: '活动详情', exact: true }) })
  await expect(released).toHaveCount(1)
  await expect(released.locator('.t-project-numbers')).toContainText('1已分配')
  await page.reload()
  await expect(released).toHaveCount(1)
  await released.getByRole('button', { name: '活动详情', exact: true }).click()
  const detail = page.getByRole('dialog', { name: title, exact: true })
  for (const heading of ['固定活动要求', '目标与可观察表现', '评价量规', '帮助政策', '已分配学生']) {
    await expect(detail.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  }
  await expect(detail).toContainText('解释文件处理与动态数据结构')
  await expect(detail).toContainText('报告内容、数值、排序和输入覆盖范围符合活动要求')
  await expect(detail).toContainText('保护当前任务的关键思考')
  await expect(detail.getByText('林同学', { exact: true })).toBeVisible()
  await expect(detail.getByText('等待学生开始', { exact: true })).toBeVisible()
  await expect(detail.locator('summary').filter({ hasText: 'TextScope 项目说明 · v1' })).toHaveCount(1)
  await detail.getByRole('button', { name: '完成', exact: true }).click()

  await page.goto(`${REAL_URL}${preview}/design/draft-report`)
  await page.getByLabel(/^项目标题/).fill(`${title} · 下一版本`)
  await page.getByRole('button', { name: /目标与证据/ }).click()
  await page.getByRole('textbox', { name: /^学习目标/ }).first().fill('下一版本的新目标，不属于旧固定活动。')
  await page.getByRole('button', { name: '保存草稿', exact: true }).click()
  await expect(page.locator('.td-save-state')).toContainText('已保存 · v5')
  await page.locator('.td-back').click()
  await released.getByRole('button', { name: '活动详情', exact: true }).click()
  await expect(detail.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect(detail).toContainText('固定于蓝图 revision 4')
  await expect(detail).toContainText('解释文件处理与动态数据结构')
  await expect(detail).not.toContainText('下一版本的新目标')
  await expect(detail).not.toContainText(`${title} · 下一版本`)
  expect(requests).toEqual([])
})

test('学生审阅深链追溯原始证据，纠正有理由和引用，反馈后才发放修订许可', async ({ page }) => {
  const requests = await enterPreview(page, '/review?learner=learner-lin')
  await expect(page.getByRole('heading', { name: '林同学的学习记录', exact: true })).toBeVisible()
  await expect(page.locator('.t-rm-snapshot')).toContainText('submission-001')
  await page.locator('.t-rm-evidence-row').filter({ hasText: '边界条件与文件读取' }).click()
  const evidence = openDialog(page, '边界条件与文件读取')
  await expect(evidence).toContainText('while (fgets(')
  await expect(evidence).toContainText('已观察到概念提示')
  await evidence.getByRole('button', { name: '关闭原始引用', exact: true }).click()
  await expect(page.getByRole('button', { name: '允许修订', exact: true })).toBeDisabled()
  await page.locator('.t-rm-claim').first().getByRole('button', { name: '纠正', exact: true }).click()
  const decision = openDialog(page, '纠正判断')
  await expect(decision).toBeVisible()
  await decision.getByRole('textbox', { name: '纠正后的具体判断', exact: true }).fill('已处理受助后的空输入边界；独立解释仍缺证据。')
  await decision.getByRole('combobox', { name: '证据状态', exact: true }).selectOption('insufficient')
  await decision.getByRole('textbox', { name: /^判断理由/ }).fill('运行事实支持边界处理，不能据此推断独立掌握。')
  for (const checkbox of await decision.getByRole('checkbox').all()) await checkbox.uncheck()
  await decision.getByRole('button', { name: '保存到本机预览', exact: true }).click()
  await expect(decision.getByRole('alert')).toContainText('至少一条原始证据')
  await decision.getByRole('checkbox').first().check()
  await decision.getByRole('button', { name: '保存到本机预览', exact: true }).click()
  await expect(decision).not.toBeVisible()
  await expect(page.locator('.t-rm-claim').first()).toContainText('独立解释仍缺证据')
  await expect(page.locator('.t-rm-claim').first()).toContainText('证据不足')
  await page.getByRole('textbox', { name: '反馈正文', exact: true }).fill('请补充独立解释，并保留一次分配失败路径的反例。')
  await page.getByRole('button', { name: '保存反馈到预览', exact: true }).click()
  await expect(page.locator('.t-rm-page-heading')).toContainText('已反馈')
  await page.getByRole('button', { name: '允许修订', exact: true }).click()
  const grant = openDialog(page, '允许修订')
  await expect(grant).toContainText('许可绑定 submission-001')
  await grant.getByRole('textbox', { name: /^允许修订的理由与建议/ }).fill('根据这次反馈由学生主动重开，保留旧提交。')
  await grant.getByRole('checkbox').first().check()
  await grant.getByRole('button', { name: '保存到本机预览', exact: true }).click()
  await expect(page.getByRole('button', { name: '已允许修订', exact: true })).toBeDisabled()
  await page.reload()
  await expect(page.getByRole('textbox', { name: '反馈正文', exact: true })).toHaveValue('请补充独立解释，并保留一次分配失败路径的反例。')
  await expect(page.locator('.t-rm-decision-history')).toContainText('纠正判断')
  await expect(page.locator('.t-rm-decision-history')).toContainText('允许修订')
  await expect(page.locator('.t-rm-snapshot')).toContainText('submission-001')
  expect(requests).toEqual([])
})

test('学生账号误入教师入口回到本人首页，不读取教师课程或出现示例记录', async ({ page }) => {
  const reads: string[] = []
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname
    reads.push(path)
    const data = path === '/api/session' ? { userId: 'student-only', csrfToken: 'student-csrf', courses: [{ courseId: 'student-course', role: 'student' }] }
      : path === '/api/model-settings' ? { revision: 0, enabled: false, callsEnabled: false, defaultModelId: '', providers: [], efforts: {} }
        : path === '/api/courses/student-course/assignments' || path === '/api/agent/conversations' ? [] : undefined
    if (data === undefined) await route.fulfill({ status: 503, json: failure })
    else await route.fulfill({ json: { requestId, data } })
  })
  await page.goto(`${REAL_URL}/#/teacher`)
  await expect(page).toHaveURL(`${REAL_URL}/#/`)
  await expect(page.locator('.account-name')).toHaveText('student-only')
  await expect(page.locator('.t-preview-note')).toHaveCount(0)
  await expect(page.getByText('林同学', { exact: true })).toHaveCount(0)
  expect(reads.some(path => path.includes('/teacher-workbench'))).toBe(false)
})

test('真实分配读取失败明确显示错误，重试只读真实接口且不回退预览', async ({ page }) => {
  let unavailable = true
  const reads: string[] = []
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    expect(request.method()).toBe('GET')
    reads.push(path)
    if (path === '/api/session') {
      await route.fulfill({ json: { requestId, data: { userId: 'authorized-teacher', displayName: '陈老师', csrfToken: 'teacher-csrf',
        courses: [{ courseId: 'authorized-course', role: 'teacher' }] } } }); return
    }
    if (path === '/api/courses/authorized-course/teacher-workbench') {
      await route.fulfill(unavailable ? { status: 503, json: failure } : { json: { requestId, data: { courseId: 'authorized-course', courseName: '程序设计基础 · 一班', recoveryGeneration: 'g', members: [], resources: [], drafts: [], activities: [], assignments: [], attempts: [], presets: [] } } }); return
    }
    await route.fulfill({ status: 503, json: failure })
  })
  await page.goto(`${REAL_URL}/#/`)
  await expect(page).toHaveURL(`${REAL_URL}/#/teacher`)
  await expect(page.getByRole('alert')).toContainText('课程数据未能读取')
  await expect(page.getByRole('alert')).toContainText('DEPENDENCY_UNAVAILABLE')
  await expect(page.locator('.t-course-card')).toHaveCount(0)
  await expect(page.getByRole('button', { name: '设计新项目', exact: true })).toBeDisabled()
  unavailable = false
  await page.getByRole('button', { name: '重新读取', exact: true }).click()
  await expect(page.locator('.t-scope-note')).toContainText('已连接当前教学服务')
  await expect(page.locator('.t-course-card')).toHaveCount(1)
  await expect(page.locator('.t-course-card')).toContainText('程序设计基础 · 一班')
  await expect(page.locator('.t-course-card')).not.toContainText('authorized-course')
  await expect(page.locator('.t-course-cover > span:not(.t-course-mark), .t-course-card-body > p')).toHaveCount(0)
  await expect(page.locator('.t-account')).toContainText('陈老师')
  await expect(page.locator('.t-account small')).toHaveText('教师账号')
  await expect(page.locator('.t-account')).not.toContainText('authorized-teacher')
  await expect(page.locator('.t-preview-note')).toHaveCount(0)
  await expect(page.getByText('林同学', { exact: true })).toHaveCount(0)
  expect(reads.every(path => path === '/api/session' || path === '/api/courses/authorized-course/teacher-workbench')).toBe(true)
})

test('真实工作台按教师课程读取活动，未提交和审阅显示实际零值', async ({ page }) => {
  const paths: string[] = []
  await page.route('**/api/**', async route => {
    const request = route.request(), url = new URL(request.url())
    expect(request.method()).toBe('GET')
    paths.push(url.pathname)
    let data: unknown
    if (url.pathname === '/api/session') data = { userId: 'authorized-teacher', csrfToken: 'teacher-csrf', courses: [
      { courseId: 'authorized-course', role: 'teacher' }, { courseId: 'student-course', role: 'student' },
    ] }
    else if (url.pathname === '/api/courses/authorized-course/teacher-workbench') data = {
      courseId: 'authorized-course', recoveryGeneration: 'g', members: [], resources: [], drafts: [], attempts: [], presets: [],
      assignments: ['a', 'b'].map((studentId, index) => ({ assignmentId: `assignment-${index}`, studentId, activityVersionId: 'fixed-version', assignmentRevision: 1, active: true })),
      activities: [{ activityVersionId: 'fixed-version', courseId: 'authorized-course', sourceRevision: 9, activityControlRevision: 1,
        status: 'active', runtimeProfileVersionId: 'approved-profile',
        content: { audience: 'teacher-validator', content: { projectTitle: '授权课程中的真实活动', problem: '固定课程任务正文',
          routes: [], goals: [], tasks: [], observations: [], rubricCriteria: [], milestones: [] }, materials: [] },
        helpPolicy: { versionId: 'policy', description: '帮助政策', helpAllowed: true, wholeSolutionAllowed: false, limitedCheckHelpAllowed: false } }],
    }
    if (data === undefined) await route.fulfill({ status: 503, json: failure })
    else await route.fulfill({ json: { requestId, data } })
  })
  await page.goto(`${REAL_URL}/#/teacher/projects`)
  await expect(page.locator('.t-project-card')).toHaveCount(1)
  const card = page.locator('.t-project-card')
  await expect(card).toContainText('授权课程中的真实活动')
  await expect(card).toContainText('来源 revision 9')
  await expect(card.locator('.t-project-numbers')).toHaveText('2已分配0已提交0已审阅')
  await page.getByRole('navigation').getByRole('link', { name: '学生与审阅', exact: true }).click()
  await expect(page.locator('.t-page')).toContainText('暂无')
  await expect(page.locator('.t-rm-learner-row')).toHaveCount(0)
  // Development StrictMode may restart the loading effect; each load still fetches the shared activity only once.
  expect(paths).not.toContain('/api/activities/fixed-version')
  expect(paths).not.toContain('/api/courses/student-course/assignments')
})

test('课程学生名单读取真实成员与分配，未开始不生成尝试或审阅入口，按课程筛选', async ({ page }, info) => {
  const reads: string[] = []
  const workbenches = [
    { courseId: 'course-a', courseName: '程序设计基础 · 一班', recoveryGeneration: 'g', resources: [], drafts: [], activities: [], presets: [],
      members: [{ userId: 'not-started', displayName: '林同学' }, { userId: 'started', displayName: '陈同学' }],
      assignments: [{ assignmentId: 'assigned-pending', studentId: 'not-started', activityVersionId: 'activity-a', assignmentRevision: 1, active: true },
        { assignmentId: 'assigned-started', studentId: 'started', activityVersionId: 'activity-a', assignmentRevision: 1, active: true }],
      attempts: [{ attemptId: 'original-attempt', courseId: 'course-a', studentId: 'started', assignmentId: 'assigned-started', activityVersionId: 'activity-a',
        status: 'active', attemptRevision: 1, workspaceRevision: 0, latestSubmission: null }] },
    { courseId: 'course-b', courseName: '数字逻辑 · 二班', recoveryGeneration: 'g', resources: [], drafts: [], activities: [], presets: [],
      members: [{ userId: 'unassigned', displayName: '周同学' }], assignments: [], attempts: [] },
  ]
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    expect(request.method()).toBe('GET'); reads.push(path)
    const data = path === '/api/session' ? { userId: 'authorized-teacher', csrfToken: 'teacher-csrf', courses: workbenches.map(w => ({ courseId: w.courseId, role: 'teacher' })) }
      : workbenches.find(w => path === `/api/courses/${w.courseId}/teacher-workbench`)
    if (data === undefined) await route.fulfill({ status: 503, json: failure })
    else await route.fulfill({ json: { requestId, data } })
  })
  await page.goto(`${REAL_URL}/#/teacher/review`)
  const roster = page.getByRole('table', { name: '课程学生', exact: true })
  await expect(roster.getByRole('row')).toHaveCount(4)
  const pending = roster.getByRole('row').filter({ hasText: '林同学' })
  await expect(pending).not.toContainText('not-started')
  await expect(pending).toContainText('程序设计基础 · 一班')
  await expect(pending.getByRole('cell').nth(2)).toHaveText('1 项1 项开放')
  await expect(pending.getByRole('cell').nth(3)).toHaveText('未开始0 次尝试')
  await expect(pending.getByRole('button')).toHaveCount(0)
  await expect(pending.getByRole('link')).toHaveCount(0)
  await expect(roster.getByRole('row').filter({ hasText: '陈同学' })).toContainText('进行中1 次尝试')
  await expect(roster.getByRole('row').filter({ hasText: '周同学' })).toContainText('0 项0 项开放未开始0 次尝试')
  expect(reads.some(path => path.startsWith('/api/attempts/'))).toBe(false)
  await page.getByRole('combobox', { name: '当前课程', exact: true }).selectOption('course-b')
  await expect(roster.getByRole('row')).toHaveCount(2)
  await expect(roster).toContainText('数字逻辑 · 二班')
  await expect(roster).not.toContainText('林同学')
  await expect(page.locator('button.t-rm-learner-row')).toHaveCount(0)
  await page.getByRole('combobox', { name: '当前课程', exact: true }).selectOption('all')
  await expect(roster.getByRole('row')).toHaveCount(4)
  await expect(page.locator('button.t-rm-learner-row .t-rm-learner-identity')).toHaveText('陈同陈同学')
  await page.locator('.t-live-review').screenshot({ path: info.outputPath('course-student-roster.png') })
  await page.setViewportSize({ width: 390, height: 1000 })
  await expect.poll(() => page.locator('.t-main').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
  await page.screenshot({ path: info.outputPath('course-student-roster-mobile.png'), fullPage: true })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.locator('button.t-rm-learner-row').click()
  await expect.poll(() => reads.filter(path => path.startsWith('/api/attempts/'))).toEqual(['/api/attempts/original-attempt/review-context'])
})

test('720与390宽度主要页面无水平溢出，主题切换与刷新保留偏好', async ({ page }, info) => {
  await page.emulateMedia({ colorScheme: 'light' })
  const requests = await enterPreview(page)
  const paths = ['', '/projects', '/design/draft-report', '/review?learner=learner-lin', '/materials', '/settings']
  for (const width of [720, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const path of paths) {
      await page.goto(`${REAL_URL}${preview}${path}`)
      await expect(page.locator('.t-page h1')).toBeVisible()
      const overflow = await page.evaluate(() => {
        const main = document.querySelector('.t-main')!
        return { document: document.documentElement.scrollWidth - window.innerWidth, main: main.scrollWidth - main.clientWidth }
      })
      expect(overflow.document, `${width}px ${path || '/'} document`).toBeLessThanOrEqual(1)
      expect(overflow.main, `${width}px ${path || '/'} main`).toBeLessThanOrEqual(1)
      if (!path) await page.screenshot({ path: info.outputPath(`teacher-overview-${width}.png`) })
    }
  }
  await page.getByLabel('显示主题', { exact: true }).selectOption('dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: info.outputPath('teacher-settings-dark-390.png') })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByLabel('显示主题', { exact: true })).toHaveValue('dark')
  await page.getByRole('button', { name: '切换浅色模式', exact: true }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  expect(requests).toEqual([])
})
