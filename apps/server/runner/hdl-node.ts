import {connect} from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync,mkdirSync,readdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {RunnerError,sha256} from './snapshot.ts';
import {envelope,readEnvelope,writeImmutable} from './node-files.ts';
import {nodeFingerprint} from './fingerprint.ts';
import {hdlExecutor} from './hdl-executor.ts';
import type {HdlNodeConfig} from './hdl-executor.ts';
import {initializeHdl,hdlRoot,hdlDirectory,readSession,saveSession,sameIdentity,readIfPresent,hdlSocket} from './hdl-ledger.ts';
import {fields,hdlLimits,validateIdentity,validateBuildRequest,validateOperation,validateProgram} from './hdl-profile.ts';
import type {HdlCommand,HdlBuild,HdlBuildRequest,HdlIdentity,HdlProgram,HdlSession} from '../contracts/runner/hdl.ts';
import type {HdlAluProbe,HdlAluCheck,HdlAluResult} from '../contracts/runner/alu.ts';
import {validateAluProbe,validateAluCheck,matchAluBuild,resolveAluBinding,aluBindingHash,aluPublicResult,emptyAluCoverage,type AluElaboration} from './alu-check.ts';

const exec=promisify(execFile);
export class HdlNode {
  config:HdlNodeConfig;configPath:string;generation:()=>string;paused=false;
  constructor(config:HdlNodeConfig,configPath:string,generation:()=>string){
    for(const image of [config.hdl.buildImage,config.hdl.runtimeImage])if(!/^sha256:[a-f0-9]{64}$/.test(image))throw new RunnerError('INVALID_CONFIGURATION','Fixed HDL images required');
    this.config=config;this.configPath=configPath;this.generation=generation;initializeHdl(config);
  }
  private authorize(identity:HdlIdentity){validateIdentity(identity);if(identity.recoveryGeneration!==this.generation())throw new RunnerError('RECOVERY_REQUIRED','Current execution generation required');}
  async readiness(){
    const executor=hdlExecutor(this.config),{fingerprint,hash,info}=await nodeFingerprint({source:this.config.source,profile:this.config.hdl},executor);
    const validationPath=join(hdlRoot(this.config),'validation.jsonl');
    const validation=existsSync(validationPath)?JSON.parse(readFileSync(validationPath,'utf8').trim().split('\n').at(-1)!):undefined;
    const images=JSON.parse(await executor.command(['image','inspect',this.config.hdl.buildImage,this.config.hdl.runtimeImage]));
    const enforced=readFileSync('/sys/kernel/security/apparmor/profiles','utf8').split('\n').includes('xunjie-dlc-v1 (enforce)');
    return {ready:!this.paused&&enforced&&fingerprint.sourceHash===this.config.hdl.sourceHash&&validation?.passed===true&&validation.fingerprintHash===hash
      &&info.CgroupVersion==='2'&&info.MemoryLimit&&info.SwapLimit&&info.PidsLimit&&info.SecurityOptions?.some((value:string)=>value.startsWith('name=seccomp'))
      &&images.every((image:{Os:string;Architecture:string})=>image.Os==='linux'&&image.Architecture==='amd64'),
      profile:this.config.hdl,recoveryGeneration:this.generation(),fingerprint,fingerprintHash:hash,validation:validation??null};
  }
  private async launch(kind:'build'|'session'|'alu',path:string,id:string){
    const unit='xunjie-dlc-'+(kind==='alu'?'session':kind)+'-'+sha256(id);
    await exec('/usr/bin/systemd-run',['--unit',unit,'--quiet','--property=Restart=no','--property=KillMode=control-group',
      `--property=RuntimeMaxSec=${kind==='session'?1800:120}s`,
      `--property=ExecStopPost=${this.config.node} ${this.config.source}/hdl-stop-worker.ts ${path} ${this.configPath}`,
      this.config.node,`${this.config.source}/hdl-${kind}-worker.ts`,path,this.configPath],{timeout:10000,maxBuffer:65536});
  }
  private session(identity:HdlIdentity):{state:HdlSession;path:string}{
    this.authorize(identity);const path=hdlDirectory(this.config,'sessions',identity.id);
    if(!existsSync(path))throw new RunnerError('FORBIDDEN','Original session unavailable');const state=readSession(path);sameIdentity(state.identity,identity);return {state,path};
  }
  private build(identity:HdlIdentity):HdlBuild{
    this.authorize(identity);const path=hdlDirectory(this.config,'builds',identity.id);
    if(!existsSync(path))throw new RunnerError('FORBIDDEN','Original build unavailable');
    const original=readEnvelope(join(path,'request.json')) as HdlBuildRequest;sameIdentity(original.identity,identity);
    const outcome=readIfPresent(join(path,'outcome.json'));
    const barrier=readIfPresent(join(path,'termination.json'));
    if(outcome){sameIdentity(outcome.identity,identity);
      return !outcome.terminationConfirmed&&barrier?{...outcome,status:'cancelled',terminationConfirmed:true,failureKind:'engine_recovery_barrier'}:outcome;}
    const unknown=readIfPresent(join(path,'unknown.json'));
    return {buildId:identity.id,identity,snapshotId:original.snapshot.snapshotId,snapshotHash:original.snapshot.hash,board:original.board,
      runtimeProfileVersion:this.config.hdl.runtimeProfileVersion,engineVersion:this.config.hdl.engineVersion,imageDigest:this.config.hdl.buildImage,
      configurationHash:sha256(JSON.stringify(original.board)),status:barrier?'cancelled':unknown?(unknown.terminationConfirmed?'cancelled':'outcome_unknown'):'queued',terminationConfirmed:barrier?.unitTerminated===true||unknown?.terminationConfirmed===true,diagnostics:[],stdout:'',stderr:''};
  }
  private async submit(request:HdlBuildRequest){
    validateBuildRequest(request);this.authorize(request.identity);
    const path=hdlDirectory(this.config,'builds',request.identity.id);
    if(existsSync(path)){const original=readEnvelope(join(path,'request.json'));sameIdentity(original.identity,request.identity);
      if(JSON.stringify(original)!==JSON.stringify(request))throw new RunnerError('IDEMPOTENCY_CONFLICT','Original build packet required');return this.build(request.identity);}
    if(request.runtimeProfileVersion!==this.config.hdl.runtimeProfileVersion)throw new RunnerError('RUNTIME_NOT_READY','Approved HDL runtime required');
    mkdirSync(path,{mode:0o700});writeImmutable(join(path,'request.json'),envelope(request));
    await this.launch('build',path,request.identity.id);return this.build(request.identity);
  }
  private async program(request:HdlProgram){
    validateProgram(request);this.authorize(request.identity);const path=hdlDirectory(this.config,'sessions',request.identity.id);
    if(existsSync(path)){const original=readEnvelope(join(path,'request.json')).program;sameIdentity(original.identity,request.identity);
      if(JSON.stringify(original)!==JSON.stringify(request))throw new RunnerError('IDEMPOTENCY_CONFLICT','Original program packet required');return readSession(path);}
    const buildPath=hdlDirectory(this.config,'builds',request.buildId);
    if(!existsSync(buildPath))throw new RunnerError('FORBIDDEN','Authorized build required');
    const originalBuild=readEnvelope(join(buildPath,'request.json')) as HdlBuildRequest;
    if(JSON.stringify(originalBuild.identity.scope)!==JSON.stringify(request.identity.scope))throw new RunnerError('FORBIDDEN','Same-scope build required');
    const build=this.build(originalBuild.identity);if(build.status!=='succeeded'||!build.terminationConfirmed||!build.artifactHash)throw new RunnerError('STATE_CONFLICT','Successful immutable build required');
    if(request.replaceSessionId){const originalPath=hdlDirectory(this.config,'sessions',request.replaceSessionId);
      if(!existsSync(originalPath))throw new RunnerError('FORBIDDEN','Original replacement session required');const previous=readSession(originalPath);
      if(JSON.stringify(previous.identity.scope)!==JSON.stringify(request.identity.scope))throw new RunnerError('FORBIDDEN','Original replacement scope required');
      if(previous.sessionRevision!==request.expectedSessionRevision)throw new RunnerError('VERSION_CONFLICT','Replacement session changed');await this.stop(previous.identity);}
    const occupied=readdirSync(join(hdlRoot(this.config),'sessions')).map(name=>readSession(join(hdlRoot(this.config),'sessions',name))).filter(item=>!item.terminationConfirmed);
    if(occupied.length>=hdlLimits.sessions||occupied.some(item=>item.identity.scope.attemptId===request.identity.scope.attemptId))throw new RunnerError('RATE_LIMITED','HDL session quota occupied');
    mkdirSync(path,{mode:0o700});mkdirSync(join(path,'operations'),{mode:0o700});
    writeImmutable(join(path,'request.json'),envelope({program:request,build,artifact:join(buildPath,'artifact')}));
    const now=new Date().toISOString(),state:HdlSession={sessionId:request.identity.id,identity:request.identity,buildId:build.buildId,snapshotId:build.snapshotId,snapshotHash:build.snapshotHash,
      boardProfileVersion:build.board.boardProfileVersion,mappingVersion:build.board.mappingVersion,engineVersion:build.engineVersion,runtimeProfileVersion:build.runtimeProfileVersion,
      sessionRevision:1,confirmedSequence:0,simTimePs:'0',status:'starting',terminationConfirmed:false,stopRequested:false,createdAt:now,lastOperationAt:now,deadline:new Date(Date.now()+hdlLimits.lifetimeMs).toISOString()};
    writeImmutable(join(path,'initial-state.json'),envelope(state));saveSession(path,state);
    await this.launch('session',path,request.identity.id);return state;
  }
  private aluProbe(request:HdlAluProbe){
    const {identity,buildId,artifactHash,snapshotId,snapshotHash,configurationHash,binding}=request;
    validateAluProbe({identity,buildId,artifactHash,snapshotId,snapshotHash,configurationHash,binding});this.authorize(request.identity);
    const buildPath=hdlDirectory(this.config,'builds',request.buildId);
    if(!existsSync(buildPath))throw new RunnerError('FORBIDDEN','Original ALU Build unavailable');
    const original=readEnvelope(join(buildPath,'request.json')) as HdlBuildRequest;
    const build=this.build(original.identity);matchAluBuild(request,build,this.config.hdl);
    if(sha256(readFileSync(join(buildPath,'artifact','design.vvp')))!==request.artifactHash)throw new RunnerError('INVALID_REFERENCE','Immutable ALU artifact mismatch');
    const metadata=readIfPresent(join(buildPath,'elaboration.json'));
    if(!metadata||metadata.artifactHash!==request.artifactHash)throw new RunnerError('RUNTIME_NOT_READY','Current immutable ALU elaboration required');
    const bits=resolveAluBinding(request.binding,metadata.elaboration as AluElaboration);
    return {bindingVersionId:request.binding.versionId,bindingHash:aluBindingHash(request.binding),buildId:build.buildId,
      artifactHash:build.artifactHash,bits};
  }
  private async aluCheck(request:HdlAluCheck){
    validateAluCheck(request);this.authorize(request.identity);
    const path=hdlDirectory(this.config,'sessions',request.identity.id);
    if(existsSync(path)){
      const original=readEnvelope(join(path,'request.json')).check;
      if(!original)throw new RunnerError('IDEMPOTENCY_CONFLICT','Original check identity required');
      sameIdentity(original.identity,request.identity);
      if(JSON.stringify(original)!==JSON.stringify(request))throw new RunnerError('IDEMPOTENCY_CONFLICT','Original ALU check packet required');
      return this.aluResult(request.identity);
    }
    const runtime=this.config.hdl;
    if(['runtimeProfileVersion','engineVersion','buildImage','runtimeImage','sourceHash'].some(key=>
      request[key as keyof HdlAluCheck]!==runtime[key as keyof typeof runtime]))throw new RunnerError('RUNTIME_NOT_READY','Approved ALU engine/source required');
    const probed=this.aluProbe(request);
    const occupied=readdirSync(join(hdlRoot(this.config),'sessions')).map(name=>readSession(join(hdlRoot(this.config),'sessions',name))).filter(item=>!item.terminationConfirmed);
    if(occupied.length>=hdlLimits.sessions||occupied.some(item=>item.identity.scope.attemptId===request.identity.scope.attemptId))
      throw new RunnerError('RATE_LIMITED','Explicitly stop the student Session before ALU check');
    mkdirSync(path,{mode:0o700});mkdirSync(join(path,'operations'),{mode:0o700});
    writeImmutable(join(path,'request.json'),envelope({check:request,bits:probed.bits,artifact:join(hdlDirectory(this.config,'builds',request.buildId),'artifact')}));
    const built=this.build(readEnvelope(join(hdlDirectory(this.config,'builds',request.buildId),'request.json')).identity);
    const at=new Date().toISOString();const state:HdlSession={sessionId:request.identity.id,identity:request.identity,buildId:request.buildId,
      snapshotId:request.snapshotId,snapshotHash:request.snapshotHash,boardProfileVersion:built.board.boardProfileVersion,
      mappingVersion:built.board.mappingVersion,
      engineVersion:runtime.engineVersion,runtimeProfileVersion:runtime.runtimeProfileVersion,sessionRevision:1,confirmedSequence:0,simTimePs:'0',status:'starting',
      terminationConfirmed:false,stopRequested:false,createdAt:at,lastOperationAt:at,deadline:new Date(Date.now()+120000).toISOString()};
    writeImmutable(join(path,'initial-state.json'),envelope(state));saveSession(path,state);
    await this.launch('alu',path,request.identity.id);return this.aluResult(request.identity);
  }
  private aluResult(identity:HdlIdentity):HdlAluResult{
    const {path,state}=this.session(identity),request=readEnvelope(join(path,'request.json')).check as HdlAluCheck;
    if(!request)throw new RunnerError('INVALID_REFERENCE','Original ALU check required');validateAluCheck(request);sameIdentity(request.identity,identity);
    const result=readIfPresent(join(path,'check-result.json')) as HdlAluResult|undefined;
    if(result){const {resultHash,...body}=result;
      if(sha256(JSON.stringify(body))!==resultHash||JSON.stringify(body.identity)!==JSON.stringify(identity)
        ||body.buildId!==request.buildId||body.bindingHash!==request.bindingHash)throw new RunnerError('INVALID_REFERENCE','Original private check result hash required');
      if(JSON.stringify(aluPublicResult(request,result.status,result.coverage,result.terminationConfirmed,result.failureCategory))!==JSON.stringify(result))
        throw new RunnerError('INVALID_REFERENCE','Exact frozen ALU result binding required');
      if(result.status==='passed'&&(!result.terminationConfirmed||!result.coverage.complete||result.coverage.compared!==2800||result.coverage.sampled!==2800))
        throw new RunnerError('INVALID_REFERENCE','Complete ALU comparison required');
      if(!result.terminationConfirmed&&state.terminationConfirmed)return aluPublicResult(request,
        existsSync(join(path,'stop.intent'))?'cancelled':'incomplete',result.coverage,true,'worker_termination_barrier');return result;
    }
    return aluPublicResult(request,state.terminationConfirmed?(existsSync(join(path,'stop.intent'))?'cancelled':'incomplete'):
      state.status==='active'?'running':state.status==='outcome_unknown'?'outcome_unknown':'queued',emptyAluCoverage(),state.terminationConfirmed);
  }
  private rpc(path:string,packet:object):Promise<unknown>{
    return new Promise((resolve,reject)=>{const socket=connect(hdlSocket(readSession(path).sessionId));let body='';socket.setTimeout(125000,()=>socket.destroy(new Error('HDL response timed out')));
      socket.on('connect',()=>socket.write(JSON.stringify(packet)+'\n'));socket.on('data',bytes=>{body+=bytes.toString('utf8');if(Buffer.byteLength(body)>hdlLimits.packetBytes+8192)socket.destroy(new Error('HDL response too large'));});
      socket.on('error',()=>reject(new RunnerError('DEPENDENCY_UNAVAILABLE','Original session control unavailable')));
      socket.on('end',()=>{try{const value=JSON.parse(body);if(value.error)reject(new RunnerError(value.error.code,'Original session command rejected'));else resolve(value.data);}catch{reject(new RunnerError('DEPENDENCY_UNAVAILABLE','Session response unavailable'));}});
    });
  }
  private async stop(identity:HdlIdentity){
    const {path,state}=this.session(identity);if(state.terminationConfirmed)return state;
    if(!existsSync(join(path,'stop.intent')))writeImmutable(join(path,'stop.intent'),envelope({identity}));
    try{if(readEnvelope(join(path,'request.json')).check)throw new RunnerError('STATE_CONFLICT','Stop independent check worker');
      await this.rpc(path,{op:'stop',identity});}catch{
      await exec('/usr/bin/systemctl',['stop','xunjie-dlc-session-'+sha256(identity.id)],{timeout:15000,maxBuffer:65536});}
    const result=readSession(path);if(!result.terminationConfirmed)throw new RunnerError('DEPENDENCY_UNAVAILABLE','Original session termination unconfirmed');return result;
  }
  async pause(){this.paused=true;for(const name of readdirSync(join(hdlRoot(this.config),'sessions'))){const state=readSession(join(hdlRoot(this.config),'sessions',name));
    try{await this.stop(state.identity);}catch{/* Engine recovery barrier must reconcile uncertain instances. */}}
    for(const name of readdirSync(join(hdlRoot(this.config),'builds'))){const path=join(hdlRoot(this.config),'builds',name);
      if(readIfPresent(join(path,'outcome.json'))?.terminationConfirmed)continue;
      const identity=readEnvelope(join(path,'request.json')).identity;validateIdentity(identity);
      try{await exec('/usr/bin/systemctl',['stop','xunjie-dlc-build-'+sha256(identity.id)],{timeout:15000,maxBuffer:65536});}
      catch{/* Missing transient units after a reboot require the subsequent Engine/PID barrier. */}
    }
  }
  async generationBarrier(){await this.pause();
    for(const name of readdirSync(join(hdlRoot(this.config),'sessions')))if(!readSession(join(hdlRoot(this.config),'sessions',name)).terminationConfirmed)
      throw new RunnerError('DEPENDENCY_UNAVAILABLE','HDL generation barrier requires confirmed termination');
  }
  async afterEngineBarrier(){
    for(const name of readdirSync(join(hdlRoot(this.config),'builds'))){const path=join(hdlRoot(this.config),'builds',name),identity=readEnvelope(join(path,'request.json')).identity;validateIdentity(identity);
      const process=await exec('/usr/bin/systemctl',['show','xunjie-dlc-build-'+sha256(identity.id),'--property=MainPID','--value']);
      if(process.stdout.trim()!=='0')throw new RunnerError('DEPENDENCY_UNAVAILABLE','Original HDL build worker remains alive');
      if(!existsSync(join(path,'termination.json')))writeImmutable(join(path,'termination.json'),envelope({identity,unitTerminated:true,source:'engine_recovery_barrier'}));
    }
    for(const name of readdirSync(join(hdlRoot(this.config),'sessions'))){const path=join(hdlRoot(this.config),'sessions',name),state=readSession(path);
      const process=await exec('/usr/bin/systemctl',['show','xunjie-dlc-session-'+sha256(state.sessionId),'--property=MainPID','--value']);
      if(process.stdout.trim()!=='0')throw new RunnerError('DEPENDENCY_UNAVAILABLE','Original HDL worker remains alive');
      if(!state.terminationConfirmed)saveSession(path,{...state,status:'failed',stopRequested:true,terminationConfirmed:true,sessionRevision:state.sessionRevision+1,failureKind:'engine_recovery_barrier'});
    }this.paused=false;
  }
  async dispatch(command:HdlCommand,maintenance=false){
    fields(command,['op',...(['hdl_build','hdl_program','hdl_interact','hdl_alu_probe','hdl_alu_check'].includes(command.op)?['request']:command.op==='hdl_readiness'?[]:['identity',...(command.op==='hdl_result'?['operationId']:[])])]);
    if(command.op==='hdl_readiness')return this.readiness();
    if(command.op==='hdl_query'){
      this.authorize(command.identity);if(!existsSync(hdlDirectory(this.config,'sessions',command.identity.id)))return this.build(command.identity);
      const state=this.session(command.identity).state;
      if(readEnvelope(join(hdlDirectory(this.config,'sessions',command.identity.id),'request.json')).check)return this.aluResult(command.identity);
      if(!state.terminationConfirmed){const process=await exec('/usr/bin/systemctl',['show','xunjie-dlc-session-'+sha256(state.sessionId),'--property=MainPID','--value']);
        if(process.stdout.trim()==='0')return {...state,status:'outcome_unknown',stopRequested:true,failureKind:'original_worker_unavailable'};
      }return state;
    }
    if(command.op==='hdl_alu_result')return this.aluResult(command.identity);
    if(command.op==='hdl_result'){const {path,state}=this.session(command.identity);
      if(readEnvelope(join(path,'request.json')).check)throw new RunnerError('FORBIDDEN','ALU check has no public signal trace');
      const resultPath=command.operationId===state.sessionId?join(path,'initial.json'):join(path,'operations',sha256(command.operationId),'result.json');return readIfPresent(resultPath)??null;}
    if(command.op==='hdl_stop'){
      if(existsSync(hdlDirectory(this.config,'sessions',command.identity.id)))return this.stop(command.identity);
      this.build(command.identity);const path=hdlDirectory(this.config,'builds',command.identity.id);
      if(!existsSync(join(path,'stop.intent')))writeImmutable(join(path,'stop.intent'),envelope({identity:command.identity}));
      await exec('/usr/bin/systemctl',['stop','xunjie-dlc-build-'+sha256(command.identity.id)],{timeout:15000,maxBuffer:65536});return this.build(command.identity);
    }
    if(this.paused)throw new RunnerError('RUNTIME_NOT_READY','HDL dispatch paused');
    if(!maintenance&&!(await this.readiness()).ready)throw new RunnerError('RUNTIME_NOT_READY','Current HDL validation required');
    if(command.op==='hdl_alu_probe'){validateAluProbe(command.request);const probe=this.aluProbe(command.request);return {bindingVersionId:probe.bindingVersionId,bindingHash:probe.bindingHash,
      buildId:probe.buildId,artifactHash:probe.artifactHash,validated:true};}
    if(command.op==='hdl_alu_check')return this.aluCheck(command.request);
    if(command.op==='hdl_build')return this.submit(command.request);
    if(command.op==='hdl_program')return this.program(command.request);
    if(command.op!=='hdl_interact')throw new RunnerError('INVALID_REQUEST','Unknown HDL command');
    validateOperation(command.request);this.authorize(command.request.identity);
    const path=hdlDirectory(this.config,'sessions',command.request.sessionId),state=readSession(path);
    if(JSON.stringify(state.identity.scope)!==JSON.stringify(command.request.identity.scope))throw new RunnerError('FORBIDDEN','Original session scope required');
    return this.rpc(path,{op:'interact',request:command.request});
  }
}
