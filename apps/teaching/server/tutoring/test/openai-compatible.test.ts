import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { createCompatibleTransport, isPublicModelAddress, modelBaseUrl, compatibleTutoringProvider,
  requirePersonalSelection, CompatibleRequestError, type ModelHttpsOpen } from '../openai-compatible.ts';
import {resolvePublicModelHost} from '../openai-compatible.ts';
import type { ModelSelection } from '../../personal-agent/types.ts';

const selection:ModelSelection={userId:'synthetic-user',version:'personal:synthetic:1',providerId:'custom',
  baseUrl:'https://models.example/v1',model:'custom-model',apiKey:'synthetic-key-canary'};
const response=(chunks:(string|Buffer)[],statusCode=200)=>Object.assign(Readable.from(chunks),{statusCode}) as IncomingMessage;
const frame=(value:unknown)=>`data: ${JSON.stringify(value)}\n\n`;
const opts=()=>({selection,messages:[{role:'user' as const,content:'解释时钟边沿'}],signal:new AbortController().signal,remainingMs:1000});

test('provider address gate rejects local/private/mapped and non-HTTPS destinations',()=>{
  for(const address of ['127.0.0.1','0.0.0.0','10.1.2.3','172.16.1.1','192.168.1.1','169.254.169.254','100.64.0.1',
    '224.0.0.1','192.0.2.1','::1','fc00::1','fe80::1','::ffff:8.8.8.8','2001:db8::1','2002:7f00:1::1'])assert.equal(isPublicModelAddress(address),false,address);
  for(const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111'])assert.equal(isPublicModelAddress(address),true,address);
  for(const url of ['http://models.example/v1','https://127.1/v1','https://[::1]/v1','https://user:pass@models.example/v1',
    'https://models.example/v1?key=secret','https://models.example/v1#token'])assert.throws(()=>modelBaseUrl(url),CompatibleRequestError);
});

test('actual SSE chunks preserve split UTF-8 content and usage while ignoring internal reasoning',async()=>{
  const deltas:string[]=[];let wire:Record<string,unknown>|undefined;
  const open:ModelHttpsOpen=async(url,input)=>{
    assert.equal(url.href,'https://models.example/v1/chat/completions');assert.equal(input.apiKey,selection.apiKey);
    wire=JSON.parse(input.body!);
    const body=Buffer.from(frame({choices:[{delta:{reasoning_content:'do not store',content:'你'}}]})+
      frame({choices:[{delta:{content:'好'},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:3}})+'data: [DONE]\n\n');
    const index=body.indexOf(Buffer.from('你'))+1;
    return response([body.subarray(0,index),body.subarray(index,index+1),body.subarray(index+1)]);
  };
  const result=await createCompatibleTransport(open).complete({...opts(),onText:text=>deltas.push(text)});
  assert.deepEqual(deltas,['你','你好']);assert.equal(result.text,'你好');
  assert.deepEqual(result.usage,{status:'actual',inputTokens:12,outputTokens:3});
  assert.equal(wire!.model,'custom-model');assert.equal(wire!.stream,true);assert.equal(wire!.max_tokens,4096);
  assert.equal('tools' in wire!,false);
});

test('proxy synthetic DNS is resolved to verified public addresses without allowing private destinations',async()=>{
  const signal=new AbortController().signal;let queries=0;
  const lookup=async()=>[{address:'198.18.0.103',family:4}];
  const publicDns=async(hostname:string)=>{assert.equal(hostname,'models.example');queries++;return [{address:'1.1.1.1',family:4}];};
  assert.deepEqual(await resolvePublicModelHost('models.example',signal,{lookup,publicDns}),[{address:'1.1.1.1',family:4}]);
  assert.equal(queries,1);
  await assert.rejects(resolvePublicModelHost('models.example',signal,{lookup,publicDns:async()=>[{address:'127.0.0.1',family:4}]}),CompatibleRequestError);
  await assert.rejects(resolvePublicModelHost('models.example',signal,{lookup:async()=>[{address:'10.0.0.1',family:4}],publicDns}),CompatibleRequestError);
  assert.equal(queries,1); // Private DNS never triggers a public-resolution bypass.
  await assert.rejects(resolvePublicModelHost('198.18.0.103',signal,{lookup,publicDns}),CompatibleRequestError);
  assert.equal(queries,1);
});

test('stream interruption preserves actual partial text but never reports a complete response',async()=>{
  let seen='';const transport=createCompatibleTransport(async()=>response([frame({choices:[{delta:{content:'部分正文'}}]})]));
  await assert.rejects(transport.complete({...opts(),onText:text=>{seen=text;}}),error=>error instanceof CompatibleRequestError&&error.kind==='protocol');
  assert.equal(seen,'部分正文');
});

test('structured teaching uses saved model and reasoning with JSON validation and no tools',async()=>{
  let wire:Record<string,unknown>|undefined;
  const transport=createCompatibleTransport(async(_url,input)=>{wire=JSON.parse(input.body!);return response([JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]})]);});
  const provider=compatibleTutoringProvider({...selection,baseUrl:'https://api.deepseek.com/v1',reasoningEffort:'max'},transport);
  const result=await provider.generate({purpose:'student_help',systemPolicy:'Keep the student in control.',untrustedInput:{question:'synthetic'},repair:false,remainingMs:1000,signal:new AbortController().signal});
  assert.deepEqual(result.body,{});assert.equal(result.usage,undefined);
  assert.equal(wire!.model,'custom-model');assert.equal(wire!.stream,true);
  assert.deepEqual(wire!.response_format,{type:'json_object'});assert.deepEqual(wire!.thinking,{type:'enabled'});
  assert.equal(wire!.reasoning_effort,'max');
});

