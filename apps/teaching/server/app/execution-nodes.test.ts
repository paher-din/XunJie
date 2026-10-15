import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,allocate,command,view,syntheticNode,profile} from '../../tests/dl-a-support.ts';
import {createDigitalLogicApplication} from './digital-logic.ts';
import {executionNodes,type ExecutionNode} from './execution-nodes.ts';
import {createWorkspaceWorker} from '../workspace/worker.ts';
import {readJobs,saveJob} from '../db/records-adapter.ts';
import type {RunnerTransport} from '../records/runner.ts';
import type {RunFact} from '../../contracts/runner/index.ts';
import type {HdlTransport} from '../workspace/hdl.ts';
import {sha256} from '../../runner/snapshot.ts';
import {SyntheticProvider} from '../tutoring/providers.ts';
const selected=(base:{origin:string;cookie:string;'x-csrf-token':string},nodeId:string)=>({...base,'x-xunjie-execution-node':nodeId});

function memberNode(nodeId:string){
 const nodeGeneration='node-generation-'+nodeId,hdl=syntheticNode(),facts=new Map<string,RunFact>(),results=new Map<string,object>();
 let online=true,submits=0,lose=false,diagnosticCalls=0;
 const runner:RunnerTransport=async packet=>{
  if(!online)throw new Error('Synthetic member disconnected');
  if(packet.op==='readiness'){
   const fingerprint={profile,sourceHash:'d'.repeat(64)};
   return {data:{ready:true,...profile,recoveryGeneration:nodeGeneration,fingerprint,
    validation:{passed:true,fingerprintHash:sha256(JSON.stringify(fingerprint)),validatedAt:new Date().toISOString()}}};
  }
  if(packet.op==='editor_diagnostics'){
   diagnosticCalls++;assert.equal(packet.packet.recoveryGeneration,nodeGeneration);
   const source=packet.packet.snapshot.files.find(file=>file.fileId===packet.packet.fileId)!;
   return {data:{status:'ready',sourceHash:packet.packet.snapshot.hash,provider:packet.packet.language==='hdl'?'iverilog':'gcc',
    diagnostics:[{fileId:source.fileId,path:source.path,contentHash:source.contentHash,severity:'error',message:'Synthetic draft analysis by '+nodeId,line:1}]}};
  }
  const identity=packet.op==='submit'?packet.submission.identity:packet.identity;
  assert.equal(identity.recoveryGeneration,nodeGeneration,'real wire identity must use the registered node generation');
  if(packet.op==='submit'){
   submits++;
   const result={...identity,unitTerminated:true,phases:[{stdout:'member '+nodeId,stderr:''}]};results.set(identity.runId,result);
   facts.set(identity.runId,{identity,state:'succeeded',reserved:false,stopRequested:false,units:[],pending:[],resultRef:'member-result-'+identity.runId,resultHash:sha256(JSON.stringify(result))});
   if(lose){lose=false;throw new Error('Synthetic accepted request lost its response');}
  }
  if(packet.op==='cancel')facts.set(identity.runId,{identity,state:'cancelled',reserved:false,stopRequested:true,units:[],pending:[]});
  return {data:packet.op==='readResult'?results.get(identity.runId):facts.get(identity.runId)??null};
 };
 const hdlTransport:HdlTransport=async packet=>{
  if(!online)throw new Error('Synthetic member disconnected');
  if(packet.op==='hdl_readiness'){
   const response=await hdl.transport(packet);return {data:{...response.data,recoveryGeneration:nodeGeneration}};
  }
  const identity='identity' in packet?packet.identity:packet.request.identity;
  assert.equal(identity.recoveryGeneration,nodeGeneration);
  return hdl.transport(packet);
 };
 const node:ExecutionNode={nodeId,label:'Member '+nodeId,recoveryGeneration:nodeGeneration,runner,hdlTransport};
 return {node,hdl,online(value:boolean){online=value;},loseNext(){lose=true;},submits:()=>submits,diagnosticCalls:()=>diagnosticCalls};
}

