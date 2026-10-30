import assert from 'node:assert/strict';
import { test } from 'node:test';
import {crc32} from 'node:zlib';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createApp } from '../app.ts';
import { ApiError } from '../app/errors.ts';
import { createPersonalAgentService } from './service.ts';
import { openPersonalAgentStore } from './store.ts';
import { openCredential, sealCredential } from './credentials.ts';
import { CompatibleRequestError } from '../tutoring/openai-compatible.ts';
import { InputLimitError } from '../tutoring/providers.ts';
import { fixture as digitalLogicFixture, allocate as allocateDigitalLogic, command as digitalLogicCommand } from '../../tests/dl-a-support.ts';
import { readStudentTasks } from './student-tasks.ts';
import type { CompatibleMessage, CompatibleTransport } from './types.ts';

const secret='offline-test-secret-NEVER-RETURN-FULL';
const provider={id:'test',name:'Offline integration provider',baseUrl:'https://public.example/v1',apiKey:secret,
  models:[{id:'test-model',contextWindow:'16000',maxOutput:'4096',inputTypes:[],reasoningLevels:[]}]};
const settings=(overrides:Record<string,unknown>={})=>({expectedRevision:0,enabled:true,defaultModelId:'custom:test:test-model',providers:[provider],...overrides});
const pause=()=>new Promise<void>(resolve=>setImmediate(resolve));
const image={name:'sample.png',dataUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC'};

test('three accounts share two upstream slots; an idempotent waiting turn can be cancelled without a call',async t=>{
  const started:string[]=[],releases:Array<()=>void>=[];
  const fixture=await setup({...immediateTransport,async complete({selection}){
    started.push(selection.userId);await new Promise<void>(resolve=>releases.push(resolve));return {text:'done'};
  }});
  t.after(async()=>{for(const release of releases)release();await fixture.cleanup();});
  for(const user of ['alice','bob','carol'])await fixture.request('POST','/api/model-settings',settings(),user);
  const turns:any[]=[];
  for(const user of ['alice','bob','carol'])turns.push((await fixture.request('POST','/api/agent/turns',
    {conversationId:null,mode:'send',text:'one bounded question',requestKey:'shared-budget'},user)).body.data);
  await pause();assert.deepEqual(started,['alice','bob']);
  const repeated=await fixture.request('POST','/api/agent/turns',
    {conversationId:null,mode:'send',text:'one bounded question',requestKey:'shared-budget'},'carol');
  assert.equal(repeated.body.data.turnId,turns[2].turnId);
  assert.equal(repeated.body.data.message.phase,'waiting');
  await fixture.request('POST',`/api/agent/turns/${turns[2].turnId}/stop`,{},'carol');
  for(const release of releases)release();await pause();await pause();
  assert.deepEqual(started,['alice','bob']);
  assert.equal((await fixture.request('GET',`/api/agent/turns/${turns[2].turnId}`,undefined,'carol')).body.data.message.phase,'stopped');
});

test('history identifies only the original live turn for refresh recovery; reads never call the provider',async t=>{
  let release!:(value:{text:string})=>void,calls=0;
  const fixture=await setup({...immediateTransport,async complete(input){calls++;input.onText?.('first chunk');return new Promise(resolve=>{release=resolve;});}});
  t.after(fixture.cleanup);const {request}=fixture;
  await request('POST','/api/model-settings',settings());
  const accepted=(await request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'recover',requestKey:'recover-original'})).body.data;
  await pause();
  const path=`/api/agent/conversations/${accepted.conversationId}`;
  const history=(await request('GET',path)).body.data;
  assert.equal(history.activeTurnId,accepted.turnId);
  assert.equal(history.messages.at(-1).text,'first chunk');
  assert.equal((await request('GET',path,undefined,'bob')).status,403);
  assert.equal((await request('GET',`/api/agent/turns/${history.activeTurnId}`)).body.data.turnId,accepted.turnId);
  assert.equal(calls,1);
  release({text:'first chunk completed'});await pause();
  assert.equal((await request('GET',path)).body.data.activeTurnId,undefined);
  assert.equal(calls,1);
});

test('image-only messages reach the provider as pixels, survive history/edit/retry and retain account isolation',async t=>{
  const requests:any[]=[];
  const fixture=await setup({...immediateTransport,async complete(input){requests.push(input.messages);return {text:'vision reply'};}});
  t.after(fixture.cleanup);const {request}=fixture;
  await request('POST','/api/model-settings',settings({providers:[{...provider,models:[{...provider.models[0],inputTypes:['image']}]}]}));
  const input={conversationId:null,mode:'send',text:'',images:[image],requestKey:'image-one'};
  const accepted=await request('POST','/api/agent/turns',input);assert.equal(accepted.status,200);
  const {conversationId,turnId}=accepted.body.data;await pause();
  assert.deepEqual(requests[0][1].content,[{type:'image_url',image_url:{url:image.dataUrl}}]);
  assert.equal((await request('POST','/api/agent/turns',input)).body.data.turnId,turnId);assert.equal(requests.length,1);
  assert.equal((await request('POST','/api/agent/turns',{...input,images:[{...image,name:'different.png'}]})).status,409);
  const history=(await request('GET',`/api/agent/conversations/${conversationId}`)).body.data;
  assert.deepEqual(history.messages[0].images,[image]);
  assert.equal((await request('GET',`/api/agent/conversations/${conversationId}`,undefined,'bob')).status,403);
  await request('POST',`/api/agent/conversations/${conversationId}/edit`,{messageIndex:0,text:'Describe it',expectedMessageHash:messageHash(history.messages[0])});
  await request('POST','/api/agent/turns',{conversationId,mode:'retry',requestKey:'image-retry'});await pause();
  assert.deepEqual(requests[1][1].content,[{type:'text',text:'Describe it'},{type:'image_url',image_url:{url:image.dataUrl}}]);
  await request('POST','/api/model-settings',settings({expectedRevision:1}));
  assert.equal((await request('POST','/api/agent/turns',{conversationId,mode:'send',text:'again',requestKey:'image-text-only'})).status,422);
  assert.equal(requests.length,2);assert.equal((await request('GET',`/api/agent/conversations/${conversationId}`)).body.data.messages.length,2);
});

