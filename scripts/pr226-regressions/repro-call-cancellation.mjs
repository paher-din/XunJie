// Real PostgreSQL runtime/store/cancellation runner and product task bridge.
// Gateway responses and execution-owner records are controlled doubles: this is not deployment acceptance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setImmediate as nextTick } from 'node:timers/promises';
import { openStorage } from '../../packages/storage/dist/index.js';
import { createAgentRuntime, createAgentStore, agentRuntimeMigrations } from '../../packages/agent-runtime/dist/index.js';
import pg from '../../node_modules/pg/lib/index.js';
import { createWorkspaceAgentTasks } from '../../packages/product-runtime/dist/workspace-agent-tasks.js';
import { harness, mockGateway, scenario, input } from './harness.mjs';

const realSetTimeout = globalThis.setTimeout;
async function until(check, label, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  do {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => realSetTimeout(resolve, 5));
  } while (performance.now() < deadline);
  throw Error('Timed out: ' + label);
}
function manualTimers() {
  const pending = new Map();
  return {
    pending,
    setTimeout(callback, delayMs) { const handle = {}; pending.set(handle, { callback, delayMs }); return handle; },
    clearTimeout(handle) { pending.delete(handle); },
    fireRetry() {
      // The same runtime clock holds the 24-hour Turn deadline; only fire runner backoff timers.
      const next = [...pending].find(([, timer]) => timer.delayMs <= 30000);
      assert.ok(next, 'an unacknowledged call must have a retry timer');
      pending.delete(next[0]); next[1].callback();
    },
    hasRetry: () => [...pending.values()].some(timer => timer.delayMs <= 30000),
  };
}
function controlledOwner() {
  const records = new Map(), cancels = [], reads = [], lists = [];
  let listFailures = 0, confirmCancellation = false, returnAllRecords = false;
  return {
    records, cancels, reads, lists,
    failNextLists(count) { listFailures = count; },
    confirmOnCancel(value) { confirmCancellation = value; },
    includeUnrelatedRecords() { returnAllRecords = true; },
    add(taskId, ctx, extra = {}) {
      const record = { taskId, toolCallId: ctx.toolCallId, activityId: randomUUID(), identity: ctx.identity,
        sessionId: ctx.sessionId, originTurnId: ctx.turnId, state: 'running', statusKnowledge: 'confirmed',
        confirmedSeq: 1, name: taskId, summary: 'controlled owner task', resultRef: null, ...extra };
      records.set(taskId, record); return record;
    },
    async read(taskId, requester) {
      reads.push(taskId);
      const record = records.get(taskId);
      if (!record || requester && (record.sessionId !== requester.sessionId
        || record.identity.principalId !== requester.identity.principalId)) return null;
      return structuredClone(record);
    },
    async listByOriginTurn(sessionId, turnId) {
      lists.push({ sessionId, turnId });
      if (listFailures > 0) { listFailures--; throw Error('controlled temporary owner outage'); }
      return [...records.values()].filter(record => returnAllRecords || record.sessionId === sessionId && record.originTurnId === turnId).map(record => structuredClone(record));
    },
    async cancel(taskId, requester) {
      const record = records.get(taskId);
      assert.ok(record); assert.equal(requester.sessionId, record.sessionId);
      cancels.push(taskId);
      // A successful cancel RPC is only a request receipt, not proof of physical termination.
      if (confirmCancellation) Object.assign(record, { state: 'cancelled', statusKnowledge: 'confirmed', confirmedSeq: record.confirmedSeq + 1 });
      else record.statusKnowledge = 'unknown';
    },
  };
}
const tool = (name, execute) => ({ definition: { name, description: name, inputSchema: { type: 'object', properties: {} } }, supportsBackground: true, execute });
const intent = (name, background = false) => ({ callId: 'native-' + name, name, arguments: background ? { executionMode: 'background' } : {} });
const reply = (...toolIntents) => ({ text: '', toolIntents });
const accepted = taskId => ({ kind: 'accepted', taskId, summary: 'controlled owner accepted ' + taskId });

