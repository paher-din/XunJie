import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { productNativeAdapters, SupervisedSession } from '@xunjie/learning-space';

const adapter = productNativeAdapters[0];
const limits = { operationTimeoutMs: 5000, idleMs: 60_000, maxMs: 120_000, memoryMiB: 64, outputBytes: 65_536 };
const open = async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-native-test-'));
  return { root, session: await SupervisedSession.create({ adapter, limits, sessionRoot: root, nodePath: process.execPath }) };
};

/** The real adapter is a real child process: state only advances through its own stdin/stdout protocol. */
test('the native adapter keeps state across inputs and never applies one control twice', async () => {
  const { root, session } = await open();
  try {
    assert.deepEqual(session.initialObservation, { value: 0, total: 0, applied: 0 });
    const first = await session.input(randomUUID(), 1, { value: 1 });
    assert.deepEqual([first.seq, first.state], [1, { value: 1, total: 1, applied: 1 }]);
    const secondId = randomUUID();
    const second = await session.input(secondId, 2, { value: 2 });
    assert.deepEqual([second.seq, second.state], [2, { value: 3, total: 3, applied: 2 }]);
    const third = await session.input(randomUUID(), 3, { value: 2 });
    assert.deepEqual([third.seq, third.state], [3, { value: 1, total: 5, applied: 3 }]);
    // A retried control identity returns the original observation instead of advancing again.
    const replay = await session.input(secondId, 2, { value: 2 });
    assert.deepEqual(replay, second);
    assert.deepEqual(await session.reconcile(secondId), second);
    assert.equal(await session.reconcile(randomUUID()), null);
    await assert.rejects(session.input(randomUUID(), 9, { value: 1 }), /顺序/);
    assert.deepEqual(await session.snapshot(), { value: 1, total: 5, applied: 3 });
    assert.equal(await session.stop(3000), true);
    assert.equal(session.exitFact?.requested, true);
    assert.equal(session.exitFact?.code, 0);
  } finally {
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('the supervisor ends an idle session by really terminating the child process', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-native-idle-'));
  const session = await SupervisedSession.create({ adapter,
    limits: { ...limits, idleMs: 1000 }, sessionRoot: root, nodePath: process.execPath });
  try {
    // Taskkill is asynchronous on Windows, so wait for the real OS exit, not a fixed sleep.
    const deadline = Date.now() + 12_000;
    while (!session.exitFact && Date.now() < deadline) {
      await session.snapshot().catch(() => {}); // Heartbeats do not count as experiment input.
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(session.exitFact?.expired, 'idle');
    await assert.rejects(session.input(randomUUID(), 1, { value: 1 }));
  } finally {
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test('real pause, step, reset and checkpoint restore retain process state and stable operation identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-session174-'));
  const adapter = productNativeAdapters.find(item => item.adapterVersion === 2);
  const first = await SupervisedSession.create({ adapter, limits, sessionRoot: root });
  let restored;
  try {
    const instance = first.instanceId;
    await first.input(randomUUID(), 1, { value: 1 });
    const paused = await first.control('pause', randomUUID(), 2, {});
    assert.equal(paused.sessionState, 'paused');
    await assert.rejects(first.input(randomUUID(), 3, { value: 2 }), /当前状态/);
    assert.deepEqual(await first.snapshot(), { value: 1, total: 1, applied: 1 });
    const stepId = randomUUID(), stepped = await first.control('step', stepId, 3, { value: 2 });
    assert.deepEqual(stepped.state, { value: 3, total: 3, applied: 2 });
    assert.equal(stepped.sessionState, 'paused');
    assert.deepEqual(await first.control('step', stepId, 3, { value: 2 }), stepped);
    await assert.rejects(first.control('step', stepId, 3, { value: 1 }), /身份/);
    const checkpoint = await first.control('checkpoint', randomUUID(), 4, {});
    assert.deepEqual(checkpoint.checkpoint, { formatVersion: 1, value: 3, total: 3, applied: 2, mode: 'paused' });
    const baseline = await first.control('step', randomUUID(), 5, { value: 2 });
    restored = await SupervisedSession.create({ adapter, limits, sessionRoot: root });
    const recovered = await restored.restore(checkpoint.checkpoint);
    assert.deepEqual(recovered, { state: { value: 3, total: 3, applied: 2 }, sessionState: 'paused' });
    const next = await restored.control('step', randomUUID(), 1, { value: 2 });
    assert.deepEqual(next.state, baseline.state);
    const resumed = await first.control('resume', randomUUID(), 6, {});
    assert.equal(resumed.sessionState, 'running');assert.equal(first.instanceId, instance);
    const reset = await first.control('reset', randomUUID(), 7, {});
    assert.deepEqual(reset.state, { value: 0, total: 0, applied: 0 });assert.equal(first.instanceId, instance);
    assert.notEqual(restored.instanceId, instance);
    await assert.rejects(restored.restore(checkpoint.checkpoint), /不兼容/);
  } finally { await first.dispose();await restored?.dispose();await rm(root, { recursive: true, force: true }); }
});

test('a real fresh adapter refuses a malformed checkpoint rather than guessing an internal state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xj-session174-invalid-'));
  const session = await SupervisedSession.create({ adapter: productNativeAdapters.find(item => item.adapterVersion === 2), limits, sessionRoot: root });
  try {
    await assert.rejects(session.restore({ formatVersion: 99, value: 3, total: 3, applied: 2, mode: 'paused' }), /不兼容/);
    assert.deepEqual(await session.snapshot(), { value: 0, total: 0, applied: 0 });
  } finally { await session.dispose();await rm(root, { recursive: true, force: true }); }
});
