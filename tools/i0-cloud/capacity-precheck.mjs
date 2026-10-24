// A real HTTPS five-member read/write precheck on a retained-data copy, never a deployment artifact or 905s pass.
import {createRequire} from 'node:module';
import {randomBytes,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as pause} from 'node:timers/promises';
import {client,httpsTransport,editAndSave,submit,snapshot,reviewAndResume,check} from './capacity-workflow.mjs';
import {parseServerMetric,summarizeServer} from './capacity-metrics.mjs';

export async function precheck(input){
  const root='/var/lib/xunjie/capacity-133/perf-0f7e1a3b',teachingRoot='/opt/xunjie/candidates/133-c896c52/apps/teaching';
  check(input.accounts.length===5&&input.actors.length===4&&/^[1-9]$/.test(String(input.attempt)),'CAPACITY_PRECHECK_SCOPE');
  check(['records','course-hydration'].includes(input.variant??'records'),'CAPACITY_PRECHECK_VARIANT');
  const cfg=JSON.parse(readFileSync('/var/lib/xunjie/capacity-133/application.json','utf8')),load=file=>import(pathToFileURL(join(teachingRoot,file)).href);
  const Driver=createRequire(join(teachingRoot,'package.json'))('better-sqlite3'),source=new Driver(join(root,'synthetic.sqlite'),{readonly:true,fileMustExist:true}),databaseFile=join(root,'precheck-'+input.attempt+'.sqlite');
  check(!existsSync(databaseFile),'CAPACITY_PRECHECK_ALREADY_EXISTS');
  source.pragma('query_only=ON');try{await source.backup(databaseFile);}finally{source.close();}
  const {openApplicationDatabase}=await load('server/db/transaction.ts'),{createDigitalLogicApplication}=await load('server/app/digital-logic.ts'),{executionTransports}=await load('server/app/execution-transport.ts');
  const db=openApplicationDatabase(databaseFile),metrics=[],requests=[],connections=[];let service,stop=false,teacherFailure;const reviews=[];
  const startedAt=new Date().toISOString();
  try{
    const ids=input.accounts.map(account=>db.withTransaction(tx=>tx.get('SELECT id FROM users WHERE login_name=?',account.loginName)?.id));
    check(ids.every(id=>typeof id==='string')&&new Set(ids).size===5,'CAPACITY_PRECHECK_IDENTITIES');
    service=await createDigitalLogicApplication({db,origin:cfg.origin,signingSecret:randomBytes(48).toString('hex'),allowedLoginUserIds:ids,
      https:{key:readFileSync(cfg.tls.keyFile),cert:readFileSync(cfg.tls.certFile)},approvedHdlRuntimes:cfg.approvedHdlRuntimes,
      executionNodes:cfg.executionNodes.map(({ssh,...node})=>({...node,...executionTransports(ssh)})),
      ...(cfg.review?{review:{versions:{modelConfigVersion:'disabled',promptVersion:'disabled',schemaVersion:'disabled',analysisVersion:'learner-analysis-v1'}}}:{}),
      studentHelp:{versions:{modelConfig:'disabled',prompt:'disabled',schema:'disabled',policy:'disabled'},budgetAvailable:()=>false},
      logDestination:{write(line){const row=parseServerMetric(line);if(row)metrics.push(row);}}});
    await service.app.listen({host:'127.0.0.1',port:0});const port=service.app.server.address().port;
    const clients=input.accounts.map((account,i)=>{const transport=httpsTransport({port,ca:input.caPEM,origin:cfg.origin});connections.push(transport);
      return client({actor:['T','S1','S2','S3','S4'][i],origin:cfg.origin,transport,record:row=>requests.push(row)});});
    for(let i=0;i<5;i+=2)await Promise.all(clients.slice(i,i+2).map((c,j)=>c.login(input.accounts[i+j])));
    input.accounts.length=0;input.caPEM='';
    // Dispatch five real requests together, including the expensive workbench, before the unchanged paced loop.
    const burstStart=requests.length;
    await Promise.all([clients[0].get('/api/courses/:id/teacher-workbench',{id:'synthetic-textscope-c'}),
      ...input.actors.map((actor,index)=>clients[index+1].get('/api/attempts/:id',{id:actor.attemptId}))]);
    const burst=requests.slice(burstStart);
    const states=input.actors.map((actor,index)=>({...actor,label:['S1','S2','S3','S4'][index],client:clients[index+1],generation:cfg.recoveryGeneration,
      clientId:'precheck-'+randomUUID(),clientSeq:0,iterations:0,submissions:0,feedback:0,replays:0,lastHash:null,lastVersion:0}));
    const t0=Date.now(),end=t0+40_000,runId='precheck-'+randomUUID();let studentsDone=false;
    const teacher=(async()=>{let nextView=0;try{while((!studentsDone||reviews.length)&&!stop){
      const item=reviews.shift();if(item){try{await reviewAndResume(clients[0],item);item.resolve();}catch(error){item.reject(error);throw error;}}
      if(Date.now()>=nextView){await clients[0].get('/api/courses/:id/teacher-workbench',{id:'synthetic-textscope-c'});await clients[0].get('/api/session');nextView=Date.now()+5000;}
      if(!item)await pause(100);
    }}catch(error){teacherFailure=error;stop=true;for(const item of reviews.splice(0))item.reject(error);}})();
    await Promise.all(states.map(async(state,index)=>{await pause(index*600);while(Date.now()<end&&!stop){const began=Date.now();
      if(state.iterations%5===0){await state.client.get('/api/courses');await state.client.get('/api/courses/:id/assignments',{id:'synthetic-textscope-c'});await state.client.get('/api/session');}
      await editAndSave(state,runId);
      if(state.iterations%6===0){const item=await submit(state);if(teacherFailure)throw teacherFailure;check(!stop,'CAPACITY_PRECHECK_STOPPED');
        await new Promise((resolve,reject)=>reviews.push({...item,resolve,reject}));await state.client.get('/api/attempts/:id/feedback',{id:state.attemptId});}
      else if(state.iterations%3===0)await snapshot(state);
      await pause(Math.max(0,5000-(Date.now()-began)));
    }}));studentsDone=true;await teacher;if(teacherFailure)throw teacherFailure;
    const timings=summarizeServer(metrics,requests),receipt={at:new Date().toISOString(),startedAt,kind:'isolated real HTTPS precheck; five product sessions, preserved history, unchanged 5s cadence including teacher workbench',
      runtimeSource:'c896c52 with explicit '+(input.variant==='course-hydration'?'a8a5fa2 + workspace/storage and teacher-workbench':'a8a5fa2 records-adapter')+' diagnostic overrides; NOT activated artifact',seconds:(Date.now()-t0)/1000,sourceDatasetReceipts:1103,
      actors:states.map(s=>({actor:s.label,iterations:s.iterations,submissions:s.submissions,feedback:s.feedback,replays:s.replays})),...timings};
    receipt.simultaneousFive=summarizeServer(metrics,burst);
    writeFileSync(join(root,'precheck-'+input.attempt+'.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});return receipt;
  }catch(error){
    writeFileSync(join(root,'precheck-'+input.attempt+'-failure.json'),JSON.stringify({at:new Date().toISOString(),startedAt,
      failureCode:typeof error?.code==='string'&&/^[A-Z_]+$/.test(error.code)?error.code:'CAPACITY_PRECHECK_FAILED',
      details:error?.details,...summarizeServer(metrics,requests)})+'\n',{mode:0o600,flag:'wx'});throw error;
  }finally{stop=true;for(const transport of connections)transport.close();await service?.shutdown();db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>65536)throw new Error('CAPACITY_INPUT_LIMIT');}
    process.stdout.write(JSON.stringify(await precheck(JSON.parse(text)))+'\n');}
  catch{process.stderr.write('CAPACITY_HTTPS_PRECHECK_FAILED; no native errors or input persisted.\n');process.exitCode=1;}
}
