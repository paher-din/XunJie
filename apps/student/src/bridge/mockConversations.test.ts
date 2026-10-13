import { describe, expect, it } from 'vitest'
import { MockLearningApi } from './mockAdapter'

/** 会话管理契约（docs/agent-page-design.md 推进顺序第 5 步，2026-10-10 确认）。 */
describe('会话历史管理', () => {
  it('摘要列表按最近更新排序，新的在前；默认列表不含归档，includeArchived 才带上', async () => {
    const api = new MockLearningApi()
    const list = await api.listConversations({ includeArchived: true })
    expect(list.length).toBeGreaterThanOrEqual(12)
    const times = list.map((s) => new Date(s.updatedAt).getTime())
    expect(times.every((t, i) => i === 0 || times[i - 1] >= t)).toBe(true)

    // 归档会话只在 includeArchived 下出现：默认列表 = 全量 - 归档（2026-10-11 归档箱定稿）
    const archived = list.filter((s) => s.archived)
    expect(archived.length).toBeGreaterThan(0)
    const def = await api.listConversations()
    expect(def.every((s) => !s.archived)).toBe(true)
    expect(def.length).toBe(list.length - archived.length)
  })

  it('重命名：trim 后写回标题；空标题忽略', async () => {
    const api = new MockLearningApi()
    await api.renameConversation({ conversationId: 'seed-reset', title: '  复位问题整理  ' })
    let list = await api.listConversations()
    expect(list.find((s) => s.id === 'seed-reset')?.title).toBe('复位问题整理')

    await api.renameConversation({ conversationId: 'seed-reset', title: '   ' })
    list = await api.listConversations()
    expect(list.find((s) => s.id === 'seed-reset')?.title).toBe('复位问题整理')
  })

  it('删除：从列表消失；删除不存在的会话不报错', async () => {
    const api = new MockLearningApi()
    await api.deleteConversation({ conversationId: 'seed-quiz' })
    const list = await api.listConversations()
    expect(list.some((s) => s.id === 'seed-quiz')).toBe(false)
    await expect(api.deleteConversation({ conversationId: 'seed-quiz' })).resolves.toBeUndefined()
  })

  it('置顶：摘要带 pinned 标记，取消置顶后回落；置顶不改变列表排序', async () => {
    const api = new MockLearningApi()
    let list = await api.listConversations()
    expect(list.find((s) => s.id === 'seed-resume')?.pinned).toBe(true)
    expect(list.find((s) => s.id === 'seed-quiz')?.pinned).toBe(false)

    await api.pinConversation({ conversationId: 'seed-quiz', pinned: true })
    list = await api.listConversations()
    expect(list.find((s) => s.id === 'seed-quiz')?.pinned).toBe(true)
    const times = list.map((s) => new Date(s.updatedAt).getTime())
    expect(times.every((t, i) => i === 0 || times[i - 1] >= t)).toBe(true)

    await api.pinConversation({ conversationId: 'seed-quiz', pinned: false })
    list = await api.listConversations()
    expect(list.find((s) => s.id === 'seed-quiz')?.pinned).toBe(false)

    // 不存在的会话忽略，不报错
    await expect(
      api.pinConversation({ conversationId: 'not-there', pinned: true }),
    ).resolves.toBeUndefined()
  })

  it('归档：离开主列表但内容保留、仍可取回；恢复后回到主列表', async () => {
    const api = new MockLearningApi()
    await api.archiveConversation({ conversationId: 'seed-progress' })
    const list = await api.listConversations()
    expect(list.some((s) => s.id === 'seed-progress')).toBe(false)
    const withArchived = await api.listConversations({ includeArchived: true })
    expect(withArchived.find((s) => s.id === 'seed-progress')?.archived).toBe(true)
    expect(await api.getConversation('seed-progress')).not.toBeNull()

    await expect(
      api.archiveConversation({ conversationId: 'seed-progress' }),
    ).resolves.toBeUndefined()
    await expect(
      api.archiveConversation({ conversationId: 'not-there' }),
    ).resolves.toBeUndefined()

    // 恢复：标记清掉、回到主列表；重复恢复与不存在都不报错，种子里的归档项不受影响
    await api.restoreConversation({ conversationId: 'seed-progress' })
    const back = await api.listConversations()
    expect(back.find((s) => s.id === 'seed-progress')?.archived).toBe(false)
    await expect(
      api.restoreConversation({ conversationId: 'seed-progress' }),
    ).resolves.toBeUndefined()
    await expect(
      api.restoreConversation({ conversationId: 'not-there' }),
    ).resolves.toBeUndefined()
    expect(
      (await api.listConversations({ includeArchived: true })).find(
        (s) => s.id === 'seed-comb-logic',
      )?.archived,
    ).toBe(true)
  })

  it('新会话标题为首句截断 24 字', async () => {
    const api = new MockLearningApi()
    const long = '同步复位和异步复位在时序逻辑设计里到底有什么本质区别？请展开讲讲'
    const { conversationId } = await api.sendMessage({ conversationId: null, text: long })
    const list = await api.listConversations()
    expect(list.find((s) => s.id === conversationId)?.title).toBe(long.slice(0, 24))
  })

  it('空状态推荐问题：2–4 条非空文案', async () => {
    const api = new MockLearningApi()
    const sugs = await api.suggestQuestions()
    expect(sugs.length).toBeGreaterThanOrEqual(2)
    expect(sugs.length).toBeLessThanOrEqual(4)
    expect(sugs.every((s) => s.trim().length > 0)).toBe(true)
  })
})
