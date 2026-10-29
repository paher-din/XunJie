import {assertDigitalLogicApplicationDatabase} from '../db/transaction.ts';
import {attachOriginalJobHost,guardHostTransport} from './original-job-host.ts';
import { originalTeachingConsumer } from './original-teaching-host.ts';
import { readAuthorizedHdlHelp } from '../workspace/hdl-help.ts';
import type { ModelProvider } from '../tutoring/providers.ts';
import {z} from 'zod';
import type {FastifyRequest} from 'fastify';
import {createTutoringApp,type TutoringAppOptions} from '../tutoring/application.ts';
import {createReviewApp,type ReviewAppOptions} from '../review/application.ts';
import {registerTeacherWorkbench} from './teacher-workbench.ts';
import {createHdlWorkspace,type HdlTransport} from '../workspace/hdl.ts';
import {hdlConfigurationSchema,hdlRuntimeSchema} from '../../contracts/design/hdl.ts';
import {storeHdlConfiguration,fixedHdlRuntime,availableHdlRuntime,configurationHash} from '../design/hdl-configurations.ts';
import {readDraft,draftCourse} from '../design/storage.ts';
import {queryRuntime,availableRuntime} from '../design/readiness.ts';
import {readActivity,readAssignment} from '../design/activities.ts';
import {readAttempt,saveAttempt,finishRecordCommand,readRecordCommand,stopAttemptJobs,saveJob} from '../db/records-adapter.ts';
import {cancelJob} from '../records/jobs.ts';
import {MODEL_QUEUE_LIMITS} from '../personal-agent/model-budget.ts';
import {loadTeacherRequest} from '../design/teacher-storage.ts';
import {parseRequest} from './validation.ts';
import {ApiError} from './errors.ts';
import {canonical} from '../records/commands.ts';
import type {Transaction} from '../db/transaction.ts';
import type {ActorContext} from '../../contracts/access/index.ts';
import {courseMembershipViewSchema} from '../../contracts/access/index.ts';
import {assignmentSummarySchema} from '../../contracts/design/results.ts';
import {hasDisplayColumn,optionalDisplayText} from '../access/display-text.ts';
import {personalModels,type PersonalModelsOptions,teacherDesignAgentOptions} from './personal-models.ts';
import type {TeacherDesignApproval} from './config.ts';
import {executionNodes,type ExecutionNode} from './execution-nodes.ts';
import type {ExecutionBinding} from '../../contracts/records/index.ts';
const id=z.string().min(1).max(128),revision=z.number().int().positive(),key=z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/),params=z.strictObject({id});
const generationInput={recoveryGeneration:id},basis={...generationInput,expectedAttemptRevision:revision};
const buildInput=z.strictObject({...basis,snapshotId:id});
const programInput=z.strictObject({...basis,buildId:id,replaceSessionId:id.optional(),expectedSessionRevision:revision.optional()}).refine(value=>(value.replaceSessionId===undefined)===(value.expectedSessionRevision===undefined));
const operationInput=z.strictObject({...basis,sessionId:id,expectedSessionRevision:revision,expectedSequence:revision,inputs:z.strictObject({switches:z.string().regex(/^[01]{16}$/),buttons:z.string().regex(/^[01]{5}$/),resetN:z.string().regex(/^[01]$/)}),advanceCycles:z.number().int().min(1).max(5000000)});
const stopInput=z.strictObject({...basis,action:z.literal('stop'),reason:z.string().trim().min(1).max(1024)});
export type DigitalLogicApplicationOptions=Omit<TutoringAppOptions,'currentGeneration'|'hdl'|'queryExecution'|'execution'> & {hdlTransport?:HdlTransport;executionNodes?:ExecutionNode[];legacyExecutionNodeId?:string;approvedHdlRuntimes:z.infer<typeof hdlRuntimeSchema>[];staticDirectory?:string;consumerIntervalMs?:number;tutoringProvider?:ModelProvider;personalModels?:PersonalModelsOptions;teacherDesign?:TeacherDesignApproval;review?:ReviewAppOptions['review']};
export async function createDigitalLogicApplication(options:DigitalLogicApplicationOptions){
 assertDigitalLogicApplicationDatabase(options.db,Boolean(options.review));
 const now=options.now??Date.now;
 // Read exactly once before any composed business transaction; callbacks never open nested SQL.
 const control=options.db.withTransaction(tx=>tx.get('SELECT * FROM application_control WHERE singleton=1'));
 if(!control||typeof control.recovery_generation!=='string'||!control.recovery_generation||Number(control.control_revision)<1)throw new ApiError('RECOVERY_REQUIRED');
 const generation=control.recovery_generation,currentGeneration=()=>generation;
 const approved=options.approvedHdlRuntimes.map(value=>hdlRuntimeSchema.parse(value));
 if(!approved.length)throw new ApiError('INVALID_CONFIGURATION');
 const admission={accepting:true};
 if(options.executionNodes&&(options.runner||options.hdlTransport)||!options.executionNodes&&!options.hdlTransport)throw new ApiError('INVALID_CONFIGURATION');
 const execution=options.executionNodes?executionNodes(options.executionNodes.map(node=>({...node,
  runner:guardHostTransport(node.runner,admission,{dispatch:['submit','editor_diagnostics'],readiness:'readiness'}),
  hdlTransport:guardHostTransport(node.hdlTransport,admission,{dispatch:['hdl_build','hdl_program','hdl_interact'],readiness:'hdl_readiness'}),
 })),options.legacyExecutionNodeId):undefined;
 const hdlTransport:HdlTransport=guardHostTransport(async command=>{
  if(!execution)return options.hdlTransport!(command);
  if(command.op==='hdl_readiness')throw new ApiError('RUNTIME_NOT_READY');
  const identity='identity' in command?command.identity:command.request.identity;
  const binding=options.db.withTransaction(tx=>execution.forHdl(tx,identity.id));
  if(identity.recoveryGeneration!==binding.nodeGeneration)throw new ApiError('RECOVERY_REQUIRED');
  return execution.node(binding).hdlTransport(command);
 },admission,{dispatch:['hdl_build','hdl_program','hdl_interact'],readiness:'hdl_readiness'});
 let latest:Awaited<ReturnType<typeof availableHdlRuntime>>|undefined;
 const profiles=new Map<string,NonNullable<typeof latest>>();
 async function refresh(binding?:ExecutionBinding){
  if(binding)profiles.delete(binding.nodeId);else latest=undefined;
  if(!admission.accepting)throw new ApiError('DEPENDENCY_UNAVAILABLE');
  if(execution&&!binding)throw new ApiError('RUNTIME_NOT_READY');
  const result=await availableHdlRuntime(binding?execution!.node(binding).hdlTransport:hdlTransport,approved);
  if(!admission.accepting)throw new ApiError('DEPENDENCY_UNAVAILABLE');
  if(result.recoveryGeneration!==(binding?.nodeGeneration??generation))throw new ApiError('RECOVERY_REQUIRED');
  if(binding)profiles.set(binding.nodeId,result);else latest=result;
 }
 if(!execution){await refresh();const cReady=await availableRuntime(options.runner);if(options.runner&&(!cReady||cReady.recoveryGeneration!==generation))throw new ApiError('RECOVERY_REQUIRED');}
 const hdl=createHdlWorkspace({db:options.db,currentGeneration,transport:hdlTransport,...(execution?{execution}:{}),...(options.now?{now:options.now}:{}),refreshProfile:refresh,
 approvedProfile(tx,attemptId,binding){const profile=binding?profiles.get(binding.nodeId):latest;if(!admission.accepting||!profile)return undefined;const attempt=readAttempt(tx,attemptId),runtime=readActivity(tx,attempt.courseId,attempt.activityVersionId).runtimeProfile;
 if(!('kind' in runtime)||canonical(runtime.configuration.runtime)!==canonical(profile.profile)||runtime.contentHash!==configurationHash(runtime.configuration))return undefined;
 return {board:runtime.configuration.board,runtime:runtime.configuration.runtime};}});
 const runner=options.runner?guardHostTransport(options.runner,admission,{dispatch:['submit','editor_diagnostics'],readiness:'readiness'}):undefined;
 let host:ReturnType<typeof attachOriginalJobHost>;
 const compose=(base:TutoringAppOptions)=>options.review?createReviewApp({...base,review:options.review}):createTutoringApp(base);
 const personal:ReturnType<typeof personalModels>|undefined=options.personalModels?personalModels(options.personalModels,
  (request):string=>options.db.withTransaction(tx=>instance.access.authenticatedUserInTransaction(request,tx)),options.studentHelp,options.db):undefined;
 const teacherDesignAgent=personal&&options.teacherDesign
  ?{
    // The approved personal model replaces the static provider for this teacher, gated by the separate,
    // default-off approval. The static fields stay present so the original behaviour remains the fallback.
    ...(options.teacherAgent??{provider:{generate:async()=>{throw new Error('Model unavailable.');}},
      versions:{modelConfig:'personal-unconfigured',prompt:'teacher-design-v1',schema:'teacher-design-v1',policy:'teacher-design-v1'},
      budgetAvailable:()=>false}),
    ...teacherDesignAgentOptions({service:personal,transport:personal.transport,
      personalCallsEnabled:()=>options.personalModels?.callsEnabled!==false,
      approval:{allowedTeacherIds:options.teacherDesign.allowedTeacherIds,allowedCourseIds:options.teacherDesign.allowedCourseIds,
        maximumCallsPerRequest:options.teacherDesign.maximumCallsPerRequest,maximumCallsPerRound:options.teacherDesign.maximumCallsPerRound,
        maximumOutputTokens:options.teacherDesign.maximumOutputTokens,roundStartsAtMs:Date.parse(options.teacherDesign.roundStartsAt)}})}
  :options.teacherAgent;
 const instance:Awaited<ReturnType<typeof compose>>=await compose({...options,...(teacherDesignAgent?{teacherAgent:teacherDesignAgent}:{}),studentHelp:{...(personal?.studentHelp??options.studentHelp),readHdlContext:(...args)=>{
  if(!admission.accepting)throw new ApiError('DEPENDENCY_UNAVAILABLE');return readAuthorizedHdlHelp(...args);
 }},...(runner?{runner}:{}),...(execution?{execution}:{}),currentGeneration,hdl,checkReadiness:async()=>{try{host.checkConsumerReady();if(execution)return true;await refresh();const c=await availableRuntime(runner);host.checkConsumerReady();return !options.runner||Boolean(c&&c.recoveryGeneration===generation);}catch{return false;}},async queryExecution(request,blueprintId){
 const fixed=instance.access.withAuthorizedCourse(request,tx=>draftCourse(tx,blueprintId),'teacher',(tx,actor)=>{
  const draft=readDraft(tx,actor.courseId,blueprintId);return draft.content.digitalLogicConfigVersionId?fixedHdlRuntime(tx,actor.courseId,draft.content.digitalLogicConfigVersionId):undefined;
 },false);
 const binding=execution?.selected(request);
 if(!fixed){const result=await queryRuntime(binding?execution!.node(binding).runner:runner);if(binding&&result.ok&&result.runtime){if(result.runtime.recoveryGeneration!==binding.nodeGeneration)throw new ApiError('RECOVERY_REQUIRED');return {ok:true as const,runtime:{...result.runtime,execution:binding}};}return result;}
 try{const ready=await availableHdlRuntime(binding?execution!.node(binding).hdlTransport:hdlTransport,approved);if(ready.recoveryGeneration!==(binding?.nodeGeneration??generation))throw new ApiError('RECOVERY_REQUIRED');
 if(canonical(fixed.configuration.runtime)!==canonical(ready.profile))throw new ApiError('INVALID_REFERENCE');return {ok:true as const,runtime:{...ready,profile:fixed,...(binding?{execution:binding}:{})}};
 }catch(error){return {ok:false as const,error};}
 }}).catch(async error=>{await personal?.close();throw error;});
 const {app,access}=instance;
 app.get('/api/execution-nodes',async request=>{
  options.db.withTransaction(tx=>access.authenticatedUserInTransaction(request,tx));
  async function probe(read:()=>Promise<boolean>){
   let timer:ReturnType<typeof setTimeout>|undefined;
   try{return await Promise.race([read(),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),4000);})]);}
   catch{return false;}finally{if(timer)clearTimeout(timer);}
  }
  const nodes=await Promise.all((execution?.nodes??[]).map(async node=>{
   const [cReady,hdlReady]=await Promise.all([
    probe(async()=>{const ready=await availableRuntime(node.runner);return Boolean(ready&&ready.recoveryGeneration===node.recoveryGeneration);}),
    probe(async()=>(await availableHdlRuntime(node.hdlTransport,approved)).recoveryGeneration===node.recoveryGeneration),
   ]);
   return {nodeId:node.nodeId,label:node.label,cReady,hdlReady};
  }));
  const selected=request.headers['x-xunjie-execution-node'];
  return {requestId:request.id,data:{nodes,...(typeof selected==='string'&&nodes.some(node=>node.nodeId===selected)?{selectedNodeId:selected}:{})}};
 });
 if(personal){personal.register(app);app.addHook('onClose',async()=>personal.close());}
 if(options.review)registerTeacherWorkbench(app,access,currentGeneration);
 const locate=(tx:Transaction,attemptId:string)=>{const attempt=readAttempt(tx,attemptId);return {kind:'student_work' as const,courseId:attempt.courseId,studentId:attempt.studentId,stage:attempt.status,assignmentActive:false};};
 const scope=(request:FastifyRequest,attemptId:string)=>access.withAuthorizedResource(request,tx=>locate(tx,attemptId),'read',(_tx,actor)=>actor);
 const guard=(request:FastifyRequest,attemptId:string)=>(tx:Transaction,use:'read'|'write')=>{
 if(!admission.accepting&&use==='write')throw new ApiError('DEPENDENCY_UNAVAILABLE');return access.authorizeResourceInTransaction(request,tx,t=>locate(t,attemptId),use);
 };
 const requireGeneration=(expected:string)=>{if(expected!==generation)throw new ApiError('RECOVERY_REQUIRED');return generation;};
 app.addHook('preHandler',async request=>{if(!admission.accepting&&!['GET','HEAD','OPTIONS'].includes(request.method))throw new ApiError('DEPENDENCY_UNAVAILABLE');});
 app.get('/api/courses',request=>({requestId:request.id,data:options.db.withTransaction(tx=>{
 const userId=access.authenticatedUserInTransaction(request,tx);
 const courseName=hasDisplayColumn(tx,'courses','name')?'c.name':'NULL AS name';
 return tx.all(`SELECT m.course_id,m.role,${courseName} FROM course_memberships m JOIN courses c ON c.id=m.course_id WHERE m.user_id=? AND m.active=1 ORDER BY m.course_id`,userId).map(row=>{
 const name=optionalDisplayText(row.name);return courseMembershipViewSchema.parse({courseId:String(row.course_id),role:row.role,...(name?{name}:{})});});
 })}));
 app.get('/api/courses/:id/assignments',request=>{const courseId=parseRequest(params,request.params).id;return {requestId:request.id,data:access.withAuthorizedCourse(request,courseId,undefined,(tx,actor)=>{
 const rows=actor.role==='teacher'?tx.all('SELECT id FROM assignments WHERE course_id=? ORDER BY id',courseId):tx.all('SELECT id FROM assignments WHERE course_id=? AND student_id=? ORDER BY id',courseId,actor.userId);
 return rows.map(row=>{const assignment=readAssignment(tx,courseId,String(row.id)),activity=readActivity(tx,courseId,assignment.activity_id),control=tx.get('SELECT status FROM activity_controls WHERE activity_id=?',assignment.activity_id),member=tx.get('SELECT m.active,u.disabled_at_ms FROM course_memberships m JOIN users u ON u.id=m.user_id WHERE m.course_id=? AND m.user_id=?',courseId,assignment.student_id);
 const displayTitle=optionalDisplayText(assignment.display_title);
 return assignmentSummarySchema.parse({assignmentId:assignment.id,studentId:assignment.student_id,activityVersionId:assignment.activity_id,assignmentRevision:assignment.assignment_revision,active:assignment.status==='active'&&control?.status==='active'&&member?.active===1&&member.disabled_at_ms===null,executionKind:'kind' in activity.runtimeProfile?'hdl_board':'textscope',runtimeProfileVersion:activity.runtimeProfile.runtimeProfileVersion,...(displayTitle?{displayTitle}:{})});});
 })};});
 app.post('/api/courses/:id/hdl-configurations',request=>{const courseId=parseRequest(params,request.params).id,input=parseRequest(z.strictObject({...generationInput,configuration:hdlConfigurationSchema}),request.body),idempotencyKey=parseRequest(key,request.headers['idempotency-key']);
 const data=access.withAuthorizedCourse(request,courseId,'teacher',(tx,actor)=>finishRecordCommand(tx,{actorId:actor.userId,command:'hdl.configuration',target:courseId,scope:{courseId},idempotencyKey,recoveryGeneration:requireGeneration(input.recoveryGeneration)},input,generation,now(),()=>storeHdlConfiguration(tx,actor,input.configuration,approved,now()),value=>{
 const ack=z.strictObject({configuration:hdlConfigurationSchema,contentHash:z.string()}).parse(value),stored=fixedHdlRuntime(tx,courseId,ack.configuration.versionId);if(canonical(ack.configuration)!==canonical(stored.configuration)||ack.contentHash!==stored.contentHash)throw new ApiError('INVALID_REFERENCE');return ack;
 }));return {requestId:request.id,data};});
 app.post('/api/attempts/:id/hdl/builds',async request=>{const attemptId=parseRequest(params,request.params).id,input=parseRequest(buildInput,request.body),actor=scope(request,attemptId),idempotencyKey=parseRequest(key,request.headers['idempotency-key']);
 // Read replay in the same C transaction; fresh readiness is consulted only for a new command.
 const previous=options.db.withTransaction(tx=>{guard(request,attemptId)(tx,'read');const attempt=readAttempt(tx,attemptId);return readRecordCommand(tx,{actorId:actor.userId,command:'hdl.build',target:attemptId,scope:{courseId:attempt.courseId,studentId:attempt.studentId,attemptId},idempotencyKey,recoveryGeneration:requireGeneration(input.recoveryGeneration)},{expectedAttemptRevision:input.expectedAttemptRevision,snapshotId:input.snapshotId},generation,value=>z.strictObject({buildId:id,jobId:id}).parse(value));});
 const binding=previous?undefined:execution?.selected(request);
 if(!previous)await refresh(binding);return {requestId:request.id,data:hdl.build(actor,attemptId,idempotencyKey,input.recoveryGeneration,{expectedAttemptRevision:input.expectedAttemptRevision,snapshotId:input.snapshotId},guard(request,attemptId),binding)};});
 app.post('/api/attempts/:id/hdl/programs',async request=>{const attemptId=parseRequest(params,request.params).id,{recoveryGeneration,...input}=parseRequest(programInput,request.body),actor=scope(request,attemptId);return {requestId:request.id,data:await hdl.program(actor,attemptId,parseRequest(key,request.headers['idempotency-key']),recoveryGeneration,JSON.parse(JSON.stringify(input)),guard(request,attemptId))};});
 app.post('/api/attempts/:id/hdl/interactions',async request=>{const attemptId=parseRequest(params,request.params).id,{recoveryGeneration,...input}=parseRequest(operationInput,request.body),actor=scope(request,attemptId),idempotencyKey=parseRequest(key,request.headers['idempotency-key']);
 const previous=options.db.withTransaction(tx=>{guard(request,attemptId)(tx,'read');const attempt=readAttempt(tx,attemptId);return readRecordCommand(tx,{actorId:actor.userId,command:'hdl.interact',target:attemptId,scope:{courseId:attempt.courseId,studentId:attempt.studentId,attemptId},idempotencyKey,recoveryGeneration:requireGeneration(recoveryGeneration)},input,generation,value=>z.strictObject({sessionId:id,operationId:id,jobId:id}).parse(value));});
 if(!previous){const binding=execution?options.db.withTransaction(tx=>{guard(request,attemptId)(tx,'read');hdl.readSession(tx,actor,input.sessionId);return execution.forHdl(tx,input.sessionId);}):undefined;await refresh(binding);}return {requestId:request.id,data:hdl.interact(actor,attemptId,idempotencyKey,recoveryGeneration,JSON.parse(JSON.stringify(input)),guard(request,attemptId))};});
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

 const teaching=originalTeachingConsumer(instance,{...options,currentGeneration},options.tutoringProvider??{
  generate:async()=>{throw new ApiError('DEPENDENCY_UNAVAILABLE');},
 },admission);
 const teacherTasks=new Map<string,{actorId:string;controller:AbortController;task:Promise<unknown>}>();
 // Submit enough distinct teachers for the shared budget to select runnable work, without
 // retaining an unbounded batch or filling its wait queue with a single busy member.
 const teacherTaskLimit=MODEL_QUEUE_LIMITS.active+MODEL_QUEUE_LIMITS.waiting;
 function stopTeacherJobs(tx:Transaction){
  for(const row of tx.all("SELECT job_id FROM jobs WHERE purpose='teacher_design' AND status IN ('queued','running','outcome_unknown','cancelling')"))
   saveJob(tx,cancelJob(loadTeacherRequest(tx,String(row.job_id)).job));
 }
 app.addHook('preClose',async()=>{
  try {options.db.withTransaction(stopTeacherJobs);}
  finally {for(const {controller} of teacherTasks.values())controller.abort();}
 });
 try {host=attachOriginalJobHost(instance,{...options,currentGeneration},{
  admission,
  startAdditional:teaching.start,
  additionalReady:teaching.isHealthy,
  async consumeAdditional(){
   if(instance.teacherAgent&&admission.accepting){
    const jobs=options.db.withTransaction(tx=>tx.all("SELECT j.job_id,j.status,r.actor_id,json_extract(j.job_json,'$.deadline') AS deadline FROM jobs j JOIN teacher_design_requests r ON r.job_id=j.job_id WHERE j.purpose='teacher_design' AND j.status IN ('queued','running','outcome_unknown','cancelling') ORDER BY json_extract(j.job_json,'$.acceptedAt'),j.rowid"));
    if(!teacherDesignAgent?.modelBudget){
     for(const row of jobs)await instance.teacherAgent.processJob(String(row.job_id));
     return;
    }
    const members=new Set([...teacherTasks.values()].map(value=>value.actorId));
    for(const row of jobs){
     const jobId=String(row.job_id),actorId=String(row.actor_id);
     if(teacherTasks.has(jobId))continue;
     // Recovery and expired DB backlog never dispatch a model or take a budget entry.
     if(row.status!=='queued'||Date.parse(String(row.deadline))<=now()){
      await instance.teacherAgent.processJob(jobId);continue;
     }
     if(teacherTasks.size>=teacherTaskLimit||members.has(actorId))continue;
     const controller=new AbortController();
     const task=instance.teacherAgent.processJob(jobId,controller.signal)
      .catch(()=>{app.log.error({errorCode:'DEPENDENCY_UNAVAILABLE'},'Original teacher job reconciliation failed.');})
      .finally(()=>teacherTasks.delete(jobId));
     teacherTasks.set(jobId,{actorId,controller,task});members.add(actorId);
    }
   }
  },
  stopInTransaction(tx){
   teaching.stopInTransaction(tx);
   stopTeacherJobs(tx);
   for(const row of tx.all('SELECT DISTINCT attempt_id FROM hdl_sessions WHERE termination_confirmed=0')){
    const attempt=readAttempt(tx,String(row.attempt_id));
    hdl.stopInTransaction(tx,attempt.attemptId,'application_shutdown',generation);
    saveAttempt(tx,{...attempt,attemptRevision:attempt.attemptRevision+1,decisionEpoch:attempt.decisionEpoch+1});
   }
  },
  async stopAdditional(){
   for(const {controller} of teacherTasks.values())controller.abort();
   await Promise.all([teaching.stop(),Promise.allSettled([...teacherTasks.values()].map(value=>value.task))]);
  },
  reconcile:()=>hdl.reconcileStops(),
 });} catch(error) {await app.close();throw error;}
 // Member PCs can be offline during an ECS restart. Reconciliation starts after listen in the original consumer.
 if(!execution)app.addHook('onReady',async()=>{await host.consumeOnce();});
 return {...instance,hdl,currentGeneration,consumeOnce:host.consumeOnce,startConsumer:host.startConsumer,shutdown:host.close,
   management:{deactivateMembershipInTransaction:deactivateMembership,disableUserInTransaction:disableUser},isAccepting:host.isAccepting};
}
