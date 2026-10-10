import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sha256} from '../../runner/snapshot.ts';
import {canonical,finishCommand,requestHash,resolveCommandReceipt} from './commands.ts';
import {enqueueJob,claimJob,renewJob,recordModelCall,finishJob,cancelJob,confirmRunStopped,recoverJob,cancelByPurpose,invalidateInTransaction} from './jobs.ts';
import type {Job,Records,CommandIdentity} from '../../contracts/records/index.ts';

const now='2026-10-10T00:00:00.000Z';
const at=(ms:number)=>new Date(Date.parse(now)+ms).toISOString();
const scope={courseId:'course',studentId:'student',attemptId:'attempt'};
const identity:CommandIdentity={actorId:'student',command:'sync',target:'/api/attempts/attempt/sync',scope,idempotencyKey:'key',recoveryGeneration:'gen',sync:{clientId:'page',clientSeq:40}};
const empty=():Records=>({receipts:[],commandAliases:[],events:[],jobs:[],serverSeq:0});
const job=(overrides:Partial<Job>={}):Job=>({jobId:'job',kind:'help',purpose:'student_help',scope,requestReceiptId:'receipt',status:'queued',
  stopRequested:false,expectedRevision:1,decisionEpoch:0,recoveryGeneration:'gen',acceptedAt:now,deadline:at(45000),attemptCount:0,...overrides});

test('canonical digest preserves body bytes, includes versions, rejects non-JSON and session credentials',()=>{
  assert.equal(canonical({z:1,a:{y:'a\r\n',b:2}}),canonical({a:{b:2,y:'a\r\n'},z:1}));
  assert.notEqual(requestHash('target',{text:'x\n'}),requestHash('target',{text:'x\r\n'}));
  assert.notEqual(requestHash('target',{revision:1}),requestHash('target',{revision:2}));
  for(const value of [undefined,NaN,{missing:undefined},new Date(),()=>{}])assert.throws(()=>canonical(value));
  assert.throws(()=>requestHash('/api/sessions',{password:'synthetic'}),/excluded/);
});
test('receipt plan binds both keys to original IDs and aliases cannot be reused for other payload',()=>{
  const records=empty(),hash=requestHash(identity.target,{revision:0,text:'first'});
  const input={receiptId:'receipt',commandId:'command',identity,requestHash:hash,result:{fileId:'file',version:1},committedAt:now};
  const event={eventId:'event',scope,type:'confirmed',occurredAt:now,source:'student_command' as const};
  const finished=finishCommand(records,input,event,'gen');
  assert.equal(records.receipts.length,0);assert.equal(finished.records.events.length,1);
  const alias={...identity,idempotencyKey:'alias'};
  const replay=finishCommand(finished.records,{...input,receiptId:'unused',commandId:'unused',identity:alias},{...event,eventId:'unused'},'gen');
  assert.equal(replay.receipt.receiptId,'receipt');assert.equal(replay.records.serverSeq,1);
  assert.equal(replay.records.commandAliases.length,1);
  assert.throws(()=>resolveCommandReceipt(replay.records,{...alias,sync:{clientId:'page',clientSeq:41}},sha256('other'),'gen'),/mismatch/);
  assert.throws(()=>resolveCommandReceipt(replay.records,{...identity,recoveryGeneration:'old'},hash,'gen'),/generation/);
  assert.throws(()=>resolveCommandReceipt(replay.records,{...identity,scope:{...scope,courseId:'other'}},hash,'gen'),/mismatch/);
});
test('jobs retain bounded deadlines/call counts across leases and reject expired worker completion',()=>{
  const queued=job();assert.equal(enqueueJob([],queued).length,1);
  assert.throws(()=>enqueueJob([queued],job({jobId:'second'})),/unsettled/);
  let running=claimJob(queued,'lease',at(20000),'gen',now);
  running=renewJob(running,'lease',at(30000),'gen',at(1000));
  for(let index=0;index<3;index++)running=recordModelCall(running,'lease','gen',at(1000));
  assert.equal(running.deadline,at(45000));assert.equal(running.attemptCount,3);
  assert.throws(()=>recordModelCall(running,'lease','gen',at(1000)),/not permitted/);
  const completion={leaseToken:'lease',generation:'gen',now:at(2000),resultRef:'result',resultHash:sha256('body')};
  const completed=finishJob(running,completion,{expectedRevision:1,decisionEpoch:0});
  assert.equal(completed.status,'succeeded');assert.equal(finishJob(completed,completion,{expectedRevision:2,decisionEpoch:1}).resultRef,'result');
  assert.throws(()=>finishJob(running,{...completion,leaseToken:'old'},{expectedRevision:1,decisionEpoch:0}),/lease/);
  assert.throws(()=>finishJob(running,{...completion,now:at(31000)},{expectedRevision:1,decisionEpoch:0}),/lease/);
  assert.throws(()=>finishJob(running,completion,{expectedRevision:1,decisionEpoch:1}),/applicable/);
  assert.equal(recoverJob(running,at(31000)).status,'outcome_unknown');
  assert.throws(()=>claimJob(recoverJob(running,at(31000)),'new',at(44000),'gen',at(32000)),/dispatchable/);
});
test('cancel and purpose invalidation preserve generated/ordinary-run facts and unknown occupancy',()=>{
  const run=claimJob(job({purpose:'student_run',kind:'run',runId:'run'}),'lease',at(20000),'gen',now);
  const stopping=cancelJob(run);assert.equal(stopping.status,'cancelling');
  assert.throws(()=>confirmRunStopped(stopping,'run',false),/not confirmed/);
  assert.equal(confirmRunStopped(stopping,'run',true).status,'cancelled');
  const completed=job({status:'succeeded',resultRef:'result',resultHash:sha256('body')});
  assert.equal(cancelJob(completed).status,'succeeded');assert.equal(cancelJob(completed).stopRequested,true);
  const reminder=job({jobId:'reminder',purpose:'reminder'});
  const result=cancelByPurpose([job(),reminder,run],scope,['reminder']);
  assert.deepEqual(result.jobIds,['reminder']);assert.equal(result.jobs[0]!.stopRequested,false);
  const invalidated=invalidateInTransaction([job(),run,completed],{courseId:'course',studentId:'student',attemptIds:['attempt'],expectedEpochs:{attempt:0}},{attempt:0});
  assert.equal(invalidated.epochs.attempt,1);assert.equal(invalidated.jobs[0]!.status,'stale');
  assert.equal(invalidated.jobs[1]!.status,'running');assert.equal(invalidated.jobs[2]!.status,'succeeded');
  assert.equal(invalidated.jobs[2]!.stopRequested,true);assert(invalidated.jobIds.includes(completed.jobId));
  assert.throws(()=>invalidateInTransaction([job()],{courseId:'course',studentId:'student',attemptIds:['attempt'],expectedEpochs:{attempt:9}},{attempt:0}),/epoch/);
});
