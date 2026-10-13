import { record, requiredId, revision, textHash } from './confirmation'
import { pathProblem } from '../lib/projectFiles'
import { tutorActions } from './tutoringEvents'
import type { CommandContext } from './frozenCommand'
import type { TutorHistory, TutorHistoryAction, TutorHistoryQuestion, TutorHistoryReply, TutorSource } from './tutoringContracts'

export const emptyTutorHistory = ():TutorHistory => ({questions:[],entries:[]})
function fail():never { throw new Error('教学历史字段、归属或原始关联不完整') }
const hash = (v:unknown) => { if(typeof v!=='string'||!/^[a-f0-9]{64}$/.test(v))fail();return v }
const text = (v:unknown,nonempty=false) => {if(typeof v!=='string'||(nonempty&&!v.length))fail();return v}
const strings = (v:unknown,ids=false) => {
  if(!Array.isArray(v))fail()
  v.forEach(x=>ids?requiredId(x):text(x))
}
const shape = (v:unknown,keys:string[]) => {
  const r=record(v);if(Object.keys(r).some(k=>!keys.includes(k)))fail();return r
}
const same = (a:unknown,b:unknown):boolean => {
  const normalized=(v:unknown):unknown => Array.isArray(v)?v.map(normalized):v&&typeof v==='object'
    ?Object.fromEntries(Object.keys(v).sort().map(k=>[k,normalized((v as Record<string,unknown>)[k])])):v
  return JSON.stringify(normalized(a))===JSON.stringify(normalized(b))
}
function scope(v:unknown,c:CommandContext) {
  const s=shape(v,['courseId','studentId','attemptId'])
  for(const k of ['courseId','studentId','attemptId'])requiredId(s[k])
  if(s.courseId!==c.courseId||s.studentId!==c.userId||s.attemptId!==c.attemptId)fail()
}
function versions(v:unknown,c:CommandContext) {
  const r=shape(v,['activityVersionId','policyVersionId','modelConfigVersion','promptVersion','schemaVersion','analysisVersion'])
  for(const k of ['activityVersionId','policyVersionId','modelConfigVersion','promptVersion','schemaVersion'])requiredId(r[k])
  if(r.analysisVersion!==undefined)requiredId(r.analysisVersion)
  if(r.activityVersionId!==c.activityVersionId)fail()
}
function objectRef(v:unknown,c:CommandContext) {
  const r=record(v)
  const fields:Record<string,string[]>={project:['activityVersionId'],run:['runId','snapshotId'],resource:['resourceVersionId','paragraphId'],
    code:['snapshotId','fileId','path','documentVersion','contentHash','range','source']}
  const keys=fields[String(r.kind)];if(!keys)fail()
  shape(r,['kind','attemptId',...keys]);if(r.attemptId!==c.attemptId)fail()
  if(r.kind==='project') {if(r.activityVersionId!==c.activityVersionId)fail()}
  else if(r.kind==='code') {
    requiredId(r.snapshotId);requiredId(r.fileId);revision(r.documentVersion,1);hash(r.contentHash)
    if(typeof r.path!=='string'||pathProblem(r.path,[]))fail()
    if(r.range!==undefined) {
      const range=shape(r.range,['startLine','startColumn','endLine','endColumn'])
      for(const v of Object.values(range))revision(v,1)
      if(Object.keys(range).length!==4)fail()
      if((range.endLine as number)<(range.startLine as number)||range.endLine===range.startLine&&(range.endColumn as number)<(range.startColumn as number))fail()
    }
    if(r.source!==undefined) {
      const source=shape(r.source,['system','session','modelId','seq'])
      if(source.system!=='student-ide')fail();requiredId(source.session);requiredId(source.modelId)
      if(source.seq!==undefined)revision(source.seq)
    }
  } else for(const key of keys)requiredId(r[key])
}
function basis(v:unknown,c:CommandContext) {
  const r=shape(v,['attemptRevision','decisionEpoch','captureRevision','relatedStateRevision','objectRef','inputRefs','assistanceRefs','coverageRefs'])
  revision(r.attemptRevision,1);for(const k of ['decisionEpoch','captureRevision','relatedStateRevision'])revision(r[k])
  for(const k of ['inputRefs','assistanceRefs','coverageRefs'])strings(r[k],true)
  if(r.objectRef!==undefined)objectRef(r.objectRef,c)
}
const sourceFields = ['scope','jobId','messageId','generation','targetVersions','basis'] as const
function freezeSource<T>(value:T):T {
  if(value&&typeof value==='object') {
    for(const nested of Object.values(value))freezeSource(nested)
    Object.freeze(value)
  }
  return value
}
/** Validate only the published Action association; absence is legacy, never an inferred Job or object. */
export function verifyTutorSource(payload:unknown,c:CommandContext,epoch:number):TutorSource|null {
  try {
    const raw=record(payload),present=sourceFields.filter(key=>Object.hasOwn(raw,key))
    if(!present.length)return null
    if(present.length!==sourceFields.length)fail()
    // Copy the six association fields only, keeping unrelated/unvalidated body bytes out of error handling.
    const source=structuredClone(Object.fromEntries(sourceFields.map(key=>[key,raw[key]])))
    scope(source.scope,c);versions(source.targetVersions,c)
    requiredId(source.jobId);requiredId(source.messageId);requiredId(source.generation)
    if(source.generation!==c.trustedRecoveryGeneration)fail()
    const b=shape(source.basis,['attemptRevision','decisionEpoch','captureRevision','relatedStateRevision','objectRef'])
    revision(b.attemptRevision,1)
    for(const key of ['decisionEpoch','captureRevision','relatedStateRevision'])revision(b[key])
    if(b.decisionEpoch!==revision(epoch))fail()
    if(b.objectRef!==undefined)objectRef(b.objectRef,c)
    return freezeSource(source as unknown as TutorSource)
  } catch {
    throw new Error('教学消息来源字段、归属或原始关联不完整')
  }
}
/** Compare the normalized immutable origin, not a Delivery, body, arrival order, or later basis-revision flag. */
export function sameTutorSource(a:TutorSource,b:TutorSource):boolean {
  const tuple=(s:TutorSource)=>[s.scope,s.jobId,s.messageId,s.generation,s.targetVersions,s.basis]
  return same(tuple(a),tuple(b))
}
function body(v:unknown) {
  const r=shape(v,['kind','actionType','content','rationale','expectedStudentAction','evidenceIds','resourceRefs','assistanceContext','unresolved','policyChecks'])
  if(r.kind!=='student_help'||!tutorActions.includes(String(r.actionType)))fail()
  for(const k of ['content','rationale','expectedStudentAction','assistanceContext'])text(r[k],true)
  strings(r.evidenceIds,true);strings(r.resourceRefs,true);strings(r.unresolved)
  const checks=shape(r.policyChecks,['containsWholeSolution','writesStudentWork','runsCode','makesFormalEvaluation'])
  if(Object.keys(checks).length!==4||Object.values(checks).some(v=>v!==false))fail()
  return r
}
/** A complete student projection; no reconstructed bodies or current-delivery authority. */
export async function verifyTutorHistory(value:unknown,c:CommandContext):Promise<TutorHistory> {
  requiredId(c.attemptId)
  const page=shape(structuredClone(value),['messages','actions'])
  if(!Array.isArray(page.messages)||!Array.isArray(page.actions))fail()
  const questions:TutorHistoryQuestion[]=[],replies=new Map<string,TutorHistoryReply>()
  const messageIds=new Set<string>(),jobAuthors=new Set<string>()
  for(const value of page.messages) {
    const m=shape(value,['messageId','scope','jobId','requestReceiptId','authorKind','contentHash','resultHash','envelope'])
    const id=requiredId(m.messageId),jobId=requiredId(m.jobId);scope(m.scope,c);hash(m.contentHash)
    if(messageIds.has(id)||jobAuthors.has(`${jobId}:${m.authorKind}`))fail()
    messageIds.add(id);jobAuthors.add(`${jobId}:${m.authorKind}`)
    if(m.requestReceiptId!==undefined)requiredId(m.requestReceiptId)
    if(m.resultHash!==undefined)hash(m.resultHash)
    if(m.authorKind==='student') {
      const e=shape(m.envelope,['kind','question','objectRef','inputRefs','versions'])
      if(e.kind!=='student_question'||m.contentHash!==await textHash(text(e.question)))fail()
      strings(e.inputRefs,true);versions(e.versions,c);if(e.objectRef!==undefined)objectRef(e.objectRef,c)
      questions.push(m as unknown as TutorHistoryQuestion)
    } else if(m.authorKind==='model') {
      const e=shape(m.envelope,['kind','body','bodyJsonText','versions','usage','calls','elapsedMs','basis'])
      if(e.kind!=='student_help')fail();const b=body(e.body)
      if(m.contentHash!==await textHash(text(b.content)))fail()
      versions(e.versions,c);basis(e.basis,c);revision(e.calls);revision(e.elapsedMs)
      const usage=shape(e.usage,['status','inputTokens','outputTokens','reason'])
      if(usage.status==='actual') {shape(usage,['status','inputTokens','outputTokens']);revision(usage.inputTokens);revision(usage.outputTokens)}
      else if(usage.status==='unknown') {shape(usage,['status','reason']);if(usage.reason!==undefined)requiredId(usage.reason)}
      else fail()
      // Older C3 rows can lack the original JSON bytes; do not require or recreate them.
      if(e.bodyJsonText!==undefined) {
        const raw=text(e.bodyJsonText);if(m.resultHash!==await textHash(raw))fail()
        let parsed:unknown
        try {parsed=JSON.parse(raw)}catch {fail()} // Never put unvalidated raw bytes in a parser error shown to the student.
        if(!same(parsed,e.body))fail()
      }
      replies.set(id,m as unknown as TutorHistoryReply)
    } else fail()
  }
  const entries:TutorHistory['entries']=[],actionIds=new Set<string>(),actionJobs=new Set<string>(),usedMessages=new Set<string>()
  for(const value of page.actions) {
    const a=shape(value,['actionId','scope','jobId','messageId','contentHash','disposition','targetVersions','basis','generation','stopReason','causeRef','basisRevised','createdAt','deliveries','receipts'])
    const id=requiredId(a.actionId),jobId=requiredId(a.jobId),messageId=requiredId(a.messageId)
    scope(a.scope,c);hash(a.contentHash);versions(a.targetVersions,c);basis(a.basis,c);requiredId(a.generation);requiredId(a.createdAt)
    if(a.stopReason!==undefined)requiredId(a.stopReason);if(a.causeRef!==undefined)requiredId(a.causeRef)
    if(!['pending','cancelled','stale','failed'].includes(String(a.disposition))||typeof a.basisRevised!=='boolean'
      ||!Array.isArray(a.deliveries)||!Array.isArray(a.receipts)||actionIds.has(id)||actionJobs.has(jobId)||usedMessages.has(messageId))fail()
    actionIds.add(id);actionJobs.add(jobId);usedMessages.add(messageId)
    const message=replies.get(messageId),question=questions.find(q=>q.jobId===jobId)
    if(!message||message.jobId!==jobId||message.contentHash!==a.contentHash||!same(message.envelope.basis,a.basis)||!same(message.envelope.versions,a.targetVersions))fail()
    if(question&&(!same(question.envelope.versions,a.targetVersions)||question.envelope.objectRef!==undefined&&!same(question.envelope.objectRef,message.envelope.basis.objectRef)))fail()
    if(question?.requestReceiptId&&message.requestReceiptId&&question.requestReceiptId!==message.requestReceiptId)fail()
    const deliveries=new Map<string,Record<string,unknown>>()
    for(const value of a.deliveries) {
      const d=shape(value,['deliveryId','actionId','recipientId','clientId','contentHash','recoveryGeneration','serverSeq','attemptedAt','control','eventId'])
      const id=requiredId(d.deliveryId)
      if(deliveries.has(id)||d.actionId!==a.actionId||d.recipientId!==c.userId||d.contentHash!==a.contentHash)fail()
      for(const k of ['clientId','recoveryGeneration','attemptedAt'])requiredId(d[k]);revision(d.serverSeq,1)
      if(d.eventId!==undefined)requiredId(d.eventId)
      const control=shape(d.control,['attemptRevision','decisionEpoch','captureRevision'])
      revision(control.attemptRevision,1);revision(control.decisionEpoch);revision(control.captureRevision)
      deliveries.set(id,d)
    }
    const receiptIds=new Set<string>(),receiptKeys=new Set<string>();let shown=false
    for(const value of a.receipts) {
      const r=shape(value,['receiptId','actionId','deliveryId','contentHash','receiptKind','clientReceiptId','clientId','serverSeq','clientDeclaredAt','serverReceivedAt','versions','raceReason'])
      const id=requiredId(r.receiptId);for(const k of ['clientReceiptId','clientId','serverReceivedAt'])requiredId(r[k]);revision(r.serverSeq,1)
      if(r.clientDeclaredAt!==undefined)requiredId(r.clientDeclaredAt);if(r.raceReason!==undefined)requiredId(r.raceReason)
      versions(r.versions,c)
      const receiptKey=JSON.stringify([r.receiptKind,r.clientReceiptId])
      if(receiptIds.has(id)||receiptKeys.has(receiptKey)||r.actionId!==a.actionId||r.contentHash!==a.contentHash||!same(r.versions,a.targetVersions)
        ||!['received','displayed','acknowledged','cancelled','stale','failed'].includes(String(r.receiptKind)))fail()
      receiptIds.add(id);receiptKeys.add(receiptKey)
      if(r.deliveryId!==undefined) {
        const d=deliveries.get(requiredId(r.deliveryId));if(!d||d.clientId!==r.clientId||d.contentHash!==r.contentHash)fail()
      }
      // deliveryId is optional in the public stored receipt type; history never uses it to report again.
      if(r.receiptKind==='displayed'||r.receiptKind==='acknowledged')shown=true
    }
    if(!shown)fail()
    entries.push({action:a as unknown as TutorHistoryAction,message,...(question?{question}:{})})
  }
  if(replies.size!==usedMessages.size)fail() // Student projection must not leak an unshown orphan body.
  return {questions,entries}
}
