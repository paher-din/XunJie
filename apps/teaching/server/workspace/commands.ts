import {RunnerError} from '../../runner/snapshot.ts';
import {finishCommand,requestHash,resolveCommandReceipt,onlyFields,sameScope} from '../records/commands.ts';
import {activate,syncFiles} from './files.ts';
import {freezeSnapshot,beginExplicitOperation,validateObjectRef} from './snapshots.ts';
import {controlAttempt} from './controls.ts';
import type {Control} from './controls.ts';
import {latestSubmission,planResumeRevision,planSubmission,reopenView} from './submissions.ts';
import type {SubmissionRequest} from './submissions.ts';
import {cancelByPurpose,cancelJob,claimJob,enqueueJob,confirmRunStopped} from '../records/jobs.ts';
import {compilerArgs,sha256,validateSnapshot} from '../../runner/snapshot.ts';
import {textScopeArgs} from '../../runner/run-snapshot.ts';
import {validateRunFact,validateRunResult} from '../records/runner.ts';
import {ApiError} from '../app/errors.ts';
import type {Records,CommandIdentity,Job,Purpose,TeachingActionRecord,TeachingCoverage,TeachingMessage,
  TeachingStopContext,TeachingStopResult} from '../../contracts/records/index.ts';
import type {FastifyRequest} from 'fastify';
import type {Transaction} from '../db/transaction.ts';
import type {SubmitRun,Profile,TextScopeInput} from '../../contracts/runner/index.ts';
import type {Attempt,ArtifactSnapshot,AttemptRecovery,ProjectFile,RecoveryFeedback,RecoveryRunOutcome,ReopenGrant,
  Submission,SyncBatch} from '../../contracts/workspace/index.ts';

export type WorkspaceState = {attempt:Attempt;files:ProjectFile[];snapshots:ArtifactSnapshot[];records:Records;
  checks:{jobId:string;runId:string;policyVersion:string;state:'active'|'ended'}[];
  runs:{runId:string;jobId:string;submission:SubmitRun;result?:unknown;resultHash?:string}[];
  // C4: fixed submissions in ascending commit order and the reopen grants saved against them. Both are append-only
  // history; neither is rewritten by a later submission, review or reopen.
  submissions:Submission[];grants:ReopenGrant[]};
export type CommandContext = {identity:CommandIdentity;generation:string;now:string;commandId:string;receiptId:string;eventId:string;
  assignmentActive:boolean;authorize:()=>boolean;transaction?:Transaction;stopReason?:string;runPurposes?:Purpose[]};
// C3 seam: A's design/control paths and C's own control/cancel paths call the same synchronous stop capability
// inside their current transaction. A missing handler never pretends the action invalidation happened.
export type TeachingStopHandler = (tx:Transaction,courseId:string,studentId:string,jobIds:string[],
  context:TeachingStopContext)=>TeachingStopResult;
