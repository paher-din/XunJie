import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {test} from 'node:test';
import {sha256} from '../../runner/snapshot.ts';
import {createAttempt,freezeSnapshot} from './snapshots.ts';
import {runCommand,claimRun,reconcileRun,markRunUnknown,cancelRunCommand,confirmNodeCancellation,readWorkspace,readConfirmedSnapshot,readRunDiagnostics} from './commands.ts';
import type {CommandContext,WorkspaceState,RuntimeConfiguration} from './commands.ts';
import {readRuntime,sshRunner,dispatchOriginalRun,readOriginalResult,stopOriginalRun,validateRunResult} from '../records/runner.ts';
import type {RunnerTransport} from '../records/runner.ts';
import type {Profile} from '../../contracts/runner/index.ts';

const now='2026-10-10T00:00:00.000Z';
const at=(ms:number)=>new Date(Date.parse(now)+ms).toISOString();
const profile:Profile={runtimeProfileVersion:'synthetic-profile',imageDigest:`sha256:${sha256('manifest')}`,
  compilerImage:`sha256:${sha256('compiler')}`,runtimeImage:`sha256:${sha256('runtime')}`,approvedResultFiles:['report.txt']};
function fixture(generation='gen',source='#include <stdio.h>\nint main(void){puts("old snapshot");return 0;}',clock=now) {
  const id=`synthetic-${randomUUID()}`;
  const attempt=createAttempt([],{attemptId:id,assignmentId:`assignment-${id}`,activityVersionId:'synthetic-activity',courseId:'synthetic-course',studentId:'synthetic-student'},true);
  const files=[{fileId:'source',attemptId:id,path:'main.c',text:source,documentVersion:1,contentHash:sha256(source),lifecycle:'active' as const},
    {fileId:'input',attemptId:id,path:'a.txt',text:'C and memory.\n',documentVersion:1,contentHash:sha256('C and memory.\n'),lifecycle:'active' as const}];
  const snapshot=freezeSnapshot(attempt,files,0,`snapshot-${id}`,clock);
  const state:WorkspaceState={attempt,files,snapshots:[snapshot],checks:[],runs:[],records:{receipts:[],commandAliases:[],events:[],jobs:[],serverSeq:0}};
  const context:CommandContext={identity:{actorId:attempt.studentId,command:'runs',target:`/api/attempts/${id}/runs`,
    scope:{courseId:attempt.courseId,studentId:attempt.studentId,attemptId:id},idempotencyKey:'synthetic-request',recoveryGeneration:generation},
    generation,now:clock,commandId:`command-${id}`,receiptId:`receipt-${id}`,eventId:`event-${id}`,assignmentActive:true,authorize:()=>true};
  const runtime:RuntimeConfiguration={ready:true,recoveryGeneration:generation,profile,policyVersion:'synthetic-check-policy',checkRuleVersion:'textscope-core-v1',
    checkCancelPurposes:['student_help','reminder','explicit_analysis','passive_analysis']};
  const request={expectedAttemptRevision:1,snapshotId:snapshot.snapshotId,runtimeProfileVersion:profile.runtimeProfileVersion,
    entryFileId:'source',input:{operation:'stats' as const,fileIds:['input']},mode:'run' as const};
  const ids={runId:`run-${id}`,jobId:`job-${id}`};
  return {state,context,runtime,request,ids};
}
const fact=(submission:ReturnType<typeof runCommand>['state']['runs'][number]['submission'])=>({identity:submission.identity,
  state:'running',reserved:true,stopRequested:false,units:['xunjie-synthetic'],pending:['xunjie-synthetic']});

