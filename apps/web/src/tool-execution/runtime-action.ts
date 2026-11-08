import { executionActionV3Schema } from '@xunjie/contracts/execution'
import { acceptsState, type ComponentBinding } from '@xunjie/contracts/components'
import type { LearningActivity, WorkFile } from '@xunjie/contracts/learning-data'
import type { ReliableWorkspace } from '../reliable-workspace'
import { actionScopeFromWorkspaceKey } from '../reliable-workspace/actions'
import { digestOf, readComponentState } from './action'
import { aluControls } from './adapters/alu'
import { aluCaseDraftSchema, aluCaseFromAction, aluInputsSchema, isAluCodeWork, type AluCaseDraft } from '@xunjie/contracts/alu-learning'
import { componentStateMediaType } from '@xunjie/contracts/components'

export interface RuntimeActionOptions {
  requestId?: string
  /** An explicit comparison freezes student text beside its input, in this command's own state basis. */
  caseDraft?: AluCaseDraft
  operationId?: string
  parameters?: unknown
  /**
   * The fixed code snapshot a free observation or full check cites. It is the accepted basis of the
   * run that enabled this work, never the current editor head. Omit it for an explicit run, which
   * captures the click-time files.
   */
  basisWorks?: WorkFile[]
  enabledBy?: { requestId: string; inputDigest: string; executionRef: string }
}

export async function runtimeAction(workspace:ReliableWorkspace, activity:LearningActivity, binding:ComponentBinding,
  receiverId:string, options:RuntimeActionOptions = {}) {
  const manifest=structuredClone(binding.definition.manifest), files=structuredClone(workspace.snapshot().files)
  const requestId=options.requestId??crypto.randomUUID()
  if(manifest.formatVersion!==3 || !activity.course?.executionPlan) throw new Error('capability-unavailable')
  const operationId=options.operationId??manifest.runtime.operations[0]?.operationId
  const operation=manifest.runtime.operations.find(item=>item.operationId===operationId)
  if(!operation) throw new Error('capability-unavailable')
  if (operationId !== 'run-single' && (!options.enabledBy || !options.basisWorks)) throw new Error('缺少成功运行的启用依据。')
  const instanceId=`${activity.activityId}:${binding.key}`, state=readComponentState(workspace,binding,instanceId)
  const currentCode=files.filter(isAluCodeWork), enabled=options.basisWorks?structuredClone(options.basisWorks).filter(isAluCodeWork):undefined
  const stateContent=state.content as Record<string,unknown>
  const parameters=options.parameters!==undefined?structuredClone(options.parameters)
    : operationId==='check-all'?{}
    : aluControls({A:stateContent.A,B:stateContent.B,M:stateContent.M,S:stateContent.S,Cin:stateContent.Cin})
  if(!acceptsState(operation.parameters,parameters)) throw new Error('invalid-input')
  // An explicit run cites the current state file as well as the click-time code. A free observation
  // and a full check cite only the enabled code, so editing the head cannot change what they test.
  const includeState=true
  const citedCode=enabled??currentCode
  if(!citedCode.some(file=>file.name===operation.compile.entryFiles[0]))
    throw new Error(`缺少固定编译入口 ${operation.compile.entryFiles[0]}；请恢复该文件后重试。`)
  let stateFile=state.file&&structuredClone(state.file)
  if(manifest.stateVersion===3) {
    const fixedCase=options.caseDraft&&aluCaseDraftSchema.parse(options.caseDraft)
    if(fixedCase && (operationId!=='observe-enabled'||!options.enabledBy)) throw new Error('invalid-case')
    stateFile={objectId:stateFile?.objectId??crypto.randomUUID(),contentId:crypto.randomUUID(),name:`components/${binding.key}.json`,
      kind:'state',encoding:'json',mediaType:componentStateMediaType,value:JSON.stringify({formatVersion:1,instanceId,
        componentId:manifest.componentId,version:manifest.version,definitionDigest:binding.definition.digest,stateVersion:manifest.stateVersion,
        operationId:crypto.randomUUID(),content:{...stateContent,caseRequestId:fixedCase?requestId:'',
          ...(fixedCase?{...aluInputsSchema.parse(parameters),caseDraft:JSON.stringify(fixedCase),feedbackPolicy:'hold',
            enabledBasis:JSON.stringify({...options.enabledBy,definitionDigest:binding.definition.digest,
              activationRevision:stateContent.activationRevision})}:{})}})}
  } else if(options.caseDraft) throw new Error('unsupported-case-version')
  const works=[...citedCode,...(includeState&&stateFile?[stateFile]:[])]
  if(works.some(file=>file.name===manifest.runtime.resources.find(resource=>resource.resourceId===operation.observation.scaffoldResourceId)?.path))
    throw new Error('invalid-input')
  const scope=actionScopeFromWorkspaceKey(workspace.key)
  return executionActionV3Schema.parse({protocolVersion:3,kind:'execution',requestId,scope,
    receiver:{receiverId,location:'local',kind:'execution'},execution:{
      instance:{instanceId,key:binding.key,componentId:manifest.componentId,componentVersion:manifest.version,
        definitionDigest:binding.definition.digest,hostApiVersion:1,stateVersion:manifest.stateVersion},
      operation:{operationId:operation.operationId,effect:'execute'},parameters,
      basis:{works,...(options.enabledBy?{enabledBy:structuredClone(options.enabledBy)}:{}),runtime:manifest.runtime && {
        adapterId:manifest.runtime.adapterId,adapterVersion:manifest.runtime.adapterVersion,bundleIdentity:manifest.runtime.bundleIdentity,resources:manifest.runtime.resources},
        compile:operation.compile,observation:operation.observation,course:{releaseId:activity.course.releaseId,
          behaviorRuleDigest:await digestOf(activity.course.requirements),planDigest:activity.course.executionPlan.planDigest},
        expected:{stateContentId:includeState&&stateFile?stateFile.contentId:null}},
      limits:{...operation.budgets,concurrentJobs:manifest.budget.concurrentJobs,queuedJobs:manifest.budget.queuedJobs},
      plan:{planId:activity.course.executionPlan.planId,planVersion:activity.course.executionPlan.planVersion,
        planDigest:activity.course.executionPlan.planDigest,location:'browser',kind:'job'},initiator:{kind:'student',principalId:scope.principalId}}})
}

