import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { provisionStorage, openStorage, createFileBackend, StorageError } from '@xunjie/storage';
import { nativeFixture } from '../../../packages/storage/test/native-fixture.mjs';
import { modelMigrations } from '../../../packages/learning-space/dist/model-connections/index.js';
import { createChecks } from '../../../packages/learning-space/dist/model-connections/checks.js';
import { learningAdmissionMigration, defaultLearningAdmissionPolicy } from '../../../packages/learning-space/dist/model-connections/learning-admission.js';

const migrations = modelMigrations.some(item => item.version === learningAdmissionMigration.version)
  ? modelMigrations : [...modelMigrations, learningAdmissionMigration];
const actor = (environmentId, principalId = randomUUID()) => ({ environmentId, principalId, spaceId: randomUUID(), kind: 'personal', name: '学习' });
const connection = { connectionId: randomUUID(), name: '受控模型', protocol: 'chat-completions', baseUrl: 'https://fixture.invalid/v1',
  path: '/chat/completions', modelId: 'fixture', dialect: 'standard', parameterMode: 'plain', enabled: true,
  version: 1, routeId: randomUUID(), hasCredential: true, adapterState: 'ready',
  capabilities: { text: 'verified', images: 'unknown', tools: 'unknown', strictSchema: 'unknown' } };
async function until(read, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const fact = await read();
    if (predicate(fact)) return fact;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('controlled model transition timed out');
}

async function dispatchUntil(h, requests, count) {
  for (let round = 0; round < requests.length + 2 && h.sends < count; round++) {
    await Promise.all(requests.map(item => h.checks.dispatch(item.identity, item.id)));
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(h.sends, count);
}

async function harness(policy = {}, storageWrapper = storage => storage) {
  const fixture = await nativeFixture();
  const environmentId = randomUUID();
  const binding = await provisionStorage({ admin: fixture.admin, owner: { environmentId, serviceId: randomUUID() }, password: randomUUID(), migrations });
  const backend = createFileBackend({ id: 'r9', root: join(fixture.root, 'r9') });
  let storage = await openStorage({ binding, migrations, backend });
  const feeSources = new Map(), streams = new Map(), identities = new Map(), preflights = new Map(), authorizations = new Map(), inputs = new Map();
  let sends = 0;
  const rules = { ...defaultLearningAdmissionPolicy, version: 'r9-test-v1', ...policy };
  function owner(dispatcher = { id: 'live', hasEnded: async () => false }) {
    return { dispatcher, authorize: async identity => { await authorizations.get(identity.principalId)?.(); }, assertDispatch: async (_identity, attempt) => { await preflights.get(attempt.attemptId)?.(); }, publishChat: async () => {},
      credential: async () => 'synthetic-r9-secret', learningAdmissionPolicy: rules,
      snapshot: async () => { throw new Error('learning must not use the probe snapshot'); },
      prepareChat: async (identity, input) => ({ connection, credentialRef: randomUUID(),
        source: { kind: 'personal', ownerScope: 'shared-owner', feeSource: feeSources.get(identity.principalId) ?? 'shared-fee' },
        payload: { model: 'fixture', messages: [{ role: 'user', content: input.input.text }], max_tokens: input.limits.maxOutputTokens,
          stream: true, stream_options: { include_usage: true } } }),
      requestFetch: async () => async (_url, init) => {
        sends++;
        const request = JSON.parse(init.body), label = request.messages[0].content;
        const stream = new ReadableStream({
          start(controller) {
            streams.set(label, controller);
            // A real fetch rejects its local reader on abort. This says nothing about
            // the provider's computation, so admission must keep its upstream slot.
            init.signal?.addEventListener('abort', () => {
              try { controller.error(new DOMException('Local reader aborted', 'AbortError')); } catch {}
            }, { once: true });
          },
          cancel() { /* Upstream has not acknowledged stopping. */ },
        });
        return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      } };
  }
  let checks = createChecks(storageWrapper(storage), owner());
  async function receive(identity, label, id = randomUUID()) {
    identities.set(id, identity);
    const input = inputs.get(id) ?? { attemptId: id, purpose: 'learning', segmentId: randomUUID(), expectedSequence: 0,
      input: { text: label }, limits: { maxOutputTokens: 100 } };
    inputs.set(id, input);
    await checks.receive(identity, input);
    return id;
  }
  function finish(label, usage = { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 }) {
    const controller = streams.get(label); assert.ok(controller, label);
    controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ id: 'r9', object: 'chat.completion.chunk', created: 1, model: 'fixture',
      choices: [{ index: 0, delta: { role: 'assistant', content: '完成' }, finish_reason: 'stop' }], usage }) + '\n\ndata: [DONE]\n\n'));
    controller.close();
  }
  return { fixture, environmentId, binding, backend, feeSources, preflights, authorizations, rules, owner, receive, finish,
    get storage() { return storage; }, get checks() { return checks; }, get sends() { return sends; },
    async reopen(dispatcher) { await storage.close(); storage = await openStorage({ binding, migrations, backend }); checks = createChecks(storage, owner(dispatcher)); },
    async close() {
      for (const [id, identity] of identities) await checks.cancel(identity, id).catch(() => {});
      await checks.drain().catch(() => {});
      await storage.close(); await fixture.close();
    } };
}

