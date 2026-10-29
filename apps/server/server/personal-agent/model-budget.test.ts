import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelBudget } from './model-budget.ts';

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function deferred<T=void>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}

test('two members run while the oldest eligible waiter bypasses a busy member without losing its FIFO place',async()=>{
  const budget=createModelBudget(),a=deferred(),b=deferred(),next=deferred(),order:string[]=[];
  const run=(memberId:string,label:string,gate:Promise<void>)=>budget.run({memberId,payloadBytes:10},async()=>{order.push(label);await gate;});
  const first=run('a','a1',a.promise),second=run('b','b1',b.promise);
  const same=run('a','a2',next.promise),third=run('c','c1',next.promise);
  await tick();assert.deepEqual(order,['a1','b1']);
  b.resolve();await second;await tick();assert.deepEqual(order,['a1','b1','c1']);
  assert.equal(budget.status().waiting,1);
  a.resolve();await first;await tick();assert.deepEqual(order,['a1','b1','c1','a2']);
  next.resolve();await Promise.all([same,third]);await budget.close();
  assert.deepEqual(budget.status(),{active:0,waiting:0,waitingBytes:0,closed:true});
});

test('cancelling a logical operation keeps its physical upstream and member slot occupied until settlement',async()=>{
  const budget=createModelBudget(),upstream=deferred(),other=deferred(),cancel=new AbortController(),order:string[]=[];
  const first=budget.run({memberId:'a',payloadBytes:1,signal:cancel.signal},async signal=>{
    order.push('a1');
    const aborted=new Promise<never>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('stopped')),{once:true}));
    await Promise.race([budget.track(()=>upstream.promise),aborted]);
  });
  const stopped=assert.rejects(first,/stopped/);
  const second=budget.run({memberId:'b',payloadBytes:1},async()=>{await other.promise;});
  const third=budget.run({memberId:'c',payloadBytes:1},async()=>{order.push('c');});
  const same=budget.run({memberId:'a',payloadBytes:1},async()=>{order.push('a2');});
  await tick();cancel.abort();await stopped;await tick();
  assert.deepEqual(order,['a1']);assert.equal(budget.status().active,2);
  other.resolve();await second;await third;assert.deepEqual(order,['a1','c']);
  upstream.resolve();await same;assert.deepEqual(order,['a1','c','a2']);await budget.close();
});

test('waiting count and bytes are bounded; cancelled waiters return their byte allowance',async()=>{
  const budget=createModelBudget({waiting:1,waitingBytes:10}),gate=deferred(),cancel=new AbortController();
  const a=budget.run({memberId:'a',payloadBytes:1},async()=>gate.promise);
  const b=budget.run({memberId:'b',payloadBytes:1},async()=>gate.promise);
  const c=budget.run({memberId:'c',payloadBytes:8,signal:cancel.signal},async()=>{});
  await assert.rejects(budget.run({memberId:'d',payloadBytes:1},async()=>{}),{code:'MODEL_QUEUE_FULL'});
  const cancelled=assert.rejects(c,{code:'MODEL_QUEUE_CANCELLED'});cancel.abort();await cancelled;
  assert.equal(budget.status().waitingBytes,0);
  await assert.rejects(budget.run({memberId:'d',payloadBytes:11},async()=>{}),{code:'MODEL_QUEUE_FULL'});
  const d=budget.run({memberId:'d',payloadBytes:10},async()=>{});
  gate.resolve();await Promise.all([a,b,d]);await budget.close();
});

test('queue expiry never dispatches and closing waits for upstream that ignores abort',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const budget=createModelBudget(),gate=deferred();let dispatched=false,closed=false;
  const a=budget.run({memberId:'a',payloadBytes:1},async()=>budget.track(()=>gate.promise));
  const b=budget.run({memberId:'b',payloadBytes:1},async()=>budget.track(()=>gate.promise));
  const c=budget.run({memberId:'c',payloadBytes:1},async()=>{dispatched=true;});
  const expired=assert.rejects(c,{code:'MODEL_QUEUE_TIMEOUT'});
  await tick();t.mock.timers.tick(120_001);await expired;assert.equal(dispatched,false);
  const d=budget.run({memberId:'d',payloadBytes:1},async()=>{dispatched=true;});
  const rejected=assert.rejects(d,{code:'MODEL_QUEUE_CLOSED'});
  const closing=budget.close().then(()=>{closed=true;});await rejected;await tick();
  assert.equal(closed,false);assert.equal(dispatched,false);
  gate.resolve();await Promise.all([a,b,closing]);assert.equal(closed,true);
  await assert.rejects(budget.run({memberId:'e',payloadBytes:1},async()=>{}),{code:'MODEL_QUEUE_CLOSED'});
});

test('production defaults bound twenty waiting payloads and their combined 32 MiB independently',async()=>{
  const budget=createModelBudget(),gate=deferred(),cancel=new AbortController();
  const a=budget.run({memberId:'a',payloadBytes:1},async()=>gate.promise);
  const b=budget.run({memberId:'b',payloadBytes:1},async()=>gate.promise);
  const largest=budget.run({memberId:'large',payloadBytes:32*1024*1024,signal:cancel.signal},async()=>{});
  await assert.rejects(budget.run({memberId:'extra-byte',payloadBytes:1},async()=>{}),{code:'MODEL_QUEUE_FULL'});
  const cancelled=assert.rejects(largest,{code:'MODEL_QUEUE_CANCELLED'});cancel.abort();await cancelled;
  const waiters=Array.from({length:20},(_,index)=>budget.run({memberId:`member-${index}`,payloadBytes:1},async()=>{}));
  await assert.rejects(budget.run({memberId:'twenty-first',payloadBytes:0},async()=>{}),{code:'MODEL_QUEUE_FULL'});
  assert.equal(budget.status().waiting,20);assert.equal(budget.status().waitingBytes,20);
  gate.resolve();await Promise.all([a,b,...waiters]);await budget.close();
});
