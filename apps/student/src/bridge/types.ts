/** 领域类型：界面与本地能力之间的共享契约。 */

export type TaskStatus = '未开始' | '进行中' | '已完成'

/** 项目任务：教师布置的项目学习要求。 */
export interface ProjectTask {
  id: string
  name: string
  course: string
  /** 课程内区分图标，占位符号，非品牌定稿。 */
  icon: string
  status: TaskStatus
  /** 任务目标，一句话。 */
  goal: string
  /** 最近一次学习进展的说明。 */
  last: string
  stepsDone: number
  stepsTotal: number
  /** 教师设定的截止时间，ISO 字符串；无截止时间为 null。 */
  deadlineAt: string | null
  /** 最近一次学习活动时间，ISO 字符串；从未学习为 null。 */
  lastStudiedAt: string | null
}

export interface LearningMetrics {
  /** 看板口径，当前固定为「本周」。 */
  periodLabel: string
  /** 学习时长（小时）。口径待正式定义，见 docs/home-design.md。 */
  hours: number
  /** 学习天数。 */
  days: number
  /** 本周期内完成的任务数。 */
  completedThisPeriod: number
  /** 周一到周日的相对活跃度（0-100），用于柱状图。 */
  weeklyActivity: number[]
}

export interface HomeSnapshot {
  /** 快照时间，ISO 字符串；逾期等判断以它为准。 */
  now: string
  tasks: ProjectTask[]
  metrics: LearningMetrics
  dashboard: DashboardData
}

/** 学习看板数据。时长口径=活跃时间，见 docs/home-design.md。 */
export interface DashboardData {
  /** 本学期开学日，yyyy-mm-dd。 */
  semesterStart: string
  /** 开学至今逐日学习时长（小时）。 */
  activity: ActivityDay[]
  /** 学习投入构成的总时长（小时）。 */
  compositionTotalHours: number
  composition: CompositionSlice[]
  badges: Badge[]
  radar: RadarAxis[]
  milestones: Milestone[]
  mastery: MasteryRow[]
  xp: XpState
  /** 学习时段分布：7 天（周一起）× 24 小时的时长。 */
  punch: number[][]
}

export interface ActivityDay {
  /** yyyy-mm-dd */
  date: string
  hours: number
}

export interface CompositionSlice {
  label: string
  percent: number
  /** 色板槽位，由样式表决定具体颜色。 */
  tone: 'a' | 'b' | 'c' | 'd'
}

export interface Badge {
  icon: string
  label: string
  unlocked: boolean
  tone: number
}

export interface RadarAxis {
  axis: string
  /** 0-1 */
  value: number
}

export interface Milestone {
  name: string
  note: string
  state: 'done' | 'now' | 'next'
}

export interface MasteryRow {
  label: string
  /** 0-100 */
  percent: number
}

export interface XpState {
  level: number
  total: number
  today: number
  nextLevelRemaining: number
  nextLevelProgress: number
}

/**
 * 一条回合的阶段（agent 消息维度）：
 * waiting 等待首 token → thinking 思考中 → streaming 正文流出 → settled 落定，
 * 中断为 stopped，失败为 failed。低档思考强度下没有 thinking，从 waiting 直接进 streaming。
 * 状态机全貌见 docs/agent-page-design.md「一条回合的状态机」。
 */
export type TurnPhase = 'waiting' | 'thinking' | 'streaming' | 'settled' | 'stopped' | 'failed'

/** 失败分型：界面按型给文案与动作；断网时必须说明本地内容不受影响（docs/frontend-architecture.md §12）。 */
export type FailureReason = 'network' | 'model' | 'quota'

/** 时序波形图示：概念讲解卡的读图部分。坐标为抽象单位，渲染时按固定几何映射到 SVG。 */
export interface WaveSpec {
  rows: WaveRow[]
  /** 高亮区间 [from, to]，标示读图重点时间段。 */
  highlight?: [number, number]
  /** 竖直虚线标注位置。 */
  markers?: number[]
  /** 底部文字标注；dx 用于横向避让。 */
  labels?: { x: number; dx?: number; text: string }[]
}

export interface WaveRow {
  name: string
  /** 时钟行：从高电平起、按固定半周期翻转的方波。 */
  clk?: boolean
  /** 非时钟行的翻转点：[x, 翻转后电平]；初始为高电平。 */
  segs?: [number, number][]
}

/** 概念讲解卡：结构化要点 + 图示；嵌在正文第 afterPara 段之后（1 起，该段引出的列表 / 代码一并带上；缺省或超出则附在正文末尾）。 */
export interface ConceptCard {
  title: string
  points: string[]
  /** 读图提示。 */
  note?: string
  afterPara?: number
  wave?: WaveSpec
}

