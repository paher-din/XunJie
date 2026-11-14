import assert from 'node:assert/strict';
import test from 'node:test';
import { DirectRunner } from '../src/execution/direct-runner.ts';
import { AsyncWaits } from '../src/execution/async-waits.ts';
import { RunCoordinator } from '../src/execution/run-coordinator.ts';

function deferred() { return Promise.withResolvers(); }
function settle() { return new Promise((resolve) => setImmediate(resolve)); }

// Time is an injected system boundary; retain cleared callbacks to model already queued timers.
function manualTimers() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout(callback, delayMs) {
      const timer = { callback, delayMs, cleared: false };
      scheduled.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; },
  };
}

test('ExecutionStrategy: an explicit wake advances that run', async () => {
  const advanced = [];
  const runner = new DirectRunner({ advance: (runId) => { advanced.push(runId); } });
  await runner.wake('run-a');
  await runner.drain();
  assert.deepEqual(advanced, ['run-a']);
});

test('ExecutionStrategy: active wakes are retained without reentering the same run', async () => {
  const entered = deferred();
  const release = deferred();
  let count = 0;
  let active = 0;
  let peak = 0;
  const runner = new DirectRunner({
    async advance() {
      count += 1;
      active += 1;
      peak = Math.max(peak, active);
      if (count === 1) { entered.resolve(); await release.promise; }
      active -= 1;
    },
  });
  const first = runner.wake('run-a');
  await entered.promise;
  const second = runner.wake('run-a');
  release.resolve();
  await Promise.all([first, second, runner.drain()]);
  assert.equal(peak, 1, 'a run must never overlap itself');
  assert.equal(count, 2, 'a wake during advance requires another turn');
});

test('ExecutionStrategy: starting wakes survive asynchronous persistence and runs advance independently', async () => {
  const marking = deferred();
  const persist = deferred();
  const aEntered = deferred();
  const releaseA = deferred();
  const advanced = [];
  let marks = 0;
  const runner = new DirectRunner({
    async markPending(runId) {
      marks += 1;
      if (runId === 'run-a' && marks === 1) { marking.resolve(); await persist.promise; }
    },
    async advance(runId) {
      advanced.push(runId);
      if (runId === 'run-a' && advanced.filter((id) => id === runId).length === 1) {
        aEntered.resolve(); await releaseA.promise;
      }
    },
  });
  const first = runner.wake('run-a');
  // A starting run is already registered, even while its durable wake is being written.
  await settle();
  assert.equal(marks, 1);
  await marking.promise;
  const second = runner.wake('run-a');
  await runner.wake('run-b');
  assert.deepEqual(advanced, ['run-b']);
  persist.resolve();
  await aEntered.promise;
  const third = runner.wake('run-a');
  releaseA.resolve();
  await Promise.all([first, second, third, runner.drain()]);
  assert.equal(marks, 4);
  assert.deepEqual(advanced, ['run-b', 'run-a', 'run-a']);
});

test('ExecutionStrategy: rechecks persistent pending at exit and retains wakes during that check', async () => {
  const checking = deferred();
  const checked = deferred();
  let advances = 0;
  let checks = 0;
  const runner = new DirectRunner({
    advance() { advances += 1; },
    async hasPending() {
      checks += 1;
      if (checks === 1) { checking.resolve(); await checked.promise; return false; }
      return checks === 2;
    },
  });
  const first = runner.wake('run-a');
  await settle();
  assert.equal(checks, 1);
  await checking.promise;
  const wakeAtExit = runner.wake('run-a');
  checked.resolve();
  await Promise.all([first, wakeAtExit, runner.drain()]);
  assert.equal(advances, 3);
  assert.equal(checks, 3);
});

test('ExecutionStrategy: closing before startup blocks advance and rejects subsequent wakes', async () => {
  let advances = 0;
  const runner = new DirectRunner({ advance() { advances += 1; } });
  const starting = runner.wake('run-a');
  runner.closeDispatch();
  await starting;
  await assert.rejects(runner.wake('run-b'), { name: 'DispatchClosedError' });
  await runner.drain();
  assert.equal(advances, 0);
});

