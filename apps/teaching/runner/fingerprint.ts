import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {release} from 'node:os';
import {sha256} from './snapshot.ts';
import type {DockerExecutor} from './docker.ts';

export async function nodeFingerprint(config:{source:string;profile:object},executor:DockerExecutor) {
  const info=JSON.parse(await executor.command(['info','--format','{{json .}}']));
  const sources=readdirSync(config.source).filter(name=>name.endsWith('.ts')&&!name.endsWith('.test.ts')).sort()
    .map(name=>[name,sha256(readFileSync(join(config.source,name)))]);
  sources.push(['contracts/runner/index.ts',sha256(readFileSync(join(config.source,'../contracts/runner/index.ts')))]);
  const fingerprint={kernel:release(),node:process.version,engine:info.ServerVersion,cgroup:info.CgroupVersion,
    seccomp:info.SecurityOptions?.filter((value:string)=>value.startsWith('name=seccomp')),profile:config.profile,
    sourceHash:sha256(JSON.stringify(sources))};
  return {fingerprint,hash:sha256(JSON.stringify(fingerprint)),info};
}
