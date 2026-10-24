import assert from 'node:assert/strict';
import test from 'node:test';
import {resources} from './capacity-collect.mjs';
const unit=(cpu,memory,peak,events='0',pid='101')=>({MainPID:pid,NRestarts:pid==='101'?'0':'1',MemoryMax:'536870912',MemoryHigh:'infinity',
  'memory.current':String(memory),'memory.peak':String(peak),'memory.events':`high 0\nmax 0\noom ${events}\noom_kill ${events}`,
  'cpu.stat':`usage_usec ${cpu}`,'memory.pressure':'some avg10=0.00 total=0','cpu.pressure':'some avg10=0.00 total=0',Result:'success'});
const row=(time,state)=>({at:new Date(time*1000).toISOString(),monotonic:time,units:{business:state},
  host:{memory:{'MemAvailable:':`${time===0?900000:600000} kB`},cpu:`cpu ${time*100} 0 0 ${time*100}`,cpuPressure:'some avg10=0.00 total=0',memoryPressure:'some avg10=0.00 total=0'}});
test('capacity resources distinguish sampled memory from lifetime peak and detect restarts/OOM during the window',()=>{
  const result=resources([row(0,unit(1e6,100,900)),row(5,unit(6e6,200,900,'1','102')),row(10,unit(7e6,150,900,'1','102'))]);
  assert.equal(result.units.business.maxMemoryCurrent,200);assert.equal(result.units.business.startLifetimeMemoryPeak,900);
  assert.deepEqual(result.units.business.uniquePIDs,[101,102]);assert.equal(result.units.business.memoryEventDelta.oom_kill,1);
  assert.equal(result.minimumMemAvailable,614400000);assert.equal(result.units.business.averageCPUPercentOfOneCore,60);
  assert.equal(result.units.business.maximumIntervalCPUPercentOfOneCore,100);
});
