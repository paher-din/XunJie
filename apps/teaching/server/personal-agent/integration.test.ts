import assert from 'node:assert/strict';
import { test } from 'node:test';
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
import type { CompatibleTransport } from './types.ts';

const secret='offline-test-secret-NEVER-RETURN-FULL';
const provider={id:'test',name:'Offline integration provider',baseUrl:'https://public.example/v1',apiKey:secret,
  models:[{id:'test-model',contextWindow:'16000',maxOutput:'4096',inputTypes:[],reasoningLevels:[]}]};
const settings=(overrides:Record<string,unknown>={})=>({expectedRevision:0,enabled:true,defaultModelId:'custom:test:test-model',providers:[provider],...overrides});
const pause=()=>new Promise<void>(resolve=>setImmediate(resolve));
const messageHash=(message:{role:string;text:string;at?:string})=>createHash('sha256').update(JSON.stringify([message.role,message.text,message.at??null])).digest('hex');
const immediateTransport:CompatibleTransport={async complete(){return {text:'actual fake transport result'};},async test(){return {ok:true,latencyMs:1,modelCount:1};}};

async function setup(transport:CompatibleTransport=immediateTransport){
  const directory=mkdtempSync(join(tmpdir(),'xunjie-personal-integration-'));
  const service=createPersonalAgentService({directory,transport,authorize(request){
    const user=request.headers['x-test-user'];if(typeof user!=='string')throw new ApiError('UNAUTHENTICATED');return user;
  }}),app=createApp();service.register(app);await app.ready();
  const request=async(method:'GET'|'POST',url:string,payload?:unknown,user='alice')=>{
    const result=await app.inject({method,url,headers:{'x-test-user':user},...(payload===undefined?{}:{payload:payload as object})});
    return {status:result.statusCode,body:result.json() as {data:any;error?:{code:string}}};
  };
  async function cleanup(){await service.close();await app.close();assert.ok(directory.startsWith(join(tmpdir(),'xunjie-personal-integration-')));rmSync(directory,{recursive:true,force:true});}
  return {directory,service,app,request,cleanup};
}

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
  const transport:CompatibleTransport={...immediateTransport,async complete({onText,messages}){
    calls++;
    if(calls===1){lateText=onText;onText?.('partial ');return new Promise(()=>{});}
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

test('45 second deadline preserves real partial output, releases the conversation and never retries the provider',async t=>{
  let calls=0;
  const fixture=await setup({...immediateTransport,async complete({onText}){calls++;onText?.('bounded partial');return new Promise(()=>{});}});
  t.after(fixture.cleanup);await fixture.request('POST','/api/model-settings',settings());
  t.mock.timers.enable({apis:['setTimeout']});
  const accepted=await fixture.request('POST','/api/agent/turns',{conversationId:null,mode:'send',text:'question',requestKey:'timeout'});
  await pause();t.mock.timers.tick(45001);await pause();
  const failed=await fixture.request('GET',`/api/agent/turns/${accepted.body.data.turnId}`);
  assert.equal(failed.body.data.message.phase,'failed');assert.equal(failed.body.data.message.text,'bounded partial');
  assert.equal(failed.body.data.message.failure.code,'DEADLINE_EXCEEDED');assert.equal(calls,1);
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
