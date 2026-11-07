import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, utimes, stat, readdir } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { contentManifest, digest, lockTiming, runBuildGraph } from './build-cache.mjs';
import { ensureBuild, expandTargets, normalizePassthroughArgs, parseBuildArgs, resolveTool } from './build.mjs';
import { scanServerOutput } from './build-server.mjs';

const paths = { contracts: 'packages/contracts', storage: 'packages/storage', 'learning-space': 'packages/learning-space',
  server: 'apps/server', 'product-runtime': 'packages/product-runtime', web: 'apps/web', 'local-runtime': 'apps/local-runtime' };
const compiler = `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, resolve, join } from 'node:path';
const args=process.argv.slice(2), cwd=process.cwd();
appendFileSync(resolve(cwd,'../../calls.log'),JSON.stringify({tool:'tsc',workspace:basename(cwd),args})+'\\n');
if(args.includes('--bad')) process.exit(2);
if(!args.includes('--noEmit')) {
 const out=args.includes('--outDir')?args[args.indexOf('--outDir')+1]:'dist';
 const path=resolve(cwd,out,args.includes('tsconfig.build.json')?'server':'');
 mkdirSync(path,{recursive:true}); writeFileSync(join(path,basename(cwd)==='server'?'main.js':basename(cwd)==='local-runtime'?'cli.js':'index.js'),'export const value=1;');
}`;
const bundler = `import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const args=process.argv.slice(2),cwd=process.cwd();
appendFileSync(resolve(cwd,'../../calls.log'),JSON.stringify({tool:'vite',workspace:'web',args})+'\\n');
if(args.includes('--bad'))process.exit(2);
const out=args.includes('--outDir')?args[args.indexOf('--outDir')+1]:args.includes('vite.runtime.config.ts')?'dist-runtime':'dist';
mkdirSync(resolve(cwd,out),{recursive:true});writeFileSync(join(resolve(cwd,out),'index.html'),'<html>built</html>');`;
async function put(root, path, value) { await mkdir(dirname(join(root,path)),{recursive:true}); await writeFile(join(root,path),value); }
async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'xunjie-build-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
  await put(root,'package.json',JSON.stringify({type:'module'}));
  await put(root,'package-lock.json','{}');
  for(const [name,path] of Object.entries(paths)) {
    await put(root,`${path}/package.json`,JSON.stringify({type:'module',name:`@xunjie/${name}`}));
    await put(root,`${path}/src/index.ts`,'export const value = 1;');
    await put(root,`${path}/tsconfig.json`,'{}');
    await put(root,`${path}/node_modules/typescript/package.json`,JSON.stringify({name:'typescript',version:name==='server'?'7.0.2':'5.9.3',type:'module',bin:{tsc:'tsc.mjs'}}));
    await put(root,`${path}/node_modules/typescript/tsc.mjs`,compiler);
  }
  await put(root,'apps/server/tsconfig.build.json','{}');
  await put(root,'apps/server/tools/check-runtime.mjs','');
  await put(root,'apps/web/tsconfig.node.json','{}');
  for(const name of ['vite','esbuild','rollup']) {
    await put(root,`apps/web/node_modules/${name}/package.json`,JSON.stringify({name,version:'1.0.0',type:'module',bin:{[name]:'cli.mjs'}}));
    await put(root,`apps/web/node_modules/${name}/cli.mjs`,bundler);
  }
  return root;
}
async function calls(root) { return (await readFile(join(root,'calls.log'),'utf8')).trim().split('\n').map(line=>JSON.parse(line)); }
const quiet = {log:()=>{}};

const contractsCompiler = `import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
const args=process.argv.slice(2),cwd=process.cwd();
appendFileSync(resolve(cwd,'../../calls.log'),JSON.stringify({tool:'tsc',workspace:'contracts',args,nodeOptions:process.env.NODE_OPTIONS})+'\\n');
await new Promise(resolve=>setTimeout(resolve,75));
const out=resolve(cwd,args.includes('--outDir')?args[args.indexOf('--outDir')+1]:'dist');
for(const name of readdirSync(join(cwd,'src'),{recursive:true})) {
 if(!name.endsWith('.ts'))continue;
 const output=join(out,name.slice(0,-3));mkdirSync(dirname(output),{recursive:true});
 writeFileSync(output+'.js',readFileSync(join(cwd,'src',name)));
 writeFileSync(output+'.d.ts','export declare const value: number;');
}`;

