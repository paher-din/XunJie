import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,allocate,command,view,type Fixture,type Headers} from '../../tests/dl-a-support.ts';
import {createModelBudget,type ModelBudget} from '../personal-agent/model-budget.ts';
import type {CompatibleTransport} from '../personal-agent/types.ts';
import {readTeachingJob} from '../records/teaching.ts';
import {openPersonalAgentStore} from '../personal-agent/store.ts';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
const candidates={kind:'candidates',candidates:[{problem:'Count words',audience:'CS beginners',artifact:'A tested C program',
  routes:['scan','tokenize'],goals:['Compare routes'],constraints:['One week'],unresolved:['Teacher confirmation'],resourceRefs:[]}]};
const hint={kind:'student_help',actionType:'hint',content:'Compare the two routes.',rationale:'Keep the learner in control.',
  expectedStudentAction:'Explain the difference.',evidenceIds:[],resourceRefs:[],assistanceContext:'Current question.',unresolved:[],
  policyChecks:{containsWholeSolution:false,writesStudentWork:false,runsCode:false,makesFormalEvaluation:false}};
const settings=(expectedRevision=0)=>({expectedRevision,enabled:true,defaultModelId:'custom:p:model',
  providers:[{id:'p',name:'Offline provider',baseUrl:'https://models.example/v1',apiKey:'SYNTHETIC-ONLY',
    models:[{id:'model',contextWindow:'200000',maxOutput:'4096',inputTypes:[],reasoningLevels:[]}]}],efforts:{}});

async function setup(budget:ModelBudget=createModelBudget(),now?:()=>number){
  const directory=mkdtempSync(join(tmpdir(),'xj140-composed-'));
  const calls:Array<{input:Parameters<CompatibleTransport['complete']>[0];resolve:(value:{text:string})=>void;reject:(error:Error)=>void}>=[];
  let closing=false;
  const transport:CompatibleTransport={async test(){return {ok:true,latencyMs:1,modelCount:1};},complete(input){
    if(closing)return Promise.resolve({text:'closed'});
    return new Promise((resolve,reject)=>calls.push({input,resolve,reject}));
  }};
  // Pass through the real production composition, including its default-off teacher approval.
  const options={...(now?{now}:{}),personalModels:{directory,transport,modelBudget:budget},teacherDesign:{allowedTeacherIds:['teacher'],
    allowedCourseIds:['course'],maximumCallsPerRequest:1,maximumCallsPerRound:20,maximumOutputTokens:4096,
    roundStartsAt:new Date(0).toISOString()}};
  const f=await fixture(undefined,options),teacher=await f.login('teacher'),student=await f.login(),other=await f.login('other');
  for(const headers of [teacher,student,other]){
    const result=await f.app.inject({method:'POST',url:'/api/model-settings',headers,payload:settings()});
    assert.equal(result.statusCode,200,result.body);
  }
  return {f,teacher,student,other,budget,calls,directory,
    async close(){closing=true;for(const call of calls)call.resolve({text:'closed'});await f.close();rmSync(directory,{recursive:true,force:true});}};
}
async function chat(f:Fixture,headers:Headers,key:string){
  const res=await f.app.inject({method:'POST',url:'/api/agent/turns',headers,
    payload:{conversationId:null,mode:'send',text:'Explain this question.',requestKey:key}});
  assert.equal(res.statusCode,200,res.body);await tick();return res.json().data as {turnId:string};
}
async function design(f:Fixture,teacher:Headers,key='teacher-design'){
  const res=await command(f,teacher,'/api/courses/course/blueprints',
    {mode:'agent',generationMode:'candidates',request:'Design a small C project',references:[]},key);
  assert.equal(res.statusCode,200,res.body);return String(res.json().data.result.jobId);
}
async function help(f:Fixture,student:Headers,attemptId:string){
  const res=await command(f,student,`/api/attempts/${attemptId}/help`,
    {expectedAttemptRevision:(await view(f,student,attemptId)).attempt.attemptRevision,question:'How can I compare the two routes?'});
  assert.equal(res.statusCode,200,res.body);return String(res.json().data.result.jobId);
}
const unusedProvider={generate:async()=>{throw new Error('The production personal provider must replace this fallback.');}};

