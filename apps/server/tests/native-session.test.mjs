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
    while (!session.exitFact && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(session.exitFact?.expired, 'idle');
    await assert.rejects(session.input(randomUUID(), 1, { value: 1 }));
  } finally {
    await session.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
