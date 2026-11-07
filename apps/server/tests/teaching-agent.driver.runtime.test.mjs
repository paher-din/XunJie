import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { StorageError } from '@xunjie/storage';
import { fixture, reply, until } from './support/teaching-input-control.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('two drivers racing on one run keep one effective dispatch through generation fencing', { timeout: 180000 }, async () => {
  let releaseReceive;
  const receiveGate = new Promise(resolve => { releaseReceive = resolve; });
  const f = await fixture((_payload, response) => reply(response, { text: '单一回答' }));
  try {
    const activity = await f.activity('单一推进权'), c = await f.controlled(activity);
    const receivedIds = [], dispatched = [], cancelled = [];
    const models = { ...c.models, checks: { ...c.models.checks,
      async receive(who, input) {
        const fact = await c.models.checks.receive(who, input);
        assert.equal(fact.state, 'accepted');
        receivedIds.push(fact.attemptId);
        // The real Gateway has durably received the request; only reply delivery is delayed.
        await receiveGate;
        return fact;
      },
      async dispatch(who, attemptId) {
        dispatched.push(attemptId);
        return c.models.checks.dispatch(who, attemptId);
      },
      async cancel(who, attemptId) {
        cancelled.push(attemptId);
        return c.models.checks.cancel(who, attemptId);
      },
    } };
    const leaseMs = 1000;
    const first = c.makeAgent({ models, driverId: 'driver-a', leaseMs });
    const second = c.makeAgent({ models, driverId: 'driver-b', leaseMs });
    const accepted = await c.send('哪一个推进者会真正外发？', undefined, [], first);
    assert.equal(accepted.receipt.state, 'accepted');
    first.resume();
    await until(() => receivedIds.length === 1, 'The first driver receives the original attempt at the real Gateway.');
    // The original owner renews for longer than one lease while its receive RPC is delayed.
    await delay(leaseMs + 200);
    second.resume();
    await delay(200);
    assert.equal(receivedIds.length, 1, 'a live driver keeps its lease during a slow owner RPC');
    assert.equal(f.payloads.length, 0);
    first.closeDispatch();
    await until(() => receivedIds.length === 2, 'The second driver takes over after the original lease expires.');
    assert.equal(new Set(receivedIds).size, 1, 'both generations receive the same durable planned attempt');
    // This public permit proves the successor really owns generation 2 while both replies are delayed.
    await second.assertModelDispatch(c.identity, activity.activityId, { runId: accepted.runId, activityId: activity.activityId,
      driverId: 'driver-b', generation: 2, attemptId: receivedIds[0], dispatch: false });
    assert.equal((await c.models.checks.read(c.identity, receivedIds[0])).state, 'accepted');
    releaseReceive();
    const completed = await until(async () => {
      const value = await second.run(c.identity, activity.activityId, accepted.runId);
      return value.state === 'completed' ? value : null;
    }, 'The successor completes the original attempt.');
    await first.drain();
    assert.equal(completed.attemptId, receivedIds[0]);
    assert.deepEqual(dispatched, [receivedIds[0]], 'only one driver dispatches the prepared attempt');
    assert.equal(cancelled.length, 0, 'losing authority cannot cancel the shared original attempt');
    assert.equal(f.payloads.length, 1, 'generation fencing allows one actual upstream request');
    assert.deepEqual(completed.usage, { state: 'final', inputTokens: 20, outputTokens: 10, totalTokens: 30 });
    const events = await second.events(c.identity, activity.activityId);
    assert.equal(events.filter(event => event.kind === 'attempt-dispatched').length, 1);
    assert.equal(events.filter(event => event.kind === 'assistant').length, 1);
    assert.equal(events.filter(event => event.kind === 'run-completed').length, 1);
  } finally { releaseReceive(); await f.close(); }
});