async function fixture(responses, tools, owner) {
  let bridge, currentTimers = manualTimers();
  const deliveries = [];
  const taskCancellation = {
    listNonTerminal: (...args) => bridge.taskCancellation.listNonTerminal(...args),
    cancel: (...args) => bridge.taskCancellation.cancel(...args),
    async cancelCall(...args) {
      try {
        const done = await bridge.taskCancellation.cancelCall(...args);
        deliveries.push({ done });
        return done;
      } catch (error) { deliveries.push({ error }); throw error; }
    },
  };
  const budget = { maxCallMs: 1000, hardDeadlineMs: 86400000 };
  const h = await harness(responses, tools, {}, { taskCancellation, cancellationTimers: currentTimers, budget });
  let storage = h.storage, runtime = h.runtime;
  function connectBridge() {
    bridge = createWorkspaceAgentTasks({ storage, owner,
      registerNotification: (...args) => runtime.registerNotification(...args) });
  }
  connectBridge();
  return {
    ...h, deliveries,
    get storage() { return storage; }, get runtime() { return runtime; }, get bridge() { return bridge; },
    get timers() { return currentTimers; },
    async controls() {
      return (await storage.read("SELECT body FROM agent_controls WHERE operation='cancel-call' ORDER BY request_id")).rows.map(row => row.body);
    },
    snapshot: () => runtime.sessionSnapshot(h.identity, h.session.sessionId),
    async retry() {
      currentTimers.fireRetry();
      await runtime.drain();
    },
    async restart() {
      bridge.closeDispatch(); await bridge.drain(); await runtime.close(); await storage.close();
      assert.equal(currentTimers.pending.size, 0, 'the old host cleared its retry/deadline timers');
      // Reopen a new PG handle, not merely a second runner over the old in-memory store.
      storage = await openStorage({ binding: h.binding, backend: h.backend, migrations: agentRuntimeMigrations });
      currentTimers = manualTimers(); connectBridge();
      runtime = createAgentRuntime(storage, { authorize: async () => {}, readOnly: true,
        scenario: scenario(tools), gateway: mockGateway([]), taskCancellation, cancellationTimers: currentTimers, budget });
      await runtime.resume();
    },
    async close() {
      bridge.closeDispatch(); await bridge.drain();
      try { await runtime.close(); } finally {
        try { await storage.close(); } finally { await h.postgres.close(); }
      }
    },
  };
}