test('invalid image bytes, MIME spoofing, URLs and unsupported models are rejected before recording or billing',async t=>{
  let calls=0;
  const fixture=await setup({...immediateTransport,async complete(){calls++;return {text:'unexpected'};}});t.after(fixture.cleanup);
  const {request}=fixture;
  await request('POST','/api/model-settings',settings({providers:[{...provider,models:[{...provider.models[0],inputTypes:['image']}]}]}));
  for(const dataUrl of ['https://example.com/image.png','data:image/svg+xml;base64,PHN2Zy8+','data:image/png;base64,aGVsbG8=',image.dataUrl.replace('image/png','image/jpeg')]){
    assert.equal((await request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'inspect',images:[{...image,dataUrl}],requestKey:dataUrl.slice(0,100)})).status,400);
  }
  assert.deepEqual((await request('GET','/api/agent/conversations')).body.data,[]);assert.equal(calls,0);
});
const messageHash=(message:{role:string;text:string;at?:string})=>createHash('sha256').update(JSON.stringify([message.role,message.text,message.at??null])).digest('hex');
const immediateTransport:CompatibleTransport={async complete(){return {text:'actual fake transport result'};},async test(){return {ok:true,latencyMs:1,modelCount:1};}};

async function setup(transport:CompatibleTransport=immediateTransport,
  readStudentTasks?:(userId:string)=>{tasks:{assignmentId:string;courseId:string;courseName?:string;title:string;availability:'active'|'paused'}[];hasMore:boolean}){
  const directory=mkdtempSync(join(tmpdir(),'xunjie-personal-integration-'));
  const service=createPersonalAgentService({directory,transport,...(readStudentTasks?{readStudentTasks}:{}),authorize(request){
    const user=request.headers['x-test-user'];if(typeof user!=='string')throw new ApiError('UNAUTHENTICATED');return user;
  }}),app=createApp();service.register(app);await app.ready();
  const request=async(method:'GET'|'POST',url:string,payload?:unknown,user='alice')=>{
    const result=await app.inject({method,url,headers:{'x-test-user':user},...(payload===undefined?{}:{payload:payload as object})});
    return {status:result.statusCode,body:result.json() as {data:any;error?:{code:string}}};
  };
  async function cleanup(){await service.close();await app.close();assert.ok(directory.startsWith(join(tmpdir(),'xunjie-personal-integration-')));rmSync(directory,{recursive:true,force:true});}
  return {directory,service,app,request,cleanup};
}

test('task question receives current account assignments without inventing completion, while unrelated chat sends no task data',async t=>{
  const prompts:unknown[]=[];const reads:string[]=[];
  const fixture=await setup({...immediateTransport,async complete(input){prompts.push(input.messages);return {text:'synthetic reply'};}},userId=>{
    reads.push(userId);
    return {tasks:[{assignmentId:'own-assignment',courseId:'course-c',courseName:'C',title:`${userId} 的 TextScope Core`,availability:'active'}],hasMore:false};
  });
  t.after(fixture.cleanup);const {request}=fixture;
  await request('POST','/api/model-settings',settings());
  await request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'你好',requestKey:'hello'});await pause();
  assert.deepEqual(reads,['alice']);
  assert.doesNotMatch(JSON.stringify(prompts[0]),/own-assignment|TextScope Core/);
  await request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'我该怎么做一道数学题？',requestKey:'generic-how-to'});await pause();
  assert.doesNotMatch(JSON.stringify(prompts[1]),/own-assignment|TextScope Core/);
  await request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'我现在有什么任务还没完成',requestKey:'tasks'});await pause();
  assert.ok(reads.every(userId=>userId==='alice'));
  assert.match(JSON.stringify(prompts[2]),/own-assignment|TextScope Core/);
  assert.match(JSON.stringify(prompts[2]),/完成状态未知/);
});

test('task lookup failure rejects the turn before recording a question or calling the provider',async t=>{
  let calls=0;
  const fixture=await setup({...immediateTransport,async complete(){calls++;return {text:'unexpected'};}},()=>{
    throw new Error('Synthetic course read failed');
  });
  t.after(fixture.cleanup);const {request}=fixture;
  await request('POST','/api/model-settings',settings());
  const failed=await request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'我现在有什么任务还没完成',requestKey:'tasks-failure'});
  assert.equal(failed.status,503);
  assert.deepEqual((await request('GET','/api/agent/conversations')).body.data,[]);
  assert.equal(calls,0);
});

