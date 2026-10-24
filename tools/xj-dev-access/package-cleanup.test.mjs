import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openAccessStore } from './store.mjs';
import { createPackages } from './packages.mjs';
import { createOssStorage } from './oss-storage.mjs';

function fixture() {
  const root=mkdtempSync(join(tmpdir(),'xjpc-')),key=join(root,'key');writeFileSync(key,randomBytes(32),{mode:0o600});
  const access=openAccessStore(join(root,'access.sqlite'),key,'cleanup-test');
  const memberId=access.createInvitation({label:'fixture',teamRole:'developer',appRole:'student',courseId:'course',ttlSeconds:60,capabilities:['file:publish']}).memberId;
  const state={uploads:new Map(),objects:new Map(),failHead:0,failDelete:0,loseInit:false,loseHeadAfterComplete:true,completeCrc64:'0'};
  const foreign='team/_protocol-probe/not-ours';state.uploads.set(foreign,new Set(['foreign-upload']));state.objects.set(foreign,{bytes:1,crc64:'0',etag:'"foreign"'});
  const error=(code,status)=>Object.assign(new Error('controlled storage failure'),{code,status});
  class SDK {
    async listUploads(){return {uploads:[...state.uploads].flatMap(([name,ids])=>[...ids].map(uploadId=>({name,uploadId}))),isTruncated:false};}
    async initMultipartUpload(name){const uploadId=randomUUID();state.uploads.set(name,new Set([uploadId]));if(state.loseInit)throw error('RequestTimeout',503);return {uploadId};}
    async listParts(name){return {parts:[{PartNumber:'1',Size:'7',ETag:'"'+createHash('md5').update('fixture').digest('hex')+'"'}],isTruncated:false};}
    async completeMultipartUpload(name,uploadId){state.uploads.get(name)?.delete(uploadId);state.objects.set(name,{bytes:7,crc64:state.completeCrc64,etag:'"final-etag"'});if(state.loseHeadAfterComplete)state.failHead=1;return {};}
    async abortMultipartUpload(name,uploadId){assert.notEqual(name,foreign);if(!state.uploads.get(name)?.delete(uploadId))throw error('NoSuchUpload',404);}
    async head(name){if(state.failHead){state.failHead--;throw error('ServiceUnavailable',503);}const p=state.objects.get(name);if(!p)throw error('NoSuchKey',404);return {res:{headers:{'content-length':String(p.bytes),'x-oss-hash-crc64ecma':p.crc64,etag:p.etag}}};}
    async delete(name){assert.notEqual(name,foreign);if(state.failDelete){state.failDelete--;throw error('ServiceUnavailable',503);}state.objects.delete(name);return {};}
  }
  const config={bucket:'fixture-bucket',prefix:'team/',region:'oss-cn-beijing',roleName:'fixture-role'};
  const storage=createOssStorage(config,{SDK,credentials:async()=>({accessKeyId:'fixture-id',accessKeySecret:'fixture-secret',stsToken:'fixture-token',expiresAt:Date.now()+3600000})});
  const packages=createPackages(access,config,{storage}),identity={memberId,deviceId:randomUUID()};
  const input={idempotencyKey:randomUUID(),digest:'sha256:'+'a'.repeat(64),bytes:7,crc64:'0',formatVersion:'xj-repro/1',toolVersion:'0.2.0'};
  const completedButUnpublished=async()=>{
    const {transferId}=await packages.handle('upload',identity,input);
    packages.catalog.declareParts(transferId,[{partNumber:1,bytes:7,contentMD5:createHash('md5').update('fixture').digest('base64')}]);
    await assert.rejects(packages.handle('complete',identity,{transferId}),{code:'OBJECT_STORAGE_UNAVAILABLE'});
    assert.equal(packages.catalog.get(transferId).state,'uploading');return transferId;
  };
  return {state,packages,identity,input,completedButUnpublished,foreign,close(){access.close();rmSync(root,{recursive:true,force:true});}};
}

test('Complete succeeded but subsequent HEAD failed: cleanup confirms both multipart and object gone before returning quota',async()=>{
  const f=fixture();try{
    const transferId=await f.completedButUnpublished(),p=f.packages.catalog.get(transferId);assert(f.state.objects.has(p.object_key));
    await f.packages.admin('package-cleanup',{transferId});
    assert.equal(f.state.objects.has(p.object_key),false);assert.equal(f.state.uploads.get(p.object_key).size,0);
    assert.equal(f.packages.catalog.quota(f.identity.memberId).usage.memberBytes,0);
    assert(f.state.objects.has(f.foreign));assert.equal(f.state.uploads.get(f.foreign).size,1);
  }finally{f.close();}
});

test('cleanup HEAD or Delete failure persists deny and reservation until an explicit successful retry',async()=>{
  const f=fixture();try{
    const transferId=await f.completedButUnpublished();f.state.failHead=1;
    await assert.rejects(f.packages.admin('package-cleanup',{transferId}),{code:'OBJECT_STORAGE_UNAVAILABLE'});
    assert.equal(f.packages.catalog.get(transferId).state,'failed');assert.equal(f.packages.catalog.quota(f.identity.memberId).usage.memberBytes,7);
    f.state.failDelete=1;await assert.rejects(f.packages.admin('package-cleanup',{transferId}),{code:'OBJECT_STORAGE_UNAVAILABLE'});
    assert.equal(f.packages.catalog.quota(f.identity.memberId).usage.memberBytes,7);
    await f.packages.admin('package-cleanup',{transferId});assert.equal(f.packages.catalog.quota(f.identity.memberId).usage.memberBytes,0);
  }finally{f.close();}
});

test('lost Init reply with NULL database uploadId is cleaned by exact owned key without sweeping another prefix',async()=>{
  const f=fixture();try{
    f.state.loseInit=true;await assert.rejects(f.packages.handle('upload',f.identity,f.input),{code:'OBJECT_STORAGE_UNAVAILABLE'});
    const p=f.packages.catalog.reservation(f.identity,f.input);
    assert.equal(p.upload_id,null);assert.equal(f.state.uploads.get(p.object_key).size,1);
    await f.packages.admin('package-cleanup',{transferId:p.id});assert.equal(f.state.uploads.get(p.object_key).size,0);
    assert.equal(f.packages.catalog.quota(f.identity.memberId).usage.memberBytes,0);assert.equal(f.state.uploads.get(f.foreign).size,1);
  }finally{f.close();}
});

test('completed object with a mismatched HEAD CRC remains unpublished and can only be reclaimed through failed cleanup',async()=>{
  const f=fixture();try{
    f.state.loseHeadAfterComplete=false;f.state.completeCrc64='1';
    const {transferId}=await f.packages.handle('upload',f.identity,f.input);
    f.packages.catalog.declareParts(transferId,[{partNumber:1,bytes:7,contentMD5:createHash('md5').update('fixture').digest('base64')}]);
    await assert.rejects(f.packages.handle('complete',f.identity,{transferId}),{code:'OBJECT_MISMATCH'});
    const p=f.packages.catalog.get(transferId);assert.equal(p.state,'uploading');assert(f.state.objects.has(p.object_key));
    await f.packages.admin('package-cleanup',{transferId});assert.equal(f.state.objects.has(p.object_key),false);
    assert.equal(f.packages.catalog.quota(f.identity.memberId).usage.memberBytes,0);
  }finally{f.close();}
});
