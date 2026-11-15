import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTeachingTools } from '../../packages/agents/dist/workspace-assistant/tools/tools.js';
import { accumulatorPackage } from '../../components/state-accumulator/package.mjs';
const {manifest}=await accumulatorPackage({version:1});
const identity={kind:'personal',name:'A',environmentId:randomUUID(),spaceId:randomUUID(),principalId:randomUUID()};
const activityId=randomUUID(),parentRequestId=randomUUID(),executionRef=randomUUID(),originTurnId=randomUUID();
const actionScope={environmentId:identity.environmentId,spaceId:identity.spaceId,principalId:identity.principalId,activityId};
const binding={key:'counter',definition:{digest:'a'.repeat(64),manifest},configuration:{title:'累加器'},materialIds:[]};
const activity={activityId,identity,status:'open',course:{releaseId:randomUUID(),components:[binding]}};
const action={requestId:randomUUID(),scope:actionScope,receiver:{receiverId:'test',kind:'question',location:'local'},
 draft:{token:'test',question:'advance',references:[],bases:[]},works:[],evidence:[]};
const query={requestId:parentRequestId,executionRef,scope:actionScope,statusKnowledge:'confirmed',state:'running',session:{observations:[],appliedSeq:1}};
let receiptReads=0,queryReads=0,cancelCalls=0,currentControlId;
const original={action:{receiver:{location:'local'},execution:{instance:{key:'counter',definitionDigest:'a'.repeat(64)}}},association:{runId:originTurnId}};
const learning={open:async()=>activity,executions:{
 controlReceipt:async()=>{receiptReads++;return {controlId:currentControlId,requestId:parentRequestId,executionRef,query,status:receiptReads===1?'dispatching':'applied'};},
 agent:{original:async()=>original,control:async()=>query,read:async()=>{queryReads++;return query;},
 cleanup:async()=>{cancelCalls++;return null;},cleanupStatus:async()=>({cancelled:true,claimed:true,browserId:randomUUID()})}
}};
const host=createTeachingTools({learning:()=>learning,courses:{verifyComponentReference:async()=>{} }});
const scope={identity,activity,input:action,runId:randomUUID(),stepId:randomUUID(),snapshotId:randomUUID(),attemptId:randomUUID(),assertDispatch:async()=>{}};
const controller=new AbortController();
const ctx={identity,sessionId:randomUUID(),turnId:scope.runId,stepId:scope.stepId,toolCallId:randomUUID(),signal:controller.signal,inputIds:[randomUUID()],ask:async()=>{throw Error('unused');}};
const call={toolCallId:ctx.toolCallId,nativeCallId:'control',callIndex:0,name:'course_operation',executionMode:'foreground',
 input:{componentKey:'counter',operationId:'advance',parameters:{value:1},requestId:parentRequestId,expectedSeq:0}};
currentControlId=call.toolCallId;
const realNow=Date.now;
let ticks=-1;
Date.now=()=>++ticks*300000;
let result;
try {result=await host.execute(scope,call,ctx);} finally {Date.now=realNow;}
assert.equal(receiptReads,2,'polls the control receipt until it is applied');
assert.equal(cancelCalls,0,'does not cancel the parent session when the operation applied');
assert.equal(result.kind,'completed');
assert.equal(result.outcome,'success');
console.log(JSON.stringify({repro:'T7 control operation vs session',receiptReads,queryReads,cancelCalls,parentState:query.state,result}));
const bgIds=[];
for(let i=0;i<2;i++){
 const nextCall={...call,toolCallId:randomUUID(),executionMode:'background'};currentControlId=nextCall.toolCallId;
 const outcome=await host.execute(scope,nextCall,{...ctx,toolCallId:nextCall.toolCallId});bgIds.push(outcome.taskId);
}
assert.equal(new Set(bgIds).size,2,'each background control has its own taskId');
assert.ok(bgIds.every(id=>id!==parentRequestId),'a control taskId is not the parent requestId');
console.log(JSON.stringify({repro:'T7 control operation vs session',receiptReads,cancelCalls,result,bgIds,originTurnId,currentTurnId:scope.runId}));
