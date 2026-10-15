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

test('structured teaching uses the configured model with bounded JSON and no thinking/tool capabilities',async()=>{
  let wire:Record<string,unknown>|undefined;
  const transport=createCompatibleTransport(async(_url,input)=>{wire=JSON.parse(input.body!);return response([JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]})]);});
  const provider=compatibleTutoringProvider({...selection,baseUrl:'https://api.deepseek.com/v1',reasoningEffort:'max'},transport);
  const result=await provider.generate({purpose:'student_help',systemPolicy:'Keep the student in control.',untrustedInput:{question:'synthetic'},repair:false,remainingMs:1000,signal:new AbortController().signal});
  assert.deepEqual(result.body,{});assert.equal(result.usage,undefined);
  assert.equal(wire!.model,'custom-model');assert.equal(wire!.stream,false);
  assert.deepEqual(wire!.response_format,{type:'json_object'});assert.deepEqual(wire!.thinking,{type:'disabled'});
  assert.equal('reasoning_effort' in wire!,false);
});

test('declared reasoning effort affects standalone calls without persisting reasoning content',async()=>{
  let wire:Record<string,unknown>|undefined;
  const transport=createCompatibleTransport(async(_url,input)=>{wire=JSON.parse(input.body!);return response([frame({choices:[{delta:{content:'正文'},finish_reason:'stop'}]})+'data: [DONE]\n\n']);});
  await transport.complete({...opts(),selection:{...selection,reasoningEffort:'high'}});
  assert.equal(wire!.reasoning_effort,'high');
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
