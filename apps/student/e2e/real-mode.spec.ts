import { expect, test, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { REAL_URL } from './env'

/**
 * 真实模式（普通 `npm run dev`）的边界核对。
 *
 * 依据 docs/tasks/I0_UI_CLIENT_CONTRACT.md §2：普通 dev 用真实 transport，真实初始化不足时
 * 显示不可用，不能自动改用 fixture。深链使用固定宿主 bootstrap；下方协议替身只证明实际前端、
 * 浏览器和本机事务，正常宿主/TLS/节点与模型由主 Agent 另验。
 */

test.describe('真实模式', () => {
  test('不挂载准备 fixture，准备深链不冒充合成成功', async ({ page, request }) => {
    const ctx = await request.get(REAL_URL + '/__i0prep/context', {
      headers: { Accept: 'application/json' },
    })
    const ctxBody = await ctx.text()
    expect(ctxBody).not.toContain('i0-prep-textscope-c')
    expect(ctxBody).not.toContain('preparationEpoch')
    expect(ctxBody).not.toContain('syntheticAccount')

    await page.goto(REAL_URL + '/#/')
    await expect(page.locator('.prep-entry')).toHaveCount(0)

    // 同一深链容器可挂载，普通 dev 没有可用 Session，不取准备正文/身份。
    await page.goto(REAL_URL + '/#/task/i0-prep-textscope-c')
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'unavailable')
    await expect(page.locator('.ts-badge')).toContainText('真实分配')
    await expect(page.locator('.ts-synth-flag')).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('prep-student-01')
  })

  test('真实 /api 没有可回退的数据源（H-01 缺口如实暴露）', async ({ request }) => {
    const res = await request.get(REAL_URL + '/api/session', {
      headers: { Accept: 'application/json' },
    })
    const body = await res.text()
    // 断言「拿不到可用会话」，不用「状态码 >= 400 或不是信封」这类恒真条件：
    // 无论开发服务器落回 SPA HTML（200）还是真实后端回 401 信封，都不得出现可用的会话字段，
    // 也不得出现准备 fixture 的合成身份或端点。
    expect(body).not.toContain('csrfToken')
    expect(body).not.toContain('"userId"')
    expect(body).not.toContain('prep-student-01')
    expect(body).not.toContain('__i0prep')
    expect(body).not.toContain('i0-prep-textscope-c')
    if (res.status() === 200) {
      // 200 只可能是 Vite 落回的 SPA HTML，不能是 JSON 会话信封
      expect(res.headers()['content-type'] ?? '').not.toContain('application/json')
    } else {
      expect(res.status()).toBeGreaterThanOrEqual(400)
    }
  })

  test('原数字逻辑演示在真实模式下同样保留', async ({ page }) => {
    await page.goto(REAL_URL + '/#/task/counter')
    await expect(page.locator('.ws-intro-veil')).toContainText('可交互数字计数器')
    await page.locator('.ws-intro-veil').getByRole('button', { name: /开始任务|进入任务/ }).click()
    await page.getByRole('button', { name: '任务信息' }).click()
    await expect(page.locator('.ws-demo-flag')).toContainText('演示数据')
    await expect(page.getByRole('button', { name: '检查并构建' })).toBeVisible()
  })
})

// 普通 real 开发服务上的公开协议替身；不连接后台，不计作实际宿主/TLS验收。
const ids = { assignment: 'protocol-assignment-a', activity: 'protocol-activity-a', student: 'protocol-student-a',
  course: 'protocol-course-a', attempt: 'protocol-attempt-a', generation: 'protocol-generation-a' }
const assignment = { assignmentId: ids.assignment, activityVersionId: ids.activity, studentId: ids.student,
  assignmentRevision: 1, active: true, status: 'active', reasons: { individual: '', activity: '' }, activityControlRevision: 1 }