test('production chat, student help and teacher design share global two and member one before recording calls',async t=>{
  const s=await setup();t.after(()=>s.close());const {f,teacher,student,other,calls,budget}=s;
  const item=await allocate(f,teacher,student,false);
  await chat(f,student,'student-chat');await chat(f,other,'other-chat');
  const studentJob=await help(f,student,item.attemptId),studentWork=f.host.tutoring.processJob(studentJob,unusedProvider);
  const teacherJob=await design(f,teacher),teacherWork=f.host.teacherAgent!.processJob(teacherJob);
  await tick();assert.equal(calls.length,2);assert.equal(budget.status().waiting,2);
  const waiting=f.db.withTransaction(tx=>readTeachingJob(tx,'course',studentJob)!);
  assert.equal(waiting.status,'queued');assert.equal(waiting.attemptCount,0);
  let teacherState=(await f.app.inject({url:`/api/jobs/${teacherJob}`,headers:teacher})).json().data;
  assert.equal(teacherState.status,'queued');assert.equal(teacherState.attemptCount,0);assert.deepEqual(teacherState.usages,[]);
  const replay=await design(f,teacher);assert.equal(replay,teacherJob);await tick();assert.equal(budget.status().waiting,2);
  calls[1]!.resolve({text:'chat done'});await tick();await tick();
  assert.equal(calls.length,3);assert.equal(calls[2]!.input.selection.userId,'teacher','busy student must not block another member');
  teacherState=(await f.app.inject({url:`/api/jobs/${teacherJob}`,headers:teacher})).json().data;
  assert.equal(teacherState.attemptCount,1);
  calls[2]!.resolve({text:JSON.stringify(candidates)});await teacherWork;
  assert.equal(calls.length,3,'same student stays blocked despite free global capacity');
  calls[0]!.resolve({text:'chat done'});await tick();await tick();
  assert.equal(calls.length,4);assert.equal(calls[3]!.input.selection.userId,'student');
  calls[3]!.resolve({text:JSON.stringify(hint)});assert.equal((await studentWork).outcome.outcome,'success');
  const tested=await f.app.inject({method:'POST',url:'/api/model-settings/test',headers:teacher,payload:{providerId:'p'}});
  assert.equal(tested.json().data.ok,true,'catalog test also receives the shared admission');
  assert.equal(calls.length,4);
});

test('a stopped chat keeps both its physical slot and member lease until an abort-ignoring transport settles',async t=>{
  const s=await setup();t.after(()=>s.close());const {f,teacher,student,other,calls,budget}=s;
  const stopped=await chat(f,teacher,'stopped');await chat(f,student,'other-active');
  const third=await chat(f,other,'third');
  await f.app.inject({method:'POST',url:`/api/agent/turns/${stopped.turnId}/stop`,headers:teacher,payload:{}});await tick();
  assert.equal(calls[0]!.input.signal.aborted,true);assert.equal(calls.length,2);assert.equal(budget.status().active,2);
  const same=await chat(f,teacher,'teacher-again');
  calls[1]!.reject(new Error('offline provider failed'));await tick();await tick();
  assert.equal(calls.length,3);assert.equal(calls[2]!.input.selection.userId,'other');
  calls[2]!.resolve({text:'third done'});await tick();await tick();assert.equal(calls.length,3);
  calls[0]!.resolve({text:'late stopped reply'});await tick();await tick();
  assert.equal(calls.length,4);assert.equal(calls[3]!.input.selection.userId,'teacher');
  const original=(await f.app.inject({url:`/api/agent/turns/${stopped.turnId}`,headers:teacher})).json().data;
  assert.equal(original.message.phase,'stopped');assert.equal(original.message.text,'');
  assert.ok(third.turnId&&same.turnId);
});

test('waiting model changes and revoked teacher membership are rechecked without upstream calls or ledger reservations',async t=>{
  const s=await setup();t.after(()=>s.close());const {f,teacher,student,other,calls}=s;
  const item=await allocate(f,teacher,student,false);
  await chat(f,teacher,'teacher-active');await chat(f,other,'other-active');
  const job=await help(f,student,item.attemptId),work=f.host.tutoring.processJob(job,unusedProvider);
  await tick();
  assert.equal((await f.app.inject({method:'POST',url:'/api/model-settings',headers:student,payload:settings(1)})).statusCode,200);
  calls[1]!.resolve({text:'done'});const result=await work;
  assert.equal(result.outcome.outcome,'stale');assert.equal(result.outcome.calls,0);
  assert.equal(f.db.withTransaction(tx=>readTeachingJob(tx,'course',job)!.attemptCount),0);
  await chat(f,student,'student-hold');
  assert.equal(calls.length,3); // student was admitted after the stale help released its lease
  const pendingTeacher=await design(f,teacher,'revoked-teacher-design'),teacherWork=f.host.teacherAgent!.processJob(pendingTeacher);
  await tick();
  f.db.withTransaction(tx=>tx.run("UPDATE course_memberships SET active=0 WHERE user_id='teacher' AND course_id='course'"));
  calls[0]!.resolve({text:'done'});await teacherWork;
  assert.equal(calls.length,3);
  const ledger=f.db.withTransaction(tx=>tx.get('SELECT job_json FROM jobs WHERE job_id=?',pendingTeacher));
  assert.ok(ledger);const state=JSON.parse(String(ledger.job_json));
  assert.equal(state.status,'stale');assert.equal(state.attemptCount,0);
});