test('a settled reply gets one durable card only for a uniquely named assignment in its authenticated snapshot',async t=>{
  let reply='',hasMore=false,fail=false;const reads:string[]=[];
  const assignments=[
    {assignmentId:'assignment-a',courseId:'course-a',courseName:'数字逻辑',title:'同步计数器',availability:'active' as const},
    {assignmentId:'assignment-b',courseId:'course-b',courseName:'程序设计',title:'文件索引器',availability:'paused' as const},
  ];
  const fixture=await setup({...immediateTransport,async complete(input){
    if(fail){input.onText?.('同步计数器的部分回答');throw new Error('Synthetic provider failure');}
    return {text:reply};
  }},userId=>{
    reads.push(userId);
    return {tasks:userId==='alice'?assignments:[],hasMore};
  });t.after(fixture.cleanup);
  const {request}=fixture;await request('POST','/api/model-settings',settings());
  const send=async(text:string,key:string)=>{
    const accepted=await request('POST','/api/agent/turns',{conversationId:null,mode:'send',text,requestKey:key});
    assert.equal(accepted.status,200);await pause();
    const turn=(await request('GET',`/api/agent/turns/${accepted.body.data.turnId}`)).body.data;
    const history=(await request('GET',`/api/agent/conversations/${accepted.body.data.conversationId}`)).body.data;
    assert.deepEqual(turn.message.taskCard,history.messages.at(-1).taskCard);
    return {turn,history};
  };
  reply='同步计数器可以先画状态图。';
  const single=await send('我该怎么做同步计数器？','single-task-card');
  assert.deepEqual(single.turn.message.taskCard,{assignmentId:'assignment-a',courseName:'数字逻辑',title:'同步计数器',availability:'active'});
  assert.equal((await request('GET',`/api/agent/conversations/${single.turn.conversationId}`,undefined,'bob')).status,403);
  reply='同步计数器和文件索引器都在你的任务列表。';
  assert.equal((await send('我有哪些任务？','multiple-task-cards')).turn.message.taskCard,undefined);
  reply='可以先画状态图。';
  assert.equal((await send('我该怎么做同步计数器？','no-reply-reference')).turn.message.taskCard,undefined);
  reply='普通回答。';
  assert.equal((await send('你好','ordinary-chat')).turn.message.taskCard,undefined);
  assert.ok(reads.length>=4&&reads.every(userId=>userId==='alice'));
  reply='同步计数器可以先画状态图。';
  assert.deepEqual((await send('这个状态图画法呢？','answer-references-task')).turn.message.taskCard,single.turn.message.taskCard);
  hasMore=true;
  assert.equal((await send('同步计数器怎么做？','partial-task-snapshot')).turn.message.taskCard,undefined);
  hasMore=false;fail=true;
  const failed=await send('同步计数器怎么做？','failed-task-reply');
  assert.equal(failed.turn.message.phase,'failed');
  assert.equal(failed.turn.message.taskCard,undefined);
  fail=false;
  assignments.push({assignmentId:'assignment-c',courseId:'course-a',courseName:'数字逻辑',title:'同步计数器',availability:'active'});
  reply='同步计数器可以先画状态图。';
  assert.equal((await send('我该怎么做同步计数器？','ambiguous-task-card')).turn.message.taskCard,undefined);
});

