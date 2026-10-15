import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextGuard } from './context'
import { loadWorkspaceInit } from './init'
import type { ActivityView, AssignmentView, SessionView } from './contracts'

const assignment: AssignmentView = {
  assignmentId: 'approved-assignment', activityVersionId: 'fixed-activity', studentId: 'student-a',
  assignmentRevision: 1, active: true, status: 'active', reasons: { individual: '', activity: '' }, activityControlRevision: 1,
}
const session: SessionView = { userId: 'student-a', courses: [{ courseId: 'course-a', role: 'student' }], csrfToken: 'session-csrf' }
const activity: ActivityView = {
  activityVersionId: 'fixed-activity', courseId: 'course-a', activityControlRevision: 1, status: 'active',
  runtimeProfileVersionId: 'profile-a', helpPolicy: { versionId: 'policy-a', helpAllowed: true,
    wholeSolutionAllowed: false, limitedCheckHelpAllowed: false, description: 'Conceptual help' },
  content: { audience: 'student', materials: [{ status: 'redacted' }], content: {
    projectTitle: 'Project', problem: 'Explore', audience: 'student', artifact: 'Code', studentBackground: '',
    timeConstraints: '', routes: [], goals: [], tasks: [], observations: [], rubricCriteria: [], milestones: [], helpPolicyVersionId: 'policy-a',
  } },
}
const guard = (assignmentId: string | null = assignment.assignmentId) => new ContextGuard({ mode: 'real',
  userId: null, assignmentId, activityVersionId: null, attemptId: null, preparationEpoch: null,
  loadEpoch: 1, trustedRecoveryGeneration: null,
})
function transport(options: { session?: unknown; bootstrap?: unknown; activity?: unknown; status?: number } = {}) {
  const paths: string[] = []
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    paths.push(url)
    expect(init.method).toBe('GET')
    const data = url === '/api/session' ? options.session ?? session
      : url.endsWith('/bootstrap') ? options.bootstrap ?? { assignment, recoveryGeneration: 'trusted-generation' }
      : url.startsWith('/api/activities/') ? options.activity ?? activity : undefined
    if (data === undefined) throw new Error(`Unexpected read ${url}`)
    return new Response(JSON.stringify(options.status ? { requestId: 'r', error: {
      code: 'UNAUTHENTICATED', message: 'No session', retryable: false, recovery: 'Login',
    } } : { requestId: 'r', data }), { status: options.status ?? 200, headers: { 'content-type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fn)
  return paths
}
afterEach(() => vi.unstubAllGlobals())

describe('real 深链初始化（协议替身，非宿主验收）', () => {
  it('只读合法分配；取服务代际，不创建 Attempt/求助/保存/运行或读取裁剪资料', async () => {
    const paths = transport()
    const result = await loadWorkspaceInit(guard())
    expect(result.kind).toBe('ready')
    if (result.kind !== 'ready') throw new Error('Expected ready')
    expect(result.context).toMatchObject({ userId: session.userId, assignmentId: assignment.assignmentId,
      activityVersionId: activity.activityVersionId, trustedRecoveryGeneration: 'trusted-generation', attemptId: null, preparationEpoch: null })
    expect(result.prepContext).toBeNull()
    expect(paths).toEqual(['/api/session', '/api/assignments/approved-assignment/bootstrap', '/api/activities/fixed-activity?audience=student'])
  })
  it('没有深链引用时不遍历或猜分配', async () => {
    const paths = transport()
    expect(await loadWorkspaceInit(guard(null))).toMatchObject({ kind: 'unavailable', stage: 'discovery' })
    expect(paths).toEqual(['/api/session'])
  })
  it('匿名失败不读分配或回准备端点', async () => {
    const paths = transport({ status: 401 })
    expect(await loadWorkspaceInit(guard())).toMatchObject({ kind: 'unavailable', stage: 'session' })
    expect(paths).toEqual(['/api/session'])
  })
  it.each([
    { status: 403, code: 'FORBIDDEN', reason: '当前账号无法访问这个任务' },
    { status: 503, code: 'DEPENDENCY_UNAVAILABLE', reason: '这项分配没有读取成功' },
  ])('分配读取 $status 给出对应恢复说明，不猜任务或绕过鉴权', async ({ status, code, reason }) => {
    const paths = transport()
    const original = globalThis.fetch
    vi.stubGlobal('fetch', async (url: string, request: RequestInit) => url.endsWith('/bootstrap')
      ? new Response(JSON.stringify({ requestId: 'rejected-bootstrap', error: {
        code, message: 'Unavailable', retryable: false, recovery: 'Read current assignments',
      } }), { status, headers: { 'content-type': 'application/json' } })
      : original(url, request))
    const result = await loadWorkspaceInit(guard())
    expect(result).toMatchObject({ kind: 'unavailable', stage: 'assignment', reason: expect.stringContaining(reason),
      failure: { kind: 'api', status, error: { code } } })
    expect(paths).toEqual(['/api/session'])
  })
  it.each([
    { assignment: { ...assignment, assignmentId: 'other-assignment' }, recoveryGeneration: 'trusted-generation' },
    { assignment: { ...assignment, studentId: 'student-b' }, recoveryGeneration: 'trusted-generation' },
    { assignment, recoveryGeneration: '' },
    { assignment },
  ])('错误引用/跨学生/缺代际不能进入 ($assignment.studentId)', async bootstrap => {
    const paths = transport({ bootstrap })
    expect(await loadWorkspaceInit(guard())).toMatchObject({ kind: 'unavailable', stage: 'assignment' })
    expect(paths).toHaveLength(2)
  })
  it.each([
    { ...session, courses: [{ courseId: 'course-a', role: 'teacher' }] },
    { ...session, courses: [{ courseId: 'course-b', role: 'student' }] },
  ])('必须是活动所在课程的学生成员', async candidate => {
    transport({ session: candidate })
    expect(await loadWorkspaceInit(guard())).toMatchObject({ kind: 'unavailable', stage: 'activity' })
  })
  it('活动版本/控制改变不接纳旧分配', async () => {
    transport({ activity: { ...activity, activityControlRevision: 2 } })
    expect(await loadWorkspaceInit(guard())).toMatchObject({ kind: 'unavailable', stage: 'activity' })
  })
  it('活动缺正文或错误学生视角时不安装可见工作区', async () => {
    transport({ activity: { ...activity, content: { audience: 'teacher-validator' } } })
    expect(await loadWorkspaceInit(guard())).toMatchObject({ kind: 'unavailable', stage: 'activity' })
  })
  it('暂停分配可以只读，active=false 原样保留', async () => {
    transport({ bootstrap: { assignment: { ...assignment, active: false, status: 'paused' }, recoveryGeneration: 'trusted-generation' } })
    const result = await loadWorkspaceInit(guard())
    expect(result).toMatchObject({ kind: 'ready', assignment: { active: false, status: 'paused' } })
  })
  it('换任务后迟到的 bootstrap 不覆盖新上下文或继续读取活动', async () => {
    const paths = transport()
    const original = fetch
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    let bootstrapStarted!: () => void
    const started = new Promise<void>(resolve => { bootstrapStarted = resolve })
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      const response = await original(url, init)
      if (url.endsWith('/bootstrap')) { bootstrapStarted(); await hold }
      return response
    })
    const old = guard(), pending = loadWorkspaceInit(old)
    await started
    const next = guard('another-assignment')
    release()
    expect(await pending).toEqual({ kind: 'stale' })
    expect(next.stale).toBe(false)
    expect(paths).toHaveLength(2)
  })
  it('卸载后迟到的 Session 不读取 bootstrap', async () => {
    let release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const fn = vi.fn(async () => { await hold; return new Response(JSON.stringify({ requestId: 'r', data: session })) })
    vi.stubGlobal('fetch', fn)
    const current = guard(), pending = loadWorkspaceInit(current)
    current.dispose(); release()
    expect(await pending).toEqual({ kind: 'stale' })
    expect(fn).toHaveBeenCalledOnce()
  })
  it('资源响应错绑版本时仅标缺口，不展示其正文', async () => {
    transport({ activity: { ...activity, content: { ...activity.content, materials: [
      { status: 'available', resourceVersionId: 'resource-a' },
    ] } } })
    const original = fetch
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => url.includes('/resources/')
      ? new Response(JSON.stringify({ requestId: 'r', data: { status: 'available', resourceVersionId: 'wrong-resource',
        title: 'Wrong version', text: 'Not allowed to install', contentHash: 'hash', paragraphs: [] } })) : original(url, init))
    const result = await loadWorkspaceInit(guard())
    expect(result).toMatchObject({ kind: 'ready', materials: [{ state: { kind: 'failed', resourceVersionId: 'resource-a' } }] })
    expect(JSON.stringify(result)).not.toContain('Not allowed to install')
  })
  it('资源迟到前换任务，不安装前一任务材料', async () => {
    transport({ activity: { ...activity, content: { ...activity.content, materials: [
      { status: 'available', resourceVersionId: 'resource-a' },
    ] } } })
    const original = fetch
    let release!: () => void, arrived!: () => void
    const hold = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { arrived = resolve })
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (!url.includes('/resources/')) return original(url, init)
      arrived(); await hold
      return new Response(JSON.stringify({ requestId: 'r', data: { status: 'available', resourceVersionId: 'resource-a',
        title: 'Old material', text: 'Old text', contentHash: 'hash', paragraphs: [] } }))
    })
    const pending = loadWorkspaceInit(guard())
    await started
    guard('new-assignment'); release()
    expect(await pending).toEqual({ kind: 'stale' })
  })
})
