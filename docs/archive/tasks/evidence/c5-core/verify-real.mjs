import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

// Only the approved PAHER synthetic environment; authentication material never enters evidence.
const [source,output]=process.argv.slice(2);
assert.equal(process.version,'v24.21.0');assert.equal(process.getuid(),0);
const root='/opt/xunjie-runner/tests/i0-entry-20261013-01';
const config=JSON.parse(readFileSync(root+'/i0-host-recovered-20261014.json','utf8'));
const initializer=JSON.parse(readFileSync(root+'/initializer.json','utf8'));
const load=path=>import(pathToFileURL(source+'/apps/teaching/'+path));
const {executionTransports}=await load('server/app/execution-transport.ts');
const {initializeSyntheticApplication}=await load('server/app/initialize.ts');
const {createDigitalLogicApplication}=await load('server/app/digital-logic.ts');
const {configuration}=await load('tests/dl-a-support.ts');
const transports=executionTransports(config.ssh);
const c=(await transports.runner({op:'readiness'})).data,h=(await transports.hdlTransport({op:'hdl_readiness'})).data;
assert.equal(c.ready,true);assert.equal(h.ready,true);assert.equal(c.recoveryGeneration,h.recoveryGeneration);
const manifest={synthetic:true,recoveryGeneration:h.recoveryGeneration,accounts:initializer.users,courses:initializer.courses.map(x=>x.id),
  memberships:initializer.courses.flatMap(x=>[{courseId:x.id,userId:x.teacherId,role:'teacher'},...x.studentIds.map(userId=>({courseId:x.id,userId,role:'student'}))])};
const db=await initializeSyntheticApplication(manifest,transports,[h.profile]);
const evidence={sourceCommit:'37b628b75ec3a2238b9b77c8bd1882d36a2e55a6',startedAt:new Date().toISOString(),node:process.version,
  scope:'fresh isolated synthetic 35-table application, authenticated real VM; app.inject HTTP transport; no browser/model',
  databaseFile:db.file,cReadiness:c,hdlReadiness:h,http:[],checks:[]};
const host=await createDigitalLogicApplication({db,origin:config.origin,signingSecret:readFileSync(config.signingSecretFile,'utf8').trim(),
  ...transports,approvedHdlRuntimes:[h.profile],studentHelp:{versions:{modelConfig:'disabled',prompt:'disabled',schema:'disabled',policy:'current'},budgetAvailable:()=>false}});
const gen=h.recoveryGeneration,origin=config.origin,sessions=[];
async function http(method,url,payload,headers={},expected=200,key=randomUUID()){
  const r=await host.app.inject({method,url,headers:{origin,...headers,...(method==='POST'?{'idempotency-key':key}:{})},
    ...(payload===undefined?{}:{payload:{recoveryGeneration:gen,...payload}})});
  const body=r.json();if(url!=='/api/sessions')evidence.http.push({method,url,status:r.statusCode,body});
  assert.equal(r.statusCode,expected,JSON.stringify({method,url,status:r.statusCode,body}));return {r,body};
}
async function login(id){const user=initializer.users.find(x=>x.id===id);assert(user);
  const r=await host.app.inject({method:'POST',url:'/api/sessions',headers:{origin},payload:{loginName:user.loginName,password:user.password}});
  assert.equal(r.statusCode,200,'Synthetic login failed');return {cookie:r.cookies.filter(x=>x.value).map(x=>x.name+'='+encodeURIComponent(x.value)).join('; '),'x-csrf-token':r.json().data.csrfToken};}
