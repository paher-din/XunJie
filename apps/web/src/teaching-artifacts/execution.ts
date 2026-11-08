import { componentStateName, matchesComponentState } from '@xunjie/contracts/components'
import { teachingArtifactExecutionInputSchema, type TeachingArtifactRevision } from '@xunjie/contracts/teaching-artifacts'
import { aluInputsSchema, isAluCodeWork } from '@xunjie/contracts/alu-learning'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import type { ReliableWorkspace } from '../reliable-workspace'
import type { ExecutionController } from '../tool-execution/controller'
import { runtimeAction, type RuntimeActionOptions } from '../tool-execution/runtime-action'
import { priorCaseSources } from '../course-tools/alu/cases'

/** Only the existing execution owner supplies successful code, observations and prior-result identities. */
export async function artifactExecutionAction(workspace: ReliableWorkspace, activity: LearningActivity,
  revision: TeachingArtifactRevision, execution: ExecutionController, value: unknown) {
  const input = teachingArtifactExecutionInputSchema.parse(value)
  const binding = activity.course?.components?.find(binding => binding.key === input.componentKey)
  const file = structuredClone(workspace.snapshot().files.find(file => file.name === componentStateName(revision.binding.key)))
  if (!file || !matchesComponentState(revision.binding, activity.activityId, file)
    || !binding || binding.definition.manifest.formatVersion !== 3
    || !binding.definition.manifest.requiredCapabilities.includes('execution.submit')) throw new Error('capability-unavailable')
  let options: RuntimeActionOptions = { requestId: input.requestId, operationId: input.operationId, parameters: input.parameters }
  if (input.operationId === 'run-single') {
    if (input.enabledByRequestId || input.caseDraft) throw new Error('invalid-input')
  } else {
    if (!input.enabledByRequestId) throw new Error('invalid-input')
    const confirmed = await execution.query(input.enabledByRequestId)
    const records = execution.snapshot().records, enabled = records.find(record => record.requestId === input.enabledByRequestId)
    if (!enabled || !confirmed || confirmed.state !== 'succeeded' || confirmed.statusKnowledge !== 'confirmed' || !confirmed.output
      || enabled.action.protocolVersion !== 3 || enabled.action.execution.operation.operationId !== 'run-single'
      || enabled.action.scope.activityId !== activity.activityId || enabled.action.execution.instance.key !== binding.key
      || enabled.action.execution.instance.definitionDigest !== binding.definition.digest) throw new Error('resource-unavailable')
    options = { ...options, basisWorks: enabled.action.execution.basis.works.filter(isAluCodeWork),
      enabledBy: { requestId: enabled.requestId, executionRef: confirmed.executionRef, inputDigest: confirmed.inputDigest } }
    if (input.operationId === 'observe-enabled') {
      if (!input.caseDraft || binding.definition.manifest.runtime.adapterId !== 'icarus-alu') throw new Error('invalid-input')
      const inputs = aluInputsSchema.parse(input.parameters)
      options.caseDraft = { ...input.caseDraft, helpReported: true, priorSources: priorCaseSources(records, enabled, inputs) }
    } else if (input.caseDraft) throw new Error('invalid-input')
  }
  const action = await runtimeAction(workspace, activity, binding, execution.receiver.identity.receiverId, options)
  // The immutable generated binding and its click-time state travel with the real execution's retained works.
  action.execution.basis.works.push(file)
  return action
}
