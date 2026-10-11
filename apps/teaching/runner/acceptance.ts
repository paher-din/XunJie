import {execFile} from 'node:child_process';
import {mkdirSync,mkdtempSync,writeFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {sha256} from './snapshot.ts';

const exec=promisify(execFile);
if(process.platform!=='linux')throw Error('Run in the prepared WSL host, never the guest');
const base='/opt/xunjie-runner/vm';
const ssh=['-i',`${base}/keys/maintenance`,'-o',`UserKnownHostsFile=${base}/keys/known_hosts`,
  '-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','-p','2222','root@127.0.0.1'];
const cache=resolve('node_modules/.cache');mkdirSync(cache,{recursive:true});
const directory=mkdtempSync(join(cache,'c1-acceptance-'));
const node='/opt/xunjie-runner/node/bin/node';
const config=JSON.parse((await exec('/usr/bin/ssh',[...ssh,'cat /opt/xunjie-runner/config.json'])).stdout);
if(!/^sha256:[0-9a-f]{64}$/.test(config.profile.runtimeImage))throw Error('Recorded runtime image required');
const suites=[
  {suite:'guest',binary:'/usr/bin/ssh',args:[...ssh,`XUNJIE_C1_RUNTIME=1 XUNJIE_C1_RUNTIME_IMAGE=${config.profile.runtimeImage} ${node} --test /opt/xunjie-runner/source/runner/*.test.ts`]},
  {suite:'ssh',binary:node,args:['--test','apps/teaching/runner/node.rpc.test.ts'],env:{...process.env,XUNJIE_C1_SSH:'1'}},
  {suite:'types',binary:node,args:['/opt/xunjie-runner/typecheck/node_modules/typescript/bin/tsc','--noEmit','--strict','--target','es2023','--module','esnext','--moduleResolution','bundler',
    '--allowImportingTsExtensions','--types','node','--typeRoots','/opt/xunjie-runner/typecheck/node_modules/@types',
    ...['apps/teaching/runner','apps/teaching/contracts/runner'].flatMap(directory=>readdirSync(directory).filter(name=>name.endsWith('.ts')).map(name=>join(directory,name)))]},
];
const evidence:{suite:string;exitCode:number;outputHash:string}[]=[];
for(const suite of suites) {
  let exitCode=0;let output='';
  try {const value=await exec(suite.binary,suite.args,{timeout:240000,maxBuffer:4*1024*1024,env:suite.env});output=value.stdout+value.stderr;}
  catch(error){const failure=error as {code?:number;stdout?:string;stderr?:string};exitCode=failure.code??1;output=(failure.stdout??'')+(failure.stderr??'');}
  writeFileSync(join(directory,`${suite.suite}.txt`),output,{flag:'wx'});
  process.stdout.write(output);process.stdout.write(`${suite.suite}: exit ${exitCode}\n`);
  evidence.push({suite:suite.suite,exitCode,outputHash:sha256(output)});
  if(exitCode!==0)throw Error(`Acceptance failed: ${suite.suite}; retained logs in ${directory}`);
}
const recorded=await new Promise<string>((resolve,reject)=>{
  const child=execFile('/usr/bin/ssh',[...ssh,`${node} /opt/xunjie-runner/source/runner/record-validation.ts /opt/xunjie-runner/config.json`],
    {timeout:30000,maxBuffer:65536},(error,stdout)=>error?reject(error):resolve(stdout));
  child.stdin!.end(JSON.stringify(evidence));
});
writeFileSync(join(directory,'validation.json'),recorded,{flag:'wx'});
process.stdout.write(recorded);