test('independent chat folds repeated HDL ALU allocations into one workspace card',async t=>{
  const course=await digitalLogicFixture();t.after(()=>course.close());
  const teacher=await course.login('teacher');
  const student=await course.login('student');
  const source=await allocateDigitalLogic(course,teacher,student);
  const fixed=course.db.withTransaction(tx=>tx.get('SELECT activity_json FROM activity_versions WHERE id=?',source.activityId));
  assert.ok(fixed);
  const baseContent=(JSON.parse(String(fixed.activity_json)) as {draft:{content:Record<string,unknown>}}).draft.content;
  assert.notEqual(baseContent.projectTitle,'四位算术逻辑单元');
  const publish=async(problem=String(baseContent.problem))=>{
    const draft=await digitalLogicCommand(course,teacher,'/api/courses/logic-course/blueprints',{
      mode:'manual',content:{...baseContent,problem},
    });
    assert.equal(draft.statusCode,200,draft.body);
    const blueprintId=String(draft.json().data.result.draft.blueprintId);
    const checks=await digitalLogicCommand(course,teacher,`/api/blueprints/${blueprintId}/checks`,{expectedRevision:1});
    assert.equal(checks.statusCode,200,checks.body);
    assert.deepEqual(checks.json().data.result.report.blocking,[]);
    const release=await digitalLogicCommand(course,teacher,`/api/blueprints/${blueprintId}/releases`,{expectedRevision:1,confirmed:true});
    assert.equal(release.statusCode,200,release.body);
    const activityId=String(release.json().data.result.activityVersionId);
    const allocation=await digitalLogicCommand(course,teacher,`/api/activities/${activityId}/assignments`,{
      expectedActivityControlRevision:1,studentIds:['student'],
    });
    assert.equal(allocation.statusCode,200,allocation.body);
    return String(allocation.json().data.result.assignments[0].assignmentId);
  };
  const duplicateIds:string[]=[source.assignmentId];
  for(let index=1;index<4;index++)duplicateIds.push(await publish());
  course.db.withTransaction(tx=>{
    for(const id of duplicateIds)tx.run('UPDATE assignments SET display_title=? WHERE id=?','四位算术逻辑单元',id);
  });
  const preferred=duplicateIds.toSorted().at(-1)!;
  const visible=readStudentTasks(course.db,'student');
  assert.equal(visible.hasMore,false);
  assert.deepEqual(visible.tasks.filter(task=>task.title==='四位算术逻辑单元').map(task=>task.assignmentId),[preferred]);
  const summaries=await course.app.inject({url:'/api/courses/logic-course/assignments',headers:student});
  assert.equal(summaries.statusCode,200,summaries.body);
  assert.equal(summaries.json().data.length,4);
  assert.ok(summaries.json().data.every((summary:{executionKind:string})=>summary.executionKind==='hdl_board'));

  const prompts:CompatibleMessage[][]=[];
  const agent=await setup({...immediateTransport,async complete(input){
    prompts.push(input.messages);return {text:'四位算术逻辑单元可以先核对输入与预期结果。'};
  }},userId=>readStudentTasks(course.db,userId));
  t.after(agent.cleanup);
  const {request}=agent;
  await request('POST','/api/model-settings',settings(), 'student');
  const accepted=await request('POST','/api/agent/turns',{
    conversationId:null,mode:'send',text:'四位算术逻辑单元这个任务情况怎么样',requestKey:'alu-visible',
  },'student');
  assert.equal(accepted.status,200);await pause();
  const turn=(await request('GET',`/api/agent/turns/${accepted.body.data.turnId}`,undefined,'student')).body.data;
  const history=(await request('GET',`/api/agent/conversations/${accepted.body.data.conversationId}`,undefined,'student')).body.data;
  assert.equal(turn.message.taskCard?.assignmentId,preferred);
  assert.deepEqual(history.messages.at(-1).taskCard,turn.message.taskCard);
  const prompt=JSON.stringify(prompts[0]);
  assert.match(prompt,/四位算术逻辑单元/);
  assert.ok(duplicateIds.filter(id=>prompt.includes(id)).length===1);
  assert.ok(!prompt.includes('PRIVATE_BODY'));
  const workspace=await course.app.inject({url:`/api/assignments/${preferred}/bootstrap`,headers:student});
  assert.equal(workspace.statusCode,200,workspace.body);

  const paused=await digitalLogicCommand(course,teacher,`/api/assignments/${preferred}/controls`,{
    expectedAssignmentRevision:1,action:'pause',reason:'Synthetic availability change',
  });
  assert.equal(paused.statusCode,200,paused.body);
  assert.equal(readStudentTasks(course.db,'student').tasks.find(task=>task.title==='四位算术逻辑单元')?.assignmentId,
    duplicateIds.toSorted().at(-2));

  const different=await publish('A changed ALU learning goal');
  course.db.withTransaction(tx=>tx.run('UPDATE assignments SET display_title=? WHERE id=?','四位算术逻辑单元',different));
  const separate=readStudentTasks(course.db,'student').tasks.filter(task=>task.title==='四位算术逻辑单元');
  assert.deepEqual(separate.map(task=>task.assignmentId).toSorted(),[duplicateIds.toSorted().at(-2)!,different].toSorted());
});

test('an inline image above Fastify default body size remains sendable and durable after a service restart',async t=>{
  const fixture=await setup();t.after(fixture.cleanup);const {request,directory}=fixture;
  await request('POST','/api/model-settings',settings({providers:[{...provider,models:[{...provider.models[0],inputTypes:['image']}]}]}));
  const png=Buffer.from(image.dataUrl.split(',')[1]!, 'base64'),data=Buffer.concat([Buffer.from('Comment\0'),Buffer.alloc(1100000,65)]);
  const chunk=Buffer.alloc(data.length+12);chunk.writeUInt32BE(data.length);chunk.write('tEXt',4);data.copy(chunk,8);chunk.writeUInt32BE(crc32(chunk.subarray(4,-4)),chunk.length-4);
  const large={name:'large.png',dataUrl:'data:image/png;base64,'+Buffer.concat([png.subarray(0,-12),chunk,png.subarray(-12)]).toString('base64')};
  const accepted=await request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'inspect',images:[large],requestKey:'large'});
  assert.equal(accepted.status,200);await pause();await fixture.service.close();
  const restarted=createPersonalAgentService({directory,transport:immediateTransport,authorize(){return 'alice';}}),app=createApp();restarted.register(app);await app.ready();
  try {
    const restored=(await app.inject({method:'GET',url:`/api/agent/conversations/${accepted.body.data.conversationId}`})).json();
    assert.deepEqual(restored.data.messages[0].images,[large]);
  } finally { await restarted.close(); await app.close(); }
});

