import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { resolveCredential, openProductRuntime, createProductRuntimeHost, createProductLearningApplication } from '@xunjie/product-runtime';
import { join } from 'node:path';
import { pdfRuntime, modelReply } from './fixtures/pdf-runtime.mjs';
import { fixedPdf } from './fixtures/pdf-material.mjs';

test('course PDF import checks the fixed student-open release and retains its provenance', {timeout:180000}, async()=>{
 const f=await pdfRuntime((_payload,_index,protocol)=>modelReply(protocol,null));
 try {
  const admin={authorization:'Bearer '+await resolveCredential(f.root,'control')};
  const courseId=randomUUID(),releaseId=randomUUID(),materialId=randomUUID(),privateId=randomUUID(),bytes=fixedPdf();
  const manifest={formatVersion:1,requestId:randomUUID(),course:{courseId,name:'PDF 电路课程'},task:{taskId:randomUUID(),title:'阅读电路',summary:'根据原页学习'},
   release:{releaseId,objectives:['说明电路中的数值'],requirements:'请引用实际文件页序。',helpPolicy:{version:1,questions:'allowed',scope:'course'},
    materials:[{materialId,title:'课程电路.pdf',path:'lesson.pdf',mediaType:'Application/PDF; version=1.7',access:'student',sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length},
     {materialId:privateId,title:'教师私有.pdf',path:'private.pdf',mediaType:'application/pdf',access:'private',sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length}],starterWorks:[],capabilities:[]},
   resources:[{path:'lesson.pdf',contentBase64:bytes.toString('base64')},{path:'private.pdf',contentBase64:bytes.toString('base64')}]};
  await f.api('manage/course-import',manifest,admin);
  const password=randomUUID(),member=await f.api('manage/members',{requestId:randomUUID(),loginName:'pdf-student',password},admin);
  await f.api('manage/course-access',{requestId:randomUUID(),courseId,principalId:member.principalId,active:true},admin);
  const logged=await f.request('login',{loginName:'pdf-student',password},{'x-xj-space':'school'});
  assert.equal(logged.status,200);const student={'x-xj-space':'school',cookie:logged.headers.get('set-cookie').split(';')[0]};
  const activity=await f.api('course-activities',{requestId:randomUUID(),releaseId},student);
  const route=`pdf/${activity.activityId}`;
  const imported=await f.api(route+'/course',{requestId:randomUUID(),documentId:randomUUID(),materialId},student);
  assert.equal(imported.state,'ready');assert.deepEqual(imported.courseSource,{releaseId,materialId});
  const read=await f.api(route+'/read',{requestId:randomUUID(),documentId:imported.documentId,pages:[2],region:null},student);
  assert.match(read.pages[0].text,/37 volts/);
  // The installed remote client must expose PDF search through the same school grant.
  // No local PDF copy or parser is used by this client.
  const clientRoot=join(f.root,'pdf-remote-client'),clientRuntime=openProductRuntime({root:clientRoot,resources:f.resources});
  let clientHost;
  try {
   await clientRuntime.install({profile:'remote'});
   clientHost=await createProductRuntimeHost({root:clientRoot,createApplication:createProductLearningApplication});
   const connectionId=randomUUID();
   const clientCall=async(path,body,selected=false)=>{
    const response=await fetch(new URL('/api/learning/'+path,clientHost.endpoint),{method:'POST',
     headers:{'content-type':'application/json',...(selected?{'x-xj-space':'school:'+connectionId}:{})},body:JSON.stringify(body)});
    assert.equal(response.status,200,await response.clone().text());return response.json();
   };
   await clientCall('client/start',{requestId:connectionId,schoolEndpoint:f.endpoint});
   await f.api('connections/approve',{requestId:connectionId},student);
   await clientCall('client/complete',{requestId:connectionId});
   const found=await clientCall(route+'/find',{requestId:randomUUID(),documentId:imported.documentId,pages:[2],query:'37 volts'},true);
   assert.deepEqual(found.searchedPages,[2]);assert.equal(found.matches.length,1);
   assert.equal(found.source.documentSha256,imported.sha256);assert.equal(found.imagesSent,false);
  } finally {await clientHost?.stop();await clientRuntime.stop();}
  assert.notEqual((await f.request(route+'/course',{requestId:randomUUID(),documentId:randomUUID(),materialId:privateId},student)).status,200);
  assert.notEqual((await f.request(route+'/documents/'+imported.documentId)).status,200,'personal actor cannot read school PDF');
  await f.api('manage/course-access',{requestId:randomUUID(),courseId,principalId:member.principalId,active:false},admin);
  assert.notEqual((await f.request(route+'/reads/'+read.readingId,undefined,student)).status,200,'revocation stops new reads of retained pages');
 }finally{await f.close();}
});
