import 'fake-indexeddb/auto'
import { afterEach, expect, it, vi } from 'vitest'
import { createHash, webcrypto } from 'node:crypto'
import { anyExecutionActionSchema } from '@xunjie/contracts/execution'
import { aluCoursePackage } from '../../../../components/alu-experiment/package.mjs'
import { TeachingBrowserExecution } from './TeachingBrowserExecution'
import { ExecutionController } from '../tool-execution/controller'
import { createAdapterRegistry } from '../tool-execution/adapters'
import type { ExecutionTransport } from '../tool-execution/retention'

afterEach(() => vi.unstubAllGlobals())

async function fixture() {
  vi.stubGlobal('crypto', webcrypto)
  const saved = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key), setItem: (key: string, value: string) => saved.set(key, value) })
  vi.stubGlobal('navigator', { locks: { request: async (...args: unknown[]) => (args.at(-1) as (lock: object) => unknown)({}) } })
  const course = await aluCoursePackage(), binding = course.release.components![0], manifest = binding.definition.manifest
  if (manifest.formatVersion !== 3) throw new Error('Expected published runtime')
  const operation = manifest.runtime.operations.find(item => item.operationId === 'run-single')!, plan = course.release.executionPlan!
  const scope = { environmentId: crypto.randomUUID(), spaceId: crypto.randomUUID(), principalId: crypto.randomUUID(), activityId: crypto.randomUUID() }
  const action = anyExecutionActionSchema.parse({ protocolVersion: 3, kind: 'execution', requestId: crypto.randomUUID(), scope,
    receiver: { receiverId: 'browser-execution', location: 'local', kind: 'execution' },
    execution: { instance: { instanceId: `${scope.activityId}:${binding.key}`, key: binding.key,
      componentId: manifest.componentId, componentVersion: manifest.version, definitionDigest: binding.definition.digest,
      hostApiVersion: manifest.hostApiVersion, stateVersion: manifest.stateVersion },
      operation: { operationId: operation.operationId, effect: 'execute' }, parameters: { A: 15, B: 1, M: 1, S: 0, Cin: 0 },
      basis: { works: [{ objectId: crypto.randomUUID(), contentId: crypto.randomUUID(), name: operation.compile.entryFiles[0],
        kind: 'code', encoding: 'utf8', mediaType: 'text/plain', value: 'module alu; endmodule' }],
        runtime: { adapterId: manifest.runtime.adapterId, adapterVersion: manifest.runtime.adapterVersion,
          bundleIdentity: manifest.runtime.bundleIdentity, resources: manifest.runtime.resources },
        compile: operation.compile, observation: operation.observation,
        course: { releaseId: course.release.releaseId, behaviorRuleDigest: 'a'.repeat(64), planDigest: plan.planDigest }, expected: { stateContentId: null } },
      limits: { ...operation.budgets, concurrentJobs: 1, queuedJobs: 1 },
      plan: { planId: plan.planId, planVersion: plan.planVersion, planDigest: plan.planDigest, location: 'browser', kind: 'job' },
      initiator: { kind: 'agent', principalId: scope.principalId } } })
  const association = { runId: crypto.randomUUID(), stepId: crypto.randomUUID(), commandId: action.requestId, snapshotId: crypto.randomUUID() }
  let permitted = true, remoteStop = false, conflict = false, revokeOnReceipt = false
  const transport: ExecutionTransport = {
    accept: async () => {
      const record = await receiver.store.read(receiver.scope, action.requestId)
      if (!record) throw new Error('missing')
      if (revokeOnReceipt) permitted = false
      return { ...record.query, stopRequested: remoteStop, ...(conflict ? { executionRef: crypto.randomUUID() } : {}) }
    },
    read: async () => null,
    report: async (_id, query) => query,
    stop: async () => { throw new Error('No remote stop is dispatched by this authorization test') },
    result: async () => { throw new Error('No simulation result is produced by this authorization test') },
  }
  const receiver = new TeachingBrowserExecution(JSON.stringify(['test', scope.environmentId, scope.spaceId, scope.principalId, scope.activityId]),
    1, async () => { if (!permitted) throw new Error('permit-revoked'); return { action, association } }, transport, () => true, scope.activityId)
  const digest = createHash('sha256').update(JSON.stringify(action)).digest('hex')
  return { action, receiver, transport, digest, revoke: () => { permitted = false }, stop: () => { remoteStop = true },
    conflict: () => { conflict = true }, revokeDuringReceipt: () => { revokeOnReceipt = true } }
}

it('the real V3 adapter rechecks the original permit after resource loading and before creating a Worker', async () => {
  const f = await fixture()
  let release!: () => void, entered!: () => void
  const loading = new Promise<void>(done => { entered = done }), gate = new Promise<void>(done => { release = done })
  const worker = vi.fn(() => { throw new Error('Worker must not start') })
  vi.stubGlobal('Worker', worker)
  const controller = new ExecutionController(f.receiver.scope, f.receiver,
    { createExecution: async () => null, cancel: async () => null }, f.transport,
    createAdapterRegistry({ provider: { load: async () => { throw new Error('V3 must not use aggregation') } },
      runtimeResources: async () => { entered(); await gate; return {} } }))
  try {
    await f.receiver.accept(f.action, f.digest)
    await loading
    f.revoke(); release()
    await vi.waitFor(async () => {
      const query = (await f.receiver.store.read(f.receiver.scope, f.action.requestId))?.query
      expect(query?.state).toBe('failed')
      expect(query?.reason?.detail).toBe('permit-revoked')
    })
    expect(worker).not.toHaveBeenCalled()
  } finally { release(); controller.dispose() }
})

it.each(['revoked', 'stop', 'identity-conflict'] as const)('a recovered V3 command checks %s before entering the adapter', async mode => {
  const f = await fixture()
  await f.receiver.accept(f.action, f.digest)
  if (mode === 'revoked') f.revoke()
  else if (mode === 'stop') f.stop()
  else f.conflict()
  let entered = false
  const controller = new ExecutionController(f.receiver.scope, f.receiver,
    { createExecution: async () => null, cancel: async () => null }, f.transport,
    createAdapterRegistry({ provider: { load: async () => { throw new Error('unexpected aggregation') } },
      runtimeResources: async () => { entered = true; return {} } }))
  try {
    await controller.open()
    await vi.waitFor(async () => {
      const query = (await f.receiver.store.read(f.receiver.scope, f.action.requestId))?.query
      expect(query?.state).toBe(mode === 'stop' ? 'cancelled' : 'failed')
      if (mode === 'stop') expect(query?.stopRequested).toBe(true)
      else expect(query?.reason?.detail).toBe(mode === 'revoked' ? 'permit-revoked' : 'identity-conflict')
    })
    expect(entered).toBe(false)
  } finally { controller.dispose() }
})

it('archiving the receipt cannot authorize a V3 run whose permit was revoked while the reply was in flight', async () => {
  const f = await fixture()
  await f.receiver.accept(f.action, f.digest)
  f.revokeDuringReceipt()
  await expect(f.receiver.beforeRun(f.action)).rejects.toThrow('permit-revoked')
})
