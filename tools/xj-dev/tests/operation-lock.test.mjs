import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
import { acquireLock } from '../src/state.mjs';

// Children are real processes, with IPC barriers at filesystem publication and
// acquisition. No wall-clock grace period determines whether a lock is owned.
const worker = String.raw`
import fs from 'node:fs';
import { syncBuiltinESMExports, createRequire } from 'node:module';
import { resolve } from 'node:path';
const [moduleUrl, root, mode] = process.argv.slice(1);
const paths = { root, lockFile: root + '/lock' };
function pause(phase) {
  fs.writeFileSync(root + '/paused', phase);
  const wait = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(root + '/continue')) Atomics.wait(wait, 0, 0, 10);
}
if (['creation', 'publication', 'initialization'].includes(mode)) {
  const originalMkdir = fs.mkdirSync;
  fs.mkdirSync = function(file, ...args) {
    const result = originalMkdir.call(this, file, ...args);
    if (mode === 'creation' && resolve(String(file)) === resolve(paths.lockFile)) pause('lock-directory');
    return result;
  };
  const original = fs.openSync;
  fs.openSync = function(file, flags, ...args) {
    const fd = original.call(this, file, flags, ...args);
    if (String(file) === paths.lockFile && flags === 'wx') pause('empty-json');
    return fd;
  };
  const originalLink = fs.linkSync;
  fs.linkSync = function(source, destination) {
    const result = originalLink.call(this, source, destination);
    if (mode === 'publication' && resolve(String(destination)) === resolve(paths.lockFile, 'mutex.sqlite')) pause('published-database');
    return result;
  };
  if (mode === 'initialization') {
    const sqlite = createRequire(import.meta.url)('node:sqlite');
    const OriginalDatabase = sqlite.DatabaseSync;
    sqlite.DatabaseSync = class extends OriginalDatabase {
      exec(sql) { if (sql.includes('CREATE TABLE xj_dev_lock')) pause('private-initialization'); return super.exec(sql); }
    };
  }
  syncBuiltinESMExports();
}
const { acquireLock } = await import(moduleUrl);
let lock;
process.on('message', async message => {
  if (message === 'acquire' || message === 'retry') {
    do {
      try { lock = acquireLock(paths); process.send({ type: 'acquired' }); return; }
      catch (error) {
        if (message !== 'retry' || error.code !== 'LOCK_HELD') {
          process.send({ type: 'failed', code: error.code, stage: error.stage, retryable: error.retryable }); return;
        }
        await new Promise(done => setTimeout(done, 5));
      }
    } while (true);
  }
  if (message === 'legacy') {
    try {
      // Frozen 0.1.0 acquisition algorithm: unknown JSON is considered stale.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const fd = fs.openSync(paths.lockFile, 'wx');
          fs.writeFileSync(fd, JSON.stringify({pid: process.pid, token: 'legacy', at: new Date().toISOString()}));
          fs.closeSync(fd); process.send({ type: 'legacy-acquired' }); return;
        } catch (error) {
          if (error.code !== 'EEXIST') throw error;
          let holder;
          try { holder = JSON.parse(fs.readFileSync(paths.lockFile, 'utf8')); } catch {}
          let alive = false;
          if (holder && Number.isInteger(holder.pid)) {
            try { process.kill(holder.pid, 0); alive = true; } catch {}
          }
          if (alive) throw Object.assign(new Error('held'), {code: 'LOCK_HELD'});
          fs.rmSync(paths.lockFile, {force: true});
        }
      }
    } catch (error) { process.send({ type: 'legacy-blocked', code: error.code }); }
  }
  if (message === 'stress') {
    let acquired = 0;
    try {
      while (acquired < 15) {
        let current;
        try { current = acquireLock(paths); }
        catch (error) { if (error.code !== 'LOCK_HELD') throw error; await new Promise(done => setTimeout(done, 2)); continue; }
        try {
          const fd = fs.openSync(root + '/critical-section', 'wx');
          await new Promise(done => setTimeout(done, 2));
          fs.closeSync(fd); fs.unlinkSync(root + '/critical-section'); acquired++;
        } finally { current.release(); }
      }
      process.send({ type: 'stress-complete', acquired });
    } catch (error) { process.send({ type: 'stress-failed', code: error.code, message: error.message }); }
  }
  if (message === 'release') { lock.release(); process.send({ type: 'released' }); }
  if (message === 'exit') process.exit(0);
});
process.send({ type: 'ready' });
`;
const moduleUrl = new URL('../src/state.mjs', import.meta.url).href;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'xj139-lock-'));
  const children = [];
  t.after(async () => {
    await Promise.all(children.map(child => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const stopped = new Promise(done => child.once('exit', done));
      child.kill('SIGKILL');
      return stopped;
    }));
    rmSync(root, { recursive: true, force: true });
  });
  return { root, children, lockFile: join(root, 'lock') };
}

