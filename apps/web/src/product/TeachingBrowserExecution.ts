import { actionReceiptSchema } from '@xunjie/contracts/action-intents'
import { executionAcceptanceSchema, anyExecutionActionSchema, agentBrowserIdSchema, agentBrowserClaimInputSchema,
  agentBrowserCommandSchema, agentBrowserPendingSchema, agentBrowserStopsSchema,
  isTerminalExecutionState, type ExecutionAcceptance, type AnyExecutionAction } from '@xunjie/contracts/execution'
import { BrowserExecutionReceiver } from '../tool-execution/receiver'
import type { ExecutionController } from '../tool-execution/controller'
import type { AlgorithmProvider } from '../tool-execution/adapters'
import type { ExecutionTransport } from '../tool-execution/retention'
import { AlgorithmError } from '../tool-execution/algorithm'

const browserKey = 'xj:teaching-browser-id'
type Request = (route: string, body?: unknown) => Promise<unknown>

/** Same-origin tabs share one durable browser node; a cleared profile is a different node. */
export async function teachingBrowserId(): Promise<string> {
  if (!navigator.locks) throw new Error('当前浏览器无法可靠协调 Agent 实验。')
  return navigator.locks.request(browserKey, () => {
    const saved = localStorage.getItem(browserKey)
    if (saved) return agentBrowserIdSchema.parse(saved)
    const id = crypto.randomUUID()
    localStorage.setItem(browserKey, id)
    return id
  })
}

