import { expect, test, type Page } from '@playwright/test'
import { REAL_URL } from './env'
import type { BlueprintContent } from '../src/teacher/wire'

// Isolated HTTP protocol checks, never a cloud/supplier call or real teaching record.
const original: BlueprintContent = { projectTitle: '合成设计', problem: '原问题', routes: [], goals: [], tasks: [], observations: [], rubricCriteria: [], milestones: [], resources: [] }
async function setup(page: Page, existing = false, budgetClosed = false) {
  let revision = 1, problem = '原问题', mode = 'candidates', created = false, stale = false, conflict = false, jobStatus = 'succeeded'
  let loseAck = false
  const writes: { path: string; body: Record<string, unknown>; key: string }[] = []
  const reads: string[] = []
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname
    let data: unknown
    const draft = { courseId: 'c1', blueprintId: 'b1', revision, content: { ...original, problem } }
    const failure = async (code: string, status: number) => route.fulfill({ status, json: { requestId: 'ai-test', error: { code, message: code, retryable: false, recovery: 'Read the original request' } } })
    if (request.method() === 'GET') {
      reads.push(path)
      if (path === '/api/session') data = { userId: 'teacher-ai-test', csrfToken: 'csrf-ai', courses: [{ courseId: 'c1', role: 'teacher' }] }
      else if (path === '/api/courses/c1/teacher-workbench') data = { courseId: 'c1', courseName: '合成课程', recoveryGeneration: 'g1',
        drafts: existing ? [draft] : created ? [{ ...draft, blueprintId: 'new-draft' }] : [],
        members: [], activities: [], assignments: [], attempts: [], presets: [], resources: [true, false].map((allowed, i) => ({
          courseId: 'c1', resourceVersionId: `r${i}`, available: true, teacherDesignAllowed: allowed,
          material: { title: allowed ? '获准样例' : '未授权材料', text: '合成段落', kind: 'private_answer', format: 'paste', byteLength: 12,
            contentHash: 'a'.repeat(64), visibility: { student: false, tutor: false },
            paragraphs: [{ paragraphId: `para${i}`, ordinal: 0, start: 0, end: 4, text: '合成段落', contentHash: 'a'.repeat(64) }] },
        })) }
      else if (path === '/api/jobs/j1') data = { jobId: 'j1', status: jobStatus, ...(jobStatus === 'succeeded' ? { proposalId: 'p1', resultHash: 'a'.repeat(64) } : {}) }
      else if (path === '/api/design-proposals/p1') data = { proposalId: 'p1', jobId: 'j1', courseId: 'c1', blueprintId: existing ? 'b1' : null, baseRevision: existing ? 1 : 0,
        resultHash: 'a'.repeat(64), applicable: !stale, rationale: '建议理由', affectedReferences: ['para0'], modelResult: { calls: 1, elapsedMs: 8, usage: { status: 'unknown' } },
        body: mode === 'rubric_trial' ? { kind: mode, criterionComments: ['样例评价'], ambiguities: ['歧义说明'], suggestedChanges: ['由教师修订'], sampleRefs: ['para0'], unresolved: [] }
          : mode === 'patch' ? { kind: mode, changes: [{ field: 'problem', value: 'AI候选问题' }], unresolved: [] }
            : mode === 'blueprint' ? { kind: mode, problem: 'AI候选问题', goals: ['文字目标'], unresolved: ['教师核对'] }
              : { kind: 'candidates', candidates: [{ problem: 'AI候选问题', audience: '合成受众', artifact: '合成产物', routes: [], goals: ['候选目标'], unresolved: ['教师核对'] }] },
        diff: [{ path: 'problem', before: existing ? '原问题' : null, after: 'AI候选问题' }],
      }
      else if (path === '/api/model-settings') data = { revision: 0, enabled: false, callsEnabled: false, defaultModelId: '', providers: [], efforts: {} }
      else if (path === '/api/agent/conversations' || path === '/api/courses/c1/assignments') data = []
      else return failure('NOT_FOUND', 404)
    } else {
      const body = request.postDataJSON() as Record<string, unknown>, key = request.headers()['idempotency-key']!
      writes.push({ path, body, key })
      expect(request.headers()['x-csrf-token']).toBe('csrf-ai'); expect(key).toBeTruthy()
      let result: unknown
      if (path.endsWith('/proposals') || path === '/api/courses/c1/blueprints' || path.endsWith('/rubric-trials')) {
        if (budgetClosed) return failure('BUDGET_EXHAUSTED', 409)
        mode = path.endsWith('/rubric-trials') ? 'rubric_trial' : (body.generationMode ?? body.mode) as string
        if (loseAck) { loseAck = false; await route.abort('failed'); return }
        result = { jobId: 'j1', status: 'queued' }
      } else if (path === '/api/design-proposals/p1/adopt') {
        created = true; result = { kind: 'draft', draft: { ...draft, blueprintId: 'new-draft' } }
      } else if (path === '/api/blueprints/b1') {
        if (conflict) return failure('VERSION_CONFLICT', 409)
        expect(body.expectedRevision).toBe(revision); expect(body.proposalId).toBe('p1')
        expect(body.patch).toEqual({ problem: 'AI候选问题' }); revision++; problem = 'AI候选问题'
        result = { kind: 'draft', draft: { ...draft, revision, content: { ...original, problem } } }
      } else if (path === '/api/jobs/j1/cancel') { jobStatus = 'cancelled'; result = { jobId: 'j1', status: 'cancelled', attemptCount: 0 } }
      else return failure('NOT_FOUND', 404)
      data = { result, commandId: 'cmd-ai', receiptId: `receipt-${writes.length}`, identity: { actorId: 'teacher-ai-test', idempotencyKey: key, recoveryGeneration: 'g1' } }
    }
    await route.fulfill({ json: { requestId: 'ai-test', data } })
  })
  return { writes, reads, stale: () => { stale = true }, conflict: () => { conflict = true }, loseAck: () => { loseAck = true }, running: () => { jobStatus = 'running' } }
}
async function enter(page: Page, existing = false) {
  await page.goto(`${REAL_URL}/#/teacher/design/${existing ? 'b1' : 'new'}?course=c1`)
  const panel = page.locator('.tda-panel')
  await panel.locator('summary').first().click()
  await panel.getByLabel('给 AI 的设计要求').fill('仅使用获准资料，提供合成测试建议')
  return panel
}
test('预算关闭如实失败，未授权材料不进入设计上下文', async ({ page }) => {
  const api = await setup(page, false, true), panel = await enter(page)
  await expect(panel).not.toContainText('未授权材料')
  await panel.getByRole('button', { name: '提交设计请求' }).click()
  await expect(panel.getByRole('alert')).toContainText('BUDGET_EXHAUSTED')
  expect(api.writes).toHaveLength(1); expect(api.reads.some(path => path.startsWith('/api/jobs/'))).toBe(false)
})
test('根候选显式选择并采用为新草稿；刷新恢复只读取不重新生成', async ({ page }, info) => {
  const api = await setup(page), panel = await enter(page)
  await panel.getByRole('button', { name: '提交设计请求' }).click()
  await expect(panel.getByRole('region', { name: '模型设计候选' })).toBeVisible()
  await page.reload()
  await panel.locator('summary').first().click()
  await expect(panel.getByRole('region', { name: '模型设计候选' })).toBeVisible()
  await expect(panel.getByRole('button', { name: '采用为新草稿' })).toBeDisabled()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await panel.locator('summary').first().scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('design-ai-controls.png') })
  await panel.getByRole('region', { name: '模型设计候选' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('design-ai-desktop.png') })
  await page.setViewportSize({ width: 390, height: 900 })
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true)
  await panel.getByRole('region', { name: '模型设计候选' }).scrollIntoViewIfNeeded()
  await page.screenshot({ path: info.outputPath('design-ai-mobile.png') })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await panel.getByRole('radio', { name: '选择候选 1' }).check()
  await panel.getByRole('button', { name: '采用为新草稿' }).click()
  await expect(page).toHaveURL(/design\/new-draft/)
  expect(api.writes.map(w => w.path)).toEqual(['/api/courses/c1/blueprints', '/api/design-proposals/p1/adopt'])
})
test('已有蓝图局部建议只PATCH允许字段；教师编辑后不能覆盖', async ({ page }) => {
  const api = await setup(page, true), panel = await enter(page, true)
  await panel.getByRole('button', { name: '提交设计请求' }).click()
  const adopt = panel.getByRole('button', { name: '采用允许字段到草稿新版本' })
  await expect(adopt).toBeEnabled()
  await page.getByRole('textbox', { name: '驱动问题', exact: true }).fill('教师期间手改')
  await expect(adopt).toBeDisabled(); await expect(panel).toContainText('期间发生人工编辑')
  expect(api.writes).toHaveLength(1)
})
test('局部采纳冲突不覆盖当前编辑', async ({ page }) => {
  const api = await setup(page, true), panel = await enter(page, true)
  await panel.getByRole('button', { name: '提交设计请求' }).click()
  await expect(panel.getByRole('button', { name: '采用允许字段到草稿新版本' })).toBeEnabled()
  api.conflict()
  await panel.getByRole('button', { name: '采用允许字段到草稿新版本' }).click()
  await expect(panel.getByRole('alert')).toContainText('VERSION_CONFLICT')
  await expect(page.getByRole('textbox', { name: '驱动问题', exact: true })).toHaveValue('原问题')
})
test('局部采纳显式保存为新revision，并保持原蓝图ID', async ({ page }) => {
  const api = await setup(page, true), panel = await enter(page, true)
  await panel.getByRole('button', { name: '提交设计请求' }).click()
  await expect(panel.getByRole('button', { name: '采用允许字段到草稿新版本' })).toBeEnabled()
  await panel.getByRole('button', { name: '采用允许字段到草稿新版本' }).click()
  await expect(page.getByRole('textbox', { name: '驱动问题', exact: true })).toHaveValue('AI候选问题')
  await expect(page.locator('.td-save-state')).toContainText('v2')
  expect(api.writes.map(item => item.path)).toEqual(['/api/blueprints/b1/proposals', '/api/blueprints/b1'])
})
test('量规试评须显式认可样例，结果只提供建议', async ({ page }) => {
  const api = await setup(page, true), panel = await enter(page, true)
  await panel.getByLabel('设计协助类型').selectOption('rubric_trial')
  await panel.getByRole('button', { name: '提交设计请求' }).click()
  await expect(panel.getByRole('alert')).toContainText('至少一个')
  expect(api.writes).toHaveLength(0)
  await panel.getByRole('checkbox', { name: /获准样例/ }).check()
  await panel.getByRole('checkbox', { name: '将此段作为教师认可的试评样例' }).check()
  await panel.getByRole('button', { name: '提交设计请求' }).click()
  await expect(panel).toContainText('歧义说明')
  await expect(panel.getByRole('button', { name: /采用/ })).toHaveCount(0)
  expect(api.writes[0]!.body).toMatchObject({ expectedRevision: 1, sampleReferenceIds: ['para0'], references: [{ paragraphId: 'para0', contentHash: 'a'.repeat(64) }] })
})
test('未知响应核对原请求保留字节与幂等键，运行中可取消', async ({ page }) => {
  const api = await setup(page, true), panel = await enter(page, true)
  api.loseAck(); api.running()
  await panel.getByRole('button', { name: '提交设计请求' }).click()
  await expect(panel.getByRole('button', { name: '核对原 AI 请求' })).toBeVisible()
  await panel.getByRole('button', { name: '核对原 AI 请求' }).click()
  await expect(panel.getByRole('button', { name: '取消设计任务' })).toBeVisible()
  expect(api.writes[0]).toEqual(api.writes[1])
  await panel.getByRole('button', { name: '取消设计任务' }).click()
  await expect(panel).toContainText('已取消')
})
