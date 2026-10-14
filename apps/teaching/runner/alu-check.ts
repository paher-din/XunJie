import type { AluBinding,AluCoverage,AluSample,AluSemantic,AluStatus,HdlAluCheck,HdlAluProbe,HdlAluResult } from '../contracts/runner/alu.ts';
import type { HdlBuild,HdlInputs,HdlRuntime } from '../contracts/runner/hdl.ts';
import { fields,id,identifier,natural,validateIdentity,configurationHash,type HdlPort,hdlLimits } from './hdl-profile.ts';
import { RunnerError,sha256 } from './snapshot.ts';

export const aluVersions={rule:'hdl-alu-behavior-v1',validator:'hdl-alu-validator-v1',sampling:'alu-lowphase-3samples-v1',
  vectorSetHash:'e3903faa6a66e72355bfd62435caad5f53688327ff070b8e57b3992b04760ca1'} as const;
const widths:Record<AluSemantic,number>={A:4,B:4,Cin:1,M:1,S:2,F:4,Cout:1};
const semantics=Object.keys(widths) as AluSemantic[];
type Vector={m:number;s:number;a:number;b:number;cin:number};
export type AluElaboration={complete:boolean;instances:{instanceSegments:string[];ports:HdlPort[]}[]};
export type ResolvedAluBit={path:string;index:number;offset:number;width:number};
function hash(value:unknown){if(typeof value!=='string'||! /^[a-f0-9]{64}$/.test(value))throw new RunnerError('INVALID_REFERENCE','Immutable ALU hash required');}
export function validateAluBinding(value:unknown):asserts value is AluBinding{
  fields(value,['versionId','references','switchMapping']);id(value.versionId);fields(value.references,semantics);
  const selected=new Set<string>();let instance:string|undefined;
  for(const semantic of semantics){
    const refs=value.references[semantic];if(!Array.isArray(refs)||!refs.length||refs.length>(semantic==='S'?2:1))throw new RunnerError('INVALID_CONFIGURATION','Restricted ALU references required');
    let width=0;
    for(const ref of refs){fields(ref,['instanceSegments','signal','offset','width']);identifier(ref.signal);natural(ref.offset,0,127);natural(ref.width,1,4);
      if(!Array.isArray(ref.instanceSegments)||ref.instanceSegments.length>16)throw new RunnerError('INVALID_CONFIGURATION','Restricted ALU instance required');
      ref.instanceSegments.forEach(identifier);if(ref.instanceSegments.join('.').length+ref.signal.length+18>1024)throw new RunnerError('INVALID_CONFIGURATION','ALU reference too long');
      const path=JSON.stringify(ref.instanceSegments);if(instance!==undefined&&instance!==path)throw new RunnerError('INVALID_CONFIGURATION','One ALU instance required');instance=path;
      for(let bit=ref.offset;bit<ref.offset+ref.width;bit++){const key=path+':'+ref.signal+':'+bit;
        if(selected.has(key))throw new RunnerError('INVALID_CONFIGURATION','Aliased ALU bits rejected');selected.add(key);}
      width+=ref.width;
    }
    if(width!==widths[semantic])throw new RunnerError('INVALID_CONFIGURATION','ALU semantic width mismatch');
  }
  if(!Array.isArray(value.switchMapping)||value.switchMapping.length!==5)throw new RunnerError('INVALID_CONFIGURATION','Approved switch mapping required');
  const used=new Set<number>(),seen=new Set<string>(),mappingWidths={operand_a:4,operand_b:4,carry_in:1,mode:1,select:2};
  for(const item of value.switchMapping){fields(item,['semantic','offset','width']);
    if(typeof item.semantic!=='string'||!Object.hasOwn(mappingWidths,item.semantic)||seen.has(item.semantic))throw new RunnerError('INVALID_CONFIGURATION','Unique switch semantic required');
    natural(item.offset,0,15);natural(item.width,1,4);
    if(item.width!==mappingWidths[item.semantic as keyof typeof mappingWidths]||item.offset+item.width>16)throw new RunnerError('INVALID_CONFIGURATION','Switch width mismatch');
    for(let bit=item.offset;bit<item.offset+item.width;bit++){if(used.has(bit))throw new RunnerError('INVALID_CONFIGURATION','Switch overlap rejected');used.add(bit);}seen.add(item.semantic);
  }
}
export function aluBindingHash(binding:AluBinding){validateAluBinding(binding);
  return sha256(JSON.stringify({versionId:binding.versionId,references:Object.fromEntries(semantics.map(name=>[name,binding.references[name].map(ref=>({instanceSegments:ref.instanceSegments,signal:ref.signal,offset:ref.offset,width:ref.width}))])),
    switchMapping:[...binding.switchMapping].sort((a,b)=>a.semantic.localeCompare(b.semantic)).map(item=>({semantic:item.semantic,offset:item.offset,width:item.width}))}));
}
export function resolveAluBinding(binding:AluBinding,elaboration:AluElaboration):ResolvedAluBit[]{
  validateAluBinding(binding);
  if(!elaboration?.complete||!Array.isArray(elaboration.instances)||elaboration.instances.length>512)throw new RunnerError('RUNTIME_NOT_READY','Complete ALU elaboration required');
  const bits:ResolvedAluBit[]=[];
  for(const semantic of semantics){const logical:ResolvedAluBit[]=[];
    for(const ref of binding.references[semantic]){
      const matches=elaboration.instances.filter(value=>JSON.stringify(value.instanceSegments)===JSON.stringify(ref.instanceSegments));
      if(matches.length!==1||!Array.isArray(matches[0]!.ports))throw new RunnerError('INVALID_CONFIGURATION','Elaborated ALU instance unavailable');
      const ports=matches[0]!.ports.filter(port=>port.name===ref.signal),port=ports[0];
      if(ports.length!==1||!port||port.direction!==(semantic==='F'||semantic==='Cout'?'output':'input')
        ||!Number.isSafeInteger(port.left)||!Number.isSafeInteger(port.right)||Math.abs(port.left-port.right)+1!==port.width
        ||port.width!==ref.width||ref.offset+ref.width>port.width)throw new RunnerError('INVALID_CONFIGURATION','Elaborated ALU port mismatch');
      for(let i=0;i<ref.width;i++)logical.push({path:['xunjie_board','dut',...ref.instanceSegments,ref.signal].join('.'),index:port.right+(port.left>=port.right?1:-1)*(ref.offset+i),offset:ref.offset+i,width:port.width});
    }
    bits.push(...logical.reverse());
  }
  return bits;
}
export function validateAluProbe(value:unknown):asserts value is HdlAluProbe{
  fields(value,['identity','buildId','artifactHash','snapshotId','snapshotHash','configurationHash','binding']);validateIdentity(value.identity);
  id(value.buildId);id(value.snapshotId);hash(value.artifactHash);hash(value.snapshotHash);hash(value.configurationHash);validateAluBinding(value.binding);
}
export function validateAluCheck(value:unknown):asserts value is HdlAluCheck{
  fields(value,['identity','buildId','artifactHash','snapshotId','snapshotHash','configurationHash','binding','bindingHash','ruleVersionId','validatorVersion',
    'vectorSetHash','samplingProfileVersion','runtimeProfileVersion','engineVersion','buildImage','runtimeImage','sourceHash']);
  const {bindingHash,ruleVersionId,validatorVersion,vectorSetHash,samplingProfileVersion,runtimeProfileVersion,engineVersion,buildImage,runtimeImage,sourceHash,...probe}=value;
  validateAluProbe(probe);hash(bindingHash);hash(sourceHash);id(runtimeProfileVersion);id(engineVersion);
  if(bindingHash!==aluBindingHash(probe.binding)||ruleVersionId!==aluVersions.rule||validatorVersion!==aluVersions.validator||vectorSetHash!==aluVersions.vectorSetHash
    ||samplingProfileVersion!==aluVersions.sampling||typeof buildImage!=='string'||!/^sha256:[a-f0-9]{64}$/.test(buildImage)
    ||typeof runtimeImage!=='string'||!/^sha256:[a-f0-9]{64}$/.test(runtimeImage))throw new RunnerError('INVALID_CONFIGURATION','Fixed ALU validation versions required');
}
export function matchAluBuild(request:HdlAluProbe,build:HdlBuild,runtime:HdlRuntime){
  if(build.status!=='succeeded'||!build.terminationConfirmed||build.buildId!==request.buildId||build.artifactHash!==request.artifactHash
    ||build.snapshotId!==request.snapshotId||build.snapshotHash!==request.snapshotHash||configurationHash(build.board)!==request.configurationHash
    ||JSON.stringify(build.identity.scope)!==JSON.stringify(request.identity.scope)||build.identity.recoveryGeneration!==request.identity.recoveryGeneration
    ||build.runtimeProfileVersion!==runtime.runtimeProfileVersion||build.engineVersion!==runtime.engineVersion||build.imageDigest!==runtime.buildImage)
    throw new RunnerError('INVALID_REFERENCE','Original successful same-scope ALU Build required');
}
function vectors():Vector[]{const result:Vector[]=[];
  for(let m=0;m<2;m++)for(let s=0;s<4;s++)for(let a=0;a<16;a++)for(let b=0;b<16;b++)for(let cin=0;cin<2;cin++)
    if(m===0||s===0||s===1&&a>b)result.push({m,s,a,b,cin});return result;
}
export const aluVectors=vectors();
if(aluVectors.length!==2800||sha256(JSON.stringify(aluVectors.map(v=>[v.m,v.s,v.a,v.b,v.cin])))!==aluVersions.vectorSetHash)
  throw new RunnerError('INVALID_CONFIGURATION','ALU vector domain fingerprint changed');
