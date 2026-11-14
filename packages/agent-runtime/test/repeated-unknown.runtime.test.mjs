import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { createAgentRuntime, agentRuntimeMigrations } from '../dist/index.js';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';

for (const pauseReason of [undefined, 'original-owner-unconfirmed']) {
  test('repeated unknown after explicit continue pauses the same operation without dispatching again: ' + (pauseReason ?? 'default reason'), { timeout: 60000 }, async t => {
    const pg = await nativeFixture();
    let storage, runtime, confirmed = false, plans = 0;
    const dispatches = [], reads = [], originals = new Map();
    const server = createServer((request, response) => {
      const attemptId = request.url.slice(1);
      if (request.method === 'POST') {
        assert.ok(!originals.has(attemptId), 'The original owner must never receive a replacement dispatch');
        dispatches.push(attemptId); originals.set(attemptId, { attemptId });
      } else { assert.equal(request.method, 'GET'); assert.ok(originals.has(attemptId)); reads.push(attemptId); }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ state: confirmed ? 'completed' : 'unknown', value: originals.get(attemptId) }));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => { try { await runtime?.close(); await storage?.close(); } finally {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await pg.close();
    } });
    const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
    const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
    storage = await openStorage({ binding, migrations: agentRuntimeMigrations,
      backend: createFileBackend({ id: 'original-effects', root: pg.root + '/objects' }) });
    const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
    const sessionId = randomUUID(), endpoint = `http://127.0.0.1:${server.address().port}`;
    const pipeline = {
      async plan(_snapshot, ids) { plans++; return { kind: 'operation', operation: { operationId: ids.operationId,
        kind: 'original-http-effect', bindingId: 'fixed-owner-v1', input: {} }, snapshot: {} }; },
      async dispatch(_snapshot, step, _permit, assertDispatch) {
        await assertDispatch(); return (await fetch(endpoint + '/' + step.operation.operationId, { method: 'POST' })).json();
      },
      async reconcile(_snapshot, step) { return (await fetch(endpoint + '/' + step.operation.operationId)).json(); },
      async apply(snapshot, _step, result) { return result.state === 'unknown'
        ? { state: snapshot.state, ...(pauseReason ? { pause: pauseReason } : {}) }
        : { state: snapshot.state, complete: true, events: [{ kind: 'original-completed', body: result.value }] }; },
    };
    const open = () => createAgentRuntime(storage, { authorize: async () => {}, pipeline });
    runtime = open();
    await runtime.initialize({ sessionId, identity, scenario: 'fixture', restartPolicy: 'explicit', createdAt: new Date().toISOString() });
    const received = await runtime.accept(identity, { requestId: randomUUID(), sessionId, text: '保留原操作，等待原 owner 核实' });
    const snapshot = () => runtime.snapshot(identity, sessionId, received.runId);
    await runtime.advance(received.runId);
    const initial = await snapshot(), original = initial.steps[0];
    function assertPaused(value) {
      assert.equal(value.run.state, 'paused'); assert.equal(value.run.needsContinue, true);
      assert.equal(value.run.reason, pauseReason ?? 'result-unknown');
      assert.equal(value.run.runId, received.runId); assert.equal(value.steps.length, 1);
      assert.equal(value.steps[0].stepId, original.stepId);
      assert.equal(value.steps[0].operation.operationId, original.operation.operationId);
      assert.deepEqual(value.steps[0].result, original.result); assert.equal(value.steps[0].state, 'unknown');
      assert.equal(value.budget.dispatches, 1); assert.equal(dispatches.length, 1); assert.equal(plans, 1);
    }
    assertPaused(initial);
    for (let attempt = 0; attempt < 2; attempt++) {
      await runtime.continueRun(identity, sessionId, received.runId, randomUUID());
      await runtime.advance(received.runId); assertPaused(await snapshot());
    }
    await runtime.close(); runtime = open();
    await runtime.continueRun(identity, sessionId, received.runId, randomUUID());
    await runtime.advance(received.runId); assertPaused(await snapshot());
    let events = await runtime.events(identity, sessionId);
    assert.equal(events.filter(event => event.kind === 'operation-result').length, 1, 'Repeated unknown does not republish the same result');
    assert.ok(reads.length >= 3); assert.ok(reads.every(id => id === original.operation.operationId));
    confirmed = true;
    await runtime.continueRun(identity, sessionId, received.runId, randomUUID()); await runtime.advance(received.runId);
    const completed = await snapshot();
    assert.equal(completed.run.state, 'completed'); assert.equal(completed.run.needsContinue, false);
    assert.equal(completed.steps.length, 1); assert.equal(completed.steps[0].operation.operationId, original.operation.operationId);
    assert.equal(completed.steps[0].result.value.attemptId, original.operation.operationId);
    assert.equal(completed.budget.dispatches, 1); assert.equal(dispatches.length, 1); assert.equal(plans, 1);
    events = await runtime.events(identity, sessionId);
    assert.equal(events.filter(event => event.kind === 'operation-result').length, 2);
    assert.equal(events.filter(event => event.kind === 'original-completed').length, 1);
  });
}