test('contracts recompiles on loader env changes while identical dist stays continuously readable and untouched',async t=>{
  const root=await fixture(t);
  await put(root,'packages/contracts/node_modules/typescript/tsc.mjs',contractsCompiler);
  await ensureBuild('contracts',{root,...quiet});
  const dist=join(root,'packages/contracts/dist'),output=join(dist,'index.js');
  await utimes(output,new Date(0),new Date(0));
  const before=await Promise.all([stat(dist),stat(output),stat(join(dist,'index.d.ts'))]);
  // The real Node loader reads the live output before the compiler starts. The
  // former rm-before-compile implementation fails here deterministically.
  await put(root,'reader-loader.mjs',`import {readFileSync} from 'node:fs';
if(readFileSync(new URL('./packages/contracts/dist/index.js',import.meta.url),'utf8')!=='export const value = 1;')throw new Error('Live contracts output changed');`);
  const options=[process.env.NODE_OPTIONS,`--import=${pathToFileURL(join(root,'reader-loader.mjs')).href}`].filter(Boolean).join(' ');
  let reading=true,reads=0,readerError;
  const reader=(async()=>{
    try {while(reading){assert.equal(await readFile(output,'utf8'),'export const value = 1;');reads++;await delay(1);}}
    catch(error){readerError=error;}
  })();
  try {await ensureBuild('contracts',{root,env:{...process.env,NODE_OPTIONS:options},...quiet});}
  finally {reading=false;await reader;}
  assert.ifError(readerError);assert.ok(reads>1);
  assert.equal((await calls(root)).length,2);
  assert.equal((await calls(root))[1].nodeOptions,options);
  const after=await Promise.all([stat(dist),stat(output),stat(join(dist,'index.d.ts'))]);
  assert.deepEqual(after.map(s=>[s.ino,s.mtimeMs,s.ctimeMs]),before.map(s=>[s.ino,s.mtimeMs,s.ctimeMs]));
  assert.equal((await readdir(join(root,'.cache/xunjie-build'))).some(name=>name.startsWith('contracts-')),false);
});

test('contracts publishes changed and deleted source emissions without stale files and keeps custom outDir working',async t=>{
  const root=await fixture(t);
  await put(root,'packages/contracts/node_modules/typescript/tsc.mjs',contractsCompiler);
  await put(root,'packages/contracts/src/nested/extra.ts','export const value = 2;');
  await ensureBuild('contracts',{root,...quiet});
  await readFile(join(root,'packages/contracts/dist/nested/extra.js'));
  await put(root,'packages/contracts/src/index.ts','export const value = 3;');
  await rm(join(root,'packages/contracts/src/nested'),{recursive:true});
  await put(root,'packages/contracts/dist/stale.js','stale');
  await ensureBuild('contracts',{root,...quiet});
  assert.equal(await readFile(join(root,'packages/contracts/dist/index.js'),'utf8'),'export const value = 3;');
  assert.deepEqual((await readdir(join(root,'packages/contracts/dist'))).sort(),['index.d.ts','index.js']);
  await ensureBuild('contracts',{root,args:['--outDir',join(root,'custom-contracts')],...quiet});
  assert.equal(await readFile(join(root,'custom-contracts/index.js'),'utf8'),'export const value = 3;');
  assert.equal((await readdir(join(root,'.cache/xunjie-build'))).some(name=>name.startsWith('contracts-')),false);
});