test('member node bindings survive C consumer replacement and replay with a different selected node',async()=>{
 const f=await fixture(),a=memberNode('a'),b=memberNode('b');let shared:Awaited<ReturnType<typeof createDigitalLogicApplication>>|undefined;
 try{
  const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student,false);
  await f.host.shutdown();const {runner:_runner,hdlTransport:_hdl,...settings}=f.settings;
  const nodes=[a.node,b.node];shared=await createDigitalLogicApplication({...settings,executionNodes:nodes});f.app=shared.app;
  assert.equal((await f.app.inject({url:'/api/execution-nodes'})).statusCode,401);
  const registry=await f.app.inject({url:'/api/execution-nodes',headers:selected(student,'a')});
  assert.deepEqual(registry.json().data,{nodes:[{nodeId:'a',label:'Member a',cReady:true,hdlReady:true},{nodeId:'b',label:'Member b',cReady:true,hdlReady:true}],selectedNodeId:'a'});
  const state=await view(f,student,item.attemptId),input={expectedAttemptRevision:state.attempt.attemptRevision,snapshotId:item.snapshotId,mode:'run',runtimeProfileVersion:profile.runtimeProfileVersion,entryFileId:state.files[0].fileId,input:{operation:'stats',fileIds:[state.files[0].fileId]}};
  const count=()=>f.db.withTransaction(tx=>tx.all('SELECT job_id FROM jobs').length);
  const before=count();assert.equal((await command(f,student,`/api/attempts/${item.attemptId}/runs`,input)).statusCode,422);assert.equal(count(),before);
  const first=await command(f,selected(student,'a'),`/api/attempts/${item.attemptId}/runs`,input,'same-run');assert.equal(first.statusCode,200,first.body);
  const ack=first.json().data.result,job=()=>f.db.withTransaction(tx=>readJobs(tx,'course').find(job=>job.jobId===ack.jobId)!);
  assert.deepEqual(job().execution,{nodeId:'a',nodeGeneration:a.node.recoveryGeneration});assert.equal(job().recoveryGeneration,'generation');
  const originalJob=job();assert.throws(()=>f.db.withTransaction(tx=>saveJob(tx,{...originalJob,execution:{nodeId:'b',nodeGeneration:b.node.recoveryGeneration}})),{code:'INVALID_REFERENCE'});
  a.loseNext();await shared.workspace.processJob(ack.jobId);assert.equal(job().status,'outcome_unknown');assert.equal(a.submits(),1);
  const replay=await command(f,selected(student,'b'),`/api/attempts/${item.attemptId}/runs`,input,'same-run');assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().data.result.runId,ack.runId);
  // A fresh worker has no HTTP context or previous in-memory registry; only persisted Job.execution selects A.
  const replacement=createWorkspaceWorker({...settings,currentGeneration:()=> 'generation',execution:executionNodes(nodes)});
  await replacement.processJob(ack.jobId);assert.equal(job().status,'succeeded');assert.equal(a.submits(),1);assert.equal(b.submits(),0);
  assert.equal((await view(f,student,item.attemptId)).runs[0].runId,ack.runId);
  const stored=f.db.withTransaction(tx=>tx.get('SELECT submission_json,result_json FROM workspace_runs WHERE run_id=?',ack.runId)!);
  assert.equal(JSON.parse(String(stored.submission_json)).identity.recoveryGeneration,a.node.recoveryGeneration);
  assert.equal(JSON.parse(String(stored.result_json)).recoveryGeneration,a.node.recoveryGeneration);
  const projected=await f.app.inject({url:`/api/attempts/${item.attemptId}/runs/${ack.runId}`,headers:student});assert.equal(projected.statusCode,200,projected.body);
  assert.equal(projected.json().data.runId,ack.runId);assert.equal(projected.json().data.snapshotId,item.snapshotId);
  const resultFiles=await f.app.inject({url:`/api/attempts/${item.attemptId}/runs/${ack.runId}/files`,headers:student});assert.equal(resultFiles.statusCode,200,resultFiles.body);assert.equal(resultFiles.json().data.status,'available');
 }finally{await shared?.shutdown();await f.close();}
});

