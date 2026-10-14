import { describe, expect, it } from 'vitest'
import type { CommandContext } from './frozenCommand'
import type { TutorObject, TutorPayload, TutorSource } from './tutoringContracts'
import { sameTutorSource, verifyTutorSource } from './tutoringHistory'

const context:CommandContext={mode:'real',userId:'student',courseId:'course',assignmentId:'assignment',
  activityVersionId:'activity',attemptId:'attempt',preparationEpoch:null,trustedRecoveryGeneration:'generation',loadEpoch:1}
const epoch=2
const sourceKeys=['scope','jobId','messageId','generation','targetVersions','basis'] as const
const code=():TutorObject=>({kind:'code',attemptId:'attempt',snapshotId:'snapshot',fileId:'original-file',path:'src/main.c',
  documentVersion:1,contentHash:'a'.repeat(64),range:{startLine:1,startColumn:1,endLine:2,endColumn:3},
  source:{system:'student-ide',session:'original-session',modelId:'original-model',seq:0}})
function source():TutorSource {
  return {scope:{courseId:'course',studentId:'student',attemptId:'attempt'},jobId:'job',messageId:'message',generation:'generation',
    targetVersions:{activityVersionId:'activity',policyVersionId:'original-policy',modelConfigVersion:'model',promptVersion:'prompt',schemaVersion:'schema'},
    basis:{attemptRevision:1,decisionEpoch:epoch,captureRevision:0,relatedStateRevision:0,objectRef:code()}}
}
function payload():TutorPayload & TutorSource {
  return {...source(),actionId:'action',contentHash:'b'.repeat(64),content:'相同的提示正文',actionType:'hint',
    disposition:'pending',createdAt:'2026-10-14T00:00:00Z',basisRevised:false,deliveryId:'delivery'}
}
const raw=()=>payload() as unknown as Record<string,unknown>
const assoc=(p:Record<string,unknown>,key:string)=>p[key] as Record<string,unknown>
const reversed=(v:unknown):unknown=>Array.isArray(v)?v.map(reversed):v&&typeof v==='object'
  ?Object.fromEntries(Object.keys(v).reverse().map(k=>[k,reversed((v as Record<string,unknown>)[k])])):v

