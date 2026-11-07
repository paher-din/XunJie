import 'fake-indexeddb/auto'
import {describe,expect,it,vi,afterEach} from 'vitest'
import {webcrypto} from 'node:crypto'
import {aluCoursePackage} from '../../../../components/alu-experiment/package.mjs'
import type {LearningActivity,WorkFile} from '@xunjie/contracts/learning-data'
import {ReliableWorkspace} from '../reliable-workspace'
import {runtimeAction, runtimeCandidateIsCurrent} from './runtime-action'
import {aluCaseFromAction, newAluCaseDraft} from '@xunjie/contracts/alu-learning'
import {BrowserExecutionReceiver} from './receiver'
import {digestOf} from './action'
afterEach(()=>vi.unstubAllGlobals())

describe('fixed ALU execution through the shared receiver',()=>{
  it('fixes a comparison before protection and keeps later input and prediction edits independent',async()=>{
    vi.stubGlobal('crypto',webcrypto)
    vi.stubGlobal('window',new EventTarget())
    const course=await aluCoursePackage(), binding=course.release.components![0]
    const identity={environmentId:crypto.randomUUID(),spaceId:crypto.randomUUID(),principalId:crypto.randomUUID(),kind:'school' as const,name:'test'}
    const activity:LearningActivity={activityId:crypto.randomUUID(),identity,goal:'',question:'',references:[],status:'open',createdAt:new Date().toISOString(),
      target:{environmentId:identity.environmentId,serviceId:crypto.randomUUID(),version:1},course:{...course.release,
        associationId:crypto.randomUUID(),courseId:course.course.courseId,taskId:course.task.taskId,courseName:course.course.name,taskTitle:course.task.title,contentDigest:'a'.repeat(64)}}
    const code:WorkFile={objectId:crypto.randomUUID(),contentId:crypto.randomUUID(),name:'alu.sv',kind:'code',encoding:'utf8',mediaType:'text/plain',value:'module alu; endmodule'}
    const enabledBy={requestId:crypto.randomUUID(),inputDigest:'1'.repeat(64),executionRef:crypto.randomUUID()}
    const draft={...newAluCaseDraft(crypto.randomUUID(),crypto.randomUUID()),predictedF:'0000',predictedCout:'1',reason:'15 + 1 crosses the four-bit boundary'}
    const state:WorkFile={objectId:crypto.randomUUID(),contentId:crypto.randomUUID(),name:'components/alu.json',kind:'state',encoding:'json',mediaType:'application/vnd.xunjie.component-state+json',value:JSON.stringify({
      formatVersion:1,instanceId:`${activity.activityId}:alu`,componentId:binding.definition.manifest.componentId,version:3,definitionDigest:binding.definition.digest,stateVersion:3,operationId:crypto.randomUUID(),
      content:{...(binding.definition.manifest.initialState as Record<string,unknown>),A:15,B:1,M:1,feedbackPolicy:'hold',caseDraft:JSON.stringify(draft),enabledBasis:JSON.stringify({...enabledBy,definitionDigest:binding.definition.digest,activationRevision:1})}})}
    const workspace=new ReliableWorkspace(JSON.stringify(['test',identity.environmentId,identity.spaceId,identity.principalId,activity.activityId]),
      {read:async()=>({revision:1,files:[code,state]}),receipt:async()=>null,sync:async input=>({revision:2,files:input.files})})
    try {
      await workspace.open()
      const requestId=crypto.randomUUID()
      const pending=runtimeAction(workspace,activity,binding,'browser-execution',{operationId:'observe-enabled',
        parameters:{A:15,B:1,M:1,S:0,Cin:0},basisWorks:[code],enabledBy,requestId,caseDraft:draft})
      workspace.change([code,{...state,contentId:crypto.randomUUID(),value:state.value.replace(draft.reason,'a later draft').replace('"A":15','"A":2')}])
      const action=await pending
      expect(action.requestId).toBe(requestId)
      expect(aluCaseFromAction(action)).toMatchObject({draft,inputs:{A:15,B:1,M:1,S:0,Cin:0}})
      expect(action.execution.basis.expected.stateContentId).not.toBe(state.contentId)
      expect(runtimeCandidateIsCurrent(workspace,activity,action)).toBe(true)
      expect(workspace.snapshot().files.find(f=>f.objectId===state.objectId)?.value).toContain('a later draft')
    } finally {workspace.dispose()}
  })
  it('freezes the click-time source, deduplicates the original request and rejects reusing its identity for edited code',async()=>{
    vi.stubGlobal('crypto',webcrypto)
    vi.stubGlobal('window',new EventTarget())
    const course=await aluCoursePackage()
    const identity={environmentId:crypto.randomUUID(),spaceId:crypto.randomUUID(),principalId:crypto.randomUUID(),kind:'school' as const,name:'test'}
    const activity:LearningActivity={activityId:crypto.randomUUID(),identity,goal:'',question:'',references:[],status:'open',createdAt:new Date().toISOString(),
      target:{environmentId:identity.environmentId,serviceId:crypto.randomUUID(),version:1},course:{...course.release,
        associationId:crypto.randomUUID(),courseId:course.course.courseId,taskId:course.task.taskId,courseName:course.course.name,taskTitle:course.task.title,contentDigest:'a'.repeat(64)}}
    const binding=course.release.components![0]
    const key=JSON.stringify(['test',identity.environmentId,identity.spaceId,identity.principalId,activity.activityId])
    const file:WorkFile={objectId:crypto.randomUUID(),contentId:crypto.randomUUID(),kind:'code',encoding:'utf8',mediaType:'text/plain',name:'alu.sv',value:'module alu; endmodule'}
    const workspace=new ReliableWorkspace(key,{read:async()=>({revision:1,files:[file]}),receipt:async()=>null,sync:async input=>({revision:2,files:input.files})})
    try {
      await workspace.open()
      const frozen=runtimeAction(workspace,activity,binding,'browser-execution')
      workspace.edit(file.objectId,'module changed; endmodule')
      const action=await frozen
      expect(action.execution.basis.works.find(f=>f.objectId===file.objectId)?.value).toBe('module alu; endmodule')
      const receiver=new BrowserExecutionReceiver(action.receiver,key,1)
      const digest=await digestOf(action),accepted=await receiver.accept(action,digest)
      expect((await receiver.accept(action,digest)).execution?.executionRef).toBe(accepted.execution?.executionRef)
      const changed=structuredClone(action);changed.execution.basis.works[0].value='different'
      await expect(receiver.accept(changed,await digestOf(changed))).rejects.toThrow('同一执行身份')
      let current = true
      const guarded = new BrowserExecutionReceiver(action.receiver, key, 2, () => true, () => current)
      const candidate = structuredClone(action); candidate.requestId = crypto.randomUUID()
      const candidateDigest = await digestOf(candidate)
      const accepting = guarded.accept(candidate, candidateDigest)
      current = false // Changes during database opening/protection, before the receiver commits.
      expect((await accepting).receipt.state).toBe('rejected')
      expect(await guarded.store.read(key, candidate.requestId)).toBeUndefined()
      current = true
      const first = await guarded.accept(candidate, candidateDigest)
      current = false
      expect(await guarded.accept(candidate, candidateDigest)).toEqual(first)
    } finally {workspace.dispose()}
  })
})
