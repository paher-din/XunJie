import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const enabled = process.platform === 'linux' && process.env.XUNJIE_C1_SSH === '1';
const exec = promisify(execFile);
const base = process.env.XUNJIE_C1_HOST_BASE ?? '/opt/xunjie-runner/vm';
const options = (role: string) => ['-i', `${base}/keys/${role}`, '-o', `UserKnownHostsFile=${base}/keys/known_hosts`,
  '-o', 'StrictHostKeyChecking=yes', '-o', 'BatchMode=yes', '-p', '2222', 'root@127.0.0.1'];
function ssh(command: string, input = '', role = 'maintenance'): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile('/usr/bin/ssh', [...options(role), command], { timeout: 90000, maxBuffer: 2 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(stdout));
    child.stdin!.on('error', () => {}); child.stdin!.end(input);
  });
}
test('dedicated VM: real C/HDL syntax only, UTF-16, preemption, tmpfs cleanup and unchanged original readiness', { skip: !enabled, timeout: 120000 }, async () => {
  const nodeConfig = process.env.XUNJIE_EDITOR_NODE_CONFIG;
  assert(nodeConfig?.startsWith('/opt/xunjie-runner/') && nodeConfig.endsWith('.json'), 'Explicit non-secret node configuration path required');
  const readiness = async (op: string) => JSON.parse(await ssh('xunjie-c1', JSON.stringify({ op }), 'application')).data;
  const before = [await readiness('readiness'), await readiness('hdl_readiness')];
  assert(before.every(item => item.ready === true));
  const directory = '/opt/xunjie-runner/tests/editor-diagnostics-' + randomUUID();
  await ssh(`mkdir -p ${directory}/runner`);
  const archive = await exec('/usr/bin/tar', ['-cf', '-', 'runner/editor-diagnostics.ts', 'runner/docker.ts', 'runner/snapshot.ts',
    'runner/node-files.ts', 'runner/editor-diagnostics-service.ts', 'runner/editor-diagnostics-entry.ts'],
    { encoding: 'buffer', maxBuffer: 1024 * 1024 });
  // Base64 avoids the SSH text wrapper corrupting the archive; no source or credential is logged.
  await ssh(`base64 -d | tar -xf - -C ${directory}`, archive.stdout.toString('base64'));
  const result = await ssh('/opt/xunjie-runner/node/bin/node --input-type=module', String.raw`
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {existsSync} from 'node:fs';
import {spawn,execFile} from 'node:child_process';
import {EditorDiagnosticsNode} from '${directory}/runner/editor-diagnostics.ts';
import {DockerExecutor} from '${directory}/runner/docker.ts';
import {manifestHash,sha256} from '${directory}/runner/snapshot.ts';
const config=JSON.parse(readFileSync(${JSON.stringify(nodeConfig)},'utf8'));
const executor=new DockerExecutor(config.dockerBinary,config.dockerSocket,config.cliConfig);
const node=new EditorDiagnosticsNode(executor,{c:config.profile.compilerImage,hdl:config.hdl.buildImage});
const packet=(language,text,extra=[])=>{
 const files=[{fileId:'source',path:language==='c'?'main.c':'top.sv',documentVersion:1,text,contentHash:sha256(text)},...extra];
 return {recoveryGeneration:${JSON.stringify(before[0].recoveryGeneration)},scope:{userId:'isolated-syntax',courseId:'isolated',attemptId:'isolated'},
  fileId:'source',language,snapshot:{snapshotId:'ephemeral',hashFormat:'sha256-manifest-v1',hash:manifestHash(files),files}};
};
const findings=[];
for(const [language,text,bad] of [
 ['c','int main(void) { for (;;) {} }',false],
 ['c','/* 中文😀 */ int value = ;',true],
 ['c','\ufeff/* 中文😀 */ int value = ;\r\n',true],
 ['hdl','module top; wire led = 1; endmodule',false],
 ['hdl','module top; wire led = ; endmodule',true],
]){
 const result=await node.analyze(packet(language,text));
 assert.equal(result.status,'ready',JSON.stringify(result));
 assert.equal(result.diagnostics.some(item=>item.severity==='error'),bad,JSON.stringify(result));
 if(language==='c'&&bad)assert.equal(result.diagnostics[0].range.startColumn,text.indexOf(';')+1);
 if(language==='hdl'&&bad)assert.equal(result.diagnostics[0].line,1);
 findings.push({language,bad,status:result.status,count:result.diagnostics.length});
}
const header='typedef int Word;';
const multi=await node.analyze(packet('c','#include "types.h"\nWord count;',[
 {fileId:'header',path:'types.h',documentVersion:1,text:header,contentHash:sha256(header)}]));
assert.equal(multi.status,'ready');assert.equal(multi.diagnostics.length,0);
const first=node.analyze(packet('c','int n;'));
assert.equal((await node.analyze(packet('hdl','module top; endmodule'))).status,'busy');
await node.preempt();assert.equal((await first).status,'busy');
assert.equal(await executor.command(['ps','-a','--filter','label=xunjie.editor=true','--format','{{.ID}}']),'');
const socket='${directory.replace('/opt/xunjie-runner/tests/', '/run/')}.sock';
const service=spawn(config.node,['${directory}/runner/editor-diagnostics-service.ts',${JSON.stringify(nodeConfig)},socket],{stdio:['ignore','ignore','pipe']});
let serviceError='';service.stderr.on('data',chunk=>serviceError+=chunk);
const relay=request=>new Promise((resolve,reject)=>{
 const child=execFile(config.node,['${directory}/runner/editor-diagnostics-entry.ts',socket,config.source+'/ssh-control.ts'],
  {env:{...process.env,SSH_ORIGINAL_COMMAND:'xunjie-c1'},timeout:30000,maxBuffer:131072},(error,stdout)=>{
   if(error&&!stdout){reject(error);return;}try{resolve(JSON.parse(stdout));}catch{reject(new Error('Invalid entry response'));}
  });child.stdin.end(JSON.stringify(request));
});
try{
 for(let i=0;i<100&&!existsSync(socket)&&service.exitCode===null;i++)await new Promise(r=>setTimeout(r,20));
 assert(existsSync(socket),'Diagnostic service did not start: '+serviceError);
 const original=await relay({op:'readiness'});assert.equal(original.data.ready,true);
 const analyzed=await relay({op:'editor_diagnostics',packet:packet('c','int n = ;')});
 assert.equal(analyzed.data?.status,'ready',JSON.stringify(analyzed));assert.equal(analyzed.data.diagnostics[0].severity,'error');
 const unicode=await relay({op:'editor_diagnostics',packet:packet('c','/* '+'中文😀'.repeat(10000)+' */ int n;')});
 assert.equal(unicode.data?.status,'ready',JSON.stringify(unicode));assert.equal(unicode.data.diagnostics.length,0);
 const hdl=await relay({op:'editor_diagnostics',packet:packet('hdl','module top; wire led = ; endmodule')});
 assert.equal(hdl.data?.status,'ready',JSON.stringify(hdl));assert.equal(hdl.data.diagnostics[0].line,1);
 assert.equal((await relay({op:'editor_diagnostics',packet:{...packet('c','int n;'),recoveryGeneration:'old-generation'}})).error.code,'RECOVERY_REQUIRED');
 assert.equal((await relay({op:'recover'})).error.code,'FORBIDDEN');
}finally{service.kill('SIGTERM');await new Promise(resolve=>service.once('close',resolve));}
assert.equal(await executor.command(['ps','-a','--filter','label=xunjie.editor=true','--format','{{.ID}}']),'');
console.log(JSON.stringify({findings,multifile:true,preemption:true,restrictedRelay:true,noRemainingDiagnosticContainers:true}));
`);
  const report = JSON.parse(result.trim());
  assert.equal(report.findings.length, 5); assert.equal(report.noRemainingDiagnosticContainers, true);
  const after = [await readiness('readiness'), await readiness('hdl_readiness')];
  assert(after.every(item => item.ready === true));
  assert.deepEqual(after.map(item => item.fingerprint), before.map(item => item.fingerprint));
});
