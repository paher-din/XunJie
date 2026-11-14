import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentRuntime, agentRuntimeMigrations } from '../dist/index.js';
import { collectAgentRuntimeBoundary, collectAgentRuntimeReceiverBoundary, validateAgentRuntimeBoundary } from '../dist/maintenance.js';

let postgres;
before(async () => { postgres = await nativeFixture(); });
after(async () => { await postgres?.close(); });

function manualTimers() {
  const scheduled = [];
  return { scheduled,
    setTimeout(callback, delayMs) { const timer = { callback, delayMs, cleared: false }; scheduled.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
  };
}

async function fixture(t, pipeline, storageForRuntime = storage => storage) {
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: postgres.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
  const backend = createFileBackend({ id: 'agent', root: join(postgres.root, owner.serviceId) });
  const storage = await openStorage({ binding, migrations: agentRuntimeMigrations, backend });
  const identity = { kind: 'personal', name: '学生', environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID() };
  const sessionId = randomUUID(), runtimes = [], timers = manualTimers();
  const open = (options = {}) => {
    const runtime = createAgentRuntime(storageForRuntime(storage), { authorize: async () => {}, pipeline, cancellationTimers: timers, ...options });
    runtimes.push(runtime); return runtime;
  };
  const runtime = open();
  t.after(async () => {
    try { for (const current of runtimes.reverse()) await current.close(); }
    finally { await storage.close(); }
  });
  await runtime.initialize({ sessionId, identity, scenario: 'fixture', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
  return { runtime, identity, sessionId, storage, open, timers,
    accept: () => runtime.accept(identity, { sessionId, requestId: randomUUID(), text: '原任务' }),
  };
}

function waitingPipeline(overrides) {
  return {
    async plan(_snapshot, ids) { return { kind: 'operation', operation: {
      operationId: ids.operationId, kind: 'external.original', bindingId: 'original-owner:1', input: { original: true },
    }, snapshot: { fixed: 'original-source' } }; },
    async dispatch() { return { state: 'completed', value: { original: 'received' } }; },
    async reconcile() { assert.fail('stopped work must not reconcile or dispatch'); },
    async apply(snapshot) { return { state: snapshot.state,
      wait: { kind: 'logical', presentation: { prompt: '等待学生' }, deadline: null } }; },
    ...overrides,
  };
}

test('restart delivers a cancellation lost after stop committed without reviving or dispatching the stopped run', async t => {
  const deliveries = [], acknowledged = new Set(); let dispatched = 0, permit;
  const f = await fixture(t, waitingPipeline({
    async dispatch(_snapshot, _step, issued) { dispatched++; permit = issued; return { state: 'completed', value: {} }; },
    async cancel(snapshot, step) {
      assert.equal(snapshot.run.state, 'stopped');
      deliveries.push({ operation: step.operation, snapshot: step.snapshot });
      if (deliveries.length === 1) {
        f.runtime.closeDispatch();
        throw new StorageError('unavailable'); // The process stops before the original owner receives cancellation.
      }
      acknowledged.add(step.operation.operationId); // Delivery acknowledgement, not a physical terminal receipt.
    },
  }));
  const accepted = await f.accept(); await f.runtime.advance(accepted.runId);
  const stopId = randomUUID();
  await assert.rejects(f.runtime.stop(f.identity, f.sessionId, accepted.runId, stopId), { code: 'unavailable' });
  await f.runtime.close();
  const restarted = f.open();
  await restarted.drain();
  assert.deepEqual([...acknowledged], [permit.operationId], 'startup must deliver the original pending cancellation');
  assert.deepEqual(deliveries[1], deliveries[0], 'recovery retains the exact original binding, operation and snapshot');
  assert.equal(dispatched, 1);
  assert.deepEqual(await restarted.recoverableRuns(), []);
  const stopped = await restarted.run(f.identity, f.sessionId, accepted.runId);
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.needsContinue, false);
  await assert.rejects(restarted.assertDispatch(f.identity, permit), { code: 'stale-generation' });
  await restarted.stop(f.identity, f.sessionId, accepted.runId, stopId);
  await restarted.stop(f.identity, f.sessionId, accepted.runId, randomUUID());
  assert.equal(deliveries.length, 2, 'acknowledged cancellation is not delivered again by repeated stop');
  assert.equal(f.timers.scheduled.length, 0, 'no retry timer is installed on a successful acknowledgement');
});

test('a failed delivery retries only its original cancellation and retires the timer after owner acknowledgement', async t => {
  const delivered = []; let attempts = 0, dispatched = 0;
  const f = await fixture(t, waitingPipeline({
    async dispatch() { dispatched++; return { state: 'completed', value: {} }; },
    async cancel(snapshot, step) {
      assert.equal(snapshot.run.state, 'stopped');
      if (++attempts === 1) throw new StorageError('unavailable');
      delivered.push(step.operation.operationId);
    },
  }));
  const accepted = await f.accept(); await f.runtime.advance(accepted.runId);
  await assert.rejects(f.runtime.stop(f.identity, f.sessionId, accepted.runId, randomUUID()), { code: 'unavailable' });
  assert.equal(f.timers.scheduled.length, 1, 'only a real failed cancellation installs a retry timer');
  const retry = f.timers.scheduled[0];
  assert.ok(retry.delayMs >= 1 && retry.delayMs <= 30000);
  retry.callback(); await f.runtime.drain();
  assert.equal(delivered.length, 1); assert.equal(attempts, 2); assert.equal(dispatched, 1);
  retry.callback(); await f.runtime.drain();
  assert.equal(attempts, 2, 'an already-fired callback cannot redeliver an acknowledged cancellation');
  assert.equal(f.timers.scheduled.length, 1);
  await f.runtime.close();
  const restarted = f.open(); await restarted.drain();
  assert.equal(attempts, 2, 'delivery acknowledgement survives a process restart');
});

test('maintenance inventories pending delivery and read-only recovery preserves it until explicitly resumed', async t => {
  let attempts = 0;
  const f = await fixture(t, waitingPipeline({
    async cancel() { if (++attempts === 1) throw new StorageError('unavailable'); },
  }));
  const accepted = await f.accept(); await f.runtime.advance(accepted.runId);
  await assert.rejects(f.runtime.stop(f.identity, f.sessionId, accepted.runId, randomUUID()), { code: 'unavailable' });
  const retry = f.timers.scheduled[0];
  f.runtime.closeWrites(); await f.runtime.drain();
  assert.equal(retry.cleared, true);
  await f.storage.participant().closeWrites(); await f.storage.participant().closeDispatch(); await f.storage.participant().drain();
  const boundary = await collectAgentRuntimeBoundary(f.storage);
  assert.equal(boundary.unresolved.length, 1);
  assert.equal(boundary.unresolved[0].disposition, 'stop-pending');
  assert.equal(boundary.unresolved[0].statusKnowledge, 'unknown');
  assert.equal((await collectAgentRuntimeReceiverBoundary(f.storage)).unresolved.length, 1);
  await validateAgentRuntimeBoundary(f.storage, boundary);
  const isolated = f.open({ readOnly: true }); await isolated.drain();
  retry.callback(); await f.runtime.drain();
  assert.equal(attempts, 1, 'closed and read-only hosts never deliver cancellation');
  assert.deepEqual(await collectAgentRuntimeBoundary(f.storage), boundary);
  await f.storage.participant().resume(); await isolated.resume(); await isolated.drain();
  assert.equal(attempts, 2);
  assert.equal((await isolated.run(f.identity, f.sessionId, accepted.runId)).state, 'stopped');
  isolated.closeWrites(); await isolated.drain();
  await f.storage.participant().closeWrites(); await f.storage.participant().closeDispatch(); await f.storage.participant().drain();
  const acknowledged = await collectAgentRuntimeBoundary(f.storage);
  assert.deepEqual(acknowledged.unresolved, []);
  assert.equal(acknowledged.settled, 1);
  await validateAgentRuntimeBoundary(f.storage, acknowledged);
});

test('closing writes drains an admitted cancellation and defers its acknowledgement and retry until resume', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const delivered = [];
  const f = await fixture(t, waitingPipeline({
    async cancel(_snapshot, step) {
      delivered.push(step.operation.operationId);
      if (delivered.length === 1) { entered.resolve(); await release.promise; }
    },
  }));
  const accepted = await f.accept(); await f.runtime.advance(accepted.runId);
  const stopping = f.runtime.stop(f.identity, f.sessionId, accepted.runId, randomUUID());
  await entered.promise;
  f.runtime.closeWrites();
  let drained = false;
  const draining = f.runtime.drain().then(() => { drained = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false, 'drain waits for a cancellation already admitted to the owner');
  } finally { release.resolve(); await stopping; await draining; }
  await f.storage.participant().closeWrites(); await f.storage.participant().closeDispatch(); await f.storage.participant().drain();
  const boundary = await collectAgentRuntimeBoundary(f.storage);
  assert.equal(boundary.unresolved[0].disposition, 'stop-pending', 'closed writes cannot acknowledge a late reply');
  assert.equal(f.timers.scheduled.length, 0);
  await f.storage.participant().resume(); await f.runtime.resume(); await f.runtime.drain();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1], delivered[0], 'an acknowledgement lost at the maintenance gate retries only the original cancellation');
  assert.equal((await f.runtime.run(f.identity, f.sessionId, accepted.runId)).state, 'stopped');
});

