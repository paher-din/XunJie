import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,readFileSync,writeFileSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setImmediate as turn} from 'node:timers/promises';
import {fixture,allocate} from '../../apps/teaching/tests/dl-a-support.ts';
import {CliError} from '../xj-dev/src/envelope.mjs';
import {runCapacity} from './capacity-run.mjs';

async function until(predicate){
  const end=performance.now()+10_000;
  while(!predicate()){assert(performance.now()<end,'controlled run did not reach the expected boundary');await turn();}
}
async function flush(){for(let i=0;i<100;i++)await turn();}
function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
function controlledWait(ms,value,{signal}){
  return new Promise((resolve,reject)=>{
    const cancelled=()=>{clearTimeout(timer);signal.removeEventListener('abort',cancelled);reject(new Error('synthetic aborted wait'));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',cancelled);resolve(value);},ms);
    if(signal.aborted)cancelled();else signal.addEventListener('abort',cancelled,{once:true});
  });
}

async function setup(t,publish,{wait=controlledWait,transferAtSeconds=[0,1],onBusinessFailureText,onClose}={}){
  const f=await fixture(undefined,{review:{versions:{modelConfigVersion:'disabled',promptVersion:'disabled',schemaVersion:'review-v1',analysisVersion:'review-v1'}}});
  await allocate(f,await f.login('teacher'),await f.login(),false);
  f.db.withTransaction(tx=>{for(const id of ['capacity-s3','capacity-s4']){
    tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length) SELECT ?,?,password_hash,salt,algorithm,n,r,p,key_length FROM users WHERE id=?',id,id,'student');
    tx.run("INSERT INTO course_memberships(course_id,user_id,role,active) VALUES('course',?,'student',1)",id);
  }});
  const root=mkdtempSync(join(tmpdir(),'xj133-failure-')),source='1'.repeat(40),labels=['T','S1','S2','S3','S4'];
  const users=['teacher','student','other','capacity-s3','capacity-s4'],privateFile=(name,data)=>{
    const file=join(root,name);writeFileSync(file,JSON.stringify(data),{mode:0o600});return file;
  };
  const actors=labels.map((label,i)=>({label,memberId:randomUUID(),home:join(root,label),deviceFile:join(root,label+'-device.json'),
    accountFile:privateFile(label+'-account.json',{loginName:users[i],password:f.password}),
    connectionFile:privateFile(label+'-connection.json',{browserOrigin:'https://synthetic.example',caFile:'unused-controlled-transport'})}));
  const files=['one.zip','two.zip'].map((name,i)=>{const file=join(root,name);writeFileSync(file,i?'fixture-two-bytes':'fixture-one');return file;});
  const config={windowApproved:true,seconds:905,expectedSource:source,runId:randomUUID(),actorsFile:privateFile('actors.json',{actors}),
    evidenceDirectory:join(root,'evidence'),courseId:'course',ports:Object.fromEntries(labels.map((label,i)=>[label,100+i])),
    modelAtSeconds:0,modelConfigRevision:2,transferAtSeconds,transferFiles:files};
  const state={uploadCalls:0,uploadFinished:0,closed:0,sendsAfterClose:0,fatalBusiness:false,requests:[],outcome:null};
  const synthetic=(data,status=200)=>({status,headers:{'x-request-id':randomUUID()},text:JSON.stringify({data}),bytes:10});
  const transportFactory=({port})=>{const label=labels[port-100];let closed=false;return {
    close(){if(!closed){closed=true;state.closed++;onClose?.(state);}},
    async send(input){
      if(closed){state.sendsAfterClose++;throw new Error('synthetic closed request');}
      state.requests.push({label,method:input.method,url:input.url});
      if(state.fatalBusiness&&label==='S1'&&input.method==='GET'&&/^\/api\/attempts\/[^/]+$/.test(input.url)){
        const response=synthetic(null,503);Object.defineProperty(response,'text',{get(){onBusinessFailureText?.();
          return JSON.stringify({error:{code:'DEPENDENCY_UNAVAILABLE',message:'synthetic-sensitive-response'}});}});return response;
      }
      if(input.url==='/health/live')return {...synthetic({}),headers:{'x-xunjie-version':source}};
      if(input.url==='/api/model-settings')return synthetic({revision:2});
      if(input.url==='/api/agent/turns')return synthetic({turnId:randomUUID()});
      if(input.url.startsWith('/api/agent/turns/'))return synthetic({message:{phase:'settled',text:'OK'}});
      const res=await f.app.inject({method:input.method,url:input.url,headers:input.headers,...(input.body?{payload:input.body}:{})});
      return {status:res.statusCode,headers:res.headers,text:res.body,bytes:Buffer.byteLength(res.body)};
    },
  };};
  t.mock.timers.enable({apis:['Date','setTimeout','setInterval'],now:Date.now()});
  const oldExit=process.exitCode;
  const running=runCapacity(config,{transportFactory,wait,publish:async(...args)=>{
    state.uploadCalls++;const value=await publish(state,...args);state.uploadFinished++;return value;
  }}).then(value=>{state.outcome={value};},error=>{state.outcome={error};});
  const receipt=()=>{const file=join(config.evidenceDirectory,'run.json');return existsSync(file)?JSON.parse(readFileSync(file,'utf8')):null;};
  await until(()=>receipt()?.phase==='steady-load'||state.outcome);
  return {state,config,running,receipt,
    events:()=>readFileSync(join(config.evidenceDirectory,'events.jsonl'),'utf8'),
    async tick(ms){t.mock.timers.tick(ms);await flush();},
    async close(){
      state.fatalBusiness=true;
      for(let i=0;!state.outcome&&i<10;i++){t.mock.timers.tick(910_000);await flush();}
      await running;t.mock.timers.reset();process.exitCode=oldExit;
      await f.close();rmSync(dirname(f.db.file),{recursive:true,force:true});rmSync(root,{recursive:true,force:true});
    }};
}
const published=bytes=>({record:{state:'published',reproId:'xjp_'+randomUUID(),bytes}});

