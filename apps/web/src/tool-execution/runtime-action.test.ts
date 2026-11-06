import 'fake-indexeddb/auto'
import {describe,expect,it,vi,afterEach} from 'vitest'
import {webcrypto} from 'node:crypto'
import {aluCoursePackage} from '../../../../components/alu-experiment/package.mjs'
import type {LearningActivity,WorkFile} from '@xunjie/contracts/learning-data'
import {ReliableWorkspace} from '../reliable-workspace'
import {runtimeAction} from './runtime-action'
import {BrowserExecutionReceiver} from './receiver'
import {digestOf} from './action'
afterEach(()=>vi.unstubAllGlobals())

describe('fixed ALU execution through the shared receiver',()=>{
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