test('contracts failed and cancelled compiles clean staging, preserve live output and publish no success',async t=>{
  const root=await fixture(t);
  await ensureBuild('contracts',{root,...quiet});
  const output=join(root,'packages/contracts/dist/index.js');
  const original=await readFile(output,'utf8');
  const before=await stat(output);
  await put(root,'packages/contracts/node_modules/typescript/tsc.mjs',"process.exit(2);");
  await assert.rejects(ensureBuild('contracts',{root,...quiet}),/Build command failed/);
  await put(root,'packages/contracts/node_modules/typescript/tsc.mjs',contractsCompiler.replace('setTimeout(resolve,75)','setTimeout(resolve,10000)'));
  const controller=new AbortController(),count=(await calls(root)).length;
  const running=ensureBuild('contracts',{root,signal:controller.signal,...quiet});
  const rejected=assert.rejects(running);
  const timeout=setTimeout(()=>controller.abort(),2000);
  try {
    while((await calls(root)).length===count&&!controller.signal.aborted)await delay(5);
    controller.abort();await rejected;
  } finally {clearTimeout(timeout);controller.abort();}
  assert.equal(await readFile(output,'utf8'),original);
  const after=await stat(output);assert.deepEqual([after.ino,after.mtimeMs,after.ctimeMs],[before.ino,before.mtimeMs,before.ctimeMs]);
  await assert.rejects(readFile(join(root,'.cache/xunjie-build/contracts.json')),{code:'ENOENT'});
  assert.equal((await readdir(join(root,'.cache/xunjie-build'))).some(name=>name.startsWith('contracts-')),false);
});

test('content fingerprints ignore mtimes and checkout paths but detect names and bytes',async t=>{
  const a=await fixture(t),b=await fixture(t);
  const paths=['packages/contracts/src'];
  assert.deepEqual(await contentManifest(a,paths),await contentManifest(b,paths));
  await utimes(join(a,paths[0],'index.ts'),new Date(0),new Date(0));
  assert.deepEqual(await contentManifest(a,paths),await contentManifest(b,paths));
  await put(a,`${paths[0]}/new.ts`,'new');
  assert.notDeepEqual(await contentManifest(a,paths),await contentManifest(b,paths));
  await rm(join(a,paths[0],'new.ts'));
  await put(a,`${paths[0]}/index.ts`,'changed');
  assert.notDeepEqual(await contentManifest(a,paths),await contentManifest(b,paths));
});

test('DAG prepares both web outputs; src check is shared and correct compiler versions resolve',async t=>{
  const root=await fixture(t);
  await ensureBuild('typecheck',{root,...quiet});
  await ensureBuild('test',{root,...quiet});
  const first=await calls(root);
  assert.equal(first.filter(c=>c.tool==='tsc'&&c.workspace==='web'&&c.args.includes('tsconfig.json')).length,1);
  assert.equal(first.filter(c=>c.workspace==='server'&&c.args.includes('--noEmit')).length,1);
  assert.equal(first.filter(c=>c.tool==='tsc'&&c.workspace==='web'&&c.args.includes('tsconfig.node.json')).length,1);
  assert.equal(first.filter(c=>c.tool==='vite').length,2);
  assert.equal((await resolveTool(root,'server','typescript','tsc')).metadata.version,'7.0.2');
  assert.equal((await resolveTool(root,'storage','typescript','tsc')).metadata.version,'5.9.3');
  await ensureBuild(['typecheck','all'],{root,...quiet});
  assert.deepEqual(await calls(root),first);
  assert.ok((await readFile(join(root,'apps/web/dist/index.html'),'utf8')).includes('built'));
  assert.ok((await readFile(join(root,'apps/web/dist-runtime/index.html'),'utf8')).includes('built'));
});

test('exact outputs: missing, changed and added files invalidate; deleted sources remove old emissions',async t=>{
  const root=await fixture(t);
  await ensureBuild('storage',{root,...quiet});
  let count=(await calls(root)).length;
  for(const change of [
    ()=>rm(join(root,'packages/contracts/dist/index.js')),
    ()=>put(root,'packages/contracts/dist/index.js','tampered'),
    ()=>put(root,'packages/contracts/dist/stale.js','stale'),
    ()=>put(root,'packages/contracts/src/extra.ts','extra'),
    ()=>rm(join(root,'packages/contracts/src/extra.ts')),
  ]) {
    await change(); await ensureBuild('storage',{root,...quiet});
    assert.ok((await calls(root)).length>count);count=(await calls(root)).length;
  }
  await assert.rejects(readFile(join(root,'packages/contracts/dist/stale.js')), {code:'ENOENT'});
});