async function childFor(f, mode = '', root = f.root) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', worker, moduleUrl, root, mode], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const messages = [];
  let pending;
  child.on('message', message => {
    if (pending) { const done = pending; pending = undefined; done(message); }
    else messages.push(message);
  });
  child.next = () => messages.length ? Promise.resolve(messages.shift()) : new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending = undefined; reject(new Error(`child timeout: ${stderr}`)); }, 10000);
    pending = message => { clearTimeout(timer); resolve(message); };
  });
  child.ask = message => { child.send(message); return child.next(); };
  f.children.push(child);
  assert.deepEqual(await child.next(), { type: 'ready' });
  return child;
}

async function paused(f) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (existsSync(join(f.root, 'paused'))) return;
    await new Promise(done => setTimeout(done, 5));
  }
  assert.fail('child did not reach creation barrier');
}

const held = { type: 'failed', code: 'LOCK_HELD', stage: 'lock', retryable: true };

for (const mode of ['creation', 'publication']) test(`${mode} window: paused creator cannot delete or share a live contender lock`, { timeout: 15000 }, async t => {
  const f = fixture(t);
  const creator = await childFor(f, mode);
  creator.send('acquire');
  await paused(f);
  const contender = await childFor(f);
  assert.deepEqual(await contender.ask('acquire'), { type: 'acquired' });
  writeFileSync(join(f.root, 'continue'), '');
  assert.deepEqual(await creator.next(), held, 'creator must lose to the still-live holder');
  assert.deepEqual(await creator.ask('acquire'), held);
  assert.deepEqual(await contender.ask('release'), { type: 'released' });
  assert.deepEqual(await creator.ask('acquire'), { type: 'acquired' });
});

for (const mode of ['creation', 'initialization', 'publication', 'holder']) {
  test(`process death during ${mode}: concurrent successors use one permanent lock`, { timeout: 15000 }, async t => {
    const f = fixture(t);
    const creator = await childFor(f, mode === 'holder' ? '' : mode);
    if (mode === 'holder') assert.deepEqual(await creator.ask('acquire'), { type: 'acquired' });
    else { creator.send('acquire'); await paused(f); }
    const successors = await Promise.all(Array.from({ length: 6 }, () => childFor(f)));
    // Repeated live contenders must fail without modifying the holder's inode.
    if (mode === 'holder') {
      const before = lstatSync(join(f.lockFile, 'mutex.sqlite'));
      assert.deepEqual(await Promise.all(successors.map(child => child.ask('acquire'))), successors.map(() => held));
      const after = lstatSync(join(f.lockFile, 'mutex.sqlite'));
      assert.equal(after.ino, before.ino);
    }
    const exited = new Promise(done => creator.once('exit', done));
    creator.kill('SIGKILL');
    await exited;
    const results = await Promise.all(successors.map(child => child.ask('acquire')));
    assert.equal(results.filter(result => result.type === 'acquired').length, 1);
    assert.equal(results.filter(result => result.code === 'LOCK_HELD').length, 5);
    const winner = successors[results.findIndex(result => result.type === 'acquired')];
    const retrying = successors.find(child => child !== winner);
    retrying.send('retry');
    assert.deepEqual(await winner.ask('release'), { type: 'released' });
    assert.deepEqual(await retrying.next(), { type: 'acquired' });
    // A former holder's repeated release cannot close the successor's handle.
    assert.deepEqual(await winner.ask('release'), { type: 'released' });
    assert.deepEqual(await winner.ask('acquire'), held);
  });
}

test('six processes repeatedly enter a real exclusive critical section without overlap', { timeout: 20000 }, async t => {
  const f = fixture(t);
  const workers = await Promise.all(Array.from({ length: 6 }, () => childFor(f)));
  const results = await Promise.all(workers.map(child => child.ask('stress')));
  assert.deepEqual(results, workers.map(() => ({ type: 'stress-complete', acquired: 15 })));
  assert.equal(existsSync(join(f.root, 'critical-section')), false);
});

test('different environments and different lock names remain independent', async t => {
  const f = fixture(t);
  const first = await childFor(f);
  const other = await childFor(f, '', join(f.root, 'other-environment'));
  assert.deepEqual(await first.ask('acquire'), { type: 'acquired' });
  assert.deepEqual(await other.ask('acquire'), { type: 'acquired' });
  const selection = acquireLock({ root: f.root, lockFile: join(f.root, 'selection.lock') });
  try { assert.deepEqual(await first.ask('acquire'), held); }
  finally { selection.release(); }
});

