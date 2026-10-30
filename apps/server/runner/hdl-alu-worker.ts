import {existsSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {readJson,readEnvelope,writeImmutable,envelope} from './node-files.ts';
import {RunnerError,sha256} from './snapshot.ts';
import {containerArgs,hdlExecutor,temporaryWork,type HdlNodeConfig} from './hdl-executor.ts';
import {attachAluSimulation} from './alu-simulation.ts';
import {runAluComparison,aluPublicResult,emptyAluCoverage,validateAluCheck,type ResolvedAluBit} from './alu-check.ts';
import {acquireHdlToken,saveSession,readSession,journalUnit} from './hdl-ledger.ts';
import type {HdlAluCheck,AluStatus} from '../contracts/runner/alu.ts';

const path=process.argv[2]!,config=readJson(process.argv[3]!) as HdlNodeConfig;
const packet=readEnvelope(join(path,'request.json')),request=packet.check as HdlAluCheck;validateAluCheck(request);
const bits=packet.bits as ResolvedAluBit[],artifact=String(packet.artifact),state=readSession(path),executor=hdlExecutor(config);
if(sha256(readFileSync(join(artifact,'design.vvp')))!==request.artifactHash)throw new RunnerError('INVALID_REFERENCE','Immutable ALU artifact mismatch');
const started=performance.now(),budget=Math.max(0,Math.min(120000,Date.parse(state.deadline)-Date.now()));
let container:string|undefined,engine:ReturnType<typeof attachAluSimulation>|undefined,release:(()=>void)|undefined;
let failure:string|undefined,stopping=false,confirmed=false,status:AluStatus='incomplete',coverage=emptyAluCoverage(),termination:Promise<void>|undefined;
async function stopContainer(){stopping=true;engine?.close();
  if(!container)return;
  termination??=(async()=>{for(let i=0;i<50&&!confirmed;i++){confirmed=await executor.stop(container!);if(!confirmed)await new Promise(resolve=>setTimeout(resolve,100));}})();
  await termination;
}
const cancelled=()=>existsSync(join(path,'stop.intent'));
const timer=setInterval(()=>{if(cancelled()||performance.now()-started>=budget)void stopContainer();},50);
try{
  release=await acquireHdlToken(config,Math.max(1,Math.ceil(budget/1000)));
  if(cancelled()){status='cancelled';throw new RunnerError('STATE_CONFLICT','ALU check cancelled before dispatch');}
  if(stopping||performance.now()-started>=budget)throw new RunnerError('DEPENDENCY_UNAVAILABLE','ALU deadline before dispatch');
  await temporaryWork(join(path,'work'),32*1024*1024);
  const name='xunjie-dlc-session-'+sha256(state.sessionId);journalUnit(path,name);
  container=await executor.command(containerArgs(name,config.hdl.runtimeImage,artifact,join(path,'work'),true));
  if(!/^[a-f0-9]{64}$/.test(container))throw new RunnerError('DEPENDENCY_UNAVAILABLE','ALU container unconfirmed');
  writeImmutable(join(path,'created.json'),envelope({container}));journalUnit(path,name,container);
  if(stopping||cancelled())throw new RunnerError('STATE_CONFLICT','ALU check stopped before engine start');
  engine=attachAluSimulation(executor,container,reason=>{failure??=reason;void stopContainer();});
  await engine.initial(Math.max(1,budget-(performance.now()-started)));await engine.bind(bits);
  saveSession(path,{...state,status:'active',lastOperationAt:new Date().toISOString()});
  const result=await runAluComparison(request.binding,(start,inputs,remaining)=>engine!.batch(start,inputs,remaining),
    ()=>cancelled()||stopping,()=>performance.now(),Math.max(0,Math.floor(budget-(performance.now()-started))));
  status=result.status;coverage=result.coverage;
  // Private rows/failures are retained on the node, never returned by public result/query.
  writeImmutable(join(path,'private-samples.json'),envelope(result.rows.map(row=>[row.index,row.simTimePs,row.bits])));
  writeImmutable(join(path,'private-failures.json'),envelope(result.failures));
  if(result.failures.some(value=>['input_mismatch','unstable'].includes(value.category)))failure='binding_or_sampling_incomplete';
  else if(result.failures.length)failure='defined_domain_mismatch';
}catch{if(cancelled())status='cancelled';else{status='incomplete';failure??='sampling_unavailable';}}
finally{
  clearInterval(timer);await stopContainer();if(!container)confirmed=true;release?.();
  if(cancelled())status='cancelled';else if(performance.now()-started>=budget&&status==='passed'){status='incomplete';failure='deadline';}
  if(!confirmed)status='outcome_unknown';
  const final=aluPublicResult(request,status,coverage,confirmed,failure);
  writeImmutable(join(path,'check-result.json'),envelope(final));
  const current=readSession(path);saveSession(path,{...current,status:confirmed?(status==='passed'?'stopped':'failed'):'outcome_unknown',
    stopRequested:true,terminationConfirmed:confirmed,sessionRevision:current.sessionRevision+1,lastOperationAt:new Date().toISOString(),
    ...(failure?{failureKind:failure}:{})});
}
