import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {promisify} from 'node:util';
import {setTimeout} from 'node:timers/promises';
import {test} from 'node:test';
import {manifestHash,sha256} from './snapshot.ts';
import {textScopeArgs} from './run-snapshot.ts';
import type {TextScopeInput} from './run-snapshot.ts';
import type {SubmitRun,RunnerCommand} from '../contracts/runner/index.ts';

const exec=promisify(execFile);
const enabled=process.platform==='linux'&&process.env.XUNJIE_C1_SSH==='1';
const base=process.env.XUNJIE_C1_HOST_BASE??'/opt/xunjie-runner/vm';
const options=(role:string)=>['-i',`${base}/keys/${role}`,'-o',`UserKnownHostsFile=${base}/keys/known_hosts`,
  '-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','-p','2222','root@127.0.0.1'];
async function rpc(request:RunnerCommand|object|string,role='application') {
  const result=await new Promise<string>((resolve,reject)=>{
    const child=execFile('/usr/bin/ssh',[...options(role),role==='application'?'xunjie-c1':
      '/opt/xunjie-runner/node/bin/node /opt/xunjie-runner/source/runner/ssh-control.ts maintenance'],
      {timeout:160000,maxBuffer:1024*1024},(_error,stdout)=>stdout?resolve(stdout):reject(_error));
    child.stdin!.end(JSON.stringify(request));
  });
  return JSON.parse(result);
}
async function maintain(command:string) {return (await exec('/usr/bin/ssh',[...options('maintenance'),command],{timeout:70000,maxBuffer:1024*1024})).stdout.trim();}
async function fact(submission:SubmitRun) {const value=await rpc({op:'query',identity:submission.identity});assert(!value.error,JSON.stringify(value));return value.data;}
async function until(condition:()=>Promise<boolean>,timeout=45000) {
  const end=Date.now()+timeout;
  while(Date.now()<end){if(await condition())return;await setTimeout(100);}
  assert.fail('Dedicated node did not reach expected state');
}

const report='FILE "a.txt" 3 8 37\nFILE "b.txt" 1 3 14\nTOTAL 4 11 51\nUNIQUE 7\nTOP c 3\nTOP is 2\nTOP memory 2\nTOP and 1\nTOP fast 1\nTOP fun 1\nTOP matters 1\n';
// Synthetic fixture only implements this test's two inputs; it is not a course solution.
const validSource=`#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <errno.h>
#include <limits.h>
_Static_assert(INT_MAX==2147483647,"Approved C int profile");
int main(int n,char **v){
 if(n<2){fputs("usage\\n",stderr);return 2;}
 if(!strcmp(v[1],"stats")){
  if(n<3){fputs("usage\\n",stderr);return 2;}
  for(int i=2;i<n;i++){FILE *f=fopen(v[i],"r");if(!f){fputs("cannot open\\n",stderr);return 1;}fclose(f);}
  puts("a.txt\\t3\\t8\\t37\\nb.txt\\t1\\t3\\t14\\nTOTAL\\t4\\t11\\t51");return 0;}
 if(!strcmp(v[1],"top")){if(n<5){fputs("usage\\n",stderr);return 2;}char *end;errno=0;long count=strtol(v[3],&end,10);
  if(errno||*end||count<1||count>INT_MAX){fputs("usage\\n",stderr);return 2;}
  const char *rows[]={"c 3","is 2","memory 2","and 1","fast 1","fun 1","matters 1"};for(int i=0;i<7&&i<count;i++)puts(rows[i]);return 0;}
 if(!strcmp(v[1],"find")){puts("a.txt:1:C is fun.\\na.txt:2:C is fast.\\nb.txt:1:C and memory.");return 0;}
 if(!strcmp(v[1],"report")){FILE *f=fopen(v[3],"w");if(!f)return 1;fputs(${JSON.stringify(report)},f);fclose(f);return 0;}
 fputs("usage\\n",stderr);return 2;}
`;

