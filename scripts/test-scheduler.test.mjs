import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runVerification } from './test-scheduler.mjs';
import { scheduleTestPhases, sensitiveTools, targetTasks } from './test-discovery.mjs';
import { reuseWorkspaceDependencies } from '../tools/xj-dev/tests/workspace-dependencies.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'xunjie-scheduler-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'worker.mjs');
  writeFileSync(join(root, 'start.mjs'), `
import {appendFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
export async function start(log,name,barrier,participants,startupDelay=0) {
  if(startupDelay)await setTimeout(Number(startupDelay));
  appendFileSync(log,JSON.stringify({name,action:'start'})+'\\n');
  if (!barrier) return;
  writeFileSync(join(barrier,encodeURIComponent(name)), '');
  const deadline=Date.now()+10000;
  while(readdirSync(barrier).length<Number(participants)) {
    if(Date.now()>deadline)throw Error('worker wave did not rendezvous');
    await setTimeout(10);
  }
}
`);
  writeFileSync(script, `
import {appendFileSync} from 'node:fs';
import {setTimeout} from 'node:timers/promises';
import {start} from './start.mjs';
const [log,name,wait,code,barrier,participants,startupDelay] = process.argv.slice(2);
await start(log,name,barrier,participants,startupDelay);
console.log('stdout '+name); console.error('stderr '+name);
await setTimeout(Number(wait));
appendFileSync(log,JSON.stringify({name,action:'end'})+'\\n');
process.exitCode=Number(code);
`);
  const events = join(root, 'events.jsonl');
  return { root, events, barrier(tasks, participants) {
    const directory = mkdtempSync(join(root, 'barrier-'));
    // Hold the first wave until every worker logs its start; process startup
    // speed must not determine whether the configured budget was exercised.
    for (const [index, task] of tasks.slice(0, participants).entries())
      task.args.push(directory, String(participants), index === participants - 1 ? '200' : '0');
  }, task: (name, group, exclusive = false, code = 0) => ({
    name, group, exclusive, command: process.execPath, args: [script, events, name, '80', String(code)], cwd: root,
  }), summary: () => JSON.parse(readFileSync(join(root, '.verification/latest.json'), 'utf8')) };
}

for (const jobs of [1, 2, 4]) {
  test(`global worker budget ${jobs} spans groups and exclusive files form barriers`, async t => {
    const f = fixture(t);
    const tasks = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name, index) => f.task(name, index % 2 ? 'server' : 'unit'));
    tasks.splice(4, 0, f.task('sensitive-1', 'tools', true), f.task('sensitive-2', 'tools', true));
    f.barrier(tasks, jobs);
    assert.equal(await runVerification({ root: f.root, options: { jobs, reportDir: '.verification' }, phases: [tasks] }), 0);
    let active = new Set(), peak = 0;
    for (const event of readFileSync(f.events, 'utf8').trim().split('\n').map(JSON.parse)) {
      if (event.action === 'start') {
        if (event.name.startsWith('sensitive')) assert.equal(active.size, 0);
        assert(![...active].some(name => name.startsWith('sensitive')));
        active.add(event.name); peak = Math.max(peak, active.size);
      } else assert(active.delete(event.name));
      assert(active.size <= jobs, 'worker budget exceeded');
    }
    assert.equal(peak, jobs);
    assert.equal(active.size, 0);
    const summary = f.summary();
    assert.equal(summary.testsCached, false);
    assert(summary.stages.every(stage => stage.status === 'passed' && stage.exitCode === 0 && stage.durationMs >= 0));
    for (const stage of summary.stages) for (const task of stage.tasks) {
      const log = readFileSync(stage.logFile, 'utf8');
      assert.match(log, new RegExp('stdout ' + task.name));
      assert.match(log, new RegExp('stderr ' + task.name));
    }
  });
}

test('launch errors are logged, return failure, and preserve the rest of the tests', async t => {
  const f = fixture(t);
  const missing = { ...f.task('missing', 'unit'), command: join(f.root, 'not-installed') };
  assert.equal(await runVerification({ root: f.root, options: { jobs: 2, reportDir: '.verification' }, phases: [[missing, f.task('remaining', 'unit')]] }), 1);
  const stage = f.summary().stages[0];
  assert.equal(stage.status, 'failed');
  assert.equal(stage.tasks[0].exitCode, 1);
  assert.equal(stage.tasks[1].status, 'passed');
  assert.match(readFileSync(stage.logFile, 'utf8'), /ENOENT/);
});

