import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const [source,mode,output]=process.argv.slice(2);
assert.equal(process.version,'v24.21.0');assert(['baseline','candidate'].includes(mode));
const load=path=>import(pathToFileURL(source+'/apps/teaching/'+path));
const {syncFiles}=await load('server/workspace/files.ts');
const {controlAttempt}=await load('server/workspace/controls.ts');
const {createAttempt}=await load('server/workspace/snapshots.ts');
const cases=[];
const fresh=()=>createAttempt([],{attemptId:'attempt',courseId:'course',studentId:'student',assignmentId:'assignment',activityVersionId:'activity'},true);
const summary=attempt=>({status:attempt.status,attemptRevision:attempt.attemptRevision,workspaceRevision:attempt.workspaceRevision,decisionEpoch:attempt.decisionEpoch});
const batch=(attempt,operations,seq=1)=>({expectedWorkspaceRevision:attempt.workspaceRevision,clientId:'synthetic-page',clientSeq:seq,operations});
const initial=syncFiles(fresh(),[],batch(fresh(),[{kind:'create',clientFileKey:'source',path:'main.c',text:'old'}]),true,{source:'source'});
assert.equal(initial.attempt.attemptRevision,2);assert.equal(initial.attempt.workspaceRevision,1);
cases.push({case:'ready_first_save_activates',before:summary(fresh()),after:summary(initial.attempt)});
for(const [name,status,assignmentActive] of [['active_update','active',true],['paused_update','paused',true],['assignment_paused_update','active',false]]){
  const before={...initial.attempt,status};
  const result=syncFiles(before,initial.files,batch(before,[{kind:'update',fileId:'source',baseVersion:1,text:'new'}],2),assignmentActive,{});
  assert.equal(result.attempt.attemptRevision,before.attemptRevision+(mode==='baseline'?1:0));
  assert.equal(result.attempt.workspaceRevision,before.workspaceRevision+1);assert.equal(result.files[0].documentVersion,2);
  cases.push({case:name,before:summary(before),after:summary(result.attempt),documentVersion:result.files[0].documentVersion});
}
const edited=syncFiles(initial.attempt,initial.files,batch(initial.attempt,[{kind:'update',fileId:'source',baseVersion:1,text:'new'}],2),true,{});
const sameText=syncFiles(initial.attempt,initial.files,batch(initial.attempt,[{kind:'update',fileId:'source',baseVersion:1,text:'old'}],2),true,{});
assert.equal(sameText.attempt.workspaceRevision,2);assert.equal(sameText.files[0].documentVersion,2);
assert.equal(sameText.attempt.attemptRevision,2+(mode==='baseline'?1:0));
cases.push({case:'new_batch_with_identical_body_still_confirms_file_version',after:summary(sameText.attempt),documentVersion:2});
let control;
try{control={accepted:true,after:summary(controlAttempt(edited.attempt,initial.attempt.attemptRevision,{kind:'pause'},true).attempt)};}
catch(error){control={accepted:false,errorCode:error.code};}
assert.equal(control.accepted,mode==='candidate');if(mode==='baseline')assert.equal(control.errorCode,'VERSION_CONFLICT');
cases.push({case:'pause_using_control_revision_read_before_file_edit',control});
const paused=controlAttempt(edited.attempt,edited.attempt.attemptRevision,{kind:'pause'},true).attempt;
assert.throws(()=>controlAttempt(paused,edited.attempt.attemptRevision,{kind:'resume'},true),{code:'VERSION_CONFLICT'});
assert.throws(()=>syncFiles(edited.attempt,edited.files,{...batch(edited.attempt,[{kind:'update',fileId:'source',baseVersion:2,text:'newer'}]),expectedWorkspaceRevision:1},true,{}),{code:'VERSION_CONFLICT'});
assert.throws(()=>syncFiles(edited.attempt,edited.files,batch(edited.attempt,[{kind:'update',fileId:'source',baseVersion:1,text:'newer'}]),true,{}),{code:'VERSION_CONFLICT'});
cases.push({case:'real_control_and_workspace_document_conflicts',staleControlRejected:true,staleWorkspaceRejected:true,staleDocumentRejected:true});
const recycled=syncFiles(initial.attempt,initial.files,batch(initial.attempt,[{kind:'recycle',fileId:'source',baseVersion:1}],2),true,{});
const restored=syncFiles(recycled.attempt,recycled.files,batch(recycled.attempt,[{kind:'restore',fileId:'source',baseVersion:2}],3),true,{});
assert.equal(restored.attempt.attemptRevision,initial.attempt.attemptRevision+(mode==='baseline'?2:0));
assert.equal(restored.attempt.workspaceRevision,3);assert.equal(restored.files[0].documentVersion,3);
cases.push({case:'file_recycle_restore_versions',before:summary(initial.attempt),after:summary(restored.attempt),documentVersion:3});
const {fixture,assigned,opened,files,command,view}=await load('server/workspace/test-support.ts');
const f=await fixture();
try{
 const teacher=await f.login('teacher'),student=await f.login(),allocation=await assigned(f,teacher),id=await opened(f,student,allocation.assignmentId);
 const ids=await files(f,student,id),before=await view(f,student,id);
 const target=before.files.find(file=>file.fileId===ids.source);
 const payload={expectedWorkspaceRevision:before.attempt.workspaceRevision,clientId:'h05-http',clientSeq:1,operations:[{kind:'update',fileId:target.fileId,baseVersion:target.documentVersion,text:'synthetic new source'}]};
 const first=await command(f,student,`/api/attempts/${id}/sync`,payload,'h05-edit');assert.equal(first.statusCode,200,first.body);
 const editedHead=await view(f,student,id);const replay=await command(f,student,`/api/attempts/${id}/sync`,payload,'h05-edit');assert.equal(replay.statusCode,200,replay.body);assert.equal(replay.json().data.replayed,true);
 assert.deepEqual((await view(f,student,id)).attempt,editedHead.attempt);
 const stale=await command(f,student,`/api/attempts/${id}/sync`,{...payload,clientSeq:2},'h05-stale-workspace');assert.equal(stale.statusCode,409);
 const stop=await command(f,student,`/api/attempts/${id}/controls`,{expectedAttemptRevision:before.attempt.attemptRevision,control:{kind:'pause'}},'h05-control-before-edit');
 assert.equal(stop.statusCode,mode==='baseline'?409:200,stop.body);
 cases.push({case:'normal_http_sqlite_ack_replay_and_control',before:summary(before.attempt),afterEdit:summary(editedHead.attempt),saveHttp:200,replayHttp:200,replayPreservesVersions:true,staleWorkspaceHttp:409,pauseUsingPriorControlHttp:stop.statusCode});
 const {readAttempt,saveAttempt}=await load('server/db/records-adapter.ts');
 const persisted=f.db.withTransaction(tx=>readAttempt(tx,id));
 for(const change of [{workspaceRevision:persisted.workspaceRevision+2},{status:persisted.status==='paused'?'active':'paused'},
   {decisionEpoch:persisted.decisionEpoch+1},{captureRevision:persisted.captureRevision+1},{route:'unapproved same-version change'},
   {workspaceRevision:persisted.workspaceRevision+1,status:persisted.status==='paused'?'active':'paused'}]){
   assert.throws(()=>f.db.withTransaction(tx=>saveAttempt(tx,{...persisted,...change})),{code:'VERSION_CONFLICT'});
   assert.deepEqual(f.db.withTransaction(tx=>readAttempt(tx,id)),persisted);
 }
 cases.push({case:'persistence_same_control_whitelist_and_rollback',forbiddenMutationsRejected:6,originalHeadPreserved:true});
}finally{await f.close();}
const result={node:process.version,mode,synthetic:true,productionSourceChanged:false,modelRequests:0,executionNodeRequests:0,cases};
writeFileSync(output,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({mode,cases:cases.length,passed:true,output}));
