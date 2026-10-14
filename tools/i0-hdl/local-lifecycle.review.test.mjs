// Failure/stop counterexamples for the new local wrappers. Runs their actual
// source in an in-memory VM; no Linux path, real DB, identity or model is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SourceTextModule, SyntheticModule, createContext } from 'node:vm';
const root='/opt/xunjie-ui-local';
const generation='synthetic-review-generation';
const ssh={host:'127.0.0.1',port:2222,keyFile:'/opt/xunjie-runner/vm/keys/application'};
const profile={sourceHash:'7f4ec4f3d3ce420c41265f0011746557424ded9630f9b2b53e9833d382677852'};
const readiness={data:{ready:true,profile,recoveryGeneration:generation}};
async function execute(name,{files=new Map(),db,initialize,createService,handlers=new Map(),argv=[],env={},sdk}={}){
  const config={databaseFile:root+'/retained-tmp/xunjie-a12-completion-Review/synthetic.sqlite',origin:'https://127.0.0.1:3444',
    ssh,recoveryGeneration:generation,approvedHdlRuntimes:[profile],tls:{keyFile:root+'/tls/server.key.pem',certFile:root+'/tls/server.crt.pem'},signingSecretFile:root+'/signing-secret.txt',consumerIntervalMs:250};
  const publicOutput=[];
  const fs={existsSync:path=>path==='/opt/xunjie-runner/local-node-ready.json'||files.has(path),
    readFileSync:path=>path==='/opt/xunjie-runner/local-node-ready.json'?JSON.stringify({ssh}):files.get(path)??'synthetic-non-secret',
    writeFileSync:(path,value,options)=>{if(options?.flag==='wx'&&files.has(path)){const e=new Error('EEXIST');e.code='EEXIST';throw e;}files.set(path,value);},
    mkdirSync:()=>{},lstatSync:()=>({isSymbolicLink:()=>false}),appendFileSync:(_path,value)=>publicOutput.push(value)};
  const modules={
    'node:fs':fs,'node:crypto':{randomBytes:()=>({toString:()=> 'synthetic-review-only-value'}),randomUUID:()=> 'synthetic-review-only-id'},
    'node:path':{resolve:path=>path},'node:url':{pathToFileURL:path=>({href:'file://'+path})},
    'server/app/config.ts':{sshConfigurationSchema:{parse:value=>value},readApplicationConfig:()=>config,readI0SigningSecret:()=> 'synthetic-non-secret'},
    'server/db/transaction.ts':{openSyntheticDatabase:()=>db},
    'server/app/execution-transport.ts':{executionTransports:()=>({runner:async()=>readiness,hdlTransport:async()=>readiness})},
    'server/design/readiness.ts':{availableRuntime:async()=>({recoveryGeneration:generation})},
    'server/design/hdl-configurations.ts':{availableHdlRuntime:async()=>({recoveryGeneration:generation})},
    'server/app/initialize.ts':{initializeSyntheticApplication:initialize},
    'server/app/digital-logic.ts':{createDigitalLogicApplication:createService},
    'server/tutoring/deepseek-sdk.ts':{createAiSdkDeepSeekProvider:sdk},
  };
  const context=createContext({process:{platform:'linux',version:'v24.21.0',argv:['node','test-module',...argv],env:{...env},
    once:(name,handler)=>handlers.set(name,handler),stderr:{write:value=>publicOutput.push(value)}},
    console:{log:value=>publicOutput.push(value)},URL,performance:{now:()=>0},fetch:()=>{throw new Error('Model calls forbidden in review');}});
  async function module(specifier){
    const key=specifier.startsWith('file://')?specifier.split('/apps/teaching/')[1]:specifier;
    const exports=modules[key];if(!exports)throw new Error('Unexpected module in isolated review: '+key);
    const child=new SyntheticModule(Object.keys(exports),function(){for(const [key,value]of Object.entries(exports))this.setExport(key,value);},{context});
    await child.link(()=>{throw new Error('Unexpected dependency');});await child.evaluate();return child;
  }
  const source=await readFile(new URL(name,import.meta.url),'utf8');
  const entry=new SourceTextModule(source,{context,importModuleDynamically:module});await entry.link(module);
  return {done:entry.evaluate(),context,handlers,files,publicOutput};
}
test('a transient original initializer failure can retry without overwriting prepared secrets or creating a second DB',async()=>{
  const files=new Map();let attempts=0,closed=0;
  const initialize=async()=>{attempts++;if(attempts===1)throw new Error('Original second readiness became unavailable');return {file:root+'/retained-tmp/xunjie-a12-completion-Review/synthetic.sqlite',close:()=>closed++};};
  const first=await execute('initialize-local-application.mjs',{files,initialize});await assert.rejects(first.done,/readiness became unavailable/);
  const second=await execute('initialize-local-application.mjs',{files,initialize});await second.done;
  assert.equal(attempts,2);assert.equal(closed,1);assert.ok(files.has(root+'/application-config.json'));
});
test('SIGTERM while the original application factory is pending fences listen and shuts the returned factory down',async()=>{
  let finish,entered;const start=new Promise(resolve=>entered=resolve),factory=new Promise(resolve=>finish=resolve);
  const events=[],db={withTransaction:fn=>fn({get:()=>({recovery_generation:generation}),all:sql=>sql.includes('users')?
    ['teacher','student-a','student-b'].map(x=>({id:'synthetic-robert-'+x})):['c','hdl'].map(x=>({id:'synthetic-robert-course-'+x}))}),close:()=>events.push('db-close')};
  const service={shutdown:async()=>events.push('shutdown'),app:{listen:async()=>events.push('listen')},startConsumer:()=>events.push('consumer')};
  const run=await execute('local-application-host.mjs',{db,createService:()=>{entered();return factory;}});await start;
  run.handlers.get('SIGTERM')();await Promise.resolve();finish(service);await run.done;
  assert.equal(events.includes('listen'),false);assert.equal(events.includes('consumer'),false);assert.equal(events.filter(x=>x==='shutdown').length,1);
  assert.equal(events.at(-1),'db-close');
});
test('an inherited test key alone keeps model budget off, and explicit model mode gates the original student_help purpose without logging keys/bodies',async()=>{
  for(const enabled of [false,true]){
    let options,constructed=0,generated=0;
    const canary='SYNTHETIC-REVIEW-CANARY-ONLY',bodyCanary='SYNTHETIC-REVIEW-MODEL-BODY';
    const db={withTransaction:fn=>fn({get:()=>({recovery_generation:generation}),all:sql=>sql.includes('users')?
      ['teacher','student-a','student-b'].map(x=>({id:'synthetic-robert-'+x})):['c','hdl'].map(x=>({id:'synthetic-robert-course-'+x}))}),close:()=>{}};
    const service={shutdown:async()=>{},app:{listen:async()=>{}},startConsumer:()=>{}};
    const run=await execute('local-application-host.mjs',{db,env:{DEEPSEEK_API_KEY:canary},argv:enabled?['--model-enabled']:[],
      createService:async value=>{options=value;return service;},sdk:settings=>{
        constructed++;assert.equal(settings.apiKey,canary);return {generate:async()=>{generated++;return {body:bodyCanary,usage:{status:'actual',inputTokens:3,outputTokens:2}};}};
      }});
    await run.done;assert.equal(options.studentHelp.budgetAvailable({}),enabled);assert.equal(constructed,enabled?1:0);
    assert.equal(options.teacherAgent.budgetAvailable({}),false);
    if(enabled){await assert.rejects(options.tutoringProvider.generate({purpose:'teacher_design'}),/Only approved synthetic/);assert.equal(generated,0);
      const result=await options.tutoringProvider.generate({purpose:'student_help'});assert.equal(result.body,bodyCanary);assert.equal(generated,1);}
    else assert.equal(options.tutoringProvider,undefined);
    assert.equal(run.publicOutput.join('').includes(canary),false);assert.equal(run.publicOutput.join('').includes(bodyCanary),false);
  }
});
