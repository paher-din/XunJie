import { describe, expect, it } from 'vitest'
import { componentBindingSchema, componentPreparedManifestSchema, type ComponentBinding,
  type ComponentPreparedManifest } from '@xunjie/contracts/components'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { createComponentPreparation, scopeKeyOf, type PreparationTarget, type PreparationTransport } from './preparation'
import { gatedCapabilities, type SelfTestInput, type SelfTestOutcome } from './self-test'
import { fingerprint, sha256 } from './device'
import type { ActiveEnvironment, CachedResource, CheckResult, PreparationRecord, PreparationStore } from './store'

const componentId = '6237a554-67ee-4e74-ae33-36faf1223f12'
const entryResource = '702493fc-1bb0-4483-a695-e66694509656'
const libraryResource = '0445d39b-51ce-4481-9a60-798b92d3a2e6'
const releaseId = '3f2b6a1e-9c4d-4a55-9c1e-6b0f2d8a4e77'
const identity = { environmentId: '11111111-1111-4111-8111-111111111111', spaceId: '22222222-2222-4222-8222-222222222222',
  principalId: '33333333-3333-4333-8333-333333333333' }
const entryBytes = new TextEncoder().encode('<html><body>材料标注</body></html>')
const libraryBytes = new TextEncoder().encode('window.Mark = function Mark() {}')
const device = { platform: 'Win32', browser: 'chrome', browserVersion: '141.0.0.0',
  features: ['message-port', 'crypto-subtle', 'indexeddb', 'sandboxed-iframe'], preparationImplementationVersion: 1 }

async function manifestFor(library: Uint8Array, version: number): Promise<ComponentPreparedManifest> {
  return componentPreparedManifestSchema.parse({ formatVersion: 2, componentId, version,
    hostApiVersion: 1, preparationProtocolVersion: 1, title: '材料标注',
    entry: { resourceId: entryResource, mediaType: 'text/html', sha256: await sha256(entryBytes), byteLength: entryBytes.length },
    dependencies: [{ dependencyId: 'mark-js', package: 'mark.js', version: '8.11.1', role: 'script', resourceId: libraryResource,
      mediaType: 'text/javascript', loadOrder: 0, preparationTypes: ['browser'], sha256: await sha256(library), byteLength: library.length }],
    environment: { preparationType: 'browser', preparationProtocolVersion: 1, selfTestVersion: 1, requiredFeatures: ['indexeddb'],
      capabilityDependencies: [{ capability: 'workspace.read', dependencyIds: [] }, { capability: 'workspace.change', dependencyIds: [] },
        { capability: 'material.highlight', dependencyIds: ['mark-js'] }] },
    budget: { resourceCount: 2, totalResourceBytes: 4096, messageBytes: 4096, preparationTimeoutMs: 5000,
      selfTestTimeoutMs: 5000, parallelism: 1, cacheScope: 'device-local' },
    selfTest: { selfTestVersion: 1, material: { title: '自检样例材料', text: '观察与解释' }, steps: [
      { kind: 'dependency-loads', checkId: 'loads', dependencyIds: ['mark-js'], expect: { globalName: 'Mark' } },
      { kind: 'highlight-matches', checkId: 'hit', quote: '观察', expect: { marks: 1, markedText: '观察' } },
      { kind: 'annotation-roundtrip', checkId: 'roundtrip', quote: '观察', note: '临时', expect: { annotations: 1, note: '临时' } }] },
    stateVersion: 1, requiredCapabilities: ['workspace.read', 'workspace.change', 'material.highlight'],
    stateShape: { type: 'object', properties: { annotations: { type: 'array', maxItems: 100, items: { type: 'object',
      properties: { id: { type: 'string', maxLength: 36 }, quote: { type: 'string', maxLength: 4000 }, note: { type: 'string', maxLength: 4000 } } } } } },
    initialState: { annotations: [] } })
}
async function bindingFor(library: Uint8Array, version: number, title = '材料标注'): Promise<ComponentBinding> {
  const manifest = await manifestFor(library, version)
  return componentBindingSchema.parse({ key: 'annotation', configuration: { title }, materialIds: [],
    definition: { manifest, digest: await fingerprint(manifest) } })
}
function targetFor(binding: ComponentBinding, activityId = crypto.randomUUID()): PreparationTarget {
  return { namespace: 'local', spaceKey: 'personal', binding,
    activity: { activityId, identity, course: { releaseId } } as unknown as LearningActivity }
}

