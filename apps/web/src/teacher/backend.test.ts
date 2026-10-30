import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadTeacherWorkbenchData, pendingTeacherCommands, retryTeacherCommands, teacherCommand } from './backend'
import { setCsrfToken } from '../workspace/http'
import { clearExecutionNodes, loadExecutionNodes, selectExecutionNode } from '../workspace/executionNodes'

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
  clearExecutionNodes()
})
afterEach(() => { vi.unstubAllGlobals(); setCsrfToken(null) })

describe('教师真实命令和课程读取', () => {
  it('design checks require an explicit node and a lost ACK retry retains the original node, body and key', async () => {
    let first = true
    const fetcher = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/execution-nodes')) return envelope({ nodes: [
        { nodeId: 'robert', label: 'Robert 的电脑', cReady: true, hdlReady: true },
        { nodeId: 'member', label: '成员的电脑', cReady: true, hdlReady: true },
      ] })
      if (first) { first = false; throw new Error('lost check ACK') }
      return envelope(receipt('node-teacher', init))
    })
    vi.stubGlobal('fetch', fetcher)
    await loadExecutionNodes('node-teacher')
    const body = { recoveryGeneration: 'generation', expectedRevision: 1, concerns: [] }
    await expect(teacherCommand('node-teacher', 'POST', '/blueprints/draft/checks', body)).rejects.toThrow('选择自己的执行电脑')
    expect(fetcher).toHaveBeenCalledTimes(1)
    selectExecutionNode('robert')
    await expect(teacherCommand('node-teacher', 'POST', '/blueprints/draft/checks', body)).rejects.toThrow('lost check ACK')
    selectExecutionNode('member')
    await retryTeacherCommands('node-teacher')
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').map(([, init]) => init)
    expect(posts).toHaveLength(2)
    expect(posts[0]!.headers).toMatchObject({ 'x-xunjie-execution-node': 'robert', 'x-csrf-token': 'test-csrf' })
    expect(posts[1]!.headers).toEqual(posts[0]!.headers)
    expect(posts[1]!.body).toBe(posts[0]!.body)
    expect(JSON.parse(posts[0]!.body as string)).not.toHaveProperty('executionNodeId')
  })
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