describe('C3 first-delivery immutable source',()=> {
  it('accepts the exact five-field basis and returns a detached, deeply frozen original association',()=> {
    const p=payload(),verified=verifyTutorSource(p,context,epoch)!
    expect(verified).toEqual(source());expect(Object.keys(verified).sort()).toEqual([...sourceKeys].sort())
    for(const v of [verified,verified.scope,verified.targetVersions,verified.basis,verified.basis.objectRef,
      verified.basis.objectRef!.range,verified.basis.objectRef!.source])expect(Object.isFrozen(v)).toBe(true)
    p.jobId='other-job';p.scope.studentId='other';p.targetVersions.policyVersionId='changed';p.basis.objectRef!.path='renamed.c'
    expect(verified).toEqual(source())
    expect(()=>{verified.basis.objectRef!.path='renamed.c'}).toThrow()
  })
  it('keeps legacy fields absent as null without inferring a Job from identical body, Action or another object',()=> {
    const legacy=raw();for(const key of sourceKeys)delete legacy[key]
    legacy.latestJob={jobId:'guessed'};legacy.objectRef=code()
    expect(verifyTutorSource(legacy,context,epoch)).toBeNull()
  })
  it.each(sourceKeys)('rejects the partial association when %s is missing',key=> {
    const p=raw();delete p[key];expect(()=>verifyTutorSource(p,context,epoch)).toThrow()
  })
  it.each(sourceKeys)('rejects an explicitly undefined %s instead of treating it as an older projection',key=> {
    const p=raw();p[key]=undefined;expect(()=>verifyTutorSource(p,context,epoch)).toThrow()
  })
  it.each(['courseId','studentId','attemptId'])('rejects cross-scope %s',key=> {
    const p=raw();assoc(p,'scope')[key]='other';expect(()=>verifyTutorSource(p,context,epoch)).toThrow()
  })
  it('rejects old generation/epoch and invalid current epoch without accepting a new context label',()=> {
    expect(()=>verifyTutorSource({...payload(),generation:'old-generation'},context,epoch)).toThrow()
    expect(()=>verifyTutorSource(payload(),{...context,trustedRecoveryGeneration:'new-generation'},epoch)).toThrow()
    expect(()=>verifyTutorSource(payload(),context,epoch+1)).toThrow()
    expect(()=>verifyTutorSource(payload(),context,-1)).toThrow()
    expect(()=>verifyTutorSource(payload(),context,Number.NaN)).toThrow()
  })
  it.each(['jobId','messageId','generation'])('requires a valid original %s',key=> {
    const p=raw();p[key]='';expect(()=>verifyTutorSource(p,context,epoch)).toThrow()
  })
  it.each([
    ['attemptRevision',0],['attemptRevision',-1],['attemptRevision',1.5],['decisionEpoch',-1],
    ['captureRevision',-1],['captureRevision',Number.MAX_SAFE_INTEGER+1],['relatedStateRevision',-1],['relatedStateRevision','0'],
  ])('rejects malformed origin revision %s=%s',(key,value)=> {
    const p=raw();assoc(p,'basis')[key as string]=value;expect(()=>verifyTutorSource(p,context,epoch)).toThrow()
  })
  it('preserves accepted origin revisions while unrelated current attempt/capture revisions advance',()=> {
    const c={...context,attemptRevision:99,captureRevision:42},p=payload()
    p.basis.relatedStateRevision=7
    const verified=verifyTutorSource(p,c,epoch)!
    expect(verified.basis.attemptRevision).toBe(1);expect(verified.basis.captureRevision).toBe(0)
    expect(verified.basis.relatedStateRevision).toBe(7);expect(verified.targetVersions.policyVersionId).toBe('original-policy')
  })
  it.each(['inputRefs','assistanceRefs','coverageRefs','privateAnswer'])('rejects non-public basis field %s',key=> {
    const p=raw();assoc(p,'basis')[key]=['private'];expect(()=>verifyTutorSource(p,context,epoch)).toThrow()
  })
  it('reuses fixed activity and strict version/scope projections',()=> {
    const wrong=payload();wrong.targetVersions.activityVersionId='other-activity'
    expect(()=>verifyTutorSource(wrong,context,epoch)).toThrow()
    const missing=raw();delete assoc(missing,'targetVersions').schemaVersion
    expect(()=>verifyTutorSource(missing,context,epoch)).toThrow()
    const extra=raw();assoc(extra,'scope').privateAnswer='PRIVATE_SCOPE'
    expect(()=>verifyTutorSource(extra,context,epoch)).toThrow()
    const versions=raw();assoc(versions,'targetVersions').leaseToken='PRIVATE_LEASE'
    expect(()=>verifyTutorSource(versions,context,epoch)).toThrow()
  })
  it.each<TutorObject>([
    {kind:'project',attemptId:'attempt',activityVersionId:'activity'},
    {kind:'run',attemptId:'attempt',runId:'original-run',snapshotId:'original-snapshot'},
    {kind:'resource',attemptId:'attempt',resourceVersionId:'resource-version',paragraphId:'paragraph'},code(),
  ])('accepts an actual %s ObjectRef without changing its original fields',objectRef=> {
    const p=payload();p.basis.objectRef=objectRef
    expect(verifyTutorSource(p,context,epoch)!.basis.objectRef).toEqual(objectRef)
  })
  it('permits absent ObjectRef and never manufactures one from the body or current selection',()=> {
    const p=payload();delete p.basis.objectRef
    const verified=verifyTutorSource(p,context,epoch)!
    expect(Object.hasOwn(verified.basis,'objectRef')).toBe(false)
  })
  it.each<TutorObject>([
    {kind:'unknown',attemptId:'attempt'},
    {kind:'project',attemptId:'attempt',activityVersionId:'other'},
    {kind:'run',attemptId:'other',runId:'run',snapshotId:'snapshot'},
    {kind:'run',attemptId:'attempt',runId:'',snapshotId:'snapshot'},
    {kind:'resource',attemptId:'attempt',resourceVersionId:'resource'},
    {...code(),documentVersion:0},{...code(),contentHash:'A'.repeat(64)},
    {...code(),source:{system:'other',session:'session',modelId:'model'}},
    {...code(),source:{system:'student-ide',session:'session',modelId:'model',seq:-1}},
  ])('rejects illegal original ObjectRef %j',objectRef=> {
    const p=payload();p.basis.objectRef=objectRef;expect(()=>verifyTutorSource(p,context,epoch)).toThrow()
  })
  it.each(['','/root.c','D:/private.c','../private.c','src/../private.c','src//main.c','src\\main.c','src/\0main.c'])('rejects illegal original code path %j',path=> {
    const p=payload();p.basis.objectRef={...code(),path};expect(()=>verifyTutorSource(p,context,epoch)).toThrow()
  })
  it.each([
    {startLine:0,startColumn:1,endLine:2,endColumn:3},
    {startLine:1,startColumn:0,endLine:2,endColumn:3},
    {startLine:2,startColumn:1,endLine:1,endColumn:3},
    {startLine:1,startColumn:4,endLine:1,endColumn:3},
    {startLine:1.5,startColumn:1,endLine:2,endColumn:3},
    {startLine:1,startColumn:1,endLine:2},
    {startLine:1,startColumn:1,endLine:2,endColumn:3,privateAnswer:'private'},
  ])('rejects malformed UTF-16 range %j',range=> {
    const p=payload();p.basis.objectRef={...code(),range};expect(()=>verifyTutorSource(p,context,epoch)).toThrow()
  })
  it('reports invalid source without echoing private content or parser details',()=> {
    const p=raw();p.content='PRIVATE_BODY_DO_NOT_ECHO';assoc(p,'scope').studentId='PRIVATE_ID_DO_NOT_ECHO'
    try {verifyTutorSource(p,context,epoch);expect.fail('must reject source')}catch(e) {
      expect((e as Error).message).toBe('教学消息来源字段、归属或原始关联不完整')
    }
  })
})

