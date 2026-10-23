import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';

// Run on the prepared dedicated Linux VM with Node 24. Uses a fresh synthetic
// ledger; it does not create an Attempt or perform a student's browser action.
const originalPath=process.argv[2];
assert.ok(originalPath,'usage: node run.mjs <approved-node-config.json>');
const original=JSON.parse(readFileSync(originalPath,'utf8'));
const evidenceDir=mkdtempSync(join(tmpdir(),'xunjie-alu-current-node-'));
const config={...original,state:join(evidenceDir,'state')};
const configPath=join(evidenceDir,'config.json');
writeFileSync(configPath,JSON.stringify(config),{flag:'wx',mode:0o600});
const load=async file=>import(pathToFileURL(join(config.source,file)).href);
const {HdlNode}=await load('hdl-node.ts');
const {sha256,manifestHash}=await load('snapshot.ts');
const {board}=await import(pathToFileURL(join(config.source,'../tests/fixtures/hdl-board.ts')).href);
const node=new HdlNode(config,configPath,()=>config.generation);
const scope={courseId:'synthetic-alu-check',studentId:'synthetic-alu-check',
  attemptId:randomUUID(),activityVersionId:'synthetic-alu-check'};
const identity=()=>({id:randomUUID(),commandId:randomUUID(),requestHash:sha256(randomUUID()),
  recoveryGeneration:config.generation,scope});
const source=`module top(input clk,input [15:0] sw,input [4:0] btn,
output [15:0] led,output reg [7:0] an,output reg [6:0] seg,output dp);
reg [4:0] alu; reg [1:0] scan=0; reg [3:0] digit;
always @(posedge clk) scan<=scan+1;
always @* begin
  alu=0;
  if(sw[8]) case(sw[10:9])
    2'b00: alu={1'b0,sw[3:0]}+{1'b0,sw[7:4]}+sw[11];
    2'b01: if(sw[3:0]>sw[7:4]) alu=sw[3:0]-sw[7:4]-sw[11]; else alu=5'bxxxxx;
    default: alu=5'bxxxxx;
  endcase else case(sw[10:9])
    2'b00: alu={1'b0,~sw[3:0]}; 2'b01: alu={1'b0,sw[3:0]&sw[7:4]};
    2'b10: alu={1'b0,sw[3:0]|sw[7:4]}; 2'b11: alu={1'b0,sw[3:0]^sw[7:4]};
  endcase
  case(scan) 0:begin an=8'hfe;digit=sw[3:0];end 1:begin an=8'hfd;digit=sw[7:4];end
    2:begin an=8'hfb;digit=alu[3:0];end 3:begin an=8'hf7;digit={3'b0,alu[4]};end endcase
  case(digit) 0:seg=7'b1000000;1:seg=7'b1111001;2:seg=7'b0100100;3:seg=7'b0110000;
    4:seg=7'b0011001;5:seg=7'b0010010;6:seg=7'b0000010;7:seg=7'b1111000;
    8:seg=7'b0000000;9:seg=7'b0010000;10:seg=7'b0001000;11:seg=7'b0000011;
    12:seg=7'b1000110;13:seg=7'b0100001;14:seg=7'b0000110;15:seg=7'b0001110;
    default:seg=7'bxxxxxxx;endcase
end
assign led={11'b0,alu};assign dp=1'b1;endmodule
`;
const file={fileId:'synthetic-top',path:'top.sv',documentVersion:1,text:source,contentHash:sha256(source)};
const buildId=identity();
const request={identity:buildId,snapshot:{snapshotId:randomUUID(),hashFormat:'sha256-manifest-v1',
  files:[file],hash:manifestHash([file])},board,runtimeProfileVersion:config.hdl.runtimeProfileVersion};
let session;
const results=[];
try{
  await node.dispatch({op:'hdl_build',request},true);
  let build;
  for(let i=0;i<600;i++){
    build=await node.dispatch({op:'hdl_query',identity:buildId},true);
    if(!['queued','running'].includes(build.status))break;
    await delay(50);
  }
  assert.equal(build.status,'succeeded',JSON.stringify(build));
  assert.equal(build.terminationConfirmed,true);
  const programId=identity();
  await node.dispatch({op:'hdl_program',request:{identity:programId,buildId:build.buildId}},true);
  for(let i=0;i<600;i++){
    session=await node.dispatch({op:'hdl_query',identity:programId},true);
    if(session.status!=='starting')break;
    await delay(50);
  }
  assert.equal(session.status,'active',JSON.stringify(session));
  for(const [switches,expectedLed,digits] of [
    [0x0943,8,['0110000','0011001','0000000','1000000']],
    [0x0635,6,['0010010','0110000','0000010','1000000']]
  ]){
    const input=switches.toString(2).padStart(16,'0');
    const result=await node.dispatch({op:'hdl_interact',request:{identity:identity(),
      sessionId:session.sessionId,expectedSessionRevision:session.sessionRevision,
      expectedSequence:session.confirmedSequence+1,
      inputs:{switches:input,buttons:'00000',resetN:'1'},advanceCycles:4}},true);
    assert.equal(result.finalFrame.leds,expectedLed.toString(2).padStart(16,'0'));
    assert.equal(result.finalFrame.switches,input);
    assert.equal(result.finalFrame.dp,'1');
    assert.equal(result.coverage,'complete');
    assert.equal(result.droppedFrames,0);
    for(const [index,an] of ['11111110','11111101','11111011','11110111'].entries())
      assert.ok(result.frames.some(frame=>frame.anodes===an&&frame.segments===digits[index]),
        `missing ALU digit ${index} for ${input}`);
    results.push({switches:input,leds:result.finalFrame.leds,anodesAndSegments:result.frames.map(
      frame=>[frame.anodes,frame.segments]),sequence:result.sequence,coverage:result.coverage});
    session=await node.dispatch({op:'hdl_query',identity:programId},true);
  }
  session=await node.dispatch({op:'hdl_stop',identity:programId},true);
  assert.equal(session.terminationConfirmed,true);
  console.log(JSON.stringify({passed:true,evidenceDir,buildStatus:build.status,
    buildTerminationConfirmed:build.terminationConfirmed,sessionStatus:session.status,
    sessionTerminationConfirmed:session.terminationConfirmed,results}));
}finally{
  if(session&&!session.terminationConfirmed)
    await node.dispatch({op:'hdl_stop',identity:session.identity},true);
}
