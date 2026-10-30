import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {boardWrapper} from './hdl-profile.ts';
import {parseFrame} from './hdl-executor.ts';
import {board} from '../tests/fixtures/hdl-board.ts';

// A retained, extracted copy of the approved Icarus package; this exercises the public engine CLI, not node isolation.
const toolchain=process.env.XUNJIE_DLC_TOOLCHAIN;
const ports=board.bindings.map(binding=>({name:binding.port,width:binding.width,
  direction:['clock','switches','buttons'].includes(binding.signal)?'input' as const:'output' as const,left:binding.width-1,right:0}));
test('the platform clock and delayed RTL keep picosecond semantics under finer student time precision',
  {skip:process.platform!=='linux'||!toolchain,timeout:60000},async t=>{
  const directory=mkdtempSync(join(tmpdir(),'xunjie-hdl-clock-'));
  const run=(binary:string,args:string[],input?:string)=>{
    const result=spawnSync(binary,args,{cwd:directory,input,encoding:'utf8',timeout:15000,stdio:['pipe','pipe','pipe','pipe']});
    assert.ifError(result.error);assert.equal(result.status,0,String(result.stderr));return result;
  };
  run('/usr/bin/cc',['-fPIC','-shared','-I'+join(toolchain!,'usr/include/iverilog'),
    '-o','clock.vpi',fileURLToPath(new URL('./hdl-bridge.c',import.meta.url))]);
  writeFileSync(join(directory,'board.sv'),boardWrapper(board,ports),{flag:'wx'});
  const simulate=(precision:string,cycles:number)=>{
    const rtl=String.fromCharCode(96)+`timescale 1ns/${precision}
module top(input clk,input [15:0] sw,input [4:0] btn,output [15:0] led,output [7:0] an,output [6:0] seg,output dp);
reg [15:0] delayed=0;always @(posedge clk) delayed<= #1 delayed+1;
assign led=delayed;assign an=8'hfe;assign seg=sw[6:0];assign dp=0;endmodule
`;
    writeFileSync(join(directory,'top.sv'),rtl);
    run(join(toolchain!,'usr/bin/iverilog'),['-B'+join(toolchain!,'usr/lib/x86_64-linux-gnu/ivl'),
      '-g2012','-s','xunjie_board','-o','design.vvp','board.sv','top.sv']);
    const result=run(join(toolchain!,'usr/bin/vvp'),['-M'+directory,'-mclock','design.vvp'],
      `${cycles} 0000000000000000 00000 1\n`);
    return String(result.output[3]).trim().split('\n').filter(line=>line.startsWith('F\t')).map(parseFrame);
  };
  for(const precision of ['1ps','100fs','1fs'])await t.test(precision,()=>{
    const frames=simulate(precision,2);
    assert.equal(frames[0]!.simTimePs,'0');
    assert.equal(frames.at(-1)!.simTimePs,'20000');
    assert.equal(frames.at(-1)!.leds,'0000000000000010','both 1ns delayed updates must settle before the complete cycle sample');
  });
  await t.test('fine precision advances beyond the low 32 bits of simulation ticks',()=>{
    const frames=simulate('1fs',450);
    assert.equal(frames.at(-1)!.simTimePs,'4500000');
    assert.equal(frames.at(-1)!.leds,'0000000111000010');
  });
});