describe('source identity comparison',()=> {
  it('distinguishes identical bodies/hashes belonging to different Jobs without using arrival order',()=> {
    const first=payload(),second={...payload(),jobId:'another-job',messageId:'another-message',actionId:'another-action'}
    expect(first.content).toBe(second.content);expect(first.contentHash).toBe(second.contentHash)
    expect(sameTutorSource(verifyTutorSource(first,context,epoch)!,verifyTutorSource(second,context,epoch)!)).toBe(false)
  })
  it('normalizes nested key order and ignores Delivery and subsequent basisRevised/body flags',()=> {
    const a=payload(),b={...reversed(payload()) as TutorPayload & TutorSource,deliveryId:'redelivery',basisRevised:true,
      disposition:'stale' as const,content:'different body is checked separately'}
    expect(sameTutorSource(verifyTutorSource(a,context,epoch)!,verifyTutorSource(b,context,epoch)!)).toBe(true)
    expect(sameTutorSource(a,b)).toBe(true)
  })
  it.each([
    ['job',(s:TutorSource)=>{s.jobId='another-job'}],
    ['message',(s:TutorSource)=>{s.messageId='another-message'}],
    ['policy',(s:TutorSource)=>{s.targetVersions.policyVersionId='other-policy'}],
    ['attempt origin',(s:TutorSource)=>{s.basis.attemptRevision=3}],
    ['capture origin',(s:TutorSource)=>{s.basis.captureRevision=4}],
    ['related state',(s:TutorSource)=>{s.basis.relatedStateRevision=1}],
    ['snapshot',(s:TutorSource)=>{s.basis.objectRef!.snapshotId='other-snapshot'}],
    ['file instance',(s:TutorSource)=>{s.basis.objectRef!.fileId='same-name-new-file'}],
    ['document version',(s:TutorSource)=>{s.basis.objectRef!.documentVersion=2}],
    ['range',(s:TutorSource)=>{s.basis.objectRef!.range={startLine:1,startColumn:2,endLine:2,endColumn:3}}],
    ['run',(s:TutorSource)=>{s.basis.objectRef={kind:'run',attemptId:'attempt',runId:'run',snapshotId:'snapshot'}}],
  ])('detects immutable %s conflicts even when the body/Action hash is unchanged',(_name,mutate)=> {
    const a=payload(),b=payload();mutate(b)
    expect(b.actionId).toBe(a.actionId);expect(b.contentHash).toBe(a.contentHash)
    expect(sameTutorSource(verifyTutorSource(a,context,epoch)!,verifyTutorSource(b,context,epoch)!)).toBe(false)
  })
})
