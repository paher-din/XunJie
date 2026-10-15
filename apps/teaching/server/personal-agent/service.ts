import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from '../app/errors.ts';
import { InputLimitError } from '../tutoring/providers.ts';
import { CompatibleRequestError } from '../tutoring/openai-compatible.ts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { openCredential, sealCredential, type SealedCredential } from './credentials.ts';
import { openPersonalAgentStore } from './store.ts';
import type { CompatibleMessage, ModelSelection, PersonalAgentOptions, PersonalAgentService } from './types.ts';

const identifier=z.string().min(1).max(128);
const modelSchema=z.strictObject({id:z.string().trim().min(1).max(256),contextWindow:z.string().max(32),maxOutput:z.string().max(32),
  inputTypes:z.array(z.enum(['image','video','pdf'])).max(3),reasoningLevels:z.array(z.string().max(32)).max(12)});
const providerSchema=z.strictObject({id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),name:z.string().trim().min(1).max(128),
  baseUrl:z.string().min(1).max(2048),models:z.array(modelSchema).max(100),apiKey:z.string().max(4096).optional(),clearKey:z.boolean().optional(),
  // These public read fields can be returned by clients, but never select stored credential material.
  hasKey:z.boolean().optional(),keyHint:z.string().max(16).optional()});
const settingsSchema=z.strictObject({expectedRevision:z.number().int().min(0),enabled:z.boolean(),defaultModelId:z.string().max(512),
  providers:z.array(providerSchema).max(32),efforts:z.record(z.string().max(512),z.string().max(32)).optional()});
type ModelMetadata=z.infer<typeof modelSchema>;
type StoredProvider={id:string;name:string;baseUrl:string;models:ModelMetadata[];credential?:SealedCredential};
type StoredConfig={enabled:boolean;defaultModelId:string;providers:StoredProvider[];efforts:Record<string,string>};
type ChatMessage={role:'user'|'agent';text:string;at:string;phase?:'waiting'|'streaming'|'settled'|'stopped'|'failed';
  failure?:{reason:'network'|'model'|'quota';code:string}};
type Turn={turnId:string;conversationId:string;userId:string;messageId:string;message:ChatMessage;configVersion:string;
  modelConfig:{providerId:string;baseUrl:string;model:string;reasoningEffort?:'low'|'high'|'max'};
  acceptedAt:number;deadline:number;callCount:number;status:'running'|'settled'|'stopped'|'failed';usage?:{status:'actual';inputTokens:number;outputTokens:number}|{status:'unknown'}};
type Conversation={id:string;userId:string;title:string;updatedAt:string;pinned:boolean;archived:boolean;ids:string[]};
const turnInput=z.strictObject({conversationId:identifier.nullable(),mode:z.enum(['send','retry','resume']),
  text:z.string().max(32000).optional(),requestKey:z.string().min(1).max(128)});
const textInput=z.string().trim().min(1).max(32000);
const parse=<T>(schema:z.ZodType<T>,value:unknown):T=>{const result=schema.safeParse(value);if(!result.success)throw new ApiError('INVALID_REQUEST');return result.data;};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const emptyConfig=():StoredConfig=>({enabled:false,defaultModelId:'',providers:[],efforts:{}});

function normalizeBaseUrl(value:string):string {
  try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.href.includes('?')||url.href.includes('#'))throw new Error();
    return url.toString().replace(/\/+$/,'');}catch{throw new ApiError('INVALID_CONFIGURATION');}
}

