import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import pg from '../../node_modules/pg/lib/index.js';
import { createAgentRuntime, createAgentStore } from '../../packages/agent-runtime/dist/index.js';
import { harness, mockGateway, scenario, input, waitFor } from './harness.mjs';

// Correct-behavior regressions ported from the PR #226 review witnesses.
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function blocking(name = 'block') {
  let release; let ctx;
  const gate = new Promise(resolve => { release = resolve; });
  return { release, get context() { return ctx; }, tool: {
    definition: { name, description: name, inputSchema: { type: 'object' } }, supportsBackground: false,
    async execute(_call, context) { ctx = context; await gate; return { kind: 'completed', outcome: 'success', summary: 'late result' }; },
  } };
}

test('a production-style readOnly resume holds the exclusive host lock while it runs a tool', async () => {
  const h = await harness([]);
  await h.runtime.close();
  const b = blocking(); let released = 0;
  const wrapped = { ...h.storage, async tryHostLock(key) {
    const lock = await h.storage.tryHostLock(key);
    return lock ? { ...lock, async release() { await lock.release(); released++; } } : null;
  } };
  const runtime = createAgentRuntime(wrapped, {
    authorize: async () => {}, readOnly: true, scenario: scenario([b.tool]),
    gateway: mockGateway([{ text: 'call', toolIntents: [{ callId: 'c1', name: 'block', arguments: {} }] }]),
  });
  let probe;
  try {
    await runtime.resume();
    assert.equal(released, 0, 'resume retains the host lock rather than using a temporary one');
    const receipt = await runtime.submit(h.identity, input(h.session.sessionId, 'run'));
    await waitFor(() => b.context);
    probe = await h.storage.tryHostLock('agent-host:' + h.storage.owner.environmentId + '/' + h.storage.owner.serviceId);
    assert.equal(probe, null, 'the running host still owns the exclusive lock');
    console.log('REGRESSION host-lock: active tool=true, competing lock acquired=false');
    await runtime.stop(h.identity, h.session.sessionId, receipt.turnId, randomUUID());
    b.release(); await runtime.drain();
  } finally {
    b.release(); if (probe) await probe.release();
    await runtime.close(); await h.storage.close(); await h.postgres.close();
  }
});

test('a readOnly host can drain behind closed storage gates before restart resumes recovery', async () => {
  const h = await harness([]);
  await h.runtime.close();
  const participant = h.storage.participant();
  await participant.closeWrites(); await participant.closeDispatch();
  const runtime = createAgentRuntime(h.storage, { authorize: async () => {}, readOnly: true,
    scenario: scenario([]), gateway: mockGateway([{ text: '重启后完成', toolIntents: [] }]) });
  let probe;
  try {
    await runtime.drain(); // Maintenance drains before reopening storage, so this must be read-only.
    probe = await h.storage.tryHostLock('agent-host:' + h.storage.owner.environmentId + '/' + h.storage.owner.serviceId);
    assert.equal(probe, null, 'paused host still holds the exclusive ownership lock');
    await participant.resume(); await runtime.resume();
    const receipt = await runtime.submit(h.identity, input(h.session.sessionId, 'restart'));
    await runtime.drain();
    const snapshot = await runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snapshot.turns.find(turn => turn.turnId === receipt.turnId).state, 'completed');
    console.log('REGRESSION readOnly restart: lock held behind closed gates, recovery deferred until storage resumes');
  } finally {
    await probe?.release(); await participant.resume();
    await runtime.close().catch(() => {}); await h.storage.close(); await h.postgres.close();
  }
});

