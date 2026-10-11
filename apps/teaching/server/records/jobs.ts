import {RunnerError} from '../../runner/snapshot.ts';
import {sameScope} from './commands.ts';
import type {Job,Purpose,Scope} from '../../contracts/records/index.ts';

const terminal=new Set(['succeeded','failed','cancelled','stale','timed_out']);
const purposes:Purpose[]=['teacher_design','student_help','reminder','explicit_analysis','passive_analysis','student_run','teacher_sample'];
const time=(value:string)=>{const result=Date.parse(value);if(!Number.isFinite(result))throw new RunnerError('INVALID_REQUEST','Invalid trusted time');return result;};
function assertLease(job:Job,token:string,generation:string,now:string) {
  if(job.recoveryGeneration!==generation)throw new RunnerError('RECOVERY_REQUIRED','Stale job generation');
  if(!token||job.leaseToken!==token||!job.leaseUntil||time(job.leaseUntil)<=time(now))throw new RunnerError('STATE_CONFLICT','Job lease is not current');
}
export function enqueueJob(existing:Job[],job:Job) {
  if(!job.jobId||!job.kind||!purposes.includes(job.purpose)||!job.scope.courseId||!job.requestReceiptId
    ||!job.recoveryGeneration||job.status!=='queued'||job.stopRequested||job.attemptCount!==0
    ||!Number.isSafeInteger(job.expectedRevision)||job.expectedRevision<0||!Number.isSafeInteger(job.decisionEpoch)||job.decisionEpoch<0
    ||time(job.deadline)<=time(job.acceptedAt)||job.leaseToken||job.resultRef)throw new RunnerError('INVALID_REQUEST','Invalid new job');
  if(existing.some(item=>item.jobId===job.jobId))throw new RunnerError('IDEMPOTENCY_CONFLICT','Job ID already exists');
  if(['teacher_design','student_help'].includes(job.purpose)&&time(job.deadline)-time(job.acceptedAt)>45000)throw new RunnerError('INVALID_CONFIGURATION','Teaching round deadline exceeds 45 seconds');
  if(job.purpose==='student_run'&&(!job.runId||!job.scope.attemptId||!job.scope.studentId))throw new RunnerError('INVALID_REFERENCE','Run scope required');
  if(job.purpose==='teacher_sample'&&(job.scope.attemptId||job.scope.studentId))throw new RunnerError('INVALID_REFERENCE','Teacher sample cannot use a student scope');
  if(job.scope.attemptId&&['student_run','student_help'].includes(job.purpose)&&existing.some(item=>item.scope.attemptId===job.scope.attemptId
    &&item.purpose===job.purpose&&!terminal.has(item.status)))throw new RunnerError('STATE_CONFLICT','Attempt already has an unsettled job for this purpose');
  return [...existing,structuredClone(job)];
}
export function claimJob(job:Job,token:string,until:string,generation:string,now:string):Job {
  if(job.recoveryGeneration!==generation)throw new RunnerError('RECOVERY_REQUIRED','Stale job generation');
  if(job.status!=='queued'||job.stopRequested)throw new RunnerError('STATE_CONFLICT','Job is not dispatchable');
  if(time(job.deadline)<=time(now))return {...job,status:'timed_out',failure:'deadline'};
  if(!token||time(until)<=time(now)||time(until)>time(job.deadline))throw new RunnerError('INVALID_REQUEST','Invalid bounded lease');
  return {...job,status:'running',leaseToken:token,leaseUntil:until};
}
export function renewJob(job:Job,token:string,until:string,generation:string,now:string):Job {
  assertLease(job,token,generation,now);
  if(job.status!=='running'||job.stopRequested||time(until)<=time(now)||time(until)>time(job.deadline))throw new RunnerError('STATE_CONFLICT','Cannot renew stopped or expired job');
  return {...job,leaseUntil:until};
}
export function recordModelCall(job:Job,token:string,generation:string,now:string):Job {
  assertLease(job,token,generation,now);
  if(job.status!=='running'||job.stopRequested||time(job.deadline)<=time(now)||job.attemptCount>=3
    ||['student_run','teacher_sample'].includes(job.purpose))throw new RunnerError('STATE_CONFLICT','Model call is not permitted');
  return {...job,attemptCount:job.attemptCount+1};
}
export function finishJob(job:Job,completion:{leaseToken:string;generation:string;now:string;resultRef:string;resultHash:string},
  current:{expectedRevision:number;decisionEpoch:number}):Job {
  if(job.recoveryGeneration!==completion.generation)throw new RunnerError('RECOVERY_REQUIRED','Stale job generation');
  if(job.resultRef) {
    if(job.resultRef!==completion.resultRef||job.resultHash!==completion.resultHash)throw new RunnerError('IDEMPOTENCY_CONFLICT','Original job result mismatch');
    return structuredClone(job);
  }
  assertLease(job,completion.leaseToken,completion.generation,completion.now);
  if(!completion.resultRef||! /^[0-9a-f]{64}$/.test(completion.resultHash))throw new RunnerError('INVALID_REFERENCE','Immutable result reference required');
  if(job.status!=='running'||job.stopRequested||time(job.deadline)<=time(completion.now)
    ||job.expectedRevision!==current.expectedRevision||job.decisionEpoch!==current.decisionEpoch)throw new RunnerError('STATE_CONFLICT','Job completion is no longer applicable');
  return {...job,status:'succeeded',resultRef:completion.resultRef,resultHash:completion.resultHash};
}
export function cancelJob(job:Job):Job {
  if(job.stopRequested)return structuredClone(job);
  return {...job,stopRequested:true,...(!terminal.has(job.status)?{status:
    ['student_run','teacher_sample'].includes(job.purpose)?'cancelling' as const:'cancelled' as const}:{})};
}
export function confirmRunStopped(job:Job,runId:string,unitTerminated:boolean):Job {
  if(job.runId!==runId||!job.stopRequested||!unitTerminated||!['cancelling','outcome_unknown'].includes(job.status))throw new RunnerError('STATE_CONFLICT','Original run termination is not confirmed');
  return {...job,status:'cancelled'};
}
export function recoverJob(job:Job,now:string):Job {
  if(job.status==='running'&&job.leaseUntil&&time(job.leaseUntil)<=time(now))return {...job,status:'outcome_unknown',failure:'expired_lease_requires_original_reconciliation'};
  return structuredClone(job);
}
export function cancelByPurpose(jobs:Job[],scope:Scope,selected:Purpose[]) {
  const changed:string[]=[];
  const next=jobs.map(job=>{
    if(!sameScope(job.scope,scope)||!selected.includes(job.purpose)||job.stopRequested)return structuredClone(job);
    changed.push(job.jobId);return cancelJob(job);
  });
  return {jobs:next,jobIds:changed};
}

