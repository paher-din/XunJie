import { acceptsState, type ComponentBinding, type StateShape } from '@xunjie/contracts/components'
import { executionActionSchema, type CheckpointResume, type ExecutionAction, type ExecutionLimits, type ExecutionPlan } from '@xunjie/contracts/execution'
import { decideExecutionPlacement, plannedExecutionScope, type CourseExecutionPlan, type ExecutionDevice } from '@xunjie/contracts/execution'
import type { ReliableWorkspace } from '../reliable-workspace'
import { actionScopeFromWorkspaceKey } from '../reliable-workspace/actions'
import { digestOf, readComponentState } from './action'

export interface DeclaredSession {
  adapterId: string
  adapterVersion: number
  controls?: ('pause' | 'resume' | 'step' | 'reset' | 'checkpoint')[]
  checkpointVersion?: number
  lifecycle?: { acrossViews: true; pageClose: 'continue'; activityClose: 'stop'; reconnect: 'query' }
  parameters: StateShape
  operation: { operationId: string; parameters: StateShape; result: StateShape }
  budgets: { operationTimeoutMs: number; idleMs: number; maxMs: number; memoryMiB: number
    inputBytes: number; outputBytes: number; concurrentSessions: number; queuedSessions: number }
}

/** The declared session, or null for a job/prepared component. */
export function declaredSession(binding: ComponentBinding): DeclaredSession | null {
  const manifest = binding.definition.manifest
  return manifest.formatVersion === 1 && manifest.session ? manifest.session : null
}

/** The wire still speaks one fixed limit set; a session maps its own budgets onto it. */
export function nativeLimits(session: DeclaredSession): ExecutionLimits {
  return { timeMs: session.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: session.budgets.inputBytes,
    outputBytes: session.budgets.outputBytes, concurrentJobs: session.budgets.concurrentSessions,
    queuedJobs: session.budgets.queuedSessions }
}

export async function nativePlan(binding: ComponentBinding, operationId: string): Promise<ExecutionPlan> {
  const manifest = binding.definition.manifest
  return { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session',
    planDigest: await digestOf({ planId: 'native-session', planVersion: 1, componentId: manifest.componentId,
      componentVersion: manifest.version, operationId }) }
}

export interface SessionPlacement {
  plan: CourseExecutionPlan
  device: ExecutionDevice
  remoteAvailable: boolean
}

export function sessionPlacement(binding: ComponentBinding, placement: SessionPlacement) {
  const session = declaredSession(binding)
  if (!session || plannedExecutionScope(placement.plan, { key: binding.key,
    definitionDigest: binding.definition.digest, operationId: session.operation.operationId,
    location: 'native' }) !== 'allowed') throw new Error('not-planned')
  return decideExecutionPlacement({ ...placement, operationId: session.operation.operationId, kind: 'session',
    adapter: { adapterId: session.adapterId, adapterVersion: session.adapterVersion } })
}

/**
 * One assembly for opening a native session. The host, not the component, fixes the adapter,
 * the plan, the limits and the state copy the session cites.
 */
export async function sessionAction(input: {
  workspace: ReliableWorkspace; binding: ComponentBinding; instanceId: string
  receiver: ExecutionAction['receiver']; parameters: unknown; requestId: string
  placement?: SessionPlacement
  resumeFromCheckpoint?: CheckpointResume
}): Promise<ExecutionAction> {
  input = { ...input, binding: structuredClone(input.binding), receiver: structuredClone(input.receiver),
    parameters: structuredClone(input.parameters),
    resumeFromCheckpoint: input.resumeFromCheckpoint && structuredClone(input.resumeFromCheckpoint), placement: input.placement && structuredClone(input.placement) }
  const session = declaredSession(input.binding)
  const manifest = input.binding.definition.manifest
  if (manifest.formatVersion !== 1 || !session) throw new Error('capability-unavailable')
  if (!acceptsState(session.parameters, input.parameters)) throw new Error('invalid-input')
  const decision = input.placement && sessionPlacement(input.binding, input.placement)
  if (decision && (!decision.location || !decision.owner)) throw new Error(decision.detail)
  if (input.placement) {
    const component = input.placement.plan.components.find(item => item.key === input.binding.key)!
    if (component.configurationDigest !== await digestOf(input.binding.configuration)) throw new Error('not-planned')
  }
  const state = readComponentState(input.workspace, input.binding, input.instanceId)
  const scope = actionScopeFromWorkspaceKey(input.workspace.key)
  return executionActionSchema.parse({ protocolVersion: 2, kind: 'execution', requestId: input.requestId, scope,
    receiver: decision ? { ...input.receiver, location: decision.owner === 'school-node' ? 'remote' : 'local' } : input.receiver,
    execution: {
      instance: { instanceId: input.instanceId, key: input.binding.key, componentId: manifest.componentId,
        componentVersion: manifest.version, definitionDigest: input.binding.definition.digest,
        hostApiVersion: 1, stateVersion: manifest.stateVersion },
      operation: { operationId: session.operation.operationId, effect: 'input' },
      parameters: input.parameters,
      basis: { works: state.file ? [state.file] : [], state: state.file ? {
        name: state.file.name, contentId: state.file.contentId, sha256: await digestOf(JSON.parse(state.file.value)) } : null,
        expected: { stateContentId: state.contentId }, resources: [] },
      limits: nativeLimits(session),
      plan: await nativePlan(input.binding, session.operation.operationId),
      ...(input.placement ? { device: input.placement.device } : {}),
      session: { adapterId: session.adapterId, adapterVersion: session.adapterVersion, limits: {
        operationTimeoutMs: session.budgets.operationTimeoutMs, idleMs: session.budgets.idleMs,
        maxMs: session.budgets.maxMs, memoryMiB: session.budgets.memoryMiB,
        concurrentSessions: session.budgets.concurrentSessions, queuedSessions: session.budgets.queuedSessions } },
      ...(input.resumeFromCheckpoint ? { resumeFromCheckpoint: input.resumeFromCheckpoint } : {}),
      initiator: { kind: 'student', principalId: scope.principalId } } })
}