test('queue full and expiry are observable with zero calls and no provider inactivity clock while waiting',async t=>{
  const budget=createModelBudget({waiting:1}),s=await setup(budget);t.after(()=>s.close());
  t.mock.timers.enable({apis:['setTimeout']});
  const {f,teacher,student,other,calls,directory}=s;
  await chat(f,teacher,'active');await chat(f,student,'active');
  const waiting=await chat(f,other,'waiting');
  const full=await design(f,teacher,'full');await f.host.teacherAgent!.processJob(full);
  let result=(await f.app.inject({url:`/api/jobs/${full}`,headers:teacher})).json().data;
  assert.equal(result.failure,'MODEL_QUEUE_FULL');assert.equal(result.attemptCount,0);assert.deepEqual(result.usages,[]);
  t.mock.timers.tick(120_001);await tick();
  result=(await f.app.inject({url:`/api/agent/turns/${waiting.turnId}`,headers:other})).json().data;
  assert.equal(result.message.failure.code,'MODEL_QUEUE_TIMEOUT');assert.equal(calls.length,2);
  const store=openPersonalAgentStore(directory);
  try{
    const turn=JSON.parse(String(store.get('SELECT turn_json FROM agent_turns WHERE turn_id=?',waiting.turnId)!.turn_json));
    assert.equal(turn.callCount,0);assert.equal(turn.deadline,null);
  }finally{store.close();}
});

for(const entry of ['student','teacher'] as const)test(`${entry} cancellation at the reserved-but-unsent boundary returns its ledger reservation`,async t=>{
  const actual=createModelBudget();
  const budget:ModelBudget={...actual,track:call=>{void actual.close();return actual.track(call);}};
  const s=await setup(budget);t.after(()=>s.close());const {f,teacher,student,calls}=s;
  if(entry==='teacher'){
    const job=await design(f,teacher);const completion=await f.host.teacherAgent!.processJob(job);
    const state=(await f.app.inject({url:`/api/jobs/${job}`,headers:teacher})).json().data;
    assert.equal(state.attemptCount,0);assert.deepEqual(state.usages,[]);
    assert.equal(completion!.delivery.outcome.calls,0);
  }else{
    const item=await allocate(f,teacher,student,false),job=await help(f,student,item.attemptId);
    const result=await f.host.tutoring.processJob(job,unusedProvider);
    assert.equal(result.outcome.outcome,'cancelled');assert.equal(result.outcome.calls,0);
    assert.equal(f.db.withTransaction(tx=>readTeachingJob(tx,'course',job)!.attemptCount),0);
  }
  assert.equal(calls.length,0);await actual.close();
});

test('application shutdown rejects waiting operations and waits for actual upstream settlement',async t=>{
  const s=await setup();t.after(()=>s.close());const {f,teacher,student,other,calls,budget}=s;
  await chat(f,teacher,'active');await chat(f,student,'active');await chat(f,other,'waiting');
  let closed=false;const closing=f.host.shutdown().then(()=>{closed=true;});
  await tick();await tick();assert.equal(closed,false);assert.equal(calls.length,2);
  assert.equal(budget.status().waiting,0);assert.equal(calls[0]!.input.signal.aborted,true);
  calls[0]!.resolve({text:'late'});await tick();assert.equal(closed,false);
  calls[1]!.resolve({text:'late'});await closing;assert.equal(closed,true);
  assert.deepEqual(budget.status(),{active:0,waiting:0,waitingBytes:0,closed:true});
});

test('the actual retained chat payload is charged to the waiting byte cap before dispatch',async t=>{
  const s=await setup(createModelBudget({waitingBytes:256}));t.after(()=>s.close());
  const {f,teacher,student,other,calls,budget}=s;
  await chat(f,teacher,'active');await chat(f,student,'active');const denied=await chat(f,other,'bytes-full');
  const turn=(await f.app.inject({url:`/api/agent/turns/${denied.turnId}`,headers:other})).json().data;
  assert.equal(turn.message.failure.code,'MODEL_QUEUE_FULL');assert.equal(calls.length,2);
  assert.equal(budget.status().waitingBytes,0);assert.equal(budget.status().waiting,0);
});