test('ExecutionStrategy: closing stops new turns while drain waits for active work and accepted writes', async () => {
  const entered = deferred();
  const release = deferred();
  const write = deferred();
  let advances = 0;
  let marks = 0;
  let drained = false;
  const runner = new DirectRunner({
    async markPending() { if (++marks === 2) await write.promise; },
    async advance() { advances += 1; entered.resolve(); await release.promise; },
  });
  const first = runner.wake('run-a');
  await entered.promise;
  const second = runner.wake('run-a');
  runner.closeDispatch();
  const draining = runner.drain().then(() => { drained = true; });
  await settle();
  assert.equal(drained, false);
  release.resolve();
  await settle();
  assert.equal(drained, false, 'accepted persistence must finish too');
  write.resolve();
  await Promise.all([first, second, draining]);
  assert.equal(advances, 1);
});

test('ExecutionStrategy: construction and idle user waits create no background work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let advances = 0;
  let checks = 0;
  const runner = new DirectRunner({
    advance() { advances += 1; },
    hasPending() { checks += 1; return false; },
  });
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(advances, 0);
  assert.equal(checks, 0);
  await runner.wake('wait-user');
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(advances, 1);
  assert.equal(checks, 1);
});

test('ExecutionStrategy: only registered asynchronous waits get bounded, one-shot timers', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const wakes = [];
  const waits = new AsyncWaits({
    wake: (runId, waitId) => { wakes.push([runId, waitId]); },
    minDelayMs: 5,
    maxDelayMs: 20,
  });
  t.after(() => waits.stop());
  t.mock.timers.tick(100);
  await settle();
  assert.deepEqual(wakes, []);
  waits.register({ runId: 'run-a', waitId: 'capacity-attempt-1', delayMs: 0 });
  waits.register({ runId: 'run-b', waitId: 'tool-command-1', delayMs: 1e12 });
  t.mock.timers.tick(4);
  assert.deepEqual(wakes, []);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(wakes, [['run-a', 'capacity-attempt-1']]);
  t.mock.timers.tick(15);
  await settle();
  assert.deepEqual(wakes, [['run-a', 'capacity-attempt-1'], ['run-b', 'tool-command-1']]);
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(wakes.length, 2, 'retrying requires explicit registration of the original wait');
});

test('ExecutionStrategy: replacing/cancelling waits invalidates stale callbacks and stale disposers', async () => {
  const timers = manualTimers();
  const wakes = [];
  const waits = new AsyncWaits({ timers, wake: (run, wait) => { wakes.push([run, wait]); } });
  const oldDispose = waits.register({ runId: 'old-run', waitId: 'attempt', delayMs: 10 });
  const dispose = waits.register({ runId: 'new-run', waitId: 'attempt', delayMs: 10 });
  assert.equal(timers.scheduled.length, 2);
  assert.equal(timers.scheduled[0].cleared, true);
  oldDispose();
  timers.scheduled[0].callback();
  timers.scheduled[1].callback();
  await settle();
  assert.deepEqual(wakes, [['new-run', 'attempt']]);
  dispose();
  const cancel = waits.register({ runId: 'run-b', waitId: 'cancelled', delayMs: 10 });
  cancel();
  timers.scheduled[2].callback();
  await settle();
  assert.equal(wakes.length, 1);
  waits.stop();
});

test('ExecutionStrategy: stopping clears every wait and makes queued timers inert', async () => {
  const timers = manualTimers();
  const wakes = [];
  const waits = new AsyncWaits({ timers, wake: (run) => { wakes.push(run); } });
  waits.register({ runId: 'run-a', waitId: 'one', delayMs: 10 });
  waits.register({ runId: 'run-b', waitId: 'two', delayMs: 10 });
  waits.stop();
  waits.stop();
  assert.equal(timers.scheduled.length, 2);
  assert.ok(timers.scheduled.every((timer) => timer.cleared));
  for (const timer of timers.scheduled) timer.callback();
  await settle();
  assert.deepEqual(wakes, []);
  assert.throws(() => waits.register({ runId: 'run-c', waitId: 'three', delayMs: 10 }), /stopped/i);
});

test('ExecutionStrategy: coordination is explicit and advances only under a successful claim', async () => {
  const advanced = [];
  const released = [];
  let claims = 0;
  const coordinator = new RunCoordinator({
    renewIntervalMs: 100,
    claim(runId) { claims += 1; return runId === 'owned' ? { token: 'lease-1', expiresAt: Date.now() + 10_000 } : null; },
    renew() { throw new Error('short advance should not need renewal'); },
    advance(runId, context) { context.assertCurrent(); advanced.push([runId, context.lease.token]); },
    release(runId, lease) { released.push([runId, lease.token]); },
  });
  await settle();
  assert.equal(claims, 0, 'constructing a coordinator must not claim or scan');
  await coordinator.wake('not-owned');
  await coordinator.wake('owned');
  await coordinator.drain();
  assert.equal(claims, 2);
  assert.deepEqual(advanced, [['owned', 'lease-1']]);
  assert.deepEqual(released, [['owned', 'lease-1']]);
});

