import { componentInitializeSchema, componentPreparationMessageSchema, componentPreparationReplySchema,
  type ComponentBinding, type ComponentCapability, type ComponentPreparedManifest,
  type ComponentSelfTestStep, type PreparationReasonCode, type PreparationVerification } from '@xunjie/contracts/components'
import { createPreparationBridge } from './bridge'
import { encodeBase64 } from './device'

export interface SelfTestCheck {
  checkId: string
  verification: PreparationVerification
  reason: PreparationReasonCode
  capabilities: ComponentCapability[]
}
export interface SelfTestOutcome { checks: SelfTestCheck[]; interrupted: boolean; elapsedMs: number }

/**
 * Which capabilities one check gates. The mapping is fixed and covers only the declared step kinds, so a new
 * kind must be added here before a component may declare it; an unknown step can never silently pass.
 */
export function gatedCapabilities(manifest: ComponentPreparedManifest, step: ComponentSelfTestStep): ComponentCapability[] {
  if (step.kind === 'dependency-loads')
    return [...new Set(manifest.environment.capabilityDependencies
      .filter(item => item.dependencyIds.some(id => step.dependencyIds.includes(id)))
      .map(item => item.capability))]
  if (step.kind === 'highlight-matches' || step.kind === 'highlight-releases') return ['material.highlight']
  return ['workspace.read', 'workspace.change']
}

function matches(step: ComponentSelfTestStep, observation: unknown): boolean {
  if (typeof observation !== 'object' || observation === null) return false
  const kind = (observation as { kind?: unknown }).kind
  if (step.kind === 'dependency-loads') {
    if (kind !== 'loaded') return false
    const loaded = (observation as { loaded: { dependencyId: string; globals: string[] }[] }).loaded
    return step.dependencyIds.every(id => loaded.some(entry => entry.dependencyId === id && entry.globals.includes(step.expect.globalName)))
  }
  if (step.kind === 'highlight-matches' || step.kind === 'highlight-releases') {
    if (kind !== 'highlight') return false
    const value = observation as { marks: number; markedTexts: string[]; bodyText: string }
    if (value.marks !== step.expect.marks || value.markedTexts.length !== step.expect.marks) return false
    return step.kind === 'highlight-matches'
      ? value.markedTexts.every(text => text === step.expect.markedText)
      : value.markedTexts.length === 0 && value.bodyText === step.expect.bodyText
  }
  if (kind !== 'annotations') return false
  const value = observation as { annotations: number; note: string; rejected: boolean }
  if (value.annotations !== step.expect.annotations) return false
  return step.kind === 'annotation-roundtrip' ? !value.rejected && value.note === step.expect.note : value.rejected === step.expect.rejected
}

export interface SelfTestInput {
  preparationId: string
  binding: ComponentBinding
  manifest: ComponentPreparedManifest
  viewUrl: string
  dependencies: { dependencyId: string; bytes: Uint8Array }[]
  initialContent: unknown
}

/**
 * Runs the fixed self-test in an isolated instance of the same view code and the same verified dependency bytes.
 * Nothing here writes student work; the only writable surface is the in-memory preparation bridge.
 */