test('R9 real PG atomically limits shared fees and physical/principal slots, bypasses blocked principals fairly, and settles once after restart', { timeout: 90000 }, async () => {
  const h = await harness({ maxPhysical: 3, maxFeeSourcePhysical: 2, maxPrincipalPhysical: 1 });
  try {
    const a = actor(h.environmentId), aOtherActivity = actor(h.environmentId, a.principalId);
    const b = actor(h.environmentId), c = actor(h.environmentId), d = actor(h.environmentId);
    h.feeSources.set(d.principalId, 'another-fee');
    const ids = [await h.receive(a, 'a1'), await h.receive(aOtherActivity, 'a2'), await h.receive(b, 'b'), await h.receive(c, 'c'), await h.receive(d, 'd')];
    await dispatchUntil(h, [{ identity: a, id: ids[0] }], 1);
    await dispatchUntil(h, [{ identity: b, id: ids[2] }], 2);
    await dispatchUntil(h, [a, aOtherActivity, b, c, d].map((identity, index) => ({ identity, id: ids[index] })), 3);
    const { rows: held } = await h.storage.read('SELECT * FROM model_learning_admissions WHERE physical_held');
    assert.equal(held.length, 3);
    assert.equal(held.filter(row => row.fee_source === 'shared-fee').length, 2);
    assert.equal(held.filter(row => row.principal.endsWith(a.principalId)).length, 1);
    // The first accepted activity of one principal keeps its place even if preflight races.
    const firstA = (await h.checks.read(a, ids[0])).dispatched ? { identity: a, id: ids[0], label: 'a1' }
      : { identity: aOtherActivity, id: ids[1], label: 'a2' };
    const otherA = firstA.id === ids[0] ? { identity: aOtherActivity, id: ids[1], label: 'a2' } : { identity: a, id: ids[0], label: 'a1' };
    assert.equal((await h.checks.read(otherA.identity, otherA.id)).reason, 'learning-principal-concurrency');
    // Free only source capacity: the older same-principal request is blocked by a1,
    // so c must pass it without head-of-line blocking.
    h.finish('b');
    await until(() => h.checks.read(b, ids[2]), fact => fact.physicalRequestEnded && fact.state === 'completed');
    await h.checks.dispatch(c, ids[3]);
    await until(async () => h.sends, value => value === 4);
    assert.equal((await h.checks.read(otherA.identity, otherA.id)).dispatched, false);
    h.finish(firstA.label); h.finish('c'); h.finish('d');
    await Promise.all([[firstA.identity, firstA.id], [c, ids[3]], [d, ids[4]]].map(([who, id]) => until(() => h.checks.read(who, id), fact => fact.state === 'completed')));
    await h.checks.dispatch(otherA.identity, otherA.id);
    await until(async () => h.sends, value => value === 5);
    h.finish(otherA.label, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    await until(() => h.checks.read(otherA.identity, otherA.id), fact => fact.state === 'completed');
    await h.checks.drain();
    await h.reopen({ id: 'restart', hasEnded: async () => true });
    await h.receive(otherA.identity, otherA.label, otherA.id);
    await h.checks.dispatch(otherA.identity, otherA.id);
    assert.equal(h.sends, 5, 'restart/repeated dispatch never sends or charges again');
    const { rows: [billing] } = await h.storage.read('SELECT count(*)::int AS n,sum(settled_units)::int AS used FROM model_learning_admissions WHERE settlement=\'final\'');
    assert.equal(billing.n, 5); assert.equal(billing.used, 48);
    await h.checks.validate();
  } finally { await h.close(); }
});

test('R9 unknown/cancelled upstream keeps reservation and physical slot across dispatcher death and time windows', { timeout: 90000 }, async () => {
  const h = await harness({ maxPhysical: 1, maxFeeSourcePhysical: 1, feeWindowMs: 1000 });
  try {
    const a = actor(h.environmentId), b = actor(h.environmentId);
    const id = await h.receive(a, 'unknown');
    await h.checks.dispatch(a, id);
    await until(async () => h.sends, value => value === 1);
    await h.checks.cancel(a, id);
    await until(() => h.checks.read(a, id), fact => fact.state === 'cancelled' && fact.resultRef !== null);
    const fact = await h.checks.read(a, id);
    assert.equal(fact.physicalRequestEnded, true);
    assert.equal(fact.usage.state, 'unknown');
    await h.checks.drain(); // Local SDK ended; backups retain the independent upstream reservation.
    const next = await h.receive(b, 'waiting');
    await h.storage.request({ requestId: randomUUID(), fingerprint: 'age-r9' }, tx => tx.query("UPDATE model_learning_admissions SET charged_at=clock_timestamp()-interval '2 days' WHERE attempt_id=$1", [id]));
    await h.reopen({ id: 'after-crash', hasEnded: async () => true });
    await h.checks.dispatch(b, next);
    assert.equal((await h.checks.read(b, next)).state, 'accepted');
    assert.equal(h.sends, 1);
    const { rows: [charge] } = await h.storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [id]);
    assert.equal(charge.physical_held, true); assert.equal(charge.upstream_ended, false); assert.equal(charge.settled_units, null); assert.equal(charge.settlement, 'unknown');
    assert.equal((await h.checks.read(a, id)).physicalRequestEnded, true);
  } finally { await h.close(); }
});