test('real PG timeout intent survives owner failure, absent records and restart, then cancels only its exact call', { timeout: 30000 }, async t => {
  const owner = controlledOwner();
  const priorTask = randomUUID(), siblingTask = randomUUID(), targetTask = randomUUID();
  let targetContext, releaseTarget, executions = 0;
  const tools = [
    tool('prior', async (_call, ctx) => { executions++; owner.add(priorTask, ctx); return accepted(priorTask); }),
    tool('sibling', async (_call, ctx) => { executions++; owner.add(siblingTask, ctx); return accepted(siblingTask); }),
    tool('delayed', async (_call, ctx) => {
      executions++; targetContext = ctx;
      await ctx.reportEffect({ requestRef: 'controlled-owner-request' });
      return new Promise(resolve => { releaseTarget = () => resolve(accepted(targetTask)); });
    }),
  ];
  const f = await fixture([reply(intent('prior', true)), reply(), reply(intent('sibling', true), intent('delayed')), reply()], tools, owner);
  try {
    const previous = await f.runtime.submit(f.identity, input(f.session.sessionId, 'prior background task'));
    await f.runtime.drain();
    assert.equal((await f.snapshot()).turns.find(turn => turn.turnId === previous.turnId).state, 'completed');
    owner.failNextLists(1);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const received = await f.runtime.submit(f.identity, input(f.session.sessionId, 'sibling plus timed-out call'));
    await until(() => releaseTarget, 'tool started and reported its external request');
    t.mock.timers.tick(1001); await nextTick(); await f.runtime.drain();
    t.mock.timers.reset();
    await until(() => f.timers.hasRetry(), 'runner scheduled retry after owner exception');
    const [pending] = await f.controls();
    assert.equal((await f.controls()).length, 1);
    assert.equal(pending.state, 'pending'); assert.equal(pending.sessionId, f.session.sessionId);
    assert.equal(pending.turnId, received.turnId); assert.equal(pending.toolCallId, targetContext.toolCallId);
    assert.deepEqual(pending.reference, { requestRef: 'controlled-owner-request' });
    assert.equal(targetContext.signal.aborted, true);
    const unknown = (await f.snapshot()).toolCalls.find(call => call.toolCallId === targetContext.toolCallId).result;
    assert.equal(unknown.kind, 'outcome_unknown'); assert.equal(unknown.requestRef, pending.reference.requestRef);
    assert.equal(owner.cancels.length, 0, 'an unavailable owner has not confirmed cancellation');
    assert.match(f.deliveries.at(-1).error.message, /temporary owner outage/);

    await f.retry();
    assert.equal((await f.controls())[0].state, 'pending', 'no matching owner record is not a delivered cancellation');
    assert.equal(f.deliveries.at(-1).done, false, 'the real bridge explicitly returns false for absent owner records');
    assert.equal(owner.cancels.length, 0);
    const attemptsBeforeRestart = (await f.snapshot()).attempts.length;
    const listsBeforeRestart = owner.lists.length;
    await f.restart();
    assert.ok(owner.lists.length > listsBeforeRestart, 'the new real runtime resumed its durable runner without new user input');
    assert.equal((await f.controls())[0].state, 'pending');
    assert.equal((await f.snapshot()).attempts.length, attemptsBeforeRestart);
    assert.equal(executions, 3, 'restart never re-dispatches any original tool');
    assert.equal(owner.cancels.length, 0);

    // The real bridge must discover by owner-verified toolCallId, even when taskId != callId
    // and the original timeout only knew a request reference.
    assert.notEqual(targetTask, targetContext.toolCallId);
    const wrongTurnTask = randomUUID(), wrongSessionTask = randomUUID();
    owner.add(wrongTurnTask, targetContext, { originTurnId: previous.turnId });
    owner.add(wrongSessionTask, targetContext, { sessionId: randomUUID() });
    // An overbroad owner reply must still be fenced by the real bridge's full tuple.
    owner.includeUnrelatedRecords();
    owner.add(targetTask, targetContext);
    await f.retry();
    assert.deepEqual(owner.cancels, [targetTask]);
    assert.equal((await f.controls())[0].state, 'pending', 'a successful cancel RPC without confirmed terminal state cannot ACK delivered');
    assert.equal(owner.records.get(targetTask).statusKnowledge, 'unknown');
    assert.equal(f.deliveries.at(-1).done, false, 'a cancel request receipt is not terminal confirmation');
    owner.confirmOnCancel(true);
    await f.retry();
    assert.equal((await f.controls())[0].state, 'delivered');
    assert.ok(owner.cancels.length >= 2); assert.ok(owner.cancels.every(taskId => taskId === targetTask));
    assert.equal(owner.records.get(targetTask).state, 'cancelled');
    assert.equal(owner.records.get(siblingTask).state, 'running');
    assert.equal(owner.records.get(priorTask).state, 'running');
    assert.equal(owner.records.get(wrongTurnTask).state, 'running', 'matching call id from an earlier Turn is excluded');
    assert.equal(owner.records.get(wrongSessionTask).state, 'running', 'matching call id from another Session is excluded');
    assert.equal(f.deliveries.at(-1).done, true);
    assert.equal((await f.snapshot()).toolCalls.find(call => call.toolCallId === targetContext.toolCallId).result.kind, 'outcome_unknown');
    assert.equal(f.timers.hasRetry(), false);
    assert.equal((await f.storage.read("SELECT count(*) AS count FROM agent_controls WHERE operation='cancel-turn'")).rows[0].count, '0',
      'a call timeout does not silently escalate to Turn cancellation');
    console.log('COVERAGE real PG runtime/store/runner + real product bridge; controlled owner: exception -> missing -> reopen -> unconfirmed -> confirmed; only target cancelled');
  } finally {
    t.mock.timers.reset(); releaseTarget?.(); await nextTick(); await f.close();
  }
});