test('lock/config/env/tool bytes invalidate, upstream identities propagate and force runs again',async t=>{
  const root=await fixture(t);
  await ensureBuild('storage',{root,env:{},...quiet});
  let count=(await calls(root)).length;
  for(const [path,value] of [['package-lock.json','{"changed":true}'],['packages/contracts/tsconfig.json','{"strict":true}'],
    ['packages/contracts/node_modules/typescript/tsc.mjs',compiler+'\n// actual tool changed']]) {
    await put(root,path,value);await ensureBuild('storage',{root,env:{},...quiet});
    assert.equal((await calls(root)).length,count+2);count+=2;
  }
  await ensureBuild('storage',{root,env:{VITE_FEATURE:'new'},...quiet});
  assert.equal((await calls(root)).length,count+2);count+=2;
  await ensureBuild('storage',{root,env:{VITE_FEATURE:'new'},force:true,...quiet});
  assert.equal((await calls(root)).length,count+2);
});

test('installed graph markers invalidate with the root lock unchanged',async t=>{
  const root=await fixture(t);
  const rootLock=await readFile(join(root,'package-lock.json'),'utf8');
  await ensureBuild('contracts',{root,env:{},...quiet});
  let count=(await calls(root)).length;
  for(const path of ['node_modules/.package-lock.json','packages/contracts/node_modules/.package-lock.json']) {
    for(const version of ['1.0.0','2.0.0']) {
      await put(root,path,JSON.stringify({lockfileVersion:3,packages:{'node_modules/example':{version}}}));
      await ensureBuild('contracts',{root,env:{},...quiet});
      assert.equal((await calls(root)).length,++count);
      assert.equal(await readFile(join(root,'package-lock.json'),'utf8'),rootLock);
    }
  }
  await ensureBuild('contracts',{root,env:{},...quiet});
  assert.equal((await calls(root)).length,count);
});

test('restored cache hits in a different checkout with the same content and installed graph',async t=>{
  const root=await fixture(t),other=await fixture(t);
  for(const checkout of [root,other]) {
    for(const path of ['node_modules/.package-lock.json','packages/contracts/node_modules/.package-lock.json']) {
      await put(checkout,path,JSON.stringify({lockfileVersion:3,packages:{'node_modules/example':{version:'1.0.0'}}}));
    }
  }
  await ensureBuild('contracts',{root,env:{},...quiet});
  await cp(join(root,'.cache'),join(other,'.cache'),{recursive:true});
  await cp(join(root,'packages/contracts/dist'),join(other,'packages/contracts/dist'),{recursive:true});
  const hit=[];
  await ensureBuild('contracts',{root:other,env:{},log:line=>hit.push(line)});
  assert.deepEqual(hit,['[build] HIT contracts']);
  await assert.rejects(readFile(join(other,'calls.log')),{code:'ENOENT'});
});

test('custom --outDir reaches Vite without poisoning the default-output cache; unknown flags fail',async t=>{
  const root=await fixture(t);
  await ensureBuild('web:runtime',{root,...quiet});
  await ensureBuild('web:runtime',{root,args:['--outDir','candidate'],...quiet});
  await readFile(join(root,'apps/web/candidate/index.html'));
  await rm(join(root,'apps/web/candidate'),{recursive:true,force:true});
  const before=(await calls(root)).filter(c=>c.tool==='vite').length;
  await ensureBuild('web:runtime',{root,...quiet});
  assert.equal((await calls(root)).filter(c=>c.tool==='vite').length,before+1);
  await assert.rejects(ensureBuild('web:runtime',{root,args:['--bad'],...quiet}),/Build command failed/);
  assert.throws(()=>parseBuildArgs(['all','--wat']),/Usage/);
  assert.throws(()=>parseBuildArgs(['missing']),/Unknown build target/);
  assert.throws(()=>parseBuildArgs(['all','--force','--force']),/Usage/);
  assert.deepEqual(parseBuildArgs(['web:runtime','--','--outDir','candidate']),{target:'web:runtime',force:false,args:['--outDir','candidate']});
});

test('failure, cancellation and concurrent input edits never leave a success marker',async t=>{
  const root=await fixture(t);
  let fail=false,edit=false,cancel;
  const task={outputs:['out'],fingerprint:()=>contentManifest(root,['source']),async run(){
    await put(root,'out/index.js','ok');
    if(fail)throw new Error('deliberate failure');
    if(edit)await put(root,'source','changed');
    cancel?.abort();
  }};
  const run=opts=>runBuildGraph({root,tasks:{one:task},targets:['one'],...quiet,...opts});
  await run(); fail=true;
  await assert.rejects(run({force:true}),/deliberate failure/);
  await assert.rejects(readFile(join(root,'.cache/xunjie-build/one.json')),{code:'ENOENT'});
  fail=false;edit=true;
  await assert.rejects(run(),/inputs changed/);edit=false;
  await assert.rejects(readFile(join(root,'.cache/xunjie-build/one.json')),{code:'ENOENT'});
  cancel=new AbortController();await assert.rejects(run({signal:cancel.signal}));
  await assert.rejects(readFile(join(root,'.cache/xunjie-build/one.json')),{code:'ENOENT'});
});

