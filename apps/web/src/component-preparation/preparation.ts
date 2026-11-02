import { componentDependencyContentSchema, componentPreparationReportSchema, componentPreparationReportsSchema,
  manifestDependencies, type ComponentBinding, type ComponentCapability, type ComponentPreparationReport,
  type ComponentPreparedManifest, type ComponentSelfTestStep, type PreparationCapability, type PreparationReasonCode,
  type PreparationStage, type PreparationStatus, type PreparationVerification } from '@xunjie/contracts/components'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import { learningRequest } from '../product/learningTransport'
import { decodeBase64, detectDevice, encodeBase64, fingerprint, hostVersion, missingFeatures,
  preparationImplementationVersion, sha256, type PreparationDeviceProbe } from './device'
import { gatedCapabilities, runSelfTest, type SelfTestCheck, type SelfTestInput, type SelfTestOutcome } from './self-test'
import { preparationStore, withPreparationLock, type ActiveEnvironment, type PreparationCheck,
  type PreparationDiagnostic, type PreparationRecord, type PreparationStore } from './store'

export interface PreparationTarget { namespace: string; spaceKey: string; activity: LearningActivity; binding: ComponentBinding }
export interface PreparationTransport {
  dependency(target: PreparationTarget, dependencyId: string): Promise<unknown>
  submitReport(target: PreparationTarget, submission: unknown): Promise<unknown>
  reports(target: PreparationTarget): Promise<unknown>
}
export interface PreparationSnapshot {
  preparationId: string
  status: PreparationStatus
  stage: PreparationStage
  reason: PreparationReasonCode
  verification: PreparationVerification
  capabilities: PreparationCapability[]
  checks: PreparationCheck[]
  environmentId: string | null
  diagnostics: PreparationDiagnostic[]
  cacheHit: boolean
  resourceBytes: number
  durationMs: number
  updatedAt: string
}
export interface PreparationResult { preparationId: string; snapshot: PreparationSnapshot }
export interface CapabilityProjection { environmentId: string | null; capabilities: PreparationCapability[] }

const failure = (reason: PreparationReasonCode, message: string = reason) => Object.assign(new Error(message), { reason })

export function preparedManifest(binding: ComponentBinding): ComponentPreparedManifest {
  if (binding.definition.manifest.formatVersion === 1) throw new Error('unsupported-version')
  return binding.definition.manifest
}
/** Preparation exists only for components that declare dependencies; a format 1 binding keeps its original path. */
export function requiresPreparation(binding: ComponentBinding) { return binding.definition.manifest.formatVersion === 2 }

export function componentViewUrl(target: PreparationTarget) {
  const releaseId = target.activity.course?.releaseId
  if (!releaseId) throw new Error('resource-unavailable')
  const query = new URLSearchParams({ space: target.spaceKey, digest: target.binding.definition.digest,
    subject: [target.activity.identity.environmentId, target.activity.identity.spaceId, target.activity.identity.principalId].join('.') })
  return `/api/learning/releases/${releaseId}/components/${target.binding.key}/view?${query}`
}
function routeOf(target: PreparationTarget, suffix: string) {
  const releaseId = target.activity.course?.releaseId
  if (!releaseId) throw new Error('resource-unavailable')
  return `releases/${releaseId}/components/${target.binding.key}/${suffix}`
}
/** Cache scope covers the recovery namespace, environment/space/principal and the exact bound definition. */
export function scopeKeyOf(target: PreparationTarget) {
  const manifest = preparedManifest(target.binding)
  const { environmentId, spaceId, principalId } = target.activity.identity
  return JSON.stringify([target.namespace, environmentId, spaceId, principalId, manifest.componentId, manifest.version,
    target.binding.definition.digest, target.binding.configuration])
}

