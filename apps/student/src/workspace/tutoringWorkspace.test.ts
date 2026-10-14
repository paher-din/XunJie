import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfirmationWorkspace } from './confirmationWorkspace'
import type { CommandContext } from './frozenCommand'
import type { TutorLedger } from './tutoringStore'
const mocked=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),write:vi.fn(),read:vi.fn()}))
vi.mock('./http',async original=>({...await original<object>(),apiGet:mocked.get,apiPostFrozen:mocked.post}))
vi.mock('./confirmationDb',()=>({confirmationRepository:{isCurrentAuthority:async()=>true}}))
vi.mock('./tutoringStore',async original=>({...await original<object>(),readTutorLedger:mocked.read,writeTutorLedger:mocked.write,
  writeTutorHistoryCache:async()=>undefined,tutorChannel:async()=>({clientId:'original-channel',close:()=>{}})}))
import { TutoringWorkspace } from './tutoringWorkspace'
import { textHash } from './confirmation'
import type { TutorPayload } from './tutoringContracts'
import type { TutorHdlCurrent } from './tutoringHdl'
import { tutorRequestHash } from './tutoringCommand'
const context:CommandContext={mode:'preparation',userId:'u',courseId:'c',assignmentId:'assignment',activityVersionId:'activity',attemptId:'attempt',
  preparationEpoch:'prep',trustedRecoveryGeneration:'g',loadEpoch:1}
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r});return{promise,resolve}}
const control={attemptRevision:1,decisionEpoch:1,captureRevision:0,collecting:true,reminders:false,generation:'g',status:'active' as const}
async function fixture() {
  const payload={actionId:'a',deliveryId:'d',content:'完整合成正文',contentHash:await textHash('完整合成正文'),actionType:'hint',createdAt:new Date().toISOString(),basisRevised:false,disposition:'pending' as const}
  const attempt={...control,attemptId:'attempt'}, confirmation={context,current:{attempt},isCurrent:()=>true,readHead:vi.fn(async()=>({attempt,limitedCheck:false as boolean|undefined}))}
  const page={control,resyncRequired:false,events:[{serverSeq:3,eventId:'e',type:'teaching.delivery',occurredAt:new Date().toISOString(),payload}],nextServerSeq:3,hasMore:false}
  let stored:TutorLedger|undefined
  mocked.read.mockImplementation(async()=>stored)
  mocked.write.mockImplementation(async(row:TutorLedger)=>{stored=structuredClone(row)})
  mocked.get.mockResolvedValue(page)
  mocked.post.mockImplementation(async(_path:string,wire:string)=>{const input=JSON.parse(wire);return{receiptId:'r',actionId:'a',receiptKind:input.receiptKind,serverSeq:4,replayed:false}})
  const client=new TutoringWorkspace(confirmation as unknown as ConfirmationWorkspace,context)
  return{client,confirmation,page,payload,getStored:()=>stored}
}
beforeEach(()=>{vi.clearAllMocks();vi.stubGlobal('document',{visibilityState:'visible'})})
describe('tutoring stop/display/control interleavings',()=> {
  it('retiring the context while the help command is persisted prevents its POST',async()=> {
    const f=await fixture();await f.client.initialize();mocked.post.mockClear()
    let current=true;f.confirmation.isCurrent=()=>current
    mocked.write.mockImplementation(async(row:TutorLedger)=>{if(row.commands.some(c=>c.kind==='help'))queueMicrotask(()=>{current=false})})
    await f.client.send('原上下文问题')
    expect(mocked.post).not.toHaveBeenCalled()
    f.client.dispose()
  })
  it('a stop during the preflight read prevents the earlier help POST',async()=> {
    const f=await fixture();await f.client.initialize();mocked.post.mockClear()
    const gate=deferred<{attempt:typeof f.confirmation.current.attempt;limitedCheck:boolean|undefined}>(),reached=deferred<void>()
    f.confirmation.readHead.mockImplementationOnce(()=>{reached.resolve();return gate.promise})
    const send=f.client.send('原问题');await reached.promise
    const stop=f.client.stop();gate.resolve({attempt:f.confirmation.current.attempt,limitedCheck:false})
    await send;await stop
    expect(mocked.post).not.toHaveBeenCalled()
    expect(f.client.current.ledger?.commands).toEqual([])
    expect(f.client.current.ledger?.blocked).toBe(true)
    f.client.dispose()
  })
  it.each([true,undefined])('fresh limitedCheck=%s blocks help even after an unrestricted cached read',async limitedCheck=> {
    const f=await fixture();await f.client.initialize();mocked.post.mockClear()
    f.confirmation.readHead.mockResolvedValue({attempt:f.confirmation.current.attempt,limitedCheck})
    await f.client.send('应保持未发送')
    expect(mocked.post).not.toHaveBeenCalled()
    expect(f.client.current.ledger?.commands).toEqual([])
    expect(f.client.current.notice).toContain(limitedCheck?'限定检查进行中':'状态尚未确认')
    f.client.dispose()
  })
  it('a stop during page persistence cannot release the synchronous display fence',async()=> {
    const f=await fixture(), gate=deferred<void>(), reached=deferred<void>()
    let once=false
    mocked.write.mockImplementation(async(row:TutorLedger)=>{if(row.messages.length && !once){once=true;reached.resolve();await gate.promise}})
    const init=f.client.initialize();await reached.promise
    const stopped=f.client.stop();gate.resolve();await init;await stopped
    expect(f.client.current.synchronized).toBe(false)
    expect(f.client.current.ledger?.messages.some(m=>m.valid&&!m.shown)).toBe(false)
    f.client.dispose()
  })
  it('an actual display observed while received ACK is held survives a following stop',async()=> {
    const f=await fixture(),gate=deferred<unknown>(),reached=deferred<void>()
    mocked.post.mockImplementationOnce(()=>{reached.resolve();return gate.promise})
    const init=f.client.initialize();await reached.promise
    const fact=f.client.fact('a','displayed')
    expect(f.client.current.ledger?.messages[0]?.shown).toBe(true)
    const stop=f.client.stop()
    gate.resolve({receiptId:'r',actionId:'a',receiptKind:'received',serverSeq:4,replayed:false})
    await init;await fact;await stop
    expect(f.getStored()?.messages[0]?.facts.displayed).toBeTruthy()
    expect(f.client.current.ledger?.messages[0]?.shown).toBe(true)
    f.client.dispose()
  })
  it('a delayed active page cannot cross the newer accepted pause/epoch',async()=> {
    const f=await fixture(),gate=deferred<unknown>(),reached=deferred<void>()
    mocked.get.mockImplementation(()=>{reached.resolve();return gate.promise})
    const init=f.client.initialize();await reached.promise
    Object.assign(f.confirmation.current.attempt,{status:'paused',attemptRevision:2,decisionEpoch:2})
    f.client.invalidateControl();gate.resolve(f.page);await init
    expect(f.client.current.synchronized).toBe(false)
    expect(f.client.current.ledger?.messages).toEqual([])
    expect(mocked.post).not.toHaveBeenCalled()
    f.client.dispose()
  })
})
function currentHdl():TutorHdlCurrent {return {workspaceRevision:4,hasDraftChanges:false,generation:'g',
  build:{buildId:'build',snapshotId:'snapshot',snapshotHash:'a'.repeat(64),status:'succeeded',buildResultHash:'b'.repeat(64)},
  session:{sessionId:'session',buildId:'build',snapshotId:'snapshot',snapshotHash:'a'.repeat(64),sessionRevision:2,status:'active',recoveryGeneration:'g',
    confirmedSequence:1,simTimePs:'40000',stopRequested:false,terminationConfirmed:false},
  operation:{operationId:'operation',sessionId:'session',resultHash:'c'.repeat(64),sequence:1,sessionRevision:2,simTimePs:'40000'}}}
