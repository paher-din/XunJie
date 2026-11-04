import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { linuxSessionEntry, planSeatbelt, productNativeAdapters, seatbeltLauncherPath, seatbeltProfileVersion, SupervisedSession } from '@xunjie/learning-space';

function mockLinuxConfig(t, text, metadata = {}) {
  t.mock.method(fs, 'openSync', (path, flags) => {
    assert.equal(path, '/etc/xunjie/native-session.conf');
    assert.equal(flags, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    return 123;
  });
  t.mock.method(fs, 'fstatSync', descriptor => {
    assert.equal(descriptor, 123);
    return { uid: 0, mode: 0o100644, isFile: () => true, ...metadata };
  });
  t.mock.method(fs, 'readFileSync', (descriptor, encoding) => {
    assert.equal(descriptor, 123);
    assert.equal(encoding, 'utf8');
    return text;
  });
  return t.mock.method(fs, 'closeSync', descriptor => assert.equal(descriptor, 123));
}

const linuxDefaults = {
  entry: '/usr/local/lib/xunjie/native-session-entry', sudo: '/usr/bin/sudo',
  workRoot: '/var/lib/xunjie-native', runUser: 'xunjie', nodeRoot: '/opt/xunjie',
};

test('linuxSessionEntry reads installer configuration without changing the privileged command', t => {
  const close = mockLinuxConfig(t, '# 安装配置\nXJ_RUN_USER=school-worker\nXJ_WORK_ROOT=/srv/sessions\n'
    + 'XJ_NODE_ROOT=/srv/runtime\nXJ_STATE_ROOT=/srv/school-state\n');
  assert.deepEqual(linuxSessionEntry(), { ...linuxDefaults, runUser: 'school-worker',
    workRoot: '/srv/sessions', nodeRoot: '/srv/runtime' });
  assert.equal(close.mock.callCount(), 1);
});

test('linuxSessionEntry uses defaults only when the configuration is missing', t => {
  t.mock.method(fs, 'openSync', () => { throw Object.assign(new Error('缺少配置'), { code: 'ENOENT' }); });
  assert.deepEqual(linuxSessionEntry(), linuxDefaults);
});

test('linuxSessionEntry rejects invalid data instead of evaluating it', async t => {
  for (const text of [
    'XJ_RUN_USER=root', 'XJ_RUN_USER=123', 'XJ_WORK_ROOT=relative/path',
    'XJ_WORK_ROOT=/', 'XJ_NODE_ROOT=/srv/../etc', 'XJ_WORK_ROOT=/srv//sessions',
    'XJ_STATE_ROOT=$(touch /tmp/xj-config-executed)', 'XJ_NODE_ROOT=/srv/runtime;id',
    'XJ_WORK_ROOT="/srv/sessions"', 'entry=/tmp/arbitrary-entry', 'sudo=/tmp/sudo',
    'XJ_RO_SENTINEL=/tmp/sentinel', 'XJ_RUN_USER=xunjie\nXJ_RUN_USER=other',
    'XJ_STATE_ROOT=',
  ]) {
    await t.test(text, child => {
      const close = mockLinuxConfig(child, text);
      assert.throws(linuxSessionEntry, { code: 'resource-unavailable' });
      assert.equal(close.mock.callCount(), 1);
    });
  }
});

test('linuxSessionEntry rejects untrusted files and read failures', async t => {
  for (const metadata of [{ uid: 1000 }, { mode: 0o100664 }, { mode: 0o100646 }, { isFile: () => false }]) {
    await t.test(JSON.stringify(metadata), child => {
      const close = mockLinuxConfig(child, '', metadata);
      assert.throws(linuxSessionEntry, { code: 'resource-unavailable' });
      assert.equal(close.mock.callCount(), 1);
    });
  }
  for (const code of ['EACCES', 'ELOOP']) {
    await t.test(code, child => {
      child.mock.method(fs, 'openSync', () => { throw Object.assign(new Error('拒绝读取'), { code }); });
      assert.throws(linuxSessionEntry, { code: 'resource-unavailable' });
    });
  }
  await t.test('read failure', child => {
    const close = mockLinuxConfig(child, '');
    child.mock.method(fs, 'readFileSync', () => { throw Object.assign(new Error('读取失败'), { code: 'EIO' }); });
    assert.throws(linuxSessionEntry, { code: 'resource-unavailable' });
    assert.equal(close.mock.callCount(), 1);
  });
});

const limits = { operationTimeoutMs: 5000, idleMs: 60_000, maxMs: 120_000, memoryMiB: 48, outputBytes: 65_536 };
const darwinOnly = process.platform === 'darwin' ? undefined : { skip: 'seatbelt is macOS only' };

/** A session must never be able to read product data or reach the network, not even its own directory parent. */
const probeAdapter = {
  adapterId: 'isolation-test', adapterVersion: 1,
  source: `
const fs = await import('node:fs');
const write = value => process.stdout.write(JSON.stringify(value) + '\\n');
async function handle(message) {
  if (message.type === 'ready') {
    write({ type: 'ready', adapterId: 'isolation-test', adapterVersion: 1,
      instanceId: process.env.XJ_SESSION_INSTANCE || '', observation: { value: 0 } });
    return;
  }
  if (message.type === 'input') {
    let state;
    try { fs.writeFileSync(message.parameters.path, 'probe'); state = { ok: true } }
    catch (error) { state = { ok: false, code: error.code } }
    write({ type: 'observation', seq: 1, controlId: message.controlId, state, at: new Date().toISOString() });
    return;
  }
  if (message.type === 'stop') { process.exit(0); return; }
  write({ type: 'status', observation: { value: 0 } });
}
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  for (;;) {
    const index = buffer.indexOf('\\n');
    if (index < 0) break;
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) void handle(JSON.parse(line));
  }
});
`,
};

test('the seatbelt profile names the fixed runtime, the session directory and a closed network', () => {
  const session = join(tmpdir(), 'xj-plan-session');
  const plan = planSeatbelt(process.execPath, session);
  if (process.platform !== 'darwin') { assert.equal(plan, null); return }
  assert.ok(plan);
  assert.equal(plan.launcher, seatbeltLauncherPath);
  assert.equal(plan.profileVersion, seatbeltProfileVersion);
  assert.equal(plan.profileDigest, createHash('sha256').update(plan.profileText).digest('hex'));
  assert.match(plan.profileText, /^\(version 1\)\n\(deny default\)/);
  assert.match(plan.profileText, new RegExp(`\\(allow process-exec \\(literal "${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\)\\)`));
  assert.ok(plan.profileText.includes('(deny network*)'));
  assert.ok(plan.profileText.includes('(allow signal (target same-sandbox))'));
  assert.ok(plan.readDenied.includes(homedir()));
  assert.ok(plan.readAllowed.some(value => session.startsWith(value) || value.includes('xj-plan-session')));
  // A different session directory changes the profile, so a digest always identifies one session.
  const other = planSeatbelt(process.execPath, join(tmpdir(), 'xj-plan-other'));
  assert.notEqual(other.profileDigest, plan.profileDigest);
  // Another platform never receives a macOS profile it cannot enforce.
  assert.equal(planSeatbelt(process.execPath, session, [], 'win32'), null);
  assert.equal(planSeatbelt(process.execPath, session, [], 'linux'), null);
});

test('a real macOS session is confined, reports the enforcement and confirms its empty group', darwinOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-native-isolation-'));
  const outside = await mkdtemp(join(tmpdir(), 'xj-native-outside-'));
  const session = await SupervisedSession.create({ adapter: probeAdapter, limits, sessionRoot: root,
    nodePath: process.execPath });
  try {
    assert.equal(session.isolation.kind, 'seatbelt');
    assert.equal(session.isolation.network, 'denied');
    assert.equal(session.isolation.supervisorDeath, 'session-watchdog');
    const inside = await session.input(randomUUID(), 1, { path: join(session.sessionDirectoryInput, 'inside.txt') });
    assert.deepEqual(inside.state, { ok: true });
    const denied = await session.input(randomUUID(), 2, { path: join(outside, 'outside.txt') });
    assert.deepEqual(denied.state, { ok: false, code: 'EPERM' });
    assert.equal(await session.stop(4000), true);
    const fact = await session.settled(4000);
    assert.equal(fact?.confirmed, true);
    assert.equal(session.exitFact?.requested, true);
  } finally {
    await session.dispose();
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('the process-group baseline stays available for hosts that opt out of the sandbox', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-native-baseline-'));
  const session = await SupervisedSession.create({ adapter: probeAdapter, limits, sessionRoot: root,
    nodePath: process.execPath, macosSandbox: false });
  try {
    assert.equal(session.isolation.kind, 'process-group');
    assert.equal(session.isolation.network, 'unrestricted');
    assert.equal(await session.stop(4000), true);
  } finally {
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('the real v2 adapter stays confined through controls, checkpoints and group reaping', darwinOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-native-v2-isolation-'));
  const adapter = productNativeAdapters.find(item => item.adapterVersion === 2);
  assert.ok(adapter);
  const session = await SupervisedSession.create({ adapter, limits: { ...limits, memoryMiB: 64 },
    sessionRoot: root, nodePath: process.execPath });
  try {
    assert.equal(session.isolation.kind, 'seatbelt');
    assert.equal(session.isolation.network, 'denied');
    assert.equal(session.isolation.writes, 'session-directory');
    assert.equal(session.isolation.exec, 'fixed-node-only');
    assert.equal(session.isolation.memory, 'heap-cap-and-rss-watchdog');
    assert.equal(session.isolation.processes, 'supervisor-group-confirmed');
    assert.equal(session.isolation.supervisorDeath, 'session-watchdog');
    const paused = await session.control('pause', randomUUID(), 1, {});
    assert.equal(paused.sessionState, 'paused');
    const step = await session.control('step', randomUUID(), 2, { value: 2 });
    assert.deepEqual(step.state, { value: 2, total: 2, applied: 1 });
    const checkpoint = await session.control('checkpoint', randomUUID(), 3, {});
    assert.deepEqual(checkpoint.checkpoint, { formatVersion: 1, value: 2, total: 2, applied: 1, mode: 'paused' });
    assert.equal(await session.stop(4000), true);
    assert.equal((await session.settled(4000))?.confirmed, true);
    assert.equal(session.exitFact?.requested, true);
  } finally {
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('the real v2 adapter still ends on a real idle budget under seatbelt', darwinOnly, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-native-v2-idle-'));
  const adapter = productNativeAdapters.find(item => item.adapterVersion === 2);
  assert.ok(adapter);
  const session = await SupervisedSession.create({ adapter, limits: { ...limits, memoryMiB: 64, idleMs: 1_000 },
    sessionRoot: root, nodePath: process.execPath });
  try {
    assert.equal(session.isolation.kind, 'seatbelt');
    const deadline = Date.now() + 12_000;
    while (!session.exitFact && Date.now() < deadline) {
      await session.snapshot().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(session.exitFact?.expired, 'idle');
    assert.equal(session.exitFact?.confirmed, true);
  } finally {
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('the Linux procfs v2 adapter restores persisted state into a new real process identity',
  { skip: process.platform !== 'linux' || process.arch !== 'x64' ? 'requires Linux x64 procfs' : false }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'xj-linux-proc-v2-'));
    const adapter = productNativeAdapters.find(item => item.adapterId === 'linux-proc-accumulator' && item.adapterVersion === 2);
    assert.ok(adapter);
    // Exercise the real adapter protocol here; systemd enforcement is accepted by the school-node probe.
    let first, restored;
    try {
      first = await SupervisedSession.create({ adapter, limits: { ...limits, memoryMiB: 64 }, sessionRoot: root });
      const oldPid = first.initialObservation.pid;
      const assertLiveIdentity = async (state, pid) => {
        const status = await readFile(`/proc/${pid}/status`, 'utf8');
        assert.equal(state.pid, Number(status.match(/^Pid:\s+(\d+)/m)?.[1]));
        assert.equal(state.threads, Number(status.match(/^Threads:\s+(\d+)/m)?.[1]));
        assert.ok(state.threads > 0);
      };
      await assertLiveIdentity(first.initialObservation, oldPid);
      await first.input(randomUUID(), 1, { value: 1 });
      await first.control('pause', randomUUID(), 2, {});
      const stepId = randomUUID();
      const stepped = await first.control('step', stepId, 3, { value: 2 });
      assert.deepEqual(await first.control('step', stepId, 3, { value: 2 }), stepped);
      await assert.rejects(first.input(randomUUID(), 4, { value: 1 }), /当前状态/);
      const captured = await first.control('checkpoint', randomUUID(), 4, {});
      await assertLiveIdentity(captured.state, oldPid);
      assert.deepEqual(captured.checkpoint, { formatVersion: 1, value: 3, total: 3, applied: 2, mode: 'paused' });
      const checkpointPath = join(root, 'checkpoint.json');
      await writeFile(checkpointPath, JSON.stringify(captured.checkpoint));
      const persisted = JSON.parse(await readFile(checkpointPath, 'utf8'));
      const baseline = await first.control('step', randomUUID(), 5, { value: 2 });
      restored = await SupervisedSession.create({ adapter, limits: { ...limits, memoryMiB: 64 }, sessionRoot: root });
      const newPid = restored.initialObservation.pid;
      assert.notEqual(newPid, oldPid); // The original is still alive, so its PID cannot be reused.
      assert.notEqual(restored.instanceId, first.instanceId);
      await assert.rejects(restored.restore({ ...persisted, pid: oldPid }), /不兼容/);
      const recovered = await restored.restore(persisted);
      assert.equal(recovered.sessionState, 'paused');
      assert.deepEqual(recovered.state, { value: 3, total: 3, applied: 2, pid: newPid, threads: recovered.state.threads });
      await assertLiveIdentity(recovered.state, newPid);
      const next = await restored.control('step', randomUUID(), 1, { value: 2 });
      for (const key of ['value', 'total', 'applied']) assert.equal(next.state[key], baseline.state[key]);
      await assertLiveIdentity(next.state, newPid);
      assert.equal((await restored.control('resume', randomUUID(), 2, {})).sessionState, 'running');
      const reset = await restored.control('reset', randomUUID(), 3, {});
      assert.deepEqual(reset.state, { value: 0, total: 0, applied: 0, pid: newPid, threads: reset.state.threads });
      await assertLiveIdentity(reset.state, newPid);
      assert.equal(await first.stop(4000), true);
      assert.equal(await restored.stop(4000), true);
    } finally {
      await first?.dispose();
      await restored?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
