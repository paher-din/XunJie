import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fixture, assigned, opened, files, snapshot, view, command, syntheticProfile } from '../workspace/test-support.ts';
import { createI0App } from './i0.ts';

function syntheticReadiness() {
  const fingerprint={profile:syntheticProfile,sourceHash:'d'.repeat(64)};
  return {data:{ready:true,...syntheticProfile,recoveryGeneration:'generation',fingerprint,
    validation:{passed:true,fingerprintHash:createHash('sha256').update(JSON.stringify(fingerprint)).digest('hex'),validatedAt:new Date().toISOString()}}};
}

test('student bootstraps own assignment with trusted generation and no attempt side effect', async () => {
  const f = await fixture();
  const student = await f.login(), teacher = await f.login('teacher');
  const assignment = await assigned(f,teacher);
  const service = await createI0App({ db:f.db, origin:'https://synthetic.example', signingSecret:f.signingSecret,
    now:f.timestamp,currentGeneration:f.generation });
  try {
    const before = await f.app.inject({url:'/api/assignments/'+assignment.assignmentId,headers:student});
    const response = await service.app.inject({url:'/api/assignments/'+assignment.assignmentId+'/bootstrap',headers:student});
    assert.equal(response.statusCode,200,response.body);
    assert.deepEqual(response.json().data,{assignment:before.json().data,recoveryGeneration:'generation'});
    const attempt = await service.app.inject({method:'POST',url:'/api/assignments/'+assignment.assignmentId+'/attempts',
      headers:{...student,'idempotency-key':'first'},payload:{recoveryGeneration:response.json().data.recoveryGeneration}});
    assert.equal(attempt.statusCode,200,attempt.body);
    const read = await service.app.inject({url:'/api/attempts/'+attempt.json().data.result.attemptId,headers:student});
    assert.equal(read.json().data.attempt.status,'ready');
    assert.deepEqual(read.json().data.files,[]);
    assert.deepEqual(read.json().data.jobs,[]);
  } finally { await service.close(); await f.close(); }
});

