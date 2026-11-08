import { captureJobEvidence } from './probe-evidence.mjs';
// Public WP09 scenario layered on the established two-host runtime controller.
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash, X509Certificate } from 'node:crypto';
import { readFile, writeFile, mkdtemp, mkdir, rename, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { execFile, spawn } from 'node:child_process';
const exec=promisify(execFile), sha=v=>createHash('sha256').update(v).digest('hex'), delay=ms=>new Promise(d=>setTimeout(d,ms));
const check=(v,c)=>{if(!v)throw Object.assign(new Error(c),{code:c});};
const safe=e=>/^[a-zA-Z0-9_-]{1,100}$/.test(e?.code??'')?e.code:e?.name==='TimeoutError'?'browser-control-timeout':'artifact-case-failed';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,canonical(x)])):v;
const digest=v=>sha(JSON.stringify(canonical(v))), q=v=>"'"+v.replaceAll("'","''")+"'";
const meaning='学生对二进制位宽的解释';
async function atomic(path,value){await writeFile(path+'.tmp',JSON.stringify(value,null,2)+'\n',{mode:0o600});for(let n=0;;n++){try{await rename(path+'.tmp',path);return;}catch(error){if(n>=8||!['EPERM','EACCES','EBUSY'].includes(error.code))throw error;await delay(100);}}}
async function until(f,code,ms=180000){const end=Date.now()+ms;while(Date.now()<end){const v=await f();if(v)return v;await delay(400);}throw Object.assign(new Error(code),{code});}
export async function windowsControl(ssh,source,input=''){
 return new Promise((done,reject)=>{
 source=source.replaceAll('[Console]::In.ReadToEnd()', '([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::ReadLine())))');
 const ps="$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.UTF8Encoding]::new($false);[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);"+source;
  const child=spawn('ssh',['-o','BatchMode=yes','-o','ConnectTimeout=10',ssh,'powershell -NoProfile -EncodedCommand '+Buffer.from(ps,'utf16le').toString('base64')],{stdio:['pipe','pipe','pipe']});
  let out='';child.stdout.on('data',b=>out+=b);child.stderr.resume();const t=setTimeout(()=>{child.kill();reject(Object.assign(new Error(),{code:'windows-control-timeout'}));},60000);
  child.on('error',()=>{clearTimeout(t);reject(Object.assign(new Error(),{code:'windows-control-failed'}));});child.on('close',n=>{clearTimeout(t);n===0?done(out.replace(/^\uFEFF/,'').trim()):reject(Object.assign(new Error(),{code:'windows-control-failed'}));});child.stdin.end(Buffer.from(input,'utf8').toString('base64')+'\n');
 });
}
function teachingPayload(revised=false){return {html:'<h2>二进制位宽教学示意</h2><p>位宽增加一位，可表示的组合数加倍。'+(revised?'补充：这仍是教学示意。':'')+'</p><label>我的解释<textarea aria-label="我的解释"></textarea></label>',title:'位宽解释卡',display:'card',formatVersion:1,hostApiVersion:1,css:'body{padding:16px;color:var(--ink)}textarea{display:block;width:95%;min-height:120px}',javascript:'(async()=>{const saved=await window.xunjie.read();const input=document.querySelector("textarea");input.value=saved.content.explanation;input.addEventListener("input",()=>window.xunjie.change({explanation:input.value}).catch(()=>{}));})();',stateVersion:1,stateShape:{type:'object',properties:{explanation:{type:'string',maxLength:1000}}},initialState:{explanation:''},semanticFields:[{key:'explanation',meaning}],semanticObjects:[],requiredCapabilities:['workspace.read','workspace.change'],artifactId:null,parentRevisionId:null,mapping:[]};}
export function controlledArtifactReply(payload){
 const messages=payload.messages??[],last=messages.at(-1),question=[...messages].reverse().find(m=>m.role==='user')?.content??'';
 const text=typeof question==='string'?question:JSON.stringify(question),match=text.match(/artifactId=([a-f0-9-]{36}),parentRevisionId=([a-f0-9-]{36})/i);
 let name,args;
 if(last?.role==='tool'){
  const toolMessage=[...messages].reverse().find(m=>m.role==='assistant'&&m.tool_calls?.length)?.tool_calls?.[0];
  if(toolMessage?.function?.name==='read_teaching_artifact'){name='generate_teaching_artifact';args={...teachingPayload(true),artifactId:match?.[1],parentRevisionId:match?.[2]};}
 }else if(match){name='read_teaching_artifact';args={artifactId:match[1],revisionId:match[2]};}
 else{name='generate_teaching_artifact';args=teachingPayload();}
 return {id:'controlled-'+randomUUID(),object:'chat.completion',created:Math.floor(Date.now()/1000),model:payload.model,
  choices:[{index:0,message:name?{role:'assistant',content:null,tool_calls:[{id:'call_'+randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:'学习卡片已准备，保留你的解释。'},finish_reason:name?'tool_calls':'stop'}],usage:{prompt_tokens:600,completion_tokens:name?900:20,total_tokens:name?1500:620}};
}
export function controlledArtifactStream(payload) {
 const reply=controlledArtifactReply(payload),message=reply.choices[0].message;
 const delta={...message}; if(delta.tool_calls)delta.tool_calls=delta.tool_calls.map((tool,index)=>({...tool,index}));
 return 'data: '+JSON.stringify({id:reply.id,choices:[{index:0,delta,finish_reason:null}]})+'\n\n'
  +'data: '+JSON.stringify({id:reply.id,choices:[{index:0,delta:{},finish_reason:reply.choices[0].finish_reason}]})+'\n\n'
  +'data: '+JSON.stringify({choices:[],usage:reply.usage})+'\n\ndata: [DONE]\n\n';
}
export async function stableTlsIngress({certificate,key,port,target}) {
 const ca=await readFile(certificate),privateKey=await readFile(key);
 const server=https.createServer({cert:ca,key:privateKey},(request,response)=>{
  const url=new URL(request.url,target);const upstream=https.request(url,{method:request.method,headers:{...request.headers,host:url.host},ca,rejectUnauthorized:true},incoming=>{response.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(response);});
  upstream.on('error',()=>{if(!response.headersSent)response.writeHead(502,{'content-type':'application/json'});response.end(JSON.stringify({error:'unavailable'}));});request.pipe(upstream);
 });await new Promise((done,reject)=>{server.once('error',reject);server.listen(port,'0.0.0.0',done);});return {async close(){server.closeAllConnections();await new Promise(done=>server.close(done));}};
}
let workerExtra;
export async function artifactWorkerOperation(input,c){
 workerExtra??={};const x=workerExtra,{pkg,runtime,state,args}=c;
 if(input.operation==='artifact.local-setup'){
  check(!x.localRuntime,'local-Windows-already-started');x.directory??=await mkdtemp(join(tmpdir(),'xj-wp09-agent-local-'));x.localRoot=join(x.directory,'local-product');x.localModelCalls=0;
  x.localServer=createServer(async(request,response)=>{const chunks=[];for await(const chunk of request)chunks.push(chunk);const payload=JSON.parse(Buffer.concat(chunks).toString());if(++x.localModelCalls>2){response.writeHead(429);response.end();return;}response.writeHead(200,{'content-type':'text/event-stream'});response.end(controlledArtifactStream(payload));});
  await new Promise(done=>x.localServer.listen(0,'127.0.0.1',done));
  x.localRuntime=pkg.module.openProductRuntime({root:x.localRoot,resources:pkg.resources});await x.localRuntime.install({profile:'local'});x.localHost=await pkg.module.createProductRuntimeHost({root:x.localRoot,createApplication:pkg.module.createProductLearningApplication});
  const api=async(route,body)=>{const response=await fetch(x.localHost.endpoint+'/api/learning/'+route,{headers:{'content-type':'application/json','x-xj-space':'personal'},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});check(response.status===200,'windows-local-http-'+response.status);return response.json();};
  const connectionId=randomUUID(),grantId=randomUUID();await api('models/connections',{requestId:randomUUID(),connectionId,expectedVersion:0,name:'WP09 controlled local-only acceptance',protocol:'chat-completions',baseUrl:'http://127.0.0.1:'+x.localServer.address().port+'/v1',path:'/chat/completions',modelId:'deepseek-flash',dialect:'deepseek',parameterMode:'thinking',enabled:true,contextWindow:262144,maxOutputTokens:8192,credential:{action:'replace',value:'controlled-only-'+randomUUID()}});
  await api('models/grants',{requestId:randomUUID(),grantId,connectionId,owner:'self'});const selected=await api('models/selection');await api('models/selection',{requestId:randomUUID(),expectedVersion:selected.version,source:{kind:'personal',connectionId,grantId}});
  const activity=await api('activities',{requestId:randomUUID(),goal:'Windows 本机独立学习卡',question:'',references:[]}),cap=await api('agent/'+activity.activityId+'/capabilities'),requestId=randomUUID();
  await api('intents/'+activity.activityId,{requestId,scope:{environmentId:activity.identity.environmentId,spaceId:activity.identity.spaceId,principalId:activity.identity.principalId,activityId:activity.activityId},receiver:cap.receiver,draft:{token:randomUUID(),question:'请用generate_teaching_artifact制作二进制位宽解释卡。',references:[],bases:[]},works:[],evidence:[]});
  const accepted=await api(`intents/${activity.activityId}/${requestId}/dispatch`,{});check(accepted.state==='accepted','windows-local-action-not-accepted');const runId=JSON.parse(accepted.receipt.detail).runId;
  await until(async()=>{const conversation=await api('agent/'+activity.activityId+'/conversation'),run=conversation.runs.find(r=>r.runId===runId);if(run&&['failed','stopped','paused'].includes(run.state))throw Object.assign(new Error(),{code:'windows-local-run-'+run.state});return run?.state==='completed';},'windows-local-Agent-timeout');
  return {activityId:activity.activityId,endpoint:x.localHost.endpoint,requestId,runId,environmentId:activity.identity.environmentId,modelSource:'controlled Chat SSE transport; no provider key on Windows',modelCalls:x.localModelCalls};
 }
 if(input.operation==='artifact.metadata')return {root:c.root,serviceIds:state.environment.services.map(s=>s.serviceId)};
 if(input.operation==='artifact.resume-active-target'){
  check(input.root?.replaceAll('\\','/').startsWith('C:/Users/h/AppData/Local/Temp/xj-wp09-agent-recovery-'),'unexpected-restored-root');
  x.targetRoot=input.root;x.directory=dirname(input.root);x.target=pkg.module.openProductRuntime({root:x.targetRoot,resources:pkg.resources});
  x.host=await pkg.module.createProductRuntimeHost({root:x.targetRoot,createApplication:pkg.module.createProductLearningApplication});
  const value=await x.target.status();const recovery=JSON.parse(await readFile(join(x.targetRoot,'recovery-state.json'),'utf8'));
  check(recovery.phase==='active','existing-target-not-active');return {state:value.state,environment:value.environment,endpoint:value.endpoint};
 }
 if(input.operation==='artifact.backup'){
  check(!x.backup,'backup-already-created');x.directory=await mkdtemp(join(tmpdir(),'xj-wp09-agent-recovery-'));
  const keyRef='wp09-associated-recovery-'+randomUUID();await runtime.setCredential(keyRef,input.key);
  x.backup=await runtime.recovery.backup({directory:join(x.directory,'backups'),recoveryKeyRef:keyRef,leaveClosed:true});
  x.archive=join(x.directory,'agent-backup.tgz');await exec('tar.exe',['-czf',x.archive,'-C',join(x.directory,'backups'),x.backup.backupId],{timeout:120000});
  return {backupId:x.backup.backupId,boundaryAt:x.backup.boundaryAt,receiverIds:x.backup.receiverIds,archive:x.archive,installationId:state.environment.installationId,environmentId:state.environment.environmentId};
 }
 if(input.operation==='artifact.restore'){
  check(x.backup&&!x.target,'backup-required');x.targetRoot=join(x.directory,'restored');
  const restored=await pkg.module.restoreProductRecovery({root:x.targetRoot,resources:pkg.resources,backupDirectory:join(x.directory,'backups',x.backup.backupId),key:Buffer.from(input.key,'base64'),
   installation:{profile:'agent',host:'0.0.0.0',port:Number(args['win-port'])+2,publicEndpoint:`https://${args['win-host']}:${Number(args['win-port'])+2}`,tls:{certificateFile:resolve(args.certificate),keyFile:resolve(args.key)}}});
  const ownerMaterial=[];for(const owner of restored.owners){const m=await owner.material({backupId:x.backup.backupId,boundaryAt:x.backup.boundaryAt,signal:new AbortController().signal});ownerMaterial.push({serviceId:m.serviceId,kind:m.kind,sources:m.sources?.entries?.map(e=>({kind:e.kind,fixedId:e.fixedId,digest:e.digest})),blocking:m.blocking.length});await owner.close?.();}
  x.target=pkg.module.openProductRuntime({root:x.targetRoot,resources:pkg.resources});x.host=await pkg.module.createProductRuntimeHost({root:x.targetRoot,createApplication:pkg.module.createProductLearningApplication});
  const status=await x.target.status();return {state:status.state,endpoint:status.endpoint,environmentId:status.environment.environmentId,installationId:status.environment.installationId,target:status.environment.services.find(s=>s.unit==='teaching-agent'),ownerMaterial};
 }
 if(input.operation==='artifact.fence')return runtime.recovery.fenceSource(input.fence);
 if(input.operation==='artifact.fence-active')return x.target.recovery.fenceSource(input.fence);
 if(input.operation==='artifact.takeover'){
  const proof=input.proof;check(x.host&&proof?.fenced,'real-fence-proof-required');
  const result=await x.host.recovery.takeover({source:{retire:binding=>runtime.recovery.retire(binding)},receivers:[{id:proof.receiverId,async fence(){return proof;}}]});return {result,active:true};
 }
 if(input.operation==='artifact.authorize')return x.target.authorize({...input.source,capabilities:['teaching.agent']},input.targetServiceId);
 if(input.operation==='artifact.connect'){const config=JSON.parse(await readFile(join(x.targetRoot,'installation.json'),'utf8'));const exists=config.connections.some(c=>c.connectionId===input.connection.connectionId);await x.target[exists?'reconnect':'connect'](input.connection,input.token);return {connected:true};}
 if(input.operation==='artifact.switch-ingress'){await runtime.stop();x.ingress=await stableTlsIngress({certificate:args.certificate,key:args.key,port:Number(args['win-port']),target:`https://${args['win-host']}:${Number(args['win-port'])+2}`});return {sourceStopped:true,stableEndpoint:`https://${args['win-host']}:${args['win-port']}`,successorNativeEndpoint:`https://${args['win-host']}:${Number(args['win-port'])+2}`};}
 if(input.operation==='artifact.assert-retired'){try{await runtime.reconnect(input.connection,input.token);return {rejected:false};}catch(error){return {rejected:true,code:safe(error)};}}

 if(input.operation==='artifact.restart-target'){await x.host.stop();x.host=await pkg.module.createProductRuntimeHost({root:x.targetRoot,createApplication:pkg.module.createProductLearningApplication});return {restarted:true,endpoint:x.host.endpoint};}
 throw Object.assign(new Error(),{code:'unsupported-artifact-worker-operation'});
}
export async function cleanupArtifactWorker(c,{keep=false}={}){
 if(!workerExtra)return {};const x=workerExtra;if(!x.stopped){await x.ingress?.close();await x.localHost?.stop();const installed=x.localRuntime&&await readFile(join(x.localRoot,'installation.json')).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});if(installed){if(keep)await x.localRuntime.stop();else check((await c.removeEnvironment(x.localRuntime,x.localRoot)).rootRemoved,'local-Windows-product-cleanup-failed');}if(x.localServer)await new Promise(done=>x.localServer.close(done));await x.host?.stop();x.stopped=true;}
 if(keep){if(x.target&&x.host)await x.target.stop();return {retainedDerivedRoots:x.directory?[x.directory]:[]};}
 if(x.target)check((await c.removeEnvironment(x.target,x.targetRoot)).rootRemoved,'restored-agent-cleanup-failed');
 if(x.directory)await rm(x.directory,{recursive:true,force:true,maxRetries:5,retryDelay:200});workerExtra=null;
}

