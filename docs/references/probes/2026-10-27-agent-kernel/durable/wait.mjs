// Custom durable task: polling is a host bridge; the task checkpoint/scheduler is Pi.
import { pathToFileURL } from 'node:url';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const deps=process.env.PROBE_DEPS, dir=process.env.PROBE_RUN;
const pkg=(name,file)=>import(pathToFileURL(join(deps,'node_modules/@earendil-works',name,'dist',file)).href);
const D=await pkg('pi-durable','index.js');
const {openNodeSqliteStorage}=await pkg('pi-durable','storage/sqlite/node.js');
const {BACKGROUND_CONTEXT:ctx}=await pkg('chord','context/index.js');
const {createModels}=await pkg('pi-ai','models.js');
const save=(f,v)=>writeFileSync(join(dir,f),JSON.stringify(v));
const read=(f)=>JSON.parse(readFileSync(join(dir,f),'utf8'));
const Task=D.defineTask({name:'fixture.wait',version:1,initial:()=>({phase:'wait'}),phases:{
 wait:async (_task,runtime,c)=>{ await runtime.sleepUntil(100,{phase:'receipt'},c); },
 receipt:async (_task,runtime,c)=>{ const receipt=read('receipt.json'); save('delivered.json',{receipt,pid:process.pid}); await runtime.commit(()=>({status:'terminal',outcome:{status:'completed',result:receipt}}),c); },
},abort:async (_task,runtime,c)=>{await runtime.commit(()=>({status:'terminal',outcome:{status:'aborted'}}),c);}});
async function child(stage) {
 const registry=D.createRegistry(); registry.install(D.defineExtension({name:'wait',tasks:[Task]}));
 const harness=await D.Harness.open(await openNodeSqliteStorage(join(dir,'wait.sqlite')),{models:createModels(),registry,now:()=>stage==='create'||stage==='cancel'?0:200,onWake:()=>{}},ctx);
 const root=await harness.root(ctx);
 if(stage==='create') {
  const id=await root.commit(tx=>tx.createTask(Task,{commandId:'command-wait-1'},{ownership:{kind:'conversation',conversationId:root.id}}),ctx); save('task.json',id); harness.resume();
  for(let i=0;i<100;i++){const t=await harness.getTask(id,ctx); if(t?.state?.status==='sleeping'){save('sleep.json',{state:t.state,pid:process.pid});break;} await new Promise(r=>setTimeout(r,10));}
  if(!existsSync(join(dir,'sleep.json'))) throw Error('did not reach durable sleep');
 } else if(stage==='cancel'){await root.abort(ctx); save('cancel.json',{pid:process.pid,outcome:await harness.waitForTask(read('task.json'),ctx)});}
 else {harness.resume(); const outcome=await harness.waitForTask(read('task.json'),ctx); save('outcome.json',{pid:process.pid,outcome});}
 await harness.close(ctx);
}
if(process.argv[2]==='child') await child(process.argv[3]);
else {
 const results={};
 for(const mode of ['resume','cancel']){
  const path=join(dir,'wait-'+mode);mkdirSync(path,{recursive:true}); const env={...process.env,PROBE_RUN:path};
  const run=(stage)=>{const r=spawnSync(process.execPath,[process.argv[1],'child',stage],{env,encoding:'utf8',timeout:10000}); if(r.status!==0) throw Error(stage+': '+r.stderr);};
  run('create'); if(mode==='cancel') run('cancel');
  writeFileSync(join(path,'receipt.json'),JSON.stringify({commandId:'command-wait-1',value:'ready'})); run('resume');
  const sleep=JSON.parse(readFileSync(join(path,'sleep.json'))), outcome=JSON.parse(readFileSync(join(path,'outcome.json')));
  const delivered=existsSync(join(path,'delivered.json'))?JSON.parse(readFileSync(join(path,'delivered.json'))):null;
  results[mode]={sleep,outcome,delivered,checks:{differentProcess:sleep.pid!==outcome.pid, sleeping:sleep.state.status==='sleeping', expectedDelivery:mode==='resume'?delivered?.receipt.commandId==='command-wait-1':delivered===null, expectedOutcome:outcome.outcome.state?.outcome?.status===(mode==='resume'?'completed':'aborted')}};
 }
 console.log(JSON.stringify(results,null,2));
 if(Object.values(results).some(x=>Object.values(x.checks).some(v=>v!==true))) process.exitCode=1;
}