export function aluInputs(binding:AluBinding,vector:Vector):HdlInputs{
  const values={operand_a:vector.a,operand_b:vector.b,carry_in:vector.cin,mode:vector.m,select:vector.s};let switches=0;
  for(const item of binding.switchMapping)switches|=values[item.semantic]<<item.offset;
  return {switches:switches.toString(2).padStart(16,'0'),buttons:'00000',resetN:'1'};
}
function expected(v:Vector){const full=v.m===0?[~v.a,v.a&v.b,v.a|v.b,v.a^v.b][v.s]!:
  v.s===0?v.a+v.b+v.cin:v.a-v.b-v.cin;return {f:full&15,cout:v.m===1&&v.s===0?(full>>4)&1:undefined};}
export const emptyAluCoverage=():AluCoverage=>({expected:2800,sampled:0,compared:0,excluded:1296,complete:false});
export function compareAluSamples(rows:AluSample[],startIndex:number,count:number){
  natural(startIndex,0,2799);natural(count,1,32);if(startIndex+count>2800||rows.length!==count*3)throw new RunnerError('INVALID_REFERENCE','Three complete stable ALU samples per vector required');
  const failures:{index:number;category:string}[]=[];let compared=0;
  for(let i=0;i<count;i++){
    const index=startIndex+i,v=aluVectors[index]!,samples=rows.slice(i*3,i*3+3),want=expected(v);
    for(let phase=0;phase<3;phase++){const row=samples[phase]!;
      if(row.index!==index||row.simTimePs!==(BigInt(index*4+phase+2)*10000n).toString()||! /^[01xz]{17}$/.test(row.bits))
        throw new RunnerError('INVALID_REFERENCE','Original low-phase ALU sample required');
    }
    const wantedInputs=v.a.toString(2).padStart(4,'0')+v.b.toString(2).padStart(4,'0')+v.cin+v.m+v.s.toString(2).padStart(2,'0');
    if(samples.some(row=>row.bits.slice(0,12)!==wantedInputs)){failures.push({index,category:'input_mismatch'});continue;}
    const outputs=samples.map(row=>row.bits.slice(12,16)+(want.cout===undefined?'':row.bits[16]));
    if(outputs.some(bits=>/[xz]/.test(bits))){compared++;failures.push({index,category:'graded_unknown'});continue;}
    if(outputs.some(bits=>bits!==outputs[0])){failures.push({index,category:'unstable'});continue;}
    compared++;if(Number.parseInt(outputs[0]!.slice(0,4),2)!==want.f||want.cout!==undefined&&Number(outputs[0]![4])!==want.cout)
      failures.push({index,category:'behavior_mismatch'});
  }
  return {compared,failures};
}
export function aluPublicResult(request:HdlAluCheck,status:AluStatus,coverage:AluCoverage,terminationConfirmed:boolean,failureCategory?:string):HdlAluResult{
  if(!['queued','running','passed','failed','incomplete','outcome_unknown','cancelled'].includes(status)||typeof terminationConfirmed!=='boolean')
    throw new RunnerError('INVALID_REFERENCE','Approved ALU result status required');
  fields(coverage,['expected','sampled','compared','excluded','complete']);natural(coverage.sampled,0,2800);natural(coverage.compared,0,coverage.sampled);
  if(coverage.expected!==2800||coverage.excluded!==1296||typeof coverage.complete!=='boolean'
    ||coverage.complete!==(coverage.sampled===2800&&coverage.compared===2800))throw new RunnerError('INVALID_REFERENCE','Actual ALU coverage required');
  if(failureCategory!==undefined&&!['binding_or_sampling_incomplete','defined_domain_mismatch','sampling_unavailable','deadline','timeout',
    'engine_exit','output_limit','infrastructure_error','invalid_alu_protocol','worker_termination_barrier'].includes(failureCategory))
    throw new RunnerError('INVALID_REFERENCE','Sanitized ALU failure category required');
  if(status==='passed'&&(!terminationConfirmed||!coverage.complete||coverage.compared!==2800||coverage.sampled!==2800))throw new RunnerError('INVALID_REFERENCE','Complete confirmed ALU comparison required');
  const body={checkId:request.identity.id,identity:request.identity,buildId:request.buildId,artifactHash:request.artifactHash,snapshotId:request.snapshotId,snapshotHash:request.snapshotHash,
    configurationHash:request.configurationHash,bindingVersionId:request.binding.versionId,bindingHash:request.bindingHash,ruleVersionId:request.ruleVersionId,validatorVersion:request.validatorVersion,
    vectorSetHash:request.vectorSetHash,samplingProfileVersion:request.samplingProfileVersion,runtimeProfileVersion:request.runtimeProfileVersion,engineVersion:request.engineVersion,
    buildImage:request.buildImage,runtimeImage:request.runtimeImage,sourceHash:request.sourceHash,status,coverage,terminationConfirmed,...(failureCategory?{failureCategory}:{})};
  return {...body,resultHash:sha256(JSON.stringify(body))};
}
export async function runAluComparison(binding:AluBinding,read:(start:number,inputs:HdlInputs[],remainingMs:number)=>Promise<AluSample[]>,stopped:()=>boolean,
  now:()=>number=performance.now.bind(performance),budgetMs=120000){
  validateAluBinding(binding);natural(budgetMs,0,120000);
  const started=now(),coverage=emptyAluCoverage(),rows:AluSample[]=[],failures:{index:number;category:string}[]=[];let bytes=0;
  for(let start=0;start<2800;start+=32){
    if(stopped())return {status:'cancelled' as const,coverage,rows,failures};
    if(now()-started>=budgetMs)return {status:'incomplete' as const,coverage,rows,failures};
    const batch=aluVectors.slice(start,start+32),packet=await read(start,batch.map(v=>aluInputs(binding,v)),Math.min(hdlLimits.stepMs,budgetMs-(now()-started)));
    const size=Buffer.byteLength(JSON.stringify(packet.map(row=>[row.index,row.simTimePs,row.bits])));bytes+=size;
    if(size>hdlLimits.packetBytes||bytes>hdlLimits.traceBytes)throw new RunnerError('CONTENT_LIMIT','Private ALU sample capacity exceeded');
    const checked=compareAluSamples(packet,start,batch.length);rows.push(...packet);failures.push(...checked.failures);
    coverage.sampled+=batch.length;coverage.compared+=checked.compared;
    if(stopped())return {status:'cancelled' as const,coverage,rows,failures};
    if(now()-started>=budgetMs)return {status:'incomplete' as const,coverage,rows,failures};
  }
  coverage.complete=coverage.sampled===2800&&coverage.compared===2800;
  return {status:coverage.complete?(failures.length?'failed' as const:'passed' as const):'incomplete' as const,coverage,rows,failures};
}
