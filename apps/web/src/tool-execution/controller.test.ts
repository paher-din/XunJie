import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { executionActionSchema, type ExecutionAction } from '@xunjie/contracts/execution'
import { AlgorithmError, type AggregationOutcome } from './algorithm'
import { ExecutionController, type AlgorithmProvider, type RunAlgorithm } from './controller'
import { BrowserExecutionReceiver } from './receiver'
import type { ExecutionTransport } from './retention'

const identity = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(),
  activityId: crypto.randomUUID() }
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const outcome: AggregationOutcome = { result: { rows: 1, aggregate: 'sum', groupColumn: '小组', valueColumn: '得分', groups: [], value: 88, rejected: [] },
  artifact: { name: 'result.csv', mediaType: 'text/csv', text: 'A,88' } }
const controllers: ExecutionController[] = []
const offline: ExecutionTransport = { accept: async () => { throw new Error('offline') },
  report: async () => { throw new Error('offline') }, stop: async () => { throw new Error('offline') },
  result: async () => { throw new Error('offline') }, read: async () => { throw new Error('offline') } }
const provider: AlgorithmProvider = { load: async () => ({ bytes: new ArrayBuffer(8), entry: 'aggregate', memoryPages: 1,
  result: { type: 'object', properties: { rows: { type: 'number' }, groups: { type: 'array', maxItems: 100, items: { type: 'number' } },
    value: { type: 'number' }, aggregate: { type: 'string', maxLength: 100 }, groupColumn: { type: 'string', maxLength: 100 },
    valueColumn: { type: 'string', maxLength: 100 }, rejected: { type: 'array', maxItems: 100, items: { type: 'number' } } } } }) }
const liveRunner = () => {
  let signal: AbortSignal | undefined
  const run: RunAlgorithm = (_job, abort) => new Promise((_resolve, reject) => {
    signal = abort
    const stop = () => reject(new AlgorithmError('worker-terminated', '执行线程已终止。'))
    if (abort.aborted) stop()
    else abort.addEventListener('abort', stop, { once: true })
  })
  return { run, signal: () => signal }
}
function setup(options: { scope?: string; generation?: number; run?: RunAlgorithm; provider?: AlgorithmProvider;
  canAccess?: () => boolean; transport?: ExecutionTransport } = {}) {
  const receiver = new BrowserExecutionReceiver(actionOf(crypto.randomUUID()).receiver,
    options.scope ?? crypto.randomUUID(), options.generation ?? 1)
  const actions = { createExecution: vi.fn(async (input: { requestId: string; receiver: ExecutionAction['receiver'];
    execution: ExecutionAction['execution'] }) => {
    const action = executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', scope: identity, ...input })
    return receiver.accept(action, digestOf(action))
  }), cancel: vi.fn(async () => null) }
  const controller = new ExecutionController(receiver.scope, receiver, actions, options.transport ?? offline,
    options.provider ?? provider, options.run ?? (async () => outcome), options.canAccess ?? (() => true))
  controllers.push(controller)
  const read = (requestId: string) => receiver.store.read(receiver.scope, requestId)
  return { controller, receiver, actions, read }
}
const until = async (check: () => unknown | Promise<unknown>) => {
  await vi.waitFor(async () => { expect(await check()).toBeTruthy() }, { timeout: 1500, interval: 10 })
}
afterEach(async () => {
  for (const controller of controllers) controller.dispose()
  await until(() => controllers.every(controller => controller.counts().running === 0 && controller.counts().queued === 0))
  controllers.length = 0
  vi.restoreAllMocks()
})