export type TeachingWorkspaceExtensions = {
  acceptStudentQuestion(request:FastifyRequest,attemptId:string,input:unknown):{messageId:string;jobId:string;contentHash:string;stoppedJobIds:string[]};
  completeTeaching(attemptId:string,input:unknown):{messageId:string;actionId:string;disposition:'pending'|'cancelled'|'stale'|'failed';replayed:boolean;contentHash:string};
  readTeachingRecords(attemptId:string):{messages:TeachingMessage[];actions:TeachingActionRecord[]};
  readCoverage(attemptId:string):TeachingCoverage;
};
export function guardCommand(state:WorkspaceState,context:CommandContext) {
  if(context.authorize()!==true||context.identity.actorId!==state.attempt.studentId
    ||context.identity.scope.courseId!==state.attempt.courseId||context.identity.scope.studentId!==state.attempt.studentId
    ||context.identity.scope.attemptId!==state.attempt.attemptId)throw new RunnerError('FORBIDDEN','Authorized student command required');
}
export function completeCommand(state:WorkspaceState,context:CommandContext,hash:string,result:unknown,type:string) {
  // A dependent record (a teaching stop) may already hold the next audit slot, so the command event is
  // planned from the current server sequence rather than the pre-command snapshot.
  const sequence=Number(context.transaction?.get('SELECT COALESCE(MAX(server_seq),0) AS seq FROM audit_events')?.seq??0);
  const planned=sequence>0?{...state.records,serverSeq:sequence}:state.records;
  const finished=finishCommand(planned,{receiptId:context.receiptId,commandId:context.commandId,identity:context.identity,
    requestHash:hash,result,committedAt:context.now},{eventId:context.eventId,scope:context.identity.scope,type,
    occurredAt:context.now,source:'student_command',payloadRef:context.receiptId},context.generation);
  return {state:{...state,records:finished.records},receipt:finished.receipt,replayed:finished.replayed};
}
export function syncCommand(state:WorkspaceState,context:CommandContext,batch:SyncBatch,ids:Record<string,string>) {
  guardCommand(state,context);
  if(!context.identity.sync||context.identity.sync.clientId!==batch.clientId||context.identity.sync.clientSeq!==batch.clientSeq)throw new RunnerError('INVALID_REQUEST','Sync identifiers must use the command receipt');
  const hash=requestHash(context.identity.target,batch);
  const previous=resolveCommandReceipt(state.records,context.identity,hash,context.generation);
  if(previous)return completeCommand(state,context,hash,previous.result,'workspace_confirmed');
  const plan=syncFiles(state.attempt,state.files,batch,context.assignmentActive,ids);
  return completeCommand({...state,attempt:plan.attempt,files:plan.files},context,hash,{workspaceRevision:plan.attempt.workspaceRevision,
    files:plan.files.map(({fileId,path,documentVersion,contentHash,lifecycle})=>({fileId,path,documentVersion,contentHash,lifecycle})),
    created:plan.created,process:plan.process},'workspace_confirmed');
}
export function snapshotCommand(state:WorkspaceState,context:CommandContext,expectedWorkspaceRevision:number,snapshotId:string) {
  guardCommand(state,context);
  const hash=requestHash(context.identity.target,{expectedWorkspaceRevision});
  const previous=resolveCommandReceipt(state.records,context.identity,hash,context.generation);
  if(previous)return completeCommand(state,context,hash,previous.result,'snapshot_confirmed');
  if(!['ready','active','paused'].includes(state.attempt.status))throw new RunnerError('STATE_CONFLICT','Attempt snapshots are read-only');
  if(state.snapshots.some(row=>row.snapshotId===snapshotId))throw new RunnerError('IDEMPOTENCY_CONFLICT','Snapshot ID already exists');
  const snapshot=freezeSnapshot(state.attempt,state.files,expectedWorkspaceRevision,snapshotId,context.now);
  const attempt=context.assignmentActive?activate(state.attempt):state.attempt;
  return completeCommand({...state,attempt,snapshots:[...state.snapshots,snapshot]},context,hash,{snapshotId:snapshot.snapshotId,
    snapshotHash:snapshot.hash,workspaceRevision:snapshot.workspaceRevision},'snapshot_confirmed');
}

// C4: the student's fixed submission. The receipt, the stage change and the invalidation of the teaching purposes
// that depended on a workable attempt are one plan, so the caller persists them in a single short transaction.
// A replay returns the original submission and receipt; a differing digest conflicts in `resolveCommandReceipt`.
export function submitCommand(state:WorkspaceState,context:CommandContext,request:SubmissionRequest,
  ids:{submissionId:string},teachingStop?:TeachingStopHandler) {
  guardCommand(state,context);
  const hash=requestHash(context.identity.target,request);
  const previous=resolveCommandReceipt(state.records,context.identity,hash,context.generation);
  if(previous)return completeCommand(state,context,hash,previous.result,'submission_confirmed');
  const plan=planSubmission(state,request,ids,{assignmentActive:context.assignmentActive,now:context.now,
    generation:context.generation,receiptId:context.receiptId});
  const stopped=stopJobs(state,context,plan.cancelPurposes,context.stopReason??'submission_confirmed',teachingStop);
  return completeCommand({...state,attempt:plan.attempt,checks:plan.checks,
    submissions:[...state.submissions,plan.submission],records:{...state.records,jobs:stopped.jobs}},context,hash,
    {submissionId:plan.submission.submissionId,snapshotId:plan.submission.snapshotId,snapshotHash:plan.submission.snapshotHash,
      workspaceRevision:plan.submission.workspaceRevision,attemptRevision:plan.attempt.attemptRevision,
      decisionEpoch:plan.attempt.decisionEpoch,status:plan.attempt.status,checkRefs:plan.submission.checkRefs,
      cancelledJobIds:stopped.jobIds},'submission_confirmed');
}

