import {z} from 'zod';
import {RunnerError} from '../../runner/snapshot.ts';
import {onlyFields} from '../records/commands.ts';
import {validateRunResult} from '../records/runner.ts';
import {activate,validateText} from './files.ts';
import {ApiError} from '../app/errors.ts';
import {readAttempt,saveAttempt} from '../db/records-adapter.ts';
import {artifactSubmissionSchema,domainReopenGrant,domainSubmissionRecord,reopenGrantSchema} from './inputs.ts';
import type {Transaction} from '../db/transaction.ts';
import type {Purpose} from '../../contracts/records/index.ts';
import type {SubmitRun} from '../../contracts/runner/index.ts';
import type {ArtifactSnapshot,Attempt,ReopenGrant,ReopenView,Submission,SubmissionCheckRef} from '../../contracts/workspace/index.ts';

export type SubmissionRequest={expectedAttemptRevision:number;snapshotId:string;reflection?:string;checkRunIds:string[]};
// The narrow slice C4's pure plans read. A full WorkspaceState satisfies it structurally, so the plans stay
// testable without records, files or an HTTP request.
export type SubmissionBasis={attempt:Attempt;snapshots:ArtifactSnapshot[];submissions:Submission[];grants:ReopenGrant[];
  runs:{runId:string;jobId:string;submission:SubmitRun;result?:unknown;resultHash?:string}[];
  checks:{jobId:string;runId:string;policyVersion:string;state:'active'|'ended'}[]};
export type SubmissionContext={assignmentActive:boolean;now:string;generation:string;receiptId:string};
// A submission and a reopen both invalidate the teaching purposes that depend on a workable attempt. Ordinary runs
// are deliberately not cancelled: a new run is already refused once the stage leaves ready/active, and an in-flight
// run keeps its own facts and original references (task record §6).
const revisionCancelPurposes:Purpose[]=['student_help','reminder','explicit_analysis','passive_analysis'];
const reflectionLimit=4096,checkRefLimit=16,verdictLimit=64;

function persisted<Schema extends z.ZodType>(schema:Schema,json:string):z.output<Schema> {
  const result=schema.safeParse(JSON.parse(json));
  if(!result.success)throw new Error('Invalid persisted workspace record.');
  return result.data;
}
// Storage loads submissions ordered by the owning receipt's server sequence, so the last entry is the latest
// fixed submission. Nothing here re-derives that order from a client-supplied value.
export function latestSubmission(basis:{submissions:Submission[]}):Submission|undefined {
  return basis.submissions[basis.submissions.length-1];
}
/**
 * The one grant `planResumeRevision` would accept right now, or undefined. Both the consuming command and the
 * recovery projection go through this, so the view can never offer a permission the command would then refuse.
 */
function currentGrant(basis:{attempt:Attempt;submissions:Submission[];grants:ReopenGrant[]}):ReopenGrant|undefined {
  if(basis.attempt.status!=='reviewed')return undefined;
  const latest=latestSubmission(basis);
  if(!latest)return undefined;
  return basis.grants.find(row=>row.state==='valid'&&row.attemptId===basis.attempt.attemptId
    &&row.submissionId===latest.submissionId&&row.attemptRevision===basis.attempt.attemptRevision);
}
/**
 * The reopen state a resuming client acts on. It reports the most recently *saved* grant as its own persisted fact
 * and separately says whether the student can consume it. Superseding always inserts, so the last row is the one the
 * teacher's latest decision produced; reporting an older settled row instead would point the student at a grant the
 * teacher has already replaced, and collapsing a still-`valid` row into `none` would hide a real persisted fact —
 * an assignment pause alone produces exactly that row, so it is an ordinary chain rather than a corner case.
 */
export function reopenView(basis:{attempt:Attempt;submissions:Submission[];grants:ReopenGrant[]}):ReopenView {
  const newest=basis.grants[basis.grants.length-1];
  if(!newest)return {state:'none',actionable:false};
  const actionable=currentGrant(basis);
  return {state:newest.state,actionable:actionable?.grantId===newest.grantId,
    grantId:newest.grantId,submissionId:newest.submissionId,reason:newest.reason,grantedAt:newest.grantedAt,
    ...(newest.consumedAt===undefined?{}:{consumedAt:newest.consumedAt})};
}