test('declared reasoning effort affects standalone calls without persisting reasoning content',async()=>{
  let wire:Record<string,unknown>|undefined;
  const transport=createCompatibleTransport(async(_url,input)=>{wire=JSON.parse(input.body!);return response([frame({choices:[{delta:{content:'正文'},finish_reason:'stop'}]})+'data: [DONE]\n\n']);});
  await transport.complete({...opts(),selection:{...selection,reasoningEffort:'high'}});
  assert.equal(wire!.reasoning_effort,'high');
});

test('low high and max reach both text and structured wire requests with saved token limits',async()=>{
  for(const effort of ['low','high','max'] as const)for(const structured of [false,true]){
    let wire:Record<string,any>|undefined,thinking=0,visible='';
    const transport=createCompatibleTransport(async(_url,input)=>{
      wire=JSON.parse(input.body!);
      const reply=response([frame({choices:[{delta:{reasoning_content:'INTERNAL-CANARY'}}]})+
        frame({choices:[{delta:{content:structured?'{}':'answer'},finish_reason:'stop'}],usage:{prompt_tokens:18,completion_tokens:5}})+'data: [DONE]\n\n']);
      reply.headers={'content-type':'text/event-stream'};return reply;
    });
    const result=await transport.complete({...opts(),selection:{...selection,baseUrl:'https://api.deepseek.com/v1',reasoningEffort:effort,
      contextWindow:300000,maxOutputTokens:131072},...(structured?{jsonSchema:{type:'object'}}:{}),onThinking:()=>{thinking++;},onText:text=>{visible=text;}});
    assert.equal(wire!.reasoning_effort,effort);assert.deepEqual(wire!.thinking,{type:'enabled'});
    assert.equal(wire!.max_tokens,131072);assert.equal(thinking,1);assert.equal(result.text,structured?'{}':'answer');
    assert.doesNotMatch(visible+JSON.stringify(result),/INTERNAL-CANARY/);
  }
});

test('saved context limit rejects unsent input while larger declared context accepts it',async()=>{
  let calls=0;
  const transport=createCompatibleTransport(async()=>{calls++;return response([frame({choices:[{delta:{content:'ok'},finish_reason:'stop'}]})+'data: [DONE]\n\n']);});
  const input={...opts(),messages:[{role:'user' as const,content:'x'.repeat(18000)}]};
  await assert.rejects(transport.complete({...input,selection:{...selection,contextWindow:20000,maxOutputTokens:4096}}),/exceeds/);
  assert.equal(calls,0);
  assert.equal((await transport.complete({...input,selection:{...selection,contextWindow:32000,maxOutputTokens:4096}})).text,'ok');
  assert.equal(calls,1);
});

