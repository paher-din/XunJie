import {beforeEach,describe,expect,it,vi} from 'vitest'
import type {CommandContext} from './frozenCommand'
import type {ConfirmationWorkspace} from './confirmationWorkspace'
import {textHash} from './confirmation'
import {verifyTutorHistory} from './tutoringHistory'
import type {TutorHistoryAction,TutorHistoryQuestion,TutorHistoryReply} from './tutoringContracts'
const mocks=vi.hoisted(()=>({get:vi.fn(),post:vi.fn(),cache:vi.fn(),authority:vi.fn()}))
vi.mock('./http',async original=>({...await original<object>(),apiGet:mocks.get,apiPostFrozen:mocks.post}))
vi.mock('./confirmationDb',()=>({confirmationRepository:{isCurrentAuthority:mocks.authority}}))
vi.mock('./tutoringStore',async original=>({...await original<object>(),writeTutorHistoryCache:mocks.cache,
  readTutorLedger:async()=>undefined,writeTutorLedger:async()=>undefined,tutorChannel:async()=>({clientId:'channel',close:()=>{}})}))
import {TutoringWorkspace} from './tutoringWorkspace'
const context:CommandContext={mode:'preparation',userId:'u',courseId:'c',assignmentId:'assignment',activityVersionId:'activity',
  attemptId:'attempt',preparationEpoch:'prep',trustedRecoveryGeneration:'current-g',loadEpoch:1}
