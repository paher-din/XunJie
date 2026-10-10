import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, chownSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { DockerExecutor } from './docker.ts';
import { collectResultFiles } from './result-files.ts';
import { compilerArgs, manifestHash, sha256 } from './snapshot.ts';
import { RunControl } from './control.ts';
import { buildRunWork, textScopeArgs } from './run-snapshot.ts';
import { setTimeout } from 'node:timers/promises';

const enabled = process.platform === 'linux' && process.env.XUNJIE_C1_RUNTIME === '1';
const compilerImage = 'sha256:9f14e671a09bc195b93ca39524b8dcf401bc832b0c520e462327ce94986799aa';
const runtimeImage = process.env.XUNJIE_C1_RUNTIME_IMAGE ?? '';

test('dedicated Linux synthetic container execution and resource checks', { skip: !enabled }, async t => {
  assert.match(runtimeImage, /^sha256:[0-9a-f]{64}$/, 'Set the recorded local runtime image ID explicitly');
  const executor = new DockerExecutor('/opt/xunjie-runner/engine/docker', '/run/xunjie-c1-docker.sock',
    '/opt/xunjie-runner/cli-config');
  mkdirSync('/opt/xunjie-runner/tests', { recursive: true, mode: 0o700 });

  async function fixture(text: string, executeTimeout = 10000, signal = new AbortController().signal,
    afterRuntimeCreate?: () => void) {
    const root = mkdtempSync('/opt/xunjie-runner/tests/run-');
    const sourceDirectory = join(root, 'snapshot');
    const workDirectory = join(root, 'work');
    mkdirSync(sourceDirectory, { mode: 0o755 });
    mkdirSync(workDirectory, { mode: 0o700 });
    execFileSync('/usr/bin/mount', ['-t', 'tmpfs', '-o', 'size=134217728,mode=0700,uid=65534,gid=65534,nosuid,nodev',
      'tmpfs', workDirectory]);
    mkdirSync(join(workDirectory, 'tmp'), { mode: 0o700 });
    chownSync(join(workDirectory, 'tmp'), 65534, 65534);
    writeFileSync(join(sourceDirectory, 'main.c'), text, { flag: 'wx', mode: 0o444 });
    writeFileSync(join(sourceDirectory, 'a.txt'), 'C is fun.\nC is fast.\nMemory matters.\n', { flag: 'wx', mode: 0o444 });
    chmodSync(sourceDirectory, 0o755);
    const inputText = 'C is fun.\nC is fast.\nMemory matters.\n';
    const files = [
      { fileId: 'f1', path: 'main.c', documentVersion: 1, text, contentHash: sha256(text) },
      { fileId: 'f2', path: 'a.txt', documentVersion: 1, text: inputText, contentHash: sha256(inputText) },
    ];
    const snapshot = { snapshotId: `synthetic-${randomUUID()}`, hashFormat: 'sha256-manifest-v1' as const,
      hash: manifestHash(files), files };
    const name = `xunjie-${randomUUID()}`;
    const ids: string[] = [];
    const inspectLimits = async (id: string) => {
      ids.push(id);
      const config = JSON.parse(await executor.command(['inspect', id]))[0];
      assert.equal(config.Config.User, '65534:65534');
      assert.equal(config.HostConfig.ReadonlyRootfs, true);
      assert.equal(config.HostConfig.Privileged, false);
      assert.equal(config.HostConfig.NanoCpus, 1000000000);
      assert.equal(config.HostConfig.Memory, 536870912);
      assert.equal(config.HostConfig.MemorySwap, 536870912);
      assert.equal(config.HostConfig.PidsLimit, 64);
      assert.equal(config.HostConfig.NetworkMode, 'none');
      assert.deepEqual(config.HostConfig.CapDrop, ['ALL']);
      assert(config.HostConfig.SecurityOpt.some((option: string) => option.startsWith('no-new-privileges')));
      assert.deepEqual(config.Mounts.map((mount: {Destination: string}) => mount.Destination).sort(),
        ['/dev/shm', '/snapshot', '/tmp', '/work']);
      assert.equal(config.Mounts.find((mount: {Destination: string}) => mount.Destination === '/snapshot').RW, false);
      if (config.Config.Entrypoint[0] === '/work/textscope') afterRuntimeCreate?.();
    };
    const compiled = await executor.execute({ phase: 'compile', name: `${name}-compile`, image: compilerImage,
      sourceDirectory, workDirectory, args: compilerArgs(snapshot, 'f1'), timeoutMs: 30000,
      outputBudget: 65536, signal: new AbortController().signal }, inspectLimits);
    assert.equal(compiled.exitCode, 0, compiled.stderr);
    assert.equal(compiled.unitTerminated, true);
    assert.equal(compiled.failureKind, undefined);
    const executed = await executor.execute({ phase: 'execute', name: `${name}-execute`, image: runtimeImage,
      sourceDirectory, workDirectory, args: [], timeoutMs: executeTimeout,
      outputBudget: 65536 - compiled.outputBytes, signal }, inspectLimits);
    return { compiled, executed, workDirectory, ids, root };
  }

  await t.test('fixed C17 static program runs non-root and can only read approved input', async () => {
    const { executed } = await fixture('#include <stdio.h>\n#include <unistd.h>\nint main(void){FILE *f=fopen("/snapshot/a.txt","r");printf("uid=%d input=%d\\n",getuid(),f!=NULL); if(f)fclose(f);return 0;}');
    assert.equal(executed.exitCode, 0);
    assert.equal(executed.stdout, 'uid=65534 input=1\n');
    assert.equal(executed.unitTerminated, true);
    assert.equal(executed.failureKind, undefined);
  });
  await t.test('stalled real GCC receives the fixed 30 second compile deadline', async () => {
    // A trusted fixture FIFO blocks GCC's include read, exercising its actual deadline.
    const root = mkdtempSync('/opt/xunjie-runner/tests/compile-deadline-');
    const sourceDirectory = join(root,'snapshot');const workDirectory = join(root,'work');
    mkdirSync(sourceDirectory,{mode:0o755});mkdirSync(workDirectory,{mode:0o755});
    execFileSync('/usr/bin/mount',['-t','tmpfs','-o','size=134217728,mode=0700,uid=65534,gid=65534,nosuid,nodev','tmpfs',workDirectory]);
    mkdirSync(join(workDirectory,'tmp'),{mode:0o700});chownSync(join(workDirectory,'tmp'),65534,65534);
    execFileSync('/usr/bin/mkfifo',['-m','666',join(workDirectory,'wait.h')]);
    const text='#include "/work/wait.h"\nint main(void){return 0;}';
    writeFileSync(join(sourceDirectory,'main.c'),text,{mode:0o444,flag:'wx'});
    const files=[{fileId:'source',path:'main.c',documentVersion:1,text,contentHash:sha256(text)}];
    const snapshot={snapshotId:'synthetic-stall',hashFormat:'sha256-manifest-v1' as const,hash:manifestHash(files),files};
    const result=await executor.execute({phase:'compile',name:`xunjie-${randomUUID()}`,image:compilerImage,
      sourceDirectory,workDirectory,args:compilerArgs(snapshot,'source'),timeoutMs:30000,outputBudget:65536,
      signal:new AbortController().signal},()=>{});
    assert.equal(result.failureKind,'timeout');assert.equal(result.unitTerminated,true);
    assert(result.durationMs>=30000&&result.durationMs<36000);
  });
  await t.test('root/source writes, Windows files, engine socket and external network are denied', async () => {
    const { executed } = await fixture('#include <stdio.h>\n#include <unistd.h>\n#include <sys/socket.h>\n#include <arpa/inet.h>\nint main(void){const char *p[]={"/snapshot/a.txt","/root.txt","/mnt/c/Windows/win.ini","/run/xunjie-c1-docker.sock"};for(int i=0;i<4;i++){FILE *f=fopen(p[i],i<2?"w":"r");if(f){fclose(f);return 10+i;}}int s=socket(AF_INET,SOCK_STREAM,0);struct sockaddr_in a={.sin_family=AF_INET,.sin_port=htons(443)};inet_pton(AF_INET,"1.1.1.1",&a.sin_addr);int n=connect(s,(struct sockaddr*)&a,sizeof a);close(s);puts(n<0?"denied":"connected");return n<0?0:20;}');
    assert.equal(executed.exitCode, 0);
    assert.equal(executed.stdout, 'denied\n');
  });
  await t.test('seccomp and no-new-privileges are effective; keys, verifier and other jobs are absent', async () => {
    const {executed}=await fixture('#define _GNU_SOURCE\n#include <stdio.h>\n#include <string.h>\n#include <unistd.h>\n#include <sys/syscall.h>\n#include <sched.h>\nint main(void){const char *p[]={"/opt/xunjie-runner/config.json","/opt/xunjie-runner/source/runner/course.ts","/opt/xunjie-runner/state/jobs","/opt/xunjie-runner/vm/keys/application","/bin/sh"};for(int i=0;i<5;i++)if(access(p[i],F_OK)==0)return 10+i;FILE *f=fopen("/proc/self/status","r");if(!f)return 2;char line[256];int sec=0,priv=0,cap=0;while(fgets(line,sizeof line,f)){if(!strcmp(line,"Seccomp:\\t2\\n"))sec=1;if(!strcmp(line,"NoNewPrivs:\\t1\\n"))priv=1;if(!strcmp(line,"CapEff:\\t0000000000000000\\n"))cap=1;}fclose(f);return sec&&priv&&cap&&syscall(SYS_unshare,CLONE_NEWUSER)<0?0:3;}');
    assert.equal(executed.exitCode,0,executed.stderr);assert.equal(executed.unitTerminated,true);
  });
  await t.test('execution timeout stops the complete container', async () => {
    const { executed } = await fixture('int main(void){for(;;){}return 0;}', 10000);
    assert.equal(executed.failureKind, 'timeout');
    assert.equal(executed.unitTerminated, true);
    assert(executed.durationMs >= 10000 && executed.durationMs < 16000);
    assert.deepEqual(executed.cgroupLimits, { cpuMax: '100000 100000', memoryMax: '536870912',
      memorySwapMax: '0', pidsMax: '64' });
  });
  await t.test('over-output is terminated instead of only clipped', async () => {
    const { executed } = await fixture('#include <stdio.h>\nint main(void){for(;;)puts("passed passed passed passed passed passed");}');
    assert.equal(executed.failureKind, 'output_limit');
    assert(executed.outputBytes > 65536);
    assert(Buffer.byteLength(executed.stdout) <= 65536);
    assert.equal(executed.unitTerminated, true);
  });
  await t.test('512 MiB OOM has engine evidence', async () => {
    const { executed } = await fixture('#include <stdlib.h>\n#include <string.h>\nint main(void){for(;;){volatile unsigned char *p=malloc(16*1024*1024);if(!p)return 2;for(int i=0;i<16*1024*1024;i++)p[i]=1;}}');
    assert.equal(executed.failureKind, 'oom');
    assert.equal(executed.unitTerminated, true);
  });
  await t.test('128 MiB work limit is real and visible to the trusted host', async () => {
    const { executed } = await fixture('#include <stdio.h>\n#include <errno.h>\nint main(void){FILE *f=fopen("big.bin","w");if(!f)return 3;static char b[1048576];for(int i=0;i<256;i++){if(fwrite(b,1,sizeof b,f)!=sizeof b){fclose(f);return 1;}}fclose(f);return 0;}');
    assert.equal(executed.failureKind, 'temp_limit');
    assert.equal(executed.unitTerminated, true);
  });
  await t.test('pids constraint refuses forks and cancellation leaves no live root process', async () => {
    const { executed } = await fixture('#include <unistd.h>\n#include <stdio.h>\nint main(void){int n=0;for(int i=0;i<100;i++){int p=fork();if(p<0)break;if(p==0){for(;;)pause();}n++;}printf("children=%d\\n",n);fflush(stdout);sleep(1);return n<100?1:0;}');
    assert.equal(executed.failureKind, 'process_limit');
    assert((executed.pidsMaxEvents ?? 0) > 0);
    assert.equal(executed.unitTerminated, true);
    assert.equal((await executor.inspect(executed.containerId)).State.Pid, 0);
  });
  await t.test('cancelled-before-start cannot execute a late-created unit', async () => {
    const cancel = new AbortController();
    cancel.abort();
    const { executed } = await fixture('#include <stdio.h>\nint main(void){puts("should-not-run");return 0;}', 10000, cancel.signal);
    assert.equal(executed.failureKind, 'cancelled');
    assert.equal(executed.stdout, '');
    assert.equal((await executor.inspect(executed.containerId)).State.Status, 'created');
    assert.equal(executed.unitTerminated, true);
  });
  await t.test('cancellation around start request repeatedly stops a possibly late-starting unit', async () => {
    const cancel = new AbortController();
    const { executed } = await fixture('int main(void){for(;;){}return 0;}', 10000, cancel.signal,
      () => { void setTimeout(1).then(() => cancel.abort()); });
    assert.equal(executed.failureKind, 'cancelled');
    assert.equal(executed.unitTerminated, true);
    assert.equal((await executor.inspect(executed.containerId)).State.Running, false);
    assert(executed.durationMs < 5000);
  });
  await t.test('report is collected only after termination and symlinks stay incomplete', async () => {
    const { executed, workDirectory } = await fixture('#define _POSIX_C_SOURCE 200809L\n#include <stdio.h>\n#include <unistd.h>\nint main(void){FILE *f=fopen("report.txt","wx");if(!f)return 1;fputs("TOTAL\\t4\\t11\\t51\\n",f);fclose(f);symlink("/snapshot/a.txt","link.txt");return 0;}');
    assert.equal(executed.exitCode, 0);
    const files = collectResultFiles(workDirectory, ['report.txt', 'link.txt'], 65536, executed.unitTerminated);
    assert.equal(files[0]!.status, 'complete');
    assert.equal(files[0]!.text, 'TOTAL\t4\t11\t51\n');
    assert.equal(files[1]!.status, 'incomplete');
  });
  await t.test('durable control uses actual fixed-snapshot containers and duplicate submit returns original results', async () => {
    const text = '#include <stdio.h>\nint main(void){puts("pipeline");return 0;}';
    const inputText = 'C and memory.\n';
    const files = [
      { fileId: 'source', path: 'main.c', documentVersion: 1, text, contentHash: sha256(text) },
      { fileId: 'input', path: 'a.txt', documentVersion: 1, text: inputText, contentHash: sha256(inputText) },
    ];
    const snapshot = { snapshotId: `synthetic-${randomUUID()}`, hashFormat: 'sha256-manifest-v1' as const, hash: manifestHash(files), files };
    const input = { operation: 'stats' as const, fileIds: ['input'] };
    const profile = { runtimeProfileVersion: 'c1-local-synthetic-v1', imageDigest: 'sha256:980e5c2310bee44d11ee46964174cc11dfea822ba60f0d050d2161d63b64b8f5',
      compilerImage, runtimeImage, approvedResultFiles: [] };
    const identity = { runId: `synthetic-${randomUUID()}`, commandId: `synthetic-command-${randomUUID()}`,
      requestHash: sha256('synthetic original request'), recoveryGeneration: 'synthetic-generation',
      snapshotId: snapshot.snapshotId, snapshotHash: snapshot.hash,
      inputHash: sha256(JSON.stringify(textScopeArgs(snapshot, input, []))), runtimeProfileVersion: profile.runtimeProfileVersion,
      imageDigest: profile.imageDigest, authorizedScope: { userId: 'synthetic-user', courseId: 'synthetic-course',
        attemptId: 'synthetic-attempt', purpose: 'student_run' as const } };
    const directory = mkdtempSync('/opt/xunjie-runner/tests/control-');
    const control = new RunControl(directory, 'synthetic-generation', actor => actor === 'synthetic-service', name => executor.stop(name));
    const work = buildRunWork(executor, '/opt/xunjie-runner/tests/pipeline', identity, snapshot, 'source', input, profile);
    await control.submitRun('synthetic-service', identity, work);
    let fact;
    for (let i = 0; i < 500; i++) {
      fact = await control.queryRun('synthetic-service', identity);
      if (fact?.state === 'succeeded') break;
      await setTimeout(25);
    }
    assert.equal(fact?.state, 'succeeded');
    const result = await control.readResult('synthetic-service', identity);
    assert.equal(result.snapshotHash, snapshot.hash);
    assert.equal(result.phases[1]!.stdout, 'pipeline\n');
    assert.equal(result.unitTerminated, true);
    assert.equal(result.phases[0]!.imageId, compilerImage);
    assert.equal(result.phases[1]!.imageId, runtimeImage);
    const replayed = await control.submitRun('synthetic-service', identity, work);
    assert.equal(replayed?.resultRef, fact.resultRef);
    assert.equal(replayed?.units.length, 2);
    assert.equal(replayed?.pending.length, 0);
    control.close();
  });
});