function matchCheckRefs(basis:SubmissionBasis,snapshot:ArtifactSnapshot,checkRunIds:string[]) {
  if(!Array.isArray(checkRunIds)||checkRunIds.length>checkRefLimit)throw new RunnerError('INVALID_REQUEST','Bounded trusted check references required');
  const seen=new Set<string>(),refs:SubmissionCheckRef[]=[];
  for(const runId of checkRunIds) {
    if(typeof runId!=='string'||!runId||seen.has(runId))throw new RunnerError('INVALID_REQUEST','Distinct trusted check references required');
    seen.add(runId);
    const run=basis.runs.find(row=>row.runId===runId);
    // A matching reference is a real course check of this attempt bound to the submitted snapshot. Its verdict is
    // recorded exactly as the run fact states it: a failed or incomplete check still submits, because correctness
    // is the teacher's judgement and never a submission gate.
    if(!run||run.submission.mode!=='check'||run.submission.identity.authorizedScope.attemptId!==basis.attempt.attemptId
      ||run.submission.identity.snapshotId!==snapshot.snapshotId)throw new RunnerError('INVALID_REFERENCE','Trusted check reference does not match the submitted snapshot');
    const ref:SubmissionCheckRef={runId,snapshotId:snapshot.snapshotId};
    if(run.resultHash&&run.result!==undefined){
      ref.resultHash=run.resultHash;
      const verdict=validateRunResult(run.submission,run.result).record.verdict;
      if(typeof verdict==='string'&&verdict&&verdict.length<=verdictLimit)ref.verdict=verdict;
    }
    refs.push(ref);
  }
  return refs;
}

/**
 * The pure submission plan: it fixes one already confirmed snapshot, moves the attempt to `submitted` and ends the
 * limited-help check phase. The caller owns the receipt, the teaching stop and persistence, so a failure anywhere
 * in that transaction leaves no partial submission behind.
 */
export function planSubmission(basis:SubmissionBasis,request:SubmissionRequest,ids:{submissionId:string},context:SubmissionContext) {
  onlyFields(request,['expectedAttemptRevision','snapshotId','reflection','checkRunIds']);
  if(!ids.submissionId)throw new RunnerError('INVALID_REQUEST','Trusted new submission reference required');
  if(!Number.isFinite(Date.parse(context.now))||!context.generation||!context.receiptId)throw new RunnerError('INVALID_REQUEST','Trusted time, generation and receipt required');
  if(basis.submissions.some(row=>row.submissionId===ids.submissionId))throw new RunnerError('IDEMPOTENCY_CONFLICT','Original submission ID must be unique');
  if(!context.assignmentActive)throw new RunnerError('STATE_CONFLICT','Assignment pause cannot be overridden');
  if(basis.attempt.attemptRevision!==request.expectedAttemptRevision)throw new RunnerError('VERSION_CONFLICT','Attempt version conflict');
  if(!['ready','active'].includes(basis.attempt.status))throw new RunnerError('STATE_CONFLICT','Submitted and reviewed artifacts are read-only');
  if(request.reflection!==undefined){
    validateText(request.reflection);
    if(request.reflection.length>reflectionLimit)throw new RunnerError('CONTENT_LIMIT','Short reflection limit exceeded');
  }
  const snapshot=basis.snapshots.find(row=>row.snapshotId===request.snapshotId&&row.attemptId===basis.attempt.attemptId
    &&row.activityVersionId===basis.attempt.activityVersionId);
  if(!snapshot)throw new RunnerError('INVALID_REFERENCE','Confirmed snapshot unavailable');
  const checkRefs=matchCheckRefs(basis,snapshot,request.checkRunIds);
  const activated=activate(basis.attempt);
  const attempt:Attempt={...activated,status:'submitted',decisionEpoch:activated.decisionEpoch+1,
    attemptRevision:activated.attemptRevision===basis.attempt.attemptRevision?activated.attemptRevision+1:activated.attemptRevision};
  const submission:Submission={submissionId:ids.submissionId,attemptId:basis.attempt.attemptId,courseId:basis.attempt.courseId,
    studentId:basis.attempt.studentId,assignmentId:basis.attempt.assignmentId,activityVersionId:basis.attempt.activityVersionId,
    snapshotId:snapshot.snapshotId,snapshotHash:snapshot.hash,workspaceRevision:snapshot.workspaceRevision,
    // The recorded revisions are the ones the student's expectedAttemptRevision named, so the accepted CAS stays
    // auditable after the attempt itself has moved on.
    attemptRevision:basis.attempt.attemptRevision,decisionEpoch:basis.attempt.decisionEpoch,
    recoveryGeneration:context.generation,receiptId:context.receiptId,submittedAt:context.now,checkRefs,
    ...(request.reflection===undefined?{}:{reflection:request.reflection})};
  // Ending the check phase here is monotonic: reconciliation ends it too and a persisted `ended` stage never
  // returns to `active`. Leaving it active would keep tutoring disabled after the student reopens for revision.
  const checks=basis.checks.map(check=>check.state==='active'?{...check,state:'ended' as const}:check);
  return {attempt,submission,checks,cancelPurposes:revisionCancelPurposes};
}

