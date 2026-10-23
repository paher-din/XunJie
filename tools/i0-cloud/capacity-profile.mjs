// CPU/SQL attribution on the immutable-artifact reader and a consistent, isolated SQLite copy.
import {createRequire} from 'node:module';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {Session} from 'node:inspector/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
export async function profileReads(input){
  if(input.root!=='/var/lib/xunjie/capacity-133/perf-0f7e1a3b'||input.teachingRoot!=='/opt/xunjie/candidates/133-c896c52/apps/teaching'
    ||input.attemptIds.length!==4)throw new Error('CAPACITY_PROFILE_SCOPE');
  const variant=input.variant??'baseline';if(!['baseline','json-reuse','indexed'].includes(variant))throw new Error('CAPACITY_PROFILE_VARIANT');
  const Driver=createRequire(join(input.teachingRoot,'package.json'))('better-sqlite3'),db=new Driver(join(input.root,'synthetic.sqlite'),{readonly:true,fileMustExist:true});db.pragma('query_only=ON');
  const {loadWorkspace}=await import(pathToFileURL(join(input.teachingRoot,'server/workspace/storage.ts')).href),sql=new Map();
  const query=(kind,statement,parameters)=>{const started=performance.now(),result=db.prepare(statement)[kind](...parameters),elapsed=performance.now()-started;
    const key=statement.replace(/\s+/g,' ').trim(),before=sql.get(key)??{calls:0,milliseconds:0,rows:0};before.calls++;before.milliseconds+=elapsed;before.rows+=Array.isArray(result)?result.length:result?1:0;sql.set(key,before);return result;};
  const tx={get:(statement,...parameters)=>query('get',statement,parameters),all:(statement,...parameters)=>query('all',statement,parameters),run:()=>{throw new Error('READ_ONLY_PROFILE');}};
  const session=new Session();session.connect();
  try{
    const records=db.prepare("SELECT count(*) AS n FROM command_receipts WHERE course_id=? AND command LIKE 'shared.%'").get('synthetic-textscope-c').n;
    const oldAttempts=db.prepare('SELECT attempt_id FROM attempts WHERE course_id=?').all('synthetic-textscope-c').map(row=>row.attempt_id);
    const counts={courseReceipts:records,courseAttempts:oldAttempts.length,allPublicBindings:db.prepare("SELECT count(*) AS n FROM workspace_command_bindings WHERE kind='public'").get().n};
    await session.post('Profiler.enable');await session.post('Profiler.setSamplingInterval',{interval:500});await session.post('Profiler.start');
    const cpuBefore=process.cpuUsage(),start=performance.now(),operations=[];
    for(let round=0;round<3;round++)for(const id of input.attemptIds){const at=performance.now();loadWorkspace(tx,id);operations.push({kind:'full workspace read',round,wallMs:performance.now()-at});}
    for(let round=0;round<2;round++){const at=performance.now();for(const id of oldAttempts)loadWorkspace(tx,id);operations.push({kind:'teacher workbench all-workspace hydration subtree',round,wallMs:performance.now()-at});}
    const cpu=process.cpuUsage(cpuBefore),wallMs=performance.now()-start,{profile}=await session.post('Profiler.stop');
    writeFileSync(join(input.root,'reader-'+variant+'.cpuprofile'),JSON.stringify(profile),{mode:0o600});
    const nodes=new Map(profile.nodes.map(node=>[node.id,node])),time=new Map();
    for(let i=0;i<(profile.samples??[]).length;i++){const node=nodes.get(profile.samples[i]),frame=node.callFrame;
      const key=JSON.stringify({function:frame.functionName||'<anonymous>',file:frame.url.replace(/^file:\/\//,'').replace(input.teachingRoot+'/',''),line:frame.lineNumber+1});
      time.set(key,(time.get(key)??0)+(profile.timeDeltas[i]??0));}
    const sqlTotals=[...sql].map(([statement,value])=>({statement,...value})).sort((a,b)=>b.milliseconds-a.milliseconds);
    const result={at:new Date().toISOString(),variant,diagnosticOverride:variant!=='baseline',...(variant!=='baseline'?{patchSha256:createHash('sha256').update(readFileSync(join(input.root,'patched-records-adapter.ts'))).digest('hex')}:{}),source:'c896c520a64a40b6860dce279692be5f0481115c',scope:'isolated consistent DB copy, raw driver query_only, original artifact reader; no product request or consumer change',counts,
      wallMs,processCPUUserMs:cpu.user/1000,processCPUSystemMs:cpu.system/1000,sqlTotalMs:sqlTotals.reduce((sum,row)=>sum+row.milliseconds,0),operations,
      topSQL:sqlTotals.slice(0,12),topSelfFunctions:[...time].sort((a,b)=>b[1]-a[1]).slice(0,20).map(([key,us])=>({...JSON.parse(key),sampleSelfMs:us/1000}))};
    writeFileSync(join(input.root,'reader-'+variant+'-profile.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});return result;
  }finally{session.disconnect();db.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>16384)throw new Error('CAPACITY_INPUT_LIMIT');}
    process.stdout.write(JSON.stringify(await profileReads(JSON.parse(text)))+'\n');}
  catch{process.stderr.write('CAPACITY_READ_PROFILE_FAILED; no data/credentials/native error output.\n');process.exitCode=1;}
}
