import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout} from 'node:timers/promises';
import {readJson} from './node-files.ts';
import {HdlNode} from './hdl-node.ts';
import {hdlExecutor} from './hdl-executor.ts';
import type {HdlNodeConfig} from './hdl-executor.ts';

// Explicit synthetic maintenance window only; it never removes a ledger, image or container.
if(process.argv[2]!=='recover')throw new Error('Usage: hdl-maintenance.ts recover <approved config>');
const path=process.argv[3]!,config=readJson(path) as HdlNodeConfig,exec=promisify(execFile);
const node=new HdlNode(config,path,()=>config.generation);await node.pause();
await exec('/usr/bin/systemctl',['stop','xunjie-c1-docker'],{timeout:60000});
const old=await exec('/usr/bin/systemctl',['show','xunjie-c1-docker','--property=MainPID','--value']);
if(old.stdout.trim()!=='0')throw new Error('Original Engine barrier unconfirmed');
await exec('/usr/bin/systemctl',['start','xunjie-c1-docker'],{timeout:60000});
const executor=hdlExecutor(config);let ready=false;
for(let i=0;i<100;i++){try{await executor.command(['info']);ready=true;break;}catch{await setTimeout(100);}}
if(!ready)throw new Error('Engine unavailable after recovery');
await node.afterEngineBarrier();console.log('HDL original resources reconciled after confirmed Engine barrier; results remain unknown where missing.');
