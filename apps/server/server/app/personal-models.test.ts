import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { assigned, fixture } from '../workspace/test-support.ts';
import { createI0App } from './i0.ts';
import { createPersonalAgentService } from '../personal-agent/service.ts';
import { createCompatibleTransport } from '../tutoring/openai-compatible.ts';
import { readStudentTasks } from '../personal-agent/student-tasks.ts';

test('authenticated independent chat sends only the current student assignment summary to the model',async()=>{
  const f=await fixture(),directory=mkdtempSync(join(tmpdir(),'xunjie-task-chat-host-'));
  const host=await createI0App({db:f.db,origin:'https://synthetic.example',signingSecret:f.signingSecret,now:f.timestamp,currentGeneration:f.generation});
  const seen:Array<{userId:string;messages:unknown}>=[];
  const personal=createPersonalAgentService({directory,now:f.timestamp,
    authorize:request=>f.db.withTransaction(tx=>host.access.authenticatedUserInTransaction(request,tx)),
    readStudentTasks:userId=>readStudentTasks(f.db,userId),
    transport:{async test(){return {ok:true,latencyMs:1,modelCount:1}},async complete({selection,messages}){
      seen.push({userId:selection.userId,messages});return {text:'Synthetic reply'};
    }}});
  personal.register(host.app);
  try{
    const teacher=await f.login('teacher'),student=await f.login(),other=await f.login('other');
    const {assignmentId}=await assigned(f,teacher);
    const payload={expectedRevision:0,enabled:true,defaultModelId:'custom:p:model',providers:[{id:'p',name:'Synthetic provider',
      baseUrl:'https://models.example/v1',apiKey:'SYNTHETIC-KEY',models:[{id:'model',contextWindow:'16000',maxOutput:'4096',inputTypes:[],reasoningLevels:[]}]}],efforts:{}};
    for(const headers of [student,other,teacher]){
      const saved=await host.app.inject({method:'POST',url:'/api/model-settings',headers,payload});
      assert.equal(saved.statusCode,200,saved.body);
      const turn=await host.app.inject({method:'POST',url:'/api/agent/turns',headers,
        payload:{conversationId:null,mode:'send',text:'我现在有什么任务还没完成',requestKey:'task-question'}});
      assert.equal(turn.statusCode,200,turn.body);
    }
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(seen.length,3);
    const studentPrompt=JSON.stringify(seen.find(item=>item.userId==='student')?.messages);
    assert.match(studentPrompt,/TextScope/);assert.match(studentPrompt,new RegExp(assignmentId));
    assert.doesNotMatch(studentPrompt,/PRIVATE_TITLE|PRIVATE_BODY|SYNTHETIC-KEY/);
    for(const userId of ['other','teacher']){
      const prompt=JSON.stringify(seen.find(item=>item.userId===userId)?.messages);
      assert.doesNotMatch(prompt,/TextScope|PRIVATE_TITLE|PRIVATE_BODY|SYNTHETIC-KEY/);
      const summary=(seen.find(item=>item.userId===userId)?.messages as {content:string}[])[1]?.content??'';
      assert.match(summary,/"tasks":\[\]/);
    }
  }finally{await personal.close();await host.close();await f.close();rmSync(directory,{recursive:true,force:true});}
});