test('R9 fee reservations are atomic across subjects; real final usage releases budget once, unknown charges do not expire', { timeout: 90000 }, async () => {
  const h = await harness({ feeBudgetTokens: 5000, maxPhysical: 8, maxFeeSourcePhysical: 8 });
  try {
    const a = actor(h.environmentId), b = actor(h.environmentId), c = actor(h.environmentId);
    const ids = await Promise.all([h.receive(a, 'a'), h.receive(b, 'b'), h.receive(c, 'c')]);
    const who = [a, b, c];
    await dispatchUntil(h, ids.map((id, index) => ({ identity: who[index], id })), 1);
    await Promise.all(ids.map((id, index) => h.checks.dispatch(who[index], id)));
    const facts = await Promise.all(ids.map((id, index) => h.checks.read(who[index], id)));
    assert.equal(facts.filter(fact => fact.reason === 'learning-fee-budget').length, 2);
    const winner = facts.findIndex(fact => fact.dispatched);
    h.finish(['a', 'b', 'c'][winner]);
    await until(() => h.checks.read(who[winner], ids[winner]), fact => fact.state === 'completed');
    const { rows: queued } = await h.storage.read('SELECT attempt_id FROM model_learning_admissions WHERE charged_at IS NULL ORDER BY queue_sequence');
    const waiting = queued.map(row => ({ id: row.attempt_id, index: ids.indexOf(row.attempt_id) }));
    // Try the newer one first. A persisted earlier ready attempt must retain its turn.
    await h.checks.dispatch(who[waiting[1].index], waiting[1].id);
    assert.equal((await h.checks.read(who[waiting[1].index], waiting[1].id)).reason, 'learning-fair-queue');
    await h.checks.dispatch(who[waiting[0].index], waiting[0].id);
    await until(async () => h.sends, value => value === 2);
    h.finish(['a', 'b', 'c'][waiting[0].index]);
    await until(() => h.checks.read(who[waiting[0].index], waiting[0].id), fact => fact.state === 'completed');
    await h.checks.dispatch(who[waiting[1].index], waiting[1].id);
    await until(async () => h.sends, value => value === 3);
    h.finish(['a', 'b', 'c'][waiting[1].index]);
    await until(() => h.checks.read(who[waiting[1].index], waiting[1].id), fact => fact.state === 'completed');
    await h.checks.drain();
    const { rows: [total] } = await h.storage.read('SELECT sum(settled_units)::int AS used,count(*)::int AS n FROM model_learning_admissions');
    assert.equal(total.used, 36); assert.equal(total.n, 3);
  } finally { await h.close(); }
});

