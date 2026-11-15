import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { harness, input } from './harness.mjs';
import { createWorkspaceAssistant } from '../../packages/agents/dist/workspace-assistant/index.js';
import { teachingDefinitions } from '../../packages/agents/dist/workspace-assistant/tools/tools-schema.js';
import { compileOutputSchema } from '../../packages/model-gateway/dist/chat-native.js';
import { createWorkspaceAgentTasks, createLearningSpaceTaskOwner } from '../../packages/product-runtime/dist/workspace-agent-tasks.js';
import { createAgentDependencyService } from '../../packages/agents/dist/transport/session-dependencies.js';

// Actual public schema plus actual Gateway AJV compiler, no copied validator.
const definition = teachingDefinitions({ activity: { course: { components: [{ key:'lab', definition: {
 digest:'a'.repeat(64), manifest:{formatVersion:1, operations:[{operationId:'run', parameters:{type:'object',properties:{}}}]}
} }] } }, input:{draft:{references:[]}} }).find(t=>t.name==='course_operation');
assert.ok(definition);
const validate = compileOutputSchema(definition.inputSchema);
const arguments_ = {componentKey:'lab',operationId:'run',parameters:{}};
assert.equal(validate(arguments_), true);
assert.equal(validate({...arguments_,executionMode:'background'}), true);
const backgroundErrors=structuredClone(validate.errors);
assert.equal(validate({...arguments_,executionMode:'foreground'}), true);
console.log(JSON.stringify({repro:'T3 schema',defaultAccepted:true,backgroundAccepted:true,foregroundAccepted:true}));

// Actual workspace scene + concrete read_teaching_artifact + real Agent PG, scripted Gateway only.
let activity;
const scene = createWorkspaceAssistant({
 workspace:async()=>activity,
 learning:{open:async()=>activity,drafts:{verifyReferences:async()=>{}},artifacts:{list:async()=>[]}},
 courses:{},compaction:false,
});
const workspace = await harness([
 {text:'先检查教学内容',toolIntents:[{callId:'artifact-list',name:'read_teaching_artifact',arguments:{artifactId:null,revisionId:null}}]},
 {text:'没有教学内容',toolIntents:[]}
],[],{}, {scenario:scene});
try {
 activity={activityId:randomUUID(),identity:workspace.identity,target:{environmentId:workspace.identity.environmentId,serviceId:randomUUID(),version:1},
  goal:'审查工作区',question:'列出教学内容',references:[],status:'open',createdAt:new Date().toISOString()};
 let modelCalls=0;
 const receive=workspace.gateway.checks.receive;
 workspace.gateway.checks.receive=async(...args)=>{modelCalls++;return receive(...args);};
 const message=input(workspace.session.sessionId,'列出教学内容');
 message.context={action:{requestId:message.requestId, receiver:{receiverId:'agent-session:'+workspace.session.sessionId,kind:'question',location:'remote'},
  scope:{environmentId:workspace.identity.environmentId,spaceId:workspace.identity.spaceId,principalId:workspace.identity.principalId,activityId:activity.activityId},
  draft:{token:randomUUID(),question:message.text,references:[],bases:[]},works:[],evidence:[]}};
 const receipt=await workspace.runtime.submit(workspace.identity,message);
 await workspace.runtime.drain();
 const snapshot=await workspace.runtime.sessionSnapshot(workspace.identity,workspace.session.sessionId);
 const turn=snapshot.turns.find(t=>t.turnId===receipt.turnId);
 assert.equal(snapshot.toolCalls.length,1);
 assert.equal(snapshot.toolCalls[0].result.kind,'completed');
 assert.equal(snapshot.toolCalls[0].result.outcome,'success');
 assert.equal(modelCalls,2);
 assert.equal(turn.state,'completed');
 assert.equal(snapshot.steps.length,2);
 console.log(JSON.stringify({repro:'T1 actual workspace Step2',modelCalls,turnState:turn.state,reason:turn.reason,steps:snapshot.steps.map(s=>({index:s.index,state:s.state,inputIds:s.snapshot.inputIds})),toolResults:snapshot.toolCalls.map(c=>c.result)}));
} finally {await workspace.close();}

