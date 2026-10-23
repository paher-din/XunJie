import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {parseServerMetric,publicRequest,summarizeServer} from './capacity-metrics.mjs';
const metric=(route='/api/sessions',durationMs=250)=>({requestId:randomUUID(),method:'POST',route,status:200,durationMs});
test('collector fails closed on raw URLs, arbitrary fields, remote error text, malformed and credential-bearing records',()=>{
  const row=metric();assert.deepEqual(parseServerMetric(JSON.stringify(row)),row);
  for(const input of [{...row,route:'/api/attempts/SECRET/sync'},{...row,route:'/api/sessions?token=SECRET'},
    {...row,headers:{authorization:'SECRET'}},{...row,body:'SECRET'},{...row,message:'https://SECRET'},
    {...row,requestId:'SECRET'},{...row,durationMs:-1},{...row,status:NaN}])assert.equal(parseServerMetric(JSON.stringify(input)),null);
  for(const value of ['SECRET','null','[]','{"password":"SECRET"}'])assert.equal(parseServerMetric(value),null);
});
test('public harness records project only fixed fields and never native errors, headers, body, credentials or raw URL',()=>{
  const row=metric(),request={...row,actor:'S1',clientRttMs:900,readBytes:20,writeBytes:12,
    rawUrl:'/SECRET',headers:{cookie:'SECRET'},body:{password:'SECRET'},message:'SECRET',error:new Error('SECRET')};
  const projection=publicRequest(request);assert(!JSON.stringify(projection).includes('SECRET'));
  assert.deepEqual(Object.keys(projection),['actor','requestId','method','route','status','clientRttMs','readBytes','writeBytes']);
  assert.throws(()=>publicRequest({...request,route:'/SECRET'}));assert.throws(()=>publicRequest({...request,actor:'SECRET'}));
});
test('ordinary p95 includes normal login, uses server duration and refuses to substitute client RTT for missing measurements',()=>{
  const login=metric('/api/sessions',470),read={...metric('/api/attempts/:id',20),method:'GET'},model=metric('/api/agent/turns',9000);
  const requests=[login,read,model].map(row=>publicRequest({...row,actor:'T',clientRttMs:10000,readBytes:20,writeBytes:0}));
  const result=summarizeServer([login,read,model],requests);assert.equal(result.ordinary.count,2);assert.equal(result.ordinary.p95Ms,470);
  assert.equal(result.byRoute['POST /api/sessions'].p95Ms,470);assert.equal(result.missing,0);
  assert.equal(summarizeServer([read,model],requests).missing,1);
});