/** Evaluated by the original receiver inside its acceptance transaction, after async protection. */
export function runtimeCandidateIsCurrent(workspace: ReliableWorkspace, activity: LearningActivity, action: import('@xunjie/contracts/execution').AnyExecutionAction) {
  if (action.protocolVersion !== 3 || action.execution.operation.operationId !== 'observe-enabled') return true
  try {
    if (workspace.snapshot().conflict || workspace.isReadOnly() || workspace.accessDenied()) return false
    const binding = activity.course?.components?.find(item => item.key === action.execution.instance.key)
    if (!binding || binding.definition.digest !== action.execution.instance.definitionDigest) return false
    // A comparison is an explicit click-time command. Editing after the click creates a new draft,
    // while this already protected command keeps the original prediction and original enabled work.
    if (aluCaseFromAction(action)) return true
    const current = readComponentState(workspace, binding, action.execution.instance.instanceId).content as Record<string, unknown>
    const fixedFile = action.execution.basis.works.find(file => file.contentId === action.execution.basis.expected.stateContentId && file.kind === 'state')
    if (!fixedFile) return false
    const fixed = JSON.parse(fixedFile.value).content as Record<string, unknown>
    const pointer = JSON.parse(String(current.enabledBasis)) as { requestId?: string; executionRef?: string }
    return current.feedbackPolicy === 'live' && !current.pendingActivation && current.inputRevision === fixed.inputRevision
      && current.enabledBasis === fixed.enabledBasis
      && pointer.requestId === action.execution.basis.enabledBy?.requestId && pointer.executionRef === action.execution.basis.enabledBy?.executionRef
      && ['A', 'B', 'M', 'S', 'Cin'].every(key => current[key] === (action.execution.parameters as Record<string, unknown>)[key])
  } catch { return false }
}