test('tests rerun on a second invocation and keep separate raw logs', async t => {
  const f = fixture(t);
  const options = { jobs: 1, reportDir: '.verification' }, phases = [[f.task('again', 'unit')]];
  assert.equal(await runVerification({ root: f.root, options, phases }), 0);
  const first = f.summary();
  assert.equal(await runVerification({ root: f.root, options, phases }), 0);
  const second = f.summary();
  assert.notEqual(first.logFile, second.logFile);
  assert.equal(readFileSync(f.events, 'utf8').trim().split('\n').length, 4);
  assert.match(readFileSync(first.logFile, 'utf8'), /stdout again/);
  assert.match(readFileSync(second.logFile, 'utf8'), /stderr again/);
});

test('real lifecycle tasks share the global budget; helper-linked outputs stay isolated', async t => {
  const f = fixture(t), source = join(f.root, 'source');
  function workspace(root) {
    mkdirSync(join(root, 'packages/contracts/dist'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['packages/*'] }));
    writeFileSync(join(root, 'package-lock.json'), '{}');
    writeFileSync(join(root, 'packages/contracts/package.json'), JSON.stringify({ name: '@xunjie/contracts' }));
    writeFileSync(join(root, 'packages/contracts/dist/result.txt'), 'prepared');
  }
  workspace(source);
  mkdirSync(join(source, 'node_modules/@xunjie'), { recursive: true });
  symlinkSync(join(source, 'packages/contracts'), join(source, 'node_modules/@xunjie/contracts'), process.platform === 'win32' ? 'junction' : 'dir');
  const worker = join(f.root, 'isolation.mjs');
  writeFileSync(worker, `
import {appendFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout} from 'node:timers/promises';
import {start} from './start.mjs';
const [events,name,target,barrier,participants,startupDelay]=process.argv.slice(2);
await start(events,name,barrier,participants,startupDelay);
if(realpathSync(join(target,'node_modules/@xunjie/contracts'))!==realpathSync(join(target,'packages/contracts')))throw Error('shared output alias');
writeFileSync(join(target,'node_modules/@xunjie/contracts/dist/result.txt'),name);
await setTimeout(120);
appendFileSync(events,JSON.stringify({name,action:'end'})+'\\n');
`);
  const tasks = [f.task('unit', 'unit'), f.task('server', 'server'), f.task('pure-tool-1', 'tools'), f.task('pure-tool-2', 'tools')];
  const targets = [];
  for (const [index, task] of targetTasks(f.root, 'tools', [...sensitiveTools].map(path => 'tools/' + path)).entries()) {
    assert.equal(task.exclusive, false);
    assert.equal(task.args[1], '--test-concurrency=1');
    const target = join(f.root, 'receiver-' + index); workspace(target);
    reuseWorkspaceDependencies(source, target);
    assert.equal(realpathSync(join(target, 'node_modules/@xunjie/contracts')), realpathSync(join(target, 'packages/contracts')));
    targets.push({ target, name: task.name });
    tasks.push({ ...task, cwd: target, args: [worker, f.events, task.name, target] }, f.task('reader-' + index, 'server'));
  }
  const phases = scheduleTestPhases(tasks);
  f.barrier(phases[0], 4);
  assert.equal(await runVerification({ root: f.root, options: { jobs: 4, reportDir: '.verification' }, phases }), 0);
  let active = 0, peak = 0;
  for (const event of readFileSync(f.events, 'utf8').trim().split('\n').map(JSON.parse)) {
    active += event.action === 'start' ? 1 : -1; peak = Math.max(peak, active);
    assert(active >= 0 && active <= 4);
  }
  assert.equal(peak, 4);
  assert.equal(active, 0);
  for (const { target, name } of targets) assert.equal(readFileSync(join(target, 'packages/contracts/dist/result.txt'), 'utf8'), name);
  assert.equal(readFileSync(join(source, 'packages/contracts/dist/result.txt'), 'utf8'), 'prepared');
});
