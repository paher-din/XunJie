import { manifestResources, type ComponentBinding } from '@xunjie/contracts/components'
import { courseExecutionPlanBasis, decideExecutionPlacement, isCourseExecutionPlanV2, plannedExecutionScope,
  type CourseExecutionPlan, type ExecutionDevice } from '@xunjie/contracts/execution'
import { digestOf } from './identity'

export interface ExecutionPlacement {
  plan: CourseExecutionPlan
  device: ExecutionDevice
  remoteAvailable: boolean
}

/** Resolve exactly one bound operation. A malformed/missing plan is a refusal, never an unplanned run. */
export function operationPlacement(binding: ComponentBinding, operationId: string, kind: 'job' | 'session',
  placement: ExecutionPlacement) {
  if (plannedExecutionScope(placement.plan, { key: binding.key, definitionDigest: binding.definition.digest,
    operationId, location: kind === 'job' ? 'browser' : 'native' }) !== 'allowed') throw new Error('not-planned')
  const manifest = binding.definition.manifest
  const session = manifest.formatVersion === 1 ? manifest.session : undefined
  return decideExecutionPlacement({ ...placement, componentKey: binding.key, operationId, kind,
    adapter: session ? { adapterId: session.adapterId, adapterVersion: session.adapterVersion } : null })
}

/** The same teacher ceilings are advertised, accepted and handed to the actual adapter. */
export function teacherExecutionLimits<T extends Record<string, number>>(limits: T, binding: ComponentBinding,
  operationId: string, plan?: CourseExecutionPlan): T {
  if (!plan || !isCourseExecutionPlanV2(plan)) return { ...limits }
  const fixed = plan.placements.find(item => item.componentKey === binding.key && item.operationId === operationId)
  if (!fixed) throw new Error('not-planned')
  const result = { ...limits }
  for (const key of Object.keys(result)) {
    const ceiling = fixed.budgets[key]
    if (ceiling === undefined) throw new Error('not-planned')
    result[key as keyof T] = Math.min(result[key]!, ceiling) as T[keyof T]
  }
  return result
}

/** Verify the fixed release, including resource identities, before protecting a new action. */
export async function verifyTeacherExecutionPlan(binding: ComponentBinding, operationId: string,
  location: 'browser' | 'native', plan?: CourseExecutionPlan) {
  if (!plan) return
  if (plannedExecutionScope(plan, { key: binding.key, definitionDigest: binding.definition.digest,
    operationId, location }) !== 'allowed') throw new Error('not-planned')
  const component = plan.components.find(item => item.key === binding.key)!
  if (component.configurationDigest !== await digestOf(binding.configuration)) throw new Error('not-planned')
  if (!isCourseExecutionPlanV2(plan)) return
  if (plan.planDigest !== await digestOf(courseExecutionPlanBasis(plan))) throw new Error('not-planned')
  const fixed = plan.placements.find(item => item.componentKey === binding.key && item.operationId === operationId)!
  const resources = [binding.definition.manifest.entry, ...manifestResources(binding.definition.manifest)]
    .map(({ resourceId, sha256, byteLength }) => ({ resourceId, sha256, byteLength }))
  const sorted = (items: typeof resources) => [...items].sort((a,b) => a.resourceId.localeCompare(b.resourceId, 'en'))
  if (await digestOf(sorted(resources)) !== await digestOf(sorted(fixed.resources))) throw new Error('not-planned')
}
