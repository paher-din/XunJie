import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';

const [source,probePath,output]=process.argv.slice(2);
const hash=text=>createHash('sha256').update(text).digest('hex');
const read=path=>JSON.parse(readFileSync(join(source,path),'utf8'));
const probe=JSON.parse(readFileSync(probePath,'utf8'));
const records=[['docs/tasks/evidence/i0-c-revalidation/verification.json','validation','c'],
  ['docs/tasks/evidence/i0-c-revalidation/hdl-current.json','record','hdl']];
const evidence={date:'2026-10-15',currentIntegration:'37b628b75ec3a2238b9b77c8bd1882d36a2e55a6',probeHash:hash(readFileSync(probePath)),records:[]};
for(const [path,field,kind] of records){const r=read(path),current=probe[kind].data;
  assert.equal(current.ready,true);assert.equal(current.validation.fingerprintHash,r[field].fingerprintHash);
  const logs=[];for(const log of r.logs){assert.equal(hash(log.output),log.outputHash);if(log.bytes!==undefined)assert.equal(Buffer.byteLength(log.output),log.bytes);
    const registration=r[field].evidence.find(x=>x.suite===log.suite);
    if(registration)assert.equal(registration.outputHash,log.outputHash);
    logs.push({suite:log.suite,command:log.command,exitCode:log.exitCode,outputHash:log.outputHash,bytes:log.bytes,
      tests:log.tests,pass:log.pass,fail:log.fail,cancelled:log.cancelled,skipped:log.skipped});}
  evidence.records.push({path,fileHash:hash(readFileSync(join(source,path))),sourceCommit:r.sourceCommit,environment:r.environment,
    registeredFingerprint:r[field].fingerprintHash,validatedAt:current.validation.validatedAt,currentSourceHash:current.fingerprint.sourceHash,
    decision:'Reuse for unchanged deployed node only; current app seams tested separately. H3 source is not deployed or validated.',logs});
}
if(process.platform==='win32'){
  evidence.nodeSourceChanges=execFileSync('git',['diff','--name-only','cde69cc','37b628b','--','apps/teaching/runner','apps/teaching/contracts/runner'],{cwd:source,encoding:'utf8'}).trim().split('\n');
  const unchanged=['docker.ts','docker.runtime.test.ts','control.ts','control.test.ts','course.ts','verify.ts','hdl-profile.ts','hdl.runtime.test.ts','node.rpc.test.ts'];
  for(const file of unchanged)assert.equal(execFileSync('git',['diff','cde69cc','37b628b','--','apps/teaching/runner/'+file],{cwd:source,encoding:'utf8'}),'');
  evidence.unchangedCoreFiles=unchanged;
}
writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({passed:true,records:evidence.records.length,output}));
