import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMaintenanceCoordinator, type MaintenanceState } from '@xunjie/product-runtime/maintenance';

// A small service consumer: writes and dispatches really pass through its gates.
function service(serviceId: string) {
  let writesOpen = true;
  let dispatchOpen = true;
  const pending: string[] = [];
  const saved: string[] = [];
  const sent: string[] = [];
  return {
    descriptor: { serviceId, schemaVersion: '1', resourceRoots: [`resources/${serviceId}`], configurationRefs: [] },
    invalid: false,
    failResume: false,
    failDrain: false,
    failClose: false,
    beforeClose: async () => {},
    beforeDrain: () => {},
    write(value: string) {
      if (!writesOpen) throw new Error('Writes closed');
      pending.push(value);
    },
    dispatch(value: string) {
      if (!dispatchOpen) throw new Error('Dispatch closed');
      sent.push(value);
    },
    saved, sent,
    async closeWrites() {
      await this.beforeClose();
      if (this.failClose) throw new Error('Write gate unavailable');
      writesOpen = false;
    },
    async closeDispatch() { dispatchOpen = false; },
    async drain() {
      this.beforeDrain();
      if (this.failDrain) throw new Error('Persistence unavailable');
      saved.push(...pending.splice(0));
    },
    async validate() { if (this.invalid) throw new Error('Resource missing'); },
    async resume() {
      writesOpen = true;
      dispatchOpen = true;
      if (this.failResume) throw new Error('Reopen failed');
    },
  };
}

function closed(consumer: ReturnType<typeof service>) {
  assert.throws(() => consumer.write('unexpected'), /Writes closed/);
  assert.throws(() => consumer.dispatch('unexpected'), /Dispatch closed/);
}

test('maintenance closes all consumers before draining and records a usable stop boundary', async () => {
  const records: MaintenanceState[] = [];
  const coordinator = createMaintenanceCoordinator({ requiredServiceIds: ['a', 'b'], record: async (state) => { records.push(state); } });
  const a = service('a');
  const b = service('b');
  for (const consumer of [a, b]) {
    consumer.beforeDrain = () => { closed(a); closed(b); };
    consumer.write('accepted');
    coordinator.register(consumer);
  }
  const state = await coordinator.enter('backup');
  assert.equal(state.safeToStop, true);
  assert.equal(state.reason, 'backup');
  assert.deepEqual(a.saved, ['accepted']);
  assert.deepEqual(b.saved, ['accepted']);
  assert.equal(records.at(-1)?.safeToStop, true);
  assert.throws(() => coordinator.register(service('c')), /during maintenance/);
  await assert.rejects(coordinator.enter('second'), /already entered/);
  const snapshot = coordinator.status();
  snapshot.participants[0]!.resourceRoots.push('mutated');
  assert.deepEqual(coordinator.status().participants[0]!.resourceRoots, ['resources/a']);
  await coordinator.resume();
  a.write('after');
  b.dispatch('after');
  assert.deepEqual(b.sent, ['after']);
  assert.equal(coordinator.status().phase, 'open');
});

test('missing required participant fails closed, then registration and validation recover', async () => {
  const coordinator = createMaintenanceCoordinator({ requiredServiceIds: ['a', 'b'], record: async () => {} });
  const a = service('a');
  coordinator.register(a);
  await assert.rejects(coordinator.enter('stop'), /Missing maintenance participants: b/);
  closed(a);
  assert.equal(coordinator.status().phase, 'failed');
  assert.equal(coordinator.status().safeToStop, false);
  await assert.rejects(coordinator.resume(), /Missing maintenance participants/);
  closed(a);
  const b = service('b');
  coordinator.register(b);
  assert.equal((await coordinator.validate()).phase, 'validated');
  closed(b);
  await coordinator.resume();
  b.write('recovered');
});

test('resume revalidates even after validation succeeded and reseals partial reopen failures', async () => {
  const coordinator = createMaintenanceCoordinator({ requiredServiceIds: ['a', 'b'], record: async () => {} });
  const a = service('a');
  const b = service('b');
  coordinator.register(a);
  coordinator.register(b);
  await coordinator.enter('repair');
  await coordinator.validate();
  b.invalid = true;
  await assert.rejects(coordinator.resume());
  closed(a); closed(b);
  b.invalid = false;
  b.failResume = true;
  await assert.rejects(coordinator.resume());
  closed(a); closed(b);
  assert.equal(coordinator.status().safeToStop, false);
  b.failResume = false;
  await coordinator.resume();
  a.dispatch('recovered');
  assert.deepEqual(a.sent, ['recovered']);
});

test('drain and durable record failures stay closed and can recover', async () => {
  let failRecord = false;
  const records: MaintenanceState[] = [];
  const coordinator = createMaintenanceCoordinator({ requiredServiceIds: ['a'], record: async (state) => {
    if (failRecord) throw new Error('Record unavailable');
    records.push(state);
  } });
  const a = service('a');
  coordinator.register(a);
  a.write('retained');
  a.failDrain = true;
  await assert.rejects(coordinator.enter('backup'));
  closed(a);
  a.failDrain = false;
  await coordinator.validate();
  assert.deepEqual(a.saved, ['retained']);
  failRecord = true;
  await assert.rejects(coordinator.resume());
  closed(a);
  assert.equal(coordinator.status().phase, 'failed');
  failRecord = false;
  await coordinator.resume();
  assert.equal(records.at(-1)?.phase, 'open');
});

test('concurrent operations and registration are rejected while closure is pending', async () => {
  const coordinator = createMaintenanceCoordinator({ requiredServiceIds: ['a'], record: async () => {} });
  const a = service('a');
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  a.beforeClose = () => barrier;
  coordinator.register(a);
  const entering = coordinator.enter('stop');
  try {
    await assert.rejects(coordinator.resume(), /in progress/);
    await assert.rejects(coordinator.validate(), /in progress/);
    await assert.rejects(coordinator.enter('backup'), /in progress|already entered/);
    assert.throws(() => coordinator.register(service('b')), /during maintenance/);
    assert.equal(coordinator.status().safeToStop, false);
  } finally { release(); }
  await entering;
  closed(a);
});

test('unconfirmed closure cannot authorize stop, and successful peers remain closed', async () => {
  const coordinator = createMaintenanceCoordinator({ requiredServiceIds: ['a', 'b'], record: async () => {} });
  const a = service('a');
  const b = service('b');
  b.failClose = true;
  coordinator.register(a);
  coordinator.register(b);
  await assert.rejects(coordinator.enter('stop'), /Write gate unavailable/);
  closed(a);
  assert.equal(coordinator.status().gatesClosed, false);
  assert.equal(coordinator.status().safeToStop, false);
  b.failClose = false;
  assert.equal((await coordinator.validate()).safeToStop, true);
  closed(b);
});

test('failure to record the reopened state reseals every consumer', async () => {
  const coordinator = createMaintenanceCoordinator({ requiredServiceIds: ['a'], record: async (state) => {
    if (state.phase === 'open') throw new Error('Completion record unavailable');
  } });
  const a = service('a');
  coordinator.register(a);
  await coordinator.enter('backup');
  await assert.rejects(coordinator.resume(), /Completion record unavailable/);
  closed(a);
  assert.equal(coordinator.status().phase, 'failed');
});
