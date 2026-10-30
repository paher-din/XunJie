import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { resolveContext } from '../src/commands.mjs';
import { ensureBaseline } from '../src/baseline.mjs';
import { databaseDriver } from '../src/repro-data.mjs';
import { captureRepro, restoreRepro } from '../src/repro.mjs';
import { environmentId, environmentPaths } from '../src/paths.mjs';
import { collectCode, git } from '../src/repro-code.mjs';
import { decodeZip, digest, encodeZip, jsonBytes } from '../src/repro-archive.mjs';

const worktree = resolve(import.meta.dirname, '../../..'), cli = join(worktree, 'tools/xj-dev/xj-dev.mjs');
const root = realpathSync(mkdtempSync(join(tmpdir(), 'xj-repro-restore-review-'))), targets = [];
const file = join(root, 'scene.zip'), preload = join(root, 'controlled-boundary.mjs');
const codePaths = ['package-lock.json', 'package.json', 'tools/xj-dev/package.json', 'README.md'];
function ownedRegistrations() {
  const normalize = path => path.replaceAll('\\', '/');
  return git(worktree, ['worktree', 'list', '--porcelain']).split(/\r?\n\r?\n/)
    .filter(entry => normalize(entry.split('\n')[0]).startsWith(`worktree ${normalize(root)}/`)).sort();
}

