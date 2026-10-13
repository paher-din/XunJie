// Synthetic completed B2/C3 public projections, following application.ts and teaching.ts.
// Imported only by dev:prep plugin; no supplier, runner, real account or backend import.
import { randomUUID } from 'node:crypto'
import { sha256Hex, REFS } from './scenario'
import type { PrepSession } from './authority'
import { PrepWorkspaceError, readPrepAttempt, recoveryGenerationOf, prepTeachingCommand } from './workspace'
import type { TutorJob, TutorPage, TutorPayload, TutorCoverage, TutorHistoryQuestion, TutorBasis, TutorVersions,
  TutorHistoryAction, TutorHistoryReply, TutorHistoryBody, TutorObject } from '../src/workspace/tutoringContracts'
interface Action { payload: TutorPayload; jobId: string; epoch: number; clients: Map<string, { deliveryId: string; seq: number }>; shown: boolean
  record:TutorHistoryAction;message:TutorHistoryReply }
interface Scene { seq: number; jobs: TutorJob[]; actions: Action[]; questions:TutorHistoryQuestion[];bases:Map<string,TutorBasis>
  coverage?:TutorCoverage; receipts: Array<{ actionId: string; kind: string; clientId: string; key: string; wire: string; result: unknown }> }
const scenes = new Map<string, Scene>()
const scripts = new Map<string, 'normal' | 'running' | 'failed' | 'timed_out' | 'budget'>()
export function setPrepTutorScript(scenario: string, body: unknown) {
  const value=object(body,['kind']).kind
  if(value==='history-revised') {
    for(const action of sceneOf(scenario).actions) {
      action.payload.basisRevised=true;action.payload.disposition='stale'
      action.record.stopReason='synthetic_teacher_revision'
      const job=sceneOf(scenario).jobs.find(j=>j.jobId===action.jobId);if(job)job.stopRequested=true
    }
    return {kind:value}
  }
  if (!['normal','running','failed','timed_out','budget'].includes(String(value))) reject('INVALID_REQUEST')
  scripts.set(scenario,value as 'normal'|'running'|'failed'|'timed_out'|'budget')
  return {kind:value}
}
const sceneOf = (id: string) => { if (!scenes.has(id)) scenes.set(id, { seq: 0, jobs: [], actions: [], receipts: [],questions:[],bases:new Map() }); return scenes.get(id)! }
function reject(code: ConstructorParameters<typeof PrepWorkspaceError>[0]): never { throw new PrepWorkspaceError(code) }
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (v && typeof v==='object') return `{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canonical((v as Record<string,unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v)
}
const object = (v: unknown, keys: string[]): Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) reject('INVALID_REQUEST')
  return v as Record<string, unknown>
}
export function ownsPrepTutorJob(scenario: string, id: string) { return sceneOf(scenario).jobs.some(j => j.jobId === id) }
export function recordPrepTutorCoverage(scenario:string,session:PrepSession,attemptId:string,serverSeq?:number) {
  const scene=sceneOf(scenario),a=readPrepAttempt(scenario,session,attemptId).attempt,now=new Date().toISOString()
  scene.seq=Math.max(scene.seq,serverSeq??0)
  const old=scene.coverage
  if(!old)scene.coverage={attemptId,captureRevision:a.captureRevision,collecting:a.collecting,cutoffServerSeq:scene.seq,intervals:[]}
  const coverage=scene.coverage!
  const last=coverage.intervals.at(-1)
  if(!last || last.captureRevision!==a.captureRevision) {
    if(last){last.open=false;last.to=now;last.toServerSeq=scene.seq}
    coverage.intervals.push({attemptId,captureRevision:a.captureRevision,state:a.collecting?'collecting':'paused',fromServerSeq:scene.seq,from:now,open:true,rejections:[]})
  }
  coverage.captureRevision=a.captureRevision;coverage.collecting=a.collecting;coverage.cutoffServerSeq=scene.seq
  return structuredClone(coverage)
}
export function stopPrepTutoring(scenario: string, attemptId: string, purposes: string[]) {
  if(!purposes.includes('student_help')) return []
  const scene=sceneOf(scenario), ids:string[]=[]
  for(const job of scene.jobs) if(job.scope.attemptId===attemptId && !job.stopRequested) {
    job.stopRequested=true
    if(['queued','running'].includes(job.status)) {job.status='cancelled';ids.push(job.jobId)}
    for(const action of scene.actions) if(action.jobId===job.jobId&&!action.shown)action.payload.disposition='cancelled'
  }
  return ids
}
export function createPrepHelp(scenario: string, session: PrepSession, attemptId: string, value: unknown, key: unknown) {
  const body = object(value, ['question','expectedAttemptRevision','recoveryGeneration','objectRef'])
  if (typeof body.question !== 'string' || !body.question.trim() || body.question.length > 16384) reject('INVALID_REQUEST')
  const scene = sceneOf(scenario)
  const receipt=prepTeachingCommand(scenario, session, attemptId, 'student_help.create', `/api/attempts/${attemptId}/help`, body, key, head => {
    if (body.expectedAttemptRevision !== head.attempt.attemptRevision) reject('VERSION_CONFLICT')
    if (!['ready','active'].includes(head.attempt.status)) reject('STATE_CONFLICT')
    if (scripts.get(scenario)==='budget') reject('BUDGET_EXHAUSTED')
    if (body.objectRef) {
      const ref = object(body.objectRef, ['kind','attemptId','activityVersionId','snapshotId','fileId','path','documentVersion','contentHash','range','runId','source'])
      if (ref.attemptId !== attemptId) reject('INVALID_REFERENCE')
      if (ref.kind === 'code') {
        const snapshot = head.snapshots.find(s => s.snapshotId === ref.snapshotId), file = snapshot?.files.find(f => f.fileId === ref.fileId)
        if (!file || file.path !== ref.path || file.documentVersion !== ref.documentVersion || file.contentHash !== ref.contentHash) reject('INVALID_REFERENCE')
      } else if (ref.kind === 'run') {
        if (!head.runs.some(r => r.runId === ref.runId && r.snapshotId === ref.snapshotId)) reject('INVALID_REFERENCE')
      } else if (ref.kind !== 'project' || ref.activityVersionId !== head.attempt.activityVersionId) reject('INVALID_REFERENCE')
    }
    const replacedJobIds = scene.jobs.filter(j => !j.stopRequested && ['queued','running'].includes(j.status)).map(j => j.jobId)
    for (const job of scene.jobs) if (replacedJobIds.includes(job.jobId)) { job.stopRequested = true; job.status = 'cancelled' }
    for (const action of scene.actions) if (!action.shown) action.payload.disposition = 'stale'
    head.attempt.decisionEpoch++; head.attempt.attemptRevision++
    if (head.attempt.status === 'ready') head.attempt.status = 'active'
    const jobId = randomUUID(), now = new Date().toISOString()
    scene.jobs.push({ jobId, purpose: 'student_help', status: 'queued', stopRequested: false,
      scope: { courseId: session.courseId, studentId: session.userId, attemptId }, decisionEpoch: head.attempt.decisionEpoch,
      recoveryGeneration: recoveryGenerationOf(scenario), acceptedAt: now, deadline: new Date(Date.now()+45000).toISOString() })
    const versions:TutorVersions={activityVersionId:head.attempt.activityVersionId,policyVersionId:REFS.helpPolicyVersionId,
      modelConfigVersion:'prep-model-v1',promptVersion:'prep-prompt-v1',schemaVersion:'prep-schema-v1'}
    scene.questions.push({messageId:randomUUID(),jobId,scope:{courseId:session.courseId,studentId:session.userId,attemptId},
      authorKind:'student',contentHash:sha256Hex(body.question as string),envelope:{kind:'student_question',question:body.question as string,
        inputRefs:[],versions,...(body.objectRef?{objectRef:structuredClone(body.objectRef) as TutorObject}:{})}})
    scene.bases.set(jobId,{attemptRevision:head.attempt.attemptRevision,decisionEpoch:head.attempt.decisionEpoch,
      captureRevision:head.attempt.captureRevision,relatedStateRevision:0,inputRefs:[],assistanceRefs:[],coverageRefs:[],
      ...(body.objectRef?{objectRef:structuredClone(body.objectRef) as TutorObject}:{})})
    return { jobId, attemptRevision: head.attempt.attemptRevision, decisionEpoch: head.attempt.decisionEpoch,
      replacedJobIds, acceptedInputHash: sha256Hex(canonical({target:'student_help.accepted_input',fields:{question:body.question,objectRef:body.objectRef??null}})) }
  })
  const question=scene.questions.find(q=>q.jobId===(receipt.result as {jobId:string}).jobId)
  if(question)question.requestReceiptId=receipt.receiptId
  return receipt
}
export function readPrepTutorJob(scenario: string, session: PrepSession, id: string) {
  const scene = sceneOf(scenario), job = scene.jobs.find(j => j.jobId === id)
  if (!job) reject('FORBIDDEN')
  const head = readPrepAttempt(scenario, session, job.scope.attemptId!)
  if (!job.stopRequested && ['queued','running'].includes(job.status)) {
    if (job.status === 'queued') job.status = 'running'
    else if (scripts.get(scenario)==='failed' || scripts.get(scenario)==='timed_out') {
      job.status=scripts.get(scenario)==='failed'?'failed':'timed_out'
      job.failure='synthetic_provider_failure'
    } else if (scripts.get(scenario)!=='running') {
      job.status = 'succeeded'
      const content = '合成准备内容：先选一个最小输入，手算预期输出，再检查程序中的判断条件。'
      const question=scene.questions.find(q=>q.jobId===id)!,basis=scene.bases.get(id)!
      const payload:TutorPayload={ actionId: randomUUID(), contentHash: sha256Hex(content), disposition: 'pending', createdAt: new Date().toISOString(),
          basisRevised: false, actionType: 'hint', content, rationale: '合成项目级支持，不包含代码定位。',
          expectedStudentAction: '自己构造一个反例并检查。', assistanceContext: '合成准备场景，非实际模型输出。',
          evidenceIds: [], resourceRefs: ['prep-resource-adjacent-example-01'], unresolved: ['首次投递对象关联尚未交接'] }
      const body:TutorHistoryBody={kind:'student_help',actionType:payload.actionType!,content,rationale:payload.rationale!,
        expectedStudentAction:payload.expectedStudentAction!,assistanceContext:payload.assistanceContext!,evidenceIds:[],
        resourceRefs:payload.resourceRefs!,unresolved:payload.unresolved!,policyChecks:{containsWholeSolution:false,writesStudentWork:false,runsCode:false,makesFormalEvaluation:false}}
      const bodyJsonText=JSON.stringify(body),messageId=randomUUID()
      const message:TutorHistoryReply={messageId,jobId:id,scope:question.scope,authorKind:'model',requestReceiptId:question.requestReceiptId,
        contentHash:payload.contentHash,resultHash:sha256Hex(bodyJsonText),envelope:{kind:'student_help',body,bodyJsonText,
          versions:question.envelope.versions,usage:{status:'unknown',reason:'synthetic_provider_not_called'},calls:0,elapsedMs:0,basis}}
      scene.actions.push({jobId:id,epoch:job.decisionEpoch,clients:new Map(),shown:false,payload,message,
        record:{actionId:payload.actionId,scope:question.scope,jobId:id,messageId,contentHash:payload.contentHash,
          disposition:'pending',targetVersions:question.envelope.versions,basis,generation:job.recoveryGeneration,
          basisRevised:false,createdAt:payload.createdAt,deliveries:[],receipts:[]}})
    }
  }
  if (head.attempt.decisionEpoch !== job.decisionEpoch && !job.stopRequested) job.status = 'stale'
  return structuredClone({ ...job, kind: 'tutoring', requestReceiptId: scene.questions.find(q=>q.jobId===id)!.requestReceiptId!,
    expectedRevision:scene.bases.get(id)!.attemptRevision, attemptCount: 0 })
}
export function cancelPrepHelp(scenario: string, session: PrepSession, id: string, value: unknown, key: unknown) {
  const scene = sceneOf(scenario), job = scene.jobs.find(j => j.jobId === id)
  if (!job) reject('FORBIDDEN')
  const body = object(value, ['recoveryGeneration','reason'])
  return prepTeachingCommand(scenario, session, job.scope.attemptId!, 'job.cancel', `/api/jobs/${id}/cancel`, body, key, () => {
    job.stopRequested = true
    if (['queued','running','cancelling'].includes(job.status)) job.status = 'cancelled'
    const invalidatedActionIds: string[] = []
    for (const action of scene.actions) if (action.jobId === id && !action.shown) { action.payload.disposition = 'cancelled'; invalidatedActionIds.push(action.payload.actionId) }
    return { jobId: id, status: job.status, stopRequested: true, invalidatedActionIds }
  }, { jobId:id, reason:body.reason??'explicit_job_cancel' })
}
export function readPrepTutorEvents(scenario: string, session: PrepSession, attemptId: string, query: URLSearchParams): TutorPage {
  const scene = sceneOf(scenario), head = readPrepAttempt(scenario, session, attemptId), a = head.attempt
  const cursor = Number(query.get('afterServerSeq') ?? 0), limit = Number(query.get('limit') ?? 100), clientId = query.get('clientId')
  if (!Number.isSafeInteger(cursor) || cursor < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) reject('INVALID_REQUEST')
  const control = { attemptRevision: a.attemptRevision, decisionEpoch: a.decisionEpoch, captureRevision: a.captureRevision,
    collecting: a.collecting, reminders: a.reminders, status: a.status, generation: recoveryGenerationOf(scenario) }
  if (!clientId || query.get('recoveryGeneration') !== control.generation || Number(query.get('decisionEpoch')) !== a.decisionEpoch)
    return { control, resyncRequired: true, events: [], nextServerSeq: cursor, hasMore: false }
  const candidates = scene.actions.filter(action => action.epoch === a.decisionEpoch && action.payload.disposition === 'pending')
  for (const action of candidates) if (!action.shown && !action.clients.has(clientId)) {
    const deliveryId=randomUUID(),seq=++scene.seq
    action.clients.set(clientId,{deliveryId,seq})
    action.record.deliveries.push({deliveryId,actionId:action.payload.actionId,recipientId:session.userId,clientId,
      contentHash:action.payload.contentHash,recoveryGeneration:control.generation,serverSeq:seq,attemptedAt:new Date().toISOString(),
      eventId:deliveryId,control:{attemptRevision:a.attemptRevision,decisionEpoch:a.decisionEpoch,captureRevision:a.captureRevision}})
  }
  const rows = scene.actions.flatMap(action => {
    const delivery = action.clients.get(clientId)
    if (!delivery || delivery.seq <= cursor) return []
    const eligible = candidates.includes(action) && ['ready','active'].includes(a.status)
    return [{ serverSeq: delivery.seq, eventId: delivery.deliveryId, type: 'teaching.delivery', occurredAt: action.payload.createdAt,
      ...(eligible ? { payload: { ...action.payload, deliveryId: delivery.deliveryId } } : {}) }]
  }).sort((a,b)=>a.serverSeq-b.serverSeq)
  const events = rows.slice(0,limit)
  return { control, resyncRequired: false, events, nextServerSeq: events.at(-1)?.serverSeq ?? cursor, hasMore: rows.length > limit,
    coverage:recordPrepTutorCoverage(scenario,session,attemptId) }
}
export function recordPrepTutorReceipt(scenario: string, session: PrepSession, id: string, value: unknown, key: unknown) {
  const body = object(value, ['recoveryGeneration','clientId','contentHash','receiptKind','clientReceiptId','deliveryId','clientDeclaredAt','versions'])
  const scene = sceneOf(scenario), action = scene.actions.find(a => a.payload.actionId === id)
  const job = scene.jobs.find(j=>j.jobId===action?.jobId)
  if (!action || !job) reject('FORBIDDEN')
  readPrepAttempt(scenario, session, job.scope.attemptId!)
  if (body.recoveryGeneration !== recoveryGenerationOf(scenario)) reject('RECOVERY_REQUIRED')
  const clientId = String(body.clientId), delivery = action.clients.get(clientId)
  if (!delivery || delivery.deliveryId !== body.deliveryId || body.contentHash !== action.payload.contentHash
    || !['received','displayed','acknowledged'].includes(String(body.receiptKind)) || typeof body.clientReceiptId !== 'string' || typeof key !== 'string') reject('INVALID_REFERENCE')
  const wire = JSON.stringify(body), previous = scene.receipts.find(r=>r.key===key)
  if (previous) { if (previous.wire !== wire) reject('IDEMPOTENCY_CONFLICT'); return { ...(previous.result as object), replayed: true } }
  const result = { receiptId: randomUUID(), actionId: id, receiptKind: body.receiptKind, serverSeq: ++scene.seq, replayed: false,
    ...(action.payload.disposition !== 'pending' ? { raceReason: 'synthetic_late_receipt' } : {}) }
  scene.receipts.push({ actionId: id, kind: String(body.receiptKind), clientId, key, wire, result })
  action.record.receipts.push({receiptId:result.receiptId,actionId:id,deliveryId:delivery.deliveryId,clientId,
    contentHash:action.payload.contentHash,receiptKind:body.receiptKind as 'received'|'displayed'|'acknowledged',
    clientReceiptId:body.clientReceiptId as string,serverSeq:result.serverSeq,serverReceivedAt:new Date().toISOString(),
    versions:action.record.targetVersions,...(body.clientDeclaredAt?{clientDeclaredAt:body.clientDeclaredAt as string}:{}),
    ...(result.raceReason?{raceReason:result.raceReason}:{})})
  if (['displayed','acknowledged'].includes(String(body.receiptKind))) action.shown = true
  return result
}

/** Existing student projection; no Delivery allocation, Job processing, control or cutoff envelope. */
export function readPrepTutorHistory(scenario:string,session:PrepSession,attemptId:string) {
  readPrepAttempt(scenario,session,attemptId)
  const scene=sceneOf(scenario),shown=scene.actions.filter(a=>a.record.scope.attemptId===attemptId
    &&a.record.receipts.some(r=>r.receiptKind==='displayed'||r.receiptKind==='acknowledged'))
  return structuredClone({messages:[...scene.questions.filter(q=>q.scope.attemptId===attemptId),...shown.map(a=>a.message)]
    .sort((a,b)=>a.messageId.localeCompare(b.messageId)),actions:shown.map(a=>({...a.record,
      disposition:a.payload.disposition,basisRevised:a.payload.basisRevised})).sort((a,b)=>a.actionId.localeCompare(b.actionId))})
}
