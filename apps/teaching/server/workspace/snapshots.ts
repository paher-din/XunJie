import {manifestHash,RunnerError,validateSnapshot} from '../../runner/snapshot.ts';
import {activate,rangeOffsets,validateFiles} from './files.ts';
import type {ArtifactSnapshot,Attempt,ObjectRef,ProjectFile} from '../../contracts/workspace/index.ts';
import {onlyFields} from '../records/commands.ts';

export function freezeSnapshot(attempt:Attempt,files:ProjectFile[],expectedWorkspaceRevision:number,snapshotId:string,now:string) {
  validateFiles(attempt,files);
  if(expectedWorkspaceRevision!==attempt.workspaceRevision)throw new RunnerError('VERSION_CONFLICT','Workspace version conflict');
  if(!snapshotId||!Number.isFinite(Date.parse(now)))throw new RunnerError('INVALID_REQUEST','Snapshot ID and trusted time required');
  const selected=files.filter(file=>file.lifecycle==='active').map(({fileId,path,documentVersion,text,contentHash})=>({fileId,path,documentVersion,text,contentHash}));
  const snapshot:ArtifactSnapshot={snapshotId,attemptId:attempt.attemptId,activityVersionId:attempt.activityVersionId,
    workspaceRevision:attempt.workspaceRevision,createdAt:now,hashFormat:'sha256-manifest-v1',hash:manifestHash(selected),files:selected};
  validateSnapshot(snapshot);
  return structuredClone(snapshot);
}
export function validateObjectRef(attempt:Attempt,reference:ObjectRef,context:{snapshots:ArtifactSnapshot[];
  runs:{runId:string;snapshotId:string;attemptId:string}[];resources:{resourceVersionId:string;paragraphId:string}[]}) {
  if(!reference||reference.attemptId!==attempt.attemptId)throw new RunnerError('INVALID_REFERENCE','Object scope mismatch');
  onlyFields(reference,reference.kind==='code'?['kind','attemptId','snapshotId','fileId','path','documentVersion','contentHash','range','source']:
    reference.kind==='run'?['kind','attemptId','runId','snapshotId']:reference.kind==='resource'?['kind','attemptId','resourceVersionId','paragraphId']:['kind','attemptId','activityVersionId']);
  if(reference.kind==='project') {
    if(reference.activityVersionId!==attempt.activityVersionId)throw new RunnerError('INVALID_REFERENCE','Activity reference mismatch');
  } else if(reference.kind==='resource') {
    if(!context.resources.some(row=>row.resourceVersionId===reference.resourceVersionId&&row.paragraphId===reference.paragraphId))throw new RunnerError('INVALID_REFERENCE','Resource reference unavailable');
  } else {
    const snapshot=context.snapshots.find(row=>row.snapshotId===reference.snapshotId&&row.attemptId===attempt.attemptId&&row.activityVersionId===attempt.activityVersionId);
    if(!snapshot)throw new RunnerError('INVALID_REFERENCE','Snapshot reference unavailable');
    validateSnapshot(snapshot);
    if(reference.kind==='run') {
      if(!context.runs.some(row=>row.runId===reference.runId&&row.snapshotId===snapshot.snapshotId&&row.attemptId===attempt.attemptId))throw new RunnerError('INVALID_REFERENCE','Run reference mismatch');
    } else if(reference.kind==='code') {
      const file=snapshot.files.find(row=>row.fileId===reference.fileId);
      if(!file||file.path!==reference.path||file.documentVersion!==reference.documentVersion||file.contentHash!==reference.contentHash)throw new RunnerError('INVALID_REFERENCE','Exact code instance/version/hash required');
      if(reference.range)rangeOffsets(file.text,reference.range);
      if(reference.source){onlyFields(reference.source,['system','session','modelId','seq']);
        if(reference.source.system!=='student-ide'||!reference.source.session||!reference.source.modelId
          ||(reference.source.seq!==undefined&&(!Number.isSafeInteger(reference.source.seq)||reference.source.seq<0)))throw new RunnerError('INVALID_REFERENCE','Invalid historical source reference');}
    } else throw new RunnerError('INVALID_REFERENCE','Unsupported object reference');
  }
  return structuredClone(reference);
}

export function createAttempt(existing:Attempt[],input:{attemptId:string;courseId:string;studentId:string;assignmentId:string;activityVersionId:string},assignmentActive:boolean):Attempt {
  const current=existing.find(row=>row.assignmentId===input.assignmentId&&row.studentId===input.studentId);
  if(current) {
    if(current.courseId!==input.courseId||current.activityVersionId!==input.activityVersionId)throw new RunnerError('INVALID_REFERENCE','Immutable assignment reference mismatch');
    return structuredClone(current);
  }
  if(!assignmentActive)throw new RunnerError('STATE_CONFLICT','Assignment is paused');
  if(Object.values(input).some(value=>typeof value!=='string'||!value)||existing.some(row=>row.attemptId===input.attemptId))throw new RunnerError('INVALID_REQUEST','Trusted new attempt references required');
  return {...input,status:'ready',attemptRevision:1,workspaceRevision:0,decisionEpoch:0,captureRevision:0,collecting:true,reminders:false};
}
export function beginExplicitOperation(attempt:Attempt,expectedAttemptRevision:number,assignmentActive:boolean) {
  if(attempt.attemptRevision!==expectedAttemptRevision)throw new RunnerError('VERSION_CONFLICT','Attempt version conflict');
  if(!assignmentActive||!['ready','active'].includes(attempt.status))throw new RunnerError('STATE_CONFLICT','Explicit operation is not permitted');
  return activate(attempt);
}
