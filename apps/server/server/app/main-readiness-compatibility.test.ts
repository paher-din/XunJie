import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../app.ts';
import {ApiError} from './errors.ts';

test('latest main void hook and PR56 boolean hook each use the same readiness route with explicit failure',async()=>{
  for(const kind of ['checkReady','checkReadiness'] as const){
    let ready=true,probes=0;
    const app=createApp(kind==='checkReady'?{checkReady:()=>{probes++;if(!ready)throw new ApiError('DEPENDENCY_UNAVAILABLE');}}:
      {checkReadiness:()=>{probes++;return ready;}});
    try{
      const healthy=await app.inject({url:'/health/ready'});assert.equal(healthy.statusCode,200);assert.equal(healthy.headers['cache-control'],'no-store');
      ready=false;assert.equal((await app.inject({url:'/health/ready'})).statusCode,503);assert.equal(probes,2);
    }finally{await app.close();}
  }
  assert.throws(()=>createApp({checkReady:()=>{},checkReadiness:()=>true}),{code:'INVALID_CONFIGURATION'});
});
