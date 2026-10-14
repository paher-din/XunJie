import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {request} from 'node:https';
import {execFileSync} from 'node:child_process';
const [workspace,source,output]=process.argv.slice(2);
assert.equal(process.version,'v24.21.0');
const read=path=>JSON.parse(readFileSync(path,'utf8'));
const evidence=workspace+'/docs/tasks/evidence';
const projected=read(evidence+'/i0-ui30-comment-closeout/server-run-projection.json');
const facts=read(evidence+'/i0-ui30-comment-closeout/workspace-snapshot-facts.json');
const config=read('/opt/xunjie-runner/tests/i0-entry-20261013-01/i0-host-recovered-20261014.json');
const {default:Database}=await import(pathToFileURL(source+'/apps/teaching/node_modules/better-sqlite3/lib/index.js'));
const {manifestHash}=await import(pathToFileURL(source+'/apps/teaching/runner/snapshot.ts'));
const sha=text=>createHash('sha256').update(text).digest('hex');
const db=new Database(config.databaseFile,{readonly:true,fileMustExist:true});const checkedRuns=[];
try{
 for(const row of projected.runs){
  const saved=db.prepare('SELECT * FROM workspace_runs WHERE run_id=? AND attempt_id=?').get(row.runId,projected.approvedAttemptId);assert(saved);
  const job=JSON.parse(db.prepare('SELECT job_json FROM jobs WHERE job_id=?').get(saved.job_id).job_json),submission=JSON.parse(saved.submission_json);
  assert.equal(saved.job_id,row.jobId);assert.equal(saved.snapshot_id,row.snapshotId);assert.equal(job.status,row.jobStatus);
  assert.equal(job.runId,row.runId);assert.equal(job.recoveryGeneration,row.recoveryGeneration);assert.equal(job.requestReceiptId,row.requestReceiptId);
  assert.equal(submission.identity.snapshotId,row.snapshotId);assert.equal(submission.snapshot.hash,row.snapshotHash);
  assert.equal(saved.result_hash,row.resultHash);if(saved.result_json!==null)assert.equal(sha(saved.result_json),saved.result_hash);
  checkedRuns.push({runId:row.runId,jobId:row.jobId,status:job.status,snapshotId:row.snapshotId,relationsPreserved:true});
 }
 for(const row of facts.snapshots){
  const snapshot=JSON.parse(db.prepare('SELECT snapshot_json FROM artifact_snapshots WHERE snapshot_id=? AND attempt_id=?').get(row.snapshotId,facts.attemptId).snapshot_json);
  assert.equal(snapshot.hash,row.hash);assert.equal(manifestHash(snapshot.files),row.hash);assert.equal(snapshot.workspaceRevision,row.workspaceRevision);
  for(const file of row.files){const stored=snapshot.files.find(value=>value.fileId===file.fileId);assert(stored);assert.equal(stored.contentHash,file.contentHash);assert.equal(sha(stored.text),file.contentHash);assert.equal(stored.documentVersion,file.documentVersion);}
 }
 assert.equal(db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE attempt_id=? AND status IN ('queued','running','cancelling','outcome_unknown')").get(projected.approvedAttemptId).n,0);
}finally{db.close();}
const ui=read(evidence+'/i0-ui-prep-closeout/student-real-dist-manifest.json'),ours=read(evidence+'/dla-pr56-review-20261014/main-student-dist-manifest.json');
const map=value=>new Map(value.files.map(row=>[row.path,{bytes:row.bytes,sha256:row.sha256}]));assert.deepEqual(map(ui),map(ours));
const http=[];
for(const port of [3443,3444])for(const path of ['/health/live','/health/ready','/api/session']){
 const response=await new Promise((resolve,reject)=>{const req=request(`https://127.0.0.1:${port}${path}`,{ca:readFileSync(config.tls.certFile),rejectUnauthorized:true},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,cacheControl:res.headers['cache-control'],body:JSON.parse(Buffer.concat(chunks).toString('utf8'))}));});req.setTimeout(6000,()=>req.destroy(new Error('Read-only HTTP timeout')));req.on('error',reject);req.end();});
 assert.equal(response.status,path==='/api/session'?401:200);if(path==='/health/ready'){assert.equal(response.cacheControl,'no-store');assert.equal(response.body.data.status,'ready');}
 http.push({port,path,status:response.status,...(path==='/health/ready'?{noStore:true}: {})});
}
const cUnits=['xunjie-i0-entry-pr56-f761dcd-20261014.service','xunjie-i0-entry-main-87edd51-20261014.service'];
const activeC=cUnits.filter(unit=>{try{return execFileSync('systemctl',['is-active',unit],{encoding:'utf8'}).trim()==='active';}catch{return false;}});assert.equal(activeC.length,1);
const units=[activeC[0],'xunjie-dla-ui-main-87edd51-20261014.service'];
const services=units.map(unit=>{const status=execFileSync('systemctl',['is-active',unit],{encoding:'utf8'}).trim();assert.equal(status,'active');return {unit,status,execStart:execFileSync('systemctl',['show',unit,'-p','ExecStart','--value'],{encoding:'utf8'}).trim()};});
const result={checkedAt:new Date().toISOString(),readOnly:true,studentLearningWrites:0,modelRequests:0,executionNodeMutations:0,originalRunCount:checkedRuns.length,checkedRuns,originalSnapshotCount:facts.snapshots.length,snapshotHashesPreserved:true,ui143FileBytesMatch:true,zipContainerHashesMayDiffer:true,http,services,browserAcceptance:false};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({originalRuns:checkedRuns.length,originalSnapshots:facts.snapshots.length,ui143FilesMatch:true,http:http.map(row=>row.status),passed:true,output}));