export function controlCommand(state:WorkspaceState,context:CommandContext,expectedRevision:number,control:Control,
  resources:{resourceVersionId:string;paragraphId:string}[]=[],teachingStop?:TeachingStopHandler) {
  guardCommand(state,context);const hash=requestHash(context.identity.target,{expectedRevision,control});
  const previous=resolveCommandReceipt(state.records,context.identity,hash,context.generation);
  if(previous)return completeCommand(state,context,hash,previous.result,'attempt_controlled');
  // C4: reopening for revision is the student's own explicit consumption of a current teacher grant, so it is
  // guarded by the submission domain instead of the lifecycle flags. It never rewrites the fixed submission.
  if(control.kind==='resume_revision') {
    const plan=planResumeRevision(state,expectedRevision,{assignmentActive:context.assignmentActive,now:context.now,receiptId:context.receiptId});
    const stopped=stopJobs(state,context,plan.cancelPurposes,context.stopReason??'attempt_control_resume_revision',teachingStop);
    return completeCommand({...state,attempt:plan.attempt,grants:state.grants.map(row=>row.grantId===plan.grant.grantId?plan.grant:row),
      records:{...state.records,jobs:stopped.jobs}},context,hash,
      {attemptRevision:plan.attempt.attemptRevision,decisionEpoch:plan.attempt.decisionEpoch,captureRevision:plan.attempt.captureRevision,
        status:plan.attempt.status,grantId:plan.grant.grantId,submissionId:plan.grant.submissionId,
        cancelledJobIds:stopped.jobIds,captureChanged:false},'attempt_controlled');
  }
  if(control.kind==='position'&&control.returnPosition)validateObjectRef(state.attempt,control.returnPosition,
    {snapshots:state.snapshots,runs:state.runs.map(row=>({runId:row.runId,snapshotId:row.submission.snapshot.snapshotId,attemptId:state.attempt.attemptId})),resources});
  const plan=controlAttempt(state.attempt,expectedRevision,control,context.assignmentActive);
  const stopped=stopJobs(state,context,plan.cancelPurposes,context.stopReason??'attempt_control',teachingStop);
  return completeCommand({...state,attempt:plan.attempt,records:{...state.records,jobs:stopped.jobs}},context,hash,
    {attemptRevision:plan.attempt.attemptRevision,decisionEpoch:plan.attempt.decisionEpoch,captureRevision:plan.attempt.captureRevision,
      cancelledJobIds:stopped.jobIds,captureChanged:plan.captureChanged},'attempt_controlled');
}
// One capability for capture/reminder/lifecycle stops and teaching cancellation. The caller's own receipt
// records the cause; the stop handler persists the intent and invalidates the related, not-yet-displayed actions.
function stopJobs(state:WorkspaceState,context:CommandContext,purposes:Purpose[],reason:string,teachingStop?:TeachingStopHandler) {
  const cancellation=cancelByPurpose(state.records.jobs,context.identity.scope,purposes);
  if(!cancellation.jobIds.length)return {jobs:cancellation.jobs,jobIds:[] as string[],actionIds:[] as string[]};
  // A teaching stop must also invalidate the action store, so it is refused without an attached
  // transaction instead of being reported as a completed cancellation. C2's ordinary stop stays an
  // in-memory plan for pure callers and is persisted by persistWorkspace.
  const transaction=context.transaction;
  if(!teachingStop||!transaction) {
    if(teachingStop)throw new ApiError('PERSISTENCE_UNAVAILABLE');
    return {jobs:cancellation.jobs,jobIds:cancellation.jobIds,actionIds:[] as string[]};
  }
  const stopped=teachingStop(transaction,state.attempt.courseId,state.attempt.studentId,cancellation.jobIds,
    {reason,causeRef:context.receiptId,generation:context.generation,now:context.now});
  return {jobs:cancellation.jobs,jobIds:cancellation.jobIds,actionIds:stopped.invalidatedActionIds};
}

export type RunRequest = {expectedAttemptRevision:number;snapshotId:string;runtimeProfileVersion:string;entryFileId:string;
  input:TextScopeInput;mode:'run'|'course_check'};
export type RuntimeConfiguration = {ready:boolean;recoveryGeneration:string;profile:Profile;policyVersion:string;
  checkRuleVersion:string;checkCancelPurposes:Purpose[]};
