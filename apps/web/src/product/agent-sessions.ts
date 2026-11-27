import { replaceEqualDeep } from '@tanstack/react-query'
import { z } from 'zod'
import { agentSessionSchema, createAgentSessionSchema, startAgentSessionSchema, updateAgentSessionSchema, type AgentSession, type CreateAgentSession, type UpdateAgentSession } from '@xunjie/contracts/agent-sessions'
import { agentInputSchema, agentInputReceiptSchema, agentEventSchema, agentTurnSchema, agentQuestionReceiptSchema, type AgentInput } from '@xunjie/contracts/agent-runtime'
import { agentAcceptedRequestSchema, agentConversationSchema, type AgentConversation } from '@xunjie/contracts/agent-service'
import { learningTargetSchema, type LearningTarget, type SpaceIdentity } from '@xunjie/contracts/spaces'

export interface SessionSubject { identity: SpaceIdentity; spaceKey: string; namespace: string; teacherCourseId?: string }
const fail = (code: string, text: string) => Object.assign(new Error(text), { code })
const subject = (value: SpaceIdentity) => [value.kind, value.environmentId, value.spaceId, value.principalId].join('.')
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)
/** Only an explicit rejection from the owner releases a durable mutation identity. */
export class AgentSessionRequestError extends Error {
  readonly rejected: boolean
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message)
    this.rejected = [400, 401, 403, 404, 409, 410, 422].includes(status)
      && ['invalid', 'forbidden', 'missing', 'conflict', 'identity-conflict', 'incompatible'].includes(code)
  }
}
export class AgentSessionsClient {
  readonly scope: string
  constructor(readonly subject: SessionSubject) {
    this.scope = JSON.stringify([subject.namespace, subject.spaceKey, subject.identity.kind, subject.identity.environmentId,
      subject.identity.spaceId, subject.identity.principalId, ...(subject.teacherCourseId ? [subject.teacherCourseId] : [])])
  }
  async request(route = '', body?: unknown): Promise<unknown> {
    const { identity, spaceKey, namespace } = this.subject
    const suffix = route && !route.startsWith('?') ? '/' + route : route
    const response = await fetch('/api/learning/agent-sessions' + suffix, {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-xj-agent-contract': '3', 'x-xj-space': spaceKey, 'x-xj-namespace': namespace,
        ...(this.subject.teacherCourseId ? { 'x-xj-teacher-agent': '1' } : {}),
        'x-xj-expected-subject': [identity.environmentId, identity.spaceId, identity.principalId].join('.') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000),
    })
    const value = await response.json()
    if (!response.ok) {
      const failure = z.object({ error: z.string() }).safeParse(value)
      const code = failure.success ? failure.data.error : 'unavailable'
      throw new AgentSessionRequestError(code, response.status, ({ incompatible: '对话服务版本不兼容，请更新后继续。', forbidden: this.subject.teacherCourseId ? '当前账号没有这门课程的教师 Agent 访问权限。' : '当前会话的访问资格已失效，请恢复原账号。',
        conflict: '会话或输入已变化，请刷新后再操作。', missing: '原会话或请求暂时无法读取。',
        unavailable: this.subject.teacherCourseId ? '教师 Agent 暂时不可用，请检查本机服务或学校连接。' : '对话服务暂时不可用，请稍后重试。' } as Record<string, string>)[code] ?? '操作结果尚未确认，原请求已保留，请重试。')
    }
    return value
  }
  private session(value: unknown) {
    const result = agentSessionSchema.parse(value)
    if (subject(result.identity) !== subject(this.subject.identity)) throw fail('forbidden', '会话不属于当前身份。')
    if (this.subject.teacherCourseId && (result.scenario !== 'teacher-assistant' || result.courseId !== this.subject.teacherCourseId))
      throw fail('corrupt', '会话不属于当前任教课程。')
    return result
  }
  async list() { return z.object({ items: z.array(agentSessionSchema) }).strict().parse(await this.request()).items.map(item => this.session(item)) }
  async listTeacherCourse(courseId: string) {
    const course = z.uuid().parse(courseId)
    const result = z.object({ items: z.array(agentSessionSchema) }).strict()
      .parse(await this.request('?courseId=' + encodeURIComponent(course)))
    return result.items.map(item => {
      const session = this.session(item)
      if (session.scenario !== 'teacher-assistant' || session.courseId !== course) throw fail('corrupt', '会话不属于当前任教课程。')
      return session
    })
  }
  async read(sessionId: string) { const result = this.session(await this.request(sessionId)); if (result.sessionId !== sessionId) throw fail('corrupt', '会话身份不匹配。'); return result }
  private createdSession(input: CreateAgentSession, value: unknown) {
    const result = this.session(value)
    if (result.sessionId !== input.sessionId || result.requestId !== input.requestId
      || result.scenario !== input.scenario || result.courseId !== input.courseId) throw fail('corrupt', '会话创建回执不匹配。')
    return result
  }
  async create(value: CreateAgentSession) {
    const input = createAgentSessionSchema.parse(value)
    return this.createdSession(input, await this.request('', input))
  }
  async startSession(create: CreateAgentSession, input: AgentInput) {
    const value = await this.request('start', startAgentSessionSchema.parse({ create, input }))
    const result = z.object({ session: agentSessionSchema, receipt: agentInputReceiptSchema }).strict().parse(value)
    const session = this.createdSession(create, result.session)
    if (result.receipt.sessionId !== session.sessionId || result.receipt.requestId !== input.requestId)
      throw fail('corrupt', '输入回执不匹配。')
    return { session, receipt: result.receipt }
  }
  async workspace(activityId: string, target: LearningTarget) {
    const result = this.session(await this.request('workspace', { activityId: z.uuid().parse(activityId), target: learningTargetSchema.parse(target) }))
    if (result.scenario !== 'workspace-assistant' || result.workspace?.activityId !== activityId || canonical(result.workspace.target) !== canonical(target)) throw fail('corrupt', '工作区会话不属于原活动。')
    return result
  }
  async update(value: UpdateAgentSession) { const input = updateAgentSessionSchema.parse(value), result = this.session(await this.request('update', input));
    if (result.sessionId !== input.sessionId) throw fail('corrupt', '会话更新回执不匹配。'); return result }
  async conversation(sessionId: string, after = 0) { const result = agentConversationSchema.parse(await this.request(`${sessionId}/conversation?after=${after}`));
    if (result.sessionId !== sessionId) throw fail('corrupt', '对话不属于原会话。'); return result }
  async original(sessionId: string, requestId: string) { const result = agentAcceptedRequestSchema.nullable().parse(await this.request(`${sessionId}/requests/${requestId}`));
    if (result && (result.receipt.sessionId !== sessionId || result.receipt.requestId !== requestId)) throw fail('corrupt', '原请求回执不匹配。'); return result }
  async send(value: AgentInput, checkOriginal = true) {
    const input = agentInputSchema.parse(value)
    if (checkOriginal) {
      const original = await this.original(input.sessionId, input.requestId)
      if (original) {
        if (canonical(original.input) !== canonical(input)) throw fail('identity-conflict', '原请求已绑定其他内容，不能替换后重发。')
        return original.receipt
      }
    }
    const receipt = agentInputReceiptSchema.parse(await this.request(`${input.sessionId}/inputs`, input))
    if (receipt.sessionId !== input.sessionId || receipt.requestId !== input.requestId) throw fail('corrupt', '输入回执不匹配。')
    return receipt
  }
  async events(sessionId: string, after = 0) {
    const result = z.array(agentEventSchema).parse(await this.request(`${sessionId}/events?after=${after}`))
    if (result.some((event, index) => event.sessionId !== sessionId || event.seq <= (result[index - 1]?.seq ?? after))) throw fail('corrupt', '事件不属于原会话或顺序不完整。')
    return result
  }
  async control(sessionId: string, turnId: string, operation: 'stop' | 'continue', requestId: string) {
    const result = agentTurnSchema.parse(await this.request(`${sessionId}/runs/${turnId}/${operation}`, { requestId }))
    // Continue opens a new Turn; only stop answers with the Turn it closed.
    if (result.sessionId !== sessionId || operation === 'stop' && result.turnId !== turnId) throw fail('corrupt', '运行回执不匹配。')
    return result
  }
  async respond(sessionId: string, questionId: string, expectedVersion: number, answer: Record<string, any>, requestId: string) {
    const result = agentQuestionReceiptSchema.parse(await this.request(`${sessionId}/waits/${questionId}/responses`,
      { requestId, questionId, expectedVersion, answer }))
    if (result.questionId !== questionId) throw fail('corrupt', '回应回执不匹配。'); return result
  }
}
const startSchema = z.object({ version: z.literal(3), create: createAgentSessionSchema, input: agentInputSchema }).strict()
export type SessionStart = z.infer<typeof startSchema>
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
/** Persist identities and complete bytes before the first network call. A restart queries the original owner. */
export class SessionOutbox {
  readonly key: string
  private freshStartId?: string
  constructor(readonly client: AgentSessionsClient, private storage: StoragePort = localStorage) { this.key = 'xj.agent-session.v3.' + client.scope }
  start(): SessionStart | null { const raw = this.storage.getItem(this.key + '.first'); return raw ? startSchema.parse(JSON.parse(raw)) : null }
  begin(text: string, context: AgentInput['context'] = {}): SessionStart {
    const previous = this.start(); if (previous) return previous
    const sessionId = crypto.randomUUID()
    const courseId = this.client.subject.teacherCourseId
    const scenario = courseId ? { scenario: 'teacher-assistant', courseId } : { scenario: 'student-assistant' }
    const value = startSchema.parse({ version: 3, create: { sessionId, requestId: crypto.randomUUID(), ...scenario, title: text.trim().slice(0, 80) || null },
      input: { sessionId, requestId: crypto.randomUUID(), text, context } })
    this.storage.setItem(this.key + '.first', JSON.stringify(value))
    this.freshStartId = value.create.requestId
    return value
  }
  async deliverStart(value = this.start()) {
    if (!value) throw fail('missing', '没有待发送的首问。')
    const fresh = this.freshStartId === value.create.requestId
    this.freshStartId = undefined
    const recover = async () => {
      const session = await this.client.read(value.create.sessionId).catch(error => {
        if ((error as { code?: string }).code !== 'missing') throw error
        return null
      })
      if (session?.state !== 'ready') return null
      const original = await this.client.original(session.sessionId, value.input.requestId)
      if (!original) return null
      if (canonical(original.input) !== canonical(value.input)) throw fail('identity-conflict', '原请求已绑定其他内容，不能替换后重发。')
      return { session, receipt: original.receipt }
    }
    const result = (fresh ? null : await recover()) ?? await this.client.startSession(value.create, value.input)
    if (!fresh) {
      // Older builds also stored the first input in the per-session queue.
      const saved = this.pending(value.input.sessionId)
      if (saved.some(input => input.requestId === value.input.requestId))
        this.storage.setItem(this.key + '.' + value.input.sessionId, JSON.stringify(saved.filter(input => input.requestId !== value.input.requestId)))
    }
    this.discardStart(value.input.requestId)
    return result
  }
  discardStart(requestId: string) {
    if (this.start()?.input.requestId === requestId) this.storage.removeItem(this.key + '.first')
  }
  pending(sessionId: string): AgentInput[] { return z.array(agentInputSchema).parse(JSON.parse(this.storage.getItem(this.key + '.' + sessionId) ?? '[]')) }
  async send(value: AgentInput) {
    const input = agentInputSchema.parse(value), key = this.key + '.' + input.sessionId
    const saved = this.pending(input.sessionId), prior = saved.find(item => item.requestId === input.requestId)
    if (prior && canonical(prior) !== canonical(input)) throw fail('identity-conflict', '待发请求不能改换内容。')
    if (!prior) this.storage.setItem(key, JSON.stringify([...saved, input]))
    const clear = () => this.storage.setItem(key, JSON.stringify(this.pending(input.sessionId).filter(item => item.requestId !== input.requestId)))
    try {
      const receipt = await this.client.send(input, !!prior)
      clear()
      return receipt
    } catch (cause) {
      if (this.client.subject.teacherCourseId && cause instanceof AgentSessionRequestError && cause.rejected) clear()
      throw cause
    }
  }
}
export function mergeAgentConversation(previous: AgentConversation | null, next: AgentConversation): AgentConversation {
  if (!previous || previous.sessionId !== next.sessionId || next.reset) return next
  if (previous.lastSeq > next.lastSeq) return previous
  const messages = new Map(previous.messages.map(message => [message.messageId, message]))
  for (const message of next.messages) {
    const before = messages.get(message.messageId)
    messages.set(message.messageId, before ? { ...message, createdAt: before.createdAt,
      ...(message.editedAt ?? before.editedAt ? { editedAt: message.editedAt ?? before.editedAt } : {}) } : message)
  }
  const turns = new Map(next.turns.map(turn => [turn.turnId, turn]))
  for (const [id, message] of messages) {
    if (message.state !== 'streaming') continue
    const turn = turns.get(message.turnId)
    if (!turn || !['completed', 'stopped', 'interrupted', 'failed'].includes(turn.state)) continue
    messages.set(id, { ...message, state: turn.state === 'stopped' ? 'stopped' : turn.state === 'failed' ? 'failed' : 'settled' })
  }
  const merged = <T,>(before: T[], incoming: T[], key: (item: T) => string) => { const values = new Map(before.map(item => [key(item), item])); for (const item of incoming) values.set(key(item), item); return [...values.values()] }
  return replaceEqualDeep(previous, { ...next, messages: [...messages.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    thinking: merged(previous.thinking ?? [], next.thinking ?? [], item => item.messageId), contextUsage: next.contextUsage ?? previous.contextUsage,
    turns: merged(previous.turns, next.turns, item => item.turnId), inputs: merged(previous.inputs, next.inputs, item => item.inputId),
    questions: merged(previous.questions, next.questions, item => item.questionId), tools: merged(previous.tools, next.tools, item => item.toolCallId),
    workspaces: merged(previous.workspaces, next.workspaces, item => item.toolCallId),
    citations: merged(previous.citations ?? [], next.citations ?? [], item => item.citation.citationId) })
}
export function workspaceCard(value: unknown): { activityId: string; title: string; goal?: string; target: LearningTarget } | null {
  const schema = z.object({ activityId: z.uuid(), title: z.string().min(1).optional(), goal: z.string().optional(),
    content: z.object({ title: z.string(), goal: z.string() }).passthrough().optional(), target: learningTargetSchema }).passthrough()
  const result = schema.safeParse(value)
  if (!result.success) return null
  const title = result.data.title ?? result.data.content?.title
  return title ? { activityId: result.data.activityId, target: result.data.target, title, ...(result.data.goal || result.data.content?.goal ? { goal: result.data.goal ?? result.data.content?.goal } : {}) } : null
}

/** The existing protected workspace queue keeps its real works/references; only its receiver changes. */
export function createSessionActionReceiver(client: AgentSessionsClient, session: AgentSession, protect: (action: import('@xunjie/contracts/action-intents').ActionInput) => Promise<void> = async () => {}): import('@xunjie/contracts/action-intents').ActionReceiver {
  const identity = { receiverId: 'teaching-agent:' + session.owner.target.serviceId, kind: 'question' as const, location: 'local' as const }
  const digest = async (input: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input))))).map(byte => byte.toString(16).padStart(2, '0')).join('')
  const receipt = (requestId: string, inputDigest: string, inputId: string) => ({ requestId, receiver: identity, inputDigest, state: 'accepted' as const, receiptId: inputId, detail: '' })
  const query = async (requestId: string, inputDigest: string) => {
    const known = await client.original(session.sessionId, requestId)
    if (!known) return null
    const action = known.input.context.action
    if (!action || await digest(action) !== inputDigest) throw fail('identity-conflict', '工作区原请求不匹配。')
    return receipt(requestId, inputDigest, known.receipt.inputId)
  }
  return { identity, query, cancel: query, async accept(action, inputDigest) {
    if (action.scope.activityId !== session.workspace?.activityId || action.scope.environmentId !== session.identity.environmentId
      || action.scope.spaceId !== session.identity.spaceId || action.scope.principalId !== session.identity.principalId
      || canonical(action.receiver) !== canonical(identity) || await digest(action) !== inputDigest) throw fail('forbidden', '问题不属于当前工作区。')
    await protect(action)
    const outbox = new SessionOutbox(client)
    const result = await outbox.send({ requestId: action.requestId, sessionId: session.sessionId, text: action.draft.question || '请结合所选内容帮助我。',
      context: { action: JSON.parse(JSON.stringify(action)) } })
    return receipt(action.requestId, inputDigest, result.inputId)
  } }
}
