import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createQuestionDrafts, draftIdFor } from '../../../packages/learning-space/dist/learning-data/drafts.js';
import { verifySemanticReference } from '../../../packages/learning-space/dist/learning-data/semantic-references.js';
import { semanticReferenceCopy } from '@xunjie/contracts/question-drafts';
const uuid=()=>randomUUID();
function fixture(){
 const identity={environmentId:uuid(),spaceId:uuid(),principalId:uuid()},activityId=uuid(),objectId=uuid(),contentId=uuid(),annotationId=uuid();
 const manifest={componentId:uuid(),version:4,stateVersion:1,stateShape:{type:'object',properties:{annotations:{type:'array',maxItems:100,items:{type:'object',properties:{id:{type:'string',maxLength:36},quote:{type:'string',maxLength:4000},note:{type:'string',maxLength:4000}}}}}}};
 const binding={key:'annotation',definition:{digest:'a'.repeat(64),manifest}},activity={activityId,identity,course:{components:[binding]}};
 const state={formatVersion:1,instanceId:activityId+':annotation',componentId:manifest.componentId,version:4,definitionDigest:binding.definition.digest,stateVersion:1,operationId:uuid(),content:{annotations:[{id:annotationId,quote:'依据',note:'问题'}]}};
 const source={kind:'component',formatVersion:1,...identity,activityId,instanceId:state.instanceId,componentId:manifest.componentId,componentVersion:4,definitionDigest:binding.definition.digest,bindingKey:'annotation',objectId,contentId,origin:'state',requestId:null,executionRef:null};
 const range={kind:'semantic',formatVersion:1,typeId:'annotation-objects',version:1,target:{objectIds:[annotationId]},start:0,end:1};
 const copy=semanticReferenceCopy(range,state.content);range.end=copy.length;
 const reference={referenceId:uuid(),source,range,copy,sourceName:'标注'};
 let reads=0;
 const storage={readResource:async id=>{reads++;assert.equal(id,contentId);return Buffer.from(JSON.stringify(state))},read:async()=>({rows:[{object_id:objectId,activity_id:activityId,encoding:'json',media_type:'application/vnd.xunjie.component-state+json',kind:'state'}]})};
 return{activity,reference,storage,state,reads:()=>reads};
}
test('state owner verifies actual immutable object and selected content',async()=>{const f=fixture();await verifySemanticReference(f.storage,f.activity,f.reference);assert.equal(f.reads(),1)});
for(const field of ['environmentId','spaceId','principalId','activityId','instanceId','componentId','definitionDigest','objectId'])test('rejects forged '+field,async()=>{const f=fixture();f.reference.source[field]=field==='definitionDigest'?'b'.repeat(64):uuid();await assert.rejects(verifySemanticReference(f.storage,f.activity,f.reference));if(field!=='objectId')assert.equal(f.reads(),0)});
test('does not trust an equal-length claimed copy or an absent annotation id',async()=>{const f=fixture();f.reference.copy='假'.repeat(f.reference.copy.length);await assert.rejects(verifySemanticReference(f.storage,f.activity,f.reference));f.reference.range.target.objectIds=[uuid()];await assert.rejects(verifySemanticReference(f.storage,f.activity,f.reference))});
test('unknown adapters are rejected for creation but existing immutable envelopes can be checked read-only',async()=>{const f=fixture();f.reference.range.typeId='future-adapter';await assert.rejects(verifySemanticReference(f.storage,f.activity,f.reference));await verifySemanticReference(f.storage,f.activity,f.reference,true)});

const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function historicalFixture(kind='revision') {
 const f=fixture(), identity=f.activity.identity, draftId=draftIdFor(f.activity.activityId);
 // Simulates a once-registered adapter that is no longer installed.
 f.reference.range.typeId='retired-adapter';
 const stored={...structuredClone(f.reference),copyDigest:createHash('sha256').update(f.reference.copy).digest('hex')};
 const revisionId=uuid(),requestId=uuid();
 const draft={draftId,revision:1,revisionId,question:'原问题',references:[stored]};
 const action={requestId,scope:{...identity,activityId:f.activity.activityId},receiver:{receiverId:'test',location:'remote',kind:'question'},
  draft:{token:'fixed',question:'原问题',references:[structuredClone(f.reference)],bases:[]},works:[],evidence:[]};
 const row=kind==='revision'?{body:draft,content_digest:hash({question:draft.question,references:draft.references}),revision_id:revisionId,revision:1,request_id:null}
  :{body:action,content_digest:hash(action),request_id:requestId,revision_id:null,revision:null};
 let authorityCalls=0,pin=f.reference.source.contentId;
 const read=f.storage.read;
 f.storage.read=async(sql,params)=>{
  if(sql.includes('UNION ALL')) {assert.deepEqual(params.slice(0,5),[draftId,f.activity.activityId,identity.environmentId,identity.spaceId,identity.principalId]);return {rows:[row]};}
  if(sql.includes('_storage_references')) {assert.equal(params[0],kind==='revision'?`question-reference/${draftId}/${revisionId}/${f.reference.referenceId}`:`action/${requestId}/reference/${f.reference.referenceId}`);return {rows:pin?[{resource_id:pin}]:[]};}
  return read(sql,params);
 };
 const drafts=createQuestionDrafts(f.storage,{activity:async()=>f.activity,works:{},courses:{verifyComponentReference:async()=>{authorityCalls++;throw Error('disabled component')}}});
 return {...f,row,check:()=>drafts.verifyReferences(identity,f.activity.activityId,{references:[f.reference],bases:[]}),authorityCalls:()=>authorityCalls,removePin:()=>{pin=null}};
}
for(const kind of ['revision','action']) {
 test(`${kind} restores a removed historical reference without a current adapter or enabled component`,async()=>{
  const f=historicalFixture(kind);await f.check();assert.equal(f.authorityCalls(),0);assert.equal(f.reads(),1);
 });
 for(const fault of ['copy','range','reference-id']) test(`${kind} history does not authorize changed ${fault}`,async()=>{
  const f=historicalFixture(kind);
  if(fault==='copy')f.reference.copy='假'.repeat(f.reference.copy.length);
  if(fault==='range')f.reference.range.target.objectIds=[uuid()];
  if(fault==='reference-id')f.reference.referenceId=uuid();
  await assert.rejects(f.check(),/disabled component/);assert.equal(f.authorityCalls(),1);
 });
 test(`${kind} history rejects an unretained resource`,async()=>{const f=historicalFixture(kind);f.removePin();await assert.rejects(f.check(),error=>error.code==='corrupt')});
 test(`${kind} history rejects a corrupt stored digest`,async()=>{const f=historicalFixture(kind);f.row.content_digest='0'.repeat(64);await assert.rejects(f.check(),error=>error.code==='corrupt')});
}
test('an action in another principal scope cannot establish historical provenance',async()=>{
 const f=historicalFixture('action');f.row.body.scope.principalId=uuid();f.row.content_digest=hash(f.row.body);
 await assert.rejects(f.check(),error=>error.code==='corrupt');
});
