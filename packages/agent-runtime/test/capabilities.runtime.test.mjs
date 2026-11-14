import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentRuntime, agentRuntimeMigrations } from '../dist/index.js';
import * as core from '../dist/index.js';
import { createDirectExecution } from '../../agents/src/execution/wire.ts';
import { createAgentSessionClient, createAgentSessionService, createBrowserAgentSessionCall } from '../../agents/src/transport/session-service.ts';

let postgres;
before(async () => { postgres = await nativeFixture(); });
after(async () => { await postgres?.close(); });
const deferred = () => Promise.withResolvers();
function manualTimers() {
  const scheduled = [];
  return { scheduled,
    setTimeout(callback, delayMs) { const timer = { callback, delayMs, cleared: false }; scheduled.push(timer); return timer; },
    clearTimeout(timer) { timer.cleared = true; },
  };
}
const pipeline = (overrides = {}) => ({
  async plan(_snapshot, ids) {
    return { kind: 'operation', operation: { operationId: ids.operationId, kind: 'fixture', bindingId: 'fixture-v1', input: {} }, snapshot: {} };
  },
  async dispatch() { return { state: 'completed', value: {} }; },
  async reconcile() { return null; },
  async apply(snapshot) { return { state: snapshot.state, complete: true }; },
  ...overrides,
});
function continuationPipeline(overrides = {}) {
  return pipeline({
    async plan(snapshot, ids) {
      if (snapshot.waits.some(wait => wait.state === 'consumed')) return { kind: 'complete' };
      return pipeline().plan(snapshot, ids);
    },
    async apply(snapshot, step) {
      return step.number === 1 ? { state: { originalOperationId: step.operation.operationId }, keepDispatch: true }
        : { state: snapshot.state, wait: { kind: 'external', presentation: {}, deadline: null,
          continuationOperationId: snapshot.state.originalOperationId } };
    },
    ...overrides,
  });
}

