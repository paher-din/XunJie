import test from 'node:test';import assert from 'node:assert/strict';import {analyze,correlation} from './capacity-analysis.mjs';
test('latency/response size and CPU/IO attribution use journal time and server duration, not RTT',()=>{
  const timeline=[{at:'2026-10-23T00:00:01Z',metric:{requestId:'a',method:'POST',route:'/api/sessions',durationMs:400}},
    {at:'2026-10-23T00:00:10Z',metric:{requestId:'b',method:'GET',route:'/api/session',durationMs:20}}];
  const requests=[{requestId:'a',readBytes:100,clientRttMs:9000},{requestId:'b',readBytes:300,clientRttMs:9000}];
  const samples=[2,12].map((seconds,index)=>({at:`2026-10-23T00:00:${String(seconds).padStart(2,'0')}Z`,monotonic:seconds,
    host:{cpu:index?'cpu 200 0 0 800 0 0 0 0':'cpu 100 0 0 700 0 0 0 0',memory:{'MemAvailable:':'800000 kB'}},
    units:{'xunjie-candidate-128.service':{'cpu.stat':`usage_usec ${index?8000000:0}`,'cpu.pressure':`some avg10=0 total=${index?1000000:0}`,
      'io.pressure':'some avg10=0 total=0','memory.pressure':'some avg10=0 total=0','memory.current':'100000000'}}}));
  const result=analyze(timeline,requests,samples),bucket=result.buckets[0];assert.equal(bucket.p95Ms,400);assert.equal(bucket.responseBytes,400);
  assert.equal(bucket.businessCPUPercentOfOneCore,80);assert.equal(bucket.hostBusyPercent,50);assert.equal(bucket.hostIOWaitPercent,0);assert.equal(bucket.businessCPUStallPercent,10);
  assert.equal(result.byRoute['GET /api/session'].p95ResponseBytes,300);assert.equal(correlation([1,2,3],[10,20,30]),1);
});