export function runCommand(state:WorkspaceState,context:CommandContext,request:RunRequest,runtime:RuntimeConfiguration,
  ids:{runId:string;jobId:string},deadline:string) {
  guardCommand(state,context);
  onlyFields(request,['expectedAttemptRevision','snapshotId','runtimeProfileVersion','entryFileId','input','mode']);
  onlyFields(request.input,['operation','fileIds','word','count','resultFile']);
  onlyFields(request.input,['operation','fileIds',...(request.input.operation==='find'?['word']:request.input.operation==='top'?['count']:request.input.operation==='report'?['resultFile']:[])]);
  const hash=requestHash(context.identity.target,request);
  const previous=resolveCommandReceipt(state.records,context.identity,hash,context.generation);
  if(previous)return completeCommand(state,context,hash,previous.result,'run_requested');
  if(!['run','course_check'].includes(request.mode)||!runtime.ready||request.runtimeProfileVersion!==runtime.profile.runtimeProfileVersion)throw new RunnerError('RUNTIME_NOT_READY','Confirmed runtime configuration unavailable');
  if(runtime.recoveryGeneration!==context.generation)throw new RunnerError('RECOVERY_REQUIRED','Runtime generation reconciliation required');
  if(state.runs.some(row=>row.runId===ids.runId)||!ids.runId)throw new RunnerError('IDEMPOTENCY_CONFLICT','Original run ID must be unique');
  const snapshot=state.snapshots.find(row=>row.snapshotId===request.snapshotId&&row.attemptId===state.attempt.attemptId&&row.activityVersionId===state.attempt.activityVersionId);
  if(!snapshot)throw new RunnerError('INVALID_REFERENCE','Confirmed snapshot unavailable');
  validateSnapshot(snapshot);compilerArgs(snapshot,request.entryFileId);
  const args=textScopeArgs(snapshot,request.input,runtime.profile.approvedResultFiles);
  let attempt=beginExplicitOperation(state.attempt,request.expectedAttemptRevision,context.assignmentActive);
  let jobs=state.records.jobs;
  const checks=structuredClone(state.checks);
  if(request.mode==='course_check') {
    if(!runtime.policyVersion||!runtime.checkRuleVersion||checks.some(check=>check.state==='active'))throw new RunnerError('STATE_CONFLICT','Check policy or prior check termination unavailable');
    attempt={...attempt,decisionEpoch:attempt.decisionEpoch+1,
      attemptRevision:attempt.attemptRevision===state.attempt.attemptRevision?attempt.attemptRevision+1:attempt.attemptRevision};
    jobs=cancelByPurpose(jobs,context.identity.scope,runtime.checkCancelPurposes).jobs;
    checks.push({jobId:ids.jobId,runId:ids.runId,policyVersion:runtime.policyVersion,state:'active'});
  }
  const submission:SubmitRun={identity:{runId:ids.runId,commandId:context.commandId,requestHash:hash,recoveryGeneration:context.generation,
    snapshotId:snapshot.snapshotId,snapshotHash:snapshot.hash,inputHash:sha256(JSON.stringify(args)),runtimeProfileVersion:runtime.profile.runtimeProfileVersion,
    imageDigest:runtime.profile.imageDigest,authorizedScope:{userId:context.identity.actorId,courseId:attempt.courseId,attemptId:attempt.attemptId,
      activityVersionId:attempt.activityVersionId,purpose:'student_run'}},snapshot:structuredClone(snapshot),entryFileId:request.entryFileId,
    input:structuredClone(request.input),mode:request.mode==='run'?'run':'check',...(request.mode==='course_check'?{checkRuleVersion:runtime.checkRuleVersion}:{})};
  const job:Job={jobId:ids.jobId,kind:request.mode,purpose:'student_run',scope:context.identity.scope,requestReceiptId:context.receiptId,
    status:'queued',stopRequested:false,expectedRevision:attempt.attemptRevision,decisionEpoch:attempt.decisionEpoch,recoveryGeneration:context.generation,
    acceptedAt:context.now,deadline,attemptCount:0,runId:ids.runId};
  const next={...state,attempt,checks,records:{...state.records,jobs:enqueueJob(jobs,job)},runs:[...state.runs,{runId:ids.runId,jobId:ids.jobId,submission}]};
  return completeCommand(next,context,hash,{runId:ids.runId,jobId:ids.jobId,snapshotId:snapshot.snapshotId},'run_requested');
}

