import type { ChatMessage, TurnPhase } from './types'
import type { ScriptStep, TurnScript } from './turnScript'

/**
 * 回合播放器：把确定性剧本逐步应用到一条 agent 消息草稿上，每步发出整条快照。
 * start / resume 返回的 Promise 在落定、失败或被停止时兑现最终快照。
 * 停止不清草稿，resume 从停下的那一步继续（该步间隔重新计时）。
 * 适配层（全局会话）与界面层（工作区引导的本地回合）共用它，状态机只有一份。
 */
export class TurnPlayer {
  private draft: ChatMessage
  private stepIndex = 0
  private timer: ReturnType<typeof setTimeout> | null = null
  private resumePhase: TurnPhase = 'waiting'
  private onUpdate: (message: ChatMessage) => void
  private resolve: ((final: ChatMessage) => void) | null = null

  constructor(
    private script: TurnScript,
    reply: ChatMessage,
    onUpdate: (message: ChatMessage) => void,
  ) {
    this.draft = { role: 'agent', text: '', phase: 'waiting' }
    // 任务卡、追问选项、小测卡与生成卡只在落定时挂上：正文没写完就展示会误导。
    // 概念讲解卡是例外（2026-10-12）：它是正文的一部分，由剧本插在它依附的那一段之后逐笔画出。
    this.finalTaskId = reply.taskId
    this.finalFollowUps = reply.followUps
    this.finalQuiz = reply.quiz
    this.finalGenCard = reply.genCard
    this.onUpdate = onUpdate
  }

  private finalTaskId?: string
  private finalFollowUps?: string[]
  private finalQuiz?: ChatMessage['quiz']
  private finalGenCard?: ChatMessage['genCard']

  start(): Promise<ChatMessage> {
    return new Promise((resolve) => {
      this.resolve = resolve
      this.schedule()
    })
  }

  get snapshot(): ChatMessage {
    return { ...this.draft }
  }

  private schedule() {
    const step = this.script.steps[this.stepIndex]
    if (!step) return this.settle()
    this.timer = setTimeout(() => this.apply(step), step.delayMs)
  }

  private apply(step: ScriptStep) {
    if (step.phase) this.draft.phase = step.phase
    if (step.appendText !== undefined) this.draft.text += step.appendText
    if (step.appendStep !== undefined) this.draft.steps = [...(this.draft.steps ?? []), step.appendStep]
    this.applyConcept(step)
    if (step.thinking) this.draft.thinking = step.thinking
    if (step.failure) {
      this.draft.phase = 'failed'
      this.draft.failure = step.failure
      // 失败不落卡：半张卡片配一张失败卡，只会让学生分不清该看哪儿（与停止同规则）
      this.draft.concept = undefined
    }
    this.stepIndex++
    this.emit()
    if (step.failure) return this.done()
    this.schedule()
  }

  /** 概念讲解卡的逐步流出：壳与标题 → 要点逐字写出 → 波形 → 读图提示。每步换一个新对象，视图按引用重渲染。 */
  private applyConcept(step: ScriptStep) {
    if (step.conceptStart) {
      this.draft.concept = {
        title: step.conceptStart.title,
        afterPara: step.conceptStart.afterPara,
        points: [],
      }
    }
    const card = this.draft.concept
    if (!card) return
    const t = step.conceptText
    if (t) {
      const last = card.points[card.points.length - 1] ?? ''
      this.draft.concept =
        t.part === 'point'
          ? {
              ...card,
              points: t.start ? [...card.points, t.chunk] : [...card.points.slice(0, -1), last + t.chunk],
            }
          : { ...card, note: (card.note ?? '') + t.chunk }
      return
    }
    if (step.conceptWave) this.draft.concept = { ...card, wave: step.conceptWave }
  }

  private settle() {
    this.draft.phase = 'settled'
    if (this.finalTaskId) this.draft.taskId = this.finalTaskId
    if (this.finalFollowUps) this.draft.followUps = this.finalFollowUps
    if (this.finalQuiz) this.draft.quiz = this.finalQuiz
    if (this.finalGenCard) this.draft.genCard = this.finalGenCard
    this.emit()
    this.done()
  }

  private done() {
    const resolve = this.resolve
    this.resolve = null
    resolve?.(this.snapshot)
  }

  stop() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.draft.phase === 'settled' || this.draft.phase === 'failed') return
    if (this.draft.phase === 'stopped') return
    this.resumePhase = this.draft.phase ?? 'waiting'
    this.draft.phase = 'stopped'
    this.emit()
    this.done()
  }

  resume(onUpdate: (message: ChatMessage) => void): Promise<ChatMessage> {
    this.onUpdate = onUpdate
    this.draft.phase = this.resumePhase
    this.emit()
    return new Promise((resolve) => {
      this.resolve = resolve
      this.schedule()
    })
  }

  private emit() {
    this.onUpdate(this.snapshot)
  }
}
