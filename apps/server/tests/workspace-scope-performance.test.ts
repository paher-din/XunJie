import assert from 'node:assert/strict';
import test from 'node:test';
import {dirname} from 'node:path';
import {rmSync} from 'node:fs';
import {fixture,allocate,command,view} from './dl-a-support.ts';
import {loadWorkspace,readWorkspaceRecords,readProcessRecords} from '../server/workspace/storage.ts';
import {readWorkspace} from '../server/workspace/commands.ts';
import {readCoverageIntervals} from '../server/records/teaching.ts';
import {resolveEvidence} from '../server/review/evidence.ts';

const review={versions:{modelConfigVersion:'disabled',promptVersion:'disabled',schemaVersion:'review-v1',analysisVersion:'review-v1'}};

test('explicit attempt hydration preserves course create/coverage roots, exact full projections, and same-student cross-attempt evidence',async()=>{
  const f=await fixture(undefined,{review});
  try{
    const teacher=await f.login('teacher'),student=await f.login(),other=await f.login('other');
    const first=await allocate(f,teacher,student,false),second=await allocate(f,teacher,student,false);
    const peer=await allocate(f,teacher,other,false,{studentId:'other'});
    const foreign=await allocate(f,teacher,student,false,{course:'logic-course'});
    const before=await view(f,student,first.attemptId);
    const control=await command(f,student,`/api/attempts/${first.attemptId}/controls`,{
      expectedAttemptRevision:before.attempt.attemptRevision,control:{kind:'capture',value:false}});
    assert.equal(control.statusCode,200,control.body);
    f.db.withTransaction(tx=>{
      const scoped=loadWorkspace(tx,first.attemptId),full=readWorkspaceRecords(tx,'course');
      const expected=full.receipts.filter(row=>row.identity.scope.attemptId===undefined||row.identity.scope.attemptId===first.attemptId);
      assert.deepEqual(new Set(scoped.records.receipts.map(row=>row.receiptId)),new Set(expected.map(row=>row.receiptId)));
      assert(!scoped.records.receipts.some(row=>row.identity.scope.attemptId===second.attemptId));
      assert.deepEqual(readWorkspace(scoped,()=>true,true),readWorkspace({...scoped,records:full},()=>true,true));
      const create=scoped.records.receipts.find(row=>row.identity.command==='attempt.create'&&(row.result as {attemptId?:string}).attemptId===first.attemptId)!;
      assert(create);assert.equal(create.identity.scope.attemptId,undefined);
      const coverage=readCoverageIntervals(tx,first.attemptId);
      assert.equal(coverage.intervals[0]!.fromServerSeq,create.serverSeq);
      assert.equal(coverage.intervals[0]!.state,'collecting');assert.equal(coverage.intervals.at(-1)!.state,'paused');
      assert.equal(coverage.cutoffServerSeq,full.serverSeq);
      const process=readProcessRecords(tx,first.attemptId);
      assert(process.some(row=>row.kind==='coverage'));assert(process.every(row=>scoped.records.receipts.some(receipt=>receipt.receiptId===row.receiptId)));
      const scope={courseId:'course',studentId:'student',attemptId:first.attemptId};
      assert.deepEqual(resolveEvidence(tx,scope,{kind:'snapshot',attemptId:second.attemptId,id:second.snapshotId}).groupIds,[second.attemptId]);
      for(const item of [peer,foreign])assert.throws(()=>resolveEvidence(tx,scope,{kind:'snapshot',attemptId:item.attemptId,id:item.snapshotId}),{code:'INVALID_REFERENCE'});
    });
    assert.equal((await f.app.inject({url:`/api/attempts/${first.attemptId}`,headers:other})).statusCode,403);
    f.db.withTransaction(tx=>tx.run("UPDATE course_memberships SET active=0 WHERE course_id='course' AND user_id='student'"));
    assert.equal((await f.app.inject({url:`/api/attempts/${first.attemptId}`,headers:student})).statusCode,403);
  }finally{await f.close();rmSync(dirname(f.db.file),{recursive:true,force:true});}
});

