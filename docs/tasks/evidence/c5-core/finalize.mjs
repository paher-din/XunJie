import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {join} from 'node:path';

const root=process.argv[2],hash=value=>createHash('sha256').update(value).digest('hex');
const read=name=>JSON.parse(readFileSync(join(root,name),'utf8'));
const before=read('runtime-before.json'),after=read('runtime-after.json'),real=read('real-fourth.json');
assert.equal(real.passed,true);assert.equal(real.checks.length,6);
assert.equal(real.modelCalls,0);assert.equal(real.browser,'not executed');
for(const kind of ['c','hdl'])assert.deepEqual(before[kind],after[kind]);
const files=[];
for(const name of ['targeted.tap','typecheck.txt','build.txt']){
  const raw=readFileSync(join(root,name)),display=raw.toString('utf8').split(/\r?\n/).map(x=>x.trimEnd()).join('\n').trimEnd()+'\n';
  writeFileSync(join(root,name+'.gz'),gzipSync(raw),{flag:'wx'});writeFileSync(join(root,name),display);
  files.push({path:name,originalArchive:name+'.gz',originalHash:hash(raw),displayHash:hash(display),displayChange:'Only trailing whitespace/EOF blank lines'});
}
const tap=readFileSync(join(root,'targeted.tap'),'utf8');
for(const line of ['# tests 73','# pass 71','# fail 0','# cancelled 0','# skipped 2'])assert(tap.includes(line));
const summary={sourceCommit:real.sourceCommit,date:'2026-10-15',node:real.node,applicationEvidence:'real-fourth.json',
  applicationEvidenceHash:hash(readFileSync(join(root,'real-fourth.json'))),applicationScope:real.scope,checks:real.checks.map(x=>x.name),
  publicHttpResponses:real.http.length,models:0,browser:'NOT_EXECUTED',typecheck:'PASS',build:'PASS',
  targeted:{tests:73,pass:71,fail:0,cancelled:0,skipped:2,skipReason:'Real C1 runtime gates were disabled in this offline suite; fresh actual-node app chain is separately recorded.'},
  nodeFingerprintUnchanged:true,cFingerprint:after.c.data.validation.fingerprintHash,hdlFingerprint:after.hdl.data.fingerprintHash,
  nodeSourceHash:after.hdl.data.fingerprint.sourceHash,recoveryGeneration:after.hdl.data.recoveryGeneration,
  preparationFailures:[{round:1,reason:'Finally tried PRAGMA through SELECT/INSERT/UPDATE-only transaction; rejected. No result file was saved; no pass claimed.'},
    {round:2,evidence:'real-second.json',reason:'Synthetic blueprint omitted project and ai_collaboration goals; product correctly refused checks.'},
    {round:3,evidence:'real-third.json',reason:'Harness compared snapshotHash on outer Build projection; actual public contract stores it under result.'}],
  sourceChanges:[],deferred:['HDL actual browser display and full error→repair→reload flow (UI/P5)','H3 image/node deployment and 2800-vector trusted course_check',
    'Full load/performance distribution, large fault matrix, long stability, complete backup restore/export/RPO/RTO','Real-model semantic/teacher review, actual learners and teaching effectiveness'],
  retained:'Fresh synthetic databases and stopped container/ledger facts remain; no deletion, old database migration, key/config change or model request.',files};
writeFileSync(join(root,'summary.json'),JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
const manifest=[];for(const name of readdirSync(root).sort()){const bytes=readFileSync(join(root,name));manifest.push({path:name,bytes:bytes.length,sha256:hash(bytes)});}
writeFileSync(join(root,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({passed:true,files:manifest.length,checks:summary.checks.length}));
