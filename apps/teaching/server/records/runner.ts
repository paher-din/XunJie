import {execFile} from 'node:child_process';
import {RunnerError,sha256,validatePath} from '../../runner/snapshot.ts';
import {canonical} from './commands.ts';
import type {RunnerCommand,SubmitRun,RunFact,Profile} from '../../contracts/runner/index.ts';

type ApplicationCommand=Extract<RunnerCommand,{op:'submit'|'query'|'cancel'|'readResult'|'readiness'}>;
export type RunnerTransport=(command:ApplicationCommand)=>Promise<unknown>;
function object(value:unknown):Record<string,unknown> {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new RunnerError('DEPENDENCY_UNAVAILABLE','Malformed authenticated runner response');
  return value as Record<string,unknown>;
}
function data(value:unknown) {
  const response=object(value);
  if(response.error){const error=object(response.error);throw new RunnerError(typeof error.code==='string'?error.code:'DEPENDENCY_UNAVAILABLE','Runner command rejected');}
  if(!Object.hasOwn(response,'data'))throw new RunnerError('DEPENDENCY_UNAVAILABLE','Runner response missing');
  return response.data;
}
function authorize(check:()=>boolean){if(check()!==true)throw new RunnerError('FORBIDDEN','Current run authorization required');}

// All SSH settings come from maintenance configuration; no request supplies options or commands.
export function sshRunner(config:{binary:string;keyFile:string;knownHostsFile:string;host:string;port:number}):RunnerTransport {
  if(!config.binary||!config.keyFile||!config.knownHostsFile||!/^[A-Za-z0-9.-]+$/.test(config.host)
    ||!Number.isInteger(config.port)||config.port<1||config.port>65535)throw new RunnerError('INVALID_CONFIGURATION','Trusted SSH configuration required');
  return request=>new Promise((resolve,reject)=>{
    const child=execFile(config.binary,['-i',config.keyFile,'-o',`UserKnownHostsFile=${config.knownHostsFile}`,
      '-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','-o','ConnectTimeout=5','-p',String(config.port),`root@${config.host}`,'xunjie-c1'],
      {timeout:150000,maxBuffer:4*1024*1024},(error,stdout)=>{
        if(error){reject(new RunnerError('DEPENDENCY_UNAVAILABLE','Authenticated runner unavailable'));return;}
        try{resolve(JSON.parse(stdout));}catch{reject(new RunnerError('DEPENDENCY_UNAVAILABLE','Malformed runner response'));}
      });
    child.stdin!.on('error',()=>{});child.stdin!.end(JSON.stringify(request));
  });
}
export async function readRuntime(transport:RunnerTransport) {
  const ready=object(data(await transport({op:'readiness'})));
  if(ready.ready!==true)throw new RunnerError('RUNTIME_NOT_READY','Runner has not passed current environment validation');
  const profile=object(object(ready.fingerprint).profile);
  if(['runtimeProfileVersion','imageDigest','compilerImage','runtimeImage'].some(key=>typeof profile[key]!=='string'||profile[key]!==ready[key])
    ||typeof ready.recoveryGeneration!=='string'||!ready.recoveryGeneration
    ||!Array.isArray(profile.approvedResultFiles)||profile.approvedResultFiles.some(name=>typeof name!=='string')
    ||['imageDigest','compilerImage','runtimeImage'].some(key=>!/^sha256:[0-9a-f]{64}$/.test(String(profile[key]))))throw new RunnerError('INVALID_REFERENCE','Runtime identity mismatch');
  profile.approvedResultFiles.forEach(validatePath);
  return {profile:structuredClone(profile) as Profile,recoveryGeneration:ready.recoveryGeneration};
}
export function validateRunFact(submission:SubmitRun,value:unknown):RunFact|null {
  if(value===null)return null;
  const fact=object(value),identity=object(fact.identity);
  const current={...submission.identity,recoveryGeneration:identity.recoveryGeneration};
  if(canonical(identity)!==canonical(current)||typeof fact.reserved!=='boolean'||typeof fact.stopRequested!=='boolean'
    ||!['queued','running','cancelling','cancelled','succeeded','failed','stale','outcome_unknown'].includes(String(fact.state))
    ||!Array.isArray(fact.units)||!Array.isArray(fact.pending)||[...fact.units,...fact.pending].some(name=>typeof name!=='string'))throw new RunnerError('INVALID_REFERENCE','Original runner fact mismatch');
  return structuredClone(fact) as RunFact;
}
export async function dispatchOriginalRun(submission:SubmitRun,transport:RunnerTransport,checkCurrent:()=>boolean) {
  authorize(checkCurrent);
  const known=validateRunFact(submission,data(await transport({op:'query',identity:submission.identity})));
  authorize(checkCurrent);
  if(known)return known;
  const accepted=validateRunFact(submission,data(await transport({op:'submit',submission})));
  authorize(checkCurrent);return accepted;
}
export async function stopOriginalRun(submission:SubmitRun,transport:RunnerTransport,checkCurrent:()=>boolean) {
  authorize(checkCurrent);
  return validateRunFact(submission,data(await transport({op:'cancel',identity:submission.identity})));
}
export async function queryOriginalRun(submission:SubmitRun,transport:RunnerTransport,checkCurrent:()=>boolean) {
  authorize(checkCurrent);
  const fact=validateRunFact(submission,data(await transport({op:'query',identity:submission.identity})));
  authorize(checkCurrent);return fact;
}
export function validateRunResult(submission:SubmitRun,value:unknown) {
  const record=object(value);
  if(['runId','snapshotId','snapshotHash','inputHash','runtimeProfileVersion','imageDigest'].some(key=>record[key]!==submission.identity[key as keyof typeof submission.identity])
    ||record.unitTerminated!==true)throw new RunnerError('INVALID_REFERENCE','Confirmed original run result required');
  if(record.executionOutcome==='outcome_unknown'&&record.verdict==='passed')throw new RunnerError('INVALID_REFERENCE','Unknown result cannot pass a check');
  const body=JSON.stringify(record);
  return {record:structuredClone(record),body,contentHash:sha256(body)};
}
export async function readOriginalResult(submission:SubmitRun,transport:RunnerTransport,checkCurrent:()=>boolean) {
  authorize(checkCurrent);
  const fact=validateRunFact(submission,data(await transport({op:'query',identity:submission.identity})));
  if(!fact?.resultRef||!fact.resultHash)return undefined;
  authorize(checkCurrent);
  const result=validateRunResult(submission,data(await transport({op:'readResult',identity:submission.identity})));
  authorize(checkCurrent);
  if(result.contentHash!==fact.resultHash)throw new RunnerError('INVALID_REFERENCE','Original node result checksum mismatch');
  return {...result,resultRef:fact.resultRef};
}
