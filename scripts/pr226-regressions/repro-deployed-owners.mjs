/** Real SSH two-machine product/PG acceptance. No owner/executor/storage mocks.
 * Run with Node 24.21.0; requires the authorized xunjie-cloud SSH alias and native macOS sandbox.
 * A deterministic HTTP model supplier controls which business tools are invoked; it is not model-quality acceptance.
 * Creates and removes only its own mkdtemp roots, SSH process and product hosts. Never touches default data.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { bundleApplication } from '../package-product.mjs';
import { createAgentConnection } from '../../packages/product-runtime/dist/agent-connections.js';
import { canonicalValue } from '@xunjie/contracts/execution';
import { accumulatorPackage } from '../../components/state-accumulator/package.mjs';
import { question, until, versionHeaders } from '../../packages/product-runtime/test/support/installed-agent-v2.mjs';
const require = createRequire(import.meta.url), pg = require('pg');
const sshArgs = ['-F', join(homedir(), '.config/xunjie-cloud/ssh.conf'), 'xunjie-cloud'];
const linuxBase = '/home/xunjie-admin/wp04-211/product-linux-x64';
const linuxNode = linuxBase+'/resources/node/bin/node';
const hash = value => createHash('sha256').update(JSON.stringify(canonicalValue(value))).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { stdio: ['pipe','pipe','pipe'] }); let out='', err='';
    p.stdout.on('data', b => out+=b); p.stderr.on('data', b => err+=b);
    p.on('error', reject); p.on('close', code => code===0 ? resolve(out.trim()) : reject(new Error(command+' exit '+code+': '+err.slice(-4000))));
    p.stdin.end(input);
  });
}
const shellQuote = value => "'"+value.replaceAll("'", "'\\''")+"'";
const ssh = (command, input) => run('ssh', [...sshArgs, command], input);
async function freePort() { const s=tcpServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const n=s.address().port; await new Promise(r=>s.close(r)); return n; }
// SSH policy permits commands but refuses forwarding. Multiplex only these isolated TCP sockets
// over one SSH stdio session; no sshd changes, public listeners, or product protocol substitution.
const relaySource = `
import net from 'node:net'; import readline from 'node:readline';
const config=JSON.parse(process.argv[2]), sockets=new Map();let seq=0;
const emit=v=>process.stdout.write(JSON.stringify(v)+'\\n');
function attach(id,s){s.setNoDelay(true);sockets.set(id,s);s.on('data',b=>emit({id,type:'data',data:b.toString('base64')}));s.on('end',()=>emit({id,type:'end'}));s.on('close',()=>{sockets.delete(id);emit({id,type:'close'});});s.on('error',()=>{s.destroy();});}
readline.createInterface({input:process.stdin}).on('line',line=>{const p=JSON.parse(line);if(p.type==='open'){const socket=net.connect(p.port,'127.0.0.1');attach(p.id,socket);}else{const s=sockets.get(p.id);if(!s)return;if(p.type==='data')s.write(Buffer.from(p.data,'base64'));if(p.type==='end')s.end();if(p.type==='close')s.destroy();}}).on('close',()=>process.exit());
for(const {listen,target} of config.listeners){net.createServer(s=>{const id='r'+(++seq);attach(id,s);emit({id,type:'open',port:target});}).listen(listen,'127.0.0.1');}
`;
const root = await mkdtemp(join(tmpdir(), 'xj-pr226-deployed-'));
let remoteRoot, tunnel, provider, worker, agent, product, failure;let releaseClaims=()=>{};
const report = { node:process.version, cases:[], failures:[], isolation:{}, cleanup:{} };
const record = (name, facts) => { const value={name,...facts}; report.cases.push(value); console.log(JSON.stringify(value)); };
let replies=[], held=[], modelRequests=[];let diagnosticTurn;
function answer(response, tools=[]) {
 response.writeHead(200, {'content-type':'text/event-stream'});
 const delta=tools.length ? {tool_calls:tools.map((tool,index)=>({index,id:'call-'+randomUUID(),type:'function',function:{name:tool.name,arguments:JSON.stringify(tool.arguments)}}))} : {content:'验收响应'};
 response.end('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:tools.length?'tool_calls':'stop'}],usage:{prompt_tokens:11,completion_tokens:3,total_tokens:14}})+'\n\ndata: [DONE]\n\n');
}
const resources={nodePath:process.execPath,nodeVersion:'24.21.0',postgresBin:'/opt/homebrew/opt/postgresql@18/bin',postgresVersion:'18.6',webRoot:resolve('apps/web/dist-runtime')};
const depId=randomUUID(), sessionConnectionId=randomUUID();
const rpc = async (action, args={}) => JSON.parse(await ssh(linuxNode+' '+shellQuote(remoteRoot+'/rpc.mjs'), JSON.stringify({action,args})));
let schoolEndpoint, member, admin;
async function api(route, body, headers=member, expected=200) {
 const response=await fetch(schoolEndpoint+'/api/learning/'+route,{headers:{'content-type':'application/json',...versionHeaders(route),...headers},...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});
 const value=await response.json(); assert.equal(response.status,expected,route+': '+JSON.stringify(value)); return value;
}
async function agentSql(sql, values=[]) {
 const environment=JSON.parse(await readFile(join(root,'agent/environment.json'),'utf8')),service=environment.services.find(s=>s.unit==='teaching-agent');
 const b=JSON.parse(await product.resolveCredential(join(root,'agent'),'storage-'+service.serviceId));
 const c=new pg.Client(b.connection); await c.connect(); try {await c.query('SET search_path TO "'+b.schema.replaceAll('"','""')+'"'); return (await c.query(sql,values)).rows;} finally {await c.end();}
}
async function turnDone(sessionId, turnId) {
 return until(async()=> {const rows=await agentSql('SELECT state,reason FROM agent_turns WHERE turn_id=$1',[turnId]); if(!rows[0]||rows[0].state==='active')return null;if(rows[0].state!=='completed'){console.log(JSON.stringify({failedTurn:turnId,attempts:await agentSql('SELECT a.state,a.error FROM agent_attempts a JOIN agent_steps s USING(step_id) WHERE s.turn_id=$1',[turnId]),events:await agentSql('SELECT kind,body FROM agent_events WHERE session_id=$1 ORDER BY seq DESC LIMIT 4',[sessionId])}));}assert.equal(rows[0].state,'completed',JSON.stringify(rows));return rows[0];},'Turn did not complete',90000);
}
try {
 assert.equal(process.version,'v24.21.0');
 // Inventory proved the old school no longer exists. Every path below is newly allocated.
 remoteRoot=await ssh('mktemp -d /tmp/xj-pr226-deployed-XXXXXXXX');
 report.isolation={localRoot:root,remoteRoot};
 const app=join(root,'app'); await mkdir(app);
 await bundleApplication(app);
 await writeFile(join(app,'package.json'),'{"type":"module"}');
 product=await import(pathToFileURL(join(app,'product-runtime.js')).href);
 const bundleDigest=hash(await Promise.all(['daemon.js','product-runtime.js'].map(async file=>[file,createHash('sha256').update(await readFile(join(app,file))).digest('hex')])));
 record('fresh source bundled for both machines',{bundleDigest});
 // pg is bundled independently for evidence and compatibility fixtures in the isolated remote DB.
 const {build}=await import('esbuild');
 await build({stdin:{contents:"export {default} from 'pg';",resolveDir:process.cwd(),sourcefile:'evidence-pg.js'},outfile:join(app,'evidence-pg.js'),bundle:true,platform:'node',format:'cjs',logLevel:'silent'});
 await run('tar',['-czf',join(root,'app.tgz'),'-C',root,'app']);
 await ssh('tar -xzf - -C '+shellQuote(remoteRoot),await readFile(join(root,'app.tgz')));
 const rpcSource=`import {openProductRuntime,resolveCredential} from './app/product-runtime.js';
import pg from './app/evidence-pg.cjs';
import {readFile} from 'node:fs/promises';
const root=${JSON.stringify(remoteRoot+'/school')};
const runtime=openProductRuntime({root,resources:{nodePath:${JSON.stringify(linuxNode)},nodeVersion:'24.21.0',postgresBin:${JSON.stringify(linuxBase+'/resources/postgres/bin')},postgresVersion:'18.6',webRoot:${JSON.stringify(linuxBase+'/web')}}});
let text='';for await(const b of process.stdin)text+=b;const {action,args}=JSON.parse(text);let result;
if(action==='credential')result=await resolveCredential(root,args.name);
else if(action==='sql'){const environment=JSON.parse(await readFile(root+'/environment.json','utf8'));const service=environment.services.find(x=>x.unit===args.unit);const b=JSON.parse(await resolveCredential(root,'storage-'+service.serviceId));const c=new (pg.default??pg).Client(b.connection);await c.connect();try{await c.query('SET search_path TO "'+b.schema.replaceAll('"','""')+'"');result=(await c.query(args.sql,args.values??[])).rows;}finally{await c.end();}}
else if(action==='authorize')result=await runtime.authorize(args.authorization,args.serviceId);
else if(action==='connect')result=await runtime.connect(args.connection,args.token);
else result=await runtime[action](...(action==='install'?[args]:[]));
console.log(JSON.stringify(result??null));`;
 await ssh('mv '+shellQuote(remoteRoot+'/app/evidence-pg.js')+' '+shellQuote(remoteRoot+'/app/evidence-pg.cjs'));
 await ssh('cat > '+shellQuote(remoteRoot+'/rpc.mjs'),rpcSource);
 const schoolPort=await freePort(),agentPort=await freePort(),providerPort=await freePort();
 provider=createServer((request,response)=>{void(async()=>{let data='';for await(const b of request)data+=b;const payload=JSON.parse(data);modelRequests.push(payload);const next=replies.shift();if(next==='hold'){held.push(response);return;}answer(response,next??[]);})().catch(e=>response.destroy(e));});
 await new Promise(r=>provider.listen(providerPort,'127.0.0.1',r));
 await ssh('cat > '+shellQuote(remoteRoot+'/relay.mjs'),relaySource);
 tunnel=spawn('ssh',[...sshArgs,linuxNode+' '+shellQuote(remoteRoot+'/relay.mjs')+' '+shellQuote(JSON.stringify({listeners:[{listen:agentPort,target:agentPort},{listen:providerPort,target:providerPort}]}))],{stdio:['pipe','pipe','pipe']});
 const sockets=new Map();let sequence=0;
 const emit=p=>tunnel.stdin.write(JSON.stringify(p)+'\n');
 const attach=(id,s)=>{s.setNoDelay(true);sockets.set(id,s);s.on('data',b=>emit({id,type:'data',data:b.toString('base64')}));s.on('end',()=>emit({id,type:'end'}));s.on('close',()=>{sockets.delete(id);emit({id,type:'close'});});s.on('error',()=>s.destroy());};
 const {createInterface}=await import('node:readline');const {connect}=await import('node:net');
 createInterface({input:tunnel.stdout}).on('line',line=>{const p=JSON.parse(line);if(p.type==='open')attach(p.id,connect(p.port,'127.0.0.1'));else {const s=sockets.get(p.id);if(!s)return;if(p.type==='data')s.write(Buffer.from(p.data,'base64'));if(p.type==='end')s.end();if(p.type==='close')s.destroy();}});
 const schoolProxy=tcpServer(s=>{const id='l'+(++sequence);attach(id,s);emit({id,type:'open',port:schoolPort});});
 await new Promise(r=>schoolProxy.listen(schoolPort,'127.0.0.1',r));
 tunnel.on('close',()=>{for(const s of sockets.values())s.destroy();schoolProxy.close();});
 await delay(500);assert.equal(tunnel.exitCode,null,'SSH byte relay must stay alive');
 await rpc('install',{profile:'school',port:schoolPort});
 const schoolState=await rpc('start'); schoolEndpoint=schoolState.endpoint;
 agent=product.openProductRuntime({root:join(root,'agent'),resources});
 await agent.install({profile:'agent',port:agentPort,agent:{dependencyConnectionId:depId}});
 let agentState=await agent.start();
 admin={authorization:'Bearer '+await rpc('credential',{name:'control'})};
 const password=randomUUID(),loginName='pr226-'+randomUUID();
 const identity=await api('manage/members',{requestId:randomUUID(),loginName,password},admin);
 const login=await fetch(schoolEndpoint+'/api/learning/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({loginName,password})});assert.equal(login.status,200);
 member={cookie:login.headers.get('set-cookie').split(';')[0],'x-xj-space':'school'};
 const data=schoolState.environment.services.find(x=>x.unit==='learning-data'), service=agentState.environment.services.find(x=>x.unit==='teaching-agent');
 const grant=await agent.authorize({sourceEnvironmentId:data.environmentId,sourceServiceId:data.serviceId,sourceInstallationId:schoolState.environment.installationId,capabilities:['agent.sessions.v3']},service.serviceId);
 await rpc('connect',{connection:{connectionId:sessionConnectionId,sourceEnvironmentId:data.environmentId,sourceServiceId:data.serviceId,target:service,requiredCapabilities:['agent.sessions.v3'],optionalCapabilities:[],credentialRef:'pr226-agent'},token:grant.token});
 await api('manage/agent-binding',{requestId:randomUUID(),identity,connectionId:sessionConnectionId,target:service,installationId:agentState.environment.installationId},admin);
 const dependencyGrant=await rpc('authorize',{serviceId:data.serviceId,authorization:{sourceEnvironmentId:service.environmentId,sourceServiceId:service.serviceId,sourceInstallationId:agentState.environment.installationId,capabilities:['agent.dependencies.v2']}});
 await agent.connect({connectionId:depId,sourceEnvironmentId:service.environmentId,sourceServiceId:service.serviceId,target:data,requiredCapabilities:['agent.dependencies.v2'],optionalCapabilities:[],credentialRef:'pr226-dependency'},dependencyGrant.token);
 const modelId=randomUUID();
 await api('manage/model-default',{requestId:randomUUID(),connectionId:modelId,expectedVersion:0,name:'PR226 controlled supplier',protocol:'chat-completions',baseUrl:`http://127.0.0.1:${providerPort}`,path:'/chat/completions',modelId:'pr226-deterministic',dialect:'standard',parameterMode:'plain',enabled:true,contextWindow:1000000,maxOutputTokens:4096,credential:{action:'replace',value:'isolated-synthetic-key'},policy:{checksAllowed:true,maxChecksPerHour:60,maxOutputTokens:4096,timeoutMs:30000}},admin);
 await api('models/selection',{requestId:randomUUID(),expectedVersion:0,source:{kind:'school',connectionId:modelId}});
 const activity=await api('activities',{requestId:randomUUID(),goal:'PR226 deployed owners',question:'',references:[]});
 const session=await api('agent-sessions/workspace',{activityId:activity.activityId,target:activity.target});
 assert.equal(session.owner.target.environmentId,service.environmentId);assert.notEqual(identity.environmentId,service.environmentId);
 const remotePG=await rpc('sql',{unit:'learning-data',sql:'SELECT version() AS version, system_identifier FROM pg_control_system()'}).catch(async()=>rpc('sql',{unit:'learning-data',sql:'SELECT version() AS version'}));
 const localPG=await agentSql('SELECT version() AS version');
 record('isolated real two-machine hosts',{schoolEnvironment:identity.environmentId,agentEnvironment:service.environmentId,agentProfile:agentState.environment.profile,remotePG,localPG});
 replies.push([{name:'read_teaching_artifact',arguments:{artifactId:null,revisionId:null}}],[]);
 const receipt=await api(`agent-sessions/${session.sessionId}/inputs`,question(activity,session,'search deployed owner'));
 await turnDone(session.sessionId,receipt.turnId);
 const calls=await agentSql('SELECT c.name,c.result FROM agent_tool_calls c JOIN agent_steps s USING(step_id) WHERE s.turn_id=$1',[receipt.turnId]);
 assert.equal(calls[0]?.name,'read_teaching_artifact');assert.equal(calls[0]?.result.kind,'completed');assert.equal(calls[0]?.result.outcome,'success');
 assert.ok(modelRequests[0].tools.some(t=>t.function.name==='read_teaching_artifact'));
 record('standalone profile real tools/descriptors',{sessionId:session.sessionId,turnId:receipt.turnId,tools:calls});
 // Keep a genuine generating Step open so authorization failures cannot be explained by a stale Step.
 replies.push('hold');const heldReceipt=await api(`agent-sessions/${session.sessionId}/inputs`,question(activity,session,'authorization boundaries'));
 await until(()=>held.length,'provider not held');
 const [step]=await agentSql('SELECT * FROM agent_steps WHERE turn_id=$1 ORDER BY step_no DESC LIMIT 1',[heldReceipt.turnId]);
 const retainedInputs=await agentSql("SELECT input_id,body FROM agent_inputs WHERE session_id=$1 AND state='adopted' ORDER BY seq",[session.sessionId]);
 const context={sessionId:session.sessionId,turnId:heldReceipt.turnId,stepId:step.step_id,toolCallId:randomUUID(),context:{system:'',facts:{workspace:activity},sources:[]},inputIds:step.snapshot.inputIds,sessionState:{workspaceInputs:retainedInputs.filter(i=>i.body.context?.action).map(i=>({inputId:i.input_id,action:i.body.context.action}))}};
 const invoke=createAgentConnection(join(root,'agent'),depId,'agent.dependencies.v2');
 const base={version:2,operation:'tools.execute',identity,sessionId:session.sessionId,permit:{sessionId:session.sessionId,runId:heldReceipt.turnId,stepId:step.step_id,operationId:context.toolCallId,generation:1},args:{module:{id:'read_teaching_artifact',version:1},context,call:{toolCallId:context.toolCallId,nativeCallId:'auth-probe',callIndex:0,name:'read_teaching_artifact',input:{artifactId:null,revisionId:null},executionMode:'foreground'}}};
 const validProbe=await invoke(base);assert.equal(validProbe.kind,'completed');assert.equal(validProbe.outcome,'success');
 for(const [name,patch] of [['wrong identity',{identity:{...identity,principalId:randomUUID()}}],['wrong workspace',{args:{...base.args,context:{...context,context:{...context.context,facts:{workspace:{...activity,activityId:randomUUID()}}}}}}],['wrong permit',{permit:{...base.permit,stepId:randomUUID()}}]]) {
  const probeId=randomUUID();const probe={...base,...patch,permit:{...(patch.permit??base.permit),operationId:probeId},args:{...(patch.args??base.args),context:{...(patch.args?.context??base.args.context),toolCallId:probeId},call:{...base.args.call,toolCallId:probeId}}};let error;try{await invoke(probe);}catch(e){error=e;}assert.ok(error,name+' accepted');assert.ok(['forbidden','stale-generation','identity-conflict'].includes(error.code),name+': '+error.code);record('standalone rejection '+name,{code:error.code,liveStep:step.step_id});
 }
 answer(held.shift());await turnDone(session.sessionId,heldReceipt.turnId);
 console.log(JSON.stringify({phase:'business-tools-complete'}));
 // Enroll a real native executor on this Mac against the Linux task owner.
 const connectionId=randomUUID(),verifier=randomUUID()+randomUUID();
 await api('connections/start',{requestId:connectionId,clientId:randomUUID(),challenge:createHash('sha256').update(verifier).digest('base64url')},{});
 await api('connections/approve',{requestId:connectionId});
 const nativeGrant=await api('connections/exchange',{requestId:connectionId,verifier},{});
 const native={nodePath:process.execPath,sessionRoot:join(root,'native-sessions')};
 const node=await product.nativeChannelNode({...native,connectionId,installationId:randomUUID()});
 assert.ok(node.adapters.some(a=>a.adapterId==='four-state-accumulator'),'real sandbox native adapter unavailable');
 let pauseClaims=false, claimBlocked;
 const claims=[];
 worker=product.createNativeChannelWorker({root:join(root,'worker'),node,native,call:async(operation,input)=>{
  // Fault only claim delivery, allowing the real worker to renew its lease on later ticks.
  if(operation==='claim'&&pauseClaims){claimBlocked?.();throw new Error('acceptance claim delivery paused');}
  const value=await api('native-channel/'+operation,input,{authorization:'Bearer '+nativeGrant.token});
  if(operation==='claim'&&value.command)claims.push(value.command);
  return value;
 }});
 await worker.tick();worker.start();
 const published=await accumulatorPackage({version:1});
 const definition=await api('manage/component-import',{requestId:randomUUID(),...published},admin);
 const courseId=randomUUID(),taskId=randomUUID(),releaseId=randomUUID();
 await api('manage/course-import',{formatVersion:1,requestId:randomUUID(),course:{courseId,name:'PR226 deployed native'},task:{taskId,title:'real control',summary:''},release:{releaseId,objectives:['真实执行'],requirements:'native controls',starterWorks:[],capabilities:[],materials:[],components:[{key:'counter',definition,configuration:{title:'验收'},materialIds:[]}],helpPolicy:{version:1,questions:'allowed',scope:'course'}},resources:[]},admin);
 await api('manage/course-access',{requestId:randomUUID(),courseId,principalId:identity.principalId,active:true},admin);
 const nativeActivity=await api('course-activities',{requestId:randomUUID(),releaseId});
 const nativeSession=await api('agent-sessions/workspace',{activityId:nativeActivity.activityId,target:nativeActivity.target});
 const submit=async(text,tools,hold=false)=>{replies.push(tools,hold?'hold':[]);const receipt=await api(`agent-sessions/${nativeSession.sessionId}/inputs`,question(nativeActivity,nativeSession,text));diagnosticTurn={sessionId:nativeSession.sessionId,turnId:receipt.turnId};if(!hold)await turnDone(nativeSession.sessionId,receipt.turnId);return receipt;};
 const started=await submit('start native',[{name:'course_operation',arguments:{componentKey:'counter',operationId:'start_session',parameters:{},executionMode:'foreground'}}]);
 const [parentCall]=await agentSql('SELECT c.* FROM agent_tool_calls c JOIN agent_steps s USING(step_id) WHERE s.turn_id=$1',[started.turnId]);
 const parentId=parentCall.tool_call_id;
 const parentPath=`executions/${nativeActivity.activityId}/${parentId}`;
 const parent=await until(async()=>{const v=await api(parentPath);return v?.state==='running'?v:null;},'native parent never running');
 assert.equal(parentCall.result.kind,'completed');assert.equal(parentCall.result.outcome,'success');
  const processRows=await run('ps',['eww','-axo','pid=,command=']);
 const processLine=processRows.split('\n').find(line=>line.includes('XJ_SESSION_INSTANCE='+parent.session.executorInstanceId));
 assert.ok(processLine,'real native child must exist');const nativePid=Number(processLine.trim().split(/\s+/)[0]);
 record('real native parent running',{requestId:parentId,executionRef:parent.executionRef,nativePid,executorInstanceId:parent.session.executorInstanceId});
 // Two independent controls in one Turn. Hold the follow-up generation so both owner facts
 // can be observed before the kernel adopts their notifications; no direct scan/observe calls.
 const bg=await submit('two background native controls',[
  {name:'course_operation',arguments:{componentKey:'counter',operationId:'advance',parameters:{value:1},requestId:parentId,expectedSeq:0,executionMode:'background'}},
  {name:'course_operation',arguments:{componentKey:'counter',operationId:'advance',parameters:{value:2},requestId:parentId,expectedSeq:1,executionMode:'background'}}],true);
 await until(()=>held.length,'background followup not held',180000);
 const bgCalls=await agentSql('SELECT c.* FROM agent_tool_calls c JOIN agent_steps s USING(step_id) WHERE s.turn_id=$1 ORDER BY c.call_index',[bg.turnId]);
 assert.equal(bgCalls.length,2);for(const c of bgCalls){assert.equal(c.result.kind,'accepted');assert.equal(c.task_id,c.tool_call_id);assert.notEqual(c.task_id,parentId);}
 await until(async()=>{const q=await api(parentPath);return q.session.appliedSeq===2;},'both real controls did not apply');
 const taskFacts=[];for(const c of bgCalls)taskFacts.push(await invoke({version:2,operation:'tasks',identity,sessionId:nativeSession.sessionId,args:{method:'read',taskId:c.task_id}}));
 if(taskFacts.some(x=>!x))record('missing task fact diagnostics',{taskFacts,requester:{identity,sessionId:nativeSession.sessionId},ledger:await rpc('sql',{unit:'learning-data',sql:'SELECT c.command_id,c.request_id,c.activity_id,c.association,c.kind,c.cancelled,o.identity FROM agent_execution_commands c LEFT JOIN agent_execution_origins o USING(command_id) WHERE c.command_id=ANY($1::uuid[])',values:[bgCalls.map(c=>c.task_id)]})});
 assert.ok(taskFacts.every(x=>x?.state==='succeeded'&&x.statusKnowledge==='confirmed'),JSON.stringify(taskFacts));
 const notificationRows=()=>agentSql('SELECT * FROM agent_notifications WHERE session_id=$1',[nativeSession.sessionId]);
 const notices=await until(async()=>{const n=await notificationRows();return n.length===2?n:null;},'product host did not auto-notify both terminal tasks',30000);
 for(const c of bgCalls)assert.equal(notices.filter(n=>n.task_id===c.task_id).length,1);
 answer(held.shift());await turnDone(nativeSession.sessionId,bg.turnId);
 try {
 const listed=await invoke({version:2,operation:'tasks',identity,sessionId:nativeSession.sessionId,args:{method:'list',turnId:bg.turnId}});
 assert.equal(listed.length,2);assert.ok(listed.every(f=>f.sessionId===nativeSession.sessionId));
 const crossRead=await invoke({version:2,operation:'tasks',identity,sessionId:session.sessionId,args:{method:'read',taskId:bgCalls[0].task_id}}).catch(error=>({error:error.code}));
 assert.ok(crossRead===null||crossRead?.error==='forbidden','another workspace read a native task');
 let crossCancelError;try{await invoke({version:2,operation:'tasks',identity,sessionId:session.sessionId,args:{method:'cancel',taskId:bgCalls[0].task_id}});}catch(error){crossCancelError=error;}
 assert.ok(crossCancelError,'another workspace cancelled a native task');
 record('remote task source and cross-workspace authorization',{listed:listed.length,crossRead,crossCancel:crossCancelError.code});
 // Simulate a pre-sessionId association in the actual remote owner ledger. The school has
 // no matching Agent Turn: resolving this record must query its independent Agent owner.
 const legacyTaskId=bgCalls[0].task_id;
 const [localTurnCount]=await rpc('sql',{unit:'teaching-agent',sql:'SELECT count(*)::int AS count FROM agent_turns WHERE turn_id=$1',values:[bg.turnId]});
 assert.equal(localTurnCount.count,0,'origin Turn must live only on the independent Agent');
 const [savedAssociation]=await rpc('sql',{unit:'learning-data',sql:'SELECT association FROM agent_execution_commands WHERE command_id=$1',values:[legacyTaskId]});
 assert.equal(savedAssociation.association.sessionId,nativeSession.sessionId);
 await rpc('sql',{unit:'learning-data',sql:"UPDATE agent_execution_commands SET association=association-'sessionId' WHERE command_id=$1",values:[legacyTaskId]});
 try {
  const legacy=await invoke({version:2,operation:'tasks',identity,sessionId:nativeSession.sessionId,args:{method:'read',taskId:legacyTaskId}});
  assert.equal(legacy.sessionId,nativeSession.sessionId);assert.equal(legacy.state,'succeeded');
  const legacyCrossRead=await invoke({version:2,operation:'tasks',identity,sessionId:session.sessionId,args:{method:'read',taskId:legacyTaskId}}).catch(error=>({error:error.code}));
  assert.ok(legacyCrossRead===null||legacyCrossRead?.error==='forbidden');
  await assert.rejects(invoke({version:2,operation:'tasks',identity,sessionId:session.sessionId,args:{method:'cancel',taskId:legacyTaskId}}),error=>error.code==='forbidden');
  // A cancellation requested after physical application cannot change its confirmed outcome.
  await invoke({version:2,operation:'tasks',identity,sessionId:nativeSession.sessionId,args:{method:'cancel',taskId:legacyTaskId}});
  const applied=await invoke({version:2,operation:'tasks',identity,sessionId:nativeSession.sessionId,args:{method:'read',taskId:legacyTaskId}});
  assert.equal(applied.state,'succeeded');assert.equal(applied.statusKnowledge,'confirmed');
  record('legacy association resolves across machines and applied receipt wins',{sessionId:legacy.sessionId,state:applied.state,statusKnowledge:applied.statusKnowledge});
 } finally {
  await rpc('sql',{unit:'learning-data',sql:'UPDATE agent_execution_commands SET association=$2::jsonb WHERE command_id=$1',values:[legacyTaskId,JSON.stringify(savedAssociation.association)]});
 }

 } catch(error) {report.failures.push({name:'remote task source and cross-workspace authorization',error:error.message});record('remote task source and cross-workspace authorization FAIL',{error:error.message});}
 record('two real background terminals automatically notified',{originTurnId:bg.turnId,taskFacts,notifications:notices.map(n=>({id:n.notification_id,taskId:n.task_id,state:n.state}))});
 // Ensure a foreground operation completes but does not register any background notification.
 const fg=await submit('foreground native control',[{name:'course_operation',arguments:{componentKey:'counter',operationId:'advance',parameters:{value:3},requestId:parentId,expectedSeq:2,executionMode:'foreground'}}]);
 assert.equal((await api(parentPath)).session.appliedSeq,3);
 assert.equal((await notificationRows()).length,2);
 record('foreground terminal does not notify',{turnId:fg.turnId,notifications:2});
 await agent.stop();await agent.start();await delay(4500);
 const restarted=await notificationRows();assert.equal(restarted.length,2);assert.deepEqual(restarted.map(n=>n.notification_id).sort(),notices.map(n=>n.notification_id).sort());
 record('product host restart does not duplicate notifications',{notifications:restarted.length});
 // Delay only claim delivery; a blocked tick would expire the live native process lease.
 // Registration and heartbeat still reach the real owner on each retry.
 let claimIsPaused=false;claimBlocked=()=>{claimIsPaused=true;};
 pauseClaims=true;releaseClaims=()=>{pauseClaims=false;};
 await until(()=>claimIsPaused,'worker did not reach its claim boundary',30000);
 assert.equal((await api(parentPath)).state,'running');process.kill(nativePid,0);
 const cancelTurn=await submit('cancel independent control',[{name:'course_operation',arguments:{componentKey:'counter',operationId:'advance',parameters:{value:99},requestId:parentId,expectedSeq:3,executionMode:'background'}}],true);
 await until(()=>held.length,'cancellation followup not held',180000);
 const [cancelCall]=await agentSql('SELECT c.* FROM agent_tool_calls c JOIN agent_steps s USING(step_id) WHERE s.turn_id=$1',[cancelTurn.turnId]);
 assert.equal(cancelCall.result.kind,'accepted',JSON.stringify({result:cancelCall.result,executionMode:cancelCall.execution_mode,taskId:cancelCall.task_id}));
 await invoke({version:2,operation:'tasks',identity,sessionId:nativeSession.sessionId,args:{method:'cancel',taskId:cancelCall.task_id}});
 await invoke({version:2,operation:'tasks',identity,sessionId:nativeSession.sessionId,args:{method:'cancel',taskId:cancelCall.task_id}});
 const pendingCancel=await invoke({version:2,operation:'tasks',identity,sessionId:nativeSession.sessionId,args:{method:'read',taskId:cancelCall.task_id}});
 assert.equal(pendingCancel.state,'running');assert.equal(pendingCancel.statusKnowledge,'unknown');
 assert.equal((await notificationRows()).length,2,'cancel intent must not notify a terminal');
 record('queued control cancel intent remains unconfirmed',{state:pendingCancel.state,statusKnowledge:pendingCancel.statusKnowledge});
 releaseClaims();
 const physicallyCancelled=await until(async()=>{const rows=await rpc('sql',{unit:'learning-data',sql:'SELECT state,result,claim_id FROM native_channel_commands WHERE command_id=$1',values:[cancelCall.task_id]});return rows[0]?.state==='cancelled'?rows[0]:null;},'native owner failed to cancel the queued operation',30000);
 assert.equal(physicallyCancelled.claim_id,null,'queued cancellation must never be claimed');
 const cancelledTask=await invoke({version:2,operation:'tasks',identity,sessionId:nativeSession.sessionId,args:{method:'read',taskId:cancelCall.task_id}});
 assert.equal(cancelledTask.state,'cancelled');assert.equal(cancelledTask.statusKnowledge,'confirmed');
 const preserved=await api(parentPath);assert.equal(preserved.state,'running');assert.equal(preserved.session.appliedSeq,3);
 process.kill(nativePid,0);
 assert.ok(!preserved.session.observations.some(o=>o.controlId===cancelCall.task_id));
 answer(held.shift());await turnDone(nativeSession.sessionId,cancelTurn.turnId);
 record('native owner confirms queued control cancellation without killing parent',{taskId:cancelCall.task_id,nativeCommand:physicallyCancelled,taskState:cancelledTask.state,parentState:preserved.state,appliedSeq:preserved.session.appliedSeq,nativePid});
 const afterCancel=await submit('parent still accepts inputs',[{name:'course_operation',arguments:{componentKey:'counter',operationId:'advance',parameters:{value:4},requestId:parentId,expectedSeq:3,executionMode:'foreground'}}]);
 assert.equal((await api(parentPath)).session.appliedSeq,4);process.kill(nativePid,0);
 record('parent executes after independent cancellation',{turnId:afterCancel.turnId,appliedSeq:4,nativePid});
 // Now explicitly stop the running root task through its real owner, after proving that
 // cancellation of an independent control preserved it. Verify process exit, not just intent.
 for(let attempt=0;attempt<2;attempt++)await invoke({version:2,operation:'tasks',identity,sessionId:nativeSession.sessionId,args:{method:'cancel',taskId:parentId}});
 const rootCancelled=await until(async()=>{const fact=await invoke({version:2,operation:'tasks',identity,sessionId:nativeSession.sessionId,args:{method:'read',taskId:parentId}});return fact?.state==='cancelled'&&fact.statusKnowledge==='confirmed'?fact:null;},'native owner did not confirm running task cancellation',30000);
 await until(()=>{try{process.kill(nativePid,0);return false;}catch(error){if(error.code==='ESRCH')return true;throw error;}},'native process survived confirmed cancellation',30000);
 record('native owner physically stops the running task idempotently',{taskId:parentId,state:rootCancelled.state,statusKnowledge:rootCancelled.statusKnowledge,nativePid,processExited:true});

 } catch(error) {
 if(diagnosticTurn){try{record('failure diagnostics',{turns:await agentSql('SELECT turn_id,state FROM agent_turns WHERE turn_id=$1',[diagnosticTurn.turnId]),steps:await agentSql('SELECT step_id,state FROM agent_steps WHERE turn_id=$1 ORDER BY step_no',[diagnosticTurn.turnId]),calls:await agentSql('SELECT c.name,c.state,c.result,c.execution_mode,c.task_id FROM agent_tool_calls c JOIN agent_steps s USING(step_id) WHERE s.turn_id=$1 ORDER BY c.call_index',[diagnosticTurn.turnId]),attempts:await agentSql('SELECT a.state,a.error FROM agent_attempts a JOIN agent_steps s USING(step_id) WHERE s.turn_id=$1',[diagnosticTurn.turnId]),pendingReplies:replies.map(x=>x==='hold'?'hold':x.map(t=>t.name)),modelRequestCount:modelRequests.length});}catch(diagnosticError){record('failure diagnostic unavailable',{error:diagnosticError.message});}}
 failure=error;
 report.failures.push({name:'deployed acceptance',error:error.message});
} finally {
 releaseClaims();
 for(const response of held)response.destroy();
 const cleanup=async(name,operation)=>{try{await operation();report.cleanup[name]=true;return true;}catch(error){report.cleanup[name]=false;report.failures.push({name:'cleanup '+name,error:error.message});return false;}};
 await cleanup('nativeWorkerStopped',async()=>worker?.stop());
 const agentStopped=await cleanup('agentStopped',async()=>agent?.stop());
 const schoolStopped=await cleanup('schoolStopped',async()=>{if(remoteRoot)await rpc('stop');});
 tunnel?.kill();
 provider?.closeAllConnections();if(provider?.listening)await new Promise(r=>provider.close(r));
 if(remoteRoot&&schoolStopped)await cleanup('remoteRootRemoved',()=>ssh('rm -rf -- '+shellQuote(remoteRoot)));
 if(agentStopped)await cleanup('localRootRemoved',()=>rm(root,{recursive:true,force:true}));
}
console.log(JSON.stringify({acceptance:report}));
if(failure)throw failure;
assert.deepEqual(report.failures,[],'deployed acceptance failures');
