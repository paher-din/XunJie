import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from '../workspace/test-support.ts';
import { createI0App } from './i0.ts';

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
