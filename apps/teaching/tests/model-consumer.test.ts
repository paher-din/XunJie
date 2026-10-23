import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fixture,command,type Fixture,type Headers} from './dl-a-support.ts';
import {createModelBudget,MODEL_QUEUE_LIMITS} from '../server/personal-agent/model-budget.ts';
import type {CompatibleTransport} from '../server/personal-agent/types.ts';
import {loadTeacherRequest} from '../server/design/teacher-storage.ts';
import {saveJob} from '../server/db/records-adapter.ts';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
async function until(check:()=>boolean) {
  const deadline=Date.now()+1000;
  while(!check()&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.ok(check(),'production consumer did not make the expected progress');
}
const candidates={kind:'candidates',candidates:[{problem:'Count words',audience:'CS beginners',artifact:'A tested C program',
  routes:['scan','tokenize'],goals:['Compare routes'],constraints:['One week'],unresolved:['Teacher confirmation'],resourceRefs:[]}]};
async function setup(budget=createModelBudget(),now?:()=>number) {
  const directory=mkdtempSync(join(tmpdir(),'xj133-consumer-'));
  const calls:Array<{input:Parameters<CompatibleTransport['complete']>[0];resolve:(value:{text:string})=>void;reject:(error:Error)=>void}>=[];
  let closing=false;
  const transport:CompatibleTransport={async test(){return {ok:true,latencyMs:1,modelCount:1};},complete(input){
    if(closing)return Promise.resolve({text:'closed'});
    return new Promise((resolve,reject)=>calls.push({input,resolve,reject}));
  }};
  const options={...(now?{now}:{}),personalModels:{directory,transport,modelBudget:budget},teacherDesign:{allowedTeacherIds:['teacher','other'],
    allowedCourseIds:['course'],maximumCallsPerRequest:1,maximumCallsPerRound:100,maximumOutputTokens:4096,
    roundStartsAt:new Date(0).toISOString()}};
  const f=await fixture(undefined,options);
  f.db.withTransaction(tx=>tx.run("UPDATE course_memberships SET role='teacher' WHERE user_id='other' AND course_id='course'"));
  const a=await f.login('teacher'),b=await f.login('other');
  for(const headers of [a,b]) {
    const response=await f.app.inject({method:'POST',url:'/api/model-settings',headers,payload:{expectedRevision:0,enabled:true,
      defaultModelId:'custom:p:model',providers:[{id:'p',name:'Offline provider',baseUrl:'https://models.example/v1',
        apiKey:'SYNTHETIC-ONLY',models:[{id:'model',contextWindow:'200000',maxOutput:'4096',inputTypes:[],reasoningLevels:[]}]}],efforts:{}}});
    assert.equal(response.statusCode,200,response.body);
  }
  return {f,a,b,calls,budget,async close(){
    closing=true;for(const call of calls)call.resolve({text:'closed'});
    await f.close();rmSync(directory,{recursive:true,force:true});
  }};
}
async function chat(f:Fixture,headers:Headers) {
  const response=await f.app.inject({method:'POST',url:'/api/agent/turns',headers,
    payload:{conversationId:null,mode:'send',text:'Explain this question.',requestKey:'consumer-chat'}});
  assert.equal(response.statusCode,200,response.body);await tick();return String(response.json().data.turnId);
}
async function design(f:Fixture,headers:Headers) {
  const response=await command(f,headers,'/api/courses/course/blueprints',
    {mode:'agent',generationMode:'candidates',request:'Design a small C project',references:[]});
  assert.equal(response.statusCode,200,response.body);return String(response.json().data.result.jobId);
}
async function job(f:Fixture,headers:Headers,id:string) {
  const response=await f.app.inject({url:`/api/jobs/${id}`,headers});
  assert.equal(response.statusCode,200,response.body);return response.json().data;
}

test('production consumer admits runnable teacher B while teacher A waits behind A personal chat',async t=>{
  const s=await setup();t.after(()=>s.close());const {f,a,b,calls,budget}=s;
  await chat(f,a);
  const a1=await design(f,a),later:string[]=[];
  for(let i=0;i<MODEL_QUEUE_LIMITS.waiting+2;i++)later.push(await design(f,a));
  const a2=later[0]!,b1=await design(f,b);
  f.host.startConsumer(50);
  await until(()=>calls.length===2);
  assert.deepEqual(calls.map(call=>call.input.selection.userId),['teacher','other']);
  assert.equal(budget.status().active,2);assert.equal(budget.status().waiting,1);
  assert.equal((await job(f,a,a1)).attemptCount,0);
  assert.equal((await job(f,a,a2)).attemptCount,0);
  assert.equal((await job(f,b,b1)).attemptCount,1);
  calls[1]!.resolve({text:JSON.stringify(candidates)});
  await until(()=>budget.status().active===1);
  assert.equal(calls.length,2,'A remains blocked by its own chat despite a free global slot');
  calls[0]!.resolve({text:'chat done'});
  await until(()=>calls.length===3);
  assert.equal((await job(f,a,a1)).attemptCount,1,'oldest A job runs first');
  assert.equal((await job(f,a,a2)).attemptCount,0);
  calls[2]!.resolve({text:JSON.stringify(candidates)});
  await until(()=>calls.length===4);
  assert.equal((await job(f,a,a1)).status,'succeeded');
  assert.equal((await job(f,a,a2)).attemptCount,1);
  calls[3]!.resolve({text:JSON.stringify(candidates)});
  await until(()=>budget.status().active===0);
});

test('production consumer removes a cancelled unsent job and keeps the next job behind its member chat',async t=>{
  const s=await setup();t.after(()=>s.close());const {f,a,b,calls,budget}=s;
  await chat(f,a);
  const a1=await design(f,a),a2=await design(f,a),b1=await design(f,b);
  f.host.startConsumer(50);
  await until(()=>calls.length===2&&budget.status().waiting===1);
  const cancelled=await command(f,a,`/api/jobs/${a1}/cancel`,{});
  assert.equal(cancelled.statusCode,200,cancelled.body);
  await until(()=>budget.status().waiting===1);
  assert.equal((await job(f,a,a1)).status,'cancelled');
  assert.equal((await job(f,a,a1)).attemptCount,0);
  calls[1]!.resolve({text:JSON.stringify(candidates)});
  await until(()=>budget.status().active===1);
  assert.equal((await job(f,b,b1)).status,'succeeded');
  assert.equal(calls.length,2);
  calls[0]!.resolve({text:'chat done'});
  await until(()=>calls.length===3);
  assert.equal((await job(f,a,a2)).attemptCount,1);
  assert.equal((await job(f,a,a1)).attemptCount,0,'cancelled waiter never reserves a call');
  calls[2]!.resolve({text:JSON.stringify(candidates)});
  await until(()=>budget.status().active===0);
});

test('production consumer keeps cancelled teacher upstream and member leases until the transport settles',async t=>{
  const s=await setup();t.after(()=>s.close());const {f,a,b,calls,budget}=s;
  const b1=await design(f,b);
  f.host.startConsumer(50);
  await until(()=>calls.length===1);
  const cancelled=await command(f,b,`/api/jobs/${b1}/cancel`,{});
  assert.equal(cancelled.statusCode,200,cancelled.body);
  await until(()=>calls[0]!.input.signal.aborted);
  const b2=await design(f,b),a1=await design(f,a);
  await until(()=>calls.length===2&&budget.status().waiting===1);
  assert.equal(calls[1]!.input.selection.userId,'teacher');
  assert.equal(budget.status().active,2);
  assert.equal((await job(f,b,b1)).attemptCount,1);
  assert.equal((await job(f,b,b2)).attemptCount,0);
  calls[1]!.resolve({text:JSON.stringify(candidates)});
  await until(()=>budget.status().active===1);
  assert.equal((await job(f,a,a1)).status,'succeeded');
  assert.equal(calls.length,2,'a free slot cannot bypass the unsettled B member lease');
  calls[0]!.resolve({text:JSON.stringify(candidates)});
  await until(()=>calls.length===3);
  assert.equal((await job(f,b,b1)).status,'cancelled');
  assert.equal((await job(f,b,b2)).attemptCount,1);
  calls[2]!.resolve({text:JSON.stringify(candidates)});
  await until(()=>budget.status().active===0);
});

test('production consumer handles a task rejection without blocking other teachers or leaking the raw error',async t=>{
  const s=await setup();t.after(()=>s.close());const {f,a,b,calls}=s;
  const a1=await design(f,a),b1=await design(f,b),agent=f.host.teacherAgent!;
  const original=agent.processJob,errors:unknown[][]=[];
  const logging=t.mock.method(f.app.log,'error',(...args:unknown[])=>{errors.push(args);});
  const processing=t.mock.method(agent,'processJob',async(id:string,signal?:AbortSignal)=>{
    if(id===a1)throw new Error('SYNTHETIC_RAW_PROVIDER_DETAIL');
    return original(id,signal);
  });
  f.host.startConsumer(50);
  await until(()=>calls.length===1&&errors.length>0);
  assert.equal(calls[0]!.input.selection.userId,'other');
  assert.equal((await job(f,b,b1)).attemptCount,1);
  assert.doesNotMatch(JSON.stringify(errors),/SYNTHETIC_RAW_PROVIDER_DETAIL/);
  assert.match(JSON.stringify(errors),/DEPENDENCY_UNAVAILABLE/);
  processing.mock.restore();logging.mock.restore();
  await until(()=>calls.length===2);
  assert.equal((await job(f,a,a1)).attemptCount,1);
  for(const call of calls)call.resolve({text:JSON.stringify(candidates)});
});

test('production consumer shutdown cancels waiting and deferred jobs and waits for physical upstream settlement',async t=>{
  const s=await setup();t.after(()=>s.close());const {f,a,b,calls,budget}=s;
  await chat(f,a);
  const a1=await design(f,a),a2=await design(f,a),b1=await design(f,b);
  f.host.startConsumer(50);
  await until(()=>calls.length===2&&budget.status().waiting===1);
  let closed=false;
  const closing=f.host.shutdown().then(()=>{closed=true;});
  await until(()=>budget.status().closed&&budget.status().waiting===0);
  assert.equal(closed,false);assert.equal(budget.status().active,2);
  assert.ok(calls.every(call=>call.input.signal.aborted));
  calls[0]!.resolve({text:'late chat'});await tick();
  assert.equal(closed,false,'the second physical upstream is still outstanding');
  calls[1]!.resolve({text:JSON.stringify(candidates)});
  await closing;
  assert.deepEqual(budget.status(),{active:0,waiting:0,waitingBytes:0,closed:true});
  for(const id of [a1,a2,b1]) {
    const state=f.db.withTransaction(tx=>JSON.parse(String(tx.get('SELECT job_json FROM jobs WHERE job_id=?',id)!.job_json)));
    assert.equal(state.status,'cancelled');assert.equal(state.stopRequested,true);
    assert.equal(state.attemptCount,id===b1?1:0);
  }
  assert.equal(calls.length,2,'shutdown never dispatches the deferred second A job');
});

test('production consumer reconciles an old teacher lease without replay or blocking a later same-member job',async t=>{
  const s=await setup();t.after(()=>s.close());const {f,a,calls,budget}=s;
  const old=await design(f,a),next=await design(f,a);
  f.db.withTransaction(tx=>saveJob(tx,{...loadTeacherRequest(tx,old).job,status:'running',
    leaseToken:'synthetic-old-lease',leaseUntil:new Date(0).toISOString()}));
  f.host.startConsumer(50);
  await until(()=>calls.length===1);
  assert.equal((await job(f,a,old)).status,'outcome_unknown');
  assert.equal((await job(f,a,old)).attemptCount,0,'the old lease never authorizes repeating a call');
  assert.equal((await job(f,a,next)).attemptCount,1);
  assert.equal(budget.status().waiting,0);
  calls[0]!.resolve({text:JSON.stringify(candidates)});
  await until(()=>budget.status().active===0);
});

test('production consumer reports bounded queue expiry without calls and continues another teacher',async t=>{
  const s=await setup(createModelBudget({waitingMs:100}));t.after(()=>s.close());const {f,a,b,calls,budget}=s;
  await chat(f,a);
  const a1=await design(f,a),b1=await design(f,b);
  f.host.startConsumer(50);
  await until(()=>calls.length===2);
  await until(()=>budget.status().waiting===0);
  const state=await job(f,a,a1);
  assert.equal(state.status,'timed_out');assert.equal(state.failure,'MODEL_QUEUE_TIMEOUT');
  assert.equal(state.attemptCount,0);assert.deepEqual(state.usages,[]);
  assert.equal((await job(f,b,b1)).attemptCount,1);
  for(const call of calls)call.resolve({text:JSON.stringify(candidates)});
  await until(()=>budget.status().active===0);
  assert.equal(calls.length,2,'expired waiter is never retried');
});

test('production consumer observes the shared waiting cap without extra calls or repeated submissions',async t=>{
  const s=await setup(createModelBudget({waiting:1}));t.after(()=>s.close());const {f,a,b,calls,budget}=s;
  await chat(f,a);await chat(f,b);
  const a1=await design(f,a),b1=await design(f,b);
  f.host.startConsumer(50);
  await until(()=>budget.status().waiting===1);
  await tick();
  const state=await job(f,b,b1);
  assert.equal(state.status,'failed');assert.equal(state.failure,'MODEL_QUEUE_FULL');
  assert.equal(state.attemptCount,0);assert.deepEqual(state.usages,[]);
  assert.equal(calls.length,2);
  const cancelled=await command(f,a,`/api/jobs/${a1}/cancel`,{});
  assert.equal(cancelled.statusCode,200,cancelled.body);
  await until(()=>budget.status().waiting===0);
  for(const call of calls)call.resolve({text:'chat done'});
  await until(()=>budget.status().active===0);
  assert.equal(calls.length,2);
});

test('production consumer expires deferred DB backlog without stealing the active model-budget wait allowance',async t=>{
  let time=Date.now();
  const s=await setup(createModelBudget(),()=>time);t.after(()=>s.close());const {f,a,b,calls,budget}=s;
  await chat(f,a);
  const a1=await design(f,a),a2=await design(f,a);
  await design(f,b);
  f.host.startConsumer(50);
  await until(()=>calls.length===2&&budget.status().waiting===1);
  time+=60_000;
  await f.host.consumeOnce();
  const deferred=await job(f,a,a2);
  assert.equal(deferred.status,'timed_out');assert.equal(deferred.attemptCount,0);
  assert.equal((await job(f,a,a1)).status,'queued','already submitted budget wait retains its own bounded allowance');
  assert.equal(budget.status().waiting,1);assert.equal(calls.length,2);
});
