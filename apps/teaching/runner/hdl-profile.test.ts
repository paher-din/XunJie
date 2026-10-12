import test from 'node:test';
import assert from 'node:assert/strict';
import {boardWrapper,validateBoard,validateOperation} from './hdl-profile.ts';
import {parseFrame,containerArgs} from './hdl-executor.ts';
import type {BoardProfile} from '../contracts/runner/hdl.ts';
export const board:BoardProfile={boardProfileVersion:'nexys4-ddr-rev-c-v1',mappingVersion:'synthetic-mapping-v1',topModule:'top',bindings:[
  {signal:'clock',offset:0,port:'clk',portOffset:0,width:1},{signal:'switches',offset:0,port:'sw',portOffset:0,width:16},
  {signal:'buttons',offset:0,port:'btn',portOffset:0,width:5},{signal:'leds',offset:0,port:'led',portOffset:0,width:16},
  {signal:'anodes',offset:0,port:'an',portOffset:0,width:8},{signal:'segments',offset:0,port:'seg',portOffset:0,width:7},
  {signal:'dp',offset:0,port:'dp',portOffset:0,width:1}]};
test('HDL board validation refuses executable mappings, missing bits and duplicates',()=>{
  validateBoard(board);assert.throws(()=>validateBoard({...board,topModule:'top;system'}));
  assert.throws(()=>validateBoard({...board,bindings:board.bindings.slice(1)}));assert.throws(()=>validateBoard({...board,bindings:[...board.bindings,board.bindings[0]]}));
});
test('elaborated widths/directions and all input bits must match, including ascending buses',()=>{
  const ports=board.bindings.map(binding=>({name:binding.port,width:binding.width,direction:['clock','switches','buttons'].includes(binding.signal)?'input' as const:'output' as const,left:binding.width-1,right:0}));
  assert(boardWrapper(board,ports).includes('top dut'));assert.throws(()=>boardWrapper(board,ports.map(port=>port.name==='sw'?{...port,width:8,left:7}:port)));
  assert.throws(()=>boardWrapper(board,[...ports,{name:'extra',width:1,direction:'input',left:0,right:0}]));
  assert(boardWrapper(board,ports.map(port=>port.name==='sw'?{...port,left:0,right:15}:port)).includes('p_sw[15] = switches[0]'));
});
test('four-value frames preserve X/Z and reject missing width or forged time',()=>{
  const line='F\t10000\t0000000000000000\t00000\t1\t0000000000000000\t11111110\tx0z1010\t0';
  assert.equal(parseFrame(line).segments,'x0z1010');assert.throws(()=>parseFrame(line.replace('10000','-1')));assert.throws(()=>parseFrame(line.replace('x0z1010','10')));
});
test('HDL interaction keeps input/cycle trust boundaries and the independent container limits',()=>{
  const operation={identity:{id:'op',commandId:'command',requestHash:'a'.repeat(64),recoveryGeneration:'generation',scope:{courseId:'course',studentId:'student',attemptId:'attempt',activityVersionId:'activity'}},
    sessionId:'session',expectedSessionRevision:1,expectedSequence:1,inputs:{switches:'0'.repeat(16),buttons:'00001',resetN:'1'},advanceCycles:2};
  validateOperation(operation);assert.throws(()=>validateOperation({...operation,advanceCycles:5000001}));assert.throws(()=>validateOperation({...operation,inputs:{...operation.inputs,buttons:'0000x'}}));
  const args=containerArgs('xunjie-dlc-test','sha256:'+'a'.repeat(64),'/source','/work',true);
  for(const value of ['--network=none','--memory=256m','--memory-swap=256m','--pids-limit=32','--cpus=0.5','--interactive'])assert(args.includes(value));
  assert(args.includes('--security-opt=apparmor=xunjie-dlc-v1'));
});
