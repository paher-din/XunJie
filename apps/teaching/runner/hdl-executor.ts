import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdirSync,writeFileSync,readFileSync,chmodSync,statSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {DockerExecutor} from './docker.ts';
import {RunnerError,sha256,validatePath} from './snapshot.ts';
import {boardWrapper,configurationHash,hdlLimits,validateBuildRequest} from './hdl-profile.ts';
import type {HdlPort} from './hdl-profile.ts';
import type {HdlBuildRequest,HdlBuild,HdlRuntime,HdlInputs,SignalFrame} from '../contracts/runner/hdl.ts';
import type {AluElaboration} from './alu-check.ts';
import {envelope,writeImmutable} from './node-files.ts';

const exec=promisify(execFile);
export type HdlNodeConfig={node:string;source:string;state:string;generation:string;dockerBinary:string;dockerSocket:string;cliConfig:string;hdl:HdlRuntime};
export const hdlExecutor=(config:HdlNodeConfig)=>new DockerExecutor(config.dockerBinary,config.dockerSocket,config.cliConfig);
export function containerArgs(name:string,image:string,source:string,work:string,session=false):string[]{
  if(!/^xunjie-dlc-[a-z0-9-]+$/.test(name)||!/^sha256:[a-f0-9]{64}$/.test(image))throw new RunnerError('INVALID_CONFIGURATION','Fixed HDL image required');
  return ['create','--name',name,'--label','xunjie.dlc=true','--cpus=0.5','--cpu-shares=256',`--memory=${session?'256':'512'}m`,
    `--memory-swap=${session?'256':'512'}m`,`--pids-limit=${session?'32':'64'}`,'--read-only','--user=65534:65534',
    '--network=none','--cap-drop=ALL','--security-opt=no-new-privileges','--security-opt=apparmor=xunjie-dlc-v1','--ipc=private','--log-driver=none',
    '--mount',`type=bind,src=${source},dst=${session?'/build':'/snapshot'},readonly,bind-propagation=rprivate,bind-recursive=readonly`,
    '--mount',`type=bind,src=${work},dst=/work`,
    '--mount',`type=bind,src=${work},dst=/tmp`,
    '--mount',`type=bind,src=${work},dst=/dev/shm`,
    '--workdir=/work','--env=TMPDIR=/work','--env=LANG=C','--env=LC_ALL=C',...(session?['--interactive']:[]),image];
}
export async function temporaryWork(path:string,bytes:number){
  mkdirSync(path,{recursive:true,mode:0o700});
  await exec('/usr/bin/mount',['-t','tmpfs','-o',`size=${bytes},uid=65534,gid=65534,mode=0700,nosuid,nodev,noexec`,'tmpfs',path]);
}
export async function runBounded(executor:DockerExecutor,name:string,args:string[],timeoutMs:number,recordUnit:(name:string,container?:string)=>void,outputBudget=hdlLimits.logBytes){
  recordUnit(name);const container=await executor.command(args);if(!/^[a-f0-9]{64}$/.test(container))throw new RunnerError('DEPENDENCY_UNAVAILABLE','HDL container unconfirmed');
  recordUnit(name,container);
  const chunks:Buffer[]=[],errors:Buffer[]=[];let bytes=0,failure:string|undefined,stopping=false;
  const stop=()=>{stopping=true;void executor.stop(container);};
  const child=spawn(executor.binary,[`--host=unix://${executor.socket}`,'start','--attach',container],{env:{PATH:'/usr/bin:/bin',DOCKER_CONFIG:executor.configDirectory},stdio:['ignore','pipe','pipe']});
  for(const [stream,list] of [[child.stdout,chunks],[child.stderr,errors]] as const)stream.on('data',(chunk:Buffer)=>{
    const left=Math.max(0,outputBudget-bytes);list.push(Buffer.from(chunk.subarray(0,left)));bytes+=chunk.length;
    if(bytes>outputBudget){failure??='output_limit';stop();}});
  const timer=setTimeout(()=>{failure??='timeout';stop();},timeoutMs);
  const retry=setInterval(()=>{if(stopping)void executor.stop(container);},100);
  try{await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',()=>resolve());});
    const info=await executor.inspect(container);if(info.State.OOMKilled)failure??='oom';
    const terminated=!info.State.Running&&info.State.Status==='exited'&&!info.State.FinishedAt.startsWith('0001-');
    if(!terminated)failure??='infrastructure_error';
    return {exitCode:info.State.ExitCode,stdout:Buffer.concat(chunks).toString('utf8'),stderr:Buffer.concat(errors).toString('utf8'),failure,terminated};
  }finally{clearTimeout(timer);clearInterval(retry);}
}
export async function buildHdl(config:HdlNodeConfig,request:HdlBuildRequest,path:string,recordUnit:(name:string,container?:string)=>void):Promise<HdlBuild>{
  validateBuildRequest(request);const executor=hdlExecutor(config);
  if(request.runtimeProfileVersion!==config.hdl.runtimeProfileVersion)throw new RunnerError('RUNTIME_NOT_READY','Approved HDL profile mismatch');
  const source=join(path,'snapshot'),work=join(path,'work');mkdirSync(source,{recursive:true,mode:0o755});
  for(const file of request.snapshot.files){const target=join(source,file.path);mkdirSync(dirname(target),{recursive:true,mode:0o755});writeFileSync(target,file.text,{flag:'wx',mode:0o444});}
  await temporaryWork(work,128*1024*1024);let stdout='',stderr='',failure:string|undefined,terminated=true,artifactHash:string|undefined;
  const started=performance.now(),files=request.snapshot.files.filter(file=>/\.(sv|v)$/.test(file.path)).map(file=>'/snapshot/'+file.path).sort();
  const base=containerArgs('xunjie-dlc-build-'+sha256(request.identity.id)+'-ports',config.hdl.buildImage,source,work);
  // The image's shell only runs this fixed platform script; the student provides source files, never arguments.
  const compile=async(suffix:string,argv:string[])=>{
    const args=[...base];args[args.indexOf('--name')+1]='xunjie-dlc-build-'+sha256(request.identity.id)+'-'+suffix;
    args.splice(args.length-1,0,'--entrypoint','/usr/bin/iverilog');args.push(...argv);
    const result=await runBounded(executor,args[args.indexOf('--name')+1]!,args,Math.max(1,hdlLimits.buildMs-(performance.now()-started)),recordUnit,
      Math.max(0,hdlLimits.logBytes-Buffer.byteLength(stdout)-Buffer.byteLength(stderr)));
    stdout+=result.stdout;stderr+=result.stderr;terminated&&=result.terminated;
    failure??=result.failure??(result.exitCode!==0?'compile_error':undefined);return !failure;
  };
  try{
    if(await compile('ports',['-g2012','-gno-std-include','-I/snapshot','-s',request.board.topModule,'-pXUNJIE_HIERARCHY=1','-txunjie_ports','-Mprefix=/work/deps.txt','-o','/work/ports.json',...files])){
      const dependencies=readFileSync(join(work,'deps.txt'),'utf8').trim().split('\n').map(line=>line.replace(/^[IM] /,''));
      for(const dependency of dependencies){if(!dependency.startsWith('/snapshot/'))throw new RunnerError('INVALID_REFERENCE','External HDL include rejected');
        const relative=dependency.slice(10);validatePath(relative);if(!request.snapshot.files.some(file=>file.path===relative))throw new RunnerError('INVALID_REFERENCE','Include is outside the confirmed snapshot');}
      if(statSync(join(work,'ports.json')).size>hdlLimits.traceBytes)throw new RunnerError('CONTENT_LIMIT','Elaboration metadata capacity exceeded');
      const metadata=JSON.parse(readFileSync(join(work,'ports.json'),'utf8')) as HdlPort[]|{ports:HdlPort[];elaboration:AluElaboration};
      const ports=Array.isArray(metadata)?metadata:metadata.ports;
      if(!Array.isArray(ports))throw new RunnerError('INVALID_CONFIGURATION','Elaborated ports unavailable');
      writeFileSync(join(work,'board.sv'),boardWrapper(request.board,ports),{flag:'wx',mode:0o444});
      if(await compile('compile',['-g2012','-gno-std-include','-I/snapshot','-s','xunjie_board','-o','/work/design.vvp','/work/board.sv',...files])){
        const artifact=readFileSync(join(work,'design.vvp'));artifactHash=sha256(artifact);
        mkdirSync(join(path,'artifact'),{mode:0o755});writeFileSync(join(path,'artifact','design.vvp'),artifact,{flag:'wx',mode:0o444});
        if(!Array.isArray(metadata))writeImmutable(join(path,'elaboration.json'),envelope({artifactHash,elaboration:metadata.elaboration}));
        chmodSync(join(path,'artifact'),0o755);
      }
    }
  }catch(error){if(!(error instanceof RunnerError))console.error('HDL maintenance infrastructure error code:',(error as NodeJS.ErrnoException).code??'unknown');
    failure=error instanceof RunnerError?error.code:'infrastructure_error';stderr+='\n'+(error instanceof RunnerError?error.message:'HDL build metadata unavailable');}
  const diagnostics=stderr.split('\n').filter(Boolean).slice(0,100).map(message=>{
    const location=message.match(/^\/snapshot\/(.+?):(\d+):\s*(.*)$/),file=location?request.snapshot.files.find(item=>item.path===location[1]):undefined;
    return {severity:message.includes('warning:')?'warning' as const:'error' as const,message:message.replaceAll(source,'/snapshot'),
      ...(file&&location?{fileId:file.fileId,path:file.path,line:Number(location[2]),location:'line-only' as const}:{location:'unavailable' as const})};});
  if(failure==='infrastructure_error'){stdout='';stderr='HDL execution infrastructure unavailable.';diagnostics.splice(0,diagnostics.length,{severity:'error',message:stderr,location:'unavailable'});}
  return {buildId:request.identity.id,identity:request.identity,snapshotId:request.snapshot.snapshotId,snapshotHash:request.snapshot.hash,board:request.board,
    runtimeProfileVersion:config.hdl.runtimeProfileVersion,engineVersion:config.hdl.engineVersion,imageDigest:config.hdl.buildImage,
    configurationHash:configurationHash(request.board),status:artifactHash&&terminated?'succeeded':terminated?'failed':'outcome_unknown',terminationConfirmed:terminated,
    ...(artifactHash?{artifactHash}:{}),diagnostics,stdout,stderr,...(failure?{failureKind:failure}:{})};
}
export type FrameBatch={frames:SignalFrame[];finalFrame:SignalFrame;sampleCount:number;droppedFrames:number};
export function parseFrame(line:string):SignalFrame{
  const fields=line.split('\t');if(fields.length!==9||fields[0]!=='F'||!/^\d+$/.test(fields[1]!))throw new RunnerError('INVALID_REFERENCE','Malformed VPI frame');
  const names=['switches','buttons','resetN','leds','anodes','segments','dp'] as const,widths=[16,5,1,16,8,7,1];
  const frame={simTimePs:fields[1]} as SignalFrame;
  for(let i=0;i<names.length;i++){if(!new RegExp(`^[01xz]{${widths[i]}}$`).test(fields[i+2]!))throw new RunnerError('INVALID_REFERENCE','Invalid four-value signal');frame[names[i]!]=fields[i+2]!;}
  return frame;
}
export function attachSimulation(executor:DockerExecutor,container:string,onFailure:(reason:string)=>void,onLog:(bytes:Buffer)=>void=()=>{}){
  const child=spawn(executor.binary,[`--host=unix://${executor.socket}`,'start','--attach','--interactive',container],{
    env:{PATH:'/usr/bin:/bin',DOCKER_CONFIG:executor.configDirectory},stdio:['pipe','pipe','pipe']});
  let text='',bytes=0,logBytes=0,frames:SignalFrame[]=[],waiting:{resolve:(value:FrameBatch)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}|undefined;
  let available:FrameBatch|undefined,dead:Error|undefined;
  const fail=(reason:string)=>{dead=new RunnerError('DEPENDENCY_UNAVAILABLE',reason);onFailure(reason);if(waiting){clearTimeout(waiting.timer);waiting.reject(dead);waiting=undefined;}};
  child.stderr.on('data',(chunk:Buffer)=>{onLog(chunk.subarray(0,Math.max(0,hdlLimits.logBytes-logBytes)));logBytes+=chunk.length;if(logBytes>hdlLimits.logBytes)fail('output_limit');});
  child.stdin.on('error',()=>fail('engine_exit'));child.once('error',()=>fail('infrastructure_error'));child.once('close',()=>fail('engine_exit'));
  child.stdout.on('data',(chunk:Buffer)=>{try{bytes+=chunk.length;if(bytes>hdlLimits.packetBytes)throw new Error('protocol_limit');text+=chunk.toString('utf8');
    while(text.includes('\n')){const end=text.indexOf('\n'),line=text.slice(0,end);text=text.slice(end+1);
      if(line.startsWith('F\t')){const frame=parseFrame(line);if(frames.length>=hdlLimits.frames||frames.length&&BigInt(frame.simTimePs)<BigInt(frames.at(-1)!.simTimePs))throw new Error('invalid_signal_time');frames.push(frame);}
      else {const fields=line.split('\t');if(fields.length!==4||fields[0]!=='D'||fields.slice(1).some(value=>!/^\d+$/.test(value))||!frames.length||Number(fields[2])!==frames.length)throw new Error('invalid_protocol');
        const batch={frames,finalFrame:frames.at(-1)!,sampleCount:Number(fields[1]),droppedFrames:Number(fields[3])};frames=[];bytes=0;
        if(waiting){clearTimeout(waiting.timer);waiting.resolve(batch);waiting=undefined;}else if(available)throw new Error('unsolicited_frame');else available=batch;}
    }}catch(error){fail(error instanceof Error?error.message:'invalid_protocol');}});
  const receive=(timeoutMs:number)=>new Promise<FrameBatch>((resolve,reject)=>{
    if(dead){reject(dead);return;}if(available){const value=available;available=undefined;resolve(value);return;}
    if(waiting){reject(new RunnerError('STATE_CONFLICT','One VPI request at a time'));return;}
    waiting={resolve,reject,timer:setTimeout(()=>fail('timeout'),timeoutMs)};
  });
  return {async initial(){
      const started=performance.now();
      while(performance.now()-started<30000){
        if(dead)throw dead;
        const state=(await executor.inspect(container)).State;if(state.Running)return receive(hdlLimits.stepMs);
        if(state.Status==='exited')throw new RunnerError('DEPENDENCY_UNAVAILABLE','Engine exited during startup');
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      fail('startup_timeout');throw new RunnerError('DEPENDENCY_UNAVAILABLE','Engine did not start');
    },step(inputs:HdlInputs,cycles:number){const result=receive(hdlLimits.stepMs);child.stdin.write(`${cycles} ${inputs.switches} ${inputs.buttons} ${inputs.resetN}\n`);return result;},
    close(){child.stdin.end();},child};
}
