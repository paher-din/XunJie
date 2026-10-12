import {z} from 'zod';
import type {FastifyRequest} from 'fastify';
import {createTutoringApp,type TutoringAppOptions} from '../tutoring/application.ts';
import {createHdlWorkspace,type HdlTransport} from '../workspace/hdl.ts';
import {hdlConfigurationSchema,hdlRuntimeSchema} from '../../contracts/design/hdl.ts';
import {storeHdlConfiguration,fixedHdlRuntime,availableHdlRuntime,configurationHash} from '../design/hdl-configurations.ts';
import {readDraft,draftCourse} from '../design/storage.ts';
import {queryRuntime,availableRuntime} from '../design/readiness.ts';
import {readActivity,readAssignment} from '../design/activities.ts';
import {readAttempt,saveAttempt,finishRecordCommand,readRecordCommand,stopAttemptJobs} from '../db/records-adapter.ts';
import {parseRequest} from './validation.ts';
import {ApiError} from './errors.ts';
import {canonical} from '../records/commands.ts';
import type {Transaction} from '../db/transaction.ts';
import type {ActorContext} from '../../contracts/access/index.ts';
const id=z.string().min(1).max(128),revision=z.number().int().positive(),key=z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/),params=z.strictObject({id});
const generationInput={recoveryGeneration:id},basis={...generationInput,expectedAttemptRevision:revision};
const buildInput=z.strictObject({...basis,snapshotId:id});
const programInput=z.strictObject({...basis,buildId:id,replaceSessionId:id.optional(),expectedSessionRevision:revision.optional()}).refine(value=>(value.replaceSessionId===undefined)===(value.expectedSessionRevision===undefined));
const operationInput=z.strictObject({...basis,sessionId:id,expectedSessionRevision:revision,expectedSequence:revision,inputs:z.strictObject({switches:z.string().regex(/^[01]{16}$/),buttons:z.string().regex(/^[01]{5}$/),resetN:z.string().regex(/^[01]$/)}),advanceCycles:z.number().int().min(1).max(5000000)});
const stopInput=z.strictObject({...basis,action:z.literal('stop'),reason:z.string().trim().min(1).max(1024)});
export type DigitalLogicApplicationOptions=Omit<TutoringAppOptions,'currentGeneration'|'hdl'|'queryExecution'> & {hdlTransport:HdlTransport;approvedHdlRuntimes:z.infer<typeof hdlRuntimeSchema>[]};
export async function createDigitalLogicApplication(options:DigitalLogicApplicationOptions){
 const now=options.now??Date.now;
 // Read exactly once before any composed business transaction; callbacks never open nested SQL.
 const control=options.db.withTransaction(tx=>tx.get('SELECT * FROM application_control WHERE singleton=1'));
 if(!control||typeof control.recovery_generation!=='string'||!control.recovery_generation||Number(control.control_revision)<1)throw new ApiError('RECOVERY_REQUIRED');
 const generation=control.recovery_generation,currentGeneration=()=>generation;
 const approved=options.approvedHdlRuntimes.map(value=>hdlRuntimeSchema.parse(value));
 if(!approved.length)throw new ApiError('INVALID_CONFIGURATION');
 let accepting=true,latest:Awaited<ReturnType<typeof availableHdlRuntime>>|undefined;
 async function refresh(){latest=undefined;const result=await availableHdlRuntime(options.hdlTransport,approved);if(result.recoveryGeneration!==generation)throw new ApiError('RECOVERY_REQUIRED');latest=result;}
 await refresh();
 const cReady=await availableRuntime(options.runner);if(options.runner&&(!cReady||cReady.recoveryGeneration!==generation))throw new ApiError('RECOVERY_REQUIRED');
 const hdl=createHdlWorkspace({db:options.db,currentGeneration,transport:options.hdlTransport,...(options.now?{now:options.now}:{}),refreshProfile:refresh,
 approvedProfile(tx,attemptId){if(!accepting||!latest)return undefined;const attempt=readAttempt(tx,attemptId),runtime=readActivity(tx,attempt.courseId,attempt.activityVersionId).runtimeProfile;
 if(!('kind' in runtime)||canonical(runtime.configuration.runtime)!==canonical(latest.profile)||runtime.contentHash!==configurationHash(runtime.configuration))return undefined;
 return {board:runtime.configuration.board,runtime:runtime.configuration.runtime};}});
 const instance=await createTutoringApp({...options,currentGeneration,hdl,checkReadiness:async()=>{if(!accepting)return false;try{await refresh();const c=await availableRuntime(options.runner);return !options.runner||Boolean(c&&c.recoveryGeneration===generation);}catch{return false;}},async queryExecution(request,blueprintId){
 const fixed=instance.access.withAuthorizedCourse(request,tx=>draftCourse(tx,blueprintId),'teacher',(tx,actor)=>{
  const draft=readDraft(tx,actor.courseId,blueprintId);return draft.content.digitalLogicConfigVersionId?fixedHdlRuntime(tx,actor.courseId,draft.content.digitalLogicConfigVersionId):undefined;
 },false);
 if(!fixed)return queryRuntime(options.runner);
 try{const ready=await availableHdlRuntime(options.hdlTransport,approved);if(ready.recoveryGeneration!==generation)throw new ApiError('RECOVERY_REQUIRED');
 if(canonical(fixed.configuration.runtime)!==canonical(ready.profile))throw new ApiError('INVALID_REFERENCE');return {ok:true as const,runtime:{...ready,profile:fixed}};
 }catch(error){return {ok:false as const,error};}
 }});
 const {app,access}=instance;
 const locate=(tx:Transaction,attemptId:string)=>{const attempt=readAttempt(tx,attemptId);return {kind:'student_work' as const,courseId:attempt.courseId,studentId:attempt.studentId,stage:attempt.status,assignmentActive:false};};
 const scope=(request:FastifyRequest,attemptId:string)=>access.withAuthorizedResource(request,tx=>locate(tx,attemptId),'read',(_tx,actor)=>actor);
 const guard=(request:FastifyRequest,attemptId:string)=>(tx:Transaction,use:'read'|'write')=>{
 if(!accepting&&use==='write')throw new ApiError('DEPENDENCY_UNAVAILABLE');return access.authorizeResourceInTransaction(request,tx,t=>locate(t,attemptId),use);
 };
 const requireGeneration=(expected:string)=>{if(expected!==generation)throw new ApiError('RECOVERY_REQUIRED');return generation;};
 app.addHook('preHandler',async request=>{if(request.method==='POST'&&/^\/api\/attempts\/[^/]+\/help$/.test(request.url.split('?',1)[0]!))throw new ApiError('DEPENDENCY_UNAVAILABLE');if(!accepting&&!['GET','HEAD','OPTIONS'].includes(request.method))throw new ApiError('DEPENDENCY_UNAVAILABLE');});
 app.get('/api/courses',request=>({requestId:request.id,data:options.db.withTransaction(tx=>{
 const userId=access.authenticatedUserInTransaction(request,tx);
 return tx.all('SELECT course_id,role FROM course_memberships WHERE user_id=? AND active=1 ORDER BY course_id',userId).map(row=>({courseId:String(row.course_id),role:row.role}));
 })}));
 app.get('/api/courses/:id/assignments',request=>{const courseId=parseRequest(params,request.params).id;return {requestId:request.id,data:access.withAuthorizedCourse(request,courseId,undefined,(tx,actor)=>{
 const rows=actor.role==='teacher'?tx.all('SELECT id FROM assignments WHERE course_id=? ORDER BY id',courseId):tx.all('SELECT id FROM assignments WHERE course_id=? AND student_id=? ORDER BY id',courseId,actor.userId);
 return rows.map(row=>{const assignment=readAssignment(tx,courseId,String(row.id)),activity=readActivity(tx,courseId,assignment.activity_id),control=tx.get('SELECT status FROM activity_controls WHERE activity_id=?',assignment.activity_id),member=tx.get('SELECT m.active,u.disabled_at_ms FROM course_memberships m JOIN users u ON u.id=m.user_id WHERE m.course_id=? AND m.user_id=?',courseId,assignment.student_id);
 return {assignmentId:assignment.id,studentId:assignment.student_id,activityVersionId:assignment.activity_id,assignmentRevision:assignment.assignment_revision,active:assignment.status==='active'&&control?.status==='active'&&member?.active===1&&member.disabled_at_ms===null,executionKind:'kind' in activity.runtimeProfile?'hdl_board':'textscope',runtimeProfileVersion:activity.runtimeProfile.runtimeProfileVersion};});
 })};});
 app.post('/api/courses/:id/hdl-configurations',request=>{const courseId=parseRequest(params,request.params).id,input=parseRequest(z.strictObject({...generationInput,configuration:hdlConfigurationSchema}),request.body),idempotencyKey=parseRequest(key,request.headers['idempotency-key']);
 const data=access.withAuthorizedCourse(request,courseId,'teacher',(tx,actor)=>finishRecordCommand(tx,{actorId:actor.userId,command:'hdl.configuration',target:courseId,scope:{courseId},idempotencyKey,recoveryGeneration:requireGeneration(input.recoveryGeneration)},input,generation,now(),()=>storeHdlConfiguration(tx,actor,input.configuration,approved,now()),value=>{
 const ack=z.strictObject({configuration:hdlConfigurationSchema,contentHash:z.string()}).parse(value),stored=fixedHdlRuntime(tx,courseId,ack.configuration.versionId);if(canonical(ack.configuration)!==canonical(stored.configuration)||ack.contentHash!==stored.contentHash)throw new ApiError('INVALID_REFERENCE');return ack;
 }));return {requestId:request.id,data};});
 app.post('/api/attempts/:id/hdl/builds',async request=>{const attemptId=parseRequest(params,request.params).id,input=parseRequest(buildInput,request.body),actor=scope(request,attemptId),idempotencyKey=parseRequest(key,request.headers['idempotency-key']);
 // Read replay in the same C transaction; fresh readiness is consulted only for a new command.
 const previous=options.db.withTransaction(tx=>{guard(request,attemptId)(tx,'read');const attempt=readAttempt(tx,attemptId);return readRecordCommand(tx,{actorId:actor.userId,command:'hdl.build',target:attemptId,scope:{courseId:attempt.courseId,studentId:attempt.studentId,attemptId},idempotencyKey,recoveryGeneration:requireGeneration(input.recoveryGeneration)},{expectedAttemptRevision:input.expectedAttemptRevision,snapshotId:input.snapshotId},generation,value=>z.strictObject({buildId:id,jobId:id}).parse(value));});
 if(!previous)await refresh();return {requestId:request.id,data:hdl.build(actor,attemptId,idempotencyKey,input.recoveryGeneration,{expectedAttemptRevision:input.expectedAttemptRevision,snapshotId:input.snapshotId},guard(request,attemptId))};});
 app.post('/api/attempts/:id/hdl/programs',async request=>{const attemptId=parseRequest(params,request.params).id,{recoveryGeneration,...input}=parseRequest(programInput,request.body),actor=scope(request,attemptId);return {requestId:request.id,data:await hdl.program(actor,attemptId,parseRequest(key,request.headers['idempotency-key']),recoveryGeneration,JSON.parse(JSON.stringify(input)),guard(request,attemptId))};});
 app.post('/api/attempts/:id/hdl/interactions',async request=>{const attemptId=parseRequest(params,request.params).id,{recoveryGeneration,...input}=parseRequest(operationInput,request.body),actor=scope(request,attemptId),idempotencyKey=parseRequest(key,request.headers['idempotency-key']);
 const previous=options.db.withTransaction(tx=>{guard(request,attemptId)(tx,'read');const attempt=readAttempt(tx,attemptId);return readRecordCommand(tx,{actorId:actor.userId,command:'hdl.interact',target:attemptId,scope:{courseId:attempt.courseId,studentId:attempt.studentId,attemptId},idempotencyKey,recoveryGeneration:requireGeneration(recoveryGeneration)},input,generation,value=>z.strictObject({sessionId:id,operationId:id,jobId:id}).parse(value));});
 if(!previous)await refresh();return {requestId:request.id,data:hdl.interact(actor,attemptId,idempotencyKey,recoveryGeneration,JSON.parse(JSON.stringify(input)),guard(request,attemptId))};});
 app.post('/api/attempts/:id/hdl/controls',async request=>{const attemptId=parseRequest(params,request.params).id,input=parseRequest(stopInput,request.body),idempotencyKey=parseRequest(key,request.headers['idempotency-key']);
 const data=options.db.withTransaction(tx=>{const actor=guard(request,attemptId)(tx,'read'),attempt=readAttempt(tx,attemptId);if(actor.role!=='student')throw new ApiError('FORBIDDEN');return finishRecordCommand(tx,{actorId:actor.userId,command:'hdl.stop',target:attemptId,scope:{courseId:actor.courseId,studentId:actor.userId,attemptId},idempotencyKey,recoveryGeneration:requireGeneration(input.recoveryGeneration)},input,generation,now(),()=>{
 guard(request,attemptId)(tx,'write');if(attempt.attemptRevision!==input.expectedAttemptRevision)throw new ApiError('VERSION_CONFLICT');hdl.stopInTransaction(tx,attemptId,input.reason,generation);saveAttempt(tx,{...attempt,attemptRevision:attempt.attemptRevision+1,decisionEpoch:attempt.decisionEpoch+1});return {attemptId,stopRequested:true};
 },value=>z.strictObject({attemptId:id,stopRequested:z.literal(true)}).parse(value));});await hdl.reconcileStops();return {requestId:request.id,data};});
 function readHdl<T>(request:FastifyRequest,kind:'build'|'session',work:(tx:Transaction,actor:ActorContext,id:string)=>T){const target=parseRequest(params,request.params).id;return access.withAuthorizedResource(request,tx=>{
 const row=tx.get(kind==='build'?'SELECT attempt_id FROM hdl_builds WHERE build_id=?':'SELECT attempt_id FROM hdl_sessions WHERE session_id=?',target);if(!row)throw new ApiError('FORBIDDEN');return locate(tx,String(row.attempt_id));
 },'read',(tx,actor)=>work(tx,actor,target));}
 app.get('/api/hdl/builds/:id',request=>({requestId:request.id,data:readHdl(request,'build',(tx,actor,target)=>hdl.readBuild(tx,actor,target))}));
 app.get('/api/hdl/sessions/:id',request=>({requestId:request.id,data:readHdl(request,'session',(tx,actor,target)=>hdl.readSession(tx,actor,target))}));
 app.get('/api/hdl/sessions/:id/trace',request=>{const query=parseRequest(z.strictObject({afterSequence:z.string().regex(/^(?:-1|0|[1-9][0-9]*)$/).default('-1')}),request.query);return {requestId:request.id,data:readHdl(request,'session',(tx,actor,target)=>hdl.readTrace(tx,actor,target,Number(query.afterSequence)))};});
 function deactivateMembership(tx:Transaction,courseId:string,userId:string){
 const member=tx.get('SELECT role FROM course_memberships WHERE course_id=? AND user_id=?',courseId,userId);if(!member)throw new ApiError('FORBIDDEN');
 tx.run('UPDATE course_memberships SET active=0 WHERE course_id=? AND user_id=?',courseId,userId);
 for(const row of tx.all('SELECT attempt_id FROM attempts WHERE course_id=? AND student_id=?',courseId,userId)){const attempt=readAttempt(tx,String(row.attempt_id));const stopped=stopAttemptJobs(tx,attempt,['student_run','student_help']);instance.workspace.teaching.stopTeaching?.(tx,courseId,userId,stopped,{reason:'membership_revoked',generation,now:new Date(now()).toISOString()});saveAttempt(tx,{...attempt,attemptRevision:attempt.attemptRevision+1,decisionEpoch:attempt.decisionEpoch+1});hdl.stopInTransaction(tx,attempt.attemptId,'membership_revoked',generation);}
 }
 function disableUser(tx:Transaction,userId:string){if(!tx.get('SELECT id FROM users WHERE id=?',userId))throw new ApiError('FORBIDDEN');tx.run('UPDATE users SET disabled_at_ms=? WHERE id=?',now(),userId);
 for(const row of tx.all('SELECT course_id FROM course_memberships WHERE user_id=?',userId))deactivateMembership(tx,String(row.course_id),userId);
 }
 let consuming:Promise<void>|undefined,timer:ReturnType<typeof setInterval>|undefined;
 async function consumeOnce(){if(consuming)return consuming;consuming=(async()=>{for(const jobId of instance.workspace.pendingJobs())await instance.workspace.processJob(jobId);
 if(instance.teacherAgent){const jobs=options.db.withTransaction(tx=>tx.all("SELECT job_id FROM jobs WHERE purpose='teacher_design' AND status IN ('queued','running','outcome_unknown','cancelling')").map(row=>String(row.job_id)));for(const jobId of jobs)await instance.teacherAgent.processJob(jobId);}
 await hdl.reconcileStops();})();try{await consuming;}finally{consuming=undefined;}}
 function startConsumer(intervalMs=250){if(!Number.isInteger(intervalMs)||intervalMs<50||intervalMs>10000)throw new ApiError('INVALID_CONFIGURATION');if(timer)return;if(!accepting)throw new ApiError('DEPENDENCY_UNAVAILABLE');timer=setInterval(()=>{void consumeOnce().catch(()=>{accepting=false;});},intervalMs);timer.unref();}
 async function shutdown(){
  accepting=false;if(timer){clearInterval(timer);timer=undefined;}
  try{
   options.db.withTransaction(tx=>{
    const ids=new Set([...tx.all('SELECT DISTINCT attempt_id FROM hdl_sessions WHERE termination_confirmed=0'),...tx.all("SELECT DISTINCT attempt_id FROM jobs WHERE purpose='student_run' AND status IN ('queued','running','outcome_unknown','cancelling')")].map(row=>String(row.attempt_id)));
    for(const id of ids){const attempt=readAttempt(tx,id);stopAttemptJobs(tx,attempt,['student_run']);hdl.stopInTransaction(tx,id,'application_shutdown',generation);saveAttempt(tx,{...attempt,attemptRevision:attempt.attemptRevision+1,decisionEpoch:attempt.decisionEpoch+1});}
   });
   await hdl.reconcileStops();if(consuming)await consuming;
   await consumeOnce();await hdl.reconcileStops();
  }finally{await app.close();}
 }

 app.addHook('onReady',async()=>{await consumeOnce();});
 return {...instance,hdl,currentGeneration,consumeOnce,startConsumer,shutdown,management:{deactivateMembershipInTransaction:deactivateMembership,disableUserInTransaction:disableUser},isAccepting:()=>accepting};
}
