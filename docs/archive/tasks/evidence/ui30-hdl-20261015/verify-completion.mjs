import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {compareRefresh,verifyEvidence} from '../../../../tools/i0-hdl/verify-local-browser-evidence.mjs';

// Rechecks archived public facts, not a new browser, engine or model run.
const read=name=>JSON.parse(readFileSync(new URL(name,import.meta.url),'utf8'));
const data=read('browser-completion-after.json');
const base=verifyEvidence(data,{requireSettled:true});
assert.equal(base.status,'settled-consistent');
const build=data.builds.find(x=>x.build_id==='d8174bc9-ac86-4a9f-928f-e5692aa567e3');
assert.equal(build.status,'succeeded');
assert.equal(build.request_json.snapshot.snapshotId,'6d0ed106-5b29-4603-98d5-1fef95ac3914');
const verilog=build.request_json.snapshot.files.find(x=>x.path==='helper.v');
assert.equal(verilog.text,'module evidence_helper(input wire a, output wire y);\nassign y = a;\nendmodule\n');
assert.equal(verilog.documentVersion,1);
assert.ok(build.request_json.snapshot.files.some(x=>x.path==='top.sv'));
const session='0d8b34a8-bc2a-4780-bc60-3218c200bc26';
assert.equal(data.sessions.find(x=>x.session_id===session).build_id,build.build_id);
const operations=data.operations.filter(x=>x.session_id===session);
const observations=read('browser-all16-observations.json').observations;
assert.equal(observations.length,32);
for(let bit=0;bit<16;bit++)for(const on of [true,false]){
  const sequence=2*bit+(on?1:2);
  const mask=on?(1<<bit).toString(2).padStart(16,'0'):'0000000000000000';
  const led=on&&bit===1?'xxxxxxxxzzzzzzzz':mask;
  const op=operations.find(x=>x.sequence===sequence);
  assert.ok(op);assert.equal(op.status,'succeeded');
  assert.deepEqual(op.request_json.inputs,{switches:mask,buttons:'00000',resetN:'1'});
  assert.equal(op.result_json.finalFrame.switches,mask);
  assert.equal(op.result_json.finalFrame.leds,led);
  assert.equal(op.result_json.finalFrame.simTimePs,String(sequence*10000));
  const dom=observations.find(x=>x.bit===bit&&x.on===on)?.dom;
  assert.ok(dom?.includes(`LED=${led}`));
  assert.ok(dom.includes(`操作序号 ${sequence} · 模拟时间 ${sequence*10000} ps`));
}
const before=read('browser-peer-short-before.json'),after=read('browser-peer-short-after.json');
const peer=compareRefresh(before,after);assert.equal(peer.status,'unchanged');
assert.deepEqual(before.commandReceipts,after.commandReceipts);
const pair=read('browser-peer-short-before-dom.json');
assert.ok(pair.primary.includes('操作序号 1 · 模拟时间 10000 ps'));
assert.ok(pair.peer.includes('操作序号 0 · 模拟时间 0 ps'));
const blocked=read('browser-peer-short-after-dom.json').dom;
assert.ok(blocked.includes('原会话已改变、正在处理或已停止，请重新读取'));
assert.ok(blocked.includes('LED=0000000100000000'));
const retry=data.operations.find(x=>x.operation_id==='16235ed5-73b7-42e0-b8eb-d4535abaebe0');
assert.equal(retry.result_json.finalFrame.switches,'0000000100000001');
assert.equal(retry.result_json.finalFrame.leds,'0000000100000001');
const action=data.actions.find(x=>x.job_id==='765530ca-367c-4ca1-b496-d5365584cdff');
const hdl=action.action_json.basis.hdl;
assert.equal(hdl.snapshotId,build.snapshot_id);assert.equal(hdl.buildId,build.build_id);
assert.equal(hdl.sessionId,'c69decae-f4c2-4cc3-9fa3-0138d30ca22c');
assert.equal(hdl.operationId,retry.operation_id);assert.equal(hdl.resultHash,retry.result_json.resultHash);
assert.equal(hdl.confirmedSequence,2);assert.equal(hdl.simTimePs,'20000');
assert.equal(action.disposition,'stale');
const receipts=data.teachingReceipts.filter(x=>x.action_id===action.action_id);
assert.ok(receipts.some(x=>x.receipt_kind==='received'));
assert.ok(!receipts.some(x=>['displayed','acknowledged'].includes(x.receipt_kind)));
assert.ok(data.sessions.every(x=>x.termination_confirmed===1));
const result={status:'verified',verilogSnapshot:hdl.snapshotId,switchOnOffCases:32,
  stalePeer:{nineObjectGroupsUnchanged:true,commandReceiptsUnchanged:true,explicitRetryPreservesSW8:true},
  boardHelp:{jobId:action.job_id,basisMatches:true,finalDisposition:action.disposition,displayed:false,acknowledged:false},
  globalCounts:base.counts,boundary:'Archived public consistency only; screenshots/operation records supply browser evidence. Global totals include other C-side activity and are not all attributed to this UI supplement.'};
writeFileSync(fileURLToPath(new URL('completion-audit-result.json',import.meta.url)),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify(result,null,2));
