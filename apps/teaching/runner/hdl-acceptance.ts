import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {appendFileSync,openSync,closeSync,fsyncSync,readdirSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {readJson} from './node-files.ts';
import {nodeFingerprint} from './fingerprint.ts';
import {hdlExecutor} from './hdl-executor.ts';
import type {HdlNodeConfig} from './hdl-executor.ts';
import {HdlNode} from './hdl-node.ts';
import {sha256} from './snapshot.ts';

const exec=promisify(execFile),path=process.argv[2]!,config=readJson(path) as HdlNodeConfig;
const evidenceDir=join(config.state,'hdl','acceptance-'+Date.now());mkdirSync(evidenceDir,{mode:0o700});
const evidence=[];
for(const [name,files,environment] of [
  ['hdl',[join(config.source,'hdl.runtime.test.ts')],{XUNJIE_DLC_CONFIG:path}],
  ['c',readdirSync(config.source).filter(name=>name.endsWith('.test.ts')&&!name.startsWith('hdl')).map(name=>join(config.source,name)),
    {XUNJIE_C1_RUNTIME:'1',XUNJIE_C1_RUNTIME_IMAGE:readJson(path).profile.runtimeImage}],
] as const){
  let result;
  try{result=await exec(config.node,['--test',...files],{env:{...process.env,...environment},timeout:240000,maxBuffer:4*1024*1024});}
  catch(error){const value=error as {stdout?:string;stderr?:string};writeFileSync(join(evidenceDir,name+'.failed.txt'),(value.stdout??'')+(value.stderr??''),{flag:'wx'});throw new Error('Acceptance failed: '+name);}
  const output=result.stdout+result.stderr;writeFileSync(join(evidenceDir,name+'.txt'),output,{flag:'wx'});evidence.push({suite:name,exitCode:0,outputHash:sha256(output)});console.log(output);
}
const node=new HdlNode(config,path,()=>config.generation),{fingerprint,hash}=await nodeFingerprint({source:config.source,profile:config.hdl},hdlExecutor(config));
if(fingerprint.sourceHash!==config.hdl.sourceHash)throw new Error('Current source differs from prepared profile');
const record={passed:true,fingerprintHash:hash,validatedAt:new Date().toISOString(),evidence};
const log=join(config.state,'hdl','validation.jsonl');appendFileSync(log,JSON.stringify(record)+'\n',{mode:0o600});
const fd=openSync(log,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
console.log(JSON.stringify({record,ready:(await node.readiness()).ready,evidenceDir}));