test('losing the real PostgreSQL host lock fences final facts until a new lock holder repairs the Turn', async () => {
  const b = blocking();
  const h = await harness([{ text: 'call', toolIntents: [{ callId: 'c1', name: 'block', arguments: {} }] }], [b.tool]);
  const admin = new pg.Client(h.postgres.admin);
  let successor;
  try {
    await admin.connect();
    const receipt = await h.runtime.submit(h.identity, input(h.session.sessionId, 'run'));
    await waitFor(() => b.context);
    const killed = await admin.query("SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE application_name='xunjie-agent-host-lock' AND usename=$1", [h.binding.connection.user]);
    assert.equal(killed.rows.length, 1);
    await waitFor(() => b.context.signal.aborted);
    b.release(); await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.toolCalls[0].result, null);
    assert.notEqual(snap.steps[0].state, 'completed');
    assert.equal(snap.turns[0].state, 'active', 'the lost host cannot close its Turn in the loop error handler');
    const oldOwner = createAgentStore(h.storage, { ownerInstanceId: snap.turns[0].ownerInstanceId,
      assertOwner: () => !b.context.signal.aborted });
    for (const state of ['failed', 'completed']) {
      assert.equal(await oldOwner.finishTurn(receipt.turnId, state, 'late-finish'), false,
        'matching the persisted owner ID is insufficient after losing the real lock');
    }
    assert.equal((await oldOwner.events(h.session.sessionId))
      .some(event => ['turn-failed', 'turn-completed'].includes(event.kind)), false);
    successor = createAgentRuntime(h.storage, { authorize: async () => {}, readOnly: true,
      scenario: scenario([]), gateway: mockGateway([]) });
    await successor.resume();
    const repaired = await successor.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(repaired.turns[0].state, 'interrupted');
    assert.equal(repaired.turns[0].reason, 'host-restart');
    assert.equal(repaired.toolCalls[0].result.kind, 'outcome_unknown');
    assert.equal(repaired.steps[0].state, 'interrupted');
    console.log('REGRESSION lock-loss: old finish rejected, Turn stays active until successor lock/recovery => interrupted');
  } finally { b.release(); await successor?.close(); await admin.end(); await h.close(); }
});

test('lock loss during Turn closure rolls back the terminal state and child cleanup together', async () => {
  const h = await harness([]);
  await h.runtime.close();
  const admin = new pg.Client(h.postgres.admin);
  const lock = await h.storage.tryHostLock('agent-host:' + h.storage.owner.environmentId + '/' + h.storage.owner.serviceId);
  assert.ok(lock);
  let owns = true, loseDuringClose = false;
  const wrapped = { ...h.storage, request(options, work) {
    return h.storage.request(options, tx => work({ ...tx, async query(sql, args) {
      const result = await tx.query(sql, args);
      if (loseDuringClose && sql.startsWith('UPDATE agent_turns SET state=$2')) {
        loseDuringClose = false;
        await admin.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='xunjie-agent-host-lock' AND usename=$1", [h.binding.connection.user]);
        await lock.lost; owns = false;
      }
      return result;
    } }));
  } };
  const store = createAgentStore(wrapped, { ownerInstanceId: randomUUID(), assertOwner: () => owns });
  let successor;
  try {
    await admin.connect();
    const receipt = await store.submitInput(input(h.session.sessionId, 'run'));
    const opened = await store.openStep(receipt.turnId, {}, true);
    assert.equal(opened.kind, 'step');
    loseDuringClose = true;
    await assert.rejects(() => store.finishTurn(receipt.turnId, 'failed', 'internal-error'),
      error => error.code === 'stale-generation');
    const unchanged = await store.sessionSnapshot(h.session.sessionId);
    assert.equal(unchanged.turns[0].state, 'active');
    assert.equal(unchanged.steps[0].state, 'generating');
    assert.equal((await store.events(h.session.sessionId)).some(event => event.kind === 'turn-failed'), false);
    successor = createAgentRuntime(h.storage, { authorize: async () => {}, readOnly: true,
      scenario: scenario([]), gateway: mockGateway([]) });
    await successor.resume();
    const repaired = await successor.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(repaired.turns[0].state, 'interrupted');
    assert.equal(repaired.steps[0].state, 'interrupted');
  } finally { await successor?.close(); await lock.release(); await admin.end(); await h.storage.close(); await h.postgres.close(); }
});

