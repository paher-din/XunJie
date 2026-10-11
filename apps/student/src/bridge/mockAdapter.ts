import type { LearningApi } from './learningApi'
import type { ChatMessage, Conversation, GenCard, HomeSnapshot, QuizCard, StoredGenCard } from './types'
import { demoDashboard, demoMetrics, demoTasks } from './mockData'
import { buildTurnScript } from './turnScript'
import { TurnPlayer } from './turnPlayer'
import { glitch, simCompare } from './genCardDemos'

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** 本地模拟回复：按问题关键词给出预设内容；涉及具体任务时携带任务卡（taskId）。 */
function mockReply(question: string): ChatMessage {
  // 「毛刺」在「复位」之前匹配：复位的追问「异步复位为什么对毛刺敏感？」应落到交互卡。
  if (/毛刺/.test(question)) {
    return {
      role: 'agent',
      text: '好问题。**毛刺**是机械按键在接触瞬间的快速弹跳——你的设计把每一次弹跳都当成了有效按下。\n\n我分三步把它讲清楚，然后给你一张可以反复按的交互卡。\n\n这是本地模拟回复。',
      steps: [
        '先看原始信号：一次按下被采成几次跳变',
        '再对比消抖：信号稳定后才认定一次按下',
        '最后打开交互卡，自己按几次验证',
      ],
      genCard: {
        cardId: 'glitch',
        title: '毛刺是什么？按键消抖对比',
        taskId: 'counter',
        claimSim: false,
        srcdoc: glitch({ version: 1 }),
        version: 1,
      },
      followUps: ['仿真对比一下消抖前后', '为什么消抖要等信号稳定？', '把这个交互收纳到任务里'],
    }
  }
  if (/消抖仿真|仿真对比/.test(question)) {
    return {
      role: 'agent',
      text: '按固定激励跑一遍对比：同一次 180ms 机械抖动，未消抖的计数会跳多次，消抖后只认定一次。\n\n这是确定性演示结果，卡上标了「仿真结果」。\n\n这是本地模拟回复。',
      genCard: {
        cardId: 'sim-compare',
        title: '消抖前后对比',
        taskId: 'counter',
        claimSim: true,
        srcdoc: simCompare(),
        version: 1,
      },
      followUps: ['毛刺到底是怎么产生的？', '把这个交互收纳到任务里'],
    }
  }
  if (/卡失败/.test(question)) {
    return {
      role: 'agent',
      text: '我试着为「毛刺」生成一张交互卡，但这次生成没有成功。\n\n可以重试，也可以先点「知道了」收起。\n\n这是本地模拟回复。',
      genCard: {
        cardId: 'glitch',
        title: '毛刺是什么？按键消抖对比',
        taskId: 'counter',
        claimSim: false,
        srcdoc: glitch({ version: 1 }),
        fallbackSrcdoc: glitch({ version: 1 }),
        version: 2,
        genFailure: { code: 'GEN_RENDER_502' },
      },
      followUps: ['毛刺到底是怎么产生的？'],
    }
  }
  if (/不响应|超时/.test(question)) {
    // 协议超时演示：srcdoc 故意不回 ready（特殊卡 id），3 秒判死后卡上「重试」改载正常版本。
    // 归属置空：这张卡同时演示无归属收纳（收纳时弹任务选择器）。
    return {
      role: 'agent',
      text: '这张卡的沙箱故意不回就绪信号：发出 init 3 秒后会判定「这个交互没有响应」。\n\n点卡上的「重试」会改载正常版本。\n\n这是本地模拟回复。',
      genCard: {
        cardId: 'gen-never',
        title: '毛刺是什么？（无响应演示）',
        taskId: null,
        claimSim: false,
        srcdoc: glitch({ version: 1, neverReady: true }),
        fallbackSrcdoc: glitch({ version: 1 }),
        version: 1,
      },
      followUps: ['毛刺到底是怎么产生的？'],
    }
  }
  if (/复位/.test(question)) {
    return {
      role: 'agent',
      text: '**复位**的作用，是让电路回到一个确定的初始状态。\n\n两种做法的差别，在于复位信号要不要等时钟的有效边沿：**同步复位**要等下一个上升沿，**异步复位**则立即生效。\n\n写进代码里，差别就在敏感列表：\n\n```verilog\n// 异步复位：rst_n 一拉低，q 立刻归零\nalways_ff @(posedge clk or negedge rst_n) begin\n  if (!rst_n) q <= \'0;\n  else        q <= d;\nend\n```\n\n代价是异步复位对**毛刺**更敏感，释放时刻还要额外处理。板级复位常用「异步置位、同步释放」的组合。\n\n这是本地模拟回复，用于体验对话流程。',
      concept: {
        title: '同步复位 vs 异步复位',
        afterPara: 2,
        points: [
          '判别标准：复位信号要不要等时钟的有效边沿。',
          '同步复位：信号有效后，等到下一个上升沿才归零。',
          '异步复位：信号一有效，输出立刻归零。',
        ],
        note: '读图：rst_n 在两个上升沿之间拉低——异步输出立刻掉，同步输出拖到下一个上升沿才掉。',
        wave: {
          rows: [
            { name: 'CLK', clk: true },
            { name: 'rst_n', segs: [[140, 0], [244, 1]] },
            { name: 'q（异步）', segs: [[140, 0], [244, 1]] },
            { name: 'q（同步）', segs: [[156, 0], [252, 1]] },
          ],
          highlight: [140, 156],
          markers: [140, 156],
          labels: [
            { x: 140, text: '立即' },
            { x: 156, dx: 36, text: '等上升沿' },
          ],
        },
      },
      followUps: ['异步复位为什么对毛刺敏感？', '「异步置位、同步释放」怎么写代码？', '出一道题考考我'],
    }
  }
  if (/考考我|出一道|出题/.test(question)) {
    return {
      role: 'agent',
      text: '好，结合刚才讲的**复位**，考你一道。\n\n这是本地模拟回复。',
      quiz: resetQuiz(),
      followUps: ['这题考的是什么概念？', '再出一道题', '回到复位的讲解'],
    }
  }
  if (/进度|这周|时长|学习情况/.test(question)) {
    return {
      role: 'agent',
      text: '从当前的学习记录来看，你本周学习了 **6.4 小时**，完成了 **2 个任务**。\n\n| 状态 | 任务数 |\n| --- | --- |\n| 已完成 | 3 |\n| 进行中 | 3 |\n| 未开始 | 2 |\n\n数字计数器已完成 3 / 5 个阶段，可以从`按键消抖验证`继续。\n\n以上均为模拟记录，不代表真实学习情况。',
      taskId: 'counter',
      followUps: ['哪个任务最紧急？', '计数器还剩哪些阶段？', '这周哪天学得最多？'],
    }
  }
  if (/任务|哪里|上次/.test(question)) {
    return {
      role: 'agent',
      text: '你上次在「可交互数字计数器」中完成了**复位逻辑**，接下来可以验证`按键消抖`。\n\n这个任务的目标是让按键输入、计数逻辑与七段数码管协同工作。点击下面的任务卡即可回到对应入口。\n\n这是本地模拟回复。',
      taskId: 'counter',
      followUps: ['按键消抖要验证什么？', '这个任务什么时候截止？', '出一道题考考我'],
    }
  }
  return {
    role: 'agent',
    text: '已收到你的问题：「' + question + '」。\n\n正式版本将在这里回答知识、任务与学习情况问题。当前为本地模拟回复，未连接真实 Agent。',
    followUps: ['解释一下同步复位', '我上次学到哪里了？', '这周的学习进度如何？'],
  }
}

