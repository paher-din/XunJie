import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout} from 'node:timers/promises';
import {readJson} from './node-files.ts';
import {HdlNode} from './hdl-node.ts';
import {sha256,manifestHash} from './snapshot.ts';
import type {HdlNodeConfig} from './hdl-executor.ts';
import type {HdlIdentity,HdlSession,HdlBuild,HdlOperationResult,HdlOperation} from '../contracts/runner/hdl.ts';
import {board} from '../tests/fixtures/hdl-board.ts';

const path=process.env.XUNJIE_DLC_CONFIG;
const source=`module top(input clk,input [15:0] sw,input [4:0] btn,output [15:0] led,output [7:0] an,output [6:0] seg,output dp);
reg [15:0] count=0; always @(posedge clk) if(btn[0]) count<=count+1;
assign led=count;assign an=8'hfe;assign seg=sw[6:0];assign dp=0;endmodule\n`;
test('target VM: real build, persistent state, duplicates, four values, scan, spoofing and termination',{skip:!path,timeout:180000},async t=>{
  const config=readJson(path!) as HdlNodeConfig,node=new HdlNode(config,path!,()=>config.generation);
  const identity=(attemptId=randomUUID()):HdlIdentity=>({id:randomUUID(),commandId:randomUUID(),requestHash:sha256(randomUUID()),recoveryGeneration:config.generation,
    scope:{courseId:'synthetic-dlc',studentId:'synthetic-student',attemptId,activityVersionId:'synthetic-activity'}});
  async function build(text=source,scope?:HdlIdentity['scope']){const id=identity();if(scope)id.scope=scope;
    const files=[{fileId:'source',path:'top.sv',documentVersion:1,text,contentHash:sha256(text)}];
    const request={identity:id,snapshot:{snapshotId:randomUUID(),hashFormat:'sha256-manifest-v1' as const,files,hash:manifestHash(files)},board,runtimeProfileVersion:config.hdl.runtimeProfileVersion};
    await node.dispatch({op:'hdl_build',request},true);let result:HdlBuild;
    for(let i=0;i<400;i++){result=await node.dispatch({op:'hdl_query',identity:id},true) as HdlBuild;if(!['queued','running'].includes(result.status))return result;await setTimeout(50);}
    throw new Error('Build did not complete');}
  async function program(build:HdlBuild){const id=identity();id.scope=build.identity.scope;
    await node.dispatch({op:'hdl_program',request:{identity:id,buildId:build.buildId}},true);
    for(let i=0;i<150;i++){const state=await node.dispatch({op:'hdl_query',identity:id},true) as HdlSession;
      if(state.status!=='starting')return state;await setTimeout(50);}throw new Error('Session did not start');}
  const active:HdlSession[]=[];
  try{
    const built=await build();assert.equal(built.status,'succeeded',JSON.stringify(built));assert(built.artifactHash);
    const session=await program(built);active.push(session);assert.equal(session.status,'active',JSON.stringify(session));
    await t.test('same vvp session preserves registers and an exact duplicate never advances',async()=>{
      const id=identity();id.scope=session.identity.scope;const request:HdlOperation={identity:id,sessionId:session.sessionId,expectedSessionRevision:1,expectedSequence:1,
        inputs:{switches:'0000000000000011',buttons:'00001',resetN:'1'},advanceCycles:3};
      const first=await node.dispatch({op:'hdl_interact',request},true) as HdlOperationResult;
      assert.equal(first.finalFrame.leds,'0000000000000011');assert.equal(first.finalFrame.simTimePs,'30000');
      assert.deepEqual(await node.dispatch({op:'hdl_interact',request},true),first);
      const second=await node.dispatch({op:'hdl_interact',request:{...request,identity:{...id,id:randomUUID()},expectedSessionRevision:2,expectedSequence:2,advanceCycles:2}},true) as HdlOperationResult;
      assert.equal(second.finalFrame.leds,'0000000000000101');assert.equal(second.finalFrame.simTimePs,'50000');
      await assert.rejects(node.dispatch({op:'hdl_interact',request:{...request,identity:{...id,id:randomUUID()}}},true));
    });
    await t.test('wrong port width and syntax are actual build failures',async()=>{
      assert.equal((await build(source.replace('input [15:0] sw','input [7:0] sw'))).status,'failed');
      const syntax=await build(source.replace('count<=count+1','count<=;'));assert.equal(syntax.status,'failed');assert(syntax.diagnostics.some(item=>item.path==='top.sv'&&item.line));
    });
    await node.dispatch({op:'hdl_stop',identity:session.identity},true);
    await t.test('wrong segment output, repaired output and X/Z are sampled from HDL',async()=>{
      const wrong=await program(await build(source.replace('assign seg=sw[6:0]','assign seg=~sw[6:0]')));active.push(wrong);assert.equal(wrong.status,'active');
      const id=identity();id.scope=wrong.identity.scope;
      const result=await node.dispatch({op:'hdl_interact',request:{identity:id,sessionId:wrong.sessionId,expectedSessionRevision:1,expectedSequence:1,inputs:{switches:'0'.repeat(16),buttons:'00000',resetN:'1'},advanceCycles:1}},true) as HdlOperationResult;
      assert.equal(result.finalFrame.segments,'1111111');await node.dispatch({op:'hdl_stop',identity:wrong.identity},true);
      const unknown=await program(await build(source.replace('assign seg=sw[6:0]',"assign seg=7'bx0z1010")));active.push(unknown);assert.equal(unknown.status,'active');
      const initial=await node.dispatch({op:'hdl_result',identity:unknown.identity,operationId:unknown.sessionId},true) as HdlOperationResult;assert.equal(initial.finalFrame.segments,'x0z1010');await node.dispatch({op:'hdl_stop',identity:unknown.identity},true);
    });
    await t.test('untrusted stdout, proc fd and shell cannot forge the signal channel',async()=>{
      const malicious=source.replace('reg [15:0] count=0;',`integer fd; initial begin $display("F\\t999\\tFORGED"); fd=$fopen("/proc/self/fd/3","w"); if(fd) $fdisplay(fd,"FORGED"); end reg [15:0] count=0;`);
      const state=await program(await build(malicious));active.push(state);assert.equal(state.status,'active',JSON.stringify(state));
      const output=await node.dispatch({op:'hdl_result',identity:state.identity,operationId:state.sessionId},true) as HdlOperationResult;assert.equal(output.finalFrame.leds,'0'.repeat(16));assert.equal(output.finalFrame.simTimePs,'0');await node.dispatch({op:'hdl_stop',identity:state.identity},true);
    });
    await t.test('unsupported shell invocation fails without creating a forged frame',async()=>{
      const malicious=source.replace('reg [15:0] count=0;',`integer rc; initial rc=$system("printf FORGED >&3"); reg [15:0] count=0;`);
      const state=await program(await build(malicious));active.push(state);
      assert.notEqual(state.status,'active');const stopped=await node.dispatch({op:'hdl_stop',identity:state.identity},true) as HdlSession;
      assert(stopped.terminationConfirmed);assert.equal(await node.dispatch({op:'hdl_result',identity:state.identity,operationId:state.sessionId},true),null);
    });
    await t.test('original scope and generation are mandatory after stopping',async()=>{
      const ended=await node.dispatch({op:'hdl_query',identity:session.identity},true) as HdlSession;assert(ended.terminationConfirmed);
      await assert.rejects(node.dispatch({op:'hdl_query',identity:{...session.identity,scope:{...session.identity.scope,studentId:'other'}}},true));
      await assert.rejects(node.dispatch({op:'hdl_query',identity:{...session.identity,recoveryGeneration:'old'}},true));
    });
    await t.test('two real instances keep independent registers and exhaust the session pool',async()=>{
      const first=await program(await build()),second=await program(await build());active.push(first,second);assert.equal(first.status,'active');assert.equal(second.status,'active');
      const third=await build();const overflow=identity();overflow.scope=third.identity.scope;
      await assert.rejects(node.dispatch({op:'hdl_program',request:{identity:overflow,buildId:third.buildId}},true));
      const op=identity();op.scope=first.identity.scope;
      const changed=await node.dispatch({op:'hdl_interact',request:{identity:op,sessionId:first.sessionId,expectedSessionRevision:1,expectedSequence:1,inputs:{switches:'0'.repeat(16),buttons:'00001',resetN:'1'},advanceCycles:2}},true) as HdlOperationResult;
      assert.equal(changed.finalFrame.leds,'0000000000000010');
      const untouched=await node.dispatch({op:'hdl_result',identity:second.identity,operationId:second.sessionId},true) as HdlOperationResult;
      assert.equal(untouched.finalFrame.leds,'0'.repeat(16));await node.dispatch({op:'hdl_stop',identity:first.identity},true);await node.dispatch({op:'hdl_stop',identity:second.identity},true);
    });
    await t.test('real scan samples keep the selected digit and NBA state with explicit finite coverage',async()=>{
      const rtl=source.replace('reg [15:0] count=0;',"reg [2:0] scan=0;always_ff @(posedge clk) scan<=scan+1;reg [15:0] count=0;").replace("assign an=8'hfe","assign an=~(8'b1<<scan)");
      const state=await program(await build(rtl));active.push(state);assert.equal(state.status,'active');const op=identity();op.scope=state.identity.scope;
      const result=await node.dispatch({op:'hdl_interact',request:{identity:op,sessionId:state.sessionId,expectedSessionRevision:1,expectedSequence:1,inputs:{switches:'0'.repeat(16),buttons:'00000',resetN:'1'},advanceCycles:400}},true) as HdlOperationResult;
      assert.equal(result.finalFrame.anodes,'11111110');assert.equal(result.sampleCount,400);assert.equal(result.coverage,'incomplete');assert(result.droppedFrames>0);
      assert(result.frames.some(frame=>frame.anodes==='11111101'));await node.dispatch({op:'hdl_stop',identity:state.identity},true);
    });
    await t.test('a zero-time loop cannot progress and is terminated, not reported as a successful frame',async()=>{
      const rtl=source.replace('reg [15:0] count=0;','reg dead=0;initial forever dead=~dead;reg [15:0] count=0;');
      const state=await program(await build(rtl));active.push(state);assert.notEqual(state.status,'active');
      const stopped=await node.dispatch({op:'hdl_stop',identity:state.identity},true) as HdlSession;assert(stopped.terminationConfirmed);
      assert.equal(await node.dispatch({op:'hdl_result',identity:state.identity,operationId:state.sessionId},true),null);
    });
  }finally{for(const state of active)try{await node.dispatch({op:'hdl_stop',identity:state.identity},true);}catch{}}
});