const activity = { activityVersionId: ids.activity, courseId: ids.course, activityControlRevision: 1, status: 'active',
  runtimeProfileVersionId: 'protocol-c-profile', helpPolicy: { versionId: 'protocol-policy', helpAllowed: true,
    wholeSolutionAllowed: false, limitedCheckHelpAllowed: false, description: 'Protocol test help' },
  content: { audience: 'student', materials: [{ status: 'redacted' }], content: {
    projectTitle: '协议检查的 C 项目', problem: '仅检查前端接线', audience: 'student', artifact: 'Code',
    studentBackground: '', timeConstraints: '', routes: [], goals: [], tasks: [], observations: [], rubricCriteria: [],
    milestones: [], helpPolicyVersionId: 'protocol-policy',
  } },
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
  return JSON.stringify(value)
}
async function mockProtocol(page: Page, options: { paused?: boolean; generation?: string; studentId?: string } = {}) {
  const seen: Array<{ path: string; method: string; body?: Record<string, unknown>; headers: Record<string, string> }> = []
  let created = false, signedIn = true
  const view = { ...assignment, ...(options.paused ? { active: false, status: 'paused' } : {}),
    studentId: options.studentId ?? ids.student }
  await page.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname, method = req.method()
    const body = method === 'POST' ? req.postDataJSON() as Record<string, unknown> : undefined
    const headers = req.headers()
    seen.push({ path, method, body, headers })
    let data: unknown
    if (path === '/api/session' && signedIn) data = { userId: ids.student, courses: [{ courseId: ids.course, role: 'student' }], csrfToken: 'protocol-csrf' }
    else if (path === `/api/assignments/${ids.assignment}/bootstrap`) data = { assignment: view, recoveryGeneration: options.generation ?? ids.generation }
    else if (path === `/api/assignments/${ids.assignment}`) data = view
    else if (path === `/api/activities/${ids.activity}`) data = activity
    else if (path === `/api/assignments/${ids.assignment}/attempts` && method === 'POST') {
      created = true
      data = { receiptId: 'protocol-receipt', commandId: 'protocol-command',
        requestHash: createHash('sha256').update(canonical({ target: ids.assignment, fields: body })).digest('hex'),
        serverSeq: 1, committedAt: '2026-10-13T16:00:00Z', replayed: false,
        result: { attemptId: ids.attempt, assignmentId: ids.assignment, activityVersionId: ids.activity },
        identity: { actorId: ids.student, command: 'attempt.create', target: ids.assignment,
          idempotencyKey: headers['idempotency-key'], recoveryGeneration: ids.generation,
          scope: { courseId: ids.course, studentId: ids.student, attemptId: ids.attempt } } }
    } else if (path === `/api/attempts/${ids.attempt}` && created) data = { attempt: {
      attemptId: ids.attempt, assignmentId: ids.assignment, activityVersionId: ids.activity,
      courseId: ids.course, studentId: ids.student, status: 'ready', attemptRevision: 1,
      workspaceRevision: 0, decisionEpoch: 0, captureRevision: 0, collecting: true, reminders: false,
    }, files: [], snapshots: [], jobs: [], runs: [], checks: [] }
    else if (path === '/api/logout' && method === 'POST') { signedIn = false; data = { loggedOut: true } }
    if (data === undefined) {
      await route.fulfill({ status: 401, json: { requestId: 'protocol-read', error: {
        code: 'UNAUTHENTICATED', message: 'Protocol stub unavailable', retryable: false, recovery: 'Read session',
      } } })
    } else await route.fulfill({ json: { requestId: 'protocol-read', data } })
  })
  return seen
}

test.describe('real 入口协议替身（非真实宿主验收）', () => {
  test('只读载入→学生明确创建→同本机刷新恢复；不使用准备身份/端点', async ({ page }) => {
    const seen = await mockProtocol(page)
    const fixtureRequests: string[] = []
    page.on('request', request => { if (request.url().includes('__i0prep')) fixtureRequests.push(request.url()) })
    await page.goto(`${REAL_URL}/#/task/${ids.assignment}`)
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
    await expect(page.locator('.ts-badge')).toContainText('真实分配')
    const start = page.getByRole('button', { name: '开始 Attempt', exact: true })
    await expect(start).toBeEnabled()
    await expect(page.locator('.ts-synth-flag')).toHaveCount(0)
    await expect(page.locator('body')).not.toContainText('准备场景（合成）')
    expect(seen.every(item => item.method === 'GET')).toBe(true)
    expect(seen.some(item => item.path.endsWith('/bootstrap'))).toBe(true)
    await start.click()
    await expect(page.locator('.cw')).toBeVisible()
    const creates = seen.filter(item => item.method === 'POST')
    expect(creates).toHaveLength(1)
    expect(creates[0]!.path).toBe(`/api/assignments/${ids.assignment}/attempts`)
    expect(creates[0]!.body).toEqual({ recoveryGeneration: ids.generation })
    expect(creates[0]!.headers['x-csrf-token']).toBe('protocol-csrf')
    expect(creates[0]!.headers['idempotency-key']).toBeTruthy()
    await page.reload()
    await expect(page.locator('.cw')).toBeVisible()
    expect(seen.filter(item => item.method === 'POST')).toHaveLength(1)
    expect(fixtureRequests).toEqual([])
    await page.getByRole('button', { name: '任务信息', exact: true }).click()
    await expect(page.locator('.ts-taskinfo')).toContainText(ids.student)
    await expect(page.locator('.ts-taskinfo')).not.toContainText('身份与会话（合成）')
    await page.keyboard.press('Escape')
    await expect(page.locator('.ws-popveil')).toHaveCount(0)
    await page.getByRole('button', { name: '退出', exact: true }).click()
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'unavailable')
    await expect(page.locator('.cw')).toHaveCount(0)
  })
  test('暂停分配可以阅读，不能首次创建', async ({ page }) => {
    const seen = await mockProtocol(page, { paused: true })
    await page.goto(`${REAL_URL}/#/task/${ids.assignment}`)
    await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'ready')
    await expect(page.getByRole('button', { name: '开始 Attempt', exact: true })).toBeDisabled()
    await expect(page.locator('.ts-pending-pill')).toHaveText('分配已暂停')
    expect(seen.every(item => item.method === 'GET')).toBe(true)
  })
  for (const options of [{ generation: '' }, { studentId: 'protocol-other-student' }]) {
    test(`${options.generation === '' ? '缺代际' : '跨学生'}不进入，不回 fixture`, async ({ page }) => {
      const seen = await mockProtocol(page, options)
      const fixtureRequests: string[] = []
      page.on('request', request => { if (request.url().includes('__i0prep')) fixtureRequests.push(request.url()) })
      await page.goto(`${REAL_URL}/#/task/${ids.assignment}`)
      await expect(page.locator('.ts-badge')).toHaveAttribute('data-status', 'unavailable')
      await expect(page.locator('.cw')).toHaveCount(0)
      expect(seen.every(item => item.method === 'GET')).toBe(true)
      expect(seen.some(item => item.path.includes('/activities/'))).toBe(false)
      expect(fixtureRequests).toEqual([])
    })
  }
})