test('real sync retries preserve global original/binding recovery-before-course conflicts without writing another ACK',async()=>{
  const f=await fixture(undefined,{review});
  try{
    const teacher=await f.login('teacher'),student=await f.login();
    const own=await allocate(f,teacher,student,false),foreign=await allocate(f,teacher,student,false,{course:'logic-course'});
    const head=await view(f,student,own.attemptId),file=head.files[0],url=`/api/attempts/${own.attemptId}/sync`;
    const body={expectedWorkspaceRevision:head.attempt.workspaceRevision,clientId:'scope-global',clientSeq:1,
      operations:[{kind:'update',fileId:file.fileId,baseVersion:file.documentVersion,text:'scope conflict fixture'}]};
    const saved=await command(f,student,url,body,'scope-key');assert.equal(saved.statusCode,200,saved.body);
    const ownReceipt=f.db.withTransaction(tx=>tx.get('SELECT * FROM command_receipts WHERE receipt_id=?',saved.json().data.receiptId))!;
    const foreignReceipt=f.db.withTransaction(tx=>tx.get("SELECT * FROM command_receipts WHERE course_id='logic-course' AND command='shared.workspace.sync' AND target=?",`/api/attempts/${foreign.attemptId}/sync`))!;
    const counts=()=>f.db.withTransaction(tx=>({receipts:tx.get('SELECT count(*) AS n FROM command_receipts')!.n,events:tx.get('SELECT count(*) AS n FROM audit_events')!.n}));
    const originalCounts=counts();
    const expect=async(code:string)=>{const response=await command(f,student,url,body,'scope-key');assert.equal(response.statusCode,409,response.body);assert.equal(response.json().error.code,code);assert.deepEqual(counts(),originalCounts);};
    // The global original is checked before its untrusted JSON could be admitted through relatedIds.
    for(const generation of ['old-generation','generation']){
      f.db.withTransaction(tx=>tx.run('UPDATE command_receipts SET course_id=?,recovery_generation=? WHERE receipt_id=?','logic-course',generation,ownReceipt.receipt_id!));
      await expect(generation==='generation'?'IDEMPOTENCY_CONFLICT':'RECOVERY_REQUIRED');
    }
    f.db.withTransaction(tx=>tx.run('UPDATE command_receipts SET course_id=?,recovery_generation=? WHERE receipt_id=?',ownReceipt.course_id!,ownReceipt.recovery_generation!,ownReceipt.receipt_id!));
    // A binding to a foreign receipt must be point-checked, never silently treated as a fresh sync.
    f.db.withTransaction(tx=>tx.run("UPDATE workspace_command_bindings SET receipt_id=? WHERE receipt_id=?",foreignReceipt.receipt_id!,ownReceipt.receipt_id!));
    await expect('IDEMPOTENCY_CONFLICT');
    f.db.withTransaction(tx=>tx.run('UPDATE command_receipts SET recovery_generation=? WHERE receipt_id=?','old-generation',foreignReceipt.receipt_id!));
    await expect('RECOVERY_REQUIRED');
    f.db.withTransaction(tx=>{
      tx.run('UPDATE command_receipts SET recovery_generation=? WHERE receipt_id=?',foreignReceipt.recovery_generation!,foreignReceipt.receipt_id!);
      tx.run('UPDATE workspace_command_bindings SET receipt_id=? WHERE receipt_id=? AND json_extract(identity_json,\'$.scope.attemptId\')=?',ownReceipt.receipt_id!,foreignReceipt.receipt_id!,own.attemptId);
    });
    const replay=await command(f,student,url,body,'scope-key');assert.equal(replay.statusCode,200,replay.body);
    assert.equal(replay.json().data.replayed,true);assert.deepEqual(replay.json().data.result,saved.json().data.result);assert.deepEqual(counts(),originalCounts);
  }finally{await f.close();rmSync(dirname(f.db.file),{recursive:true,force:true});}
});

test('selected aliases and moved receipt/event scopes fail closed while an unrelated damaged attempt remains a course-wide failure',async()=>{
  const f=await fixture(undefined,{review});
  try{
    const teacher=await f.login('teacher'),student=await f.login(),other=await f.login('other');
    const own=await allocate(f,teacher,student,false),peer=await allocate(f,teacher,other,false,{studentId:'other'});
    const ownReceipt=f.db.withTransaction(tx=>tx.get("SELECT * FROM command_receipts WHERE command='shared.workspace.sync' AND target=?",`/api/attempts/${own.attemptId}/sync`))!;
    // Both receipt/event JSON scopes move away; the original binding still pulls the owner into validation.
    assert.throws(()=>f.db.withTransaction(tx=>{
      const receipt=JSON.parse(String(ownReceipt.result_json));receipt.identity.scope.attemptId=peer.attemptId;
      tx.run('UPDATE command_receipts SET result_json=? WHERE receipt_id=?',JSON.stringify(receipt),ownReceipt.receipt_id!);
      const row=tx.get('SELECT object_ref_json FROM audit_events WHERE server_seq=?',ownReceipt.server_seq!)!,event=JSON.parse(String(row.object_ref_json));
      event.scope.attemptId=peer.attemptId;tx.run('UPDATE audit_events SET object_ref_json=? WHERE server_seq=?',JSON.stringify(event),ownReceipt.server_seq!);
      loadWorkspace(tx,own.attemptId);
    }));
    assert.throws(()=>f.db.withTransaction(tx=>{
      const row=tx.get("SELECT * FROM workspace_command_bindings WHERE kind='public' AND receipt_id=?",ownReceipt.receipt_id!)!,identity=JSON.parse(String(row.identity_json));
      identity.scope.attemptId=peer.attemptId;
      tx.run("UPDATE workspace_command_bindings SET identity_json=? WHERE kind='public' AND key_json=?",JSON.stringify(identity),row.key_json!);loadWorkspace(tx,own.attemptId);
    }));
    const peerReceipt=f.db.withTransaction(tx=>tx.get("SELECT * FROM command_receipts WHERE command='shared.workspace.sync' AND target=?",`/api/attempts/${peer.attemptId}/sync`))!;
    const receipt=JSON.parse(String(peerReceipt.result_json));receipt.result='nonfinite-fixture';
    f.db.withTransaction(tx=>tx.run('UPDATE command_receipts SET result_json=? WHERE receipt_id=?',JSON.stringify(receipt).replace('"nonfinite-fixture"','1e309'),peerReceipt.receipt_id!));
    try{
      assert.equal((await f.app.inject({url:`/api/attempts/${own.attemptId}`,headers:student})).statusCode,200);
      assert.equal((await f.app.inject({url:'/api/courses/course/teacher-workbench',headers:teacher})).statusCode,503);
    }finally{f.db.withTransaction(tx=>tx.run('UPDATE command_receipts SET result_json=? WHERE receipt_id=?',peerReceipt.result_json!,peerReceipt.receipt_id!));}
    assert.equal((await f.app.inject({url:'/api/courses/course/teacher-workbench',headers:teacher})).statusCode,200);
  }finally{await f.close();rmSync(dirname(f.db.file),{recursive:true,force:true});}
});
