import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {readJson,readEnvelope,writeImmutable,envelope} from './node-files.ts';
import {buildHdl} from './hdl-executor.ts';
import type {HdlNodeConfig} from './hdl-executor.ts';
import {acquireHdlToken,journalUnit} from './hdl-ledger.ts';
import type {HdlBuildRequest} from '../contracts/runner/hdl.ts';

const path=process.argv[2]!,config=readJson(process.argv[3]!) as HdlNodeConfig;
const request=readEnvelope(join(path,'request.json')) as HdlBuildRequest;
const release=await acquireHdlToken(config);
try{if(!existsSync(join(path,'stop.intent'))){const result=await buildHdl(config,request,path,(name,container)=>journalUnit(path,name,container));
  writeImmutable(join(path,'outcome.json'),envelope(result));}}
finally{release();}