async function hdlFixture() {
  const f=await fixture(),payload=f.page.events[0]!.payload as TutorPayload
  Object.assign(f.confirmation.current.attempt,{workspaceRevision:4})
  Object.assign(payload,{scope:{courseId:'c',studentId:'u',attemptId:'attempt'},jobId:'job',messageId:'message',generation:'g',
    targetVersions:{activityVersionId:'activity',policyVersionId:'policy',modelConfigVersion:'model',promptVersion:'prompt',schemaVersion:'schema'},
    basis:{attemptRevision:1,decisionEpoch:1,captureRevision:0,relatedStateRevision:0,hdl:{snapshotId:'snapshot',snapshotHash:'a'.repeat(64),buildId:'build',
      buildStatus:'succeeded',buildResultHash:'b'.repeat(64),workspaceRevision:4,sessionId:'session',sessionRevision:2,sessionStatus:'active',sessionGeneration:'g',
      confirmedSequence:1,simTimePs:'40000',stopRequested:false,terminationConfirmed:false,operationId:'operation',resultHash:'c'.repeat(64)}}})
  f.page.events[0]!.type='teaching.delivered'
  mocked.get.mockImplementation(async(path:string)=>path.endsWith('/teaching-records')?{messages:[],actions:[]}:f.page)
  f.client.dispose()
  const client=new TutoringWorkspace(f.confirmation as unknown as ConfirmationWorkspace,{...context,mode:'real',preparationEpoch:null})
  client.setHdlCurrent(currentHdl())
  return {...f,client}
}
describe('HDL provenance and explicit display fence',()=> {
  it('receives a real delivered body without inventing display or student acknowledgement',async()=> {
    const f=await hdlFixture();await f.client.initialize()
    expect(f.client.current.ledger?.messages[0]?.valid).toBe(true)
    expect(f.client.current.ledger?.messages[0]?.facts.received?.state).toBe('confirmed')
    expect(f.client.current.ledger?.messages[0]?.shown).toBe(false)
    expect(f.client.current.ledger?.messages[0]?.facts.displayed).toBeUndefined()
    expect(f.client.current.ledger?.messages[0]?.facts.acknowledged).toBeUndefined()
    await f.client.fact('a','acknowledged');expect(f.client.current.ledger?.messages[0]?.facts.acknowledged).toBeUndefined()
    f.client.dispose()
  })
  it('invalidates a shown answer on new draft and cannot restore current guidance by rereading old events',async()=> {
    const f=await hdlFixture();await f.client.initialize();await f.client.fact('a','displayed')
    const edited=currentHdl();edited.hasDraftChanges=true;f.client.setHdlCurrent(edited)
    expect(f.client.current.ledger?.messages[0]?.valid).toBe(false)
    expect(f.client.current.ledger?.messages[0]?.hdlInvalidated).toBe(true)
    f.client.setHdlCurrent(currentHdl());await f.client.read(true)
    expect(f.client.current.ledger?.messages[0]?.valid).toBe(false)
    expect(f.client.current.ledger?.messages[0]?.shown).toBe(true)
    expect(f.client.hdlSourceStatus(f.client.current.ledger!.messages[0]!)).toContain('历史')
    f.client.dispose()
  })
  it('fences an unseen answer synchronously when an interaction becomes pending',async()=> {
    const f=await hdlFixture();await f.client.initialize();mocked.post.mockClear()
    const pending=currentHdl();pending.session!.pendingOperationId='pending';f.client.setHdlCurrent(pending)
    await f.client.fact('a','displayed')
    expect(f.client.current.ledger?.messages[0]?.facts.displayed).toBeUndefined()
    expect(mocked.post).not.toHaveBeenCalled();f.client.dispose()
  })
  it('keeps missing HDL basis and non-delivery payloads out of real current guidance',async()=> {
    const f=await hdlFixture();delete (f.page.events[0]!.payload as TutorPayload).basis!.hdl
    await f.client.initialize();expect(f.client.current.ledger?.messages).toEqual([]);f.client.dispose()
    const other=await hdlFixture();other.page.events[0]!.type='teaching.received'
    await other.client.initialize();expect(other.client.current.ledger?.messages).toEqual([]);other.client.dispose()
  })
  it('retains an explicitly unselected project dialogue only with its original confirmed request/Job association',async()=> {
    const f=await hdlFixture();delete (f.page.events[0]!.payload as TutorPayload).basis!.hdl
    await f.client.initialize()
    f.client.current.ledger!.commands.push({kind:'help',state:'confirmed',key:'original-help',path:'/attempts/attempt/help',
      wireJson:JSON.stringify({question:'一般项目问题',recoveryGeneration:'g',expectedAttemptRevision:1}),result:{result:{jobId:'other-job'}}})
    await f.client.read(true);expect(f.client.current.ledger?.messages).toEqual([])
    f.client.current.ledger!.commands[0]!.result={result:{jobId:'job'}}
    await f.client.read(true)
    expect(f.client.current.ledger?.messages[0]?.hdlUnselected).toBe(true)
    expect(f.client.current.ledger?.messages[0]?.payload.basis?.hdl).toBeUndefined()
    expect(f.client.hdlSourceStatus(f.client.current.ledger!.messages[0]!)).toContain('不代表当前板卡')
    f.client.dispose()
  })
  it('does not send a selected HDL problem after draft state changes during persistence',async()=> {
    const f=await hdlFixture();await f.client.initialize();mocked.post.mockClear()
    mocked.write.mockImplementation(async(row:TutorLedger)=> {
      if(row.commands.some(c=>c.kind==='help')) {const edited=currentHdl();edited.hasDraftChanges=true;f.client.setHdlCurrent(edited)}
    })
    await f.client.send('明确询问所选构建',undefined,false,()=>true,{snapshotId:'snapshot',buildId:'build',sessionId:'session',operationId:'operation'})
    expect(mocked.post).not.toHaveBeenCalled();expect(f.client.current.ledger?.commands[0]?.error).toContain('发送前改变')
    f.client.dispose()
  })
  it('confirms HDL acceptance only after the original authorized question supplies its frozen basis',async()=> {
    const f=await hdlFixture();await f.client.initialize()
    let originalQuestion:unknown
    const frozen=structuredClone((f.page.events[0]!.payload as TutorPayload).basis!.hdl!)
    mocked.post.mockImplementation(async(path:string,wire:string)=> {
      const input=JSON.parse(wire)
      if(!path.endsWith('/help'))return{receiptId:'r',actionId:'a',receiptKind:input.receiptKind,serverSeq:4,replayed:false}
      originalQuestion={messageId:'original-question',jobId:'accepted-job',requestReceiptId:'accepted-receipt',authorKind:'student',
        scope:{courseId:'c',studentId:'u',attemptId:'attempt'},contentHash:await textHash(input.question),
        envelope:{kind:'student_question',question:input.question,hdlSelection:input.hdlSelection,hdlBasis:frozen,inputRefs:[],
          versions:{activityVersionId:'activity',policyVersionId:'policy',modelConfigVersion:'model',promptVersion:'prompt',schemaVersion:'schema'}}}
      Object.assign(f.confirmation.current.attempt,{decisionEpoch:2,attemptRevision:2})
      f.page.control={...control,decisionEpoch:2,attemptRevision:2};f.page.events=[]
      return {receiptId:'accepted-receipt',commandId:'accepted-command',serverSeq:5,committedAt:'2026-10-14T00:00:00Z',replayed:false,
        identity:{command:'student_help.create',actorId:'u',target:'/api/attempts/attempt/help',idempotencyKey:f.client.current.ledger!.commands[0]!.key,
          recoveryGeneration:'g',scope:{courseId:'c',studentId:'u',attemptId:'attempt'}},requestHash:await tutorRequestHash('/api/attempts/attempt/help',input),
        result:{jobId:'accepted-job',attemptRevision:2,decisionEpoch:2,replacedJobIds:[],acceptedInputHash:await tutorRequestHash('student_help.accepted_input',
          {question:input.question,objectRef:null,hdlSelection:input.hdlSelection,hdlBasis:frozen})}}
    })
    mocked.get.mockImplementation(async(path:string)=>path.endsWith('/teaching-records')?{messages:originalQuestion?[originalQuestion]:[],actions:[]}:
      path==='/jobs/accepted-job'?{jobId:'accepted-job',purpose:'student_help',status:'failed',stopRequested:false,decisionEpoch:2,recoveryGeneration:'g',
        scope:{courseId:'c',studentId:'u',attemptId:'attempt'},acceptedAt:'2026-10-14T00:00:00Z',deadline:'2026-10-14T00:00:45Z',failure:'budget_disabled'}:f.page)
    await f.client.send('明确所选 HDL',undefined,false,()=>true,{snapshotId:'snapshot',buildId:'build',sessionId:'session',operationId:'operation'})
    expect(f.client.current.ledger?.commands[0]?.state).toBe('confirmed')
    expect(JSON.parse(f.client.current.ledger!.commands[0]!.wireJson).hdlSelection.operationId).toBe('operation')
    expect(f.client.current.ledger?.job?.status).toBe('failed')
    expect(mocked.get).toHaveBeenCalledWith('/attempts/attempt/teaching-records',{mode:'real',scenarioId:undefined})
    expect(f.client.current.ledger?.messages.some(m=>m.facts.displayed||m.facts.acknowledged)).toBe(false)
    f.client.dispose()
  })
})
