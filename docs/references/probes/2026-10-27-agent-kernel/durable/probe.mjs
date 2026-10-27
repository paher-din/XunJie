// Isolated research probe. Dependencies are loaded from PROBE_DEPS, never from the app.
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { nativeFixture, toolCallId, toolName, toolInput } from '../fixtures.mjs';
import assert from 'node:assert/strict';
const deps = process.env.PROBE_DEPS;
if (!deps) throw Error('Set PROBE_DEPS to temporary npm prefix');
const pkg = (name, file) => import(pathToFileURL(join(deps, 'node_modules/@earendil-works', name, 'dist', file)).href);
const D = await pkg('pi-durable','index.js');
const { openNodeSqliteStorage } = await pkg('pi-durable','storage/sqlite/node.js');
const { createModels } = await pkg('pi-ai','models.js');
const { createAssistantMessageEventStream } = await pkg('pi-ai','utils/event-stream.js');
const { Type } = await pkg('pi-ai','index.js');
const { BACKGROUND_CONTEXT: ctx } = await pkg('chord','context/index.js');
const dir = process.env.PROBE_RUN;
const read = (name, fallback = null) => existsSync(join(dir,name)) ? JSON.parse(readFileSync(join(dir,name),'utf8')) : fallback;
const save = (name, value) => writeFileSync(join(dir,name), JSON.stringify(value));
const log = (event) => appendFileSync(join(dir,'events.jsonl'),JSON.stringify({event, pid:process.pid})+'\n');
const events = () => existsSync(join(dir,'events.jsonl')) ? readFileSync(join(dir,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse) : [];
const model = { id:'fixture', name:'fixture', api:'fixture-api', provider:'fixture', baseUrl:'', input:['text'], reasoning:false, contextWindow:32000, maxTokens:1024, cost:{input:0,output:0,cacheRead:0,cacheWrite:0} };
const usage = {input:1,output:1,cacheRead:0,cacheWrite:0,totalTokens:2,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
const message = (content, stopReason) => ({role:'assistant',content,api:model.api,provider:model.provider,model:model.id,usage,stopReason,timestamp:Date.now()});
const scenario = process.env.SCENARIO;
function stream(_model, transcript) {
  const s = createAssistantMessageEventStream();
  queueMicrotask(() => {
    let count = read('count.json',0) + 1; save('count.json',count); log('model:'+count);
    const afterTool = transcript.messages.some(m => m.role === 'toolResult');
    let answer;
    if (scenario === 'failure' || (scenario === 'budget' && count > 1)) {
      answer = {...message([{type:'toolCall',id:toolCallId,name:toolName,arguments:toolInput}],'error'),errorMessage: scenario === 'budget' ? 'host budget denied' : 'fixture failed terminal'};
      s.push({type:'error',reason:'error',error:answer});
    } else {
      if (!afterTool) {
        // Host bridge persists the entire native object before publishing the terminal projection.
        save('raw.json',nativeFixture(process.env.PROTOCOL)); log('native_saved');
        answer = message([{type:'toolCall',id:toolCallId,name:toolName,arguments:toolInput}],'toolUse');
      } else {
        save('seen-tool.json', transcript.messages.filter(m => m.role === 'toolResult'));
        answer = message([{type:'text',text:'fixture complete'}],'stop');
      }
      s.push({type:'done',reason:answer.stopReason,message:answer});
    }
    s.end();
  });
  return s;
}
const models = createModels();
models.setProvider({id:'fixture',name:'fixture',auth:{apiKey:{name:'keyless fixture',resolve:async()=>({auth:{},source:'fixture'})}},getModels:()=>[model],stream,streamSimple:stream});
const tool = D.defineTool({name:toolName,description:'fixture observation',parameters:Type.Object({objectRef:Type.String()}),replay:scenario === 'safe' ? 'safe' : 'unsafe',execute:async () => {
  log('execute');
  assert.deepEqual(read('raw.json'), nativeFixture(process.env.PROTOCOL));
  if (scenario === 'safe' && read('revoked.json',false)) { log('execution_auth_denied'); return {output:[{type:'text',text:'authorization revoked'}],isError:true}; }
  if (!read('receipt.json')) { save('receipt.json',{commandId:'command-1',value:'accepted'}); log('effect'); }
  if ((scenario === 'unsafe' || scenario === 'safe') && !read('crashed.json',false)) { save('crashed.json',true); log('crash'); process.kill(process.pid,'SIGKILL'); }
  return {output:[{type:'text',text:'observation complete'}]};
}});
const ext = D.defineExtension({name:'fixture',tools:[tool],hooks:[D.hook(D.ToolTask,{beforeTool:()=>{log('beforeTool');}})]});
async function runChild() {
 const registry=D.createRegistry(); registry.install(ext);
 const harness=await D.Harness.open(await openNodeSqliteStorage(join(dir,'pi.sqlite')),{models,registry,settings:{retry:{maxRetries:0}}},ctx);
 const root=await harness.root(ctx,{agent:{model:{provider:'fixture',modelId:'fixture'}}});
 const submission=await root.submit({type:'input',content:'observe',requestId:'request-1'},ctx);
 save('submission.json',submission.id);
 const result=await submission.wait(ctx); save('result.json',result);
 const page=await root.entries({order:'ascending'},100,undefined,ctx); save('entries.json',page);
 await harness.close(ctx);
}
if (process.argv[2]==='child') { await runChild(); }
else {
 const output={node:process.version, scenarios:{}};
 for (const [name,protocol] of [['normal','chat'],['normal','responses'],['normal','messages'],['failure','chat'],['unsafe','responses'],['safe','messages'],['budget','chat']]) {
  const key=name+'-'+protocol; const path=join(dir,key); mkdirSync(path,{recursive:true});
  const env={...process.env,PROBE_RUN:path,SCENARIO:name,PROTOCOL:protocol};
  const launch=()=>spawnSync(process.execPath,[process.argv[1],'child'],{env,encoding:'utf8',timeout:15000});
  const first=launch();
  let second;
  if (name==='safe' || name==='unsafe') { if(name==='safe') writeFileSync(join(path,'revoked.json'),'true'); second=launch(); }
  const ev=existsSync(join(path,'events.jsonl')) ? readFileSync(join(path,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse) : [];
  const result=existsSync(join(path,'result.json')) ? JSON.parse(readFileSync(join(path,'result.json'),'utf8')) : null;
  const seen=existsSync(join(path,'seen-tool.json')) ? JSON.parse(readFileSync(join(path,'seen-tool.json'),'utf8')) : [];
  const raw=existsSync(join(path,'raw.json')) ? JSON.parse(readFileSync(join(path,'raw.json'),'utf8')) : null;
  const count=(event)=>ev.filter(x=>x.event===event).length;
  const checks={};
  if(name==='normal') {checks.raw=JSON.stringify(raw)===JSON.stringify(nativeFixture(protocol)); checks.saveBeforeExecute=ev.findIndex(x=>x.event==='native_saved')<ev.findIndex(x=>x.event==='execute'); checks.done=result?.status==='done';}
  if(name==='failure') checks.noExecution=count('execute')===0;
  if(name==='unsafe') { checks.crashed=first.signal==='SIGKILL'; checks.noReplay=count('execute')===1; checks.hostQueriesOriginalReceipt=JSON.parse(readFileSync(join(path,'receipt.json'),'utf8')).commandId==='command-1'; checks.interrupted=JSON.stringify(seen).includes('interrupted'); checks.noRepeatFirstModel=count('model:1')===1; checks.rawAfterRestart=JSON.stringify(raw)===JSON.stringify(nativeFixture(protocol)); }
  if(name==='safe') {checks.crashed=first.signal==='SIGKILL'; checks.replayed=count('execute')===2; checks.hookSkipped=count('beforeTool')===1; checks.executionDenied=count('execution_auth_denied')===1; checks.oneEffect=count('effect')===1;}
  if(name==='budget') { checks.hostDeniedSecond=count('model:2')===1 && result?.status==='unanswered'; }
  output.scenarios[key]={first:{status:first.status,signal:first.signal,stderr:first.stderr?.slice(-1200)},second:second&&{status:second.status,signal:second.signal,stderr:second.stderr?.slice(-1200)},events:ev.map(x=>x.event),result,seen,checks};
 }
 console.log(JSON.stringify(output,null,2));
 if(Object.values(output.scenarios).some(x=>Object.values(x.checks).some(v=>v!==true))) process.exitCode=1;
}