export function cancelRunCommand(state:WorkspaceState,context:CommandContext,jobId:string) {
  guardCommand(state,context);const hash=requestHash(context.identity.target,{jobId});
  const previous=resolveCommandReceipt(state.records,context.identity,hash,context.generation);
  if(previous)return completeCommand(state,context,hash,previous.result,'job_stop_requested');
  const {job:original}=ownRun(state,jobId);
  const cancelled=cancelJob(original);
  return completeCommand({...state,records:{...state.records,jobs:state.records.jobs.map(row=>row.jobId===jobId?cancelled:row)}},context,hash,
    {jobId,status:cancelled.status,stopRequested:true},'job_stop_requested');
}
// C3: teaching jobs stop through the same persistent stop capability and invalidate their not-yet-displayed actions.
export function cancelTeachingJobCommand(state:WorkspaceState,context:CommandContext,jobId:string,teachingStop?:TeachingStopHandler) {
  guardCommand(state,context);const reason=context.stopReason??'explicit_job_cancel';
  const hash=requestHash(context.identity.target,{jobId,reason});
  const previous=resolveCommandReceipt(state.records,context.identity,hash,context.generation);
  if(previous)return completeCommand(state,context,hash,previous.result,'job_stop_requested');
  const jobs=state.records.jobs.filter(row=>row.jobId===jobId);
  if(jobs.length!==1)throw new RunnerError('INVALID_REFERENCE','Original job association unavailable');
  const original=jobs[0]!;
  if(!sameScope(original.scope,context.identity.scope))throw new RunnerError('FORBIDDEN','Original job scope mismatch');
  if(original.purpose==='student_run'||original.purpose==='teacher_sample')
    throw new RunnerError('STATE_CONFLICT','Ordinary runs stop through the original run unit');
  if(!teachingStop||!context.transaction)throw new ApiError('PERSISTENCE_UNAVAILABLE');
  const stopped=teachingStop(context.transaction,state.attempt.courseId,state.attempt.studentId,[jobId],
    {reason,causeRef:context.receiptId,generation:context.generation,now:context.now});
  const current=stopped.jobs.find(job=>job.jobId===jobId);
  if(!current)throw new ApiError('PERSISTENCE_UNAVAILABLE');
  const updated=state.records.jobs.map(job=>job.jobId===jobId?{...job,status:current.status,stopRequested:current.stopRequested}:job);
  return completeCommand({...state,records:{...state.records,jobs:updated}},context,hash,
    {jobId,status:current.status,stopRequested:current.stopRequested,invalidatedActionIds:stopped.invalidatedActionIds},'job_stop_requested');
}

function ownRun(state:WorkspaceState,jobId:string) {
  const jobs=state.records.jobs.filter(row=>row.jobId===jobId),runs=state.runs.filter(row=>row.jobId===jobId);
  const [job]=jobs,[run]=runs;
  if(jobs.length!==1||runs.length!==1||!job||!run)throw new RunnerError('INVALID_REFERENCE','Original run/job association unavailable');
  const scope=run.submission.identity.authorizedScope;
  if(job.purpose!=='student_run'||job.scope.attemptId!==state.attempt.attemptId||job.scope.courseId!==state.attempt.courseId
    ||job.scope.studentId!==state.attempt.studentId||scope.attemptId!==state.attempt.attemptId||scope.courseId!==state.attempt.courseId
    ||scope.userId!==state.attempt.studentId||run.runId!==job.runId||run.submission.identity.runId!==run.runId)throw new RunnerError('FORBIDDEN','Original run scope mismatch');
  return {job,run};
}