export const learningTransport: PreparationTransport = {
  dependency: (target, dependencyId) => learningRequest(target.activity, target.spaceKey, target.namespace,
    routeOf(target, `dependencies/${dependencyId}`)),
  submitReport: (target, submission) => learningRequest(target.activity, target.spaceKey, target.namespace,
    routeOf(target, 'preparation-report'), submission),
  reports: target => learningRequest(target.activity, target.spaceKey, target.namespace, routeOf(target, 'preparation-reports')),
}

interface GatedCheck { checkId: string; verification: PreparationVerification; reason: PreparationReasonCode; capabilities: ComponentCapability[] }

/**
 * Per-capability projection. A capability is available only when every dependency it declares was verified and
 * every gating check was verified on this device. Nothing is inferred from one global ready flag, and execution
 * capabilities are never projected: they are not declared by this component version.
 */
function projectCapabilities(manifest: ComponentPreparedManifest, checks: GatedCheck[],
  dependencyFailure: Map<string, PreparationReasonCode>): PreparationCapability[] {
  return manifest.requiredCapabilities.map((capability): PreparationCapability => {
    const declared = manifest.environment.capabilityDependencies.find(item => item.capability === capability)?.dependencyIds ?? []
    const blocked = declared.map(id => dependencyFailure.get(id)).find((reason): reason is PreparationReasonCode => reason !== undefined)
    if (blocked) return { capability, availability: 'unavailable', reason: blocked, verification: 'failed' }
    const gating = checks.filter(check => check.capabilities.includes(capability))
    if (!gating.length) return { capability, availability: 'available', reason: 'none', verification: 'verified' }
    const failed = gating.find(check => check.verification === 'failed')
    if (failed) return { capability, availability: 'unavailable', reason: failed.reason, verification: 'failed' }
    const unfinished = gating.find(check => check.verification !== 'verified')
    if (unfinished) return { capability, availability: 'unavailable', reason: unfinished.reason,
      verification: unfinished.verification === 'interrupted' ? 'interrupted' : 'unverified' }
    return { capability, availability: 'available', reason: 'none', verification: 'verified' }
  })
}

const snapshotOf = (record: PreparationRecord): PreparationSnapshot => ({
  preparationId: record.preparationId, status: record.status, stage: record.stage, reason: record.reason,
  verification: record.checks.some(check => check.verification === 'interrupted') ? 'interrupted'
    : record.checks.length > 0 && record.checks.every(check => check.verification === 'verified') ? 'verified' : 'unverified',
  capabilities: record.capabilities, checks: record.checks, environmentId: record.environmentId,
  diagnostics: record.diagnostics, cacheHit: record.cacheHit, resourceBytes: record.resourceBytes,
  durationMs: record.durationMs, updatedAt: record.updatedAt })

export interface PreparationOptions {
  transport?: PreparationTransport
  store?: PreparationStore
  /** The real driver loads the same view code in an isolated iframe; tests inject timing and outcome faults here. */
  selfTest?: (input: SelfTestInput) => Promise<SelfTestOutcome>
  device?: PreparationDeviceProbe
  lock?: <T>(name: string, run: () => Promise<T>) => Promise<T>
}

