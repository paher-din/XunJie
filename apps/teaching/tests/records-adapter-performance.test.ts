import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {dirname} from 'node:path';
import {rmSync} from 'node:fs';
import {createWorkspaceDatabase,type Transaction} from '../server/db/transaction.ts';
import {readRecords,saveRecordPlan,finishRecordCommand,saveJob} from '../server/db/records-adapter.ts';
import type {CommandReceipt,AuditEvent} from '../contracts/records/index.ts';

function fixture(count:number,scoped:boolean|'distributed'=false){
  const db=createWorkspaceDatabase(),at='2026-10-23T00:00:00.000Z',course='capacity-regression';
  const created=JSON.parse('{"__proto__":"file-1","constructor":"file-2"}') as Record<string,string>;
  const result={created,nested:[true,false,null,17,{text:'Fixture ACK'}]};
  db.withTransaction(tx=>{
    tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length) VALUES(?,?,?,?,?,?,?,?,?)',
      'actor','actor',randomBytes(64),randomBytes(16),'scrypt',131072,8,1,64);
    tx.run('INSERT INTO courses(id) VALUES(?)',course);
    for(let i=1;i<=count;i++){
      const scope=scoped?{courseId:course,studentId:'actor',attemptId:scoped==='distributed'?'attempt-'+(i%4):i===1?'own-attempt':'other-attempt'}:{courseId:course};
      const receipt:CommandReceipt={receiptId:'receipt-'+i,commandId:'command-'+i,identity:{actorId:'actor',command:'workspace.sync',target:`/api/attempts/${scope.attemptId??'fixture'}/sync`,scope,idempotencyKey:'request-'+i,recoveryGeneration:'generation'},
        requestHash:'a'.repeat(64),result,serverSeq:i,committedAt:at};
      const event:AuditEvent={eventId:'event-'+i,serverSeq:i,scope,type:'workspace.sync',occurredAt:at,source:'student_command',payloadRef:receipt.receiptId};
      saveRecordPlan(tx,receipt,event);
    }
  });
  return {db,course,result,read:()=>db.withTransaction(tx=>readRecords(tx,course)),close(){db.close();rmSync(dirname(db.file),{recursive:true,force:true});}};
}

test('an attempt ledger reads its exact validated history without hydrating unrelated course ACKs and keeps the global sequence',()=>{
  const f=fixture(2124,true);try{
    let rowsRead=0;
    const records=f.db.withTransaction(tx=>readRecords({...tx,all(sql,...args){
      const rows=tx.all(sql,...args);rowsRead+=rows.filter(row=>'result_json' in row).length;return rows;
    }},f.course,'own-attempt'));
    assert.equal(records.receipts.length,1);assert.equal(rowsRead,1,'only the authorized attempt ACK is hydrated');
    assert.equal(records.events.length,1);assert.equal(records.serverSeq,2124);
    assert.deepEqual(records.receipts[0]!.result,f.result);
    // A corrupted event cannot disappear by moving its JSON scope: its selected receipt still owns it.
    assert.throws(()=>f.db.withTransaction(tx=>{
      const row=tx.get('SELECT object_ref_json FROM audit_events WHERE event_id=?','event-1')!;
      const event=JSON.parse(String(row.object_ref_json));event.scope.attemptId='other-attempt';
      tx.run('UPDATE audit_events SET object_ref_json=? WHERE event_id=?',JSON.stringify(event),'event-1');
      readRecords(tx,f.course,'own-attempt');
    }));
    // A receipt cannot hide by changing its JSON scope while its durable target still names this attempt.
    assert.throws(()=>f.db.withTransaction(tx=>{
      const row=tx.get('SELECT result_json FROM command_receipts WHERE receipt_id=?','receipt-1')!;
      const receipt=JSON.parse(String(row.result_json));receipt.identity.scope.attemptId='other-attempt';
      tx.run('UPDATE command_receipts SET result_json=? WHERE receipt_id=?',JSON.stringify(receipt),'receipt-1');
      readRecords(tx,f.course,'own-attempt');
    }));
    assert.equal(f.read().receipts.length,2124,'the retained course history is unchanged');
  }finally{f.close();}
});

