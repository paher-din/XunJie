import {existsSync,appendFileSync,openSync,fsyncSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {DockerExecutor} from './docker.ts';
import {buildRunWork} from './run-snapshot.ts';
import {courseChecks} from './course.ts';
import {readEnvelope,readJson,writeImmutable,envelope} from './node-files.ts';

const directory=process.argv[2];
const configPath=process.argv[3];
if(!directory||!configPath)throw Error('Job directory and runner configuration arguments are required');
const submission=readEnvelope(join(directory,'submission.json'));
const config=readJson(configPath);
const executor=new DockerExecutor(config.dockerBinary,config.dockerSocket,config.cliConfig);
const signal=new AbortController();
if(existsSync(join(directory,'stop.intent')))signal.abort();
const timer=setInterval(()=>{if(existsSync(join(directory,'stop.intent')))signal.abort();},50);
const checks=submission.mode==='check'?courseChecks(submission.snapshot,submission.input,submission.checkRuleVersion):undefined;
const work=buildRunWork(executor,join(directory,'workspace'),submission.identity,submission.snapshot,submission.entryFileId,submission.input,config.profile,checks);
try {
  const result=await work(signal.signal,async (name,operation)=>{
    appendFileSync(join(directory,'phases.jsonl'),JSON.stringify({name,pending:true})+'\n',{mode:0o600});
    const fd=openSync(join(directory,'phases.jsonl'),'r');try{fsyncSync(fd);}finally{closeSync(fd);}
    const result=await operation();
    appendFileSync(join(directory,'phases.jsonl'),JSON.stringify({name,pending:!result.unitTerminated})+'\n');
    const ended=openSync(join(directory,'phases.jsonl'),'r');try{fsyncSync(ended);}finally{closeSync(ended);}
    return result;
  });
  writeImmutable(join(directory,'outcome.json'),envelope(result));
} finally {clearInterval(timer);}
