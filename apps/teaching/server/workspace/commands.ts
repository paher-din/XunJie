import {RunnerError} from '../../runner/snapshot.ts';
import {finishCommand,requestHash,resolveCommandReceipt,onlyFields} from '../records/commands.ts';
import {activate,syncFiles} from './files.ts';
import {freezeSnapshot,beginExplicitOperation,validateObjectRef} from './snapshots.ts';
import {controlAttempt} from './controls.ts';
import type {Control} from './controls.ts';
import {cancelByPurpose,cancelJob,claimJob,enqueueJob,confirmRunStopped} from '../records/jobs.ts';
import {compilerArgs,sha256,validateSnapshot} from '../../runner/snapshot.ts';
import {textScopeArgs} from '../../runner/run-snapshot.ts';
import {validateRunFact,validateRunResult} from '../records/runner.ts';
import type {Records,CommandIdentity,Job,Purpose} from '../../contracts/records/index.ts';
import type {SubmitRun,Profile,TextScopeInput} from '../../contracts/runner/index.ts';
import type {Attempt,ProjectFile,ArtifactSnapshot,SyncBatch} from '../../contracts/workspace/index.ts';

export type WorkspaceState = {attempt:Attempt;files:ProjectFile[];snapshots:ArtifactSnapshot[];records:Records;
  checks:{jobId:string;runId:string;policyVersion:string;state:'active'|'ended'}[];
  runs:{runId:string;jobId:string;submission:SubmitRun;result?:unknown;resultHash?:string}[]};
export type CommandContext = {identity:CommandIdentity;generation:string;now:string;commandId:string;receiptId:string;eventId:string;
  assignmentActive:boolean;authorize:()=>boolean};
