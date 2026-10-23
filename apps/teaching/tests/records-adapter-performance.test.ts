import assert from 'node:assert/strict';
import test from 'node:test';
import {randomBytes} from 'node:crypto';
import {dirname} from 'node:path';
import {rmSync} from 'node:fs';
import {createWorkspaceDatabase,type Transaction} from '../server/db/transaction.ts';
import {readRecords,saveRecordPlan} from '../server/db/records-adapter.ts';
import type {CommandReceipt,AuditEvent} from '../contracts/records/index.ts';

function fixture(count:number){
  const db=createWorkspaceDatabase(),at='2026-10-23T00:00:00.000Z',course='capacity-regression';
  const created=JSON.parse('{"__proto__":"file-1","constructor":"file-2"}') as Record<string,string>;
  const result={created,nested:[true,false,null,17,{text:'Fixture ACK'}]};
  db.withTransaction(tx=>{
    tx.run('INSERT INTO users(id,login_name,password_hash,salt,algorithm,n,r,p,key_length) VALUES(?,?,?,?,?,?,?,?,?)',
      'actor','actor',randomBytes(64),randomBytes(16),'scrypt',131072,8,1,64);
    tx.run('INSERT INTO courses(id) VALUES(?)',course);
    for(let i=1;i<=count;i++){
      const receipt:CommandReceipt={receiptId:'receipt-'+i,commandId:'command-'+i,identity:{actorId:'actor',command:'workspace.sync',target:'/api/attempts/fixture/sync',scope:{courseId:course},idempotencyKey:'request-'+i,recoveryGeneration:'generation'},
        requestHash:'a'.repeat(64),result,serverSeq:i,committedAt:at};
      const event:AuditEvent={eventId:'event-'+i,serverSeq:i,scope:{courseId:course},type:'workspace.sync',occurredAt:at,source:'student_command',payloadRef:receipt.receiptId};
      saveRecordPlan(tx,receipt,event);
    }
  });
  return {db,course,result,read:()=>db.withTransaction(tx=>readRecords(tx,course)),close(){db.close();rmSync(dirname(db.file),{recursive:true,force:true});}};
}

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