test('normal host serves only built public assets and rejects escaped or hidden paths', async () => {
  const { mkdtempSync, writeFileSync, mkdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dist = mkdtempSync(join(tmpdir(),'xunjie-i0-static-'));
  writeFileSync(join(dist,'index.html'),'<h1>Synthetic built UI</h1>');
  mkdirSync(join(dist,'assets'));
  writeFileSync(join(dist,'assets','app.js'),'export const built = true;');
  writeFileSync(join(dist,'.env'),'PRIVATE_SYNTHETIC_CONFIG');
  const f = await fixture();
  const service = await createI0App({db:f.db,origin:'https://synthetic.example',signingSecret:f.signingSecret,
    now:f.timestamp,currentGeneration:f.generation,staticDirectory:dist});
  try {
    const index = await service.app.inject({url:'/'});
    assert.equal(index.statusCode,200,index.body);
    assert.match(index.headers['content-type'] ?? '',/text\/html/);
    assert.equal(index.body,'<h1>Synthetic built UI</h1>');
    assert.equal((await service.app.inject({url:'/assets/app.js'})).body,'export const built = true;');
    for (const url of ['/.env','/%2e%2e/secret.txt','/assets/%2f..%2f.env','/synthetic.sqlite','/api/missing','/assets/']) {
      const response = await service.app.inject({url});
      assert.notEqual(response.statusCode,200,url);
      assert.doesNotMatch(response.body,/PRIVATE_SYNTHETIC_CONFIG/);
    }
  } finally { await service.close(); await f.close(); }
});


test('normal consumer runs original job without manual worker calls and shutdown confirms its stop', async () => {
  const { setTimeout: delay } = await import('node:timers/promises');
  const facts = new Map<string,object>();
  const runner: import('../records/runner.ts').RunnerTransport = async request => {
    if (request.op === 'readiness') {
      return syntheticReadiness();
    }
    const identity = request.op === 'submit' ? request.submission.identity : request.identity;
    if (request.op === 'submit') facts.set(identity.runId,{identity,state:'running',reserved:true,stopRequested:false,units:['synthetic-unit'],pending:[]});
    if (request.op === 'cancel') facts.set(identity.runId,{identity,state:'cancelled',reserved:false,stopRequested:true,units:[],pending:[]});
    return {data:facts.get(identity.runId) ?? null};
  };
  const f = await fixture(runner), teacher = await f.login('teacher'), student = await f.login();
  const allocation = await assigned(f,teacher), id = await opened(f,student,allocation.assignmentId);
  const ids = await files(f,student,id), snap = await snapshot(f,student,id), state = await view(f,student,id);
  const accepted = await command(f,student,'/api/attempts/'+id+'/runs',{expectedAttemptRevision:state.attempt.attemptRevision,
    snapshotId:snap,runtimeProfileVersion:syntheticProfile.runtimeProfileVersion,entryFileId:ids.source,input:{operation:'stats',fileIds:[ids.input]},mode:'run'});
  assert.equal(accepted.statusCode,200,accepted.body);
  const service = await createI0App({db:f.db,origin:'https://synthetic.example',signingSecret:f.signingSecret,
    now:f.timestamp,currentGeneration:f.generation,runner,consumerIntervalMs:50});
  try {
    service.startConsumer();
    let status = '';
    for (let i=0;i<60;i++) {
      const response = await service.app.inject({url:'/api/jobs/'+accepted.json().data.result.jobId,headers:student});
      status = response.json().data.status;
      if (status === 'running') break;
      await delay(20);
    }
    assert.equal(status,'running');
    await service.close();
    const stopped = await f.app.inject({url:'/api/jobs/'+accepted.json().data.result.jobId,headers:student});
    assert.equal(stopped.statusCode,200,stopped.body);
    assert.equal(stopped.json().data.status,'cancelled',stopped.body);
    assert.equal(stopped.json().data.stopRequested,true);
  } finally { await service.close(); await f.close(); }
});


test('controlled initializer creates a fresh synthetic host with login and original course policy', async () => {
  const { initializeI0 } = await import('./i0-initialize.ts');
  const { randomBytes } = await import('node:crypto');
  const password = randomBytes(32).toString('hex');
  const initialized = await initializeI0({synthetic:true,users:[
    {id:'synthetic-teacher',loginName:'synthetic-teacher',password},
    {id:'synthetic-student',loginName:'synthetic-student',password}],
    courses:[{id:'synthetic-course',teacherId:'synthetic-teacher',studentIds:['synthetic-student'],
      helpPolicy:{versionId:'synthetic-help',helpAllowed:true,wholeSolutionAllowed:false,limitedCheckHelpAllowed:false,description:'Synthetic'},
      checkRule:{versionId:'textscope-core-v1',validatorVersion:'textscope-validator-v2',limitedHelp:true,description:'Synthetic'}}]});
  const service = await createI0App({db:initialized.db,origin:'https://synthetic.example',
    signingSecret:randomBytes(48).toString('hex'),currentGeneration:()=>''});
  try {
    const logged = await service.app.inject({method:'POST',url:'/api/sessions',headers:{origin:'https://synthetic.example'},
      payload:{loginName:'synthetic-student',password}});
    assert.equal(logged.statusCode,200,logged.body);
    const cookie = logged.cookies.filter(c=>c.value).map(c=>c.name+'='+encodeURIComponent(c.value)).join('; ');
    const session = await service.app.inject({url:'/api/session',headers:{cookie}});
    assert.deepEqual(session.json().data.courses,[{courseId:'synthetic-course',role:'student'}]);
    const missing = await service.app.inject({url:'/api/assignments/unassigned/bootstrap',headers:{cookie}});
    assert.equal(missing.json().error.code,'FORBIDDEN');
  } finally { await service.close(); initialized.db.close(); }
});

test('bootstrap rejects anonymous, cross-student and cross-course readers and fails closed without trusted generation', async () => {
  const f=await fixture(),teacher=await f.login('teacher'),student=await f.login(),other=await f.login('other'),foreign=await f.login('foreign');
  const allocation=await assigned(f,teacher);
  let generation=f.generation();
  const service=await createI0App({db:f.db,origin:'https://synthetic.example',signingSecret:f.signingSecret,now:f.timestamp,currentGeneration:()=>generation});
  const url='/api/assignments/'+allocation.assignmentId+'/bootstrap';
  try {
    assert.equal((await service.app.inject({url})).json().error.code,'UNAUTHENTICATED');
    for (const headers of [other,foreign]) assert.equal((await service.app.inject({url,headers})).json().error.code,'FORBIDDEN');
    assert.equal((await service.app.inject({url,headers:teacher})).statusCode,200);
    generation='';
    assert.equal((await service.app.inject({url,headers:student})).json().error.code,'RECOVERY_REQUIRED');
    const denied=await service.app.inject({method:'POST',url:'/api/assignments/'+allocation.assignmentId+'/attempts',
      headers:{...student,'idempotency-key':'old'},payload:{recoveryGeneration:'generation'}});
    assert.equal(denied.json().error.code,'RECOVERY_REQUIRED');
    // Ordinary assignment reading is independent of first-write generation/readiness.
    assert.equal((await service.app.inject({url:'/api/assignments/'+allocation.assignmentId,headers:student})).statusCode,200);
  } finally {await service.close();await f.close();}
});

test('normal host keeps original sync replay, current revision and paused assignment save boundaries while runner is offline', async () => {
  const f=await fixture(),teacher=await f.login('teacher'),student=await f.login(),allocation=await assigned(f,teacher);
  let ready=false;
  const service=await createI0App({db:f.db,origin:'https://synthetic.example',signingSecret:f.signingSecret,
    now:f.timestamp,currentGeneration:f.generation,runner:async request=>{
      if (!ready || request.op!=='readiness') throw new Error('Synthetic offline');
      return syntheticReadiness();
    }});
  const post=(url:string,payload:object,key:string)=>service.app.inject({method:'POST',url,
    headers:{...student,'idempotency-key':key},payload:{recoveryGeneration:'generation',...payload}});
  try {
    const opened=await post('/api/assignments/'+allocation.assignmentId+'/attempts',{},'open');
    const id=String(opened.json().data.result.attemptId);
    const body={expectedWorkspaceRevision:0,clientId:'normal-page',clientSeq:1,operations:[{kind:'create',clientFileKey:'source',path:'main.c',text:'int main(void){return 0;}'}]};
    const first=await post('/api/attempts/'+id+'/sync',body,'sync');
    assert.equal(first.statusCode,200,first.body);
    const replay=await post('/api/attempts/'+id+'/sync',body,'sync');
    assert.equal(replay.json().data.receiptId,first.json().data.receiptId);
    assert.equal(replay.json().data.replayed,true);
    const conflict=await post('/api/attempts/'+id+'/sync',{...body,operations:[{...body.operations[0],text:'different'}]},'sync');
    assert.equal(conflict.json().error.code,'IDEMPOTENCY_CONFLICT');
    const head=await service.app.inject({url:'/api/attempts/'+id,headers:student});
    assert.equal(head.json().data.attempt.workspaceRevision,1);
    assert.equal(head.json().data.attempt.attemptRevision,2);
    const stale=await post('/api/attempts/'+id+'/sync',{...body,clientSeq:2},'stale');
    assert.equal(stale.json().error.code,'VERSION_CONFLICT');
    const old=await service.app.inject({method:'POST',url:'/api/attempts/'+id+'/sync',
      headers:{...student,'idempotency-key':'old-generation'},payload:{...body,recoveryGeneration:'old'}});
    assert.equal(old.json().error.code,'RECOVERY_REQUIRED');
    const noCsrf=await service.app.inject({method:'POST',url:'/api/attempts/'+id+'/sync',
      headers:{origin:student.origin,cookie:student.cookie,'idempotency-key':'csrf'},payload:{...body,recoveryGeneration:'generation'}});
    assert.equal(noCsrf.json().error.code,'FORBIDDEN');
    const paused=await service.app.inject({method:'POST',url:'/api/assignments/'+allocation.assignmentId+'/controls',headers:{...teacher,'idempotency-key':'pause'},
      payload:{recoveryGeneration:'generation',expectedAssignmentRevision:1,action:'pause',reason:'Synthetic review'}});
    assert.equal(paused.statusCode,200,paused.body);
    const bootstrap=await service.app.inject({url:'/api/assignments/'+allocation.assignmentId+'/bootstrap',headers:student});
    assert.equal(bootstrap.json().data.assignment.active,false);
    const update=await post('/api/attempts/'+id+'/sync',{expectedWorkspaceRevision:1,clientId:'normal-page',clientSeq:3,
      operations:[{kind:'update',fileId:first.json().data.result.created.source,baseVersion:1,text:'int main(void){return 1;}'}]},'update');
    assert.equal(update.statusCode,200,update.body);
    const forbidden=await post('/api/attempts/'+id+'/sync',{expectedWorkspaceRevision:2,clientId:'normal-page',clientSeq:4,
      operations:[{kind:'create',clientFileKey:'new',path:'new.c',text:''}]},'new');
    assert.equal(forbidden.json().error.code,'STATE_CONFLICT');
    const current=await service.app.inject({url:'/api/attempts/'+id,headers:student});
    assert.equal(current.json().data.files[0].text,'int main(void){return 1;}');
    const snapshot=await post('/api/attempts/'+id+'/snapshots',{expectedWorkspaceRevision:2},'snapshot');
    assert.equal(snapshot.statusCode,200,snapshot.body);
    const frozen=await service.app.inject({url:'/api/attempts/'+id+'/snapshots/'+snapshot.json().data.result.snapshotId,headers:student});
    assert.equal(frozen.statusCode,200,frozen.body);
    ready=true;
    const run=await post('/api/attempts/'+id+'/runs',{expectedAttemptRevision:current.json().data.attempt.attemptRevision,
      snapshotId:snapshot.json().data.result.snapshotId,runtimeProfileVersion:syntheticProfile.runtimeProfileVersion,
      entryFileId:first.json().data.result.created.source,input:{operation:'stats',fileIds:[first.json().data.result.created.source]},mode:'run'},'paused-run');
    assert.equal(run.json().error.code,'STATE_CONFLICT');
  } finally {await service.close();await f.close();}
});


test('bootstrap does not create an attempt: pausing allocation before first explicit creation still rejects it',async()=>{
  const f=await fixture(),teacher=await f.login('teacher'),student=await f.login(),allocation=await assigned(f,teacher);
  const service=await createI0App({db:f.db,origin:'https://synthetic.example',signingSecret:f.signingSecret,now:f.timestamp,currentGeneration:f.generation});
  try {
    assert.equal((await service.app.inject({url:'/api/assignments/'+allocation.assignmentId+'/bootstrap',headers:student})).statusCode,200);
    const pause=await command(f,teacher,'/api/assignments/'+allocation.assignmentId+'/controls',{expectedAssignmentRevision:1,action:'pause',reason:'Synthetic'},'pause');
    assert.equal(pause.statusCode,200,pause.body);
    const response=await service.app.inject({method:'POST',url:'/api/assignments/'+allocation.assignmentId+'/attempts',
      headers:{...student,'idempotency-key':'first-after-pause'},payload:{recoveryGeneration:'generation'}});
    assert.equal(response.json().error.code,'STATE_CONFLICT');
  } finally {await service.close();await f.close();}
});


test('unknown original job survives host restart and is reconciled without a replacement execution',async()=>{
  const facts=new Map<string,object>(); let confirms=false,submits=0;
  const runner:import('../records/runner.ts').RunnerTransport=async request=>{
    if (request.op==='readiness') {
      return syntheticReadiness();
    }
    const identity=request.op==='submit'?request.submission.identity:request.identity;
    if (request.op==='submit') {
      submits++;
      facts.set(identity.runId,{identity,state:'running',reserved:true,stopRequested:false,units:['synthetic'],pending:[]});
      throw new Error('Synthetic ACK lost');
    }
    if (request.op==='cancel') {
      if (!confirms) throw new Error('Synthetic stop link lost');
      facts.set(identity.runId,{identity,state:'cancelled',reserved:false,stopRequested:true,units:[],pending:[]});
    }
    return {data:facts.get(identity.runId) ?? null};
  };
  const f=await fixture(runner),teacher=await f.login('teacher'),student=await f.login(),allocation=await assigned(f,teacher);
  const id=await opened(f,student,allocation.assignmentId),ids=await files(f,student,id),snap=await snapshot(f,student,id),state=await view(f,student,id);
  const accepted=await command(f,student,'/api/attempts/'+id+'/runs',{expectedAttemptRevision:state.attempt.attemptRevision,
    snapshotId:snap,runtimeProfileVersion:syntheticProfile.runtimeProfileVersion,entryFileId:ids.source,input:{operation:'stats',fileIds:[ids.input]},mode:'run'});
  assert.equal(accepted.statusCode,200,accepted.body);
  const jobId=String(accepted.json().data.result.jobId);
  const options=()=>({db:f.db,origin:'https://synthetic.example',signingSecret:f.signingSecret,now:f.timestamp,currentGeneration:f.generation,runner,consumerIntervalMs:50});
  let service=await createI0App(options());
  try {
    service.startConsumer();
    const {setTimeout:delay}=await import('node:timers/promises');
    for(let i=0;i<60;i++){
      const read=await service.app.inject({url:'/api/jobs/'+jobId,headers:student});
      if(read.json().data.status==='outcome_unknown')break;
      await delay(20);
    }
    const beforeStop=await service.app.inject({url:'/api/jobs/'+jobId,headers:student});
    assert.equal(beforeStop.json().data.status,'outcome_unknown');
    await service.close();
    const unknown=await f.app.inject({url:'/api/jobs/'+jobId,headers:student});
    assert.equal(unknown.json().data.status,'cancelling');
    assert.equal(unknown.json().data.stopRequested,true);
    await f.reopen(); confirms=true;
    service=await createI0App(options()); service.startConsumer();
    let status='';
    for(let i=0;i<60;i++){
      const read=await service.app.inject({url:'/api/jobs/'+jobId,headers:student});
      status=read.json().data.status;
      if(status==='cancelled')break;
      await delay(20);
    }
    assert.equal(status,'cancelled');
    assert.equal(submits,1);
    const head=await service.app.inject({url:'/api/attempts/'+id,headers:student});
    assert.equal(head.json().data.jobs.length,1);
    assert.equal(head.json().data.runs.length,1);
    assert.equal(head.json().data.jobs[0].jobId,jobId);
  }finally{await service.close();await f.close();}
});

test('normal host serves the unchanged real UI build and authorized session over a loopback HTTP listener',async()=>{
  const {fileURLToPath}=await import('node:url');
  const {readFileSync}=await import('node:fs');
  const f=await fixture(),student=await f.login();
  const staticDirectory=fileURLToPath(new URL('../../../student/dist/',import.meta.url));
  const service=await createI0App({db:f.db,origin:'https://synthetic.example',signingSecret:f.signingSecret,now:f.timestamp,
    currentGeneration:f.generation,staticDirectory});
  try{
    const address=await service.app.listen({host:'127.0.0.1',port:0});
    const index=await fetch(address);
    assert.equal(index.status,200);
    const html=await index.text();
    assert.match(html,/id="root"/);
    assert.equal(html,readFileSync(new URL('../../../student/dist/index.html',import.meta.url),'utf8'));
    const bundle=html.match(/src="([^"]+\.js)"/)?.[1];
    assert.ok(bundle);
    const asset=await fetch(address+bundle);
    assert.equal(asset.status,200);
    assert.match(asset.headers.get('content-type')??'',/javascript/);
    const session=await fetch(address+'/api/session',{headers:{cookie:student.cookie}});
    assert.equal(session.status,200);
    const sessionBody=await session.json() as {data:{userId:string}};
    assert.equal(sessionBody.data.userId,'student');
    assert.notEqual((await fetch(address+'/.env')).status,200);
  }finally{await service.close();await f.close();}
});