test('personal endpoints reuse actual Session/Origin/CSRF and do not alter the course database',async()=>{
  const f=await fixture(),directory=mkdtempSync(join(tmpdir(),'xunjie-personal-host-'));
  const before=f.db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"));
  const service=await createI0App({db:f.db,origin:'https://synthetic.example',signingSecret:f.signingSecret,now:f.timestamp,
    currentGeneration:f.generation,personalModels:{directory,callsEnabled:false}});
  try{
    const student=await f.login(),other=await f.login('other');
    assert.equal((await service.app.inject({url:'/api/model-settings'})).statusCode,401);
    const payload={expectedRevision:0,enabled:true,defaultModelId:'custom:p:model',providers:[{id:'p',name:'Synthetic public provider',
      baseUrl:'https://models.example/v1',apiKey:'SYNTHETIC-HOST-KEY-CANARY',models:[{id:'model',contextWindow:'16000',maxOutput:'4096',inputTypes:[],reasoningLevels:[]}]}],efforts:{}};
    assert.equal((await service.app.inject({method:'POST',url:'/api/model-settings',headers:{...student,origin:'https://other.example'},payload})).statusCode,403);
    assert.equal((await service.app.inject({method:'POST',url:'/api/model-settings',headers:{...student,'x-csrf-token':'wrong'},payload})).statusCode,403);
    const saved=await service.app.inject({method:'POST',url:'/api/model-settings',headers:student,payload});
    assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().data.revision,1);
    assert.equal(saved.json().data.callsEnabled,false);assert.equal(saved.json().data.providers[0].hasKey,true);
    assert.doesNotMatch(saved.body,/SYNTHETIC-HOST-KEY-CANARY|ciphertext|apiKey/);
    const own=await service.app.inject({url:'/api/model-settings',headers:student});assert.equal(own.headers['cache-control'],'no-store');
    const isolated=await service.app.inject({url:'/api/model-settings',headers:other});assert.deepEqual(isolated.json().data.providers,[]);
    const blocked=await service.app.inject({method:'POST',url:'/api/agent/turns',headers:student,payload:{conversationId:null,mode:'send',text:'synthetic',requestKey:'test-only'}});
    assert.equal(blocked.statusCode,422,blocked.body);
    assert.deepEqual(f.db.withTransaction(tx=>tx.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")),before);
  }finally{await service.close();await f.close();rmSync(directory,{recursive:true,force:true});}
});

test('teacher sessions own model settings and connection tests only request the model catalog',async()=>{
  const f=await fixture(),directory=mkdtempSync(join(tmpdir(),'xunjie-teacher-model-settings-'));
  const host=await createI0App({db:f.db,origin:'https://synthetic.example',signingSecret:f.signingSecret,now:f.timestamp,currentGeneration:f.generation});
  const requests:Array<{method:string;url:string}>=[];
  let generations=0;
  // Use the production service and Session authority with an offline HTTPS boundary.
  const personal=createPersonalAgentService({directory,now:f.timestamp,
    authorize:request=>f.db.withTransaction(tx=>host.access.authenticatedUserInTransaction(request,tx)),
    transport:{...createCompatibleTransport(async(url,input)=>{
      requests.push({method:input.method,url:url.href});
      assert.equal(input.apiKey,'SYNTHETIC-TEACHER-KEY-CANARY');
      return Object.assign(Readable.from(['{"data":[{"id":"teacher-model"}]}']),{statusCode:200}) as IncomingMessage;
    }),async complete(){generations++;throw new Error('Generation is outside the settings workflow.');}}});
  personal.register(host.app);
  try{
    const teacher=await f.login('teacher'),student=await f.login();
    const identity=await host.app.inject({url:'/api/session',headers:teacher});
    assert.equal(identity.json().data.courses[0].role,'teacher');
    const initial=await host.app.inject({url:'/api/model-settings',headers:teacher});
    assert.equal(initial.statusCode,200,initial.body);assert.equal(initial.json().data.revision,0);
    const payload={expectedRevision:0,enabled:false,defaultModelId:'custom:p:teacher-model',providers:[{id:'p',name:'Synthetic teacher provider',
      baseUrl:'https://models.example/v1',apiKey:'SYNTHETIC-TEACHER-KEY-CANARY',models:[{id:'teacher-model',contextWindow:'16000',maxOutput:'4096',inputTypes:[],reasoningLevels:[]}]}],efforts:{}};
    const saved=await host.app.inject({method:'POST',url:'/api/model-settings',headers:teacher,payload});
    assert.equal(saved.statusCode,200,saved.body);assert.equal(saved.json().data.revision,1);
    assert.equal(saved.json().data.providers[0].hasKey,true);
    assert.doesNotMatch(saved.body,/SYNTHETIC-TEACHER-KEY-CANARY|ciphertext|apiKey/);
    const enabled=await host.app.inject({method:'POST',url:'/api/model-settings',headers:teacher,
      payload:{...payload,expectedRevision:1,enabled:true,providers:payload.providers.map(({apiKey:_,...provider})=>provider)}});
    assert.equal(enabled.statusCode,200,enabled.body);assert.equal(enabled.json().data.revision,2);assert.equal(enabled.json().data.enabled,true);
    const own=await host.app.inject({url:'/api/model-settings',headers:teacher});
    assert.equal(own.headers['cache-control'],'no-store');assert.equal(own.json().data.revision,2);
    assert.doesNotMatch(own.body,/SYNTHETIC-TEACHER-KEY-CANARY|ciphertext|apiKey/);
    const isolated=await host.app.inject({url:'/api/model-settings',headers:student});
    assert.equal(isolated.json().data.revision,0);assert.deepEqual(isolated.json().data.providers,[]);
    assert.equal((await host.app.inject({method:'POST',url:'/api/model-settings',headers:teacher,payload})).statusCode,409);
    assert.equal((await host.app.inject({method:'POST',url:'/api/model-settings/test',headers:{...teacher,'x-csrf-token':'wrong'},payload:{providerId:'p'}})).statusCode,403);
    assert.equal((await host.app.inject({method:'POST',url:'/api/model-settings/test',headers:student,payload:{providerId:'p'}})).statusCode,422);
    const tested=await host.app.inject({method:'POST',url:'/api/model-settings/test',headers:teacher,payload:{providerId:'p'}});
    assert.equal(tested.statusCode,200,tested.body);assert.equal(tested.json().data.ok,true);assert.equal(tested.json().data.modelCount,1);
    assert.deepEqual(requests,[{method:'GET',url:'https://models.example/v1/models'}]);assert.equal(generations,0);
    f.advance(31*60*1000);
    assert.equal((await host.app.inject({url:'/api/model-settings',headers:teacher})).statusCode,401);
  }finally{await personal.close();await host.close();await f.close();rmSync(directory,{recursive:true,force:true});}
});