test('personal settings use CAS, authenticated ownership and encrypted persistent secrets; public reads never return a key',async t=>{
  const fixture=await setup();t.after(fixture.cleanup);
  const {request,service,directory}=fixture;
  assert.equal((await fixture.app.inject({method:'GET',url:'/api/model-settings'})).statusCode,401);
  assert.equal((await request('GET','/api/model-settings')).body.data.revision,0);
  const saved=await request('POST','/api/model-settings',settings());assert.equal(saved.status,200);
  assert.equal(saved.body.data.revision,1);assert.equal(saved.body.data.providers[0].hasKey,true);
  assert.equal(saved.body.data.providers[0].apiKey,undefined);assert.equal(saved.body.data.providers[0].keyHint,'••••FULL');
  assert.ok(!JSON.stringify(saved.body).includes(secret));assert.equal(service.selection('alice')?.apiKey,secret);
  assert.equal(service.selection('bob'),undefined);
  assert.deepEqual((await request('GET','/api/model-settings',undefined,'bob')).body.data.providers,[]);
  assert.equal((await request('POST','/api/model-settings',settings())).status,409);
  const retained=await request('POST','/api/model-settings',settings({expectedRevision:1,providers:[{...provider,apiKey:'   '}]}));
  assert.equal(retained.status,200);assert.equal(service.selection('alice')?.apiKey,secret);
  for(const file of readdirSync(directory).filter(name=>name.startsWith('personal-agent.sqlite'))){
    assert.equal(readFileSync(join(directory,file)).includes(Buffer.from(secret)),false);
  }
  const currentVersion=service.selection('alice')!.version;
  await service.close();
  const restarted=createPersonalAgentService({directory,transport:immediateTransport,authorize(){return 'alice';}});
  t.after(()=>restarted.close());assert.equal(restarted.selection('alice')?.apiKey,secret);assert.equal(restarted.selection('alice')?.version,currentVersion);
  await restarted.close();
});

test('URL structure, duplicate metadata and disabled key clearing are validated without leaking credential material',async t=>{
  const fixture=await setup();t.after(fixture.cleanup);const {request,service}=fixture;
  for(const baseUrl of ['http://public.example/v1','https://user:pass@public.example/v1','https://public.example/v1?key=no','https://public.example/v1#fragment','https://public.example/v1?']){
    assert.equal((await request('POST','/api/model-settings',settings({providers:[{...provider,baseUrl}]}))).status,422);
  }
  assert.equal((await request('POST','/api/model-settings',settings({providers:[provider,provider]}))).status,400);
  await request('POST','/api/model-settings',settings());
  const cleared=await request('POST','/api/model-settings',settings({expectedRevision:1,enabled:false,providers:[{...provider,apiKey:'',clearKey:true}]}));
  assert.equal(cleared.status,200);assert.equal(cleared.body.data.providers[0].hasKey,false);assert.equal(service.selection('alice'),undefined);
  assert.equal((await request('POST','/api/model-settings/test',{providerId:'test'})).status,422);
});

test('turn acceptance is idempotent, account isolated and editing preserves the previous original branch',async t=>{
  let calls=0;
  const transport:CompatibleTransport={...immediateTransport,async complete({onText}){calls++;onText?.('provider partial');return {text:`provider reply ${calls}`};}};
  const fixture=await setup(transport);t.after(fixture.cleanup);const {request,directory}=fixture;
  await request('POST','/api/model-settings',settings());
  const input={conversationId:null,mode:'send',text:'Original question',requestKey:'one'};
  const first=await request('POST','/api/agent/turns',input);assert.equal(first.status,200);
  const {turnId,conversationId}=first.body.data;await pause();
  const replay=await request('POST','/api/agent/turns',input);assert.equal(replay.body.data.turnId,turnId);assert.equal(calls,1);
  assert.equal((await request('POST','/api/agent/turns',{...input,text:'Changed question'})).status,409);
  assert.equal((await request('GET',`/api/agent/conversations/${conversationId}`,undefined,'bob')).status,403);
  assert.equal((await request('GET',`/api/agent/turns/${turnId}`,undefined,'bob')).status,403);
  const original=(await request('GET',`/api/agent/conversations/${conversationId}`)).body.data;
  assert.equal(original.messages[1].text,'provider reply 1');
  const expectedMessageHash=messageHash(original.messages[0]);
  assert.equal((await request('POST',`/api/agent/conversations/${conversationId}/edit`,{messageIndex:0,text:'Edited question',expectedMessageHash})).status,200);
  assert.equal((await request('POST',`/api/agent/conversations/${conversationId}/edit`,{messageIndex:0,text:'STALE SECOND TAB',expectedMessageHash})).status,409);
  const edited=(await request('GET',`/api/agent/conversations/${conversationId}`)).body.data;
  assert.equal(edited.messages.length,1);assert.equal(edited.messages[0].text,'Edited question');assert.equal(edited.title,'Edited question');
  assert.equal(edited.contextTokens,undefined);
  const retried=await request('POST','/api/agent/turns',{conversationId,mode:'retry',requestKey:'retry'});assert.equal(retried.status,200);await pause();
  assert.equal(calls,2);
  const store=openPersonalAgentStore(directory);t.after(()=>store.close());
  const originals=store.all('SELECT message_json FROM agent_messages WHERE conversation_id=?',conversationId).map(row=>String(row.message_json));
  assert.ok(originals.some(text=>text.includes('Original question')));assert.ok(originals.some(text=>text.includes('provider reply 1')));
  const persistedTurns=store.all('SELECT * FROM agent_turns');assert.equal(persistedTurns.length,2);
  assert.equal(JSON.stringify(persistedTurns).includes(secret),false);
  assert.equal(JSON.parse(String(persistedTurns[0]!.turn_json)).modelConfig.model,'test-model');
  await request('POST',`/api/agent/conversations/${conversationId}`,{action:'delete'});
  assert.equal((await request('GET','/api/agent/conversations')).body.data.length,0);
  assert.equal((await request('GET',`/api/agent/conversations/${conversationId}`)).status,403);
  assert.equal(store.all('SELECT * FROM agent_messages').length,4);
  store.close();
});

