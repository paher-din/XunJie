import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { CliError, failureEnvelope, resultEnvelope } from '../src/envelope.mjs';
import { PINNED_NODE, environmentId, environmentPaths, findWorktreeRoot, toolHome } from '../src/paths.mjs';
import { allocatePorts, basePortFor, portFree } from '../src/ports.mjs';
import { acquireLock, loadState, saveState } from '../src/state.mjs';
import { componentRunning, spawnComponent, stopComponent } from '../src/processes.mjs';
import { dependenciesFresh, locatePinnedRuntime, npmCliJs, runNode } from '../src/runtime.mjs';

test('runNode keeps npm lifecycle node on the selected runtime', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'xj-shadow-node-'));
  try {
    const shadow = join(directory, process.platform === 'win32' ? 'node.exe' : 'node');
    writeFileSync(shadow, process.platform === 'win32' ? 'invalid executable' : '#!/bin/sh\necho v99.0.0\n');
    chmodSync(shadow, 0o755);
    const result = await runNode(process.execPath, ['-e',
      `const {execFileSync}=require('node:child_process'); process.stdout.write(execFileSync('node',['--version'],{encoding:'utf8'}));`],
    { env: { PATH: directory } });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout.trim(), PINNED_NODE);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('npmCliJs locates POSIX and Windows distribution layouts', () => {
  const root = mkdtempSync(join(tmpdir(), 'xj-npm-layout-'));
  try {
    for (const [name, executable, relative] of [
      ['posix', join('bin', 'node'), join('lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')],
      ['windows', 'node.exe', join('node_modules', 'npm', 'bin', 'npm-cli.js')],
      [join('windows', 'bin'), 'node.exe', join('node_modules', 'npm', 'bin', 'npm-cli.js')],
    ]) {
      const prefix = join(root, name);
      const cli = join(prefix, relative);
      mkdirSync(dirname(cli), { recursive: true });
      writeFileSync(cli, '');
      assert.equal(npmCliJs(join(prefix, executable)), cli);
    }
    assert.throws(() => npmCliJs(join(root, 'missing', 'node')),
      error => error instanceof CliError && error.code === 'NPM_MISSING');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

assert.equal(process.version, PINNED_NODE,
  `xj-dev 测试必须由受管 Node ${PINNED_NODE} 运行（当前 ${process.version}）；先 node tools/xj-dev/xj-dev.mjs doctor 确认定位。`);

const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worktreeRoot = resolve(toolRoot, '..', '..');

function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `xj-dev-${label}-`));
}

function fakeNode(directory, version) {
  const file = join(directory, process.platform === 'win32' ? `node-${version}.exe` : 'fake-node');
  if (process.platform === 'win32') {
    if (version === PINNED_NODE) copyFileSync(process.execPath, file);
    else writeFileSync(file, 'invalid executable');
  } else {
    writeFileSync(file, `#!/bin/sh\necho ${version}\n`);
    chmodSync(file, 0o755);
  }
  return file;
}

test('environmentId 稳定、随 instance 变化、为 12 位十六进制', () => {
  const id = environmentId(worktreeRoot, '');
  assert.match(id, /^[0-9a-f]{12}$/);
  assert.equal(environmentId(worktreeRoot, ''), id);
  assert.notEqual(environmentId(worktreeRoot, 'second'), id);
  assert.notEqual(environmentId('/elsewhere-checkout', ''), id);
});

test('environmentPaths 布局与 toolHome 覆盖', () => {
  const home = tempDir('home');
  const paths = environmentPaths(home, 'abcdef012345');
  assert.equal(paths.root, join(home, 'envs', 'abcdef012345'));
  assert.equal(paths.database, join(paths.root, 'data', 'xunjie.sqlite'));
  assert.equal(paths.lockFile, join(paths.root, 'lock'));
  assert.equal(toolHome({ XJ_DEV_HOME: home }), home);
  assert.ok(toolHome({}).endsWith(join('.xunjie', 'xj-dev')));
});

