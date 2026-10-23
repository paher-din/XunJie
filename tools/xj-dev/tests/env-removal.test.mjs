import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { environmentId, environmentPaths, PINNED_NODE } from '../src/paths.mjs';
import { processAlive } from '../src/state.mjs';

const worktree = resolve(import.meta.dirname, '../../..');
const cli = join(worktree, 'tools/xj-dev/xj-dev.mjs');
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
assert.equal(process.version, PINNED_NODE);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'xj141-delete-'));
  const home = join(root, 'home');
  const paths = instance => environmentPaths(home, environmentId(worktree, instance));
  const args = (command, instance) => [cli, command, '--worktree', worktree, '--instance', instance, '--json'];
  const check = result => {
    assert.ok(result.stdout, 'CLI must return a structured result: ' + String(result.stderr).slice(-500));
    const body = JSON.parse(result.stdout);
    assert.equal(body.schema, 'xj-dev/result-v1');
    assert.equal(result.status === 0, body.ok, JSON.stringify(body.failure));
    return body;
  };
  const run = (command, instance) => check(spawnSync(process.execPath, args(command, instance), {
    env: { ...process.env, XJ_DEV_HOME: home }, encoding: 'utf8', timeout: 300000, maxBuffer: 4 * 1024 * 1024,
  }));
  const instances = new Set();
  t.after(() => {
    for (const instance of instances) {
      const result = run('down', instance);
      assert.equal(result.ok, true, JSON.stringify(result.failure));
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, home, paths, run, args, check, instances };
}

test('delete is explicit, missing environments are idempotent and unknown directories are never adopted', t => {
  const f = fixture(t), instance = 'unknown-' + randomUUID(), env = f.paths(instance);
  assert.equal(f.run('delete', instance).deletion.result, 'not-present');
  assert.equal(existsSync(env.root), false, 'missing deletion must not create a lock or environment');
  mkdirSync(env.data, { recursive: true });
  const sentinel = join(env.data, 'foreign.txt'); writeFileSync(sentinel, 'foreign data');
  assert.equal(f.run('delete', instance).failure.code, 'ENVIRONMENT_UNKNOWN_OBJECT');
  assert.equal(readFileSync(sentinel, 'utf8'), 'foreign data');
  assert.equal(existsSync(env.lockFile), false);
  rmSync(sentinel);
  assert.equal(f.run('delete', instance).failure.code, 'ENVIRONMENT_UNREGISTERED');
  assert.equal(existsSync(env.data), true);
  const state = { version: 1, envId: 'foreign-id', worktree, instance };
  writeFileSync(env.stateFile, JSON.stringify(state));
  assert.equal(f.run('delete', instance).failure.code, 'ENVIRONMENT_UNREGISTERED');
  assert.equal(json(env.stateFile).envId, 'foreign-id');
  writeFileSync(env.stateFile, JSON.stringify({ ...state, envId: environmentId(worktree, instance), instance: 'foreign-instance' }));
  assert.equal(f.run('delete', instance).failure.code, 'ENVIRONMENT_UNREGISTERED');
  writeFileSync(env.stateFile, JSON.stringify({ ...state, envId: environmentId(worktree, instance), worktree: f.root }));
  assert.equal(f.run('delete', instance).failure.code, 'ENVIRONMENT_UNREGISTERED');
});

test('delete rejects root and nested directory links without changing either destination', t => {
  const f = fixture(t), instance = 'link-' + randomUUID(), env = f.paths(instance);
  const foreign = join(f.root, 'foreign'); mkdirSync(foreign);
  writeFileSync(join(foreign, 'keep.txt'), 'keep');
  mkdirSync(join(f.home, 'envs'), { recursive: true });
  symlinkSync(foreign, env.root, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.run('delete', instance).failure.code, 'ENVIRONMENT_UNSAFE');
  assert.equal(lstatSync(env.root).isSymbolicLink(), true);
  unlinkSync(env.root);
  mkdirSync(env.root);
  writeFileSync(env.stateFile, JSON.stringify({ version: 1, envId: environmentId(worktree, instance), worktree, instance }));
  mkdirSync(env.personalModels); symlinkSync(foreign, join(env.personalModels, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(f.run('delete', instance).failure.code, 'ENVIRONMENT_UNSAFE');
  assert.equal(readFileSync(join(foreign, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(env.stateFile), true);
  assert.equal(existsSync(env.lockFile), false, 'validate the entire tree before opening a mutex');
  unlinkSync(join(env.personalModels, 'linked'));
});

test('forged selected-mode IDs and paths cannot redirect delete into another environment', t => {
  const f = fixture(t), instance = 'mode-' + randomUUID(), env = f.paths(instance);
  const other = f.paths('other'); mkdirSync(env.root, { recursive: true }); mkdirSync(other.root, { recursive: true });
  mkdirSync(other.personalModels); writeFileSync(join(other.personalModels, 'keep.txt'), 'keep');
  const entry = { id: environmentId(worktree, 'other'), root: other.root, mode: 'cloud' };
  writeFileSync(other.stateFile, JSON.stringify({ version: 1, envId: entry.id, worktree, mode: 'cloud', target: 'foreign' }));
  writeFileSync(join(env.root, 'selection.json'), JSON.stringify({ mode: 'cloud', targets: { cloud: entry } }));
  assert.equal(f.run('delete', instance).failure.code, 'ENVIRONMENT_UNREGISTERED');
  assert.equal(readFileSync(join(other.personalModels, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(existsSync(other.lockFile), false);
});

test('a valid selected remote-mode registration deletes only that derived environment and retains the local namespace', t => {
  const f = fixture(t), instance = 'remote-' + randomUUID(), base = f.paths(instance), target = 'approved-target';
  const id = createHash('sha256').update(`${environmentId(worktree, instance)}:cloud:${target}`).digest('hex').slice(0, 12);
  const remote = environmentPaths(f.home, id);
  mkdirSync(base.personalModels, { recursive: true }); writeFileSync(join(base.personalModels, 'keep.txt'), 'local work');
  mkdirSync(remote.data, { recursive: true }); writeFileSync(remote.baselineFile, '{}');
  writeFileSync(remote.stateFile, JSON.stringify({ version: 1, envId: id, worktree, mode: 'cloud', target }));
  const selection = { mode: 'cloud', targets: { cloud: { id, root: remote.root, mode: 'cloud' } } };
  writeFileSync(join(base.root, 'selection.json'), JSON.stringify(selection));
  const removed = f.run('delete', instance);
  assert.equal(removed.deletion.result, 'deleted'); assert.equal(removed.environment.id, id);
  assert.equal(existsSync(remote.data), false); assert.equal(existsSync(remote.lockFile), true);
  assert.equal(readFileSync(join(base.personalModels, 'keep.txt'), 'utf8'), 'local work');
  assert.deepEqual(json(join(base.root, 'selection.json')), selection);
  assert.equal(f.run('delete', instance).deletion.result, 'already-deleted');
});

const preload = String.raw`
import fs from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
const target = process.env.XJ_DELETE_BARRIER_TARGET;
let paused = false;
function pause() {
  if (paused) return;
  paused = true; fs.writeFileSync(process.env.XJ_DELETE_BARRIER_READY, 'ready');
  const waiter = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(process.env.XJ_DELETE_BARRIER_CONTINUE)) Atomics.wait(waiter, 0, 0, 10);
}
if (process.env.XJ_DELETE_BARRIER_KIND === 'up') {
  const sqlite = createRequire(import.meta.url)('node:sqlite'), Original = sqlite.DatabaseSync;
  sqlite.DatabaseSync = class extends Original {
    constructor(file, ...args) { super(file, ...args); this.testFile = file; }
    exec(sql) { const result = super.exec(sql); if (sql.includes('BEGIN IMMEDIATE') && resolve(this.testFile) === resolve(target)) pause(); return result; }
  };
} else {
  const original = fs.rmSync;
  fs.rmSync = function(file, ...args) {
    const result = original.call(this, file, ...args);
    if (resolve(String(file)) === resolve(target)) pause();
    return result;
  };
  syncBuiltinESMExports();
}
`;

async function pausedCli(f, command, instance, t) {
  const name = randomUUID(), ready = join(f.root, name + '.ready'), resume = join(f.root, name + '.continue');
  const module = join(f.root, 'barrier.mjs'); writeFileSync(module, preload);
  const env = f.paths(instance);
  const child = spawn(process.execPath, ['--import', module, ...f.args(command, instance)], {
    env: { ...process.env, XJ_DEV_HOME: f.home, XJ_DELETE_BARRIER_KIND: command, XJ_DELETE_BARRIER_TARGET: command === 'up' ? join(env.lockFile, 'mutex.sqlite') : env.data,
      XJ_DELETE_BARRIER_READY: ready, XJ_DELETE_BARRIER_CONTINUE: resume }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes);
  const ended = once(child, 'exit').then(([status]) => ({ status, stdout, stderr }));
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await ended;
  });
  const deadline = Date.now() + 180000;
  while (!existsSync(ready)) {
    assert.equal(child.exitCode, null, 'barrier CLI exited: ' + stderr.slice(-500));
    assert.ok(Date.now() < deadline, 'CLI did not reach the real operation barrier');
    await delay(25);
  }
  return { child, resume: () => writeFileSync(resume, 'continue'), ended };
}

test('real CLI down/delete/rebuild isolate two environments and keep original mutex inodes across concurrent up and process death', { timeout: 1200000 }, async t => {
  const f = fixture(t), a = 'a-' + randomUUID(), b = 'b-' + randomUUID();
  f.instances.add(a); f.instances.add(b);
  const A = f.paths(a), B = f.paths(b);
  const upA = f.run('up', a), upB = f.run('up', b);
  assert.equal(upA.ok, true, JSON.stringify(upA.failure)); assert.equal(upB.ok, true, JSON.stringify(upB.failure));
  const lock = join(A.lockFile, 'mutex.sqlite'), inode = lstatSync(lock).ino;
  const oldCredentials = hash(A.baselineCredentials), bCredentials = hash(B.baselineCredentials);
  const keep = join(A.personalModels, 'work.txt'); mkdirSync(A.personalModels, { recursive: true }); writeFileSync(keep, 'personal work');
  const globals = ['enrollment/device.json', 'enrollment/invitation.json', 'enrollment/account.json', 'oss/cache.zip', 'packages/scene.zip', 'runtime/keep.txt'];
  for (const path of globals) { const file = join(f.home, path); mkdirSync(resolve(file, '..'), { recursive: true }); writeFileSync(file, 'test-only sentinel'); }
  const ca = hash(join(f.home, 'ca/ca-key.pem'));
  mkdirSync(join(A.root, 'repro')); writeFileSync(join(A.root, 'repro/scene.zip'), 'test-only package sentinel');
  writeFileSync(join(A.root, 'enrollment.json'), JSON.stringify({ accountFile: join(f.home, 'enrollment/account.json') }));

  await t.test('down preserves the original baseline, private data and restart identity', () => {
    assert.equal(f.run('down', a).ok, true);
    assert.equal(hash(A.baselineCredentials), oldCredentials); assert.equal(readFileSync(keep, 'utf8'), 'personal work');
    assert.equal(f.run('up', a).ok, true); assert.equal(hash(A.baselineCredentials), oldCredentials);
  });
  await t.test('unknown descendants and a foreign registered PID abort before stopping any owned component', () => {
    const unknown = join(A.secrets, 'foreign-account.json'); writeFileSync(unknown, 'test-only sentinel');
    assert.equal(f.run('delete', a).failure.code, 'ENVIRONMENT_UNKNOWN_OBJECT');
    for (const component of Object.values(f.run('status', a).processes)) assert.equal(component.running, true);
    assert.equal(existsSync(unknown), true); rmSync(unknown);
    // Backend is checked after gateway/vite: a foreign late record must still
    // abort the whole preflight before either earlier component is stopped.
    const recordFile = join(A.pids, 'backend.json'), original = readFileSync(recordFile);
    const ownGateway = json(join(A.pids, 'gateway.json')).pid, ownBackend = json(recordFile).pid;
    writeFileSync(recordFile, JSON.stringify({ ...json(recordFile), pid: upB.processes.gateway.pid }));
    try {
      assert.equal(f.run('delete', a).failure.code, 'ENVIRONMENT_FOREIGN_PROCESS');
      assert.equal(processAlive(upB.processes.gateway.pid), true);
      assert.equal(processAlive(ownGateway), true); assert.equal(processAlive(ownBackend), true);
      assert.equal(hash(A.baselineCredentials), oldCredentials);
    } finally { writeFileSync(recordFile, original); }
  });
  await t.test('delete refuses an up that already owns the original operation lock', async t => {
    const paused = await pausedCli(f, 'up', a, t);
    try {
      assert.equal(f.run('delete', a).failure.code, 'LOCK_HELD');
      assert.equal(hash(A.baselineCredentials), oldCredentials);
    } finally { paused.resume(); }
    assert.equal(f.check(await paused.ended).ok, true);
  });
  await t.test('up and another delete cannot enter after data removal while the deleting CLI still owns its mutex', async t => {
    const paused = await pausedCli(f, 'delete', a, t);
    try {
      assert.equal(existsSync(A.data), false, 'pause after real payload removal');
      assert.equal(f.run('up', a).failure.code, 'LOCK_HELD');
      assert.equal(f.run('delete', a).failure.code, 'LOCK_HELD');
      assert.equal(f.run('up', b).ok, true, 'different environment remains independent');
      assert.equal(lstatSync(lock).ino, inode);
    } finally { paused.resume(); }
    assert.equal(f.check(await paused.ended).deletion.result, 'deleted');
    assert.equal(lstatSync(lock).ino, inode);
  });
  await t.test('only owned payload is deleted; shared material, source, other environment and package evidence survive', () => {
    for (const path of [A.database, A.personalModels, A.tls, A.pids, A.stateFile]) assert.equal(existsSync(path), false);
    assert.equal(f.run('delete', a).deletion.result, 'already-deleted');
    assert.equal(existsSync(join(worktree, '.git')), true);
    assert.equal(hash(B.baselineCredentials), bCredentials); assert.equal(f.run('status', b).ok, true);
    assert.equal(hash(join(f.home, 'ca/ca-key.pem')), ca);
    for (const path of globals) assert.equal(readFileSync(join(f.home, path), 'utf8'), 'test-only sentinel');
    assert.equal(readFileSync(join(A.root, 'repro/scene.zip'), 'utf8'), 'test-only package sentinel');
    assert.equal(existsSync(join(A.root, 'enrollment.json')), true);
    assert.deepEqual(readdirSync(A.root).sort(), ['deletion.json', 'enrollment.json', 'lock', 'repro', 'selection.lock']);
  });
  await t.test('fresh up recreates the fixed baseline and uses the very same SQLite mutex', () => {
    const rebuilt = f.run('up', a); assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt.failure));
    assert.equal(rebuilt.environment.id, upA.environment.id);
    assert.equal(rebuilt.environment.baselineVersion, 'local-baseline-1');
    assert.notEqual(hash(A.baselineCredentials), oldCredentials);
    assert.equal(existsSync(keep), false); assert.equal(lstatSync(lock).ino, inode);
  });
  await t.test('death during deletion releases OS locks and an explicit retry completes the recorded operation', async t => {
    const paused = await pausedCli(f, 'delete', a, t);
    paused.child.kill('SIGKILL'); await paused.ended;
    assert.equal(json(join(A.root, 'deletion.json')).status, 'deleting');
    assert.equal(f.run('delete', a).deletion.result, 'deleted');
    assert.equal(f.run('delete', a).deletion.result, 'already-deleted');
    assert.equal(lstatSync(lock).ino, inode); assert.equal(hash(B.baselineCredentials), bCredentials);
  });
});