// Actual bridge and owner adapter: a caller's untrusted structured taskId makes owner read as victim.
let bridge;
const h=await harness([{text:'任务事实已读取',toolIntents:[]}],[],{}, {taskFacts:{relevant:(...args)=>bridge.taskFacts.relevant(...args)}});
try {
 const victim={...h.identity,principalId:randomUUID(),spaceId:randomUUID(),name:'另一个用户'};
 const victimSession=randomUUID(),victimTurn=randomUUID(),taskId=randomUUID(),activityId=randomUUID();
 const secret='VICTIM_PRIVATE_NOTE_ONLY_B_SHOULD_SEE';
 const asWho=[];
 const association={runId:victimTurn,stepId:randomUUID(),commandId:taskId,snapshotId:randomUUID()};
 const owner=createLearningSpaceTaskOwner({
  storage:{read:async(sql,args)=>({rows:args[0]===taskId?[{command_id:taskId,request_id:taskId,activity_id:activityId,association,
   body_text:JSON.stringify({execution:{operation:{operationId:'private-lab'}}}),identity:victim}]:[]})},
  executions:{read:async(identity,act,id)=>{assert.equal(identity.principalId,victim.principalId);assert.equal(act,activityId);assert.equal(id,taskId);asWho.push(identity.principalId);
   return {state:'failed',statusKnowledge:'confirmed',confirmedSeq:7,reason:{detail:secret},output:{contentId:randomUUID()},executionRef:randomUUID()};},agent:{stop:async()=>{}}},
  sessionIdOfTurn:async(turn)=>{assert.equal(turn,victimTurn);return victimSession;}
 });
 bridge=createWorkspaceAgentTasks({storage:h.storage,owner,registerNotification:async()=>{throw Error('unused');}});
 let modelText=''; const receive=h.gateway.checks.receive;
 h.gateway.checks.receive=async(identity,request)=>{modelText=request.input.text;return receive(identity,request);};
 const message=input(h.session.sessionId,'查询此任务');message.context={taskId};
 await h.runtime.submit(h.identity,message);await h.runtime.drain();
 assert.equal(modelText.includes(secret),false);
 assert.equal(asWho.length,0);
 console.log(JSON.stringify({repro:'T6 task facts cross-identity',caller:h.identity.principalId,taskOwner:victim.principalId,queriedAs:asWho,secretPresentInCallerModelInput:modelText.includes(secret),ownerQueries:asWho.length}));
} finally {bridge?.closeDispatch();await h.close();}


// A control operation owns its own taskId and completes from its receipt while the parent runs.
{
 const identity={...h.identity}, sessionId=randomUUID(), turnId=randomUUID(), controlId=randomUUID();
 const parentRequestId=randomUUID(), activityId=randomUUID(), executionRef=randomUUID();
 const association={runId:turnId,stepId:randomUUID(),commandId:controlId,snapshotId:randomUUID()};
 const controlOwner=createLearningSpaceTaskOwner({
  storage:{read:async(sql,args)=>{
   if(sql.includes('WHERE c.command_id')) return {rows:args[0]===controlId?[{command_id:controlId,request_id:parentRequestId,activity_id:activityId,association,
     body_text:JSON.stringify({execution:{operation:{operationId:'advance'}}}),kind:'control',identity}]:[] };
   if(sql.includes("WHERE kind IN ('submit','control')")) return {rows:[{command_id:controlId}]};
   return {rows:[]};
  }},
  executions:{read:async()=>{throw Error('a control must not read the parent execution as its task fact');},
   controlReceipt:async(_identity,_activity,requestId,id)=>{assert.equal(requestId,parentRequestId);assert.equal(id,controlId);
    return {status:'applied',seq:3,executionRef};},agent:{stop:async()=>{throw Error('must not stop the parent for a control task');}}},
  sessionIdOfTurn:async(turn)=>{assert.equal(turn,turnId);return sessionId;}
 });
 const record=await controlOwner.read(controlId,{sessionId,identity});
 assert.equal(record.taskId,controlId);
 assert.equal(record.taskId===parentRequestId,false);
 assert.equal(record.state,'succeeded');
 assert.equal(record.originTurnId,turnId);
 const listed=await controlOwner.listByOriginTurn(sessionId,turnId);
 assert.equal(listed.length,1);
 assert.equal(listed[0].taskId,controlId);
 let controlCancelled=false,parentStops=0;
 const cancelOwner=createLearningSpaceTaskOwner({
  storage:{
   read:async(sql,args)=>{
    if(sql.includes('WHERE c.command_id')) return {rows:args[0]===controlId?[{command_id:controlId,request_id:parentRequestId,activity_id:activityId,association,
      body_text:JSON.stringify({execution:{operation:{operationId:'advance'}}}),kind:'control',cancelled:controlCancelled,identity}]:[] };
    if(sql.includes("WHERE kind IN ('submit','control')")) return {rows:[{command_id:controlId}]};
    return {rows:[]};
   },
   request:async(_options,run)=>{await run({query:async(sql)=>{if(sql.startsWith('UPDATE agent_execution_commands')) controlCancelled=true;}});},
  },
  executions:{read:async()=>({state:'running',statusKnowledge:'confirmed',confirmedSeq:3,reason:null,output:null,executionRef}),controlReceipt:async()=>({status:'applied',seq:3,executionRef}),
   agent:{stop:async()=>{parentStops++;throw Error('must not stop the parent session');}}},
  sessionIdOfTurn:async()=>sessionId
 });
 await cancelOwner.cancel(controlId);
 const cancelledRecord=await cancelOwner.read(controlId,{sessionId,identity});
 assert.equal(controlCancelled,true,'control operation is cancelled in its own command row');
 assert.equal(cancelledRecord.state,'cancelled');
 assert.equal(parentStops,0,'parent session remains untouched by control cancellation');
 console.log(JSON.stringify({repro:'T7 control task owner',taskId:record.taskId,parentRequestId,state:record.state,originTurnId:record.originTurnId,
  cancelledState:cancelledRecord.state,parentStops}));
}