test('safe OSS CliError is independently durable while ordinary 905s and the second scheduled upload continue',async t=>{
  const secret=['synthetic','sensitive','upload-diagnostic'].join('-');
  const h=await setup(t,async(state)=>{
    if(state.uploadCalls===1)throw new CliError('transfer','TRANSFER_STATE_INVALID',secret,{recovery:secret});
    return published(17);
  });
  try{
    await h.tick(0);await until(()=>h.state.uploadCalls===1||h.state.outcome);
    const first=h.receipt();
    assert.equal(first.transfers[0]?.state,'failed');
    assert.equal(first.transfers[0]?.actor,'T');assert.equal(first.transfers[0]?.plannedBytes,11);
    assert.equal(first.transfers[0]?.failureStage,'transfer');assert.equal(first.transfers[0]?.failureCode,'TRANSFER_STATE_INVALID');
    assert(Number.isFinite(first.transfers[0].elapsedMs));assert.equal(h.state.outcome,null);
    for(let i=0;i<16;i++)await h.tick(5000);
    assert.equal(h.state.uploadCalls,2);assert(h.receipt().actors.every(a=>a.iterations>=6));
    await h.tick(910_000);await h.tick(1000);await until(()=>h.state.outcome);
    assert.equal(h.state.outcome.error,undefined);assert.equal(h.state.outcome.value.overallPassed,false);
    const final=h.receipt();assert.equal(final.phase,'completed');assert(final.elapsedSeconds>=905);
    assert.equal(final.acceptance.businessRequestsAllSuccessful,true);assert.equal(final.acceptance.realUploadsPassed,false);
    assert.equal(final.acceptance.executionPassed,false);assert.equal(final.acceptance.overallPassed,false);assert.equal(final.transfers[1].state,'published');
    assert.equal(final.failureCode,'CAPACITY_EXTERNAL_DEPENDENCY_FAILED');
    assert.equal(JSON.parse(h.events().trim().split('\n').at(-1)).success,false);
    assert.equal(final.executionDrained,true);assert(!JSON.stringify(final).includes(secret));assert(!h.events().includes(secret));
  }finally{await h.close();}
});

