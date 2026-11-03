import { z } from 'zod'
import { acceptsState, componentMessageSchema, componentChangeSchema, componentStateSchema,
  componentStateName, componentInstanceId, matchesComponentState, componentEventSchema, type ComponentBinding, type ComponentEvent } from '@xunjie/contracts/components'
import type { ReliableWorkspace } from '../reliable-workspace'

export const componentStateMediaType = 'application/vnd.xunjie.component-state+json'
export function componentError(error: unknown) {
  const codes = ['invalid-input', 'unsupported-version', 'capability-unavailable', 'forbidden', 'stale-connection', 'conflict', 'resource-unavailable', 'outcome-unknown']
  const code = error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid-input'
    : error instanceof Error && codes.includes(error.message) ? error.message : 'resource-unavailable'
  return { code, next: code === 'invalid-input' ? '核对请求结构后使用原操作身份查询，修改输入时使用新的操作身份。'
    : code === 'forbidden' ? '原空间资格已失效，请重新登录并核对课程资格。'
    : code === 'outcome-unknown' ? '保留原操作身份查询确认结果，不要生成新操作重做。'
    : '保留当前内容，可在作品中导出并重新打开核对。' }
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)]))
  return value
}
/** A mount grants exactly one fixed instance and expires independently of other valid views. */
export function createComponentBridge(workspace: ReliableWorkspace, activityId: string, binding: ComponentBinding, canWrite: () => boolean,
  consume: (event: ComponentEvent) => void = () => {}) {
  const connectionId = crypto.randomUUID(), instanceId = componentInstanceId(activityId, binding.key)
  const manifest = binding.definition.manifest
  let active = true
  let accepting = Promise.resolve()
  let sequence = 0
  const events = new Map<string, { input: string; receipt: { received: true; eventId: string; sequence: number; kind: ComponentEvent['kind'] } }>()
  const current = () => workspace.snapshot().files.find(file => file.name === componentStateName(binding.key))
  function read() {
    const file = current()
    if (!file) return { contentId: null, content: manifest.initialState }
    const value = componentStateSchema.parse(JSON.parse(file.value))
    if (!matchesComponentState(binding, activityId, file)) throw new Error('invalid-input')
    return { contentId: file.contentId, content: value.content }
  }
  async function handle(raw: unknown) {
    if (!active) throw new Error('stale-connection')
    if (!canWrite()) throw new Error('forbidden')
    if ((raw as { hostApiVersion?: unknown })?.hostApiVersion !== 1) throw new Error('unsupported-version')
    const parsed = componentMessageSchema.safeParse(raw)
    if (!parsed.success) throw new Error('invalid-input')
    const message = parsed.data
    if (message.connectionId !== connectionId || message.instanceId !== instanceId) throw new Error('stale-connection')
    if (message.method === 'component.close') { z.object({}).strict().parse(message.payload); active = false; return { closed: true } }
    if (message.method === 'component.ready') { z.object({}).strict().parse(message.payload); return { ready: true } }
    if (message.method === 'component.event') {
      const event = componentEventSchema.parse(message.payload), input = JSON.stringify(canonical(event))
      const previous = events.get(event.eventId)
      if (previous) { if (previous.input !== input) throw new Error('conflict'); return previous.receipt }
      if (event.sequence !== sequence + 1) throw new Error('conflict')
      if (events.size >= 4096) throw new Error('capability-unavailable')
      consume(event)
      const receipt = { received: true as const, eventId: event.eventId, sequence: event.sequence, kind: event.kind }
      events.set(event.eventId, { input, receipt }); sequence = event.sequence
      return receipt
    }
    const capability = message.method
    if (capability !== 'workspace.read' && capability !== 'workspace.change') throw new Error('capability-unavailable')
    if (!manifest.requiredCapabilities.includes(capability)) throw new Error('capability-unavailable')
    if (message.method === 'workspace.read') {
      z.object({}).strict().parse(message.payload)
      if (!workspace.snapshot().ready || workspace.snapshot().conflict) throw new Error('conflict')
      return read()
    }
    const input = componentChangeSchema.parse(message.payload)
    if (!acceptsState(manifest.stateShape, input.content)) throw new Error('invalid-input')
    const snapshot = componentStateSchema.parse({ formatVersion: 1, instanceId, componentId: manifest.componentId,
      version: manifest.version, definitionDigest: binding.definition.digest, stateVersion: manifest.stateVersion,
      operationId: input.operationId, content: input.content })
    const candidate = () => {
      const previous = current()
      const file = { objectId: previous?.objectId ?? crypto.randomUUID(), contentId: input.contentId, name: componentStateName(binding.key),
        kind: 'state' as const, encoding: 'json' as const, mediaType: componentStateMediaType, value: JSON.stringify(snapshot) }
      return { previous, files: [...workspace.snapshot().files.filter(item => item.objectId !== file.objectId), file] }
    }
    const preceding = accepting
    let release!: () => void
    accepting = new Promise<void>(resolve => { release = resolve })
    return workspace.trackInput((async () => {
      try {
      const bytes = new TextEncoder().encode(JSON.stringify(canonical(input)))
      const inputDigest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('')
      await preceding
      return await workspace.applyOperation({ scope: instanceId, operationId: input.operationId, inputDigest, name: componentStateName(binding.key), contentId: input.contentId }, () => {
        if (!active) throw new Error('stale-connection')
        if (!canWrite()) throw new Error('forbidden')
        if (!workspace.snapshot().ready) throw new Error('conflict')
        if (input.contentId === input.expectedContentId || workspace.snapshot().files.some(file => file.contentId === input.contentId)) throw new Error('invalid-input')
        const { previous, files } = candidate()
        if (workspace.snapshot().conflict || (previous?.contentId ?? null) !== input.expectedContentId) {
          workspace.retainConflict(files)
          throw new Error('conflict')
        }
        workspace.change(files, true)
        // Preserve message arrival order through async admission; protection remains in the shared owner.
        release()
      }, () => {
        if (!active) throw new Error('stale-connection')
        if (!canWrite()) throw new Error('forbidden')
        workspace.retainConflict(candidate().files)
      })
      } finally { release() }
    })())
  }
  return { connectionId, instanceId, handle, read, close() { active = false } }
}
