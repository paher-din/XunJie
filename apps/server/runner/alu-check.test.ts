import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {AluSample} from '../contracts/runner/alu.ts';
import {aluInputs,aluVectors,validateAluBinding,validateAluCheck,resolveAluBinding,compareAluSamples,
  runAluComparison,aluPublicResult,emptyAluCoverage} from './alu-check.ts';
import {AluProtocol} from './alu-simulation.ts';
import {board} from '../tests/fixtures/hdl-board.ts';
import {boardWrapper} from './hdl-profile.ts';
import {binding,elaboration,request} from '../tests/fixtures/alu-check.ts';

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