test('authenticated dedicated VM control and supervision',{skip:!enabled},async t=>{
  const ready=await rpc({op:'readiness'});assert(!ready.error,JSON.stringify(ready));
  let generation=ready.data.recoveryGeneration;
  assert.equal(typeof generation,'string');
  const profile=ready.data;
  const initialRecovery=await rpc({op:'recover'},'maintenance');assert(!initialRecovery.error,JSON.stringify(initialRecovery));
  function submission(source:string,input:TextScopeInput={operation:'stats',fileIds:['a','b']},mode:'run'|'check'='run'):SubmitRun {
    const files=[{fileId:'source',path:'main.c',text:source},{fileId:'a',path:'a.txt',text:'C is fun.\nC is fast.\nMemory matters.\n'},
      {fileId:'b',path:'b.txt',text:'C and memory.\n'}].map(file=>({...file,documentVersion:1,contentHash:sha256(file.text)}));
    const snapshot={snapshotId:`synthetic-${randomUUID()}`,hashFormat:'sha256-manifest-v1' as const,hash:manifestHash(files),files};
    const identity={runId:`synthetic-${randomUUID()}`,commandId:`synthetic-${randomUUID()}`,requestHash:sha256(JSON.stringify({snapshot,input,mode})),
      recoveryGeneration:generation,snapshotId:snapshot.snapshotId,snapshotHash:snapshot.hash,inputHash:sha256(JSON.stringify(textScopeArgs(snapshot,input,['report.txt']))),
      runtimeProfileVersion:profile.runtimeProfileVersion,imageDigest:profile.imageDigest,
      authorizedScope:{userId:'synthetic-student',courseId:'synthetic-course',attemptId:`synthetic-${randomUUID()}`,purpose:'student_run' as const}};
    return {identity,snapshot,entryFileId:'source',input,mode,...(mode==='check'?{checkRuleVersion:input.operation==='report'?'textscope-report-v1':'textscope-core-v1'}:{})};
  }
  async function submit(item:SubmitRun){const value=await rpc({op:'submit',submission:item});assert(!value.error,JSON.stringify(value));return value.data;}
  async function finished(item:SubmitRun){await until(async()=>!(await fact(item)).reserved&&['succeeded','cancelled','failed','stale'].includes((await fact(item)).state));return (await rpc({op:'readResult',identity:item.identity})).data;}
  const spin='#include <stdio.h>\nint main(void){puts("started");fflush(stdout);for(;;){}return 0;}';
  async function executing(item:SubmitRun){await until(async()=>await maintain(`/opt/xunjie-runner/engine/docker --host=unix:///run/xunjie-c1-docker.sock inspect --format '{{.State.Running}}' xunjie-${sha256(item.identity.runId)}-execute 2>/dev/null || true`)==='true');}

  await t.test('SSH application entry rejects shell, role injection, maintenance and unknown credential',async()=>{
    assert.equal((await rpc({op:'recover'})).error.code,'FORBIDDEN');
    assert.equal((await rpc({op:'readiness',role:'maintenance'})).error.code,'FORBIDDEN');
    assert.equal((await rpc('invalid')).error.code,'FORBIDDEN');
    const shell=await exec('/usr/bin/ssh',[...options('application'),'cat /etc/shadow']).catch(error=>({stdout:error.stdout}));
    assert.equal(JSON.parse(shell.stdout).error.code,'FORBIDDEN');
    const none=await exec('/usr/bin/ssh',['-o','IdentityAgent=none','-o','IdentitiesOnly=yes','-o','IdentityFile=none',
      '-o',`UserKnownHostsFile=${base}/keys/known_hosts`,'-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','-p','2222','root@127.0.0.1','true']).then(()=>false,()=>true);
    assert(none);
    assert.equal(await maintain('/usr/bin/flock --nonblock /opt/xunjie-runner/state/controller.lock /usr/bin/true; echo $?'),'1');
    assert.equal(await maintain('nproc'),'2');
    assert(!/\b(9p|virtiofs|drvfs)\b/.test(await maintain('cat /proc/mounts')));
  });
  await t.test('trusted Core and Report check real output, error exits and immutable original results',async()=>{
    for(const input of [{operation:'stats',fileIds:['a','b']},{operation:'find',word:'C',fileIds:['a','b']},
      {operation:'top',count:'3',fileIds:['a','b']},{operation:'report',resultFile:'report.txt',fileIds:['a','b']}] as TextScopeInput[]) {
      const item=submission(validSource,input,'check');await submit(item);const result=await finished(item);
      assert.equal(result.verdict,'passed',JSON.stringify(result));assert.equal(result.checkResults.length,6);
      assert.deepEqual(result.phases.slice(1).map((phase:any)=>phase.exitCode),[0,2,2,2,2,1]);
      assert.equal(result.checkResults[0].source,'trusted_validator');
      const before=await fact(item);const duplicate=await submit(item);assert.equal(duplicate.resultRef,before.resultRef);
      assert.equal(duplicate.units.length,1);
      assert.equal((await rpc({op:'submit',submission:{...item,identity:{...item.identity,requestHash:sha256('other')}}})).error.code,'IDEMPOTENCY_CONFLICT');
      assert.equal((await rpc({op:'query',identity:{...item.identity,authorizedScope:{...item.identity.authorizedScope,userId:'other'}}})).error.code,'FORBIDDEN');
      if(input.operation==='report'){assert.equal(result.resultFiles[0].text,report);assert.equal(result.resultFiles[0].contentHash,sha256(report));}
    }
    const fake=submission('#include <stdio.h>\nint main(void){puts("passed");return 0;}',undefined,'check');
    await submit(fake);assert.equal((await finished(fake)).verdict,'failed');
    const broken=submission('this is not C',undefined,'check');await submit(broken);
    assert.equal((await finished(broken)).failureKind,'compile_error');
  });
  await t.test('legal names colliding with missing-file sentinel still pass the trusted missing case',async()=>{
    const item=submission(validSource,undefined,'check');
    item.snapshot.files.push(...['__xunjie_missing_input__','__xunjie_missing_input__.1/child.txt'].map((path,index)=>({
      fileId:`collision-${index}`,path,documentVersion:1,text:'legal student file',contentHash:sha256('legal student file')})));
    item.snapshot.hash=manifestHash(item.snapshot.files);item.identity.snapshotHash=item.snapshot.hash;
    item.identity.requestHash=sha256(JSON.stringify({snapshot:item.snapshot,input:item.input,mode:item.mode}));
    await submit(item);const result=await finished(item);
    assert.equal(result.verdict,'passed');assert.equal(result.phases.at(-1).exitCode,1);
  });
  await t.test('C int maximum is normal, while overflow is rejected or checked as expected exit two',async()=>{
    const item=submission(validSource,{operation:'top',count:'2147483647',fileIds:['a','b']},'check');
    await submit(item);const result=await finished(item);
    assert.equal(result.verdict,'passed');assert.equal(result.checkResults[0].validatorVersion,'textscope-validator-v2');
    assert.deepEqual(result.phases.slice(1).map((phase:any)=>phase.exitCode),[0,2,2,2,2,1]);
    item.input.count='2147483648';
    assert.equal((await rpc({op:'submit',submission:item})).error.code,'INVALID_REQUEST');
  });
  await t.test('cancel before submit is durable; running cancellation waits for original units',async()=>{
    const pre=submission(spin);assert.equal((await rpc({op:'cancel',identity:pre.identity})).data.state,'cancelled');
    await maintain('systemctl restart xunjie-c1.service');assert.equal((await submit(pre)).state,'cancelled');
    assert.equal((await fact(pre)).units.length,0);
    const running=submission(spin);await submit(running);await executing(running);
    const first=await rpc({op:'cancel',identity:running.identity});assert(['cancelling','cancelled'].includes(first.data.state));
    const result=await finished(running);assert.equal((await fact(running)).state,'cancelled');
    assert.equal(result.unitTerminated,true);assert.equal(result.failureKind,'cancelled');
  });
  await t.test('multiple checks share ten seconds and stdout plus report share 64 KiB',async()=>{
    const slow=submission('#include <unistd.h>\nint main(void){sleep(3);return 0;}',undefined,'check');
    await submit(slow);const timed=await finished(slow);
    assert.equal(timed.failureKind,'timeout');assert.equal(timed.verdict,'incomplete');
    assert(timed.phases.slice(1).reduce((sum:number,phase:any)=>sum+phase.durationMs,0)<12000);
    assert(timed.phases.length<6);
    const large=submission('#include <stdio.h>\nint main(void){for(int i=0;i<30000;i++)putchar(65);FILE *f=fopen("report.txt","w");for(int i=0;i<40000;i++)fputc(66,f);fclose(f);return 0;}',
      {operation:'report',fileIds:['a','b'],resultFile:'report.txt'},'check');
    await submit(large);const exceeded=await finished(large);
    assert.equal(exceeded.failureKind,'output_limit');assert.equal(exceeded.verdict,'incomplete');
  });
  await t.test('controller crash preserves independent timeout, original identity and queued work',async()=>{
    const one=submission(spin),two=submission(spin),three=submission(validSource);
    await submit(one);await submit(two);await submit(three);
    assert.equal((await fact(three)).state,'queued');
    const collision=submission(spin);collision.identity.authorizedScope=one.identity.authorizedScope;
    assert.equal((await rpc({op:'submit',submission:collision})).error.code,'STATE_CONFLICT');
    await executing(one);await executing(two);
    await maintain('systemctl kill --kill-whom=main --signal=SIGKILL xunjie-c1.service');
    await setTimeout(1500);
    assert.equal((await rpc({op:'readiness'})).data.recoveryGeneration,generation);
    const result=await finished(one);assert.equal(result.failureKind,'timeout');assert.equal(result.unitTerminated,true);
    assert.equal((await finished(two)).failureKind,'timeout');
    assert.equal((await finished(three)).phases[1].exitCode,0);
    assert.equal((await submit(one)).resultRef,(await fact(one)).resultRef);
  });
  await t.test('worker crash keeps unknown reserved until authenticated Engine recovery barrier',async()=>{
    const item=submission(spin);await submit(item);await executing(item);
    await maintain(`systemctl kill --kill-whom=main --signal=SIGKILL xunjie-job-${sha256(item.identity.runId)}`);
    await until(async()=>(await fact(item)).state==='outcome_unknown');
    assert.equal((await fact(item)).reserved,true);
    const recovered=await rpc({op:'recover'},'maintenance');assert(!recovered.error,JSON.stringify(recovered));
    assert(recovered.data.reconciled.includes(item.identity.runId));
    const result=await finished(item);assert.equal(result.executionOutcome,'outcome_unknown');
    assert.equal(result.unitTerminated,true);assert.equal((await fact(item)).reserved,false);
  });
  await t.test('registered new generation rejects old control and never reruns original ID',async()=>{
    const item=submission(validSource);await submit(item);await finished(item);
    const old=generation;generation=`synthetic-generation-${randomUUID()}`;
    assert(!(await rpc({op:'advanceGeneration',generation},'maintenance')).error);
    assert.equal((await rpc({op:'query',identity:item.identity})).error.code,'RECOVERY_REQUIRED');
    item.identity.recoveryGeneration=generation;
    assert.equal((await submit(item)).state,'succeeded');
    assert.equal((await rpc({op:'advanceGeneration',generation:old},'maintenance')).error.code,'RECOVERY_REQUIRED');
    await maintain('systemctl restart xunjie-c1.service');
    assert.equal((await rpc({op:'readiness'})).data.recoveryGeneration,generation);
  });
  assert.equal(await maintain('/opt/xunjie-runner/engine/docker --host=unix:///run/xunjie-c1-docker.sock ps -q'),'');
});