/**
 * The pure reopen plan. The student's own explicit command consumes a currently valid teacher grant on the latest
 * submission; a missing, consumed, superseded, stale or older-submission grant is refused and the system never
 * continues revising on the student's behalf.
 */
export function planResumeRevision(basis:SubmissionBasis,expectedRevision:number,
  context:{assignmentActive:boolean;now:string;receiptId:string}) {
  if(!Number.isFinite(Date.parse(context.now))||!context.receiptId)throw new RunnerError('INVALID_REQUEST','Trusted time and receipt required');
  if(!context.assignmentActive)throw new RunnerError('STATE_CONFLICT','Assignment pause cannot be overridden');
  if(basis.attempt.attemptRevision!==expectedRevision)throw new RunnerError('VERSION_CONFLICT','Attempt version conflict');
  if(basis.attempt.status!=='reviewed')throw new RunnerError('STATE_CONFLICT','Only a reviewed attempt resumes revision');
  if(!latestSubmission(basis))throw new RunnerError('STATE_CONFLICT','No fixed submission to revise');
  // The same predicate the recovery projection reports through, so a view claiming `actionable` is a view this
  // command will actually accept.
  const grant=currentGrant(basis);
  if(!grant)throw new RunnerError('STATE_CONFLICT','Current teacher reopen permission required');
  const attempt:Attempt={...structuredClone(basis.attempt),status:'active',
    attemptRevision:basis.attempt.attemptRevision+1,decisionEpoch:basis.attempt.decisionEpoch+1};
  const consumed:ReopenGrant={...grant,state:'consumed',consumedReceiptId:context.receiptId,consumedAt:context.now};
  return {attempt,grant:consumed,cancelPurposes:revisionCancelPurposes};
}

