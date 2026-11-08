import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { pdfReferenceCopy } from '@xunjie/contracts/pdf-materials';
import { pdfRuntime, modelReply } from './fixtures/pdf-runtime.mjs';
import { fixedPdf } from './fixtures/pdf-material.mjs';

for (const firstTool of ['read_pdf', 'find_pdf']) test(`${firstTool}: bounded feedback permits reading the retained tail of a long native page`, {timeout:180000}, async()=>{
 const body=Array.from({length:400},()=> 'target searchable "quoted" evidence;').join('\n')+'\nTAIL-MARKER-218';
 let referenceId,readingId,returnedTail;
 const f=await pdfRuntime((payload,index,protocol)=>{
  if(index===1)return modelReply(protocol,{id:'read-long-page',name:firstTool,arguments:firstTool==='read_pdf'
   ?{referenceId,pages:[2],region:null}:{referenceId,pages:[2],query:'target'}});
  const text=payload.messages.filter(message=>message.role==='tool').at(-1)?.content;
  assert.ok(typeof text==='string'&&text.length<=8192,'the exact Gateway feedback remains within its wire limit');
  const feedback=JSON.parse(text);
  if(index===2){
   readingId=feedback.source.readingId;
   assert.equal(feedback.readMore.tool,'read_pdf_text');
   assert.equal(feedback.readMore.referenceId,referenceId);
   if(firstTool==='find_pdf')assert.equal(feedback.feedbackMatchesTruncated,true);
   else assert.equal(feedback.reading.pages[0].textTruncated,true);
   return modelReply(protocol,{id:'read-page-tail',name:'read_pdf_text',arguments:{referenceId,readingId,page:2,start:body.length-100,length:100}});
  }
  returnedTail=feedback;
  assert.match(feedback.text,/TAIL-MARKER-218/);
  assert.equal(feedback.imagesSent,false);
  return modelReply(protocol,null,'尾部正文来自原固定阅读副本，不是新转换。');
 },'chat-completions',fixedPdf(body));
 try{
  assert.equal(f.reading.pages[0].text,body,'fixture retains the complete native text');
  // The question cites the cover only. The requested long page was never copied into its input.
  const cover=await f.api(`pdf/${f.activity.activityId}/read`,{requestId:randomUUID(),documentId:f.document.documentId,pages:[1],region:null});
  const copy=pdfReferenceCopy(cover),reference={...f.reference,referenceId:randomUUID(),copy,
   source:{...f.reference.source,readingId:cover.readingId},range:{...f.reference.range,end:copy.length,target:{...f.reference.range.target,pages:[1]}}};
  referenceId=reference.referenceId;
  const input={...f.input,draft:{...f.input.draft,references:[reference]}};
  const conversation=await f.completed(await f.send(input));
  assert.equal(f.payloads.length,3);assert.equal(conversation.tools.length,2);
  const retained=await f.api(`pdf/${f.activity.activityId}/reads/${readingId}`);
  assert.equal(retained.pages[0].text,body);
  if(firstTool==='find_pdf')assert.equal(conversation.tools[0].result.matches.length,100,'full retained result is not its model projection');
  assert.equal(returnedTail.start,body.length-100);assert.equal(returnedTail.end,body.length);assert.equal(returnedTail.nextStart,null);
  assert.equal(returnedTail.source.readingId,readingId);
  await f.restart();
  assert.deepEqual(await f.api(`pdf/${f.activity.activityId}/reads/${readingId}`),retained);
  assert.equal(f.payloads.length,3);
 }finally{await f.close();}
});

test('native-text continuation cannot borrow a reading from an unselected document', {timeout:180000}, async()=>{
 let referenceId,readingId;
 const f=await pdfRuntime((payload,index,protocol)=>{
  if(index===1)return modelReply(protocol,{id:'foreign-text',name:'read_pdf_text',arguments:{referenceId,readingId,page:2,start:0,length:100}});
  const text=payload.messages.filter(message=>message.role==='tool').at(-1)?.content;
  assert.match(text,/not-executed|forbidden/);assert.doesNotMatch(text,/UNSELECTED-PDF-CONTENT/);
  return modelReply(protocol,null,'无权读取未选择的文件。');
 });
 try{
  referenceId=f.reference.referenceId;
  const route=`pdf/${f.activity.activityId}`;
  const other=await f.api(route,{requestId:randomUUID(),documentId:randomUUID(),name:'other.pdf',dataBase64:fixedPdf('UNSELECTED-PDF-CONTENT').toString('base64')});
  readingId=(await f.api(route+'/read',{requestId:randomUUID(),documentId:other.documentId,pages:[2],region:null})).readingId;
  const conversation=await f.completed(await f.send());
  assert.equal(conversation.tools[0].outcome,'not-dispatched');assert.equal(f.payloads.length,2);
 }finally{await f.close();}
});
