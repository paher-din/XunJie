import assert from 'node:assert/strict';
import {test} from 'node:test';
import {sha256} from '../../runner/snapshot.ts';
import {applyChanges,rangeOffsets,syncFiles} from './files.ts';
import {beginExplicitOperation,createAttempt,freezeSnapshot,validateObjectRef} from './snapshots.ts';
import {controlAttempt} from './controls.ts';
import {syncCommand,snapshotCommand} from './commands.ts';
import type {CommandContext,WorkspaceState} from './commands.ts';
import type {Attempt,ProjectFile,SyncBatch,Range} from '../../contracts/workspace/index.ts';

const now='2026-10-10T00:00:00.000Z';
const attempt=():Attempt=>createAttempt([],{attemptId:'attempt',courseId:'course',studentId:'student',assignmentId:'assignment',activityVersionId:'activity'},true);
const file=(id='file',path='main.c',text='int main(void){return 0;}'):ProjectFile=>({fileId:id,attemptId:'attempt',path,documentVersion:1,text,contentHash:sha256(text),lifecycle:'active'});
const batch=(operations:SyncBatch['operations'],revision=0):SyncBatch=>({clientId:'page',clientSeq:400,expectedWorkspaceRevision:revision,operations});
const state=():WorkspaceState=>({attempt:attempt(),files:[],snapshots:[],checks:[],runs:[],records:{receipts:[],commandAliases:[],events:[],jobs:[],serverSeq:0}});
const context=(command='sync'):CommandContext=>({identity:{actorId:'student',scope:{courseId:'course',studentId:'student',attemptId:'attempt'},command,target:`/api/attempts/attempt/${command}`,
  idempotencyKey:'key',recoveryGeneration:'gen',...(command==='sync'?{sync:{clientId:'page',clientSeq:400}}:{})},generation:'gen',now,commandId:'command',receiptId:'receipt',eventId:'event',assignmentActive:true,authorize:()=>true});
const range=(startLine:number,startColumn:number,endLine:number,endColumn:number):Range=>({startLine,startColumn,endLine,endColumn});

