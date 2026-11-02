import { actionInputSchema, actionViewSchema, actionScopeSchema, actionReceiptSchema, actionReceiverSchema } from '@xunjie/contracts/action-intents'
import type { ActionInput, ActionView, ActionReceiverIdentity, ActionReceiver, ActionReceipt } from '@xunjie/contracts/action-intents'
import { executionAcceptanceSchema, fixedActionSchema, isExecutionAction, rejectedExecutionAcceptance } from '@xunjie/contracts/execution'
import type { FixedAction, ExecutionAction, ExecutionAcceptance, ExecutionQuery } from '@xunjie/contracts/execution'
import { ActionStore } from './action-store'
import type { LocalAction } from './action-store'
import type { ReliableQuestionDraft } from './draft'
import { NETWORK_MAX_WAIT_MS } from './coordinator'
import { questionReferenceKey, questionReferencesSchema, questionTextSchema } from '@xunjie/contracts/question-drafts'

export interface ActionTransport {
  prepare(input: ActionInput): Promise<ActionView>
  read(requestId: string): Promise<ActionView | null>
  list(): Promise<ActionView[]>
  dispatch(requestId: string): Promise<ActionView>
  cancel(requestId: string): Promise<ActionView>
  capabilities(): Promise<ActionReceiverIdentity[]>
}
/** The browser-side execution receiver seam: durable acceptance, original-identity query and a real stop. */
export interface LocalExecutionReceiver {
  identity: ActionReceiverIdentity
  accept(action: ExecutionAction, inputDigest: string): Promise<ExecutionAcceptance>
  query(requestId: string, inputDigest: string): Promise<ExecutionQuery | null>
  cancel(requestId: string, inputDigest: string): Promise<ExecutionAcceptance | null>
  blocked(requestId: string, inputDigest: string): Promise<boolean>
}
export interface ActionQueueState { ready: boolean; active: boolean; items: LocalAction[]; previous: LocalAction[]; error: string; receivers: ActionReceiverIdentity[] }
const terminal = (item: LocalAction) => ['accepted', 'cancelled', 'failed'].includes(item.phase)
const parseFixed = (value: unknown) => fixedActionSchema.parse(value)
const matches = (a: FixedAction, b: FixedAction) => JSON.stringify(parseFixed(a)) === JSON.stringify(parseFixed(b))
async function actionInputDigest(input: FixedAction): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(parseFixed(input)))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}
/** Question-only partitions stay unreachable for an execution intent. */
function questionPart(input: FixedAction): ActionInput {
  if (isExecutionAction(input)) throw new Error('执行动作不参与问题派发。')
  return input
}
function scopeFromKey(key: string) {
  const [, environmentId, spaceId, principalId, activityId] = JSON.parse(key) as string[]
  return actionScopeSchema.parse({ environmentId, spaceId, principalId, activityId })
}
/** One workspace key is one fixed action scope; hosts never invent a second scope. */
export const actionScopeFromWorkspaceKey = scopeFromKey

