// Offline regressions exercise the actual verifier callbacks with synthetic I/O.
// No PAHER files, passwords, TLS listeners, database or runner are accessed.
import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';

const uiSource = readFileSync(new URL('./prepare-ui-handoff.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const verifySource = readFileSync(new URL('./verify-entry-https.mjs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const helperUrl = new URL('./entry-verification-helpers.mjs', import.meta.url);
const helperImport = existsSync(helperUrl) ? `import {exchangeHttps, stopApplication, assertReleasedActivity, assertFrozenActivity} from ${JSON.stringify(helperUrl.href)};` : '';
const helpers = existsSync(helperUrl) ? await import(helperUrl.href) : undefined;
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const responses = JSON.parse(readFileSync(new URL('../c-entry-https/http-final.json', import.meta.url), 'utf8'));
const preparation = JSON.parse(readFileSync(new URL('../c-entry-https/preparation.json', import.meta.url), 'utf8'));
const verified = JSON.parse(readFileSync(new URL('../c-entry-https/verification-final.json', import.meta.url), 'utf8'));

for (const [name, source, endMarker] of [['UI', uiSource, '\nlet metadata, failed'], ['HTTPS', verifySource, '\nfunction success(']]) {
  const requestFunction = source.slice(source.indexOf('async function request('), source.indexOf(endMarker));
  assert(requestFunction.startsWith('async function request('));
  for (const scenario of ['valid', 'asset_html', 'http_503', 'invalid_json', 'response_error', 'aborted', 'early_close', 'tls_rejected', 'fingerprint_mismatch', 'request_error', 'deadline']) {
    test(`${name}: ${scenario} settles through caller cleanup`, () => {
      const program = `
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
${helperImport}
const scenario=${JSON.stringify(scenario)}, config={origin:'https://synthetic.example'}, agent={};
const certificate={fingerprint256:'synthetic-fingerprint'}, samples=[];
const lifecycle={assertHealthy(){}}, currentCase=1;
let tlsVerified=0,requestCount=0;
const digest=x=>createHash('sha256').update(x).digest('hex'), publicValue=x=>x;
const https={request(options,callback){
  const req=new EventEmitter();req.destroy=error=>{if(error)queueMicrotask(()=>req.emit('error',error));return req;};
  req.setTimeout=(ms,fn)=>{req.deadline=fn;return req;};
  req.end=()=>setImmediate(()=>{
    if(scenario==='request_error'){req.emit('error',Object.assign(new Error('Synthetic request failure'),{code:'ECONNREFUSED'}));return;}
    if(scenario==='deadline'){req.deadline();return;}
    const res=new EventEmitter();res.socket={authorized:scenario!=='tls_rejected',getPeerCertificate:()=>({fingerprint256:scenario==='fingerprint_mismatch'?'wrong':'synthetic-fingerprint'})};
    res.statusCode=scenario==='http_503'?503:200;res.headers={'content-type':scenario==='asset_html'?'text/html':'application/json'};
    callback(res);
    if(scenario==='response_error'){res.emit('error',new Error('Synthetic response error'));return;}
    if(scenario==='aborted'){res.emit('aborted');res.emit('close');return;}
    if(scenario==='early_close'){res.emit('close');return;}
    res.emit('data',Buffer.from(scenario==='asset_html'?'<html>synthetic asset</html>':scenario==='invalid_json'?'invalid-json':JSON.stringify(scenario==='http_503'?{error:{code:'DEPENDENCY_UNAVAILABLE'}}:{data:{ok:true}})));
    res.emit('end');res.emit('close');
  });return req;
}};
${requestFunction}
let caught=false,finished=false,response;
try{response=await request({cookie:'',csrf:''},'GET',scenario==='asset_html'?'/assets/synthetic.html':'/api/synthetic');}
catch{caught=true;}
finally{finished=true;}
console.log(JSON.stringify({caught,finished,status:response?.status}));
`;
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', program], {encoding: 'utf8', timeout: 3000});
      assert.ifError(child.error);
      assert.equal(child.status, 0, 'Callback failure escaped the Promise or request never settled');
      const result = JSON.parse(child.stdout.trim());
      assert.equal(result.finished, true);
      // The full HTTPS verifier intentionally returns HTTP errors to denied(),
      // while malformed API JSON must reject instead of masquerading as an asset.
      const expectedCaught = scenario !== 'valid' && !(name === 'HTTPS' && ['http_503','asset_html'].includes(scenario))
        && !(name === 'UI' && scenario === 'fingerprint_mismatch');
      assert.equal(result.caught, expectedCaught);
      if (name === 'HTTPS' && scenario === 'http_503') assert.equal(result.status, 503);
    });
  }
}

const finalizer = uiSource.slice(uiSource.lastIndexOf('\nfinally {') + '\nfinally {'.length, uiSource.lastIndexOf('\n}'));
for (const scenario of ['normal_exit', 'signal_exit', 'exit_after_sigterm', 'unconfirmed']) {
  test(`UI finalizer: ${scenario} records actual stop state`, async () => {
    const child = new EventEmitter();
    Object.assign(child, {pid: 12345, exitCode: scenario === 'normal_exit' ? 0 : null,
      signalCode: scenario === 'signal_exit' ? 'SIGTERM' : null,
      kill() { if (scenario === 'exit_after_sigterm') queueMicrotask(() => {child.signalCode='SIGTERM';child.emit('exit',null,'SIGTERM');});return true; }});
    const log = new EventEmitter();Object.assign(log,{end:callback=>callback(),destroyed:false});
    const metadata = {}, fakeProcess = {}, writes = [];
    const run = new AsyncFunction('agent','child','log','metadata','evidenceDirectory','writeFileSync','console','failed','process','setTimeout','clearTimeout','stopApplication','lifecycle','phase',finalizer);
    await run({destroy(){}},child,log,metadata,'/synthetic',(...args)=>writes.push(args),{log(){}},false,fakeProcess,
      callback=>setTimeout(callback,1),clearTimeout,
      helpers ? (c,l,options)=>helpers.stopApplication(c,l,{...options,timeoutMs:1}) : undefined,
      {spawnFailed:false,dispose(){},failureCode:null},'shutdown');
    assert.equal(writes.length,1);
    assert.equal(metadata.stopConfirmed,scenario!=='unconfirmed');
    assert.equal(metadata.serviceRunning,scenario==='unconfirmed'?null:false);
    assert.equal(metadata.serviceState,scenario==='unconfirmed'?'unknown':'stopped');
    assert.equal(metadata.serverPid,12345);
    assert.equal(metadata.serverExitCode,child.exitCode);
    assert.equal(metadata.serverSignalCode,child.signalCode);
    if(scenario==='unconfirmed') {assert.equal(fakeProcess.exitCode,1);assert.equal(metadata.failureStage,'shutdown');}
  });
}

const release = responses.find(x=>x.case===5&&x.method==='POST').response.data;
const originalActivity = responses.find(x=>x.case===5&&x.method==='GET').response.data;
const publicResource = responses.find(x=>x.case===2&&x.request.material.kind!=='private_answer').response.data.result.resourceVersion;
const case5 = verifySource.match(/await runCase\(5,[\s\S]*?async \(\) => \{([\s\S]*?)\n  \}\);/)[1];
for (const mutation of ['original_archive', 'empty', 'wrong_profile', 'private_leak', 'wrong_course', 'wrong_revision']) {
  test(`Actual case 5: ${mutation}`, async () => {
    const activity = structuredClone(originalActivity);
    if(mutation==='empty') for(const key of Object.keys(activity)) delete activity[key];
    if(mutation==='wrong_profile') activity.runtimeProfileVersionId='wrong-profile';
    if(mutation==='private_leak') activity.content.materials[1]={status:'available',text:'SYNTHETIC_PRIVATE_SENTINEL'};
    if(mutation==='wrong_course') activity.courseId='wrong-course';
    if(mutation==='wrong_revision') activity.sourceRevision=999;
    const references = {...verified.references,publicMaterial:publicResource.material};
    const request = async (client,method,path)=>({status:200,body:{data:method==='POST'?release:
      {...activity,...(activity.content?{content:{...activity.content,audience:path.includes('audience=tutor')?'tutor':'student'}}:{})}}});
    const work = new AsyncFunction('assert','report','success','request','teacher','references','generation','key','input','preparation','assertReleasedActivity','assertFrozenActivity','readFrozenActivity',case5);
    const run = ()=>work(assert,{designConcerns:[]},r=>{assert.equal(r.status,200);return r.body.data;},request,{user:{id:'synthetic-i0-teacher-a'}},references,
      preparation.runtime.recoveryGeneration,x=>x,{courses:[{id:'synthetic-i0-course-a',teacherId:'synthetic-i0-teacher-a'}]},preparation,
      helpers?.assertReleasedActivity,helpers?.assertFrozenActivity,async()=>frozenFixture());
    if(mutation==='original_archive') await run();
    else await assert.rejects(run,{code:'ERR_ASSERTION'},'Invalid activity was accepted by the actual case 5 callback');
  });
}

function frozenFixture() {
  return {activityVersionId:verified.references.activityVersionId,courseId:'synthetic-i0-course-a',
    sourceBlueprintId:verified.references.blueprintId,sourceRevision:1,recoveryGeneration:preparation.runtime.recoveryGeneration,
    runtimeProfile:{runtimeProfileVersion:preparation.runtime.runtimeProfileVersion},
    runtimeReadiness:{...Object.fromEntries(['sourceHash','fingerprintHash','validatedAt'].map(k=>[k,preparation.runtime[k]])),checkedAt:verified.startedAt}};
}

test('Frozen readiness is checked independently of the public GET', {skip:!helpers}, () => {
  const expected = {...verified.references,courseId:'synthetic-i0-course-a',generation:preparation.runtime.recoveryGeneration,preparation:preparation.runtime};
  helpers.assertFrozenActivity(frozenFixture(),expected);
  for(const mutate of [x=>x.runtimeReadiness.sourceHash='0'.repeat(64),x=>x.runtimeReadiness.fingerprintHash='0'.repeat(64),
    x=>x.recoveryGeneration='wrong',x=>x.sourceRevision=999,x=>x.runtimeReadiness.checkedAt='invalid']) {
    const frozen=frozenFixture();mutate(frozen);assert.throws(()=>helpers.assertFrozenActivity(frozen,expected));
  }
});

test('Process/output/log errors reject the managed work and keep cleanup runnable', {skip:!helpers}, async () => {
  for(const origin of ['child','stdout','stderr','log']) {
    const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    const log=new EventEmitter(), lifecycle=helpers.monitorApplication(child,log);
    const running=lifecycle.run(()=>new Promise(()=>{}));
    (origin==='child'?child:origin==='log'?log:child[origin]).emit('error',new Error('Synthetic error'));
    await assert.rejects(running);assert.throws(()=>lifecycle.assertHealthy());lifecycle.dispose();
  }
});

test('An exit observed while finishing logs supersedes an earlier stop timeout', {skip:!helpers}, async () => {
  const child=new EventEmitter();Object.assign(child,{pid:12345,exitCode:null,signalCode:null,kill:()=>true});
  const log=new EventEmitter();Object.assign(log,{destroyed:false,end:callback=>{child.exitCode=0;callback();}});
  const result=await helpers.stopApplication(child,log,{timeoutMs:1});
  assert.equal(result.stopConfirmed,true);assert.equal(result.serviceState,'stopped');assert.equal(result.serviceRunning,false);
});
