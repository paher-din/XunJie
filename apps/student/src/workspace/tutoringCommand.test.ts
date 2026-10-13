import {expect,it} from 'vitest'
import type {CommandContext} from './frozenCommand'
import type {TutorCommand} from './tutoringStore'
import {verifyTutorCommandReceipt} from './tutoringCommand'

const context:CommandContext={mode:'real',userId:'student',courseId:'course',assignmentId:'assignment',
  activityVersionId:'activity',attemptId:'attempt',preparationEpoch:null,trustedRecoveryGeneration:'generation',loadEpoch:1}
const input={question:'original question',expectedAttemptRevision:1,recoveryGeneration:'generation'}
const command:TutorCommand={key:'key',kind:'help',path:'/attempts/attempt/help',wireJson:JSON.stringify(input),state:'pending'}
// Original B2 record-adapter/requestHash vectors, generated with the teaching Node24.21 runtime.
const receipt=()=>({receiptId:'receipt',commandId:'command',serverSeq:1,committedAt:'2026-10-14T00:00:00Z',replayed:false,
  identity:{actorId:'student',command:'student_help.create',target:'/api/attempts/attempt/help',idempotencyKey:'key',
    recoveryGeneration:'generation',scope:{courseId:'course',studentId:'student',attemptId:'attempt'}},
  requestHash:'617d0357f4f6536ba3f5b2754d925a712582d5f289567666d09a0216127b3ce2',
  result:{jobId:'job',attemptRevision:2,decisionEpoch:1,replacedJobIds:[],acceptedInputHash:'6ad9080ad2da198c90860871cce33983f4466ffc5a3a4d7dda61fc97fa49a9e2'}})

it('accepts the original B2 full-input digest including generation on first commit and replay',async()=> {
  const r=receipt()
  expect(await verifyTutorCommandReceipt(context,command,r)).toEqual(r.result)
  expect(await verifyTutorCommandReceipt(context,command,{...r,replayed:true})).toEqual(r.result)
})
it('rejects a receipt from another scope/key or whose question input changed',async()=> {
  const r=receipt()
  await expect(verifyTutorCommandReceipt(context,command,{...r,identity:{...r.identity,idempotencyKey:'another-key'}})).rejects.toThrow()
  await expect(verifyTutorCommandReceipt(context,command,{...r,identity:{...r.identity,scope:{...r.identity.scope,attemptId:'another'}}})).rejects.toThrow()
  await expect(verifyTutorCommandReceipt(context,{...command,wireJson:JSON.stringify({...input,question:'different question'})},r)).rejects.toThrow()
})
it('retains C cancellation digest semantics independently of B2 help generation',async()=> {
  const r=receipt(),cancel:TutorCommand={key:'key',kind:'cancel',path:'/jobs/job/cancel',state:'pending',
    wireJson:JSON.stringify({recoveryGeneration:'generation',reason:'student_stop'})}
  const result={jobId:'job',stopRequested:true,status:'succeeded',invalidatedActionIds:[]}
  expect(await verifyTutorCommandReceipt(context,cancel,{...r,identity:{...r.identity,command:'job.cancel',target:'/api/jobs/job/cancel'},
    requestHash:'5b50865e26401432739b5bd71ba798d70ce86405460c2800617190655d534d65',result})).toEqual(result)
})
