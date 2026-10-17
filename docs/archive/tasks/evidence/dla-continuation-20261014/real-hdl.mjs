import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {request as httpsRequest} from 'node:https';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

// PAHER only: original approved credentials stay in memory and are never evidence.
const source=process.argv[2],output=process.argv[3];
assert.equal(process.version,'v24.21.0');assert.equal(process.getuid(),0);
const root='/opt/xunjie-runner/tests/i0-entry-20261013-01';
process.env.TMPDIR=root+'/retained-tmp-20261014';
const config=JSON.parse(readFileSync(root+'/i0-host-recovered-20261014.json','utf8'));
const origin=process.env.XUNJIE_DLA_DEMO_ORIGIN??config.origin;
assert(['https://127.0.0.1:3443','https://127.0.0.1:3444'].includes(origin));
const initializer=JSON.parse(readFileSync(root+'/initializer.json','utf8'));
const load=path=>import(pathToFileURL(source+'/apps/teaching/'+path));
const live=process.argv[5]!==undefined;
if(live)assert.equal(process.env.XUNJIE_DLA_REAL_MODEL,'approved-synthetic');
const modelHttp=[];
let modelRequests=0,modelKey;
let provider;
if(live){
  const {readI0SigningSecret}=await load('server/app/config.ts');
  const {createAiSdkDeepSeekProvider}=await load('server/tutoring/deepseek-sdk.ts');
  const {createObservedModelFetch}=await load('server/tutoring/test/real-model-support.ts');
  modelKey=readI0SigningSecret(process.argv[5]);
  const observed=createObservedModelFetch(modelHttp,fetch,Date.now,()=>{
    assert(modelRequests<3,'Authorized HTTP request ceiling reached');
    if(modelRequests===0)writeFileSync(source+'/model-authorization-used.json',JSON.stringify({date:'2026-10-14',model:'deepseek-flash',
      scope:'one synthetic H4 student_help',maximumExternalRequests:3,startedAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});
    modelRequests++;
  });
  provider=createAiSdkDeepSeekProvider({apiKey:modelKey,fetch:observed});
}
const {executionTransports}=await load('server/app/execution-transport.ts');
const {initializeSyntheticApplication}=await load('server/app/initialize.ts');
const {createDigitalLogicApplication}=await load('server/app/digital-logic.ts');
const {assembleStudentHelpRequest,projectHdlHelpCurrentState}=await load('server/tutoring/context.ts');
const {definedAluOperations}=await load('contracts/design/hdl.ts');
const {board}=await load('tests/fixtures/hdl-board.ts');
const {configuration}=await load('tests/dl-a-support.ts');
const transports=executionTransports(config.ssh);
const c=(await transports.runner({op:'readiness'})).data;
const h=(await transports.hdlTransport({op:'hdl_readiness'})).data;
assert.equal(c.ready,true);assert.equal(h.ready,true);assert.equal(c.recoveryGeneration,h.recoveryGeneration);
assert.equal(h.profile.sourceHash,'7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852');
const manifest={synthetic:true,recoveryGeneration:h.recoveryGeneration,accounts:initializer.users,
  courses:initializer.courses.map(course=>course.id),memberships:initializer.courses.flatMap(course=>[
    {courseId:course.id,userId:course.teacherId,role:'teacher'},...course.studentIds.map(userId=>({courseId:course.id,userId,role:'student'}))])};
// Exact existing 35-table fresh-only factory authorized in DL-A §15.7; no old database migration.
const db=process.argv[4]?(await load('server/db/transaction.ts')).openSyntheticDatabase(process.argv[4]):
  await initializeSyntheticApplication(manifest,transports,[h.profile]);
const versions={modelConfig:'deepseek-flash-v1',prompt:'student-help-v1',schema:'student-help-v1',policy:'current-activity'};
const host=await createDigitalLogicApplication({db,origin,signingSecret:readFileSync(config.signingSecretFile,'utf8').trim(),
  https:{key:readFileSync(config.tls.keyFile),cert:readFileSync(config.tls.certFile)},...transports,approvedHdlRuntimes:[h.profile],
  studentHelp:{versions,budgetAvailable:()=>live&&modelRequests<3},...(provider?{tutoringProvider:provider}:{}),consumerIntervalMs:250});
const evidence={checkedAt:new Date().toISOString(),purpose:'isolated synthetic engineering acceptance; no real student actions',
  node:process.version,origin,databaseFile:db.file,reusedDatabase:!!process.argv[4],tables:db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length),
  generation:h.recoveryGeneration,hdlRuntime:h.profile,cRuntime:{runtimeProfileVersion:c.runtimeProfileVersion,imageDigest:c.imageDigest},
  nodeFingerprintHash:h.fingerprintHash,http:[],modelCalls:0,browser:'not executed',aluBehavior:'unverified'};
