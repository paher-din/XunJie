// PR #222 review fault schedules, using real OwnedStorage/PostgreSQL.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { reviewStorage, source, digest, defer, waitFor } from './support/review-native-storage.mjs';
const { createTeachingAgent, teachingAgentMigrations } = await source('packages/learning-space/dist/teaching-agent/index.js');
const { createChecks } = await source('packages/learning-space/dist/model-connections/checks.js');
const { modelMigrations } = await source('packages/learning-space/dist/model-connections/index.js');
const { teachingAgentReceiverId } = await source('packages/contracts/dist/teaching-agent.js');

function actor(storage) {
  const identity = { ...storage.owner, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: 'Review fixture' };
  delete identity.serviceId;
  const activity = { activityId: randomUUID(), identity, goal: 'Review', question: '', references: [], status: 'open', createdAt: new Date().toISOString() };
  return { identity, activity };
}
function inputFor(storage, identity, activity, question = 'Explain this') {
  return { requestId: randomUUID(), scope: { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId: activity.activityId },
    receiver: { receiverId: teachingAgentReceiverId(storage.owner.serviceId), location: 'remote', kind: 'question' },
    draft: { token: randomUUID(), question, references: [], bases: [] }, works: [], evidence: [] };
}

function simpleModels() {
  const requests = [], segments = new Map(), attempts = new Map();
  let enabled = true, version = 1;
  let connection = { connectionId: randomUUID(), version: 1, protocol: 'chat-completions', modelId: 'review-fixture', contextWindow: 16384, maxOutputTokens: 1024 };
  const choice = () => ({ choice: { connection }, source: { kind: 'personal', feeSource: 'review-self' } });
  const models = {
    selection: { read: async () => ({ version, selected: enabled ? connection : null }), snapshot: async () => choice(), pin: async () => choice(), pinned: async () => choice() },
    segments: {
      create: async (_identity, input) => { segments.set(input.segmentId, { ...input, closed: false, pending: false, pendingTools: [], sequence: 0 }); },
      read: async (_identity, id) => segments.get(id),
      close: async (_identity, id) => { segments.get(id).closed = true; },
      settle: async (_identity, id) => { segments.get(id).sequence++; },
    },
    checks: {
      receive: async (_identity, input) => { requests.push(structuredClone(input)); attempts.set(input.attemptId, { attemptId: input.attemptId, state: 'accepted', physicalRequestEnded: true, text: '', usage: { state: 'unknown' }, reason: '', segmentId: input.segmentId }); },
      requestPayload: async (_identity, id) => ({ model: connection.modelId, messages: [{ role: 'user', content: requests.find(r => r.attemptId === id).input.text }] }),
      dispatch: async (_identity, id) => { const fact = { ...attempts.get(id), state: 'completed', resultRef: randomUUID(), text: 'A concise answer without reproducing source content.', usage: { state: 'final', inputTokens: 1, outputTokens: 1, totalTokens: 2 } }; attempts.set(id, fact); segments.get(fact.segmentId).sequence++; return fact; },
      read: async (_identity, id) => attempts.get(id), progress: async () => null, cancel: async () => {},
    }, results: { retain: async () => {} },
  };
  return { models, requests, segments, disable: () => { enabled = false; }, enable: () => { enabled = true; },
    switch: () => { version++; connection = { ...connection, connectionId: randomUUID(), modelId: 'switched-fixture', protocol: 'responses' }; return version; } };
}

test('R1 cancellation racing acceptance returns the committed receiver receipt', async t => {
  const { storage, hooks } = await reviewStorage(teachingAgentMigrations);
  const { identity, activity } = actor(storage);
  const agent = createTeachingAgent(storage, { authorize: async () => {}, identityFor: async () => identity,
    activity: async () => activity, models: {}, start: false });
  agent.closeDispatch();
  t.after(async () => { agent.close(); await storage.close(); });
  const input = inputFor(storage, identity, activity), inputDigest = digest(input);
  const readReached = defer(), releaseRead = defer();
  let blocked = false;
  hooks.afterRead = async (sql, values, result) => {
    if (!blocked && sql === 'SELECT * FROM teaching_requests WHERE request_id=$1' && values[0] === input.requestId && result.rows.length === 0) {
      blocked = true; readReached.resolve(); await releaseRead.promise;
    }
  };
  const cancelling = agent.cancel(input.requestId, inputDigest);
  await readReached.promise;
  const accepted = await agent.accept(input, inputDigest);
  assert.equal(accepted.state, 'accepted');
  releaseRead.resolve();
  const cancellation = await cancelling;
  const persisted = await agent.query(input.requestId, inputDigest);
  const run = await agent.run(identity, activity.activityId, JSON.parse(accepted.detail).runId);
  console.log('R1 evidence', JSON.stringify({ cancellation: cancellation.state, persisted: persisted.state, run: run.state, stopRequested: run.stopRequested }));
  assert.equal(cancellation.state, persisted.state, 'the cancel response cannot claim a tombstone when acceptance already won');
  assert.equal(run.stopRequested, true, 'an accepted Run still receives the stop request');
  assert.equal((await agent.cancel(input.requestId, inputDigest)).state, 'accepted');
});