test('one unavailable cancellation does not block other original owners or repeat their delivery acknowledgements', async t => {
  const delivered = [], attempts = []; let dispatched = 0;
  const f = await fixture(t, waitingPipeline({
    async plan(snapshot, ids) { return { kind: 'operation', operation: { operationId: ids.operationId,
      kind: 'external.original', bindingId: 'original-owner:1', input: { number: snapshot.steps.length + 1 } }, snapshot: {} }; },
    async dispatch() { dispatched++; return { state: 'completed', value: {} }; },
    async apply(snapshot, step) { return { state: snapshot.state, ...(step.operation.input.number === 2
      ? { wait: { kind: 'logical', presentation: {}, deadline: null } } : {}) }; },
    async cancel(_snapshot, step) {
      const number = step.operation.input.number; attempts.push(number);
      if (number === 1 && attempts.filter(value => value === 1).length === 1) throw new StorageError('unavailable');
      delivered.push(number);
    },
  }));
  const accepted = await f.accept(); await f.runtime.advance(accepted.runId);
  await assert.rejects(f.runtime.stop(f.identity, f.sessionId, accepted.runId, randomUUID()), { code: 'unavailable' });
  assert.deepEqual(delivered, [2]);
  f.timers.scheduled[0].callback(); await f.runtime.drain();
  assert.deepEqual(delivered, [2, 1]);
  assert.equal(attempts.filter(value => value === 2).length, 1);
  assert.equal(dispatched, 2);
});

test('a process closed immediately after the stop transaction retains cancellation before its first delivery', async t => {
  const delivered = []; let stopRequest;
  const f = await fixture(t, waitingPipeline({ async cancel(_snapshot, step) { delivered.push(step.operation.operationId); } }), storage => ({
    ...storage,
    async request(input, effect) {
      const receipt = await storage.request(input, effect);
      if (input.requestId === stopRequest) { stopRequest = undefined; f.runtime.closeDispatch(); }
      return receipt;
    },
  }));
  const accepted = await f.accept(); await f.runtime.advance(accepted.runId);
  const stopId = randomUUID(); stopRequest = 'agent-control:' + stopId;
  assert.equal((await f.runtime.stop(f.identity, f.sessionId, accepted.runId, stopId)).state, 'stopped');
  assert.deepEqual(delivered, [], 'the process gate closed before the first cancellation callback');
  await f.runtime.close();
  const restarted = f.open(); await restarted.drain();
  assert.equal(delivered.length, 1);
  const original = await restarted.snapshot(f.identity, f.sessionId, accepted.runId);
  assert.equal(delivered[0], original.steps[0].operation.operationId);
  assert.equal(original.run.state, 'stopped');
  assert.equal(f.timers.scheduled.length, 0);
});
