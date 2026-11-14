import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentRuntime, agentRuntimeMigrations } from '../dist/index.js';
import { createDirectExecution } from '../../agents/src/execution/wire.ts';

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

function completePipeline(overrides = {}) {
  return {
    async plan(_snapshot, ids) {
      return { kind: 'operation', operation: { operationId: ids.operationId, kind: 'fixture', bindingId: 'fixture-v1', input: {} }, snapshot: {} };
    },
    async dispatch() { return { state: 'completed', value: {} }; },
    async reconcile() { return null; },
    async apply(snapshot) { return { state: snapshot.state, complete: true }; },
    ...overrides,
  };
}

async function setup(t, pipeline, options = {}) {
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: postgres.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
  const backend = createFileBackend({ id: 'agent', root: join(postgres.root, owner.serviceId) });
  const storage = await openStorage({ binding, migrations: agentRuntimeMigrations, backend });
  const identity = { kind: 'personal', name: '学生', environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID() };
  const runtimes = [];
  const open = () => {
    const runtime = createAgentRuntime(storage, { authorize: async () => {}, pipeline, ...options });
    runtimes.push(runtime);
    return runtime;
  };
  const runtime = open();
  t.after(async () => {
    try { for (const current of runtimes.reverse()) await current.close(); }
    finally { await storage.close(); }
  });
  const sessionId = randomUUID();
  await runtime.initialize({ sessionId, identity, scenario: 'fixture', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
  const accept = (text = '问题', mode = 'steering') => runtime.accept(identity, { sessionId, requestId: randomUUID(), text, mode });
  const snapshot = (runId, current = runtime) => current.snapshot(identity, sessionId, runId);
  return { runtime, identity, sessionId, accept, snapshot, open };
}

function questionPipeline(overrides = {}) {
  return completePipeline({
    async plan(snapshot, ids) {
      if (snapshot.waits.some(wait => wait.state === 'consumed')) return { kind: 'complete' };
      return completePipeline().plan(snapshot, ids);
    },
    async apply(snapshot) {
      return { state: snapshot.state, wait: { kind: 'user', presentation: { question: '选一个' }, deadline: null } };
    },
    ...overrides,
  });
}

test('session state is committed with settlement and retained by the next run', async (t) => {
  const retained = { segment: { binding: 'model-v1', history: ['question', 'answer'] }, selection: 'one' };
  const seen = [];
  const pipeline = completePipeline({
    async plan(snapshot, ids) {
      seen.push(snapshot.sessionState);
      return completePipeline().plan(snapshot, ids);
    },
    async apply(snapshot) {
      return { state: { finished: true }, sessionState: retained, complete: true,
        events: [{ kind: 'answer', body: { text: 'done' } }] };
    },
  });
  const f = await setup(t, pipeline);
  const first = await f.accept();
  assert.deepEqual((await f.snapshot(first.runId)).sessionState, {});
  await f.runtime.advance(first.runId);
  const settled = await f.snapshot(first.runId);
  assert.equal(settled.run.state, 'completed');
  assert.deepEqual(settled.sessionState, retained);
  const second = await f.accept('后续问题');
  assert.notEqual(second.runId, first.runId);
  assert.deepEqual((await f.snapshot(second.runId)).sessionState, retained);
  await f.runtime.advance(second.runId);
  assert.deepEqual(seen, [{}, retained]);
});

test('advancing a pending user wait leaves it waiting without renewing dispatch generation', async (t) => {
  let plans = 0;
  const pipeline = questionPipeline({
    async plan(snapshot, ids) { plans += 1; return questionPipeline().plan(snapshot, ids); },
  });
  const f = await setup(t, pipeline);
  const accepted = await f.accept();
  await f.runtime.advance(accepted.runId);
  const waiting = await f.snapshot(accepted.runId);
  assert.equal(waiting.run.state, 'waiting');
  await f.runtime.advance(accepted.runId);
  const stillWaiting = await f.snapshot(accepted.runId);
  assert.equal(stillWaiting.run.state, 'waiting');
  assert.equal(stillWaiting.run.generation, waiting.run.generation);
  assert.equal(plans, 1);
});

test('a response atomically consumes its original wait and identical retries bypass validation', async (t) => {
  let validations = 0;
  const f = await setup(t, questionPipeline({
    async validateResponse(_snapshot, wait, answer) {
      validations += 1;
      assert.equal(wait.state, 'pending');
      if (answer.choice !== 'yes') throw new Error('invalid choice');
    },
  }));
  const accepted = await f.accept();
  await f.runtime.advance(accepted.runId);
  const [wait] = (await f.snapshot(accepted.runId)).waits;
  const response = { requestId: randomUUID(), waitId: wait.waitId, expectedVersion: wait.version, answer: { choice: 'yes' } };
  const respond = (value) => f.runtime.respond(f.identity, f.sessionId, value);
  await assert.rejects(respond({ ...response, requestId: randomUUID(), answer: { choice: 'no' } }), /invalid choice/);
  assert.equal((await f.snapshot(accepted.runId)).waits[0].state, 'pending');
  const receipt = await respond(response);
  assert.deepEqual(await respond(response), receipt);
  const consumed = (await f.snapshot(accepted.runId)).waits[0];
  assert.equal(consumed.waitId, wait.waitId);
  assert.equal(consumed.state, 'consumed');
  assert.equal(consumed.version, wait.version + 1);
  assert.deepEqual(consumed.response, { choice: 'yes' });
  assert.equal(validations, 2, 'only the rejected answer and first successful request are validated');
  await assert.rejects(respond({ ...response, answer: { choice: 'no' } }), { code: 'identity-conflict' });
  await assert.rejects(respond({ ...response, requestId: randomUUID() }), { code: 'conflict' });
  const events = await f.runtime.events(f.identity, f.sessionId);
  assert.equal(events.filter(event => event.kind === 'wait-consumed').length, 1);
  await f.runtime.advance(accepted.runId);
  assert.equal((await f.snapshot(accepted.runId)).run.state, 'completed');
});

test('queued inputs become successor runs and start in order only after their predecessors finish', async (t) => {
  const dispatched = [];
  const f = await setup(t, completePipeline({
    async dispatch(snapshot) { dispatched.push(snapshot.inputs.map(input => input.input.text)); return { state: 'completed', value: {} }; },
  }));
  const first = await f.accept('first');
  const second = await f.accept('second', 'queue');
  const third = await f.accept('third', 'queue');
  assert.notEqual(second.runId, first.runId, 'queued input must not disappear inside the active run');
  assert.notEqual(third.runId, second.runId);
  assert.equal((await f.snapshot(second.runId)).run.previousRunId, first.runId);
  assert.equal((await f.snapshot(third.runId)).run.previousRunId, second.runId);
  await Promise.all([f.runtime.advance(second.runId), f.runtime.advance(third.runId)]);
  assert.deepEqual(dispatched, []);
  const firstResult = await f.runtime.advance(first.runId);
  assert.equal(firstResult.nextRunId, second.runId, 'handoff must identify the queued run for execution');
  assert.deepEqual(dispatched, [['first']], 'the driver leaves successor scheduling to execution');
  const secondResult = await f.runtime.advance(firstResult.nextRunId);
  assert.equal(secondResult.nextRunId, third.runId);
  await f.runtime.advance(secondResult.nextRunId);
  assert.deepEqual(dispatched, [['first'], ['second'], ['third']]);
  for (const receipt of [first, second, third]) assert.equal((await f.snapshot(receipt.runId)).run.state, 'completed');
});

test('identity authorization compares the fixed subject and ignores a changed display name', async (t) => {
  const f = await setup(t, completePipeline());
  const renamed = { ...f.identity, name: '新名字' };
  const receipt = await f.runtime.accept(renamed, { sessionId: f.sessionId, requestId: randomUUID(), text: '问题' });
  assert.equal((await f.runtime.run(renamed, f.sessionId, receipt.runId)).runId, receipt.runId);
  for (const field of ['environmentId', 'spaceId', 'principalId']) {
    await assert.rejects(f.runtime.events({ ...renamed, [field]: randomUUID() }, f.sessionId), { code: 'forbidden' });
  }
  await assert.rejects(f.runtime.events({ ...renamed, kind: 'school' }, f.sessionId), { code: 'forbidden' });
});

test('steering received during planning invalidates that revision before the first dispatch', async (t) => {
  const entered = deferred();
  const release = deferred();
  let plans = 0;
  const dispatched = [];
  const f = await setup(t, completePipeline({
    async plan(snapshot, ids) {
      const text = snapshot.inputs.at(-1).input.text;
      if (++plans === 1) { entered.resolve(); await release.promise; }
      const decision = await completePipeline().plan(snapshot, ids);
      decision.operation.input = { text };
      return decision;
    },
    async dispatch(_snapshot, step) { dispatched.push(step.operation.input.text); return { state: 'completed', value: {} }; },
  }));
  const first = await f.accept('old');
  const advancing = f.runtime.advance(first.runId);
  try {
    await entered.promise;
    const steering = await f.accept('new');
    assert.equal(steering.runId, first.runId);
  } finally { release.resolve(); await advancing; }
  assert.equal(plans, 2);
  assert.deepEqual(dispatched, ['new']);
  const events = await f.runtime.events(f.identity, f.sessionId);
  assert.equal(events.filter(event => event.kind === 'operation-prepared').length, 1);
});

test('unknown results after restart and continue query the original HTTP operation without resending it', async (t) => {
  const posts = [], gets = [];
  let readable = false;
  const upstream = createServer((request, response) => {
    if (request.method === 'POST') posts.push(request.url);
    else gets.push(request.url);
    response.writeHead(request.method === 'GET' && !readable ? 404 : 200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ text: 'original result' }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const f = await setup(t, completePipeline({
    async dispatch(_snapshot, step, _permit, assertDispatch) {
      await assertDispatch();
      await fetch(`${base}/${step.operation.operationId}`, { method: 'POST' });
      throw new Error('response lost after owner committed');
    },
    async reconcile(_snapshot, step) {
      const response = await fetch(`${base}/${step.operation.operationId}`);
      return response.ok ? { state: 'completed', value: await response.json() } : null;
    },
  }));
  const accepted = await f.accept();
  await f.runtime.advance(accepted.runId);
  const original = await f.snapshot(accepted.runId);
  assert.equal(original.steps[0].state, 'unknown');
  assert.equal(original.run.needsContinue, true);
  await f.runtime.close();
  const restarted = f.open();
  const queriedBefore = gets.length;
  await restarted.advance(accepted.runId);
  assert.equal(gets.length, queriedBefore + 1, 'explicit continuation gates new effects, not original result reads');
  assert.equal((await f.snapshot(accepted.runId, restarted)).run.needsContinue, true);
  readable = true;
  await restarted.continueRun(f.identity, f.sessionId, accepted.runId, randomUUID());
  await restarted.advance(accepted.runId);
  assert.equal((await f.snapshot(accepted.runId, restarted)).run.state, 'completed');
  assert.deepEqual(posts, [`/${original.steps[0].operation.operationId}`]);
  assert.ok(gets.every(url => url === posts[0]));
});

test('stop cancels pending waits atomically and a late answer cannot revive the run', async (t) => {
  const f = await setup(t, questionPipeline());
  const accepted = await f.accept();
  await f.runtime.advance(accepted.runId);
  const wait = (await f.snapshot(accepted.runId)).waits[0];
  const requestId = randomUUID();
  await f.runtime.stop(f.identity, f.sessionId, accepted.runId, requestId);
  await f.runtime.stop(f.identity, f.sessionId, accepted.runId, requestId);
  const stopped = await f.snapshot(accepted.runId);
  assert.equal(stopped.run.state, 'stopped');
  assert.equal(stopped.waits[0].state, 'cancelled');
  assert.equal(stopped.waits[0].version, wait.version + 1);
  await assert.rejects(f.runtime.respond(f.identity, f.sessionId, {
    requestId: randomUUID(), waitId: wait.waitId, expectedVersion: wait.version, answer: { choice: 'yes' },
  }), { code: 'conflict' });
  await f.runtime.advance(accepted.runId);
  assert.equal((await f.snapshot(accepted.runId)).run.state, 'stopped');
  const events = await f.runtime.events(f.identity, f.sessionId);
  assert.equal(events.filter(event => event.kind === 'run-stopped').length, 1);
});

test('stop revokes an issued permit before cancellation and blocks the physical effect', async (t) => {
  const entered = deferred(), release = deferred();
  let permit, physical = 0;
  const cancelled = [];
  const f = await setup(t, completePipeline({
    async dispatch(_snapshot, _step, issued, assertDispatch) {
      permit = issued;
      entered.resolve();
      await release.promise;
      await assertDispatch();
      physical += 1;
      return { state: 'completed', value: {} };
    },
    async cancel(snapshot, step) {
      assert.equal(snapshot.run.state, 'stopped');
      await assert.rejects(f.runtime.assertDispatch(f.identity, permit), { code: 'stale-generation' });
      cancelled.push(step.operation.operationId);
    },
  }));
  const accepted = await f.accept();
  const advancing = f.runtime.advance(accepted.runId);
  try {
    await entered.promise;
    await f.runtime.stop(f.identity, f.sessionId, accepted.runId, randomUUID());
    await assert.rejects(f.runtime.assertDispatch(f.identity, permit), { code: 'stale-generation' });
    assert.deepEqual(cancelled, [permit.operationId]);
  } finally { release.resolve(); await advancing; }
  assert.equal(physical, 0);
});

test('explicit restart permits reconciliation but gates planning and new dispatch until continue', async (t) => {
  let plans = 0;
  const dispatched = [], reconciled = [];
  const f = await setup(t, completePipeline({
    async plan(snapshot, ids) { plans += 1; return completePipeline().plan(snapshot, ids); },
    async dispatch(_snapshot, step) {
      dispatched.push(step.operation.operationId);
      return { state: dispatched.length === 1 ? 'accepted' : 'completed', value: {} };
    },
    async reconcile(_snapshot, step) { reconciled.push(step.operation.operationId); return { state: 'completed', value: {} }; },
    async apply(snapshot, _step, result) {
      if (result.state === 'accepted') return { state: snapshot.state };
      return snapshot.state.firstDone ? { state: { done: true }, complete: true }
        : { state: { firstDone: true }, sessionState: { history: ['original-result'] } };
    },
  }));
  const accepted = await f.accept();
  await f.runtime.advance(accepted.runId);
  await f.runtime.close();
  const restarted = f.open();
  await restarted.advance(accepted.runId);
  const recovered = await f.snapshot(accepted.runId, restarted);
  assert.equal(recovered.steps[0].state, 'completed');
  assert.equal(recovered.run.needsContinue, true);
  assert.deepEqual(recovered.sessionState, { history: ['original-result'] });
  assert.deepEqual(reconciled, [dispatched[0]]);
  assert.equal(plans, 1);
  assert.equal(dispatched.length, 1);
  await restarted.continueRun(f.identity, f.sessionId, accepted.runId, randomUUID());
  await restarted.advance(accepted.runId);
  assert.equal(plans, 2);
  assert.equal(dispatched.length, 2);
  assert.notEqual(dispatched[0], dispatched[1]);
  assert.equal((await f.snapshot(accepted.runId, restarted)).run.state, 'completed');
});

test('a failed settlement rolls back session state, run state, result and events together', async (t) => {
  const f = await setup(t, completePipeline({
    async apply() {
      return { state: { changed: true }, sessionState: { history: ['uncommitted'] },
        events: [{ kind: 'answer', body: { text: 'uncommitted' } }],
        wait: { kind: 'user', presentation: {}, deadline: 'invalid-timestamp' } };
    },
  }));
  const accepted = await f.accept();
  await assert.rejects(f.runtime.advance(accepted.runId));
  const snapshot = await f.snapshot(accepted.runId);
  assert.deepEqual(snapshot.sessionState, {});
  assert.deepEqual(snapshot.state, {});
  assert.equal(snapshot.steps[0].result, null);
  assert.equal(snapshot.waits.length, 0);
  const events = await f.runtime.events(f.identity, f.sessionId);
  assert.equal(events.filter(event => ['answer', 'operation-result', 'wait-opened'].includes(event.kind)).length, 0);
});

test('a result arriving after stop is retained without applying state, events or another wait', async (t) => {
  const entered = deferred(), release = deferred();
  const f = await setup(t, completePipeline({
    async dispatch() { entered.resolve(); await release.promise; return { state: 'completed', value: { original: true } }; },
    async apply() {
      return { state: { late: true }, sessionState: { history: ['late'] },
        events: [{ kind: 'answer', body: { text: 'late' } }],
        wait: { kind: 'user', presentation: {}, deadline: null } };
    },
  }));
  const accepted = await f.accept();
  const advancing = f.runtime.advance(accepted.runId);
  try {
    await entered.promise;
    await f.runtime.stop(f.identity, f.sessionId, accepted.runId, randomUUID());
  } finally { release.resolve(); await advancing; }
  const stopped = await f.snapshot(accepted.runId);
  assert.equal(stopped.run.state, 'stopped');
  assert.deepEqual(stopped.steps[0].result, { state: 'completed', value: { original: true } });
  assert.deepEqual(stopped.state, {});
  assert.deepEqual(stopped.sessionState, {});
  assert.deepEqual(stopped.waits, []);
  assert.equal((await f.runtime.events(f.identity, f.sessionId)).filter(event => event.kind === 'answer').length, 0);
});

test('only Node wait resolution can record an external result and it preserves explicit restart gating', async (t) => {
  const f = await setup(t, questionPipeline({
    async apply(snapshot) { return { state: snapshot.state, wait: { kind: 'experiment', presentation: {}, deadline: null } }; },
    async validateResponse(_snapshot, wait) {
      if (wait.kind !== 'user') throw new Error('only user questions accept browser answers');
    },
  }));
  const accepted = await f.accept();
  await f.runtime.advance(accepted.runId);
  const wait = (await f.snapshot(accepted.runId)).waits[0];
  const requestId = randomUUID();
  const result = { requestId, waitId: wait.waitId, expectedVersion: wait.version, result: { command: 'original', completed: true } };
  await assert.rejects(f.runtime.respond(f.identity, f.sessionId, {
    requestId, waitId: wait.waitId, expectedVersion: wait.version, answer: result.result,
  }), /only user questions/);
  await f.runtime.close();
  const restarted = f.open();
  const receipt = await restarted.resolveWait(f.identity, f.sessionId, result);
  assert.deepEqual(await restarted.resolveWait(f.identity, f.sessionId, result), receipt);
  await assert.rejects(restarted.resolveWait(f.identity, f.sessionId, { ...result, result: { forged: true } }), { code: 'identity-conflict' });
  const resolved = await f.snapshot(accepted.runId, restarted);
  assert.equal(resolved.waits[0].state, 'consumed');
  assert.deepEqual(resolved.waits[0].response, result.result);
  assert.equal(resolved.run.needsContinue, true, 'an external notification cannot authorize new dispatch');
  await restarted.advance(accepted.runId);
  assert.notEqual((await f.snapshot(accepted.runId, restarted)).run.state, 'completed');
  await restarted.continueRun(f.identity, f.sessionId, accepted.runId, randomUUID());
  await restarted.advance(accepted.runId);
  assert.equal((await f.snapshot(accepted.runId, restarted)).run.state, 'completed');
  assert.equal((await restarted.events(f.identity, f.sessionId)).filter(event => event.kind === 'wait-resolved').length, 1);
});

test('actual execution wiring retries only the accepted original operation on its explicit timer', async (t) => {
  const timers = manualTimers();
  const dispatched = [], reconciled = [];
  const f = await setup(t, completePipeline({
    async dispatch(_snapshot, step) { dispatched.push(step.operation.operationId); return { state: 'accepted', value: {}, retryAfterMs: 10 }; },
    async reconcile(_snapshot, step) { reconciled.push(step.operation.operationId); return { state: 'completed', value: {} }; },
    async apply(snapshot, _step, result) { return { state: snapshot.state, complete: result.state === 'completed' }; },
  }), { execution: advance => createDirectExecution(advance, { timers }) });
  const accepted = await f.accept();
  await f.runtime.drain();
  assert.equal((await f.snapshot(accepted.runId)).run.state, 'waiting');
  assert.equal(timers.scheduled.length, 1);
  assert.equal(timers.scheduled[0].delayMs, 10);
  assert.equal(reconciled.length, 0);
  timers.scheduled[0].callback();
  await f.runtime.drain();
  assert.equal((await f.snapshot(accepted.runId)).run.state, 'completed');
  assert.equal(dispatched.length, 1);
  assert.deepEqual(reconciled, dispatched);
  assert.ok(timers.scheduled.every(timer => timer.cleared));
});

test('actual execution wiring starts a queued successor and retains that successor retry timer', async (t) => {
  const timers = manualTimers(), entered = deferred(), release = deferred();
  const dispatched = [], planned = [];
  const f = await setup(t, completePipeline({
    async plan(snapshot, ids) { planned.push([snapshot.inputs[0].input.text, snapshot.sessionState]); return completePipeline().plan(snapshot, ids); },
    async dispatch(snapshot) {
      const text = snapshot.inputs[0].input.text;
      dispatched.push(text);
      if (text === 'first') { entered.resolve(); await release.promise; return { state: 'completed', value: {} }; }
      return { state: 'accepted', value: {}, retryAfterMs: 10 };
    },
    async reconcile() { return { state: 'completed', value: {} }; },
    async apply(snapshot, _step, result) {
      return result.state === 'accepted' ? { state: snapshot.state }
        : { state: snapshot.state, sessionState: { last: snapshot.inputs[0].input.text }, complete: true };
    },
  }), { execution: advance => createDirectExecution(advance, { timers }) });
  const first = await f.accept('first');
  let second;
  try {
    await entered.promise;
    second = await f.accept('second', 'queue');
    await f.runtime.advance(second.runId);
    assert.deepEqual(dispatched, ['first']);
    assert.equal((await f.snapshot(second.runId)).run.state, 'received');
  } finally { release.resolve(); await f.runtime.drain(); }
  assert.equal((await f.snapshot(first.runId)).run.state, 'completed');
  assert.equal((await f.snapshot(second.runId)).run.state, 'waiting');
  assert.deepEqual(planned, [['first', {}], ['second', { last: 'first' }]]);
  assert.equal(timers.scheduled.length, 1);
  timers.scheduled[0].callback();
  await f.runtime.drain();
  assert.equal((await f.snapshot(second.runId)).run.state, 'completed');
  assert.deepEqual(dispatched, ['first', 'second']);
});

test('actual execution wiring cancels obsolete retry timers on stop and never polls user waits', async (t) => {
  const timers = manualTimers();
  let reconciles = 0;
  const f = await setup(t, completePipeline({
    async dispatch() { return { state: 'accepted', value: {}, retryAfterMs: 10 }; },
    async reconcile() { reconciles += 1; return null; },
    async apply(snapshot) { return { state: snapshot.state }; },
  }), { execution: advance => createDirectExecution(advance, { timers }) });
  const accepted = await f.accept();
  await f.runtime.drain();
  const obsolete = timers.scheduled[0];
  await f.runtime.stop(f.identity, f.sessionId, accepted.runId, randomUUID());
  await f.runtime.drain();
  assert.equal(obsolete.cleared, true);
  obsolete.callback();
  await f.runtime.drain();
  assert.equal(reconciles, 0);
  assert.equal((await f.snapshot(accepted.runId)).run.state, 'stopped');
  const userTimers = manualTimers();
  const user = await setup(t, questionPipeline(), { execution: advance => createDirectExecution(advance, { timers: userTimers }) });
  const waiting = await user.accept();
  await user.runtime.drain();
  assert.equal((await user.snapshot(waiting.runId)).run.state, 'waiting');
  assert.deepEqual(userTimers.scheduled, []);
  user.runtime.closeDispatch();
  await user.runtime.drain();
  assert.deepEqual(userTimers.scheduled, []);
});

test('identical not-dispatched admissions can retry the same operation until one physical dispatch succeeds', async (t) => {
  const timers = manualTimers();
  const admitted = [];
  let physical = 0, reconciles = 0;
  const f = await setup(t, completePipeline({
    async dispatch(_snapshot, step) {
      admitted.push(step.operation.operationId);
      if (admitted.length < 3) return { state: 'not-dispatched', value: { reason: 'capacity' }, retryAfterMs: 10 };
      physical += 1;
      return { state: 'completed', value: {} };
    },
    async reconcile() { reconciles += 1; return null; },
    async apply(snapshot, _step, result) { return { state: snapshot.state, complete: result.state === 'completed' }; },
  }), { execution: advance => createDirectExecution(advance, { timers }) });
  const accepted = await f.accept();
  await f.runtime.drain();
  timers.scheduled[0].callback();
  await f.runtime.drain();
  assert.equal((await f.snapshot(accepted.runId)).steps[0].state, 'prepared');
  timers.scheduled[1].callback();
  await f.runtime.drain();
  assert.equal((await f.snapshot(accepted.runId)).run.state, 'completed');
  assert.equal(admitted.length, 3);
  assert.equal(new Set(admitted).size, 1);
  assert.equal(physical, 1);
  assert.equal(reconciles, 0, 'known not-started operations must not become unknown due to result deduplication');
});