let activeSessionId,student,attemptId;
const cert=readFileSync(config.tls.certFile);
async function http(method,path,payload,session){
  const startedAtMs=Date.now();
  const data=payload===undefined?undefined:JSON.stringify(payload);
  const res=await new Promise((resolve,reject)=>{
    const req=httpsRequest(new URL(path,origin),{method,ca:cert,rejectUnauthorized:true,
      headers:{origin,...(session?{cookie:session.cookie,'x-csrf-token':session.csrf}:{}),
        ...(data===undefined?{}:{'content-type':'application/json','content-length':Buffer.byteLength(data),'idempotency-key':randomUUID()})}},response=>{
      let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;});response.on('end',()=>resolve({status:response.statusCode,
        headers:response.headers,body:JSON.parse(text),authorized:response.socket?.authorized??true}));
    });req.setTimeout(15000,()=>req.destroy(new Error('Bounded HTTPS request timed out')));req.on('error',reject);req.end(data);
  });
  // Login response carries CSRF/session material and is intentionally excluded.
  if(path!=='/api/sessions')evidence.http.push({method,path,status:res.status,startedAtMs,endedAtMs:Date.now(),requestId:res.body.requestId,body:res.body});
  assert.equal(res.status,200,JSON.stringify({method,path,response:res.body}));return res;
}
async function login(userId){const account=initializer.users.find(user=>user.id===userId);assert.ok(account);
  const res=await http('POST','/api/sessions',{loginName:account.loginName,password:account.password});
  return {cookie:res.headers['set-cookie'].map(value=>value.split(';',1)[0]).join('; '),csrf:res.body.data.csrfToken};}