test('R9 a confirmed terminal without final usage releases only physical capacity; unknown cost survives restart and rolling expiry', { timeout: 90000 }, async () => {
  const h = await harness({ feeBudgetTokens: 5000, feeWindowMs: 1000 });
  try {
    const a = actor(h.environmentId), b = actor(h.environmentId);
    const id = await h.receive(a, 'unbilled');
    await h.checks.dispatch(a, id);
    await until(async () => h.sends, value => value === 1);
    h.finish('unbilled', null);
    await until(() => h.checks.read(a, id), fact => fact.state === 'completed');
    await h.checks.drain();
    await h.storage.request({ requestId: randomUUID(), fingerprint: 'age-unknown-r9' }, tx => tx.query("UPDATE model_learning_admissions SET charged_at=clock_timestamp()-interval '2 days' WHERE attempt_id=$1", [id]));
    await h.reopen({ id: 'restart', hasEnded: async () => true });
    const next = await h.receive(b, 'blocked');
    await h.checks.dispatch(b, next);
    assert.equal((await h.checks.read(b, next)).reason, 'learning-fee-budget');
    const { rows: [charge] } = await h.storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [id]);
    assert.equal(charge.physical_held, false); assert.equal(charge.upstream_ended, true); assert.equal(charge.settled_units, null);
    assert.equal(h.sends, 1);
    await h.checks.cancel(b, next);
    await h.checks.validate();
  } finally { await h.close(); }
});

test('R9 more than twenty blocked requests neither cap owner capacity nor hide an eligible later subject', { timeout: 90000 }, async () => {
  const h = await harness({ maxPhysical: 32, maxFeeSourcePhysical: 32 });
  try {
    const a = actor(h.environmentId);
    const first = await h.receive(a, 'a-active');
    await h.checks.dispatch(a, first);
    await until(async () => h.sends, value => value === 1);
    for (let index = 0; index < 25; index++) {
      const id = await h.receive(a, 'blocked-' + index);
      await h.checks.dispatch(a, id);
      assert.equal((await h.checks.read(a, id)).reason, 'learning-principal-concurrency');
    }
    const others = [];
    for (let index = 0; index < 21; index++) {
      const identity = actor(h.environmentId), label = 'eligible-' + index;
      others.push({ identity, label, id: await h.receive(identity, label) });
    }
    await dispatchUntil(h, others, 22);
    const { rows: [held] } = await h.storage.read('SELECT count(*)::int AS n FROM model_learning_admissions WHERE physical_held');
    assert.equal(held.n, 22);
    h.finish('a-active');
    for (const item of others) h.finish(item.label);
    await until(() => h.checks.read(a, first), fact => fact.state === 'completed');
    await Promise.all(others.map(item => until(() => h.checks.read(item.identity, item.id), fact => fact.state === 'completed')));
    await h.checks.drain();
  } finally { await h.close(); }
});