test('0.1.0 stale-file deletion cannot steal a 0.2.0 directory lock', async t => {
  const f = fixture(t);
  const current = await childFor(f);
  const legacy = await childFor(f);
  assert.deepEqual(await current.ask('acquire'), { type: 'acquired' });
  const original = readFileSync(join(f.lockFile, 'mutex.sqlite'));
  const result = await legacy.ask('legacy');
  assert.equal(result.type, 'legacy-blocked');
  assert.ok(['EISDIR', 'ERR_FS_EISDIR', 'EPERM'].includes(result.code), JSON.stringify(result));
  assert.deepEqual(readFileSync(join(f.lockFile, 'mutex.sqlite')), original);
  assert.deepEqual(await legacy.ask('acquire'), held);
});

for (const [name, value, code] of [
  ['empty/in-progress', '', 'LOCK_UNSAFE'],
  ['broken', '{"pid":', 'LOCK_UNSAFE'],
  ['unknown', '{"pid":999999}', 'LOCK_UNSAFE'],
  ['dead legacy', JSON.stringify({ pid: 2 ** 22, token: 'old', at: new Date().toISOString() }), 'LOCK_LEGACY'],
  ['live legacy', JSON.stringify({ pid: process.pid, token: 'old', at: new Date().toISOString() }), 'LOCK_HELD'],
]) {
  test(`${name} JSON: multiple processes preserve the original object`, async t => {
    const f = fixture(t);
    writeFileSync(f.lockFile, value);
    const contenders = await Promise.all(Array.from({ length: 3 }, () => childFor(f)));
    const results = await Promise.all(contenders.map(child => child.ask('acquire')));
    for (const result of results) {
      assert.equal(result.code, code);
      assert.equal(result.stage, 'lock');
    }
    assert.equal(readFileSync(f.lockFile, 'utf8'), value);
  });
}

test('explicit offline legacy migration preserves the old file and enables new locks', t => {
  const f = fixture(t);
  const old = JSON.stringify({ pid: 2 ** 22, token: 'old', at: new Date().toISOString() });
  writeFileSync(f.lockFile, old);
  assert.throws(() => acquireLock(f), { code: 'LOCK_LEGACY' });
  renameSync(f.lockFile, join(f.root, 'legacy-lock.json'));
  const lock = acquireLock(f);
  lock.release();
  assert.equal(readFileSync(join(f.root, 'legacy-lock.json'), 'utf8'), old);
});

test('foreign SQLite, including a forged application id, is never modified', t => {
  const f = fixture(t);
  mkdirSync(f.lockFile);
  const file = join(f.lockFile, 'mutex.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE business (value TEXT); INSERT INTO business VALUES (\'keep me\')');
  db.close();
  for (const forged of [false, true]) {
    if (forged) {
      const db = new DatabaseSync(file);
      db.exec('PRAGMA application_id = 1481264203');
      db.close();
    }
    const original = readFileSync(file);
    assert.throws(() => acquireLock(f), { code: 'LOCK_UNSAFE' });
    assert.deepEqual(readFileSync(file), original);
    assert.equal(existsSync(file + '-journal'), false);
  }
});

test('unknown/empty mutex files and sidecars are preserved', t => {
  const f = fixture(t);
  mkdirSync(f.lockFile);
  const file = join(f.lockFile, 'mutex.sqlite');
  for (const value of ['', 'not a database']) {
    writeFileSync(file, value);
    assert.throws(() => acquireLock(f), { code: 'LOCK_UNSAFE' });
    assert.equal(readFileSync(file, 'utf8'), value);
  }
  rmSync(file); // Test fixture only; no holder exists.
  acquireLock(f).release();
  const original = readFileSync(file);
  for (const suffix of ['-journal', '-wal', '-shm']) {
    writeFileSync(file + suffix, 'unknown sidecar');
    assert.throws(() => acquireLock(f), { code: 'LOCK_UNSAFE' });
    assert.equal(readFileSync(file + suffix, 'utf8'), 'unknown sidecar');
    assert.deepEqual(readFileSync(file), original);
    rmSync(file + suffix);
  }
});

test('final lock-directory symlink/junction and mutex symlink cannot redirect writes', t => {
  const f = fixture(t);
  const target = join(f.root, 'foreign-directory');
  mkdirSync(target);
  writeFileSync(join(target, 'business.txt'), 'keep me');
  symlinkSync(target, f.lockFile, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => acquireLock(f), { code: 'LOCK_UNSAFE' });
  assert.equal(readFileSync(join(target, 'business.txt'), 'utf8'), 'keep me');
  rmSync(f.lockFile);
  mkdirSync(f.lockFile);
  const foreign = join(target, 'foreign.sqlite');
  writeFileSync(foreign, 'keep me');
  try { symlinkSync(foreign, join(f.lockFile, 'mutex.sqlite'), 'file'); }
  catch (error) { if (error.code === 'EPERM') { t.diagnostic('file symlink requires Windows Developer Mode; junction was checked'); return; } throw error; }
  assert.throws(() => acquireLock(f), { code: 'LOCK_UNSAFE' });
  assert.equal(readFileSync(foreign, 'utf8'), 'keep me');
});
