import {spawnSync} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {privateJson} from '../xj-dev/src/enrollment-protocol.mjs';
import {parseServerMetric,summarizeServer,quantile} from './capacity-metrics.mjs';

const parseFields=text=>Object.fromEntries(String(text??'').split('\n').filter(Boolean).map(line=>line.trim().split(/\s+/,2)));
const kib=value=>Number.parseInt(value??'0',10)*1024;
export function resources(rows){
  if(rows.length<2)throw new Error('CAPACITY_RESOURCE_WINDOW_MISSING');
  const first=rows[0],last=rows.at(-1),elapsed=last.monotonic-first.monotonic;
  if(!(elapsed>0))throw new Error('CAPACITY_RESOURCE_WINDOW_INVALID');
  const units=Object.fromEntries(Object.keys(first.units).map(name=>{
    const a=first.units[name],b=last.units[name],before=parseFields(a['memory.events']),after=parseFields(b['memory.events']);
    const peak=Math.max(...rows.map(row=>Number(row.units[name]['memory.peak']??0))),current=rows.map(row=>Number(row.units[name]['memory.current']??0));
    const cpuA=parseFields(a['cpu.stat']),cpuB=parseFields(b['cpu.stat']);
    const intervals=rows.slice(1).map((row,index)=>{const previous=rows[index],seconds=row.monotonic-previous.monotonic;
      return 100*(Number(parseFields(row.units[name]['cpu.stat']).usage_usec)-Number(parseFields(previous.units[name]['cpu.stat']).usage_usec))/1e6/seconds;});
    return [name,{startPID:Number(a.MainPID),endPID:Number(b.MainPID),uniquePIDs:[...new Set(rows.map(row=>Number(row.units[name].MainPID)))],
      startRestarts:Number(a.NRestarts),endRestarts:Number(b.NRestarts),maxMemoryCurrent:Math.max(...current),p95MemoryCurrent:quantile(current,.95),
      startLifetimeMemoryPeak:Number(a['memory.peak']),endLifetimeMemoryPeak:Number(b['memory.peak']),maximumLifetimeMemoryPeakObserved:peak,
      memoryMax:b.MemoryMax,memoryHigh:b.MemoryHigh,memoryEventDelta:Object.fromEntries(Object.keys(after).map(key=>[key,Number(after[key])-Number(before[key]??0)])),
      cpuSeconds:(Number(cpuB.usage_usec)-Number(cpuA.usage_usec))/1e6,averageCPUPercentOfOneCore:100*(Number(cpuB.usage_usec)-Number(cpuA.usage_usec))/1e6/elapsed,
      maximumIntervalCPUPercentOfOneCore:Math.max(...intervals),
      startMemoryPressure:a['memory.pressure'],endMemoryPressure:b['memory.pressure'],endCPUPressure:b['cpu.pressure'],result:b.Result}];
  }));
  return {samples:rows.length,seconds:elapsed,start:first.at,end:last.at,
    minimumMemAvailable:Math.min(...rows.map(row=>kib(row.host.memory['MemAvailable:']))),
    startCPU:first.host.cpu,endCPU:last.host.cpu,startHostCPUPressure:first.host.cpuPressure,endHostCPUPressure:last.host.cpuPressure,
    startHostMemoryPressure:first.host.memoryPressure,endHostMemoryPressure:last.host.memoryPressure,units};
}
export function collect(config){
  const root=config.evidenceDirectory,run=JSON.parse(readFileSync(join(root,'run.json'),'utf8'));
  if(run.phase!=='completed')throw new Error('CAPACITY_RUN_NOT_COMPLETED');
  const since=Math.floor(Date.parse(run.startedAt)/1000)-2,until=Math.ceil(Date.parse(run.finishedAt)/1000)+3;
  const ssh=['-F',config.sshConfig,'xunjie-cloud'];
  const journal=spawnSync('ssh',[...ssh,`sudo -n journalctl -u xunjie-candidate-128 --since @${since} --until @${until} -o json --no-pager`],{encoding:'utf8',maxBuffer:64*1024*1024,timeout:60_000});
  if(journal.status!==0)throw new Error('CAPACITY_JOURNAL_UNAVAILABLE');
  const timeline=journal.stdout.split('\n').flatMap(line=>{try{const row=JSON.parse(line),metric=typeof row.MESSAGE==='string'?parseServerMetric(row.MESSAGE):null;
    return metric&&/^\d{12,20}$/.test(String(row.__REALTIME_TIMESTAMP))?[{at:new Date(Number(row.__REALTIME_TIMESTAMP)/1000).toISOString(),metric}]:[];}catch{return [];}});
  const metrics=timeline.map(row=>row.metric);
  const requests=readFileSync(join(root,'requests.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
  writeFileSync(join(root,'server-metrics.jsonl'),metrics.map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600});
  const supplementFile=join(root,'deepseek-e2e-requests.jsonl'),supplement=existsSync(supplementFile)?readFileSync(supplementFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
  const allRequests=[...requests,...supplement],selectedIds=new Set(allRequests.map(row=>row.requestId));
  writeFileSync(join(root,'server-timeline.jsonl'),timeline.filter(row=>selectedIds.has(row.metric.requestId)).map(row=>JSON.stringify(row)).join('\n')+'\n',{mode:0o600});
  const timings={...summarizeServer(metrics,allRequests),requestSources:{primary:requests.length,supplementalProductE2E:supplement.length}};writeFileSync(join(root,'server-summary.json'),JSON.stringify(timings,null,2)+'\n',{mode:0o600});
  return timings;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{process.stdout.write(JSON.stringify(collect(privateJson(resolve(process.argv[2]))))+'\n');}
  catch{process.stderr.write('CAPACITY_COLLECT_FAILED; raw journal lines were not persisted.\n');process.exitCode=1;}
}