test('R9 earlier acceptance cannot be overtaken while its dispatch preflight is delayed', { timeout: 90000 }, async () => {
  const h = await harness({ maxPhysical: 2, maxFeeSourcePhysical: 2 });
  let release;
  try {
    const a = actor(h.environmentId), b = actor(h.environmentId);
    const first = await h.receive(a, 'first'), second = await h.receive(b, 'second');
    let reached;
    const blocked = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { reached = resolve; });
    h.preflights.set(first, async () => { reached(); await blocked; });
    const earlierDispatch = h.checks.dispatch(a, first);
    await entered;
    await h.checks.dispatch(b, second);
    assert.equal(h.sends, 0);
    assert.equal((await h.checks.read(b, second)).reason, 'learning-fair-queue');
    release(); await earlierDispatch;
    await until(async () => h.sends, count => count === 1);
    assert.equal((await h.checks.read(a, first)).dispatched, true);
    await h.checks.dispatch(b, second);
    await until(async () => h.sends, count => count === 2);
    h.finish('first'); h.finish('second');
    await Promise.all([[a, first], [b, second]].map(([who, id]) => until(() => h.checks.read(who, id), fact => fact.state === 'completed')));
    await h.checks.drain();
  } finally { release?.(); await h.close(); }
});

test('R9 an external call with lost result persistence is never replayed or refunded when its dispatcher ends', { timeout: 90000 }, async () => {
  let loseResults = false, failedWrites = 0;
  const h = await harness({ maxPhysical: 1 }, storage => ({ ...storage,
    async request(input, effect) {
      if (loseResults && (input.fingerprint.startsWith('model-result:') || input.fingerprint.startsWith('model-transition:'))) {
        failedWrites++; throw new StorageError('unavailable');
      }
      return storage.request(input, effect);
    },
  }));
  try {
    const a = actor(h.environmentId), b = actor(h.environmentId);
    const id = await h.receive(a, 'lost-result');
    await h.checks.dispatch(a, id);
    await until(async () => h.sends, count => count === 1);
    loseResults = true;
    h.finish('lost-result');
    await until(async () => failedWrites, count => count >= 2);
    await h.reopen({ id: 'replacement', hasEnded: async () => true });
    const prior = await h.checks.read(a, id);
    assert.equal(prior.state, 'unknown'); assert.equal(prior.physicalRequestEnded, true);
    assert.equal(prior.usage.state, 'unknown');
    await h.checks.dispatch(a, id);
    const next = await h.receive(b, 'later');
    await h.checks.dispatch(b, next);
    assert.equal(h.sends, 1);
    assert.equal((await h.checks.read(b, next)).reason, 'learning-physical-capacity');
    const { rows: [charge] } = await h.storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [id]);
    assert.equal(charge.physical_held, true); assert.equal(charge.upstream_ended, false);
    assert.equal(charge.settlement, 'unknown'); assert.equal(charge.settled_units, null);
    await h.checks.drain(); await h.checks.validate();
  } finally { await h.close(); }
});

test('R9 an accepted request without dispatch does not hold up other subjects', { timeout: 90000 }, async () => {
  const h = await harness({ maxPhysical: 1 });
  try {
    const a = actor(h.environmentId), b = actor(h.environmentId);
    const first = await h.receive(a, 'not-requested'), second = await h.receive(b, 'requested');
    const { rows: [queued] } = await h.storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [first]);
    assert.equal(queued.ready, false); assert.equal(queued.ticket_id, null); assert.equal(queued.charged_at, null);
    await h.checks.dispatch(b, second);
    await until(async () => h.sends, count => count === 1);
    assert.equal((await h.checks.read(a, first)).state, 'accepted');
    h.finish('requested');
    await until(() => h.checks.read(b, second), fact => fact.state === 'completed');
    await h.checks.dispatch(a, first);
    await until(async () => h.sends, count => count === 2);
    h.finish('not-requested');
    await until(() => h.checks.read(a, first), fact => fact.state === 'completed');
    await h.checks.drain();
  } finally { await h.close(); }
});