test('production emitted graph rejects imported test hosts, not just tsconfig exclusions',async t=>{
  const root=await fixture(t);
  await put(root,'out/server/main.js','main');await scanServerOutput(join(root,'out'));
  for(const name of ['tests/host.js','server/test-child.js','runner/acceptance.js','server/accidental.test.d.ts']) {
    await put(root,`out/${name}`,'test host');await assert.rejects(scanServerOutput(join(root,'out')),/Test-only file/);
    await rm(join(root,'out',name));
  }
});

test('workspace test targets prepare real emitted dependencies and keep both web bundles for server',()=>{
  assert.deepEqual(expandTargets('server:test'),expandTargets('all'));
  assert.deepEqual(expandTargets('product-runtime:test'),expandTargets('all'));
  assert.deepEqual(expandTargets('web:test'),['web','web:runtime']);
  assert.deepEqual(expandTargets('@xunjie/storage'),['storage']);
});

test('cross-process lock ignores dead tickets, serializes contenders, and coalesces cache misses',async t=>{
  const root=await fixture(t);
  const module=pathToFileURL(fileURLToPath(new URL('./build-cache.mjs',import.meta.url))).href;
  await put(root,'worker.mjs',`import {runBuildGraph} from ${JSON.stringify(module)};
import {appendFile,open,mkdir,writeFile,rm} from 'node:fs/promises';import {join} from 'node:path';
const root=process.argv[2];
await runBuildGraph({root,force:process.argv.includes('--force'),log:()=>{},tasks:{one:{outputs:['output'],fingerprint:async()=>({v:1}),async run(){
 const exclusive=await open(join(root,'exclusive'),'wx');
 try {await appendFile(join(root,'runs'),'run\\n'); await new Promise(r=>setTimeout(r,75)); await mkdir(join(root,'output'),{recursive:true});await writeFile(join(root,'output/index.js'),'ok');}
 finally {await exclusive.close();await rm(join(root,'exclusive'));}
}}},targets:['one']});`);
  // Dead choosing tickets must not make a fresh process remove a live owner.
  const host=digest(hostname()).slice(0,16);
  await put(root,`.cache/xunjie-build/locks/${host}-2147483647-old.json`,JSON.stringify({pid:2147483647,host,choosing:true,number:1}));
  await put(root,'.cache/xunjie-build/lock',JSON.stringify({pid:2147483647,host:'stale',token:'old'}));
  const processRun=(force=false)=>new Promise((accept,reject)=>{
    const child=spawn(process.execPath,[join(root,'worker.mjs'),root,...force?['--force']:[]],{stdio:['ignore','pipe','pipe']});
    let output='';child.stderr.on('data',data=>output+=data);child.once('error',reject);
    child.once('close',code=>code===0?accept():reject(new Error(output||`exit ${code}`)));
  });
  await Promise.all(Array.from({length:6},()=>processRun()));
  assert.equal(await readFile(join(root,'runs'),'utf8'),'run\n');
  await Promise.all(Array.from({length:6},()=>processRun(true)));
  assert.equal(await readFile(join(root,'runs'),'utf8'),'run\n'.repeat(7));
});