test('stop persists partial text, rejects late updates and resume is one new provider call with the retained prefix',async t=>{
  let calls=0,lateText:((text:string)=>void)|undefined;
  const transport:CompatibleTransport={...immediateTransport,async complete({onText,messages,signal}){
    calls++;
    if(calls===1){lateText=onText;onText?.('partial ');return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({text:'late completion'}),{once:true}));}
    assert.ok(messages.some(message=>message.role==='assistant'&&message.content==='partial '));
    onText?.('continued');return {text:'continued'};
  }};
  const fixture=await setup(transport);t.after(fixture.cleanup);const {request}=fixture;
  await request('POST','/api/model-settings',settings());
  const first=await request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'question',requestKey:'stop'});await pause();
  const {turnId,conversationId}=first.body.data;
  const stopped=await request('POST',`/api/agent/turns/${turnId}/stop`,{});assert.equal(stopped.body.data.message.text,'partial ');assert.equal(stopped.body.data.message.phase,'stopped');
  lateText?.('LATE RESPONSE MUST NOT REPLACE STOPPED TEXT');await pause();
  assert.equal((await request('GET',`/api/agent/turns/${turnId}`)).body.data.message.text,'partial ');
  const resumed=await request('POST','/api/agent/turns',{conversationId,mode:'resume',requestKey:'resume'});assert.equal(resumed.status,200);await pause();
  const final=await request('GET',`/api/agent/turns/${resumed.body.data.turnId}`);
  assert.equal(final.body.data.message.text,'partial continued');assert.equal(final.body.data.message.phase,'settled');assert.equal(calls,2);
});

test('restarting an unfinished persisted turn marks unknown interruption and never invokes transport',async t=>{
  const fixture=await setup();t.after(fixture.cleanup);const {request,directory,service}=fixture;
  await request('POST','/api/model-settings',settings());
  const first=await request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'question',requestKey:'restart'});await pause();
  const {turnId}=first.body.data;await service.close();
  const store=openPersonalAgentStore(directory),row=store.get('SELECT turn_json FROM agent_turns WHERE turn_id=?',turnId)!;
  const value=JSON.parse(String(row.turn_json));value.status='running';value.callCount=1;value.message.phase='streaming';value.message.text='received partial';
  store.run('UPDATE agent_turns SET turn_json=? WHERE turn_id=?',JSON.stringify(value),turnId);store.close();
  let calls=0;const restarted=createPersonalAgentService({directory,authorize(){return 'alice';},transport:{...immediateTransport,async complete(){calls++;return {text:'must not happen'};}}});
  t.after(()=>restarted.close());
  const persisted=openPersonalAgentStore(directory);t.after(()=>persisted.close());
  const recovered=JSON.parse(String(persisted.get('SELECT turn_json FROM agent_turns WHERE turn_id=?',turnId)!.turn_json));
  assert.equal(recovered.status,'failed');assert.equal(recovered.message.failure.code,'INTERRUPTED');assert.equal(recovered.message.text,'received partial');assert.equal(calls,0);
  persisted.close();await restarted.close();
});

test('credential encryption is bound to the owning account and provider',()=>{
  const key=Buffer.alloc(32,7),sealed=sealCredential(key,'alice','one',secret);
  assert.equal(openCredential(key,'alice','one',sealed),secret);
  assert.throws(()=>openCredential(key,'bob','one',sealed));assert.throws(()=>openCredential(key,'alice','two',sealed));
});

test('active turn conflicts do not change its branch and configuration changes apply to the next explicit request',async t=>{
  const selections:Array<{apiKey:string;version:string}>=[];
  let finish:((result:{text:string})=>void)|undefined;
  const transport:CompatibleTransport={...immediateTransport,async complete({selection}){
    selections.push({apiKey:selection.apiKey,version:selection.version});
    if(selections.length===1)return new Promise(resolve=>{finish=resolve;});return {text:'second real fake response'};
  }};
  const fixture=await setup(transport);t.after(fixture.cleanup);const {request}=fixture;
  await request('POST','/api/model-settings',settings());
  const first=await request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'first',requestKey:'first'});await pause();
  const {conversationId,turnId}=first.body.data;
  assert.equal((await request('POST','/api/agent/turns',{conversationId,mode:'send',text:'racing message',requestKey:'racing'})).status,409);
  assert.equal((await request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'another conversation',requestKey:'racing-other'})).status,409);
  assert.equal((await request('POST',`/api/agent/conversations/${conversationId}/edit`,{messageIndex:0,text:'racing edit',expectedMessageHash:'a'.repeat(64)})).status,409);
  const secondSecret='another-offline-only-secret';
  await request('POST','/api/model-settings',settings({expectedRevision:1,providers:[{...provider,apiKey:secondSecret}]}));
  finish?.({text:'first response'});await pause();
  assert.equal((await request('GET',`/api/agent/turns/${turnId}`)).body.data.message.text,'first response');
  await request('POST','/api/agent/turns',{conversationId,mode:'send',text:'second',requestKey:'second'});await pause();
  assert.equal(selections[0]!.apiKey,secret);assert.equal(selections[1]!.apiKey,secondSecret);assert.notEqual(selections[0]!.version,selections[1]!.version);
});

