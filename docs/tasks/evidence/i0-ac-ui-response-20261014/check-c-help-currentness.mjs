import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
const [source,output]=process.argv.slice(2);
const load=path=>import(pathToFileURL(source+'/apps/teaching/'+path));
const {fixture,allocate,command,view}=await load('tests/dl-a-support.ts');
const {SyntheticProvider}=await load('server/tutoring/providers.ts');
const cases=[];
for(const targetChanged of [true,false]){
 let started,release;
 const entered=new Promise(resolve=>{started=resolve;});
 const wait=new Promise(resolve=>{release=resolve;});
 const provider=new SyntheticProvider([async request=>{
   started();await wait;
   return {body:{kind:'student_help',actionType:'hint',content:'请核对已确认代码，再自行检查。',rationale:'只解释所选版本。',expectedStudentAction:'自行检查。',evidenceIds:[request.untrustedInput.references[0].id],resourceRefs:[],assistanceContext:'合成隔离验证。',unresolved:[],policyChecks:{containsWholeSolution:false,writesStudentWork:false,runsCode:false,makesFormalEvaluation:false}}};
 }]);
 const f=await fixture(undefined,{studentHelp:{versions:{modelConfig:'synthetic',prompt:'synthetic',schema:'synthetic',policy:'course-help'},budgetAvailable:()=>true},tutoringProvider:provider});
 try{
  const teacher=await f.login('teacher'),student=await f.login(),item=await allocate(f,teacher,student,false),head=await view(f,student,item.attemptId),file=head.files[0];
  const accepted=await command(f,student,`/api/attempts/${item.attemptId}/help`,{expectedAttemptRevision:head.attempt.attemptRevision,question:'给一点提示',objectRef:{kind:'code',attemptId:item.attemptId,snapshotId:item.snapshotId,fileId:file.fileId,path:file.path,documentVersion:file.documentVersion,contentHash:file.contentHash}});
  assert.equal(accepted.statusCode,200,accepted.body);f.host.startConsumer(50);await entered;
  const current=await view(f,student,item.attemptId);
  const edited=await command(f,student,`/api/attempts/${item.attemptId}/sync`,{expectedWorkspaceRevision:current.attempt.workspaceRevision,clientId:'currentness',clientSeq:1,operations:[targetChanged?{kind:'update',fileId:file.fileId,baseVersion:file.documentVersion,text:'changed target'}:{kind:'create',clientFileKey:'other',path:'notes.txt',text:'unrelated source'}]});
  assert.equal(edited.statusCode,200,edited.body);assert.equal((await view(f,student,item.attemptId)).attempt.attemptRevision,current.attempt.attemptRevision);
  release();const jobId=accepted.json().data.result.jobId;let status;
  for(let i=0;i<100;i++){const response=await f.app.inject({url:'/api/jobs/'+jobId,headers:student});status=response.json().data.status;if(['stale','failed','succeeded','cancelled'].includes(status))break;await delay(20);}
  const actions=f.db.withTransaction(tx=>tx.all('SELECT action_id,disposition FROM teaching_actions WHERE job_id=?',jobId));
  if(targetChanged){assert.equal(status,'stale');assert(actions.every(row=>row.disposition==='stale'));}else{assert.equal(status,'succeeded');assert.equal(actions.length,1);assert.equal(actions[0].disposition,'pending');}
  cases.push({targetChanged,controlRevisionPreserved:true,jobStatus:status,actionDispositions:actions.map(row=>row.disposition),externalModelRequests:0});
 }finally{release();await f.close();}
}
writeFileSync(output,JSON.stringify({synthetic:true,externalModelRequests:0,cases},null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({cases:cases.length,passed:true,externalModelRequests:0}));