/** This runs in installed Chrome; Windows launches it in an Interactive/Limited scheduled task. */
export async function artifactChromeJob(path){
 const job=JSON.parse(await readFile(path,'utf8'));await rm(path);
 const result={status:'running',platform:process.platform,host:hostname(),workerProcessId:process.pid,checks:[],screenshots:[],model:'no browser-to-provider connection'};
 let browser,page,phase='desktop',writes=Promise.resolve();const save=()=>{result.phase=phase;result.observedAt=new Date().toISOString();const copy=JSON.parse(JSON.stringify(result));const pending=writes.then(()=>atomic(job.result,copy));writes=pending.catch(()=>{});return pending;};
 await save();let diagnosing=false,diagnosticAt=0;
 const heartbeat=setInterval(()=>{void save().catch(error=>{result.saveError=safe(error);});if(job.diagnosticOnly&&page&&phase==='actual-checked-candidate'&&!diagnosing&&Date.now()-diagnosticAt>5000){diagnosing=true;diagnosticAt=Date.now();void (async()=>{
  result.diagnostic=await page.evaluate(async activityId=>{
   const read=async route=>{try{const response=await fetch('/api/learning/'+route,{headers:{'x-xj-space':'school',...(window.__wp09Namespace?{'x-xj-namespace':window.__wp09Namespace}:{})},signal:AbortSignal.timeout(10000)});const body=await response.json();return {status:response.status,body};}catch{return {status:0,error:'read-unavailable'};}};
   const artifacts=await read('artifacts/'+activityId),conversation=await read('agent/'+activityId+'/conversation');
   const candidates=[];if(artifacts.status===200&&Array.isArray(artifacts.body))for(const item of artifacts.body)candidates.push(await read(`artifacts/${activityId}/candidates/${item.latestCandidateId}`));
   let controller,workspace,activityProps;for(const element of document.querySelectorAll('article,main,section')){let fiber=element[Object.keys(element).find(key=>key.startsWith('__reactFiber$'))];for(let n=0;fiber&&n<35;n++,fiber=fiber.return){controller??=fiber.memoizedProps?.controller;if(fiber.memoizedProps?.activity?.activityId===activityId&&'authorized' in fiber.memoizedProps)activityProps??=fiber.memoizedProps;let dep=fiber.dependencies?.firstContext;while(dep){workspace??=dep.memoizedValue?.workspace;dep=dep.next;}}}
   const w=workspace?.snapshot?.();
   return {visibility:document.visibilityState,focus:document.hasFocus(),triggerFlags:{authorized:controller?.authorized??activityProps?.authorized,readOnly:workspace?.isReadOnly?.(),activityStatus:controller?.activity?.status??activityProps?.activity?.status,workspaceReady:w?.ready,workspaceError:w?.error,entries:controller?.entries?.map(e=>({artifactId:e.artifact.artifactId,revisionId:e.revision?.revisionId??null,issue:e.issue}))},url:location.pathname+location.search,visibleText:document.body.innerText.slice(0,3500),cards:document.querySelectorAll('.teaching-artifact-card').length,iframes:[...document.querySelectorAll('iframe')].map(f=>({title:f.title,src:f.getAttribute('src')})),errors:[...document.querySelectorAll('[role=alert],.learning-error')].map(e=>e.textContent.slice(0,300)),artifacts,candidates,conversation:{status:conversation.status,error:conversation.body?.error,tools:conversation.body?.tools?.map(t=>({name:t.name,runId:t.runId,commandId:t.commandId,outcome:t.outcome,resultKeys:Object.keys(t.result??{}),artifact:t.result?.artifact,feedback:t.feedback})),runs:conversation.body?.runs?.map(r=>({runId:r.runId,state:r.state,stopRequested:r.stopRequested,reason:r.reason}))}};
  },job.activityId);
  if(job.captureEvidence!==false&&job.screenshot&&!result.diagnosticScreenshot&&!await page.getByLabel('学校账号',{exact:true}).isVisible()){await captureJobEvidence(job,page,result,'diagnostic-current-page',{path:job.screenshot.replace(/\.png$/,'-diagnostic.png'),fullPage:true,timeout:5000});result.diagnosticScreenshot=true;}
 })().catch(error=>{result.diagnosticError=safe(error);}).finally(()=>{diagnosing=false;});}},1000);heartbeat.unref();
 try{
  phase='request-TLS-CA';
  if(job.certificate){
   const pem=await readFile(job.certificate,'utf8'),certificate=new X509Certificate(pem);
   check(createHash('sha256').update(certificate.publicKey.export({type:'spki',format:'der'})).digest('base64')===job.spki,'browser-test-CA-pin-mismatch');
   // route.fetch uses Node TLS, independently of Chrome's SPKI trust flag.
   tls.setDefaultCACertificates([...tls.getCACertificates('default'),pem]);
   result.requestTransport={testCaSha256:sha(certificate.raw),certificateVerification:true};
  }
  phase='playwright-import';
  const {chromium,expect}=createRequire(job.playwright)('@playwright/test');
  phase='native-session-id';
  if(process.platform==='win32'){const s=await exec('powershell.exe',['-NoProfile','-Command','[Diagnostics.Process]::GetCurrentProcess().SessionId'],{timeout:10000,windowsHide:true});result.desktopSessionId=Number(s.stdout.trim());check(result.desktopSessionId>0,'browser-session-zero');}
  phase='package-attestation';
  if(!job.transportOnly){const manifest=JSON.parse(await readFile(join(job.product,'distribution.json'),'utf8'));
  result.product={platform:manifest.platform,applicationSha256:sha(await readFile(join(job.product,'app/product-runtime.js')))};check(result.product.applicationSha256===job.applicationSha256,'browser-product-code-mismatch');}
  phase='Chrome-launch';
  browser=await chromium.launch({channel:'chrome',headless:false,args:['--ignore-certificate-errors-spki-list='+job.spki]});result.chromeVersion=browser.version();
  const context=await browser.newContext({viewport:{width:1440,height:1000}});page=await context.newPage();page.setDefaultTimeout(30000);
  if(job.certificate){const response=await context.request.get(job.endpoint+'/api/learning/context');check(response.status()===200,'browser-request-TLS-preflight-failed');result.requestTransport.httpStatus=response.status();}
  if(job.transportOnly){
    const response=await page.goto(job.endpoint);check(response.status()===200,'Chrome-HTTPS-preflight-failed');
    result.transport={httpStatus:response.status(),secureContext:await page.evaluate(()=>window.isSecureContext),scope:'TLS/Chrome infrastructure only; WP09 product not run'};
    check(result.transport.secureContext,'Chrome-not-secure-context');await captureJobEvidence(job,page,result,'transport-preflight');result.status='passed';return;
  }
  const pageErrors=[];page.on('pageerror',()=>pageErrors.push('browser-page-error'));result.loginHTTP=[];page.on('response',response=>{if(/\/api\/learning\/(login|context)$/.test(new URL(response.url()).pathname))result.loginHTTP.push({route:new URL(response.url()).pathname.split('/').at(-1),status:response.status()});});
  result.productHTTP=[];result.failedRequests=[];
  page.on('response',response=>{const route=new URL(response.url()).pathname;if(route.includes('/artifacts/')||route.endsWith('/conversation')){result.productHTTP.push({route,method:response.request().method(),status:response.status()});if(result.productHTTP.length>100)result.productHTTP.shift();}});
  page.on('requestfailed',request=>{const route=new URL(request.url()).pathname;if(route.startsWith('/api/learning/')){result.failedRequests.push({route,error:(request.failure()?.errorText??'failed').slice(0,100)});if(result.failedRequests.length>30)result.failedRequests.shift();}});
  result.workRequests=[];result.receiptQueries=[];
  page.on('request',request=>{const url=new URL(request.url());if(request.method()==='POST'&&/\/api\/learning\/workspaces\//.test(url.pathname)){try{const body=request.postDataJSON();result.workRequests.push({requestId:body.requestId,baseRevision:body.baseRevision,inputSha256:digest(body)});}catch{}}if(request.method()==='GET'&&url.pathname.includes('/receipts/'))result.receiptQueries.push(url.pathname.split('/').at(-1));});
  if(!job.readOnly&&!job.readOnlyView&&!job.standalone){let dropped=false;await context.route('**/api/learning/artifacts/*/adopt',async route=>{try{const response=await route.fetch();if(!dropped&&response.status()===200){dropped=true;result.lostAdoptAck={requestId:route.request().postDataJSON().requestId,status:'upstream-committed-response-replaced-with-commit-unknown'};await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'commit-unknown'})});}else await route.fulfill({response});}catch(error){result.status='failed';result.error='browser-route-fetch-failed';result.routeFetchError=safe(error);await save();await route.abort();}});}

  const api=(route,body)=>page.evaluate(async({route,body,space})=>{const response=await fetch('/api/learning/'+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json','x-xj-space':space,...(window.__wp09Namespace?{'x-xj-namespace':window.__wp09Namespace}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,value:await response.json()};},{route,body,space:job.space??'school'});
  async function login(endpoint){const previousPhase=phase;phase='student-login';result.loginPhase='navigation';await page.goto(endpoint+'/?space='+(job.space??'school'));if(job.space!=='personal'){result.loginPhase='form-ready';await page.getByLabel('学校账号',{exact:true}).waitFor({state:'visible'});await page.getByLabel('学校账号',{exact:true}).fill(job.student.loginName);await page.getByLabel('密码',{exact:true}).fill(job.student.password);result.loginPhase='submit';await page.getByRole('button',{name:'登录此学校',exact:true}).click();await page.getByLabel('学校账号',{exact:true}).waitFor({state:'hidden'});}const c=await api('context');await page.evaluate(v=>window.__wp09Namespace=v,c.value.clientNamespace);result.loginPhase='complete';phase=previousPhase;}
  async function open(){const b=page.getByRole('button',{name:/^(打开对话|问题与引用)$/});await b.waitFor();if(await b.getAttribute('aria-expanded')==='false')await b.click();}
  async function card(){const c=page.locator('.teaching-artifact-card').filter({has:page.locator('iframe')}).first();await c.waitFor();return {card:c,input:c.frameLocator('iframe').getByRole('textbox',{name:'我的解释',exact:true})};}
  async function snap(name){await captureJobEvidence(job,page,result,name,{path:job.screenshot?.replace(/\.png$/,'-'+name+'.png'),fullPage:true});}
  async function signal(expected){return until(async()=>{try{const v=JSON.parse(await readFile(job.signal,'utf8'));return v.phase===expected?v:null;}catch(e){if(e.code==='ENOENT')return null;throw e;}},'controller-signal-timeout',360000);}
  phase='student-login';await login(job.endpoint);await page.goto(job.endpoint+'/?space='+(job.space??'school')+'&activity='+job.activityId);await open();
  if(job.diagnosticOnly){phase='actual-checked-candidate';await delay(12000);await until(()=>result.diagnostic,'diagnostic-not-collected',15000);await save();result.status='diagnosed';return;}
  if(job.standalone){
    phase='local-Windows-generated-artifact';let c=await card();await expect(c.input).toBeEditable({timeout:90000});await c.input.fill(job.expected);await page.getByRole('textbox',{name:'你的问题',exact:true}).focus();
    await until(async()=>{const w=(await api('workspaces/'+job.activityId)).value;return w.files.some(f=>f.value.includes(job.expected));},'local-Windows-state-not-durable');
    await page.reload();await open();c=await card();await expect(c.input).toHaveValue(job.expected);await snap('windows-local-reopened');
    await c.card.getByRole('button',{name:'收纳',exact:true}).click();await c.card.getByRole('button',{name:'在工具区打开',exact:true}).click();await expect(page.locator('.teaching-artifact-center').frameLocator('iframe').getByRole('textbox',{name:'我的解释'})).toHaveValue(job.expected);await snap('windows-local-center');
    result.checks.push('actual-Windows-local-product-Agent-Chrome-check-adopt-save-refresh-shelf');result.status='passed';
  }else if(job.readOnly||job.readOnlyView){const c=await card();await expect(c.input).toHaveValue(job.expected);if(job.readOnly)await expect(c.input).toBeDisabled();if(job.takeoverView)await expect(c.input).toBeEditable();await snap(job.readOnly?'isolated-read-only':job.takeoverView?'takeover':'mac-reopened');result.checks.push(job.readOnly?'restored-artifact-input-disabled':job.takeoverView?'formal-takeover-same-artifact-state-editable':'second-machine-Chrome-same-fixed-state');result.status='passed';}
  else{
   let c;
   if(job.resume){
    result.artifactId=job.artifactId;result.firstRevisionId=job.originalRevisionId;
    phase='compatible-revision';
    await until(async()=>{const a=(await api('artifacts/'+job.activityId)).value.find(a=>a.artifactId===job.artifactId);return a?.activeRevisionId===job.revisionId?a:null;},'retained-revision-not-adopted',180000);
    c=await card();await expect(c.input).toHaveValue(job.expected);result.checks.push('same-original-generation-and-revision-reopened-with-Chinese-input');
   }else{
   phase='actual-checked-candidate';c=await card();await expect(c.input).toBeEditable({timeout:120000});
   const artifacts=(await api('artifacts/'+job.activityId)).value;check(artifacts.length===1&&artifacts[0].activeRevisionId,'actual-browser-did-not-adopt');result.artifactId=artifacts[0].artifactId;result.firstRevisionId=artifacts[0].activeRevisionId;
   await c.input.fill(job.expected);await page.getByRole('textbox',{name:'你的问题',exact:true}).focus();
   await until(async()=>{const w=(await api('workspaces/'+job.activityId)).value;const f=w.files.find(f=>f.name==='components/artifact-'+result.artifactId+'.json');return f&&JSON.parse(f.value).content.explanation===job.expected?{workRevision:w.revision,contentId:f.contentId}:null;},'student-input-not-durable');
   check(result.lostAdoptAck&&result.receiptQueries.includes(result.lostAdoptAck.requestId),'lost-adopt-ack-not-reconciled-by-original-ID');result.checks.push('cross-HTTPS-adopt-ack-loss-queries-original-receipt');
   result.firstState=(await api('workspaces/'+job.activityId)).value.files.map(f=>({contentId:f.contentId,objectId:f.objectId}));await snap('first-adopted');result.status='awaiting-revision';await save();
   await signal('revision');phase='compatible-revision';await until(async()=>{const a=(await api('artifacts/'+job.activityId)).value.find(a=>a.artifactId===result.artifactId);return a.activeRevisionId!==result.firstRevisionId?a:null;},'revision-not-adopted',240000);
   c=await card();await expect(c.input).toHaveValue(job.expected);await page.reload();await open();c=await card();await expect(c.input).toHaveValue(job.expected);result.checks.push('actual-Chrome-check-adopt-and-compatible-revision-retains-Chinese-input');
   }
   await snap('revised');
   const shelf=c.card.getByRole('button',{name:'收纳',exact:true});if(await shelf.count())await shelf.click();await c.card.getByRole('button',{name:'在工具区打开',exact:true}).click();await expect(page.locator('.teaching-artifact-center').frameLocator('iframe').getByRole('textbox',{name:'我的解释'})).toHaveValue(job.expected);await snap('center-reopened');await page.locator('.teaching-artifact-center').getByRole('button',{name:'关闭页面',exact:true}).click();result.checks.push('shelf-center-close-retains-state');
   phase='browser-offline-edit';c=await card();await expect(c.input).toBeEditable();await expect(c.input).toHaveValue(job.expected);await context.setOffline(true);await c.input.fill(job.expected+'（断线时补充）');await delay(1200);await context.setOffline(false);await page.getByRole('textbox',{name:'你的问题',exact:true}).focus();job.expected+='（断线时补充）';
   await until(async()=>{const w=(await api('workspaces/'+job.activityId)).value;return w.files.some(f=>f.value.includes(job.expected));},'offline-input-did-not-reconcile');result.explanationSha256=sha(job.expected);result.checks.push('actual-browser-offline-input-reconciled');result.status='awaiting-restart';await save();
   await signal('restart');phase='owner-restart';await page.reload();await open();c=await card();await expect(c.input).toHaveValue(job.expected);result.checks.push('both-owner-restart-same-input');await snap('after-restart');result.status='awaiting-isolated';await save();
   const isolated=await signal('isolated');phase='isolated-read-only';await login(isolated.endpoint);await page.goto(isolated.endpoint+'/?space=school&activity='+job.activityId);await open();c=await card();await expect(c.input).toHaveValue(job.expected);await expect(c.input).toBeDisabled();result.checks.push('associated-backup-isolated-artifact-state-read-only');await snap('isolated');result.status='awaiting-takeover';await save();
   const active=await signal('takeover');phase='takeover';await login(active.endpoint);await page.goto(active.endpoint+'/?space=school&activity='+job.activityId);await open();c=await card();await expect(c.input).toHaveValue(job.expected);await expect(c.input).toBeEditable();await snap('takeover');result.checks.push('formal-takeover-same-artifact-state-editable');result.status='passed';
  }
  result.pageErrors=pageErrors;check(pageErrors.length===0,'browser-page-error');
 }catch(e){result.status='failed';result.error=safe(e);result.phase=phase;await save();if(page&&phase==='student-login'){result.loginUI={labels:await page.locator('label').allTextContents().catch(()=>[]),buttons:await page.getByRole('button').allTextContents().catch(()=>[])};}if(page&&phase!=='student-login'){await captureJobEvidence(job,page,result,'failure-'+phase,{fullPage:true,timeout:7000}).catch(()=>{});}}
 finally{clearInterval(heartbeat);await save();await Promise.race([browser?.close().catch(()=>{}),delay(7000)]);await writes;result.finishedAt=new Date().toISOString();await save();}
}

export async function runArtifactsCase(c){
 if(c.args['artifacts-windows-local-only']){c.report.scope='Windows standalone local product only; two-host pairing is infrastructure, not a cross-artifact acceptance claim';return runWindowsLocalCase(c);}
 const {args,pkg,runtime,root,state,windows,remote,relay,schoolApi,identity,data,agentTarget,stage,report}=c;
 const captureEvidence=!args['no-evidence'];
 const evidence=dirname(resolve(args.out)),windowsEvidence=resolve(evidence,'../windows');if(captureEvidence)await mkdir(windowsEvidence,{recursive:true});
 const output=c.resume?{...structuredClone(c.resume.artifacts),priorBrowser:structuredClone(c.resume.artifacts.windows),screenshots:captureEvidence?[...c.resume.artifacts.screenshots]:[],cleanup:{},resumed:true}
  :{modelSource:args['artifacts-model']==='controlled'?'controlled external Chat transport':'real DeepSeek chat-completions',originals:[],screenshots:[],cleanup:{}};
 const spki=createHash('sha256').update(new X509Certificate(await readFile(args.certificate)).publicKey.export({type:'spki',format:'der'})).digest('base64');
 let directory,taskName,taskRegistered=false,releaseWindows,releaseMac,sourceHost=c.host,targetHost,targetRuntime,targetRoot,recovered,macIngress,sourceHostStopped=false,casePassed=false;
 const ps=(script,input)=>windowsControl(args.ssh,script,input);
 const readRemote=async path=>{const s=await ps(`if(Test-Path -LiteralPath ${q(path)}){[IO.File]::ReadAllText(${q(path)})}`);return s?JSON.parse(s):null;};
 const recordSource=async(runId,requestId,activity)=>{
  const conversation=await schoolApi(`agent/${activity.activityId}/conversation`),tools=conversation.tools.filter(t=>t.runId===runId);
  const generated=tools.filter(t=>t.name==='generate_teaching_artifact'&&t.outcome==='completed');check(generated.length===1,'one-artifact-generation-per-request-required');
  const receipt=generated[0].result?.artifact;check(receipt?.candidateId&&receipt.requestId===generated[0].commandId,'original-publish-receipt-missing');
  const fixed=await schoolApi(`artifacts/${activity.activityId}/${receipt.artifactId}/revisions/${receipt.revisionId}`);
  check(fixed.origin.runId===runId&&fixed.origin.commandId===receipt.requestId&&fixed.origin.snapshotId&&fixed.origin.attemptId,'run-origin-not-retained');
  const snapshot=await schoolApi(`agent/${activity.activityId}/snapshots/${fixed.origin.snapshotId}`);
  check(digest(snapshot.payload)===snapshot.payloadSha256&&relay.requests.some(r=>r.payloadSha256===snapshot.payloadSha256),'actual-transport-snapshot-not-matched');
  const original={requestId,runId,artifactId:receipt.artifactId,revisionId:receipt.revisionId,candidateId:receipt.candidateId,commandId:receipt.requestId,
   snapshotId:fixed.origin.snapshotId,stepId:fixed.origin.stepId,attemptId:fixed.origin.attemptId,segmentId:fixed.origin.segmentId,resourceSha256:fixed.sha256,payloadSha256:snapshot.payloadSha256};
  output.originals.push(original);await c.persist();return {receipt,fixed,original};
 };
 const run=async(activity,question)=>{
  const cap=await schoolApi(`agent/${activity.activityId}/capabilities`);check(cap.receiver.receiverId==='teaching-agent:'+agentTarget.serviceId,'wrong-Agent-owner');
  const requestId=randomUUID(),head=await schoolApi('workspaces/'+activity.activityId);
  const input={requestId,scope:{environmentId:identity.environmentId,spaceId:identity.spaceId,principalId:identity.principalId,activityId:activity.activityId},receiver:cap.receiver,
   draft:{token:randomUUID(),question,references:[],bases:[]},works:head.files,evidence:[]};
  await schoolApi('intents/'+activity.activityId,input);const accepted=await schoolApi(`intents/${activity.activityId}/${requestId}/dispatch`,{});check(accepted.state==='accepted','cross-input-not-accepted');const runId=JSON.parse(accepted.receipt.detail).runId;
  await c.until(async()=>{const value=await schoolApi(`agent/${activity.activityId}/conversation`),r=value.runs.find(r=>r.runId===runId);if(r&&['failed','stopped','paused','waiting'].includes(r.state)){output.failedRun={runId,state:r.state,reason:typeof r.reason==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(r.reason)?r.reason:'unclassified'};throw Object.assign(new Error(),{code:'cross-run-'+r.state});}return r?.state==='completed';},'cross-generation-timeout',300000);
  return recordSource(runId,requestId,activity);
 };
 const waitJob=async(status)=>c.until(async()=>{const value=await readRemote(directory+'/result.json');if(value?.status==='failed'){output.windows=value;throw Object.assign(new Error(),{code:value.error});}return value?.status===status?value:null;},'windows-artifact-phase-timeout',300000);
 const signal=(phase,extra={})=>ps(`[IO.File]::WriteAllText(${q(directory+'/signal.json')},[Console]::In.ReadToEnd(),[Text.UTF8Encoding]::new($false))`,JSON.stringify({phase,...extra}));
 async function macView(endpoint,activityId,expected,readOnly=false){
  const local=await mkdtemp(join(tmpdir(),'xj-wp09-mac-chrome-'));try{
   const job={captureEvidence,endpoint,student:{loginName:c.loginName,password:c.password},activityId,expected,readOnly,readOnlyView:!readOnly,spki,certificate:args.certificate,
    product:pkg.root,applicationSha256:pkg.fact.applicationSha256,playwright:resolve('apps/web/package.json'),result:join(local,'result.json'),screenshot:captureEvidence?join(local,'screen.png'):undefined};
   const path=join(local,'job.json');await atomic(path,job);await artifactChromeJob(path);const result=JSON.parse(await readFile(job.result,'utf8'));
   if(captureEvidence)for(const screenshot of result.screenshots){const path=join(evidence,'mac-'+screenshot.name+'.png');await writeFile(path,await readFile(screenshot.path));output.screenshots.push({platform:'darwin',path,sha256:screenshot.sha256});}
   check(result.status==='passed','mac-Chrome-artifact-verification-failed');return {chromeVersion:result.chromeVersion,checks:result.checks,applicationSha256:result.product.applicationSha256};
  }finally{await rm(local,{recursive:true,force:true});}
 }
 try{
  const activity=c.resume?await schoolApi('activities/'+output.activityId):await schoolApi('activities',{requestId:randomUUID(),goal:'跨机器理解二进制位宽',question:'',references:[]});output.activityId=activity.activityId;
  report.artifacts=output;
  const retained=async original=>({original,receipt:await schoolApi(`artifacts/${activity.activityId}/receipts/${original.commandId}`),fixed:await schoolApi(`artifacts/${activity.activityId}/${original.artifactId}/revisions/${original.revisionId}`)});
  let generated,revised;
  if(c.resume){
   check(output.originals.length===2,'two-original-generations-required-for-recovery');
   generated=await retained(output.originals[0]);revised=await retained(output.originals[1]);
   check(revised.receipt.artifactId===generated.receipt.artifactId&&revised.fixed.parentRevisionId===generated.fixed.revisionId,'retained-revision-left-original-artifact');
   output.resumeFacts={requestIds:output.originals.map(x=>x.requestId),revisionIds:output.originals.map(x=>x.revisionId),newGenerations:0};
  }else await stage('Win-Agent-generates-fixed-candidate-at-Mac-owner',async()=>{generated=await run(activity,
   `请实际调用一次 generate_teaching_artifact 制作小型中文二进制位宽教学示意卡。不要在对话粘贴代码。页面只有一段说明和 aria-label="我的解释" 的textarea。
唯一状态 explanation:string(maxLength=1000)，initialState={explanation:''}，stateVersion=1；semanticFields=[{key:'explanation',meaning:'${meaning}'}]，semanticObjects=[]；requiredCapabilities=['workspace.read','workspace.change']。
脚本写javascript async IIFE，先 await window.xunjie.read() 恢复textarea.value，再input事件调用 window.xunjie.change({explanation:textarea.value}) 并处理Promise失败。html仅正文无script/on*，css独立。只生成一次，不ask/discover/load/实验，成功后一句话结束。`);return generated.original;});
  const {acquireNativeDesktop}=await import('./native-desktop-lock.mjs');
  releaseWindows=await c.until(async()=>{try{return await acquireNativeDesktop('windows',args['artifacts-session'],'WP09 real two-host artifacts and isolated recovery');}catch(e){if(e.message.startsWith('Desktop lock is held;'))return null;throw e;}},'Windows-desktop-owned',15*60*1000);
  directory=args['remote-script'].replaceAll('\\','/').replace(/\/[^/]+$/,'')+'/artifact-chrome'+(c.resume?'-resume-'+randomUUID():'');await ps(`New-Item -ItemType Directory -Path ${q(directory)}|Out-Null`);
  taskName='XunJie-WP09-Artifact-'+randomUUID();
  const head=c.resume?await schoolApi('workspaces/'+activity.activityId):null;
  const expected=c.resume?JSON.parse(head.files.find(f=>f.name==='components/artifact-'+generated.receipt.artifactId+'.json').value).content.explanation:'位宽增加一位，组合数加倍；这是我的中文解释。';
  const job={captureEvidence,endpoint:state.endpoint,student:{loginName:c.loginName,password:c.password},activityId:activity.activityId,expected,spki,certificate:args['remote-certificate'],product:args['remote-product'],applicationSha256:windows.package.applicationSha256,
   ...(c.resume?{resume:true,artifactId:generated.receipt.artifactId,originalRevisionId:generated.receipt.revisionId,revisionId:revised.receipt.revisionId}:{}),
   playwright:'C:/Users/h/XunJie-acceptance/package.json',result:directory+'/result.json',screenshot:captureEvidence?directory+'/result.png':undefined,signal:directory+'/signal.json'};
  await stage(c.resume?'Windows-same-original-revision-and-offline-input-resume':'Windows-Interactive-Limited-Chrome-check-adopt-save',async()=>{
   const browserScript=args['remote-script'].replace(/probe-teaching-assembly-cross\.mjs$/,'probe-wp09-cross.mjs');
   const launch='"'+browserScript+'" --chrome-job "'+directory+'/job.json"';
   await ps(`[IO.File]::WriteAllText(${q(directory+'/job.json')},[Console]::In.ReadToEnd(),[Text.UTF8Encoding]::new($false));$a=New-ScheduledTaskAction -Execute ${q(args['remote-product']+'/resources/node/node.exe')} -Argument ${q(launch)};$p=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 12);Register-ScheduledTask -TaskName ${q(taskName)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${q(taskName)}`,JSON.stringify(job));taskRegistered=true;
   output.windows=await waitJob(c.resume?'awaiting-restart':'awaiting-revision');return {artifactId:output.windows.artifactId,firstRevisionId:output.windows.firstRevisionId,chromeVersion:output.windows.chromeVersion,desktopSessionId:output.windows.desktopSessionId};
  });
  if(!c.resume)await stage('Win-Agent-revises-original-and-Chrome-retains-input',async()=>{
   await signal('revision');const value=await run(activity,
    `请先调用 read_teaching_artifact，再调用一次 generate_teaching_artifact 修订固定产物。artifactId=${generated.receipt.artifactId},parentRevisionId=${generated.receipt.revisionId}。
只在原HTML补一句“补充：增加一位可表示的组合数加倍，仍是教学示意。”。保留textarea与SDK逻辑、stateVersion/stateShape/initialState/semanticFields字段名/类型/上限/含义完全不变，mapping=[]，不修改学生explanation。只读一次、生成一次，不ask其他工具，成功后一句话结束。`);
   check(value.receipt.artifactId===generated.receipt.artifactId&&value.fixed.parentRevisionId===generated.receipt.revisionId,'revision-left-original-artifact');output.windows=await waitJob('awaiting-restart');revised=value;return value.original;
  });
  const finalExpected=expected+'（断线时补充）',before=await schoolApi('workspaces/'+activity.activityId);
  check(before.files.some(f=>JSON.parse(f.value).content.explanation===finalExpected),'latest-input-not-on-Mac-owner');output.state={workRevision:before.revision,files:before.files.map(f=>({objectId:f.objectId,contentId:f.contentId,sha256:sha(f.value)}))};
  await stage('disconnect-original-Windows-owner-query-reconnect-and-restart-both',async()=>{
   const requestPath=`agent/${activity.activityId}/requests/${generated.original.requestId}`,originalReceipt=await schoolApi(requestPath),requests=relay.requests.length;
   await remote.call('offline');const denied=await c.requestApi(state.endpoint,requestPath,undefined,c.headers);check(denied.status>=400,'disconnected-Agent-did-not-fail');
   const online=await remote.call('online');check(online.environmentId===windows.environmentId&&online.installationId===windows.installationId,'reconnect-replaced-Agent');assert.deepEqual(await schoolApi(requestPath),originalReceipt);
   await remote.call('restart');await sourceHost.stop();if(sourceHost===c.host)output.cleanup.originalMacHostStopped=true;sourceHost=await pkg.module.createProductRuntimeHost({root,createApplication:context=>{context.configuration.resources.webRoot=pkg.resources.webRoot;return pkg.module.createProductLearningApplication(context);}});
   assert.deepEqual(await schoolApi(requestPath),originalReceipt);assert.deepEqual(await schoolApi('workspaces/'+activity.activityId),before);check(relay.requests.length===requests,'restart-issued-model-request');
   await signal('restart');output.windows=await waitJob('awaiting-isolated');return {requestId:generated.original.requestId,runId:generated.original.runId,disconnectHttpStatus:denied.status,reconnectSameInstallation:true,newModelRequests:0};
  });
  releaseMac=await c.until(async()=>{try{return await acquireNativeDesktop('macos',args['artifacts-session'],'WP09 Mac Chrome second-machine fixed artifact state');}catch(e){if(e.message.startsWith('Desktop lock is held;'))return null;throw e;}},'Mac-desktop-owned',15*60*1000);
  output.macBrowser=await stage('Mac-Chrome-school-page-reopens-same-fixed-artifact',()=>macView(state.endpoint,activity.activityId,finalExpected));await releaseMac();releaseMac=null;
  const callsBeforeRecovery=relay.requests.length;const recoveryDirectory=await mkdtemp(join(tmpdir(),'xj-wp09-associated-recovery-'));output.privateRecoveryDirectory=recoveryDirectory;
  const key=randomBytes(32);let windowsBackup,macBackup;
  await stage('associated-real-backups-pin-both-owners-and-resources',async()=>{
   windowsBackup=await remote.call('artifact.backup',{key:key.toString('base64')});const keyRef='wp09-associated-recovery-'+randomUUID();await runtime.setCredential(keyRef,key.toString('base64'));
   macBackup=await runtime.recovery.backup({directory:join(recoveryDirectory,'mac-backups'),recoveryKeyRef:keyRef,leaveClosed:true});
   const archive=join(recoveryDirectory,'windows-backup.tgz');await exec('scp',['-q',args.ssh+':'+windowsBackup.archive.replaceAll('\\','/'),archive],{timeout:120000});await exec('tar',['-xzf',archive,'-C',recoveryDirectory]);
   const set=await pkg.module.sealRecoverySet({directory:join(recoveryDirectory,'associated-set'),key,members:[{installationId:state.environment.installationId,environmentId:state.environment.environmentId,backupDirectory:join(recoveryDirectory,'mac-backups',macBackup.backupId)},
    {installationId:windows.installationId,environmentId:windows.environmentId,backupDirectory:join(recoveryDirectory,windowsBackup.backupId)}]});
   const verified=await pkg.module.verifyRecoverySet(join(recoveryDirectory,'associated-set'),key);check(verified.members.length===2,'both-backup-members-required');
   output.recovery={setId:set.setId,members:set.members.map(m=>({backupId:m.backupId,environmentId:m.environmentId,installationId:m.installationId,manifestSha256:m.manifestSha256,services:m.services}))};return output.recovery;
  });
  let isolatedWindows,isolatedMac;
  await stage('isolated-restores-have-original-facts-and-zero-generation',async()=>{
   isolatedWindows=await remote.call('artifact.restore',{key:key.toString('base64')});targetRoot=join(recoveryDirectory,'restored-mac');
   recovered=await pkg.module.restoreProductRecovery({root:targetRoot,resources:pkg.resources,backupDirectory:join(recoveryDirectory,'mac-backups',macBackup.backupId),key,
    installation:{profile:'school',host:'0.0.0.0',port:Number(args['mac-port'])+2,publicEndpoint:`https://${args['mac-host']}:${Number(args['mac-port'])+2}`,tls:{certificateFile:resolve(args.certificate),keyFile:resolve(args.key)}}});
   const facts=[];for(const owner of recovered.owners){const material=await owner.material({backupId:macBackup.backupId,boundaryAt:macBackup.boundaryAt,signal:new AbortController().signal});for(const fact of material.sources?.entries??[])if(fact.kind.startsWith('teaching_artifact')||fact.kind==='work_versions')facts.push({kind:fact.kind,fixedId:fact.fixedId,digest:fact.digest,resources:fact.resources});await owner.close?.();}recovered=null;
   check(facts.some(f=>f.kind==='teaching_artifact_revisions')&&facts.some(f=>f.kind==='teaching_artifact_checks')&&facts.some(f=>f.kind==='teaching_artifact_receipts'),'new-artifact-closure-not-restored');
   targetRuntime=pkg.module.openProductRuntime({root:targetRoot,resources:pkg.resources});targetHost=await pkg.module.createProductRuntimeHost({root:targetRoot,createApplication:pkg.module.createProductLearningApplication});isolatedMac=await targetRuntime.status();check(isolatedMac.state==='maintenance'&&isolatedWindows.state==='maintenance','restored-owners-not-isolated');
   output.recovery.isolated={mac:{environmentId:isolatedMac.environment.environmentId,installationId:isolatedMac.environment.installationId,facts},windows:isolatedWindows};
   await signal('isolated',{endpoint:isolatedMac.endpoint});output.windows=await waitJob('awaiting-takeover');check(relay.requests.length===callsBeforeRecovery,'restore-generated-model-call');return {macState:isolatedMac.state,windowsState:isolatedWindows.state,fixedArtifactEntries:facts.length,newModelRequests:0};
  });
  await stage('formal-two-owner-takeover-fences-old-installations-and-repairs-grants',async()=>{
   const windowsReceiver=`${windows.environmentId}/${agentTarget.serviceId}`;
   const receivers=macBackup.receiverIds.map(id=>({id,async fence(source,serviceIds,binding){check(id===windowsReceiver,'unexpected-Mac-backup-receiver');const proof=await remote.call('artifact.fence',{fence:{sourceEnvironmentId:source.environmentId,sourceServiceId:serviceIds[0],sourceServiceIds:[...serviceIds],sourceInstallationId:source.installationId,...binding}});check(proof.sourceEnvironmentId===source.environmentId&&proof.sourceInstallationId===source.installationId,'remote-fence-source-mismatch');return {fenced:true,...binding,receiverId:id,sourceEnvironmentId:source.environmentId,sourceInstallationId:source.installationId,sourceServiceIds:[...serviceIds],execution:proof.execution};}}));
   await targetHost.recovery.takeover({source:{retire:binding=>runtime.recovery.retire(binding)},receivers});
   await sourceHost.stop();sourceHostStopped=true;macIngress=await stableTlsIngress({certificate:args.certificate,key:args.key,port:Number(args['mac-port']),target:isolatedMac.endpoint});

   // The receiver proof covers every real source service, including its client descriptor.
   const ids=(await remote.call('artifact.metadata')).serviceIds.sort();const proof=await targetRuntime.recovery.fenceSource({sourceEnvironmentId:windows.environmentId,sourceServiceId:ids[0],sourceServiceIds:ids,sourceInstallationId:windows.installationId,backupId:windowsBackup.backupId,targetInstallationId:isolatedWindows.installationId});
   await remote.call('artifact.takeover',{proof:{fenced:true,receiverId:`${data.environmentId}/${data.serviceId}`,sourceEnvironmentId:windows.environmentId,sourceInstallationId:windows.installationId,sourceServiceIds:ids,backupId:windowsBackup.backupId,targetInstallationId:isolatedWindows.installationId,execution:proof.execution}});
   const macIds=state.environment.services.map(s=>s.serviceId).sort();await remote.call('artifact.fence-active',{fence:{sourceEnvironmentId:state.environment.environmentId,sourceServiceId:macIds[0],sourceServiceIds:macIds,sourceInstallationId:state.environment.installationId,backupId:macBackup.backupId,targetInstallationId:isolatedMac.environment.installationId}});
   output.recovery.ingress={mac:{sourceStopped:true,stableEndpoint:state.endpoint,successorNativeEndpoint:isolatedMac.endpoint},windows:await remote.call('artifact.switch-ingress'),transport:'stable direct LAN TLS ingress to the real successor native listener; no SSH tunnel'};
   const newData=data,newAgent=isolatedWindows.target;
   const accept=await remote.call('artifact.authorize',{source:{sourceEnvironmentId:data.environmentId,sourceServiceId:data.serviceId,sourceInstallationId:isolatedMac.environment.installationId},targetServiceId:agentTarget.serviceId});
   const installed=JSON.parse(await readFile(join(root,'installation.json'),'utf8'));const inbound=installed.connections.find(x=>x.requiredCapabilities.includes('teaching.agent'));check(inbound,'original-Agent-connection-not-found');
   check(inbound.target.environmentId===newAgent.environmentId&&inbound.target.serviceId===newAgent.serviceId,'restored-Agent-owner-changed');
   const targetConfig=JSON.parse(await readFile(join(targetRoot,'installation.json'),'utf8'));
   await targetRuntime[targetConfig.connections.some(c=>c.connectionId===inbound.connectionId)?'reconnect':'connect']({...inbound,credentialRef:'wp09-restored-agent'},accept.token);
   const dependency=await targetRuntime.authorize({sourceEnvironmentId:agentTarget.environmentId,sourceServiceId:agentTarget.serviceId,sourceInstallationId:isolatedWindows.installationId,capabilities:['teaching.dependencies']},data.serviceId);
   await remote.call('artifact.connect',{connection:{...c.dependencyConnection,target:newData,credentialRef:'wp09-restored-dependencies'},token:dependency.token});
   const login=await c.api(isolatedMac.endpoint,'login',{loginName:c.loginName,password:c.password});const ns=(await c.api(isolatedMac.endpoint,'context',undefined,{cookie:login.cookie})).value.clientNamespace;
   const actor={cookie:login.cookie,'x-xj-space':'school','x-xj-namespace':ns};const read=async r=>(await c.api(isolatedMac.endpoint,r,undefined,actor)).value;
   assert.deepEqual(await read('workspaces/'+activity.activityId),before);const fixed=await read(`artifacts/${activity.activityId}/${revised.receipt.artifactId}/revisions/${revised.receipt.revisionId}`);assert.deepEqual(fixed,revised.fixed);
   const conversation=await read('agent/'+activity.activityId+'/conversation');check(conversation.runs.some(r=>r.runId===generated.original.runId)&&conversation.runs.some(r=>r.runId===revised.original.runId),'new-Agent-lost-original-run-ids');
   const old=await c.requestApi(state.endpoint,'artifacts/'+activity.activityId+'/shelf',{requestId:randomUUID(),artifactId:generated.receipt.artifactId,shelved:false},c.headers);check(old.status===403,'old-browser-namespace-not-refused');
   let retiredMac=false;try{await runtime.connect({...inbound,connectionId:randomUUID(),credentialRef:'wp09-retired-source-must-refuse'},accept.token);}catch(error){retiredMac=error.code==='source-retired';}check(retiredMac,'old-Mac-installation-can-still-configure-dispatch');
   const retiredWindows=await remote.call('artifact.assert-retired',{connection:c.dependencyConnection,token:dependency.token});check(retiredWindows.rejected&&retiredWindows.code==='source-retired','old-Windows-installation-can-still-configure-dispatch');

   await signal('takeover',{endpoint:isolatedMac.endpoint});output.windows=await waitJob('passed');check(relay.requests.length===callsBeforeRecovery,'takeover-replayed-model');output.recovery.takeover={macInstallationId:isolatedMac.environment.installationId,windowsInstallationId:isolatedWindows.installationId,retiredMac,retiredWindows,oldMacHttpStatus:old.status,runIds:conversation.runs.map(r=>r.runId),newModelRequests:0};return output.recovery.takeover;
  });
  if(!args['artifacts-skip-windows-local'])await stage('Windows-standalone-local-product-generated-page-and-reload',async()=>{output.windowsLocal=await runWindowsLocalCase(c,{desktopHeld:true});return {status:output.windowsLocal.status,modelSource:'controlled Chat SSE; no provider key on Windows'};});
  output.windowsStatus='passed';casePassed=true;return output;
 }finally{
  if(directory){
   try{const result=await readRemote(directory+'/result.json');if(result)output.windows=result;if(captureEvidence)for(const shot of [...(result?.screenshots??[]),...(output.windowsLocal?.browser?.screenshots??[])]){const encoded=await ps(`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${q(shot.path)}))`);const path=join(windowsEvidence,'cross-'+shot.name+'.png');const bytes=Buffer.from(encoded,'base64');check(sha(bytes)===shot.sha256,'remote-screenshot-checksum-mismatch');await writeFile(path,bytes);output.screenshots.push({platform:'win32',path,sha256:shot.sha256});}
    if(result&&!['passed','failed'].includes(result.status)&&Number.isInteger(result.workerProcessId))await ps(`$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${result.workerProcessId}';if($p -and $p.CommandLine.Contains(${q(directory)})){taskkill.exe /PID ${result.workerProcessId} /T /F|Out-Null}`);
    if(taskRegistered)await ps(`Stop-ScheduledTask -TaskName ${q(taskName)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName ${q(taskName)} -Confirm:$false -ErrorAction SilentlyContinue`);output.cleanup.windowsTaskRemoved=true;
   }catch(e){output.cleanup.windowsError=safe(e);}
  }
  await releaseWindows?.();await releaseMac?.();output.cleanup.desktopLocksReleased=true;
  for(const owner of recovered?.owners??[])await owner.close?.();await macIngress?.close();await targetHost?.stop();if(targetRuntime)output.cleanup.restoredMac=await c.pkg.module.openProductRuntime({root:targetRoot,resources:pkg.resources}).stop().then(()=>({stopped:true}));
  if(sourceHost!==c.host&&!sourceHostStopped){try{await sourceHost.stop();}catch(e){output.cleanup.sourceMacStopError=safe(e);}}
  if(output.privateRecoveryDirectory&&casePassed){if(targetRuntime){try{await targetRuntime.deleteEnvironment({environmentId:(await targetRuntime.status()).environment.environmentId});}catch(e){output.cleanup.restoredMacError=safe(e);}}if(!output.cleanup.restoredMacError){await rm(output.privateRecoveryDirectory,{recursive:true,force:true,maxRetries:5,retryDelay:200});output.cleanup.privateRecoveryRootsRemoved=true;}delete output.privateRecoveryDirectory;}
  report.artifacts=output;await c.persist();
 }
}

export async function runWindowsLocalCase(c,{desktopHeld=false}={}){
 const captureEvidence=!c.args['no-evidence'];
 const {args,remote,pkg,windows}=c,ps=(source,input)=>windowsControl(args.ssh,source,input);
 const directory=args['remote-script'].replace(/\/[^/]+$/,'')+'/local-Chrome-'+randomUUID(),evidence=resolve(dirname(args.out),'../windows');if(captureEvidence)await mkdir(evidence,{recursive:true});
 const output={status:'running',scope:'Windows standalone actual final product; controlled external Chat SSE transport',cleanup:{},screenshots:[]};c.report.windowsStandalone=output;let releaseDesktop,registered=false,taskName,result;
 try{
  if(!desktopHeld){const {acquireNativeDesktop}=await import('./native-desktop-lock.mjs');releaseDesktop=await c.until(async()=>{try{return await acquireNativeDesktop('windows',args['artifacts-session'],'WP09 standalone Windows product Chrome');}catch(e){if(e.message.startsWith('Desktop lock is held;'))return null;throw e;}},'Windows-desktop-owned',900000);}
  const setup=await remote.call('artifact.local-setup');output.product={...windows.package};output.setup=setup;
  await ps(`New-Item -ItemType Directory -Path ${q(directory)}|Out-Null`);
  const spki=createHash('sha256').update(new X509Certificate(await readFile(args.certificate)).publicKey.export({type:'spki',format:'der'})).digest('base64');
  const job={captureEvidence,endpoint:setup.endpoint,activityId:setup.activityId,space:'personal',standalone:true,expected:'Windows 本机重开后保留的中文解释。',spki,certificate:args['remote-certificate'],product:args['remote-product'],applicationSha256:windows.package.applicationSha256,playwright:'C:/Users/h/XunJie-acceptance/package.json',result:directory+'/result.json',screenshot:captureEvidence?directory+'/screen.png':undefined};
  taskName='XunJie-WP09-Local-'+randomUUID();const script=args['remote-script'].replace(/probe-teaching-assembly-cross\.mjs$/,'probe-wp09-cross.mjs'),launch='"'+script+'" --chrome-job "'+directory+'/job.json"';
  await ps(`[IO.File]::WriteAllText(${q(directory+'/job.json')},[Console]::In.ReadToEnd(),[Text.UTF8Encoding]::new($false));$a=New-ScheduledTaskAction -Execute ${q(args['remote-product']+'/resources/node/node.exe')} -Argument ${q(launch)};$p=New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 4);Register-ScheduledTask -TaskName ${q(taskName)} -Action $a -Principal $p -Settings $s|Out-Null;Start-ScheduledTask -TaskName ${q(taskName)}`,JSON.stringify(job));registered=true;
  result=await c.until(async()=>{const text=await ps(`if(Test-Path -LiteralPath ${q(job.result)}){[IO.File]::ReadAllText(${q(job.result)})}`);const value=text?JSON.parse(text):null;if(value?.status==='failed'){output.browser=value;throw Object.assign(new Error(),{code:value.error});}return value?.status==='passed'?value:null;},'Windows-local-Chrome-timeout',180000);output.browser=result;
  if(captureEvidence)for(const shot of result.screenshots){const bytes=Buffer.from(await ps(`[Convert]::ToBase64String([IO.File]::ReadAllBytes(${q(shot.path)}))`),'base64');check(sha(bytes)===shot.sha256,'Windows-local-screenshot-digest-mismatch');const path=join(evidence,shot.name+'.png');await writeFile(path,bytes);output.screenshots.push({path,sha256:shot.sha256});}
  output.status='passed';return output;
 }finally{
  if(registered)await ps(`Stop-ScheduledTask -TaskName ${q(taskName)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName ${q(taskName)} -Confirm:$false -ErrorAction SilentlyContinue`);output.cleanup.taskRemoved=true;await releaseDesktop?.();output.cleanup.desktopReleased=!desktopHeld;await c.persist();
 }
}
