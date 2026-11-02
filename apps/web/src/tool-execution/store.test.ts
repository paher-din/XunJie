import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { executionAcceptanceSchema, executionActionSchema, type ExecutionAction } from '@xunjie/contracts/execution'
import type { ActionReceiverIdentity } from '@xunjie/contracts/action-intents'
import { AlgorithmError } from './algorithm'
import { ExecutionController } from './controller'
import { BrowserExecutionReceiver } from './receiver'
import { ExecutionStore } from './store'

const identity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(),
  activityId: crypto.randomUUID() }
const scope = JSON.stringify(['school', identity.environmentId, identity.spaceId, identity.principalId, identity.activityId])
const stateContent = { formatVersion: 1, instanceId: identity.activityId + ':table', componentId: crypto.randomUUID(), version: 1,
  definitionDigest: 'a'.repeat(64), stateVersion: 1, operationId: crypto.randomUUID(),
  content: { table: { columns: ['小组', '得分'], rows: [['A', '88']] }, parameters: { aggregate: 'sum' } } }
const stateFile = { objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: 'components/table.json',
  kind: 'state' as const, encoding: 'json' as const, mediaType: 'application/vnd.xunjie.component-state+json',
  value: JSON.stringify(stateContent) }
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function actionOf(requestId: string, parameters: Record<string, unknown> = { groupColumn: '小组', valueColumn: '得分',
  aggregate: 'sum' }): ExecutionAction {
  return executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId,
    scope: identity,
    receiver: { receiverId: 'browser-execution', location: 'local', kind: 'execution' },
    execution: {
      instance: { instanceId: identity.activityId + ':table', key: 'table', componentId: stateContent.componentId, componentVersion: 1,
        definitionDigest: 'a'.repeat(64), hostApiVersion: 1, stateVersion: 1 },
      operation: { operationId: 'aggregate', effect: 'execute' }, parameters,
      basis: { works: [stateFile], state: { name: stateFile.name, contentId: stateFile.contentId,
        sha256: sha256(stateContent) }, expected: { stateContentId: stateFile.contentId },
        resources: [{ kind: 'entry', resourceId: crypto.randomUUID(), sha256: 'b'.repeat(64), byteLength: 120, mediaType: 'text/html' },
          { kind: 'algorithm', resourceId: crypto.randomUUID(), sha256: 'c'.repeat(64), byteLength: 270, mediaType: 'application/wasm' }] },
      limits: { timeMs: 5000, memoryPages: 256, inputBytes: 1048576, outputBytes: 65536, concurrentJobs: 1, queuedJobs: 4 },
      plan: { planId: 'browser-job', planVersion: 1, location: 'browser', kind: 'job',
        planDigest: sha256({ planId: 'browser-job', planVersion: 1, componentId: stateContent.componentId,
          componentVersion: 1, operationId: 'aggregate' }) },
      initiator: { kind: 'student', principalId: identity.principalId } } })
}
const digestOf = (action: ExecutionAction) => createHash('sha256').update(JSON.stringify(action)).digest('hex')
function acceptanceOf(action: ExecutionAction, executionRef = crypto.randomUUID()) {
  return executionAcceptanceSchema.parse({ receipt: { requestId: action.requestId, inputDigest: digestOf(action),
    receiver: action.receiver, state: 'accepted', receiptId: 'browser:' + action.requestId, detail: '已在本机可靠保存命令与待处理事实。' },
    execution: { executionRef, acceptedSeq: 1 } })
}