test('transport exceptions never become a fabricated normal reply or expose supplier secrets',async t=>{
  const fixture=await setup({...immediateTransport,async complete(){throw new Error(`a supplier echoed ${secret}`);}});t.after(fixture.cleanup);
  await fixture.request('POST','/api/model-settings',settings());
  const accepted=await fixture.request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'question',requestKey:'error'});await pause();
  const failed=await fixture.request('GET',`/api/agent/turns/${accepted.body.data.turnId}`);
  assert.equal(failed.body.data.message.phase,'failed');assert.equal(failed.body.data.message.text,'');
  assert.equal(failed.body.data.message.failure.code,'DEPENDENCY_UNAVAILABLE');assert.equal(JSON.stringify(failed).includes(secret),false);
});

test('effort is selected only from supported model metadata and the maintenance switch disables all generation',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'xunjie-personal-integration-'));
  let enabled=true,calls=0;
  const service=createPersonalAgentService({directory,authorize(){return 'alice';},callsEnabled:()=>enabled,
    transport:{...immediateTransport,async complete(){calls++;return {text:'not called while disabled'};}}}),app=createApp();
  service.register(app);await app.ready();
  t.after(async()=>{await service.close();await app.close();rmSync(directory,{recursive:true,force:true});});
  const save=await app.inject({method:'POST',url:'/api/model-settings',payload:settings({providers:[{...provider,models:[{...provider.models[0],reasoningLevels:['low','high']}]}],efforts:{'custom:test:test-model':'高'}})});
  assert.equal(save.statusCode,200);
  const selected=service.selection('alice') as {reasoningEffort?:string}|undefined;
  assert.equal(selected?.reasoningEffort,'high');
  enabled=false;assert.equal(service.selection('alice'),undefined);
  const accepted=await app.inject({method:'POST',url:'/api/agent/turns',payload:{conversationId:null,mode:'send',text:'question',requestKey:'disabled'}});
  assert.equal(accepted.statusCode,422);assert.equal(calls,0);
});

test('each supported effort and saved limits reach actual dispatch while thinking state stores no reasoning text',async t=>{
  for(const effort of ['low','high','max'] as const){
    let finish:()=>void=()=>{};let dispatched:any;
    const fixture=await setup({...immediateTransport,async complete(input){
      dispatched=input.selection;input.onThinking?.();await new Promise<void>(resolve=>{finish=resolve;});return {text:'visible answer'};
    }});t.after(fixture.cleanup);
    const models=[{...provider.models[0],contextWindow:'300000',maxOutput:'131072',reasoningLevels:['low','high','max']}];
    assert.equal((await fixture.request('POST','/api/model-settings',settings({providers:[{...provider,models}],efforts:{'custom:test:test-model':effort}}))).status,200);
    const accepted=await fixture.request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'question',requestKey:effort});
    await pause();assert.equal(dispatched.reasoningEffort,effort);assert.equal(dispatched.maxOutputTokens,131072);assert.equal(dispatched.contextWindow,300000);
    const thinking=await fixture.request('GET',`/api/agent/turns/${accepted.body.data.turnId}`);
    assert.equal(thinking.body.data.message.phase,'thinking');assert.equal(thinking.body.data.message.text,'');
    finish();await pause();assert.equal((await fixture.request('GET',`/api/agent/turns/${accepted.body.data.turnId}`)).body.data.message.text,'visible answer');
  }
});

test('all configured model efforts are validated, and large declared contexts are not silently capped',async t=>{
  const fixture=await setup(immediateTransport);t.after(fixture.cleanup);
  const models=[{...provider.models[0],contextWindow:'2000000',maxOutput:'200000',reasoningLevels:['low']},
    {...provider.models[0],id:'other',reasoningLevels:['low']}];
  const bad=await fixture.request('POST','/api/model-settings',settings({providers:[{...provider,models}],efforts:{'custom:test:other':'max'}}));
  assert.equal(bad.status,422);
  const good=await fixture.request('POST','/api/model-settings',settings({providers:[{...provider,models}],efforts:{'custom:test:other':'low'}}));
  assert.equal(good.status,200);assert.equal(good.body.data.providers[0].models[0].contextWindow,'2000000');
});

test('stale page model revision rejects a new turn before recording or calling the provider',async t=>{
  let calls=0;
  const fixture=await setup({...immediateTransport,async complete(){calls++;return {text:'verified'};}});t.after(fixture.cleanup);
  await fixture.request('POST','/api/model-settings',settings());
  const stale=await fixture.request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'keep original question',requestKey:'stale-page',expectedModelConfigRevision:0});
  assert.equal(stale.status,409);assert.equal(stale.body.error?.code,'VERSION_CONFLICT');assert.equal(calls,0);
  assert.deepEqual((await fixture.request('GET','/api/agent/conversations')).body.data,[]);
  const current=await fixture.request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'keep original question',requestKey:'fresh-page',expectedModelConfigRevision:1});
  assert.equal(current.status,200);await pause();assert.equal(calls,1);
  await fixture.request('POST','/api/model-settings',settings({expectedRevision:1}));
  const replay=await fixture.request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'keep original question',requestKey:'fresh-page',expectedModelConfigRevision:1});
  assert.equal(replay.body.data.turnId,current.body.data.turnId);assert.equal(calls,1);
});

