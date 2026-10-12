import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Transaction,SyntheticDatabase,SqlRow} from '../db/transaction.ts';
import type {ActorContext} from '../../contracts/access/index.ts';
import type {CommandIdentity,Job} from '../../contracts/records/index.ts';
import type {BoardProfile,HdlRuntime,HdlBuildRequest,HdlIdentity,HdlCommand,HdlProgram,HdlOperation,HdlSession} from '../../contracts/runner/hdl.ts';
import {readAttempt,saveAttempt,readJobs,saveJob,finishRecordCommand,readRecordCommand,readRecords,saveRecordPlan} from '../db/records-adapter.ts';
import {assignmentAvailability} from '../design/activities.ts';
import {loadWorkspace} from './storage.ts';
import {activate} from './files.ts';
import {requestHash,canonical,finishCommand} from '../records/commands.ts';
import {enqueueJob,claimJob,cancelJob} from '../records/jobs.ts';
import {ApiError,domainError} from '../app/errors.ts';
import {sha256} from '../../runner/snapshot.ts';
import {fields,validateIdentity,validateBoard,validateOperation} from '../../runner/hdl-profile.ts';
import {hdlBuild,hdlSession,hdlResult} from './hdl-inputs.ts';

export type HdlTransport=(command:HdlCommand)=>Promise<unknown>;
export type ApprovedHdlProfile={board:BoardProfile;runtime:HdlRuntime};
const buildAck=z.strictObject({buildId:z.string().min(1),jobId:z.string().min(1)});
const operationAck=z.strictObject({sessionId:z.string().min(1),operationId:z.string().min(1),jobId:z.string().min(1)});
const terminal=new Set(['succeeded','failed','cancelled','stale','timed_out']);
function permitted(tx:Transaction,actor:ActorContext,attemptId:string,write:boolean){
  const attempt=readAttempt(tx,attemptId),member=tx.get('SELECT role FROM course_memberships WHERE course_id=? AND user_id=? AND active=1',actor.courseId,actor.userId);
  const user=tx.get('SELECT disabled_at_ms FROM users WHERE id=?',actor.userId);
  if(!member||member.role!==actor.role||!user||user.disabled_at_ms!==null||attempt.courseId!==actor.courseId
    ||actor.role==='student'&&attempt.studentId!==actor.userId||write&&actor.role!=='student')throw new ApiError('FORBIDDEN');
  return attempt;
}
function writable(tx:Transaction,actor:ActorContext,attemptId:string,expected:number){
  const attempt=permitted(tx,actor,attemptId,true);
  if(expected!==attempt.attemptRevision)throw new ApiError('VERSION_CONFLICT');
  if(!['ready','active'].includes(attempt.status)||!assignmentAvailability(tx,attempt.courseId,attempt.assignmentId,attempt.studentId).active)throw new ApiError('STATE_CONFLICT');
  return attempt;
}
function nodeIdentity(tx:Transaction,identity:CommandIdentity,receiptId:string,id:string):HdlIdentity{
  const receipt=readRecords(tx,identity.scope.courseId).receipts.find(item=>item.receiptId===receiptId)!;
  const attempt=readAttempt(tx,identity.scope.attemptId!);
  return {id,commandId:receipt.commandId,requestHash:receipt.requestHash,recoveryGeneration:identity.recoveryGeneration,
    scope:{courseId:attempt.courseId,studentId:attempt.studentId,attemptId:attempt.attemptId,activityVersionId:attempt.activityVersionId}};
}
function jobFor(tx:Transaction,identity:CommandIdentity,receiptId:string,jobId:string,kind:string,runId:string,now:number){
  const attempt=readAttempt(tx,identity.scope.attemptId!),job:Job={jobId,kind,purpose:'student_run',scope:identity.scope,requestReceiptId:receiptId,
    status:'queued',stopRequested:false,expectedRevision:attempt.attemptRevision,decisionEpoch:attempt.decisionEpoch,
    recoveryGeneration:identity.recoveryGeneration,acceptedAt:new Date(now).toISOString(),deadline:new Date(now+120000).toISOString(),attemptCount:0,runId};
  enqueueJob(readJobs(tx,attempt.courseId),job);saveJob(tx,job);return job;
}
function commandScope(actor:ActorContext,attempt:ReturnType<typeof readAttempt>,key:string,generation:string,command:string):CommandIdentity{
  return {actorId:actor.userId,command,target:attempt.attemptId,scope:{courseId:attempt.courseId,studentId:attempt.studentId,attemptId:attempt.attemptId},idempotencyKey:key,recoveryGeneration:generation};
}
function checkedRequest<T>(row:SqlRow,field:string):T {const value=JSON.parse(String(row[field]));return value as T;}
function checkedSession(tx:Transaction,sessionId:string):HdlSession{
  const row=tx.get('SELECT * FROM hdl_sessions WHERE session_id=?',sessionId);if(!row)throw new ApiError('FORBIDDEN');
  const attempt=readAttempt(tx,String(row.attempt_id)),actor:ActorContext={userId:attempt.studentId,courseId:attempt.courseId,role:'student'};
  const value=hdlSession.parse(JSON.parse(String(row.session_json)));scopeIdentity(value.identity,actor,attempt);
  if(value.sessionId!==row.session_id||value.buildId!==row.build_id||value.identity.scope.attemptId!==row.attempt_id
    ||value.identity.recoveryGeneration!==row.generation||value.sessionRevision!==row.revision||value.status!==row.status
    ||value.confirmedSequence!==row.confirmed_sequence||Number(value.terminationConfirmed)!==row.termination_confirmed
    ||Number(value.stopRequested)!==row.stop_requested|| (value.pendingOperationId??null)!==row.pending_operation_id)throw new ApiError('INVALID_REFERENCE');return value;
}
export function readHdlSession(tx:Transaction,actor:ActorContext,sessionId:string):HdlSession{
  const value=checkedSession(tx,sessionId);permitted(tx,actor,value.identity.scope.attemptId,false);return value;
}
export function readHdlBuild(tx:Transaction,actor:ActorContext,buildId:string){
  const row=tx.get('SELECT * FROM hdl_builds WHERE build_id=?',buildId);if(!row)throw new ApiError('FORBIDDEN');permitted(tx,actor,String(row.attempt_id),false);
  const request=checkedRequest<HdlBuildRequest>(row,'request_json');validateIdentity(request.identity);validateBoard(request.board);
  const basis=tx.get('SELECT attempt_id,content_hash FROM artifact_snapshots WHERE snapshot_id=?',request.snapshot.snapshotId);
  if(request.identity.id!==buildId||request.identity.scope.attemptId!==row.attempt_id||request.snapshot.snapshotId!==row.snapshot_id
    ||basis?.attempt_id!==row.attempt_id||basis.content_hash!==request.snapshot.hash||request.board.boardProfileVersion!==row.board_profile_version
    ||request.board.mappingVersion!==row.mapping_version||request.runtimeProfileVersion!==row.runtime_profile_version)throw new ApiError('INVALID_REFERENCE');
  const result=row.build_json===null?null:hdlBuild.parse(JSON.parse(String(row.build_json)));
  if(result&&(sha256(String(row.build_json))!==row.result_hash||result.status!==row.status||result.artifactHash!== (row.artifact_hash??undefined)
    ||result.buildId!==buildId||canonical(result.identity)!==canonical(request.identity)))throw new ApiError('INVALID_REFERENCE');return {request,result,status:String(row.status),jobId:String(row.job_id)};
}
function saveSession(tx:Transaction,state:HdlSession,pending?:string){
  const old=tx.get('SELECT stop_requested FROM hdl_sessions WHERE session_id=?',state.sessionId);
  if(old?.stop_requested===1&&!state.stopRequested)throw new ApiError('STATE_CONFLICT');
  const body={...state};if(pending!==undefined)body.pendingOperationId=pending;else delete body.pendingOperationId;
  tx.run('UPDATE hdl_sessions SET revision=?,status=?,confirmed_sequence=?,termination_confirmed=?,stop_requested=?,pending_operation_id=?,session_json=? WHERE session_id=?',
    body.sessionRevision,body.status,body.confirmedSequence,Number(body.terminationConfirmed),Number(body.stopRequested),pending??null,JSON.stringify(body),body.sessionId);
}
function scopeIdentity(identity:HdlIdentity,actor:ActorContext,attempt:ReturnType<typeof readAttempt>){
  if(identity.scope.courseId!==actor.courseId||identity.scope.studentId!==attempt.studentId||identity.scope.attemptId!==attempt.attemptId||identity.scope.activityVersionId!==attempt.activityVersionId)throw new ApiError('INVALID_REFERENCE');
}
export function stopHdlInTransaction(tx:Transaction,attemptId:string,reason:string,generation:string){
  const attempt=readAttempt(tx,attemptId);
  for(const row of tx.all('SELECT * FROM hdl_sessions WHERE attempt_id=? AND termination_confirmed=0',attemptId)){
    const state=checkedSession(tx,String(row.session_id));
    saveSession(tx,{...state,status:'stopping',stopRequested:true,failureKind:reason},state.pendingOperationId);
  }
  for(const job of readJobs(tx,attempt.courseId).filter(item=>item.scope.attemptId===attemptId&&item.kind.startsWith('hdl_')&&!terminal.has(item.status)))
    saveJob(tx,{...cancelJob(job),failure:reason});
  return {attemptId,recoveryGeneration:generation};
}
export function createHdlWorkspace(options:{db:SyntheticDatabase;currentGeneration:()=>string;transport:HdlTransport;
  approvedProfile:(tx:Transaction,attemptId:string)=>ApprovedHdlProfile|undefined;now?:()=>number}){
  const now=options.now??Date.now;
  const generation=(expected:string)=>{if(expected!==options.currentGeneration())throw new ApiError('RECOVERY_REQUIRED');return expected;};
  function build(actor:ActorContext,attemptId:string,key:string,expectedGeneration:string,input:{expectedAttemptRevision:number;snapshotId:string}){
    return options.db.withTransaction(tx=>{
      generation(expectedGeneration);const attempt=permitted(tx,actor,attemptId,true),identity=commandScope(actor,attempt,key,expectedGeneration,'hdl.build');
      return finishRecordCommand(tx,identity,input,expectedGeneration,now(),()=>{
        const current=writable(tx,actor,attemptId,input.expectedAttemptRevision),profile=options.approvedProfile(tx,attemptId);
        if(!profile)throw new ApiError('RUNTIME_NOT_READY');validateBoard(profile.board);
        const snapshot=loadWorkspace(tx,attemptId).snapshots.find(item=>item.snapshotId===input.snapshotId);if(!snapshot)throw new ApiError('INVALID_REFERENCE');
        saveAttempt(tx,activate(current));return buildAck.parse({buildId:randomUUID(),jobId:randomUUID()});
      },value=>buildAck.parse(value),(receiptId,result)=>{
        const profile=options.approvedProfile(tx,attemptId)!;const snapshot=loadWorkspace(tx,attemptId).snapshots.find(item=>item.snapshotId===input.snapshotId)!;
        jobFor(tx,identity,receiptId,result.jobId,'hdl_build',result.buildId!,now());
        const request:HdlBuildRequest={identity:nodeIdentity(tx,identity,receiptId,result.buildId!),snapshot,board:profile.board,runtimeProfileVersion:profile.runtime.runtimeProfileVersion};
        tx.run('INSERT INTO hdl_builds(build_id,attempt_id,job_id,run_id,snapshot_id,board_profile_version,mapping_version,runtime_profile_version,status,request_json) VALUES (?,?,?,?,?,?,?,?,?,?)',
          result.buildId!,attemptId,result.jobId,result.buildId!,input.snapshotId,profile.board.boardProfileVersion,profile.board.mappingVersion,request.runtimeProfileVersion,'queued',JSON.stringify(request));
      });
    });
  }
  function acceptProgram(actor:ActorContext,attemptId:string,key:string,expectedGeneration:string,input:{expectedAttemptRevision:number;buildId:string;replaceSessionId?:string;expectedSessionRevision?:number}){
    return options.db.withTransaction(tx=>{
      generation(expectedGeneration);const attempt=permitted(tx,actor,attemptId,true),identity=commandScope(actor,attempt,key,expectedGeneration,'hdl.program');
      return finishRecordCommand(tx,identity,input,expectedGeneration,now(),()=>{
        writable(tx,actor,attemptId,input.expectedAttemptRevision);const build=readHdlBuild(tx,actor,input.buildId);
        if(build.request.identity.scope.attemptId!==attemptId||build.result?.status!=='succeeded'||!build.result.terminationConfirmed)throw new ApiError('STATE_CONFLICT');
        const occupied=tx.get('SELECT session_id FROM hdl_sessions WHERE attempt_id=? AND termination_confirmed=0',attemptId);
        if(occupied)throw new ApiError('STATE_CONFLICT');
        const sessionId=randomUUID();return operationAck.parse({sessionId,operationId:sessionId,jobId:randomUUID()});
      },value=>operationAck.parse(value),(receiptId,result)=>{
        const build=readHdlBuild(tx,actor,input.buildId),at=new Date(now()).toISOString();
        const state:HdlSession={sessionId:result.sessionId!,identity:nodeIdentity(tx,identity,receiptId,result.sessionId!),buildId:input.buildId,
          snapshotId:build.request.snapshot.snapshotId,snapshotHash:build.request.snapshot.hash,boardProfileVersion:build.request.board.boardProfileVersion,
          mappingVersion:build.request.board.mappingVersion,engineVersion:build.result!.engineVersion,runtimeProfileVersion:build.request.runtimeProfileVersion,
          sessionRevision:1,confirmedSequence:0,simTimePs:'0',status:'starting',terminationConfirmed:false,stopRequested:false,createdAt:at,lastOperationAt:at,deadline:new Date(now()+1800000).toISOString()};
        tx.run('INSERT INTO hdl_sessions(session_id,attempt_id,build_id,request_receipt_id,generation,revision,status,confirmed_sequence,termination_confirmed,stop_requested,session_json) VALUES (?,?,?,?,?,1,\'starting\',0,0,0,?)',
          state.sessionId,attemptId,input.buildId,receiptId,expectedGeneration,JSON.stringify(state));
        jobFor(tx,identity,receiptId,result.jobId,'hdl_program',result.operationId!,now());
        const packet:HdlProgram={identity:state.identity,buildId:input.buildId};
        tx.run('INSERT INTO hdl_operations(operation_id,session_id,job_id,request_receipt_id,sequence,request_hash,status,request_json) VALUES (?,?,?,?,0,?,\'queued\',?)',
          result.operationId!,state.sessionId,result.jobId,receiptId,requestHash(state.sessionId,packet),JSON.stringify(packet));
        saveSession(tx,state,result.operationId!);
      });
    });
  }
  async function program(actor:ActorContext,attemptId:string,key:string,expectedGeneration:string,input:{expectedAttemptRevision:number;buildId:string;replaceSessionId?:string;expectedSessionRevision?:number}){
    const previous=options.db.withTransaction(tx=>{generation(expectedGeneration);const attempt=permitted(tx,actor,attemptId,true);
      return readRecordCommand(tx,commandScope(actor,attempt,key,expectedGeneration,'hdl.program'),input,expectedGeneration,value=>operationAck.parse(value));});
    if(previous)return previous;
    if(input.replaceSessionId){
      const stopped=options.db.withTransaction(tx=>{
        generation(expectedGeneration);const attempt=permitted(tx,actor,attemptId,true),identity=commandScope(actor,attempt,key,expectedGeneration,'hdl.replace_stop');
        const receipt=finishRecordCommand(tx,identity,input,expectedGeneration,now(),()=>{
          writable(tx,actor,attemptId,input.expectedAttemptRevision);const original=readHdlSession(tx,actor,input.replaceSessionId!);
          if(original.identity.scope.attemptId!==attemptId)throw new ApiError('FORBIDDEN');if(original.sessionRevision!==input.expectedSessionRevision)throw new ApiError('VERSION_CONFLICT');
          stopHdlInTransaction(tx,attemptId,'explicit_reprogram',expectedGeneration);return original.identity;
        },value=>{validateIdentity(value);return value;});return receipt.result;
      });
      const response=await options.transport({op:'hdl_stop',identity:stopped});fields(response,['data','error']);if(response.error)throw new ApiError('DEPENDENCY_UNAVAILABLE');
      const node=hdlSession.parse(response.data);
      if(!node?.terminationConfirmed||canonical(node.identity)!==canonical(stopped))throw new ApiError('DEPENDENCY_UNAVAILABLE');
      options.db.withTransaction(tx=>{generation(expectedGeneration);const original=readHdlSession(tx,actor,input.replaceSessionId!);saveSession(tx,{...node,stopRequested:true});
        for(const row of tx.all('SELECT job_id FROM hdl_operations WHERE session_id=?',original.sessionId)){
          const job=readJobs(tx,actor.courseId).find(item=>item.jobId===row.job_id)!;if(!terminal.has(job.status))saveJob(tx,{...job,status:'cancelled',stopRequested:true});}
      });
    }
    return acceptProgram(actor,attemptId,key,expectedGeneration,input);
  }
  function interact(actor:ActorContext,attemptId:string,key:string,expectedGeneration:string,input:Omit<HdlOperation,'identity'>&{expectedAttemptRevision:number}){
    return options.db.withTransaction(tx=>{
      generation(expectedGeneration);const attempt=permitted(tx,actor,attemptId,true),identity=commandScope(actor,attempt,key,expectedGeneration,'hdl.interact');
      return finishRecordCommand(tx,identity,input,expectedGeneration,now(),()=>{
        writable(tx,actor,attemptId,input.expectedAttemptRevision);const session=readHdlSession(tx,actor,input.sessionId);
        if(session.identity.scope.attemptId!==attemptId||session.status!=='active'||session.stopRequested||session.pendingOperationId)throw new ApiError('STATE_CONFLICT');
        if(session.sessionRevision!==input.expectedSessionRevision||session.confirmedSequence+1!==input.expectedSequence)throw new ApiError('VERSION_CONFLICT');
        return operationAck.parse({sessionId:input.sessionId,operationId:randomUUID(),jobId:randomUUID()});
      },value=>operationAck.parse(value),(receiptId,result)=>{
        const session=readHdlSession(tx,actor,input.sessionId),packet:HdlOperation={identity:nodeIdentity(tx,identity,receiptId,result.operationId!),sessionId:input.sessionId,
          expectedSessionRevision:input.expectedSessionRevision,expectedSequence:input.expectedSequence,inputs:input.inputs,advanceCycles:input.advanceCycles};validateOperation(packet);
        jobFor(tx,identity,receiptId,result.jobId,'hdl_interact',result.operationId!,now());
        tx.run('INSERT INTO hdl_operations(operation_id,session_id,job_id,request_receipt_id,sequence,request_hash,status,request_json) VALUES (?,?,?,?,?,?,\'queued\',?)',
          result.operationId!,input.sessionId,result.jobId,receiptId,input.expectedSequence,requestHash(input.sessionId,packet),JSON.stringify(packet));saveSession(tx,session,result.operationId!);
      });
    });
  }
  function progress(tx:Transaction,job:Job){
    const at=new Date(now()).toISOString(),identity:CommandIdentity={actorId:job.scope.studentId!,command:'hdl.progress',target:job.jobId,scope:job.scope,idempotencyKey:randomUUID(),recoveryGeneration:job.recoveryGeneration};
    const result={jobId:job.jobId,status:job.status,stopRequested:job.stopRequested,...(job.resultRef?{resultRef:job.resultRef,resultHash:job.resultHash}: {})};
    const plan=finishCommand(readRecords(tx,job.scope.courseId),{identity,receiptId:randomUUID(),commandId:randomUUID(),requestHash:requestHash(job.jobId,result),result,committedAt:at},
      {eventId:randomUUID(),scope:job.scope,type:'hdl.progress',occurredAt:at,source:'trusted_service'},job.recoveryGeneration);
    const event=plan.records.events.at(-1)!;saveRecordPlan(tx,plan.receipt,{...event,payloadRef:plan.receipt.receiptId});
  }
  function cancelInTransaction(tx:Transaction,actor:ActorContext,jobId:string,key:string,expectedGeneration:string,reason='explicit_job_cancel'){
    generation(expectedGeneration);const row=tx.get('SELECT attempt_id FROM jobs WHERE job_id=?',jobId);if(!row)throw new ApiError('FORBIDDEN');
    const attempt=permitted(tx,actor,String(row.attempt_id),true),job=readJobs(tx,actor.courseId).find(item=>item.jobId===jobId)!;
    if(!job.kind.startsWith('hdl_'))throw new ApiError('FORBIDDEN');
    const identity={...commandScope(actor,attempt,key,expectedGeneration,'hdl.cancel'),target:jobId};
    return finishRecordCommand(tx,identity,{jobId,reason},expectedGeneration,now(),()=>{
      const operation=tx.get('SELECT session_id FROM hdl_operations WHERE job_id=?',jobId);
      if(operation){const session=checkedSession(tx,String(operation.session_id));
        if(!session.terminationConfirmed)saveSession(tx,{...session,status:'stopping',stopRequested:true,failureKind:reason},session.pendingOperationId);
      }
      saveJob(tx,cancelJob(job));return {jobId,stopRequested:true};
    },value=>z.strictObject({jobId:z.string(),stopRequested:z.literal(true)}).parse(value));
  }
  async function reconcileStops(){
    const pending=options.db.withTransaction(tx=>tx.all('SELECT session_id FROM hdl_sessions WHERE stop_requested=1 AND termination_confirmed=0').map(row=>checkedSession(tx,String(row.session_id))));
    for(const original of pending){
      try{const response=await options.transport({op:'hdl_stop',identity:original.identity});fields(response,['data','error']);if(response.error)continue;
        const fact=hdlSession.parse(response.data);if(canonical(fact.identity)!==canonical(original.identity)||!fact.terminationConfirmed)continue;
        options.db.withTransaction(tx=>{
          if(fact.identity.recoveryGeneration!==options.currentGeneration())throw new ApiError('RECOVERY_REQUIRED');
          const current=checkedSession(tx,original.sessionId);if(!current.stopRequested)return;
          saveSession(tx,{...fact,stopRequested:true});
          for(const row of tx.all('SELECT job_id FROM hdl_operations WHERE session_id=?',original.sessionId)){
            const job=readJobs(tx,original.identity.scope.courseId).find(item=>item.jobId===row.job_id)!;
            if(!terminal.has(job.status)){const next={...job,status:'cancelled' as const,stopRequested:true};saveJob(tx,next);progress(tx,next);}
          }
        });
      }catch(error){if(domainError(error,'DEPENDENCY_UNAVAILABLE').code==='PERSISTENCE_UNAVAILABLE')throw error;}
    }
  }
  async function processJob(jobId:string){
    const work=options.db.withTransaction(tx=>{
      const row=tx.get('SELECT * FROM jobs WHERE job_id=?',jobId);if(!row?.attempt_id)throw new ApiError('FORBIDDEN');
      const attempt=readAttempt(tx,String(row.attempt_id)),job=readJobs(tx,attempt.courseId).find(item=>item.jobId===jobId)!;
      if(!job.kind.startsWith('hdl_'))throw new ApiError('FORBIDDEN');generation(job.recoveryGeneration);
      if(terminal.has(job.status)||job.leaseUntil&&Date.parse(job.leaseUntil)>now())return undefined;
      const actor:ActorContext={userId:attempt.studentId,courseId:attempt.courseId,role:'student'};
      let valid=true;try{permitted(tx,actor,attempt.attemptId,true);valid=attempt.status==='active'&&assignmentAvailability(tx,attempt.courseId,attempt.assignmentId,attempt.studentId).active;}catch{valid=false;}
      let next=job;if(!valid||Date.parse(job.deadline)<=now())next=cancelJob(job);
      const dispatch=next.status==='queued';if(dispatch)next=claimJob(next,randomUUID(),new Date(Math.min(now()+120000,Date.parse(job.deadline))).toISOString(),options.currentGeneration(),new Date(now()).toISOString());
      else next={...next,leaseToken:randomUUID(),leaseUntil:new Date(now()+120000).toISOString()};saveJob(tx,next);
      const buildRow=tx.get('SELECT * FROM hdl_builds WHERE job_id=?',jobId),operationRow=tx.get('SELECT * FROM hdl_operations WHERE job_id=?',jobId);
      if(!buildRow&&!operationRow)throw new ApiError('INVALID_REFERENCE');
      return {attempt,actor,job:next,dispatch,buildRow,operationRow};
    });if(!work)return;
    const packet=checkedRequest<HdlBuildRequest|HdlProgram|HdlOperation>(work.buildRow??work.operationRow!,'request_json');
    const session=work.operationRow?options.db.withTransaction(tx=>checkedSession(tx,String(work.operationRow!.session_id))):undefined;
    if(session)scopeIdentity(session.identity,work.actor,work.attempt);
    let command:HdlCommand;
    if(work.job.stopRequested)command={op:'hdl_stop',identity:session?.identity??packet.identity};
    else if(work.dispatch)command=work.buildRow?{op:'hdl_build',request:packet as HdlBuildRequest}:work.job.kind==='hdl_program'?{op:'hdl_program',request:packet as HdlProgram}:{op:'hdl_interact',request:packet as HdlOperation};
    else command={op:'hdl_query',identity:session?.identity??packet.identity};
    try{
      const response=await options.transport(command);fields(response,['data','error']);if(response.error)throw new ApiError('DEPENDENCY_UNAVAILABLE');
      let fact=response.data;
      let result:unknown;
      if(session&&command.op==='hdl_interact'){
        const current=await options.transport({op:'hdl_query',identity:session.identity});fields(current,['data','error']);
        if(current.error||!Object.hasOwn(current,'data'))throw new ApiError('DEPENDENCY_UNAVAILABLE');fact=current.data;
      }
      if(session){const read=await options.transport({op:'hdl_result',identity:session.identity,operationId:work.job.kind==='hdl_program'?session.sessionId:String(work.operationRow!.operation_id)});
        fields(read,['data','error']);if(read.error)throw new ApiError('DEPENDENCY_UNAVAILABLE');result=read.data;}
      options.db.withTransaction(tx=>{
        generation(work.job.recoveryGeneration);const current=readJobs(tx,work.attempt.courseId).find(item=>item.jobId===jobId)!;
        if(current.leaseToken!==work.job.leaseToken||!current.leaseUntil||Date.parse(current.leaseUntil)<=now())throw new ApiError('STATE_CONFLICT');
        const attempt=readAttempt(tx,work.attempt.attemptId);let stopped=current.stopRequested||attempt.status!=='active'||!assignmentAvailability(tx,attempt.courseId,attempt.assignmentId,attempt.studentId).active;
        try{permitted(tx,work.actor,attempt.attemptId,true);}catch{stopped=true;}
        let next=current;
        if(work.buildRow&&fact){const build=hdlBuild.parse(fact);scopeIdentity(build.identity,work.actor,attempt);
          if(canonical(build.identity)!==canonical(packet.identity)||build.snapshotId!==(packet as HdlBuildRequest).snapshot.snapshotId||build.snapshotHash!==(packet as HdlBuildRequest).snapshot.hash
            ||canonical(build.board)!==canonical((packet as HdlBuildRequest).board))throw new ApiError('INVALID_REFERENCE');
          if(!['queued','running'].includes(build.status)){
            const text=JSON.stringify(build),old=tx.get('SELECT result_hash FROM hdl_builds WHERE build_id=?',build.buildId);
            if(old?.result_hash&&old.result_hash!==sha256(text))throw new ApiError('IDEMPOTENCY_CONFLICT');
            tx.run('UPDATE hdl_builds SET status=?,artifact_hash=?,build_json=?,result_hash=? WHERE build_id=?',build.status,build.artifactHash??null,text,sha256(text),build.buildId);
            next={...next,status:build.terminationConfirmed?(stopped?'cancelled':build.status==='succeeded'?'succeeded':'failed'):'outcome_unknown',resultRef:build.buildId,resultHash:sha256(text)};
          }
        }else if(session&&fact){const node=hdlSession.parse(fact);scopeIdentity(node.identity,work.actor,attempt);
          if(canonical(node.identity)!==canonical(session.identity)||node.buildId!==session.buildId||node.snapshotHash!==session.snapshotHash)throw new ApiError('INVALID_REFERENCE');
          const local=checkedSession(tx,session.sessionId);
          if(node.sessionRevision<local.sessionRevision||node.confirmedSequence<local.confirmedSequence)throw new ApiError('VERSION_CONFLICT');
          if(local.stopRequested){stopped=true;node.stopRequested=true;node.status=node.terminationConfirmed?node.status:'stopping';}
          if(result){const output=hdlResult.parse(result);const {resultHash,...body}=output;
            if(sha256(JSON.stringify(body))!==resultHash||output.sessionId!==session.sessionId||output.buildId!==session.buildId||output.snapshotHash!==session.snapshotHash
              ||output.sequence!==Number(work.operationRow!.sequence)||output.operationId!==(work.job.kind==='hdl_program'?session.sessionId:String(work.operationRow!.operation_id)))throw new ApiError('INVALID_REFERENCE');
            const text=JSON.stringify(output);tx.run('UPDATE hdl_operations SET status=?,result_json=?,result_hash=? WHERE operation_id=? AND (result_hash IS NULL OR result_hash=?)',
              stopped?'cancelled':'succeeded',text,sha256(text),String(work.operationRow!.operation_id),sha256(text));
            next={...next,status:stopped&&!node.terminationConfirmed?'cancelling':stopped?'cancelled':'succeeded',resultRef:String(work.operationRow!.operation_id),resultHash:sha256(text)};
          }else if(node.terminationConfirmed)next={...next,status:stopped?'cancelled':'failed'};
          saveSession(tx,node,terminal.has(next.status)?undefined:local.pendingOperationId);
        }
        next={...next,leaseUntil:new Date(now()).toISOString()};saveJob(tx,next);progress(tx,next);
      });
    }catch(error){if(['PERSISTENCE_UNAVAILABLE','RECOVERY_REQUIRED'].includes(domainError(error,'DEPENDENCY_UNAVAILABLE').code))throw error;
      options.db.withTransaction(tx=>{const current=readJobs(tx,work.attempt.courseId).find(item=>item.jobId===jobId)!;
        if(current.leaseToken===work.job.leaseToken&&!terminal.has(current.status))saveJob(tx,{...current,status:'outcome_unknown',leaseUntil:new Date(now()).toISOString()});});}
  }
  function readTrace(tx:Transaction,actor:ActorContext,sessionId:string,afterSequence=-1){
    readHdlSession(tx,actor,sessionId);
    if(!Number.isSafeInteger(afterSequence)||afterSequence< -1)throw new ApiError('INVALID_REQUEST');
    const row=tx.get('SELECT * FROM hdl_operations WHERE session_id=? AND sequence>? ORDER BY sequence LIMIT 1',sessionId,afterSequence);
    if(!row)return {operation:null,nextSequence:afterSequence};
    const body=row.result_json===null?null:hdlResult.parse(JSON.parse(String(row.result_json)));
    if(body&&(sha256(String(row.result_json))!==row.result_hash||body.sessionId!==sessionId||body.sequence!==row.sequence))throw new ApiError('INVALID_REFERENCE');
    return {operation:{operationId:String(row.operation_id),sequence:Number(row.sequence),status:String(row.status),result:body},nextSequence:Number(row.sequence)};
  }
  return {build,program,interact,processJob,readTrace,cancelInTransaction,reconcileStops,databaseFile:options.db.file,
    pendingJobs:()=>options.db.withTransaction(tx=>tx.all("SELECT job_id FROM jobs WHERE json_extract(job_json,'$.kind') LIKE 'hdl_%' AND status IN ('queued','running','outcome_unknown','cancelling')").map(row=>String(row.job_id))),
    stopInTransaction:stopHdlInTransaction,readBuild:readHdlBuild,readSession:readHdlSession};
}