// The authenticated dependency service exposes task read/list/cancel only for the caller's own Session.
{
 const identity={...h.identity}, sessionId=randomUUID(), turnId=randomUUID(), taskId=randomUUID();
 const sourceOwnerTarget={environmentId:identity.environmentId,serviceId:randomUUID(),version:1};
 const session={identity,sessionId,state:'ready',deleted:false,owner:{target:sourceOwnerTarget,installationId:randomUUID()}};
 const record={taskId,activityId:randomUUID(),identity,sessionId,originTurnId:turnId,state:'running',
  statusKnowledge:'unknown',confirmedSeq:0,name:'课程任务',summary:'执行中',resultRef:null};
 const calls=[];
 const service=createAgentDependencyService({
  sessions:{read:async()=>session},learning:{open:async()=>({})},courses:{},isOwnerSuccessor:async()=>true,
  authorize:async()=>{},assertDispatch:async()=>{},
  tasks:{
   read:async(who,sid,id)=>{calls.push(['read',who.principalId,sid,id]);assert.equal(sid,sessionId);return record;},
   list:async(who,sid,id)=>{calls.push(['list',who.principalId,sid,id]);assert.equal(sid,sessionId);return [record];},
   cancel:async(who,sid,id)=>{calls.push(['cancel',who.principalId,sid,id]);assert.equal(sid,sessionId);},
  }
 });
 const readCall={version:2,operation:'tasks',identity,sessionId,args:{method:'read',taskId}};
 const source={assertAuthorized:async()=>{},sourceEnvironmentId:sourceOwnerTarget.environmentId,sourceServiceId:sourceOwnerTarget.serviceId,sourceInstallationId:session.owner.installationId};
 const read=await service(readCall,source);
 assert.equal(read.taskId,taskId);
 const listCall={...readCall,args:{method:'list',turnId}};
 const list=await service(listCall,source);
 assert.equal(list.length,1);
 const cancelCall={...readCall,args:{method:'cancel',taskId}};
 await service(cancelCall,source);
 assert.deepEqual(calls.map(c=>c[0]),['read','list','cancel']);
 const seen=[];
 const readPdf={definition:{name:'read_pdf',description:'PDF reader',inputSchema:{type:'object',properties:{documentId:{type:'string'}}}},
  supportsBackground:false, execute:async(call,ctx)=>{seen.push({call,ctx});return {kind:'completed',outcome:'success',summary:'真实工具已执行'};}};
 const toolService=createAgentDependencyService({
  sessions:{read:async()=>session},learning:{open:async()=>({})},courses:{},isOwnerSuccessor:async()=>true,
  authorize:async()=>{},assertDispatch:async()=>{},tools:async()=>[readPdf]
 });
 const toolCall={version:2,operation:'tools.execute',identity,sessionId,
  permit:{sessionId,runId:turnId,stepId:randomUUID(),operationId:randomUUID(),generation:1},
  args:{module:{id:'read_pdf',version:1},context:{sessionId,turnId,stepId:randomUUID(),toolCallId:randomUUID(),
   context:{system:'test',facts:{},sources:[]},inputIds:[randomUUID()],sessionState:{workspaceInputs:[]}},
   call:{toolCallId:randomUUID(),nativeCallId:'pdf-1',callIndex:0,name:'read_pdf',input:{documentId:randomUUID()},executionMode:'foreground'}}};
 const toolResult=await toolService(toolCall,source);
 assert.equal(toolResult.kind,'completed');
 assert.equal(toolResult.summary,'真实工具已执行');
 assert.equal(seen.length,1);
 assert.equal(seen[0].ctx.sessionId,sessionId);
 assert.equal(seen[0].call.input.documentId,toolCall.args.call.input.documentId);
 console.log(JSON.stringify({repro:'T2 remote tool execution',calls:calls.map(c=>c[0]),sessionId,taskId,executed:seen.length,tool:saw(seen[0])}));
 function saw(entry){return entry?'read_pdf':'none';}
}
