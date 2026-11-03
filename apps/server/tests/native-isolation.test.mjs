import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { planSeatbelt, seatbeltLauncherPath, seatbeltProfileVersion, SupervisedSession } from '@xunjie/learning-space';

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