export function claimRun(state:WorkspaceState,jobId:string,token:string,until:string,generation:string,now:string) {
  const {job}=ownRun(state,jobId);
  const claimed=claimJob(job,token,until,generation,now);
  return {...state,records:{...state.records,jobs:state.records.jobs.map(row=>row.jobId===jobId?claimed:row)}};
}
export function claimRunReconciliation(state:WorkspaceState,jobId:string,token:string,until:string,generation:string,now:string) {
  const {job}=ownRun(state,jobId);
  if(job.recoveryGeneration!==generation)throw new RunnerError('RECOVERY_REQUIRED','Original reconciliation generation required');
  if(!['running','outcome_unknown','cancelling'].includes(job.status)||(!job.stopRequested&&job.leaseUntil&&Date.parse(job.leaseUntil)>Date.parse(now)))throw new RunnerError('STATE_CONFLICT','Original run is already leased or terminal');
  if(!token||!Number.isFinite(Date.parse(now))||!Number.isFinite(Date.parse(until))||Date.parse(until)<=Date.parse(now)
    ||Date.parse(until)>Date.parse(now)+150000)throw new RunnerError('INVALID_REQUEST','Bounded reconciliation lease required');
  const leased:Job={...job,leaseToken:token,leaseUntil:until,status:job.stopRequested?'cancelling':'outcome_unknown'};
  return {...state,records:{...state.records,jobs:state.records.jobs.map(row=>row.jobId===jobId?leased:row)}};
}
export function readWorkspace(state:WorkspaceState,authorize:()=>boolean,assignmentActive:boolean) {
  if(authorize()!==true)throw new RunnerError('FORBIDDEN','Workspace read denied');
  const own=state.records.jobs.filter(row=>row.scope.attemptId===state.attempt.attemptId
    &&row.scope.courseId===state.attempt.courseId&&row.scope.studentId===state.attempt.studentId);
  return structuredClone({attempt:state.attempt,files:state.files.filter(row=>row.attemptId===state.attempt.attemptId),
    snapshots:state.snapshots.filter(row=>row.attemptId===state.attempt.attemptId&&row.activityVersionId===state.attempt.activityVersionId),
    jobs:own.map(job=>({jobId:job.jobId,kind:job.kind,purpose:job.purpose,scope:job.scope,requestReceiptId:job.requestReceiptId,
      status:job.status,stopRequested:job.stopRequested,expectedRevision:job.expectedRevision,decisionEpoch:job.decisionEpoch,
      recoveryGeneration:job.recoveryGeneration,acceptedAt:job.acceptedAt,deadline:job.deadline,attemptCount:job.attemptCount,
      ...(job.runId?{runId:job.runId}:{})})),runs:state.runs.filter(row=>own.some(job=>job.jobId===row.jobId)).map(run=>{ownRun(state,run.jobId);return {
      runId:run.runId,jobId:run.jobId,snapshotId:run.submission.identity.snapshotId,snapshotHash:run.submission.identity.snapshotHash,
      mode:run.submission.mode,runtimeProfileVersion:run.submission.identity.runtimeProfileVersion,
      imageDigest:run.submission.identity.imageDigest,diagnostics:runDiagnostics(run)};}),
    checks:state.checks.filter(row=>own.some(job=>job.jobId===row.jobId)),
    // C4: the fixed submission history and the reopen permission the student needs in order to act. Older
    // submissions stay listed after a reopen, so a new submission never hides the one the teacher reviewed.
    submissions:state.submissions.map(submission=>({submissionId:submission.submissionId,snapshotId:submission.snapshotId,
      snapshotHash:submission.snapshotHash,workspaceRevision:submission.workspaceRevision,attemptRevision:submission.attemptRevision,
      decisionEpoch:submission.decisionEpoch,submittedAt:submission.submittedAt,receiptId:submission.receiptId,
      checkRefs:structuredClone(submission.checkRefs),...(submission.reflection===undefined?{}:{reflection:submission.reflection})})),
    reopen:reopenView(state,assignmentActive)});
}

// C4 recovery projection. Read-only: it never activates the attempt, enqueues work, repeats a side effect or moves
// the learning stage. `resyncRequired` is decided by the caller from the client's own generation/epoch, so a stale
// page is told to re-synchronize instead of being handed content it may not display.
const recoveryRunLimit=20;
function recoveryOutcome(run:WorkspaceState['runs'][number],job:Job):RecoveryRunOutcome {
  // An executor disconnect stays unknown. It is never folded into `confirmed`, and nothing here re-runs it.
  if(job.status==='outcome_unknown')return 'unknown';
  if(job.status==='failed')return 'failed';
  if(job.status==='cancelled')return 'cancelled';
  if(job.status==='stale')return 'stale';
  if(job.status==='timed_out')return 'timed_out';
  if(job.status==='queued'||job.status==='running'||job.status==='cancelling')return 'in_flight';
  return run.resultHash?'confirmed':'incomplete';
}
export function readRecovery(state:WorkspaceState,context:{recoveryGeneration:string;resyncRequired:boolean;assignmentActive:boolean;
  feedback:RecoveryFeedback;coverage?:TeachingCoverage},authorize:()=>boolean):AttemptRecovery {
  if(authorize()!==true)throw new RunnerError('FORBIDDEN','Recovery read denied');
  const own=state.records.jobs.filter(row=>row.scope.attemptId===state.attempt.attemptId
    &&row.scope.courseId===state.attempt.courseId&&row.scope.studentId===state.attempt.studentId);
  const runs=state.runs.filter(run=>own.some(job=>job.jobId===run.jobId)).map(run=>{
    const job=own.find(row=>row.jobId===run.jobId)!;
    return {runId:run.runId,jobId:run.jobId,mode:run.submission.mode,snapshotId:run.submission.identity.snapshotId,
      jobStatus:job.status,outcome:recoveryOutcome(run,job),acceptedAt:job.acceptedAt};
  // Run rows carry no timestamp of their own, so recency comes from the trusted job acceptance time.
  }).sort((a,b)=>Date.parse(b.acceptedAt)-Date.parse(a.acceptedAt)).slice(0,recoveryRunLimit)
    .map(({acceptedAt:_acceptedAt,...run})=>run);
  const newestSnapshot=latestSnapshot(state),newestSubmission=latestSubmission(state);
  return structuredClone({attempt:state.attempt,recoveryGeneration:context.recoveryGeneration,
    resyncRequired:context.resyncRequired,
    files:state.files.filter(row=>row.attemptId===state.attempt.attemptId)
      .map(({fileId,path,documentVersion,contentHash,lifecycle})=>({fileId,path,documentVersion,contentHash,lifecycle})),
    ...(newestSnapshot===undefined?{}:{latestSnapshotId:newestSnapshot.snapshotId}),
    submissions:state.submissions.map(submission=>({submissionId:submission.submissionId,snapshotId:submission.snapshotId,
      snapshotHash:submission.snapshotHash,workspaceRevision:submission.workspaceRevision,attemptRevision:submission.attemptRevision,
      serverSeq:receiptSequence(state,submission.receiptId),submittedAt:submission.submittedAt,
      hasReflection:submission.reflection!==undefined,checkRefs:submission.checkRefs})),
    ...(newestSubmission===undefined?{}:{latestSubmissionId:newestSubmission.submissionId}),
    reopen:reopenView(state,context.assignmentActive),runs,
    // A pending question is the student's own help request whose job has not reached a terminal fact yet.
    pendingQuestions:own.filter(job=>job.purpose==='student_help'&&['queued','running','cancelling'].includes(job.status))
      .map(job=>({jobId:job.jobId,jobStatus:job.status,acceptedAt:job.acceptedAt,deadline:job.deadline})),
    feedback:context.feedback,...(context.coverage===undefined?{}:{coverage:context.coverage})});
}
function receiptSequence(state:WorkspaceState,receiptId:string) {
  const receipt=state.records.receipts.find(row=>row.receiptId===receiptId);
  if(!receipt)throw new RunnerError('INVALID_REFERENCE','Original submission receipt unavailable');
  return receipt.serverSeq;
}
// Snapshot rows are keyed by an unordered identifier, so the newest confirmed snapshot is the one freezing the
// highest workspace revision, tie-broken by its trusted creation time.
function latestSnapshot(state:WorkspaceState) {
  return state.snapshots.filter(row=>row.attemptId===state.attempt.attemptId&&row.activityVersionId===state.attempt.activityVersionId)
    .slice().sort((a,b)=>b.workspaceRevision-a.workspaceRevision||Date.parse(b.createdAt)-Date.parse(a.createdAt))[0];
}

