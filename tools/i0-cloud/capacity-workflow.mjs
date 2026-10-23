import {request,Agent} from 'node:https';
import {readFileSync} from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
import {publicRequest} from './capacity-metrics.mjs';

export class CapacityFailure extends Error{constructor(code,details){super(code);this.code=code;this.details=details;}}
export const check=(condition,code)=>{if(!condition)throw new CapacityFailure(code);};
export const hash=value=>createHash('sha256').update(value).digest('hex');
export function httpsTransport({port,caFile,ca,origin}){
  const agent=new Agent({keepAlive:true,maxSockets:8,ca:ca??readFileSync(caFile),rejectUnauthorized:true});
  return {close:()=>agent.destroy(),send:input=>new Promise((accept,reject)=>{
    const req=request({hostname:'127.0.0.1',port,servername:'localhost',method:input.method,path:input.url,agent,
      headers:{host:new URL(origin).host,...input.headers,...(input.body?{'content-length':Buffer.byteLength(input.body)}:{})}},res=>{
      let text='',bytes=0;res.setEncoding('utf8');res.on('data',chunk=>{text+=chunk;bytes+=Buffer.byteLength(chunk);if(bytes>16*1024*1024)req.destroy();});
      res.on('end',()=>accept({status:res.statusCode,headers:res.headers,text,bytes}));
      res.on('error',()=>reject(new CapacityFailure('CAPACITY_HTTP_FAILED')));res.on('aborted',()=>reject(new CapacityFailure('CAPACITY_HTTP_ABORTED')));
    });
    req.setTimeout(30_000,()=>req.destroy());req.on('error',()=>reject(new CapacityFailure('CAPACITY_HTTP_FAILED')));req.end(input.body);
  })};
}
export function client({actor,origin,transport,record,executionNodeId}){
  let cookie='',csrf='';
  async function call(method,route,values={},payload,key){
    let url=route;for(const [name,value]of Object.entries(values))url=url.replace(':'+name,encodeURIComponent(value));
    check(!url.includes('/:'),'CAPACITY_ROUTE_PARAMETERS_MISSING');
    const body=payload===undefined?undefined:JSON.stringify(payload),started=performance.now();
    const response=await transport.send({method,url,headers:{origin,...(executionNodeId?{'x-xunjie-execution-node':executionNodeId}:{}),...(cookie?{cookie}:{}),...(csrf?{'x-csrf-token':csrf}:{}),
      ...(body?{'content-type':'application/json'}:{}),...(key?{'idempotency-key':key}:{})},body});
    record(publicRequest({actor,requestId:response.headers['x-request-id'],method,route,status:response.status,
      clientRttMs:performance.now()-started,readBytes:response.bytes,writeBytes:body?Buffer.byteLength(body):0}));
    if(response.status!==200){let serverErrorCode;try{const code=JSON.parse(response.text).error?.code;
      if(typeof code==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(code))serverErrorCode=code;}catch{}
      throw new CapacityFailure('CAPACITY_HTTP_NON_200',{actor,method,route,status:response.status,requestId:response.headers['x-request-id'],serverErrorCode});}
    let result;try{result=JSON.parse(response.text);}catch{throw new CapacityFailure('CAPACITY_HTTP_JSON_FAILED');}
    if(route==='/api/sessions'){
      const supplied=response.headers['set-cookie'];check(typeof supplied==='string'||Array.isArray(supplied),'CAPACITY_SESSION_COOKIE_MISSING');
      cookie=(Array.isArray(supplied)?supplied:[supplied]).map(value=>value.split(';',1)[0]).join('; ');csrf=result.data.csrfToken;
    }
    return result.data;
  }
  return {actor,call,get:(route,values)=>call('GET',route,values),
    post:(route,values,payload,key=randomUUID())=>call('POST',route,values,payload,key),
    login:account=>call('POST','/api/sessions',{},account),
    // Never expose the cookie itself; only prove the five sessions are independent in memory.
    sessionFingerprint:()=>hash(cookie)};
}
export async function prepareProject(teacher,students,courseId,runId,{reusePublishedActivity=false}={}){
  const workbench=await teacher.get('/api/courses/:id/teacher-workbench',{id:courseId});
  const preset=workbench.presets.find(row=>!row.content.digitalLogicConfigVersionId);check(preset,'CAPACITY_C_PRESET_MISSING');
  const generation=workbench.recoveryGeneration;
  let blueprintId,activityId,activityControlRevision=1;
  if(reusePublishedActivity){
    const fixed=workbench.activities.find(row=>row.activityVersionId===preset.id&&row.status==='active');
    check(fixed,'CAPACITY_ACTIVE_C_ACTIVITY_REQUIRED');
    check(!workbench.assignments.some(row=>row.activityVersionId===fixed.activityVersionId&&students.some(student=>student.userId===row.studentId)),
      'CAPACITY_OWN_FRESH_ASSIGNMENTS_REQUIRED');
    activityId=fixed.activityVersionId;activityControlRevision=fixed.activityControlRevision;
  }else{
  const draft=await teacher.post('/api/courses/:id/blueprints',{id:courseId},{recoveryGeneration:generation,mode:'manual',
    content:{...preset.content,projectTitle:`Capacity 133 ${runId}`}},`${runId}-draft`);
  blueprintId=draft.result.draft.blueprintId;
  const checked=await teacher.post('/api/blueprints/:id/checks',{id:blueprintId},{recoveryGeneration:generation,expectedRevision:1},`${runId}-check`);
  check(checked.result.report.blocking.length===0,'CAPACITY_PROJECT_CHECK_FAILED');
  const released=await teacher.post('/api/blueprints/:id/releases',{id:blueprintId},{recoveryGeneration:generation,expectedRevision:1,confirmed:true},`${runId}-release`);
  activityId=released.result.activityVersionId;
  }
  const assigned=await teacher.post('/api/activities/:id/assignments',{id:activityId},{recoveryGeneration:generation,expectedActivityControlRevision:activityControlRevision,
    studentIds:students.map(row=>row.userId)},`${runId}-assign`);
  const states=[];
  for(const student of students){
    const assignment=assigned.result.assignments.find(row=>row.studentId===student.userId);check(assignment,'CAPACITY_ASSIGNMENT_MISSING');
    const started=await student.client.post('/api/assignments/:id/attempts',{id:assignment.assignmentId},{recoveryGeneration:generation},`${runId}-${student.label}-attempt`);
    states.push({label:student.label,client:student.client,assignmentId:assignment.assignmentId,attemptId:started.result.attemptId,
      generation,clientId:`capacity-${runId}-${student.label}`,clientSeq:0,iterations:0,submissions:0,feedback:0,replays:0,lastHash:null,lastVersion:0});
  }
  return {runId,courseId,generation,blueprintId,activityId,states,projectSource:reusePublishedActivity?'existing immutable activity; fresh own assignments':'newly published own activity'};
}
// A repeat measures the growing original history, never fresh/cleared attempts. Revalidate ownership via real APIs.
export async function resumeProject(teacher,students,courseId,runId,previous){
  check(previous.actors.length===students.length&&new Set(previous.actors.map(a=>a.attemptId)).size===students.length,'CAPACITY_RESUME_SCOPE');
  const workbench=await teacher.get('/api/courses/:id/teacher-workbench',{id:courseId}),states=[];
  for(const student of students){
    const prior=previous.actors.find(a=>a.actor===student.label),entry=prior&&workbench.attempts.find(a=>a.attemptId===prior.attemptId);
    const assignment=prior&&workbench.assignments.find(a=>a.assignmentId===prior.assignmentId);
    check(entry&&assignment&&assignment.active&&assignment.studentId===student.userId&&entry.studentId===student.userId
      &&entry.assignmentId===prior.assignmentId&&entry.courseId===courseId,'CAPACITY_RESUME_OWNERSHIP');
    const head=await student.client.get('/api/attempts/:id',{id:prior.attemptId}),file=head.files.find(row=>row.path==='capacity.c'&&row.lifecycle==='active');
    const feedback=await student.client.get('/api/attempts/:id/feedback',{id:prior.attemptId});
    const baseSubmissions=(prior.baseSubmissions??0)+prior.submissions,baseFeedback=(prior.baseFeedback??0)+prior.feedback;
    check(head.attempt.attemptId===prior.attemptId&&['ready','active'].includes(head.attempt.status)
      &&file?.documentVersion===prior.finalVersion&&file?.contentHash===prior.finalHash
      &&head.submissions.length===baseSubmissions&&feedback.feedbackRevision===baseFeedback,'CAPACITY_RESUME_BASE_CHANGED');
    states.push({label:student.label,client:student.client,assignmentId:prior.assignmentId,attemptId:prior.attemptId,generation:workbench.recoveryGeneration,
      clientId:`capacity-${runId}-${student.label}`,clientSeq:0,iterations:0,submissions:0,feedback:0,replays:0,lastHash:file.contentHash,lastVersion:file.documentVersion,
      baseDocumentVersion:file.documentVersion,baseSaves:(prior.baseSaves??0)+prior.iterations,baseSubmissions,baseFeedback});
  }
  return {runId,courseId,generation:workbench.recoveryGeneration,states,projectSource:'same owned assignments/attempts with all prior history retained; base plus this run delta'};
}
export async function editAndSave(state,runId){
  const c=state.client,{attempt,files}=await c.get('/api/attempts/:id',{id:state.attemptId});
  check(attempt.status==='active'||attempt.status==='ready','CAPACITY_ATTEMPT_NOT_EDITABLE');
  const file=files.find(row=>row.lifecycle==='active'&&row.path==='capacity.c');
  const text=`/* capacity133 ${runId} ${state.label} iteration ${state.iterations+1} */\nint main(void){return ${(state.iterations+1)%2};}\n`
    +'/* '+state.label.repeat(1024)+' */\n';
  const payload={recoveryGeneration:state.generation,expectedWorkspaceRevision:attempt.workspaceRevision,clientId:state.clientId,clientSeq:++state.clientSeq,
    operations:[file?{kind:'update',fileId:file.fileId,baseVersion:file.documentVersion,text}:{kind:'create',clientFileKey:'capacity-source',path:'capacity.c',text}]};
  const key=randomUUID(),saved=await c.post('/api/attempts/:id/sync',{id:state.attemptId},payload,key);
  const after=await c.get('/api/attempts/:id',{id:state.attemptId}),current=after.files.find(row=>row.path==='capacity.c'&&row.lifecycle==='active');
  check(current?.text===text&&current.contentHash===hash(text)&&current.documentVersion===(file?.documentVersion??0)+1,'CAPACITY_LOST_WRITE');
  if(state.iterations%10===0){
    const replay=await c.post('/api/attempts/:id/sync',{id:state.attemptId},payload,key);
    check(replay.replayed===true&&JSON.stringify(replay.result)===JSON.stringify(saved.result),'CAPACITY_SYNC_REPLAY_CHANGED');
    const final=await c.get('/api/attempts/:id',{id:state.attemptId});check(final.attempt.workspaceRevision===after.attempt.workspaceRevision,'CAPACITY_DUPLICATE_WRITE');state.replays++;
  }
  state.iterations++;state.lastHash=current.contentHash;state.lastVersion=current.documentVersion;
  return after;
}
export async function snapshot(state){
  const current=await state.client.get('/api/attempts/:id',{id:state.attemptId});
  return state.client.post('/api/attempts/:id/snapshots',{id:state.attemptId},{recoveryGeneration:state.generation,expectedWorkspaceRevision:current.attempt.workspaceRevision});
}
export async function submit(state){
  const frozen=await snapshot(state),head=await state.client.get('/api/attempts/:id',{id:state.attemptId});
  const response=await state.client.post('/api/attempts/:id/submissions',{id:state.attemptId},
    {recoveryGeneration:state.generation,expectedAttemptRevision:head.attempt.attemptRevision,snapshotId:frozen.result.snapshotId,reflection:`Capacity round ${state.submissions+1}`});
  state.submissions++;return {state,submissionId:response.result.submissionId,snapshotId:frozen.result.snapshotId};
}
export async function reviewAndResume(teacher,item){
  const {state,submissionId,snapshotId}=item,scope={id:state.attemptId};
  const before=await teacher.get('/api/attempts/:id/review-context',scope);
  check(before.submission.submissionId===submissionId,'CAPACITY_SUBMISSION_ID_MISMATCH');
  const key=randomUUID(),payload={recoveryGeneration:state.generation,expectedAttemptRevision:before.attempt.attemptRevision,
    expectedStateRevision:before.learnerStateRevision,expectedFeedbackRevision:before.feedback.feedbackRevision,
    submissionId,kind:'submission_review',summary:`Capacity feedback ${state.feedback+1}`,reason:'Review the fixed snapshot',evidenceRefs:[{kind:'snapshot',id:snapshotId,attemptId:state.attemptId}]};
  const saved=await teacher.post('/api/attempts/:id/feedback',scope,payload,key);
  const replay=await teacher.post('/api/attempts/:id/feedback',scope,payload,key);
  check(replay.replayed===true&&JSON.stringify(saved.result)===JSON.stringify(replay.result),'CAPACITY_FEEDBACK_REPLAY_CHANGED');
  const reviewed=await teacher.get('/api/attempts/:id/review-context',scope);
  await teacher.post('/api/attempts/:id/reopen',scope,{recoveryGeneration:state.generation,expectedAttemptRevision:reviewed.attempt.attemptRevision,submissionId,reason:'Capacity revision requested'});
  const recovery=await state.client.get('/api/attempts/:id/recovery',scope);check(recovery.feedback.status==='available','CAPACITY_FEEDBACK_NOT_VISIBLE');
  const head=await state.client.get('/api/attempts/:id',scope);
  await state.client.post('/api/attempts/:id/controls',scope,{recoveryGeneration:state.generation,expectedAttemptRevision:head.attempt.attemptRevision,control:{kind:'resume_revision'}});
  const after=await teacher.get('/api/attempts/:id/review-context',scope);
  check(after.reopen.state==='consumed'&&JSON.stringify(after.artifact)===JSON.stringify(before.artifact),'CAPACITY_FIXED_SUBMISSION_CHANGED');state.feedback++;
}
