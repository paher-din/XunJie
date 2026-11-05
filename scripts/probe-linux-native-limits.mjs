import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SupervisedSession } from '../packages/learning-space/src/learning-data/native-process.ts';
import { linuxSessionEntry, probeLinuxIsolation } from '../packages/learning-space/src/learning-data/linux-isolation.ts';
import { parseArgs, digest, createLearningApi, expectOk, loginMember } from './remote-probe-helpers.mjs';

// Bundle this probe with esbuild before copying it to the independent Ubuntu node.
const args = parseArgs();
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
const exec = promisify(execFile), entry = linuxSessionEntry();
const limits = { operationTimeoutMs: 5000, idleMs: 60000, maxMs: 60000, memoryMiB: 256, outputBytes: 2048 };
const adapter = {
  adapterId: 'linux-limits-probe', adapterVersion: 1,
  source: `
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
let descendants = [];
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
 const message = JSON.parse(line);
 if (message.type === 'ready') {
  if (process.env.XJ_PROBE_DESCENDANTS) throw new Error('unexpected inherited environment');
  emit({type:'ready',adapterId:'linux-limits-probe',adapterVersion:1,instanceId:process.env.XJ_SESSION_INSTANCE,
   observation:{pid:process.pid,descendants}});
 } else if (message.type === 'input' && message.parameters.kind === 'output') process.stdout.write('x'.repeat(65536));
 else if (message.type === 'input' && message.parameters.kind === 'descendants') {
  const child = spawn(process.execPath, ['-e',
   "const{spawn}=require('node:child_process');const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});console.log(p.pid);setInterval(()=>{},1000)"],
   {detached:true,stdio:['ignore','pipe','ignore']});
  const grandchild = await new Promise((done,bad)=>{child.stdout.once('data',chunk=>done(Number(chunk.toString().trim())));child.once('error',bad)});
  descendants = [child.pid,grandchild];
  emit({type:'observation',seq:message.seq,controlId:message.controlId,state:{pid:process.pid,descendants},at:new Date().toISOString()});
 } else if (message.type === 'stop') process.exit(0);
}
` };
if (Object.hasOwn(args, 'supervisor')) {
  const isolation = JSON.parse(args.isolation);
  const session = await SupervisedSession.create({ adapter, nodePath: process.execPath, linuxEntry: entry, linuxIsolation: isolation, limits });
  const observation = await session.input(randomUUID(), 1, { kind: 'descendants' });
  console.log(JSON.stringify({ supervisor: process.pid, unit: `xj-session-${session.instanceId}`,
    instanceId: session.instanceId, directory: session.sessionDirectoryInput, ...observation.state }));
  setInterval(() => {}, 1000);
} else {
  if (!args.endpoint || !args.control || !args.state || !args.payload || !args.out)
    throw new Error('usage: --endpoint=HTTPS --control=FILE --state=FILE --payload=FILE --out=FILE');
  const report = { node: process.version, platform: `${process.platform}-${process.arch}`, status: 'running', cases: [] };
  const isolation = await probeLinuxIsolation(entry, process.execPath);
  assert.equal(isolation?.kind, 'systemd-unit', 'the installed entry must pass its real isolation probe');
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; if (error.code === 'EPERM') return true; throw error; } };
  let supervisor, childFact, outputSession;
  const runs = [];
  let api, student, activityId;
  try {
    outputSession = await SupervisedSession.create({ adapter, nodePath: process.execPath, linuxEntry: entry, linuxIsolation: isolation, limits });
    await assert.rejects(outputSession.input(randomUUID(), 1, { kind: 'output' }));
    const exit = await outputSession.settled(10000);
    assert.equal(exit?.expired, 'output');
    assert.equal(exit?.confirmed, true);
    report.output = { limitBytes: limits.outputBytes, emittedBytes: 65536, exit, instanceId: outputSession.instanceId };
    report.cases.push('actual systemd session exceeds its output budget and confirms whole-unit exit');
    await outputSession.dispose(); outputSession = undefined;

    supervisor = spawn(process.execPath, [fileURLToPath(import.meta.url), '--supervisor', `--isolation=${JSON.stringify(isolation)}`],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    childFact = await new Promise((done, bad) => {
      let text = '';
      const timer = setTimeout(() => bad(new Error('supervisor did not identify its real descendants')), 15000);
      supervisor.stdout.on('data', chunk => {
        text += chunk;
        if (text.includes('\n')) { clearTimeout(timer); try { done(JSON.parse(text.split('\n')[0])); } catch (error) { bad(error); } }
      });
      supervisor.once('error', error => { clearTimeout(timer); bad(error); });
      supervisor.once('exit', code => { if (!childFact) { clearTimeout(timer); bad(new Error(`supervisor exited ${code} before reporting descendants`)); } });
    });
    assert.equal(childFact.descendants.length, 2);
    const pids = [childFact.pid, ...childFact.descendants];
    assert.ok(pids.every(pid => Number.isInteger(pid) && pid > 0 && alive(pid)));
    const killedAt = Date.now();
    supervisor.kill('SIGKILL');
    while (pids.some(alive) && Date.now() - killedAt < 10000) await delay(50);
    const state = await exec(entry.sudo, ['-n', entry.entry, 'state', childFact.unit, childFact.instanceId]);
    assert.ok(pids.every(pid => !alive(pid)), 'every original descendant must exit after supervisor SIGKILL');
    assert.match(state.stdout, /ActiveState=(inactive|failed)/);
    report.supervisorDeath = { ...childFact, pidsGone: true, elapsedMs: Date.now() - killedAt, state: state.stdout.trim() };
    report.cases.push('SIGKILL of the actual supervisor reaps the session and detached child and grandchild');

    const stateFile = JSON.parse(await readFile(args.state, 'utf8'));
    const payload = JSON.parse(await readFile(args.payload, 'utf8'));
    api = createLearningApi(args.endpoint, (await readFile(args.control, 'utf8')).trim());
    student = (await loginMember(args.endpoint, stateFile)).headers;
    const activity = expectOk('activity', await api('course-activities', { requestId: randomUUID(), releaseId: stateFile.releaseId }, student));
    activityId = activity.activityId;
    const { manifest } = payload.component, declared = manifest.session;
    const release = expectOk('release', await api(`releases/${stateFile.releaseId}`, undefined, student));
    const action = () => ({ protocolVersion: 2, kind: 'execution', requestId: randomUUID(),
      scope: { environmentId: activity.identity.environmentId, spaceId: activity.identity.spaceId, principalId: activity.identity.principalId, activityId },
      receiver: { receiverId: 'school-native-execution', location: 'remote', kind: 'execution' }, execution: {
        device: stateFile.device, instance: { instanceId: `${activityId}:accumulator`, key: 'accumulator', componentId: manifest.componentId,
          componentVersion: manifest.version, definitionDigest: release.components[0].definition.digest, hostApiVersion: 1, stateVersion: 1 },
        operation: { operationId: declared.operation.operationId, effect: 'input' }, parameters: {},
        basis: { works: [], state: null, expected: { stateContentId: null }, resources: [] },
        limits: { timeMs: declared.budgets.operationTimeoutMs, memoryPages: 1, inputBytes: declared.budgets.inputBytes,
          outputBytes: declared.budgets.outputBytes, concurrentJobs: declared.budgets.concurrentSessions, queuedJobs: declared.budgets.queuedSessions },
        plan: { planId: 'native-session', planVersion: 1, location: 'native', kind: 'session',
          planDigest: digest({ planId: 'native-session', planVersion: 1, componentId: manifest.componentId, componentVersion: manifest.version, operationId: declared.operation.operationId }) },
        session: { adapterId: declared.adapterId, adapterVersion: declared.adapterVersion,
          limits: Object.fromEntries(['operationTimeoutMs', 'idleMs', 'maxMs', 'memoryMiB', 'concurrentSessions', 'queuedSessions'].map(key => [key, declared.budgets[key]])) },
        initiator: { kind: 'student', principalId: activity.identity.principalId } } });
    for (let index = 0; index < declared.budgets.concurrentSessions; index++) {
      const input = action();
      const accepted = expectOk('concurrent-accept', await api(`executions/${activityId}`, { action: input }, student));
      runs.push(accepted);
      assert.equal(accepted.state, 'running');
      assert.ok(accepted.session.observation.pid > 0);
    }
    const overflow = await api(`executions/${activityId}`, { action: action() }, student);
    report.concurrency = { limit: declared.budgets.concurrentSessions, pids: runs.map(run => run.session.observation.pid), overflowStatus: overflow.status };
    assert.equal(overflow.status, 400);
    assert.equal(overflow.value.error, 'invalid');
    const listed = expectOk('concurrent-list', await api(`executions/${activityId}/sessions`, undefined, student));
    assert.equal(listed.length, runs.length);
    assert.ok(listed.every(run => run.state === 'running' && runs.some(original => original.executionRef === run.executionRef
      && original.session.observation.pid === run.session.observation.pid)));
    report.cases.push('public execution owner rejects an excess concurrent native session while original Linux processes remain live');
    report.status = 'passed';
  } catch (error) { report.status = 'failed'; report.error = error.message; report.cause = error.cause?.code; process.exitCode = 1; }
  finally {
    const cleanupErrors = [];
    await outputSession?.dispose().catch(error => cleanupErrors.push(error.message));
    if (supervisor?.exitCode === null && supervisor.signalCode === null) supervisor.kill('SIGKILL');
    if (childFact) {
      await exec(entry.sudo, ['-n', entry.entry, 'stop', childFact.unit, childFact.instanceId]).catch(error => cleanupErrors.push(error.message));
      if ([childFact.pid, ...childFact.descendants].every(pid => !alive(pid))) await rm(childFact.directory, { recursive: true, force: true });
    }
    for (const run of runs) {
      try {
        const stopped = expectOk('concurrency-stop', await api(`executions/${activityId}/${run.requestId}/stop`, { stopId: randomUUID(), reason: 'Linux limits acceptance cleanup' }, student));
        assert.equal(stopped.state, 'cancelled');
        assert.equal(stopped.statusKnowledge, 'confirmed');
      } catch (error) { cleanupErrors.push(error.message); }
    }
    if (cleanupErrors.length) { report.cleanupErrors = cleanupErrors; report.status = 'failed'; process.exitCode = 1; }
    await mkdir(dirname(resolve(args.out)), { recursive: true });
    await writeFile(args.out, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify(report));
  }
}
