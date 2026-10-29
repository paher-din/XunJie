import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AluBinding,AluSample,HdlAluCheck} from '../contracts/runner/alu.ts';
import {aluBindingHash,aluInputs,aluVectors,aluVersions,validateAluBinding,validateAluCheck,resolveAluBinding,compareAluSamples,
  runAluComparison,aluPublicResult,emptyAluCoverage,type AluElaboration} from './alu-check.ts';
import {AluProtocol} from './alu-simulation.ts';
import {HdlNode} from './hdl-node.ts';
import {hdlDirectory,saveSession,initializeHdl} from './hdl-ledger.ts';
import {mkdirSync} from 'node:fs';
import {writeImmutable,envelope} from './node-files.ts';
import {sha256} from './snapshot.ts';
import type {HdlBuild,HdlSession} from '../contracts/runner/hdl.ts';
import {board} from '../tests/fixtures/hdl-board.ts';
import {boardWrapper} from './hdl-profile.ts';

const names=['A','B','Cin','M','S','F','Cout'] as const;
export const binding:AluBinding={versionId:'synthetic-binding-v1',references:Object.fromEntries(names.map(signal=>
  [signal,[{instanceSegments:['unit'],signal,offset:0,width:signal==='A'||signal==='B'||signal==='F'?4:signal==='S'?2:1}]])) as AluBinding['references'],
  switchMapping:[{semantic:'operand_a',offset:0,width:4},{semantic:'operand_b',offset:4,width:4},{semantic:'mode',offset:8,width:1},
    {semantic:'select',offset:9,width:2},{semantic:'carry_in',offset:11,width:1}]};
const elaboration:AluElaboration={complete:true,instances:[{instanceSegments:['unit'],ports:names.map(name=>({name,direction:name==='F'||name==='Cout'?'output':'input',
  width:name==='A'||name==='B'||name==='F'?4:name==='S'?2:1,left:name==='A'||name==='B'||name==='F'?3:name==='S'?1:0,right:0}))}]};
const request:HdlAluCheck={identity:{id:'check',commandId:'command',requestHash:'a'.repeat(64),recoveryGeneration:'generation',
  scope:{courseId:'synthetic-course',studentId:'synthetic-student',attemptId:'attempt',activityVersionId:'activity'}},buildId:'build',artifactHash:'b'.repeat(64),
  snapshotId:'snapshot',snapshotHash:'c'.repeat(64),configurationHash:'d'.repeat(64),binding,bindingHash:aluBindingHash(binding),ruleVersionId:aluVersions.rule,
  validatorVersion:aluVersions.validator,vectorSetHash:aluVersions.vectorSetHash,samplingProfileVersion:aluVersions.sampling,runtimeProfileVersion:'runtime',
  engineVersion:'iverilog-12',buildImage:'sha256:'+'e'.repeat(64),runtimeImage:'sha256:'+'f'.repeat(64),sourceHash:'0'.repeat(64)};