before(async () => {
  const previous = process.env.XJ_DEV_HOME; process.env.XJ_DEV_HOME = join(root, 'source-home');
  const context = resolveContext({ worktree, instance: 'review' });
  if (previous === undefined) delete process.env.XJ_DEV_HOME; else process.env.XJ_DEV_HOME = previous;
  await ensureBaseline(context.repo.server, context.env, () => {});
  const Driver = databaseDriver(context.repo.server), db = new Driver(context.env.database, { readonly: true });
  let attemptId;
  try { attemptId = db.prepare("SELECT attempt_id FROM attempts WHERE course_id='synthetic-textscope-c'").get().attempt_id; } finally { db.close(); }
  const contextFile = join(root, 'context.json');
  writeFileSync(contextFile, JSON.stringify({ formatVersion: 'xj-repro-context/1',
    code: { roots: codePaths },
    data: { scope: { courseIds: ['synthetic-textscope-c'], userIds: ['synthetic-teacher', 'synthetic-student'], attemptIds: [attemptId] } },
    scenario: { title: 'restore ownership', start: 'before-trigger', expected: 'isolated environment', observed: 'inspect after recovery', steps: ['恢复后检查选中任务。'] } }));
  await captureRepro(context, { contextFile, out: file });
  // Pause/fail real OS subprocess/filesystem boundaries without changing production code.
  writeFileSync(preload, `
import cp from 'node:child_process';
import fs from 'node:fs';
import {resolve,join} from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
const originalSpawn=cp.spawnSync, originalAsyncSpawn=cp.spawn, originalWrite=fs.writeFileSync;
cp.spawn=function(command,args,options){
  if(process.env.XJ_REVIEW_INSTALL_FROM && args[1]==='ci' && args[0].endsWith('npm-cli.js')){
    const app='workspace';
    fs.appendFileSync(process.env.XJ_REVIEW_INSTALL_TRACE,app+'\\n');
    fs.symlinkSync(join(process.env.XJ_REVIEW_INSTALL_FROM,'node_modules'),join(options.cwd,'node_modules'),process.platform==='win32'?'junction':'dir');
    return originalAsyncSpawn.call(this,command,['-e',''],options);
  }
  return originalAsyncSpawn.call(this,command,args,options);
};
cp.spawnSync=function(command,args,options){
  const index=args.indexOf('worktree');
  if(command==='git' && args[index+1]==='add' && process.env.XJ_REVIEW_DELAY==='yes'){
    originalWrite(process.env.XJ_REVIEW_READY,'ready');
    const cell=new Int32Array(new SharedArrayBuffer(4)), deadline=Date.now()+60000;
    while(!fs.existsSync(process.env.XJ_REVIEW_RELEASE)){
      if(Date.now()>deadline)throw new Error('controlled boundary timed out');
      Atomics.wait(cell,0,0,20);
    }
  }
  const result=originalSpawn.call(this,command,args,options);
  if(command==='git' && args[index+1]==='add' && result.status===0 && process.env.XJ_REVIEW_FOREIGN_ENV){
    fs.mkdirSync(process.env.XJ_REVIEW_FOREIGN_ENV,{recursive:true});
    originalWrite(join(process.env.XJ_REVIEW_FOREIGN_ENV,'foreign-canary'),'foreign owner');
  }
  return result;
};
fs.writeFileSync=function(path,...args){
  if(process.env.XJ_REVIEW_FAIL_WRITE && typeof path==='string' && resolve(path)===join(process.env.XJ_REVIEW_FAIL_WRITE,'README.md'))
    throw Object.assign(new Error('controlled source write failure'),{code:'EIO'});
  if(process.env.XJ_REVIEW_FAIL_FILE && typeof path==='string' && resolve(path)===process.env.XJ_REVIEW_FAIL_FILE)
    throw Object.assign(new Error('controlled environment publication failure'),{code:'EIO'});
  return originalWrite.call(this,path,...args);
};
syncBuiltinESMExports();
`);
});
after(() => {
  for (const target of targets) if (existsSync(target)) git(worktree, ['worktree', 'remove', '--force', target]);
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

function launchCli(home, args, controls = {}, receiver = worktree) {
  const receiverCli = receiver === worktree ? cli : join(receiver, 'tools/xj-dev/xj-dev.mjs');
  const child = spawn(process.execPath, ['--import', pathToFileURL(preload).href, receiverCli, ...args, '--worktree', receiver],
    { env: { ...process.env, XJ_DEV_HOME: home, ...controls }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  const result = new Promise((resolveResult, reject) => {
    child.on('error', reject);
    child.on('close', status => {
      try { resolveResult({ status, envelope: JSON.parse(stdout) }); }
      catch { reject(new Error(`Restore produced no JSON: ${stderr.slice(-500)}`)); }
    });
  });
  return { child, result };
}
function launch(home, target, controls = {}) {
  return launchCli(home, ['repro', 'restore', file, '--target', target], controls);
}
function coldCheckout(receiver, localStartup = false) {
  mkdirSync(receiver); git(receiver, ['init', '-q']);
  for (const path of [...codePaths, 'apps/server', ...(localStartup ? ['apps/web'] : []), 'packages/contracts', 'scripts', 'tools/xj-dev/src', 'tools/xj-dev/xj-dev.mjs']) {
    mkdirSync(dirname(join(receiver, path)), { recursive: true });
    cpSync(join(worktree, path), join(receiver, path), { recursive: true,
      filter: source => !['node_modules', 'dist', 'coverage', 'evidence'].includes(basename(source)) });
  }
}

test('a real captured scene restores from a cold checkout only after explicit dependency preparation', async t => {
  const receiver = join(root, 'cold-source'), target = join(root, 'cold-restored'), home = join(root, 'cold-home');
  coldCheckout(receiver);
  t.after(() => { if (existsSync(target)) git(receiver, ['worktree', 'remove', '--force', target]); });
  const args = ['repro', 'restore', file, '--target', target], original = readFileSync(join(receiver, 'README.md'));
  const missing = await launchCli(home, args, {}, receiver).result;
  assert.equal(missing.envelope.failure.code, 'DEPENDENCIES_NOT_READY');
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(environmentPaths(home, environmentId(target)).root), false);
  assert.equal(existsSync(join(receiver, 'node_modules')), false);
  // Reuse the test host's installed native dependency to model the explicit
  // preparation boundary. Restore itself must never install or start services.
  symlinkSync(join(worktree, 'node_modules'), join(receiver, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const prepared = await launchCli(home, args, {}, receiver).result;
  assert.equal(prepared.status, 0, JSON.stringify(prepared.envelope.failure));
  assert.equal(prepared.envelope.verification.restored, true);
  assert.equal(prepared.envelope.verification.reproduction, 'unverified');
  assert.ok(existsSync(environmentPaths(home, environmentId(target)).database));
  assert.equal(existsSync(join(target, 'node_modules')), false);
  assert.deepEqual(readFileSync(join(receiver, 'README.md')), original);
});

for (const mode of ['cloud', 'cloud-api']) test(`public missing-dependency recovery prepares local from selected ${mode} and preserves its scene`, { timeout: 90000 }, async t => {
  const receiver = join(root, `cold-${mode}`), target = join(root, `recovered-${mode}`), home = join(root, `home-${mode}`);
  coldCheckout(receiver, true);
  const local = environmentPaths(home, environmentId(receiver)), remote = environmentPaths(home, environmentId(receiver, mode));
  mkdirSync(local.root, { recursive: true }); mkdirSync(remote.data, { recursive: true }); mkdirSync(remote.browserProfile, { recursive: true });
  const selectionFile = join(local.root, 'selection.json');
  const selection = { mode, targets: { [mode]: { id: environmentId(receiver, mode), root: remote.root,
    connectionFile: join(root, 'unavailable-cloud.json') } } };
  writeFileSync(selectionFile, JSON.stringify(selection));
  const data = join(remote.data, 'shared-scene'), draft = join(remote.browserProfile, 'draft');
  writeFileSync(data, 'synthetic cloud scene'); writeFileSync(draft, 'synthetic unsaved cloud draft');
  t.after(async () => {
    await launchCli(home, ['down'], {}, receiver).result;
    if (existsSync(target)) git(receiver, ['worktree', 'remove', '--force', target]);
  });
  const restoreArgs = ['repro', 'restore', file, '--target', target];
  const missing = await launchCli(home, restoreArgs, {}, receiver).result;
  assert.equal(missing.envelope.failure.code, 'DEPENDENCIES_NOT_READY');
  assert.deepEqual(JSON.parse(readFileSync(selectionFile)), selection, 'restore must not silently change the selected mode');
  assert.equal(existsSync(target), false); assert.equal(existsSync(join(receiver, 'node_modules')), false);
  // Execute the actual commands advertised by the failure, including their
  // worktree. Only npm's network/install subprocess is controlled; the public
  // mode routing, the workspace dependency request, native driver and services are real.
  const commands = [...missing.envelope.failure.recovery.matchAll(/node "([^"]+)" ([a-z]+(?: [a-z]+)?) --worktree "([^"]+)"/g)];
  assert.equal(commands.length, 2);
  const trace = join(root, `installs-${mode}`);
  for (const [, script, command, worktreeArgument] of commands) {
    assert.equal(script, join(receiver, 'tools/xj-dev/xj-dev.mjs')); assert.equal(worktreeArgument, receiver);
    const prepared = await launchCli(home, command.split(' '), { XJ_REVIEW_INSTALL_FROM: worktree, XJ_REVIEW_INSTALL_TRACE: trace }, receiver).result;
    assert.equal(prepared.status, 0, JSON.stringify(prepared.envelope.failure));
    if (command === 'doctor') assert.deepEqual(JSON.parse(readFileSync(selectionFile)), selection);
    else {
      assert.equal(prepared.envelope.mode, 'local');
      assert.equal(Object.values(prepared.envelope.processes).every(process => process.running), true);
    }
  }
  assert.deepEqual(readFileSync(trace, 'utf8').trim().split('\n'), ['workspace']);
  assert.deepEqual(JSON.parse(readFileSync(selectionFile)), { ...selection, mode: 'local' });
  const restored = await launchCli(home, restoreArgs, {}, receiver).result;
  assert.equal(restored.status, 0, JSON.stringify(restored.envelope.failure));
  assert.equal(restored.envelope.verification.restored, true);
  assert.equal(restored.envelope.verification.reproduction, 'unverified');
  assert.equal(readFileSync(data, 'utf8'), 'synthetic cloud scene');
  assert.equal(readFileSync(draft, 'utf8'), 'synthetic unsaved cloud draft');
});
async function ready(file) {
  const deadline = Date.now() + 30000;
  while (!existsSync(file)) { assert.ok(Date.now() < deadline, 'delayed restore reached git worktree add'); await delay(20); }
}
for (const differentHomes of [false, true]) test(`same-target restores preserve the winner (${differentHomes ? 'different' : 'same'} CLI homes)`, { timeout: 90000 }, async () => {
  const suffix = differentHomes ? 'different' : 'same', target = join(root, `receiver-${suffix}`); targets.push(target);
  const homeA = join(root, `home-${suffix}-a`), homeB = differentHomes ? join(root, `home-${suffix}-b`) : homeA;
  const signal = join(root, `ready-${suffix}`), release = join(root, `release-${suffix}`);
  const b = launch(homeB, target, { XJ_REVIEW_DELAY: 'yes', XJ_REVIEW_READY: signal, XJ_REVIEW_RELEASE: release });
  let a;
  try {
    await ready(signal);
    a = await launch(homeA, target).result;
    if (a.envelope.ok) writeFileSync(join(a.envelope.environment.root, 'preserve-canary'), 'created after success');
  } finally { writeFileSync(release, 'release'); await b.result; }
  const bResult = await b.result;
  const winners = [a, bResult].filter(result => result.envelope.ok), losers = [a, bResult].filter(result => !result.envelope.ok);
  assert.equal(winners.length, 1); assert.equal(losers.length, 1);
  const winner = winners[0].envelope;
  assert.ok(existsSync(winner.data.database), 'failed contender must not remove the successful database');
  assert.ok(existsSync(join(winner.environment.root, 'repro-receipt.json')), 'winner receipt survives');
  if (a.envelope.ok) assert.equal(readFileSync(join(winner.environment.root, 'preserve-canary'), 'utf8'), 'created after success');
  assert.ok(['TARGET_EXISTS', 'LOCK_HELD'].includes(losers[0].envelope.failure.code), 'target reservation rejects the contender before Git mutation');
  assert.equal(git(target, ['rev-parse', 'HEAD']).trim(), winner.package.manifest.code.exportedCommit);
});

test('source write failure after worktree add removes only its own partial worktree and metadata', { timeout: 90000 }, async () => {
  const target = join(root, 'write-failure'), home = join(root, 'write-home'); targets.push(target);
  const before = ownedRegistrations();
  const result = await launch(home, target, { XJ_REVIEW_FAIL_WRITE: target }).result;
  assert.equal(result.status, 1); assert.equal(result.envelope.ok, false);
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(environmentPaths(home, environmentId(target)).database), false);
  assert.deepEqual(ownedRegistrations(), before);
});

test('public CLI inspect/restore/verify reject a rechecksummed package with empty steps', async () => {
  const entries = decodeZip(readFileSync(file)), scenario = JSON.parse(entries.get('scenario.json'));
  scenario.steps = []; entries.set('scenario.json', jsonBytes(scenario));
  entries.set('checksums.json', jsonBytes(Object.fromEntries([...entries].filter(([path]) => path !== 'checksums.json').map(([path, bytes]) => [path, digest(bytes)]))));
  const changed = join(root, 'empty-steps.zip'); writeFileSync(changed, encodeZip(entries));
  for (const route of ['inspect', 'restore', 'verify']) {
    const result = await launchCli(join(root, 'empty-home'), ['repro', route, changed]).result;
    assert.equal(result.status, 1); assert.equal(result.envelope.failure.code, 'INVALID_SCENARIO');
  }
  assert.equal(existsSync(join(root, 'empty-home')), false, 'invalid scenario is rejected before any restore/session activity');
});

test('environment publication failure rolls back its own data/worktree; a newly appearing foreign environment survives', async () => {
  for (const foreign of [false, true]) {
    const target = join(root, foreign ? 'foreign-env' : 'data-failure'), home = join(root, foreign ? 'foreign-home' : 'data-home'); targets.push(target);
    const env = environmentPaths(home, environmentId(target)), before = ownedRegistrations();
    const result = await launch(home, target, foreign ? { XJ_REVIEW_FOREIGN_ENV: env.root } : { XJ_REVIEW_FAIL_FILE: env.database }).result;
    assert.equal(result.envelope.ok, false); assert.equal(existsSync(target), false);
    assert.deepEqual(ownedRegistrations(), before);
    if (foreign) {
      assert.equal(result.envelope.failure.code, 'TARGET_EXISTS');
      assert.equal(readFileSync(join(env.root, 'foreign-canary'), 'utf8'), 'foreign owner');
    } else assert.equal(existsSync(env.root), false);
  }
});

test('Windows restores to a fresh task-owned drive-root target with matching canonical path and environment ID',
  { skip: process.platform !== 'win32' }, async () => {
    const target = join(parse(worktree).root, `xj130-review-${randomUUID()}`), home = join(root, 'drive-root-home');
    assert.equal(existsSync(target), false); targets.push(target);
    try {
      const result = await launch(home, target).result;
      assert.equal(result.envelope.ok, true, JSON.stringify(result.envelope.failure));
      assert.equal(result.envelope.environment.worktree, target);
      assert.equal(result.envelope.environment.id, environmentId(target));
      assert.ok(existsSync(join(target, 'README.md')));
      assert.ok(existsSync(environmentPaths(home, environmentId(target)).database));
    } finally {
      if (existsSync(target)) git(worktree, ['worktree', 'remove', '--force', target]);
      // These are this test's paths only; all participating child processes exited.
      const lock = join(dirname(target), `.xj-repro-restore-${environmentId(target.normalize('NFC').toLowerCase())}.lock`);
      rmSync(lock, { recursive: true, force: true, maxRetries: 3 });
    }
  });

test('verified bundle lock contents must match conditions before any target/environment/Git metadata is published', async () => {
  const repo = join(root, 'changed-lock-source'); mkdirSync(repo); git(repo, ['init', '-q']);
  for (const path of codePaths) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    let bytes = readFileSync(join(worktree, path));
    if (path === 'package-lock.json') {
      const lock = JSON.parse(bytes); lock.packages['node_modules/better-sqlite3'].version = '0.0.0-review'; bytes = jsonBytes(lock);
    }
    writeFileSync(join(repo, path), bytes);
  }
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'review sentinel lock change']);
  const scratch = join(root, 'changed-lock-capture'); mkdirSync(scratch);
  const code = collectCode(repo, scratch, { roots: codePaths });
  const entries = decodeZip(readFileSync(file)), manifest = JSON.parse(entries.get('manifest.json'));
  entries.set('code/source.bundle', code.bytes);
  manifest.code = { ...code.manifest, bundleDigest: digest(code.bytes) }; // Deliberately retain original dependency conditions.
  entries.set('manifest.json', jsonBytes(manifest));
  entries.set('checksums.json', jsonBytes(Object.fromEntries([...entries].filter(([path]) => path !== 'checksums.json').map(([path, bytes]) => [path, digest(bytes)]))));
  const changed = join(root, 'changed-lock.zip'); writeFileSync(changed, encodeZip(entries));
  const previous = process.env.XJ_DEV_HOME; process.env.XJ_DEV_HOME = join(root, 'changed-lock-home');
  const context = resolveContext({ worktree });
  if (previous === undefined) delete process.env.XJ_DEV_HOME; else process.env.XJ_DEV_HOME = previous;
  const target = join(root, 'changed-lock-target'); targets.push(target);
  const before = ownedRegistrations();
  await assert.rejects(() => restoreRepro(context, { file: changed, target }), { code: 'LOCKFILE_MISMATCH' });
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(environmentPaths(context.home, environmentId(target)).root), false);
  assert.deepEqual(ownedRegistrations(), before);
});