export function reconcileRun(state:WorkspaceState,jobId:string,result:{record:unknown;contentHash:string;resultRef:string},
  leaseToken:string,generation:string,now:string) {
  const {job,run}=ownRun(state,jobId);
  if(job.recoveryGeneration!==generation)throw new RunnerError('RECOVERY_REQUIRED','Original job/generation unavailable');
  const confirmed=validateRunResult(run.submission,result.record);
  if(confirmed.contentHash!==result.contentHash)throw new RunnerError('INVALID_REFERENCE','Run result hash mismatch');
  if(run.resultHash&&run.resultHash!==result.contentHash)throw new RunnerError('IDEMPOTENCY_CONFLICT','Original run result changed');
  if(run.resultHash&&job.resultRef===result.resultRef&&['succeeded','cancelled'].includes(job.status))return structuredClone(state);
  if(job.leaseToken&&(job.leaseToken!==leaseToken||!job.leaseUntil||Date.parse(job.leaseUntil)<=Date.parse(now)))throw new RunnerError('STATE_CONFLICT','Current reconciliation lease required');
  if(!result.resultRef||!Number.isFinite(Date.parse(now)))throw new RunnerError('INVALID_REFERENCE','Original result reference and trusted time required');
  if(run.resultHash&&job.resultRef!==result.resultRef)throw new RunnerError('IDEMPOTENCY_CONFLICT','Original result reference changed');
  if(!['running','outcome_unknown','cancelling','succeeded','cancelled'].includes(job.status))throw new RunnerError('STATE_CONFLICT','Run is not awaiting original reconciliation');
  const updated:Job={...job,status:['succeeded','cancelled'].includes(job.status)?job.status:job.stopRequested?'cancelled':'succeeded',resultRef:result.resultRef,resultHash:result.contentHash};
  return {...state,records:{...state.records,jobs:state.records.jobs.map(row=>row.jobId===jobId?updated:row)},
    runs:state.runs.map(row=>row.jobId===jobId?{...row,result:confirmed.record,resultHash:confirmed.contentHash}:row),
    checks:state.checks.map(check=>check.jobId===jobId?{...check,state:'ended' as const}:check)};
}