async function actionDigest(action: AnyExecutionAction) {
  // The execution owner's digest is of the schema-normalized action, not canonical JSON.
  const bytes = new TextEncoder().encode(JSON.stringify(anyExecutionActionSchema.parse(action)))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Agent delivery uses the existing durable receiver, admission budgets, Worker and result store. */
export class TeachingBrowserExecution extends BrowserExecutionReceiver {
  private closed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(scope: string, generation: number, private request: Request, private transport: ExecutionTransport,
    private allowed: () => boolean, private activityId: string,
    current?: ConstructorParameters<typeof BrowserExecutionReceiver>[4]) {
    super({ receiverId: 'browser-execution', location: 'local', kind: 'execution' }, scope, generation, allowed, current)
  }
  private assertOpen() { if (this.closed || !this.allowed()) throw new Error('forbidden') }
  private verify(action: AnyExecutionAction) {
    const scope = JSON.parse(this.scope) as string[]
    if (action.execution.initiator.kind !== 'agent' || action.execution.plan.location !== 'browser'
      || action.scope.activityId !== this.activityId || action.scope.environmentId !== scope[1]
      || action.scope.spaceId !== scope[2] || action.scope.principalId !== scope[3]) throw new Error('forbidden')
  }
  private async claimCommand(action: AnyExecutionAction) {
    this.assertOpen(); this.verify(action)
    const value = agentBrowserCommandSchema.parse(await this.request(`agent/${action.requestId}/claim`,
      agentBrowserClaimInputSchema.parse({ browserId: await teachingBrowserId() })))
    this.assertOpen(); this.verify(value.action)
    if (value.association.commandId !== action.requestId || await actionDigest(value.action) !== await actionDigest(action))
      throw new Error('identity-conflict')
  }
  /** Before a Worker can start, both owners have durably accepted the same original identity. */
  override async accept(action: AnyExecutionAction, inputDigest: string): Promise<ExecutionAcceptance> {
    if (action.execution.initiator.kind !== 'agent') return super.accept(action, inputDigest)
    await this.claimCommand(action)
    if (await actionDigest(action) !== inputDigest) throw new Error('identity-conflict')
    this.assertOpen()
    const record = await this.store.accept(this.scope, action, inputDigest, executionAcceptanceSchema.parse({
      receipt: actionReceiptSchema.parse({ requestId: action.requestId, inputDigest, receiver: action.receiver,
        state: 'accepted', receiptId: 'browser:' + action.requestId, detail: '已在本机可靠保存命令与待处理事实。' }),
      execution: { executionRef: crypto.randomUUID(), acceptedSeq: 1 },
    }), this.generation)
    const remote = await this.transport.accept(action, record.acceptance)
    this.assertOpen()
    if (remote.requestId !== action.requestId || remote.inputDigest !== inputDigest || remote.executionRef !== record.executionRef)
      throw new Error('identity-conflict')
    if (remote.stopRequested) await this.requestStop(record, '原 Agent 已请求停止。', action.requestId)
    await this.adopt(action.requestId)
    // The base receiver emits the controller's start notification only after the server reply.
    return super.accept(action, inputDigest)
  }
  withProvider(provider: AlgorithmProvider): AlgorithmProvider {
    return { load: async action => {
      if (action.execution.initiator.kind === 'agent') {
        await this.claimCommand(action)
        const record = await this.store.read(this.scope, action.requestId)
        if (!record) throw new Error('missing')
        const remote = await this.transport.accept(action, record.acceptance)
        this.assertOpen()
        if (remote.stopRequested) {
          await this.requestStop(record, '原 Agent 已请求停止。', action.requestId)
          throw new AlgorithmError('worker-terminated', '原 Agent 已请求停止，未启动新的计算。')
        }
      }
      return provider.load(action)
    } }
  }
  /** Queries and retransmission retain original IDs; they never start an abandoned Worker again. */
  connect(controller: ExecutionController) {
    const tick = async () => {
      if (this.closed) return
      try {
        this.assertOpen()
        const stops = agentBrowserStopsSchema.parse(await this.request('agent-stops/' + await teachingBrowserId()))
        for (const item of stops) {
          this.assertOpen()
          if (item.association.commandId !== item.requestId) throw new Error('identity-conflict')
          const local = await this.store.read(this.scope, item.requestId)
          // A broker always saves before executing. Without that record there is no local
          // Worker to stop; an included original action also permits a durable pre-accept block.
          const action = item.action ?? local?.action
          if (!action) continue
          this.verify(action)
          if (action.requestId !== item.requestId) throw new Error('identity-conflict')
          const digest = await actionDigest(action)
          if (local) {
            if (local.inputDigest !== digest) throw new Error('identity-conflict')
            if (isTerminalExecutionState(local.query.state) && local.query.statusKnowledge === 'confirmed') continue
            await this.requestStop(local, item.stop.reason, item.stop.stopId)
            const latest = await this.store.read(this.scope, item.requestId)
            if (latest && !isTerminalExecutionState(latest.query.state)) {
              if (latest.startedAt === null) {
                await this.adopt(item.requestId)
                await this.finish(item.requestId, { state: 'cancelled', stopped: true,
                  reason: { code: 'worker-terminated', detail: '原 Agent 请求开始前停止。' } })
              } else await controller.stop(item.requestId, item.stop.stopId, digest)
            }
          } else await this.store.stop({ scope: this.scope, requestId: item.requestId, inputDigest: digest,
            stopId: item.stop.stopId, reason: item.stop.reason, state: 'confirmed', at: Date.now() })
        }
        for (const record of await this.store.list(this.scope)) {
          if (record.action.execution.initiator.kind !== 'agent') continue
          this.assertOpen()
          if (!isTerminalExecutionState(record.query.state)) await controller.query(record.requestId, record.inputDigest)
          const latest = await this.store.read(this.scope, record.requestId)
          if (latest) {
            await controller.syncPending(record.requestId)
            if (latest.startedAt === null && !latest.query.stopRequested && !isTerminalExecutionState(latest.query.state))
              await this.accept(latest.action, latest.inputDigest).catch(() => {})
          }
        }
        const pending = agentBrowserPendingSchema.parse(await this.request('agent-pending'))
        for (const item of pending) {
          this.assertOpen(); this.verify(item.action)
          if (item.association.commandId !== item.action.requestId) throw new Error('identity-conflict')
          const local = await this.store.read(this.scope, item.action.requestId)
          if (local?.startedAt !== undefined && local.startedAt !== null) continue
          // Claim denials or a stop block affect this command; independent pending work can proceed.
          await this.accept(item.action, await actionDigest(item.action)).catch(() => {})
        }
      } catch { /* A disconnected, revoked or unavailable owner cannot authorize new work. */ }
      finally { if (!this.closed) this.timer = setTimeout(() => void tick(), 1000) }
    }
    void tick()
    return () => { this.closed = true; if (this.timer) clearTimeout(this.timer) }
  }
}
