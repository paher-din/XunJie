import {expect,it} from 'vitest'
import type {CommandContext} from './frozenCommand'
import type {TutorCommand} from './tutoringStore'
import {verifyTutorCommandReceipt} from './tutoringCommand'
import type { TutorHistoryQuestion } from './tutoringContracts'

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
const hdlSelection={snapshotId:'snapshot',buildId:'build',sessionId:'session',operationId:'operation'}
const hdlBasis={...hdlSelection,snapshotHash:'a'.repeat(64),workspaceRevision:4,buildStatus:'succeeded' as const,buildResultHash:'b'.repeat(64),
  sessionRevision:2,sessionStatus:'active' as const,sessionGeneration:'generation',confirmedSequence:1,simTimePs:'90071992547409930000',
  stopRequested:false,terminationConfirmed:false,resultHash:'c'.repeat(64)}
const hdlQuestion=():TutorHistoryQuestion=>({authorKind:'student',messageId:'question',jobId:'job',requestReceiptId:'receipt',
  scope:{courseId:'course',studentId:'student',attemptId:'attempt'},contentHash:'unused-already-verified-history',
  envelope:{kind:'student_question',question:'original question',hdlSelection,hdlBasis,inputRefs:[],
    versions:{activityVersionId:'activity',policyVersionId:'policy',modelConfigVersion:'model',promptVersion:'prompt',schemaVersion:'schema'}}})
function hdlReceipt() {
  const r=receipt();r.requestHash='d839a722ebd23ed4fbb73c90be7e9ed9d85adfa9b2355bc9eea68f419523df56'
  r.result.acceptedInputHash='d5185b93acf8016130e043b8c616e90f969c302d3abe9d694099c20d11cae57b'
  return r
}
const hdlCommand={...command,wireJson:JSON.stringify({...input,hdlSelection})}
it('verifies H4 against a fixed backend requestHash vector including the original transaction-frozen basis',async()=> {
  expect(await verifyTutorCommandReceipt(context,hdlCommand,hdlReceipt(),hdlQuestion())).toEqual(hdlReceipt().result)
  await expect(verifyTutorCommandReceipt(context,hdlCommand,hdlReceipt())).rejects.toThrow('关联尚未核对')
})
it.each(['jobId','requestReceiptId'])('rejects an identical HDL selection from a different original %s',async key=> {
  const q=hdlQuestion();q[key as 'jobId'|'requestReceiptId']='different'
  await expect(verifyTutorCommandReceipt(context,hdlCommand,hdlReceipt(),q)).rejects.toThrow()
})
it('rejects substituted frozen sequence/hash and mismatched scope rather than re-hashing latest state as accepted',async()=> {
  const q=hdlQuestion();q.envelope.hdlBasis={...hdlBasis,confirmedSequence:2}
  await expect(verifyTutorCommandReceipt(context,hdlCommand,hdlReceipt(),q)).rejects.toThrow('原请求不符')
  q.envelope.hdlBasis=hdlBasis;q.scope={...q.scope,studentId:'other'}
  await expect(verifyTutorCommandReceipt(context,hdlCommand,hdlReceipt(),q)).rejects.toThrow()
})