test('the student personal-model idle lease starts at admission, without consuming the wait or reporting it as provider time',async t=>{
  let time=Date.now();const s=await setup(createModelBudget(),()=>time);t.after(()=>s.close());const {f,teacher,student,other,calls}=s;
  t.mock.timers.enable({apis:['setTimeout']});
  const item=await allocate(f,teacher,student,false);
  await chat(f,teacher,'active');await chat(f,other,'active');
  const job=await help(f,student,item.attemptId),work=f.host.tutoring.processJob(job,unusedProvider);await tick();
  time+=60_000;t.mock.timers.tick(60_000);calls[1]!.resolve({text:'done'});await tick();await tick();
  const running=f.db.withTransaction(tx=>readTeachingJob(tx,'course',job)!);
  assert.equal(running.status,'running');assert.equal(Date.parse(running.deadline)-time,600_000);
  assert.equal(running.leaseUntil,running.deadline);assert.equal(calls.length,3);
  calls[2]!.resolve({text:JSON.stringify(hint)});const result=await work;
  assert.equal(result.outcome.outcome,'success');
  if(result.outcome.outcome==='success')assert.equal(result.outcome.elapsedMs,0);
});

test('the existing teacher cancel route removes an unsent waiter and never dispatches it later',async t=>{
  const s=await setup();t.after(()=>s.close());const {f,teacher,student,calls,budget}=s;
  await chat(f,teacher,'active');await chat(f,student,'active');
  const job=await design(f,teacher),work=f.host.teacherAgent!.processJob(job);await tick();
  assert.equal(budget.status().waiting,1);
  const cancelled=await command(f,teacher,`/api/jobs/${job}/cancel`,{});assert.equal(cancelled.statusCode,200,cancelled.body);
  await work;assert.equal(budget.status().waiting,0);assert.equal(budget.status().waitingBytes,0);
  calls[0]!.resolve({text:'done'});calls[1]!.resolve({text:'done'});await tick();await tick();assert.equal(calls.length,2);
  const state=(await f.app.inject({url:`/api/jobs/${job}`,headers:teacher})).json().data;
  assert.equal(state.status,'cancelled');assert.equal(state.attemptCount,0);
});

test('waiting acceptance only reads provider metadata; stored credentials are first opened at admission',async t=>{
  const s=await setup();t.after(()=>s.close());const {f,teacher,student,other,calls,directory}=s;
  await chat(f,teacher,'active');await chat(f,student,'active');
  const store=openPersonalAgentStore(directory);
  try{
    const row=store.get('SELECT config_json FROM user_model_configs WHERE user_id=?','other')!;
    const config=JSON.parse(String(row.config_json));config.providers[0].credential.ciphertext='invalid-encrypted-fixture';
    store.run('UPDATE user_model_configs SET config_json=? WHERE user_id=?',JSON.stringify(config),'other');
  }finally{store.close();}
  const pending=await chat(f,other,'deferred-credential');
  let turn=(await f.app.inject({url:`/api/agent/turns/${pending.turnId}`,headers:other})).json().data;
  assert.equal(turn.message.phase,'waiting');assert.equal(calls.length,2);
  calls[1]!.resolve({text:'done'});await tick();await tick();
  turn=(await f.app.inject({url:`/api/agent/turns/${pending.turnId}`,headers:other})).json().data;
  assert.equal(turn.message.phase,'failed');assert.equal(calls.length,2,'damaged credential never reaches transport');
  assert.doesNotMatch(JSON.stringify(turn),/SYNTHETIC-ONLY|invalid-encrypted-fixture|ciphertext/);
});

test('a sent student call that ignores abort stays billed and keeps its slot beyond the unsent-verdict window',async t=>{
  const s=await setup();t.after(()=>s.close());const {f,teacher,student,other,calls,budget}=s;
  const item=await allocate(f,teacher,student,false),job=await help(f,student,item.attemptId);
  const controller=new AbortController(),work=f.host.tutoring.processJob(job,unusedProvider,controller.signal);
  await tick();assert.equal(calls.length,1);assert.equal(calls[0]!.input.selection.userId,'student');
  await chat(f,teacher,'second-slot');await chat(f,other,'waiting-third');
  controller.abort();const result=await work;
  assert.equal(result.outcome.outcome,'cancelled');assert.equal(result.outcome.calls,1);
  assert.deepEqual(result.outcome.usage,{status:'unknown'});
  assert.equal(f.db.withTransaction(tx=>readTeachingJob(tx,'course',job)!.attemptCount),1);
  assert.equal(calls[0]!.input.signal.aborted,true);assert.equal(calls.length,2);
  assert.equal(budget.status().active,2);assert.equal(budget.status().waiting,1);
  calls[0]!.resolve({text:JSON.stringify(hint)});await tick();await tick();
  assert.equal(calls.length,3);assert.equal(calls[2]!.input.selection.userId,'other');
  assert.equal(f.db.withTransaction(tx=>readTeachingJob(tx,'course',job)!.attemptCount),1);
});
