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
  writeFileSync(script, `
import {appendFileSync} from 'node:fs';
import {setTimeout} from 'node:timers/promises';
const [log,name,wait,code] = process.argv.slice(2);
appendFileSync(log,JSON.stringify({name,action:'start'})+'\\n');
console.log('stdout '+name); console.error('stderr '+name);
await setTimeout(Number(wait));
appendFileSync(log,JSON.stringify({name,action:'end'})+'\\n');
process.exitCode=Number(code);
`);
  const events = join(root, 'events.jsonl');
  return { root, events, task: (name, group, exclusive = false, code = 0) => ({
    name, group, exclusive, command: process.execPath, args: [script, events, name, '80', String(code)], cwd: root,
  }), summary: () => JSON.parse(readFileSync(join(root, '.verification/latest.json'), 'utf8')) };
}

for (const jobs of [1, 2, 4]) {
  test(`global worker budget ${jobs} spans groups and exclusive files form barriers`, async t => {
    const f = fixture(t);
    const tasks = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((name, index) => f.task(name, index % 2 ? 'server' : 'unit'));
    tasks.splice(4, 0, f.task('sensitive-1', 'tools', true), f.task('sensitive-2', 'tools', true));
    assert.equal(await runVerification({ root: f.root, options: { jobs }, phases: [tasks] }), 0);
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
  assert.equal(await runVerification({ root: f.root, options: { jobs: 2 }, phases: [[missing, f.task('remaining', 'unit')]] }), 1);
  const stage = f.summary().stages[0];
  assert.equal(stage.status, 'failed');
  assert.equal(stage.tasks[0].exitCode, 1);
  assert.equal(stage.tasks[1].status, 'passed');
  assert.match(readFileSync(stage.logFile, 'utf8'), /ENOENT/);
});

test('tests rerun on a second invocation and keep separate raw logs', async t => {
  const f = fixture(t);
  const options = { jobs: 1 }, phases = [[f.task('again', 'unit')]];
  assert.equal(await runVerification({ root: f.root, options, phases }), 0);
  const first = f.summary();
  assert.equal(await runVerification({ root: f.root, options, phases }), 0);
  const second = f.summary();
  assert.notEqual(first.logFile, second.logFile);
  assert.equal(readFileSync(f.events, 'utf8').trim().split('\n').length, 4);
  assert.match(readFileSync(first.logFile, 'utf8'), /stdout again/);
  assert.match(readFileSync(second.logFile, 'utf8'), /stderr again/);
});

test('real lifecycle tasks run serially after all independent readers; helper-linked outputs stay isolated', async t => {
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
const [events,name,target]=process.argv.slice(2);
appendFileSync(events,JSON.stringify({name,action:'start'})+'\\n');
if(realpathSync(join(target,'node_modules/@xunjie/contracts'))!==realpathSync(join(target,'packages/contracts')))throw Error('shared output alias');
writeFileSync(join(target,'node_modules/@xunjie/contracts/dist/result.txt'),name);
await setTimeout(120);
appendFileSync(events,JSON.stringify({name,action:'end'})+'\\n');
`);
  const tasks = [f.task('unit', 'unit'), f.task('server', 'server'), f.task('pure-tool-1', 'tools'), f.task('pure-tool-2', 'tools')];
  const targets = [];
  for (const [index, task] of targetTasks(f.root, 'tools', [...sensitiveTools].map(path => 'tools/' + path)).entries()) {
    assert.equal(task.exclusive, true);
    assert.equal(task.args[1], '--test-concurrency=1');
    const target = join(f.root, 'receiver-' + index); workspace(target);
    reuseWorkspaceDependencies(source, target);
    assert.equal(realpathSync(join(target, 'node_modules/@xunjie/contracts')), realpathSync(join(target, 'packages/contracts')));
    targets.push({ target, name: task.name });
    // Queue independent work after lifecycle entries as well: partitioning must
    // move every reader ahead of the resource-exclusive phase.
    tasks.push({ ...task, cwd: target, args: [worker, f.events, task.name, target] }, f.task('reader-' + index, 'server'));
  }
  assert.equal(await runVerification({ root: f.root, options: { jobs: 4 }, phases: scheduleTestPhases(tasks) }), 0);
  let active = 0, peak = 0;
  let exclusiveStarted = false, readersEnded = 0;
  for (const event of readFileSync(f.events, 'utf8').trim().split('\n').map(JSON.parse)) {
    const exclusive = targets.some(target => target.name === event.name);
    if (event.action === 'start' && exclusive) {
      exclusiveStarted = true;
      assert.equal(active, 0);
      assert.equal(readersEnded, 10);
    }
    if (!exclusive) {
      assert.equal(exclusiveStarted, false);
      if (event.action === 'end') readersEnded++;
    }
    active += event.action === 'start' ? 1 : -1; peak = Math.max(peak, active);
    assert(active >= 0 && active <= 4);
  }
  assert.equal(peak, 4);
  assert.equal(active, 0);
  for (const { target, name } of targets) assert.equal(readFileSync(join(target, 'packages/contracts/dist/result.txt'), 'utf8'), name);
  assert.equal(readFileSync(join(source, 'packages/contracts/dist/result.txt'), 'utf8'), 'prepared');
});
