import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout} from 'node:timers/promises';
import {HdlNode} from './hdl-node.ts';
import {sha256,manifestHash} from './snapshot.ts';
import type {HdlNodeConfig} from './hdl-executor.ts';
import type {BoardProfile,HdlBuild,HdlIdentity,HdlInputs,HdlOperationResult,HdlSession} from '../contracts/runner/hdl.ts';

// Opt-in real containers. The original config is read only; every ledger entry
// belongs to a fresh temporary state directory and random synthetic identities.
const originalConfigPath=process.env.XUNJIE_DLC_CONFIG;
const board:BoardProfile={boardProfileVersion:'nexys4-ddr-rev-c-v1',mappingVersion:'synthetic-all-inputs-v1',topModule:'top',bindings:[
  {signal:'clock',offset:0,port:'clk',portOffset:0,width:1},
  {signal:'switches',offset:0,port:'sw',portOffset:0,width:16},
  {signal:'buttons',offset:0,port:'btn',portOffset:0,width:5},
  {signal:'resetN',offset:0,port:'reset_n',portOffset:0,width:1},
  {signal:'leds',offset:0,port:'led',portOffset:0,width:16},
  {signal:'anodes',offset:0,port:'an',portOffset:0,width:8},
  {signal:'segments',offset:0,port:'seg',portOffset:0,width:7},
  {signal:'dp',offset:0,port:'dp',portOffset:0,width:1}
]};
const source=`module top(input clk,input [15:0] sw,input [4:0] btn,input reset_n,
output [15:0] led,output [7:0] an,output [6:0] seg,output dp);
reg [6:0] count=0; reg [2:0] scan=0;
always @(posedge clk) begin
  if(!reset_n) begin count<=0; scan<=0; end
  else begin if(btn[0]) count<=count+1; scan<=scan+1; end
end
assign led=sw^{11'b0,btn};
assign an=sw[14]?8'hff:sw[13]?8'hfc:~(8'b1<<scan);
assign seg=sw[15]?7'bx0z1010:count;
assign dp=sw[15]?1'bz:reset_n;
endmodule\n`;
const bits=(value:number,width:number)=>value.toString(2).padStart(width,'0');