for (const stage of ['authorize', 'assertDispatch']) for (const code of ['forbidden', 'unavailable']) {
  test(`R9 ${stage} ${code} withdraws an old uncharged waiting ticket and lets a different subject proceed`, { timeout: 90000 }, async () => {
    const h = await harness({ maxPhysical: 1 });
    try {
      const blocker = actor(h.environmentId), a = actor(h.environmentId), b = actor(h.environmentId);
      const busy = await h.receive(blocker, 'blocker');
      await h.checks.dispatch(blocker, busy);
      await until(async () => h.sends, count => count === 1);
      const first = await h.receive(a, 'retry-original'), second = await h.receive(b, 'successor');
      await h.checks.dispatch(a, first);
      const { rows: [before] } = await h.storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [first]);
      assert.equal(before.ready, true); assert.equal(before.charged_at, null);
      const gates = stage === 'authorize' ? h.authorizations : h.preflights;
      const key = stage === 'authorize' ? a.principalId : first;
      gates.set(key, async () => { throw new StorageError(code); });
      await assert.rejects(h.checks.dispatch(a, first), { code });
      gates.delete(key);
      const { rows: [after] } = await h.storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [first]);
      assert.equal(after.ready, false); assert.equal(after.ticket_id, null);
      assert.equal(after.charged_at, null); assert.equal(after.physical_held, false);
      assert.equal(after.queue_sequence, before.queue_sequence, 'withdrawing does not re-enqueue the input');
      const preserved = await h.checks.read(a, first);
      assert.equal(preserved.state, 'accepted'); assert.equal(preserved.cancelRequested, false);
      assert.equal(preserved.dispatched, false);
      h.finish('blocker');
      await until(() => h.checks.read(blocker, busy), fact => fact.state === 'completed');
      await h.checks.dispatch(b, second);
      await until(async () => h.sends, count => count === 2);
      h.finish('successor');
      await until(() => h.checks.read(b, second), fact => fact.state === 'completed');
      await h.checks.dispatch(a, first);
      await until(async () => h.sends, count => count === 3);
      h.finish('retry-original');
      await until(() => h.checks.read(a, first), fact => fact.state === 'completed');
      const { rows: [settled] } = await h.storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [first]);
      assert.equal(settled.queue_sequence, before.queue_sequence); assert.equal(settled.settlement, 'final');
      assert.equal(Number(settled.settled_units), 12);
      await h.checks.drain(); await h.checks.validate();
    } finally { await h.close(); }
  });
}