function memoryStore(faults: { resource?: boolean; environment?: boolean } = {}) {
  const preparations = new Map<string, PreparationRecord>()
  const checks = new Map<string, CheckResult>()
  const resources = new Map<string, CachedResource>()
  const environments = new Map<string, ActiveEnvironment>()
  const store: PreparationStore = {
    read: async id => structuredClone(preparations.get(id)),
    write: async record => { preparations.set(record.preparationId, structuredClone(record)) },
    list: async scopeKey => [...preparations.values()].filter(item => item.scopeKey === scopeKey)
      .map(item => structuredClone(item)).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    readCheck: async key => structuredClone(checks.get(key)),
    writeCheck: async result => { checks.set(result.fingerprint, structuredClone(result)) },
    readResource: async key => structuredClone(resources.get(key)),
    writeResource: async resource => { if (faults.resource) throw new Error('QuotaExceededError'); resources.set(resource.sha256, structuredClone(resource)) },
    dropResource: async key => { resources.delete(key) },
    readEnvironment: async key => structuredClone(environments.get(key)),
    activate: async (record, environment) => {
      if (faults.environment) throw new Error('QuotaExceededError')
      preparations.set(record.preparationId, structuredClone(record))
      environments.set(environment.scopeKey, structuredClone(environment))
    },
  }
  return { store, preparations, checks, resources, environments }
}

function memoryTransport(library: Uint8Array, dependency: { resourceId: string; sha256: string },
  faults: { dependency?: string; report?: boolean } = {}) {
  const calls = { dependency: 0, submitReport: 0, reports: 0 }
  const transport: PreparationTransport = {
    dependency: async () => {
      calls.dependency++
      if (faults.dependency) throw Object.assign(new Error(faults.dependency), { reason: 'resource-missing' })
      return { dependencyId: 'mark-js', resourceId: dependency.resourceId, sha256: dependency.sha256, byteLength: library.length,
        mediaType: 'text/javascript', contentBase64: Buffer.from(library).toString('base64') }
    },
    submitReport: async () => { calls.submitReport++; if (faults.report) throw new Error('unavailable'); return { reportId: crypto.randomUUID() } },
    reports: async () => { calls.reports++; return [] },
  }
  return { transport, calls }
}

/** Highlight checks need the real dependency bytes; without them only the base checks can pass. */
function memorySelfTest(options: { interrupted?: boolean } = {}) {
  const calls: SelfTestInput[] = []
  const selfTest = async (input: SelfTestInput): Promise<SelfTestOutcome> => {
    calls.push(input)
    if (options.interrupted) return { interrupted: true, elapsedMs: 1, checks: input.manifest.selfTest.steps.map(step =>
      ({ checkId: step.checkId, verification: 'interrupted' as const, reason: 'self-test-interrupted' as const,
        capabilities: gatedCapabilities(input.manifest, step) })) }
    return { interrupted: false, elapsedMs: 1, checks: input.manifest.selfTest.steps
      .filter(step => !input.checkIds || input.checkIds.includes(step.checkId)).map(step => {
      const blocked = !input.dependencies.length && gatedCapabilities(input.manifest, step).includes('material.highlight')
      return { checkId: step.checkId, verification: blocked ? 'failed' as const : 'verified' as const,
        reason: blocked ? 'self-test-mismatch' as const : 'none' as const, capabilities: gatedCapabilities(input.manifest, step) }
    }) }
  }
  return { selfTest, calls }
}
const availability = (snapshot: { capabilities: { capability: string; availability: string }[] }) =>
  Object.fromEntries(snapshot.capabilities.map(item => [item.capability, item.availability]))