const post=async(path,payload,session)=>(await http('POST',path,{recoveryGeneration:h.recoveryGeneration,...payload},session)).body.data.result;
const get=async(path,session)=>(await http('GET',path,undefined,session)).body.data;
const sourceText=`module top(input clk,input [15:0] sw,input [4:0] btn,output [15:0] led,output reg [7:0] an,output reg [6:0] seg,output dp);
reg [4:0] alu; reg [1:0] scan=0; reg [3:0] digit;
always @(posedge clk) scan<=scan+1;
always @* begin
  alu=0;
  if(sw[8]) case(sw[10:9])
    2'b00: alu={1'b0,sw[3:0]}+{1'b0,sw[7:4]}+sw[11];
    2'b01: if(sw[3:0]>sw[7:4]) alu=sw[3:0]-sw[7:4]-sw[11]; else alu=5'bxxxxx;
    default: alu=5'bxxxxx;
  endcase else case(sw[10:9])
    2'b00: alu={1'b0,~sw[3:0]}; 2'b01: alu={1'b0,sw[3:0]&sw[7:4]};
    2'b10: alu={1'b0,sw[3:0]|sw[7:4]}; 2'b11: alu={1'b0,sw[3:0]^sw[7:4]};
  endcase
  case(scan) 0:begin an=8'hfe;digit=sw[3:0];end 1:begin an=8'hfd;digit=sw[7:4];end
    2:begin an=8'hfb;digit=alu[3:0];end 3:begin an=8'hf7;digit={3'b0,alu[4]};end endcase
  case(digit) 0:seg=7'b1000000;1:seg=7'b1111001;2:seg=7'b0100100;3:seg=7'b0110000;
    4:seg=7'b0011001;5:seg=7'b0010010;6:seg=7'b0000010;7:seg=7'b1111000;
    8:seg=7'b0000000;9:seg=7'b0010000;10:seg=7'b0001000;11:seg=7'b0000011;
    12:seg=7'b1000110;13:seg=7'b0100001;14:seg=7'b0000110;15:seg=7'b0001110;
    default:seg=7'bxxxxxxx;endcase
end
assign led={11'b0,alu};assign dp=1'b1;endmodule
`;
try{
  await host.app.listen({host:'127.0.0.1',port:Number(new URL(origin).port)});host.startConsumer();
  const course=initializer.courses[1],teacher=await login(course.teacherId);student=await login(course.studentIds[0]);
  const courses=await get('/api/courses',student);assert.equal(courses.length,manifest.memberships.filter(value=>value.userId===course.studentIds[0]).length);
  assert.equal(db.withTransaction(tx=>tx.all('SELECT id FROM courses').length),2);
  const fixed={...configuration('synthetic-dla-live-config-v1'),board,runtime:h.profile};fixed.alu.operations=definedAluOperations;
  await post(`/api/courses/${course.id}/hdl-configurations`,{configuration:fixed},teacher);
  const goals=[{competencyId:'k',competencyVersion:1,domain:'domain',title:'解释 ALU 运算'},
    {competencyId:'p',competencyVersion:1,domain:'project',title:'核对输入与输出'},
    {competencyId:'a',competencyVersion:1,domain:'ai_collaboration',title:'依据真实诊断核查建议'}];
  const refs=goals.map(({competencyId,competencyVersion})=>({competencyId,competencyVersion}));
  const draft=await post(`/api/courses/${course.id}/blueprints`,{mode:'manual',content:{projectTitle:'4 位 ALU 合成工程演示',
    problem:'比较已定义 ALU 运算并观察真实段选和位选。',audience:'工程验收',artifact:'HDL 源码与真实输出',routes:['先比较逻辑','先比较加法'],goals,
    tasks:[{taskId:'compare',title:'自行核对运算',goalRefs:refs}],observations:[{observationId:'o',description:'解释结果与未知',goalRefs:refs,taskIds:['compare']}],
    rubricCriteria:[{criterionId:'r',description:'以真实运行结果解释',goalRefs:refs,observationIds:['o']}],milestones:[{milestoneId:'m',title:'核对结果',taskIds:['compare']}],resources:[],
    helpPolicyVersionId:course.id+'-help',checkRuleVersionId:'hdl-board-structure-v1',runtimeProfileVersionId:h.profile.runtimeProfileVersion,digitalLogicConfigVersionId:fixed.versionId}},teacher);
  const blueprintId=draft.draft.blueprintId;
  const checks=await post(`/api/blueprints/${blueprintId}/checks`,{expectedRevision:1},teacher);assert.equal(checks.report.blocking.length,0);
  const activity=await post(`/api/blueprints/${blueprintId}/releases`,{expectedRevision:1,confirmed:true},teacher);
  const assignment=await post(`/api/activities/${activity.activityVersionId}/assignments`,{expectedActivityControlRevision:1,studentIds:[course.studentIds[0]]},teacher);
  const assignmentId=assignment.assignments[0].assignmentId;
  attemptId=(await post(`/api/assignments/${assignmentId}/attempts`,{},student)).attemptId;
  evidence.objects={courseId:course.id,studentId:course.studentIds[0],activityVersionId:activity.activityVersionId,assignmentId,attemptId};
  await post(`/api/attempts/${attemptId}/sync`,{expectedWorkspaceRevision:0,clientId:'synthetic-engineering-script',clientSeq:1,
    operations:[{kind:'create',clientFileKey:'hdl',path:'top.sv',text:sourceText.replace('alu=0;','alu=;')}]},student);
  const head=()=>get(`/api/attempts/${attemptId}`,student);
  async function build(){const current=await head();const snap=await post(`/api/attempts/${attemptId}/snapshots`,{expectedWorkspaceRevision:current.attempt.workspaceRevision},student);
    const ack=await post(`/api/attempts/${attemptId}/hdl/builds`,{expectedAttemptRevision:current.attempt.attemptRevision,snapshotId:snap.snapshotId},student);
    for(let i=0;i<120;i++){const build=await get(`/api/hdl/builds/${ack.buildId}`,student);
      if(build.result?.terminationConfirmed)return {ack,snapshotId:snap.snapshotId,build:build.result,request:build.request};await delay(250);}throw new Error('Real build deadline reached');}
  const bad=await build();assert.equal(bad.build.status,'failed');assert(bad.build.diagnostics.some(value=>value.path==='top.sv'&&value.line));
  const helpAck=await post(`/api/attempts/${attemptId}/help`,{expectedAttemptRevision:(await head()).attempt.attemptRevision,
    question:'请依据这次真实 HDL 语法诊断给一点提示，不直接代改代码。',
    objectRef:{kind:'code',attemptId,snapshotId:bad.snapshotId,...Object.fromEntries(['fileId','path','documentVersion','contentHash'].map(key=>[key,bad.request.snapshot.files[0][key]]))},
    hdlSelection:{snapshotId:bad.snapshotId,buildId:bad.ack.buildId}},student);
  const authorized=host.tutoring.authorizeStudentHelp(undefined,attemptId,helpAck.jobId,{});
  const request=assembleStudentHelpRequest(authorized);assert.equal(request.domain,'hdl');
  evidence.failedBuild={snapshotId:bad.snapshotId,buildId:bad.ack.buildId,status:bad.build.status,diagnostics:bad.build.diagnostics};
  evidence.h4={jobId:helpAck.jobId,basis:projectHdlHelpCurrentState(authorized.hdl),references:request.references,
    modelStatus:live?'authorized bounded call in progress':'not called',budgetAvailable:live};
  if(live){
    let job;
    for(let i=0;i<450;i++){
      job=db.withTransaction(tx=>tx.get('SELECT status,job_json FROM jobs WHERE job_id=?',helpAck.jobId));
      if(['succeeded','failed','stale','timed_out','cancelled'].includes(job.status))break;await delay(100);
    }
    const {readTeachingRecordsInTransaction}=await load('server/records/teaching.ts');
    const records=db.withTransaction(tx=>readTeachingRecordsInTransaction(tx,{courseId:course.id,studentId:course.studentIds[0],attemptId}));
    const message=records.messages.find(value=>value.jobId===helpAck.jobId&&value.envelope.kind==='student_help');
    evidence.model={model:'deepseek-flash',dataScope:'synthetic-only',maximumExternalRequests:3,externalRequests:modelRequests,
      http:modelHttp,jobStatus:job.status,...(message?{body:message.envelope.body,usage:message.envelope.usage,calls:message.envelope.calls,elapsedMs:message.envelope.elapsedMs}:{}),
      semanticReview:'engineering relevance check only; no teacher review or learning-effect claim'};
    evidence.modelCalls=modelRequests;assert.equal(job.status,'succeeded','Bounded H4 model job did not succeed');assert.ok(message);
    const page=await get(`/api/attempts/${attemptId}/events?clientId=synthetic-hdl-model&recoveryGeneration=${encodeURIComponent(h.recoveryGeneration)}&decisionEpoch=${(await head()).attempt.decisionEpoch}`,student);
    const delivered=page.events.find(value=>value.payload?.content);
    assert.ok(delivered);assert.equal(delivered.payload.basis.hdl.buildId,bad.ack.buildId);
    evidence.model.delivery=delivered;
    const receipt=(await http('POST',`/api/actions/${delivered.payload.actionId}/receipts`,{recoveryGeneration:h.recoveryGeneration,
      deliveryId:delivered.payload.deliveryId,clientId:'synthetic-hdl-model',contentHash:delivered.payload.contentHash,
      receiptKind:'received',clientReceiptId:randomUUID()},student)).body.data;
    // Only transport receipt; a script never declares browser display or a human acknowledgement.
    evidence.model.transportReceipt=receipt;evidence.h4.modelStatus='generated and delivered to strict HTTPS test client';
  }
  const current=await head(),file=current.files.find(value=>value.path==='top.sv');assert.ok(file);
  await post(`/api/attempts/${attemptId}/sync`,{expectedWorkspaceRevision:current.attempt.workspaceRevision,clientId:'synthetic-engineering-script',clientSeq:2,
    operations:[{kind:'update',fileId:file.fileId,baseVersion:file.documentVersion,text:sourceText}]},student);
  const good=await build();assert.equal(good.build.status,'succeeded');
  const programmed=await post(`/api/attempts/${attemptId}/hdl/programs`,{expectedAttemptRevision:(await head()).attempt.attemptRevision,buildId:good.ack.buildId},student);
  activeSessionId=programmed.sessionId;
  let session;
  for(let i=0;i<100;i++){session=await get(`/api/hdl/sessions/${activeSessionId}`,student);if(session.status==='active'&&!session.pendingOperationId)break;await delay(100);}
  assert.equal(session.status,'active');assert.equal(session.pendingOperationId,undefined);
  evidence.successfulBuild={snapshotId:good.snapshotId,buildId:good.ack.buildId,artifactHash:good.build.artifactHash,configurationHash:good.build.configurationHash};
  evidence.operations=[];
  for(const [switches,expected] of [[0x943,8],[0x635,6]]){
    const ack=await post(`/api/attempts/${attemptId}/hdl/interactions`,{expectedAttemptRevision:(await head()).attempt.attemptRevision,sessionId:activeSessionId,
      expectedSessionRevision:session.sessionRevision,expectedSequence:session.confirmedSequence+1,
      inputs:{switches:switches.toString(2).padStart(16,'0'),buttons:'00000',resetN:'1'},advanceCycles:4},student);
    let result;
    for(let i=0;i<100;i++){const trace=await get(`/api/hdl/sessions/${activeSessionId}/trace?afterSequence=${session.confirmedSequence}`,student);
      if(trace.operation?.result){result=trace.operation.result;break;}await delay(100);}assert.ok(result);
    assert.equal(Number.parseInt(result.finalFrame.leds,2),expected);
    session=await get(`/api/hdl/sessions/${activeSessionId}`,student);
    assert.equal(result.operationId,ack.operationId);assert.equal(result.sessionRevision,session.sessionRevision);
    assert.equal(result.snapshotId,good.snapshotId);assert.equal(result.finalFrame.simTimePs,session.simTimePs);
    const exact=db.withTransaction(tx=>host.hdl.readOperation(tx,{userId:course.studentIds[0],courseId:course.id,role:'student'},ack.operationId));
    assert.deepEqual(exact.result,result);evidence.operations.push(result);
  }
  evidence.session={sessionId:activeSessionId,confirmedSequence:session.confirmedSequence,simTimePs:session.simTimePs};
  await post(`/api/attempts/${attemptId}/hdl/controls`,{expectedAttemptRevision:(await head()).attempt.attemptRevision,action:'stop',reason:'Synthetic engineering acceptance completed'},student);
  for(let i=0;i<100;i++){session=await get(`/api/hdl/sessions/${activeSessionId}`,student);if(session.terminationConfirmed)break;await delay(100);}
  assert.equal(session.terminationConfirmed,true);assert.equal(session.stopRequested,true);
  evidence.stop={status:session.status,terminationConfirmed:session.terminationConfirmed};evidence.passed=true;
}catch(error){evidence.passed=false;evidence.failure={name:error.name,message:error.message};
  evidence.sessionTiming=db.withTransaction(tx=>tx.all('SELECT user_id,created_at_ms,last_active_at_ms,absolute_expires_at_ms,revoked_at_ms FROM sessions'));
  process.exitCode=1;}
finally{
  await host.shutdown();db.close();
  evidence.modelCalls=modelRequests;
  if(evidence.model)evidence.model.externalRequests=modelRequests;
  const text=JSON.stringify(evidence,null,2)+'\n';
  for(const secret of [...initializer.users.map(user=>user.password),readFileSync(config.signingSecretFile,'utf8').trim(),readFileSync(config.tls.keyFile,'utf8').trim(),...(modelKey?[modelKey]:[])])
    assert(!text.includes(secret),'Evidence contains controlled secret');
  writeFileSync(output,text,{flag:'wx',mode:0o600});
  console.log(JSON.stringify({passed:evidence.passed,failure:evidence.failure,output,databaseFile:evidence.databaseFile,
    realOperations:evidence.operations?.length??0,modelCalls:modelRequests,modelStatus:evidence.model?.jobStatus,stop:evidence.stop}));
}
