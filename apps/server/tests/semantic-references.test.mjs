import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
