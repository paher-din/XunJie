import {createServer} from 'node:net';
import {mkdirSync,existsSync,readdirSync,readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {readJson,readEnvelope,writeImmutable,envelope} from './node-files.ts';
import {RunnerError,sha256} from './snapshot.ts';
import {attachSimulation,containerArgs,hdlExecutor,temporaryWork} from './hdl-executor.ts';
import type {HdlNodeConfig} from './hdl-executor.ts';
import {hdlLimits,validateOperation} from './hdl-profile.ts';
import {acquireHdlToken,saveSession,readSession,journalUnit,sameIdentity,hdlSocket} from './hdl-ledger.ts';
import type {HdlBuild,HdlOperation,HdlOperationResult} from '../contracts/runner/hdl.ts';

const path=process.argv[2]!,config=readJson(process.argv[3]!) as HdlNodeConfig;
let state=readSession(path),inFlight=false,traceBytes=0,terminating:Promise<void>|undefined;
const started=performance.now(),lifetime=Math.max(0,Math.min(hdlLimits.lifetimeMs,Date.parse(state.deadline)-Date.now()));let lastOperationTime=started;
const executor=hdlExecutor(config),request=readEnvelope(join(path,'request.json'));
const build=request.build as HdlBuild,artifact=request.artifact as string;
if(sha256(readFileSync(join(artifact,'design.vvp')))!==build.artifactHash)throw new RunnerError('INVALID_REFERENCE','Immutable HDL artifact mismatch');
const name='xunjie-dlc-session-'+sha256(state.sessionId),work=join(path,'work');let container:string|undefined;
let engine:ReturnType<typeof attachSimulation>|undefined;
async function terminate(reason:string){
  if(terminating)return terminating;
  state={...state,status:'stopping',stopRequested:true,failureKind:reason};saveSession(path,state);
  terminating=(async()=>{
    engine?.close();let confirmed=false;
    if(container)for(let i=0;i<50&&!confirmed;i++){confirmed=await executor.stop(container);if(!confirmed)await new Promise(resolve=>setTimeout(resolve,100));}
    let failure=reason;
    if(container)try{if((await executor.inspect(container)).State.OOMKilled)failure='oom';}catch{/* Missing resource facts remain unknown. */}
    state={...state,status:confirmed?(reason==='stopped'?'stopped':'failed'):'outcome_unknown',terminationConfirmed:confirmed,sessionRevision:state.sessionRevision+1,failureKind:failure};
    saveSession(path,state);
  })();return terminating;
}
async function interact(operation:HdlOperation){
  validateOperation(operation);
  if(operation.sessionId!==state.sessionId||JSON.stringify(operation.identity.scope)!==JSON.stringify(state.identity.scope))throw new RunnerError('FORBIDDEN','Session scope required');
  if(operation.identity.recoveryGeneration!==state.identity.recoveryGeneration)throw new RunnerError('RECOVERY_REQUIRED','Current HDL generation required');
  const directory=join(path,'operations',sha256(operation.identity.id));
  if(existsSync(join(directory,'request.json'))){sameIdentity(readEnvelope(join(directory,'request.json')).identity,operation.identity);
    if(JSON.stringify(readEnvelope(join(directory,'request.json')))!==JSON.stringify(operation))throw new RunnerError('IDEMPOTENCY_CONFLICT','Original operation required');
    return existsSync(join(directory,'result.json'))?readEnvelope(join(directory,'result.json')):{pending:true,operationId:operation.identity.id};}
  if(state.status!=='active'||state.stopRequested||inFlight)throw new RunnerError('STATE_CONFLICT','Session is not available for a new operation');
  if(operation.expectedSessionRevision!==state.sessionRevision||operation.expectedSequence!==state.confirmedSequence+1)throw new RunnerError('VERSION_CONFLICT','Session sequence/version changed');
  inFlight=true;mkdirSync(directory,{recursive:true,mode:0o700});writeImmutable(join(directory,'request.json'),envelope(operation));
  state={...state,pendingOperationId:operation.identity.id};saveSession(path,state);
  let release:(()=>void)|undefined;
  try{
    release=await acquireHdlToken(config);
    if(state.stopRequested||!engine)throw new RunnerError('STATE_CONFLICT','Session stopped before dispatch');
    const batch=await engine.step(operation.inputs,operation.advanceCycles);
    if(state.stopRequested)throw new RunnerError('STATE_CONFLICT','Session stopped before result acceptance');
    if(BigInt(batch.finalFrame.simTimePs)!==BigInt(state.simTimePs)+BigInt(operation.advanceCycles)*10000n||batch.sampleCount!==operation.advanceCycles)throw new RunnerError('INVALID_REFERENCE','Original simulation time mismatch');
    const body={operationId:operation.identity.id,sessionId:state.sessionId,buildId:build.buildId,snapshotId:build.snapshotId,snapshotHash:build.snapshotHash,
      boardProfileVersion:build.board.boardProfileVersion,mappingVersion:build.board.mappingVersion,engineVersion:build.engineVersion,
      sequence:operation.expectedSequence,sessionRevision:state.sessionRevision+1,...batch,coverage:batch.droppedFrames?'incomplete' as const:'complete' as const};
    const result:HdlOperationResult={...body,resultHash:sha256(JSON.stringify(body))};const bytes=Buffer.byteLength(JSON.stringify(result));
    if(bytes>hdlLimits.packetBytes||traceBytes+bytes>hdlLimits.traceBytes){await terminate('trace_limit');throw new RunnerError('CONTENT_LIMIT','Session trace capacity exceeded');}
    writeImmutable(join(directory,'result.json'),envelope(result));traceBytes+=bytes;
    const next={...state,confirmedSequence:result.sequence,sessionRevision:result.sessionRevision,simTimePs:result.finalFrame.simTimePs,lastOperationAt:new Date().toISOString()};
    delete next.pendingOperationId;state=next;lastOperationTime=performance.now();saveSession(path,state);return result;
  }catch(error){await terminate(error instanceof RunnerError?error.code:'infrastructure_error');throw error;}
  finally{release?.();inFlight=false;}
}
const server=createServer(socket=>{
  let body='';socket.setTimeout(125000,()=>socket.destroy());
  socket.on('data',async bytes=>{body+=bytes.toString('utf8');if(Buffer.byteLength(body)>65536){socket.destroy();return;}if(!body.includes('\n'))return;
    try{const packet=JSON.parse(body);let data;
      if(packet.op==='interact')data=await interact(packet.request);
      else if(packet.op==='stop'){sameIdentity(state.identity,packet.identity);await terminate('stopped');data=state;}
      else throw new RunnerError('INVALID_REQUEST','Unknown session command');
      socket.end(JSON.stringify({data})+'\n');
    }catch(error){socket.end(JSON.stringify({error:{code:error instanceof RunnerError?error.code:'DEPENDENCY_UNAVAILABLE',message:'HDL session command rejected'}})+'\n');}
  });
});
server.listen(hdlSocket(state.sessionId));
const watchdog=setInterval(()=>{
  const elapsed=performance.now();if(elapsed-started>=lifetime)void terminate('lifetime_limit');
  else if(elapsed-lastOperationTime>=hdlLimits.idleMs)void terminate('idle_timeout');
  if(state.terminationConfirmed){clearInterval(watchdog);server.close();}
},100);
try{
  const release=await acquireHdlToken(config);
  try{
    if(!state.stopRequested){await temporaryWork(work,32*1024*1024);journalUnit(path,name);
      container=await executor.command(containerArgs(name,config.hdl.runtimeImage,artifact,work,true));
      if(!/^[a-f0-9]{64}$/.test(container))throw new RunnerError('DEPENDENCY_UNAVAILABLE','Session container unconfirmed');
      writeImmutable(join(path,'created.json'),envelope({container}));
      if(state.stopRequested)await executor.stop(container);
      else {engine=attachSimulation(executor,container,reason=>{void terminate(reason);},bytes=>appendFileSync(join(path,'engine.log'),bytes,{mode:0o600}));const initial=await engine.initial();
        if(!state.stopRequested){state={...state,status:'active',simTimePs:initial.finalFrame.simTimePs};
          const body={operationId:state.sessionId,sessionId:state.sessionId,buildId:build.buildId,snapshotId:build.snapshotId,snapshotHash:build.snapshotHash,
            boardProfileVersion:build.board.boardProfileVersion,mappingVersion:build.board.mappingVersion,engineVersion:build.engineVersion,
            sequence:0,sessionRevision:1,...initial,coverage:'complete' as const};
          const initialResult={...body,resultHash:sha256(JSON.stringify(body))};traceBytes=Buffer.byteLength(JSON.stringify(initialResult));
          writeImmutable(join(path,'initial.json'),envelope(initialResult));saveSession(path,state);}}
    }
  }finally{release();}
}catch{await terminate('startup_failure');}
// Retained operations are immutable; a new process never replays them to rebuild registers.
for(const directory of readdirSync(join(path,'operations')))if(existsSync(join(path,'operations',directory,'result.json')))traceBytes+=readFileSync(join(path,'operations',directory,'result.json')).length;
