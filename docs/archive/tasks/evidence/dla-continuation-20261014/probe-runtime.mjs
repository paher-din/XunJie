import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const source=process.argv[2],output=process.argv[3];
assert.equal(process.version,'v24.21.0');assert.equal(process.getuid(),0);
const config=JSON.parse(readFileSync('/opt/xunjie-runner/tests/i0-entry-20261013-01/i0-host-recovered-20261014.json','utf8'));
const {executionTransports}=await import(pathToFileURL(source+'/apps/teaching/server/app/execution-transport.ts'));
const transports=executionTransports(config.ssh),results={checkedAt:new Date().toISOString(),node:process.version};
for(const [name,command] of [['c',{op:'readiness'}],['hdl',{op:'hdl_readiness'}]]){
  try{results[name]=await(name==='c'?transports.runner:transports.hdlTransport)(command);}
  catch{results[name]={error:{code:'DEPENDENCY_UNAVAILABLE'}};}
}
writeFileSync(output,JSON.stringify(results,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({cReady:results.c?.data?.ready??false,hdlReady:results.hdl?.data?.ready??false,
  cError:results.c?.error?.code,hdlError:results.hdl?.error?.code,output}));