test('ExecutionStrategy: renewal loss aborts active execution and prevents queued turns', async () => {
  const timers = manualTimers();
  const entered = deferred();
  const finish = deferred();
  let context;
  let advances = 0;
  let renewals = 0;
  const coordinator = new RunCoordinator({
    timers, now: () => 0, renewIntervalMs: 10,
    claim: () => ({ token: 'lease-1', expiresAt: 100 }),
    renew() { renewals += 1; return null; },
    async advance(_runId, current) { context = current; advances += 1; entered.resolve(); await finish.promise; },
  });
  const running = coordinator.wake('run-a');
  const outcome = running.catch((error) => error);
  await entered.promise;
  const queued = coordinator.wake('run-a');
  assert.ok(timers.scheduled.length >= 2, 'renewal and independent expiry watchdog must be armed');
  timers.scheduled.find((timer) => timer.delayMs === 10).callback();
  await settle();
  assert.equal(renewals, 1);
  assert.equal(context.signal.aborted, true);
  assert.throws(() => context.assertCurrent(), { name: 'LeaseLostError' });
  finish.resolve();
  await assert.rejects(queued, { name: 'LeaseLostError' });
  assert.equal((await outcome).name, 'LeaseLostError');
  assert.equal(advances, 1);
  assert.ok(timers.scheduled.every((timer) => timer.cleared));
});

test('ExecutionStrategy: expiry stops execution even when renewal hangs and late renewal cannot revive it', async () => {
  const timers = manualTimers();
  const renewing = deferred();
  const entered = deferred();
  const finish = deferred();
  let now = 0;
  let context;
  const coordinator = new RunCoordinator({
    timers, now: () => now, renewIntervalMs: 10,
    claim: () => ({ token: 'lease-1', expiresAt: 100 }),
    renew: () => renewing.promise,
    async advance(_id, current) { context = current; entered.resolve(); await finish.promise; },
  });
  const outcome = coordinator.wake('run-a').catch((error) => error);
  await entered.promise;
  assert.ok(timers.scheduled.length >= 2);
  timers.scheduled.find((timer) => timer.delayMs === 10).callback();
  await settle();
  now = 100;
  timers.scheduled.find((timer) => timer.delayMs === 100).callback();
  assert.equal(context.signal.aborted, true);
  renewing.resolve({ token: 'lease-1', expiresAt: 200 });
  await settle();
  assert.equal(context.signal.aborted, true);
  assert.throws(() => context.assertCurrent(), { name: 'LeaseLostError' });
  finish.resolve();
  assert.equal((await outcome).name, 'LeaseLostError');
  assert.ok(timers.scheduled.every((timer) => timer.cleared));
});

test('ExecutionStrategy: notifications retain the original wait identity and drain observes wake failures', async () => {
  const timers = manualTimers();
  const entered = deferred();
  const finish = deferred();
  const failure = new Error('wake failed');
  const seen = [];
  const waits = new AsyncWaits({
    timers,
    async wake(runId, waitId) { seen.push([runId, waitId]); entered.resolve(); await finish.promise; throw failure; },
  });
  waits.register({ runId: 'run-a', waitId: 'original-attempt', delayMs: 10 });
  assert.equal(waits.notify('unknown-attempt'), false);
  assert.equal(waits.notify('original-attempt'), true);
  await entered.promise;
  timers.scheduled[0].callback();
  waits.stop();
  let drained = false;
  const draining = waits.drain().finally(() => { drained = true; });
  const outcome = draining.catch((error) => error);
  await settle();
  assert.equal(drained, false);
  finish.resolve();
  assert.deepEqual((await outcome).errors, [failure]);
  assert.deepEqual(seen, [['run-a', 'original-attempt']]);
  await waits.drain();
});