test('late accepted after background timeout keeps its immutable unknown result and cannot generate a task notification', { timeout: 30000 }, async t => {
  const owner = controlledOwner(), targetTask = randomUUID(), siblingTask = randomUUID();
  let targetContext, releaseTarget, effects = 0;
  const tools = [
    tool('registered', async (_call, ctx) => { owner.add(siblingTask, ctx); return accepted(siblingTask); }),
    tool('late', async (_call, ctx) => {
      targetContext = ctx; owner.add(targetTask, ctx);
      await ctx.reportEffect({ taskId: targetTask, requestRef: 'late-owner-request' });
      return new Promise(resolve => { releaseTarget = () => {
        effects++; Object.assign(owner.records.get(targetTask), { state: 'succeeded', statusKnowledge: 'confirmed', confirmedSeq: 2 });
        resolve(accepted(targetTask));
      }; });
    }),
  ];
  const f = await fixture([reply(intent('registered', true), intent('late', true)), reply()], tools, owner);
  try {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    await f.runtime.submit(f.identity, input(f.session.sessionId, 'background timeout followed by late acceptance'));
    await until(() => releaseTarget, 'late background executor entered');
    t.mock.timers.tick(1001); await nextTick(); await f.runtime.drain();
    t.mock.timers.reset();
    await until(() => f.timers.hasRetry(), 'unconfirmed cancellation remains scheduled');
    const before = (await f.snapshot()).toolCalls.find(call => call.toolCallId === targetContext.toolCallId);
    assert.equal(before.executionMode, 'background'); assert.equal(before.taskId, targetTask);
    assert.equal(before.result.kind, 'outcome_unknown');
    assert.equal((await f.controls())[0].state, 'pending');
    releaseTarget(); releaseTarget = null;
    await until(async () => (await f.controls()).some(control => control.state === 'delivered'), 'late receipt re-delivered cancellation evidence through the real runner');
    await f.runtime.drain();
    const after = (await f.snapshot()).toolCalls.find(call => call.toolCallId === targetContext.toolCallId);
    assert.deepEqual(after.result, before.result, 'late success is current owner evidence, never a replacement ToolResult');
    assert.equal(effects, 1); assert.ok(owner.cancels.every(taskId => taskId === targetTask));
    Object.assign(owner.records.get(siblingTask), { state: 'succeeded', statusKnowledge: 'confirmed', confirmedSeq: 2 });
    await f.bridge.observe(); await f.runtime.drain();
    const notifications = (await f.snapshot()).notifications;
    assert.equal(notifications.length, 1, 'positive control: an actual accepted background sibling is observable');
    assert.equal(notifications[0].taskId, siblingTask);
    assert.equal(notifications.some(notification => notification.taskId === targetTask), false);
    assert.equal(owner.reads.includes(targetTask), false, 'unknown background ToolCalls are excluded before the observer asks the task owner');
    assert.equal((await f.snapshot()).toolCalls.find(call => call.toolCallId === targetContext.toolCallId).result.kind, 'outcome_unknown');
    console.log('COVERAGE real PG late acceptance + real product observer: external effect succeeded, original result stays unknown; accepted sibling notified, timed-out call not notified');
  } finally {
    t.mock.timers.reset(); releaseTarget?.(); await nextTick(); await f.close();
  }
});

