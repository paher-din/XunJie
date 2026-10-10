import {readFileSync,existsSync} from 'node:fs';
import {DockerExecutor} from './docker.ts';
import {readJson} from './node-files.ts';
import {setTimeout} from 'node:timers/promises';
import {join} from 'node:path';

const directory=process.argv[2];
const configPath=process.argv[3];
if(!directory||!configPath)throw Error('Job directory and runner configuration arguments are required');
const executorConfig=readJson(configPath);
const executor=new DockerExecutor(executorConfig.dockerBinary,executorConfig.dockerSocket,executorConfig.cliConfig);
const path=join(directory,'phases.jsonl');
if(existsSync(path)) {
  const names=[...new Set(readFileSync(path,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line).name as string))];
  // A killed worker may leave a request in the Engine; retain unknown unless recovery drains the old Engine.
  for(let attempt=0;attempt<3;attempt++) {await Promise.all(names.map(name=>executor.stop(name)));await setTimeout(100);}
}
