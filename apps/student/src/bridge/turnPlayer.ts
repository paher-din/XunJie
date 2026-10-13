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
    // 任务卡、追问选项、概念卡、小测卡与生成卡只在落定时挂上：正文没写完就展示会误导
    this.finalTaskId = reply.taskId
    this.finalFollowUps = reply.followUps
    this.finalConcept = reply.concept
    this.finalQuiz = reply.quiz
    this.finalGenCard = reply.genCard
    this.onUpdate = onUpdate
  }

  private finalTaskId?: string
  private finalFollowUps?: string[]
  private finalConcept?: ChatMessage['concept']
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
    if (step.thinking) this.draft.thinking = step.thinking
    if (step.failure) {
      this.draft.phase = 'failed'
      this.draft.failure = step.failure
    }
    this.stepIndex++
    this.emit()
    if (step.failure) return this.done()
    this.schedule()
  }

  private settle() {
    this.draft.phase = 'settled'
    if (this.finalTaskId) this.draft.taskId = this.finalTaskId
    if (this.finalFollowUps) this.draft.followUps = this.finalFollowUps
    if (this.finalConcept) this.draft.concept = this.finalConcept
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