/** 复位概念小测题：呼应追问选项「出一道题考考我」。 */
function resetQuiz(): QuizCard {
  return {
    topic: '复位概念',
    title: '复位概念 · 单选',
    stem: '带异步复位的触发器，rst_n 拉低后，输出 q 会怎样变化？',
    options: [
      { key: 'A', text: '保持原值，直到下一个时钟上升沿' },
      { key: 'B', text: '等到下一个时钟上升沿才清零' },
      { key: 'C', text: '立即清零，不等待时钟边沿' },
      { key: 'D', text: '在 rst_n 释放的瞬间清零' },
    ],
    answer: 'C',
    explain:
      '异步复位的判别标准：不等待时钟有效边沿。rst_n 一有效，q 立刻归零；要等边沿的是同步复位。',
  }
}

/** 演示种子会话：让历史时间流与任务卡在首次打开时可见。时间为相对当下的偏移。 */
function seedConversations(): Conversation[] {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString()
  const daysAgo = (d: number) => hoursAgo(d * 24)
  return [
    {
      id: 'seed-progress',
      title: '这周的学习进度如何？',
      updatedAt: hoursAgo(3),
      contextTokens: 214_000, // 21.4 万 / 30 万，对齐上下文容量卡演示值
      messages: [
        { role: 'user', text: '这周的学习进度如何？' },
        mockReply('这周的学习进度如何？'),
      ],
    },
    {
      id: 'seed-reset',
      title: '同步复位和异步复位有什么区别',
      updatedAt: daysAgo(1),
      contextTokens: 96_000,
      messages: [
        { role: 'user', text: '同步复位和异步复位有什么区别？' },
        mockReply('复位'),
      ],
    },
    {
      id: 'seed-quiz',
      title: '出一道题考考我',
      updatedAt: daysAgo(2),
      contextTokens: 58_000,
      messages: [
        { role: 'user', text: '出一道题考考我' },
        {
          ...mockReply('出一道题考考我'),
          // 已答过的历史小测：答对，第二次作答
          quiz: { ...resetQuiz(), result: { selected: 'C', correct: true, attempts: 2 } },
        },
      ],
    },
    {
      id: 'seed-resume',
      title: '我上次学到哪里了？',
      updatedAt: daysAgo(4),
      contextTokens: 41_500,
      pinned: true,
      messages: [
        { role: 'user', text: '我上次学到哪里了？' },
        mockReply('我上次学到哪里了？'),
      ],
    },
    // 补足历史长度：让侧栏滚动自动加载与三个时间分组在演示里可见
    {
      id: 'seed-sync-explain',
      title: '解释一下同步复位',
      updatedAt: hoursAgo(6),
      contextTokens: 52_000,
      messages: [
        { role: 'user', text: '解释一下同步复位' },
        mockReply('复位'),
      ],
    },
    {
      id: 'seed-debounce',
      title: '按键消抖为什么要两级触发器？',
      updatedAt: daysAgo(1.5),
      contextTokens: 33_000,
      messages: [
        { role: 'user', text: '按键消抖为什么要两级触发器？' },
        mockReply('按键消抖为什么要两级触发器？'),
      ],
    },
    {
      id: 'seed-seven-seg',
      title: '七段数码管显示乱码怎么排查',
      updatedAt: daysAgo(3),
      contextTokens: 47_000,
      messages: [
        { role: 'user', text: '七段数码管显示乱码怎么排查' },
        mockReply('七段数码管显示乱码怎么排查'),
      ],
    },
    {
      id: 'seed-fsm',
      title: '有限状态机怎么划分状态？',
      updatedAt: daysAgo(5),
      contextTokens: 29_000,
      messages: [
        { role: 'user', text: '有限状态机怎么划分状态？' },
        mockReply('有限状态机怎么划分状态？'),
      ],
    },
    {
      id: 'seed-blocking',
      title: '阻塞赋值和非阻塞赋值的区别',
      updatedAt: daysAgo(6),
      contextTokens: 38_000,
      messages: [
        { role: 'user', text: '阻塞赋值和非阻塞赋值的区别' },
        mockReply('阻塞赋值和非阻塞赋值的区别'),
      ],
    },
    {
      id: 'seed-x-value',
      title: '仿真波形里 q 一直是 x',
      updatedAt: daysAgo(9),
      contextTokens: 26_000,
      messages: [
        { role: 'user', text: '仿真波形里 q 一直是 x' },
        mockReply('仿真波形里 q 一直是 x'),
      ],
    },
    {
      id: 'seed-comb-logic',
      title: '组合逻辑和时序逻辑的区别',
      updatedAt: daysAgo(13),
      contextTokens: 22_000,
      // 演示用归档：进归档箱，也用来验证搜索命中归档行（标灰 + 恢复）
      archived: true,
      messages: [
        { role: 'user', text: '组合逻辑和时序逻辑的区别' },
        mockReply('组合逻辑和时序逻辑的区别'),
      ],
    },
    {
      id: 'seed-testbench',
      title: '怎么写第一个 testbench',
      updatedAt: daysAgo(21),
      contextTokens: 18_000,
      // 演示用置顶：这条本来落在滚动分页之外，置顶后仍常驻列表顶部
      pinned: true,
      messages: [
        { role: 'user', text: '怎么写第一个 testbench' },
        mockReply('怎么写第一个 testbench'),
      ],
    },
    // 第二条演示归档：与 seed-comb-logic 凑出归档箱「已归档 · 2」，并撑住搜索命中的归档分栏
    {
      id: 'seed-archived-pipeline',
      title: '流水线要不要给每级都打拍',
      updatedAt: daysAgo(8),
      contextTokens: 24_000,
      archived: true,
      messages: [
        { role: 'user', text: '流水线要不要给每级都打拍' },
        mockReply('流水线要不要给每级都打拍'),
      ],
    },
  ]
}