// The immutable ownership slice both readers cross-check persisted rows against. Callers pass the attempt they
// already read, so loading a workspace reads and validates that row once instead of three times.
export type SubmissionOwner={courseId:string;studentId:string;assignmentId:string;activityVersionId:string};
export function readSubmissions(tx:Transaction,attemptId:string,owner:SubmissionOwner):Submission[] {
  return tx.all('SELECT * FROM workspace_submissions WHERE attempt_id=? ORDER BY server_seq,submission_id',attemptId).map(row=>{
    const submission=domainSubmissionRecord(persisted(artifactSubmissionSchema,String(row.submission_json)));
    if(submission.submissionId!==row.submission_id||submission.attemptId!==attemptId||submission.courseId!==row.course_id
      ||submission.studentId!==row.student_id||submission.snapshotId!==row.snapshot_id
      ||submission.workspaceRevision!==row.workspace_revision||submission.attemptRevision!==row.attempt_revision
      ||submission.receiptId!==row.receipt_id||submission.recoveryGeneration!==row.recovery_generation
      ||Date.parse(submission.submittedAt)!==row.submitted_at_ms)throw new Error('Invalid persisted submission scope.');
    // A submission stays fixed to the attempt it was made from, so the immutable ownership references must still
    // agree with the attempt row rather than with whatever the request claimed.
    if(submission.studentId!==owner.studentId||submission.courseId!==owner.courseId
      ||submission.assignmentId!==owner.assignmentId||submission.activityVersionId!==owner.activityVersionId)throw new Error('Invalid persisted submission scope.');
    return submission;
  });
}
export function readGrants(tx:Transaction,attemptId:string,owner:SubmissionOwner):ReopenGrant[] {
  // Insertion order, not the granted-at timestamp: the fixture clock can be frozen, and "the most recent grant"
  // must stay unambiguous for the supersede/consume history the recovery view reports.
  return tx.all('SELECT * FROM workspace_reopen_grants WHERE attempt_id=? ORDER BY rowid',attemptId).map(row=>{
    const grant=domainReopenGrant(persisted(reopenGrantSchema,String(row.grant_json)));
    const consumedAt=grant.consumedAt===undefined?null:Date.parse(grant.consumedAt);
    if(grant.grantId!==row.grant_id||grant.attemptId!==attemptId||grant.submissionId!==row.submission_id
      ||grant.state!==row.state||grant.attemptRevision!==row.attempt_revision||grant.grantedBy!==row.granted_by
      ||grant.reason!==row.reason||grant.receiptId!==row.receipt_id||Date.parse(grant.grantedAt)!==row.granted_at_ms
      ||(grant.consumedReceiptId??null)!==row.consumed_receipt_id||consumedAt!==(row.consumed_at_ms??null))throw new Error('Invalid persisted reopen grant.');
    if(grant.courseId!==owner.courseId||grant.studentId!==owner.studentId)throw new Error('Invalid persisted reopen grant scope.');
    if((grant.state==='consumed')!==(grant.consumedReceiptId!==undefined))throw new Error('Invalid persisted reopen grant state.');
    return grant;
  });
}

/**
 * C4 seams for A5's teacher routes, the `transitionAttempt/grantReopen` pair TECH §7.2.1 assigns to C. Both run
 * synchronously inside the caller's authorized transaction and roll it back on any guard failure.
 *
 * A grant row names the command receipt that authorized it, so it cannot be written until that receipt exists.
 * `planReopenGrant` therefore only guards and computes, and `writeReopenGrant` persists: A5 plans inside
 * `finishRecordCommand`'s work callback and writes from its `afterCommit`, the same split C3 uses for a teaching
 * question and job. `grantReopenInTransaction` is the combined form for a caller whose receipt already exists.
 */