export function createPersonalAgentService(options:PersonalAgentOptions):PersonalAgentService {
  const store=openPersonalAgentStore(options.directory),now=options.now??Date.now;
  let closing=false,persistenceUnavailable=false;
  const active=new Map<string,{controller:AbortController;promise:Promise<void>}>();
  const stamp=()=>new Date(now()).toISOString();
  function config(userId:string):{revision:number;value:StoredConfig}{
    const row=store.get('SELECT revision,config_json FROM user_model_configs WHERE user_id=?',userId);
    return row?{revision:Number(row.revision),value:JSON.parse(String(row.config_json)) as StoredConfig}:{revision:0,value:emptyConfig()};
  }
  function version(userId:string,revision:number){return `personal:${hash(userId).slice(0,24)}:${revision}`;}
  function callsEnabled(){return !closing&&(options.callsEnabled?.()??true);}
  function publicSettings(userId:string){
    const current=config(userId);return {revision:current.revision,enabled:current.value.enabled,defaultModelId:current.value.defaultModelId,
      efforts:current.value.efforts,callsEnabled:callsEnabled(),providers:current.value.providers.map(({credential,...provider})=>({...provider,
        hasKey:Boolean(credential),keyHint:credential?.hint??''}))};
  }
  function selection(userId:string):ModelSelection|undefined {
    if(persistenceUnavailable)throw new ApiError('PERSISTENCE_UNAVAILABLE');
    if(!callsEnabled())return;
    const current=config(userId),value=current.value;
    if(!value.enabled)return;
    for(const provider of value.providers){
      const model=provider.models.find(item=>value.defaultModelId===`custom:${provider.id}:${item.id}`);
      if(model&&provider.credential){
        const rawEffort=value.efforts[value.defaultModelId];
        const level=rawEffort==='低'?'low':rawEffort==='高'?'high':rawEffort==='最高'?'max':rawEffort;
        const reasoningEffort=(level==='low'||level==='high'||level==='max')&&model.reasoningLevels.includes(level)?level:undefined;
        return {userId,version:version(userId,current.revision),providerId:provider.id,baseUrl:provider.baseUrl,
          model:model.id,apiKey:openCredential(store.key,userId,provider.id,provider.credential),...(reasoningEffort?{reasoningEffort}:{})};
      }
    }
    return;
  }
  function saveSettings(userId:string,raw:unknown){
    const input=parse(settingsSchema,raw);
    return store.transaction(()=>{
      const previous=config(userId);if(previous.revision!==input.expectedRevision)throw new ApiError('VERSION_CONFLICT');
      if(new Set(input.providers.map(item=>item.id)).size!==input.providers.length)throw new ApiError('INVALID_REQUEST');
      const providers:StoredProvider[]=input.providers.map(item=>{
        if(new Set(item.models.map(model=>model.id)).size!==item.models.length)throw new ApiError('INVALID_REQUEST');
        const prior=previous.value.providers.find(provider=>provider.id===item.id);
        const credential=item.clearKey?undefined:item.apiKey?.trim()?sealCredential(store.key,userId,item.id,item.apiKey.trim()):prior?.credential;
        return {id:item.id,name:item.name,baseUrl:normalizeBaseUrl(item.baseUrl),models:item.models,...(credential?{credential}:{})};
      });
      const validDefault=providers.some(provider=>provider.credential&&provider.models.some(model=>input.defaultModelId===`custom:${provider.id}:${model.id}`));
      if(input.enabled&&!validDefault)throw new ApiError('INVALID_CONFIGURATION');
      const value:StoredConfig={enabled:input.enabled,defaultModelId:input.defaultModelId,providers,efforts:input.efforts??{}};
      store.run('INSERT INTO user_model_configs(user_id,revision,config_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,config_json=excluded.config_json,updated_at=excluded.updated_at',
        userId,previous.revision+1,JSON.stringify(value),stamp());
      return publicSettings(userId);
    });
  }
  function conversation(userId:string,id:string):Conversation {
    const row=store.get('SELECT * FROM agent_conversations WHERE conversation_id=? AND user_id=? AND hidden=0',id,userId);
    if(!row)throw new ApiError('FORBIDDEN');
    return {id,userId,title:String(row.title),updatedAt:String(row.updated_at),pinned:row.pinned===1,archived:row.archived===1,
      ids:JSON.parse(String(row.current_message_ids_json)) as string[]};
  }
  function message(userId:string,id:string):ChatMessage {
    const row=store.get('SELECT message_json FROM agent_messages WHERE message_id=? AND user_id=?',id,userId);
    if(!row)throw new ApiError('FORBIDDEN');return JSON.parse(String(row.message_json)) as ChatMessage;
  }
  function saveMessage(userId:string,conversationId:string,id:string,value:ChatMessage,turnId?:string){
    store.run('INSERT INTO agent_messages(message_id,conversation_id,user_id,turn_id,message_json) VALUES(?,?,?,?,?)',
      id,conversationId,userId,turnId??null,JSON.stringify(value));
  }
  function setBranch(value:Conversation){store.run('UPDATE agent_conversations SET title=?,updated_at=?,pinned=?,archived=?,current_message_ids_json=? WHERE conversation_id=? AND user_id=?',
    value.title,value.updatedAt,Number(value.pinned),Number(value.archived),JSON.stringify(value.ids),value.id,value.userId);}
  function readTurn(userId:string,id:string):Turn {
    const row=store.get('SELECT turn_json FROM agent_turns WHERE turn_id=? AND user_id=?',id,userId);
    if(!row)throw new ApiError('FORBIDDEN');return JSON.parse(String(row.turn_json)) as Turn;
  }
  function writeTurn(value:Turn){
    store.run('UPDATE agent_turns SET turn_json=? WHERE turn_id=? AND user_id=?',JSON.stringify(value),value.turnId,value.userId);
    store.run('UPDATE agent_messages SET message_json=? WHERE message_id=? AND user_id=?',JSON.stringify(value.message),value.messageId,value.userId);
    store.run('UPDATE agent_conversations SET updated_at=? WHERE conversation_id=? AND user_id=?',stamp(),value.conversationId,value.userId);
  }
  function response(turn:Turn){return {conversationId:turn.conversationId,turnId:turn.turnId,message:turn.message};}
  function hasRunning(userId:string,id:string){return store.all('SELECT turn_json FROM agent_turns WHERE conversation_id=? AND user_id=?',id,userId)
    .some(row=>(JSON.parse(String(row.turn_json)) as Turn).status==='running');}
  function noRunning(userId:string,id:string){if(hasRunning(userId,id))throw new ApiError('STATE_CONFLICT');}
  function noRunningForAccount(userId:string){if(store.all('SELECT turn_json FROM agent_turns WHERE user_id=?',userId)
    .some(row=>(JSON.parse(String(row.turn_json)) as Turn).status==='running'))throw new ApiError('STATE_CONFLICT');}
  // Persisted unfinished requests are evidence of an interruption, never permission to retry a paid call.
  store.transaction(()=>{for(const row of store.all('SELECT turn_json FROM agent_turns')){
    const turn=JSON.parse(String(row.turn_json)) as Turn;
    if(turn.status==='running'){turn.status='failed';turn.message.phase='failed';turn.message.failure={reason:'network',code:'INTERRUPTED'};
      turn.usage={status:'unknown'};writeTurn(turn);}
  }});

  async function execute(turnId:string,selected:ModelSelection,messages:CompatibleMessage[],controller:AbortController,prefix:string){
    const userId=selected.userId;
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      let turn=readTurn(userId,turnId);
      if(turn.status!=='running')return;
      if(!callsEnabled())throw new ApiError('BUDGET_EXHAUSTED');
      const remainingMs=turn.deadline-now();
      if(remainingMs<=0)throw new Error('PERSONAL_TIMEOUT');
      turn.callCount=1;store.transaction(()=>writeTurn(turn));
      const aborted=new Promise<never>((_,reject)=>{
        const fail=()=>reject(new Error('PERSONAL_ABORTED'));
        if(controller.signal.aborted)fail();else controller.signal.addEventListener('abort',fail,{once:true});
      });
      const timeout=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{reject(new Error('PERSONAL_TIMEOUT'));controller.abort();},remainingMs);});
      const result=await Promise.race([options.transport.complete({selection:selected,messages,signal:controller.signal,remainingMs,
        onText(text){
          if(closing)return;
          const current=readTurn(userId,turnId);if(current.status!=='running')return;
          // The transport callback supplies the accumulated text, not a fabricated local reply.
          current.message.text=prefix+text;current.message.phase='streaming';store.transaction(()=>writeTurn(current));
        }}),aborted,timeout]);
      turn=readTurn(userId,turnId);if(turn.status!=='running')return;
      turn.message.text=prefix+result.text;turn.message.phase='settled';turn.status='settled';turn.usage=result.usage??{status:'unknown'};
      store.transaction(()=>writeTurn(turn));
    } catch(error){
      const turn=readTurn(userId,turnId);if(turn.status!=='running')return;
      const timedOut=now()>=turn.deadline||(error instanceof Error&&error.message==='PERSONAL_TIMEOUT');
      turn.status='failed';turn.message.phase='failed';turn.usage={status:'unknown'};
      const providerKind=error instanceof CompatibleRequestError?error.kind:undefined;
      const providerStatus=error instanceof CompatibleRequestError?error.status:undefined;
      const localQuota=error instanceof ApiError&&error.code==='BUDGET_EXHAUSTED';
      const quota=localQuota||providerKind==='http'&&(providerStatus===429||providerStatus===402);
      const inputLimit=error instanceof InputLimitError;
      // A strict transport preflight failure proves that its persisted reservation was never sent.
      if(inputLimit)turn.callCount=0;
      turn.message.failure={reason:quota?'quota':timedOut||providerKind==='network'||providerKind==='timeout'?'network':'model',
        code:inputLimit?'INPUT_LIMIT_EXCEEDED':timedOut||providerKind==='timeout'?'DEADLINE_EXCEEDED'
          :localQuota?'BUDGET_EXHAUSTED':providerKind==='http'&&providerStatus===429?'RATE_LIMITED':providerKind==='http'&&providerStatus===402?'PROVIDER_PAYMENT_REQUIRED'
          :providerKind==='auth'?'PROVIDER_AUTHENTICATION_FAILED':providerKind==='not-found'?'MODEL_NOT_FOUND'
          :providerKind==='invalid-url'?'INVALID_PROVIDER_URL':providerKind==='protocol'?'PROVIDER_PROTOCOL_ERROR'
          :providerKind==='http'?'PROVIDER_HTTP_ERROR':'DEPENDENCY_UNAVAILABLE'};
      store.transaction(()=>writeTurn(turn));
    } finally{if(timer)clearTimeout(timer);selected.apiKey='';}
  }
  function acceptTurn(userId:string,raw:unknown){
    const input=parse(turnInput,raw),requestHash=hash(JSON.stringify(input));
    const accepted=store.transaction(()=>{
      const previous=store.get('SELECT request_hash,turn_json FROM agent_turns WHERE user_id=? AND request_key=?',userId,input.requestKey);
      if(previous){if(previous.request_hash!==requestHash)throw new ApiError('IDEMPOTENCY_CONFLICT');return {turn:JSON.parse(String(previous.turn_json)) as Turn};}
      if(closing)throw new ApiError('DEPENDENCY_UNAVAILABLE');
      noRunningForAccount(userId);
      const selected=selection(userId);if(!selected)throw new ApiError('INVALID_CONFIGURATION');
      const at=stamp();
      let current:Conversation;
      if(input.conversationId)current=conversation(userId,input.conversationId);
      else {
        if(input.mode!=='send')throw new ApiError('INVALID_REQUEST');
        current={id:randomUUID(),userId,title:(input.text?.trim()??'').slice(0,24)||'新对话',updatedAt:at,pinned:false,archived:false,ids:[]};
        store.run('INSERT INTO agent_conversations(conversation_id,user_id,title,updated_at,current_message_ids_json) VALUES(?,?,?,?,?)',current.id,userId,current.title,at,'[]');
      }
      noRunning(userId,current.id);
      if(current.archived)throw new ApiError('STATE_CONFLICT');
      const turnId=randomUUID(),messageId=randomUUID();
      let prefix='';
      if(input.mode==='send'){
        const text=parse(textInput,input.text),userMessage:ChatMessage={role:'user',text,at};
        const id=randomUUID();saveMessage(userId,current.id,id,userMessage);current.ids.push(id);
      } else {
        const lastId=current.ids.at(-1);if(!lastId)throw new ApiError('STATE_CONFLICT');
        const last=message(userId,lastId);
        if(input.mode==='resume'){
          if(last.role!=='agent'||!['stopped','failed'].includes(last.phase??'')||!last.text)throw new ApiError('STATE_CONFLICT');
          prefix=last.text;current.ids.pop();
        }else if(last.role==='agent')current.ids.pop();
        if(!current.ids.length||message(userId,current.ids.at(-1)!).role!=='user')throw new ApiError('STATE_CONFLICT');
      }
      const messages:CompatibleMessage[]=[{role:'system',content:'You are a teaching assistant. Help the user understand and reason. Do not claim to have run tools, inspected private course material, evaluated a learner, or changed their work. Only use the messages provided.'},
        ...current.ids.map(id=>{const value=message(userId,id);return {role:value.role==='agent'?'assistant' as const:'user' as const,content:value.text};})];
      if(input.mode==='resume')messages.push({role:'assistant',content:prefix},{role:'user',content:'请接着上一条被中断的回答继续，不要重复已有内容。'});
      if(Buffer.byteLength(JSON.stringify(messages),'utf8')+256>16000)throw new ApiError('CONTENT_LIMIT');
      const acceptedAt=now();
      const turn:Turn={turnId,conversationId:current.id,userId,messageId,message:{role:'agent',text:prefix,at,phase:'waiting'},
        configVersion:selected.version,modelConfig:{providerId:selected.providerId,baseUrl:selected.baseUrl,model:selected.model,
          ...(selected.reasoningEffort?{reasoningEffort:selected.reasoningEffort}:{})},
        acceptedAt,deadline:acceptedAt+45000,callCount:0,status:'running',usage:{status:'unknown'}};
      store.run('INSERT INTO agent_turns(turn_id,conversation_id,user_id,request_key,request_hash,turn_json) VALUES(?,?,?,?,?,?)',
        turnId,current.id,userId,input.requestKey,requestHash,JSON.stringify(turn));
      saveMessage(userId,current.id,messageId,turn.message,turnId);current.ids.push(messageId);current.updatedAt=at;setBranch(current);
      return {turn,selected,messages,prefix};
    });
    if('selected' in accepted&&accepted.selected&&accepted.messages){
      const controller=new AbortController(),{turn,selected,messages,prefix}=accepted;
      const promise=Promise.resolve().then(()=>execute(turn.turnId,selected,messages,controller,prefix))
        .catch(()=>{persistenceUnavailable=true;}).finally(()=>active.delete(turn.turnId));
      active.set(turn.turnId,{controller,promise});
    }
    return response(accepted.turn);
  }
  function stopTurn(userId:string,id:string){return store.transaction(()=>{
    const turn=readTurn(userId,id);if(turn.status==='running'){turn.status='stopped';turn.message.phase='stopped';writeTurn(turn);active.get(id)?.controller.abort();}
    return response(turn);
  });}
  function register(app:FastifyInstance){
    const user=(request:FastifyRequest)=>{if(closing)throw new ApiError('DEPENDENCY_UNAVAILABLE');if(persistenceUnavailable)throw new ApiError('PERSISTENCE_UNAVAILABLE');return options.authorize(request);};
    const envelope=(request:FastifyRequest,data:unknown)=>({requestId:request.id,data});
    app.addHook('onSend',async(request,reply,payload)=>{if(request.url.startsWith('/api/model-settings')||request.url.startsWith('/api/agent/'))reply.header('cache-control','no-store');return payload;});
    app.get('/api/model-settings',request=>envelope(request,publicSettings(user(request))));
    app.post('/api/model-settings',request=>envelope(request,saveSettings(user(request),request.body)));
    app.post('/api/model-settings/test',async request=>{
      const userId=user(request),input=parse(z.strictObject({providerId:identifier.optional(),baseUrl:z.string().max(2048).optional(),apiKey:z.string().max(4096).optional()}),request.body);
      if(!callsEnabled())throw new ApiError('BUDGET_EXHAUSTED');
      const provider=input.providerId?config(userId).value.providers.find(item=>item.id===input.providerId):undefined;
      const baseUrl=normalizeBaseUrl(input.baseUrl??provider?.baseUrl??'');
      const apiKey=input.apiKey?.trim()||(provider?.credential?openCredential(store.key,userId,provider.id,provider.credential):'');
      if(!apiKey)throw new ApiError('INVALID_CONFIGURATION');
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
      try{return envelope(request,await options.transport.test({baseUrl,apiKey,signal:controller.signal}));}
      catch{return envelope(request,{ok:false,kind:controller.signal.aborted?'timeout':'network'});}
      finally{clearTimeout(timer);}
    });
    app.get('/api/agent/conversations',request=>{
      const userId=user(request),query=parse(z.strictObject({includeArchived:z.enum(['true','false']).optional()}),request.query);
      const rows=store.all(`SELECT conversation_id,title,updated_at,pinned,archived FROM agent_conversations WHERE user_id=? AND hidden=0${query.includeArchived==='true'?'':' AND archived=0'} ORDER BY updated_at DESC`,userId);
      return envelope(request,rows.map(row=>({id:row.conversation_id,title:row.title,updatedAt:row.updated_at,pinned:row.pinned===1,archived:row.archived===1})));
    });
    app.get('/api/agent/conversations/:id',request=>{
      const userId=user(request),id=parse(z.strictObject({id:identifier}),request.params).id,current=conversation(userId,id);
      const messages=current.ids.map(messageId=>message(userId,messageId));
      const lastId=current.ids.at(-1),lastTurnId=lastId?store.get('SELECT turn_id FROM agent_messages WHERE message_id=? AND user_id=?',lastId,userId)?.turn_id:undefined;
      const usage=typeof lastTurnId==='string'?readTurn(userId,lastTurnId).usage:undefined;
      return envelope(request,{id:current.id,title:current.title,updatedAt:current.updatedAt,pinned:current.pinned,archived:current.archived,messages,
        ...(usage?.status==='actual'?{contextTokens:usage.inputTokens+usage.outputTokens}:{})});
    });
    app.post('/api/agent/conversations/:id',request=>{
      const userId=user(request),id=parse(z.strictObject({id:identifier}),request.params).id;
      const input=parse(z.strictObject({action:z.enum(['rename','pin','archive','restore','delete']),title:z.string().trim().min(1).max(200).optional(),pinned:z.boolean().optional()}),request.body);
      const result=store.transaction(()=>{
        const current=conversation(userId,id);
        if(input.action==='rename'){if(!input.title)throw new ApiError('INVALID_REQUEST');current.title=input.title;}
        if(input.action==='pin'){if(input.pinned===undefined)throw new ApiError('INVALID_REQUEST');current.pinned=input.pinned;}
        if(input.action==='archive'||input.action==='delete'){
          for(const row of store.all('SELECT turn_id FROM agent_turns WHERE conversation_id=? AND user_id=?',id,userId)){
            const turn=readTurn(userId,String(row.turn_id));if(turn.status==='running'){turn.status='stopped';turn.message.phase='stopped';writeTurn(turn);active.get(turn.turnId)?.controller.abort();}
          }
          current.archived=true;
        }
        if(input.action==='restore')current.archived=false;
        current.updatedAt=stamp();setBranch(current);
        if(input.action==='delete')store.run('UPDATE agent_conversations SET hidden=1 WHERE conversation_id=? AND user_id=?',id,userId);
        return {id,current:true};
      });return envelope(request,result);
    });
    app.post('/api/agent/conversations/:id/edit',request=>{
      const userId=user(request),id=parse(z.strictObject({id:identifier}),request.params).id;
      const input=parse(z.strictObject({messageIndex:z.number().int().min(0),text:textInput,expectedMessageHash:z.string().regex(/^[a-f0-9]{64}$/)}),request.body);
      const result=store.transaction(()=>{
        const current=conversation(userId,id);noRunning(userId,id);
        const previousId=current.ids[input.messageIndex];if(!previousId)throw new ApiError('VERSION_CONFLICT');
        const original=message(userId,previousId);
        if(hash(JSON.stringify([original.role,original.text,original.at??null]))!==input.expectedMessageHash)throw new ApiError('VERSION_CONFLICT');
        if(original.role!=='user')throw new ApiError('INVALID_REQUEST');
        const messageId=randomUUID();saveMessage(userId,id,messageId,{role:'user',text:input.text,at:stamp()});
        current.ids=[...current.ids.slice(0,input.messageIndex),messageId];current.updatedAt=stamp();
        if(input.messageIndex===0)current.title=input.text.slice(0,24);
        setBranch(current);return {id};
      });return envelope(request,result);
    });
    app.post('/api/agent/turns',request=>envelope(request,acceptTurn(user(request),request.body)));
    app.get('/api/agent/turns/:id',request=>{
      const userId=user(request),id=parse(z.strictObject({id:identifier}),request.params).id,turn=readTurn(userId,id);conversation(userId,turn.conversationId);
      return envelope(request,response(turn));
    });
    app.post('/api/agent/turns/:id/stop',request=>{
      const userId=user(request),id=parse(z.strictObject({id:identifier}),request.params).id,turn=readTurn(userId,id);conversation(userId,turn.conversationId);
      return envelope(request,stopTurn(userId,id));
    });
  }
  let closePromise:Promise<void>|undefined;
  function close(){
    if(closePromise)return closePromise;
    closing=true;
    for(const id of active.keys()){
      try{const row=store.get('SELECT user_id FROM agent_turns WHERE turn_id=?',id);if(row)stopTurn(String(row.user_id),id);}
      catch{persistenceUnavailable=true;}finally{active.get(id)?.controller.abort();}
    }
    closePromise=Promise.allSettled([...active.values()].map(task=>task.promise)).then(()=>store.close());return closePromise;
  }
  return {register,selection,close};
}