for(const late of ['published','failed'])test(`business failure drains a late ${late} upload, keeps its first cause and has no post-return side effects`,async t=>{
  const upload=deferred();
  const h=await setup(t,async state=>{state.fatalBusiness=true;return upload.promise;});
  try{
    await h.tick(0);await until(()=>h.receipt()?.failureCode==='CAPACITY_HTTP_NON_200'||h.state.outcome);
    assert.equal(h.state.outcome,null,'failure must not return while publish can still create a remote object');
    const draining=h.receipt();assert.equal(draining.phase,'draining');
    assert.equal(draining.failureCode,'CAPACITY_HTTP_NON_200');
    assert.equal(draining.failureDetails.actor,'S1');assert.equal(draining.failureDetails.status,503);
    assert.equal(draining.failureDetails.route,'/api/attempts/:id');
    await h.tick(910_000);assert.equal(h.state.uploadCalls,1);assert.equal(h.state.outcome,null);
    if(late==='published')upload.resolve(published(11));
    else upload.reject(new CliError('enrollment','DEVICE_REVOKED','synthetic-private-late-error'));
    await flush();await until(()=>h.state.outcome);
    const final=h.receipt();assert.equal(h.state.outcome.error?.code,'CAPACITY_RUN_FAILED');
    assert.equal(final.phase,'failed');assert.equal(final.executionDrained,true);
    assert.equal(final.failureCode,draining.failureCode);assert.deepEqual(final.failureDetails,draining.failureDetails);
    assert.equal(final.transfers[0].state,late);assert.equal(final.transfers[1].state,'not_started');
    if(late==='failed'){assert.equal(final.transfers[0].failureStage,'enrollment');assert.equal(final.transfers[0].failureCode,'DEVICE_REVOKED');}
    assert.equal(h.state.uploadFinished,late==='published'?1:0);assert.equal(h.state.closed,5);assert.equal(h.state.sendsAfterClose,0);
    assert(!JSON.stringify(final).includes('synthetic-sensitive-response'));assert(!JSON.stringify(final).includes('synthetic-private-late-error'));
    const stable=JSON.stringify(final),events=h.events(),requests=h.state.requests.length;
    await h.tick(910_000);assert.equal(JSON.stringify(h.receipt()),stable);assert.equal(h.events(),events);
    assert.equal(h.state.requests.length,requests);assert.equal(h.state.uploadCalls,1);
    assert.equal(h.state.sendsAfterClose,0);
    assert.equal(JSON.parse(events.trim().split('\n').at(-1)).phase,'failed');
  }finally{upload.resolve(published(11));await flush();await h.close();}
});

test('a fulfilled upload wait whose continuation follows fatal never starts publication',async t=>{
  let releaseUploadWait,waitFulfilled=false,firstCloseSawFulfilled=false;
  const h=await setup(t,async()=>published(11),{
    transferAtSeconds:[1.234,2],
    wait(ms,value,{signal}){
      if(ms!==1234)return controlledWait(ms,value,{signal});
      // Like a timer: fulfillment removes its abort listener. A later abort cannot undo it.
      return new Promise((resolve,reject)=>{
        const abort=()=>reject(new Error('synthetic aborted upload wait'));
        signal.addEventListener('abort',abort,{once:true});
        releaseUploadWait=()=>{signal.removeEventListener('abort',abort);waitFulfilled=true;resolve(value);};
      });
    },
    onBusinessFailureText(){
      // The HTTP rejection propagates through the real client/workflow to track(). Fulfill the timer
      // after those rejection reactions are queued, just before fatal runs and before upload resumes.
      queueMicrotask(()=>queueMicrotask(()=>queueMicrotask(()=>releaseUploadWait())));
    },
    onClose(state){if(state.closed===1)firstCloseSawFulfilled=waitFulfilled;},
  });
  try{
    assert.equal(typeof releaseUploadWait,'function');h.state.fatalBusiness=true;
    await h.tick(0);await until(()=>h.state.outcome);
    assert.equal(waitFulfilled,true);assert.equal(firstCloseSawFulfilled,true,'wait really fulfilled before fatal closed transports');
    assert.equal(h.state.uploadCalls,0,'a continuation resumed in draining must not start publish');
    const final=h.receipt();assert.equal(h.state.outcome.error?.code,'CAPACITY_RUN_FAILED');
    assert.equal(final.executionDrained,true);assert.equal(final.phase,'failed');
    assert.equal(final.failureCode,'CAPACITY_HTTP_NON_200');assert.equal(final.failureDetails.status,503);
    assert(final.transfers.every(row=>row.state==='not_started'));assert.equal(h.state.sendsAfterClose,0);
    const stable=JSON.stringify(final),events=h.events();await h.tick(910_000);
    assert.equal(JSON.stringify(h.receipt()),stable);assert.equal(h.events(),events);assert.equal(h.state.uploadCalls,0);
  }finally{releaseUploadWait?.();await flush();await h.close();}
});
