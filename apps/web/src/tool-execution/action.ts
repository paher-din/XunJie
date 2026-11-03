import { acceptsState, componentStateSchema, componentStateName, type ComponentBinding, type ComponentManifest } from '@xunjie/contracts/components'
import { executionActionSchema, defaultExecutionLimits, type ExecutionAction, type ExecutionLimits, type ExecutionPlan } from '@xunjie/contracts/execution'
import type { ReliableWorkspace } from '../reliable-workspace'
import { actionScopeFromWorkspaceKey } from '../reliable-workspace/actions'

export const componentStateMediaType = 'application/vnd.xunjie.component-state+json'
export function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)]))
  return value
}
export async function digestOf(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(value)))
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('')
}
/** The instance state file is the only mutable input a run may cite; it is read, never guessed. */export function readComponentState(workspace: ReliableWorkspace, binding: ComponentBinding, instanceId: string) {
  const manifest = binding.definition.manifest
  const file = workspace.snapshot().files.find(item => item.name === componentStateName(binding.key))
  if (!file) return { file: undefined, contentId: null, content: manifest.initialState }
  const value = componentStateSchema.parse(JSON.parse(file.value))
  if (file.kind !== 'state' || file.encoding !== 'json' || file.mediaType !== componentStateMediaType
    || value.componentId !== manifest.componentId || value.version !== manifest.version || value.stateVersion !== manifest.stateVersion
    || value.instanceId !== instanceId || value.definitionDigest !== binding.definition.digest
    || !acceptsState(manifest.stateShape, value.content)) throw new Error('invalid-input')
  return { file, contentId: file.contentId, content: value.content }
}
/**
 * The one browser plan and limit set this adapter really honours. The component is told this and
 * the accepted command carries it, so what a view is promised cannot drift from what is enforced.
 */
export async function browserPlan(manifest: ComponentManifest, operationId: string): Promise<ExecutionPlan> {
  return { planId: 'browser-job', planVersion: 1, location: 'browser', kind: 'job',
    planDigest: await digestOf({ planId: 'browser-job', planVersion: 1, componentId: manifest.componentId,
      componentVersion: manifest.version, operationId }) }
}
/** Declared ceiling, not a looser per-run guess: 5 s, 16 MiB algorithm memory, 1 MiB in/out,
 *  2 concurrent (queue 4). These are algorithm limits, not Chrome's total. */
export function browserLimits(manifest: ComponentManifest,
  operation: { budgets: { timeMs: number; outputBytes: number } }): ExecutionLimits {
  return { timeMs: operation.budgets.timeMs, memoryPages: manifest.algorithm!.memoryPages,
    inputBytes: defaultExecutionLimits.inputBytes, outputBytes: operation.budgets.outputBytes,
    concurrentJobs: defaultExecutionLimits.concurrentJobs, queuedJobs: defaultExecutionLimits.queuedJobs }
}

/**
 * One assembly for every legitimate run entry: the view and the workspace panel both cite the same
 * fixed basis, plan and limits. The component never supplies the basis it is being judged by.
 */
export async function executionAction(input: {
  workspace: ReliableWorkspace; binding: ComponentBinding; instanceId: string
  receiver: ExecutionAction['receiver']; operationId: string; parameters: unknown
  expectedContentId: string | null; requestId: string
}): Promise<ExecutionAction> {
  const manifest = input.binding.definition.manifest
  if (manifest.formatVersion !== 1 || !manifest.operations || !manifest.algorithm) throw new Error('capability-unavailable')
  const operation = manifest.operations.find(item => item.operationId === input.operationId)
  if (!operation) throw new Error('capability-unavailable')
  if (!acceptsState(operation.parameters, input.parameters)) throw new Error('invalid-input')
  const state = readComponentState(input.workspace, input.binding, input.instanceId)
  if (state.contentId !== input.expectedContentId) throw new Error('conflict')
  const resources = [{ kind: 'entry' as const, resourceId: manifest.entry.resourceId, sha256: manifest.entry.sha256,
    byteLength: manifest.entry.byteLength, mediaType: manifest.entry.mediaType },
    { kind: 'algorithm' as const, resourceId: manifest.algorithm.resource.resourceId,
      sha256: manifest.algorithm.resource.sha256, byteLength: manifest.algorithm.resource.byteLength,
      mediaType: manifest.algorithm.resource.mediaType }]
  const scope = actionScopeFromWorkspaceKey(input.workspace.key)
  return executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId: input.requestId, scope,
    receiver: input.receiver,
    execution: {
      instance: { instanceId: input.instanceId, key: input.binding.key, componentId: manifest.componentId,
        componentVersion: manifest.version, definitionDigest: input.binding.definition.digest, hostApiVersion: 1,
        stateVersion: manifest.stateVersion },
      operation: { operationId: operation.operationId, effect: operation.effect },
      parameters: input.parameters,
      basis: { works: [], state: state.file ? { name: componentStateName(input.binding.key), contentId: state.file.contentId,
        sha256: await digestOf(JSON.parse(state.file.value)) } : null,
        expected: { stateContentId: input.expectedContentId }, resources },
      limits: browserLimits(manifest, operation),
      plan: await browserPlan(manifest, operation.operationId),
      initiator: { kind: 'student', principalId: scope.principalId } } })
}