test('ExecutionStrategy: invalid timer bounds fail before creating or replacing a timer', () => {
  const timers = manualTimers();
  const wake = () => {};
  assert.throws(() => new AsyncWaits({ timers, wake, minDelayMs: 0 }), RangeError);
  assert.throws(() => new AsyncWaits({ timers, wake, minDelayMs: 20, maxDelayMs: 10 }), RangeError);
  assert.throws(() => new AsyncWaits({ timers, wake, maxDelayMs: 1e12 }), RangeError);
  const waits = new AsyncWaits({ timers, wake });
  waits.register({ runId: 'run-a', waitId: 'attempt', delayMs: 10 });
  assert.throws(() => waits.register({ runId: 'run-a', waitId: 'attempt', delayMs: NaN }), RangeError);
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].cleared, false);
  waits.stop();
});

test('ExecutionStrategy: drain waits for every run despite failure and reports completed failures', async () => {
  const slow = deferred();
  const failure = new Error('advance failed');
  const runner = new DirectRunner({
    async advance(id) { if (id === 'bad') throw failure; await slow.promise; },
  });
  await assert.rejects(runner.wake('bad'), failure);
  const running = runner.wake('slow');
  let drained = false;
  const outcome = runner.drain().finally(() => { drained = true; }).catch((error) => error);
  await settle();
  assert.equal(drained, false);
  slow.resolve();
  await running;
  assert.deepEqual((await outcome).errors, [failure]);
  await runner.drain();
});

test('ExecutionStrategy: scans run only on explicit request and scan timers cannot outlive close', async () => {
  const timers = manualTimers();
  const seen = [];
  let scans = 0;
  const coordinator = new RunCoordinator({
    timers, now: () => 0, renewIntervalMs: 10,
    scan() { scans += 1; return ['run-a', 'run-a', 'run-b']; },
    claim: () => ({ expiresAt: 100 }),
    renew: () => ({ expiresAt: 100 }),
    advance(id) { seen.push(id); },
  });
  await settle();
  assert.equal(scans, 0);
  assert.equal(timers.scheduled.length, 0);
  await coordinator.scanOnce();
  await coordinator.drain();
  assert.equal(scans, 1);
  assert.deepEqual(seen.sort(), ['run-a', 'run-b']);
  const stop = coordinator.startScanning(30);
  const tick = timers.scheduled.at(-1);
  tick.callback();
  await settle();
  assert.equal(scans, 2);
  tick.callback();
  await settle();
  assert.equal(scans, 2, 'a consumed scan timer cannot schedule another scan');
  stop();
  const cancelled = timers.scheduled.at(-1);
  cancelled.callback();
  await settle();
  assert.equal(scans, 2);
  coordinator.startScanning(40);
  const late = timers.scheduled.at(-1);
  coordinator.closeDispatch();
  late.callback();
  await coordinator.drain();
  assert.equal(scans, 2);
  assert.ok(timers.scheduled.every((timer) => timer.cleared));
  await assert.rejects(coordinator.scanOnce(), { name: 'DispatchClosedError' });
});

test('ExecutionStrategy: close during a scan/claim prevents late acquisition from advancing', async () => {
  const scanResult = deferred();
  const claimResult = deferred();
  const claimed = deferred();
  const scanEntered = deferred();
  const released = [];
  let advances = 0;
  let claimSignal;
  let scanSignal;
  const coordinator = new RunCoordinator({
    renewIntervalMs: 10,
    scan(signal) { scanSignal = signal; scanEntered.resolve(); return scanResult.promise; },
    claim(_id, signal) { claimSignal = signal; claimed.resolve(); return claimResult.promise; },
    renew: () => null,
    advance() { advances += 1; },
    release(id) { released.push(id); },
  });
  const running = coordinator.wake('owned');
  const scanning = coordinator.scanOnce();
  await Promise.all([claimed.promise, scanEntered.promise]);
  coordinator.closeDispatch();
  assert.equal(claimSignal.aborted, true);
  assert.equal(scanSignal.aborted, true);
  let drained = false;
  const draining = coordinator.drain().then(() => { drained = true; });
  await settle();
  assert.equal(drained, false);
  scanResult.resolve(['late-run']);
  claimResult.resolve({ expiresAt: Date.now() + 100 });
  await Promise.all([running, scanning, draining]);
  assert.equal(advances, 0);
  assert.deepEqual(released, ['owned']);
});