test('run plan freezes original IDs/snapshot, requires actual ready and registers check policy before execution',()=>{
  const f=fixture();const plan=runCommand(f.state,f.context,{...f.request,mode:'course_check'},f.runtime,f.ids,at(100000));
  assert.equal(f.state.records.jobs.length,0);assert.equal(plan.state.checks[0].state,'active');
  assert.equal(plan.state.records.jobs[0].requestReceiptId,plan.receipt.receiptId);
  assert.equal(plan.state.runs[0].submission.mode,'check');assert.equal(plan.state.attempt.decisionEpoch,1);
  f.state.files[0].text='new edit';assert.match(plan.state.runs[0].submission.snapshot.files[0].text,/old snapshot/);
  const repeated=runCommand(plan.state,f.context,{...f.request,mode:'course_check'},f.runtime,{runId:'unused',jobId:'unused'},at(100000));
  assert.equal(repeated.receipt.receiptId,plan.receipt.receiptId);assert.equal(repeated.state.runs.length,1);
  assert.throws(()=>runCommand(f.state,f.context,f.request,{...f.runtime,ready:false},f.ids,at(100000)),/unavailable/);
  assert.throws(()=>runCommand(f.state,f.context,f.request,{...f.runtime,recoveryGeneration:'other'},f.ids,at(100000)),/generation/);
  assert.throws(()=>runCommand(f.state,{...f.context,assignmentActive:false},f.request,f.runtime,f.ids,at(100000)),/not permitted/);
});
test('lost transport queries same original run and rechecks current authorization before submit',async()=>{
  const f=fixture();const planned=runCommand(f.state,f.context,f.request,f.runtime,f.ids,at(100000)).state;
  const submission=planned.runs[0].submission;let submits=0;let queries=0;
  const knownTransport:RunnerTransport=async command=>{if(command.op==='query'){queries++;return {data:fact(submission)};}submits++;throw Error('should not submit');};
  await dispatchOriginalRun(submission,knownTransport,()=>true);await dispatchOriginalRun(submission,knownTransport,()=>true);
  assert.equal(queries,2);assert.equal(submits,0);
  let guards=0;
  await assert.rejects(dispatchOriginalRun(submission,async()=>({data:null}),()=>++guards===1),/authorization/);
  await assert.rejects(dispatchOriginalRun(submission,async()=>{throw Error('link lost');},()=>true),/link lost/);
  const active=claimRun(planned,f.ids.jobId,'lease',at(90000),'gen',now);
  const unknown=markRunUnknown(active,f.ids.jobId,'gen');assert.equal(unknown.records.jobs[0].status,'outcome_unknown');
  assert.throws(()=>claimRun(unknown,f.ids.jobId,'replacement',at(95000),'gen',at(1000)),/dispatchable/);
  assert.equal(unknown.checks.length,0);
  const wrongScope={...active,records:{...active.records,jobs:active.records.jobs.map(row=>({...row,scope:{...row.scope,courseId:'other'}}))}};
  assert.throws(()=>markRunUnknown(wrongScope,f.ids.jobId,'gen'),/scope/);
});
test('check cancellation keeps stage until the authenticated node confirms no pending units',()=>{
  const f=fixture();const planned=runCommand(f.state,f.context,{...f.request,mode:'course_check'},f.runtime,f.ids,at(100000)).state;
  const cancelContext={...f.context,identity:{...f.context.identity,command:'cancel',target:`/api/jobs/${f.ids.jobId}/cancel`,idempotencyKey:'stop'},
    commandId:'stop-command',receiptId:'stop-receipt',eventId:'stop-event'};
  const cancelled=cancelRunCommand(planned,cancelContext,f.ids.jobId).state;
  assert.equal(cancelled.records.jobs[0].status,'cancelling');assert.equal(cancelled.checks[0].state,'active');
  assert.throws(()=>confirmNodeCancellation(cancelled,f.ids.jobId,fact(cancelled.runs[0].submission),'gen'),/not confirmed/);
  const ended=confirmNodeCancellation(cancelled,f.ids.jobId,{...fact(cancelled.runs[0].submission),state:'cancelled',reserved:false,stopRequested:true,pending:[]},'gen');
  assert.equal(ended.records.jobs[0].status,'cancelled');assert.equal(ended.checks[0].state,'ended');
  assert.equal(ended.runs[0].result,undefined);
});
test('confirmed original facts reconcile expired/unknown leases and never become current-code claims',()=>{
  const f=fixture();const planned=runCommand(f.state,f.context,f.request,f.runtime,f.ids,at(100000)).state;
  const active=claimRun(planned,f.ids.jobId,'lease',at(20000),'gen',now),unknown=markRunUnknown(active,f.ids.jobId,'gen');
  const record={runId:f.ids.runId,snapshotId:f.request.snapshotId,snapshotHash:planned.runs[0].submission.identity.snapshotHash,
    inputHash:planned.runs[0].submission.identity.inputHash,runtimeProfileVersion:profile.runtimeProfileVersion,imageDigest:profile.imageDigest,
    unitTerminated:true,failureKind:'program_error'};
  const result={...validateRunResult(planned.runs[0].submission,record),resultRef:'node-result'};
  const recovered=reconcileRun(unknown,f.ids.jobId,result,'lease','gen',at(25000));
  assert.equal(recovered.records.jobs[0].status,'succeeded');assert.equal(recovered.runs[0].resultHash,result.contentHash);
  assert.deepEqual(reconcileRun(recovered,f.ids.jobId,result,'lease','gen',at(25000)),recovered);
  const stopContext={...f.context,identity:{...f.context.identity,command:'cancel',target:`/api/jobs/${f.ids.jobId}/cancel`,idempotencyKey:'stop'},
    receiptId:'stop-receipt',eventId:'stop-event',commandId:'stop-command'};
  const stopped=cancelRunCommand(recovered,stopContext,f.ids.jobId).state;
  assert.equal(reconcileRun(stopped,f.ids.jobId,result,'lease','gen',at(26000)).records.jobs[0].status,'succeeded');
  assert.throws(()=>reconcileRun(unknown,f.ids.jobId,{...result,contentHash:sha256('different')},'lease','gen',at(25000)),/hash/);
  assert.throws(()=>readWorkspace(recovered,()=>false),/denied/);
  assert.throws(()=>reconcileRun(unknown,f.ids.jobId,result,'old-worker','gen',at(25000)),/lease/);
  assert.throws(()=>reconcileRun(unknown,f.ids.jobId,result,'lease','old-generation',at(25000)),/generation/);
});
test('authorized diagnostic reads exclude other attempts and private check detail',()=>{
  const f=fixture();let planned=runCommand(f.state,f.context,{...f.request,mode:'course_check'},f.runtime,f.ids,at(100000)).state;
  planned=claimRun(planned,f.ids.jobId,'lease',at(90000),'gen',now);
  const submission=planned.runs[0].submission;
  const record={runId:f.ids.runId,snapshotId:f.request.snapshotId,snapshotHash:submission.identity.snapshotHash,inputHash:submission.identity.inputHash,
    runtimeProfileVersion:profile.runtimeProfileVersion,imageDigest:profile.imageDigest,unitTerminated:true,verdict:'failed',
    phases:[{stdout:'synthetic private test detail',stderr:'synthetic private test detail'}]};
  const accepted=reconcileRun(planned,f.ids.jobId,{...validateRunResult(submission,record),resultRef:'ref'},'lease','gen',at(1000));
  assert(!JSON.stringify(readRunDiagnostics(accepted,f.ids.runId,()=>true)).includes('private test detail'));
  const mixed={...accepted,files:[...accepted.files,{...accepted.files[0],fileId:'other',attemptId:'other',text:'other student'}]};
  assert(!JSON.stringify(readWorkspace(mixed,()=>true).files).includes('other student'));
  assert.equal(readConfirmedSnapshot(accepted,f.request.snapshotId,()=>true).hash,submission.snapshot.hash);
  assert.throws(()=>readConfirmedSnapshot(accepted,f.request.snapshotId,()=>false),/denied/);
  const poisoned=JSON.parse(JSON.stringify(f.request));poisoned.input.shell='arbitrary';
  assert.throws(()=>runCommand(f.state,f.context,poisoned,f.runtime,f.ids,at(100000)),/approved/);
});