test('HDL build, program, interaction and stop stay on the original member across browser selection changes',async()=>{
 const f=await fixture(),a=memberNode('a'),b=memberNode('b');let shared:Awaited<ReturnType<typeof createDigitalLogicApplication>>|undefined;
 try{
  const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student);
  await f.host.shutdown();const {runner:_runner,hdlTransport:_hdl,...settings}=f.settings;
  shared=await createDigitalLogicApplication({...settings,executionNodes:[a.node,b.node],studentHelp:{...settings.studentHelp,budgetAvailable:()=>true}});f.app=shared.app;
  const revision=async()=> (await view(f,student,item.attemptId)).attempt.attemptRevision;
  const build=await command(f,selected(student,'a'),`/api/attempts/${item.attemptId}/hdl/builds`,{expectedAttemptRevision:await revision(),snapshotId:item.snapshotId},'build-a');assert.equal(build.statusCode,200,build.body);
  await shared.consumeOnce();
  const program=await command(f,selected(student,'b'),`/api/attempts/${item.attemptId}/hdl/programs`,{expectedAttemptRevision:await revision(),buildId:build.json().data.result.buildId});assert.equal(program.statusCode,200,program.body);await shared.consumeOnce();
  const sessionId=program.json().data.result.sessionId;
  let session=(await f.app.inject({url:`/api/hdl/sessions/${sessionId}`,headers:student})).json().data;
  assert.equal(session.status,'active');assert.equal(session.identity.recoveryGeneration,a.node.recoveryGeneration);
  const callsB=b.hdl.calls(),input={expectedAttemptRevision:await revision(),sessionId,expectedSessionRevision:session.sessionRevision,expectedSequence:1,inputs:{switches:'0'.repeat(16),buttons:'00001',resetN:'1'},advanceCycles:3};
  const operation=await command(f,selected(student,'b'),`/api/attempts/${item.attemptId}/hdl/interactions`,input);assert.equal(operation.statusCode,200,operation.body);
  a.hdl.loseNext();await shared.consumeOnce();await shared.consumeOnce();
  session=(await f.app.inject({url:`/api/hdl/sessions/${sessionId}`,headers:student})).json().data;assert.equal(session.confirmedSequence,1);assert.equal(b.hdl.calls(),callsB);
  const jobs=f.db.withTransaction(tx=>readJobs(tx,'logic-course'));assert(jobs.every(job=>job.execution?.nodeId==='a'&&job.execution.nodeGeneration===a.node.recoveryGeneration&&job.recoveryGeneration==='generation'));
  const head=await view(f,student,item.attemptId);
  assert.equal(head.jobs.length,jobs.length);
  for(const stored of jobs){
   const projected=head.jobs.find((job:{jobId:string})=>job.jobId===stored.jobId);
   assert.deepEqual(projected.execution,stored.execution);assert.equal(projected.recoveryGeneration,'generation');
   const single=await f.app.inject({url:`/api/jobs/${stored.jobId}`,headers:student});assert.equal(single.statusCode,200,single.body);
   assert.deepEqual(single.json().data.execution,stored.execution);assert.equal(single.json().data.recoveryGeneration,'generation');
  }
  const help=await command(f,selected(student,'b'),`/api/attempts/${item.attemptId}/help`,{expectedAttemptRevision:await revision(),question:'给当前板卡结果一点提示',
   hdlSelection:{snapshotId:item.snapshotId,buildId:build.json().data.result.buildId,sessionId,operationId:operation.json().data.result.operationId}});assert.equal(help.statusCode,200,help.body);
  const provider=new SyntheticProvider([request=>({body:{kind:'student_help',actionType:'hint',content:'请核对当前输入与段选输出。',rationale:'依据已确认的板卡操作。',expectedStudentAction:'自行比较相同输入的输出。',
   evidenceIds:[(request.untrustedInput as {references:{id:string}[]}).references[0]!.id],resourceRefs:[],assistanceContext:'当前获准HDL版本。',unresolved:[],policyChecks:{containsWholeSolution:false,writesStudentWork:false,runsCode:false,makesFormalEvaluation:false}}})]);
  const helped=await shared.tutoring.processJob(help.json().data.result.jobId,provider);assert.equal(helped.outcome.outcome,'success');assert.equal(provider.calls.length,1);
  const afterHelp=await view(f,student,item.attemptId),events=await f.app.inject({url:`/api/attempts/${item.attemptId}/events?clientId=member-hdl-help&recoveryGeneration=generation&decisionEpoch=${afterHelp.attempt.decisionEpoch}`,headers:student});assert.equal(events.statusCode,200,events.body);
  const guidance=events.json().data.events.find((event:{payload?:{content?:string}})=>event.payload?.content);assert(guidance);assert.deepEqual(guidance.payload.basis.hdl.execution,{nodeId:'a',nodeGeneration:a.node.recoveryGeneration});
  const stop=await command(f,selected(student,'b'),`/api/attempts/${item.attemptId}/hdl/controls`,{expectedAttemptRevision:await revision(),action:'stop',reason:'synthetic member test'});assert.equal(stop.statusCode,200,stop.body);
  session=(await f.app.inject({url:`/api/hdl/sessions/${sessionId}`,headers:student})).json().data;assert.equal(session.terminationConfirmed,true);assert.equal(b.hdl.calls(),callsB);
 }finally{await shared?.shutdown();await f.close();}
});