test('Windows npm/cmd re-quoting is stripped so --outDir reaches Vite as a real path',async t=>{
  assert.deepEqual(normalizePassthroughArgs(['--outDir','"C:\\build\\web"'],'win32'),['--outDir','C:\\build\\web']);
  assert.deepEqual(normalizePassthroughArgs(['--outDir','"C:\\Program Files\\web"'],'win32'),['--outDir','C:\\Program Files\\web']);
  assert.deepEqual(normalizePassthroughArgs(['--outDir','C:\\build\\web'],'win32'),['--outDir','C:\\build\\web']);
  assert.deepEqual(normalizePassthroughArgs(['--outDir','"kept"'],'linux'),['--outDir','"kept"']);
  assert.deepEqual(parseBuildArgs(['web:runtime','--','--outDir','"C:\\build\\web"'],'win32'),
    {target:'web:runtime',force:false,args:['--outDir','C:\\build\\web']});
  // The stripped value is what the bundler actually receives: a quoted value
  // would land as `apps/web/"candidate"` instead of the requested directory.
  const root=await fixture(t);
  await ensureBuild('web:runtime',{root,args:parseBuildArgs(['--','--outDir','candidate'],'win32').args,...quiet});
  assert.equal(await readFile(join(root,'apps/web/candidate/index.html'),'utf8'),'<html>built</html>');
  assert.equal((await calls(root)).at(-1).args.at(-1),'candidate');
});