export function guardCommand(state:WorkspaceState,context:CommandContext) {
  if(context.authorize()!==true||context.identity.actorId!==state.attempt.studentId
    ||context.identity.scope.courseId!==state.attempt.courseId||context.identity.scope.studentId!==state.attempt.studentId
    ||context.identity.scope.attemptId!==state.attempt.attemptId)throw new RunnerError('FORBIDDEN','Authorized student command required');
}
export function completeCommand(state:WorkspaceState,context:CommandContext,hash:string,result:unknown,type:string) {
  const finished=finishCommand(state.records,{receiptId:context.receiptId,commandId:context.commandId,identity:context.identity,
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

export function controlCommand(state:WorkspaceState,context:CommandContext,expectedRevision:number,control:Control,
  resources:{resourceVersionId:string;paragraphId:string}[]=[]) {
  guardCommand(state,context);const hash=requestHash(context.identity.target,{expectedRevision,control});
  const previous=resolveCommandReceipt(state.records,context.identity,hash,context.generation);
  if(previous)return completeCommand(state,context,hash,previous.result,'attempt_controlled');
  if(control.kind==='position'&&control.returnPosition)validateObjectRef(state.attempt,control.returnPosition,
    {snapshots:state.snapshots,runs:state.runs.map(row=>({runId:row.runId,snapshotId:row.submission.snapshot.snapshotId,attemptId:state.attempt.attemptId})),resources});
  const plan=controlAttempt(state.attempt,expectedRevision,control,context.assignmentActive);
  const cancellation=cancelByPurpose(state.records.jobs,context.identity.scope,plan.cancelPurposes);
  return completeCommand({...state,attempt:plan.attempt,records:{...state.records,jobs:cancellation.jobs}},context,hash,
    {attemptRevision:plan.attempt.attemptRevision,decisionEpoch:plan.attempt.decisionEpoch,captureRevision:plan.attempt.captureRevision,
      cancelledJobIds:cancellation.jobIds,captureChanged:plan.captureChanged},'attempt_controlled');
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
    attempt={...attempt,decisionEpoch:attempt.decisionEpoch+1};
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
  // Even a queued business Job needs the node's cancel-before-submit tombstone before ending a check.
  if(original.purpose==='student_run'&&cancelled.status==='cancelled')cancelled.status='cancelling';
  return completeCommand({...state,records:{...state.records,jobs:state.records.jobs.map(row=>row.jobId===jobId?cancelled:row)}},context,hash,
    {jobId,status:cancelled.status,stopRequested:true},'job_stop_requested');
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
export function readWorkspace(state:WorkspaceState,authorize:()=>boolean) {
  if(authorize()!==true)throw new RunnerError('FORBIDDEN','Workspace read denied');
  const own=state.records.jobs.filter(row=>row.scope.attemptId===state.attempt.attemptId
    &&row.scope.courseId===state.attempt.courseId&&row.scope.studentId===state.attempt.studentId);
  return structuredClone({attempt:state.attempt,files:state.files.filter(row=>row.attemptId===state.attempt.attemptId),
    snapshots:state.snapshots.filter(row=>row.attemptId===state.attempt.attemptId&&row.activityVersionId===state.attempt.activityVersionId),
    jobs:own.map(job=>({jobId:job.jobId,kind:job.kind,purpose:job.purpose,scope:job.scope,requestReceiptId:job.requestReceiptId,
      status:job.status,stopRequested:job.stopRequested,expectedRevision:job.expectedRevision,decisionEpoch:job.decisionEpoch,
      recoveryGeneration:job.recoveryGeneration,acceptedAt:job.acceptedAt,deadline:job.deadline,attemptCount:job.attemptCount,
      ...(job.runId?{runId:job.runId}:{})})),runs:state.runs.filter(row=>own.some(job=>job.jobId===row.jobId)).map(({result:_privateResult,resultHash:_privateHash,...row})=>row),checks:state.checks.filter(row=>own.some(job=>job.jobId===row.jobId))});
}

export function reconcileRun(state:WorkspaceState,jobId:string,result:{record:unknown;contentHash:string;resultRef:string},
  leaseToken:string,generation:string,now:string) {
  const {job,run}=ownRun(state,jobId);
  if(job.recoveryGeneration!==generation)throw new RunnerError('RECOVERY_REQUIRED','Original job/generation unavailable');
  const confirmed=validateRunResult(run.submission,result.record);
  if(confirmed.contentHash!==result.contentHash)throw new RunnerError('INVALID_REFERENCE','Run result hash mismatch');
  if(run.resultHash&&run.resultHash!==result.contentHash)throw new RunnerError('IDEMPOTENCY_CONFLICT','Original run result changed');
  if(job.leaseToken&&job.leaseToken!==leaseToken)throw new RunnerError('STATE_CONFLICT','Current reconciliation lease required');
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

export function readConfirmedSnapshot(state:WorkspaceState,snapshotId:string,authorize:()=>boolean) {
  if(authorize()!==true)throw new RunnerError('FORBIDDEN','Snapshot read denied');
  const snapshot=state.snapshots.find(row=>row.snapshotId===snapshotId&&row.attemptId===state.attempt.attemptId&&row.activityVersionId===state.attempt.activityVersionId);
  if(!snapshot)throw new RunnerError('INVALID_REFERENCE','Confirmed snapshot unavailable');
  validateSnapshot(snapshot);return structuredClone(snapshot);
}
export function readRunDiagnostics(state:WorkspaceState,runId:string,authorize:()=>boolean) {
  const workspace=readWorkspace(state,authorize);
  const visible=workspace.runs.find(row=>row.runId===runId);
  if(!visible)throw new RunnerError('INVALID_REFERENCE','Authorized run unavailable');
  const {run}=ownRun(state,visible.jobId);
  const base={runId,snapshotId:run.submission.snapshot.snapshotId,snapshotHash:run.submission.snapshot.hash,source:'runner_diagnostics'};
  if(!run.result)return {...base,status:'unavailable'};
  const result=validateRunResult(run.submission,run.result).record;
  if(run.submission.mode==='check')return {...base,status:'available',verdict:result.verdict??'incomplete',failureKind:result.failureKind};
  const phases=Array.isArray(result.phases)?result.phases:[];
  return {...base,status:'available',failureKind:result.failureKind,
    stdout:phases.map(phase=>String(phase.stdout??'')).join(''),stderr:phases.map(phase=>String(phase.stderr??'')).join('')};
}