describe('durable stop observation across controllers', () => {
  it('aborts the original owner runner without a broadcast and preserves the accepted identity', async () => {
    const runner = liveRunner(), owner = setup({ run: runner.run })
    const other = setup({ scope: owner.receiver.scope, generation: 2 })
    const action = actionOf(crypto.randomUUID())
    await owner.controller.submit(action)
    await until(() => runner.signal())
    const accepted = (await owner.read(action.requestId))!
    await other.controller.open()
    await other.controller.stop(action.requestId, 'remote-stop', accepted.inputDigest)
    // A stop request alone must never pretend that the worker has already stopped.
    expect((await owner.read(action.requestId))!.query.stopRequested).toBe(true)
    await until(() => runner.signal()?.aborted)
    await until(async () => (await owner.read(action.requestId))!.query.state === 'cancelled')
    const stopped = (await owner.read(action.requestId))!
    expect(stopped.acceptance).toEqual(accepted.acceptance)
    expect(stopped.acceptance.receipt.state).toBe('accepted')
    expect(stopped.stoppedAt).not.toBeNull()
    expect(stopped.generation).toBe(1)
    expect((await other.receiver.store.stops(other.receiver.scope)).map(stop => stop.stopId)).toEqual(['remote-stop'])
    await owner.receiver.finish(action.requestId, { state: 'succeeded' })
    expect((await owner.read(action.requestId))!.query.state).toBe('cancelled')
  })
  it('does not stop a different scope with the same requestId', async () => {
    const runner = liveRunner(), owner = setup({ run: runner.run }), other = setup()
    const action = actionOf(crypto.randomUUID())
    await owner.controller.submit(action)
    await until(() => runner.signal())
    await other.controller.submit({ ...action, execution: { ...action.execution, limits: { ...action.execution.limits, concurrentJobs: 2 } } })
    await until(async () => (await other.read(action.requestId))!.query.state === 'succeeded')
    await other.controller.stop(action.requestId)
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(runner.signal()?.aborted).toBe(false)
  })
  it('does not launch a worker when a durable stop arrives during algorithm loading', async () => {
    const loading = deferred<Awaited<ReturnType<AlgorithmProvider['load']>>>()
    const entered = deferred<void>(), run = vi.fn<RunAlgorithm>(async () => outcome)
    const owner = setup({ run, provider: { load: () => { entered.resolve(); return loading.promise } } })
    const other = setup({ scope: owner.receiver.scope, generation: 2 }), action = actionOf(crypto.randomUUID())
    await owner.controller.submit(action)
    await entered.promise
    await other.controller.stop(action.requestId)
    loading.resolve(await provider.load(action))
    await until(() => owner.controller.counts().running === 0)
    expect(run).not.toHaveBeenCalled()
    expect((await owner.read(action.requestId))!.query.state).toBe('cancelled')
  })
  it('cancels an accepted run before claim without launching or reviving it', async () => {
    const run = vi.fn<RunAlgorithm>(async () => outcome), owner = setup({ run })
    const other = setup({ scope: owner.receiver.scope, generation: 2 }), action = actionOf(crypto.randomUUID())
    const entered = deferred<void>(), release = deferred<void>()
    const claim = owner.receiver.claim.bind(owner.receiver)
    vi.spyOn(owner.receiver, 'claim').mockImplementationOnce(async requestId => {
      entered.resolve(); await release.promise; return claim(requestId)
    })
    await owner.controller.submit(action)
    await entered.promise
    const accepted = (await owner.read(action.requestId))!
    await other.controller.stop(action.requestId)
    release.resolve()
    await until(() => owner.controller.counts().queued === 0)
    const cancelled = (await owner.read(action.requestId))!
    expect(cancelled.query.state).toBe('cancelled')
    expect(cancelled.startedAt).toBeNull()
    expect(cancelled.acceptance).toEqual(accepted.acceptance)
    expect(run).not.toHaveBeenCalled()
    await owner.receiver.accept(action, digestOf(action)).catch(() => {})
    expect((await owner.read(action.requestId))!.query.state).toBe('cancelled')
  })
  it('stops the owner when the stop caller read a pre-claim snapshot', async () => {
    const runner = liveRunner(), owner = setup({ run: runner.run })
    const other = setup({ scope: owner.receiver.scope, generation: 2 }), action = actionOf(crypto.randomUUID())
    const entered = deferred<void>(), release = deferred<void>()
    const claim = owner.receiver.claim.bind(owner.receiver)
    vi.spyOn(owner.receiver, 'claim').mockImplementationOnce(async requestId => {
      entered.resolve(); await release.promise; return claim(requestId)
    })
    await owner.controller.submit(action)
    await entered.promise
    const stale = (await owner.read(action.requestId))!
    release.resolve()
    await until(() => runner.signal())
    vi.spyOn(other.receiver.store, 'read').mockResolvedValueOnce(stale)
    await expect(other.controller.stop(action.requestId)).resolves.toBeUndefined()
    await until(() => runner.signal()?.aborted)
    await until(() => owner.controller.counts().running === 0)
    expect((await owner.read(action.requestId))!.query.state).toBe('cancelled')
    expect((await owner.read(action.requestId))!.generation).toBe(1)
  })
  it('does not publish success when a remote stop wins before worker completion', async () => {
    const running = deferred<AggregationOutcome>(), entered = deferred<void>()
    const owner = setup({ run: async () => { entered.resolve(); return running.promise } })
    const other = setup({ scope: owner.receiver.scope, generation: 2 }), action = actionOf(crypto.randomUUID())
    await owner.controller.submit(action)
    await entered.promise
    await other.controller.stop(action.requestId)
    running.resolve(outcome)
    await until(() => owner.controller.counts().running === 0)
    expect((await owner.read(action.requestId))!.query.state).toBe('cancelled')
    expect((await owner.read(action.requestId))!.query.output).toBeNull()
  })
  it('keeps a durable stop that arrives during artifact retention ahead of result publication', async () => {
    const owner = setup(), other = setup({ scope: owner.receiver.scope, generation: 2 })
    const action = actionOf(crypto.randomUUID()), retained = deferred<void>(), release = deferred<void>()
    const retain = owner.receiver.retainResult.bind(owner.receiver)
    vi.spyOn(owner.receiver, 'retainResult').mockImplementationOnce(async value => {
      const result = await retain(value); retained.resolve(); await release.promise; return result
    })
    await owner.controller.submit(action)
    await retained.promise
    await other.controller.stop(action.requestId)
    release.resolve()
    await until(() => owner.controller.counts().running === 0)
    const stopped = (await owner.read(action.requestId))!
    expect(stopped.query.state).toBe('cancelled')
    expect(stopped.query.output).toBeNull()
    expect(stopped.stoppedAt).not.toBeNull()
  })
  it('keeps a completed result when stop read an earlier running snapshot', async () => {
    const running = deferred<AggregationOutcome>(), entered = deferred<void>()
    const owner = setup({ run: async () => { entered.resolve(); return running.promise } })
    const other = setup({ scope: owner.receiver.scope, generation: 2 }), action = actionOf(crypto.randomUUID())
    await owner.controller.submit(action)
    await entered.promise
    const stale = (await owner.read(action.requestId))!
    running.resolve(outcome)
    await until(() => owner.controller.counts().running === 0)
    const finished = (await owner.read(action.requestId))!
    expect(finished.query.state).toBe('succeeded')
    vi.spyOn(other.receiver.store, 'read').mockResolvedValueOnce(stale)
    await other.controller.stop(action.requestId)
    const after = (await owner.read(action.requestId))!
    expect(after.query).toEqual(finished.query)
    expect(after.stoppedAt).toBeNull()
    expect(await owner.controller.artifact(action.requestId)).toMatchObject({ text: outcome.artifact.text })
  })
  it('stops observing while idle and releases its observation on dispose', async () => {
    const runner = liveRunner(), owner = setup({ run: runner.run }), action = actionOf(crypto.randomUUID())
    const reads = vi.spyOn(owner.receiver.store, 'read')
    await new Promise(resolve => setTimeout(resolve, 150))
    expect(reads).not.toHaveBeenCalled()
    await owner.controller.submit(action)
    await until(() => runner.signal())
    const before = reads.mock.calls.length
    await until(() => reads.mock.calls.length > before)
    owner.controller.dispose()
    await until(() => owner.controller.counts().running === 0)
    const settled = reads.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(reads).toHaveBeenCalledTimes(settled)
    expect(runner.signal()?.aborted).toBe(true)
  })
  it('leaves no polling after a successful run', async () => {
    const env = setup(), action = actionOf(crypto.randomUUID())
    await env.controller.submit(action)
    await until(async () => (await env.read(action.requestId))?.query.state === 'succeeded')
    await until(() => env.controller.counts().running === 0)
    // Let the single final delivery read finish before observing idle behavior.
    await new Promise(resolve => setTimeout(resolve, 20))
    const reads = vi.spyOn(env.receiver.store, 'read')
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(reads).not.toHaveBeenCalled()
  })
})

