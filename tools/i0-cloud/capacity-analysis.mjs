import {quantile} from './capacity-metrics.mjs';
const cpuField=(row,key)=>Number(String(row??'').match(new RegExp('(?:^|\\n)'+key+' (\\d+)'))?.[1]??0);
const totalPressure=(text,kind='some')=>Number(String(text??'').match(new RegExp('(?:^|\\n)'+kind+' [^\\n]*total=(\\d+)'))?.[1]??0);
const hostCPU=text=>String(text).trim().split(/\s+/).slice(1,9).map(Number);
const ordinary=row=>row.route.startsWith('/api/')&&!row.route.startsWith('/api/agent/')&&!row.route.startsWith('/api/model-settings');
export function correlation(xs,ys){
  if(xs.length<3)return null;const mx=xs.reduce((a,b)=>a+b,0)/xs.length,my=ys.reduce((a,b)=>a+b,0)/ys.length;
  const xx=xs.reduce((n,x)=>n+(x-mx)**2,0),yy=ys.reduce((n,y)=>n+(y-my)**2,0);
  return xx&&yy?xs.reduce((n,x,i)=>n+(x-mx)*(ys[i]-my),0)/Math.sqrt(xx*yy):null;
}
export function analyze(timeline,requests,samples){
  const index=new Map(requests.map(row=>[row.requestId,row])),selected=timeline.filter(row=>index.has(row.metric.requestId));
  const start=Date.parse(selected[0].at),end=Date.parse(selected.at(-1).at),buckets=[];
  for(let offset=0;start+offset<end;offset+=30_000){
    const at=start+offset,until=at+30_000,events=selected.filter(row=>Date.parse(row.at)>=at&&Date.parse(row.at)<until&&ordinary(row.metric));
    const period=samples.filter(row=>Date.parse(row.at)>=at&&Date.parse(row.at)<until);if(!events.length||period.length<2)continue;
    const a=period[0],b=period.at(-1),seconds=b.monotonic-a.monotonic,unit='xunjie-candidate-128.service',u=a.units[unit],v=b.units[unit],c0=hostCPU(a.host.cpu),c1=hostCPU(b.host.cpu),ticks=c1.reduce((n,value,i)=>n+value-c0[i],0);
    buckets.push({TPlusSeconds:offset/1000,requests:events.length,p95Ms:quantile(events.map(row=>row.metric.durationMs),.95),responseBytes:events.reduce((n,row)=>n+index.get(row.metric.requestId).readBytes,0),
      businessCPUPercentOfOneCore:100*(cpuField(v['cpu.stat'],'usage_usec')-cpuField(u['cpu.stat'],'usage_usec'))/1e6/seconds,
      hostBusyPercent:100*(1-((c1[3]-c0[3])+(c1[4]-c0[4]))/ticks),hostIOWaitPercent:100*(c1[4]-c0[4])/ticks,
      businessCPUStallPercent:100*(totalPressure(v['cpu.pressure'])-totalPressure(u['cpu.pressure']))/1e6/seconds,
      businessIOStallPercent:100*(totalPressure(v['io.pressure'])-totalPressure(u['io.pressure']))/1e6/seconds,
      businessMemoryStallPercent:100*(totalPressure(v['memory.pressure'])-totalPressure(u['memory.pressure']))/1e6/seconds,
      maxBusinessMemory:Math.max(...period.map(row=>Number(row.units[unit]['memory.current']))),minimumMemAvailable:Math.min(...period.map(row=>parseInt(row.host.memory['MemAvailable:'])*1024))});
  }
  const routes=[...new Set(selected.filter(row=>ordinary(row.metric)).map(row=>row.metric.method+' '+row.metric.route))].sort();
  const byRoute=Object.fromEntries(routes.map(route=>{const rows=selected.filter(row=>row.metric.method+' '+row.metric.route===route),bytes=rows.map(row=>index.get(row.metric.requestId).readBytes),durations=rows.map(row=>row.metric.durationMs);
    return [route,{count:rows.length,p50Ms:quantile(durations,.5),p95Ms:quantile(durations,.95),p99Ms:quantile(durations,.99),maxMs:Math.max(...durations),responseBytes:bytes.reduce((a,b)=>a+b,0),p95ResponseBytes:quantile(bytes,.95),maxResponseBytes:Math.max(...bytes)}];}));
  return {source:'journal timestamp of strict five-field server onResponse metrics, matched requestId; 30-second buckets with 5-second cgroup sampling',byRoute,buckets,
    correlation:{p95ToBusinessCPU:correlation(buckets.map(row=>row.p95Ms),buckets.map(row=>row.businessCPUPercentOfOneCore)),p95ToElapsed:correlation(buckets.map(row=>row.p95Ms),buckets.map(row=>row.TPlusSeconds))}};
}
