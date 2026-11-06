import { executionActionV3Schema } from '@xunjie/contracts/execution'
import type { ComponentBinding } from '@xunjie/contracts/components'
import type { LearningActivity } from '@xunjie/contracts/learning-data'
import type { ReliableWorkspace } from '../reliable-workspace'
import { actionScopeFromWorkspaceKey } from '../reliable-workspace/actions'
import { digestOf, readComponentState } from './action'
import { aluControls } from './adapters/alu'

export async function runtimeAction(workspace:ReliableWorkspace, activity:LearningActivity, binding:ComponentBinding, receiverId:string) {
  const manifest=structuredClone(binding.definition.manifest), files=structuredClone(workspace.snapshot().files)
  if(manifest.formatVersion!==3 || !activity.course?.executionPlan) throw new Error('capability-unavailable')
  const instanceId=`${activity.activityId}:${binding.key}`, state=readComponentState(workspace,binding,instanceId)
  const parameters=aluControls(structuredClone(state.content)), operation=manifest.runtime.operations[0]
  const scope=actionScopeFromWorkspaceKey(workspace.key)
  return executionActionV3Schema.parse({protocolVersion:3,kind:'execution',requestId:crypto.randomUUID(),scope,
    receiver:{receiverId,location:'local',kind:'execution'},execution:{
      instance:{instanceId,key:binding.key,componentId:manifest.componentId,componentVersion:manifest.version,
        definitionDigest:binding.definition.digest,hostApiVersion:1,stateVersion:manifest.stateVersion},
      operation:{operationId:operation.operationId,effect:'execute'},parameters,
      basis:{works:files.filter(f=>(f.kind==='code'&&/\.(sv|v|svh|vh)$/i.test(f.name)) || f.objectId===state.file?.objectId),runtime:manifest.runtime && {
        adapterId:manifest.runtime.adapterId,adapterVersion:manifest.runtime.adapterVersion,bundleIdentity:manifest.runtime.bundleIdentity,resources:manifest.runtime.resources},
        compile:operation.compile,observation:operation.observation,course:{releaseId:activity.course.releaseId,
          behaviorRuleDigest:await digestOf(activity.course.requirements),planDigest:activity.course.executionPlan.planDigest},expected:{stateContentId:state.contentId}},
      limits:{...operation.budgets,concurrentJobs:manifest.budget.concurrentJobs,queuedJobs:manifest.budget.queuedJobs},
      plan:{planId:activity.course.executionPlan.planId,planVersion:activity.course.executionPlan.planVersion,
        planDigest:activity.course.executionPlan.planDigest,location:'browser',kind:'job'},initiator:{kind:'student',principalId:scope.principalId}}})
}