test('all PCs offline allow a cloud cold start, authenticated reads and saves but refuse new execution',async()=>{
 const f=await fixture(),a=memberNode('a');let shared:Awaited<ReturnType<typeof createDigitalLogicApplication>>|undefined;
 try{
  const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student,false);await f.host.shutdown();
  a.online(false);const {runner:_runner,hdlTransport:_hdl,...settings}=f.settings;
  shared=await createDigitalLogicApplication({...settings,executionNodes:[a.node]});f.app=shared.app;
  assert.equal((await f.app.inject({url:'/health/live'})).statusCode,200);
  shared.startConsumer(50);await new Promise(resolve=>setTimeout(resolve,10));assert.equal((await f.app.inject({url:'/health/ready'})).statusCode,200);
  assert.equal((await f.app.inject({url:'/api/courses',headers:student})).statusCode,200);
  const state=await view(f,student,item.attemptId),file=state.files[0];
  const sync=await command(f,student,`/api/attempts/${item.attemptId}/sync`,{expectedWorkspaceRevision:state.attempt.workspaceRevision,clientId:'cloud-offline',clientSeq:1,operations:[{kind:'update',fileId:file.fileId,baseVersion:file.documentVersion,text:'int main(void){return 1;}'}]});assert.equal(sync.statusCode,200,sync.body);
  const registry=(await f.app.inject({url:'/api/execution-nodes',headers:student})).json().data;assert.equal(registry.nodes[0].cReady,false);assert.equal(registry.nodes[0].hdlReady,false);
  const run=await command(f,selected(student,'a'),`/api/attempts/${item.attemptId}/runs`,{expectedAttemptRevision:state.attempt.attemptRevision,snapshotId:item.snapshotId,mode:'run',runtimeProfileVersion:profile.runtimeProfileVersion,entryFileId:file.fileId,input:{operation:'stats',fileIds:[file.fileId]}});assert.equal(run.statusCode,422,run.body);assert.equal(a.submits(),0);
 }finally{await shared?.shutdown();await f.close();}
});

test('node registration never silently reassigns legacy jobs or accepts a changed node generation',()=>{
 const a=memberNode('a'),routing=executionNodes([a.node]);
 assert.throws(()=>routing.forJob({recoveryGeneration:'generation'} as never));
 assert.throws(()=>routing.node({nodeId:'a',nodeGeneration:'other-generation'}));
 assert.throws(()=>executionNodes([a.node,a.node]));
});

