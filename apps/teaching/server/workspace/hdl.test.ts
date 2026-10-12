import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,assigned,opened,command,snapshot,view} from './test-support.ts';
import {createHdlWorkspace,readHdlBuild,readHdlSession} from './hdl.ts';
import {sha256} from '../../runner/snapshot.ts';
import type {HdlCommand,HdlBuild,HdlSession,HdlOperationResult} from '../../contracts/runner/hdl.ts';
import {board} from '../../tests/fixtures/hdl-board.ts';
import {readAttempt} from '../db/records-adapter.ts';
import {createWorkspaceApp} from './application.ts';
import {origin} from './test-support.ts';

const actor={userId:'student',courseId:'course',role:'student' as const};
const runtime={runtimeProfileVersion:'hdl-test-v1',engineVersion:'iverilog-test',buildImage:'sha256:'+'a'.repeat(64),runtimeImage:'sha256:'+'b'.repeat(64),sourceHash:'c'.repeat(64)};
function syntheticNode(){const builds=new Map<string,HdlBuild>(),sessions=new Map<string,HdlSession>(),outputs=new Map<string,HdlOperationResult>();
  let lost=false,calls=0;
  const transport=async(command:HdlCommand)=>{calls++;
    if(command.op==='hdl_build'){const request=command.request,result:HdlBuild={buildId:request.identity.id,identity:request.identity,snapshotId:request.snapshot.snapshotId,snapshotHash:request.snapshot.hash,
      board:request.board,runtimeProfileVersion:runtime.runtimeProfileVersion,engineVersion:runtime.engineVersion,imageDigest:runtime.buildImage,configurationHash:sha256(JSON.stringify(request.board)),
      status:'succeeded',terminationConfirmed:true,artifactHash:'d'.repeat(64),diagnostics:[],stdout:'',stderr:''};builds.set(result.buildId,result);return {data:result};}
    if(command.op==='hdl_program'){const build=builds.get(command.request.buildId)!,at=new Date().toISOString(),state:HdlSession={sessionId:command.request.identity.id,identity:command.request.identity,
      buildId:build.buildId,snapshotId:build.snapshotId,snapshotHash:build.snapshotHash,boardProfileVersion:board.boardProfileVersion,mappingVersion:board.mappingVersion,
      engineVersion:runtime.engineVersion,runtimeProfileVersion:runtime.runtimeProfileVersion,sessionRevision:1,confirmedSequence:0,simTimePs:'0',status:'active',terminationConfirmed:false,stopRequested:false,
      createdAt:at,lastOperationAt:at,deadline:new Date(Date.now()+1800000).toISOString()};sessions.set(state.sessionId,state);
      const frame={simTimePs:'0',switches:'0'.repeat(16),buttons:'00000',resetN:'1',leds:'0'.repeat(16),anodes:'11111110',segments:'0'.repeat(7),dp:'0'};
      const body={operationId:state.sessionId,sessionId:state.sessionId,buildId:build.buildId,snapshotId:build.snapshotId,snapshotHash:build.snapshotHash,
        boardProfileVersion:board.boardProfileVersion,mappingVersion:board.mappingVersion,engineVersion:runtime.engineVersion,sequence:0,sessionRevision:1,
        frames:[frame],finalFrame:frame,sampleCount:1,droppedFrames:0,coverage:'complete' as const};outputs.set(state.sessionId,{...body,resultHash:sha256(JSON.stringify(body))});return {data:state};}
    if(command.op==='hdl_interact'){const request=command.request,state=sessions.get(request.sessionId)!,time=(BigInt(state.simTimePs)+BigInt(request.advanceCycles)*10000n).toString();
      const frame={simTimePs:time,...request.inputs,leds:'0'.repeat(16),anodes:'11111110',segments:'x0z1010',dp:'0'};
      const body={operationId:request.identity.id,sessionId:state.sessionId,buildId:state.buildId,snapshotId:state.snapshotId,snapshotHash:state.snapshotHash,boardProfileVersion:board.boardProfileVersion,
        mappingVersion:board.mappingVersion,engineVersion:runtime.engineVersion,sequence:request.expectedSequence,sessionRevision:request.expectedSessionRevision+1,
        frames:[frame],finalFrame:frame,sampleCount:request.advanceCycles,droppedFrames:0,coverage:'complete' as const};const result={...body,resultHash:sha256(JSON.stringify(body))};
      outputs.set(result.operationId,result);sessions.set(state.sessionId,{...state,sessionRevision:result.sessionRevision,confirmedSequence:result.sequence,simTimePs:time});
      if(lost){lost=false;throw new Error('Synthetic transport lost after the real side effect');}return {data:result};}
    if(command.op==='hdl_query')return {data:sessions.get(command.identity.id)??builds.get(command.identity.id)??null};
    if(command.op==='hdl_result')return {data:outputs.get(command.operationId)??null};
    if(command.op==='hdl_stop'){const state=sessions.get(command.identity.id)!;const stopped={...state,sessionRevision:state.sessionRevision+1,status:'stopped' as const,terminationConfirmed:true,stopRequested:true};sessions.set(state.sessionId,stopped);return {data:stopped};}
    return {data:{ready:true,profile:runtime}};
  };return {transport,loseNext(){lost=true;},calls:()=>calls};
}
async function setup(){const f=await fixture(undefined,{digitalLogic:true}),teacher=await f.login('teacher'),student=await f.login();
  const assignment=await assigned(f,teacher),attemptId=await opened(f,student,assignment.assignmentId);
  const saved=await command(f,student,`/api/attempts/${attemptId}/sync`,{expectedWorkspaceRevision:0,clientId:'hdl-page',clientSeq:1,operations:[{kind:'create',clientFileKey:'rtl',path:'top.sv',text:'module top; endmodule\n'}]});
  assert.equal(saved.statusCode,200,saved.body);const snapshotId=await snapshot(f,student,attemptId),node=syntheticNode();
  const service=createHdlWorkspace({db:f.db,currentGeneration:f.generation,transport:node.transport,approvedProfile:()=>({board,runtime})});
  const revision=()=>f.db.withTransaction(tx=>readAttempt(tx,attemptId).attemptRevision);
  return {f,attemptId,snapshotId,node,service,revision,student};}
