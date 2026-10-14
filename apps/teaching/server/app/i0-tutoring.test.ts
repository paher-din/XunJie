import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture,assigned,opened,view,files,snapshot,syntheticProfile } from '../workspace/test-support.ts';
import { createHash } from 'node:crypto';
import type { I0AppOptions } from './i0.ts';
import { createI0App } from './i0.ts';
import { SyntheticProvider,type ProviderRequest } from '../tutoring/providers.ts';
import { readTeachingJob } from '../records/teaching.ts';
import { saveJob } from '../db/records-adapter.ts';

const versions={modelConfig:'deepseek-flash-v1',prompt:'student-help-v1',schema:'student-help-v1',policy:'help-v1'};
function body(request:ProviderRequest) {
  const input=request.untrustedInput as {references:Array<{id:string}>};
  return {kind:'student_help',actionType:'hint',content:'先写出一个边界输入，再自行检查。',
    rationale:'保留学生的选择与验证。',expectedStudentAction:'请自行试验边界条件。',
    evidenceIds:[input.references[0]!.id],resourceRefs:[],assistanceContext:'仅使用当前获准问题和材料。',unresolved:[],
    policyChecks:{containsWholeSolution:false,writesStudentWork:false,runsCode:false,makesFormalEvaluation:false}};
}
async function setup(steps:ConstructorParameters<typeof SyntheticProvider>[0],budget=true,
  extra:{runner?:I0AppOptions['runner'];studentHelp?:Partial<NonNullable<I0AppOptions['tutoring']>['studentHelp']>}={}) {
  const f=await fixture(undefined,{teaching:true}),student=await f.login(),teacher=await f.login('teacher');
  const allocation=await assigned(f,teacher),id=await opened(f,student,allocation.assignmentId);
  const provider=new SyntheticProvider(steps);
  const service=await createI0App({db:f.db,origin:'https://synthetic.example',signingSecret:f.signingSecret,
    now:f.timestamp,currentGeneration:f.generation,consumerIntervalMs:50,
    ...(extra.runner?{runner:extra.runner}:{}),
    tutoring:{studentHelp:{versions,budgetAvailable:()=>budget,...extra.studentHelp},provider}});
  async function help(question='给一点提示') {
    const head=await view(f,student,id);
    const response=await service.app.inject({method:'POST',url:`/api/attempts/${id}/help`,
      headers:{...student,'idempotency-key':randomUUID()},payload:{recoveryGeneration:'generation',
        expectedAttemptRevision:head.attempt.attemptRevision,question}});
    assert.equal(response.statusCode,200,response.body);return String(response.json().data.result.jobId);
  }
  const job=(jobId:string)=>f.db.withTransaction(tx=>readTeachingJob(tx,'course',jobId)!);
  const close=async()=>{await service.close();await f.close();};
  return {f,student,teacher,id,allocation,provider,service,help,job,close};
}
async function until(check:()=>boolean) {
  for(let i=0;i<100;i++) {if(check()) return;await delay(50);}
  assert.fail('Original job did not reach expected state');
}

test('normal tutoring consumer uses the original job without retaining or creating student sessions',async()=> {
  const f=await setup([request=>({body:body(request)})]);
  try {
    const jobId=await f.help(),before=f.f.db.withTransaction(tx=>tx.all('SELECT token_hash FROM sessions').length);
    f.service.startConsumer();await until(()=>f.job(jobId).status==='succeeded');
    assert.equal(f.provider.calls.length,1);
    assert.equal(f.f.db.withTransaction(tx=>tx.all('SELECT token_hash FROM sessions').length),before);
    const head=await view(f.f,f.student,f.id);
    const page=await f.service.app.inject({url:`/api/attempts/${f.id}/events?clientId=real-page&recoveryGeneration=generation&decisionEpoch=${head.attempt.decisionEpoch}&limit=100`,headers:f.student});
    assert.equal(page.statusCode,200,page.body);
    const action=page.json().data.events.find((e:{payload?:{content?:string}})=>e.payload?.content);
    assert.ok(action);assert.equal(action.payload.content,'先写出一个边界输入，再自行检查。');
    const history=await f.service.app.inject({url:`/api/attempts/${f.id}/teaching-records`,headers:f.student});
    assert.equal(history.json().data.actions.length,0,'unshown body stays outside cross-channel history');
  } finally {await f.close();}
});