/** A workspace-owned durable action queue, not an Agent runner or an experiment executor. */
export class ReliableActions {
  private store = new ActionStore()
  private listeners = new Set<() => void>()
  private unprotected = new Map<string, LocalAction>()
  private active = new Map<string, Promise<void>>()
  private localReceivers = new Map<string, ActionReceiver>()
  private executionReceivers = new Map<string, LocalExecutionReceiver>()
  private cancellationRequests = new Set<string>()
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private disposed = false
  private denied = false
  state: ActionQueueState = { ready: false, active: true, items: [], previous: [], error: '', receivers: [] }
  constructor(readonly key: string, private draft: ReliableQuestionDraft,
    private captureWorks: () => ActionInput['works'], private transport: ActionTransport,
    private access: { denied(): boolean; confirmed(): void }) {
    if (draft.key !== key) throw new Error('问题与作品不属于同一工作区。')
  }
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  snapshot = () => this.state
  private accessDenied() { return this.denied || this.access.denied() }
  private rejectAccess(error?: unknown) {
    if (error && !['forbidden', 'stale-generation'].includes((error as { code?: string }).code ?? '')) return false
    this.denied = true
    this.notify({ active: false, error: '原空间访问资格已失效，待发内容仍保留；请重新登录原空间。' })
    return true
  }
  registerLocal(receiver: ActionReceiver) {
    const identity = actionReceiverSchema.parse(receiver.identity)
    if (identity.location !== 'local') throw new Error('本机接收器必须声明本机交接。')
    const id = JSON.stringify(identity)
    if (this.localReceivers.has(id)) throw new Error('不能替换原动作的接收方。')
    this.localReceivers.set(id, receiver)
    this.notify({ receivers: [...this.state.receivers.filter(item => item.location !== 'local'), ...this.localReceivers.values()].map(item => 'identity' in item ? item.identity : item) })
    void this.synchronize()
    return () => { if (this.localReceivers.get(id) === receiver) this.localReceivers.delete(id) }
  }
  /** Execution intents use the same durable queue and handoff, never a second dispatch loop. */
  registerLocalExecution(receiver: LocalExecutionReceiver) {
    const identity = actionReceiverSchema.parse(receiver.identity)
    if (identity.location !== 'local' || identity.kind !== 'execution') throw new Error('执行接收器必须声明本机执行交接。')
    const id = JSON.stringify(identity)
    if (this.executionReceivers.has(id)) throw new Error('不能替换原动作的接收方。')
    this.executionReceivers.set(id, receiver)
    this.notify({ receivers: [...this.state.receivers.filter(item => JSON.stringify(item) !== id), identity] })
    void this.synchronize()
    return () => { if (this.executionReceivers.get(id) === receiver) this.executionReceivers.delete(id) }
  }
  private notify(patch: Partial<ActionQueueState>) {
    if (this.disposed) return
    this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener()
  }
  private async refresh() {
    const saved = await this.store.list(this.key)
    this.notify({ ready: true, items: [...saved, ...[...this.unprotected.values()].filter(item => !saved.some(other => other.key === item.key))] })
  }
  async open() {
    this.timer ??= setInterval(() => { void this.synchronize() }, NETWORK_MAX_WAIT_MS)
    window.addEventListener('beforeunload', this.beforeUnload)
    try { await this.refresh(); this.notify({ previous: await this.previous() }) }
    catch (error) { this.notify({ error: '本机待发记录暂时无法读取；不会派发未核实的动作，系统会自动重试。' }); throw error }
    void this.synchronize()
  }
  private beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.unprotected.size || this.cancellationRequests.size) { event.preventDefault(); event.returnValue = '' }
  }
  async create(options: { requestId: string; receiver: ActionReceiverIdentity; evidence?: ActionInput['evidence']; objectIds?: string[] }) {
    // Capture all partitions before the first await. Later edits are independent from this input.
    const works = structuredClone(this.captureWorks())
    const scope = scopeFromKey(this.key)
    const input: FixedAction = actionInputSchema.parse({ requestId: options.requestId, scope, receiver: options.receiver, draft: this.draft.capture(),
      works: options.objectIds ? works.filter(file => options.objectIds!.includes(file.objectId)) : works, evidence: options.evidence ?? [] })
    if (options.objectIds?.some(id => !works.some(file => file.objectId === id))) throw new Error('所需作品已不在当前工作区。')
    return this.retainNew(input)
  }
  /**
   * An execution intent fixes its own basis only: the current works and the selected state file.
   * It never reads, sends or clears the question draft, and later edits cannot widen it.
   */
  async createExecution(options: { requestId: string; receiver: ActionReceiverIdentity
    execution: Omit<ExecutionAction['execution'], 'basis'> & { basis: Pick<ExecutionAction['execution']['basis'], 'state' | 'expected' | 'resources'> } }) {
    const works = structuredClone(this.captureWorks())
    const scope = scopeFromKey(this.key)
    const state = options.execution.basis.state
    // Only the state copy this run reads: unrelated saves must not change this input's digest,
    // and the command must stay inside the 4 MB wire budget.
    const cited = state ? works.filter(file => file.name === state.name && file.contentId === state.contentId) : []
    if (state && !cited.length) throw new Error('运行时使用的组件状态已不在当前工作区。')
    const input = fixedActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId: options.requestId, scope,
      receiver: options.receiver, execution: { ...options.execution, basis: { works: cited, state,
        expected: options.execution.basis.expected, resources: options.execution.basis.resources } } })
    return this.retainNew(input)
  }
  private async retainNew(input: FixedAction) {
    const entry: LocalAction = { key: JSON.stringify([this.key, input.requestId]), scope: this.key,
      input, phase: 'unprotected', cancelRequested: false, preparationAttempted: false, error: '' }
    const existing = this.unprotected.get(input.requestId)
    if (existing && !matches(existing.input, input)) throw new Error('同一动作身份不能改变内容。')
    this.unprotected.set(input.requestId, entry)
    try {
      const saved = await this.retain(entry)
      await this.refresh()
      void this.synchronize()
      return saved
    } catch (error) {
      if ((error as { code?: string }).code === 'identity-conflict') {
        this.unprotected.delete(input.requestId)
        await this.refresh(); throw error
      }
      this.notify({ error: '这次动作和依据尚未获得本机保护，未继续派发。请保留页面，可查看或复制原内容；系统会自动重试。',
        items: [...this.state.items.filter(item => item.input.requestId !== input.requestId), entry] })
      throw error
    }
  }
  private async retain(entry: LocalAction) {
    const saved = await this.store.change(this.key, entry.input.requestId, previous => {
      if (previous && !matches(previous.input, entry.input)) throw Object.assign(new Error('同一动作身份不能改变内容。'), { code: 'identity-conflict' })
      return previous ?? { ...entry, phase: this.cancellationRequests.has(entry.input.requestId) ? 'cancelled' : 'waiting-dependencies',
        cancelRequested: this.cancellationRequests.has(entry.input.requestId) }
    })
    this.unprotected.delete(entry.input.requestId)
    return saved
  }
  async read(requestId: string) {
    return (await this.store.list(this.key)).find(item => item.input.requestId === requestId)
      ?? this.unprotected.get(requestId) ?? null
  }
  async previous() {
    const scope = JSON.stringify(scopeFromKey(this.key))
    return (await this.store.list()).filter(item => item.scope !== this.key && JSON.stringify(item.input.scope) === scope)
  }
  async reconnect(requestId: string, previousKey = this.key) {
    if (JSON.stringify(scopeFromKey(previousKey)) !== JSON.stringify(scopeFromKey(this.key)))
      throw new Error('不能将动作接到其他空间、主体或活动。')
    const original = (await this.store.list(previousKey)).find(item => item.input.requestId === requestId)
    if (!original) throw new Error('原动作不可读。')
    if (isExecutionAction(original.input)) throw new Error('执行记录只能按原执行实例查询，不能接到其他接收方重跑。')
    if (original.input.receiver.location !== 'remote') throw new Error('本机旧交接必须由原执行能力核实，不能自动重跑。')
    const capabilities = await this.transport.capabilities()
    if (!capabilities.some(receiver => JSON.stringify(actionReceiverSchema.parse(receiver)) === JSON.stringify(original.input.receiver)))
      throw new Error('原接收能力尚未接入，旧动作继续保留。')
    let known = await this.transport.read(requestId)
    if (!known || !matches(original.input, known.input) || known.inputDigest !== await actionInputDigest(original.input))
      throw new Error('原主体、目标或请求结果尚未核实，不能另造身份继续。')
    const cancelled = original.cancelRequested || original.phase === 'cancelled'
    if (cancelled) {
      known = actionViewSchema.parse(await this.transport.cancel(requestId))
      if (!matches(original.input, known.input) || known.inputDigest !== await actionInputDigest(original.input))
        throw new Error('取消结果与原动作不符。')
    }
    await this.store.change(this.key, requestId, current => {
      if (current && !matches(current.input, original.input)) throw new Error('同一身份存在不同内容。')
      if (current && terminal(current)) return current
      return { ...original, key: JSON.stringify([this.key, requestId]), scope: this.key, remote: known,
        history: false, phase: cancelled && known!.state === 'prepared' ? 'cancelled' : known!.state === 'prepared' ? 'ready' : known!.state,
        cancelRequested: cancelled || known!.cancelRequested }
    })
    await this.refresh(); void this.synchronize()
  }
  async cancel(requestId: string) {
    if (!await this.read(requestId)) throw new Error('原动作不可读。')
    this.cancellationRequests.add(requestId)
    const key = requestId + ':cancel'
    const task = this.active.get(key) ?? this.cancelAction(requestId).then(() => {})
    this.active.set(key, task)
    try { await task } finally { if (this.active.get(key) === task) this.active.delete(key) }
    return (await this.read(requestId))!
  }
  private async cancelAction(requestId: string, reconcile = true) {
    const captured = this.unprotected.get(requestId)
    const cancelled = await this.store.change(this.key, requestId, saved => {
      const current = saved ?? captured
      if (!current) throw new Error('原动作不可读。')
      if (terminal(current)) return current
      // An explicit cancellation adopts history only for cancellation, never for dispatch.
      // Only an action that never reached its receiver can stop on local evidence alone;
      // a registered action keeps its phase until the original authority confirms the stop.
      const unsent = !current.remote && ['unprotected', 'waiting-dependencies'].includes(current.phase)
        && (current.input.receiver.location === 'local' || current.preparationAttempted === false)
      return { ...current, history: false, cancelRequested: true, phase: unsent ? 'cancelled' : current.phase }
    })
    this.unprotected.delete(requestId)
    this.cancellationRequests.delete(requestId)
    await this.refresh()
    if (!reconcile) return cancelled
    await this.reconcileCancellation(cancelled)
    await this.refresh()
    return (await this.read(requestId))!
  }
  private async reconcileCancellation(item: LocalAction) {
    if (!item.cancelRequested || item.history || this.stopped || this.accessDenied() || this.disposed
      || item.localReceipt || item.localAcceptance || item.remote && ['accepted', 'cancelled', 'failed'].includes(item.remote.state)) return
    try {
      if (isExecutionAction(item.input)) {
        const receiver = this.executionReceivers.get(JSON.stringify(item.input.receiver))
        if (!receiver) return
        const digest = await actionInputDigest(item.input)
        const acceptance = await receiver.cancel(item.input.requestId, digest)
        if (this.stopped || this.accessDenied() || this.disposed || !acceptance) return
        await this.storeLocalAcceptance(item, acceptance)
        return
      }
      if (item.input.receiver.location === 'local') {
        const receiver = this.localReceivers.get(JSON.stringify(item.input.receiver))
        if (!receiver) return
        const digest = await actionInputDigest(item.input)
        let receipt = await receiver.query(item.input.requestId, digest)
        if (this.stopped || this.accessDenied() || this.disposed) return
        receipt ??= await receiver.cancel(item.input.requestId, digest)
        if (receipt) await this.storeLocalReceipt(item, receipt)
      } else {
        // Preparation may have committed even when its response never reached this browser.
        const known = await this.transport.read(item.input.requestId)
        if (!known || this.stopped || this.accessDenied() || this.disposed) return
        await this.acceptRemote(item, ['prepared', 'dispatched'].includes(known.state)
          ? await this.transport.cancel(item.input.requestId) : known)
      }
    } catch (error) { this.rejectAccess(error) /* Keep the local stop and query the original authority on recovery. */ }
  }
  /** Periodic verification only re-queries the original authority; it never rewrites the recorded intent. */
  private verifyCancellation(item: LocalAction) {
    const key = item.input.requestId + ':cancel'
    const existing = this.active.get(key)
    if (existing) return existing
    const task = (async () => {
      try { await this.reconcileCancellation(item); await this.refresh() }
      catch { /* The recorded intent stays durable and is queried again on the next bounded tick. */ }
    })()
    // Tracked in the same lifetime used by maintenance drain, without re-entering cancel().
    this.active.set(key, task)
    return task.finally(() => { if (this.active.get(key) === task) this.active.delete(key) })
  }
  /** An authoritative view refreshes local facts; it never dispatches and never revives a local stop. */
  private async adoptAuthoritative(item: LocalAction, remote: ActionView) {
    // The fixed basis is decided locally, so an authority that disagrees cannot overwrite this record.
    if (remote.inputDigest !== await actionInputDigest(item.input) || !matches(item.input, remote.input)) return
    // An entry that is not durably retained yet is owned by this tick's retain loop, not by history.
    if (item.phase === 'unprotected') return
    await this.acceptRemote(item, remote)
  }
  private async storeLocalReceipt(item: LocalAction, value: unknown) {
    const receipt = actionReceiptSchema.parse(value)
    if (receipt.requestId !== item.input.requestId || receipt.inputDigest !== await actionInputDigest(item.input)
      || JSON.stringify(receipt.receiver) !== JSON.stringify(item.input.receiver)) throw new Error('接收回执与原动作不符。')
    return this.store.change(this.key, item.input.requestId, saved => {
      if (saved?.localReceipt && JSON.stringify(saved.localReceipt) === JSON.stringify(receipt)) return saved
      if (!saved || saved.phase !== 'dispatched' && !(saved.phase === 'cancelled' && saved.cancelRequested && !saved.localReceipt))
        throw new Error('动作尚未派发，不能接纳业务回执。')
      return { ...saved, localReceipt: receipt, phase: receipt.state === 'rejected' ? 'failed' : receipt.state, error: '' }
    })
  }
  /** Receipt callbacks are verified against the original registered authority, never trusted as bare JSON. */
  async acceptReceipt(requestId: string, value: ActionReceipt) {
    const current = await this.read(requestId)
    if (!current) throw new Error('原动作不可读。')
    if (current.input.receiver.location === 'local') {
      const receiver = this.localReceivers.get(JSON.stringify(current.input.receiver))
      if (!receiver) throw new Error('原接收能力尚未接入。')
      const known = await receiver.query(requestId, await actionInputDigest(current.input))
      if (!known || JSON.stringify(actionReceiptSchema.parse(known)) !== JSON.stringify(actionReceiptSchema.parse(value)))
        throw new Error('原接收方尚未确认此回执。')
      await this.storeLocalReceipt(current, known)
    } else {
      const known = await this.transport.read(requestId)
      if (!known?.receipt || JSON.stringify(actionReceiptSchema.parse(known.receipt)) !== JSON.stringify(actionReceiptSchema.parse(value)))
        throw new Error('原接收方尚未确认此回执。')
      await this.acceptRemote(current, known)
    }
    await this.refresh()
  }
  private async advanceLocal(item: LocalAction) {
    if (isExecutionAction(item.input)) return this.advanceLocalExecution(item, item.input)
    const receiver = this.localReceivers.get(JSON.stringify(item.input.receiver))
    if (!receiver || this.stopped || this.accessDenied() || terminal(item) || item.history || this.cancellationRequests.has(item.input.requestId)) return
    const current = await this.store.change(this.key, item.input.requestId, saved => {
      if (!saved) throw new Error('原动作不可读。')
      return terminal(saved) ? saved : { ...saved, phase: 'dispatched' }
    })
    if (terminal(current) || this.stopped || this.accessDenied() || this.cancellationRequests.has(item.input.requestId)) return
    const digest = await actionInputDigest(current.input)
    try {
      let receipt = await receiver.query(current.input.requestId, digest)
      if (this.stopped || this.accessDenied() || this.cancellationRequests.has(item.input.requestId)) return
      const latest = (await this.read(current.input.requestId))!
      if (this.stopped || this.accessDenied() || this.disposed || this.cancellationRequests.has(item.input.requestId)) return
      if (!receipt) receipt = latest.cancelRequested ? await receiver.cancel(current.input.requestId, digest)
        : await receiver.accept(questionPart(current.input), digest)
      if (receipt) await this.settleDraft(await this.storeLocalReceipt(current, receipt))
    } catch (error) { this.rejectAccess(error) /* Remains unknown and queries this exact authority on recovery. */ }
  }
  /**
   * Local handoff for an execution intent: accept is idempotent on its original identity, so a
   * lost reply is retried as the same request instead of a new one. A durable pre-accept block
   * always wins over a late acceptance.
   */
  private async advanceLocalExecution(item: LocalAction, action: ExecutionAction) {
    const receiver = this.executionReceivers.get(JSON.stringify(action.receiver))
    if (!receiver || this.stopped || this.accessDenied() || terminal(item) || item.history || this.cancellationRequests.has(action.requestId)) return
    const current = await this.store.change(this.key, action.requestId, saved => {
      if (!saved) throw new Error('原动作不可读。')
      return terminal(saved) ? saved : { ...saved, phase: 'dispatched' }
    })
    if (terminal(current) || this.stopped || this.accessDenied() || this.cancellationRequests.has(action.requestId)) return
    const digest = await actionInputDigest(action)
    try {
      if (await receiver.blocked(action.requestId, digest)) {
        const blocked = rejectedExecutionAcceptance(action.requestId, digest, action.receiver, '接收前已取消，不会再接受。')
        await this.storeLocalAcceptance(current, { ...blocked, receipt: { ...blocked.receipt, state: 'cancelled' } })
        return
      }
      const acceptance = await receiver.accept(action, digest)
      await this.storeLocalAcceptance(current, acceptance)
    } catch (error) { this.rejectAccess(error) /* Remains unknown and queries this exact receiver on recovery. */ }
  }
  private async storeLocalAcceptance(item: LocalAction, value: unknown) {
    const acceptance = executionAcceptanceSchema.parse(value)
    if (acceptance.receipt.requestId !== item.input.requestId || acceptance.receipt.inputDigest !== await actionInputDigest(item.input)
      || JSON.stringify(acceptance.receipt.receiver) !== JSON.stringify(item.input.receiver)) throw new Error('执行接收回执与原动作不符。')
    return this.store.change(this.key, item.input.requestId, saved => {
      if (saved?.localAcceptance && JSON.stringify(saved.localAcceptance) === JSON.stringify(acceptance)) return saved
      if (!saved || saved.phase !== 'dispatched' && !(saved.phase === 'cancelled' && saved.cancelRequested && !saved.localAcceptance))
        throw new Error('动作尚未派发，不能接纳执行回执。')
      return { ...saved, localAcceptance: acceptance, error: '',
        phase: acceptance.receipt.state === 'rejected' ? 'failed' : acceptance.receipt.state }
    })
  }
  private async run(item: LocalAction) {
    // One action is never dispatched and cancelled at the same time; cancellation keeps its own mutex.
    if (this.active.has(item.input.requestId) || this.active.has(item.input.requestId + ':cancel')
      || this.cancellationRequests.has(item.input.requestId)) return
    const task = item.input.receiver.location === 'local' ? this.advanceLocal(item) : this.advance(item)
    this.active.set(item.input.requestId, task)
    try { await task } finally { this.active.delete(item.input.requestId) }
  }
  async recover(requestId: string) {
    const saved = await this.store.change(this.key, requestId, current => {
      if (!current || !['cancelled', 'failed'].includes(current.phase)) throw new Error('请先核实原动作的结果。')
      if (isExecutionAction(current.input)) throw new Error('执行动作不提供恢复为问题草稿。')
      if (current.recovered) return current
      const { token: _token, ...content } = structuredClone(current.input.draft)
      return { ...current, recovered: { ...content, draftId: crypto.randomUUID() } }
    })
    await this.refresh(); return saved.recovered!
  }
  async mergeRecovered(requestId: string) {
    const item = await this.read(requestId)
    if (!item?.recovered) throw new Error('请先取回独立草稿。')
    const current = this.draft.capture(), recovered = item.recovered
    const references = [...current.references]
    for (const reference of recovered.references) {
      if (references.some(other => questionReferenceKey(other) === questionReferenceKey(reference))) continue
      references.push({ ...reference, referenceId: references.some(other => other.referenceId === reference.referenceId)
        ? crypto.randomUUID() : reference.referenceId })
    }
    const question = questionTextSchema.parse([current.question, recovered.question].filter(Boolean).join('\n\n'))
    this.draft.change(question, questionReferencesSchema.parse(references), recovered.bases)
    await this.draft.protect()
  }
  private async acceptRemote(item: LocalAction, value: unknown) {
    const remote = actionViewSchema.parse(value)
    if (!matches(item.input, remote.input) || remote.inputDigest !== await actionInputDigest(item.input))
      throw Object.assign(new Error('回执与固定依据不符。'), { code: 'corrupt' })
    return this.store.change(this.key, item.input.requestId, saved => {
      const current = saved ?? item
      // A locally confirmed unsent cancellation can never be revived by a late preparation reply.
      if (current.phase === 'cancelled' && remote.state === 'prepared') return current.remote ? current : { ...current, remote }
      const confirmed = current.localReceipt || current.remote && ['accepted', 'cancelled', 'failed'].includes(current.remote.state)
      if (terminal(current) && current.phase !== remote.state && !(current.phase === 'cancelled' && current.cancelRequested && !confirmed)) return current
      const phase = remote.state === 'prepared' ? 'ready' : remote.state
      const cancelRequested = current.cancelRequested || remote.cancelRequested
      // Identical facts must not open another durable transaction on every bounded tick.
      if (current.phase === phase && current.cancelRequested === cancelRequested && !current.error
        && current.remote && JSON.stringify(current.remote) === JSON.stringify(remote)) return current
      return { ...current, remote, phase, cancelRequested, error: '' }
    })
  }
  private async settleDraft(item: LocalAction) {
    // An execution action never touched the draft, so there is nothing to acknowledge.
    if (isExecutionAction(item.input)) return
    if (item.phase !== 'accepted' || item.draftSettled || item.history || this.stopped || this.disposed) return
    try {
      this.draft.acknowledge(item.input.draft.token)
      // The durable marker must never get ahead of the draft transaction it describes.
      await this.draft.protect()
      await this.store.change(this.key, item.input.requestId, saved => {
        if (!saved) throw new Error('原接收记录不可读。')
        return saved.phase === 'accepted' ? { ...saved, draftSettled: true } : saved
      })
    } catch { /* The draft reports protection failures; the original receipt stays unsettled for recovery. */ }
  }
  private async advance(item: LocalAction) {
    let current = (await this.read(item.input.requestId))!
    if (terminal(current) || current.history || this.stopped || this.accessDenied() || this.cancellationRequests.has(item.input.requestId)) return
    try {
      const remote = await this.transport.read(current.input.requestId)
      if (this.stopped || this.accessDenied()) return
      if (!remote) {
        // Once preparation can reach the owner, a lost ACK is an unknown result, not proof of no send.
        current = await this.store.change(this.key, current.input.requestId, saved => {
          if (!saved) throw new Error('原动作不可读。')
          return terminal(saved) || saved.cancelRequested ? saved : { ...saved, preparationAttempted: true }
        })
        if (terminal(current) || current.cancelRequested || this.stopped || this.accessDenied()
          || this.cancellationRequests.has(item.input.requestId)) return
      }
      current = await this.acceptRemote(current, remote ?? await this.transport.prepare(questionPart(current.input)))
      if (terminal(current) || this.stopped || this.accessDenied() || this.cancellationRequests.has(item.input.requestId)) {
        if (current.phase === 'cancelled' && !this.stopped && !this.denied && current.remote?.state === 'prepared')
          await this.transport.cancel(current.input.requestId)
        return
      }
      current = await this.store.change(this.key, current.input.requestId, saved => {
        if (!saved) throw new Error('原动作不可读。')
        return terminal(saved) ? saved : { ...saved, phase: 'dispatched' }
      })
      if (terminal(current) || this.stopped || this.accessDenied() || this.cancellationRequests.has(item.input.requestId)) return
      current = await this.acceptRemote(current, current.cancelRequested
        ? await this.transport.cancel(current.input.requestId) : await this.transport.dispatch(current.input.requestId))
      await this.settleDraft(current)
    } catch (error) {
      const code = (error as { code?: string }).code
      if (this.rejectAccess(error)) { /* Reauthorization is checked against the original route. */ }
      else if (code && !['unavailable', 'maintenance', 'commit-unknown'].includes(code)) {
        await this.store.change(this.key, item.input.requestId, saved => {
          const current = saved ?? item
          return { ...current, phase: ['invalid', 'identity-conflict'].includes(code) && ['waiting-dependencies', 'ready'].includes(current.phase)
            ? 'failed' : current.phase, error: '原动作尚未完成核实：' + code }
        })
      }
    }
  }
  private async synchronize() {
    if (this.disposed) return
    try {
      for (const entry of this.unprotected.values()) {
        try { await this.retain(entry) }
        catch (error) { if ((error as { code?: string }).code === 'identity-conflict') this.unprotected.delete(entry.input.requestId) }
      }
      for (const requestId of this.cancellationRequests) {
        try { await this.cancelAction(requestId, false) } catch { /* Keep suppressing dispatch until cancellation is durable. */ }
      }
      await this.refresh()
      if (this.stopped) return
      if (this.access.denied()) this.rejectAccess()
      if (this.denied) {
        // Probe only the original bound activity. A different login/namespace cannot authorize this route.
        try { await this.transport.capabilities() } catch { return }
        if (this.stopped) return
        this.access.confirmed(); this.denied = false; this.notify({ active: true })
      }
      // Resume a previously accepted draft before querying any unrelated receiver or capability.
      for (const item of this.state.items.filter(item => item.phase === 'accepted' && !item.draftSettled && !item.history)) {
        await this.settleDraft(item)
      }
      const pendingCancellations = this.state.items.filter(item => item.cancelRequested && !item.history && !item.localReceipt
        && !['accepted', 'cancelled', 'failed'].includes(item.remote?.state ?? ''))
      // Each cancellation holds only its own action's mutex, so unrelated local handoffs keep moving.
      const cancellations = pendingCancellations.map(item => this.verifyCancellation(item))
      // Local handoff must not wait for any remote capability or dependency query.
      await Promise.all(this.state.items.filter(item => item.input.receiver.location === 'local').map(item => this.run(item)))
      let history: ActionView[] = []
      try {
        const receivers = await this.transport.capabilities()
        if (this.stopped || this.accessDenied()) return
        this.notify({ receivers: [...receivers, ...[...this.localReceivers.values()].map(item => item.identity)] })
        history = await this.transport.list()
      } catch (error) { if (this.rejectAccess(error)) return /* Network outage alone does not revoke local access. */ }
      for (const remote of history) {
        if (JSON.stringify(remote.input.scope) !== JSON.stringify(scopeFromKey(this.key))) continue
        const found = await this.read(remote.input.requestId)
        // An existing record adopts the authoritative facts instead of staying frozen at import time.
        if (found) { await this.adoptAuthoritative(found, remote); continue }
        const input = actionInputSchema.parse(remote.input)
        await this.store.change(this.key, input.requestId, saved => saved ?? { key: JSON.stringify([this.key, input.requestId]),
          scope: this.key, input, phase: remote.state === 'prepared' ? 'ready' : remote.state,
          cancelRequested: remote.cancelRequested, remote: actionViewSchema.parse(remote), history: true, error: '' })
      }
      await Promise.all(this.state.items.filter(item => item.input.receiver.location === 'remote' && !terminal(item) && !item.history).map(item => this.run(item)))
      await this.refresh()
      // Cancellation queries stay tracked for maintenance drain, independently of unrelated handoffs.
      await Promise.all(cancellations)
      if (!this.unprotected.size && !this.denied) this.notify({ error: '' })
    } catch { /* Retain contents and retry from the same identity on the next bounded tick. */ }
  }
  suspend() { this.stopped = true; this.notify({ active: false }) }
  resume() { this.stopped = false; this.notify({ active: !this.accessDenied() }); void this.synchronize() }
  async leave() {
    for (const entry of this.unprotected.values()) await this.retain(entry)
    for (const requestId of this.cancellationRequests) await this.cancelAction(requestId, false)
  }
  async drain() { this.suspend(); await Promise.allSettled([...this.active.values()]) }
  dispose() { this.disposed = true; this.suspend(); if (this.timer) clearInterval(this.timer)
    window.removeEventListener('beforeunload', this.beforeUnload); this.listeners.clear() }
}