test('ExecutionStrategy: a failing advance still drains durable wakes accepted while it was active', async () => {
  const entered = deferred();
  const fail = deferred();
  const persist = deferred();
  const failure = new Error('advance failed');
  let marks = 0;
  const runner = new DirectRunner({
    async markPending() { if (++marks === 2) await persist.promise; },
    async advance() { entered.resolve(); await fail.promise; throw failure; },
  });
  const first = runner.wake('run-a').catch((error) => error);
  await entered.promise;
  const second = runner.wake('run-a').catch((error) => error);
  fail.resolve();
  let drained = false;
  const outcome = runner.drain().finally(() => { drained = true; }).catch((error) => error);
  await settle();
  assert.equal(drained, false);
  persist.resolve();
  assert.equal(await first, failure);
  assert.equal(await second, failure);
  assert.deepEqual((await outcome).errors, [failure]);
});

test('ExecutionStrategy: a renewal arriving after the previous deadline cannot extend execution', async () => {
  const timers = manualTimers();
  const renewed = deferred();
  const entered = deferred();
  const finish = deferred();
  let now = 0;
  let context;
  const coordinator = new RunCoordinator({
    timers, now: () => now, renewIntervalMs: 10,
    claim: () => ({ expiresAt: 100 }),
    renew: () => renewed.promise,
    async advance(_id, current) { context = current; entered.resolve(); await finish.promise; },
  });
  const outcome = coordinator.wake('run-a').catch((error) => error);
  await entered.promise;
  now = 10;
  timers.scheduled.find((timer) => timer.delayMs === 10).callback();
  await settle();
  now = 100;
  // Deliberately do not fire the expiry timer: a delayed event loop cannot revive the lease either.
  renewed.resolve({ expiresAt: 200 });
  await settle();
  assert.equal(context.signal.aborted, true);
  finish.resolve();
  assert.equal((await outcome).name, 'LeaseLostError');
});

test('ExecutionStrategy: a successful renewal invalidates old timers and releases the latest receipt', async () => {
  const timers = manualTimers();
  const entered = deferred();
  const finish = deferred();
  let now = 0;
  let context;
  const released = [];
  const coordinator = new RunCoordinator({
    timers, now: () => now, renewIntervalMs: 10,
    claim: () => ({ receipt: 1, expiresAt: 100 }),
    renew: () => ({ receipt: 2, expiresAt: 200 }),
    async advance(_id, current) { context = current; entered.resolve(); await finish.promise; },
    release(_id, lease) { released.push(lease.receipt); },
  });
  const running = coordinator.wake('run-a');
  await entered.promise;
  const oldDeadline = timers.scheduled.find((timer) => timer.delayMs === 100);
  const oldHeartbeat = timers.scheduled.find((timer) => timer.delayMs === 10);
  oldHeartbeat.callback();
  await settle();
  assert.equal(context.lease.receipt, 2);
  now = 100;
  oldDeadline.callback();
  oldHeartbeat.callback();
  context.assertCurrent();
  assert.equal(context.signal.aborted, false);
  finish.resolve();
  await running;
  await coordinator.drain();
  assert.deepEqual(released, [2]);
  assert.ok(timers.scheduled.every((timer) => timer.cleared));
});

test('ExecutionStrategy: scanning can discover another run while an earlier run is still advancing', async () => {
  const timers = manualTimers();
  const entered = deferred();
  const finish = deferred();
  let scans = 0;
  const advanced = [];
  const coordinator = new RunCoordinator({
    timers, now: () => 0, renewIntervalMs: 10,
    scan() { scans += 1; return scans === 1 ? ['slow'] : ['fast']; },
    claim: () => ({ expiresAt: 100 }),
    renew: () => ({ expiresAt: 100 }),
    async advance(id) { advanced.push(id); if (id === 'slow') { entered.resolve(); await finish.promise; } },
  });
  const first = coordinator.scanOnce();
  await entered.promise;
  const second = coordinator.scanOnce();
  await settle();
  assert.equal(scans, 2, 'scan lifetime must not include the lifetime of advanced runs');
  assert.deepEqual(advanced, ['slow', 'fast']);
  finish.resolve();
  await Promise.all([first, second, coordinator.drain()]);
});

test('ExecutionStrategy: a queued wait callback is cancelled if stop happens before dispatch', async () => {
  const timers = manualTimers();
  let wakes = 0;
  const waits = new AsyncWaits({ timers, wake() { wakes += 1; } });
  waits.register({ runId: 'run-a', waitId: 'attempt', delayMs: 10 });
  timers.scheduled[0].callback();
  waits.stop();
  await waits.drain();
  assert.equal(wakes, 0);
});
