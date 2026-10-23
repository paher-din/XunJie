// Controlled delay is an independent experiment, never a claim about real provider interoperability.
import {createRequire} from 'node:module';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {client,check} from './capacity-workflow.mjs';

export async function controlledQueue(input){
  check(input.teachingRoot==='/opt/xunjie/candidates/133-c896c52/apps/teaching'&&input.root==='/var/lib/xunjie/capacity-133/controlled-queue'
    &&input.accounts.length===5,'CAPACITY_QUEUE_SCOPE_REQUIRED');
  const load=file=>import(pathToFileURL(join(input.teachingRoot,file)).href),config=JSON.parse(readFileSync('/var/lib/xunjie/capacity-133/application.json','utf8'));
  mkdirSync(input.root,{mode:0o700});const copy=join(input.root,'synthetic.sqlite');
  const Driver=createRequire(join(input.teachingRoot,'package.json'))('better-sqlite3');
  const source=new Driver(config.databaseFile,{readonly:true,fileMustExist:true});source.pragma('query_only=ON');
  try{await source.backup(copy);}finally{source.close();}
  const {openApplicationDatabase}=await load('server/db/transaction.ts'),{createDigitalLogicApplication}=await load('server/app/digital-logic.ts');
  const {executionTransports}=await load('server/app/execution-transport.ts'),{createModelBudget}=await load('server/personal-agent/model-budget.ts');
  const db=openApplicationDatabase(copy),budget=createModelBudget(),calls=[];let actual=0,maximumActual=0,closing=false,host;
  const transport={async test(){return {ok:true,latencyMs:0,modelCount:1};},complete(request){
    if(closing)return Promise.resolve({text:'controlled end'});
    actual++;maximumActual=Math.max(actual,maximumActual);
    return new Promise(resolve=>{calls.push({member:request.selection.userId,signal:request.signal,finished:false,finish(){if(this.finished)return;this.finished=true;actual--;resolve({text:'controlled end'});}});});
  }};
  try{
    const userIds=input.accounts.map(account=>db.withTransaction(tx=>tx.get('SELECT id FROM users WHERE login_name=?',account.loginName)?.id));
    check(userIds.every(id=>typeof id==='string')&&new Set(userIds).size===5,'CAPACITY_QUEUE_IDENTITIES_INVALID');
    const versions={modelConfig:'disabled',prompt:'disabled',schema:'disabled',policy:'disabled'};
    host=await createDigitalLogicApplication({db,origin:config.origin,signingSecret:randomBytes(48).toString('hex'),allowedLoginUserIds:userIds,
      executionNodes:config.executionNodes.map(({ssh,...node})=>({...node,...executionTransports(ssh)})),approvedHdlRuntimes:config.approvedHdlRuntimes,
      personalModels:{directory:join(input.root,'personal-agent'),transport,modelBudget:budget},studentHelp:{versions,budgetAvailable:()=>false},
      ...(config.review?{review:{versions:{modelConfigVersion:'disabled',promptVersion:'disabled',schemaVersion:'disabled',analysisVersion:'learner-analysis-v1'}}}:{})});
    const requests=[],http={async send(request){const result=await host.app.inject({method:request.method,url:request.url,headers:request.headers,
      ...(request.body?{payload:request.body}:{})});return {status:result.statusCode,headers:result.headers,text:result.body,bytes:Buffer.byteLength(result.body)};}};
    const clients=[];
    for(const [i,account]of input.accounts.entries()){
      const c=client({actor:['T','S1','S2','S3','S4'][i],origin:config.origin,transport:http,record:row=>requests.push(row)});
      await c.login(account);await c.post('/api/model-settings',{}, {expectedRevision:0,enabled:true,defaultModelId:'custom:p:controlled',
        providers:[{id:'p',name:'Controlled delay only',baseUrl:'https://models.invalid/v1',apiKey:['synthetic','controlled','not-a-real-credential'].join('-'),
          models:[{id:'controlled',contextWindow:'8192',maxOutput:'512',inputTypes:[],reasoningLevels:[]}]}],efforts:{}});clients.push(c);
    }
    input.accounts.length=0;
    async function chat(index){const accepted=await clients[index].post('/api/agent/turns',{},
      {conversationId:null,mode:'send',text:'Controlled queue experiment',requestKey:randomUUID()});await pause(10);return accepted;}
    const activeT=await chat(0);await chat(1);const waitingS2=await chat(2);
    check(calls.length===2&&budget.status().active===2&&budget.status().waiting===1,'CAPACITY_QUEUE_GLOBAL_TWO_FAILED');
    check((await clients[2].get('/api/agent/turns/:id',{id:waitingS2.turnId})).message.phase==='waiting','CAPACITY_QUEUE_NOT_WAITING');
    const ledger=new Driver(join(input.root,'personal-agent/personal-agent.sqlite'),{readonly:true,fileMustExist:true});
    let waitingCalls;try{waitingCalls=JSON.parse(ledger.prepare('SELECT turn_json FROM agent_turns WHERE turn_id=?').get(waitingS2.turnId).turn_json).callCount;}finally{ledger.close();}
    check(waitingCalls===0,'CAPACITY_QUEUE_PREMATURE_CALL_RESERVATION');
    await clients[0].post('/api/agent/turns/:id/stop',{id:activeT.turnId},{});await chat(3);await chat(0);await pause(10);
    check(calls.length===2&&actual===2&&calls[0].signal.aborted&&budget.status().waiting===3,'CAPACITY_QUEUE_ABORT_RELEASED_TOO_EARLY');
    calls[1].finish();await pause(30);check(calls.length===3&&calls[2].member===userIds[2]&&actual===2,'CAPACITY_QUEUE_DISPATCH_FAILED');
    calls[2].finish();await pause(30);check(calls.length===4&&calls[3].member===userIds[3],'CAPACITY_QUEUE_MEMBER_ONE_FAILED');
    calls[0].finish();await pause(30);check(calls.length===5&&calls[4].member===userIds[0]&&actual===2,'CAPACITY_QUEUE_REAL_SETTLEMENT_FAILED');
    calls[3].finish();calls[4].finish();await pause(30);check(maximumActual===2&&budget.status().active===0,'CAPACITY_QUEUE_DRAIN_FAILED');
    const bounded=createModelBudget(),releases=[],pending=[];
    for(let i=0;i<2;i++)pending.push(bounded.run({memberId:'active-'+i,payloadBytes:1},()=>new Promise(resolve=>releases.push(resolve))));
    await pause(1);
    for(let i=0;i<20;i++)pending.push(bounded.run({memberId:'waiting-'+i,payloadBytes:1},async()=>{}));
    let full;try{await bounded.run({memberId:'overflow',payloadBytes:1},async()=>{});}catch(error){full=error.code;}
    check(full==='MODEL_QUEUE_FULL'&&bounded.status().waiting===20,'CAPACITY_QUEUE_COUNT_BOUND_FAILED');
    const boundary=bounded.status();releases.forEach(resolve=>resolve());await Promise.all(pending);await bounded.close();
    const bytesBudget=createModelBudget(),releaseBytes=[],bytePending=[];
    for(let i=0;i<2;i++)bytePending.push(bytesBudget.run({memberId:'a'+i,payloadBytes:1},()=>new Promise(resolve=>releaseBytes.push(resolve))));
    await pause(1);bytePending.push(bytesBudget.run({memberId:'payload',payloadBytes:32*1024*1024},async()=>{}));
    let bytesFull;try{await bytesBudget.run({memberId:'extra-byte',payloadBytes:1},async()=>{});}catch(error){bytesFull=error.code;}
    check(bytesFull==='MODEL_QUEUE_FULL'&&bytesBudget.status().waitingBytes===32*1024*1024,'CAPACITY_QUEUE_BYTE_BOUND_FAILED');
    releaseBytes.forEach(resolve=>resolve());await Promise.all(bytePending);await bytesBudget.close();
    const receipt={schema:'xunjie/capacity-controlled-queue-v1',source:'c896c520a64a40b6860dce279692be5f0481115c',kind:'controlled delay, zero real model calls',
      productSessionScryptCSRF:true,independentDatabaseCopy:true,maximumActual,perMemberOne:true,logicalCancelHeldUntilActualSettled:true,
      waitingPhaseObserved:true,waitingCalls,waitingCountLimit:boundary.waiting,waitingBytesLimit:32*1024*1024,queueFullCode:full,byteFullCode:bytesFull,
      publicRequests:requests.length,non2xx:requests.filter(row=>row.status>=400).length,memory:process.memoryUsage(),passed:true};
    writeFileSync(join(input.root,'result.json'),JSON.stringify(receipt,null,2)+'\n',{mode:0o600,flag:'wx'});return receipt;
  }finally{closing=true;for(const call of calls)call.finish();
    await host?.shutdown();db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>65536)throw new Error('CAPACITY_INPUT_LIMIT');}
    process.stdout.write(JSON.stringify(await controlledQueue(JSON.parse(raw)))+'\n');}
  catch{process.stderr.write('CAPACITY_CONTROLLED_QUEUE_FAILED; no native errors or input persisted.\n');process.exitCode=1;}
}
