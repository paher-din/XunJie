import {readFileSync,writeFileSync} from 'node:fs';
import {request} from 'node:https';
import assert from 'node:assert/strict';
const cert=readFileSync('/opt/xunjie-runner/tests/i0-entry-20261013-01/server.cert.pem');
const samples=[];
for(const port of process.argv[3]==='--dl-only'?[3444]:[3443,3444])for(const path of ['/health/live','/health/ready','/']){
  const result=await new Promise((resolve,reject)=>{
    const req=request(`https://127.0.0.1:${port}${path}`,{ca:cert,rejectUnauthorized:true},response=>{
      const authorized=response.socket.authorized;let text='';response.setEncoding('utf8');response.on('data',chunk=>{text+=chunk;});
      response.on('end',()=>resolve({origin:`https://127.0.0.1:${port}`,path,status:response.statusCode,authorized,
        cacheControl:response.headers['cache-control'],...(path==='/'?{htmlEntry:text.includes('<div id="root">')}:{body:JSON.parse(text)})}));
    });req.setTimeout(10000,()=>req.destroy(new Error('HTTPS smoke deadline')));req.on('error',reject);req.end();
  });samples.push(result);
}
const value={checkedAt:new Date().toISOString(),passed:samples.every(value=>value.authorized&&value.status===200),samples,modelRequests:0,browserAcceptance:false};
writeFileSync(process.argv[2],JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify({passed:value.passed,samples:samples.map(({origin,path,status,authorized})=>({origin,path,status,authorized})),modelRequests:0}));
assert.equal(value.passed,true);