test('the hard Turn deadline aborts a pending tool instead of letting the Turn finish', async () => {
  const b = blocking();
  const h = await harness([{ text: 'call', toolIntents: [{ callId: 'c1', name: 'block', arguments: {} }] }], [b.tool], {},
    { budget: { maxCallMs: 5000, hardDeadlineMs: 1000 } });
  try {
    const r = await h.runtime.submit(h.identity, input(h.session.sessionId, 'run'));
    await waitFor(() => b.context);
    await sleep(1200);
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.turns[0].state, 'failed');
    assert.equal(snap.turns[0].reason, 'deadline-exceeded');
    assert.equal(snap.toolCalls[0].state, 'closed');
    assert.equal(b.context.signal.aborted, true);
    console.log('REGRESSION deadline: hardDeadlineMs=1000, Turn=failed/deadline-exceeded, signal.aborted=true');
    await h.runtime.stop(h.identity, h.session.sessionId, r.turnId, randomUUID());
    b.release(); await h.settle();
  } finally { b.release(); await h.close(); }
});

test('a valid notification from an earlier completed Turn wakes an idle session after the current Turn is stopped', async () => {
  const b = blocking();
  const h = await harness([{ text: 'done', toolIntents: [] },
    { text: 'call', toolIntents: [{ callId: 'c1', name: 'block', arguments: {} }] },
    { text: 'notify', toolIntents: [] }], [b.tool]);
  try {
    const first = await h.runtime.submit(h.identity, input(h.session.sessionId, 'first'));
    await h.settle();
    const second = await h.runtime.submit(h.identity, input(h.session.sessionId, 'second'));
    await waitFor(() => b.context);
    const fact = { taskId: 'earlier-task', taskVersion: 'v1', terminalStatus: 'success', summary: 'finished', resultRef: null };
    const before = await h.runtime.registerNotification(h.identity, h.session.sessionId, first.turnId, fact);
    assert.equal(before.turnId, null);
    await h.runtime.stop(h.identity, h.session.sessionId, second.turnId, randomUUID());
    b.release(); await h.settle();
    await h.runtime.registerNotification(h.identity, h.session.sessionId, first.turnId, fact);
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.turns.length, 3);
    assert.ok(['pending', 'adopted'].includes(snap.notifications[0].state));
    assert.equal(snap.turns.some(t => t.state === 'active'), false);
    console.log('REGRESSION notification: origin=completed, current=stopped, idle=true, automatic follow-up started');
  } finally { b.release(); await h.close(); }
});