function samples(start:number,count:number):AluSample[]{return aluVectors.slice(start,start+count).flatMap((v,j)=>{
  const index=start+j,full=v.m===0?[~v.a,v.a&v.b,v.a|v.b,v.a^v.b][v.s]!:(v.s===0?v.a+v.b+v.cin:v.a-v.b-v.cin);
  const bits=v.a.toString(2).padStart(4,'0')+v.b.toString(2).padStart(4,'0')+v.cin+v.m+v.s.toString(2).padStart(2,'0')
    +(full&15).toString(2).padStart(4,'0')+(v.m===1&&v.s===0?(full>>4)&1:'x');
  return [2,3,4].map(phase=>({index,simTimePs:String((index*4+phase)*10000),bits}));
});}
test('H3 binding refuses scripts, aliases, scope escapes and unknown shared fields',()=>{
  validateAluBinding(binding);validateAluCheck(request);assert.equal(aluVectors.length,2800);
  assert.throws(()=>validateAluBinding({...binding,references:{...binding.references,A:[{...binding.references.A[0]!,signal:'A;system'}]}}));
  assert.throws(()=>validateAluBinding({...binding,references:{...binding.references,A:[{...binding.references.A[0]!,instanceSegments:['..']}]}}));
  assert.throws(()=>validateAluBinding({...binding,references:{...binding.references,F:binding.references.A}}));
  assert.throws(()=>validateAluBinding({...binding,switchMapping:binding.switchMapping.map(value=>({...value,offset:0}))}));
  assert.throws(()=>validateAluCheck({...request,extra:'script'}));assert.throws(()=>validateAluCheck({...request,bindingHash:'a'.repeat(64)}));
  assert.throws(()=>validateAluCheck({...request,vectorSetHash:'1'.repeat(64)}));
});
test('H3 actual elaboration resolves directions, ascending ranges and split S without fixing student names',()=>{
  const bits=resolveAluBinding(binding,elaboration);assert.equal(bits.length,17);assert.equal(bits[0]!.path,'xunjie_board.dut.unit.A');assert.equal(bits[0]!.index,3);
  const ascending=structuredClone(elaboration);ascending.instances[0]!.ports[0]={...ascending.instances[0]!.ports[0]!,left:0,right:3};
  assert.equal(resolveAluBinding(binding,ascending)[0]!.index,0);
  const split=structuredClone(binding);split.references.S=[{instanceSegments:['unit'],signal:'S0',offset:0,width:1},{instanceSegments:['unit'],signal:'S1',offset:0,width:1}];
  const meta=structuredClone(elaboration);meta.instances[0]!.ports=meta.instances[0]!.ports.filter(port=>port.name!=='S');
  meta.instances[0]!.ports.push(...['S0','S1'].map(name=>({name,direction:'input' as const,width:1,left:0,right:0})));
  assert.equal(resolveAluBinding(split,meta)[10]!.path,'xunjie_board.dut.unit.S1');
  assert.throws(()=>resolveAluBinding(binding,{...elaboration,complete:false}));
  assert.throws(()=>resolveAluBinding(binding,{complete:true,instances:[]}));
  const bad=structuredClone(elaboration);bad.instances[0]!.ports[0]!.direction='inout';assert.throws(()=>resolveAluBinding(binding,bad));
});
test('H3 complete 2800 comparison preserves ungraded Cout and excludes undefined vectors',async()=>{
  const result=await runAluComparison(binding,async(start,inputs)=>samples(start,inputs.length),()=>false,()=>0);
  assert.equal(result.status,'passed');assert.deepEqual(result.coverage,{expected:2800,sampled:2800,compared:2800,excluded:1296,complete:true});
  assert.equal(result.rows.length,8400);assert.equal(result.failures.length,0);
  assert.equal(aluPublicResult(request,'passed',result.coverage,true).status,'passed');
  assert.throws(()=>aluPublicResult(request,'passed',emptyAluCoverage(),true));assert.throws(()=>aluPublicResult(request,'passed',result.coverage,false));
  const remapped=structuredClone(binding);remapped.switchMapping=remapped.switchMapping.map(v=>({...v,offset:{operand_a:8,operand_b:0,mode:4,select:5,carry_in:7}[v.semantic]}));
  validateAluBinding(remapped);assert.notEqual(aluInputs(binding,aluVectors[31]!).switches,aluInputs(remapped,aluVectors[31]!).switches);
});
test('H3 separates behavior error, graded unknown, input mismatch, unstable and missing samples',()=>{
  const rows=samples(0,1);for(const row of rows)row.bits=row.bits.slice(0,12)+'0000x';
  assert.equal(compareAluSamples(rows,0,1).failures[0]!.category,'behavior_mismatch');
  rows[1]!.bits=rows[1]!.bits.slice(0,12)+'xxxxz';assert.equal(compareAluSamples(rows,0,1).failures[0]!.category,'graded_unknown');
  const input=samples(0,1);input[0]!.bits='x'+input[0]!.bits.slice(1);assert.equal(compareAluSamples(input,0,1).compared,0);
  const unstable=samples(0,1);unstable[1]!.bits=unstable[1]!.bits.slice(0,12)+'0000x';assert.equal(compareAluSamples(unstable,0,1).failures[0]!.category,'unstable');
  assert.throws(()=>compareAluSamples(rows.slice(0,2),0,1));assert.throws(()=>compareAluSamples([{...rows[0]!,simTimePs:'1'},...rows.slice(1)],0,1));
});
test('H3 whole-job deadline and cancellation never turn partial coverage into pass',async()=>{
  let now=0;const timed=await runAluComparison(binding,async(start,inputs)=>{now=120001;return samples(start,inputs.length);},()=>false,()=>now);
  assert.equal(timed.status,'incomplete');assert.equal(timed.coverage.complete,false);assert.equal(timed.coverage.sampled,32);
  const stopped=await runAluComparison(binding,async()=>{assert.fail('Must not dispatch');},()=>true);assert.equal(stopped.status,'cancelled');
});
test('H3 private parser rejects spoofed stdout, extra rows and wrong time; handles partial transport chunks',()=>{
  const parser=new AluProtocol();assert.deepEqual(parser.push(Buffer.from('F\t0\tunused\nD\t1\t1\t0\n')),['initial']);
  parser.mode='binding';assert.deepEqual(parser.push(Buffer.from('C\t17\n')),['binding']);parser.configure(0,1);
  const text=samples(0,1).map(r=>`A\t${r.index}\t${r.simTimePs}\t${r.bits}\n`).join('')+'E\t3\t40000\n';
  assert.deepEqual(parser.push(Buffer.from(text.slice(0,9))),[]);assert.deepEqual(parser.push(Buffer.from(text.slice(9))),[samples(0,1)]);
  const forged=new AluProtocol();forged.configure(0,1);assert.throws(()=>forged.push(Buffer.from('stdout says passed\n')));
  assert.throws(()=>forged.push(Buffer.from('A\t0\t999\t'+'0'.repeat(17)+'\n')));
});
test('H3 node probe requires true immutable metadata; check refuses occupied Attempt and never exposes private rows',{skip:process.platform!=='linux'},async()=>{
  const state=mkdtempSync(join(tmpdir(),'xunjie-alu-node-')),runtime={runtimeProfileVersion:'runtime',engineVersion:'iverilog-12',buildImage:request.buildImage,runtimeImage:request.runtimeImage,sourceHash:request.sourceHash};
  const config={node:process.execPath,source:state,state,generation:'generation',dockerBinary:'/nonexistent',dockerSocket:'/nonexistent',cliConfig:state,hdl:runtime};
  initializeHdl(config);const node=new HdlNode(config,state+'/config.json',()=>config.generation),artifact='immutable synthetic artifact';
  const buildPath=hdlDirectory(config,'builds','build');mkdirSync(join(buildPath,'artifact'),{recursive:true});
  writeFileSync(join(buildPath,'artifact','design.vvp'),artifact);
  const built:HdlBuild={buildId:'build',identity:{...request.identity,id:'build'},snapshotId:'snapshot',snapshotHash:request.snapshotHash,board,
    runtimeProfileVersion:runtime.runtimeProfileVersion,engineVersion:runtime.engineVersion,imageDigest:runtime.buildImage,configurationHash:sha256(JSON.stringify(board)),
    status:'succeeded',terminationConfirmed:true,artifactHash:sha256(artifact),diagnostics:[],stdout:'STUDENT_SAYS_PASSED',stderr:''};
  writeImmutable(join(buildPath,'request.json'),envelope({identity:built.identity,board,snapshot:{snapshotId:built.snapshotId,hash:built.snapshotHash}}));
  writeImmutable(join(buildPath,'outcome.json'),envelope(built));
  writeImmutable(join(buildPath,'elaboration.json'),envelope({artifactHash:built.artifactHash,elaboration}));
  const check={...request,artifactHash:built.artifactHash!,configurationHash:built.configurationHash};
  const {bindingHash:_hash,ruleVersionId:_rule,validatorVersion:_validator,vectorSetHash:_vectors,samplingProfileVersion:_sampling,
    runtimeProfileVersion:_runtime,engineVersion:_engine,buildImage:_buildImage,runtimeImage:_runtimeImage,sourceHash:_source,...probe}=check;
  const metadata=await node.dispatch({op:'hdl_alu_probe',request:probe},true);assert.equal(metadata.validated,true);assert(!JSON.stringify(metadata).includes('bits'));
  await assert.rejects(node.dispatch({op:'hdl_alu_probe',request:{...probe,artifactHash:'1'.repeat(64)}},true));
  const oldPath=hdlDirectory(config,'sessions','old');mkdirSync(oldPath);
  const old:HdlSession={sessionId:'old',identity:{...request.identity,id:'old'},buildId:'build',snapshotId:'snapshot',snapshotHash:request.snapshotHash,
    boardProfileVersion:board.boardProfileVersion,mappingVersion:board.mappingVersion,engineVersion:runtime.engineVersion,runtimeProfileVersion:'runtime',
    sessionRevision:1,confirmedSequence:0,simTimePs:'0',status:'active',terminationConfirmed:false,stopRequested:false,
    createdAt:new Date().toISOString(),lastOperationAt:new Date().toISOString(),deadline:new Date(Date.now()+120000).toISOString()};
  saveSession(oldPath,old);await assert.rejects(node.dispatch({op:'hdl_alu_check',request:check},true),{code:'RATE_LIMITED'});
  const checkPath=hdlDirectory(config,'sessions',check.identity.id);mkdirSync(checkPath);
  writeImmutable(join(checkPath,'request.json'),envelope({check}));saveSession(checkPath,{...old,sessionId:check.identity.id,identity:check.identity,status:'stopped',terminationConfirmed:true});
  const final=aluPublicResult(check,'passed',{expected:2800,sampled:2800,compared:2800,excluded:1296,complete:true},true);
  writeImmutable(join(checkPath,'check-result.json'),envelope(final));writeImmutable(join(checkPath,'private-samples.json'),envelope('PRIVATE_RAW_SAMPLES'));
  assert.deepEqual(await node.dispatch({op:'hdl_alu_result',identity:check.identity},true),final);
  assert(!JSON.stringify(await node.dispatch({op:'hdl_query',identity:check.identity},true)).includes('PRIVATE_RAW_SAMPLES'));
  await assert.rejects(node.dispatch({op:'hdl_result',identity:check.identity,operationId:check.identity.id},true),{code:'FORBIDDEN'});
  await assert.rejects(node.dispatch({op:'hdl_alu_result',identity:{...check.identity,recoveryGeneration:'old'}},true),{code:'RECOVERY_REQUIRED'});
});