async function setup(t, agentPipeline = pipeline(), options = {}) {
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: postgres.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
  const backend = createFileBackend({ id: 'agent', root: join(postgres.root, owner.serviceId) });
  const storage = await openStorage({ binding, migrations: agentRuntimeMigrations, backend });
  const identity = { kind: 'personal', name: '学生', environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID() };
  const runtimes = [];
  const open = (overrides = {}) => {
    const runtime = createAgentRuntime(storage, { authorize: async () => {}, pipeline: agentPipeline, ...options, ...overrides });
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = open();
  t.after(async () => { try { for (const current of runtimes.reverse()) await current.close(); } finally { await storage.close(); } });
  async function session(restartPolicy = 'explicit') {
    const sessionId = randomUUID();
    await runtime.initialize({ sessionId, identity, scenario: 'fixture', restartPolicy, createdAt: new Date().toISOString() });
    return sessionId;
  }
  const sessionId = await session();
  const accept = (text = '问题', mode = 'steering') => runtime.accept(identity, { sessionId, requestId: randomUUID(), text, mode });
  const snapshot = (runId, current = runtime) => current.snapshot(identity, sessionId, runId);
  return { storage, runtime, identity, sessionId, session, accept, snapshot, open };
}

test('a targeted advance atomically expires its original wait and fences the continuation without dispatch', async t => {
  let clock = Date.now(), dispatched = 0, originalPermit;
  const deadline = new Date(clock + 10).toISOString();
  const f = await setup(t, continuationPipeline({
    async dispatch(_snapshot, step, permit) {
      dispatched += 1;
      if (step.number === 1) originalPermit = permit;
      return { state: 'completed', value: {} };
    },
    async apply(snapshot, step) {
      return step.number === 1
        ? { state: { originalOperationId: step.operation.operationId }, keepDispatch: true }
        : { state: snapshot.state, wait: { kind: 'external', presentation: {}, deadline,
          continuationOperationId: snapshot.state.originalOperationId } };
    },
  }), { now: () => clock });
  const accepted = await f.accept();
  await f.runtime.advance(accepted.runId);
  const waiting = await f.snapshot(accepted.runId), wait = waiting.waits[0];
  await f.runtime.assertDispatch(f.identity, originalPermit);
  clock += 9;
  await f.runtime.advance(accepted.runId);
  assert.deepEqual(await f.snapshot(accepted.runId), waiting, 'a live wait is not changed or polled');
  clock += 1;
  const result = await f.runtime.advance(accepted.runId);
  const expired = await f.snapshot(accepted.runId);
  assert.equal(expired.run.state, 'paused');
  assert.equal(expired.run.reason, 'wait-expired');
  assert.equal(expired.run.needsContinue, true);
  assert.equal(expired.run.generation, waiting.run.generation + 1);
  assert.equal(expired.waits[0].state, 'expired');
  assert.equal(expired.waits[0].version, wait.version + 1);
  assert.equal(expired.waits[0].response, null);
  assert.ok(expired.steps.every(step => !step.continuationOpen));
  assert.deepEqual(result.waits.waits, []);
  await assert.rejects(f.runtime.assertDispatch(f.identity, originalPermit), { code: 'stale-generation' });
  await assert.rejects(f.runtime.resolveWait(f.identity, f.sessionId, { requestId: randomUUID(),
    waitId: wait.waitId, expectedVersion: wait.version, result: { late: true } }), { code: 'conflict' });
  const events = await f.runtime.events(f.identity, f.sessionId);
  assert.equal(events.filter(event => event.kind === 'wait-expired').length, 1);
  await f.runtime.advance(accepted.runId);
  assert.deepEqual(await f.snapshot(accepted.runId), expired);
  assert.deepEqual(await f.runtime.events(f.identity, f.sessionId), events);
  assert.equal(dispatched, 2);
});

test('new steering cancels an explicitly interruptible wait without answering it and reaches the next operation', async t => {
  const seen = [];
  const f = await setup(t, pipeline({
    async dispatch(snapshot) { seen.push(snapshot.inputs.map(item => item.input.text)); return { state: 'completed', value: {} }; },
    async apply(snapshot, step) { return step.number === 1
      ? { state: snapshot.state, wait: { kind: 'fixture-decision', presentation: { question: 'Original question' }, deadline: null, interruptible: true } }
      : { state: snapshot.state, complete: true }; },
  }));
  const first = await f.accept('first input');
  await f.runtime.advance(first.runId);
  const before = await f.snapshot(first.runId), original = before.waits[0];
  assert.equal(original.state, 'pending');
  const queued = await f.accept('later queued input', 'queue');
  assert.notEqual(queued.runId, first.runId);
  assert.equal((await f.snapshot(first.runId)).waits[0].state, 'pending', 'queue does not interrupt');
  const steering = await f.accept('new independent message');
  assert.equal(steering.runId, first.runId);
  const interrupted = await f.snapshot(first.runId);
  assert.equal(interrupted.waits[0].state, 'cancelled');
  assert.equal(interrupted.waits[0].response, null);
  assert.ok(interrupted.run.generation > before.run.generation);
  await assert.rejects(f.runtime.respond(f.identity, f.sessionId, { requestId: randomUUID(), waitId: original.waitId,
    expectedVersion: original.version, answer: { text: 'late answer' } }), { code: 'conflict' });
  await f.runtime.advance(first.runId);
  assert.equal((await f.snapshot(first.runId)).run.state, 'completed');
  assert.ok(seen[1].includes('new independent message'));
  assert.ok((await f.runtime.events(f.identity, f.sessionId)).some(event => event.kind === 'wait-cancelled'
    && event.body.waitId === original.waitId && event.body.reason === 'steering'));
});

test('steering preserves noninterruptible effects and closes explicitly interrupted continuation authority', async t => {
  for (const interruptible of [false, true]) {
    const f = await setup(t, continuationPipeline({
      async plan(snapshot, ids) {
        return snapshot.waits.some(wait => wait.state === 'cancelled') ? { kind: 'complete' } : pipeline().plan(snapshot, ids);
      },
      async apply(snapshot, step) { return step.number === 1 ? { state: { originalOperationId: step.operation.operationId }, keepDispatch: true }
        : { state: snapshot.state, wait: { kind: 'fixture-external', presentation: {}, deadline: null, interruptible,
          continuationOperationId: snapshot.state.originalOperationId } }; },
    }));
    const accepted = await f.accept(); await f.runtime.advance(accepted.runId);
    const before = await f.snapshot(accepted.runId), original = before.steps[0], wait = before.waits[0];
    const permit = { sessionId: f.sessionId, runId: accepted.runId, stepId: original.stepId,
      operationId: original.operation.operationId, generation: before.run.generation };
    await f.runtime.assertDispatch(f.identity, permit);
    await f.accept('steer');
    const after = await f.snapshot(accepted.runId);
    assert.equal(after.waits[0].state, interruptible ? 'cancelled' : 'pending');
    assert.deepEqual(after.steps[0].result, original.result, 'original external result remains fixed');
    if (interruptible) {
      await assert.rejects(f.runtime.assertDispatch(f.identity, permit), { code: 'stale-generation' });
      await assert.rejects(f.runtime.resolveWait(f.identity, f.sessionId, { requestId: randomUUID(), waitId: wait.waitId,
        expectedVersion: wait.version, result: { text: 'late external result' } }), { code: 'conflict' });
      await f.runtime.advance(accepted.runId);
      assert.equal((await f.snapshot(accepted.runId)).run.state, 'completed');
    } else await f.runtime.assertDispatch(f.identity, permit);
  }
});

for (const interruptible of [true, false]) test(`moving a queued input to steering ${interruptible ? 'interrupts the original wait atomically' : 'preserves a noninterruptible wait'}`, async t => {
  const f = await setup(t, continuationPipeline({
    async plan(snapshot, ids) {
      return snapshot.waits.some(wait => wait.state === 'cancelled') ? { kind: 'complete' } : pipeline().plan(snapshot, ids);
    },
    async apply(snapshot, step) { return step.number === 1
      ? { state: { originalOperationId: step.operation.operationId }, keepDispatch: true }
      : { state: snapshot.state, wait: { kind: 'user', presentation: { question: 'Original question' }, deadline: null,
        interruptible, continuationOperationId: snapshot.state.originalOperationId } }; },
  }));
  const active = await f.accept('original question'); await f.runtime.advance(active.runId);
  const before = await f.snapshot(active.runId), wait = before.waits[0], original = before.steps[0];
  const queued = await f.accept('queued steering instruction', 'queue');
  assert.notEqual(queued.runId, active.runId);
  const control = { requestId: randomUUID(), operation: 'move', expectedVersion: 1, mode: 'steering' };
  const moved = await f.runtime.inputControl(f.identity, f.sessionId, queued.inputId, control);
  assert.equal(moved.input.runId, active.runId);
  assert.equal(moved.input.inputId, queued.inputId);
  assert.equal(moved.input.input.text, 'queued steering instruction');
  assert.equal(moved.input.mode, 'steering');
  assert.equal(moved.previousRunId, queued.runId);
  const after = await f.snapshot(active.runId);
  assert.equal(after.waits[0].state, interruptible ? 'cancelled' : 'pending');
  assert.equal(after.waits[0].version, wait.version + (interruptible ? 1 : 0));
  assert.equal(after.waits[0].response, null, 'a steering move never becomes an answer to the old question');
  assert.equal(after.run.generation, before.run.generation + (interruptible ? 1 : 0));
  assert.equal(after.run.state, interruptible ? 'received' : 'waiting');
  assert.equal(after.steps[0].continuationOpen, !interruptible);
  assert.deepEqual(after.steps[0].result, original.result);
  assert.equal((await f.snapshot(queued.runId)).run.state, 'stopped', 'the now empty queued Run is retired');
  assert.deepEqual(await f.runtime.inputControl(f.identity, f.sessionId, queued.inputId, control), moved);
  assert.deepEqual(await f.snapshot(active.runId), after, 'replaying the original move cannot cancel twice or renew generation');
  if (interruptible) {
    await assert.rejects(f.runtime.respond(f.identity, f.sessionId, { requestId: randomUUID(), waitId: wait.waitId,
      expectedVersion: wait.version, answer: { text: 'late answer' } }), { code: 'conflict' });
    const events = await f.runtime.events(f.identity, f.sessionId);
    assert.equal(events.filter(event => event.kind === 'wait-cancelled' && event.body.waitId === wait.waitId
      && event.body.requestId === control.requestId && event.body.inputId === queued.inputId).length, 1);
    await f.runtime.advance(active.runId);
    assert.equal((await f.snapshot(active.runId)).run.state, 'completed');
  } else {
    await f.runtime.advance(active.runId);
    assert.equal((await f.snapshot(active.runId)).run.state, 'waiting');
  }
});

test('request recovery returns the original receipt and fixed input only within its session', async (t) => {
  const f = await setup(t);
  const input = { sessionId: f.sessionId, requestId: randomUUID(), text: '固定问题', context: { attachment: 'one' }, mode: 'steering' };
  const receipt = await f.runtime.accept(f.identity, input);
  assert.deepEqual(await f.runtime.request(f.identity, f.sessionId, input.requestId), { receipt, input });
  assert.equal(await f.runtime.request(f.identity, f.sessionId, randomUUID()), null);
  const otherSession = await f.session();
  assert.equal(await f.runtime.request(f.identity, otherSession, input.requestId), null);
  await assert.rejects(f.runtime.accept(f.identity, { ...input, sessionId: otherSession }), { code: 'identity-conflict' });
  await assert.rejects(f.runtime.request({ ...f.identity, principalId: randomUUID() }, f.sessionId, input.requestId), { code: 'forbidden' });
  await f.runtime.close();
  const restarted = f.open();
  assert.deepEqual(await restarted.request(f.identity, f.sessionId, input.requestId), { receipt, input });
});

test('sessionSnapshot projects runs, inputs and waits in one read without native step results', async (t) => {
  const hidden = 'native-result-that-the-product-must-not-project';
  const f = await setup(t, pipeline({
    async dispatch() { return { state: 'completed', value: { native: hidden.repeat(1000) } }; },
    async apply(snapshot) { return { state: snapshot.state, sessionState: { native: hidden },
      wait: { kind: 'user', presentation: { question: '继续？' }, deadline: null } }; },
  }));
  const first = await f.accept();
  await f.runtime.advance(first.runId);
  const queued = await f.accept('排队', 'queue');
  const before = await f.runtime.events(f.identity, f.sessionId);
  const projected = await f.runtime.sessionSnapshot(f.identity, f.sessionId);
  assert.deepEqual(Object.keys(projected).sort(), ['inputs', 'runs', 'session', 'waits']);
  assert.equal(projected.session.sessionId, f.sessionId);
  assert.deepEqual(projected.runs.map(run => [run.runId, run.state]), [[first.runId, 'waiting'], [queued.runId, 'received']]);
  assert.deepEqual(projected.inputs.map(input => [input.inputId, input.runId, input.version, input.mode, input.state]), [
    [first.inputId, first.runId, 1, 'steering', 'adopted'], [queued.inputId, queued.runId, 1, 'queue', 'pending'],
  ]);
  assert.equal(projected.inputs[1].input.text, '排队');
  assert.ok(projected.inputs.every(input => !Number.isNaN(Date.parse(input.createdAt))));
  assert.equal(projected.waits[0].state, 'pending');
  assert.equal(JSON.stringify(projected).includes(hidden), false);
  assert.deepEqual(await f.runtime.events(f.identity, f.sessionId), before);
  await assert.rejects(f.runtime.sessionSnapshot({ ...f.identity, principalId: randomUUID() }, f.sessionId), { code: 'forbidden' });
  const empty = await f.runtime.sessionSnapshot(f.identity, await f.session());
  assert.deepEqual([empty.runs, empty.inputs, empty.waits], [[], [], []]);
});

test('pending edits are versioned and idempotent without changing original request recovery or adopted input', async (t) => {
  const f = await setup(t);
  const original = { sessionId: f.sessionId, requestId: randomUUID(), text: 'old', context: {}, mode: 'steering' };
  const receipt = await f.runtime.accept(f.identity, original);
  const control = { requestId: randomUUID(), expectedVersion: 1, operation: 'edit', text: 'new', context: { selected: 'one' } };
  const edit = (value, sessionId = f.sessionId) => f.runtime.inputControl(f.identity, sessionId, receipt.inputId, value);
  const edited = await edit(control);
  assert.equal(edited.input.version, 2);
  assert.equal(edited.input.state, 'pending');
  assert.equal(edited.input.input.text, 'new');
  assert.deepEqual(edited.input.input.context, { selected: 'one' });
  assert.deepEqual(await edit(control), edited);
  assert.deepEqual(await f.runtime.request(f.identity, f.sessionId, original.requestId), { receipt, input: original });
  assert.deepEqual(await f.runtime.accept(f.identity, original), receipt);
  await assert.rejects(edit({ ...control, text: 'reuse' }), { code: 'identity-conflict' });
  await assert.rejects(edit({ ...control, requestId: randomUUID() }), { code: 'conflict' });
  await assert.rejects(edit({ ...control, requestId: randomUUID() }, await f.session()), { code: 'missing' });
  await f.runtime.advance(receipt.runId);
  await assert.rejects(edit({ ...control, requestId: randomUUID(), expectedVersion: 2 }), { code: 'conflict' });
  const inputs = (await f.runtime.sessionSnapshot(f.identity, f.sessionId)).inputs;
  assert.equal(inputs[0].version, 2);
  assert.equal(inputs[0].state, 'adopted');
  assert.equal((await f.runtime.events(f.identity, f.sessionId)).filter(event => event.kind === 'input-edited').length, 1);
});

test('removing the only pending input prevents a blank run and preserves queue successor handoff', async (t) => {
  const dispatched = [];
  const f = await setup(t, pipeline({ async dispatch(snapshot) { dispatched.push(snapshot.inputs[0].input.text); return { state: 'completed', value: {} }; } }));
  const first = await f.accept('remove');
  const next = await f.accept('next', 'queue');
  const control = { requestId: randomUUID(), expectedVersion: 1, operation: 'remove' };
  const removed = await f.runtime.inputControl(f.identity, f.sessionId, first.inputId, control);
  assert.equal(removed.input.state, 'removed');
  assert.equal(removed.input.version, 2);
  assert.deepEqual(await f.runtime.inputControl(f.identity, f.sessionId, first.inputId, control), removed);
  const result = await f.runtime.advance(first.runId);
  assert.equal(result.nextRunId, next.runId);
  assert.deepEqual(dispatched, []);
  await f.runtime.advance(next.runId);
  assert.deepEqual(dispatched, ['next']);
  assert.equal((await f.runtime.sessionSnapshot(f.identity, f.sessionId)).inputs[0].state, 'removed');
});

test('promoting a queued pending input joins the active run without letting later runs bypass it', async (t) => {
  const dispatched = [];
  const f = await setup(t, pipeline({ async dispatch(snapshot) { dispatched.push(snapshot.inputs.map(input => input.input.text)); return { state: 'completed', value: {} }; } }));
  const first = await f.accept('first');
  const queued = await f.accept('promote', 'queue');
  const later = await f.accept('later', 'queue');
  const promoted = await f.runtime.inputControl(f.identity, f.sessionId, queued.inputId, {
    requestId: randomUUID(), expectedVersion: 1, operation: 'move', mode: 'steering',
  });
  assert.equal(promoted.input.runId, first.runId);
  assert.equal(promoted.input.mode, 'steering');
  assert.equal((await f.snapshot(queued.runId)).run.state, 'stopped');
  await f.runtime.advance(later.runId);
  assert.deepEqual(dispatched, [], 'a retired intermediate run does not remove the active ancestor gate');
  await f.runtime.advance(first.runId);
  const handoff = await f.runtime.advance(queued.runId);
  assert.equal(handoff.nextRunId, later.runId);
  await f.runtime.advance(later.runId);
  assert.deepEqual(dispatched, [['first', 'promote'], ['later']]);
  const original = await f.runtime.request(f.identity, f.sessionId, queued.requestId);
  assert.deepEqual(original.receipt, queued);
  assert.equal(original.input.mode, 'queue');
  await core.validateAgentRuntime(f.storage);
});

test('moving pending steering to queue creates a successor while retaining its original request identity', async (t) => {
  const dispatched = [];
  const f = await setup(t, pipeline({ async dispatch(snapshot) { dispatched.push(snapshot.inputs.map(input => input.input.text)); return { state: 'completed', value: {} }; } }));
  const first = await f.accept('first');
  const steering = await f.accept('defer');
  const moved = await f.runtime.inputControl(f.identity, f.sessionId, steering.inputId, {
    requestId: randomUUID(), expectedVersion: 1, operation: 'edit', mode: 'queue', text: 'queued',
  });
  assert.notEqual(moved.input.runId, first.runId);
  assert.equal(moved.input.input.mode, 'queue');
  await f.runtime.advance(moved.input.runId);
  assert.deepEqual(dispatched, []);
  const next = await f.runtime.advance(first.runId);
  assert.equal(next.nextRunId, moved.input.runId);
  await f.runtime.advance(moved.input.runId);
  assert.deepEqual(dispatched, [['first'], ['queued']]);
  const recovered = await f.runtime.request(f.identity, f.sessionId, steering.requestId);
  assert.deepEqual(recovered.receipt, steering);
  assert.equal(recovered.input.text, 'defer');
  await core.validateAgentRuntime(f.storage);
});

test('Node progress is revisioned, deduplicated and public only while the original permit is active', async (t) => {
  const entered = deferred(), release = deferred();
  let permit;
  const f = await setup(t, pipeline({
    async dispatch(_snapshot, _step, issued) { permit = issued; entered.resolve(); await release.promise; return { state: 'completed', value: {} }; },
  }));
  const accepted = await f.accept();
  const advancing = f.runtime.advance(accepted.runId);
  try {
    await entered.promise;
    const progress = { revision: 1, text: '已过滤的进度', tools: [{ name: 'lookup', state: 'started' }] };
    assert.equal(await f.runtime.recordProgress(f.identity, permit, progress), true);
    assert.equal(await f.runtime.recordProgress(f.identity, permit, progress), false);
    await assert.rejects(f.runtime.recordProgress(f.identity, permit, { ...progress, text: 'changed' }), { code: 'identity-conflict' });
    assert.equal(await f.runtime.recordProgress(f.identity, permit, { revision: 3, text: '更新' }), true);
    assert.equal(await f.runtime.recordProgress(f.identity, permit, { revision: 2, text: '旧进度' }), false);
    assert.equal(await f.runtime.recordProgress(f.identity, { ...permit, generation: permit.generation + 1 }, { revision: 4, text: '失效' }), false);
  } finally { release.resolve(); await advancing; }
  assert.equal(await f.runtime.recordProgress(f.identity, permit, { revision: 4, text: '迟到' }), false);
  const progressEvents = (await f.runtime.events(f.identity, f.sessionId)).filter(event => event.kind === 'model-progress');
  assert.deepEqual(progressEvents.map(event => event.body.revision), [1, 3]);
  assert.equal(new Set(progressEvents.map(event => event.eventId)).size, 2);
  assert.ok(progressEvents.every(event => event.body.operationId === permit.operationId));
  await f.runtime.close();
  const restarted = f.open();
  assert.equal(await restarted.recordProgress(f.identity, permit, { revision: 5, text: '重启迟到' }), false);
  assert.equal((await restarted.events(f.identity, f.sessionId)).filter(event => event.kind === 'model-progress').length, 2);
});

test('startup exposes automatic pending waits once for host observation without waking explicit runs or polling users', async (t) => {
  const wakes = [];
  const f = await setup(t, pipeline({
    async dispatch() { return { state: 'accepted', value: {} }; },
    async apply(snapshot) { return snapshot.inputs[0].input.text === 'wait'
      ? { state: snapshot.state, wait: { kind: 'user', presentation: {}, deadline: null } }
      : { state: snapshot.state }; },
  }), { execution: () => ({ wake(id) { wakes.push(id); }, closeDispatch() {}, async drain() {} }) });
  const explicit = await f.accept();
  await f.runtime.advance(explicit.runId);
  const send = (sessionId, text) => f.runtime.accept(f.identity, { sessionId, requestId: randomUUID(), text });
  const automatic = await send(await f.session('automatic'), 'pending');
  await f.runtime.advance(automatic.runId);
  const userSession = await f.session('automatic');
  const user = await send(userSession, 'wait');
  await f.runtime.advance(user.runId);
  const queued = await f.runtime.accept(f.identity, { sessionId: userSession,
    requestId: randomUUID(), text: 'queued', mode: 'queue' });
  const received = await send(await f.session('automatic'), 'received');
  await f.runtime.close();
  wakes.length = 0;
  const restarted = f.open();
  const recoverable = await restarted.recoverableRuns();
  assert.deepEqual(new Set(recoverable.map(run => run.runId)), new Set([automatic.runId, user.runId, received.runId]));
  assert.ok(recoverable.every(run => !run.needsContinue));
  assert.equal(recoverable.some(run => [explicit.runId, queued.runId].includes(run.runId)), false);
  assert.deepEqual(wakes, []);
  assert.deepEqual(await restarted.recoverableRuns(), recoverable);
  assert.equal((await restarted.run(f.identity, f.sessionId, explicit.runId)).needsContinue, true);
  const waiting = await restarted.snapshot(f.identity, userSession, user.runId);
  const observed = await restarted.advance(user.runId);
  assert.equal(observed.waits.runId, user.runId);
  assert.deepEqual(observed.waits.waits, waiting.waits);
  assert.equal(observed.retryAfterMs, undefined, 'a pending user question schedules no timer');
  assert.deepEqual(await restarted.snapshot(f.identity, userSession, user.runId), waiting);
  assert.deepEqual(wakes, [], 'one host observation does not schedule more advances');
});

test('run step budget is frozen and cumulative across advances, restart and continue', async (t) => {
  let dispatched = 0;
  const f = await setup(t, pipeline({
    async dispatch() { dispatched += 1; return { state: 'accepted', value: {}, retryAfterMs: 1 }; },
    async reconcile() { return { state: 'completed', value: {} }; },
    async apply(snapshot) { return { state: snapshot.state }; },
  }), { runBudget: { maxSteps: 2, maxDispatches: 10 } });
  const accepted = await f.accept();
  assert.deepEqual((await f.snapshot(accepted.runId)).budget, { maxSteps: 2, maxDispatches: 10, deadline: null, steps: 0, dispatches: 0 });
  await f.runtime.advance(accepted.runId);
  await f.runtime.advance(accepted.runId);
  assert.equal(dispatched, 2);
  await f.runtime.close();
  const restarted = f.open({ runBudget: { maxSteps: 99, maxDispatches: 99 } });
  await restarted.continueRun(f.identity, f.sessionId, accepted.runId, randomUUID());
  await restarted.advance(accepted.runId);
  const exhausted = await f.snapshot(accepted.runId, restarted);
  assert.equal(exhausted.run.reason, 'step-budget-exhausted');
  assert.equal(exhausted.run.state, 'paused');
  assert.deepEqual(exhausted.budget, { maxSteps: 2, maxDispatches: 10, deadline: null, steps: 2, dispatches: 2 });
  await restarted.continueRun(f.identity, f.sessionId, accepted.runId, randomUUID());
  await restarted.advance(accepted.runId);
  assert.equal(dispatched, 2);
});

test('dispatch admissions accumulate across retries and continue cannot reset their frozen limit', async (t) => {
  let admissions = 0;
  const f = await setup(t, pipeline({
    async dispatch() { admissions += 1; return { state: 'not-dispatched', value: {}, retryAfterMs: 1 }; },
    async apply(snapshot) { return { state: snapshot.state }; },
  }), { runBudget: { maxSteps: 10, maxDispatches: 2 } });
  const accepted = await f.accept();
  await f.runtime.advance(accepted.runId);
  await f.runtime.advance(accepted.runId);
  await f.runtime.advance(accepted.runId);
  assert.equal((await f.snapshot(accepted.runId)).run.reason, 'dispatch-budget-exhausted');
  await f.runtime.continueRun(f.identity, f.sessionId, accepted.runId, randomUUID());
  await f.runtime.advance(accepted.runId);
  assert.equal(admissions, 2);
  assert.equal((await f.snapshot(accepted.runId)).budget.dispatches, 2);
});

test('a frozen deadline fences an issued permit and late progress before any physical dispatch', async (t) => {
  let clock = Date.now();
  const entered = deferred(), release = deferred();
  let permit, physical = 0;
  const f = await setup(t, pipeline({
    async dispatch(_snapshot, _step, issued, assertDispatch) {
      permit = issued; entered.resolve(); await release.promise; await assertDispatch(); physical += 1;
      return { state: 'completed', value: {} };
    },
  }), { now: () => clock, runBudget: { timeoutMs: 10 } });
  const accepted = await f.accept();
  const deadline = (await f.snapshot(accepted.runId)).budget.deadline;
  assert.equal(Date.parse(deadline), clock + 10);
  const advancing = f.runtime.advance(accepted.runId);
  try {
    await entered.promise;
    clock += 11;
    await assert.rejects(f.runtime.assertDispatch(f.identity, permit), { code: 'stale-generation' });
    assert.equal(await f.runtime.recordProgress(f.identity, permit, { revision: 1, text: 'late' }), false);
  } finally { release.resolve(); await advancing; }
  assert.equal(physical, 0);
  assert.equal((await f.snapshot(accepted.runId)).budget.deadline, deadline);
});

test('runtime source closure covers current owner facts, original inputs and staged resource bytes', async (t) => {
  const f = await setup(t, pipeline({
    async dispatch(_snapshot, _step, permit) { await f.runtime.recordProgress(f.identity, permit, { revision: 1, text: 'safe' }); return { state: 'completed', value: {} }; },
    async apply(snapshot) { return snapshot.inputs[0].input.text === 'wait'
      ? { state: snapshot.state, wait: { kind: 'user', presentation: {}, deadline: null } }
      : { state: { resourceId: resource.resourceId }, sessionState: { resourceId: resource.resourceId }, complete: true }; },
  }));
  const resource = await f.storage.stageResource({ uploadId: randomUUID(), scope: 'agent-fixture', bytes: Buffer.from('original bytes'), mediaType: 'text/plain', contentVersion: 1 });
  await f.storage.request({ requestId: 'pin', fingerprint: 'pin' }, tx => tx.reference('fixture', resource.resourceId));
  const accepted = await f.runtime.accept(f.identity, { requestId: randomUUID(), sessionId: f.sessionId, text: 'original', context: { resourceId: resource.resourceId } });
  await f.runtime.inputControl(f.identity, f.sessionId, accepted.inputId, { requestId: randomUUID(), expectedVersion: 1, operation: 'edit', text: 'edited' });
  await f.runtime.advance(accepted.runId);
  const wait = await f.accept('wait');
  await f.runtime.advance(wait.runId);
  await core.validateAgentRuntime(f.storage);
  const closure = await core.collectAgentRuntimeSources(f.storage);
  assert.equal(closure.owner, 'xunjie.agent-runtime');
  const kinds = new Set(closure.entries.map(entry => entry.kind));
  for (const kind of ['agent_runtime_sessions', 'agent_runs', 'agent_inputs', 'agent_steps', 'agent_waits', 'agent_events', 'agent_controls', 'agent_progress']) assert.ok(kinds.has(kind), kind);
  assert.ok(closure.entries.some(entry => entry.resources.some(item => item.resourceId === resource.resourceId && item.byteLength === 14)));
  await core.validateAgentRuntimeSources(f.storage, closure);
  const changed = structuredClone(closure);
  changed.entries[0].digest = '0'.repeat(64);
  await assert.rejects(core.validateAgentRuntimeSources(f.storage, changed), { code: 'corrupt' });
});

test('restore validation rejects a wait attached to a different session even when database FKs still hold', async (t) => {
  const f = await setup(t, pipeline({ async apply(snapshot) { return { state: snapshot.state, wait: { kind: 'user', presentation: {}, deadline: null } }; } }));
  const first = await f.accept();
  await f.runtime.advance(first.runId);
  const wait = (await f.snapshot(first.runId)).waits[0];
  const other = await f.runtime.accept(f.identity, { sessionId: await f.session(), requestId: randomUUID(), text: 'other' });
  await core.validateAgentRuntime(f.storage);
  await f.storage.request({ requestId: 'corrupt-wait', fingerprint: 'cross-session-wait' }, tx =>
    tx.query('UPDATE agent_waits SET run_id=$2 WHERE wait_id=$1', [wait.waitId, other.runId]));
  await assert.rejects(core.validateAgentRuntime(f.storage), { code: 'corrupt' });
});

test('restore validation rejects a malformed persisted subject rather than accepting its JSON digest', async (t) => {
  const f = await setup(t);
  await f.accept();
  await core.validateAgentRuntime(f.storage);
  await f.storage.request({ requestId: 'bad-subject', fingerprint: 'bad-subject' }, tx =>
    tx.query("UPDATE agent_runtime_sessions SET body=jsonb_set(body,'{identity,principalId}','\"invalid\"'::jsonb) WHERE session_id=$1", [f.sessionId]));
  await assert.rejects(core.validateAgentRuntime(f.storage), { code: 'corrupt' });
});

test('maintenance gates writes and dispatch, keeps pure reads and resumes the original operation without a second effect', async (t) => {
  const timers = manualTimers();
  let effects = 0, queries = 0, factories = 0;
  const f = await setup(t, pipeline({
    async dispatch() { effects += 1; return { state: 'accepted', value: {}, retryAfterMs: 10 }; },
    async reconcile() { queries += 1; return { state: 'completed', value: {} }; },
    async apply(snapshot, _step, result) { return { state: snapshot.state, complete: result.state === 'completed' }; },
  }), { execution(advance) { factories += 1; return createDirectExecution(advance, { timers }); } });
  const accepted = await f.accept();
  await f.runtime.drain();
  const waiting = await f.snapshot(accepted.runId);
  f.runtime.closeWrites();
  f.runtime.closeDispatch();
  await f.runtime.drain();
  const participant = f.storage.participant();
  await participant.closeWrites(); await participant.closeDispatch(); await participant.drain();
  await assert.rejects(f.accept(), { code: 'maintenance' });
  await assert.rejects(f.runtime.continueRun(f.identity, f.sessionId, accepted.runId, randomUUID()), { code: 'maintenance' });
  await assert.rejects(f.runtime.stop(f.identity, f.sessionId, accepted.runId, randomUUID()), { code: 'maintenance' });
  assert.deepEqual((await f.runtime.request(f.identity, f.sessionId, accepted.requestId)).receipt, accepted);
  assert.equal((await f.runtime.sessionSnapshot(f.identity, f.sessionId)).runs[0].state, 'waiting');
  assert.equal((await f.snapshot(accepted.runId)).run.generation, waiting.run.generation);
  assert.ok((await f.runtime.events(f.identity, f.sessionId)).length > 0);
  timers.scheduled[0].callback();
  assert.equal(queries, 0);
  await participant.resume();
  await f.runtime.resume();
  await f.runtime.drain();
  assert.equal(factories, 2);
  assert.equal(effects, 1);
  assert.equal(queries, 1);
  assert.equal((await f.snapshot(accepted.runId)).run.state, 'completed');
  assert.equal((await f.runtime.events(f.identity, f.sessionId)).filter(event => event.kind === 'run-recovered').length, 0);
  await f.runtime.close();
  await assert.rejects(f.runtime.resume(), { code: 'maintenance' });
});

test('maintenance resume does not release an explicit boot gate or re-run process recovery', async (t) => {
  let effects = 0, queries = 0;
  const timers = manualTimers();
  const f = await setup(t, pipeline({
    async dispatch() { effects += 1; return { state: 'accepted', value: {}, retryAfterMs: 10 }; },
    async reconcile() { queries += 1; return { state: 'completed', value: {} }; },
    async apply(snapshot, _step, result) { return { state: snapshot.state, complete: result.state === 'completed' }; },
  }), { execution: advance => createDirectExecution(advance, { timers }) });
  const accepted = await f.accept(); await f.runtime.drain(); await f.runtime.close();
  const restarted = f.open();
  const gated = await f.snapshot(accepted.runId, restarted);
  assert.equal(gated.run.needsContinue, true);
  restarted.closeWrites(); restarted.closeDispatch(); await restarted.drain();
  await restarted.resume(); await restarted.drain();
  assert.equal(queries, 0);
  assert.equal(effects, 1);
  assert.equal((await f.snapshot(accepted.runId, restarted)).run.needsContinue, true);
  assert.equal((await restarted.events(f.identity, f.sessionId)).filter(event => event.kind === 'run-recovered').length, 1);
  await restarted.continueRun(f.identity, f.sessionId, accepted.runId, randomUUID());
  await restarted.drain();
  assert.equal(queries, 1);
  assert.equal(effects, 1);
  assert.equal((await f.snapshot(accepted.runId, restarted)).run.state, 'completed');
});

test('isolated read-only startup performs no recovery writes and defers its single boot gate until resume', async (t) => {
  const f = await setup(t);
  const accepted = await f.accept();
  const before = await f.snapshot(accepted.runId);
  await f.runtime.close();
  const participant = f.storage.participant();
  await participant.closeWrites(); await participant.closeDispatch(); await participant.drain();
  const isolated = f.open({ readOnly: true });
  assert.equal((await f.snapshot(accepted.runId, isolated)).run.generation, before.run.generation);
  assert.equal((await isolated.sessionSnapshot(f.identity, f.sessionId)).runs[0].needsContinue, false);
  assert.deepEqual((await isolated.request(f.identity, f.sessionId, accepted.requestId)).receipt, accepted);
  assert.equal((await isolated.events(f.identity, f.sessionId)).filter(event => event.kind === 'run-recovered').length, 0);
  await assert.rejects(isolated.accept(f.identity, { sessionId: f.sessionId, requestId: randomUUID(), text: 'no' }), { code: 'maintenance' });
  await participant.resume(); await isolated.resume();
  assert.equal((await f.snapshot(accepted.runId, isolated)).run.needsContinue, true);
  isolated.closeWrites(); isolated.closeDispatch(); await isolated.drain(); await isolated.resume();
  assert.equal((await isolated.events(f.identity, f.sessionId)).filter(event => event.kind === 'run-recovered').length, 1);
});

test('v2 browser input control reaches the actual core and correlates its JSON receipt and budget snapshot', async (t) => {
  const f = await setup(t);
  const service = createAgentSessionService(f.runtime, { audience: 'browser', authorize: async () => {} });
  const client = createAgentSessionClient(async call => JSON.parse(JSON.stringify(await service(JSON.parse(JSON.stringify(call))))));
  const accepted = await client.accept(f.identity, { requestId: randomUUID(), sessionId: f.sessionId, text: 'before', mode: 'steering', context: {} });
  const control = { requestId: randomUUID(), expectedVersion: 1, operation: 'edit', text: 'after' };
  const receipt = await client.inputControl(f.identity, f.sessionId, accepted.inputId, control);
  assert.equal(receipt.input.version, 2);
  assert.equal(receipt.input.input.text, 'after');
  assert.deepEqual(await client.inputControl(f.identity, f.sessionId, accepted.inputId, control), receipt);
  const snapshot = await client.snapshot(f.identity, f.sessionId, accepted.runId);
  assert.equal(snapshot.budget.maxSteps, 128);
  assert.equal(snapshot.budget.steps, 0);
  const forged = createAgentSessionClient(async () => ({ ...receipt, input: { ...receipt.input, input: { ...receipt.input.input, sessionId: randomUUID() } } }));
  await assert.rejects(forged.inputControl(f.identity, f.sessionId, accepted.inputId, control), { code: 'incompatible' });
});

test('v2 original permit assertion requires service audience and extra host authorization bound to session and attempt', async (t) => {
  const entered = deferred(), release = deferred();
  let permit, checks = 0;
  const f = await setup(t, pipeline({ async dispatch(_snapshot, _step, issued) {
    permit = issued; entered.resolve(); await release.promise; return { state: 'completed', value: {} };
  } }));
  const accepted = await f.accept();
  const advancing = f.runtime.advance(accepted.runId);
  const authorizeDispatchPermit = async (_identity, original) => { checks += 1; assert.deepEqual(original, permit); };
  const service = createAgentSessionService(f.runtime, { audience: 'service', authorize: async () => {}, authorizeDispatchPermit });
  const connect = handler => createAgentSessionClient(async call => JSON.parse(JSON.stringify(await handler(JSON.parse(JSON.stringify(call))))));
  const node = connect(service);
  try {
    await entered.promise;
    assert.equal(await node.assertDispatch(f.identity, permit), undefined);
    assert.equal(checks, 1);
    const browser = connect(createAgentSessionService(f.runtime, { audience: 'browser', authorize: async () => {}, authorizeDispatchPermit }));
    await assert.rejects(browser.assertDispatch(f.identity, permit), { code: 'forbidden' });
    const untrusted = connect(createAgentSessionService(f.runtime, { audience: 'service', authorize: async () => {} }));
    await assert.rejects(untrusted.assertDispatch(f.identity, permit), { code: 'forbidden' });
    assert.equal(checks, 1);
    assert.throws(() => createBrowserAgentSessionCall(f.identity, f.sessionId, 'assertDispatch', { permit, attemptId: permit.operationId }), { code: 'forbidden' });
    const call = { version: 2, operation: 'assertDispatch', identity: f.identity, sessionId: f.sessionId,
      args: { permit, attemptId: permit.operationId } };
    await assert.rejects(service({ ...call, sessionId: randomUUID() }), { code: 'invalid' });
    await assert.rejects(service({ ...call, args: { ...call.args, attemptId: randomUUID() } }), { code: 'invalid' });
    await assert.rejects(node.assertDispatch(f.identity, { ...permit, lease: 'not-a-permit-field' }), { code: 'invalid' });
    await f.runtime.stop(f.identity, f.sessionId, accepted.runId, randomUUID());
    await assert.rejects(node.assertDispatch(f.identity, permit), { code: 'stale-generation' });
    assert.equal(await f.runtime.recordProgress(f.identity, permit, { revision: 1, text: 'late after stop' }), false);
    assert.equal((await node.snapshot(f.identity, f.sessionId, accepted.runId)).run.state, 'stopped');
  } finally { release.resolve(); await advancing; }
});

test('editing queued text preserves omitted context and mode through the same public control schema', async (t) => {
  const f = await setup(t);
  await f.accept('active');
  const queued = await f.runtime.accept(f.identity, { requestId: randomUUID(), sessionId: f.sessionId,
    text: 'before', mode: 'queue', context: { fixed: 'retained' } });
  const edited = await f.runtime.inputControl(f.identity, f.sessionId, queued.inputId, {
    requestId: randomUUID(), expectedVersion: 1, operation: 'edit', text: 'after',
  });
  assert.equal(edited.input.runId, queued.runId);
  assert.equal(edited.input.mode, 'queue');
  assert.deepEqual(edited.input.input.context, { fixed: 'retained' });
});

test('restore validation rejects completed operations with missing results and inconsistent execution state', async (t) => {
  const f = await setup(t);
  const accepted = await f.accept(); await f.runtime.advance(accepted.runId);
  await core.validateAgentRuntime(f.storage);
  await f.storage.request({ requestId: 'bad-result', fingerprint: 'missing-completed-result' }, tx =>
    tx.query('UPDATE agent_steps SET result=NULL WHERE run_id=$1', [accepted.runId]));
  await assert.rejects(core.validateAgentRuntime(f.storage), { code: 'corrupt' });
});

test('source validation retains foreign references as facts but rejects missing bytes this owner staged', async (t) => {
  const f = await setup(t);
  await f.runtime.accept(f.identity, { requestId: randomUUID(), sessionId: f.sessionId, text: 'foreign', context: { resourceId: randomUUID() } });
  await core.validateAgentRuntime(f.storage);
  const resource = await f.storage.stageResource({ uploadId: randomUUID(), scope: 'agent-fixture', bytes: Buffer.from('owned'), mediaType: 'text/plain', contentVersion: 1 });
  await f.runtime.accept(f.identity, { requestId: randomUUID(), sessionId: f.sessionId, text: 'owned', context: { resourceId: resource.resourceId } });
  await core.validateAgentRuntime(f.storage);
  const removed = await f.storage.collect({ olderThan: new Date(Date.now() + 10_000), resourceIds: [resource.resourceId] });
  assert.deepEqual(removed, [resource.resourceId]);
  await assert.rejects(core.validateAgentRuntime(f.storage), { code: 'corrupt' });
});

test('maintenance tolerates storage fencing an in-flight settlement and resumes by querying its original effect', async (t) => {
  const entered = deferred(), release = deferred();
  let effects = 0, reads = 0;
  const f = await setup(t, pipeline({
    async dispatch() { effects += 1; entered.resolve(); await release.promise; return { state: 'completed', value: {} }; },
    async reconcile() { reads += 1; return { state: 'completed', value: {} }; },
  }), { execution: advance => createDirectExecution(advance) });
  const accepted = await f.accept();
  const participant = f.storage.participant();
  try {
    await entered.promise;
    f.runtime.closeWrites(); f.runtime.closeDispatch();
    await participant.closeWrites(); await participant.closeDispatch();
  } finally { release.resolve(); }
  await f.runtime.drain(); await participant.drain();
  assert.equal((await f.snapshot(accepted.runId)).steps[0].state, 'dispatching');
  await participant.resume(); await f.runtime.resume(); await f.runtime.drain();
  assert.equal((await f.snapshot(accepted.runId)).run.state, 'completed');
  assert.equal(effects, 1);
  assert.equal(reads, 1);
});

test('an expired run can still read and settle its original accepted operation without another dispatch', async (t) => {
  let clock = Date.now(), effects = 0, reads = 0;
  const f = await setup(t, pipeline({
    async dispatch() { effects += 1; return { state: 'accepted', value: {} }; },
    async reconcile() { reads += 1; return { state: 'completed', value: {} }; },
    async apply(snapshot, _step, result) { return { state: snapshot.state, complete: result.state === 'completed' }; },
  }), { now: () => clock, runBudget: { timeoutMs: 10 } });
  const accepted = await f.accept(); await f.runtime.advance(accepted.runId);
  clock += 11;
  await f.runtime.advance(accepted.runId);
  assert.equal((await f.snapshot(accepted.runId)).run.state, 'completed');
  assert.equal(effects, 1);
  assert.equal(reads, 1);
  await core.validateAgentRuntime(f.storage);
});

test('advance returns committed pending wait facts on creation and already-waiting entry, then clears them after stop', async (t) => {
  let plans = 0, dispatches = 0;
  const f = await setup(t, pipeline({
    async plan(snapshot, ids) { plans += 1; return pipeline().plan(snapshot, ids); },
    async dispatch() { dispatches += 1; return { state: 'completed', value: {} }; },
    async apply(snapshot) { return { state: snapshot.state,
      wait: { kind: 'workspace-execution', presentation: { commandId: 'original-command' }, deadline: null } }; },
  }));
  const accepted = await f.accept();
  const created = await f.runtime.advance(accepted.runId);
  const saved = await f.snapshot(accepted.runId);
  const expected = { session: saved.session, runId: accepted.runId, waits: saved.waits.filter(wait => wait.state === 'pending') };
  assert.equal(expected.waits.length, 1);
  assert.deepEqual(created.waits, expected, 'only committed wait facts are exposed to the host');
  const repeated = await f.runtime.advance(accepted.runId);
  assert.deepEqual(repeated.waits, expected, 'begin returning early for a pending wait must still expose it');
  assert.equal((await f.snapshot(accepted.runId)).run.generation, saved.run.generation);
  assert.equal(plans, 1);
  assert.equal(dispatches, 1);
  const queued = await f.accept('same-session successor', 'queue');
  const blocked = await f.runtime.advance(queued.runId);
  assert.deepEqual(blocked.waits, { session: saved.session, runId: queued.runId, waits: [] },
    'an empty observation must target this queued run rather than its waiting predecessor');
  assert.equal((await f.snapshot(accepted.runId)).waits[0].state, 'pending');
  await f.runtime.stop(f.identity, f.sessionId, accepted.runId, randomUUID());
  const stopped = await f.runtime.advance(accepted.runId);
  assert.deepEqual(stopped.waits, { session: saved.session, runId: accepted.runId, waits: [] });
  assert.equal(stopped.nextRunId, queued.runId);
  assert.equal(dispatches, 1);
});

test('advance withdraws consumed waits while preserving the queued successor handoff', async (t) => {
  const f = await setup(t, pipeline({
    async plan(snapshot, ids) {
      return snapshot.waits.some(wait => wait.state === 'consumed') ? { kind: 'complete' } : pipeline().plan(snapshot, ids);
    },
    async apply(snapshot) { return { state: snapshot.state,
      wait: { kind: 'workspace-execution', presentation: { commandId: 'original-command' }, deadline: null } }; },
  }));
  const accepted = await f.accept();
  const pending = await f.runtime.advance(accepted.runId);
  const original = pending.waits.waits[0];
  const queued = await f.accept('next run', 'queue');
  await f.runtime.resolveWait(f.identity, f.sessionId, { requestId: randomUUID(), waitId: original.waitId,
    expectedVersion: original.version, result: { commandId: 'original-command', completed: true } });
  const completed = await f.runtime.advance(accepted.runId);
  assert.deepEqual(completed.waits, { session: pending.waits.session, runId: accepted.runId, waits: [] });
  assert.equal(completed.nextRunId, queued.runId);
  assert.equal((await f.snapshot(accepted.runId)).waits[0].state, 'consumed');
});

test('advance never exposes an uncommitted wait proposed by a result that arrived after stop', async (t) => {
  const entered = deferred(), release = deferred();
  const f = await setup(t, pipeline({
    async dispatch() { entered.resolve(); await release.promise; return { state: 'completed', value: {} }; },
    async apply(snapshot) { return { state: snapshot.state,
      wait: { kind: 'workspace-execution', presentation: { commandId: 'late-command' }, deadline: null } }; },
  }));
  const accepted = await f.accept();
  const advancing = f.runtime.advance(accepted.runId);
  try {
    await entered.promise;
    await f.runtime.stop(f.identity, f.sessionId, accepted.runId, randomUUID());
  } finally { release.resolve(); }
  const result = await advancing;
  assert.equal(result.waits.runId, accepted.runId);
  assert.deepEqual(result.waits.waits, []);
  assert.deepEqual((await f.snapshot(accepted.runId)).waits, []);
});

test('an explicitly retained original operation authorizes its delayed continuation until its linked wait is resolved', async (t) => {
  const f = await setup(t, continuationPipeline());
  const accepted = await f.accept(); await f.runtime.advance(accepted.runId);
  const snapshot = await f.snapshot(accepted.runId), [original, ordinary] = snapshot.steps;
  const permit = { sessionId: f.sessionId, runId: accepted.runId, stepId: original.stepId,
    operationId: original.operation.operationId, generation: snapshot.run.generation };
  assert.equal(snapshot.run.state, 'waiting');
  assert.equal(original.state, 'completed');
  await f.runtime.assertDispatch(f.identity, permit);
  assert.equal(original.continuationOpen, true);
  assert.equal(ordinary.continuationOpen, false);
  await assert.rejects(f.runtime.assertDispatch(f.identity, { ...permit, stepId: ordinary.stepId, operationId: ordinary.operation.operationId }), { code: 'stale-generation' });
  const wait = snapshot.waits[0];
  assert.equal(wait.continuationOperationId, original.operation.operationId);
  await f.runtime.resolveWait(f.identity, f.sessionId, { requestId: randomUUID(), waitId: wait.waitId,
    expectedVersion: wait.version, result: { completed: true } });
  await assert.rejects(f.runtime.assertDispatch(f.identity, permit), { code: 'stale-generation' });
  assert.equal((await f.snapshot(accepted.runId)).steps[0].continuationOpen, false);
  await f.runtime.advance(accepted.runId);
  assert.equal((await f.snapshot(accepted.runId)).run.state, 'completed');
  await core.validateAgentRuntime(f.storage);
});

test('continuation restart uses the current generation and preserves automatic versus explicit policy', async t => {
  for (const policy of ['automatic', 'explicit']) await t.test(policy, async t => {
    const f = await setup(t, continuationPipeline());
    const sessionId = policy === 'explicit' ? f.sessionId : await f.session(policy);
    const accepted = await f.runtime.accept(f.identity, { sessionId, requestId: randomUUID(), text: 'continue original' });
    await f.runtime.advance(accepted.runId);
    const before = await f.runtime.snapshot(f.identity, sessionId, accepted.runId);
    await f.runtime.close(); const restarted = f.open();
    const current = await restarted.snapshot(f.identity, sessionId, accepted.runId), original = current.steps[0];
    const permit = { sessionId, runId: accepted.runId, stepId: original.stepId, operationId: original.operation.operationId,
      generation: current.run.generation };
    await assert.rejects(restarted.assertDispatch(f.identity, { ...permit, generation: before.run.generation }), { code: 'stale-generation' });
    if (policy === 'explicit') {
      await assert.rejects(restarted.assertDispatch(f.identity, permit), { code: 'stale-generation' });
      await restarted.continueRun(f.identity, sessionId, accepted.runId, randomUUID());
    }
    await restarted.assertDispatch(f.identity, permit);
    assert.equal((await restarted.snapshot(f.identity, sessionId, accepted.runId)).steps[0].continuationOpen, true);
  });
});

test('linked user response and stop revoke continuation without requiring a current permit to retain results', async t => {
  const f = await setup(t, continuationPipeline({ async validateResponse(_snapshot, _wait, answer) {
    if (answer.text !== 'ok') throw new Error('invalid answer');
  } }));
  const accepted = await f.accept(); await f.runtime.advance(accepted.runId);
  let snapshot = await f.snapshot(accepted.runId), original = snapshot.steps[0];
  const permit = { sessionId: f.sessionId, runId: accepted.runId, stepId: original.stepId, operationId: original.operation.operationId, generation: snapshot.run.generation };
  const response = { requestId: randomUUID(), waitId: snapshot.waits[0].waitId, expectedVersion: 1, answer: { text: 'bad' } };
  await assert.rejects(f.runtime.respond(f.identity, f.sessionId, response), /invalid answer/);
  await f.runtime.assertDispatch(f.identity, permit);
  await f.runtime.respond(f.identity, f.sessionId, { ...response, answer: { text: 'ok' } });
  await assert.rejects(f.runtime.assertDispatch(f.identity, permit), { code: 'stale-generation' });
  await f.runtime.advance(accepted.runId);
  const stopped = await f.accept('stop original'); await f.runtime.advance(stopped.runId);
  await f.runtime.stop(f.identity, f.sessionId, stopped.runId, randomUUID()); snapshot = await f.snapshot(stopped.runId); original = snapshot.steps[0];
  assert.equal(original.continuationOpen, false);
  assert.equal(snapshot.waits[0].state, 'cancelled');
  await assert.rejects(f.runtime.assertDispatch(f.identity, { sessionId: f.sessionId, runId: stopped.runId, stepId: original.stepId,
    operationId: original.operation.operationId, generation: snapshot.run.generation }), { code: 'stale-generation' });
  assert.equal(snapshot.steps[0].result.state, 'completed');
  await core.validateAgentRuntime(f.storage);
});