test('target VM: every board input reaches real HDL with persistent state, scan, four values and confirmed stop',
  {skip:process.platform!=='linux'||!originalConfigPath,timeout:180000},async t=>{
  const originalBytes=readFileSync(originalConfigPath!);
  const original=JSON.parse(originalBytes.toString('utf8')) as HdlNodeConfig;
  const validationPath=join(original.state,'hdl','validation.jsonl');
  const validationBefore=existsSync(validationPath)?readFileSync(validationPath):null;
  const evidence=mkdtempSync(join(tmpdir(),'xunjie-board-inputs-'));
  const config:HdlNodeConfig={node:original.node,source:dirname(fileURLToPath(import.meta.url)),
    state:join(evidence,'state'),generation:original.generation,dockerBinary:original.dockerBinary,
    dockerSocket:original.dockerSocket,cliConfig:original.cliConfig,hdl:original.hdl};
  const configPath=join(evidence,'config.json');
  writeFileSync(configPath,JSON.stringify(config),{flag:'wx',mode:0o600});
  t.diagnostic(`Retained synthetic board evidence: ${evidence}`);
  const node=new HdlNode(config,configPath,()=>config.generation);
  const scope={courseId:'synthetic-board-'+randomUUID(),studentId:'synthetic-board-student',
    attemptId:randomUUID(),activityVersionId:'synthetic-full-inputs'};
  const identity=():HdlIdentity=>({id:randomUUID(),commandId:randomUUID(),requestHash:sha256(randomUUID()),
    recoveryGeneration:config.generation,scope});
  const files=[{fileId:'synthetic-top',path:'top.sv',documentVersion:1,text:source,contentHash:sha256(source)}];
  const buildIdentity=identity();
  const request={identity:buildIdentity,snapshot:{snapshotId:randomUUID(),hashFormat:'sha256-manifest-v1' as const,files,hash:manifestHash(files)},
    board,runtimeProfileVersion:config.hdl.runtimeProfileVersion};
  const observations:HdlOperationResult[]=[];
  let session:HdlSession|undefined,initial:HdlOperationResult|undefined,last:HdlOperationResult|undefined;
  let totalCycles=0,count=0,scan=0;
  const zero:HdlInputs={switches:'0'.repeat(16),buttons:'00000',resetN:'1'};
  const waitBuild=async()=>{
    for(let i=0;i<600;i++){
      const value=await node.dispatch({op:'hdl_query',identity:buildIdentity},true) as HdlBuild;
      if(!['queued','running'].includes(value.status))return value;
      await setTimeout(50);
    }
    throw new Error('Synthetic board build did not finish');
  };
  const operation=async(inputs:HdlInputs,advanceCycles=1)=>{
    assert(session);
    const result=await node.dispatch({op:'hdl_interact',request:{identity:identity(),sessionId:session.sessionId,
      expectedSessionRevision:session.sessionRevision,expectedSequence:session.confirmedSequence+1,inputs,advanceCycles}},true) as HdlOperationResult;
    totalCycles+=advanceCycles;
    if(inputs.resetN==='0'){count=0;scan=0;}
    else{if(inputs.buttons.endsWith('1'))count=(count+advanceCycles)%128;scan=(scan+advanceCycles)%8;}
    assert.equal(result.sessionId,session.sessionId);
    assert.equal(result.buildId,request.identity.id);
    assert.equal(result.snapshotHash,request.snapshot.hash);
    assert.equal(result.boardProfileVersion,board.boardProfileVersion);
    assert.equal(result.mappingVersion,board.mappingVersion);
    assert.equal(result.engineVersion,config.hdl.engineVersion);
    assert.equal(result.sequence,session.confirmedSequence+1);
    assert.equal(result.sessionRevision,session.sessionRevision+1);
    assert.equal(result.sampleCount,advanceCycles);
    assert.equal(result.finalFrame.simTimePs,String(totalCycles*10000));
    assert.equal(result.finalFrame.switches,inputs.switches);
    assert.equal(result.finalFrame.buttons,inputs.buttons);
    assert.equal(result.finalFrame.resetN,inputs.resetN);
    assert.equal(result.finalFrame.leds,bits(parseInt(inputs.switches,2)^parseInt(inputs.buttons,2),16));
    const switches=parseInt(inputs.switches,2);
    assert.equal(result.finalFrame.anodes,bits(switches&0x4000?255:switches&0x2000?252:(~(1<<scan))&255,8));
    assert.equal(result.finalFrame.segments,switches&0x8000?'x0z1010':bits(count,7));
    assert.equal(result.finalFrame.dp,switches&0x8000?'z':inputs.resetN);
    assert.deepEqual(result.frames.at(-1),result.finalFrame);
    const {resultHash,...body}=result;assert.equal(resultHash,sha256(JSON.stringify(body)));
    assert.equal(result.coverage,result.droppedFrames?'incomplete':'complete');
    observations.push(result);last=result;
    session=await node.dispatch({op:'hdl_query',identity:session.identity},true) as HdlSession;
    assert.equal(session.status,'active');assert.equal(session.confirmedSequence,result.sequence);
    return result;
  };
  try{
    await node.dispatch({op:'hdl_build',request},true);
    const built=await waitBuild();assert.equal(built.status,'succeeded',JSON.stringify(built));assert(built.terminationConfirmed);
    const programIdentity=identity();
    await node.dispatch({op:'hdl_program',request:{identity:programIdentity,buildId:built.buildId}},true);
    for(let i=0;i<600;i++){
      session=await node.dispatch({op:'hdl_query',identity:programIdentity},true) as HdlSession;
      if(session.status!=='starting')break;
      await setTimeout(50);
    }
    assert.equal(session!.status,'active',JSON.stringify(session));
    initial=await node.dispatch({op:'hdl_result',identity:session!.identity,operationId:session!.sessionId},true) as HdlOperationResult;
    assert.equal(initial.sequence,0);assert.equal(initial.finalFrame.simTimePs,'0');
    assert.deepEqual(initial.finalFrame,{...zero,simTimePs:'0',leds:'0'.repeat(16),anodes:'11111110',segments:'0000000',dp:'1'});
    for(let index=0;index<16;index++)await t.test(`SW${index}: high and low reach the corresponding real LED`,async()=>{
      await operation({...zero,switches:bits(1<<index,16)});
      await operation(zero);
    });
    for(let index=0;index<5;index++)await t.test(`BTN${index}: distinct press and release reach real HDL`,async()=>{
      await operation({...zero,buttons:bits(1<<index,5)});
      await operation(zero);
    });
    await t.test('the same engine retains counter state across explicit advances and releases',async()=>{
      await operation({...zero,buttons:'00001'},3);
      const held=await operation({...zero,buttons:'00001'},2);
      const released=await operation(zero,3);
      assert.equal(released.finalFrame.segments,held.finalFrame.segments);
      assert.equal(released.sessionId,initial!.sessionId);
    });
    await t.test('RESET_N low resets registers and release preserves the reset state',async()=>{
      await operation({...zero,resetN:'0'},2);
      const released=await operation(zero,1);assert.equal(released.finalFrame.segments,'0000000');
    });
    await t.test('a finite real scan contains all eight active-low anodes and stable segments',async()=>{
      const scanResult=await operation(zero,16);
      assert.equal(scanResult.droppedFrames,0);assert.equal(scanResult.coverage,'complete');
      assert.deepEqual(new Set(scanResult.frames.map(frame=>frame.anodes)),new Set(Array.from({length:8},(_,index)=>bits((~(1<<index))&255,8))));
      assert(scanResult.frames.every(frame=>frame.segments==='0000000'&&frame.dp==='1'));
    });
    await t.test('unknown/high impedance, multiple anodes and all-off come from the actual HDL',async()=>{
      await operation({...zero,switches:bits(0x8000,16)});
      await operation({...zero,switches:bits(0x2000,16)});
      await operation({...zero,switches:bits(0x4000,16)});
      await operation(zero);
    });
    await t.test('stop confirms the original instance exit and preserves its final result',async()=>{
      session=await node.dispatch({op:'hdl_stop',identity:session!.identity},true) as HdlSession;
      assert.equal(session.status,'stopped');assert.equal(session.terminationConfirmed,true);
      assert.equal(session.stopRequested,true);
      const retained=await node.dispatch({op:'hdl_result',identity:session.identity,operationId:last!.operationId},true);
      assert.deepEqual(retained,last);
      await assert.rejects(node.dispatch({op:'hdl_interact',request:{identity:identity(),sessionId:session.sessionId,
        expectedSessionRevision:session.sessionRevision,expectedSequence:session.confirmedSequence+1,inputs:zero,advanceCycles:1}},true));
    });
  }finally{
    if(session&&!session.terminationConfirmed)session=await node.dispatch({op:'hdl_stop',identity:session.identity},true) as HdlSession;
    writeFileSync(join(evidence,'observations.json'),JSON.stringify({scope,buildRequest:request,initial,observations,finalSession:session},null,2),{flag:'wx',mode:0o600});
    assert.deepEqual(readFileSync(originalConfigPath!),originalBytes,'original execution config must remain unchanged');
    assert.deepEqual(existsSync(validationPath)?readFileSync(validationPath):null,validationBefore,'original acceptance ledger must remain unchanged');
    if(session)assert.equal(session.terminationConfirmed,true,'the synthetic instance must confirm exit');
  }
});