export function transitionAttemptInTransaction(tx:Transaction,input:{attemptId:string;courseId:string;
  expectedAttemptRevision:number;to:'reviewed'}) {
  const attempt=readAttempt(tx,input.attemptId);
  if(attempt.courseId!==input.courseId)throw new ApiError('FORBIDDEN');
  if(attempt.attemptRevision!==input.expectedAttemptRevision)throw new ApiError('VERSION_CONFLICT');
  // Formal feedback owns the submitted→reviewed move; reviewing a claim alone never changes the learning stage.
  if(input.to!=='reviewed'||attempt.status!=='submitted')throw new ApiError('STATE_CONFLICT');
  const next:Attempt={...attempt,status:'reviewed',attemptRevision:attempt.attemptRevision+1,decisionEpoch:attempt.decisionEpoch+1};
  saveAttempt(tx,next);
  return {attemptId:next.attemptId,status:'reviewed' as const,attemptRevision:next.attemptRevision,decisionEpoch:next.decisionEpoch};
}
export function planReopenGrant(tx:Transaction,input:{attemptId:string;courseId:string;grantedBy:string;
  expectedAttemptRevision:number;submissionId:string;reason:string;grantId:string;now:string}) {
  const attempt=readAttempt(tx,input.attemptId);
  if(attempt.courseId!==input.courseId||attempt.studentId===input.grantedBy)throw new ApiError('FORBIDDEN');
  if(!input.grantId||!input.submissionId||!Number.isFinite(Date.parse(input.now)))throw new ApiError('INVALID_REQUEST');
  if(typeof input.reason!=='string'||!input.reason||input.reason.length>reflectionLimit)throw new ApiError('INVALID_REQUEST');
  if(attempt.attemptRevision!==input.expectedAttemptRevision)throw new ApiError('VERSION_CONFLICT');
  // Saving the permission keeps the artifact read-only: the attempt stays `reviewed` and only the student's own
  // resume_revision later consumes the grant.
  if(attempt.status!=='reviewed')throw new ApiError('STATE_CONFLICT');
  const latest=latestSubmission({submissions:readSubmissions(tx,input.attemptId,attempt)});
  if(!latest||latest.submissionId!==input.submissionId)throw new ApiError('INVALID_REFERENCE');
  if(tx.get('SELECT grant_id FROM workspace_reopen_grants WHERE grant_id=?',input.grantId))throw new ApiError('IDEMPOTENCY_CONFLICT');
  // A newer permission supersedes the older one on the same submission; superseding is a state change, never a
  // deletion, so the record of what the teacher granted and when survives.
  const superseded=readGrants(tx,input.attemptId,attempt).filter(row=>row.state==='valid');
  // The epoch advances with the permission, as it does for submission, review and resume_revision, so a page
  // holding the pre-grant state is told to re-synchronize instead of only finding out when its own resume_revision
  // fails the CAS. Nothing can be in flight to invalidate: reaching `reviewed` already advanced the epoch, and a
  // new student_help job is refused at that stage.
  const next:Attempt={...attempt,attemptRevision:attempt.attemptRevision+1,decisionEpoch:attempt.decisionEpoch+1};
  const grant:ReopenGrant={grantId:input.grantId,attemptId:attempt.attemptId,courseId:attempt.courseId,
    studentId:attempt.studentId,submissionId:latest.submissionId,attemptRevision:next.attemptRevision,state:'valid',
    reason:input.reason,grantedBy:input.grantedBy,grantedAt:input.now,receiptId:''};
  return {attempt:next,grant,superseded};
}
export function writeReopenGrant(tx:Transaction,plan:ReturnType<typeof planReopenGrant>,receiptId:string) {
  if(!receiptId)throw new ApiError('INVALID_REQUEST');
  const grant:ReopenGrant={...plan.grant,receiptId};
  for(const stale of plan.superseded)
    tx.run("UPDATE workspace_reopen_grants SET state='superseded',grant_json=? WHERE grant_id=? AND state='valid'",
      JSON.stringify({...stale,state:'superseded'}),stale.grantId);
  saveAttempt(tx,plan.attempt);
  tx.run(`INSERT INTO workspace_reopen_grants(grant_id,attempt_id,submission_id,state,attempt_revision,granted_by,reason,granted_at_ms,receipt_id,grant_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)`,grant.grantId,grant.attemptId,grant.submissionId,grant.state,grant.attemptRevision,
    grant.grantedBy,grant.reason,Date.parse(grant.grantedAt),grant.receiptId,JSON.stringify(grant));
  const saved=readGrants(tx,grant.attemptId,plan.attempt).find(row=>row.grantId===grant.grantId);
  if(!saved||JSON.stringify(saved)!==JSON.stringify(grant))throw new ApiError('PERSISTENCE_UNAVAILABLE');
  return {grantId:grant.grantId,submissionId:grant.submissionId,attemptRevision:plan.attempt.attemptRevision,
    status:'reviewed' as const,supersededGrantIds:plan.superseded.map(row=>row.grantId)};
}
export function grantReopenInTransaction(tx:Transaction,input:Parameters<typeof planReopenGrant>[1]&{receiptId:string}) {
  const {receiptId,...plan} = input;
  return writeReopenGrant(tx,planReopenGrant(tx,plan),receiptId);
}
