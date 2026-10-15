import type {
  ChatMessage,
  ChatImage,
  Conversation,
  ConversationSummary,
  GenCard,
  HomeSnapshot,
  ProjectTask,
  QuizCard,
  StoredGenCard,
} from './types'

/**
 * 界面与本地能力之间的类型化接口。
 *
 * 组件只依赖这个接口：开发预览使用 Mock 适配器，桌面宿主落地后由
 * Electron preload 暴露同构实现（见 docs/frontend-architecture.md 第 3 节）。
 * 接口保持业务语义，不暴露通用 shell 或任意 IPC 转发。
 */
export interface LearningApi {
  /** 首页快照：任务列表、学习看板指标与快照时间。 */
  getHomeSnapshot(): Promise<HomeSnapshot>
  /**
   * 会话摘要列表，新的在前。默认不含已归档的会话（归档不进主列表）；
   * 界面要连同归档一起取（归档箱与搜索跨两组命中）时传 `includeArchived: true`。
   */
  listConversations(opts?: { includeArchived?: boolean }): Promise<ConversationSummary[]>
  getConversation(id: string): Promise<Conversation | null>
  /**
   * 重命名会话（侧栏行内编辑提交，已确认 2026-10-10）。
   * 标题 trim 后为空时忽略本次修改。
   */
  renameConversation(input: { conversationId: string; title: string }): Promise<void>
  /** 删除会话（侧栏就地二次确认后调用，已确认 2026-10-10）。删除不存在的会话视为成功。 */
  deleteConversation(input: { conversationId: string }): Promise<void>
  /**
   * 置顶 / 取消置顶会话（侧栏行尾 pin 图标，2026-10-11 确认）。
   * 置顶会话常驻侧栏顶部「置顶」分栏，不参与时间分组与滚动分页；不存在的会话忽略。
   */
  pinConversation(input: { conversationId: string; pinned: boolean }): Promise<void>
  /**
   * 归档会话（侧栏行菜单第二项，2026-10-11 确认）：归档后离开历史主列表，内容保留、
   * 仍可用 getConversation 取回；查看入口 = 侧栏归档箱与搜索命中，都可「恢复」（同日定稿）。
   * 重复归档视为成功。
   */
  archiveConversation(input: { conversationId: string }): Promise<void>
  /**
   * 恢复（取消归档）会话（归档箱行内「恢复」、搜索命中里的「恢复」，2026-10-11 确认）：
   * 清掉归档标记后重新进主列表，标题与消息不动；不存在的会话忽略。
   */
  restoreConversation(input: { conversationId: string }): Promise<void>
  /**
   * 空状态推荐问题：按学生画像与当前任务生成（2–4 条，已确认 2026-10-10），
   * 以 SuggestionStack 叠层卡片浮在输入框上方；点击只填草稿不发送。
   * mock 为演示文案；接真实 Agent 时由画像服务给出。
   */
  suggestQuestions(): Promise<string[]>
  /**
   * 发送一条消息（同步一次性返回完整回复）。
   * 供尚未迁移到流式的页面使用；对话页迁移后由 sendMessageStream 取代。
   */
  sendMessage(input: {
    conversationId: string | null
    text: string
  }): Promise<{ conversationId: string; reply: ChatMessage }>
  /**
   * 流式发送一条消息（一条回合，状态机见 docs/agent-page-design.md）。
   * onUpdate 每次推进都收到 agent 消息的整条快照；快照的 phase 走到
   * settled / stopped / failed 即为终态，Promise 同时兑现。
   * 适配层同时只跑一条回合；生成中再发送由界面排队（已确认 2026-10-09），
   * 直接重复调用会被拒绝。
   */
  sendMessageStream(input: {
    conversationId: string | null
    text: string
    images?:ChatImage[]
    onUpdate: (message: ChatMessage) => void
  }): Promise<{ conversationId: string; final: ChatMessage }>
  /** 停止当前回合：保留已生成部分，快照 phase 变为 stopped。无进行中回合时不做事。 */
  stopTurn(): void
  /** 继续生成被停止的回合；该回合的已停止消息在会话里原位更新。 */
  resumeTurn(input: {
    conversationId: string
    onUpdate: (message: ChatMessage) => void
  }): Promise<{ conversationId: string; final: ChatMessage }>
  /**
   * 重试当前会话最后一个回合（重试 / 重新生成 / 换个模型共用）：
   * 取最后一条学生消息作为问题，替换最后一条 agent 回复，不追加（已确认 2026-10-09）。
   */
  retryLast(input: {
    conversationId: string
    onUpdate: (message: ChatMessage) => void
  }): Promise<{ conversationId: string; final: ChatMessage }>
  /**
   * 改写一条学生消息（消息级操作「编辑我的消息」，已确认 2026-10-11 第 24 条）：
   * 原位替换文本，并截掉该条之后的全部内容——旧问题的答案留着会自相矛盾（同第 9 条重试语义），
   * 界面随后用 retryLast 按新文本补一条回答。改的是首问时同步会话标题（首句截断 24 字，第 15 条）。
   * 越界索引 / 不是学生消息时抛错，交由界面提示，不静默改坏历史。
   */
  editUserMessage(input: {
    conversationId: string
    messageIndex: number
    text: string
    /** 真实通道核对当前可见原消息，避免另一个标签编辑了不同分支。 */
    expectedMessageHash?: string
  }): Promise<void>
  /**
   * 提交小测卡作答：判定并写回消息的 quiz.result（历史保留已答状态，已确认 2026-10-10）。
   * 答错可再答一次，attempts 累计。真实实现里这里同时把结果计入学习画像；mock 只写回消息。
   */
  submitQuizAnswer(input: {
    conversationId: string
    messageIndex: number
    selected: string
  }): Promise<{ quiz: QuizCard }>
  /**
   * 任务列表（任务选择器用：按课程分组、未完成任务在前，已确认 2026-10-11 第 19 条）。
   * 当前取首页快照的任务集；接真实服务后由课程服务给出。
   */
  listTasks(): Promise<ProjectTask[]>
  /**
   * 生成交互卡收纳（已确认 2026-10-11 第 19 条）：有归属直接收进任务，无归属由界面弹
   * 任务选择器、学生指派后带 taskId 调用。写任务的卡片收纳存储（工作区胶囊 / 标签页 /
   * 钉右缘共用），并回写消息的 genCard.collected；snapshot 是收纳时从 live 沙箱取的最新状态。
   */
  collectGenCard(input: {
    conversationId: string
    messageIndex: number
    taskId: string
    snapshot?: unknown
  }): Promise<{ card: GenCard }>
  /**
   * 生成失败卡重试（失败三型之一）：重新生成一次。mock 语义为再生成即成功——
   * 清掉 genFailure 并回退到可用版本；真实实现里这里重新走生成管线。
   */
  retryGenCard(input: {
    conversationId: string
    messageIndex: number
  }): Promise<{ card: GenCard }>
  /**
   * 工作区引导会话（按任务持久化 ws-conv:<taskId> localStorage，已确认 2026-10-11 第 19 条）：
   * 与全局历史列表分离（双会话分离不变），刷新后按任务恢复消息。
   */
  getWorkspaceMessages(input: { taskId: string }): Promise<ChatMessage[]>
  /** 覆盖式持久化工作区引导会话（回合落定与收纳占位等本地改写后调用）。 */
  persistWorkspaceMessages(input: { taskId: string; messages: ChatMessage[] }): Promise<void>
  /** 任务的生成卡收纳存储（工作区胶囊收纳列表的数据源）。 */
  listGenCards(input: { taskId: string }): Promise<StoredGenCard[]>
  /** 写入 / 覆盖一条生成卡收纳记录（收纳、状态续写、封面更新共用，按 cardId 合并）。 */
  putGenCard(input: { taskId: string; card: StoredGenCard }): Promise<void>
}