test('models probe refuses redirects, malformed success and secret-bearing upstream errors',async()=>{
  const input={baseUrl:selection.baseUrl,apiKey:selection.apiKey,signal:new AbortController().signal};
  for(const status of [302,401,404,500]){
    const result=await createCompatibleTransport(async()=>response(['sensitive-upstream-body'],status)).test(input);
    assert.equal(result.ok,false);assert.doesNotMatch(JSON.stringify(result),/sensitive|synthetic-key/);
  }
  const malformed=await createCompatibleTransport(async()=>response(['{}'])).test(input);assert.equal(malformed.ok,false);
  const good=await createCompatibleTransport(async()=>response(['{"data":[{"id":"model"}]}'])).test(input);
  assert.equal(good.ok,true);if(good.ok)assert.equal(good.modelCount,1);
});

test('input cap prevents transmission and dispatch rejects a changed queued configuration',async()=>{
  let calls=0;const transport=createCompatibleTransport(async()=>{calls++;throw Error('unexpected');});
  await assert.rejects(transport.complete({...opts(),messages:[{role:'user',content:'x'.repeat(17000)}]}),/exceeds 16000/);
  assert.equal(calls,0);
  assert.throws(()=>requirePersonalSelection(selection,'old-revision'),/changed before dispatch/);
  assert.throws(()=>requirePersonalSelection(undefined,selection.version),/not configured/);
});

test('catalog discovery accepts provider field dialects without inventing missing capabilities',async()=>{
  const input={baseUrl:selection.baseUrl,apiKey:selection.apiKey,signal:new AbortController().signal};
  const catalog={models:{large:{name:'Large',context_length:2000000,limit:{output:200000}},sparse:{}}};
  const result=await createCompatibleTransport(async()=>response([JSON.stringify(catalog)])).test(input);
  assert.equal(result.ok,true);if(!result.ok)return;
  assert.equal(result.modelCount,2);
  assert.deepEqual(result.models,[{id:'large',name:'Large',contextWindow:2000000,maxOutputTokens:200000},{id:'sparse'}]);
});

test('official protocol dialects send one authoritative thinking and output field',async()=>{
  for(const host of ['api.kimi.com','api.openai.com','api.deepseek.com','models.example']){
    let wire:any;
    const transport=createCompatibleTransport(async(_url,input)=>{wire=JSON.parse(input.body!);return response([frame({choices:[{delta:{content:'ok'},finish_reason:'stop'}]})+'data: [DONE]\n\n']);});
    await transport.complete({...opts(),selection:{...selection,baseUrl:`https://${host}/v1`,reasoningEffort:'high'}});
    if(host==='api.kimi.com'){
      assert.deepEqual(wire.thinking,{type:'enabled',effort:'high'});assert.equal(wire.reasoning_effort,undefined);
    }else assert.equal(wire.reasoning_effort,'high');
    assert.equal(wire[host==='api.kimi.com'||host==='api.openai.com'?'max_completion_tokens':'max_tokens'],4096);
  }
});

test('SSE frame parsing joins multiline data, keeps reasoning private and distinguishes terminal empty from thinking',async()=>{
  let thinking=0,activity=0;
  const chunks=[': keep-alive\r\n\r\n','data: {"choices":[\r\ndata: {"delta":{"reasoning":"PRIVATE-CANARY"}}]}\r\n\r\n',
    frame({choices:[{delta:{},finish_reason:'stop'}]})+'data: [DONE]\n\n'];
  await assert.rejects(createCompatibleTransport(async()=>response(chunks)).complete({...opts(),onThinking(){thinking++;},onActivity(){activity++;}}),
    error=>error instanceof CompatibleRequestError&&error.kind==='empty'&&!error.message.includes('PRIVATE-CANARY'));
  assert.equal(thinking,1);assert.equal(activity,4);
  let partial='';
  await assert.rejects(createCompatibleTransport(async()=>response([frame({choices:[{delta:{content:'partial'},finish_reason:'length'}],usage:{prompt_tokens:4,completion_tokens:8}})+'data: [DONE]\n\n']))
    .complete({...opts(),onText(text){partial=text;}}),error=>error instanceof CompatibleRequestError&&error.kind==='output-limit'&&error.usage?.outputTokens===8);
  assert.equal(partial,'partial');
});
