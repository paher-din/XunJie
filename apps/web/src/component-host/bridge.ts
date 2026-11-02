import { z } from 'zod'
import { acceptsState, componentMessageSchema, componentChangeSchema, componentStateSchema,
  componentStateName, componentInstanceId, type ComponentBinding } from '@xunjie/contracts/components'
import type { ReliableWorkspace } from '../reliable-workspace'

export const componentStateMediaType = 'application/vnd.xunjie.component-state+json'
/** A mount grants exactly one fixed instance and expires independently of other valid views. */
export function createComponentBridge(workspace: ReliableWorkspace, activityId: string, binding: ComponentBinding, canWrite: () => boolean) {
  const connectionId = crypto.randomUUID(), instanceId = componentInstanceId(activityId, binding.key)
  const manifest = binding.definition.manifest
  let active = true
  const receipts = new Map<string, { input: string; reply: Promise<unknown> }>()
  const current = () => workspace.snapshot().files.find(file => file.name === componentStateName(binding.key))
  function read() {
    const file = current()
    if (!file) return { contentId: null, content: manifest.initialState }
    const value = componentStateSchema.parse(JSON.parse(file.value))
    if (file.kind !== 'state' || file.encoding !== 'json' || file.mediaType !== componentStateMediaType
      || value.componentId !== manifest.componentId || value.version !== manifest.version || value.stateVersion !== manifest.stateVersion
      || value.instanceId !== instanceId || value.definitionDigest !== binding.definition.digest
      || !acceptsState(manifest.stateShape, value.content)) throw new Error('invalid-input')
    return { contentId: file.contentId, content: value.content }
  }
  async function handle(raw: unknown) {
    if (!active || !canWrite()) throw new Error('stale-connection')
    if ((raw as { hostApiVersion?: unknown })?.hostApiVersion !== 1) throw new Error('unsupported-version')
    const parsed = componentMessageSchema.safeParse(raw)
    if (!parsed.success) throw new Error('invalid-input')
    const message = parsed.data
    if (message.connectionId !== connectionId || message.instanceId !== instanceId) throw new Error('stale-connection')
    if (message.method === 'component.close') { z.object({}).strict().parse(message.payload); active = false; return { closed: true } }
    if (message.method === 'component.ready') { z.object({}).strict().parse(message.payload); return { ready: true } }
    if (message.method === 'component.event') {
      z.object({ eventId: z.uuid(), sequence: z.number().int().nonnegative(), kind: z.literal('interaction') }).strict().parse(message.payload)
      return { received: true } // Transport acknowledgement only; no learning evidence or model call.
    }
    const capability = message.method
    if (capability !== 'workspace.read' && capability !== 'workspace.change') throw new Error('capability-unavailable')
    if (!manifest.requiredCapabilities.includes(capability)) throw new Error('capability-unavailable')
    if (!workspace.snapshot().ready || workspace.snapshot().conflict) throw new Error('conflict')
    if (message.method === 'workspace.read') { z.object({}).strict().parse(message.payload); return read() }
    const input = componentChangeSchema.parse(message.payload)
    if (!acceptsState(manifest.stateShape, input.content)) throw new Error('invalid-input')
    const fingerprint = JSON.stringify(input)
    const known = receipts.get(input.operationId)
    if (known) { if (known.input !== fingerprint) throw new Error('conflict'); return known.reply }
    const previous = current()
    const snapshot = componentStateSchema.parse({ formatVersion: 1, instanceId, componentId: manifest.componentId,
      version: manifest.version, definitionDigest: binding.definition.digest, stateVersion: manifest.stateVersion,
      operationId: input.operationId, content: input.content })
    const contentId = input.contentId
    if (contentId === input.expectedContentId || workspace.snapshot().files.some(file => file.contentId === contentId)) throw new Error('invalid-input')
    const file = { objectId: previous?.objectId ?? crypto.randomUUID(), contentId, name: componentStateName(binding.key),
      kind: 'state' as const, encoding: 'json' as const, mediaType: componentStateMediaType, value: JSON.stringify(snapshot) }
    if ((previous?.contentId ?? null) !== input.expectedContentId) {
      workspace.retainConflict([...workspace.snapshot().files.filter(item => item.objectId !== file.objectId), file])
      await workspace.protect()
      throw new Error('conflict')
    }
    workspace.change([...workspace.snapshot().files.filter(item => item.objectId !== file.objectId), file], true)
    const reply = workspace.leave().then(() => {
      if (workspace.snapshot().conflict) throw new Error('conflict')
      const confirmed = current()?.contentId ?? null
      return { confirmation: 'local-protected', contentId: confirmed, requestedContentId: contentId, superseded: confirmed !== contentId }
    })
    receipts.set(input.operationId, { input: fingerprint, reply })
    // Transport cache is bounded; older operations still fail expected-content CAS instead of being applied twice.
    if (receipts.size > 256) receipts.delete(receipts.keys().next().value!)
    try { return await reply } catch (error) { receipts.delete(input.operationId); throw error }
  }
  return { connectionId, instanceId, handle, read, close() { active = false } }
}