test('R2 complete text accompanying tool calls is retained in the student conversation', async t => {
  const { storage } = await reviewStorage(teachingAgentMigrations);
  const { identity, activity } = actor(storage);
  const connection = { connectionId: randomUUID(), version: 1, protocol: 'chat-completions', modelId: 'review-fixture', contextWindow: 16384, maxOutputTokens: 1024 };
  const attempts = new Map(); let calls = 0, sequence = 0;
  const models = {
    selection: { read: async () => ({ version: 1, selected: connection }), snapshot: async () => ({ choice: { connection }, source: { kind: 'personal' } }) },
    segments: { read: async () => ({ closed: false, pending: false, pendingTools: [], sequence }), create: async () => {}, close: async () => {}, settle: async () => { sequence++; } },
    checks: {
      receive: async (_identity, input) => { if (!attempts.has(input.attemptId)) attempts.set(input.attemptId, { attemptId: input.attemptId, state: 'accepted', physicalRequestEnded: true, text: '', usage: { state: 'unknown' }, reason: '' }); return attempts.get(input.attemptId); },
      requestPayload: async () => ({ model: 'review-fixture', messages: [] }),
      dispatch: async (_identity, attemptId) => {
        const first = calls++ === 0; sequence++;
        const fact = { ...attempts.get(attemptId), state: 'completed', physicalRequestEnded: true, resultRef: randomUUID(),
          text: first ? 'First I will inspect the original evidence.' : 'The final explanation.',
          usage: { state: 'final', inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          ...(first ? { toolIntents: [{ callId: 'call_1', name: 'fixture_read', arguments: {} }] } : {}) };
        attempts.set(attemptId, fact); return fact;
      },
      read: async (_identity, attemptId) => attempts.get(attemptId), cancel: async () => {}, progress: async () => null,
    }, results: { retain: async () => {} },
  };
  const tools = {
    definitions: async () => [{ name: 'fixture_read', description: 'Read fixed evidence', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
    prepare: async (_scope, intent, commandId) => ({ version: 1, commandId, name: intent.name, arguments: intent.arguments, effect: 'read', conflictKey: activity.activityId, location: 'owner', basis: {} }),
    dispatch: async () => ({ state: 'completed', feedback: { outcome: 'success', text: 'evidence', images: [] }, result: { evidence: true }, source: { label: 'Fixed evidence' } }),
    reconcile: async () => null, stop: async () => null,
  };
  const agent = createTeachingAgent(storage, { authorize: async () => {}, identityFor: async () => identity, activity: async () => activity, models, tools, start: false });
  t.after(async () => { agent.close(); await agent.drain(); await storage.close(); });
  const input = inputFor(storage, identity, activity);
  const accepted = await agent.accept(input, digest(input));
  const runId = JSON.parse(accepted.detail).runId;
  await waitFor(async () => (await agent.run(identity, activity.activityId, runId)).state === 'completed', 'Run did not finish');
  const conversation = await agent.conversation(identity, activity.activityId);
  const events = await agent.events(identity, activity.activityId);
  console.log('R2 evidence', JSON.stringify({ calls, nativeTexts: [...attempts.values()].map(f => f.text), conversationTexts: conversation.messages.filter(m => m.role === 'assistant').map(m => m.text), assistantEvents: events.filter(e => e.kind === 'assistant').length }));
  assert.deepEqual(conversation.messages.filter(m => m.role === 'assistant').map(m => m.text), ['First I will inspect the original evidence.', 'The final explanation.']);
  assert.deepEqual((await agent.conversation(identity, activity.activityId)).messages, conversation.messages,
    'repeated projection reads do not publish the completed tool turn again');
});

test('R3 an accepted learning attempt remains resumable past the probe-only 60 second deadline', async t => {
  const { storage, db } = await reviewStorage(modelMigrations);
  const { identity } = actor(storage), attemptId = randomUUID();
  const connection = { connectionId: randomUUID(), version: 1, name: 'Review model', protocol: 'chat-completions', baseUrl: 'http://127.0.0.1:9999/v1', path: '/chat/completions', modelId: 'review-fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
    routeId: randomUUID(), hasCredential: true, adapterState: 'ready', contextWindow: 16384, maxOutputTokens: 1024,
    capabilities: { text: 'verified', images: 'unknown', tools: 'verified', strictSchema: 'unknown' } };
  const fact = { attemptId, purpose: 'learning', connection, limits: { maxOutputTokens: 1024, timeoutMs: 600000 }, state: 'accepted', dispatched: false, cancelRequested: false, physicalRequestEnded: true, upstreamStopped: 'unknown', text: '', usage: { state: 'unknown' }, reason: '', requestRef: randomUUID(), resultRef: null, createdAt: new Date(Date.now()-61000).toISOString() };
  const scope = [identity.environmentId, identity.spaceId, identity.principalId].join('.');
  await db.query("INSERT INTO model_attempts(id,scope,body,input_digest,state,physical_ended,created_at) VALUES($1,$2,$3,$4,'accepted',true,clock_timestamp()-interval '61 seconds')", [attemptId, scope, JSON.stringify(fact), digest(fact)]);
  const probe = { ...fact, attemptId: randomUUID(), purpose: 'connection-check', limits: { maxOutputTokens: 64, timeoutMs: 10000 } };
  await db.query("INSERT INTO model_attempts(id,scope,body,input_digest,state,physical_ended,created_at) VALUES($1,$2,$3,$4,'accepted',true,clock_timestamp()-interval '61 seconds')", [probe.attemptId, scope, JSON.stringify(probe), digest(probe)]);
  const checks = createChecks(storage, { authorize: async () => {}, publishChat: async () => {}, assertDispatch: async () => {} });
  t.after(async () => { checks.closeAdmission(); checks.closeDispatch(); await storage.close(); });
  const read = await checks.read(identity, attemptId);
  const probeResult = await checks.read(identity, probe.attemptId);
  console.log('R3 evidence', JSON.stringify({ state: read.state, reason: read.reason, dispatched: read.dispatched, runTimeoutMs: read.limits.timeoutMs, probeState: probeResult.state }));
  assert.equal(probeResult.state, 'cancelled', 'probe authorization still expires on the original short deadline');
  assert.equal(read.state, 'accepted', 'a learning attempt must use Run validity and original authority, not the probe TTL');
});

test('R4 removed unconsumed input is not sent when a model-less Run is resumed', async t => {
  const { storage } = await reviewStorage(teachingAgentMigrations);
  const { identity, activity } = actor(storage), fixture = simpleModels();
  fixture.disable();
  const agent = createTeachingAgent(storage, { authorize: async () => {}, identityFor: async () => identity, activity: async () => activity, models: fixture.models, start: false });
  t.after(async () => { agent.close(); await agent.drain(); await storage.close(); });
  const input = inputFor(storage, identity, activity, 'This question was removed before adoption');
  const accepted = await agent.accept(input, digest(input)), { runId, inputId } = JSON.parse(accepted.detail);
  await waitFor(async () => (await agent.run(identity, activity.activityId, runId)).state === 'paused', 'No-model Run did not pause');
  const removed = await agent.controlInput(identity, activity.activityId, inputId, { version: 1, requestId: randomUUID(), expectedVersion: 1, operation: 'remove' });
  assert.equal(removed.status, 'accepted');
  fixture.enable();
  await agent.continueRun(identity, activity.activityId, runId, { version: 2, requestId: randomUUID(), inputs: [] });
  await waitFor(async () => ['completed', 'paused', 'stopped'].includes((await agent.run(identity, activity.activityId, runId)).state), 'Resume did not settle');
  const after = await agent.conversation(identity, activity.activityId);
  console.log('R4 evidence', JSON.stringify({ state: after.runs.at(-1).state, inputState: after.inputs[0].state, modelCalls: fixture.requests.length, texts: fixture.requests.map(r => r.input.text) }));
  assert.equal(fixture.requests.length, 0, 'removed input must not be revived from teaching_requests.body');
});

test('R4 control: remaining unconsumed steering can resume without reviving the removed root', async t => {
  const { storage } = await reviewStorage(teachingAgentMigrations);
  const { identity, activity } = actor(storage), fixture = simpleModels();
  fixture.disable();
  const agent = createTeachingAgent(storage, { authorize: async () => {}, identityFor: async () => identity, activity: async () => activity, models: fixture.models, start: false });
  agent.closeDispatch();
  t.after(async () => { agent.close(); await agent.drain(); await storage.close(); });
  const root = inputFor(storage, identity, activity, 'REMOVED_ORIGINAL_QUESTION');
  const accepted = await agent.accept(root, digest(root)), { runId, inputId } = JSON.parse(accepted.detail);
  const steering = inputFor(storage, identity, activity, 'RETAINED_STEERING_QUESTION');
  const additional = await agent.accept(steering, digest(steering));
  assert.equal(JSON.parse(additional.detail).runId, runId);
  agent.resume();
  await waitFor(async () => (await agent.run(identity, activity.activityId, runId)).state === 'paused', 'No-model Run did not pause');
  await agent.controlInput(identity, activity.activityId, inputId, { version: 1, requestId: randomUUID(), expectedVersion: 1, operation: 'remove' });
  fixture.enable();
  await agent.continueRun(identity, activity.activityId, runId, { version: 2, requestId: randomUUID(), inputs: [] });
  await waitFor(async () => (await agent.run(identity, activity.activityId, runId)).state === 'completed', 'Remaining steering did not finish');
  const texts = fixture.requests.map(item => item.input.text).join('\n');
  console.log('R4 remaining-input evidence', JSON.stringify({ modelCalls: fixture.requests.length, texts }));
  assert.match(texts, /RETAINED_STEERING_QUESTION/);
  assert.doesNotMatch(texts, /REMOVED_ORIGINAL_QUESTION/);
});

test('R4 race control: steering accepted after the empty read is not paused by stale finish', async t => {
  const { storage, hooks } = await reviewStorage(teachingAgentMigrations);
  const { identity, activity } = actor(storage), fixture = simpleModels();
  fixture.disable();
  const agent = createTeachingAgent(storage, { authorize: async () => {}, identityFor: async () => identity, activity: async () => activity, models: fixture.models, start: false });
  t.after(async () => { agent.close(); await agent.drain(); await storage.close(); });
  const root = inputFor(storage, identity, activity, 'REMOVED_BEFORE_RACE');
  const receipt = await agent.accept(root, digest(root)), { runId, inputId } = JSON.parse(receipt.detail);
  await waitFor(async () => (await agent.run(identity, activity.activityId, runId)).state === 'paused', 'No-model Run did not pause');
  await agent.controlInput(identity, activity.activityId, inputId, { version: 1, requestId: randomUUID(), expectedVersion: 1, operation: 'remove' });
  fixture.enable();
  const readReached = defer(), releaseRead = defer(); let held = false;
  t.after(() => releaseRead.resolve());
  hooks.afterRead = async (sql, values, result) => {
    if (!held && sql.includes("WHERE i.state='pending'") && values[0] === runId && !result.rows.length) {
      held = true; readReached.resolve(); await releaseRead.promise;
    }
  };
  await agent.continueRun(identity, activity.activityId, runId, { version: 2, requestId: randomUUID(), inputs: [] });
  await readReached.promise;
  const steering = inputFor(storage, identity, activity, 'STEERING_ACCEPTED_AFTER_EMPTY_READ');
  const accepted = await agent.accept(steering, digest(steering));
  assert.equal(JSON.parse(accepted.detail).runId, runId);
  releaseRead.resolve();
  await waitFor(async () => ['completed', 'stopped', 'paused'].includes((await agent.run(identity, activity.activityId, runId)).state), 'Race did not settle');
  const conversation = await agent.conversation(identity, activity.activityId);
  const finalRun = conversation.runs.find(item => item.runId === runId);
  console.log('R4 racing-input evidence', JSON.stringify({ state: finalRun.state, modelCalls: fixture.requests.length, texts: fixture.requests.map(item => item.input.text) }));
  assert.equal(finalRun.state, 'completed', 'newly accepted steering must win over the empty snapshot');
  assert.equal(fixture.requests.length, 1);
  assert.equal(fixture.requests[0].input.text, 'STEERING_ACCEPTED_AFTER_EMPTY_READ');
});

test('R5 explicit model switch preserves adopted fixed work content in portable context', async t => {
  const { storage } = await reviewStorage(teachingAgentMigrations);
  const { identity, activity } = actor(storage), fixture = simpleModels();
  const agent = createTeachingAgent(storage, { authorize: async () => {}, identityFor: async () => identity, activity: async () => activity, models: fixture.models, start: false });
  t.after(async () => { agent.close(); await agent.drain(); await storage.close(); });
  const input = inputFor(storage, identity, activity, 'Why does this function return the wrong value?');
  input.works = [{ objectId: randomUUID(), name: 'sample.c', kind: 'code', contentId: randomUUID(), encoding: 'utf8', mediaType: 'text/plain', value: 'int unique_fixed_work_marker_42(void) { return 7; }' }];
  const accepted = await agent.accept(input, digest(input)), { runId } = JSON.parse(accepted.detail);
  await waitFor(async () => (await agent.run(identity, activity.activityId, runId)).state === 'completed', 'First run did not finish');
  assert.match(fixture.requests[0].input.text, /unique_fixed_work_marker_42/);
  const selectionVersion = fixture.switch();
  const switched = await agent.switchModel(identity, activity.activityId, { requestId: randomUUID(), selectionVersion });
  assert.equal(switched.state, 'completed');
  const portable = fixture.segments.get(switched.toSegmentId).portable;
  console.log('R5 evidence', JSON.stringify({ originalContainsFixedWork: true, portable, containsFixedWork: JSON.stringify(portable).includes('unique_fixed_work_marker_42') }));
  assert.match(JSON.stringify(portable), /unique_fixed_work_marker_42/, 'switching must retain the adopted fixed evidence or a model-readable retained reference');
});

test('R5 capacity control: preserving large fixed history never closes the usable old segment before validation', async t => {
  const { storage, db } = await reviewStorage(teachingAgentMigrations);
  const { identity, activity } = actor(storage), fixture = simpleModels();
  const agent = createTeachingAgent(storage, { authorize: async () => {}, identityFor: async () => identity, activity: async () => activity, models: fixture.models, start: false });
  t.after(async () => { agent.close(); await agent.drain(); await storage.close(); });
  const input = inputFor(storage, identity, activity, 'Retain the complete fixed work on switching.');
  input.works = [{ objectId: randomUUID(), name: 'large.c', kind: 'code', contentId: randomUUID(), encoding: 'utf8', mediaType: 'text/plain', value: 'x'.repeat(800001) }];
  const accepted = await agent.accept(input, digest(input)), { runId } = JSON.parse(accepted.detail);
  await waitFor(async () => (await agent.run(identity, activity.activityId, runId)).state === 'completed', 'Large fixed input did not finish');
  const { rows: [session] } = await storage.read('SELECT * FROM teaching_sessions WHERE activity_id=$1', [activity.activityId]);
  // Restore-fixture history: 510 additional small visible messages, preserving the event cursor.
  // The latest real input contributes three portable fragments and its answer one more.
  await db.transaction(async tx => {
    let sequence = Number(session.next_seq);
    for (let i = 0; i < 510; i++) await tx.query(
      'INSERT INTO teaching_events(activity_id,seq,event_id,kind,event_version,body) VALUES($1,$2,$3,$4,1,$5)',
      [activity.activityId, sequence++, randomUUID(), 'assistant', JSON.stringify({ text: 'Retained history ' + i, state: 'settled' })]);
    await tx.query('UPDATE teaching_sessions SET next_seq=$2 WHERE activity_id=$1', [activity.activityId, sequence]);
  });
  const selectionVersion = fixture.switch();
  const switched = await agent.switchModel(identity, activity.activityId, { requestId: randomUUID(), selectionVersion });
  const { rows: [record] } = await storage.read('SELECT create_body FROM teaching_model_switches WHERE request_id=$1', [switched.requestId]);
  console.log('R5 capacity evidence', JSON.stringify({ state: switched.state, reason: switched.reason, oldClosed: fixture.segments.get(session.segment_id).closed, createBodyStored: Boolean(record.create_body) }));
  assert.equal(switched.state, 'paused');
  assert.equal(switched.reason, 'capacity-exceeded');
  assert.equal(fixture.segments.get(session.segment_id).closed, false, 'capacity refusal must retain the original model segment');
  assert.equal(record.create_body, null, 'an invalid immutable create payload must not be frozen for endless retries');
});
