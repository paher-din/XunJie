import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture,allocate,programmed,view,command,type Fixture,type Headers } from './dl-a-support.ts';
import { SyntheticProvider,type ProviderRequest } from '../server/tutoring/providers.ts';
import { readTeachingJob } from '../server/records/teaching.ts';
import type { HdlHelpSelection } from '../contracts/workspace/hdl-help.ts';

const versions={modelConfig:'deepseek-flash-v1',prompt:'student-help-v1',schema:'student-help-v1',policy:'logic-course-help'};
function body(request:ProviderRequest){
  const input=request.untrustedInput as {references:Array<{id:string}>};
  return {kind:'student_help',actionType:'hint',content:'请核对这次操作的段选与位选，再自行试验。',
    rationale:'依据已确认 HDL 操作，保留学生修改与运行职责。',expectedStudentAction:'自行比较相同输入的结果。',
    evidenceIds:[input.references[0]!.id],resourceRefs:[],assistanceContext:'当前获准 HDL 版本。',unresolved:[],
    policyChecks:{containsWholeSolution:false,writesStudentWork:false,runsCode:false,makesFormalEvaluation:false}};
}
async function help(f:Fixture,student:Headers,attemptId:string,selection:HdlHelpSelection,key:string=randomUUID()){
  return command(f,student,`/api/attempts/${attemptId}/help`,{
    expectedAttemptRevision:(await view(f,student,attemptId)).attempt.attemptRevision,question:'给一点提示',hdlSelection:selection},key);
}
async function setup(steps:ConstructorParameters<typeof SyntheticProvider>[0]){
  const provider=new SyntheticProvider(steps),f=await fixture(undefined,{studentHelp:{versions,budgetAvailable:()=>true},tutoringProvider:provider});
  const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student),p=await programmed(f,student,item);
  const selection={snapshotId:item.snapshotId,buildId:p.build.buildId,sessionId:p.program.sessionId,operationId:p.program.operationId};
  return {f,teacher,student,item,p,selection,provider};
}
async function interact(f:Fixture,student:Headers,attemptId:string,sessionId:string){
  const state=f.db.withTransaction(tx=>f.host.hdl.readSession(tx,{userId:'student',courseId:'logic-course',role:'student'},sessionId));
  const res=await command(f,student,`/api/attempts/${attemptId}/hdl/interactions`,{
    expectedAttemptRevision:(await view(f,student,attemptId)).attempt.attemptRevision,sessionId,
    expectedSessionRevision:state.sessionRevision,expectedSequence:state.confirmedSequence+1,
    inputs:{switches:'0'.repeat(16),buttons:'00001',resetN:'1'},advanceCycles:2});
  assert.equal(res.statusCode,200,res.body);await f.host.consumeOnce();return res.json().data.result;
}
test('H4 normal HTTP freezes explicit objects, automatically consumes original Job and delivers C3 provenance',async()=>{
  const {f,student,item,selection,provider}=await setup([request=>({body:body(request)})]);
  try{
    const op=await interact(f,student,item.attemptId,selection.sessionId),selected={...selection,operationId:op.operationId};
    const response=await help(f,student,item.attemptId,selected,'selected-help');assert.equal(response.statusCode,200,response.body);
    const jobId=response.json().data.result.jobId;
    const replay=await help(f,student,item.attemptId,selected,'selected-help');
    // Retry with the same original revision rather than the new current Attempt revision.
    assert.equal(replay.statusCode,200,replay.body);
    f.host.startConsumer(50);
    for(let i=0;i<100;i++){if(f.db.withTransaction(tx=>readTeachingJob(tx,'logic-course',jobId)!.status)==='succeeded')break;await delay(20);}
    assert.equal(f.db.withTransaction(tx=>readTeachingJob(tx,'logic-course',jobId)!.status),'succeeded');
    assert.equal(provider.calls.length,1);
    const sent=JSON.stringify(provider.calls[0]!.untrustedInput);
    assert(sent.includes('x0z1010'));assert(sent.includes('20000'));assert(!sent.includes('PRIVATE_BODY'));assert(!sent.includes('buildImage'));
    const head=await view(f,student,item.attemptId);
    const events=await f.app.inject({url:`/api/attempts/${item.attemptId}/events?clientId=hdl-browser&recoveryGeneration=generation&decisionEpoch=${head.attempt.decisionEpoch}`,headers:student});
    assert.equal(events.statusCode,200,events.body);
    const action=events.json().data.events.find((e:{payload?:{content?:string}})=>e.payload?.content);
    assert.ok(action);assert.equal(action.payload.basis.hdl.operationId,op.operationId);assert.equal(action.payload.basis.hdl.confirmedSequence,1);
    const other=await f.login('other');assert.equal((await command(f,other,`/api/attempts/${item.attemptId}/help`,{
      expectedAttemptRevision:head.attempt.attemptRevision,question:'给一点提示',hdlSelection:selected})).statusCode,403);
  }finally{await f.close();}
});
test('H4 rejects pending/stopped/foreign selection and corrupted operation bytes before dispatch',async()=>{
  const {f,student,item,selection,provider}=await setup([]);
  try{
    assert.equal((await help(f,student,item.attemptId,{...selection,snapshotId:'foreign'})).statusCode,422);
    const state=await view(f,student,item.attemptId);
    const res=await command(f,student,`/api/attempts/${item.attemptId}/hdl/interactions`,{
      expectedAttemptRevision:state.attempt.attemptRevision,sessionId:selection.sessionId,expectedSessionRevision:1,expectedSequence:1,
      inputs:{switches:'0'.repeat(16),buttons:'00000',resetN:'1'},advanceCycles:1});assert.equal(res.statusCode,200,res.body);
    assert.equal((await help(f,student,item.attemptId,selection)).statusCode,409);
    await f.host.consumeOnce();
    const selected={...selection,operationId:res.json().data.result.operationId};
    f.db.withTransaction(tx=>tx.run("UPDATE hdl_operations SET result_json=json_set(result_json,'$.finalFrame.leds',?) WHERE operation_id=?",'1'.repeat(16),selected.operationId));
    assert.equal((await help(f,student,item.attemptId,selected)).statusCode,422);
    assert.equal(provider.calls.length,0);
  }finally{await f.close();}
});
test('H4 new operation during model generation invalidates old help without a C3 body',async()=>{
  let release!:(value:{body:ReturnType<typeof body>})=>void,entered!:()=>void;
  const ready=new Promise<void>(resolve=>{entered=resolve});
  const {f,student,item,selection,provider}=await setup([()=>new Promise(resolve=>{entered();release=resolve;})]);
  try{
    const response=await help(f,student,item.attemptId,selection);assert.equal(response.statusCode,200,response.body);
    const jobId=response.json().data.result.jobId,task=f.host.tutoring.processJob(jobId,provider);
    await ready;await interact(f,student,item.attemptId,selection.sessionId);release({body:body(provider.calls[0]!)});
    const result=await task;assert.equal(result.outcome.outcome,'stale');
    assert.equal(f.db.withTransaction(tx=>tx.all('SELECT action_id FROM teaching_actions WHERE job_id=?',jobId).length),0);
  }finally{await f.close();}
});
test('H4 operation after generation prevents old Delivery and displayed receipt',async()=>{
  const {f,student,item,selection,provider}=await setup([request=>({body:body(request)})]);
  try{
    const response=await help(f,student,item.attemptId,selection);assert.equal(response.statusCode,200,response.body);
    const jobId=response.json().data.result.jobId,execution=await f.host.tutoring.processJob(jobId,provider);assert.equal(execution.outcome.outcome,'success');
    await interact(f,student,item.attemptId,selection.sessionId);
    const head=await view(f,student,item.attemptId);
    const page=await f.app.inject({url:`/api/attempts/${item.attemptId}/events?clientId=stale-hdl&recoveryGeneration=generation&decisionEpoch=${head.attempt.decisionEpoch}`,headers:student});
    assert.equal(page.statusCode,200,page.body);assert(!page.json().data.events.some((e:{payload?:{content?:string}})=>e.payload?.content));
    assert.equal(f.db.withTransaction(tx=>tx.get('SELECT disposition FROM teaching_actions WHERE job_id=?',jobId)!.disposition),'stale');
  }finally{await f.close();}
});
test('H4 receipt rechecks HDL in its own transaction and preserves a late display as a raced fact',async()=>{
  const {f,student,item,selection,provider}=await setup([request=>({body:body(request)})]);
  try{
    const response=await help(f,student,item.attemptId,selection);assert.equal(response.statusCode,200,response.body);
    const jobId=response.json().data.result.jobId;await f.host.tutoring.processJob(jobId,provider);
    const head=await view(f,student,item.attemptId);
    const page=await f.app.inject({url:`/api/attempts/${item.attemptId}/events?clientId=receipt-hdl&recoveryGeneration=generation&decisionEpoch=${head.attempt.decisionEpoch}`,headers:student});
    assert.equal(page.statusCode,200,page.body);
    const action=page.json().data.events.find((e:{payload?:{content?:string}})=>e.payload?.content).payload;
    await interact(f,student,item.attemptId,selection.sessionId);
    const receipt=await command(f,student,`/api/actions/${action.actionId}/receipts`,{deliveryId:action.deliveryId,clientId:'receipt-hdl',
      contentHash:action.contentHash,receiptKind:'displayed',clientReceiptId:randomUUID()});
    assert.equal(receipt.statusCode,200,receipt.body);assert.equal(receipt.json().data.raceReason,'action_stale');
  }finally{await f.close();}
});
test('H4 stop before dispatch and provider failure never prevent confirmed source reads',async()=>{
  for(const stop of [true,false]){
    const {f,student,item,selection,provider}=await setup([new Error('Synthetic model unavailable')]);
    try{
      const response=await help(f,student,item.attemptId,selection);assert.equal(response.statusCode,200,response.body);
      const jobId=response.json().data.result.jobId;
      if(stop){
        const res=await command(f,student,`/api/attempts/${item.attemptId}/hdl/controls`,{
          expectedAttemptRevision:(await view(f,student,item.attemptId)).attempt.attemptRevision,action:'stop',reason:'Student stopped simulation'});
        assert.equal(res.statusCode,200,res.body);await f.host.consumeOnce();
        await assert.rejects(f.host.tutoring.processJob(jobId,provider));assert.equal(provider.calls.length,0);
      }else{
        const result=await f.host.tutoring.processJob(jobId,provider);assert.equal(result.outcome.outcome,'unavailable');
        assert.equal(provider.calls.length,1);
      }
      assert.equal((await view(f,student,item.attemptId)).snapshots.some((value:{snapshotId:string})=>value.snapshotId===selection.snapshotId),true);
    }finally{await f.close();}
  }
});
test('H4 freezes workspace revision at acceptance; edits before dispatch stop the original Job without a provider call',async()=>{
  const {f,student,item,selection,provider}=await setup([]);
  try{
    const response=await help(f,student,item.attemptId,selection);assert.equal(response.statusCode,200,response.body);
    const jobId=response.json().data.result.jobId,head=await view(f,student,item.attemptId),file=head.files[0];
    const sync=await command(f,student,`/api/attempts/${item.attemptId}/sync`,{expectedWorkspaceRevision:head.attempt.workspaceRevision,
      clientId:'changed-source',clientSeq:1,operations:[{kind:'update',fileId:file.fileId,baseVersion:file.documentVersion,text:'module top; wire changed; endmodule'}]});
    assert.equal(sync.statusCode,200,sync.body);
    f.host.startConsumer(50);
    for(let i=0;i<100;i++){if(f.db.withTransaction(tx=>readTeachingJob(tx,'logic-course',jobId)!.status)==='stale')break;await delay(20);}
    assert.equal(f.db.withTransaction(tx=>readTeachingJob(tx,'logic-course',jobId)!.status),'stale');assert.equal(provider.calls.length,0);
  }finally{await f.close();}
});