export function markRunUnknown(state:WorkspaceState,jobId:string,generation:string) {
  const {job}=ownRun(state,jobId);
  if(job.recoveryGeneration!==generation)throw new RunnerError('RECOVERY_REQUIRED','Original job generation required');
  if(!['running','cancelling','outcome_unknown'].includes(job.status))throw new RunnerError('STATE_CONFLICT','Only issued runs can become unknown');
  return {...state,records:{...state.records,jobs:state.records.jobs.map(row=>row.jobId===jobId?
    {...row,status:row.stopRequested?'cancelling' as const:'outcome_unknown' as const,failure:'original_runner_outcome_unknown'}:row)}};
}
export function confirmNodeCancellation(state:WorkspaceState,jobId:string,nodeFact:unknown,generation:string) {
  const {job,run}=ownRun(state,jobId);
  if(job.recoveryGeneration!==generation)throw new RunnerError('RECOVERY_REQUIRED','Original run generation required');
  const fact=validateRunFact(run.submission,nodeFact);
  if(!fact||fact.state!=='cancelled'||fact.reserved||!fact.stopRequested||fact.pending.length)throw new RunnerError('STATE_CONFLICT','Full node cancellation is not confirmed');
  const confirmed=job.status==='cancelled'&&job.stopRequested?job:confirmRunStopped(job,run.runId,true);
  return {...state,records:{...state.records,jobs:state.records.jobs.map(row=>row.jobId===jobId?confirmed:row)},
    checks:state.checks.map(check=>check.jobId===jobId?{...check,state:'ended' as const}:check)};
}
export function confirmNodeFailure(state:WorkspaceState,jobId:string,nodeFact:unknown,leaseToken:string,generation:string,now:string) {
  const {job,run}=ownRun(state,jobId);
  if(job.recoveryGeneration!==generation)throw new RunnerError('RECOVERY_REQUIRED','Original run generation required');
  if(!Number.isFinite(Date.parse(now))||!leaseToken||job.leaseToken!==leaseToken||!job.leaseUntil||Date.parse(job.leaseUntil)<=Date.parse(now))throw new RunnerError('STATE_CONFLICT','Current failure reconciliation lease required');
  const fact=validateRunFact(run.submission,nodeFact);
  if(fact&&fact.identity.recoveryGeneration!==generation)throw new RunnerError('RECOVERY_REQUIRED','Node failure generation reconciliation required');
  if(!fact||fact.state!=='failed'||fact.reserved||fact.units.length||fact.pending.length
    ||fact.resultRef!==undefined||fact.resultHash!==undefined||run.resultHash||!['running','outcome_unknown','cancelling','failed'].includes(job.status))throw new RunnerError('STATE_CONFLICT','Full node failure without a result is not confirmed');
  return {...state,records:{...state.records,jobs:state.records.jobs.map(row=>row.jobId===jobId?
    {...row,status:'failed' as const,failure:'original_runner_failed_without_result'}:row)},
    checks:state.checks.map(check=>check.jobId===jobId?{...check,state:'ended' as const}:check)};
}

export function readConfirmedSnapshot(state:WorkspaceState,snapshotId:string,authorize:()=>boolean) {
  if(authorize()!==true)throw new RunnerError('FORBIDDEN','Snapshot read denied');
  const snapshot=state.snapshots.find(row=>row.snapshotId===snapshotId&&row.attemptId===state.attempt.attemptId&&row.activityVersionId===state.attempt.activityVersionId);
  if(!snapshot)throw new RunnerError('INVALID_REFERENCE','Confirmed snapshot unavailable');
  validateSnapshot(snapshot);return structuredClone(snapshot);
}
export function readRunDiagnostics(state:WorkspaceState,runId:string,authorize:()=>boolean) {
  if(authorize()!==true)throw new RunnerError('FORBIDDEN','Run diagnostics read denied');
  const run=state.runs.find(row=>row.runId===runId);
  if(!run)throw new RunnerError('INVALID_REFERENCE','Authorized run unavailable');
  ownRun(state,run.jobId);
  return structuredClone(runDiagnostics(run));
}
function runDiagnostics(run:WorkspaceState['runs'][number]) {
  const base={runId:run.runId,snapshotId:run.submission.snapshot.snapshotId,snapshotHash:run.submission.snapshot.hash,source:'runner_diagnostics'};
  if(!run.result)return {...base,status:'unavailable'};
  const result=validateRunResult(run.submission,run.result).record;
  if(run.submission.mode==='check')return {...base,status:'available',verdict:result.verdict??'incomplete',failureKind:result.failureKind};
  const phases=Array.isArray(result.phases)?result.phases:[];
  return {...base,status:'available',failureKind:result.failureKind,
    stdout:phases.map(phase=>String(phase.stdout??'')).join(''),stderr:phases.map(phase=>String(phase.stderr??'')).join('')};
}