test('DL-C synthetic schema is exactly 29 tables; authenticated .sv ACK and immutable build survive retries',async()=>{
  const s=await setup();try{
    assert.equal(s.f.db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").length),29);
    const input={expectedAttemptRevision:s.revision(),snapshotId:s.snapshotId},accepted=s.service.build(actor,s.attemptId,'build',s.f.generation(),input);
    assert.equal(s.service.build(actor,s.attemptId,'build',s.f.generation(),input).result.buildId,accepted.result.buildId);
    assert.throws(()=>s.service.build(actor,s.attemptId,'build',s.f.generation(),{...input,snapshotId:'other'}));
    await s.service.processJob(accepted.result.jobId);
    const result=s.f.db.withTransaction(tx=>readHdlBuild(tx,actor,accepted.result.buildId));assert.equal(result.result?.status,'succeeded');
    const text=result.request.snapshot.files[0]!.text;
    const current=await view(s.f,s.student,s.attemptId);const file=current.files[0];
    assert.equal((await command(s.f,s.student,`/api/attempts/${s.attemptId}/sync`,{expectedWorkspaceRevision:current.attempt.workspaceRevision,clientId:'hdl-page',clientSeq:2,operations:[{kind:'update',fileId:file.fileId,baseVersion:file.documentVersion,text:'new draft'}]})).statusCode,200);
    assert.equal(s.f.db.withTransaction(tx=>readHdlBuild(tx,actor,accepted.result.buildId)).request.snapshot.files[0]!.text,text);
  }finally{await s.f.close();}
});
test('DL-C program/interact keep exact source, resolve lost response by original operation and explicitly reprogram',async()=>{
  const s=await setup();try{
    const build=s.service.build(actor,s.attemptId,'build',s.f.generation(),{expectedAttemptRevision:s.revision(),snapshotId:s.snapshotId});await s.service.processJob(build.result.jobId);
    const program=await s.service.program(actor,s.attemptId,'program',s.f.generation(),{expectedAttemptRevision:s.revision(),buildId:build.result.buildId});await s.service.processJob(program.result.jobId);
    let state=s.f.db.withTransaction(tx=>readHdlSession(tx,actor,program.result.sessionId));assert.equal(state.status,'active');
    const input={expectedAttemptRevision:s.revision(),sessionId:state.sessionId,expectedSessionRevision:state.sessionRevision,expectedSequence:1,inputs:{switches:'0'.repeat(16),buttons:'00001',resetN:'1'},advanceCycles:3};
    const operation=s.service.interact(actor,s.attemptId,'step',s.f.generation(),input);s.node.loseNext();await s.service.processJob(operation.result.jobId);
    const calls=s.node.calls();await s.service.processJob(operation.result.jobId);assert(s.node.calls()>calls);
    state=s.f.db.withTransaction(tx=>readHdlSession(tx,actor,state.sessionId));assert.equal(state.confirmedSequence,1);assert.equal(state.simTimePs,'30000');
    assert.equal(s.service.interact(actor,s.attemptId,'step',s.f.generation(),input).result.operationId,operation.result.operationId);
    const replacement=await s.service.program(actor,s.attemptId,'replacement',s.f.generation(),{expectedAttemptRevision:s.revision(),buildId:build.result.buildId,replaceSessionId:state.sessionId,expectedSessionRevision:state.sessionRevision});
    assert.notEqual(replacement.result.sessionId,state.sessionId);assert(s.f.db.withTransaction(tx=>readHdlSession(tx,actor,state.sessionId)).terminationConfirmed);
    await s.service.processJob(replacement.result.jobId);assert.equal(s.f.db.withTransaction(tx=>readHdlSession(tx,actor,replacement.result.sessionId)).status,'active');
  }finally{await s.f.close();}
});
test('DL-C roles, course, generation and phase guards reject new actions; a stop does not restore an old active state',async()=>{
  const s=await setup();try{
    const input={expectedAttemptRevision:s.revision(),snapshotId:s.snapshotId};
    for(const denied of [{...actor,userId:'other'},{...actor,courseId:'foreign-course'},{userId:'teacher',courseId:'course',role:'teacher' as const}])assert.throws(()=>s.service.build(denied,s.attemptId,'denied',s.f.generation(),input));
    assert.throws(()=>s.service.build(actor,s.attemptId,'old','old-generation',input));
    const build=s.service.build(actor,s.attemptId,'build',s.f.generation(),input);await s.service.processJob(build.result.jobId);
    const p=await s.service.program(actor,s.attemptId,'program',s.f.generation(),{expectedAttemptRevision:s.revision(),buildId:build.result.buildId});await s.service.processJob(p.result.jobId);
    const state=s.f.db.withTransaction(tx=>readHdlSession(tx,actor,p.result.sessionId));
    const operation=s.service.interact(actor,s.attemptId,'step',s.f.generation(),{expectedAttemptRevision:s.revision(),sessionId:state.sessionId,expectedSessionRevision:1,expectedSequence:1,inputs:{switches:'0'.repeat(16),buttons:'00001',resetN:'1'},advanceCycles:1});
    s.f.db.withTransaction(tx=>s.service.stopInTransaction(tx,s.attemptId,'assignment_paused',s.f.generation()));await s.service.processJob(operation.result.jobId);
    const ended=s.f.db.withTransaction(tx=>readHdlSession(tx,actor,p.result.sessionId));assert(ended.stopRequested);assert.notEqual(ended.status,'active');
  }finally{await s.f.close();}
});
test('existing authenticated Job paths dispatch HDL and stop its original session after a completed program',async()=>{
  const s=await setup();let composed:Awaited<ReturnType<typeof createWorkspaceApp>>|undefined;
  try{
    composed=await createWorkspaceApp({db:s.f.db,origin,signingSecret:s.f.signingSecret,currentGeneration:s.f.generation,now:s.f.timestamp,hdl:s.service});
    const build=s.service.build(actor,s.attemptId,'build',s.f.generation(),{expectedAttemptRevision:s.revision(),snapshotId:s.snapshotId});
    assert(composed.workspace.pendingJobs().includes(build.result.jobId));await composed.workspace.processJob(build.result.jobId);
    const p=await s.service.program(actor,s.attemptId,'program',s.f.generation(),{expectedAttemptRevision:s.revision(),buildId:build.result.buildId});await composed.workspace.processJob(p.result.jobId);
    const other=await s.f.login('other');const payload={recoveryGeneration:s.f.generation()};
    assert.equal((await composed.app.inject({method:'POST',url:`/api/jobs/${p.result.jobId}/cancel`,headers:{...other,'idempotency-key':'cancel'},payload})).statusCode,403);
    const cancelled=await composed.app.inject({method:'POST',url:`/api/jobs/${p.result.jobId}/cancel`,headers:{...s.student,'idempotency-key':'cancel'},payload});
    assert.equal(cancelled.statusCode,200,cancelled.body);
    const ended=s.f.db.withTransaction(tx=>readHdlSession(tx,actor,p.result.sessionId));assert(ended.stopRequested&&ended.terminationConfirmed);
    const trace=s.f.db.withTransaction(tx=>s.service.readTrace(tx,actor,p.result.sessionId));assert.equal(trace.operation?.result?.snapshotId,s.snapshotId);
  }finally{await composed?.app.close();await s.f.close();}
});
test('revoked membership cannot read or interact, while the trusted worker still stops original resources',async()=>{
  const s=await setup();try{
    const build=s.service.build(actor,s.attemptId,'build',s.f.generation(),{expectedAttemptRevision:s.revision(),snapshotId:s.snapshotId});await s.service.processJob(build.result.jobId);
    const p=await s.service.program(actor,s.attemptId,'program',s.f.generation(),{expectedAttemptRevision:s.revision(),buildId:build.result.buildId});await s.service.processJob(p.result.jobId);
    const op=s.service.interact(actor,s.attemptId,'step',s.f.generation(),{expectedAttemptRevision:s.revision(),sessionId:p.result.sessionId,expectedSessionRevision:1,expectedSequence:1,inputs:{switches:'0'.repeat(16),buttons:'00000',resetN:'1'},advanceCycles:1});
    s.f.db.withTransaction(tx=>{tx.run("UPDATE course_memberships SET active=0 WHERE course_id='course' AND user_id='student'");s.service.stopInTransaction(tx,s.attemptId,'membership_revoked',s.f.generation());});
    assert.throws(()=>s.f.db.withTransaction(tx=>readHdlSession(tx,actor,p.result.sessionId)));
    await s.service.processJob(op.result.jobId);await s.service.reconcileStops();
    assert.equal(s.f.db.withTransaction(tx=>tx.get('SELECT termination_confirmed FROM hdl_sessions WHERE session_id=?',p.result.sessionId)!.termination_confirmed),1);
  }finally{await s.f.close();}
});
test('job kind prefix classification matches startsWith for near prefixes, ASCII case and a missing kind',async()=>{
  const s=await setup();let composed:Awaited<ReturnType<typeof createWorkspaceApp>>|undefined;
  try{
    composed=await createWorkspaceApp({db:s.f.db,origin,signingSecret:s.f.signingSecret,currentGeneration:s.f.generation,now:s.f.timestamp,hdl:s.service});
    const receipt=String(s.f.db.withTransaction(tx=>tx.get('SELECT receipt_id FROM command_receipts LIMIT 1')!.receipt_id));
    // '_' is a LIKE wildcard and LIKE ignores ASCII case, so the near-prefix and upper-case kinds used to be claimed as HDL jobs.
    const sampled:[string,string|null|undefined][]=[['job-hdl','hdl_build'],['job-near','hdlXbuild'],['job-case','HDL_build'],['job-absent',undefined],['job-json-null',null]];
    for(const [jobId,kind] of sampled)
      s.f.db.withTransaction(tx=>tx.run('INSERT INTO jobs(job_id,course_id,student_id,attempt_id,request_receipt_id,purpose,status,stop_requested,recovery_generation,job_json) VALUES (?,?,?,?,?,?,?,?,?,?)',
        jobId,'course','student',null,receipt,'student_run','queued',0,s.f.generation(),kind===undefined?'{}':JSON.stringify({kind})));
    assert.deepEqual(s.service.pendingJobs().filter(id=>id.startsWith('job-')),['job-hdl'],'only the literal hdl_ prefix is an HDL job');
    const claimed=composed.workspace.pendingJobs().filter(id=>id.startsWith('job-'));
    assert.deepEqual([...claimed].sort(),['job-absent','job-case','job-hdl','job-json-null','job-near'],'the two workers together must still claim every pending job');
    assert.equal(new Set(claimed).size,claimed.length,'the two prefix predicates must stay exact negations, so no job is claimed twice');
    for(const [jobId,kind] of sampled)assert.equal((kind??'').startsWith('hdl_'),jobId==='job-hdl','SQL and JS must classify every sampled kind the same way');
  }finally{await composed?.app.close();await s.f.close();}
});
