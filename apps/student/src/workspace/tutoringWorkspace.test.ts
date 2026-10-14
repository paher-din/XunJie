import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ConfirmationWorkspace } from './confirmationWorkspace'
import type { CommandContext } from './frozenCommand'
import type { TutorLedger } from './tutoringStore'
const mocked=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),write:vi.fn(),read:vi.fn()}))
vi.mock('./http',async original=>({...await original<object>(),apiGet:mocked.get,apiPostFrozen:mocked.post}))
vi.mock('./confirmationDb',()=>({confirmationRepository:{isCurrentAuthority:async()=>true}}))
vi.mock('./tutoringStore',async original=>({...await original<object>(),readTutorLedger:mocked.read,writeTutorLedger:mocked.write,
  tutorChannel:async()=>({clientId:'original-channel',close:()=>{}})}))
import { TutoringWorkspace } from './tutoringWorkspace'
import { textHash } from './confirmation'
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