describe('the browser execution ledger keeps one command per identity', () => {
  it('stores the command under the workspace scope every later read, list and result lookup uses', async () => {
    const store = new ExecutionStore(), action = actionOf(crypto.randomUUID()), acceptance = acceptanceOf(action)
    const stored = await store.accept(scope, action, digestOf(action), acceptance, 1)
    expect(stored.scope).toBe(scope)
    // The command is readable by the same scope string the controller queries with.
    expect((await store.read(scope, action.requestId))?.acceptance).toEqual(acceptance)
    expect((await store.list(scope)).map(record => record.requestId)).toContain(action.requestId)
    expect(await store.read('["other"]', action.requestId)).toBeUndefined()
  })
  it('returns the original acceptance for a duplicate and refuses changed input under one identity', async () => {
    const store = new ExecutionStore(), action = actionOf(crypto.randomUUID()), acceptance = acceptanceOf(action)
    const first = await store.accept(scope, action, digestOf(action), acceptance, 1)
    const again = await store.accept(scope, action, digestOf(action), acceptanceOf(action), 2)
    expect(again.createdAt).toBe(first.createdAt)
    expect(again.acceptance).toEqual(first.acceptance)
    await expect(store.accept(scope, actionOf(action.requestId, { groupColumn: '小组', valueColumn: '得分', aggregate: 'mean' }),
      'd'.repeat(64), acceptance, 1)).rejects.toMatchObject({ code: 'identity-conflict' })
  })
  it('lets a durable pre-accept blank refuse a late acceptance of the same request', async () => {
    const store = new ExecutionStore(), action = actionOf(crypto.randomUUID())
    await store.stop({ scope, stopId: crypto.randomUUID(), requestId: action.requestId, inputDigest: digestOf(action),
      reason: '接收前取消。', state: 'confirmed', at: Date.now() })
    await expect(store.accept(scope, action, digestOf(action), acceptanceOf(action), 1))
      .rejects.toMatchObject({ code: 'cancelled' })
    expect(await store.read(scope, action.requestId)).toBeUndefined()
  })
  it('keeps a confirmed terminal fact when a late progress fact arrives with an older sequence', async () => {
    const store = new ExecutionStore(), action = actionOf(crypto.randomUUID()), acceptance = acceptanceOf(action)
    await store.accept(scope, action, digestOf(action), acceptance, 1)
    const finished = await store.record(scope, action.requestId, current => ({ ...current, state: 'succeeded',
      confirmedSeq: 5, output: { contentId: crypto.randomUUID(), output: { rows: 1, groups: [], value: 88 },
        artifact: { name: '聚合结果-sum.csv', mediaType: 'text/csv;charset=utf-8', byteLength: 40, sha256: 'e'.repeat(64) } } }))
    expect(finished.query.state).toBe('succeeded')
    const late = await store.record(scope, action.requestId, current => ({ ...current, state: 'failed', confirmedSeq: 4,
      reason: { code: 'algorithm-error', detail: '迟到的失败回执。' } }))
    expect(late.query.state).toBe('succeeded')
    expect(late.query.output?.output).toEqual({ rows: 1, groups: [], value: 88 })
  })
  it('gives a run exactly one executor and refuses facts from a page that lost it', async () => {
    const store = new ExecutionStore(), action = actionOf(crypto.randomUUID())
    await store.accept(scope, action, digestOf(action), acceptanceOf(action), 7)
    // A different page may not claim a command it did not accept.
    expect(await store.claim(scope, action.requestId, 8, Date.now())).toBeNull()
    const claimed = await store.claim(scope, action.requestId, 7, Date.now())
    expect([claimed?.query.state, claimed?.startedAt === null]).toEqual(['running', false])
    // One claim per run: a second start of the same command is impossible.
    expect(await store.claim(scope, action.requestId, 7, Date.now())).toBeNull()
    await expect(store.record(scope, action.requestId, current => ({ ...current, state: 'succeeded', confirmedSeq: 9 }), {}, 8))
      .rejects.toMatchObject({ code: 'stale-generation' })
    // A stop request is not an executor fact, so the page showing the record can still stop it.
    expect((await store.record(scope, action.requestId, current => ({ ...current, stopRequested: true,
      confirmedSeq: current.confirmedSeq + 1 }))).query.stopRequested).toBe(true)
  })
  it('lets a newer page adopt only a command that never started', async () => {
    const store = new ExecutionStore(), unstarted = actionOf(crypto.randomUUID()), started = actionOf(crypto.randomUUID())
    await store.accept(scope, unstarted, digestOf(unstarted), acceptanceOf(unstarted), 1)
    await store.accept(scope, started, digestOf(started), acceptanceOf(started), 1)
    await store.claim(scope, started.requestId, 1, Date.now())
    expect(await store.adopt(scope, unstarted.requestId, 2)).toBe(true)
    expect(await store.claim(scope, unstarted.requestId, 2, Date.now())).not.toBeNull()
    // A run that already produced effects keeps its owner; a new page only reports unknown.
    expect(await store.adopt(scope, started.requestId, 2)).toBe(false)
    expect((await store.read(scope, started.requestId))?.generation).toBe(1)
  })
  it('keeps result bytes readable only through the execution reference that produced them', async () => {
    const store = new ExecutionStore(), action = actionOf(crypto.randomUUID()), acceptance = acceptanceOf(action)
    const stored = await store.accept(scope, action, digestOf(action), acceptance, 1)
    await store.result({ scope, executionRef: stored.executionRef, requestId: action.requestId, name: '聚合结果-sum.csv',
      mediaType: 'text/csv;charset=utf-8', sha256: 'f'.repeat(64), byteLength: 18, text: '小组,计数\nA,1\n', output: {}, at: Date.now() })
    expect((await store.readResult(scope, stored.executionRef))?.text).toBe('小组,计数\nA,1\n')
    expect(await store.readResult(scope, crypto.randomUUID())).toBeUndefined()
  })
})