export async function runSelfTest(input: SelfTestInput): Promise<SelfTestOutcome> {
  const started = Date.now()
  const deadline = started + input.manifest.budget.selfTestTimeoutMs
  const steps = input.manifest.selfTest.steps
  const checks: SelfTestCheck[] = steps.map(step => ({ checkId: step.checkId, verification: 'unverified', reason: 'none',
    capabilities: gatedCapabilities(input.manifest, step) }))
  const bridge = createPreparationBridge(input.preparationId, input.binding, input.initialContent)
  const frame = document.createElement('iframe')
  const channel = new MessageChannel()
  const pending = new Map<string, { settle(reply: unknown): void; timer: ReturnType<typeof setTimeout> }>()
  let live = true
  let ready: (() => void) | undefined
  const readySignal = new Promise<void>(resolve => { ready = resolve })
  const fail = (reason: PreparationReasonCode) => {
    for (const check of checks) if (check.verification === 'unverified') { check.verification = 'interrupted'; check.reason = reason }
    return { checks, interrupted: true, elapsedMs: Date.now() - started }
  }
  const retire = () => {
    live = false
    bridge.close()
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
    channel.port1.close()
    frame.remove()
  }
  try {
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.setAttribute('referrerPolicy', 'no-referrer')
    frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'")
    frame.setAttribute('aria-hidden', 'true')
    frame.setAttribute('tabindex', '-1')
    frame.title = `${input.binding.configuration.title} 准备自检`
    frame.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;border:0'
    const initialize = componentInitializeSchema.parse({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
      messageId: crypto.randomUUID(), method: 'host.initialize',
      payload: { binding: input.binding, theme: {}, materials: [input.manifest.selfTest.material], readOnly: false,
        preparation: { preparationProtocolVersion: 1, mode: 'preparation' } } })
    channel.port1.onmessage = (event: MessageEvent) => {
      if (!live) return
      const raw = event.data
      if (!raw || typeof raw !== 'object'
        || ((typeof (raw as { messageId?: unknown }).messageId !== 'string') && (typeof (raw as { replyTo?: unknown }).replyTo !== 'string'))) return
      if ((raw as { preparationProtocolVersion?: unknown }).preparationProtocolVersion === 1) {
        const replyTo = (raw as { replyTo: string }).replyTo
        const entry = pending.get(replyTo)
        if (!entry) return
        pending.delete(replyTo)
        clearTimeout(entry.timer)
        const parsed = componentPreparationReplySchema.safeParse(raw)
        // A malformed observation is a failed check, not a mismatch against the fixed expectation.
        entry.settle(parsed.success ? parsed.data : { error: { code: 'invalid-input' } })
        return
      }
      if ((raw as { hostApiVersion?: unknown }).hostApiVersion !== 1) return
      const message = raw as { messageId: string; method?: string }
      void (async () => {
        try {
          const payload = await bridge.handle(raw)
          if (!live) return
          channel.port1.postMessage({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId, replyTo: message.messageId, payload })
          if (message.method === 'component.ready') ready?.()
        } catch (failure) {
          if (!live) return
          channel.port1.postMessage({ hostApiVersion: 1, connectionId: bridge.connectionId, instanceId: bridge.instanceId,
            replyTo: message.messageId, error: { code: failure instanceof Error ? failure.message : 'resource-unavailable' } })
        }
      })()
    }
    const loaded = new Promise<void>(resolve => { frame.onload = () => resolve() })
    frame.src = input.viewUrl
    document.body.append(frame)
    await loaded
    frame.contentWindow?.postMessage(initialize, '*', [channel.port2])
    const send = (request: { method: string; payload: unknown }) => new Promise<unknown>((resolve, reject) => {
      const remaining = deadline - Date.now()
      if (remaining <= 0) { reject(new Error('self-test-interrupted')); return }
      const message = componentPreparationMessageSchema.parse({ preparationProtocolVersion: 1, connectionId: bridge.connectionId,
        instanceId: bridge.instanceId, messageId: crypto.randomUUID(), request })
      const timer = setTimeout(() => { pending.delete(message.messageId); reject(new Error('self-test-interrupted')) }, remaining)
      pending.set(message.messageId, { settle: resolve, timer })
      channel.port1.postMessage(message)
    })
    // A handshake timeout must never be mistaken for component.ready: only the view's own message resolves this.
    let handshakeTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([readySignal, new Promise<never>((_, reject) => {
        handshakeTimer = setTimeout(() => reject(new Error('self-test-interrupted')), Math.max(0, deadline - Date.now()))
      })])
    } finally { if (handshakeTimer) clearTimeout(handshakeTimer) }
    if (!live) return fail('self-test-interrupted')
    // A dependency that never arrived is not delivered: the checks it gates then fail on their own evidence.
    if (input.dependencies.length)
      await send({ method: 'preparation.load',
        payload: { dependencies: input.dependencies.map(item => ({ dependencyId: item.dependencyId, scriptBase64: encodeBase64(item.bytes) })) } })
    await send({ method: 'preparation.reset', payload: {} })
    for (const [index, step] of steps.entries()) {
      const check = checks[index]!
      const reply = await send({ method: 'preparation.step', payload: { step } }) as { observation?: unknown; error?: { code?: string } }
      if (reply.error) { check.verification = 'failed'; check.reason = 'self-test-failed'; continue }
      if (matches(step, reply.observation)) { check.verification = 'verified'; check.reason = 'none' }
      else { check.verification = 'failed'; check.reason = 'self-test-mismatch' }
    }
    return { checks, interrupted: false, elapsedMs: Date.now() - started }
  } catch (error) {
    // An interrupted run leaves its remaining checks unverified: a missing observation is never a passed check.
    return fail(error instanceof Error && error.message === 'self-test-interrupted' ? 'self-test-interrupted' : 'self-test-failed')
  } finally { retire() }
}
