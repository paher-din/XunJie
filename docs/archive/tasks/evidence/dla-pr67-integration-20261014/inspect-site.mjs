import {readFileSync,writeFileSync,readdirSync,statSync} from 'node:fs';
import {createHash,X509Certificate} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const source=process.argv[2],output=process.argv[3],root='/opt/xunjie-runner/tests/i0-entry-20261013-01';
const config=JSON.parse(readFileSync(root+'/i0-host-recovered-20261014.json','utf8'));
const {default:Database}=await import(pathToFileURL(source+'/apps/teaching/node_modules/better-sqlite3/lib/index.js'));
const sha=value=>createHash('sha256').update(value).digest('hex');
function database(file){const db=new Database(file,{readonly:true,fileMustExist:true});try{
  const schema=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const assignments=db.prepare('SELECT * FROM assignments').all().map(row=>({assignmentId:row.id,activityId:row.activity_id,
    studentId:row.student_id,revision:row.assignment_revision,status:row.status}));
  const attempts=db.prepare('SELECT * FROM attempts').all().map(row=>{const body=JSON.parse(row.attempt_json);return {
    attemptId:row.attempt_id,assignmentId:body.assignmentId,studentId:body.studentId,status:body.status,
    workspaceRevision:body.workspaceRevision,attemptRevision:body.attemptRevision};});
  const jobs=db.prepare('SELECT job_json FROM jobs').all().map(row=>JSON.parse(row.job_json));
  return {file,tables:schema.length,assignments,attempts,jobCount:jobs.length,
    pendingJobCount:jobs.filter(row=>['queued','running','cancelling'].includes(row.status)).length};
}finally{db.close();}}
function tree(directory){const files=[];function visit(root,prefix=''){
  for(const name of readdirSync(root).sort()){const path=join(root,name),relative=prefix+name;
    if(statSync(path).isDirectory())visit(path,relative+'/');else files.push([relative,sha(readFileSync(path))]);}}
  visit(directory);return {directory,files:files.length,manifestSha256:sha(JSON.stringify(files)),fileHashes:files};}
const retained=JSON.parse(readFileSync('/opt/xunjie-runner/tests/dla-continuation-20261014/real-hdl-final-frozen.json','utf8'));
const data={checkedAt:new Date().toISOString(),node:process.version,original24:database(config.databaseFile),original35:database(retained.databaseFile),
  oldConfiguredUi:tree(config.staticDirectory),newUi:tree(source+'/apps/student/dist'),certificateFingerprint256:new X509Certificate(readFileSync(config.tls.certFile)).fingerprint256,
  unchangedReferences:{configurationFile:root+'/i0-host-recovered-20261014.json',generationFile:config.generationFile,tlsCertificateFile:config.tls.certFile},
  scope:'read-only public metadata; no credentials, snapshots, message bodies or database writes'};
writeFileSync(output,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});console.log(JSON.stringify({tables24:data.original24.tables,
  tables35:data.original35.tables,pending24:data.original24.pendingJobCount,pending35:data.original35.pendingJobCount,
  newUiFiles:data.newUi.files,output}));
