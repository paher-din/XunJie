export const routes=new Set(['/api/sessions','/api/logout','/api/session','/api/courses',
  '/api/courses/:id/assignments','/api/courses/:id/teacher-workbench','/api/activities/:id/assignments',
  '/api/courses/:id/blueprints','/api/blueprints/:id/checks','/api/blueprints/:id/releases',
  '/api/assignments/:id','/api/assignments/:id/bootstrap','/api/assignments/:id/attempts','/api/attempts/:id',
  ...['sync','snapshots','submissions','feedback','reopen','controls','recovery','review-context','events'].map(s=>`/api/attempts/:id/${s}`),
  '/api/execution-nodes','/api/model-settings','/api/agent/turns','/api/agent/turns/:id','/api/agent/turns/:id/stop',
  '/health/live','/health/ready','<other>']);
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const methods=new Set(['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS','OTHER']);
export function parseServerMetric(line){
  try{
    const row=JSON.parse(line);
    if(!row||Array.isArray(row)||Object.keys(row).sort().join(',')!=='durationMs,method,requestId,route,status')return null;
    if(!uuid(row.requestId)||!methods.has(row.method)||!routes.has(row.route)||!Number.isInteger(row.status)||row.status<100||row.status>599
      ||!Number.isFinite(row.durationMs)||row.durationMs<0)return null;
    return {requestId:row.requestId,method:row.method,route:row.route,status:row.status,durationMs:row.durationMs};
  }catch{return null;}
}
export function publicRequest(value){
  if(!['T','S1','S2','S3','S4'].includes(value.actor)||!routes.has(value.route)||!methods.has(value.method)||!uuid(value.requestId)
    ||!Number.isInteger(value.status)||value.status<100||value.status>599)throw new Error('CAPACITY_UNSAFE_REQUEST_RECORD');
  for(const name of ['clientRttMs','readBytes','writeBytes'])if(!Number.isFinite(value[name])||value[name]<0)throw new Error('CAPACITY_UNSAFE_REQUEST_RECORD');
  return Object.fromEntries(['actor','requestId','method','route','status','clientRttMs','readBytes','writeBytes'].map(key=>[key,value[key]]));
}
export const quantile=(values,fraction)=>values.length?[...values].sort((a,b)=>a-b)[Math.max(0,Math.ceil(values.length*fraction)-1)]:null;
export function summarizeServer(metrics,requests){
  const index=new Map(metrics.map(row=>[row.requestId,row])),selected=requests.map(row=>index.get(row.requestId)).filter(Boolean);
  const ordinary=selected.filter(row=>row.route.startsWith('/api/')&&!row.route.startsWith('/api/agent/')&&!row.route.startsWith('/api/model-settings'));
  const summary=rows=>({count:rows.length,p50Ms:quantile(rows.map(row=>row.durationMs),.5),p95Ms:quantile(rows.map(row=>row.durationMs),.95),
    maxMs:rows.length?Math.max(...rows.map(row=>row.durationMs)):null,non2xx:rows.filter(row=>row.status>=400).length,unexpected5xx:rows.filter(row=>row.status>=500).length,errorRate:rows.length?rows.filter(row=>row.status>=400).length/rows.length:0});
  return {source:'server Fastify onResponse elapsedTime, joined by requestId',matched:selected.length,expected:requests.length,
    missing:requests.length-selected.length,all:summary(selected),model:summary(selected.filter(row=>row.route.startsWith('/api/agent/'))),ordinary:summary(ordinary),byRoute:Object.fromEntries([...new Set(ordinary.map(row=>`${row.method} ${row.route}`))].sort()
      .map(route=>[route,summary(ordinary.filter(row=>`${row.method} ${row.route}`===route))]))};
}
