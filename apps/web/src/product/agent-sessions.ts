import { replaceEqualDeep } from '@tanstack/react-query'
import { z } from 'zod'
import { agentSessionSchema, createAgentSessionSchema, updateAgentSessionSchema, type AgentSession, type CreateAgentSession, type UpdateAgentSession } from '@xunjie/contracts/agent-sessions'
import { agentInputSchema, agentInputReceiptSchema, agentRunSchema, agentEventSchema, type AgentInput } from '@xunjie/contracts/agent-runtime'
import { agentAcceptedRequestSchema, agentConversationSchema, agentWaitReceiptSchema, type AgentConversation } from '@xunjie/contracts/agent-service'
import { learningTargetSchema, type LearningTarget, type SpaceIdentity } from '@xunjie/contracts/spaces'

export interface SessionSubject { identity: SpaceIdentity; spaceKey: string; namespace: string }
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
  constructor(readonly subject: SessionSubject) { this.scope = JSON.stringify([subject.namespace, subject.spaceKey, subject.identity.kind, subject.identity.environmentId, subject.identity.spaceId, subject.identity.principalId]) }
  async request(route = '', body?: unknown): Promise<unknown> {
    const { identity, spaceKey, namespace } = this.subject
    const response = await fetch('/api/learning/agent-sessions' + (route ? '/' + route : ''), {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json', 'x-xj-agent-contract': '2', 'x-xj-space': spaceKey, 'x-xj-namespace': namespace,
        'x-xj-expected-subject': [identity.environmentId, identity.spaceId, identity.principalId].join('.') },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000),
    })
    const value = await response.json()
    if (!response.ok) {
      const failure = z.object({ error: z.string() }).safeParse(value)
      const code = failure.success ? failure.data.error : 'unavailable'
      throw new AgentSessionRequestError(code, response.status, ({ incompatible: '对话服务版本不兼容，请更新后继续。', forbidden: '当前会话的访问资格已失效，请恢复原账号。',
        conflict: '会话或输入已变化，请刷新后再操作。', missing: '原会话或请求暂时无法读取。' } as Record<string, string>)[code] ?? '操作结果尚未确认，原请求已保留，请重试。')
    }
    return value
  }
  private session(value: unknown) {
    const result = agentSessionSchema.parse(value)
    if (subject(result.identity) !== subject(this.subject.identity)) throw fail('forbidden', '会话不属于当前身份。')
    return result
  }
  async list() { return z.object({ items: z.array(agentSessionSchema) }).strict().parse(await this.request()).items.map(item => this.session(item)) }
  async read(sessionId: string) { const result = this.session(await this.request(sessionId)); if (result.sessionId !== sessionId) throw fail('corrupt', '会话身份不匹配。'); return result }
  async create(value: CreateAgentSession) { const input = createAgentSessionSchema.parse(value), result = this.session(await this.request('', input));
    if (result.sessionId !== input.sessionId || result.requestId !== input.requestId) throw fail('corrupt', '会话创建回执不匹配。'); return result }
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
  async send(value: AgentInput) {
    const input = agentInputSchema.parse(value), original = await this.original(input.sessionId, input.requestId)
    if (original) { if (canonical(original.input) !== canonical(input)) throw fail('identity-conflict', '原请求已绑定其他内容，不能替换后重发。'); return original.receipt }
    const receipt = agentInputReceiptSchema.parse(await this.request(`${input.sessionId}/inputs`, input))
    if (receipt.sessionId !== input.sessionId || receipt.requestId !== input.requestId) throw fail('corrupt', '输入回执不匹配。')
    return receipt
  }
  async events(sessionId: string, after = 0) {
    const result = z.array(agentEventSchema).parse(await this.request(`${sessionId}/events?after=${after}`))
    if (result.some((event, index) => event.sessionId !== sessionId || event.seq <= (result[index - 1]?.seq ?? after))) throw fail('corrupt', '事件不属于原会话或顺序不完整。')
    return result
  }
  async control(sessionId: string, runId: string, operation: 'stop' | 'continue', requestId: string) {
    const result = agentRunSchema.parse(await this.request(`${sessionId}/runs/${runId}/${operation}`, { requestId }))
    if (result.runId !== runId || result.sessionId !== sessionId) throw fail('corrupt', '运行回执不匹配。'); return result
  }
  async respond(sessionId: string, waitId: string, expectedVersion: number, answer: Record<string, any>, requestId: string) {
    const result = agentWaitReceiptSchema.parse(await this.request(`${sessionId}/waits/${waitId}/responses`, { requestId, expectedVersion, answer }))
    if (result.waitId !== waitId) throw fail('corrupt', '回应回执不匹配。'); return result
  }
}
const startSchema = z.object({ version: z.literal(2), create: createAgentSessionSchema, input: agentInputSchema }).strict()
export type SessionStart = z.infer<typeof startSchema>
type StoragePort = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
/** Persist identities and complete bytes before the first network call. A restart queries the original owner. */
export class SessionOutbox {
  readonly key: string
  constructor(readonly client: AgentSessionsClient, private storage: StoragePort = localStorage) { this.key = 'xj.agent-session.v2.' + client.scope }
  start(): SessionStart | null { const raw = this.storage.getItem(this.key + '.first'); return raw ? startSchema.parse(JSON.parse(raw)) : null }
  begin(text: string, context: AgentInput['context'] = {}): SessionStart {
    const previous = this.start(); if (previous) return previous
    const sessionId = crypto.randomUUID()
    const value = startSchema.parse({ version: 2, create: { sessionId, requestId: crypto.randomUUID(), scenario: 'student-assistant', title: text.trim().slice(0, 80) || null },
      input: { sessionId, requestId: crypto.randomUUID(), text, mode: 'steering', context } })
    this.storage.setItem(this.key + '.first', JSON.stringify(value)); return value
  }
  async deliverStart(value = this.start()) {
    if (!value) throw fail('missing', '没有待发送的首问。')
    let session: AgentSession
    try { session = await this.client.read(value.create.sessionId) }
    catch (error) { if ((error as { code?: string }).code !== 'missing') throw error; session = await this.client.create(value.create) }
    if (session.state !== 'ready') session = await this.client.create(value.create)
    const receipt = await this.send(value.input)
    if (this.start()?.input.requestId === value.input.requestId) this.storage.removeItem(this.key + '.first')
    return { session, receipt }
  }
  pending(sessionId: string): AgentInput[] { return z.array(agentInputSchema).parse(JSON.parse(this.storage.getItem(this.key + '.' + sessionId) ?? '[]')) }
  async send(value: AgentInput) {
    const input = agentInputSchema.parse(value), key = this.key + '.' + input.sessionId
    const saved = this.pending(input.sessionId), prior = saved.find(item => item.requestId === input.requestId)
    if (prior && canonical(prior) !== canonical(input)) throw fail('identity-conflict', '待发请求不能改换内容。')
    if (!prior) this.storage.setItem(key, JSON.stringify([...saved, input]))
    const receipt = await this.client.send(input)
    this.storage.setItem(key, JSON.stringify(this.pending(input.sessionId).filter(item => item.requestId !== input.requestId)))
    return receipt
  }
}
export function mergeAgentConversation(previous: AgentConversation | null, next: AgentConversation): AgentConversation {
  if (!previous || previous.sessionId !== next.sessionId) return next
  if (previous.lastSeq > next.lastSeq) return previous
  const messages = new Map(previous.messages.map(message => [message.messageId, message]))
  for (const message of next.messages) {
    const before = messages.get(message.messageId)
    messages.set(message.messageId, before ? { ...message, createdAt: before.createdAt } : message)
  }
  const runs = new Map(next.runs.map(run => [run.runId, run]))
  for (const [id, message] of messages) {
    const run = runs.get(message.runId)
    if (message.state === 'streaming' && run && ['stopped', 'failed', 'completed', 'paused'].includes(run.state))
      messages.set(id, { ...message, state: run.state === 'stopped' ? 'stopped' : run.state === 'failed' ? 'failed' : 'settled' })
  }
  const merged = <T,>(before: T[], incoming: T[], key: (item: T) => string) => { const values = new Map(before.map(item => [key(item), item])); for (const item of incoming) values.set(key(item), item); return [...values.values()] }
  return replaceEqualDeep(previous, { ...next, messages: [...messages.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    runs: merged(previous.runs, next.runs, item => item.runId), inputs: merged(previous.inputs, next.inputs, item => item.inputId),
    waits: merged(previous.waits, next.waits, item => item.waitId), tools: merged(previous.tools, next.tools, item => item.operationId),
    workspaces: merged(previous.workspaces, next.workspaces, item => item.operationId) })
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
      mode: action.delivery?.mode ?? 'steering', context: { action: JSON.parse(JSON.stringify(action)) } })
    return receipt(action.requestId, inputDigest, result.inputId)
  } }
}