const get=async(url,headers)=>(await http('GET',url,undefined,headers)).body.data;
const post=async(url,payload,headers,key)=>(await http('POST',url,payload,headers,200,key)).body.data.result;
async function until(read,done){const deadline=Date.now()+60000;while(Date.now()<deadline){const v=await read();if(done(v))return v;await delay(100);}throw new Error('Bounded operation did not settle');}
async function allocate(course,teacher,student,hdl){
  let configId;
  if(hdl){const cfg={...configuration('synthetic-c5-'+randomUUID()),runtime:h.profile};configId=cfg.versionId;
    await post(`/api/courses/${course.id}/hdl-configurations`,{configuration:cfg},teacher);}
  const goals=[{competencyId:'k',competencyVersion:1,domain:'domain',title:'Explain results'},
    {competencyId:'p',competencyVersion:1,domain:'project',title:'Compare versions'},
    {competencyId:'a',competencyVersion:1,domain:'ai_collaboration',title:'Check tool evidence'}];
  const refs=goals.map(({competencyId,competencyVersion})=>({competencyId,competencyVersion}));
  const draft=await post(`/api/courses/${course.id}/blueprints`,{mode:'manual',content:{projectTitle:'C5 synthetic execution',problem:'Verify immutable results',audience:'Engineering',artifact:hdl?'HDL':'C',routes:['compare'],goals,
    tasks:[{taskId:'t',title:'Compare',goalRefs:refs}],observations:[{observationId:'o',description:'Observe',goalRefs:refs,taskIds:['t']}],rubricCriteria:[{criterionId:'r',description:'Explain',goalRefs:refs,observationIds:['o']}],milestones:[{milestoneId:'m',title:'Review',taskIds:['t']}],resources:[],
    helpPolicyVersionId:course.id+'-help',checkRuleVersionId:hdl?'hdl-board-structure-v1':'textscope-core-v1',runtimeProfileVersionId:hdl?h.profile.runtimeProfileVersion:c.runtimeProfileVersion,...(hdl?{digitalLogicConfigVersionId:configId}:{})}},teacher);
  const report=await post(`/api/blueprints/${draft.draft.blueprintId}/checks`,{expectedRevision:1},teacher);assert.equal(report.report.blocking.length,0);
  const release=await post(`/api/blueprints/${draft.draft.blueprintId}/releases`,{expectedRevision:1,confirmed:true},teacher);
  const assignment=await post(`/api/activities/${release.activityVersionId}/assignments`,{expectedActivityControlRevision:1,studentIds:[course.studentIds[0]]},teacher);
  return (await post(`/api/assignments/${assignment.assignments[0].assignmentId}/attempts`,{},student)).attemptId;
}
async function save(id,headers,text,path='top.sv'){
  const head=await get(`/api/attempts/${id}`,headers),file=head.files.find(x=>x.path===path);
  const ack=await post(`/api/attempts/${id}/sync`,{expectedWorkspaceRevision:head.attempt.workspaceRevision,clientId:'synthetic-c5',clientSeq:head.attempt.workspaceRevision+1,
    operations:[file?{kind:'update',fileId:file.fileId,baseVersion:file.documentVersion,text}:{kind:'create',clientFileKey:path,path,text}]},headers);
  return {ack,snapshotId:(await post(`/api/attempts/${id}/snapshots`,{expectedWorkspaceRevision:(await get(`/api/attempts/${id}`,headers)).attempt.workspaceRevision},headers)).snapshotId};
}
async function build(id,headers,snapshotId){const ack=await post(`/api/attempts/${id}/hdl/builds`,{expectedAttemptRevision:(await get(`/api/attempts/${id}`,headers)).attempt.attemptRevision,snapshotId},headers);
  const view=await until(()=>get(`/api/hdl/builds/${ack.buildId}`,headers),x=>!['queued','running'].includes(x.status));assert(view.result);return {ack,result:view.result,request:view.request};}