describe('the execution controller owns the real worker lifetime', () => {
  const identityReceiver: ActionReceiverIdentity = { receiverId: 'browser-execution', location: 'local', kind: 'execution' }
  const scopeKey = JSON.stringify(['school', identity.environmentId, identity.spaceId, identity.principalId, identity.activityId])
  const offline = { accept: async () => { throw new Error('offline') }, report: async () => { throw new Error('offline') },
    stop: async () => { throw new Error('offline') }, result: async () => { throw new Error('offline') },
    read: async () => { throw new Error('offline') } }
  const provider = { load: async () => ({ bytes: new ArrayBuffer(8), entry: 'aggregate', memoryPages: 1,
    result: { type: 'number' } as const }) }
  const until = async (check: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 300; attempt++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)) }
    throw new Error('等待执行状态超时。')
  }
  function controller(receiver: BrowserExecutionReceiver, signal: { current: AbortSignal | null }) {
    const actions = { async createExecution(options: { requestId: string; receiver: ActionReceiverIdentity
      execution: ExecutionAction['execution'] }) {
      const action = executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId: options.requestId,
        scope: identity, receiver: options.receiver, execution: options.execution })
      await receiver.accept(action, digestOf(action))
      return action
    }, async cancel() { return null } }
    // A real dedicated worker is never settled here: only the confirmed stop can end it.
    const run = (_job: unknown, abort: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal.current = abort
      abort.addEventListener('abort', () => reject(new AlgorithmError('worker-terminated', '执行线程已终止。')))
    })
    return new ExecutionController(scopeKey, receiver, actions, offline as never, provider, run as never)
  }
  it('stops a live worker, keeps the original acceptance and records the real terminal fact', async () => {
    const receiver = new BrowserExecutionReceiver(identityReceiver, scopeKey, 1)
    const signal: { current: AbortSignal | null } = { current: null }
    const execution = controller(receiver, signal)
    const requestId = crypto.randomUUID(), action = actionOf(requestId)
    await execution.submit(action)
    await until(async () => (await receiver.store.read(scopeKey, requestId))?.startedAt !== null)
    const accepted = (await receiver.store.read(scopeKey, requestId))!
    await execution.stop(requestId)
    await until(async () => ['cancelled', 'failed'].includes((await receiver.store.read(scopeKey, requestId))!.query.state))
    const stopped = (await receiver.store.read(scopeKey, requestId))!
    expect([stopped.query.state, stopped.query.stopRequested, signal.current?.aborted]).toEqual(['cancelled', true, true])
    // Stopping names the original run: the acceptance is byte-identical to what was accepted.
    expect(stopped.acceptance).toEqual(accepted.acceptance)
    // A late success from the aborted worker cannot overwrite the confirmed cancellation.
    const late = await receiver.finish(requestId, { state: 'succeeded', output: { contentId: crypto.randomUUID(),
      output: { rows: 1 }, artifact: { name: 'a.csv', mediaType: 'text/csv', byteLength: 1, sha256: 'a'.repeat(64) } } })
    expect(late.query.state).toBe('cancelled')
    execution.dispose()
  })
  it('reports an unknown request as empty instead of inventing a run', async () => {
    const receiver = new BrowserExecutionReceiver(identityReceiver, scopeKey, 5)
    const execution = controller(receiver, { current: null })
    expect(await execution.query(crypto.randomUUID())).toBeNull()
    execution.dispose()
  })
  it('answers only the input a query pins, and repeats one stop identity instead of inventing another', async () => {
    const receiver = new BrowserExecutionReceiver(identityReceiver, scopeKey, 7)
    const execution = controller(receiver, { current: null })
    const requestId = crypto.randomUUID(), action = actionOf(requestId)
    await execution.submit(action)
    const stored = (await receiver.store.read(scopeKey, requestId))!
    // A query that pins a different input is not asking about this run.
    expect(await execution.query(requestId, 'd'.repeat(64))).toBeNull()
    expect((await execution.query(requestId, stored.inputDigest))?.requestId).toBe(requestId)
    // The caller's stop identity is the one recorded, so a retry cannot create a second stop.
    const stopId = '9c9c9c9c-9c9c-4c9c-8c9c-9c9c9c9c9c9c'
    await execution.stop(requestId, stopId)
    await execution.stop(requestId, stopId)
    expect((await receiver.store.stops(scopeKey)).filter(stop => stop.requestId === requestId).map(stop => stop.stopId)).toEqual([stopId])
    execution.dispose()
  })
})
