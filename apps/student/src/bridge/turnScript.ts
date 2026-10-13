import type { ChatMessage, FailureReason, TurnPhase } from './types'

/**
 * 一条回合的确定性剧本（docs/agent-page-design.md 推进顺序第 2 步）。
 * 同一问题永远生成同一份步骤：内容与间隔都固定，可复跑、可截图。
 * 间隔是演示节奏，不代表真实模型速度。
 */
export interface TurnScript {
  steps: ScriptStep[]
}

/** 剧本的一步：delayMs 后把这次推进应用到 agent 消息草稿上。 */
export interface ScriptStep {
  delayMs: number
  phase?: TurnPhase
  appendText?: string
  /** 教学化步骤块：落定一行（第 20 条）；steps 在正文之后逐步流出。 */
  appendStep?: string
  thinking?: { summary: string; seconds: number }
  failure?: { reason: FailureReason; code: string }
}

const WAIT_MS = 1200
const THINK_MS = 2600
const CHAR_MS = 42
const PAUSE_MS = 320
const STEP_MS = 650
const FAIL_AT_MS = 2000

/** 失败演示触发词：问题里出现即按对应分型失败（在等待期失败）。 */
const FAIL_TRIGGERS: { pattern: RegExp; reason: FailureReason; code: string }[] = [
  { pattern: /断网/, reason: 'network', code: 'ERR_NETWORK' },
  { pattern: /报错/, reason: 'model', code: 'MODEL_500' },
  { pattern: /额度/, reason: 'quota', code: 'QUOTA_DAILY' },
]

/** 流式中途失败演示：问题含「中断」时，正文流出约四成才断（分型按断网）。 */
const MIDSTREAM_FAIL = { pattern: /中断/, reason: 'network', code: 'ERR_NETWORK' } as const

/** 思考摘要占位：接真实模型后由模型按教学化摘要的口径生成（已确认 2026-10-09）。 */
const THINK_SUMMARIES: [RegExp, string][] = [
  [/毛刺/, '我先区分了原始信号与消抖后的认定，再把讲解拆成三步，最后准备了一张可以反复按的交互卡。'],
  [/卡失败/, '这次生成交互卡没有成功，我把失败原样标出来，给你重试的路径。'],
  [/消抖仿真|仿真对比/, '我用固定激励跑了一遍确定性对比：同一次抖动，未消抖会计多次，消抖后只认定一次。'],
  [/不响应|超时/, '这张卡故意不回就绪信号，用来演示协议超时的判死与重试。'],
  [/复位/, '我在对比这两种复位对时钟边沿的依赖，并确认了教材里用的是「异步置位、同步释放」的说法。所以先讲差别，再讲代价。'],
  [/考考我|出一道|出题/, '我从刚才讲的内容里挑了一个判别标准类的考点，出了一道单选题。'],
  [/进度|这周|时长|学习情况/, '我先对齐了本周学习记录的口径，再把任务完成情况和计数器进度分开说。'],
  [/任务|哪里|上次/, '我先找到你最近停留的任务阶段，再对照任务目标给出下一步。'],
]

/** 逐字拆出正文步骤（已确认：正文逐字出现）；句末与换行后多停一拍。 */
function streamSteps(text: string): ScriptStep[] {
  const steps: ScriptStep[] = []
  for (const ch of text) {
    const pause = ch === '。' || ch === '？' || ch === '！' || ch === '\n' ? PAUSE_MS : 0
    steps.push({ delayMs: CHAR_MS + pause, appendText: ch })
  }
  return steps
}

export function buildTurnScript(question: string, reply: ChatMessage): TurnScript {
  const fail = FAIL_TRIGGERS.find((t) => t.pattern.test(question))
  if (fail) {
    // 失败演示优先于内容回复
    return {
      steps: [
        { delayMs: 0, phase: 'waiting' },
        { delayMs: FAIL_AT_MS, failure: { reason: fail.reason, code: fail.code } },
      ],
    }
  }
  const summary = THINK_SUMMARIES.find(([pattern]) => pattern.test(question))?.[1]
  const steps: ScriptStep[] = [{ delayMs: 0, phase: 'waiting' }]
  if (summary) {
    steps.push(
      { delayMs: WAIT_MS, phase: 'thinking' },
      {
        delayMs: THINK_MS,
        phase: 'streaming',
        thinking: { summary, seconds: Math.max(1, Math.round(THINK_MS / 1000)) },
      },
    )
  } else {
    // 低档思考强度：没有思考区，从等待直接进正文
    steps.push({ delayMs: WAIT_MS, phase: 'streaming' })
  }
  steps.push(...streamSteps(reply.text))
  // 教学化步骤块：正文之后逐步流出，每步落定一行（第 20 条）
  if (reply.steps?.length) {
    for (const s of reply.steps) steps.push({ delayMs: STEP_MS, appendStep: s })
  }
  // 中途失败：裁掉四成之后的流式步骤，失败标记跟在半截内容后面（待定清单·回合状态机，2026-10-10 定稿）
  if (MIDSTREAM_FAIL.pattern.test(question)) {
    const firstStream = steps.findIndex((s) => s.appendText !== undefined)
    if (firstStream >= 0) {
      const cut = firstStream + Math.max(1, Math.floor((steps.length - firstStream) * 0.4))
      return {
        steps: [
          ...steps.slice(0, cut),
          { delayMs: 600, failure: { reason: MIDSTREAM_FAIL.reason, code: MIDSTREAM_FAIL.code } },
        ],
      }
    }
  }
  return { steps }
}
