import {appendFileSync,openSync,closeSync,fsyncSync,constants} from 'node:fs';
import {dirname} from 'node:path';
import {DockerExecutor} from './docker.ts';
import {nodeFingerprint} from './fingerprint.ts';
import {readJson} from './node-files.ts';

// Maintenance-only entry; evidence is created by acceptance.ts from actual child exit codes.
const config=readJson(process.argv[2]);
let text='';for await(const bytes of process.stdin)text+=bytes.toString('utf8');
const evidence=JSON.parse(text);
if(!Array.isArray(evidence)||evidence.length!==3||new Set(evidence.map(item=>item.suite)).size!==3||!evidence.every(item=>item.exitCode===0
  &&/^[0-9a-f]{64}$/.test(item.outputHash)&&['guest','ssh','types'].includes(item.suite)))throw Error('All three executed suites must pass');
const executor=new DockerExecutor(config.dockerBinary,config.dockerSocket,config.cliConfig);
const {fingerprint,hash}=await nodeFingerprint(config,executor);
const record={passed:true,fingerprintHash:hash,fingerprint,evidence,validatedAt:new Date().toISOString()};
const path=config.validation+'.jsonl';
const fd=openSync(path,constants.O_CREAT|constants.O_APPEND|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
try {appendFileSync(fd,JSON.stringify(record)+'\n');fsyncSync(fd);}finally{closeSync(fd);}
const directory=openSync(dirname(path),constants.O_DIRECTORY|constants.O_RDONLY);
try{fsyncSync(directory);}finally{closeSync(directory);}
process.stdout.write(JSON.stringify(record)+'\n');