/** 小测卡作答结果：学生提交后由适配层写回消息，历史里保留已答状态。 */
export interface QuizResult {
  /** 最近一次作答选中的选项键。 */
  selected: string
  correct: boolean
  /** 累计作答次数（答错可再答一次）。 */
  attempts: number
}

export interface QuizOption {
  key: string
  text: string
}

/**
 * 自测小测卡：落定后挂载的单题单选（docs/agent-page-design.md「教学专属块」）。
 * 交互定稿（2026-10-10）：选了再提交；答错给解析并可再答一次（不揭示答案）；
 * 答对后提示已记入学习画像。
 */
export interface QuizCard {
  /** 画像条目名，答对后用于「已记入学习画像」提示。 */
  topic: string
  /** 卡片标题，如「复位概念 · 单选」。 */
  title: string
  /** 题干。 */
  stem: string
  options: QuizOption[]
  /** 正确选项键。 */
  answer: string
  /** 解析：判定后展示。 */
  explain: string
  result?: QuizResult
}

/** 生成交互卡的生成失败信息：落定后卡体渲染失败卡（「没有生成可用的交互」+ 错误码 + 重试）。 */
export interface GenFailure {
  /** 错误码（mock 占位，如 GEN_RENDER_502），随失败卡展示，便于排查。 */
  code: string
}

/**
 * 生成交互卡：Agent 生成的可操作内容，跑在 iframe srcdoc 沙箱里（已确认 2026-10-11，第 19 条）。
 * 与任务卡、概念卡同一挂载规则：只在落定（settled / 历史消息）时挂载，stopped / failed 不带。
 * 载体分场景：全局对话页内嵌消息流（live 沙箱），工作区开成中心工具区标签页（wsLayout）。
 * 双轨同壳：课程包预置素材走 cards.tsx 注册表，生成内容进沙箱，共用卡片壳与收纳。
 */
export interface GenCard {
  /** 卡片 id：宿主与沙箱双向核对（协议 instance），也是收纳存储的主键。 */
  cardId: string
  title: string
  /** 归属任务（Agent 指定，学生确认时可改）；null = 无归属，收纳时由学生从任务选择器指派。 */
  taskId: string | null
  /** 声称仿真结果时壳右上标 11px 灰字「仿真结果」角标；演示为默认，不标。 */
  claimSim: boolean
  /** 沙箱源内容（iframe srcdoc，自包含零外部资源；mock 由确定性剧本生成）。 */
  srcdoc: string
  /** 上个可用版本源内容：运行失败回滚 / 协议超时重试时改载。 */
  fallbackSrcdoc?: string
  /** 最近已知交互状态（沙箱 input 持续更新 / 快照恢复用）；必须可 JSON 化。 */
  snapshot?: unknown
  /** 当前版本号；运行失败回滚到上个可用版本。 */
  version: number
  /** 生成失败（失败三型之一）：存在时卡体渲染失败卡。 */
  genFailure?: GenFailure
  /** 收纳去向：缺省 / null = 未收纳；收纳后原位退化为占位行「已收纳到 {任务} 的卡片收纳 · 打开」。 */
  collected?: { taskId: string; at: string } | null
}

/** 收纳进任务卡片体系的生成卡（工作区胶囊收纳 / 工具区标签页 / 钉右缘共用一份存储）。 */
export interface StoredGenCard extends GenCard {
  /** 收纳时间，ISO 字符串。 */
  collectedAt: string
}

  export interface ChatImage { name:string; dataUrl:string }
  export interface ChatMessage {
  role: 'user' | 'agent'
  images?:ChatImage[]
  text: string
  /** 这条说出来的时刻（ISO）；界面上随操作条标在时间戳里，缺省则不标。 */
  at?: string
  /** 消息内任务卡：Agent 回复引用具体项目任务时携带，渲染时按 id 查任务数据。 */
  taskId?: string
  /** 回合阶段，只出现在 agent 消息上；流式期间 text 随增量增长。历史消息缺省视为 settled。 */
  phase?: TurnPhase
  /** 思考折叠行内容：模型另出的中文教学化摘要，不是原始推理（docs/agent-page-design.md 已确认 2026-10-09）。 */
  thinking?: { summary: string; seconds: number }
  /** 失败分型；failed 时 text 保留已生成部分。code 来自模型服务或桥接层，随失败卡片展示，便于排查。 */
  failure?: { reason: FailureReason; code?: string }
  /**
   * 追问选项：落定后给学生的 2–4 个可点下一步提问，渲染在输入框上方（SuggestionStack 叠层卡片），
   * 点击直接发送；生成中点击按排队语义处理（docs/agent-page-design.md 已确认 2026-10-10）。
   * 只有落定（settled / 历史消息）的消息才应展示，stopped / failed 不展示。
   */
  followUps?: string[]
  /**
   * 概念讲解卡：结构化要点 + 图示，嵌在正文段落之间（afterPara）。
   * 「收纳」按场景分流：对话页钉到右缘对照，工作区收进工作区卡片体系（已确认 2026-10-10）。
   * 与任务卡、追问选项不同（2026-10-12 改）：它是正文的一部分，随流式逐块画出——
   * 讲到它依附的那一段就挂壳，要点 / 波形 / 读图提示一步步长出来，画完前不给收纳与收起；
   * stopped 保留已画出的部分并禁用动作，failed 不显示；继续生成后按实际内容接上。
   */
  concept?: ConceptCard
  /**
   * 自测小测卡：单题单选，只在落定（settled / 历史消息）时挂载，stopped / failed 不带。
   * 作答结果由适配层写回 result（已确认 2026-10-10）。
   */
  quiz?: QuizCard
  /**
   * 教学化步骤块：编号行数组，逐步流出（每步落定一行，进行中步带脉冲点，复用活动行视觉语言），
   * 落定后可折叠成「N 步 · 已讲完」一行，默认展开（已确认 2026-10-11，第 20 条）。
   * 与思考区的区分靠内容性质：思考区是模型自述（灰、折叠），步骤块是教学内容（正文色、编号、默认展开）。
   */
  steps?: string[]
  /**
   * 生成交互卡：只在落定（settled / 历史消息）时挂载，stopped / failed 不带（已确认 2026-10-11，第 19 条）。
   * 失败三型：生成失败（genFailure 失败卡）、运行失败（沙箱 error 回滚上个可用版本）、协议超时（3 秒不就绪判死）。
   */
  genCard?: GenCard
}

