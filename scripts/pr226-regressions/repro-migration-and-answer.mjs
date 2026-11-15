import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { nativeFixture } from '../../packages/storage/test/native-fixture.mjs';
import { createFileBackend, openStorage, provisionStorage } from '../../packages/storage/dist/index.js';
import { chunkChannelMigrationSql } from '../../packages/storage/dist/chunk-channel.js';
import { agentRuntimeMigrations, createAgentStore, validateAgentRuntime } from '../../packages/agent-runtime/dist/index.js';
import { agentServiceMigrations, validateAgentServiceStorage } from '../../packages/agents/dist/transport/session-storage.js';
import { operationId } from '../../packages/storage/dist/identity.js';

const pg = await nativeFixture();
const handles=[];
try {
  // Reconstruct the exact published base service tail: runtime 1..8 + transport 9.
  const legacy = [...agentRuntimeMigrations.slice(0,8), {version:9,name:'agent-session-transport-v2',sql:chunkChannelMigrationSql}];
  const opts={admin:pg.admin,owner:{environmentId:randomUUID(),serviceId:randomUUID()},password:randomUUID()};
  const binding=await provisionStorage({...opts,migrations:legacy});
  const backend=createFileBackend({id:'migration-repro',root:join(pg.root,'migration-resources')});
  const old=await openStorage({binding,backend,migrations:legacy}); handles.push(old);
  await old.participant().closeWrites(); await old.participant().closeDispatch();
  const before=(await old.read('SELECT version,name,checksum FROM _storage_migrations ORDER BY version')).rows;
  await provisionStorage({...opts,migrations:agentServiceMigrations});
  const after=(await old.read('SELECT version,name,checksum FROM _storage_migrations ORDER BY version')).rows;
  assert.deepEqual(after.filter(row=>row.version<9),before.filter(row=>row.version<9));
  assert.equal(after.find(row=>row.version===9)?.name,'agent-turn-loop');
  assert.ok(after.some(row=>row.version===10));
  console.log(JSON.stringify({case:'baseline_service_upgrade',actual:'upgrade succeeds',transportTailPreserved:before.at(-1),migrationRows:after.length,currentTail:agentServiceMigrations.slice(-2).map(({name,version,formerVersion})=>({name,version,formerVersion}))}));
  // A precise in-memory patch confirms the existing displaced-tail mechanism is sufficient.
  const patched=agentServiceMigrations.map(m=>m.name==='agent-session-transport-v2'?{...m,formerVersion:9}:m);
  await provisionStorage({...opts,migrations:patched});
  const migrated=await openStorage({binding,backend,migrations:patched}); handles.push(migrated);
  console.log(JSON.stringify({case:'add_formerVersion_9_in_memory',actual:'upgrade succeeded',newTail:(await migrated.read('SELECT version,name FROM _storage_migrations ORDER BY version')).rows.slice(-2)}));

  const owner={environmentId:randomUUID(),serviceId:randomUUID()};
  const answerBinding=await provisionStorage({admin:pg.admin,owner,password:randomUUID(),migrations:agentServiceMigrations});
  const storage=await openStorage({binding:answerBinding,backend:createFileBackend({id:'answer-repro',root:join(pg.root,'answer-resources')}),migrations:agentServiceMigrations}); handles.push(storage);
  const store=createAgentStore(storage,{ownerInstanceId:'answer-repro-host'});
  const session={sessionId:randomUUID(),identity:{kind:'personal',name:'审查',environmentId:owner.environmentId,spaceId:randomUUID(),principalId:randomUUID()},scenario:'student-assistant',createdAt:new Date().toISOString()};
  await store.initialize(session);
  const receipt=await store.submitInput({requestId:randomUUID(),sessionId:session.sessionId,text:'请问我一个问题',context:{}});
  const opened=await store.openStep(receipt.turnId,{});
  assert.equal(opened.kind,'step');
  const stepId=opened.step.stepId, attemptId=randomUUID(), toolCallId=randomUUID();
  await store.saveAttempt(stepId,{attemptId,attemptNo:1,requestRef:null,reserved:{inputTokens:1,outputTokens:1}});
  await store.saveResponse(stepId,attemptId,{text:'',toolIntents:[{callId:'q1',name:'student_ask',arguments:{}}],resultRef:null},[{toolCallId,nativeCallId:'q1',name:'student_ask',input:{},executionMode:'foreground'}]);
  await store.startToolCall(toolCallId);
  const questionId=operationId('agent-question:'+toolCallId);
  await store.saveQuestion({questionId,sessionId:session.sessionId,turnId:receipt.turnId,stepId,toolCallId,presentation:{question:'是否继续？',source:'审查',options:[],allowText:true,skippable:true},deadline:null});
  await validateAgentServiceStorage(storage);
  const answerRequestId=randomUUID();
  await store.answerQuestion(session.sessionId,{requestId:answerRequestId,questionId,expectedVersion:1,answer:{kind:'text',text:'请继续'}});
  await validateAgentRuntime(storage);
  await validateAgentServiceStorage(storage);
  console.log(JSON.stringify({case:'answer_preserves_source_closure',runtimeValid:true,serviceValid:true,actualInputId:(await storage.read('SELECT input_id FROM agent_inputs WHERE request_id=$1',[answerRequestId])).rows[0].input_id,inputReceipt:!!(await storage.receipt('agent-input:'+answerRequestId)),answerReceipt:!!(await storage.receipt('agent-answer:'+answerRequestId))}));

  const pendingReq=randomUUID();
  const pending=await store.submitInput({requestId:pendingReq,sessionId:session.sessionId,text:'稍后也检查这个输入',context:{}});
  await store.stopTurn(session.sessionId,receipt.turnId,randomUUID());
  const original=await store.request(session.sessionId,pendingReq);
  console.log(JSON.stringify({case:'deferred_retry_has_no_state',storedState:(await storage.read('SELECT state FROM agent_inputs WHERE request_id=$1',[pendingReq])).rows[0].state,returnedKeys:Object.keys(original.receipt),returnedHasState:'state' in original||'state' in original.receipt}));
} finally {
  for (const h of handles.reverse()) await h.close();
  await pg.close();
}