test('C2 synthetic confirmed workspace uses real C1 SSH: old snapshot, original result, check verdict and cancel',
  {skip:process.platform!=='linux'||process.env.XUNJIE_C2_RUNTIME!=='1'},async()=>{
  const transport=sshRunner({binary:'/usr/bin/ssh',keyFile:'/opt/xunjie-runner/vm/keys/application',
    knownHostsFile:'/opt/xunjie-runner/vm/keys/known_hosts',host:'127.0.0.1',port:2222});
  const ready=await readRuntime(transport);
  async function settled(submission:ReturnType<typeof runCommand>['state']['runs'][number]['submission']) {
    for(let index=0;index<120;index++) {
      const result=await readOriginalResult(submission,transport,()=>true);if(result)return result;
      await setTimeout(150);
    }
    assert.fail('Real C1 result not available');
  }
  const clock=new Date().toISOString(),deadline=new Date(Date.now()+120000).toISOString(),leaseUntil=new Date(Date.now()+100000).toISOString();
  const f=fixture(ready.recoveryGeneration,undefined,clock);f.runtime.profile=ready.profile;f.request.runtimeProfileVersion=ready.profile.runtimeProfileVersion;
  const planned=runCommand(f.state,f.context,f.request,f.runtime,f.ids,deadline).state;
  const active=claimRun(planned,f.ids.jobId,'lease',leaseUntil,ready.recoveryGeneration,clock);
  f.state.files[0].text='should not run this changed source';
  const first=await dispatchOriginalRun(active.runs[0].submission,transport,()=>true);assert(first);
  const result=await settled(active.runs[0].submission);
  assert.equal((result.record.phases as {stdout:string}[])[1].stdout,'old snapshot\n');
  const recovered=reconcileRun(active,f.ids.jobId,result,'lease',ready.recoveryGeneration,new Date().toISOString());
  const duplicate=await dispatchOriginalRun(active.runs[0].submission,transport,()=>true);
  assert.equal(duplicate?.resultRef,result.resultRef);assert.equal(recovered.records.jobs[0].status,'succeeded');
  const check=fixture(ready.recoveryGeneration,'#include <stdio.h>\nint main(void){puts("passed");return 0;}',clock);
  check.runtime.profile=ready.profile;check.request.runtimeProfileVersion=ready.profile.runtimeProfileVersion;
  const checked=claimRun(runCommand(check.state,check.context,{...check.request,mode:'course_check'},check.runtime,check.ids,deadline).state,
    check.ids.jobId,'check-lease',leaseUntil,ready.recoveryGeneration,clock);
  await dispatchOriginalRun(checked.runs[0].submission,transport,()=>true);
  const checkResult=await settled(checked.runs[0].submission);assert.equal(checkResult.record.verdict,'failed');
  assert.equal(reconcileRun(checked,check.ids.jobId,checkResult,'check-lease',ready.recoveryGeneration,new Date().toISOString()).checks[0].state,'ended');
  const cancelled=fixture(ready.recoveryGeneration,'int main(void){for(;;){}return 0;}',clock);
  cancelled.runtime.profile=ready.profile;cancelled.request.runtimeProfileVersion=ready.profile.runtimeProfileVersion;
  const before=runCommand(cancelled.state,cancelled.context,{...cancelled.request,mode:'course_check'},cancelled.runtime,cancelled.ids,deadline).state;
  const cancelContext={...cancelled.context,identity:{...cancelled.context.identity,command:'cancel',target:`/api/jobs/${cancelled.ids.jobId}/cancel`,idempotencyKey:'stop'},
    commandId:`stop-${randomUUID()}`,receiptId:`stop-${randomUUID()}`,eventId:`stop-${randomUUID()}`};
  const stopping=cancelRunCommand(before,cancelContext,cancelled.ids.jobId).state;
  const proof=await stopOriginalRun(before.runs[0].submission,transport,()=>true);
  const stopped=confirmNodeCancellation(stopping,cancelled.ids.jobId,proof,ready.recoveryGeneration);
  assert.equal(stopped.checks[0].state,'ended');
  assert.equal((await dispatchOriginalRun(before.runs[0].submission,transport,()=>true))?.state,'cancelled');
});
