import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createUserQuestions } from '../../packages/agents/dist/capabilities/user-questions/index.js';
import { verifyProjectCreation } from '../../packages/agents/dist/student-assistant/creation-policy.js';
import { createLearningTools } from '../../packages/agents/dist/student-assistant/tools/learning-tools.js';
import { buildContext } from '../../packages/agent-runtime/dist/context.js';
import { createModelAdapter } from '../../packages/agent-runtime/dist/model.js';
import { StorageError } from '../../packages/storage/dist/index.js';
import { harness, input as userInput } from './harness.mjs';

const output = [];
const identity = { kind: 'personal', name: '审查测试', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
const target = { environmentId: identity.environmentId, serviceId: randomUUID(), version: 1 };
const content = { title: '排序练习', goal: '理解排序', stages: [{ title: '练习', goal: '完成排序' }], materialRefs: [] };
const proposalKey = 'audit-proposal';
const baseCtx = () => ({ identity, sessionId: randomUUID(), turnId: randomUUID(), stepId: randomUUID(), toolCallId: randomUUID(), inputIds: [randomUUID()], originInputId: randomUUID(), visibleAnswerInputIds: [], signal: new AbortController().signal });
const record = (overrides={}) => ({ questionId: randomUUID(), version: 2, state: 'answered', purpose: 'create_personal_project', proposalKey,
  question: '确认创建个人项目「排序练习」？', options: [{ id: 'confirm', label: '同意创建' }, { id: 'decline', label: '暂不创建' }],
  allowText: true, skippable: true, createdAt: new Date().toISOString(), personalProjectContent: content,
  answer: { kind: 'choice', optionId: 'confirm' }, sourceInputId: randomUUID(), answerInputId: null, ...overrides });
const budget = { maxSteps: 16, maxToolCalls: 64, maxInputTokens: 1_048_576, maxOutputTokens: 65_536, maxCallMs: 600_000, deadline: new Date(Date.now()+86_400_000).toISOString() };
const zeroUsage = { inputTokens: 0, outputTokens: 0, inputReserved: 0, outputReserved: 0 };

// Direct calls to the production tool and policy: a misleading model label becomes authorization.
{
  const ctx = baseCtx(); let saved;
  const q = { question: '是否暂不创建项目？', source: '项目确认', options: [{ id: 'confirm', label: '暂不创建' }, { id: 'decline', label: '同意创建' }],
    allowText: true, skippable: true, purpose: 'create_personal_project', proposalKey, personalProjectContent: content };
  await createUserQuestions().execute({ toolCallId: ctx.toolCallId, nativeCallId: 'q', callIndex: 0, name: 'student_ask', input: q, executionMode: 'foreground' },
    { ...ctx, async ask(value) { saved=value.presentation; return { kind: 'answered', questionId: value.presentation.questionId, version: 2, answer: {kind:'choice',optionId:'confirm'} }; } });
  const decision=await verifyProjectCreation(ctx,identity,content,proposalKey,{ findByProposal:async()=>[record({questionId:saved.questionId,sourceInputId:saved.sourceInputId,answerInputId:ctx.inputIds[0]})]});
  assert.equal(saved.options[0].label,'同意创建'); assert.equal(decision.kind,'allow');
  output.push({case:'creation_label_mismatch',displayedSelection:saved.options[0],decision});
}

// Session snapshots order questions by creation time; per-question versions do not rank different questions.
{
  const older=record(), newer=record({answer:{kind:'choice',optionId:'decline'}});
  const decision=await verifyProjectCreation(baseCtx(),identity,content,proposalKey,{findByProposal:async()=>[older,newer]});
  assert.equal(decision.kind,'confirmation_required');
  output.push({case:'duplicate_proposal_is_ambiguous',olderAnswer:'confirm',newerAnswer:'decline',versions:[older.version,newer.version],decision:decision.kind});
}

// A tool-only next Step has no newly adopted inputs. The actual ask omits sourceInputId.
{
  const ctx={...baseCtx(),inputIds:[]}; let saved;
  await createUserQuestions().execute({toolCallId:ctx.toolCallId,nativeCallId:'q2',callIndex:0,name:'student_ask',executionMode:'foreground',
    input:{question:'创建排序项目吗？',source:'项目确认',options:[{id:'confirm',label:'同意创建'},{id:'decline',label:'暂不创建'}],allowText:true,skippable:true,purpose:'create_personal_project',proposalKey,personalProjectContent:content}},
    {...ctx,async ask(value){saved=value.presentation;return {kind:'answered',questionId:value.presentation.questionId,version:2,answer:{kind:'choice',optionId:'confirm'}};}});
  assert.ok(saved.sourceInputId);
  output.push({case:'ask_after_tool_step',sourceInputIdPresent:Object.hasOwn(saved,'sourceInputId')});
}

// A real answer accepted one Step earlier is no longer in inputIds despite remaining in model history.
{
  const id=randomUUID(), ctx=baseCtx(), facts=[record({answer:{kind:'text',text:'同意创建'},answerInputId:id})], questions={findByProposal:async()=>facts};
  const immediate=await verifyProjectCreation({...ctx,inputIds:[id]},identity,content,proposalKey,questions);
  const later=await verifyProjectCreation({...ctx,inputIds:[],visibleAnswerInputIds:[id]},identity,content,proposalKey,questions);
  assert.equal(immediate.kind,'allow');assert.equal(later.kind,'allow');
  output.push({case:'free_text_after_intervening_step',immediate:immediate.kind,later:later.kind});
}

function creationFixture({pending=false,abortOnProject=false}={}) {
  const ctx=baseCtx(), controller=new AbortController(), questionId=randomUUID();ctx.signal=controller.signal;
  ctx.assertActive=async()=>{if(controller.signal.aborted)throw new StorageError('cancelled');};
  const projects=new Map(), sessions=new Map();const events=[];let ensureCalls=0;
  const host={localPersonalIdentity:identity,localLearningTarget:target,query:{},questions:{findByProposal:async()=>[record({questionId,sourceInputId:ctx.inputIds[0],answerInputId:ctx.inputIds[0]})]},
    projects:{receipt:async(_id,id)=>projects.get(id)??null,create:async(_id,value)=>{const p={...value,projectId:randomUUID(),activityId:randomUUID(),workspaceSessionId:randomUUID(),identity,target,createdAt:new Date().toISOString()};projects.set(value.operationId,p);events.push('project');if(abortOnProject)controller.abort();return p;}},
    workspaceSessions:{receipt:async(_id,id)=>sessions.get(id)??null,ensure:async(_id,value)=>{ensureCalls++;events.push('workspace:aborted='+ctx.signal.aborted);const s={sessionId:value.sessionId,activityId:value.activityId,target,ready:!pending||ensureCalls>1};sessions.set(s.sessionId,s);return s;}},
    materials:{receipt:async()=>null,adopt:async(_id,value)=>{events.push('materials:aborted='+ctx.signal.aborted);return{requestId:value.requestId,activityId:value.activityId,references:value.references};}}};
  const tool=createLearningTools(host).find(t=>t.definition.name==='create_personal_project');
  const call={toolCallId:ctx.toolCallId,nativeCallId:'create',callIndex:0,name:'create_personal_project',executionMode:'foreground',input:{...content,proposalKey}};
  return{ctx,events,projects,execute:()=>tool.execute(call,ctx),ensureCalls:()=>ensureCalls};
}
{
  const f=creationFixture({pending:true});const first=await f.execute(),second=await f.execute();
  assert.equal(f.ensureCalls(),2);assert.equal(second.outcome,'success');
  output.push({case:'partial_project_retry_reensures',ensureCalls:f.ensureCalls(),projectCount:f.projects.size,first:first.data.pending,second:second.data.pending});
}
{
  const f=creationFixture({abortOnProject:true});const result=await f.execute();
  assert.deepEqual(f.events,['project']);
  output.push({case:'project_writes_stop_after_abort',events:f.events,outcome:result.outcome,pending:result.data.pending});
}

const basicScenario={id:'audit',version:1,context:async()=>({system:'audit',facts:{},sources:[]}),tools:async()=>[]};
{
  const ctx={...baseCtx(),sessionState:{}};
  const notifications=Array.from({length:8},(_,i)=>({notificationId:'notification-'+i,taskId:'notice-task-'+i,taskVersion:'v1',terminalStatus:'success',summary:'done',resultRef:null}));
  const plan=await buildContext({store:{sessionState:async()=>({}),visibleInputs:async()=>[]},gateway:{selection:{read:async()=>({selected:false})}},scenario:basicScenario, signal:ctx.signal,
    taskFacts:{relevant:async()=>[{taskId:'explicit-task',taskVersion:'v1',status:'running',summary:'running',name:'explicit',resultRef:null,priority:0}]},budget,spent:zeroUsage},ctx,{inputs:[],notifications});
  assert.equal(plan.notificationIds.length,8);assert(plan.text.includes('notice-task-7'));
  output.push({case:'adopted_notifications_enter_context',adoptedIds:plan.notificationIds,lastTask:'notice-task-7',prompt:plan.text});
}
{
  const ctx={...baseCtx(),sessionState:{}};
  const notifications=[{notificationId:'old',taskId:'same-task',taskVersion:'v1',terminalStatus:'failed',summary:'old failure',resultRef:null},
    {notificationId:'new',taskId:'same-task',taskVersion:'v2',terminalStatus:'success',summary:'new success',resultRef:null}];
  const plan=await buildContext({store:{sessionState:async()=>({}),visibleInputs:async()=>[]},gateway:{selection:{read:async()=>({selected:false})}},scenario:basicScenario,signal:ctx.signal,budget,spent:zeroUsage},ctx,{inputs:[],notifications});
  assert(!plan.text.includes('old failure'));assert(plan.text.includes('new success'));
  output.push({case:'latest_task_version_wins',consumed:plan.notificationIds,prompt:plan.text});
}

// Production compaction is invoked three times in one Turn, despite maxPerTurn:1 and exhausted input budget.
{
  let state={history:[{id:randomUUID(),version:1,role:'user',text:'old'}]},calls=0,billingCalls=0,compactionUsed=0;
  const store={sessionState:async()=>state,setSessionState:async(_id,s)=>{state=s;},visibleInputs:async()=>[],compactionCount:async()=>compactionUsed,budgetOf:async()=>({budget:{...budget},usage:{...zeroUsage}}),appendEvent:async()=>{},saveAttempt:async()=>{billingCalls++;compactionUsed++;},finishAttempt:async()=>{billingCalls++;}};
  const gateway={selection:{read:async()=>({selected:true,version:1}),snapshot:async()=>({choice:{connection:{maxOutputTokens:100,contextWindow:100}}}),pin:async()=>{}},
    segments:{create:async(_identity,s)=>({segmentId:s.segmentId,sequence:0})},
    checks:{receive:async()=>({state:'accepted'}),dispatch:async()=>{calls++;return{state:'completed',physicalRequestEnded:true,text:'{}',usage:{state:'final',inputTokens:50,outputTokens:5},resultRef:randomUUID()};}}};
  const scenario={...basicScenario,compaction:{maxPerTurn:1,needed:()=>true,select:history=>({messages:history,remainder:[],sourceDigest:randomUUID(),sourceVersions:{retainedIds:[]},retainedDigest:'x',policy:{maxSummaryTokens:10}}),provider:{prompt:()=>({system:'summary',text:'summarize'}),parse:()=>({summary:'summary'})}}};
  const ctx={...baseCtx(),sessionState:{}};
  for(let i=0;i<3;i++)await buildContext({store,gateway,scenario,signal:ctx.signal,budget,spent:zeroUsage},
    {...ctx,stepId:randomUUID()},{inputs:[],notifications:[]});
  assert.equal(calls,1);assert.ok(billingCalls>0);
  output.push({case:'compaction_respects_maxPerTurn',sameTurnDispatches:calls,configuredMaxPerTurn:1,billingCalls});
}

// The stub follows the real chat-work.publish lifecycle: a failed attempt closes and advances its segment.
{
  let state={},s,dispatched=0,received=0,attempts=0;
  const connection={routeId:randomUUID(),version:1,maxOutputTokens:100,contextWindow:1000};
  const store={sessionState:async()=>state,setSessionState:async(_id,v)=>{state=v;},visibleInputs:async()=>[],compactionCount:async()=>0,budgetOf:async()=>({budget:{...budget},usage:{...zeroUsage}}),saveAttempt:async()=>{attempts++;},finishAttempt:async()=>{}};
  const gateway={selection:{read:async()=>({selected:true,version:1}),snapshot:async()=>({choice:{connection}}),pin:async()=>{}},
    segments:{create:async(_id,v)=>{s={segmentId:v.segmentId,sequence:0,closed:false};return structuredClone(s);},read:async()=>structuredClone(s),close:async()=>{s.closed=true;}},
    checks:{receive:async(_id,v)=>{received++;if(s.closed||s.sequence!==v.expectedSequence)throw new StorageError('conflict');return{state:'accepted'};},
      dispatch:async()=>{dispatched++;s={...s,sequence:s.sequence+1,closed:true};return dispatched===1
      ? {state:'failed',reason:'rate-limited',physicalRequestEnded:true,usage:{state:'final',inputTokens:0,outputTokens:0},resultRef:null}
      : {state:'completed',physicalRequestEnded:true,text:'retried',toolIntents:[],usage:{state:'final',inputTokens:10,outputTokens:5},resultRef:randomUUID(),segment:{segmentId:s.segmentId,sequence:s.sequence}};}}};
  const model=createModelAdapter(gateway,store,{retryBackoffMs:[0,0]});const ctx=baseCtx();let error;
  try{await model.generate({...ctx,system:'audit',tools:[],history:[],text:'hello',images:[],toolResults:[],budget,spent:zeroUsage});}catch(e){error=e.code;}
  assert.ok(dispatched>=2);assert.equal(error,undefined);
  output.push({case:'real_gateway_lifecycle_retry_succeeds',dispatched,received,attempts,error});
}

if(process.env.XUNJIE_PRODUCT_POSTGRES_BIN){
  const h=await harness([{text:'done'}],[]);
  try{
    const receipt=await h.runtime.submit(h.identity,userInput(h.session.sessionId,'计费审查'));
    await h.settle();
    const {rows:[row]}=await h.storage.read('SELECT usage FROM agent_turns WHERE turn_id=$1',[receipt.turnId]);
    const snap=await h.runtime.sessionSnapshot(h.identity,h.session.sessionId);
    assert.equal(row.usage.inputTokens,10);assert.equal(row.usage.outputTokens,5);
    output.push({case:'real_pg_non_negative_turn_usage',usage:row.usage,attempt:snap.attempts.map(a=>({usage:a.usage,reserved:a.reserved}))});
  }finally{await h.close();}
  const h2=await harness([{unknown:true},{text:'what should I do?'}],[]);
  try{
    const text='请分析这一条唯一原始需求_AUDIT';
    await h2.runtime.submit(h2.identity,userInput(h2.session.sessionId,text));await h2.settle();
    const before=(await h2.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1',[h2.session.sessionId])).rows[0].state;
    await h2.runtime.continueSession(h2.identity,h2.session.sessionId,randomUUID());await h2.settle();
    const after=(await h2.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1',[h2.session.sessionId])).rows[0].state;
    assert(JSON.stringify(after.history??[]).includes(text));
    output.push({case:'real_pg_failed_generation_retains_input_on_continue',beforeHistory:before.history??[],afterHistory:after.history??[],originalInputInHistory:true});
  }finally{await h2.close();}
}

console.log(JSON.stringify(output,null,2));