test('thinking has no total deadline; actual activity renews only the network idle window',async t=>{
  let calls=0;
  let activity:(()=>void|Promise<void>)|undefined;
  const fixture=await setup({...immediateTransport,async complete({onText,onActivity,signal}){calls++;activity=onActivity;onText?.('bounded partial');return new Promise(resolve=>signal.addEventListener('abort',()=>resolve({text:'late completion'}),{once:true}));}});
  t.after(fixture.cleanup);await fixture.request('POST','/api/model-settings',settings());
  t.mock.timers.enable({apis:['setTimeout']});
  const accepted=await fixture.request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'question',requestKey:'timeout'});
  await pause();t.mock.timers.tick(45001);await pause();
  assert.equal((await fixture.request('GET',`/api/agent/turns/${accepted.body.data.turnId}`)).body.data.message.phase,'streaming');
  t.mock.timers.tick(255000);await pause();
  assert.equal((await fixture.request('GET',`/api/agent/turns/${accepted.body.data.turnId}`)).body.data.message.phase,'streaming');
  await activity?.();t.mock.timers.tick(599999);await pause();
  assert.equal((await fixture.request('GET',`/api/agent/turns/${accepted.body.data.turnId}`)).body.data.message.phase,'streaming');
  t.mock.timers.tick(2);await pause();
  const failed=await fixture.request('GET',`/api/agent/turns/${accepted.body.data.turnId}`);
  assert.equal(failed.body.data.message.phase,'failed');assert.equal(failed.body.data.message.text,'bounded partial');
  assert.equal(failed.body.data.message.failure.code,'PROVIDER_IDLE_TIMEOUT');assert.equal(calls,1);
  const edit=await fixture.request('POST',`/api/agent/conversations/${accepted.body.data.conversationId}/edit`,{
    messageIndex:0,text:'revised',expectedMessageHash:messageHash((await fixture.request('GET',`/api/agent/conversations/${accepted.body.data.conversationId}`)).body.data.messages[0]),
  });assert.equal(edit.status,200);
});

test('conversation token display uses only actual provider usage and generated titles match the 24 character UI limit',async t=>{
  const fixture=await setup({...immediateTransport,async complete(){return {text:'reply',usage:{status:'actual',inputTokens:23,outputTokens:7}};}});
  t.after(fixture.cleanup);await fixture.request('POST','/api/model-settings',settings());
  const text='A long question that exceeds twenty four characters';
  const accepted=await fixture.request('POST','/api/agent/turns',{conversationId:null,mode:'send',text,requestKey:'usage'});await pause();
  const conversation=await fixture.request('GET',`/api/agent/conversations/${accepted.body.data.conversationId}`);
  assert.equal(conversation.body.data.title,text.slice(0,24));assert.equal(conversation.body.data.contextTokens,30);
});

test('provider throttling and payment errors are quota failures while HTTP/configuration errors are model failures',async t=>{
  let failure=new CompatibleRequestError('http',429);
  const fixture=await setup({...immediateTransport,async complete(){throw failure;}});t.after(fixture.cleanup);
  await fixture.request('POST','/api/model-settings',settings());
  const cases=[
    [new CompatibleRequestError('http',429),'quota','RATE_LIMITED'],
    [new CompatibleRequestError('http',402),'quota','PROVIDER_PAYMENT_REQUIRED'],
    [new CompatibleRequestError('http',400),'model','PROVIDER_HTTP_ERROR'],
    [new CompatibleRequestError('http',503),'model','PROVIDER_HTTP_ERROR'],
    [new CompatibleRequestError('invalid-url'),'model','INVALID_PROVIDER_URL'],
    [new CompatibleRequestError('auth',401),'model','PROVIDER_AUTHENTICATION_FAILED'],
    [new CompatibleRequestError('not-found',404),'model','MODEL_NOT_FOUND'],
    [new CompatibleRequestError('protocol'),'model','PROVIDER_PROTOCOL_ERROR'],
    [new CompatibleRequestError('network'),'network','DEPENDENCY_UNAVAILABLE'],
  ] as const;
  for(const [index,[error,reason,code]] of cases.entries()){
    failure=error;
    const accepted=await fixture.request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'question',requestKey:`error-${index}`});
    assert.equal(accepted.status,200);await pause();
    const result=await fixture.request('GET',`/api/agent/turns/${accepted.body.data.turnId}`);
    assert.equal(result.body.data.message.phase,'failed');assert.equal(result.body.data.message.text,'');
    assert.deepEqual(result.body.data.message.failure,{reason,code});
  }
});

test('strict transport input preflight releases the unsent call reservation and retains an explicit failure',async t=>{
  let preflights=0;
  const fixture=await setup({...immediateTransport,async complete(){preflights++;throw new InputLimitError(16001);}});t.after(fixture.cleanup);
  await fixture.request('POST','/api/model-settings',settings());
  const accepted=await fixture.request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'question',requestKey:'input-preflight'});await pause();
  const result=await fixture.request('GET',`/api/agent/turns/${accepted.body.data.turnId}`);
  assert.equal(result.body.data.message.phase,'failed');assert.equal(result.body.data.message.text,'');
  assert.deepEqual(result.body.data.message.failure,{reason:'model',code:'INPUT_LIMIT_EXCEEDED'});assert.equal(preflights,1);
  const store=openPersonalAgentStore(fixture.directory);
  try{
    const turn=JSON.parse(String(store.get('SELECT turn_json FROM agent_turns WHERE turn_id=?',accepted.body.data.turnId)!.turn_json));
    assert.equal(turn.callCount,0);assert.deepEqual(turn.usage,{status:'unknown'});assert.equal(turn.status,'failed');
  }finally{store.close();}
});
