import {spawn} from 'node:child_process';
import type {DockerExecutor} from './docker.ts';
import {RunnerError} from './snapshot.ts';
import {hdlLimits} from './hdl-profile.ts';
import type {AluSample} from '../contracts/runner/alu.ts';
import type {HdlInputs} from '../contracts/runner/hdl.ts';
import type {ResolvedAluBit} from './alu-check.ts';

export class AluProtocol {
  text='';bytes=0;rows:AluSample[]=[];mode:'initial'|'binding'|'batch'='initial';start=0;count=0;
  configure(start:number,count:number){this.mode='batch';this.start=start;this.count=count;}
  push(chunk:Buffer):('initial'|'binding'|AluSample[])[]{
    this.bytes+=chunk.length;if(this.bytes>hdlLimits.packetBytes)throw new RunnerError('CONTENT_LIMIT','Private ALU packet capacity exceeded');
    this.text+=chunk.toString('utf8');const completed:('initial'|'binding'|AluSample[])[]=[];
    while(this.text.includes('\n')){
      const end=this.text.indexOf('\n'),line=this.text.slice(0,end);this.text=this.text.slice(end+1);const f=line.split('\t');
      if(this.mode==='initial'&&f[0]==='F')continue;
      if(this.mode==='initial'&&/^D\t1\t1\t0$/.test(line)){completed.push('initial');this.bytes=0;continue;}
      if(this.mode==='binding'&&line==='C\t17'){completed.push('binding');this.bytes=0;continue;}
      if(this.mode==='batch'&&f[0]==='A'&&f.length===4&&/^\d+$/.test(f[1]!)&&/^\d{1,32}$/.test(f[2]!)&&/^[01xz]{17}$/.test(f[3]!)){
        if(this.rows.length>=this.count*3)throw new RunnerError('INVALID_REFERENCE','Excess private ALU sample');
        const index=this.start+Math.floor(this.rows.length/3),phase=this.rows.length%3;
        if(Number(f[1])!==index||f[2]!==String((index*4+phase+2)*10000))throw new RunnerError('INVALID_REFERENCE','Private ALU sample time/index mismatch');
        this.rows.push({index,simTimePs:f[2]!,bits:f[3]!});continue;
      }
      if(this.mode==='batch'&&line===`E\t${this.count*3}\t${(this.start+this.count)*40000}`&&this.rows.length===this.count*3){
        completed.push(this.rows);this.rows=[];this.bytes=0;continue;
      }
      throw new RunnerError('INVALID_REFERENCE','Restricted ALU protocol rejected');
    }return completed;
  }
}
export function attachAluSimulation(executor:DockerExecutor,container:string,onFailure:(reason:string)=>void){
  const child=spawn(executor.binary,[`--host=unix://${executor.socket}`,'start','--attach','--interactive',container],{
    env:{PATH:'/usr/bin:/bin',DOCKER_CONFIG:executor.configDirectory},stdio:['pipe','pipe','pipe']});
  const protocol=new AluProtocol();let available:'initial'|'binding'|AluSample[]|undefined,dead:Error|undefined,logBytes=0;
  let waiting:{resolve:(value:'initial'|'binding'|AluSample[])=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}|undefined;
  const fail=(reason:string)=>{dead=new RunnerError('DEPENDENCY_UNAVAILABLE',reason);onFailure(reason);
    if(waiting){clearTimeout(waiting.timer);waiting.reject(dead);waiting=undefined;}};
  child.stdout.on('data',(chunk:Buffer)=>{try{
    for(const value of protocol.push(chunk)){
      if(waiting){clearTimeout(waiting.timer);waiting.resolve(value);waiting=undefined;}
      else if(available!==undefined)throw new Error('unsolicited_alu_packet');else available=value;
    }
  }catch{fail('invalid_alu_protocol');}});
  child.stderr.on('data',(chunk:Buffer)=>{logBytes+=chunk.length;if(logBytes>hdlLimits.logBytes)fail('output_limit');});
  child.stdin.on('error',()=>fail('engine_exit'));child.once('error',()=>fail('infrastructure_error'));child.once('close',()=>fail('engine_exit'));
  const receive=(ms:number)=>new Promise<'initial'|'binding'|AluSample[]>((resolve,reject)=>{
    if(dead)return reject(dead);if(available!==undefined){const value=available;available=undefined;resolve(value);return;}
    if(waiting)return reject(new RunnerError('STATE_CONFLICT','One private ALU request at a time'));
    waiting={resolve,reject,timer:setTimeout(()=>fail('timeout'),Math.max(1,ms))};
  });
  return {child,
    async initial(remainingMs=30000){
      const started=performance.now();
      while(performance.now()-started<Math.min(30000,remainingMs)){
        if(dead)throw dead;
        const state=(await executor.inspect(container)).State;
        if(state.Running){if(await receive(Math.min(hdlLimits.stepMs,Math.max(1,remainingMs-(performance.now()-started))))!=='initial')
          throw new RunnerError('INVALID_REFERENCE','Original ALU initialization required');return;}
        if(state.Status==='exited')throw new RunnerError('DEPENDENCY_UNAVAILABLE','ALU engine exited during startup');
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      fail('timeout');throw new RunnerError('DEPENDENCY_UNAVAILABLE','ALU engine startup deadline');
    },
    async bind(bits:ResolvedAluBit[]){
      if(bits.length!==17)throw new RunnerError('INVALID_CONFIGURATION','17 semantic ALU bits required');
      protocol.mode='binding';const result=receive(hdlLimits.stepMs);
      child.stdin.write('B 17 '+bits.map(bit=>`${bit.path} ${bit.offset} ${bit.width}`).join(' ')+'\n');
      if(await result!=='binding')throw new RunnerError('INVALID_REFERENCE','ALU binding acknowledgement required');
    },
    async batch(start:number,inputs:HdlInputs[],remainingMs:number){
      protocol.configure(start,inputs.length);const result=receive(Math.min(hdlLimits.stepMs,remainingMs));
      child.stdin.write(`P ${start} ${inputs.length} ${inputs.map(value=>value.switches).join(' ')}\n`);
      const value=await result;if(!Array.isArray(value))throw new RunnerError('INVALID_REFERENCE','Private ALU samples required');return value;
    },close(){child.stdin.end();},
  };
}
