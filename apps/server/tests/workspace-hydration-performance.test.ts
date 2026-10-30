import assert from 'node:assert/strict';
import test from 'node:test';
import {rmSync} from 'node:fs';
import {dirname} from 'node:path';
import {fixture,allocate,command,view} from './dl-a-support.ts';
import {loadWorkspace} from '../server/workspace/storage.ts';
import {latestSubmission} from '../server/workspace/submissions.ts';

const review={versions:{modelConfigVersion:'disabled',promptVersion:'disabled',schemaVersion:'review-v1',analysisVersion:'review-v1'}};

test('real teacher workbench validates a course ledger once per transaction and rereads later committed state',async()=>{
  const f=await fixture(undefined,{review});
  try{
    const teacher=await f.login('teacher'),student=await f.login(),other=await f.login('other');
    const first=await allocate(f,teacher,student,false),second=await allocate(f,teacher,other,false,{studentId:'other'});
    const head=await view(f,student,first.attemptId);
    const submitted=await command(f,student,`/api/attempts/${first.attemptId}/submissions`,{
      expectedAttemptRevision:head.attempt.attemptRevision,snapshotId:first.snapshotId});
    assert.equal(submitted.statusCode,200,submitted.body);
    const original=f.db.withTransaction;
    let ledgers=0,bindings=0;
    f.db.withTransaction=work=>original(tx=>work({...tx,all(sql,...args){
      if(sql.includes("FROM command_receipts WHERE course_id=? AND command LIKE 'shared.%'"))ledgers++;
      if(sql.includes("FROM workspace_command_bindings WHERE kind='public'"))bindings++;
      return tx.all(sql,...args);
    }}));
    const get=()=>f.app.inject({url:'/api/courses/course/teacher-workbench',headers:teacher});
    const response=await get();assert.equal(response.statusCode,200,response.body);
    assert.equal(ledgers,1,'all attempts share one fully validated ledger in this synchronous authorized read');
    assert.equal(bindings,1);
    const projected=response.json().data.attempts;
    for(const id of [first.attemptId,second.attemptId]){
      const expected=original(tx=>{const state=loadWorkspace(tx,id);return {attempt:state.attempt,latest:latestSubmission(state)};});
      const actual=projected.find((item:{attemptId:string})=>item.attemptId===id);
      assert.equal(actual.workspaceRevision,expected.attempt.workspaceRevision);
      assert.deepEqual(actual.latestSubmission,expected.latest?{submissionId:expected.latest.submissionId,
        snapshotId:expected.latest.snapshotId,submittedAt:expected.latest.submittedAt}:null);
    }
    const before=await view(f,other,second.attemptId),file=before.files[0];
    assert.equal((await command(f,other,`/api/attempts/${second.attemptId}/sync`,{
      expectedWorkspaceRevision:before.attempt.workspaceRevision,clientId:'new-window',clientSeq:1,
      operations:[{kind:'update',fileId:file.fileId,baseVersion:file.documentVersion,text:'int main(void){return 1;}'}]})).statusCode,200);
    ledgers=0;bindings=0;
    const fresh=await get();assert.equal(fresh.statusCode,200,fresh.body);
    assert.equal(ledgers,1);assert.equal(bindings,1);
    assert.equal(fresh.json().data.attempts.find((item:{attemptId:string})=>item.attemptId===second.attemptId).workspaceRevision,before.attempt.workspaceRevision+1);
    // Every new request still validates bindings and snapshot contents; shared hydration never hides later damage.
    const binding=original(tx=>tx.get("SELECT * FROM workspace_command_bindings WHERE kind='public' LIMIT 1"))!;
    const alias=JSON.parse(String(binding.identity_json));alias.actorId='different-actor';
    original(tx=>tx.run('UPDATE workspace_command_bindings SET identity_json=? WHERE kind=? AND key_json=?',JSON.stringify(alias),binding.kind!,binding.key_json!));
    assert.equal((await get()).statusCode,503);
    original(tx=>tx.run('UPDATE workspace_command_bindings SET identity_json=? WHERE kind=? AND key_json=?',binding.identity_json!,binding.kind!,binding.key_json!));
    const snapshot=original(tx=>tx.get('SELECT * FROM artifact_snapshots WHERE snapshot_id=?',first.snapshotId))!;
    const invalid=JSON.parse(String(snapshot.snapshot_json));invalid.hash='0'.repeat(64);
    original(tx=>tx.run('UPDATE artifact_snapshots SET snapshot_json=? WHERE snapshot_id=?',JSON.stringify(invalid),first.snapshotId));
    assert.equal((await get()).statusCode,503);
    original(tx=>tx.run('UPDATE artifact_snapshots SET snapshot_json=? WHERE snapshot_id=?',snapshot.snapshot_json!,first.snapshotId));
    original(tx=>tx.run("UPDATE course_memberships SET active=0 WHERE course_id='course' AND user_id='teacher'"));
    ledgers=0;
    assert.equal((await get()).statusCode,403);assert.equal(ledgers,0,'authorization precedes hydration on every request');
  }finally{await f.close();rmSync(dirname(f.db.file),{recursive:true,force:true});}
});