test('findWorktreeRoot 向上定位 .git，仓库外报 NOT_A_WORKTREE', () => {
  assert.equal(findWorktreeRoot(toolRoot), realpathSync(worktreeRoot));
  const outside = tempDir('outside');
  assert.throws(() => findWorktreeRoot(outside), error => error instanceof CliError && error.code === 'NOT_A_WORKTREE');
});

test('basePortFor 确定且在 24000 起的三连段内', () => {
  for (const identity of ['a', 'b', 'env-1']) {
    const base = basePortFor(identity);
    assert.equal(base, basePortFor(identity));
    assert.ok(base >= 24000 && base + 2 < 33000, `base ${base} in range`);
    assert.equal((base - 24000) % 3, 0);
  }
});

test('portFree 与 allocatePorts 跳过被占用端口', async () => {
  const identity = `unit-${process.pid}`;
  const base = basePortFor(identity);
  assert.equal(await portFree(base), true);
  const blocker = createServer();
  await new Promise(done => blocker.listen(base, '127.0.0.1', done));
  try {
    assert.equal(await portFree(base), false);
    const allocated = await allocatePorts(identity);
    assert.ok(allocated, 'allocation succeeds despite occupied base');
    assert.notEqual(allocated.gateway, base);
    assert.equal(allocated.backend, allocated.gateway + 1);
    assert.equal(allocated.vite, allocated.gateway + 2);
    assert.ok(allocated.gateway > base, 'scanner moves upward past the occupied port');
  } finally {
    await new Promise(done => blocker.close(done));
  }
});

test('envelope：CliError 透传 stage/code/retryable/recovery 与 stages', () => {
  const error = new CliError('ports', 'PORT_IN_USE', '占用', { retryable: true, recovery: '释放后重试' });
  error.stages = [{ name: 'runtime', ok: true }];
  const failure = failureEnvelope('0.1.0', 'up', error);
  assert.equal(failure.schema, 'xj-dev/result-v1');
  assert.equal(failure.ok, false);
  assert.deepEqual(failure.failure, { stage: 'ports', code: 'PORT_IN_USE', message: '占用', retryable: true, recovery: '释放后重试' });
  assert.deepEqual(failure.stages, [{ name: 'runtime', ok: true }]);
  const internal = failureEnvelope('0.1.0', 'up', new Error('boom'));
  assert.deepEqual(internal.failure, { stage: 'internal', code: 'INTERNAL_ERROR', message: 'boom', retryable: false });
  const success = resultEnvelope('0.1.0', 'status', { value: 1 });
  assert.deepEqual(success, { schema: 'xj-dev/result-v1', tool: { name: 'xj-dev', version: '0.1.0' }, command: 'status', ok: true, value: 1 });
});

test('state：保存/读取往返，损坏文件报 STATE_CORRUPT', () => {
  const root = tempDir('state');
  const paths = environmentPaths(root, 'env-state');
  assert.equal(loadState(paths), undefined);
  saveState(paths, { version: 1, envId: 'env-state' });
  assert.deepEqual(loadState(paths), { version: 1, envId: 'env-state' });
  writeFileSync(paths.stateFile, '{ not json');
  assert.throws(() => loadState(paths), error => error instanceof CliError && error.code === 'STATE_CORRUPT');
});

test('lock：持有者存活时第二次获取报 LOCK_HELD，释放后可再获取', () => {
  const paths = environmentPaths(tempDir('lock'), 'env-lock');
  const first = acquireLock(paths);
  assert.throws(() => acquireLock(paths), error => error instanceof CliError && error.code === 'LOCK_HELD' && error.retryable);
  first.release();
  const second = acquireLock(paths);
  second.release();
  assert.equal(existsSync(paths.lockFile), false);
});

test('lock：持有进程已退出时接管用锁；release 不删他人锁', () => {
  const paths = environmentPaths(tempDir('lock'), 'env-stale');
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(paths.lockFile, JSON.stringify({ pid: 2 ** 22, token: 'dead', at: new Date().toISOString() }));
  const lock = acquireLock(paths);
  const held = JSON.parse(readFileSync(paths.lockFile, 'utf8'));
  assert.equal(held.token, lock.token);
  writeFileSync(paths.lockFile, JSON.stringify({ pid: process.pid, token: 'someone-else' }));
  lock.release();
  assert.equal(existsSync(paths.lockFile), true, '他人的锁不被 release 删除');
});