test('shutdown refuses a new run whose readiness request was already in flight',async()=>{
  const f=await fixture(),teacher=await f.login('teacher'),student=await f.login(),allocation=await assigned(f,teacher);
  const id=await opened(f,student,allocation.assignmentId),ids=await files(f,student,id),snap=await snapshot(f,student,id),state=await view(f,student,id);
  let release!:(value:unknown)=>void, observed!:()=>void;
  const started=new Promise<void>(resolve=>{observed=resolve;});
  const waiting=new Promise<unknown>(resolve=>{release=resolve;});
  const service=await createI0App({db:f.db,origin:'https://synthetic.example',signingSecret:f.signingSecret,now:f.timestamp,currentGeneration:f.generation,
    runner:async request=>{if(request.op==='readiness'){observed();return waiting;}throw new Error('No new submit expected');}});
  try {
    const pending=service.app.inject({method:'POST',url:'/api/attempts/'+id+'/runs',headers:{...student,'idempotency-key':'during-close'},
      payload:{recoveryGeneration:'generation',expectedAttemptRevision:state.attempt.attemptRevision,snapshotId:snap,
        runtimeProfileVersion:syntheticProfile.runtimeProfileVersion,entryFileId:ids.source,input:{operation:'stats',fileIds:[ids.input]},mode:'run'}});
    await started;
    const closing=service.close();
    release(syntheticReadiness());
    const response=await pending;
    assert.notEqual(response.statusCode,200,response.body);
    await closing;
    assert.deepEqual((await view(f,student,id)).jobs,[]);
  }finally{await service.close();await f.close();}
});