describe('dynamic execution access', () => {
  it('rejects submit and hides query/artifact before touching storage when already revoked', async () => {
    const env = setup({ canAccess: () => false }), action = actionOf(crypto.randomUUID())
    const reads = vi.spyOn(env.receiver.store, 'read')
    expect(await env.controller.query(action.requestId)).toBeNull()
    expect(await env.controller.artifact(action.requestId)).toBeNull()
    await expect(env.controller.submit(action)).rejects.toThrow('forbidden')
    expect(reads).not.toHaveBeenCalled()
    expect(env.actions.createExecution).not.toHaveBeenCalled()
  })
  it('hides a terminal local query if access is revoked during the read', async () => {
    let allowed = true
    const env = setup({ canAccess: () => allowed }), action = actionOf(crypto.randomUUID())
    await env.controller.submit(action)
    await until(async () => (await env.read(action.requestId))?.query.state === 'succeeded')
    await until(() => env.controller.counts().running === 0)
    const original = env.receiver.store.read.bind(env.receiver.store)
    vi.spyOn(env.receiver.store, 'read').mockImplementationOnce(async (...args) => {
      const record = await original(...args); allowed = false; return record
    })
    expect(await env.controller.query(action.requestId)).toBeNull()
  })
  it.each(['success', 'offline'] as const)('hides a late %s service query after revocation', async kind => {
    let allowed = true
    const reply = deferred<void>(), entered = deferred<void>(), runner = liveRunner()
    const env = setup({ canAccess: () => allowed, run: runner.run, transport: { ...offline, read: async () => {
      entered.resolve(); await reply.promise
      if (kind === 'offline') throw new Error('offline')
      return (await env.read(action.requestId))!.query
    } } }), action = actionOf(crypto.randomUUID())
    await env.controller.submit(action)
    await until(() => runner.signal())
    const query = env.controller.query(action.requestId)
    await entered.promise
    allowed = false; reply.resolve()
    expect(await query).toBeNull()
    // Losing read access must not lock the owner's worker cleanup or durable stop confirmation.
    await env.controller.stop(action.requestId)
    await until(() => env.controller.counts().running === 0)
    expect((await env.read(action.requestId))!.query.state).toBe('cancelled')
  })
  it.each(['record', 'refresh'] as const)('rechecks access after persisting a service fact at %s', async stage => {
    let allowed = true
    const runner = liveRunner()
    const env = setup({ canAccess: () => allowed, run: runner.run, transport: { ...offline, read: async () => {
      const current = (await env.read(action.requestId))!.query
      return { ...current, confirmedSeq: current.confirmedSeq + 1 }
    } } }), action = actionOf(crypto.randomUUID())
    await env.controller.submit(action)
    await until(() => runner.signal())
    const notified = vi.fn()
    env.controller.subscribe(notified)
    if (stage === 'record') {
      const record = env.receiver.store.record.bind(env.receiver.store)
      vi.spyOn(env.receiver.store, 'record').mockImplementationOnce(async (...args) => {
        const result = await record(...args); allowed = false; return result
      })
    } else {
      const list = env.receiver.store.list.bind(env.receiver.store)
      vi.spyOn(env.receiver.store, 'list').mockImplementationOnce(async (...args) => {
        const result = await list(...args); allowed = false; return result
      })
    }
    expect(await env.controller.query(action.requestId)).toBeNull()
    expect(notified).not.toHaveBeenCalled()
  })
  it.each(['record', 'artifact'] as const)('hides artifacts revoked during the %s read', async stage => {
    let allowed = true
    const env = setup({ canAccess: () => allowed }), action = actionOf(crypto.randomUUID())
    await env.controller.submit(action)
    await until(async () => (await env.read(action.requestId))?.query.state === 'succeeded')
    await until(() => env.controller.counts().running === 0)
    const artifacts = vi.spyOn(env.receiver.store, 'readResult')
    if (stage === 'record') {
      const original = env.receiver.store.read.bind(env.receiver.store)
      vi.spyOn(env.receiver.store, 'read').mockImplementationOnce(async (...args) => {
        const record = await original(...args); allowed = false; return record
      })
    } else {
      const original = env.receiver.store.readResult.bind(env.receiver.store)
      artifacts.mockImplementationOnce(async (...args) => {
        const result = await original(...args); allowed = false; return result
      })
    }
    expect(await env.controller.artifact(action.requestId)).toBeNull()
    if (stage === 'record') expect(artifacts).not.toHaveBeenCalled()
  })
  it('rechecks submit after acceptance without blocking internal termination', async () => {
    let allowed = true
    const runner = liveRunner(), env = setup({ canAccess: () => allowed, run: runner.run })
    const action = actionOf(crypto.randomUUID()), create = env.actions.createExecution.getMockImplementation()!
    env.actions.createExecution.mockImplementationOnce(async input => {
      const accepted = await create(input); allowed = false; return accepted
    })
    await expect(env.controller.submit(action)).rejects.toThrow('forbidden')
    await until(() => runner.signal())
    await env.controller.stop(action.requestId)
    await until(() => env.controller.counts().running === 0)
    expect((await env.read(action.requestId))!.query.state).toBe('cancelled')
  })
})
