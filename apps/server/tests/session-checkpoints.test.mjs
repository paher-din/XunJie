import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as id, createHash } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { createSessionCheckpoints } from '../../../packages/learning-space/dist/learning-data/session-checkpoints.js';
import { createNativeSessions } from '../../../packages/learning-space/dist/learning-data/native-sessions.js';

// A fault-injection seam for blob/transaction ordering; real PG is tested in session-recovery.runtime.test.mjs.
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([key, child]) => [key, canonical(child)]))
    : value;
function fixture() {
 const digest='a'.repeat(64),scope={environmentId:id(),spaceId:id(),principalId:id(),activityId:id()};
 const limits={operationTimeoutMs:5000,idleMs:60000,maxMs:120000,memoryMiB:64,concurrentSessions:2,queuedSessions:0};
 const action={protocolVersion:2,kind:'execution',requestId:id(),scope,receiver:{receiverId:'native-execution',location:'local',kind:'execution'},
  execution:{instance:{instanceId:scope.activityId+':accumulator',key:'accumulator',componentId:id(),componentVersion:2,definitionDigest:digest,hostApiVersion:1,stateVersion:1},
   operation:{operationId:'advance',effect:'input'},parameters:{},basis:{works:[],state:null,expected:{stateContentId:null},resources:[]},
   limits:{timeMs:5000,memoryPages:1,inputBytes:1024,outputBytes:65536,concurrentJobs:2,queuedJobs:0},
   plan:{planId:'native-session',planVersion:1,planDigest:digest,location:'native',kind:'session'},session:{adapterId:'four-state-accumulator',adapterVersion:2,limits},
   initiator:{kind:'student',principalId:scope.principalId}}};
 const row={action,session_ref:id(),executor_instance_id:id()},controlId=id(),configuration={title:'恢复测试'};
 const observation={seq:3,controlId,state:{value:3,total:3,applied:2},at:'2026-11-03T10:00:00.000Z',sessionState:'paused',
  checkpoint:{formatVersion:1,value:3,total:3,applied:2,mode:'paused'}};
 let pending,checkpoint,bytes,pin,failUpload=false,corruptRead=false,missing=false,published=[];
 const receipts=new Map();
 const query=async(sql,values=[])=>{
  if(sql.includes('SET checkpoint_pending'))pending=JSON.parse(values[1]);
  else if(sql.startsWith('SELECT checkpoints'))return {rows:[{checkpoints:published}]};
  else if(sql.includes('INSERT INTO native_session_checkpoints'))checkpoint={checkpoint_id:values[0],control_id:values[0],session_ref:values[1],
   content_id:values[0],sha256:values[2],byte_length:values[3],applied_seq:values[4],envelope:JSON.parse(values[5]),original_action:action};
  else if(sql.includes('SET checkpoints'))published=JSON.parse(values[1]);
  return {rows:[],rowCount:1};
 };
 const storage={
  request:async(input,effect)=>{const previous=receipts.get(input.requestId);if(previous){assert.equal(previous.fingerprint,input.fingerprint);return previous;}
   const result=await effect({query,reference:async(_key,resource)=>{pin=resource}});const receipt={fingerprint:input.fingerprint,result};receipts.set(input.requestId,receipt);return receipt;},
  read:async sql=>({rows:sql.includes('checkpoint_pending')?(pending?[{checkpoint_pending:structuredClone(pending)}]:[])
   :sql.includes('_storage_references')?(pin?[{resource_id:pin}]:[]):checkpoint?[checkpoint]:[]}),
  stageResource:async input=>{assert.equal(input.uploadId,controlId);bytes=Buffer.from(input.bytes);
   if(failUpload){failUpload=false;throw new StorageError('upload-unknown');}
   return {resourceId:controlId,sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length};},
  readResource:async()=>{if(missing)throw new StorageError('missing');return corruptRead?Buffer.from('damaged'):bytes;},
 };
 const owner=createSessionCheckpoints(storage);
 const capture=()=>owner.capture(row,controlId,observation,configuration,1);
 const restoreAction=()=>({...structuredClone(action),requestId:id(),execution:{...structuredClone(action.execution),
  resumeFromCheckpoint:{checkpointId:controlId,sessionRef:row.session_ref,sha256:checkpoint.sha256}}});
 return {owner,capture,observation,configuration,restoreAction,published:()=>published,
  failUpload:()=>{failUpload=true},corruptRead:()=>{corruptRead=true},missing:()=>{missing=true},removePin:()=>{pin=null},
  environmentMismatch:()=>{const envelope=JSON.parse(Buffer.from(bytes).toString('utf8'));
   envelope.environment={platform:'plan9',arch:'mips',node:'v0.0.0'};
   const rewritten=Buffer.from(JSON.stringify(canonical(envelope)));
   bytes=rewritten;checkpoint.envelope=envelope;
   checkpoint.sha256=createHash('sha256').update(rewritten).digest('hex');checkpoint.byte_length=rewritten.length;
   return checkpoint.sha256;},
  controlId};
}
test('an interrupted checkpoint upload reuses the cached executor snapshot and operation identity',async()=>{
 const f=fixture();f.failUpload();await assert.rejects(f.capture(),error=>error.code==='upload-unknown');assert.deepEqual(f.published(),[]);
 f.observation.checkpoint.value=0;
 await f.owner.complete(f.controlId);assert.equal(f.published().length,1);
 assert.deepEqual((await f.owner.restore(f.restoreAction(),f.configuration,1)).snapshot,{formatVersion:1,value:3,total:3,applied:2,mode:'paused'});
});
test('a checkpoint is not published before its bytes are successfully re-read',async()=>{
 const f=fixture();f.corruptRead();await assert.rejects(f.capture(),error=>error.code==='corrupt');assert.deepEqual(f.published(),[]);
});
for(const fault of ['corrupt','missing','retention','configuration','adapter','format','principal','digest','environment'])test('checkpoint restore refuses '+fault,async()=>{
 const f=fixture();await f.capture();const action=f.restoreAction();let configuration=f.configuration,version=1,expected;
 if(fault==='corrupt'){f.corruptRead();expected='corrupt';}
 if(fault==='missing'){f.missing();expected='missing';}
 if(fault==='retention'){f.removePin();expected='corrupt';}
 if(fault==='configuration'){configuration={title:'different'};expected='invalid';}
 if(fault==='adapter'){action.execution.session.adapterVersion=99;expected='invalid';}
 if(fault==='format'){version=2;expected='invalid';}
 if(fault==='principal'){action.scope.principalId=id();expected='forbidden';}
 if(fault==='digest'){action.execution.resumeFromCheckpoint.sha256='0'.repeat(64);expected='identity-conflict';}
 if(fault==='environment'){action.execution.resumeFromCheckpoint.sha256=f.environmentMismatch();expected='invalid';}
 await assert.rejects(f.owner.restore(action,configuration,version),error=>error.code===expected);
});

test('maintenance cannot declare an unconfirmed current executor drained after its live handle was lost',async()=>{
 const epoch=id(), storage={generation:'test',read:async(sql,values)=>{
  assert.match(sql,/status_knowledge='unknown'/);assert.deepEqual(values,[epoch]);return {rows:[{session_ref:id()}]};
 }};
 const owner=createNativeSessions(storage,{supervisorEpoch:epoch,works:{},activity:async()=>{throw Error('not used')}});
 await assert.rejects(owner.shutdown(),error=>error.code==='unavailable');
 await assert.rejects(owner.control({},id(),id(),{}),error=>error.code==='maintenance');
 await assert.rejects(owner.accept({},id(),{}),error=>error.code==='maintenance');
});