// Called with rows from A's current transaction, never through another commit/HTTP write.
export function invalidateInTransaction(jobs:Job[],request:{courseId:string;studentId:string;attemptIds:string[];
  expectedEpochs:Record<string,number>},currentEpochs:Record<string,number>) {
  if(new Set(request.attemptIds).size!==request.attemptIds.length)throw new RunnerError('INVALID_REQUEST','Duplicate affected attempts');
  const epochs={...currentEpochs};
  for(const id of request.attemptIds) {
    if(!Number.isSafeInteger(request.expectedEpochs[id])||epochs[id]!==request.expectedEpochs[id])throw new RunnerError('VERSION_CONFLICT','Decision epoch mismatch');
    epochs[id]=request.expectedEpochs[id]!+1;
  }
  const jobIds:string[]=[];
  const next=jobs.map(job=>{
    if(job.scope.courseId!==request.courseId||job.scope.studentId!==request.studentId
      ||!job.scope.attemptId||!request.attemptIds.includes(job.scope.attemptId)
      ||['student_run','teacher_sample'].includes(job.purpose))return structuredClone(job);
    jobIds.push(job.jobId);return {...job,status:terminal.has(job.status)?job.status:'stale' as const,stopRequested:true};
  });
  return {jobs:next,epochs,jobIds};
}