describe('component preparation module', () => {
  it('repairs missing or corrupt warm-cache bytes under the original preparation identity', async () => {
    const binding = await bindingFor(libraryBytes, 2), target = targetFor(binding), store = memoryStore()
    const transport = memoryTransport(libraryBytes, { resourceId: libraryResource, sha256: await sha256(libraryBytes) })
    const create = () => createComponentPreparation({ transport: transport.transport, store: store.store,
      selfTest: memorySelfTest().selfTest, device: () => device })
    const original = await create().prepare(target, crypto.randomUUID())
    for (const corrupt of [false, true]) {
      store.resources.clear()
      if (corrupt) store.resources.set(await sha256(libraryBytes), { sha256: await sha256(libraryBytes),
        bytes: new Uint8Array(libraryBytes.length), byteLength: libraryBytes.length, mediaType: 'text/javascript', storedAt: '' })
      const reopened = create()
      const result = await reopened.prepare(target, crypto.randomUUID())
      expect(result.preparationId).toBe(original.preparationId)
      expect(await reopened.dependencies(target)).toHaveLength(1)
    }
    expect(transport.calls.dependency).toBe(3)
  })

  it('serializes identity discovery across independent clients before allocating an identity', async () => {
    const binding = await bindingFor(libraryBytes, 2), target = targetFor(binding), store = memoryStore()
    const transport = memoryTransport(libraryBytes, { resourceId: libraryResource, sha256: await sha256(libraryBytes) })
    const tails = new Map<string, Promise<unknown>>()
    const lock = <T>(key: string, run: () => Promise<T>): Promise<T> => {
      const next = (tails.get(key) ?? Promise.resolve()).then(run)
      tails.set(key, next.catch(() => undefined))
      return next
    }
    const create = () => createComponentPreparation({ transport: transport.transport, store: store.store,
      selfTest: memorySelfTest().selfTest, device: () => device, lock })
    const results = await Promise.all([create().prepare(target, crypto.randomUUID()), create().prepare(target, crypto.randomUUID())])
    expect(new Set(results.map(item => item.preparationId)).size).toBe(1)
    expect(store.preparations.size).toBe(1)
    expect(store.environments.size).toBe(1)
    expect(transport.calls.dependency).toBe(1)
  })

  it('retries the exact frozen report after the owner accepted it but its acknowledgement was lost', async () => {
    const binding = await bindingFor(libraryBytes, 2), target = targetFor(binding), store = memoryStore()
    const transport = memoryTransport(libraryBytes, { resourceId: libraryResource, sha256: await sha256(libraryBytes) }).transport
    const submissions: unknown[] = []
    transport.submitReport = async (_target, submission) => {
      submissions.push(structuredClone(submission))
      if (submissions.length === 1) throw new Error('lost-ack')
      if ((submission as { requestId: string }).requestId === (submissions[0] as { requestId: string }).requestId)
        expect(submission).toEqual(submissions[0])
      return submission
    }
    const create = () => createComponentPreparation({ transport, store: store.store, selfTest: memorySelfTest().selfTest, device: () => device })
    const first = await create().prepare(target, crypto.randomUUID())
    await create().prepare(target, crypto.randomUUID())
    expect(submissions).toHaveLength(3)
    expect(submissions[1]).toEqual(submissions[0])
    expect(store.preparations.get(first.preparationId)?.reportSubmitted).toBe(true)
  })

  it('does not report unreadable storage as an absent preparation', async () => {
    const store = memoryStore()
    store.store.read = async () => { throw new Error('unreadable-store') }
    const preparation = createComponentPreparation({ store: store.store })
    await expect(preparation.query(crypto.randomUUID())).rejects.toThrow('unreadable-store')
  })

  it('never activates or claims verified capabilities before a durable preparation exists', async () => {
    const binding = await bindingFor(libraryBytes, 2), store = memoryStore()
    const preparation = createComponentPreparation({ store: store.store })
    const projection = await preparation.capabilities(targetFor(binding))
    expect(projection.environmentId).toBeNull()
    expect(projection.capabilities.every(item => item.availability === 'unavailable' && item.verification === 'unverified')).toBe(true)
    store.store.list = async () => { throw new Error('unreadable-identities') }
    await expect(preparation.prepare(targetFor(binding), crypto.randomUUID())).rejects.toThrow('unreadable-identities')
    expect(store.preparations.size).toBe(0)
  })

  it('applies the overall preparation deadline to the self-test as well as dependency downloads', async () => {
    const binding = await bindingFor(libraryBytes, 2), store = memoryStore()
    ;(binding.definition.manifest as ComponentPreparedManifest).budget.preparationTimeoutMs = 1000
    const result = await createComponentPreparation({ store: store.store,
      transport: memoryTransport(libraryBytes, { resourceId: libraryResource, sha256: await sha256(libraryBytes) }).transport,
      selfTest: async () => new Promise(() => {}), device: () => device }).prepare(targetFor(binding), crypto.randomUUID())
    expect(result.snapshot.reason).toBe('self-test-interrupted')
    expect(result.snapshot.environmentId).toBeNull()
    expect(store.environments.size).toBe(0)
  }, 2500)

  it('records preview provenance and bounds a stalled dependency acquisition', async () => {
    const binding = await bindingFor(libraryBytes, 2), target = targetFor(binding), store = memoryStore()
    target.activity.purpose = 'preview'
    const transport = memoryTransport(libraryBytes, { resourceId: libraryResource, sha256: await sha256(libraryBytes) }).transport
    let preview: boolean | undefined
    transport.submitReport = async (_target, submission) => { preview = (submission as { report: { preview: boolean } }).report.preview; return {} }
    transport.dependency = async () => new Promise(() => {})
    const manifest = binding.definition.manifest as ComponentPreparedManifest
    manifest.budget.preparationTimeoutMs = 1000
    const result = await createComponentPreparation({ transport, store: store.store,
      selfTest: memorySelfTest().selfTest, device: () => device }).prepare(target, crypto.randomUUID())
    expect(result.snapshot.status).toBe('repairable')
    expect(result.snapshot.reason).toBe('resource-missing')
    expect(preview).toBe(true)
  }, 2500)
  it('prepares cold, then reuses the identity, cached bytes and check results on a warm open', async () => {
    const binding = await bindingFor(libraryBytes, 2)
    const store = memoryStore()
    const cold = memoryTransport(libraryBytes, { resourceId: libraryResource, sha256: await sha256(libraryBytes) })
    const coldTest = memorySelfTest()
    const first = createComponentPreparation({ transport: cold.transport, store: store.store, selfTest: coldTest.selfTest, device: () => device })
    const coldResult = await first.prepare(targetFor(binding), crypto.randomUUID())
    expect(coldResult.snapshot.status).toBe('ready')
    expect(coldResult.snapshot.environmentId).not.toBeNull()
    expect(availability(coldResult.snapshot)).toEqual({ 'workspace.read': 'available', 'workspace.change': 'available', 'material.highlight': 'available' })
    expect(cold.calls.dependency).toBe(1)
    expect(coldTest.calls.length).toBe(1)
    expect(cold.calls.submitReport).toBe(1)
    expect(store.resources.size).toBe(1)
    expect(await first.dependencies(targetFor(binding))).toHaveLength(1)

    // A second activity of the same principal shares the scope, so nothing is fetched or self-tested again.
    const warm = memoryTransport(libraryBytes, { resourceId: libraryResource, sha256: await sha256(libraryBytes) })
    const warmTest = memorySelfTest()
    const second = createComponentPreparation({ transport: warm.transport, store: store.store, selfTest: warmTest.selfTest, device: () => device })
    const warmResult = await second.prepare(targetFor(binding), crypto.randomUUID())
    expect(warmResult.preparationId).toBe(coldResult.preparationId)
    expect(warmResult.snapshot.cacheHit).toBe(true)
    expect(warmResult.snapshot.status).toBe('ready')
    expect(warm.calls.dependency).toBe(0)
    expect(warmTest.calls.length).toBe(0)
  })

  it('reuses unrelated check results after a configuration change and re-runs them after a dependency change', async () => {
    const store = memoryStore()
    const digest = { resourceId: libraryResource, sha256: await sha256(libraryBytes) }
    const binding = await bindingFor(libraryBytes, 2)
    const first = memorySelfTest()
    await createComponentPreparation({ transport: memoryTransport(libraryBytes, digest).transport, store: store.store,
      selfTest: first.selfTest, device: () => device }).prepare(targetFor(binding), crypto.randomUUID())
    expect(first.calls.length).toBe(1)

    const retitled = memorySelfTest()
    const renamed = await bindingFor(libraryBytes, 2, '材料标注（第二版标题）')
    const configurationOnly = await createComponentPreparation({ transport: memoryTransport(libraryBytes, digest).transport,
      store: store.store, selfTest: retitled.selfTest, device: () => device }).prepare(targetFor(renamed), crypto.randomUUID())
    expect(configurationOnly.snapshot.status).toBe('ready')
    expect(retitled.calls.length).toBe(0)

    const changedLibrary = new TextEncoder().encode('window.Mark = function Mark() { return 2 }')
    const changed = await bindingFor(changedLibrary, 3)
    const changedTest = memorySelfTest()
    const changedDigest = { resourceId: libraryResource, sha256: await sha256(changedLibrary) }
    const upgraded = await createComponentPreparation({ transport: memoryTransport(changedLibrary, changedDigest).transport,
      store: store.store, selfTest: changedTest.selfTest, device: () => device }).prepare(targetFor(changed), crypto.randomUUID())
    expect(upgraded.snapshot.status).toBe('ready')
    expect(changedTest.calls.length).toBe(1)
    expect(changedTest.calls[0]?.checkIds).toEqual(['loads', 'hit'])
    // The previous version keeps its own environment pointer; a new version never rebinds it.
    expect(store.environments.get(scopeKeyOf(targetFor(binding)))?.definitionDigest).toBe(binding.definition.digest)
    expect(store.environments.get(scopeKeyOf(targetFor(changed)))?.definitionDigest).toBe(changed.definition.digest)
  })

  it('keeps base capabilities when the dependency cannot be fetched and names the reason', async () => {
    const binding = await bindingFor(libraryBytes, 2)
    const store = memoryStore()
    const test = memorySelfTest()
    const preparation = createComponentPreparation({
      transport: memoryTransport(libraryBytes, { resourceId: libraryResource, sha256: await sha256(libraryBytes) },
        { dependency: 'unavailable' }).transport,
      store: store.store, selfTest: test.selfTest, device: () => device })
    const result = await preparation.prepare(targetFor(binding), crypto.randomUUID())
    expect(result.snapshot.status).toBe('repairable')
    expect(result.snapshot.reason).toBe('resource-missing')
    expect(availability(result.snapshot)).toEqual({ 'workspace.read': 'available', 'workspace.change': 'available', 'material.highlight': 'unavailable' })
    expect(result.snapshot.environmentId).not.toBeNull()
    // The corrupt or missing bytes are never handed to the component.
    expect(await preparation.dependencies(targetFor(binding))).toEqual([])
  })

  it('activates nothing after an interrupted self-test and continues under the original identity', async () => {
    const binding = await bindingFor(libraryBytes, 2)
    const store = memoryStore()
    const digest = { resourceId: libraryResource, sha256: await sha256(libraryBytes) }
    const interrupted = memorySelfTest({ interrupted: true })
    const requestId = crypto.randomUUID()
    const preparation = createComponentPreparation({ transport: memoryTransport(libraryBytes, digest).transport,
      store: store.store, selfTest: interrupted.selfTest, device: () => device })
    const first = await preparation.prepare(targetFor(binding), requestId)
    expect(first.snapshot.status).toBe('self-test-failed')
    expect(first.snapshot.reason).toBe('self-test-interrupted')
    expect(first.snapshot.verification).toBe('interrupted')
    expect(first.snapshot.environmentId).toBeNull()
    expect(store.environments.size).toBe(0)
    expect(await preparation.query(first.preparationId)).toMatchObject({ stage: 'self-test', environmentId: null })

    const healthy = memorySelfTest()
    const resumed = createComponentPreparation({ transport: memoryTransport(libraryBytes, digest).transport,
      store: store.store, selfTest: healthy.selfTest, device: () => device })
    const continued = await resumed.resume(targetFor(binding), first.preparationId, requestId)
    expect(continued.preparationId).toBe(first.preparationId)
    expect(continued.snapshot.status).toBe('ready')
    expect(continued.snapshot.environmentId).not.toBeNull()
    expect(healthy.calls.length).toBe(1)
  })

  it('refuses the same preparation identity with different fixed inputs', async () => {
    const binding = await bindingFor(libraryBytes, 2)
    const store = memoryStore()
    const digest = { resourceId: libraryResource, sha256: await sha256(libraryBytes) }
    const requestId = crypto.randomUUID()
    const preparation = createComponentPreparation({ transport: memoryTransport(libraryBytes, digest).transport,
      store: store.store, selfTest: memorySelfTest().selfTest, device: () => device })
    const first = await preparation.prepare(targetFor(binding), requestId)
    const other = await bindingFor(libraryBytes, 3)
    await expect(preparation.resume(targetFor(other), first.preparationId, requestId)).rejects.toThrow('identity-conflict')
    expect((await preparation.query(first.preparationId))?.status).toBe('ready')
  })

  it('does not claim durable readiness when the environment pointer cannot be persisted', async () => {
    const binding = await bindingFor(libraryBytes, 2)
    const store = memoryStore({ environment: true })
    const result = await createComponentPreparation({
      transport: memoryTransport(libraryBytes, { resourceId: libraryResource, sha256: await sha256(libraryBytes) }).transport,
      store: store.store, selfTest: memorySelfTest().selfTest, device: () => device }).prepare(targetFor(binding), crypto.randomUUID())
    expect(result.snapshot.status).toBe('repairable')
    expect(result.snapshot.reason).toBe('storage-unavailable')
    expect(result.snapshot.environmentId).toBeNull()
    expect(result.snapshot.diagnostics.some(item => item.reason === 'storage-unavailable')).toBe(true)
  })

  it('keeps verified local capability when the report upload fails and retries under the same identity', async () => {
    const binding = await bindingFor(libraryBytes, 2)
    const store = memoryStore()
    const digest = { resourceId: libraryResource, sha256: await sha256(libraryBytes) }
    const offline = memoryTransport(libraryBytes, digest, { report: true })
    const target = targetFor(binding)
    const preparation = createComponentPreparation({ transport: offline.transport, store: store.store,
      selfTest: memorySelfTest().selfTest, device: () => device })
    const first = await preparation.prepare(target, crypto.randomUUID())
    expect(first.snapshot.status).toBe('ready')
    const stored = store.preparations.get(first.preparationId)!
    expect(stored.reportSubmitted).toBe(false)
    expect(stored.reportRequestId).not.toBeNull()
    expect(stored.reportId).not.toBeNull()

    const online = memoryTransport(libraryBytes, digest)
    const reconnected = createComponentPreparation({ transport: online.transport, store: store.store,
      selfTest: memorySelfTest().selfTest, device: () => device })
    const second = await reconnected.prepare(target, crypto.randomUUID())
    expect(second.snapshot.status).toBe('ready')
    expect(online.calls.submitReport).toBe(2)
    expect(store.preparations.get(first.preparationId)!.reportSubmitted).toBe(true)
    expect(store.preparations.get(first.preparationId)!.reportRequestId).not.toBe(stored.reportRequestId)
  })

  it('reports an unsupported device separately from a temporarily unavailable resource', async () => {
    const binding = await bindingFor(libraryBytes, 2)
    const store = memoryStore()
    const test = memorySelfTest()
    const result = await createComponentPreparation({
      transport: memoryTransport(libraryBytes, { resourceId: libraryResource, sha256: await sha256(libraryBytes) }).transport,
      store: store.store, selfTest: test.selfTest,
      device: () => ({ ...device, features: [] }) }).prepare(targetFor(binding), crypto.randomUUID())
    expect(result.snapshot.status).toBe('unsupported-device')
    expect(result.snapshot.reason).toBe('device-feature-missing')
    expect(result.snapshot.environmentId).toBeNull()
    expect(test.calls.length).toBe(0)
  })

  it('treats a corrupt delivered resource as corrupt rather than as a missing one', async () => {
    const binding = await bindingFor(libraryBytes, 2)
    const store = memoryStore()
    const result = await createComponentPreparation({
      transport: memoryTransport(libraryBytes, { resourceId: libraryResource, sha256: 'f'.repeat(64) }).transport,
      store: store.store, selfTest: memorySelfTest().selfTest, device: () => device }).prepare(targetFor(binding), crypto.randomUUID())
    expect(result.snapshot.status).toBe('repairable')
    expect(result.snapshot.reason).toBe('resource-corrupt')
    expect(store.resources.size).toBe(0)
  })

  it('still serves the activated environment when only the cache write failed', async () => {
    const binding = await bindingFor(libraryBytes, 2)
    const store = memoryStore({ resource: true })
    const preparation = createComponentPreparation({
      transport: memoryTransport(libraryBytes, { resourceId: libraryResource, sha256: await sha256(libraryBytes) }).transport,
      store: store.store, selfTest: memorySelfTest().selfTest, device: () => device })
    const result = await preparation.prepare(targetFor(binding), crypto.randomUUID())
    expect(result.snapshot.status).toBe('ready')
    expect(result.snapshot.cacheHit).toBe(false)
    expect(store.resources.size).toBe(0)
    expect(await preparation.dependencies(targetFor(binding))).toHaveLength(1)
  })

  it('separates an absent record from an unfinished one', async () => {
    const binding = await bindingFor(libraryBytes, 2)
    const store = memoryStore()
    const preparation = createComponentPreparation({
      transport: memoryTransport(libraryBytes, { resourceId: libraryResource, sha256: await sha256(libraryBytes) }).transport,
      store: store.store, selfTest: memorySelfTest().selfTest, device: () => device })
    expect(await preparation.query(crypto.randomUUID())).toBeNull()
    const result = await preparation.prepare(targetFor(binding), crypto.randomUUID())
    expect(await preparation.query(result.preparationId)).toMatchObject({ status: 'ready' })
  })
})
