import { lexer } from 'marked'
import { insertIndex } from '../lib/messageBlocks'
import type { ChatMessage, ConceptCard, FailureReason, TurnPhase, WaveSpec } from './types'

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
  /**
   * 概念讲解卡的逐步流出：正文讲到它依附的那一段，就在这一拍立起壳与标题，
   * 随后要点逐字写出、波形一次到位（各行自己描线）、读图提示收尾——
   * 卡片跟着正文一起长出来，不是最后补上的一张。
   */
  conceptStart?: { title: string; afterPara?: number }
  /** 卡片里的一段字：start 起新的一条（首拍就带几个字，屏上不会闪过空行），否则续写到最后一条上。 */
  conceptText?: { part: 'point' | 'note'; start?: boolean; chunk: string }
  /** 波形图示：整块到位。 */
  conceptWave?: WaveSpec
}

const WAIT_MS = 1200
const THINK_MS = 2600
/** token 到达节奏：一次 1–4 字、间隔带确定性抖动（下标派生，同一问题永远同一份剧本）。
 *  到达不等于上屏——界面侧 useSmoothStreamText 把这股抖动匀成匀速流。 */
const TOKEN_MS = 74
const TOKEN_JITTER_MS = 30
const TOKEN_MAX = 4
/** 句末余拍：一拍什么都不长的「零位移」时间。原先 320ms 通吃句末与换行，实测一条 20 秒的回复里
 *  有 6.7 秒正文一动不动（占 34%），读起来是「一顿一顿」而不是「从头流到尾」——压到句末 160、换行 80，
 *  节奏还在，但停的那一下短到只够上一行落定。 */
const SENTENCE_MS = 160
const LINE_MS = 80
const STEP_MS = 650
/** 卡片自身的流出节奏：壳 → 要点逐字写出 → 波形一次到位 → 读图提示收尾。
 *  正文会在这里停三秒左右，但那不是空拍——卡片一直在长，屏上始终有东西出来。 */
const CARD_SHELL_MS = 320
/** 卡片里的字比正文快一档（一行二十几字，约半秒写完）：高度只在起行那一拍变一次，其余各拍横向生长。 */
const CARD_TEXT_MS = 40
const CARD_LINE_MS = 140
const CARD_TEXT_MAX = 4
const CARD_WAVE_MS = 260
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

/** 逐 token 拆出正文步骤（已确认：正文逐字出现）；token 末尾是句读或换行时多停一拍。 */
function streamSteps(text: string): ScriptStep[] {
  const steps: ScriptStep[] = []
  const chars = [...text]
  for (let i = 0, n = 0; i < chars.length; n++) {
    const size = 1 + ((n * 7919) % TOKEN_MAX)
    const chunk = chars.slice(i, i + size).join('')
    i += chunk.length
    const tail = chunk[chunk.length - 1]
    const pause = tail === '\n' ? LINE_MS : '。？！'.includes(tail) ? SENTENCE_MS : 0
    steps.push({
      delayMs: TOKEN_MS + ((n * 104729) % TOKEN_JITTER_MS) + pause,
      appendText: chunk,
    })
  }
  return steps
}

/** 卡片的一步一图：壳与标题先起，要点一条一条写出来，波形一次到位，读图提示收尾。 */
function conceptSteps(card: ConceptCard): ScriptStep[] {
  const out: ScriptStep[] = [
    { delayMs: CARD_SHELL_MS, conceptStart: { title: card.title, afterPara: card.afterPara } },
  ]
  for (const p of card.points) out.push(...textSteps('point', p, CARD_LINE_MS))
  if (card.wave) out.push({ delayMs: CARD_WAVE_MS, conceptWave: card.wave })
  if (card.note) out.push(...textSteps('note', card.note, CARD_LINE_MS))
  return out
}

/**
 * 卡片里的一段字逐拍写出：每拍 2–4 字（下标派生，同一问题永远同一份剧本）。
 * 首拍就带着字上台，屏上不会闪过一枚空子弹；起行前留一口余拍（gap），读起来是一条写完再开下一条。
 */
function textSteps(part: 'point' | 'note', text: string, gap: number): ScriptStep[] {
  const out: ScriptStep[] = []
  const chars = [...text]
  for (let i = 0, n = 0; i < chars.length; n++) {
    const size = 1 + ((n * 7919) % CARD_TEXT_MAX)
    const chunk = chars.slice(i, i + size).join('')
    i += chunk.length
    out.push({ delayMs: n === 0 ? gap : CARD_TEXT_MS, conceptText: { part, start: n === 0, chunk } })
  }
  return out
}

/**
 * 正文讲到卡片依附的那一段，卡片就从那儿开始画——把卡片的子序列劈进正文步骤流，
 * 而不是等整条正文流完再补一张。落点用渲染器同一份规则算（lib/messageBlocks.insertIndex），
 * 两边共用才不会各说各话；没有 afterPara 的卡片按「附在正文末尾」的老规矩排在最后。
 */
function withConcept(text: string, stream: ScriptStep[], card: ConceptCard): ScriptStep[] {
  const blocks = lexer(text)
  const at = insertIndex(blocks, card.afterPara)
  let off = 0
  for (let i = 0; i <= at; i++) off += blocks[i].raw.length
  let seen = 0
  for (let i = 0; i < stream.length; i++) {
    seen += stream[i].appendText?.length ?? 0
    if (seen >= off) return [...stream.slice(0, i + 1), ...conceptSteps(card), ...stream.slice(i + 1)]
  }
  return [...stream, ...conceptSteps(card)]
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
  const stream = streamSteps(reply.text)
  // 概念讲解卡插在正文中间：讲到依附的那一段就开始画，卡片跟着正文一起长出来
  steps.push(...(reply.concept ? withConcept(reply.text, stream, reply.concept) : stream))
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
