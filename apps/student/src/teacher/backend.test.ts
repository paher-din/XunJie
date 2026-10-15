import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadTeacherWorkbenchData, pendingTeacherCommands, retryTeacherCommands, teacherCommand } from './backend'
import { setCsrfToken } from '../workspace/http'

const envelope = (data: unknown) => new Response(JSON.stringify({ requestId: 'test-read', data }))
const receipt = (account: string, init: RequestInit) => ({ commandId: 'command', receiptId: 'receipt', identity: { actorId: account, idempotencyKey: (init.headers as Record<string, string>)['Idempotency-Key'], recoveryGeneration: 'generation' }, result: { accepted: true } })
const session = { userId: 'teacher', csrfToken: 'csrf', courses: [{ courseId: 'course/a', role: 'teacher' as const }] }
beforeEach(() => {
  const values = new Map<string, string>()
  vi.stubGlobal('sessionStorage', {
    get length() { return values.size }, key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  setCsrfToken('test-csrf')
})
afterEach(() => { vi.unstubAllGlobals(); setCsrfToken(null) })

describe('教师真实命令和课程读取', () => {
  it('未知结果保留原字节和幂等键，拒绝同对象不同命令，重试不会重复创建', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(async (_url: string, init: RequestInit) => envelope(receipt('pending-teacher', init)))
    vi.stubGlobal('fetch', fetcher)
    const body = { recoveryGeneration: 'generation', content: { projectTitle: '中文\n原文' } }
    await expect(teacherCommand('pending-teacher', 'PATCH', '/blueprints/pending', body)).rejects.toThrow('offline')
    expect(pendingTeacherCommands('pending-teacher')).toHaveLength(1)
    expect(pendingTeacherCommands('another-account')).toHaveLength(0)
    await expect(teacherCommand('pending-teacher', 'PATCH', '/blueprints/pending', { ...body, changed: true })).rejects.toThrow('尚未核对')
    expect(fetcher).toHaveBeenCalledTimes(1)
    await retryTeacherCommands('pending-teacher')
    const first = fetcher.mock.calls[0]![1] as RequestInit
    const second = fetcher.mock.calls[1]![1] as RequestInit
    expect(first.body).toBe(JSON.stringify(body))
    expect(second.body).toBe(first.body)
    expect(second.headers).toEqual(first.headers)
    expect(first.headers).toMatchObject({ 'x-csrf-token': 'test-csrf' })
    expect(first.credentials).toBe('same-origin')
    expect(pendingTeacherCommands('pending-teacher')).toHaveLength(0)
  })

  it('明确拒绝后允许重读和新命令，非法成功回执保留原请求', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ requestId: 'conflict', error: {
      code: 'REVISION_CONFLICT', message: 'Changed', retryable: false, recovery: 'Read current',
    } }), { status: 409 })).mockImplementationOnce(async (_url: string, init: RequestInit) => envelope(receipt('cas-teacher', init))).mockResolvedValueOnce(envelope({ result: {} }))
    vi.stubGlobal('fetch', fetcher)
    await expect(teacherCommand('cas-teacher', 'POST', '/test/cas', { recoveryGeneration: 'generation', revision: 1 })).rejects.toThrow('409')
    expect(pendingTeacherCommands('cas-teacher')).toHaveLength(0)
    await expect(teacherCommand('cas-teacher', 'POST', '/test/cas', { recoveryGeneration: 'generation', revision: 2 })).resolves.toEqual({ accepted: true })
    expect((fetcher.mock.calls[0]![1] as RequestInit).headers).not.toEqual((fetcher.mock.calls[1]![1] as RequestInit).headers)
    await expect(teacherCommand('invalid-teacher', 'POST', '/test/invalid', { recoveryGeneration: 'generation' })).rejects.toThrow('回执不完整')
    expect(pendingTeacherCommands('invalid-teacher')).toHaveLength(1)
    // Settle this original command so the module-level safety copy does not cross test boundaries.
    fetcher.mockImplementationOnce(async (_url: string, init: RequestInit) => envelope(receipt('invalid-teacher', init)))
    await retryTeacherCommands('invalid-teacher')
  })

  it('只读取任教课程，实际名字缺失时保留ID，课程越界失败不填充演示', async () => {
    const workbench = { courseId: 'course/a', recoveryGeneration: 'g', members: [], resources: [], drafts: [], activities: [], assignments: [], attempts: [], presets: [] }
    const fetcher = vi.fn().mockResolvedValueOnce(envelope(workbench)).mockResolvedValueOnce(envelope({ ...workbench, courseId: 'foreign' }))
    vi.stubGlobal('fetch', fetcher)
    const result = await loadTeacherWorkbenchData({ ...session, courses: [...session.courses, { courseId: 'student-course', role: 'student' }] })
    expect(result.courses).toMatchObject([{ title: 'course/a', id: 'course/a' }])
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(fetcher.mock.calls[0]![0]).toBe('/api/courses/course%2Fa/teacher-workbench')
    await expect(loadTeacherWorkbenchData(session)).rejects.toThrow('课程不匹配')
  })
})
