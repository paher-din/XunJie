import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {release} from 'node:os';
import {RunnerError,sha256} from './snapshot.ts';
import type {DockerExecutor} from './docker.ts';

// A deployment that updates runner/ without contracts/ must fail readiness with a typed code, not a bare ENOENT.
function contractHash(source:string,name:string) {
  try {return sha256(readFileSync(join(source,'../contracts/runner',name)));}
  catch (error) {
    if((error as {code?:string}).code==='ENOENT')throw new RunnerError('RUNTIME_NOT_READY',`Runner contract ${name} is not deployed beside the node source`);
    throw error;
  }
}

export async function nodeFingerprint(config:{source:string;profile:object},executor:DockerExecutor) {
  const info=JSON.parse(await executor.command(['info','--format','{{json .}}']));
  const sources=readdirSync(config.source).filter(name=>(name.endsWith('.ts')&&!name.endsWith('.test.ts'))||name.startsWith('hdl-')&&name.endsWith('.c')||name==='hdl.Dockerfile'||name==='hdl.apparmor').sort()
    .map(name=>[name,sha256(readFileSync(join(config.source,name)))]);
  sources.push(['contracts/runner/index.ts',contractHash(config.source,'index.ts')]);
  sources.push(['contracts/runner/hdl.ts',contractHash(config.source,'hdl.ts')]);
  const fingerprint={kernel:release(),node:process.version,engine:info.ServerVersion,cgroup:info.CgroupVersion,
    seccomp:info.SecurityOptions?.filter((value:string)=>value.startsWith('name=seccomp')),profile:config.profile,
    sourceHash:sha256(JSON.stringify(sources))};
  return {fingerprint,hash:sha256(JSON.stringify(fingerprint)),info};
}