export function createComponentPreparation(options: PreparationOptions = {}) {
  const transport = options.transport ?? learningTransport
  const store = options.store ?? preparationStore
  const selfTest = options.selfTest ?? runSelfTest
  const detect = options.device ?? detectDevice
  const lock = options.lock ?? withPreparationLock
  const listeners = new Map<string, Set<(snapshot: PreparationSnapshot) => void>>()
  const running = new Map<string, Promise<PreparationResult>>()
  /** Verified bytes for this page's lifetime, so a cache write failure still serves the activated environment. */
  const sessionBytes = new Map<string, Uint8Array>()

  function publish(record: PreparationRecord) {
    const snapshot = snapshotOf(record)
    for (const listener of listeners.get(record.scopeKey) ?? []) listener(snapshot)
    return snapshot
  }
  /** Persist before advancing: an interruption loses only the stage that was never confirmed. */
  async function commit(record: PreparationRecord, patch: Partial<PreparationRecord>) {
    Object.assign(record, patch, { updatedAt: new Date().toISOString() })
    await store.write(structuredClone(record))
    return publish(record)
  }
  function diagnose(record: PreparationRecord, stage: PreparationStage, reason: PreparationReasonCode, detail: string) {
    record.diagnostics = [...record.diagnostics, { at: new Date().toISOString(), stage, reason, detail }].slice(-20)
  }
  async function requestDigestOf(target: PreparationTarget, deviceFingerprint: string) {
    const manifest = preparedManifest(target.binding)
    return fingerprint({ preparationImplementationVersion, scopeKey: scopeKeyOf(target),
      definitionDigest: target.binding.definition.digest, configuration: target.binding.configuration,
      selfTestVersion: manifest.selfTest.selfTestVersion,
      preparationProtocolVersion: manifest.environment.preparationProtocolVersion, deviceFingerprint })
  }
  async function checkFingerprintOf(target: PreparationTarget, manifest: ComponentPreparedManifest,
    deviceFingerprint: string, step: ComponentSelfTestStep, capabilities: ComponentCapability[]) {
    return fingerprint({ preparationImplementationVersion, componentId: manifest.componentId, version: manifest.version,
      definitionDigest: target.binding.definition.digest, entry: manifest.entry.sha256,
      selfTestVersion: manifest.selfTest.selfTestVersion, checkId: step.checkId, step, deviceFingerprint,
      dependencies: manifest.environment.capabilityDependencies
        .filter(item => capabilities.includes(item.capability))
        .flatMap(item => item.dependencyIds)
        .map(id => manifest.dependencies.find(dependency => dependency.dependencyId === id)?.sha256 ?? null) })
  }
  /** Cached bytes are re-hashed before use: a cache hit does not prove the file survived intact. */
  async function acquire(target: PreparationTarget, record: PreparationRecord,
    dependency: ComponentPreparedManifest['dependencies'][number], cached: Set<string>) {
    const stored = await store.readResource(dependency.sha256).catch(() => undefined)
    if (stored && stored.bytes.length === dependency.byteLength && await sha256(stored.bytes) === dependency.sha256) {
      cached.add(dependency.dependencyId)
      sessionBytes.set(dependency.sha256, stored.bytes)
      return stored.bytes
    }
    if (stored) await store.dropResource(dependency.sha256).catch(() => undefined)
    const payload = componentDependencyContentSchema.parse(await transport.dependency(target, dependency.dependencyId))
    if (payload.resourceId !== dependency.resourceId || payload.sha256 !== dependency.sha256
      || payload.byteLength !== dependency.byteLength || payload.mediaType !== dependency.mediaType) throw failure('resource-corrupt')
    const bytes = decodeBase64(payload.contentBase64)
    if (bytes.length !== dependency.byteLength || await sha256(bytes) !== dependency.sha256) throw failure('resource-corrupt')
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    sessionBytes.set(dependency.sha256, bytes)
    await store.writeResource({ sha256: dependency.sha256, byteLength: bytes.length,
      mediaType: dependency.mediaType, bytes, storedAt: new Date().toISOString() })
      // Losing the cache costs a re-download on the next open, not correctness for this one.
      .catch(() => diagnose(record, 'verify', 'storage-unavailable', `依赖 ${dependency.dependencyId} 未能写入浏览器缓存。`))
    return bytes
  }

  async function submitReport(target: PreparationTarget, record: PreparationRecord) {
    const manifest = preparedManifest(target.binding)
    // The report keeps its identity before the call, so a failed upload continues later without a new one.
    if (!record.reportId || !record.reportRequestId) {
      record.reportId = crypto.randomUUID()
      record.reportRequestId = crypto.randomUUID()
      await store.write(structuredClone(record)).catch(() => undefined)
    }
    const report: ComponentPreparationReport = componentPreparationReportSchema.parse({ formatVersion: 1,
      componentId: manifest.componentId, version: manifest.version, definitionDigest: target.binding.definition.digest,
      preparationProtocolVersion: manifest.environment.preparationProtocolVersion,
      selfTestVersion: manifest.selfTest.selfTestVersion, hostVersion, device: record.device,
      status: record.status, reason: record.reason, stage: record.stage, capabilities: record.capabilities,
      durationMs: record.durationMs, resourceBytes: record.resourceBytes, cacheHit: record.cacheHit, preview: false,
      memoryNote: '仅统计准备实际取得的依赖字节数；未测量浏览器进程内存。' })
    try {
      await transport.submitReport(target, { reportId: record.reportId, requestId: record.reportRequestId, report })
      record.reportSubmitted = true
    } catch {
      // Upload failure never blocks the verified local capability; the same identity resumes when connected.
      diagnose(record, 'activate', 'none', '准备报告尚未登记，将按原报告身份继续。')
    }
    await store.write(structuredClone(record)).catch(() => publish(record))
  }

  async function run(target: PreparationTarget, record: PreparationRecord): Promise<PreparationResult> {
    const manifest = preparedManifest(target.binding)
    const started = Date.now()
    const cached = new Set<string>()
    const dependencyFailure = new Map<string, PreparationReasonCode>()
    try {
      const device = detect()
      const deviceFingerprint = await fingerprint(device)
      record.device = device
      record.deviceFingerprint = deviceFingerprint
      await commit(record, { stage: 'detect', status: 'preparing', reason: 'none', device, deviceFingerprint })
      if (manifest.environment.preparationProtocolVersion !== 1) {
        diagnose(record, 'detect', 'protocol-unsupported', `未实现声明的准备协议版本 ${manifest.environment.preparationProtocolVersion}`)
        await commit(record, { stage: 'detect', status: 'unsupported-device', reason: 'protocol-unsupported' })
        return { preparationId: record.preparationId, snapshot: publish(record) }
      }
      const missing = missingFeatures(device, manifest.environment.requiredFeatures)
      if (missing.length) {
        // A device that lacks a required feature is not the same case as a resource that is temporarily unreachable.
        diagnose(record, 'detect', 'device-feature-missing', `缺少浏览器能力：${missing.join('、')}`)
        await commit(record, { stage: 'detect', status: 'unsupported-device', reason: 'device-feature-missing' })
        return { preparationId: record.preparationId, snapshot: publish(record) }
      }
      await commit(record, { stage: 'fetch', status: 'preparing' })
      const acquired: { dependencyId: string; bytes: Uint8Array }[] = []
      let resourceBytes = 0
      for (const dependency of manifestDependencies(manifest)) {
        try {
          const bytes = await acquire(target, record, dependency, cached)
          acquired.push({ dependencyId: dependency.dependencyId, bytes })
          resourceBytes += bytes.length
        } catch (error) {
          const reason = (error as { reason?: PreparationReasonCode }).reason ?? 'resource-missing'
          dependencyFailure.set(dependency.dependencyId, reason)
          diagnose(record, 'fetch', reason, `依赖 ${dependency.dependencyId}（${dependency.package}@${dependency.version}）未取得：${reason}`)
        }
      }
      record.cachedDependencies = [...cached]
      record.cacheHit = cached.size > 0 && cached.size === manifestDependencies(manifest).length
      record.resourceBytes = resourceBytes
      await commit(record, { stage: 'verify', status: 'preparing', cachedDependencies: record.cachedDependencies,
        cacheHit: record.cacheHit, resourceBytes })

      const fingerprints = new Map<string, string>()
      const capabilitiesOf = new Map<string, ComponentCapability[]>()
      for (const step of manifest.selfTest.steps) {
        const capabilities = gatedCapabilities(manifest, step)
        capabilitiesOf.set(step.checkId, capabilities)
        fingerprints.set(step.checkId, await checkFingerprintOf(target, manifest, deviceFingerprint, step, capabilities))
      }
      const reusable = await Promise.all(manifest.selfTest.steps.map(async step => {
        const found = await store.readCheck(fingerprints.get(step.checkId)!).catch(() => undefined)
        return found?.verification === 'verified' ? found : undefined
      }))
      // Declared steps are one ordered sequence over a single temporary state, so reuse is all-or-nothing: a
      // configuration change hits every cached result, while any code, dependency or device change re-runs all.
      let checks: SelfTestCheck[]
      if (reusable.every(found => found !== undefined)) {
        checks = reusable.map(found => ({ checkId: found!.checkId, verification: found!.verification,
          reason: found!.reason, capabilities: found!.capabilities }))
        await commit(record, { stage: 'persist', status: 'preparing' })
      } else {
        await commit(record, { stage: 'self-test', status: 'preparing' })
        const outcome = await selfTest({ preparationId: record.preparationId, binding: target.binding, manifest,
          viewUrl: componentViewUrl(target), dependencies: acquired, initialContent: manifest.initialState })
        // A dependency that never arrived explains its own gated checks better than a generic mismatch.
        checks = outcome.checks.map(check => {
          const blocked = [...dependencyFailure.keys()].find(id => manifest.environment.capabilityDependencies
            .some(item => item.dependencyIds.includes(id) && check.capabilities.includes(item.capability)))
          return blocked && check.verification === 'failed' ? { ...check, reason: dependencyFailure.get(blocked)! } : check
        })
        for (const step of manifest.selfTest.steps) {
          const check = checks.find(item => item.checkId === step.checkId)
          if (!check || check.verification !== 'verified') continue
          await store.writeCheck({ fingerprint: fingerprints.get(step.checkId)!, checkId: step.checkId,
            componentId: manifest.componentId, version: manifest.version, selfTestVersion: manifest.selfTest.selfTestVersion,
            verification: 'verified', reason: 'none', capabilities: capabilitiesOf.get(step.checkId)!,
            observedAt: new Date().toISOString() }).catch(() => { /* losing a cached result costs a re-run, not correctness */ })
        }
        await commit(record, { stage: 'persist', status: 'preparing' })
      }

      const projected = projectCapabilities(manifest, checks, dependencyFailure)
      const available = projected.filter(item => item.availability === 'available')
      const interrupted = checks.some(check => check.verification === 'interrupted')
      const failedCheck = checks.find(check => check.verification === 'failed')
      const status: PreparationStatus = interrupted ? 'self-test-failed'
        : !available.length ? (dependencyFailure.size ? 'repairable' : 'self-test-failed')
        : available.length === projected.length ? 'ready'
        : dependencyFailure.size ? 'repairable' : 'self-test-failed'
      const reason: PreparationReasonCode = interrupted ? 'self-test-interrupted'
        : status === 'ready' ? 'none' : failedCheck?.reason ?? [...dependencyFailure.values()][0] ?? 'self-test-failed'
      if (status !== 'ready') diagnose(record, 'self-test', reason, interrupted ? '自检被中断，结果未知，未启用新环境'
        : `检查未全部通过：${checks.filter(check => check.verification !== 'verified').map(check => check.checkId).join('、') || reason}`)
      // Only capabilities whose gating checks were all verified become usable; an interrupted run activates nothing.
      let environmentId: string | null = null
      if (available.length && !interrupted) {
        const environment: ActiveEnvironment = { scopeKey: record.scopeKey, environmentId: record.environmentId ?? crypto.randomUUID(),
          preparationId: record.preparationId, componentId: manifest.componentId, version: manifest.version,
          definitionDigest: target.binding.definition.digest, activatedAt: new Date().toISOString() }
        try {
          await store.writeEnvironment(environment)
          environmentId = environment.environmentId
        } catch {
          // An unpersisted pointer must not read as durable readiness; the previous environment stays as it was.
          diagnose(record, 'activate', 'storage-unavailable', '可用环境指针未能持久化，本次不声明就绪。')
        }
      }
      const activated = environmentId !== null
      await commit(record, { stage: activated ? 'activate' : 'self-test',
        status: activated ? status : status === 'ready' ? 'repairable' : status,
        reason: activated ? reason : status === 'ready' ? 'storage-unavailable' : reason,
        environmentId,
        checks: checks.map(check => ({ fingerprint: fingerprints.get(check.checkId) ?? '', checkId: check.checkId,
          verification: check.verification, reason: check.reason })),
        capabilities: projected, durationMs: Date.now() - started })
      await submitReport(target, record)
      return { preparationId: record.preparationId, snapshot: publish(record) }
    } catch (error) {
      const reason = (error as { reason?: PreparationReasonCode }).reason ?? 'storage-unavailable'
      diagnose(record, record.stage, reason, `准备未完成：${(error as Error).message}`)
      // A store failure keeps the diagnostics and the previously active environment; it never claims readiness.
      const capabilities = projectCapabilities(manifest, [], dependencyFailure)
      try { await commit(record, { status: 'repairable', reason, capabilities, durationMs: Date.now() - started }) }
      catch { publish(record) }
      return { preparationId: record.preparationId, snapshot: publish(record) }
    }
  }

  async function identity(target: PreparationTarget, requestId: string): Promise<PreparationRecord> {
    const manifest = preparedManifest(target.binding)
    const device = detect()
    const deviceFingerprint = await fingerprint(device)
    const scopeKey = scopeKeyOf(target)
    const requestDigest = await requestDigestOf(target, deviceFingerprint)
    const existing = await store.list(scopeKey).catch(() => [])
    // Same scope and same fingerprint reuse the original identity instead of installing or self-testing twice.
    const reused = existing.find(record => record.requestDigest === requestDigest)
    if (reused) return reused
    const conflict = existing.find(record => record.requestId === requestId)
    if (conflict) throw failure('outcome-unknown', 'identity-conflict')
    const now = new Date().toISOString()
    return { preparationId: crypto.randomUUID(), scopeKey, requestId, requestDigest,
      componentId: manifest.componentId, version: manifest.version, definitionDigest: target.binding.definition.digest,
      configurationDigest: await fingerprint(target.binding.configuration), selfTestVersion: manifest.selfTest.selfTestVersion,
      stage: 'resolve', status: 'unprepared', reason: 'none', device, deviceFingerprint, environmentId: null,
      checks: [], capabilities: [], cachedDependencies: [], cacheHit: false, resourceBytes: 0, durationMs: 0,
      reportId: null, reportRequestId: null, reportSubmitted: false, diagnostics: [], createdAt: now, updatedAt: now }
  }

  async function start(target: PreparationTarget, requestId: string, expectedPreparationId?: string): Promise<PreparationResult> {
    const record = await identity(target, requestId)
    // The same identity with different fixed inputs is refused; the original record stays intact.
    if (expectedPreparationId && expectedPreparationId !== record.preparationId) throw failure('outcome-unknown', 'identity-conflict')
    const inFlight = running.get(record.preparationId)
    if (inFlight) return inFlight
    const task = lock(record.preparationId, async () => {
      const persisted = await store.read(record.preparationId).catch(() => undefined)
      const current = persisted ?? record
      if (persisted && persisted.requestDigest === record.requestDigest && persisted.status === 'ready' && persisted.environmentId) {
        // A warm open re-reads and re-hashes the bytes it is about to use: a cache hit does not prove they survived.
        const dependencies = manifestDependencies(preparedManifest(target.binding))
        const cached = await Promise.all(dependencies.map(async dependency => {
          const stored = await store.readResource(dependency.sha256).catch(() => undefined)
          return !!stored && stored.bytes.length === dependency.byteLength && await sha256(stored.bytes) === dependency.sha256
        }))
        const cacheHit = dependencies.length > 0 && cached.every(Boolean)
        if (persisted.cacheHit !== cacheHit) await commit(persisted, { cacheHit }).catch(() => undefined)
        // A report that never reached the owner is retried under its original identity; local readiness does not wait on it.
        if (!persisted.reportSubmitted) await submitReport(target, persisted).catch(() => undefined)
        return { preparationId: persisted.preparationId, snapshot: publish(persisted) }
      }
      current.requestId = requestId
      await commit(current, { stage: current.stage === 'resolve' ? 'identity' : current.stage, status: 'preparing' })
      return run(target, current)
    })
    running.set(record.preparationId, task)
    try { return await task } finally { running.delete(record.preparationId) }
  }

  async function capabilities(target: PreparationTarget): Promise<CapabilityProjection> {
    const manifest = preparedManifest(target.binding)
    const environment = await store.readEnvironment(scopeKeyOf(target)).catch(() => undefined)
    if (!environment || environment.definitionDigest !== target.binding.definition.digest)
      return { environmentId: null, capabilities: projectCapabilities(manifest, [], new Map()) }
    const record = await store.read(environment.preparationId).catch(() => undefined)
    return { environmentId: environment.environmentId, capabilities: record?.capabilities ?? projectCapabilities(manifest, [], new Map()) }
  }

  return {
    /** Persists the identity first, then advances stages that are safe to redo under the same preparationId. */
    prepare: (target: PreparationTarget, requestId: string) => start(target, requestId),
    /** Absent and unknown stay distinct: a missing record is null, an unfinished one reports its own stage. */
    query: async (preparationId: string): Promise<PreparationSnapshot | null> => {
      const record = await store.read(preparationId).catch(() => undefined)
      return record ? snapshotOf(record) : null
    },
    /** Re-checks eligibility and fixed inputs, then continues from the first unconfirmed stage under the same identity. */
    resume: (target: PreparationTarget, preparationId: string, requestId: string) => start(target, requestId, preparationId),
    capabilities,
    /** Verified bytes for the production instance, released only while this exact binding's environment is active. */
    dependencies: async (target: PreparationTarget) => {
      const manifest = preparedManifest(target.binding)
      const { environmentId, capabilities: projected } = await capabilities(target)
      if (!environmentId) throw new Error('capability-unavailable')
      const delivered: { dependencyId: string; scriptBase64: string }[] = []
      for (const dependency of manifestDependencies(manifest)) {
        const gated = manifest.environment.capabilityDependencies
          .filter(item => item.dependencyIds.includes(dependency.dependencyId)).map(item => item.capability)
        if (!gated.every(capability => projected.some(item => item.capability === capability && item.availability === 'available'))) continue
        const stored = await store.readResource(dependency.sha256).catch(() => undefined)
        const bytes = stored && stored.bytes.length === dependency.byteLength && await sha256(stored.bytes) === dependency.sha256
          ? stored.bytes : sessionBytes.get(dependency.sha256)
        // Bytes are re-hashed before delivery whichever copy survived; a cache miss alone does not disqualify them.
        if (!bytes || bytes.length !== dependency.byteLength || await sha256(bytes) !== dependency.sha256)
          throw new Error('resource-unavailable')
        delivered.push({ dependencyId: dependency.dependencyId, scriptBase64: encodeBase64(bytes) })
      }
      return delivered
    },
    reports: async (target: PreparationTarget) => componentPreparationReportsSchema.parse(await transport.reports(target)),
    subscribe(scopeKey: string, listener: (snapshot: PreparationSnapshot) => void) {
      const set = listeners.get(scopeKey) ?? new Set()
      set.add(listener)
      listeners.set(scopeKey, set)
      return () => { set.delete(listener) }
    },
    scopeKey: scopeKeyOf,
  }
}
export type ComponentPreparation = ReturnType<typeof createComponentPreparation>
export const componentPreparation = createComponentPreparation()