const cacheModule = pathToFileURL(fileURLToPath(new URL('./build-cache.mjs', import.meta.url))).href;
const startMarkers = spawnSync('ps', ['-o', 'lstart=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout?.trim();

async function lockWorker(root) {
  await put(root,'lock-worker.mjs',`import {runBuildGraph} from ${JSON.stringify(cacheModule)};
import { appendFile, open, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
const root=process.argv[2], sleepMs=Number(process.argv[3]??0), delayMs=Number(process.argv[4]??0);
if(delayMs) await new Promise(r=>setTimeout(r,delayMs));
await runBuildGraph({root,log:()=>{},tasks:{one:{outputs:['output'],cache:false,fingerprint:async()=>({v:1}),async run(){
 const exclusive=await open(join(root,'exclusive'),'wx');
 try {await appendFile(join(root,'runs'),'run\\n'); await new Promise(r=>setTimeout(r,sleepMs));
  await mkdir(join(root,'output'),{recursive:true}); await writeFile(join(root,'output/index.js'),'ok');}
 finally {await exclusive.close(); await rm(join(root,'exclusive'));}
}}},targets:['one']});`);
}
async function lockRun(root, env, sleepMs = 0, delayMs = 0) {
  const started=Date.now();
  await new Promise((accept,reject)=>{
    const child=spawn(process.execPath,[join(root,'lock-worker.mjs'),root,String(sleepMs),String(delayMs)],
      {env,stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);
    child.once('error',reject);
    child.once('close',code=>code===0?accept():reject(new Error(output.trim()||`exit ${code}`)));
  });
  return Date.now()-started;
}

test('lock timing defaults keep a live owner trusted and bound every wait',()=>{
  assert.deepEqual(lockTiming({}),{heartbeatMs:15_000,staleMs:120_000,waitMs:600_000,pollMs:50,startVerifyMs:500});
  // A ticket must always survive several missed refreshes, and the deadline
  // must always outlive the age at which a ticket may be doubted.
  for(const env of [{},{XUNJIE_BUILD_LOCK_HEARTBEAT_MS:'1000'},
    {XUNJIE_BUILD_LOCK_STALE_MS:'600000'},
    {XUNJIE_BUILD_LOCK_HEARTBEAT_MS:'60000',XUNJIE_BUILD_LOCK_STALE_MS:'1000',XUNJIE_BUILD_LOCK_WAIT_MS:'500'}]) {
    const timing=lockTiming(env);
    assert.ok(timing.staleMs>=timing.heartbeatMs*4,JSON.stringify(timing));
    assert.ok(timing.waitMs>=timing.staleMs*2,JSON.stringify(timing));
  }
});

test('a lock ticket whose pid was reused stops blocking once the pid is verified',async t=>{
  if(!startMarkers) return t.skip('this host cannot report process start markers');
  const root=await fixture(t);
  await lockWorker(root);
  const host=digest(hostname()).slice(0,16);
  // The recorded pid is alive but belongs to a different process now: start
  // markers disagree, which is exactly the pid reuse that hung real builds.
  await put(root,`.cache/xunjie-build/locks/${host}-${process.pid}-reused.json`,JSON.stringify({
    pid:process.pid,host,choosing:true,number:1,start:'start-of-a-process-that-no-longer-exists',
    createdAt:Date.now()-60_000,updatedAt:Date.now()-60_000}));
  const env={...process.env,XUNJIE_BUILD_LOCK_STALE_MS:'150',XUNJIE_BUILD_LOCK_HEARTBEAT_MS:'30',
    XUNJIE_BUILD_LOCK_WAIT_MS:'20000',XUNJIE_BUILD_LOCK_START_VERIFY_MS:'50'};
  const elapsed=await lockRun(root,env);
  assert.equal(await readFile(join(root,'runs'),'utf8'),'run\n');
  assert.ok(elapsed<15_000,`waited ${elapsed}ms`);
  await assert.rejects(readFile(join(root,`.cache/xunjie-build/locks/${host}-${process.pid}-reused.json`)),{code:'ENOENT'});
});

test('a live owner keeps refreshing so waiters queue instead of running concurrently',async t=>{
  const root=await fixture(t);
  await lockWorker(root);
  const env={...process.env,XUNJIE_BUILD_LOCK_STALE_MS:'150',XUNJIE_BUILD_LOCK_HEARTBEAT_MS:'30',XUNJIE_BUILD_LOCK_WAIT_MS:'20000'};
  await Promise.all([lockRun(root,env,400),lockRun(root,env,400)]);
  assert.equal(await readFile(join(root,'runs'),'utf8'),'run\nrun\n');
});

// A waiter holds a ticket too, and its ticket also grows old while it waits.
// Ageing must not by itself let anyone pass, or two builds run at once.
test('an old waiter ticket is never overtaken: three contenders stay strictly serial',async t=>{
  const root=await fixture(t);
  await lockWorker(root);
  const env={...process.env,XUNJIE_BUILD_LOCK_STALE_MS:'150',XUNJIE_BUILD_LOCK_HEARTBEAT_MS:'30',
    XUNJIE_BUILD_LOCK_WAIT_MS:'20000',XUNJIE_BUILD_LOCK_START_VERIFY_MS:'50'};
  const started=Date.now();
  // Each contender holds for far longer than the age at which tickets are
  // doubted; the third takes its number while the second is already waiting.
  // Serialised they need about three holds; concurrent they would need one.
  await Promise.all([lockRun(root,env,900),lockRun(root,env,900),lockRun(root,env,900,300)]);
  const elapsed=Date.now()-started;
  assert.equal((await readFile(join(root,'runs'),'utf8')).trim().split('\n').length,3);
  assert.ok(elapsed>2_000,`three contenders finished in ${elapsed}ms; they must serialise`);
});

test('waiting for the lock fails with a deadline and a diagnosis instead of hanging',async t=>{
  const root=await fixture(t);
  await lockWorker(root,0);
  const host=digest(hostname()).slice(0,16);
  await put(root,`.cache/xunjie-build/locks/${host}-${process.pid}-fresh.json`,JSON.stringify({
    pid:process.pid,host,choosing:true,number:1,start:undefined,createdAt:Date.now(),updatedAt:Date.now()}));
  // A ticket whose owner is provably alive is never taken over, so the wait
  // ends only at the deadline: staleMs stays below it (timing guarantees it).
  const env={...process.env,XUNJIE_BUILD_LOCK_STALE_MS:'100',XUNJIE_BUILD_LOCK_HEARTBEAT_MS:'30',XUNJIE_BUILD_LOCK_WAIT_MS:'300'};
  const started=Date.now();
  let error;
  try { await lockRun(root,env); } catch (cause) { error=cause; }
  const elapsed=Date.now()-started;
  assert.match(error?.message??'',/Timed out after 300ms waiting for the build lock/);
  assert.ok(error.message.includes(String(process.pid)),error.message);
  assert.ok(elapsed<15_000,`waited ${elapsed}ms`);
});

test('abort terminates a real command and prevents caching its partial output',async t=>{
  const root=await fixture(t),controller=new AbortController();
  const run=runBuildGraph({root,signal:controller.signal,...quiet,targets:['one'],tasks:{one:{outputs:['out'],fingerprint:async()=>1,
    async run({run}){ await run(process.execPath,['-e',"setInterval(()=>{},1000)"]); }}}});
  const timer=setTimeout(()=>controller.abort(),100);t.after(()=>clearTimeout(timer));
  await assert.rejects(run);
  await assert.rejects(readFile(join(root,'.cache/xunjie-build/one.json')),{code:'ENOENT'});
  assert.deepEqual(await import('node:fs/promises').then(fs=>fs.readdir(join(root,'.cache/xunjie-build/locks'))),[]);
});