test('member draft diagnostics use only the selected node and its real generation without persisting a run',async()=>{
 const f=await fixture(),a=memberNode('a'),b=memberNode('b');let shared:Awaited<ReturnType<typeof createDigitalLogicApplication>>|undefined;
 try{
  const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student,false);await f.host.shutdown();
  const {runner:_runner,hdlTransport:_hdl,...settings}=f.settings;
  shared=await createDigitalLogicApplication({...settings,executionNodes:[a.node,b.node]});f.app=shared.app;
  const before=await view(f,student,item.attemptId),source=before.files[0];
  const input={workspaceRevision:before.attempt.workspaceRevision,captureRevision:before.attempt.captureRevision,fileId:source.fileId,
   files:before.files.map((file:{fileId:string;documentVersion:number;contentHash:string;text:string})=>({fileId:file.fileId,documentVersion:file.documentVersion,contentHash:file.contentHash,text:'int value = ;\n'}))};
  const counts=()=>f.db.withTransaction(tx=>['jobs','command_receipts','artifact_snapshots','workspace_process_records'].map(table=>tx.get(`SELECT count(*) AS n FROM ${table}`)!.n)),originalCounts=counts();
  const path=`/api/attempts/${item.attemptId}/editor-diagnostics`;
  const missing=await command(f,student,path,input);assert.equal(missing.statusCode,200,missing.body);assert.equal(missing.json().data.status,'unavailable');
  assert.equal((await command(f,selected(student,'unknown'),path,input)).json().data.status,'unavailable');
  assert.equal(a.diagnosticCalls(),0);assert.equal(b.diagnosticCalls(),0);
  const analyzed=await command(f,selected(student,'b'),path,input);assert.equal(analyzed.statusCode,200,analyzed.body);assert.equal(analyzed.json().data.status,'ready');
  assert.equal(analyzed.json().data.diagnostics[0].message,'Synthetic draft analysis by b');assert.equal(a.diagnosticCalls(),0);assert.equal(b.diagnosticCalls(),1);
  assert.deepEqual((await view(f,student,item.attemptId)).files,before.files);assert.deepEqual(counts(),originalCounts);
  b.online(false);const unavailable=await command(f,selected(student,'b'),path,input);assert.equal(unavailable.statusCode,200,unavailable.body);assert.equal(unavailable.json().data.status,'unavailable');assert.equal(a.diagnosticCalls(),0);
  const saved=await command(f,student,`/api/attempts/${item.attemptId}/sync`,{expectedWorkspaceRevision:before.attempt.workspaceRevision,clientId:'member-diagnostic-draft',clientSeq:1,
   operations:[{kind:'update',fileId:source.fileId,baseVersion:source.documentVersion,text:'int value;\n'}]});assert.equal(saved.statusCode,200,saved.body);
  const routing=executionNodes([a.node]);await assert.rejects(routing.node({nodeId:'a',nodeGeneration:a.node.recoveryGeneration}).runner({op:'editor_diagnostics',packet:{recoveryGeneration:'wrong-node-generation',scope:{userId:'student',courseId:'course',attemptId:item.attemptId},fileId:source.fileId,language:'c',snapshot:{snapshotId:'transient',hashFormat:'sha256-manifest-v1',hash:'a'.repeat(64),files:[]}}}),{code:'RECOVERY_REQUIRED'});
 }finally{await shared?.shutdown();await f.close();}
});

test('a hung member readiness probe is bounded and does not hide another ready member',async()=>{
 const f=await fixture(),a=memberNode('a'),b=memberNode('b');let shared:Awaited<ReturnType<typeof createDigitalLogicApplication>>|undefined;
 try{
  const student=await f.login();await f.host.shutdown();const {runner:_runner,hdlTransport:_hdl,...settings}=f.settings;
  const unavailable:ExecutionNode={...a.node,runner:()=>new Promise(()=>{}),hdlTransport:()=>new Promise(()=>{})};
  shared=await createDigitalLogicApplication({...settings,executionNodes:[unavailable,b.node]});f.app=shared.app;
  const start=performance.now(),response=await f.app.inject({url:'/api/execution-nodes',headers:selected(student,'b')});
  assert.equal(response.statusCode,200,response.body);assert(performance.now()-start<6000,'registry must finish before the browser request timeout');
  assert.deepEqual(response.json().data,{nodes:[{nodeId:'a',label:'Member a',cReady:false,hdlReady:false},{nodeId:'b',label:'Member b',cReady:true,hdlReady:true}],selectedNodeId:'b'});
 }finally{await shared?.shutdown();await f.close();}
});
