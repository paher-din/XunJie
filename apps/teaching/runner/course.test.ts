import assert from 'node:assert/strict';
import {test} from 'node:test';
import {courseChecks} from './course.ts';
import {manifestHash,sha256} from './snapshot.ts';
import {matchesStdout} from './stdout-records.ts';
import {verifyCase} from './verify.ts';

const files=[{fileId:'input',path:'a space.txt',documentVersion:1,text:'C c!\nMemory matters.',contentHash:sha256('C c!\nMemory matters.')}];
const snapshot={snapshotId:'synthetic',hashFormat:'sha256-manifest-v1' as const,hash:manifestHash(files),files};
test('course rules bind selected snapshot inputs, records and approved error exits',()=>{
  const cases=courseChecks(snapshot,{operation:'stats',fileIds:['input']},'textscope-core-v1');
  assert.equal(cases.length,6);
  assert.deepEqual(cases.map(item=>item.rule.expectedExitCode),[0,2,2,2,2,1]);
  assert(matchesStdout('/snapshot/a space.txt\t2\t4\t20\nTOTAL\t2\t4\t20\n',cases[0]!.rule.stdoutRecords!));
  assert(!matchesStdout('other/a space.txt\t2\t4\t20\nTOTAL\t2\t4\t20\n',cases[0]!.rule.stdoutRecords!));
  const find=courseChecks(snapshot,{operation:'find',word:'c',fileIds:['input']},'textscope-core-v1');
  assert(matchesStdout('a space.txt:1:C c!\n',find[0]!.rule.stdoutRecords!));
  assert(!matchesStdout('a space.txt:1:c c!\n',find[0]!.rule.stdoutRecords!));
  const top=courseChecks(snapshot,{operation:'top',count:'1',fileIds:['input']},'textscope-core-v1');
  assert(matchesStdout('c 2\n',top[0]!.rule.stdoutRecords!));
  assert(!matchesStdout('passed\n',top[0]!.rule.stdoutRecords!));
});
test('invalid course selection and profile cannot reach trusted oracle',()=>{
  assert.throws(()=>courseChecks(snapshot,{operation:'stats',fileIds:['missing']},'textscope-core-v1'),/approved/);
  assert.throws(()=>courseChecks(snapshot,{operation:'stats',fileIds:['input']},'textscope-report-v1'),/version/);
  const report=courseChecks(snapshot,{operation:'report',fileIds:['input'],resultFile:'report.txt'},'textscope-report-v1');
  assert.equal(report[0]!.rule.expectedReport?.expectation.files[0]!.path,'a space.txt');
});
test('missing input case avoids every snapshot file and implied directory without reserving names',()=>{
  const collisionFiles=[...files,...['__xunjie_missing_input__','__xunjie_missing_input__.1/child.txt'].map((path,index)=>({
    fileId:`collision-${index}`,path,documentVersion:1,text:'legal student file',contentHash:sha256('legal student file')}))];
  const collided={...snapshot,files:collisionFiles,hash:manifestHash(collisionFiles)};
  const missing=courseChecks(collided,{operation:'stats',fileIds:['input']},'textscope-core-v1').at(-1)!;
  const path=missing.args[1]!.slice('/snapshot/'.length);
  assert(!collisionFiles.some(file=>file.path===path||file.path.startsWith(path+'/')));
  assert.equal(missing.rule.expectedExitCode,1);
  assert.equal(verifyCase('check',{phase:'execute',containerId:'synthetic',exitCode:1,stdout:'',stderr:'cannot open\n',
    outputBytes:12,durationMs:1,unitTerminated:true},missing.rule)?.verdict,'passed');
});
test('overflow is a trusted exit-2 case and maximum normal N still covers all words',()=>{
  assert.throws(()=>courseChecks(snapshot,{operation:'top',fileIds:['input'],count:'9'.repeat(100)},'textscope-core-v1'),/positive integer/);
  const cases=courseChecks(snapshot,{operation:'top',fileIds:['input'],count:'2147483647'},'textscope-core-v1');
  assert(matchesStdout('c 2\nmatters 1\nmemory 1\n',cases[0]!.rule.stdoutRecords!));
  const overflow=cases.find(item=>item.args[0]==='top'&&item.args[2]==='2147483648');
  assert(overflow,'Overflow sample must be independently checked');
  assert.equal(verifyCase('check',{phase:'execute',containerId:'synthetic',exitCode:2,stdout:'',stderr:'usage\n',
    outputBytes:6,durationMs:1,unitTerminated:true},overflow.rule)?.verdict,'passed');
});
