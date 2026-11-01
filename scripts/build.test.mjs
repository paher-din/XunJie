import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp, utimes } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { contentManifest, digest, runBuildGraph } from './build-cache.mjs';
import { ensureBuild, expandTargets, parseBuildArgs, resolveTool } from './build.mjs';
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
  t.after(()=>rm(root,{recursive:true,force:true}));
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

test('restored cache hits in a different checkout with the same content and tools',async t=>{
  const root=await fixture(t),other=await fixture(t);
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

test('abort terminates a real command and prevents caching its partial output',async t=>{
  const root=await fixture(t),controller=new AbortController();
  const run=runBuildGraph({root,signal:controller.signal,...quiet,targets:['one'],tasks:{one:{outputs:['out'],fingerprint:async()=>1,
    async run({run}){ await run(process.execPath,['-e',"setInterval(()=>{},1000)"]); }}}});
  const timer=setTimeout(()=>controller.abort(),100);t.after(()=>clearTimeout(timer));
  await assert.rejects(run);
  await assert.rejects(readFile(join(root,'.cache/xunjie-build/one.json')),{code:'ENOENT'});
  assert.deepEqual(await import('node:fs/promises').then(fs=>fs.readdir(join(root,'.cache/xunjie-build/locks'))),[]);
});