test('processes：spawn/识别/停止自有进程，外来 pid 不动', async () => {
  const paths = environmentPaths(tempDir('proc'), 'env-proc');
  const sleeper = join(paths.root, 'sleeper.mjs');
  mkdirSync(paths.root, { recursive: true });
  writeFileSync(sleeper, 'setInterval(() => {}, 1000);\n');
  const envId = `procenv${process.pid}`;

  assert.equal(componentRunning(paths, 'sleeper').running, false);
  assert.deepEqual(await stopComponent(paths, 'sleeper'), { component: 'sleeper', result: 'not-registered' });

  const record = spawnComponent(paths, 'sleeper', process.execPath, sleeper, [envId], { envId });
  assert.ok(Number.isInteger(record.pid));
  try {
    const running = componentRunning(paths, 'sleeper');
    assert.equal(running.running, true);
    assert.equal(running.foreign, false);

    const stopped = await stopComponent(paths, 'sleeper');
    assert.equal(stopped.result, 'stopped');
    assert.equal(existsSync(record.file ?? join(paths.pids, 'sleeper.json')), false);
    assert.equal(componentRunning(paths, 'sleeper').running, false);
  } finally {
    try { process.kill(record.pid, 'SIGKILL'); } catch { /* already stopped */ }
  }

  const foreign = spawnComponent(paths, 'sleeper', process.execPath, sleeper, [envId], { envId });
  try {
    const recordFile = join(paths.pids, 'sleeper.json');
    const tampered = { ...JSON.parse(readFileSync(recordFile, 'utf8')), envId: 'someone-elses-env' };
    writeFileSync(recordFile, JSON.stringify(tampered));
    const status = componentRunning(paths, 'sleeper');
    assert.equal(status.running, false);
    assert.equal(status.foreign, true);
    const skipped = await stopComponent(paths, 'sleeper');
    assert.equal(skipped.result, 'skipped-foreign');
    try { process.kill(foreign.pid, 0); } catch { assert.fail('外来进程不得被杀'); }
  } finally {
    try { process.kill(foreign.pid, 'SIGKILL'); } catch { /* cleanup */ }
    rmSync(join(paths.pids, 'sleeper.json'), { force: true });
  }
});

test('runtime：XJ_DEV_NODE_24 优先且按版本过滤候选', () => {
  const directory = tempDir('runtime');
  const pinned = fakeNode(directory, PINNED_NODE);
  assert.equal(locatePinnedRuntime({ XJ_DEV_NODE_24: pinned }, '').path, pinned);
  const wrong = fakeNode(directory, 'v99.0.0');
  const located = locatePinnedRuntime({ XJ_DEV_NODE_24: wrong }, '');
  assert.equal(located.version, PINNED_NODE);
  assert.notEqual(located.path, wrong);
  const originalDirectory = process.cwd();
  try {
    process.chdir(dirname(process.execPath));
    const selected = locatePinnedRuntime({ XJ_DEV_NODE_24: process.platform === 'win32' ? '.\\node.exe' : './node' }, '');
    assert.equal(selected.path, process.execPath);
  } finally {
    process.chdir(originalDirectory);
  }
});

test('dependenciesFresh：以锁文件与安装标记的 mtime 判断', () => {
  const app = tempDir('deps');
  assert.equal(dependenciesFresh(app), false);
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  const lockfile = join(app, 'package-lock.json');
  const marker = join(app, 'node_modules', '.package-lock.json');
  writeFileSync(lockfile, '{}');
  writeFileSync(marker, '{}');
  const past = new Date('2026-01-01T00:00:00Z');
  utimesSync(lockfile, past, past);
  assert.equal(dependenciesFresh(app), true);
  utimesSync(marker, past, past);
  utimesSync(lockfile, new Date(), new Date());
  assert.equal(dependenciesFresh(app), false);
});