/**
 * Mock 适配器：进程内内存态，刷新即清空。
 *
 * sendMessage 同步返回预设内容，供未迁移的页面使用；sendMessageStream 按
 * turnScript.ts 的确定性剧本演完整条回合（等待 → 思考 → 逐字流出 → 落定 /
 * 停止 / 失败）。接真实 Agent 时这里替换为运行管理器通道，界面不需要改动
 * （见 learningApi.ts 的契约注释）。
 */
export class MockLearningApi implements LearningApi {
  private conversations = new Map<string, Conversation>()
  private seq = 0
  private activeTurn: { conversationId: string; player: TurnPlayer } | null = null
  private stoppedTurn: {
    conversationId: string
    player: TurnPlayer
    question: string
    messageIndex: number
  } | null = null
  /** 工作区引导会话（按任务）：localStorage ws-conv:<taskId> 的内存缓存。 */
  private wsConversations = new Map<string, ChatMessage[]>()
  /** 任务的生成卡收纳存储：localStorage ws-gencards:<taskId> 的内存缓存。 */
  private genCardStore = new Map<string, StoredGenCard[]>()

  constructor() {
    for (const c of seedConversations()) this.conversations.set(c.id, c)
  }

  async getHomeSnapshot(): Promise<HomeSnapshot> {
    return {
      now: new Date().toISOString(),
      tasks: demoTasks,
      metrics: demoMetrics,
      dashboard: demoDashboard,
    }
  }

