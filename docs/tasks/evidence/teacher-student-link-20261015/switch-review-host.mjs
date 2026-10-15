// Execute only under the owner's exact PAHER 35 -> 41 migration authorization.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {execFileSync,spawn} from 'node:child_process';
import {request} from 'node:https';
import {createRequire} from 'node:module';
assert.equal(process.platform,'linux');assert.equal(process.getuid(),0);assert.equal(process.version,'v24.21.0');
process.umask(0o077);
const source='/opt/xunjie-runner/tests/teacher-student-link-9664ca5-20261015';
const root='/opt/xunjie-runner/tests/i0-entry-20261013-01';
const oldHost='/mnt/d/tmp/xunjie-shared-20261015-input/host-shared.mjs',newHost='/mnt/d/tmp/xunjie-teacher-link-20261015/host-link.mjs';
const node='/opt/xunjie-runner/node/bin/node',oldPid=1852;
const migration='/mnt/c/Users/p3148/.codex/worktrees/teacher-student-link/XunJie/docs/tasks/evidence/teacher-student-link-20261015/enable-review-paher.mjs';
assert.equal(fs.readlinkSync('/proc/'+oldPid+'/exe'),node);
assert(fs.readFileSync('/proc/'+oldPid+'/cmdline','utf8').split('\0').includes(oldHost));
const Driver=createRequire(source+'/apps/teaching/package.json')('better-sqlite3');
const database=root+'/retained-tmp-20261014/xunjie-a12-completion-dZlbr9/synthetic.sqlite';
const d=new Driver(database,{readonly:true,fileMustExist:true});
try{
 assert.equal(d.prepare("SELECT count(*) n FROM jobs WHERE status NOT IN ('succeeded','failed','stale','timed_out','cancelled')").get().n,0);
 assert.equal(d.prepare('SELECT count(*) n FROM hdl_sessions WHERE termination_confirmed<>1 OR pending_operation_id IS NOT NULL').get().n,0);
 assert.equal(d.prepare('SELECT recovery_generation FROM application_control WHERE singleton=1').get().recovery_generation,'synthetic-generation-96fc2f60-8102-47fb-af1f-e2d86f4c2764');
}finally{d.close();}
const oldEnvironment=fs.readFileSync('/proc/'+oldPid+'/environ','utf8').split('\0');
const entry=oldEnvironment.find(v=>v.startsWith('DEEPSEEK_API_KEY='));assert(entry,'Preserve existing runtime key without persisting it');
const inheritedKey=entry.slice('DEEPSEEK_API_KEY='.length);
const sourceConfig=JSON.parse(fs.readFileSync(root+'/i0-host-recovered-20261014.json'));
const ca=fs.readFileSync(sourceConfig.tls.certFile);
const receipt={startedAtUtc:new Date().toISOString(),head:'9664ca5646b969cde0ccff4f4b8d5c7ea2da547d',oldPid,oldHost,newHost,source};
process.kill(oldPid,'SIGTERM');
for(let i=0;fs.existsSync('/proc/'+oldPid)&&i<300;i++)await new Promise(r=>setTimeout(r,100));
assert(!fs.existsSync('/proc/'+oldPid),'Original host shutdown must be confirmed before schema change');
receipt.oldHostStopped=true;
const output=execFileSync(node,[migration,'--apply'],{encoding:'utf8',timeout:30000,maxBuffer:1024*1024});
receipt.migration=JSON.parse(output.trim());assert.equal(receipt.migration.applied,true);assert.equal(receipt.migration.tableCount,41);
const log=fs.openSync(source+'/host-review.log','ax',0o600);
const child=spawn(node,[newHost],{detached:true,env:{...process.env,DEEPSEEK_API_KEY:inheritedKey},stdio:['ignore',log,log]});
fs.closeSync(log);child.unref();receipt.newPid=child.pid;
async function health(){return new Promise((resolve,reject)=>{const r=request('https://127.0.0.1:3444/health/ready',{ca,rejectUnauthorized:true},res=>{let text='';res.on('data',b=>text+=b);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});r.setTimeout(1500,()=>r.destroy(new Error('health timeout')));r.on('error',reject);r.end();});}
for(let i=0;i<40;i++){
 try{const r=await health();if(r.status===200){receipt.health=r;break;}}catch{}
 if(child.exitCode!==null)break;
 await new Promise(r=>setTimeout(r,200));
}
receipt.newHostReady=receipt.health?.status===200;receipt.finishedAtUtc=new Date().toISOString();
fs.writeFileSync(source+'/switch-public.json',JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
console.log(JSON.stringify(receipt));
assert.equal(receipt.newHostReady,true,'Retain migrated database and logs; never reopen it with the old 35-table host');
