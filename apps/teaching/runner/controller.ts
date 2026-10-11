import {createServer} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout} from 'node:timers/promises';
import {existsSync,mkdirSync,readFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {RunControl} from './control.ts';
import {DockerExecutor} from './docker.ts';
import {RunnerError,sha256,validateSnapshot} from './snapshot.ts';
import {buildRunWork} from './run-snapshot.ts';
import {courseChecks} from './course.ts';
import {nodeFingerprint} from './fingerprint.ts';
import {readJson,readEnvelope,writeImmutable,envelope} from './node-files.ts';
import type {RunIdentity} from './control.ts';
import type {SubmitRun,RunnerCommand} from '../contracts/runner/index.ts';

const exec=promisify(execFile);
const configPath=process.argv[2];
if(!configPath)throw new RunnerError('INVALID_REQUEST','Runner configuration argument is required');
const config=readJson(configPath);
mkdirSync(config.state,{recursive:true,mode:0o700});
const ledger=join(config.state,'ledger.jsonl');
const lastGeneration=existsSync(ledger)?readFileSync(ledger,'utf8').split('\n').filter(Boolean)
  .map(line=>JSON.parse(line).payload.generation).filter(Boolean).at(-1):undefined;
const executor=new DockerExecutor(config.dockerBinary,config.dockerSocket,config.cliConfig);
const directory=(id:string)=>join(config.state,'jobs',sha256(id));
const stopJob=async(name:string)=>{
  const path=join(config.state,'jobs',name.slice('xunjie-job-'.length));
  if(!existsSync(path))return false;
  if(!existsSync(join(path,'stop.intent')))writeImmutable(join(path,'stop.intent'),{stop:true});
  if(!existsSync(join(path,'outcome.json')))return false;
  return readEnvelope(join(path,'outcome.json')).unitTerminated===true;
};
const control=new RunControl(config.state,lastGeneration??config.generation,
  actor=>actor==='application'||actor==='maintenance',stopJob,actor=>actor==='maintenance');

async function reconcile(peer:string,id:RunIdentity) {
  return control.reconcileRun(peer,id,async()=>{
    const path=join(directory(id.runId),'outcome.json');
    if(!existsSync(path))return undefined;
    const outcome=readEnvelope(path);
    if(outcome.runId!==id.runId||outcome.snapshotHash!==id.snapshotHash||outcome.inputHash!==id.inputHash)throw new RunnerError('INVALID_REFERENCE','Recovered run references mismatch');
    return outcome;
  });
}

function workFor(submission:SubmitRun) {
  return async (_signal:AbortSignal,phase:<T extends {unitTerminated:boolean}>(name:string,operation:()=>Promise<T>)=>Promise<T>)=>{
    const path=directory(submission.identity.runId);
    const name=`xunjie-job-${sha256(submission.identity.runId)}`;
    return phase(name,async()=>{
      try {
        await exec('/usr/bin/systemd-run',['--unit',name,'--wait','--pipe','--quiet',
          '--property=Restart=no','--property=KillMode=control-group','--property=RuntimeMaxSec=100s',
          `--property=ExecStopPost=${config.node} ${config.source}/job-stop.ts ${path} ${configPath}`,
          config.node,`${config.source}/job-worker.ts`,path,configPath],{timeout:130000,maxBuffer:65536});
      } catch {
        if(!existsSync(join(path,'outcome.json')))throw new RunnerError('DEPENDENCY_UNAVAILABLE','Worker outcome is unknown');
      }
      const outcome=readEnvelope(join(path,'outcome.json'));
      if(outcome.runId!==submission.identity.runId||outcome.snapshotHash!==submission.identity.snapshotHash)throw new RunnerError('INVALID_REFERENCE','Worker outcome mismatch');
      return outcome;
    });
  };
}

async function dispatch(peer:string,request:RunnerCommand) {
  if(!['application','maintenance'].includes(peer))throw new RunnerError('UNAUTHENTICATED','Authenticated service peer required');
  if(!request||typeof request!=='object'||'actor' in request||'role' in request||'peer' in request)throw new RunnerError('INVALID_REQUEST','Client identity fields are forbidden');
  if(request.op==='advanceGeneration') {
    if(peer!=='maintenance')throw new RunnerError('FORBIDDEN','Recovery is maintenance-only');
    await control.advanceGeneration(peer,request.generation);return {generation:request.generation};
  }
  if(request.op==='recover') {
    if(peer!=='maintenance')throw new RunnerError('FORBIDDEN','Recovery is maintenance-only');
    control.setDispatchPaused(true);
    try {
      const identities=control.unsettledIdentities();
      for(const id of identities) {
        await control.cancelRun(peer,id);
        const unit=`xunjie-job-${sha256(id.runId)}`;
        try {await exec('/usr/bin/systemctl',['stop',unit],{timeout:60000,maxBuffer:65536});}catch{}
        const process=await exec('/usr/bin/systemctl',['show',unit,'--property=MainPID','--value']);
        if(process.stdout.trim()!=='0')throw new RunnerError('DEPENDENCY_UNAVAILABLE','Original worker still owns pending operations');
      }
      await exec('/usr/bin/systemctl',['stop','xunjie-c1-docker'],{timeout:60000,maxBuffer:65536});
      const old=await exec('/usr/bin/systemctl',['show','xunjie-c1-docker','--property=MainPID','--value']);
      if(old.stdout.trim()!=='0')throw new RunnerError('DEPENDENCY_UNAVAILABLE','Old Engine still owns pending operations');
      await exec('/usr/bin/systemctl',['start','xunjie-c1-docker'],{timeout:60000,maxBuffer:65536});
      let available=false;
      for(let attempt=0;attempt<100;attempt++) {
        try {await executor.command(['info']);available=true;break;}catch {await setTimeout(100);}
      }
      if(!available)throw new RunnerError('DEPENDENCY_UNAVAILABLE','Replacement Engine did not become ready');
      for(const id of identities) {
        const path=directory(id.runId);
        const journal=join(path,'phases.jsonl');
        if(existsSync(journal)) {
          const names=[...new Set(readFileSync(journal,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line).name as string))];
          for(const name of names) {
            const units=await executor.command(['ps','-a','--filter',`name=^/${name}$`,'--format','{{.ID}}']);
            if(units&&!await executor.stop(name))throw new RunnerError('DEPENDENCY_UNAVAILABLE','Original unit termination unconfirmed');
          }
        }
        if(!existsSync(join(path,'outcome.json')))writeImmutable(join(path,'outcome.json'),envelope({
          runId:id.runId,snapshotId:id.snapshotId,snapshotHash:id.snapshotHash,inputHash:id.inputHash,
          runtimeProfileVersion:id.runtimeProfileVersion,imageDigest:id.imageDigest,unitTerminated:true,
          failureKind:'cancelled',executionOutcome:'outcome_unknown',source:'engine_recovery_barrier'}));
        await reconcile(peer,id);
      }
      return {reconciled:identities.map(id=>id.runId)};
    } finally {control.setDispatchPaused(false);}
  }
  if(request.op==='readiness') {
    const {info,fingerprint,hash}=await nodeFingerprint(config,executor);
    const validationPath=config.validation+'.jsonl';
    const validated=existsSync(validationPath)?JSON.parse(readFileSync(validationPath,'utf8').trim().split('\n').at(-1)!):undefined;
    const images=JSON.parse(await executor.command(['image','inspect',config.profile.compilerImage,config.profile.runtimeImage]));
    return {ready:Boolean(validated?.passed&&validated.fingerprintHash===hash
      && info.SecurityOptions?.some((value:string)=>value.startsWith('name=seccomp'))&&info.CgroupVersion==='2'
      &&info.MemoryLimit&&info.SwapLimit&&info.PidsLimit
      &&images.every((image:{Os:string;Architecture:string})=>image.Os==='linux'&&image.Architecture==='amd64')),
      runtimeProfileVersion:config.profile.runtimeProfileVersion,imageDigest:config.profile.imageDigest,
      recoveryGeneration:control.currentGeneration(),
      compilerImage:config.profile.compilerImage,runtimeImage:config.profile.runtimeImage,fingerprint,validation:validated??null};
  }
  if(request.op==='submit') {
    const submission=request.submission;
    validateSnapshot(submission?.snapshot);
    if(!['run','check'].includes(submission.mode))throw new RunnerError('INVALID_REQUEST','Invalid execution mode');
    textScopeValidation(submission);
    const checks=submission.mode==='check'?courseChecks(submission.snapshot,submission.input,submission.checkRuleVersion!):undefined;
    buildRunWork(executor,join(config.state,'jobs'),submission.identity,submission.snapshot,submission.entryFileId,submission.input,config.profile,checks);
    await control.queryRun(peer,submission.identity);
    const path=directory(submission.identity.runId);
    mkdirSync(path,{recursive:true,mode:0o700});
    const packetPath=join(path,'submission.json');
    if(existsSync(packetPath)) {
      const original=readEnvelope(packetPath);
      original.identity.recoveryGeneration=submission.identity.recoveryGeneration;
      if(sha256(JSON.stringify(original))!==sha256(JSON.stringify(submission)))throw new RunnerError('IDEMPOTENCY_CONFLICT','Original run payload mismatch');
    } else writeImmutable(packetPath,envelope(submission));
    const result=await control.submitRun(peer,submission.identity,workFor(submission));
    if(result?.stopRequested&&!existsSync(join(path,'stop.intent')))writeImmutable(join(path,'stop.intent'),{stop:true});
    return result;
  }
  if(request.op==='query'||request.op==='cancel'||request.op==='readResult') {
    if(request.op==='cancel')return control.cancelRun(peer,request.identity);
    await reconcile(peer,request.identity);
    return request.op==='readResult'?control.readResult(peer,request.identity):control.queryRun(peer,request.identity);
  }
  throw new RunnerError('INVALID_REQUEST','Unknown runner command');
}