  async listConversations(opts?: { includeArchived?: boolean }) {
    return [...this.conversations.values()]
      .filter((c) => opts?.includeArchived || !c.archived)
      .map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        pinned: c.pinned ?? false,
        archived: c.archived ?? false,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
  }

  async getConversation(id: string) {
    const c = this.conversations.get(id)
    // 返回快照而非引用：回合进行中适配层会先往 store 写学生消息，
    // 查询缓存若持有同一数组会原地变化（界面把乐观气泡渲染两次）
    return c ? { ...c, messages: c.messages.map((m) => ({ ...m })) } : null
  }

  async renameConversation({ conversationId, title }: { conversationId: string; title: string }) {
    const trimmed = title.trim()
    const c = this.conversations.get(conversationId)
    if (!c || !trimmed) return
    c.title = trimmed
  }

  async deleteConversation({ conversationId }: { conversationId: string }) {
    this.conversations.delete(conversationId)
  }

  /** 置顶：只改标记，列表分组与分页在界面侧完成（见 learningApi 契约注释）。 */
  async pinConversation({
    conversationId,
    pinned,
  }: {
    conversationId: string
    pinned: boolean
  }) {
    const c = this.conversations.get(conversationId)
    if (c) c.pinned = pinned
  }

  /** 归档：置 archived，条目留在 store 里（getConversation 仍可取），从主列表挪到归档箱。 */
  async archiveConversation({ conversationId }: { conversationId: string }) {
    const c = this.conversations.get(conversationId)
    if (c) c.archived = true
  }

  /** 恢复（取消归档）：清掉标记，回到主列表。归档箱与搜索命中里的「恢复」都走这里。 */
  async restoreConversation({ conversationId }: { conversationId: string }) {
    const c = this.conversations.get(conversationId)
    if (c) c.archived = false
  }

  /* ── 工作区会话（按任务持久化，双会话分离：不进全局历史列表） ── */

