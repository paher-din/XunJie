import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createFileBackend, openStorage, provisionStorage } from '../../packages/storage/dist/index.js';
import { nativeFixture } from '../../packages/storage/test/native-fixture.mjs';
import { createModelGateway, modelMigrations } from '../../packages/model-gateway/dist/index.js';
import { createModelAdapter } from '../../packages/agent-runtime/dist/model.js';

let mode='rate-limit', requests=[];
const upstream=createServer(async(request,response)=>{
  const chunks=[];for await(const chunk of request)chunks.push(chunk);requests.push(JSON.parse(Buffer.concat(chunks)));
  if(mode==='rate-limit' && requests.length===1){response.writeHead(429,{'content-type':'application/json'});response.end(JSON.stringify({error:{message:'synthetic rate limit',type:'rate_limit',code:'rate_limit'}}));return;}
  response.writeHead(200,{'content-type':'text/event-stream'});
  const delta=mode==='tool' ? {tool_calls:[{index:0,id:'call-audit',type:'function',function:{name:'audit_tool',arguments:'{}'}}]} : {content:'synthetic completed response'};
  response.write('data: '+JSON.stringify({choices:[{index:0,delta,finish_reason:mode==='tool'?'tool_calls':'stop'}]})+'\n\n');
  response.end('data: '+JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}})+'\n\ndata: [DONE]\n\n');
});
await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
const pg=await nativeFixture();let storage,gateway;
const findings=[];
try{
  const owner={environmentId:randomUUID(),serviceId:randomUUID()};
  const binding=await provisionStorage({admin:pg.admin,owner,password:randomUUID(),migrations:modelMigrations});
  storage=await openStorage({binding,migrations:modelMigrations,backend:createFileBackend({id:'gateway-review',root:join(pg.root,'gateway')})});
  const identity={kind:'personal',name:'review',environmentId:owner.environmentId,spaceId:randomUUID(),principalId:randomUUID()};
  gateway=await createModelGateway(storage,{holder:'device',authorize:async()=>{},authorizePermit:async()=>{}});
  const connectionId=randomUUID();
  await gateway.save(identity,{requestId:randomUUID(),connectionId,expectedVersion:0,name:'review fixture',protocol:'chat-completions',baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,path:'/chat/completions',modelId:'fixture-chat',dialect:'standard',parameterMode:'plain',enabled:true,contextWindow:262144,maxOutputTokens:1024,credential:{action:'replace',value:'synthetic-review-key'}});
  await gateway.selection.save(identity,{requestId:randomUUID(),expectedVersion:0,source:{kind:'personal',connectionId,owner:'self'}});
  const budget={maxSteps:16,maxToolCalls:64,maxInputTokens:1_048_576,maxOutputTokens:65_536,maxCallMs:10000,deadline:new Date(Date.now()+60000).toISOString()};
  const input=()=>({identity,sessionId:randomUUID(),turnId:randomUUID(),stepId:randomUUID(),system:'Synthetic audit',tools:[],history:[],text:'hello',images:[],toolResults:[],budget,spent:{inputTokens:0,outputTokens:0,inputReserved:0,outputReserved:0},signal:new AbortController().signal});
  const memory=()=>{let state={};const attempts=[];return {attempts,sessionState:async()=>state,setSessionState:async(_id,s)=>{state=s;},visibleInputs:async()=>[],toolResultsByNative:async()=>new Map(),budgetOf:async()=>({budget,usage:{inputTokens:0,outputTokens:0,inputReserved:0,outputReserved:0}}),saveAttempt:async(_id,a)=>{attempts.push({...a});},finishAttempt:async(_id,id,a)=>Object.assign(attempts.find(item=>item.attemptId===id),a)};};
  {
    const store=memory(),adapter=createModelAdapter(gateway,store,{retryBackoffMs:[0,0],pollMs:5});let caught;
    try{await adapter.generate(input());}catch(error){caught=error.code;console.log('GWERR',error?.message,error?.stack);}
    const rows=(await storage.read('SELECT body FROM model_segments')).rows.map(row=>({closed:row.body.closed,sequence:row.body.sequence}));
    console.log('GW1', JSON.stringify({requests:requests.length,caught,attempts:store.attempts.map(a=>({attemptNo:a.attemptNo,state:a.state,error:a.error}))}));
    assert.equal(requests.length,2);assert.equal(caught,undefined);
    findings.push({case:'real_pg_real_gateway_http_429_retry',networkRequests:requests.length,error:caught,segments:rows,attempts:store.attempts.map(a=>({attemptNo:a.attemptNo,state:a.state,error:a.error}))});
  }
  mode='tool';requests=[];
  {
    const store=memory(),adapter=createModelAdapter(gateway,store,{retryBackoffMs:[0,0],pollMs:5});
    const value={...input(),tools:[{name:'audit_tool',description:'synthetic audit',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
    const first=await adapter.generate(value);
    assert.equal(first.toolIntents.length,1);
    const pending=await gateway.segments.read(identity,first.segmentId);let caught;
    try{await adapter.generate({...value,turnId:randomUUID(),stepId:randomUUID(),text:'继续',history:[{id:randomUUID(),version:1,role:'user',text:'prior tool outcome unknown'}]});}catch(error){caught=error.code;}
    assert.equal(requests.length,2);assert.equal(caught,undefined);
    findings.push({case:'real_pg_real_gateway_new_turn_settles_old_tools',networkRequests:requests.length,error:caught,pendingTools:pending.pendingTools.map(t=>t.callId)});
  }
  mode='tool';requests=[];
  {
    const store=memory(),adapter=createModelAdapter(gateway,store,{retryBackoffMs:[0,0],pollMs:5});
    const value={...input(),tools:[{name:'audit_tool',description:'synthetic audit',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
    const first=await adapter.generate(value);
    const imageId=randomUUID();
    await gateway.images.upload(identity,{requestId:randomUUID(),imageId,mediaType:'image/png',dataBase64:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='});
    const image={imageId,version:1};
    await adapter.settleTools(identity,first.segmentId,first.segmentSequence,[{callId:'call-audit',outcome:'success',text:'已读取图像',images:[image]}]);
    mode='plain';
    await adapter.generate({...value,stepId:randomUUID(),system:'Synthetic audit changed prefix',text:'解释之前图像',
      history:[{id:randomUUID(),version:1,role:'user',text:'已读取图像',images:[image]}]});
    assert.equal(requests.length,2);
    const newRequest=JSON.stringify(requests[1]);
    assert(newRequest.includes('image_url')||newRequest.includes('input_image'));
    findings.push({case:'real_pg_real_gateway_segment_change_keeps_authorized_image',networkRequests:requests.length,imageInFirstToolResult:true,imageInNextPayload:true,messages:requests[1].messages});
  }
  console.log(JSON.stringify(findings,null,2));
}finally{
  gateway?.closeWrites();await gateway?.checks.drain();await storage?.close();await pg.close();
  upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));
}