const toolchain=process.env.XUNJIE_DLC_TOOLCHAIN;
test('H3 isolated Icarus CLI: true hierarchical binding and 2800 stable sampled vectors',{skip:!toolchain||process.platform!=='linux',timeout:120000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'xunjie-h3-cli-'));
  const run=(bin:string,args:string[],input?:string)=>{
    const result=spawnSync(bin,args,{cwd:dir,input,encoding:'utf8',timeout:30000,maxBuffer:2*1024*1024,stdio:['pipe','pipe','pipe','pipe']});
    assert.ifError(result.error);assert.equal(result.status,0,String(result.stderr));return result;
  };
  const ivl=join(toolchain!,'usr/lib/x86_64-linux-gnu/ivl');
  run('/usr/bin/gcc',['-Wall','-Wextra','-Werror','-shared','-fPIC','-I'+join(toolchain!,'usr/include/iverilog'),
    fileURLToPath(new URL('./hdl-ports.c',import.meta.url)),'-o',join(ivl,'xunjie_ports.tgt')]);
  writeFileSync(join(ivl,'xunjie_ports.conf'),'flag:DLL='+join(ivl,'xunjie_ports.tgt')+'\n');
  run('/usr/bin/gcc',['-Wall','-Wextra','-Werror','-shared','-fPIC','-I'+join(toolchain!,'usr/include/iverilog'),
    fileURLToPath(new URL('./hdl-bridge.c',import.meta.url)),'-o',join(dir,'h3.vpi')]);
  const rtl=`module alu(input [3:0] A,B,input Cin,M,input [1:0] S,output reg [3:0] F,output reg Cout);
  reg [4:0] sum;always @* begin Cout=1'bx;sum=0;F=4'bxxxx;
  if(!M)case(S)0:F=~A;1:F=A&B;2:F=A|B;3:F=A^B;endcase
  else case(S)0:begin sum={1'b0,A}+{1'b0,B}+Cin;F=sum[3:0];Cout=sum[4];end
  1:if(A>B)F=A-B-Cin;endcase end endmodule
  module top(input clk,input [15:0] sw,input [4:0] btn,output [15:0] led,output [7:0] an,output [6:0] seg,output dp);
  wire [3:0] f;wire carry;alu unit(sw[3:0],sw[7:4],sw[11],sw[8],sw[10:9],f,carry);
  assign led={11'b0,carry,f};assign an=8'hfe;assign seg=7'h7f;assign dp=1;endmodule\n`;
  writeFileSync(join(dir,'top.sv'),rtl);
  const args=['-B'+ivl,'-g2012','-s','top','-pXUNJIE_HIERARCHY=1','-txunjie_ports','-o','ports.json','top.sv'];
  run(join(toolchain!,'usr/bin/iverilog'),args);
  const meta=JSON.parse(readFileSync(join(dir,'ports.json'),'utf8')),bits=resolveAluBinding(binding,meta.elaboration);
  writeFileSync(join(dir,'board.sv'),boardWrapper(board,meta.ports));
  const compile=()=>run(join(toolchain!,'usr/bin/iverilog'),['-B'+ivl,'-g2012','-s','xunjie_board','-o','design.vvp','board.sv','top.sv']);compile();
  const bindingCommand='B 17 '+bits.map(bit=>`${bit.path} ${bit.offset} ${bit.width}`).join(' ')+'\n';
  let commands=bindingCommand;for(let start=0;start<2800;start+=32){const input=aluVectors.slice(start,start+32).map(v=>aluInputs(binding,v).switches);
    commands+=`P ${start} ${input.length} ${input.join(' ')}\n`;}
  const actual=run(join(toolchain!,'usr/bin/vvp'),['-n','-M'+dir,'-mh3','design.vvp'],commands);
  const rows=String(actual.output[3]).trim().split('\n').filter(line=>line.startsWith('A\t')).map(line=>{const p=line.split('\t');return {index:Number(p[1]),simTimePs:p[2]!,bits:p[3]!};});
  assert.equal(rows.length,8400);for(let start=0;start<2800;start+=32){const count=Math.min(32,2800-start);assert.deepEqual(compareAluSamples(rows.slice(start*3,(start+count)*3),start,count).failures,[]);}
  writeFileSync(join(dir,'top.sv'),rtl.replace('0:F=~A','0:F=A'));compile();
  const wrong=run(join(toolchain!,'usr/bin/vvp'),['-n','-M'+dir,'-mh3','design.vvp'],bindingCommand+'P 0 1 '+aluInputs(binding,aluVectors[0]!).switches+'\n');
  const wrongRows=String(wrong.output[3]).trim().split('\n').filter(line=>line.startsWith('A\t')).map(line=>{const p=line.split('\t');return {index:Number(p[1]),simTimePs:p[2]!,bits:p[3]!};});
  assert.equal(compareAluSamples(wrongRows,0,1).failures[0]!.category,'behavior_mismatch');
});