test('actual CRLF bundle locks satisfy LF conditions while their source digests preserve raw bytes', async () => {
  const repo = join(root, 'crlf-source'); mkdirSync(repo); git(repo, ['init', '-q']); git(repo, ['config', 'core.autocrlf', 'false']);
  for (const path of codePaths) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), readFileSync(join(worktree, path), 'utf8').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
  }
  git(repo, ['add', '.']); git(repo, ['commit', '-qm', 'review CRLF bundle control']);
  const scratch = join(root, 'crlf-capture'); mkdirSync(scratch);
  const code = collectCode(repo, scratch, { roots: codePaths });
  const entries = decodeZip(readFileSync(file)), manifest = JSON.parse(entries.get('manifest.json'));
  entries.set('code/source.bundle', code.bytes); manifest.code = { ...code.manifest, bundleDigest: digest(code.bytes) };
  entries.set('manifest.json', jsonBytes(manifest));
  entries.set('checksums.json', jsonBytes(Object.fromEntries([...entries].filter(([path]) => path !== 'checksums.json').map(([path, bytes]) => [path, digest(bytes)]))));
  const changed = join(root, 'crlf.zip'); writeFileSync(changed, encodeZip(entries));
  const target = join(root, 'crlf-target'), home = join(root, 'crlf-home'); targets.push(target);
  const previous = process.env.XJ_DEV_HOME; process.env.XJ_DEV_HOME = home;
  const context = resolveContext({ worktree });
  if (previous === undefined) delete process.env.XJ_DEV_HOME; else process.env.XJ_DEV_HOME = previous;
  await restoreRepro(context, { file: changed, target });
  for (const path of codePaths) assert.equal(digest(readFileSync(join(target, path))), digest(readFileSync(join(repo, path))));
});