// Independent store witness: lose the real host lock after all terminal/child writes and the
// event insert, immediately before finishTurn's final fence. Every mutation must roll back.
test('finishTurn loses its PG host lock inside the transaction and rolls back every child and event', { timeout: 30000 }, async () => {
  const h = await harness([]);
  await h.runtime.close();
  const admin = new pg.Client(h.postgres.admin);
  let lock, owns = true, loseAfterEvent = false, injected = false;
  const writes = [];
  const wrapped = { ...h.storage, request(options, work) {
    return h.storage.request(options, tx => work({ ...tx, async query(sql, args) {
      const result = await tx.query(sql, args);
      if (loseAfterEvent) {
        writes.push(sql);
        if (sql.startsWith('INSERT INTO agent_events') && args[3] === 'turn-failed') {
          loseAfterEvent = false;
          const killed = await admin.query("SELECT pg_terminate_backend(pid) AS killed FROM pg_stat_activity WHERE application_name='xunjie-agent-host-lock' AND usename=$1", [h.binding.connection.user]);
          assert.equal(killed.rows.length, 1);
          assert.equal(killed.rows[0].killed, true);
          await lock.lost;
          owns = false; injected = true;
        }
      }
      return result;
    } }));
  } };
  const store = createAgentStore(wrapped, { ownerInstanceId: randomUUID(), assertOwner: () => owns });
  try {
    await admin.connect();
    lock = await h.storage.tryHostLock('agent-host:' + h.storage.owner.environmentId + '/' + h.storage.owner.serviceId);
    assert.ok(lock);
    const receipt = await store.submitInput(input(h.session.sessionId, 'open a question'));
    const opened = await store.openStep(receipt.turnId, {}, true);
    assert.equal(opened.kind, 'step');
    const stepId = opened.step.stepId, attemptId = randomUUID(), toolCallId = randomUUID(), questionId = randomUUID();
    await store.saveAttempt(stepId, { attemptId, attemptNo: 1, requestRef: null, reserved: { inputTokens: 100, outputTokens: 100 } });
    await store.saveResponse(stepId, attemptId, { text: 'ask', toolIntents: [], resultRef: null },
      [{ toolCallId, nativeCallId: 'fence-question', name: 'student_ask', input: {}, executionMode: 'foreground' }]);
    await store.startToolCall(toolCallId);
    await store.saveQuestion({ questionId, sessionId: h.session.sessionId, turnId: receipt.turnId, stepId, toolCallId,
      presentation: { question: 'confirm?', options: [{ id: 'confirm', label: 'Confirm' }], allowText: true, skippable: true }, deadline: null });
    await store.submitInput(input(h.session.sessionId, 'pending steering'));
    const before = await store.sessionSnapshot(h.session.sessionId), events = await store.events(h.session.sessionId);
    assert.equal(before.steps.length, 1); assert.equal(before.toolCalls.length, 1); assert.equal(before.attempts.length, 1);
    assert.equal(before.questions[0].state, 'pending'); assert.ok(before.inputs.some(value => value.state === 'pending'));
    loseAfterEvent = true;
    await assert.rejects(() => store.finishTurn(receipt.turnId, 'failed', 'budget_exhausted'), { code: 'stale-generation' });
    assert.equal(injected, true, 'lock was actually lost after the final event insert');
    for (const table of ['agent_turns', 'agent_runtime_sessions', 'agent_questions', 'agent_tool_calls', 'agent_attempts', 'agent_steps', 'agent_inputs'])
      assert.ok(writes.some(sql => sql.startsWith('UPDATE ' + table + ' ')), table + ' participated in the rolled-back transition');
    assert.deepEqual(await store.sessionSnapshot(h.session.sessionId), before,
      'Turn, Step, Attempt, ToolCall, question, pending input and automatic-wake block all rolled back');
    assert.deepEqual(await store.events(h.session.sessionId), events, 'terminal event and Session event sequence rolled back');
    const successor = createAgentStore(h.storage, { ownerInstanceId: randomUUID() });
    await successor.recoverInterrupted();
    const recovered = await successor.sessionSnapshot(h.session.sessionId);
    assert.equal(recovered.turns[0].state, 'interrupted'); assert.equal(recovered.steps[0].state, 'interrupted');
    assert.equal(recovered.toolCalls[0].state, 'closed'); assert.equal(recovered.questions[0].state, 'closed');
    console.log('COVERAGE real PG lock killed after finishTurn child cleanup/event insert: whole transition rolled back; successor repaired open facts');
  } finally {
    await lock?.release(); await admin.end();
    try { await h.storage.close(); } finally { await h.postgres.close(); }
  }
});
