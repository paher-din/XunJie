import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  session: { epoch: 0, status: 'authenticated', session: { userId: 'alice' } },
  get: vi.fn(), post: vi.fn(),
}))
vi.mock('../workspace/mode', () => ({ PREP_BUILD: false }))
vi.mock('../workspace/http', () => ({ apiGet: fixture.get, apiPost: fixture.post }))
vi.mock('../workspace/session', () => ({ getSessionState: () => fixture.session }))
vi.mock('../lib/modelSettings', () => ({ getModelSettings: () => ({
  loading: false, saving: false, data: { enabled: true, callsEnabled: true, defaultModelId: 'custom:p:m' },
}), reloadOnModelConfigConflict: async () => false }))
import { learningApi } from './agentApi'

const view = (id: string, phase: string) => ({ conversationId: `conversation-${id}`, turnId: id,
  message: { role: 'agent', text: `正文-${id}`, phase } })
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
beforeEach(() => {
  fixture.session = { epoch: 0, status: 'authenticated', session: { userId: 'alice' } }
  fixture.get.mockReset(); fixture.post.mockReset()
})
afterEach(() => { fixture.session.epoch++ })

describe('personal agent client boundaries', () => {
  it('keeps a verified single-task card in live and historical messages and rejects non-settled cards', async () => {
    const taskCard = { assignmentId: 'assignment-a', courseName: '数字逻辑', title: '同步计数器', availability: 'active' }
    fixture.post.mockResolvedValueOnce({ ...view('card', 'settled'), message: { role: 'agent', text: '同步计数器可先画状态图。', phase: 'settled', taskCard } })
    const update = vi.fn()
    const result = await learningApi.sendMessageStream({ conversationId: null, text: '同步计数器怎么做？', onUpdate: update })
    expect(result.final.taskCard).toEqual(taskCard)
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ taskCard }))
    fixture.get.mockResolvedValueOnce({ id: result.conversationId, title: '任务', updatedAt: '2026-10-15T00:00:00Z',
      messages: [{ role: 'user', text: '同步计数器怎么做？' }, { role: 'agent', text: '同步计数器可先画状态图。', phase: 'settled', taskCard }] })
    expect((await learningApi.getConversation(result.conversationId))?.messages[1].taskCard).toEqual(taskCard)
    fixture.get.mockResolvedValueOnce({ id: 'bad', title: '任务', updatedAt: '2026-10-15T00:00:00Z',
      messages: [{ role: 'agent', text: '处理中', phase: 'streaming', taskCard }] })
    await expect(learningApi.getConversation('bad')).rejects.toThrow('任务卡响应无效')
  })
  it('keeps recovery scoped to the original conversation after visiting another chat', async () => {
    fixture.post.mockResolvedValueOnce(view('interrupted','streaming')).mockResolvedValueOnce(view('other','settled'))
    fixture.get.mockRejectedValueOnce(new Error('connection lost')).mockResolvedValueOnce(view('interrupted','settled'))
    await expect(learningApi.sendMessageStream({conversationId:'conversation-interrupted',text:'original',onUpdate:vi.fn()})).rejects.toThrow('连接中断')
    await expect(learningApi.sendMessageStream({conversationId:'conversation-other',text:'other',onUpdate:vi.fn()})).resolves.toHaveProperty('conversationId','conversation-other')
    await expect(learningApi.recoverTurn!({conversationId:'conversation-interrupted',onUpdate:vi.fn()})).resolves.toHaveProperty('conversationId','conversation-interrupted')
    expect(fixture.post).toHaveBeenCalledTimes(2)
    await expect(learningApi.recoverTurn!({conversationId:'missing',onUpdate:vi.fn()})).rejects.toThrow('原回合未找到')
  })
  it('lost acceptance ACK retries the original key instead of generating another turn', async () => {
    fixture.post.mockRejectedValueOnce(new Error('lost ACK')).mockResolvedValueOnce(view('lost', 'settled'))
    await expect(learningApi.sendMessageStream({ conversationId: null, text: 'original', onUpdate: vi.fn() })).rejects.toThrow()
    const original = fixture.post.mock.calls[0][1]
    expect(learningApi.recoverTurn).toBeTypeOf('function')
    await learningApi.recoverTurn!({ conversationId: null, onUpdate: vi.fn() })
    expect(fixture.post.mock.calls[1][1]).toEqual(original)
  })

  it('restores an in-progress turn by GET and retains its original stop target', async () => {
    const end=deferred<ReturnType<typeof view>>()
    fixture.get.mockResolvedValueOnce(view('restored','streaming')).mockReturnValueOnce(end.promise)
    fixture.post.mockResolvedValue(view('restored','stopped'))
    expect(learningApi.recoverTurn).toBeTypeOf('function')
    const update=vi.fn()
    const result=learningApi.recoverTurn!({conversationId:'conversation-restored',turnId:'restored',onUpdate:update})
    await vi.waitFor(()=>expect(update).toHaveBeenCalledTimes(1))
    learningApi.stopTurn()
    expect(fixture.post).toHaveBeenCalledWith('/agent/turns/restored/stop',{},expect.anything())
    end.resolve(view('restored','stopped'));await result
    expect(fixture.post.mock.calls.every(c=>c[0].endsWith('/stop'))).toBe(true)
  })
  it('preserves unknown usage instead of projecting zero; retains actual numeric usage', async () => {
    const conversation = { id: 'c', title: '问题', updatedAt: '2026-10-15T00:00:00Z', messages: [{ role: 'agent', text: '回答' }] }
    fixture.get.mockResolvedValueOnce(conversation).mockResolvedValueOnce({ ...conversation, contextTokens: 0 })
    expect(await learningApi.getConversation('c')).not.toHaveProperty('contextTokens')
    expect(await learningApi.getConversation('c')).toHaveProperty('contextTokens', 0)
  })

  it('rejects a second same-session turn without replacing the original stop target', async () => {
    const end = deferred<ReturnType<typeof view>>()
    fixture.post.mockResolvedValue(view('first', 'streaming'))
    fixture.get.mockReturnValue(end.promise)
    const updates = vi.fn()
    const first = learningApi.sendMessageStream({ conversationId: null, text: '原问题', onUpdate: updates })
    await vi.waitFor(() => expect(updates).toHaveBeenCalledTimes(1))
    await expect(learningApi.sendMessageStream({ conversationId: null, text: '另一个问题', onUpdate: vi.fn() })).rejects.toThrow('已有回复正在生成')
    expect(fixture.post).toHaveBeenCalledTimes(1)
    learningApi.stopTurn()
    expect(fixture.post).toHaveBeenLastCalledWith('/agent/turns/first/stop', {}, expect.anything())
    end.resolve(view('first', 'stopped'))
    await expect(first).resolves.toHaveProperty('final.phase', 'stopped')
  })

  it('isolates an old account turn and keeps the new account stop target', async () => {
    const oldEnd = deferred<ReturnType<typeof view>>(), newEnd = deferred<ReturnType<typeof view>>()
    fixture.post.mockResolvedValueOnce(view('alice-turn', 'streaming')).mockResolvedValueOnce(view('bob-turn', 'streaming')).mockResolvedValue(view('bob-turn', 'stopped'))
    fixture.get.mockImplementation((path: string) => path.includes('alice-turn') ? oldEnd.promise : newEnd.promise)
    const oldUpdate = vi.fn(), newUpdate = vi.fn()
    const oldTurn = learningApi.sendMessageStream({ conversationId: null, text: 'Alice 问题', onUpdate: oldUpdate }).catch(error => error as Error)
    await vi.waitFor(() => expect(oldUpdate).toHaveBeenCalledTimes(1))
    fixture.session = { epoch: 1, status: 'authenticated', session: { userId: 'bob' } }
    const newTurn = learningApi.sendMessageStream({ conversationId: null, text: 'Bob 问题', onUpdate: newUpdate })
    await vi.waitFor(() => expect(newUpdate).toHaveBeenCalledTimes(1))
    oldEnd.resolve(view('alice-turn', 'settled'))
    expect(await oldTurn).toBeInstanceOf(Error)
    learningApi.stopTurn()
    expect(fixture.post).toHaveBeenLastCalledWith('/agent/turns/bob-turn/stop', {}, expect.anything())
    newEnd.resolve(view('bob-turn', 'stopped'))
    await expect(newTurn).resolves.toHaveProperty('final.phase', 'stopped')
    expect(oldUpdate).toHaveBeenCalledTimes(1)
  })
})