export interface Conversation {
  id: string
  /** Original in-progress turn, for read-only recovery after reload. */
  activeTurnId?: string
  title: string
  /** 最近一条消息的时间，ISO 字符串；历史时间流分组以它为准。 */
  updatedAt: string
  /** 上下文窗口已用 token 数（演示值，驱动输入框工具行的上下文环）；缺省视为 0。 */
  contextTokens?: number
  /** 学生置顶（2026-10-11 确认）：置顶会话常驻侧栏顶部「置顶」分栏；缺省视为未置顶。 */
  pinned?: boolean
  /** 已归档（2026-10-11 确认）：不在历史主列表，改收进侧栏归档箱；内容保留，可「恢复」回列表。 */
  archived?: boolean
  messages: ChatMessage[]
}

export interface ConversationSummary {
  id: string
  title: string
  /** 最近一条消息的时间，ISO 字符串。 */
  updatedAt: string
  /** 置顶标记（2026-10-11 确认）：侧栏据此把它收进顶部「置顶」分栏，不参与时间分组与分页。 */
  pinned: boolean
  /** 归档标记（2026-10-11 确认）：界面据此把它移出主列表、收进归档箱；搜索跨两组命中，归档命中标灰并可「恢复」。 */
  archived: boolean
}

/* ---------- 项目作品与本机草稿（多文件编辑） ---------- */

/**
 * 作品文件实例。稳定身份是 `fileId`，不是路径：路径只是当前占用的名字，
 * 实例被回收后同名路径可以被新实例占用，而旧实例的身份与历史不变。
 */
export interface ProjectFile {
  fileId: string
  /** 服务实例映射；fileId 继续是稳定本机身份，以保留 model/草稿/视图。 */
  serverFileId?: string
  path: string
  /**
   * 学生当前**意图**的生命周期（05）：本机实例记录优先，没有本机记录时取权威 head。
   * 「与最近确认的不一致」就是未确认的回收/恢复，界面如实标注，不冒充已生效。
   */
  lifecycle: 'active' | 'recycled'
  /**
   * 已确认的正文、版本与生命周期；本机新建、还没确认保存的文件为 null。
   * 草稿与它比较得出「未确认修改」——本机草稿与确认作品是两份内容，不共用一个值。
   */
  confirmed: { text: string; version: number; lifecycle: 'active' | 'recycled' } | null
}

/**
 * 工作区可写性。正式版由 Attempt 状态与分配状态决定（暂停时只能继续编辑已有 active 文件，
 * 终态只读）；mock 里逐项目声明，界面按 kind 与 reason 如实显示，不从昵称或本地设置推断权限。
 */
export type ProjectAccess =
  | { kind: 'editable' }
  | { kind: 'paused'; reason: string }
  | { kind: 'read-only'; reason: string }

/** 一个任务的初始作品集合（mock 数据；正式版来自服务端确认作品 + 本机草稿）。 */
export interface ProjectSeed {
  taskId: string
  files: ProjectFile[]
  access: ProjectAccess
  /** 已确认作品的工作区版本，用于「确认作品 vN」读数。 */
  confirmedRevision: number
}
