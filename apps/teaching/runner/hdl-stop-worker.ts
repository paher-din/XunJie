import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readJson,readEnvelope,writeImmutable,envelope} from './node-files.ts';
import {hdlExecutor} from './hdl-executor.ts';
import type {HdlNodeConfig} from './hdl-executor.ts';
import {readSession,saveSession} from './hdl-ledger.ts';

const exec=promisify(execFile),path=process.argv[2]!,config=readJson(process.argv[3]!) as HdlNodeConfig,executor=hdlExecutor(config);
const journal=join(path,'units.jsonl');let confirmed=!existsSync(journal);
if(existsSync(journal)){
  const units=new Map<string,string|undefined>();for(const line of readFileSync(journal,'utf8').trim().split('\n')){const record=JSON.parse(line);units.set(record.name,record.container??units.get(record.name));}
  const created=existsSync(join(path,'created.json'))?readEnvelope(join(path,'created.json')).container:undefined;
  confirmed=true;for(const [name,container] of units){try{confirmed=(await executor.stop(container??created??name))&&Boolean(container??created)&&confirmed;}catch{confirmed=false;}}
}
try{await exec('/usr/bin/umount',[join(path,'work')]);}catch{/* No mounted temporary unit is also a valid end state. */}
if(existsSync(join(path,'initial-state.json'))){const state=readSession(path);
  if(!state.terminationConfirmed)saveSession(path,{...state,status:confirmed?'failed':'outcome_unknown',terminationConfirmed:confirmed,
    stopRequested:true,sessionRevision:state.sessionRevision+1,failureKind:state.failureKind??'worker_exit'});
}else if(!existsSync(join(path,'outcome.json'))){const request=readEnvelope(join(path,'request.json'));
  writeImmutable(join(path,'unknown.json'),envelope({identity:request.identity,terminationConfirmed:confirmed,status:'outcome_unknown'}));}