  private readWsConversation(taskId: string): ChatMessage[] {
    const cached = this.wsConversations.get(taskId)
    if (cached) return cached
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(`ws-conv:${taskId}`) : null
      if (raw) {
        const parsed = JSON.parse(raw) as ChatMessage[]
        this.wsConversations.set(taskId, parsed)
        return parsed
      }
    } catch {
      // 损坏的持久化数据回退为空（页面会回填预置开场消息）
    }
    return []
  }

  private writeWsConversation(taskId: string, messages: ChatMessage[]): void {
    this.wsConversations.set(taskId, messages)
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`ws-conv:${taskId}`, JSON.stringify(messages))
      }
    } catch {
      // 存储不可用时只保留内存态（node 测试环境 / 隐私模式）
    }
  }

  async getWorkspaceMessages({ taskId }: { taskId: string }) {
    // 返回副本：调用方改动不会污染缓存
    return this.readWsConversation(taskId).map((m) => ({ ...m }))
  }

  async persistWorkspaceMessages({ taskId, messages }: { taskId: string; messages: ChatMessage[] }) {
    this.writeWsConversation(taskId, messages.map((m) => ({ ...m })))
  }

  /* ── 生成交互卡：收纳存储与任务列表 ── */

  private readGenCards(taskId: string): StoredGenCard[] {
    const cached = this.genCardStore.get(taskId)
    if (cached) return cached
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(`ws-gencards:${taskId}`) : null
      if (raw) {
        const parsed = JSON.parse(raw) as StoredGenCard[]
        this.genCardStore.set(taskId, parsed)
        return parsed
      }
    } catch {
      // 损坏的持久化数据回退为空
    }
    return []
  }

  private writeGenCards(taskId: string, cards: StoredGenCard[]): void {
    this.genCardStore.set(taskId, cards)
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`ws-gencards:${taskId}`, JSON.stringify(cards))
      }
    } catch {
      // 存储不可用时只保留内存态
    }
  }

  async listTasks() {
    return demoTasks.map((t) => ({ ...t }))
  }

  async listGenCards({ taskId }: { taskId: string }) {
    return this.readGenCards(taskId).map((c) => ({ ...c }))
  }

  async putGenCard({ taskId, card }: { taskId: string; card: StoredGenCard }) {
    const cards = this.readGenCards(taskId)
    const i = cards.findIndex((c) => c.cardId === card.cardId)
    if (i >= 0) cards[i] = { ...card }
    else cards.push({ ...card })
    this.writeGenCards(taskId, cards)
  }

  async collectGenCard({
    conversationId,
    messageIndex,
    taskId,
    snapshot,
  }: {
    conversationId: string
    messageIndex: number
    taskId: string
    snapshot?: unknown
  }) {
    const conversation = this.conversations.get(conversationId)
    const message = conversation?.messages[messageIndex]
    if (!message?.genCard) throw new Error('该消息没有生成卡')
    const card = message.genCard
    const at = new Date().toISOString()
    const stored: StoredGenCard = {
      cardId: card.cardId,
      title: card.title,
      taskId,
      claimSim: card.claimSim,
      srcdoc: card.srcdoc,
      fallbackSrcdoc: card.fallbackSrcdoc,
      version: card.version,
      snapshot: snapshot ?? card.snapshot,
      genFailure: card.genFailure,
      collectedAt: at,
    }
    await this.putGenCard({ taskId, card: stored })
    message.genCard = { ...card, snapshot: stored.snapshot, collected: { taskId, at } }
    return { card: message.genCard }
  }

  async retryGenCard({
    conversationId,
    messageIndex,
  }: {
    conversationId: string
    messageIndex: number
  }) {
    const conversation = this.conversations.get(conversationId)
    const message = conversation?.messages[messageIndex]
    if (!message?.genCard?.genFailure) throw new Error('该消息没有生成失败的卡')
    const card = message.genCard
    // mock 语义：再生成一次即成功，回退到上个可用版本（真实实现重新走生成管线）
    const next: GenCard = {
      ...card,
      genFailure: undefined,
      srcdoc: card.fallbackSrcdoc ?? card.srcdoc,
      version: 1,
    }
    message.genCard = next
    return { card: next }
  }

  /** 空状态推荐问题（演示值）：围绕学生画像与当前任务特点生成。 */
  async suggestQuestions() {
    return [
      '继续推进计数器的按键消抖逻辑验证',
      '解析同步复位与异步复位的区别与应用场景',
      '梳理有限状态机的状态转移图设计思路',
    ]
  }

  async sendMessage({ conversationId, text }: { conversationId: string | null; text: string }) {
    await delay(160)
    let id = conversationId
    if (!id || !this.conversations.has(id)) {
      id = 'local-' + ++this.seq
      this.conversations.set(id, {
        id,
        title: text.slice(0, 24),
        updatedAt: new Date().toISOString(),
        contextTokens: 0,
        messages: [],
      })
    }
    const conversation = this.conversations.get(id)!
    conversation.messages.push({ role: 'user', text })
    const reply = mockReply(text)
    conversation.messages.push(reply)
    this.bumpUsage(conversation, text, reply)
    return { conversationId: id, reply }
  }

  /** 上下文用量随收发累计（演示值，驱动侧栏会话行的上下文环）。 */
  private bumpUsage(conversation: Conversation, question: string, reply: ChatMessage) {
    conversation.updatedAt = new Date().toISOString()
    conversation.contextTokens =
      (conversation.contextTokens ?? 0) + (question.length + reply.text.length) * 3 + 400
  }

  async sendMessageStream({
    conversationId,
    text,
    onUpdate,
  }: {
    conversationId: string | null
    text: string
    onUpdate: (message: ChatMessage) => void
  }) {
    if (this.activeTurn) throw new Error('已有回合在生成中；生成中再发送由界面排队')
    // 放弃可继续的回合：它的已停止消息留在历史里
    this.stoppedTurn = null
    let id = conversationId
    if (!id || !this.conversations.has(id)) {
      id = 'local-' + ++this.seq
      this.conversations.set(id, {
        id,
        title: text.slice(0, 24),
        updatedAt: new Date().toISOString(),
        contextTokens: 0,
        messages: [],
      })
    }
    const conversation = this.conversations.get(id)!
    conversation.messages.push({ role: 'user', text })
    const cid = id
    const reply = mockReply(text)
    const player = new TurnPlayer(buildTurnScript(text, reply), reply, onUpdate)
    this.activeTurn = { conversationId: cid, player }
    const final = await player.start()
    conversation.messages.push(final)
    if (final.phase !== 'stopped') this.bumpUsage(conversation, text, final)
    this.activeTurn = null
    if (final.phase === 'stopped') {
      this.stoppedTurn = {
        conversationId: cid,
        player,
        question: text,
        messageIndex: conversation.messages.length - 1,
      }
    }
    return { conversationId: cid, final }
  }

  stopTurn() {
    this.activeTurn?.player.stop()
  }

  async submitQuizAnswer({
    conversationId,
    messageIndex,
    selected,
  }: {
    conversationId: string
    messageIndex: number
    selected: string
  }) {
    const conversation = this.conversations.get(conversationId)
    const message = conversation?.messages[messageIndex]
    if (!message?.quiz) throw new Error('该消息没有小测卡')
    const attempts = (message.quiz.result?.attempts ?? 0) + 1
    const quiz: QuizCard = {
      ...message.quiz,
      result: { selected, correct: selected === message.quiz.answer, attempts },
    }
    message.quiz = quiz
    return { quiz }
  }

  async resumeTurn({
    conversationId,
    onUpdate,
  }: {
    conversationId: string
    onUpdate: (message: ChatMessage) => void
  }) {
    if (this.activeTurn) throw new Error('已有回合在生成中')
    const stopped = this.stoppedTurn
    if (!stopped || stopped.conversationId !== conversationId) throw new Error('没有可继续的回合')
    this.stoppedTurn = null
    const conversation = this.conversations.get(conversationId)!
    this.activeTurn = { conversationId, player: stopped.player }
    const final = await stopped.player.resume(onUpdate)
    conversation.messages[stopped.messageIndex] = final
    if (final.phase !== 'stopped') this.bumpUsage(conversation, stopped.question, final)
    this.activeTurn = null
    if (final.phase === 'stopped') this.stoppedTurn = stopped
    return { conversationId, final }
  }

  async retryLast({
    conversationId,
    onUpdate,
  }: {
    conversationId: string
    onUpdate: (message: ChatMessage) => void
  }) {
    if (this.activeTurn) throw new Error('已有回合在生成中；生成中再发送由界面排队')
    const conversation = this.conversations.get(conversationId)
    if (!conversation) throw new Error('会话不存在')
    const last = conversation.messages[conversation.messages.length - 1]
    if (!last || last.role !== 'agent') throw new Error('没有可重试的回合')
    const question = [...conversation.messages].reverse().find((m) => m.role === 'user')?.text
    if (!question) throw new Error('找不到原问题')
    // 重试语义：替换原消息（已确认 2026-10-10）
    conversation.messages.pop()
    this.stoppedTurn = null
    const reply = mockReply(question)
    const player = new TurnPlayer(buildTurnScript(question, reply), reply, onUpdate)
    this.activeTurn = { conversationId, player }
    const final = await player.start()
    conversation.messages.push(final)
    if (final.phase !== 'stopped') this.bumpUsage(conversation, question, final)
    this.activeTurn = null
    if (final.phase === 'stopped') {
      this.stoppedTurn = {
        conversationId,
        player,
        question,
        messageIndex: conversation.messages.length - 1,
      }
    }
    return { conversationId, final }
  }
}

/** 当前生效的适配器。桌面宿主落地后在这里替换。 */
export const learningApi: LearningApi = new MockLearningApi()