function textScopeValidation(submission:SubmitRun) {
  // Validate selection before trusted oracles dereference it.
  buildRunWork(executor,join(config.state,'jobs'),submission.identity,submission.snapshot,submission.entryFileId,submission.input,config.profile);
}

control.setDispatchPaused(true);
for(const id of control.queuedIdentities()) {
  const submission=readEnvelope(join(directory(id.runId),'submission.json')) as SubmitRun;
  textScopeValidation(submission);
  await control.submitRun('application',id,workFor(submission));
}
control.setDispatchPaused(false);
let reconciling=false;
setInterval(async()=>{
  if(reconciling)return;
  reconciling=true;
  try {for(const id of control.unsettledIdentities())await reconcile('application',id);}
  catch { /* Unknown or corrupt results retain their reserved slot. */ }
  finally {reconciling=false;}
},250);

const server=createServer(socket=>{
  let body='';let done=false;
  socket.setTimeout(150000,()=>socket.destroy());
  socket.on('data',async bytes=>{
    if(done)return;
    body+=bytes.toString('utf8');
    if(Buffer.byteLength(body)>8*1024*1024){done=true;socket.end(JSON.stringify({error:{code:'CONTENT_LIMIT',message:'Node request too large'}})+'\n');return;}
    if(!body.includes('\n'))return;
    done=true;
    try {
      const packet=JSON.parse(body.trim());
      const data=await dispatch(packet.peer,packet.request);
      socket.end(JSON.stringify({data:data??null})+'\n');
    } catch(error) {
      socket.end(JSON.stringify({error:{code:error instanceof RunnerError?error.code:'DEPENDENCY_UNAVAILABLE',
        message:error instanceof RunnerError?error.message:'Node operation unavailable'}})+'\n');
    }
  });
});
if(process.env.LISTEN_FDS==='1')server.listen({fd:3});
else server.listen(config.socket,()=>chmodSync(config.socket,0o600));
