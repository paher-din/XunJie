import type { LearningApi } from './learningApi'
import type { ChatMessage, ChatImage, Conversation, ConversationSummary, AssignedTaskCard } from './types'
import { learningApi as mock } from './mockAdapter'
import { apiGet, apiPost } from '../workspace/http'
import { PREP_BUILD } from '../workspace/mode'
import { getSessionState } from '../workspace/session'
import { getModelSettings,reloadOnModelConfigConflict,ModelConfigurationChangedError } from '../lib/modelSettings'

const opts = { mode: 'real' as const, timeoutMs: 15_000 }
function identity() { const s = getSessionState(); return `${s.epoch}:${s.session?.userId ?? ''}` }
function assertCurrent(captured: string) {
  if (captured !== identity() || getSessionState().status !== 'authenticated') throw new Error('原登录状态已改变，请重新打开会话。')
}
function message(value: unknown): ChatMessage {
  const m = value as ChatMessage
  if (!m || !['user', 'agent'].includes(m.role) || typeof m.text !== 'string'
    || (m.phase !== undefined && !['waiting', 'thinking', 'streaming', 'settled', 'stopped', 'failed'].includes(m.phase))) throw new Error('聊天响应无效，请重新读取会话。')
  // 独立通道只接正文与实际状态，不从模型内容构造课程卡片、画像或生成 HTML。
  if(m.images!==undefined&&(!Array.isArray(m.images)||m.role!=='user'||m.images.some(image=>!image||typeof image.name!=='string'||typeof image.dataUrl!=='string'||!/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(image.dataUrl))))throw new Error('图片历史响应无效，请重新读取会话。')
  let taskCard: AssignedTaskCard | undefined
  if(m.taskCard!==undefined){
    const card=m.taskCard
    if(m.role!=='agent'||(m.phase!==undefined&&m.phase!=='settled')||!card||typeof card.assignmentId!=='string'||!card.assignmentId||card.assignmentId.length>128
      ||typeof card.title!=='string'||!card.title||card.title.length>500||!['active','paused'].includes(card.availability)
      ||(card.courseName!==undefined&&(typeof card.courseName!=='string'||card.courseName.length>500)))throw new Error('任务卡响应无效，请重新读取会话。')
    taskCard={assignmentId:card.assignmentId,title:card.title,availability:card.availability,
      ...(card.courseName?{courseName:card.courseName}:{})}
  }
  return { role: m.role, text: m.text, ...(m.images?.length?{images:m.images.map(({name,dataUrl})=>({name,dataUrl}))}:{}), ...(typeof m.at === 'string' ? { at: m.at } : {}),
    ...(taskCard?{taskCard}:{}),
    ...(m.phase ? { phase: m.phase } : {}), ...(m.failure && ['network', 'model', 'quota'].includes(m.failure.reason)
      ? { failure: { reason: m.failure.reason, ...(typeof m.failure.code === 'string' ? { code: m.failure.code } : {}) } } : {}) }
}
interface TurnView { conversationId: string; turnId: string; message: ChatMessage }
function turnView(raw: unknown): TurnView {
  const v = raw as TurnView
  if (!v || typeof v.conversationId !== 'string' || !v.conversationId || typeof v.turnId !== 'string' || !v.turnId) throw new Error('回合响应无效，请读取原会话核对。')
  const m = message(v.message)
  if (m.role !== 'agent' || !m.phase) throw new Error('回合状态无效，请读取原会话核对。')
  return { conversationId: v.conversationId, turnId: v.turnId, message: m }
}
const terminal = (m: ChatMessage) => ['settled', 'stopped', 'failed'].includes(m.phase ?? '')
export class AgentRecoveryRequiredError extends Error {
  constructor() { super('连接中断，已收到的内容仍保留。请核对原回合以继续接收，不会重新生成。') }
}
type Observer = { conversationId: string | null; onUpdate: (m: ChatMessage) => void; onAccepted?: (conversationId: string, turnId: string) => void }
type PendingTurn = { session: string; conversationId: string | null; turnId?: string; body?: unknown }
class RealAgentApi {
  private active: { session: string; turnId?: string; stopRequested: boolean; stopError?: Error } | null = null
  private pending = new Map<string | null, PendingTurn>()
  private async get<T>(path: string): Promise<T> { const captured = identity(); const value = await apiGet<T>(path, opts); assertCurrent(captured); return value }
  private async post<T>(path: string, body: unknown): Promise<T> { const captured = identity(); const value = await apiPost<T>(path, body, opts); assertCurrent(captured); return value }
  async listConversations(options?: { includeArchived?: boolean }): Promise<ConversationSummary[]> {
    const raw = await this.get<ConversationSummary[]>(`/agent/conversations${options?.includeArchived ? '?includeArchived=true' : ''}`)
    if (!Array.isArray(raw) || raw.some(c => !c || typeof c.id !== 'string' || typeof c.title !== 'string' || typeof c.updatedAt !== 'string')) throw new Error('会话列表响应无效。')
    return raw.map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, pinned: c.pinned === true, archived: c.archived === true }))
  }
  async getConversation(id: string): Promise<Conversation | null> {
    const c = await this.get<Conversation | null>(`/agent/conversations/${encodeURIComponent(id)}`)
    if (c === null) return null
    if (!c || c.id !== id || typeof c.title !== 'string' || typeof c.updatedAt !== 'string' || !Array.isArray(c.messages)) throw new Error('会话响应无效。')
    return { id, title: c.title, updatedAt: c.updatedAt, pinned: c.pinned === true, archived: c.archived === true,
      ...(typeof c.activeTurnId==='string'&&c.activeTurnId?{activeTurnId:c.activeTurnId}:{}),
      ...(typeof c.contextTokens === 'number' && Number.isFinite(c.contextTokens) && c.contextTokens >= 0 ? { contextTokens: c.contextTokens } : {}), messages: c.messages.map(message) }
  }
  private async action(id: string, body: unknown) { await this.post(`/agent/conversations/${encodeURIComponent(id)}`, body) }
  renameConversation(input: { conversationId: string; title: string }) { return this.action(input.conversationId, { action: 'rename', title: input.title }) }
  deleteConversation(input: { conversationId: string }) { return this.action(input.conversationId, { action: 'delete' }) }
  pinConversation(input: { conversationId: string; pinned: boolean }) { return this.action(input.conversationId, { action: 'pin', pinned: input.pinned }) }
  archiveConversation(input: { conversationId: string }) { return this.action(input.conversationId, { action: 'archive' }) }
  restoreConversation(input: { conversationId: string }) { return this.action(input.conversationId, { action: 'restore' }) }
  async editUserMessage(input: { conversationId: string; messageIndex: number; text: string; expectedMessageHash?: string }) {
    if (!input.expectedMessageHash) throw new Error('原消息未核对，编辑未发送。')
    await this.post(`/agent/conversations/${encodeURIComponent(input.conversationId)}/edit`, { messageIndex: input.messageIndex, text: input.text, expectedMessageHash: input.expectedMessageHash })
  }
  private async run(mode: 'send' | 'retry' | 'resume', input: Observer & { text?: string; images?:ChatImage[] }) {
    const configuration = getModelSettings()
    if (configuration.saving || configuration.loading) throw new Error('模型配置保存或读取中，请等待确认后再发送。')
    if (!configuration.data?.enabled || !configuration.data.callsEnabled || !configuration.data.defaultModelId) throw new Error('请先在设置中保存并启用个人模型。')
    const captured = identity()
    if(this.pending.get(input.conversationId)?.session===captured&&!this.active)throw new AgentRecoveryRequiredError()
    const pending:PendingTurn={session:captured,conversationId:input.conversationId,body:{conversationId:input.conversationId,mode,
      expectedModelConfigRevision:configuration.data.revision,
      ...(mode==='send'?{text:input.text,...(input.images?.length?{images:input.images}:{})}:{}),requestKey:crypto.randomUUID()}}
    return this.observe(pending,input,configuration.data.revision)
  }
  private async observe(pending:PendingTurn,input:Observer,revision?:number) {
    const captured=pending.session
    assertCurrent(captured)
    if (this.active?.session === captured) {
      throw new Error(this.active.stopRequested ? '上一会话正在停止，请等待确认后再发送。' : '此账号已有回复正在生成，请先停止原会话后再发送。')
    }
    // 换账号或重新认证后，旧回合不能占用新会话的停止目标。
    if (this.active) this.active = null
    this.pending.set(pending.conversationId,pending)
    const active = { session: captured, stopRequested: false } as NonNullable<RealAgentApi['active']>
    this.active = active
    try {
      let raw:unknown;
      try{raw=pending.turnId?await this.get(`/agent/turns/${encodeURIComponent(pending.turnId)}`):await this.post('/agent/turns',pending.body)}
      catch(error){
        if((error as {failure?:{kind:string}})?.failure?.kind==='api'&&this.pending.get(pending.conversationId)===pending)this.pending.delete(pending.conversationId)
        if(revision!==undefined&&await reloadOnModelConfigConflict(error,revision))throw new ModelConfigurationChangedError();
        throw error;
      }
      let view = turnView(raw)
      assertCurrent(captured)
      if (input.conversationId && view.conversationId !== input.conversationId) throw new Error('回合归属不一致，请重新读取会话。')
      active.turnId = view.turnId
      const cid = view.conversationId, tid = view.turnId
      if(this.pending.get(pending.conversationId)===pending)this.pending.delete(pending.conversationId)
      pending.conversationId=cid;pending.turnId=tid
      this.pending.set(cid,pending)
      input.onAccepted?.(cid,tid)
      input.onUpdate(view.message)
      if (active.stopRequested && !terminal(view.message)) await this.post(`/agent/turns/${encodeURIComponent(tid)}/stop`, {})
      while (!terminal(view.message)) {
        await new Promise(resolve => setTimeout(resolve, 250))
        assertCurrent(captured)
        if (active.stopError) throw active.stopError
        view = turnView(await this.get(`/agent/turns/${encodeURIComponent(tid)}`))
        if (view.conversationId !== cid || view.turnId !== tid) throw new Error('回合归属不一致，请重新读取会话。')
        input.onUpdate(view.message)
      }
      if(this.pending.get(pending.conversationId)===pending)this.pending.delete(pending.conversationId)
      return { conversationId: cid, final: view.message }
    } catch(error) {
      if(this.pending.get(pending.conversationId)===pending&&captured===identity())throw new AgentRecoveryRequiredError()
      throw error
    } finally { if (this.active === active) this.active = null }
  }
  async recoverTurn(input:Observer&{turnId?:string}) {
    const pending=input.turnId?{session:identity(),conversationId:input.conversationId,turnId:input.turnId}:this.pending.get(input.conversationId)
    if(!pending||pending.session!==identity()||pending.conversationId!==input.conversationId)throw new Error('原回合未找到，请重新打开原会话核对。')
    return this.observe(pending,input)
  }
  sendMessageStream(input: Observer & { text: string; images?:ChatImage[] }) { return this.run('send', input) }
  async sendMessage(input: { conversationId: string | null; text: string }) {
    const result = await this.run('send', { ...input, onUpdate: () => {} })
    return { conversationId: result.conversationId, reply: result.final }
  }
  resumeTurn(input: { conversationId: string; onUpdate: (m: ChatMessage) => void }) { return this.run('resume', input) }
  retryLast(input: { conversationId: string; onUpdate: (m: ChatMessage) => void }) { return this.run('retry', input) }
  stopTurn() {
    const active = this.active
    if (!active || active.session !== identity() || active.stopRequested) return
    active.stopRequested = true
    if (active.turnId) void this.post(`/agent/turns/${encodeURIComponent(active.turnId)}/stop`, {}).catch(() => {
      active.stopError = new Error('停止请求未确认，请重新读取原会话。')
    })
  }
  async listTasks() { return [] }
  async suggestQuestions() { return [] }
}
const real = new RealAgentApi()
const unavailable = async (): Promise<never> => { throw new Error('独立聊天未开放此功能。') }
/** 真实失败保持失败；准备工程显式使用演示适配器。 */
export const learningApi: LearningApi = PREP_BUILD ? mock : Object.assign(real, {
  getHomeSnapshot: unavailable, submitQuizAnswer: unavailable, collectGenCard: unavailable, retryGenCard: unavailable,
  getWorkspaceMessages: unavailable, persistWorkspaceMessages: unavailable, listGenCards: unavailable, putGenCard: unavailable,
})