async function program(id,headers,buildId,previous){
  const ack=await post(`/api/attempts/${id}/hdl/programs`,{expectedAttemptRevision:(await get(`/api/attempts/${id}`,headers)).attempt.attemptRevision,buildId,
    ...(previous?{replaceSessionId:previous.sessionId,expectedSessionRevision:previous.sessionRevision}:{})},headers);
  sessions.push({id,headers,sessionId:ack.sessionId});
  return until(()=>get(`/api/hdl/sessions/${ack.sessionId}`,headers),x=>x.status==='active'&&!x.pendingOperationId);
}
async function interact(id,headers,state,cycles,buttons='00001',key=randomUUID()){
  const payload={expectedAttemptRevision:(await get(`/api/attempts/${id}`,headers)).attempt.attemptRevision,sessionId:state.sessionId,
    expectedSessionRevision:state.sessionRevision,expectedSequence:state.confirmedSequence+1,inputs:{switches:'0000000000000011',buttons,resetN:'1'},advanceCycles:cycles};
  const ack=await post(`/api/attempts/${id}/hdl/interactions`,payload,headers,key);
  const trace=await until(()=>get(`/api/hdl/sessions/${state.sessionId}/trace?afterSequence=${state.confirmedSequence}`,headers),x=>!!x.operation?.result);
  assert.equal(trace.operation.result.operationId,ack.operationId);return {ack,payload,key,trace};
}
const rtl=`module top(input clk,input [15:0] sw,input [4:0] btn,output [15:0] led,output [7:0] an,output [6:0] seg,output dp);
reg [15:0] count=0;reg [2:0] scan=0;always @(posedge clk) begin scan<=scan+1;if(btn[0])count<=count+1;end
assign led=count;assign an=~(8'b1<<scan);assign seg=sw[6:0];assign dp=0;endmodule\n`;
try{
  assert.equal(db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length),35);
  host.startConsumer();
  const cc=initializer.courses[0],hc=initializer.courses[1],teacher=await login(hc.teacherId),student=await login(hc.studentIds[0]),ct=await login(cc.teacherId),cs=await login(cc.studentIds[0]);
  const id=await allocate(hc,teacher,student,true),saved=await save(id,student,rtl),first=await build(id,student,saved.snapshotId);assert.equal(first.result.status,'succeeded');
  let state=await program(id,student,first.ack.buildId),step=await interact(id,student,state,3);
  assert.equal(step.trace.operation.result.finalFrame.leds,'0000000000000011');assert.equal(step.trace.operation.result.finalFrame.simTimePs,'30000');
  assert.equal((await post(`/api/attempts/${id}/hdl/interactions`,step.payload,student,step.key)).operationId,step.ack.operationId);
  state=await get(`/api/hdl/sessions/${state.sessionId}`,student);assert.equal(state.confirmedSequence,1);
  const changed=rtl.replace('count<=count+1','count<=count+2').replace('assign seg=sw[6:0]','assign seg=~sw[6:0]');
  const newSaved=await save(id,student,changed),next=await interact(id,student,state,2);assert.equal(next.trace.operation.result.snapshotId,saved.snapshotId);
  assert.equal(next.trace.operation.result.finalFrame.leds,'0000000000000101');assert.equal(next.trace.operation.result.finalFrame.segments,'0000011');
  assert.equal(next.trace.operation.result.snapshotHash,first.result.snapshotHash);
  const rebuilt=await build(id,student,newSaved.snapshotId);assert.equal(rebuilt.result.status,'succeeded');assert.notEqual(rebuilt.result.snapshotHash,first.result.snapshotHash);
  state=await get(`/api/hdl/sessions/${state.sessionId}`,student);const replaced=await program(id,student,rebuilt.ack.buildId,state);
  assert.equal((await get(`/api/hdl/sessions/${state.sessionId}`,student)).terminationConfirmed,true);assert.notEqual(replaced.sessionId,state.sessionId);
  const initial=await get(`/api/hdl/sessions/${replaced.sessionId}/trace`,student);assert.equal(initial.operation.result.finalFrame.leds,'0'.repeat(16));
  const corrected=await interact(id,student,replaced,3);assert.equal(corrected.trace.operation.result.finalFrame.leds,'0000000000000110');assert.equal(corrected.trace.operation.result.finalFrame.segments,'1111100');
  evidence.checks.push({name:'HDL immutable old version, duplicate operation, explicit reprogram and same-input changed RTL',oldSnapshot:saved.snapshotId,newSnapshot:newSaved.snapshotId,old:first.result,new:rebuilt.result,original:step.trace,oldAfterSave:next.trace,newResult:corrected.trace});
  const id2=await allocate(hc,teacher,student,true),saved2=await save(id2,student,rtl.replace('assign seg=sw[6:0]',"assign seg=7'bx0z1010")),built2=await build(id2,student,saved2.snapshotId);
  const state2=await program(id2,student,built2.ack.buildId),untouched=await get(`/api/hdl/sessions/${state2.sessionId}/trace`,student);
  assert.equal(untouched.operation.result.finalFrame.leds,'0'.repeat(16));assert.equal(untouched.operation.result.finalFrame.segments,'x0z1010');
  const current=await get(`/api/hdl/sessions/${replaced.sessionId}`,student),scan=await interact(id,student,current,400,'00000');
  assert.equal(scan.trace.operation.result.coverage,'incomplete');assert(scan.trace.operation.result.droppedFrames>0);assert.equal(scan.trace.operation.result.sampleCount,400);
  assert(scan.trace.operation.result.frames.some(x=>x.anodes==='11111101'));assert.equal(scan.trace.operation.result.finalFrame.leds,'0000000000000110');
  const unchanged=await get(`/api/hdl/sessions/${state2.sessionId}/trace`,student);assert.deepEqual(unchanged,untouched);
  evidence.checks.push({name:'two real sessions, four-valued signals and finite scan trace',secondSession:state2,untouched,scan:scan.trace});
  const cid=await allocate(cc,ct,cs,false);await save(cid,cs,'Alpha beta\n','a.txt');const cSaved=await save(cid,cs,'#include <stdio.h>\nint main(void){puts("passed");return 0;}\n','main.c');
  const cHead=await get(`/api/attempts/${cid}`,cs),sourceFile=cHead.files.find(x=>x.path==='main.c'),inputFile=cHead.files.find(x=>x.path==='a.txt');
  const runPayload={expectedAttemptRevision:cHead.attempt.attemptRevision,snapshotId:cSaved.snapshotId,runtimeProfileVersion:c.runtimeProfileVersion,entryFileId:sourceFile.fileId,input:{operation:'stats',fileIds:[inputFile.fileId]},mode:'run'};
  const run=await post(`/api/attempts/${cid}/runs`,runPayload,cs);await save(cid,cs,'new draft must not run','main.c');
  const finished=await until(()=>get(`/api/jobs/${run.jobId}`,cs),x=>['succeeded','failed','timed_out'].includes(x.status));assert.equal(finished.status,'succeeded');
  const publicRun=await get(`/api/attempts/${cid}/runs/${run.runId}`,cs);assert.equal(publicRun.snapshotId,cSaved.snapshotId);
  const raw=db.withTransaction(tx=>tx.get('SELECT result_json FROM workspace_runs WHERE run_id=?',run.runId));
  const runResult=JSON.parse(raw.result_json);assert.equal(runResult.phases[1].stdout,'passed\n');
  evidence.checks.push({name:'real C makes progress with two HDL sessions and retains old confirmed source',job:finished,run:publicRun,raw:runResult});
  const check=await post(`/api/attempts/${cid}/runs`,{...runPayload,expectedAttemptRevision:(await get(`/api/attempts/${cid}`,cs)).attempt.attemptRevision,mode:'course_check'},cs);
  const checked=await until(()=>get(`/api/jobs/${check.jobId}`,cs),x=>['succeeded','failed'].includes(x.status));
  const checkRun=await get(`/api/attempts/${cid}/runs/${check.runId}`,cs);assert.equal(checkRun.diagnostics.verdict,'failed');
  evidence.checks.push({name:'student stdout passed is not a trusted course verdict',job:checked,run:checkRun});
  await http('GET',`/api/hdl/sessions/${replaced.sessionId}`,undefined,cs,403);
  await http('POST',`/api/attempts/${id}/hdl/interactions`,{...scan.payload,expectedSequence:1},student,409);
  const bad=await save(id2,student,rtl.replace('count<=count+1','count<=;')),badBuild=await build(id2,student,bad.snapshotId);
  assert.equal(badBuild.result.status,'failed');assert(badBuild.result.diagnostics.some(x=>x.path==='top.sv'&&x.line));
  evidence.checks.push({name:'cross-student and stale operation refusal; genuine compiler diagnostic',failedBuild:badBuild});
  for(const s of sessions){const st=await get(`/api/hdl/sessions/${s.sessionId}`,s.headers);if(!st.terminationConfirmed){
    await post(`/api/attempts/${s.id}/hdl/controls`,{expectedAttemptRevision:(await get(`/api/attempts/${s.id}`,s.headers)).attempt.attemptRevision,action:'stop',reason:'C5 synthetic acceptance completed'},s.headers);
    assert((await until(()=>get(`/api/hdl/sessions/${s.sessionId}`,s.headers),x=>x.terminationConfirmed)).stopRequested);}}
  assert.equal(db.withTransaction(tx=>tx.get('SELECT COUNT(*) AS n FROM hdl_sessions WHERE termination_confirmed=0').n),0);
  evidence.checks.push({name:'every real session termination confirmed before release',unconfirmedSessions:0});evidence.passed=true;
}catch(error){evidence.passed=false;evidence.failure={name:error.name,message:error.message};process.exitCode=1;}
finally{
  await host.shutdown();
  evidence.databaseDiagnostics=db.diagnostics;db.close();
  evidence.finishedAt=new Date().toISOString();evidence.modelCalls=0;evidence.browser='not executed';
  const text=JSON.stringify(evidence,null,2)+'\n';
  for(const secret of [...initializer.users.map(x=>x.password),readFileSync(config.signingSecretFile,'utf8').trim(),readFileSync(config.tls.keyFile,'utf8').trim()])assert(!text.includes(secret),'Evidence contains controlled secret');
  writeFileSync(output,text,{flag:'wx',mode:0o600});console.log(JSON.stringify({passed:evidence.passed,checks:evidence.checks.length,failure:evidence.failure,output,databaseFile:db.file}));
}
