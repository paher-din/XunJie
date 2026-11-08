// Bounded real-provider PDF acceptance through the production learning entry and owners.
import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import dns from 'node:dns/promises';
import dnsCallback from 'node:dns';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { fixedPdf } from '../apps/server/tests/fixtures/pdf-material.mjs';
import { pdfReferenceCopy } from '@xunjie/contracts/pdf-materials';
const {values}=parseArgs({options:{product:{type:'string'},out:{type:'string'},'credentials-file':{type:'string'},browser:{type:'boolean'},protocol:{type:'string'},course:{type:'boolean'},scan:{type:'boolean'},followup:{type:'boolean'}}});
if(!values.out||!values['credentials-file'])throw new Error('Requires --out and private --credentials-file');
const provider=JSON.parse(await readFile(values['credentials-file'],'utf8')).providers.find(p=>/deepseek/i.test(p.preset??p.name??'')&&p.key);
assert.ok(provider);
const protocols=values.protocol?[values.protocol]:['chat-completions','responses','messages'];
assert.ok(protocols.every(p=>['chat-completions','responses','messages'].includes(p)));
if(values.course&&values.scan)throw new Error('Choose course or scan');
const pdfBytes=values.course?await readFile('course_matrial/data_logic/lab/实验03题目-ALU.pdf'):values.scan?(await import('../apps/server/tests/fixtures/pdf-edge-cases.mjs')).scannedPdf():fixedPdf();
const pdfPage=values.scan?1:2,pdfName=values.course?'实验03题目-ALU.pdf':values.scan?'scan.pdf':'lesson.pdf';
const pkg=values.product?resolve(values.product):null;
const mod=await import(pkg?pathToFileURL(join(pkg,'app/product-runtime.js')).href:'@xunjie/product-runtime');
const resources=pkg?Object.fromEntries(Object.entries(JSON.parse(await readFile(join(pkg,'resources.json'),'utf8'))).map(([k,v])=>[k,typeof v==='string'&&/(Path|Bin|Root|Helper)$/.test(k)?resolve(pkg,v):v])):
 {nodePath:process.execPath,nodeVersion:'24.21.0',postgresVersion:'18.6',postgresBin:process.env.XUNJIE_PRODUCT_POSTGRES_BIN,webRoot:resolve('apps/web/dist-runtime'),windowsPrerequisitePath:resolve('scripts/windows-prereq-prepare.ps1')};