test('explicit attempt scope retains no-attempt course jobs/roots and object payload events with their sequence owner',()=>{
  const f=fixture(3,true);try{
    f.db.withTransaction(tx=>{
      const root=finishRecordCommand(tx,{actorId:'actor',command:'course.root',target:f.course,scope:{courseId:f.course},
        idempotencyKey:'root',recoveryGeneration:'generation'},{},'generation',Date.now(),()=>({root:true}),value=>value);
      saveJob(tx,{jobId:'course-job',kind:'design',purpose:'teacher_design',scope:{courseId:f.course},requestReceiptId:root.receiptId,
        status:'outcome_unknown',stopRequested:true,expectedRevision:1,decisionEpoch:0,recoveryGeneration:'generation',
        acceptedAt:'2026-10-23T00:00:00.000Z',deadline:'2026-10-23T00:01:00.000Z',attemptCount:1});
      const row=tx.get('SELECT object_ref_json FROM audit_events WHERE event_id=?','event-1')!,event=JSON.parse(String(row.object_ref_json));
      event.payloadRef='teaching-delivery';tx.run('UPDATE audit_events SET object_ref_json=? WHERE event_id=?',JSON.stringify(event),'event-1');
      const selected=readRecords(tx,f.course,'own-attempt');
      assert.equal(selected.receipts.length,2);assert(selected.receipts.some(receipt=>receipt.receiptId===root.receiptId));
      assert.equal(selected.jobs[0]!.jobId,'course-job');assert.equal(selected.events.length,2);assert.equal(selected.serverSeq,4);
      assert.equal(selected.events.find(item=>item.eventId==='event-1')!.payloadRef,'teaching-delivery');
    });
  }finally{f.close();}
});

test('2124-receipt four-attempt benchmark keeps exact target ACKs and global order without a latency acceptance claim',t=>{
  const f=fixture(2124,'distributed');try{
    const samples:{fullMs:number;scopedMs:number}[]=[];
    for(let round=0;round<3;round++)f.db.withTransaction(tx=>{
      const at=performance.now(),full=readRecords(tx,f.course),middle=performance.now(),scoped=readRecords(tx,f.course,'attempt-1'),end=performance.now();
      assert.equal(full.receipts.length,2124);assert.equal(scoped.receipts.length,531);assert.equal(scoped.events.length,531);
      assert.equal(scoped.serverSeq,full.serverSeq);assert.deepEqual(scoped.receipts,full.receipts.filter(receipt=>receipt.identity.scope.attemptId==='attempt-1'));
      samples.push({fullMs:middle-at,scopedMs:end-middle});
    });
    t.diagnostic(JSON.stringify({retainedReceipts:2124,targetReceipts:531,rounds:samples,capacityAcceptance:false}));
  }finally{f.close();}
});

