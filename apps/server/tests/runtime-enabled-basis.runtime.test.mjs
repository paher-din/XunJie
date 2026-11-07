import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { aluCoursePackage } from '../../../components/alu-experiment/package.mjs';
import { verifyEnabledRuntimeSource, verifyAluCasePriorSource } from '../../../packages/learning-space/dist/learning-data/runtime-basis.js';

const course = await aluCoursePackage();
const binding = course.release.components[0];
const scope = Object.fromEntries(['environmentId','spaceId','principalId','activityId'].map(key => [key, randomUUID()]));
const source = { protocolVersion:3, requestId:randomUUID(), scope, execution:{
  instance:{ instanceId:`${scope.activityId}:alu`,key:'alu',definitionDigest:binding.definition.digest },
  operation:{operationId:'run-single'}, parameters:{A:15,B:1,M:1,S:0,Cin:0}, basis:{
    works:[{kind:'code',contentId:randomUUID(),name:'alu.sv',value:'module alu; endmodule'}],
    runtime:binding.definition.manifest.runtime,compile:binding.definition.manifest.runtime.operations[0].compile,
    course:{releaseId:course.release.releaseId} } } };
const confirmed = { requestId:source.requestId,inputDigest:createHash('sha256').update(JSON.stringify(source)).digest('hex'),
  executionRef:randomUUID(),state:'succeeded',statusKnowledge:'confirmed',
  output:{output:{f:'xxxx',cout:'x',observationState:'complete-with-unknown'}} };
const action = structuredClone(source);
action.requestId=randomUUID(); action.execution.operation.operationId='check-all';
action.execution.basis.enabledBy={requestId:source.requestId,inputDigest:confirmed.inputDigest,executionRef:confirmed.executionRef};

test('enabled source accepts a retained complete four-state explicit run',()=>{
  assert.doesNotThrow(()=>verifyEnabledRuntimeSource(action,source,confirmed));
});
test('enabled source rejects absent, unconfirmed, failed or incomplete runs',()=>{
  assert.throws(()=>verifyEnabledRuntimeSource(action,undefined,undefined));
  for(const change of [{state:'failed'},{statusKnowledge:'unknown'},{output:null},
    {output:{output:{f:'0000',cout:'0',observationState:'incomplete'}}}]) {
    assert.throws(()=>verifyEnabledRuntimeSource(action,source,{...confirmed,...change}));
  }
});
test('enabled source rejects forged identity, source kind and changed HDL or tool versions',()=>{
  for(const mutate of [a=>a.execution.basis.enabledBy.executionRef=randomUUID(),
    a=>a.scope.principalId=randomUUID(),a=>a.execution.instance.definitionDigest='different',
    a=>a.execution.basis.works[0].value='different',a=>a.execution.basis.runtime.adapterVersion=99]) {
    const forged=structuredClone(action); mutate(forged);
    assert.throws(()=>verifyEnabledRuntimeSource(forged,source,confirmed));
  }
  const otherSource=structuredClone(source);otherSource.execution.operation.operationId='observe-enabled';
  assert.throws(()=>verifyEnabledRuntimeSource(action,otherSource,confirmed));
});

test('case sources must name a real retained observation of the same code bytes and input',()=>{
  const comparison=structuredClone(action);comparison.execution.operation.operationId='observe-enabled';
  const prior={requestId:source.requestId,inputDigest:confirmed.inputDigest,executionRef:confirmed.executionRef,kind:'same-input-observation'};
  assert.doesNotThrow(()=>verifyAluCasePriorSource(comparison,prior,source,confirmed));
  const copied=structuredClone(source);copied.execution.basis.works[0].contentId=randomUUID();
  assert.doesNotThrow(()=>verifyAluCasePriorSource(comparison,prior,copied,confirmed));
  for(const changed of [{...prior,inputDigest:'0'.repeat(64)},{...prior,executionRef:randomUUID()},{...prior,kind:'work-check'}])
    assert.throws(()=>verifyAluCasePriorSource(comparison,changed,source,confirmed));
  const otherInput=structuredClone(source);otherInput.execution.parameters.A=14;
  assert.throws(()=>verifyAluCasePriorSource(comparison,prior,otherInput,confirmed));
  const otherStudent=structuredClone(source);otherStudent.scope.principalId=randomUUID();
  assert.throws(()=>verifyAluCasePriorSource(comparison,prior,otherStudent,confirmed));
  assert.throws(()=>verifyAluCasePriorSource(comparison,prior,source,{...confirmed,statusKnowledge:'unknown'}));
});
