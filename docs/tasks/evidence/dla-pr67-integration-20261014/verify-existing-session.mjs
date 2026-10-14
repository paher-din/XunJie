import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {request} from 'node:https';
import {setTimeout as delay} from 'node:timers/promises';
const output=process.argv[2],before=JSON.parse(readFileSync(process.argv[3],'utf8'));
const root='/opt/xunjie-runner/tests/i0-entry-20261013-01',cert=readFileSync(root+'/server.cert.pem');
const account=JSON.parse(execFileSync(root+'/xj-student-cred.sh',{encoding:'utf8',stdio:['ignore','pipe','pipe']}));
assert.equal(account.loginName,'synthetic-i0-student-a');
const expected=before.original24.assignments.find(value=>value.studentId===account.loginName);
assert.ok(expected);const data={checkedAt:new Date().toISOString(),origin:'https://127.0.0.1:3443',studentId:account.loginName,
  assignmentId:expected.assignmentId,deepLink:`https://127.0.0.1:3443/#/task/${expected.assignmentId}`,http:[],
  clockRegressions:[],durationSeconds:90,modelRequests:0,studentLearningWrites:0,browserAcceptance:false};
let cookie,csrf,last=Date.now();
async function call(method,path,body){
  const text=body===undefined?undefined:JSON.stringify(body),startedAtMs=Date.now();
  const response=await new Promise((resolve,reject)=>{const req=request(new URL(path,data.origin),{method,ca:cert,rejectUnauthorized:true,
    headers:{origin:data.origin,...(cookie?{cookie,'x-csrf-token':csrf}:{}),...(text?{'content-type':'application/json','content-length':Buffer.byteLength(text)}:{})}},res=>{
    let body='';res.setEncoding('utf8');res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:JSON.parse(body)}));});
    req.setTimeout(10000,()=>req.destroy(new Error('Session verification request timed out')));req.on('error',reject);req.end(text);});
  data.http.push({method,path,status:response.status,startedAtMs,endedAtMs:Date.now(),requestId:response.body.requestId});
  assert.equal(response.status,200,`${method} ${path} status=${response.status}`);return response;
}
try{
  const login=await call('POST','/api/sessions',{loginName:account.loginName,password:account.password});
  cookie=login.headers['set-cookie'].map(value=>value.split(';',1)[0]).join('; ');csrf=login.body.data.csrfToken;
  const bootstrap=(await call('GET',`/api/assignments/${expected.assignmentId}/bootstrap`)).body.data;
  data.bootstrap={recoveryGeneration:bootstrap.recoveryGeneration,assignmentId:bootstrap.assignment.assignmentId,
    activityVersionId:bootstrap.assignment.activityVersionId,assignmentRevision:bootstrap.assignment.assignmentRevision,active:bootstrap.assignment.active};
  const existing=before.original24.attempts.find(value=>value.assignmentId===expected.assignmentId&&value.studentId===account.loginName);
  assert.ok(existing);const head=(await call('GET',`/api/attempts/${existing.attemptId}`)).body.data;
  data.attempt={attemptId:head.attempt.attemptId,workspaceRevision:head.attempt.workspaceRevision,attemptRevision:head.attempt.attemptRevision,
    snapshots:head.snapshots.map(value=>({snapshotId:value.snapshotId,hash:value.hash})),runs:head.runs.map(value=>({runId:value.runId,jobId:value.jobId}))};
  assert.equal(head.attempt.workspaceRevision,existing.workspaceRevision);assert.equal(head.attempt.attemptRevision,existing.attemptRevision);
  const started=performance.now();let reads=0;
  while(performance.now()-started<90000){
    const wall=Date.now();if(wall<last)data.clockRegressions.push({from:last,to:wall,deltaMs:wall-last});last=wall;
    const session=(await call('GET','/api/session')).body.data;assert.equal(session.userId,account.loginName);reads++;await delay(1000);
  }
  data.sessionReads=reads;data.elapsedMs=Math.round(performance.now()-started);assert.equal(data.clockRegressions.length,0);
  data.passed=true;
}catch(error){data.passed=false;data.failure={name:error.name,message:error.message};process.exitCode=1;}
finally{
  const text=JSON.stringify(data,null,2)+'\n';for(const secret of [account.password,cookie,csrf])if(secret)assert(!text.includes(secret));
  writeFileSync(output,text,{flag:'wx',mode:0o600});console.log(JSON.stringify({passed:data.passed,sessionReads:data.sessionReads,failure:data.failure,
    deepLink:data.deepLink,clockRegressions:data.clockRegressions.length,studentLearningWrites:0,modelRequests:0}));
}
