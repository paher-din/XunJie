import { z } from 'zod'
import { acceptsState, componentMessageSchema, componentChangeSchema, componentStateSchema,
  componentStateName, componentInstanceId, componentExecutionSubmitSchema, componentExecutionQuerySchema,
  componentExecutionStopSchema, type ComponentBinding } from '@xunjie/contracts/components'
import { executionCapabilitiesSchema } from '@xunjie/contracts/execution'
import type { ReliableWorkspace } from '../reliable-workspace'
import type { ExecutionController } from '../tool-execution/controller'
import { canonical, componentStateMediaType, browserLimits, browserPlan, executionAction, readComponentState } from '../tool-execution/action'

export { componentStateMediaType }
export function componentError(error: unknown) {
  const codes = ['invalid-input', 'unsupported-version', 'capability-unavailable', 'forbidden', 'stale-connection', 'conflict', 'resource-unavailable', 'outcome-unknown']
  const code = error instanceof z.ZodError || error instanceof SyntaxError ? 'invalid-input'
    : error instanceof Error && codes.includes(error.message) ? error.message : 'resource-unavailable'
  return { code, next: code === 'invalid-input' ? '核对请求结构后使用原操作身份查询，修改输入时使用新的操作身份。'
    : code === 'forbidden' ? '原空间资格已失效，请重新登录并核对课程资格。'
    : code === 'outcome-unknown' ? '保留原操作身份查询确认结果，不要生成新操作重做。'
    : '保留当前内容，可在作品中导出并重新打开核对。' }
}
/** A mount grants exactly one fixed instance and expires independently of other valid views. */
export function createComponentBridge(workspace: ReliableWorkspace, activityId: string, binding: ComponentBinding,
  canWrite: () => boolean, execution?: { controller: ExecutionController; canRun: () => boolean }) {
  const connectionId = crypto.randomUUID(), instanceId = componentInstanceId(activityId, binding.key)
  const manifest = binding.definition.manifest
  let active = true
  let accepting = Promise.resolve()
  const current = () => workspace.snapshot().files.find(file => file.name === componentStateName(binding.key))
  function read() { return readComponentState(workspace, binding, instanceId) }
  function assertWritable() {
    if (!active) throw new Error('stale-connection')
    if (!canWrite()) throw new Error('forbidden')
  }
  /** The host, not the component, assembles the fixed basis, plan and limits from the manifest. */
  async function submitExecution(raw: unknown) {
    const input = componentExecutionSubmitSchema.parse(raw)
    if (!manifest.operations || !manifest.algorithm) throw new Error('capability-unavailable')
    if (!execution || !execution.canRun()) throw new Error('capability-unavailable')
    const action = await executionAction({ workspace, binding, instanceId, receiver: {
      receiverId: execution.controller.receiver.identity.receiverId, location: 'local', kind: 'execution' },
      operationId: input.operationId, parameters: input.parameters, expectedContentId: input.expectedContentId,
      requestId: input.requestId })
    await execution.controller.submit(action)
    return action
  }
  async function handle(raw: unknown) {
    assertWritable()
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
    if (capability === 'execution.capabilities') {
      z.object({}).strict().parse(message.payload)
      if (!manifest.operations || !manifest.algorithm) throw new Error('capability-unavailable')
      const runnable = !!execution && execution.canRun()
      // Exactly the plan and limits the accepted command will carry, plus the executor's real counts.
      const counts = execution ? execution.controller.counts() : { running: 0, queued: 0 }
      return executionCapabilitiesSchema.parse({ plans: execution
        ? await Promise.all(manifest.operations.map(item => browserPlan(manifest, item.operationId))) : [],
      operations: manifest.operations.map(item => ({ operationId: item.operationId, instanceId,
        limits: browserLimits(manifest, item), available: runnable,
        reason: runnable ? null : '当前视图不可发起执行。' })),
      running: counts.running, queued: counts.queued })
    }
    if (capability === 'execution.submit') {
      // The handoff is durable, not completed: the component queries the real state next.
      const action = await submitExecution(message.payload)
      return { requestId: action.requestId }
    }
    if (capability === 'execution.query') {
      const input = componentExecutionQuerySchema.parse(message.payload)
      if (!execution) throw new Error('capability-unavailable')
      // An empty answer is honest: the durable handoff may not be readable yet, and it still exists.
      return await execution.controller.query(input.requestId, input.inputDigest)
    }
    if (capability === 'execution.stop') {
      const input = componentExecutionStopSchema.parse(message.payload)
      if (!execution) throw new Error('capability-unavailable')
      // The stop keeps the identity the caller retries with; a second click is the same stop.
      await execution.controller.stop(input.requestId, input.stopId, input.inputDigest)
      return await execution.controller.query(input.requestId, input.inputDigest)
    }
    if (capability === 'execution.control') throw new Error('capability-unavailable')
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
      }, () => workspace.retainConflict(candidate().files))
      } finally { release() }
    })())
  }
  return { connectionId, instanceId, handle, read, close() { active = false } }
}