test('scoped commands allocate after foreign non-shared audit rows and after a dependent write in the same transaction',()=>{
  const f=fixture(2,true);try{
    f.db.withTransaction(tx=>{
      tx.run('INSERT INTO courses(id) VALUES(?)','foreign-course');
      const external=(id:string,seq:number)=>tx.run(`INSERT INTO audit_events(server_seq,event_id,actor_id,course_id,command_id,command,target,object_ref_json,recovery_generation,committed_at_ms)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,seq,id,'actor','foreign-course',id,'foreign.non_shared','external','{}','generation',0);
      external('before-command',1000);
      assert.equal(readRecords(tx,f.course,'own-attempt').serverSeq,1000);
      const receipt=finishRecordCommand(tx,{actorId:'actor',command:'scope.sequence',target:'own-attempt',
        scope:{courseId:f.course,studentId:'actor',attemptId:'own-attempt'},idempotencyKey:'sequence',recoveryGeneration:'generation'},
        {},'generation',Date.now(),()=>{external('dependent-write',1001);return {done:true};},value=>value);
      assert.equal(receipt.serverSeq,1002);
      const records=readRecords(tx,f.course,'own-attempt');assert.equal(records.serverSeq,1002);
      assert.equal(records.events.find(event=>event.payloadRef===receipt.receiptId)!.serverSeq,1002);
      assert(!records.events.some(event=>event.eventId==='dependent-write'));
    });
  }finally{f.close();}
});

test('persisted receipt validation preserves original JSON ACK keys and rereads committed data without a cross-request cache',()=>{
  const f=fixture(2);try{
    const first=f.read();assert.deepEqual(first.receipts[0]!.result,f.result);
    const ack=first.receipts[0]!.result as typeof f.result;assert(Object.hasOwn(ack.created,'__proto__'));assert.equal(ack.created.__proto__,'file-1');
    ack.nested[0]=null;assert.deepEqual(f.read().receipts[0]!.result,f.result);
    f.db.withTransaction(tx=>{const row=tx.get('SELECT result_json FROM command_receipts WHERE receipt_id=?','receipt-2')!;
      const receipt=JSON.parse(String(row.result_json));receipt.result={changed:'committed'};tx.run('UPDATE command_receipts SET result_json=? WHERE receipt_id=?',JSON.stringify(receipt),'receipt-2');});
    assert.deepEqual(f.read().receipts.find(row=>row.receiptId==='receipt-2')!.result,{changed:'committed'});
  }finally{f.close();}
});

test('reused JSON validator still rejects non-finite parsed JSON and receipt/event metadata tampering',()=>{
  const f=fixture(2);try{
    const corruptions=[(tx:Transaction)=>{const row=tx.get('SELECT result_json FROM command_receipts WHERE receipt_id=?','receipt-1')!;
      const receipt=JSON.parse(String(row.result_json));receipt.result='overflow-marker';
      tx.run('UPDATE command_receipts SET result_json=? WHERE receipt_id=?',JSON.stringify(receipt).replace('"overflow-marker"','1e309'),'receipt-1');},
    (tx:Transaction)=>tx.run('UPDATE command_receipts SET target=? WHERE receipt_id=?','different-target','receipt-1'),
    (tx:Transaction)=>tx.run('UPDATE audit_events SET command=? WHERE event_id=?','shared.different-command','event-1')];
    for(const corrupt of corruptions){assert.throws(()=>f.db.withTransaction(tx=>{corrupt(tx);readRecords(tx,f.course);}));assert.equal(f.read().receipts.length,2);}
  }finally{f.close();}
});

test('event object references resolve to the same validated receipt owner and reject a changed timestamp',()=>{
  const f=fixture(2);try{
    f.db.withTransaction(tx=>{const row=tx.get('SELECT object_ref_json FROM audit_events WHERE event_id=?','event-2')!;
      const event=JSON.parse(String(row.object_ref_json));event.payloadRef='teaching-object';
      tx.run('UPDATE audit_events SET object_ref_json=? WHERE event_id=?',JSON.stringify(event),'event-2');});
    assert.equal(f.read().events.find(row=>row.eventId==='event-2')!.payloadRef,'teaching-object');
    assert.throws(()=>f.db.withTransaction(tx=>{const row=tx.get('SELECT object_ref_json FROM audit_events WHERE event_id=?','event-2')!;
      const event=JSON.parse(String(row.object_ref_json));event.occurredAt='2026-10-23T00:00:01.000Z';
      tx.run('UPDATE audit_events SET object_ref_json=?,committed_at_ms=? WHERE event_id=?',JSON.stringify(event),Date.parse(event.occurredAt),'event-2');readRecords(tx,f.course);}));
  }finally{f.close();}
});

test('1103-receipt history benchmark retains every exact ACK and event association across repeated reads',t=>{
  const f=fixture(1103);try{
    const elapsed=[];for(let i=0;i<5;i++){const began=performance.now(),records=f.read();elapsed.push(performance.now()-began);
      assert.equal(records.receipts.length,1103);assert.equal(records.events.length,1103);assert.equal(records.serverSeq,1103);
      assert.deepEqual(records.receipts[0]!.result,f.result);assert.deepEqual(records.receipts.at(-1)!.result,f.result);}
    t.diagnostic(JSON.stringify({receipts:1103,repeatedReads:5,milliseconds:elapsed,medianMs:[...elapsed].sort((a,b)=>a-b)[2]}));
    // Hardware-independent semantics here; the fixed Linux copy and real 905s run gate latency separately.
  }finally{f.close();}
});