const hash=b=>createHash('sha256').update(b).digest('hex');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v;
const digest=v=>hash(JSON.stringify(canonical(v)));
const report={at:new Date().toISOString(),platform:process.platform,product:pkg?hash(await readFile(join(pkg,'distribution.json'))):'source-build',limits:{perProtocol:3,maxOutputTokens:2048,timeoutMs:30000,retries:0},requests:[],results:[]};
const originalFetch=globalThis.fetch,originalLookup=dns.lookup,socketLookup=dnsCallback.lookup;
// Network-boundary classification only: the actual TLS socket uses the host's DNS/proxy.
dns.lookup=async(host,options)=>host==='api.deepseek.com'?(options?.all?[{address:'93.184.216.34',family:4}]:{address:'93.184.216.34',family:4}):originalLookup(host,options);
syncBuiltinESMExports();
const count=new Map();
globalThis.fetch=async(input,init)=>{
 const request=new Request(input,init),url=new URL(request.url);
 if(url.hostname!=='api.deepseek.com')return originalFetch(input,init);
 const used=count.get(url.pathname)??0;if(used>=3)return new Response('{}',{status:429});count.set(url.pathname,used+1);
 const bytes=Buffer.from(await request.arrayBuffer()),payload=JSON.parse(bytes),item={path:url.pathname,payloadSha256:digest(payload),status:null,imageSha256:[]};
 const images=value=>{if(!value||typeof value!=='object')return;if(['image_url','input_image','image'].includes(value.type)){
 const data=value.source?.data??(typeof value.image_url==='string'?value.image_url:value.image_url?.url)?.split(',')[1];if(data)item.imageSha256.push(hash(Buffer.from(data,'base64')));
 }else Object.values(value).forEach(images);};images(payload);report.requests.push(item);
 return new Promise((resolveRequest,reject)=>{
  const upstream=https.request(url,{method:request.method,headers:Object.fromEntries(request.headers),lookup:socketLookup,timeout:30000},response=>{
   const chunks=[];response.on('data',c=>chunks.push(c));response.on('end',()=>{item.status=response.statusCode;resolveRequest(new Response(Buffer.concat(chunks),{status:response.statusCode,headers:{'content-type':response.headers['content-type']??'text/event-stream'}}));});
  });upstream.on('timeout',()=>upstream.destroy(new Error('provider-timeout')));upstream.on('error',()=>reject(new Error('provider-network-failed')));upstream.end(bytes);
 });
};
const root=await mkdtemp(join(tmpdir(),'xj-pdf-218-real-')),runtime=mod.openProductRuntime({root,resources});let host,browser;
try{
 await runtime.install({profile:'local'});host=await mod.createProductRuntimeHost({root,createApplication:mod.createProductLearningApplication});
 let actor={'x-xj-space':'personal'};
 const api=async(route,body,headers)=>{const r=await originalFetch(host.endpoint+'/api/learning/'+route,{headers:{'content-type':'application/json',...actor,...headers},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});assert.equal(r.status,200,route);return r.json();};
 let selectionVersion=0;
 for(const protocol of protocols){
  const result={protocol,passed:false};report.results.push(result);
  try{
   let releaseId,materialId,student;
   if(values.course){
    const admin={authorization:'Bearer '+await mod.resolveCredential(root,'control')},courseId=randomUUID();releaseId=randomUUID();materialId=randomUUID();
    await api('manage/course-import',{formatVersion:1,requestId:randomUUID(),course:{courseId,name:'数字逻辑与部件设计'},task:{taskId:randomUUID(),title:'实验03 ALU 资料阅读',summary:'读取获准固定课程PDF'},
     release:{releaseId,objectives:['理解 ALU 与七段显示模块的数据流'],requirements:'根据参考框图解释，不代写提交代码。',helpPolicy:{version:1,questions:'allowed',scope:'course'},starterWorks:[],capabilities:[],
      materials:[{materialId,title:pdfName,path:'alu.pdf',mediaType:'application/pdf',access:'student',sha256:hash(pdfBytes),byteLength:pdfBytes.length}]},resources:[{path:'alu.pdf',contentBase64:pdfBytes.toString('base64')}]},admin);
    student={loginName:'pdf-course-'+randomUUID(),password:randomUUID()};const member=await api('manage/members',{requestId:randomUUID(),...student},admin);
    await api('manage/course-access',{requestId:randomUUID(),courseId,principalId:member.principalId,active:true},admin);
    const logged=await originalFetch(host.endpoint+'/api/learning/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(student)});assert.equal(logged.status,200);
    actor={'x-xj-space':'school',cookie:logged.headers.get('set-cookie').split(';')[0]};selectionVersion=0;
   }
   const connectionId=randomUUID(),grantId=randomUUID();
   const connection=await api('models/connections',{requestId:randomUUID(),connectionId,expectedVersion:0,name:'PDF real acceptance',protocol,
    baseUrl:'https://api.deepseek.com/'+(protocol==='messages'?'anthropic':'v1'),path:protocol==='messages'?'/v1/messages':protocol==='responses'?'/responses':'/chat/completions',
    modelId:'deepseek-flash',dialect:'deepseek',parameterMode:'thinking',enabled:true,contextWindow:262144,maxOutputTokens:2048,credential:{action:'replace',value:provider.key}});
   assert.equal(connection.capabilities.images,'verified');
   await api('models/grants',{requestId:randomUUID(),grantId,connectionId,owner:'self'});
   selectionVersion=(await api('models/selection',{requestId:randomUUID(),expectedVersion:selectionVersion,source:{kind:'personal',connectionId,grantId}})).version;
   const activity=values.course?await api('course-activities',{requestId:randomUUID(),releaseId}):await api('activities',{requestId:randomUUID(),goal:'阅读电路与扫描资料',question:'',references:[]}),route='pdf/'+activity.activityId;
   let reading,doc,page;
   if(values.browser&&protocol===protocols[0]){
    const {chromium}=await import('@playwright/test');browser=await chromium.launch({channel:'chrome',headless:false});page=await browser.newPage({viewport:{width:1440,height:1000}});
    if(student)assert.equal((await page.context().request.post(host.endpoint+'/api/learning/login',{data:student})).status(),200);
    await page.goto(host.endpoint+'/?space='+actor['x-xj-space']+'&activity='+activity.activityId);const materials=page.getByRole('button',{name:'目标与材料',exact:true});if(await materials.getAttribute('aria-expanded')==='false')await materials.click();
    if(values.course)await page.getByRole('button',{name:pdfName,exact:true}).click();
    else await page.locator('input[type=file][accept="application/pdf,.pdf"]').setInputFiles({name:pdfName,mimeType:'application/pdf',buffer:pdfBytes});
    await page.getByRole('img',{name:'PDF 第 1 页固定页图',exact:true}).waitFor();if(pdfPage===2){await page.getByRole('button',{name:'下一页',exact:true}).click();await page.getByRole('img',{name:'PDF 第 2 页固定页图',exact:true}).waitFor();}
    doc=(await api(route))[0];const id=await page.locator('[data-pdf-reading-id]').getAttribute('data-pdf-reading-id');reading=await api(route+'/reads/'+id);
    await page.getByRole('button',{name:'引用此页',exact:true}).click();
    await page.screenshot({path:resolve(dirname(values.out),values.course?'mac-course.png':values.scan?'mac-scan.png':'mac-after.png'),fullPage:true});
   }else{
    doc=values.course?await api(route+'/course',{requestId:randomUUID(),documentId:randomUUID(),materialId}):await api(route,{requestId:randomUUID(),documentId:randomUUID(),name:pdfName,dataBase64:pdfBytes.toString('base64')});
    reading=await api(route+'/read',{requestId:randomUUID(),documentId:doc.documentId,pages:[pdfPage],region:null});
   }
   const copy=pdfReferenceCopy(reading),reference={referenceId:randomUUID(),source:{kind:'pdf',activityId:activity.activityId,documentId:doc.documentId,documentSha256:doc.sha256,readingId:reading.readingId},
    range:{kind:'semantic',formatVersion:1,typeId:'pdf-pages',version:1,target:{pages:[pdfPage],region:null,coordinates:reading.coordinates},start:0,end:copy.length},copy,sourceName:doc.name};
   const question=values.course?'请实际调用 read_reference 读取我引用的第2页页图，只读取一次，然后简短解释参考框图中 ALU、x7Seg、Hex7Seg 的关系。不要给代码或再调用工具。':values.scan?'请实际调用 read_reference 读取引用页图，只读取一次，然后描述图中左右两块的颜色与连接关系。该页无文字层，不能仅按文字判断。不要再调用其他工具。':'请实际调用 read_reference 读取我引用的 PDF 页图，然后简短说明该页显示的电压数值及实际页序与标签。只调用一次读取工具后回答；不要再调用其他工具。';
   let runId;
   if(page){
    const textarea=page.locator('textarea').filter({visible:true}).last();await textarea.fill(question);
    await page.getByRole('button',{name:'发送问题',exact:true}).click();
   }else{
    const receiver=(await api(`agent/${activity.activityId}/capabilities`)).receiver;
    const input={requestId:randomUUID(),scope:{...Object.fromEntries(['environmentId','spaceId','principalId'].map(k=>[k,activity.identity[k]])),activityId:activity.activityId},receiver,
     draft:{token:randomUUID(),question,references:[reference],bases:[]},works:[],evidence:[]};
    await api('intents/'+activity.activityId,input);runId=JSON.parse((await api(`intents/${activity.activityId}/${input.requestId}/dispatch`,{})).receipt.detail).runId;
   }
   let conversation;
   for(let n=0;n<500;n++){conversation=await api(`agent/${activity.activityId}/conversation`);const run=runId?conversation.runs.find(r=>r.runId===runId):conversation.runs[0];if(run?.state==='completed'){runId=run.runId;break;}if(['failed','paused','stopped'].includes(run?.state))throw new Error('run-'+run.state+'-'+run.reason);await new Promise(r=>setTimeout(r,200));}
   assert.equal(conversation.runs.find(r=>r.runId===runId)?.state,'completed');
   assert.ok(conversation.tools.some(t=>t.name==='read_reference'&&t.outcome==='completed'));
   const events=await api(`agent/${activity.activityId}/events`),snapshots=[];
   for(const event of events.filter(e=>e.kind==='context-assembled')){const s=await api(`agent/${activity.activityId}/snapshots/${event.body.snapshotId}`);assert.ok(report.requests.some(r=>r.payloadSha256===digest(s.payload)));snapshots.push({snapshotId:s.snapshotId,payloadSha256:digest(s.payload)});}
   assert.ok(report.requests.some(r=>r.imageSha256.includes(reading.pages[0].image.sha256)));
   const answer=conversation.messages.filter(m=>m.role==='assistant').map(m=>m.text).join('\n');assert.match(answer,values.course?/ALU/:values.scan?/红|red/i:/37/);if(values.scan)assert.equal(reading.pages[0].text,'');
   if(page){await page.screenshot({path:resolve(dirname(values.out),values.course?'mac-course-answer.png':values.scan?'mac-scan-answer.png':'mac-answer.png'),fullPage:true});result.chrome={version:browser.version(),formalMaterialEntry:true,fileUpload:!values.course,courseImport:!!values.course,draftQuote:true,modelSend:true};}
   if(page){
    await page.getByRole('button',{name:'返回作品',exact:true}).click();await page.locator('.teaching-tool-record > summary').first().click();await page.getByRole('button',{name:'定位来源',exact:true}).first().click();
    await page.locator('[data-pdf-reading-id="'+reading.readingId+'"]').waitFor();result.sourceClick=true;
   }
   if(values.followup){
    const followQuestion='不再调用工具，仅依据刚才已读的固定页，用一句话重述主要观察，并注明实际页序。';
    if(page){await page.locator('textarea:visible').last().fill(followQuestion);await page.getByRole('button',{name:'发送问题',exact:true}).click();}
    else{const receiver=(await api(`agent/${activity.activityId}/capabilities`)).receiver;const input={requestId:randomUUID(),scope:{...Object.fromEntries(['environmentId','spaceId','principalId'].map(k=>[k,activity.identity[k]])),activityId:activity.activityId},receiver,draft:{token:randomUUID(),question:followQuestion,references:[],bases:[]},works:[],evidence:[]};await api('intents/'+activity.activityId,input);await api(`intents/${activity.activityId}/${input.requestId}/dispatch`,{});}
    for(let n=0;n<300;n++){const value=await api(`agent/${activity.activityId}/conversation`),run=value.runs.find(r=>r.runId!==runId);if(run?.state==='completed'){result.followup=true;break;}if(['failed','paused'].includes(run?.state))throw new Error('followup-'+run.state+'-'+run.reason);await new Promise(r=>setTimeout(r,200));}assert.equal(result.followup,true);
   }
   await host.stop();host=await mod.createProductRuntimeHost({root,createApplication:mod.createProductLearningApplication});
   assert.deepEqual(await api(route+'/reads/'+reading.readingId),reading);result.restartFixedReading=true;
   if(page){
    await page.goto(host.endpoint+'/?space='+actor['x-xj-space']+'&activity='+activity.activityId);
    const conversationButton=page.getByRole('button',{name:/^(打开对话|问题与引用)$/});await conversationButton.waitFor();
    if(await conversationButton.getAttribute('aria-expanded')==='false')await conversationButton.click();
    await page.locator('.teaching-tool-record > summary').first().click();
    await page.getByRole('button',{name:'定位来源',exact:true}).first().click();
    await page.locator('[data-pdf-reading-id="'+reading.readingId+'"]').waitFor();
    result.chromeRestartSourceClick=true;
    await page.screenshot({path:resolve(dirname(values.out),values.course?'mac-course-restored.png':values.scan?'mac-scan-restored.png':'mac-restored.png'),fullPage:true});
   }
   result.passed=true;result.answer=answer;result.snapshots=snapshots;result.source={documentId:doc.documentId,readingId:reading.readingId,sha256:doc.sha256,imageSha256:reading.pages[0].image.sha256};
   await browser?.close();browser=null;
  }catch(error){if(browser){await browser.contexts()[0]?.pages()[0]?.screenshot({path:resolve(dirname(values.out),'mac-failure.png'),fullPage:true}).catch(()=>{});}result.error=error instanceof assert.AssertionError?'acceptance-assertion':String(error.message).slice(0,180);await browser?.close();browser=null;}
 }
}finally{
 await browser?.close();await host?.stop();await runtime.stop();globalThis.fetch=originalFetch;dns.lookup=originalLookup;syncBuiltinESMExports();
 await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100});await mkdir(dirname(resolve(values.out)),{recursive:true});await writeFile(resolve(values.out),JSON.stringify(report,null,2)+'\n');
}
console.log(JSON.stringify(report));if(report.results.some(r=>!r.passed))process.exitCode=1;