test('the same driver reconciles a lost model acceptance reply without a second attempt or dispatch', { timeout: 180000 }, async () => {
  const f = await fixture((_payload, response) => reply(response, { text: '原请求已完成' }));
  try {
    const activity = await f.activity('查询原接收'), c = await f.controlled(activity);
    const received = [], dispatched = [], receipts = [];
    const models = { ...c.models, checks: { ...c.models.checks,
      async receive(who, input) {
        const fact = await c.models.checks.receive(who, input);
        received.push(fact.attemptId); receipts.push(fact);
        if (received.length === 1) throw new StorageError('unavailable'); // owner committed; only its response was lost
        return fact;
      },
      async dispatch(who, attemptId) {
        dispatched.push(attemptId);
        return c.models.checks.dispatch(who, attemptId);
      },
    } };
    const agent = c.makeAgent({ models, driverId: 'same-live-process', leaseMs: 500 });
    agent.resume();
    const accepted = await c.send('原回包丢失后继续', undefined, [], agent);
    const completed = await until(async () => {
      const value = await agent.run(c.identity, activity.activityId, accepted.runId);
      return value.state === 'completed' ? value : null;
    }, 'The same live driver reconciles the original accepted request.');
    assert.equal(received.length, 2); assert.equal(new Set(received).size, 1);
    assert.equal(completed.attemptId, received[0]);
    assert.deepEqual(receipts[1], receipts[0], 'the retry receives the same real durable acceptance');
    assert.deepEqual(dispatched, [received[0]]);
    const native = await c.models.checks.read(c.identity, received[0]);
    assert.equal(native.state, 'completed'); assert.equal(native.physicalRequestEnded, true);
    assert.equal(native.requestRef, receipts[0].requestRef, 'recovery retains the actual original model request');
    assert.equal(f.payloads.length, 1, 'a lost acceptance reply never creates another physical request');
    const events = await agent.events(c.identity, activity.activityId);
    assert.equal(events.filter(event => event.kind === 'context-assembled').length, 1);
    assert.equal(events.filter(event => event.kind === 'attempt-dispatched').length, 1);
    assert.equal(events.filter(event => event.kind === 'assistant').length, 1);
    assert.equal(events.filter(event => event.kind === 'run-completed').length, 1);
  } finally { await f.close(); }
});

test('stop committed while a remote model permit waits for its transaction prevents the permit', { timeout: 180000 }, async () => {
  let releaseReceive, releasePermit;
  const receiveGate = new Promise(resolve => { releaseReceive = resolve; });
  const permitGate = new Promise(resolve => { releasePermit = resolve; });
  const f = await fixture();
  try {
    const activity = await f.activity('原请求停止'), c = await f.controlled(activity);
    let receivedAttempt, permitEntered = false;
    const dispatched = [];
    // Delay the existing storage boundary, before its transaction starts, so stop can
    // commit after the permit's optimistic checks and before its authoritative recheck.
    const guarded = { ...c.storage, async request(input, effect) {
      if (input.requestId.startsWith('teaching-verify-permit:')) { permitEntered = true; await permitGate; }
      return c.storage.request(input, effect);
    } };
    const models = { ...c.models, checks: { ...c.models.checks,
      async receive(who, input) {
        const fact = await c.models.checks.receive(who, input);
        receivedAttempt = fact.attemptId;
        await receiveGate;
        return fact;
      },
      async dispatch(who, attemptId) {
        dispatched.push(attemptId);
        return c.models.checks.dispatch(who, attemptId);
      },
    } };
    const agent = c.makeAgent({ models, driverId: 'permit-driver', leaseMs: 5000 }, guarded);
    const accepted = await c.send('停止原请求', undefined, [], agent);
    await until(() => receivedAttempt, 'The real model owner accepts the original attempt without dispatch.');
    assert.equal((await c.models.checks.read(c.identity, receivedAttempt)).state, 'accepted');
    const permit = agent.assertModelDispatch(c.identity, activity.activityId, { runId: accepted.runId, activityId: activity.activityId,
      driverId: 'permit-driver', generation: 1, attemptId: receivedAttempt, dispatch: false });
    const denied = assert.rejects(permit, { code: 'forbidden' });
    await until(() => permitEntered, 'The original permit reaches the delayed transaction boundary.');
    await agent.stop(c.identity, activity.activityId, accepted.runId, { requestId: randomUUID() });
    assert.equal((await agent.run(c.identity, activity.activityId, accepted.runId)).stopRequested, true);
    releasePermit(); await denied;
    releaseReceive();
    const stopped = await until(async () => {
      const value = await agent.run(c.identity, activity.activityId, accepted.runId); return value.state === 'stopped' ? value : null;
    }, 'The original accepted attempt stops without any physical request.');
    assert.equal(stopped.attemptId, receivedAttempt);
    const native = await c.models.checks.read(c.identity, receivedAttempt);
    assert.equal(native.state, 'cancelled'); assert.equal(native.dispatched, false);
    assert.equal(dispatched.length, 0); assert.equal(f.payloads.length, 0);
    const events = await agent.events(c.identity, activity.activityId);
    assert.equal(events.filter(event => event.kind === 'attempt-dispatched').length, 0);
    assert.equal(events.filter(event => event.kind === 'assistant').length, 0);
    assert.equal(events.filter(event => event.kind === 'run-stopped').length, 1);
  } finally { releasePermit(); releaseReceive(); await f.close(); }
});
