import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MockLearningApi } from './mockAdapter'
import { buildTurnScript } from './turnScript'
import type { ChatMessage, TurnPhase } from './types'

/** 回合经过的阶段序列（连续同相折叠）。 */
function collectPhases(snaps: ChatMessage[]): (TurnPhase | undefined)[] {
  return snaps.map((s) => s.phase).filter((p, i, arr) => i === 0 || arr[i - 1] !== p)
}

const RESET_Q = '同步复位和异步复位有什么区别？'

describe('mock 回合剧本（docs/agent-page-design.md 状态机）', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  async function run(api: MockLearningApi, text: string, ms = 60_000) {
    const snaps: ChatMessage[] = []
    const done = api.sendMessageStream({ conversationId: null, text, onUpdate: (m) => snaps.push(m) })
    await vi.advanceTimersByTimeAsync(ms)
    return { snaps, result: await done }
  }

  it('完整回合：waiting → thinking → streaming → settled', async () => {
    const api = new MockLearningApi()
    const { snaps, result } = await run(api, RESET_Q)
    expect(collectPhases(snaps)).toEqual(['waiting', 'thinking', 'streaming', 'settled'])
    expect(result.final.phase).toBe('settled')
    expect(result.final.text).toContain('本地模拟回复')
    expect(result.final.thinking?.summary).toContain('时钟边沿')
    // 正文快照单调增长（逐字流出）
    const lens = snaps.map((s) => s.text.length)
    expect(lens.every((n, i) => i === 0 || lens[i - 1] <= n)).toBe(true)
    // 会话里沉淀一条 user + 一条 agent
    const conv = await api.getConversation(result.conversationId)
    expect(conv?.messages.map((m) => m.role)).toEqual(['user', 'agent'])
    expect(conv?.messages[1].phase).toBe('settled')
  })

  it('低档思考强度：没有思考区，waiting → streaming → settled', async () => {
    const api = new MockLearningApi()
    const { snaps, result } = await run(api, '你好')
    expect(collectPhases(snaps)).toEqual(['waiting', 'streaming', 'settled'])
    expect(result.final.thinking).toBeUndefined()
  })

  it('失败分型：触发词「断网」在等待期失败，带错误码', async () => {
    const api = new MockLearningApi()
    const { snaps, result } = await run(api, '模拟断网会怎样')
    expect(collectPhases(snaps)).toEqual(['waiting', 'failed'])
    expect(result.final.phase).toBe('failed')
    expect(result.final.failure).toEqual({ reason: 'network', code: 'ERR_NETWORK' })
    expect(result.final.text).toBe('')
    const conv = await api.getConversation(result.conversationId)
    expect(conv?.messages[1].phase).toBe('failed')
  })

  it('流式中途失败：正文保留半截，失败标记跟在后面，不落卡', async () => {
    const api = new MockLearningApi()
    const full = (await run(api, RESET_Q)).result.final.text
    const { snaps, result } = await run(api, '复位讲到一半中断了')
    expect(collectPhases(snaps)).toEqual(['waiting', 'thinking', 'streaming', 'failed'])
    expect(result.final.phase).toBe('failed')
    expect(result.final.failure).toEqual({ reason: 'network', code: 'ERR_NETWORK' })
    // 半截正文：约为全文的四成
    expect(result.final.text.length).toBeGreaterThan(full.length * 0.3)
    expect(result.final.text.length).toBeLessThan(full.length * 0.5)
    // 失败不挂追问 / 概念卡（与停止同规则）
    expect(result.final.followUps).toBeUndefined()
    expect(result.final.concept).toBeUndefined()
    const conv = await api.getConversation(result.conversationId)
    expect(conv?.messages[1].phase).toBe('failed')
  })

  it('停止保留半截，继续生成走到落定，消息原位更新', async () => {
    const api = new MockLearningApi()
    const done = api.sendMessageStream({ conversationId: null, text: RESET_Q, onUpdate: () => {} })
    await vi.advanceTimersByTimeAsync(3950) // 等待+思考结束，正文流出几个字
    api.stopTurn()
    const stoppedResult = await done
    expect(stoppedResult.final.phase).toBe('stopped')
    expect(stoppedResult.final.text.length).toBeGreaterThan(0)
    expect(stoppedResult.final.text.length).toBeLessThan(20)

    const done2 = api.resumeTurn({
      conversationId: stoppedResult.conversationId,
      onUpdate: () => {},
    })
    await vi.advanceTimersByTimeAsync(60_000)
    const resumed = await done2
    expect(resumed.final.phase).toBe('settled')
    expect(resumed.final.text).toContain('本地模拟回复')
    // 会话里仍是一条 user + 一条 agent，原位替换
    const conv = await api.getConversation(stoppedResult.conversationId)
    expect(conv?.messages.map((m) => m.role)).toEqual(['user', 'agent'])
    expect(conv?.messages[1].phase).toBe('settled')
    expect(conv?.messages[1].text).toBe(resumed.final.text)
  })

  it('等待期停止：没有已生成内容', async () => {
    const api = new MockLearningApi()
    const done = api.sendMessageStream({ conversationId: null, text: RESET_Q, onUpdate: () => {} })
    await vi.advanceTimersByTimeAsync(500)
    api.stopTurn()
    const result = await done
    expect(result.final.phase).toBe('stopped')
    expect(result.final.text).toBe('')
  })

  it('生成中重复发送被拒绝（排队在界面侧）', async () => {
    const api = new MockLearningApi()
    const done = api.sendMessageStream({ conversationId: null, text: RESET_Q, onUpdate: () => {} })
    await expect(
      api.sendMessageStream({ conversationId: null, text: '又一个问题', onUpdate: () => {} }),
    ).rejects.toThrow('排队')
    api.stopTurn()
    await done
  })

  it('没有已停止回合时不能继续', async () => {
    const api = new MockLearningApi()
    await expect(
      api.resumeTurn({ conversationId: 'seed-reset', onUpdate: () => {} }),
    ).rejects.toThrow('没有可继续的回合')
  })

  it('同一问题两次回合，快照序列一致（确定性可复跑）', async () => {
    const run1 = await run(new MockLearningApi(), RESET_Q)
    const run2 = await run(new MockLearningApi(), RESET_Q)
    expect(run2.snaps).toEqual(run1.snaps)
  })

  it('重试替换原消息：取最后一条学生消息，替换最后一条 agent 回复', async () => {
    const api = new MockLearningApi()
    const first = await run(api, RESET_Q)
    const cid = first.result.conversationId
    const snaps: ChatMessage[] = []
    const done = api.retryLast({ conversationId: cid, onUpdate: (m) => snaps.push(m) })
    await vi.advanceTimersByTimeAsync(60_000)
    const retried = await done
    expect(retried.final.phase).toBe('settled')
    expect(collectPhases(snaps)).toEqual(['waiting', 'thinking', 'streaming', 'settled'])
    const conv = await api.getConversation(cid)
    expect(conv?.messages.map((m) => m.role)).toEqual(['user', 'agent'])
    expect(conv?.messages[1].text).toBe(retried.final.text)
  })

  it('已停止回合被重试后不能再继续', async () => {
    const api = new MockLearningApi()
    const done = api.sendMessageStream({ conversationId: null, text: RESET_Q, onUpdate: () => {} })
    await vi.advanceTimersByTimeAsync(3950)
    api.stopTurn()
    const stopped = await done
    const retried = api.retryLast({ conversationId: stopped.conversationId, onUpdate: () => {} })
    await vi.advanceTimersByTimeAsync(60_000)
    await retried
    await expect(
      api.resumeTurn({ conversationId: stopped.conversationId, onUpdate: () => {} }),
    ).rejects.toThrow('没有可继续的回合')
  })

  it('任务卡在落定时才挂上', async () => {
    const api = new MockLearningApi()
    const { snaps, result } = await run(api, '我上次学到哪里了？')
    expect(result.final.taskId).toBe('counter')
    const mid = snaps.find((s) => s.phase === 'streaming')
    expect(mid?.taskId).toBeUndefined()
  })

  it('追问选项在落定时才挂上，2–4 个；停止的半截消息不带', async () => {
    const api = new MockLearningApi()
    const { snaps, result } = await run(api, RESET_Q)
    expect(result.final.followUps?.length).toBeGreaterThanOrEqual(2)
    expect(result.final.followUps?.length).toBeLessThanOrEqual(4)
    const mid = snaps.find((s) => s.phase === 'streaming')
    expect(mid?.followUps).toBeUndefined()

    const done = api.sendMessageStream({ conversationId: null, text: RESET_Q, onUpdate: () => {} })
    await vi.advanceTimersByTimeAsync(3950)
    api.stopTurn()
    const stopped = await done
    expect(stopped.final.phase).toBe('stopped')
    expect(stopped.final.followUps).toBeUndefined()
  })

  it('小测卡在落定时才挂上；作答写回结果、次数累计并留在历史里', async () => {
    const api = new MockLearningApi()
    const { snaps, result } = await run(api, '出一道题考考我')
    expect(result.final.quiz?.answer).toBe('C')
    const mid = snaps.find((s) => s.phase === 'streaming')
    expect(mid?.quiz).toBeUndefined()
    // 追问选项「再出一道题」同样触发小测
    expect((await run(api, '再出一道题')).result.final.quiz?.answer).toBe('C')

    // 停止的半截消息不带
    const done = api.sendMessageStream({
      conversationId: null,
      text: '出一道题考考我',
      onUpdate: () => {},
    })
    await vi.advanceTimersByTimeAsync(2500) // 思考期停止
    api.stopTurn()
    const stopped = await done
    expect(stopped.final.phase).toBe('stopped')
    expect(stopped.final.quiz).toBeUndefined()

    // 作答：先错后对，写回消息并累计次数
    const cid = result.conversationId
    const wrong = await api.submitQuizAnswer({ conversationId: cid, messageIndex: 1, selected: 'A' })
    expect(wrong.quiz.result).toEqual({ selected: 'A', correct: false, attempts: 1 })
    const right = await api.submitQuizAnswer({ conversationId: cid, messageIndex: 1, selected: 'C' })
    expect(right.quiz.result).toEqual({ selected: 'C', correct: true, attempts: 2 })
    const conv = await api.getConversation(cid)
    expect(conv?.messages[1].quiz?.result?.correct).toBe(true)
  })

  it('概念讲解卡在落定时才挂上；停止的半截消息不带', async () => {
    const api = new MockLearningApi()
    const { snaps, result } = await run(api, RESET_Q)
    expect(result.final.concept?.title).toContain('复位')
    expect(result.final.concept?.wave?.rows).toHaveLength(4)
    const mid = snaps.find((s) => s.phase === 'streaming')
    expect(mid?.concept).toBeUndefined()

    const done = api.sendMessageStream({ conversationId: null, text: RESET_Q, onUpdate: () => {} })
    await vi.advanceTimersByTimeAsync(3950)
    api.stopTurn()
    const stopped = await done
    expect(stopped.final.phase).toBe('stopped')
    expect(stopped.final.concept).toBeUndefined()
  })

  it('「毛刺」完整回合：步骤块逐步流出，生成卡只在落定时挂载（第 19、20 条）', async () => {
    const api = new MockLearningApi()
    const { snaps, result } = await run(api, '异步复位为什么对毛刺敏感？')
    expect(collectPhases(snaps)).toEqual(['waiting', 'thinking', 'streaming', 'settled'])
    expect(result.final.steps).toHaveLength(3)
    // 步骤逐步流出：流式途中出现过「只有部分步骤」的快照
    const streamSnaps = snaps.filter((s) => s.phase === 'streaming')
    expect(streamSnaps.some((s) => (s.steps?.length ?? 0) < 3)).toBe(true)
    expect(streamSnaps.every((s, i) => (s.steps?.length ?? 0) <= (streamSnaps[i + 1]?.steps?.length ?? 3))).toBe(true)
    // 生成卡与追问选项同一规则：落定才挂载
    expect(streamSnaps.every((s) => s.genCard === undefined)).toBe(true)
    const card = result.final.genCard
    expect(card?.cardId).toBe('glitch')
    expect(card?.title).toContain('毛刺')
    expect(card?.taskId).toBe('counter')
    expect(card?.claimSim).toBe(false)
    expect(card?.version).toBe(1)
    expect(card?.srcdoc).toContain('<!DOCTYPE html>')
    expect(card?.collected).toBeUndefined()
  })

  it('「仿真对比」卡声称仿真结果：claimSim 标角标（第 19 条标注规则）', async () => {
    const api = new MockLearningApi()
    const { result } = await run(api, '仿真对比一下消抖前后')
    expect(result.final.genCard?.cardId).toBe('sim-compare')
    expect(result.final.genCard?.claimSim).toBe(true)
    // 演示默认不标：毛刺卡不声称仿真结果
    expect((await run(api, '毛刺是怎么产生的？')).result.final.genCard?.claimSim).toBe(false)
  })

  it('「卡失败」：生成失败场景带错误码；重试清掉失败并回退可用版本（失败三型之一）', async () => {
    const api = new MockLearningApi()
    const { result } = await run(api, '生成一张卡失败的交互卡')
    const card = result.final.genCard
    expect(card?.genFailure?.code).toBe('GEN_RENDER_502')
    expect(card?.fallbackSrcdoc).toContain('<!DOCTYPE html>')

    const retried = await api.retryGenCard({ conversationId: result.conversationId, messageIndex: 1 })
    expect(retried.card.genFailure).toBeUndefined()
    expect(retried.card.version).toBe(1)
    expect(retried.card.srcdoc).toBe(card?.fallbackSrcdoc)
    const conv = await api.getConversation(result.conversationId)
    expect(conv?.messages[1].genCard?.genFailure).toBeUndefined()
  })

  it('协议超时场景：特殊卡 id 的 srcdoc 不回 ready，带可用回退版本', async () => {
    const api = new MockLearningApi()
    const { result } = await run(api, '来一张不响应的卡')
    const card = result.final.genCard
    expect(card?.cardId).toBe('gen-never')
    // neverReady 演示：吞掉 ready 应答的启动脚本被注入 srcdoc
    expect(card?.srcdoc).toContain('window.__gen.ready = function () {};')
    expect(card?.fallbackSrcdoc).toBeDefined()
    expect(card?.fallbackSrcdoc).not.toContain('window.__gen.ready = function () {};')
    // 归属不清不禁止生成：taskId 为空，收纳时由学生从任务选择器指派
    expect(card?.taskId).toBeNull()
  })

  it('收纳：collectGenCard 写任务卡片收纳存储、回写消息 collected 并保留快照', async () => {
    const api = new MockLearningApi()
    const { result } = await run(api, '毛刺是怎么产生的？')
    const cid = result.conversationId
    const snap = { count: 7, deb: 3, clean: false, presses: 5, wave: [1, 0, 1], bouncing: false, ver: 1 }
    const { card } = await api.collectGenCard({ conversationId: cid, messageIndex: 1, taskId: 'counter', snapshot: snap })
    expect(card.collected?.taskId).toBe('counter')

    const stored = await api.listGenCards({ taskId: 'counter' })
    expect(stored).toHaveLength(1)
    expect(stored[0].cardId).toBe('glitch')
    expect(stored[0].snapshot).toEqual(snap)
    expect(stored[0].collectedAt).toBeTruthy()
    const conv = await api.getConversation(cid)
    expect(conv?.messages[1].genCard?.collected?.taskId).toBe('counter')

    // 状态续写：putGenCard 按 cardId 合并封面快照
    await api.putGenCard({ taskId: 'counter', card: { ...stored[0], snapshot: { ...snap, count: 8 } } })
    expect((await api.listGenCards({ taskId: 'counter' }))[0].snapshot).toMatchObject({ count: 8 })
  })

  it('工作区会话按任务持久化：写入后可按任务取回（双会话分离，不进全局历史）', async () => {
    const api = new MockLearningApi()
    await api.persistWorkspaceMessages({
      taskId: 'counter',
      messages: [
        { role: 'agent', text: '开场', genCard: undefined },
        { role: 'user', text: '毛刺是怎么回事？' },
      ],
    })
    const msgs = await api.getWorkspaceMessages({ taskId: 'counter' })
    expect(msgs.map((m) => m.role)).toEqual(['agent', 'user'])
    // 覆盖写：同一任务重写后只保留新内容
    await api.persistWorkspaceMessages({ taskId: 'counter', messages: [{ role: 'agent', text: '覆盖后' }] })
    expect(await api.getWorkspaceMessages({ taskId: 'counter' })).toHaveLength(1)
    // 其他任务互不可见
    expect(await api.getWorkspaceMessages({ taskId: 'library' })).toHaveLength(0)
  })

  it('剧本生成是纯函数', () => {
    const reply: ChatMessage = { role: 'agent', text: '测试。' }
    expect(buildTurnScript('复位', reply)).toEqual(buildTurnScript('复位', reply))
  })
})