test('whole sync plan, stable receipt and authorization-before-replay distinguish confirmed from uncommitted',()=>{
  const original=state(),request=batch([{kind:'create',clientFileKey:'new',path:'main.c',text:'first'}]);
  const first=syncCommand(original,context(),request,{new:'file'});
  assert.equal(original.files.length,0);assert.equal(first.state.files[0].documentVersion,1);
  assert.equal(first.state.attempt.status,'active');assert.equal(first.state.attempt.workspaceRevision,1);
  const replay=syncCommand(first.state,context(),request,{new:'must-not-create'});
  assert.equal(replay.replayed,true);assert.deepEqual(replay.receipt,first.receipt);assert.equal(replay.state.records.events.length,1);
  assert.throws(()=>syncCommand(first.state,{...context(),authorize:()=>false},request,{}),/Authorized/);
  assert.throws(()=>syncCommand(first.state,context(),{...request,operations:[{kind:'create',clientFileKey:'new',path:'main.c',text:'changed'}]},{}),/mismatch/);
  assert.throws(()=>syncCommand(original,context(),batch([{kind:'create',clientFileKey:'new',path:'ok.c',text:'ok'},{kind:'create',clientFileKey:'bad',path:'../escape',text:'bad'}]),{new:'one',bad:'two'}),/path/);
  assert.equal(original.records.receipts.length,0);assert.equal(original.files.length,0);
});
test('CAS conflicts, paused updates, recycle/recreate/restore and limits never mutate input',()=>{
  const current=attempt(),files=[file()];
  assert.throws(()=>syncFiles(current,files,batch([{kind:'update',fileId:'file',baseVersion:0,text:'wrong'}]),true,{}),/version/);
  assert.throws(()=>syncFiles(current,files,batch([{kind:'update',fileId:'other',baseVersion:1,text:'wrong'}]),true,{}),/belong/);
  const recycled=syncFiles(current,files,batch([{kind:'recycle',fileId:'file',baseVersion:1}]),true,{});
  const rebuilt=syncFiles(recycled.attempt,recycled.files,batch([{kind:'create',clientFileKey:'new',path:'main.c',text:'new'}],1),true,{new:'new-instance'});
  assert.throws(()=>syncFiles(rebuilt.attempt,rebuilt.files,batch([{kind:'restore',fileId:'file',baseVersion:2}],2),true,{}),/occupied/);
  assert.equal(rebuilt.files[0].fileId,'file');assert.equal(rebuilt.files[0].lifecycle,'recycled');
  const paused={...current,status:'paused' as const};
  assert.equal(syncFiles(paused,files,batch([{kind:'update',fileId:'file',baseVersion:1,text:'saved'}]),false,{}).files[0].text,'saved');
  assert.throws(()=>syncFiles(paused,files,batch([{kind:'recycle',fileId:'file',baseVersion:1}]),false,{}),/Paused/);
  assert.throws(()=>syncFiles(current,files,batch([{kind:'update',fileId:'file',baseVersion:1,text:'x'.repeat(1048577)}]),true,{}),/limit/);
  const fifty=Array.from({length:50},(_,index)=>file(`f${index}`,`f${index}.txt`,''));
  assert.throws(()=>syncFiles(current,fifty,batch([{kind:'create',clientFileKey:'new',path:'51.txt',text:''}]),true,{new:'51'}),/limit/);
  assert.equal(files[0].documentVersion,1);assert.equal(files[0].text,'int main(void){return 0;}');
});
test('exact UTF-16 edits preserve CRLF/emoji, reject overlap and malformed ranges',()=>{
  const text='😀a\r\n中文\n';
  assert.deepEqual(rangeOffsets(text,range(1,3,1,4)),[2,3]);
  assert.equal(applyChanges(text,[{range:range(1,3,1,4),text:'b'},{range:range(2,2,2,3),text:'字'}]),'😀b\r\n中字\n');
  assert.throws(()=>applyChanges(text,[{range:range(1,1,1,3),text:''},{range:range(1,2,1,3),text:'x'}]),/Overlapping/);
  assert.throws(()=>rangeOffsets(text,JSON.parse('{}')),/range/);
  assert.throws(()=>rangeOffsets(text,range(9,1,9,1)),/line/);
  assert.throws(()=>applyChanges(text,[{range:range(1,1,1,2),text:''}]),/Unicode/);
});
test('snapshot and ObjectRef bind old file instance/version/body rather than current paths',()=>{
  const current=attempt(),files=[file('file','main.c','😀a\r\n')];
  const snapshot=freezeSnapshot(current,files,0,'snapshot',now);
  const reference={kind:'code' as const,attemptId:'attempt',snapshotId:'snapshot',fileId:'file',path:'main.c',documentVersion:1,contentHash:files[0].contentHash,range:range(1,1,1,3)};
  const refs={snapshots:[snapshot],runs:[],resources:[]};
  assert.deepEqual(validateObjectRef(current,reference,refs),reference);
  files[0].text='changed';assert.equal(snapshot.files[0].text,'😀a\r\n');
  assert.throws(()=>validateObjectRef(current,{...reference,fileId:'new-instance'},refs),/instance/);
  assert.throws(()=>validateObjectRef(current,{...reference,attemptId:'other'},refs),/scope/);
  assert.throws(()=>freezeSnapshot(current,[file()],1,'wrong',now),/version/);
  const prior=state();prior.files=[file()];const frozen=snapshotCommand(prior,context('snapshots'),0,'snapshot');
  assert.equal(prior.snapshots.length,0);assert.equal(frozen.state.snapshots.length,1);
  assert.equal(snapshotCommand(frozen.state,context('snapshots'),0,'unused').receipt.receiptId,'receipt');
});
test('capture/reminder/lifecycle controls are separate and stale process does not block saving',()=>{
  const current=attempt();const disabled=controlAttempt(current,1,{kind:'capture',value:false},true);
  assert.equal(disabled.attempt.status,'ready');assert.equal(disabled.attempt.decisionEpoch,0);assert.equal(disabled.attempt.captureRevision,1);
  assert.deepEqual(disabled.cancelPurposes,['passive_analysis']);
  const same=controlAttempt(disabled.attempt,2,{kind:'capture',value:false},true);
  assert.equal(same.attempt.attemptRevision,2);assert.equal(same.attempt.captureRevision,1);
  const resumed=controlAttempt(disabled.attempt,2,{kind:'capture',value:true},true);
  const request={...batch([{kind:'update',fileId:'file',baseVersion:1,text:'latest'}]),process:{captureRevision:0}};
  const saved=syncFiles(resumed.attempt,[file()],request,true,{});
  assert.equal(saved.files[0].text,'latest');assert.equal(saved.process.reason,'stale_capture_revision');
  const started=beginExplicitOperation(current,1,true);const paused=controlAttempt(started,2,{kind:'pause'},true);
  assert.equal(paused.attempt.decisionEpoch,1);assert(paused.cancelPurposes.includes('student_run'));
  assert.throws(()=>controlAttempt(paused.attempt,3,{kind:'resume'},false),/overridden/);
  assert.equal(current.status,'ready');
});
test('unapproved fields, pre-ACK file operations and prototype-like client keys are handled safely',()=>{
  const original=state(),request=batch([{kind:'create',clientFileKey:'__proto__',path:'safe.c',text:'safe'}]);
  const planned=syncCommand(original,context(),request,Object.fromEntries([['__proto__','safe-file']]));
  assert.equal((planned.receipt.result as {created:Record<string,string>}).created.__proto__,'safe-file');
  assert.throws(()=>syncFiles(attempt(),[],batch([{kind:'create',clientFileKey:'new',path:'main.c',text:'first'},
    {kind:'update',fileId:'new-file',baseVersion:1,text:'not acknowledged'}]),true,{new:'new-file'}),/confirmed/);
  const poisoned=JSON.parse(JSON.stringify(batch([{kind:'create',clientFileKey:'new',path:'safe.c',text:'safe'}])));
  poisoned.operations[0].shell='arbitrary';assert.throws(()=>syncFiles(attempt(),[],poisoned,true,{new:'new-file'}),/approved/);
  assert.throws(()=>snapshotCommand({...original,attempt:{...original.attempt,status:'submitted'}},context('snapshots'),0,'new'),/read-only/);
});