test('a notification with a missing origin is suppressed instead of entering a later user Turn', async () => {
  const h = await harness([{ text: 'done', toolIntents: [] }]);
  try {
    await h.runtime.registerNotification(h.identity, h.session.sessionId, randomUUID(), {
      taskId: 'legacy-task', taskVersion: 'v1', terminalStatus: 'success', summary: 'old task', resultRef: null,
    });
    await h.runtime.submit(h.identity, input(h.session.sessionId, 'new conversation'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.notifications[0].state, 'suppressed');
    assert.deepEqual(snap.steps[0].snapshot.notificationIds, []);
    console.log('REGRESSION missing origin: legacy notification=suppressed, new user Step unaffected');
  } finally { await h.close(); }
});

async function seedOpenCall(h, state) {
  const old = createAgentStore(h.storage, { ownerInstanceId: 'old-owner' });
  const receipt = await old.submitInput(input(h.session.sessionId, 'original request'));
  const opened = await old.openStep(receipt.turnId, {}, true);
  const stepId = opened.step.stepId, attemptId = randomUUID(), toolCallId = randomUUID(), questionId = randomUUID();
  await old.saveAttempt(stepId, { attemptId, attemptNo: 1, requestRef: null, reserved: { inputTokens: 100, outputTokens: 100 } });
  await old.saveResponse(stepId, attemptId, { text: 'ask', toolIntents: [], resultRef: null }, [{ toolCallId, nativeCallId: 'c1', name: 'student_ask', input: {}, executionMode: 'foreground' }]);
  await old.startToolCall(toolCallId);
  await old.saveQuestion({ questionId, sessionId: h.session.sessionId, turnId: receipt.turnId, stepId, toolCallId,
    presentation: { question: 'confirm?', options: [{ id: 'confirm', label: 'Confirm' }], allowText: true, skippable: true }, deadline: null });
  if (state === 'answered') await old.answerQuestion(h.session.sessionId, { requestId: randomUUID(), questionId, expectedVersion: 1, answer: { kind: 'choice', optionId: 'confirm' } });
  return { old, receipt, stepId, attemptId, toolCallId, questionId };
}

for (const state of ['pending', 'answered']) {
  test(`restart repair preserves the real ${state} question result`, async () => {
    const h = await harness([]); await h.runtime.close();
    try {
      const seeded = await seedOpenCall(h, state);
      const next = createAgentStore(h.storage, { ownerInstanceId: 'new-owner' });
      await next.recoverInterrupted();
      const snap = await next.sessionSnapshot(h.session.sessionId);
      assert.equal(snap.turns[0].state, 'interrupted');
      assert.equal(snap.toolCalls[0].result.kind, state === 'answered' ? 'completed' : 'interrupted');
      assert.equal(snap.questions[0].state, state === 'answered' ? 'answered' : 'closed');
      console.log(`REGRESSION repair: question originally=${state}, real result preserved or closed`);
    } finally { await h.storage.close(); await h.postgres.close(); }
  });
}

test('a failed Turn closes its open Step, ToolCall and question, including after restart', async () => {
  const h = await harness([]); await h.runtime.close();
  try {
    const seeded = await seedOpenCall(h, 'pending');
    await seeded.old.finishTurn(seeded.receipt.turnId, 'failed', 'internal-error');
    const next = createAgentStore(h.storage, { ownerInstanceId: 'new-owner' });
    await next.recoverInterrupted();
    const snap = await next.sessionSnapshot(h.session.sessionId);
    assert.equal(snap.turns[0].state, 'failed');
    assert.equal(snap.steps[0].state, 'failed');
    assert.equal(snap.toolCalls[0].state, 'closed');
    assert.equal(snap.questions[0].state, 'closed');
    console.log('REGRESSION failed closure: Step=failed, call=closed, question=closed after restart');
  } finally { await h.storage.close(); await h.postgres.close(); }
});

test('Stop followed by process exit closes its started ToolCall after startup repair', async () => {
  const h = await harness([]); await h.runtime.close();
  try {
    const seeded = await seedOpenCall(h, 'pending');
    await seeded.old.stopTurn(h.session.sessionId, seeded.receipt.turnId, randomUUID());
    const next = createAgentStore(h.storage, { ownerInstanceId: 'new-owner' });
    await next.recoverInterrupted();
    const snap = await next.sessionSnapshot(h.session.sessionId);
    assert.equal(snap.turns[0].state, 'stopped');
    assert.equal(snap.steps[0].state, 'interrupted');
    assert.equal(snap.toolCalls[0].state, 'closed');
    console.log('REGRESSION Stop/crash: Turn=stopped, Step=interrupted, call=closed after startup repair');
  } finally { await h.storage.close(); await h.postgres.close(); }
});

test('Stop closes a running model request when abort arrives during the polling delay', async () => {
  const h = await harness([]);
  let dispatches = 0, cancellations = 0;
  const dispatch = h.gateway.checks.dispatch;
  h.gateway.checks.dispatch = async (identity, attemptId) => {
    dispatches++;
    const fact = await dispatch(identity, attemptId);
    Object.assign(fact, { state: 'running', physicalRequestEnded: false });
    return fact;
  };
  h.gateway.checks.cancel = async () => { cancellations++; };
  try {
    const r = await h.runtime.submit(h.identity, input(h.session.sessionId, 'generate'));
    await waitFor(() => dispatches === 1);
    await sleep(10); // the model is now in its 50 ms polling delay
    await h.runtime.stop(h.identity, h.session.sessionId, r.turnId, randomUUID());
    await h.settle();
    assert.equal(cancellations, 1);
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.attempts[0].state, 'interrupted');
    assert.equal(snap.steps[0].state, 'interrupted');
    console.log('REGRESSION Stop/model: upstream cancel calls=1, Attempt=interrupted, Step=interrupted');
  } finally { await h.close(); }
});
