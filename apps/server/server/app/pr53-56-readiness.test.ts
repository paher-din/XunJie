import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import { fixture } from '../../tests/dl-a-support.ts';
import type {Transaction} from '../db/transaction.ts';

async function untilStatus(f:Awaited<ReturnType<typeof fixture>>,status:number) {
  for(let i=0;i<100;i++) {
    const response=await f.app.inject({url:'/health/ready'});
    if(response.statusCode===status)return response;
    await delay(10);
  }
  assert.fail(`DL-A readiness did not become ${status}`);
}

test('PR53 integration preserves DL-A HDL readiness while sharing the original health route', async () => {
  const f = await fixture();
  const counts = () => f.db.withTransaction(tx =>
    ['jobs', 'attempts', 'command_receipts'].map(table => tx.get(`SELECT COUNT(*) AS n FROM ${table}`)!.n));
  try {
    const before = counts();
    assert.equal((await f.app.inject({url:'/health/ready'})).statusCode,503);
    f.host.startConsumer(50);
    const ready = await untilStatus(f,200);
    assert.equal(ready.statusCode, 200, ready.body);
    assert.deepEqual(ready.json().data, { status: 'ready' });
    assert.equal(ready.headers['x-request-id'], ready.json().requestId);
    assert.equal(ready.headers['cache-control'], 'no-store');
    f.node.unavailable();
    const unavailable = await f.app.inject({ url: '/health/ready' });
    assert.equal(unavailable.statusCode, 503, unavailable.body);
    assert.equal(unavailable.json().error.code, 'DEPENDENCY_UNAVAILABLE');
    assert.equal(unavailable.headers['cache-control'], 'no-store');
    f.node.available();
    assert.equal((await f.app.inject({ url: '/health/ready' })).statusCode, 200);
    assert.deepEqual(counts(), before);
  } finally { await f.close(); }
});

test('DL-A rejects database and original run/teaching scan failures and recovers after a healthy scan',async()=>{
  const f=await fixture();
  const original=f.db.withTransaction;
  let failed:''|'database'|'run'|'teaching'='';
  f.db.withTransaction=<T>(work:(tx:Transaction)=>T)=>original(tx=>work({...tx,
    get(sql,...args){if(failed==='database'&&sql==='SELECT 1 AS available')throw new Error('SYNTHETIC_PRIVATE_DATABASE');return tx.get(sql,...args);},
    all(sql,...args){
      if(failed==='run'&&sql.includes('FROM jobs')||failed==='teaching'&&sql.includes("purpose='student_help'"))throw new Error('SYNTHETIC_PRIVATE_SCAN');
      return tx.all(sql,...args);
    },
  }));
  try {
    f.host.startConsumer(50);await untilStatus(f,200);
    for(const fault of ['database','run','teaching'] as const) {
      failed=fault;
      const response=await untilStatus(f,503);
      assert.equal(response.json().error.code,'DEPENDENCY_UNAVAILABLE');
      assert.doesNotMatch(response.body,/SYNTHETIC_PRIVATE/);
      failed='';await untilStatus(f,200);
    }
  } finally {failed='';f.db.withTransaction=original;await f.close();}
});

test('DL-A rechecks consumer health after a pending HDL readiness probe',async()=>{
  let hold=false,markStarted!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{markStarted=resolve;});
  const wait=new Promise<void>(resolve=>{release=resolve;});
  const f=await fixture(async command=>{if(command.op==='hdl_readiness'&&hold){markStarted();await wait;}});
  const original=f.db.withTransaction;
  let scanFailed=false,pending:Promise<{statusCode:number}>|undefined;
  f.db.withTransaction=<T>(work:(tx:Transaction)=>T)=>original(tx=>work({...tx,all(sql,...args){
    if(scanFailed&&sql.includes("purpose='student_help'"))throw new Error('Synthetic scan unavailable');
    return tx.all(sql,...args);
  }}));
  try {
    f.host.startConsumer(50);await untilStatus(f,200);
    hold=true;pending=f.app.inject({url:'/health/ready'});await started;
    scanFailed=true;await delay(120);
    release();assert.equal((await pending).statusCode,503);
    scanFailed=false;hold=false;await untilStatus(f,200);
  } finally {release();scanFailed=false;f.db.withTransaction=original;await pending;await f.close();}
});