test('R9 a late preflight failure cannot withdraw a newer qualified waiting ticket for the same attempt', { timeout: 90000 }, async () => {
  const h = await harness({ maxPhysical: 1 });
  let release;
  try {
    const blocker = actor(h.environmentId), a = actor(h.environmentId), b = actor(h.environmentId);
    const busy = await h.receive(blocker, 'blocker');
    await h.checks.dispatch(blocker, busy);
    await until(async () => h.sends, count => count === 1);
    const first = await h.receive(a, 'original'), second = await h.receive(b, 'later');
    let entered, calls = 0;
    const blocked = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { entered = resolve; });
    h.preflights.set(first, async () => {
      if (++calls === 1) { entered(); await blocked; throw new StorageError('forbidden'); }
    });
    const rejected = assert.rejects(h.checks.dispatch(a, first), { code: 'forbidden' });
    await reached;
    await h.checks.dispatch(a, first);
    const { rows: [qualified] } = await h.storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [first]);
    assert.equal(qualified.ready, true); assert.equal(qualified.charged_at, null);
    release(); await rejected;
    const { rows: [retained] } = await h.storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [first]);
    assert.equal(retained.ready, true); assert.equal(retained.ticket_id, qualified.ticket_id);
    assert.equal(retained.physical_held, false); assert.equal(retained.charged_at, null);
    h.finish('blocker');
    await until(() => h.checks.read(blocker, busy), fact => fact.state === 'completed');
    await h.checks.dispatch(b, second);
    assert.equal((await h.checks.read(b, second)).reason, 'learning-fair-queue');
    await h.checks.dispatch(a, first);
    await until(async () => h.sends, count => count === 2);
    h.finish('original');
    await until(() => h.checks.read(a, first), fact => fact.state === 'completed');
    await h.checks.dispatch(b, second);
    await until(async () => h.sends, count => count === 3);
    h.finish('later');
    await until(() => h.checks.read(b, second), fact => fact.state === 'completed');
    await h.checks.drain(); await h.checks.validate();
  } finally { release?.(); await h.close(); }
});

for (const failure of ['unavailable', 'commit-unknown']) {
  test(`R9 ${failure} withdrawing a forbidden preflight stays retryable across restart`, { timeout: 90000 }, async () => {
    let failWithdrawal = false;
    const h = await harness({ maxPhysical: 1 }, storage => ({ ...storage,
      async request(input, effect) {
        if (failWithdrawal && input.fingerprint.startsWith('model-learning-withdraw:')) {
          failWithdrawal = false;
          if (failure === 'commit-unknown') await storage.request(input, effect);
          throw new StorageError(failure);
        }
        return storage.request(input, effect);
      },
    }));
    try {
      const blocker = actor(h.environmentId), a = actor(h.environmentId), b = actor(h.environmentId);
      const busy = await h.receive(blocker, 'blocker');
      await h.checks.dispatch(blocker, busy);
      await until(async () => h.sends, count => count === 1);
      const first = await h.receive(a, 'unconfirmed-withdrawal'), second = await h.receive(b, 'successor');
      await h.checks.dispatch(a, first);
      h.preflights.set(first, async () => { throw new StorageError('forbidden'); });
      failWithdrawal = true;
      await assert.rejects(h.checks.dispatch(a, first), { code: failure }, 'do not permanently pause the Run with forbidden until withdrawal is confirmed');
      const { rows: [pending] } = await h.storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [first]);
      assert.equal(pending.ready, failure === 'unavailable');
      assert.equal(pending.charged_at, null); assert.equal(pending.physical_held, false);
      h.finish('blocker');
      // Observe the already-running SDK directly; checks.read would reconcile the
      // old process's in-memory cleanup and mask the restart boundary being tested.
      await until(async () => {
        const { rows: [row] } = await h.storage.read('SELECT body FROM model_attempts WHERE id=$1', [busy]);
        return row.body;
      }, fact => fact.state === 'completed');
      await h.reopen({ id: 'restart-without-in-memory-withdrawals', hasEnded: async () => true });
      await assert.rejects(h.checks.dispatch(a, first), { code: 'forbidden' });
      const { rows: [withdrawn] } = await h.storage.read('SELECT * FROM model_learning_admissions WHERE attempt_id=$1', [first]);
      assert.equal(withdrawn.ready, false); assert.equal(withdrawn.ticket_id, null);
      assert.equal(withdrawn.charged_at, null); assert.equal(withdrawn.physical_held, false);
      assert.equal((await h.checks.read(a, first)).state, 'accepted');
      await h.checks.dispatch(b, second);
      await until(async () => h.sends, count => count === 2);
      h.finish('successor');
      await until(() => h.checks.read(b, second), fact => fact.state === 'completed');
      await h.checks.drain(); await h.checks.validate();
    } finally { await h.close(); }
  });
}
