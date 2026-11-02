import { z } from 'zod'
import { acceptsState, componentMessageSchema, componentChangeSchema, componentStateSchema, componentTestInstanceId,
  type ComponentBinding } from '@xunjie/contracts/components'

export const preparationStateMediaType = 'application/vnd.xunjie.component-state+json'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)]))
  return value
}
async function inputDigest(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)))
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(item => item.toString(16).padStart(2, '0')).join('')
}

/**
 * The self-test's only writable surface. It holds temporary state in memory for one preparation instance and
 * is deliberately not connected to ReliableWorkspace, learning data, question drafts, execution receivers or
 * learning events: a self-test cannot produce student work, and a late reply cannot reach a production mount.
 */
export function createPreparationBridge(preparationId: string, binding: ComponentBinding, initialContent: unknown) {
  const connectionId = crypto.randomUUID()
  const instanceId = componentTestInstanceId(preparationId, binding.key)
  const manifest = binding.definition.manifest
  const receipts = new Map<string, { inputDigest: string; receipt: { confirmation: 'local-protected'; contentId: string; requestedContentId: string; superseded: boolean } }>()
  let active = true
  let contentId: string | null = null
  let content: unknown = initialContent
  let writes = 0
  function read() {
    if (!acceptsState(manifest.stateShape, content)) throw new Error('invalid-input')
    return { contentId, content: structuredClone(content) }
  }
  async function handle(raw: unknown) {
    if (!active) throw new Error('stale-connection')
    if ((raw as { hostApiVersion?: unknown })?.hostApiVersion !== 1) throw new Error('unsupported-version')
    const parsed = componentMessageSchema.safeParse(raw)
    if (!parsed.success) throw new Error('invalid-input')
    const message = parsed.data
    if (message.connectionId !== connectionId || message.instanceId !== instanceId) throw new Error('stale-connection')
    if (message.method === 'component.close') { z.object({}).strict().parse(message.payload); active = false; return { closed: true } }
    if (message.method === 'component.ready') { z.object({}).strict().parse(message.payload); return { ready: true } }
    if (message.method === 'component.event') {
      z.object({ eventId: z.uuid(), sequence: z.number().int().nonnegative(), kind: z.literal('interaction') }).strict().parse(message.payload)
      return { received: true }
    }
    const capability = message.method
    if (capability !== 'workspace.read' && capability !== 'workspace.change') throw new Error('capability-unavailable')
    if (!(manifest.requiredCapabilities as readonly string[]).includes(capability)) throw new Error('capability-unavailable')
    if (capability === 'workspace.read') { z.object({}).strict().parse(message.payload); return read() }
    const input = componentChangeSchema.parse(message.payload)
    if (!acceptsState(manifest.stateShape, input.content)) throw new Error('invalid-input')
    const digest = await inputDigest(input)
    const previous = receipts.get(input.operationId)
    if (previous) {
      // A repeated message returns its original receipt; changed input under that identity is refused.
      if (previous.inputDigest !== digest) throw new Error('conflict')
      return previous.receipt
    }
    componentStateSchema.parse({ formatVersion: 1, instanceId, componentId: manifest.componentId, version: manifest.version,
      definitionDigest: binding.definition.digest, stateVersion: manifest.stateVersion, operationId: input.operationId, content: input.content })
    if (input.expectedContentId !== contentId) throw new Error('conflict')
    contentId = input.contentId
    content = structuredClone(input.content)
    writes++
    const receipt = { confirmation: 'local-protected' as const, contentId: input.contentId, requestedContentId: input.contentId, superseded: false }
    receipts.set(input.operationId, { inputDigest: digest, receipt })
    return receipt
  }
  return { connectionId, instanceId, handle, read, close() { active = false },
    observed: () => ({ writes, contentId, content: structuredClone(content) }) }
}
