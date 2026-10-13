import {existsSync,mkdirSync,readdirSync,appendFileSync,openSync,closeSync,fsyncSync} from 'node:fs';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import {RunnerError,sha256} from './snapshot.ts';
import {envelope,readEnvelope,writeImmutable} from './node-files.ts';
import type {HdlIdentity,HdlSession} from '../contracts/runner/hdl.ts';
import type {HdlNodeConfig} from './hdl-executor.ts';

export const hdlRoot=(config:HdlNodeConfig)=>join(config.state,'hdl');
export const hdlDirectory=(config:HdlNodeConfig,kind:'builds'|'sessions',id:string)=>join(hdlRoot(config),kind,sha256(id));
export const hdlSocket=(id:string)=>join('/run/xunjie-dlc','s-'+sha256(id)+'.sock');
export function initializeHdl(config:HdlNodeConfig){mkdirSync('/run/xunjie-dlc',{recursive:true,mode:0o700});for(const name of ['builds','sessions'])mkdirSync(join(hdlRoot(config),name),{recursive:true,mode:0o700});}
export function sameIdentity(original:HdlIdentity,current:HdlIdentity){
  if(JSON.stringify(original.scope)!==JSON.stringify(current.scope))throw new RunnerError('FORBIDDEN','Original HDL scope required');
  if(JSON.stringify(original)!==JSON.stringify(current))throw new RunnerError('IDEMPOTENCY_CONFLICT','Original HDL identity required');
}
export function journalUnit(path:string,name:string,container?:string){
  const file=join(path,'units.jsonl');appendFileSync(file,JSON.stringify({name,...(container?{container}:{})})+'\n',{mode:0o600});const fd=openSync(file,'r');try{fsyncSync(fd);}finally{closeSync(fd);}
}
export function readSession(path:string):HdlSession {
  const files=readdirSync(path).filter(name=>/^state-\d{12}\.json$/.test(name)).sort();
  if(!files.length)throw new RunnerError('DEPENDENCY_UNAVAILABLE','Original session state unavailable');return readEnvelope(join(path,files.at(-1)!));
}
export function saveSession(path:string,state:HdlSession){
  const count=readdirSync(path).filter(name=>/^state-\d{12}\.json$/.test(name)).length;
  writeImmutable(join(path,`state-${String(count+1).padStart(12,'0')}.json`),envelope(state));
}
export function readIfPresent(path:string){return existsSync(path)?readEnvelope(path):undefined;}
export function acquireHdlToken(config:HdlNodeConfig):Promise<()=>void>{
  const child=spawn('/usr/bin/flock',['--exclusive','--timeout','120',join(hdlRoot(config),'active.lock'),'/bin/sh','-c','printf token; cat >/dev/null'],{stdio:['pipe','pipe','pipe']});
  return new Promise((resolve,reject)=>{
    let received=false;child.stdout.once('data',bytes=>{if(bytes.toString()!=='token'){reject(new RunnerError('DEPENDENCY_UNAVAILABLE','HDL token unavailable'));return;}
      received=true;resolve(()=>child.stdin.end());});
    child.stdin.on('error',()=>{});child.once('error',()=>reject(new RunnerError('DEPENDENCY_UNAVAILABLE','HDL token unavailable')));
    child.once('close',()=>{if(!received)reject(new RunnerError('RATE_LIMITED','HDL dispatch deadline exceeded'));});
  });
}