test('withdrawn membership prevents automatic dispatch; budget refusal never calls a provider',async()=> {
  for(const withdraw of [true,false]) {
    const f=await setup([request=>({body:body(request)})],withdraw);
    try {
      const jobId=await f.help();
      if(withdraw) f.f.db.withTransaction(tx=>tx.run("UPDATE course_memberships SET active=0 WHERE course_id='course' AND user_id='student'"));
      f.service.startConsumer();await until(()=>f.job(jobId).status===(withdraw?'stale':'failed'));
      assert.equal(f.provider.calls.length,0);assert.equal(f.job(jobId).attemptCount,0);
    } finally {await f.close();}
  }
});

test('shutdown persists original teaching stop and aborts the in-process provider without a replacement job',async()=> {
  let entered!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve});
  const f=await setup([request=>new Promise((_resolve,reject)=> {
    entered();request.signal.addEventListener('abort',()=>reject(new Error('Synthetic abort')),{once:true});
  })]);
  try {
    const jobId=await f.help();f.service.startConsumer();await ready;
    await f.service.close();
    assert.equal(f.job(jobId).stopRequested,true);assert.equal(f.job(jobId).status,'cancelled');
    assert.equal(f.provider.calls.length,1);
    assert.equal(f.f.db.withTransaction(tx=>tx.all("SELECT job_id FROM jobs WHERE purpose='student_help'").length),1);
  } finally {await f.close();}
});

test('a prior worker lease is reconciled as unknown without another model call',async()=> {
  const f=await setup([request=>({body:body(request)})]);
  try {
    const jobId=await f.help();
    const original=f.job(jobId);
    f.f.db.withTransaction(tx=>saveJob(tx,{...original,status:'running',leaseToken:'previous-process',
      leaseUntil:new Date(f.f.timestamp()-1).toISOString(),attemptCount:1}));
    f.service.startConsumer();await until(()=>f.job(jobId).status==='outcome_unknown');
    assert.equal(f.provider.calls.length,0);assert.equal(f.job(jobId).attemptCount,1);
  } finally {await f.close();}
});

test('an in-flight C dispatch cannot block a newly accepted tutoring job',async()=> {
  let entered!:()=>void,release!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve}),hold=new Promise<void>(resolve=>{release=resolve});
  const fingerprint={profile:syntheticProfile,sourceHash:'d'.repeat(64)};
  const f=await setup([request=>({body:body(request)})],true,{runner:async command=> {
    if(command.op==='readiness') return {data:{ready:true,...syntheticProfile,recoveryGeneration:'generation',fingerprint,
      validation:{passed:true,fingerprintHash:createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'),validatedAt:new Date().toISOString()}}};
    entered();await hold;throw new Error('Synthetic original C response unavailable');
  }});
  try {
    const source=await files(f.f,f.student,f.id),frozen=await snapshot(f.f,f.student,f.id),head=await view(f.f,f.student,f.id);
    const run=await f.service.app.inject({method:'POST',url:`/api/attempts/${f.id}/runs`,headers:{...f.student,'idempotency-key':randomUUID()},
      payload:{recoveryGeneration:'generation',expectedAttemptRevision:head.attempt.attemptRevision,snapshotId:frozen,
        runtimeProfileVersion:syntheticProfile.runtimeProfileVersion,entryFileId:source.source,mode:'run',input:{operation:'stats',fileIds:[source.input]}}});
    assert.equal(run.statusCode,200,run.body);f.service.startConsumer();await ready;
    const jobId=await f.help();await until(()=>f.job(jobId).status==='succeeded');
    assert.equal(f.provider.calls.length,1);
  } finally {release();await f.close();}
});

test('internal completion rechecks the same trusted learner revision guard as public C3 completion',async()=> {
  const f=await setup([request=>({body:body(request)})],true,{studentHelp:{
    readLearnerState:()=>({learnerStateRevision:1,learnerClaims:[]}),readLearnerStateRevision:()=>2,
  }});
  try {
    const jobId=await f.help();f.service.startConsumer();await until(()=>f.job(jobId).status==='stale');
    const row=f.f.db.withTransaction(tx=>tx.get('SELECT action_json FROM teaching_actions WHERE job_id=?',jobId))!;
    const action=JSON.parse(String(row.action_json));
    assert.equal(action.disposition,'stale');assert.equal(action.basisRevised,true);
    assert.equal(f.provider.calls.length,1);
  } finally {await f.close();}
});
