import type {AluBinding,HdlAluCheck} from '../../contracts/runner/alu.ts';
import {aluBindingHash,aluVersions,type AluElaboration} from '../../runner/alu-check.ts';

const names=['A','B','Cin','M','S','F','Cout'] as const;
export const binding:AluBinding={versionId:'synthetic-binding-v1',references:Object.fromEntries(names.map(signal=>
  [signal,[{instanceSegments:['unit'],signal,offset:0,width:signal==='A'||signal==='B'||signal==='F'?4:signal==='S'?2:1}]])) as AluBinding['references'],
  switchMapping:[{semantic:'operand_a',offset:0,width:4},{semantic:'operand_b',offset:4,width:4},{semantic:'mode',offset:8,width:1},
    {semantic:'select',offset:9,width:2},{semantic:'carry_in',offset:11,width:1}]};
export const elaboration:AluElaboration={complete:true,instances:[{instanceSegments:['unit'],ports:names.map(name=>({name,direction:name==='F'||name==='Cout'?'output':'input',
  width:name==='A'||name==='B'||name==='F'?4:name==='S'?2:1,left:name==='A'||name==='B'||name==='F'?3:name==='S'?1:0,right:0}))}]};
export const request:HdlAluCheck={identity:{id:'check',commandId:'command',requestHash:'a'.repeat(64),recoveryGeneration:'generation',
  scope:{courseId:'synthetic-course',studentId:'synthetic-student',attemptId:'attempt',activityVersionId:'activity'}},buildId:'build',artifactHash:'b'.repeat(64),
  snapshotId:'snapshot',snapshotHash:'c'.repeat(64),configurationHash:'d'.repeat(64),binding,bindingHash:aluBindingHash(binding),ruleVersionId:aluVersions.rule,
  validatorVersion:aluVersions.validator,vectorSetHash:aluVersions.vectorSetHash,samplingProfileVersion:aluVersions.sampling,runtimeProfileVersion:'runtime',
  engineVersion:'iverilog-12',buildImage:'sha256:'+'e'.repeat(64),runtimeImage:'sha256:'+'f'.repeat(64),sourceHash:'0'.repeat(64)};