async function fixture() {
  const scope={courseId:'c',studentId:'u',attemptId:'attempt'},versions={activityVersionId:'activity',policyVersionId:'old-policy',
    modelConfigVersion:'model',promptVersion:'prompt',schemaVersion:'schema'}
  const objectRef={kind:'code',attemptId:'attempt',snapshotId:'snapshot',fileId:'file',path:'main.c',documentVersion:1,
    contentHash:'a'.repeat(64),range:{startLine:1,startColumn:1,endLine:1,endColumn:2}}
  const basis={attemptRevision:1,decisionEpoch:1,captureRevision:0,relatedStateRevision:0,objectRef,inputRefs:[],assistanceRefs:[],coverageRefs:[]}
  const body={kind:'student_help' as const,actionType:'hint',content:'\uFEFF原正文\r\n😀',rationale:'简短依据',expectedStudentAction:'自己试试',
    evidenceIds:[],resourceRefs:[],assistanceContext:'当时允许帮助',unresolved:[],
    policyChecks:{containsWholeSolution:false as const,writesStudentWork:false as const,runsCode:false as const,makesFormalEvaluation:false as const}}
  const question:TutorHistoryQuestion={messageId:'q',jobId:'job',scope,authorKind:'student',contentHash:await textHash('原问题'),
    envelope:{kind:'student_question',question:'原问题',objectRef,inputRefs:[],versions}}
  const bodyJsonText=JSON.stringify(body),reply:TutorHistoryReply={messageId:'m',jobId:'job',scope,authorKind:'model',
    contentHash:await textHash(body.content),resultHash:await textHash(bodyJsonText),envelope:{kind:'student_help',body,bodyJsonText,versions,
      usage:{status:'unknown'},calls:0,elapsedMs:0,basis}}
  const action:TutorHistoryAction={actionId:'a',jobId:'job',messageId:'m',scope,contentHash:reply.contentHash,disposition:'stale',
    targetVersions:versions,basis,generation:'original-g',basisRevised:true,createdAt:'2026-10-13T12:00:00Z',
    deliveries:[{deliveryId:'d',actionId:'a',recipientId:'u',clientId:'original-client',contentHash:reply.contentHash,
      recoveryGeneration:'original-g',serverSeq:2,attemptedAt:'2026-10-13T12:00:00Z',control:{attemptRevision:1,decisionEpoch:1,captureRevision:0}}],
    receipts:[{receiptId:'r',actionId:'a',deliveryId:'d',contentHash:reply.contentHash,receiptKind:'displayed',
      clientReceiptId:'client-r',clientId:'original-client',serverSeq:3,serverReceivedAt:'2026-10-13T12:00:01Z',versions}]}
  return {messages:[question,reply],actions:[action]}
}
beforeEach(()=>{vi.clearAllMocks();mocks.authority.mockResolvedValue(true);mocks.cache.mockResolvedValue(undefined)})
describe('existing C3 student history projection',()=> {
  it('accepts exact old-generation/revised original body and object without current control/cutoff',async()=> {
    const raw=await fixture(),result=await verifyTutorHistory(raw,context)
    expect(result.entries[0]!.message.envelope.body.content).toBe('\uFEFF原正文\r\n😀')
    expect(result.entries[0]!.action.basis.objectRef).toEqual(raw.actions[0]!.basis.objectRef)
    expect(result.entries[0]!.question?.jobId).toBe('job')
    raw.actions[0]!.basis.objectRef!.path='changed.c'
    expect(result.entries[0]!.action.basis.objectRef!.path).toBe('main.c')
  })
  it('permits published optional fields absent, legacy stored time and acknowledged without synthesized displayed',async()=> {
    const raw=await fixture(),reply=raw.messages[1] as TutorHistoryReply
    delete reply.envelope.bodyJsonText;delete reply.resultHash
    raw.actions[0]!.createdAt='legacy-time';raw.actions[0]!.receipts[0]!.receiptKind='acknowledged'
    delete raw.actions[0]!.receipts[0]!.deliveryId;raw.actions[0]!.deliveries=[]
    const result=await verifyTutorHistory(raw,context)
    expect(result.entries[0]!.action.receipts.map(r=>r.receiptKind)).toEqual(['acknowledged'])
    expect(result.entries[0]!.message.envelope.bodyJsonText).toBeUndefined()
  })
  it('preserves own accepted question with no available model body',async()=> {
    const raw=await fixture();raw.messages=raw.messages.slice(0,1);raw.actions=[]
    const result=await verifyTutorHistory(raw,context)
    expect(result.entries).toEqual([]);expect(result.questions).toHaveLength(1)
  })
  it.each([
    ['message scope',(r:Awaited<ReturnType<typeof fixture>>)=>{r.messages[1]!.scope.studentId='other'}],
    ['action scope',(r:Awaited<ReturnType<typeof fixture>>)=>{r.actions[0]!.scope.courseId='other'}],
    ['original Job',(r:Awaited<ReturnType<typeof fixture>>)=>{r.actions[0]!.jobId='other'}],
    ['original Message',(r:Awaited<ReturnType<typeof fixture>>)=>{r.actions[0]!.messageId='other'}],
    ['body hash',(r:Awaited<ReturnType<typeof fixture>>)=>{(r.messages[1] as TutorHistoryReply).envelope.body.content+='changed'}],
    ['question hash',(r:Awaited<ReturnType<typeof fixture>>)=>{(r.messages[0] as TutorHistoryQuestion).envelope.question+='changed'}],
    ['basis mismatch',(r:Awaited<ReturnType<typeof fixture>>)=>{r.actions[0]!.basis={...r.actions[0]!.basis,decisionEpoch:7}}],
    ['target policy mismatch',(r:Awaited<ReturnType<typeof fixture>>)=>{r.actions[0]!.targetVersions={...r.actions[0]!.targetVersions,policyVersionId:'other'}}],
    ['original target',(r:Awaited<ReturnType<typeof fixture>>)=>{(r.messages[0] as TutorHistoryQuestion).envelope.objectRef={kind:'project',attemptId:'attempt',activityVersionId:'activity'}}],
    ['receipt client',(r:Awaited<ReturnType<typeof fixture>>)=>{r.actions[0]!.receipts[0]!.clientId='other'}],
    ['receipt hash',(r:Awaited<ReturnType<typeof fixture>>)=>{r.actions[0]!.receipts[0]!.contentHash='b'.repeat(64)}],
    ['received-only leak',(r:Awaited<ReturnType<typeof fixture>>)=>{r.actions[0]!.receipts[0]!.receiptKind='received'}],
    ['orphan model',(r:Awaited<ReturnType<typeof fixture>>)=>{r.actions=[]}],
    ['duplicate identity',(r:Awaited<ReturnType<typeof fixture>>)=>{r.messages.push(structuredClone(r.messages[1]!))}],
    ['missing body',(r:Awaited<ReturnType<typeof fixture>>)=>{r.messages=r.messages.slice(0,1)}],
  ])('rejects %s atomically',async(_name,mutate)=> {
    const raw=await fixture();mutate(raw);await expect(verifyTutorHistory(raw,context)).rejects.toThrow()
  })
  it('rejects extra private payload and malformed container',async()=> {
    await expect(verifyTutorHistory({...await fixture(),privateAnswer:'secret'},context)).rejects.toThrow()
    await expect(verifyTutorHistory({messages:null,actions:[]},context)).rejects.toThrow()
  })
  it('checks original JSON bytes and body separately',async()=> {
    const raw=await fixture(),reply=raw.messages[1] as TutorHistoryReply
    reply.envelope.bodyJsonText='{}';reply.resultHash=await textHash('{}')
    await expect(verifyTutorHistory(raw,context)).rejects.toThrow()
  })
  it('malformed original JSON is refused without echoing unvalidated text',async()=> {
    const raw=await fixture(),reply=raw.messages[1] as TutorHistoryReply
    reply.envelope.bodyJsonText='UNVALIDATED_PRIVATE_TEXT';reply.resultHash=await textHash(reply.envelope.bodyJsonText)
    await expect(verifyTutorHistory(raw,context)).rejects.toThrow('教学历史字段、归属或原始关联不完整')
  })
  it('retains frozen HDL history and verifies question, answer and Action association atomically',async()=> {
    const raw=await fixture(),q=raw.messages[0] as TutorHistoryQuestion,m=raw.messages[1] as TutorHistoryReply
    const hdl={snapshotId:'snapshot',snapshotHash:'a'.repeat(64),buildId:'build',buildStatus:'failed' as const,workspaceRevision:4,buildResultHash:'b'.repeat(64)}
    q.envelope.hdlSelection={snapshotId:'snapshot',buildId:'build'};q.envelope.hdlBasis=structuredClone(hdl)
    raw.actions[0]!.basis.hdl=structuredClone(hdl);m.envelope.basis.hdl=structuredClone(hdl)
    const history=await verifyTutorHistory(raw,context)
    expect(history.entries[0]!.action.basis.hdl).toEqual(hdl)
    q.envelope.hdlBasis.buildId='other';await expect(verifyTutorHistory(raw,context)).rejects.toThrow()
  })
  it('keeps legacy selected HDL history without reconstructing missing frozen fields',async()=> {
    const raw=await fixture(),q=raw.messages[0] as TutorHistoryQuestion
    q.envelope.hdlSelection={snapshotId:'snapshot',buildId:'build'}
    const history=await verifyTutorHistory(raw,context)
    expect(history.questions[0]!.envelope.hdlBasis).toBeUndefined()
    expect(history.entries[0]!.action.basis.hdl).toBeUndefined()
  })
})
function client() {
  let active=true
  const confirmation={isCurrent:()=>active,current:{attempt:null}}
  const workspace=new TutoringWorkspace(confirmation as unknown as ConfirmationWorkspace,context)
  return {workspace,revoke:()=>{active=false}}
}
describe('authorized history lifecycle',()=> {
  async function loaded() {
    const raw=await fixture(),attempt={attemptRevision:2,decisionEpoch:2,captureRevision:0,status:'active',collecting:true,reminders:false}
    let readable=true
    const confirmation={isCurrent:()=>true,current:{attempt:attempt as typeof attempt|null},
      readHead:async()=>{if(!readable){confirmation.current.attempt=null;return null}return{attempt}}}
    mocks.get.mockImplementation(async(path:string)=>path.endsWith('teaching-records')?raw:{control:{...attempt,generation:'current-g'},
      resyncRequired:false,events:[],nextServerSeq:0,hasMore:false})
    const workspace=new TutoringWorkspace(confirmation as unknown as ConfirmationWorkspace,context)
    await workspace.initialize();await workspace.readHistory()
    return {workspace,failHead:()=>{readable=false},raw}
  }
  it('uses only original HTTP GET and separate cache; cannot change the current ledger or issue receipts',async()=> {
    mocks.get.mockResolvedValue(await fixture());const {workspace}=client()
    await workspace.readHistory()
    expect(mocks.get).toHaveBeenCalledWith('/attempts/attempt/teaching-records',{mode:'preparation',scenarioId:undefined})
    expect(workspace.current.history?.phase).toBe('ready');expect(workspace.current.ledger).toBeNull()
    expect(workspace.current.synchronized).toBe(false);expect(mocks.post).not.toHaveBeenCalled()
    expect(mocks.cache).toHaveBeenCalledOnce();workspace.dispose()
  })
  it('clears this view on a rejected fresh read and never falls back to cached or previous text',async()=> {
    mocks.get.mockResolvedValue(await fixture());const {workspace}=client()
    await workspace.readHistory();expect(workspace.current.history?.data.entries).toHaveLength(1)
    mocks.get.mockRejectedValue(new Error('FORBIDDEN'));await workspace.readHistory()
    expect(workspace.current.history?.phase).toBe('unavailable');expect(workspace.current.history?.data.entries).toEqual([])
    expect(mocks.cache).toHaveBeenCalledOnce();workspace.dispose()
  })
  it('late old read cannot restore content after a newer read fails',async()=> {
    const raw=await fixture();let release!:(v:unknown)=>void
    mocks.get.mockImplementationOnce(()=>new Promise(r=>{release=r})).mockRejectedValueOnce(new Error('UNAUTHENTICATED'))
    const {workspace}=client(),old=workspace.readHistory();await workspace.readHistory();release(raw);await old
    expect(workspace.current.history?.data.entries).toEqual([]);expect(mocks.cache).not.toHaveBeenCalled();workspace.dispose()
  })
  it('account/context switch during HTTP read rejects old content and cache writes',async()=> {
    const raw=await fixture();let release!:(v:unknown)=>void;mocks.get.mockImplementationOnce(()=>new Promise(r=>{release=r}))
    const c=client(),pending=c.workspace.readHistory();c.revoke();release(raw);await pending
    expect(c.workspace.current.history?.data.entries).toEqual([]);expect(mocks.cache).not.toHaveBeenCalled();c.workspace.dispose()
  })
  it('disposal after a valid read removes all visible history',async()=> {
    mocks.get.mockResolvedValue(await fixture());const {workspace}=client();await workspace.readHistory();workspace.dispose()
    expect(workspace.current.history?.data.entries).toEqual([])
  })
  it('a swallowed failed workspace read revokes visible history without requiring manual history refresh',async()=> {
    const f=await loaded();expect(f.workspace.current.history?.data.entries).toHaveLength(1)
    mocks.get.mockClear();f.failHead();await f.workspace.read(true)
    expect(f.workspace.current.history?.phase).toBe('unavailable')
    expect(f.workspace.current.history?.data.entries).toEqual([])
    expect(mocks.get).not.toHaveBeenCalled();expect(mocks.post).not.toHaveBeenCalled();f.workspace.dispose()
  })
  it('a held successful history response cannot restore text after a swallowed failed head read',async()=> {
    const f=await loaded();let release!:(v:unknown)=>void
    mocks.get.mockImplementationOnce(()=>new Promise(r=>{release=r}))
    const pending=f.workspace.readHistory(),cached=mocks.cache.mock.calls.length
    f.failHead();await f.workspace.read();release(f.raw);await pending
    expect(f.workspace.current.history?.data.entries).toEqual([])
    expect(mocks.cache).toHaveBeenCalledTimes(cached);f.workspace.dispose()
  })
})
