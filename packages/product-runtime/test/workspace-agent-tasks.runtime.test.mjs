import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { operationId } from '@xunjie/storage/identity';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentRuntime, agentRuntimeMigrations } from '../../agent-runtime/dist/index.js';
import { createWorkspaceAgentTasks, createLearningSpaceTaskOwner } from '../dist/workspace-agent-tasks.js';

const connection = { routeId: randomUUID(), version: 1, maxOutputTokens: 4096, contextWindow: 1_000_000,
  protocol: 'openai-chat', parameterMode: 'plain', capabilities: {}, hasCredential: true, adapterState: 'ready' };
function mockGateway(responses) {
  const queue = [...responses]; const segments = new Map(); const attempts = new Map(); let sequence = 0;
  const segment = (segmentId, seq) => ({ sessionId: undefined, segmentId, formatVersion: 1, sequence: seq,
    connection, prefixDigest: '0'.repeat(64), resultRef: null, pending: false, closed: false, pendingTools: [] });
  return {
    selection: { read: async () => ({ selected: true, version: 1 }),
      snapshot: async () => ({ choice: { connection }, source: { kind: 'personal', ownerScope: 's', feeSource: 'f' } }),
      pin: async () => ({ choice: { connection }, source: { kind: 'personal', ownerScope: 's', feeSource: 'f' } }),
      pinSource: async () => ({}), pinned: async () => ({}), resolveChoice: async () => ({}) },
    segments: { create: async (_i, input) => { const s = segment(input.segmentId, sequence); segments.set(input.segmentId, s); return s; },
      read: async (_i, id) => segments.get(id),
      settle: async (_i, id, input) => { const s = segments.get(id); s.sequence = input.expectedSequence + 1; s.pendingTools = []; return s; },
      close: async (_i, id) => { const s = segments.get(id); s.closed = true; return { ...s, boundary: { owner: { environmentId: 'e', serviceId: 's' }, segmentId: id, sequence: s.sequence, routeId: connection.routeId, resultRef: null } }; } },
    checks: { receive: async (_i, input) => { const a = { attemptId: input.attemptId, state: 'accepted', physicalRequestEnded: false, dispatched: false, cancelRequested: false, text: '', usage: { state: 'unknown' }, requestRef: randomUUID(), resultRef: null, reason: '', upstreamStopped: 'unknown', createdAt: new Date().toISOString(), purpose: 'learning', connection, limits: input.limits }; attempts.set(input.attemptId, a); return a; },
      dispatch: async (_i, id) => { const a = attempts.get(id); const r = queue.shift() ?? { text: '完成', toolIntents: [] };
        Object.assign(a, { state: 'completed', physicalRequestEnded: true, dispatched: true, text: r.text, toolIntents: r.toolIntents ?? [], usage: { state: 'final', inputTokens: 10, outputTokens: 5 }, resultRef: randomUUID(), segment: { segmentId: [...segments.keys()][0], sequence: 0 } }); return a; },
      read: async (_i, id) => attempts.get(id), progress: async () => null, summary: async () => null, requestPayload: async () => ({}), cancel: async (_i, id) => attempts.get(id) },
    results: { retain: async () => null }, images: { upload: async () => ({}), read: async () => ({}) },
  };
}

const taskMigration = [{ version: 1, name: 'task-owner-fixture', sql: `
  CREATE TABLE agent_execution_commands(command_id uuid PRIMARY KEY, request_id uuid NOT NULL, activity_id uuid NOT NULL,
    association jsonb NOT NULL, body_text text NOT NULL, input_digest text NOT NULL, kind text NOT NULL,
    cancelled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT clock_timestamp());
  CREATE TABLE agent_execution_origins(command_id uuid PRIMARY KEY, identity jsonb NOT NULL);
  CREATE TABLE execution_commands(request_id uuid PRIMARY KEY, activity_id uuid NOT NULL, state text NOT NULL,
    status_knowledge text NOT NULL, confirmed_seq integer NOT NULL DEFAULT 0, reason jsonb, output jsonb, execution_ref uuid);
` }];

const waitFor = async (fn, timeout = 5000) => { const end = Date.now() + timeout; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 15)); } throw new Error('waitFor timeout'); };

async function harness(responses, { toolFactory, cancelFails = false } = {}) {
  const postgres = await nativeFixture();
  const agentOwner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const taskOwner = { environmentId: agentOwner.environmentId, serviceId: randomUUID() };
  const agentBinding = await provisionStorage({ admin: postgres.admin, owner: agentOwner, password: randomUUID(), migrations: agentRuntimeMigrations });
  const storage = await openStorage({ binding: agentBinding, migrations: agentRuntimeMigrations, backend: createFileBackend({ id: 'agent', root: join(postgres.root, 'agent-res') }) });
  const taskBinding = await provisionStorage({ admin: postgres.admin, owner: taskOwner, password: randomUUID(), migrations: taskMigration });
  const taskStorage = await openStorage({ binding: taskBinding, migrations: taskMigration, backend: createFileBackend({ id: 'task', root: join(postgres.root, 'task-res') }) });

  const identity = { kind: 'personal', name: '学生', environmentId: agentOwner.environmentId, spaceId: randomUUID(), principalId: randomUUID() };
  const activityId = randomUUID();
  const executions = {
    async read(_i, _a, requestId) {
      const { rows: [row] } = await taskStorage.read('SELECT * FROM execution_commands WHERE request_id=$1', [requestId]);
      if (!row) return null;
      return { state: row.state, statusKnowledge: row.status_knowledge, confirmedSeq: row.confirmed_seq, reason: row.reason, output: row.output, executionRef: row.execution_ref };
    },
    agent: { async stop(_i, _a, _ctx, requestId, value) {
      if (cancelFails) throw new Error('transient-cancel-failure');
      await taskStorage.request({ requestId: 'stop:' + value.stopId, fingerprint: value.stopId }, async tx => {
        await tx.query("UPDATE execution_commands SET state='cancelled', status_knowledge='confirmed', confirmed_seq=confirmed_seq+1 WHERE request_id=$1 AND state NOT IN ('succeeded','failed','cancelled')", [requestId]);
        await tx.query('UPDATE agent_execution_commands SET cancelled=true WHERE command_id=$1', [requestId]);
        return null;
      });
    } },
  };
  const owner = createLearningSpaceTaskOwner({ storage: taskStorage, executions,
    sessionIdOfTurn: async turnId => { const { rows: [row] } = await storage.read('SELECT session_id FROM agent_turns WHERE turn_id=$1', [turnId]); return String(row.session_id); } });

  let bridge;
  const gateway = mockGateway(responses);
  const tools = toolFactory ? toolFactory() : [];
  const scenario = { id: 'test', version: 1, async context() { return { system: '测试', facts: {}, sources: [] }; }, async tools() { return tools; } };
  const runtime = createAgentRuntime(storage, { authorize: async () => {}, scenario, gateway,
    taskFacts: { relevant: (...args) => bridge.taskFacts.relevant(...args) },
    taskCancellation: { listNonTerminal: (...args) => bridge.taskCancellation.listNonTerminal(...args), cancel: (...args) => bridge.taskCancellation.cancel(...args) } });
  bridge = createWorkspaceAgentTasks({ storage, owner, registerNotification: (i, s, t, f) => runtime.registerNotification(i, s, t, f) });

  const session = { sessionId: randomUUID(), identity, scenario: 'test', createdAt: new Date().toISOString() };
  await runtime.initialize(session);

  async function registerTask(taskId, turnId, { state = 'running', statusKnowledge = 'confirmed', confirmedSeq = 1 } = {}) {
    const stepId = randomUUID(), snapshotId = randomUUID();
    const association = { runId: turnId, stepId, commandId: taskId, snapshotId };
    const body = { execution: { operation: { operationId: 'run-single' } } };
    await taskStorage.request({ requestId: 'reg:' + taskId, fingerprint: taskId }, async tx => {
      await tx.query('INSERT INTO agent_execution_commands(command_id,request_id,activity_id,association,body_text,input_digest,kind) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [taskId, taskId, activityId, association, JSON.stringify(body), taskId, 'submit']);
      await tx.query('INSERT INTO agent_execution_origins(command_id,identity) VALUES($1,$2)', [taskId, identity]);
      await tx.query('INSERT INTO execution_commands(request_id,activity_id,state,status_knowledge,confirmed_seq,reason,output,execution_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [taskId, activityId, state, statusKnowledge, confirmedSeq, null, null, randomUUID()]);
      return null;
    });
  }
  async function setTaskState(taskId, state, confirmedSeq) {
    await taskStorage.request({ requestId: 'state:' + taskId + ':' + confirmedSeq, fingerprint: String(confirmedSeq) }, async tx => {
      await tx.query('UPDATE execution_commands SET state=$2, status_knowledge=$3, confirmed_seq=$4 WHERE request_id=$1', [taskId, state, 'confirmed', confirmedSeq]);
      return null;
    });
  }
  const input = text => ({ requestId: randomUUID(), sessionId: session.sessionId, text, context: {} });
  return { postgres, storage, taskStorage, runtime, bridge, owner, identity, session, activityId, registerTask, setTaskState, input,
    snapshot: () => runtime.sessionSnapshot(identity, session.sessionId),
    async close() { bridge.closeDispatch(); await runtime.close().catch(() => {}); await storage.close(); await taskStorage.close(); await postgres.close(); } };
}

/** A background tool that accepts the next queued taskId; a foreground blocking tool holds a Turn open. */
function backgroundTools(taskIds) {
  const queue = [...taskIds];
  const bg = { definition: { name: 'course_operation', description: '长任务', inputSchema: { type: 'object' } }, supportsBackground: true,
    async execute() { return { kind: 'accepted', taskId: queue.shift(), summary: '已受理' }; } };
  return [bg];
}
function blockingBackgroundTools(taskIds) {
  const queue = [...taskIds]; let release; const gate = new Promise(r => { release = r; }); const started = [];
  const bg = { definition: { name: 'course_operation', description: '长任务', inputSchema: { type: 'object' } }, supportsBackground: true,
    async execute() { return { kind: 'accepted', taskId: queue.shift(), summary: '已受理' }; } };
  const block = { definition: { name: 'block', description: '阻塞', inputSchema: { type: 'object' } }, supportsBackground: false,
    async execute() { started.push(1); await gate; return { kind: 'completed', outcome: 'success', summary: 'done' }; } };
  return { tools: [bg, block], release, started };
}

test('通知桥：空闲+来源completed 自动开新 Turn，notificationId 稳定，重放/重启不重复', async () => {
  const taskId = randomUUID();
  const h = await harness([{ text: '启动', toolIntents: [{ callId: 'c1', name: 'course_operation', arguments: { executionMode: 'background' } }] }, { text: '受理已知', toolIntents: [] }, { text: '通知已处理', toolIntents: [] }],
    { toolFactory: () => backgroundTools([taskId]) });
  try {
    const receipt = await h.runtime.submit(h.identity, h.input('启动实验'));
    await h.runtime.drain();
    await h.registerTask(taskId, receipt.turnId, { state: 'succeeded', confirmedSeq: 3 });
    await h.bridge.observe();
    const expectedId = operationId('agent-notification:' + taskId + ':3');
    let snap = await h.snapshot();
    const notification = snap.notifications.find(n => n.taskId === taskId);
    assert.ok(notification, '终态已登记为通知');
    assert.equal(notification.notificationId, expectedId, 'notificationId 由 taskId+taskVersion 确定');
    assert.equal(notification.terminalStatus, 'success');
    const wakeTurn = snap.turns.find(t => t.trigger === 'task-notification');
    assert.ok(wakeTurn, '空闲且来源 completed → 自动新 Turn');
    await h.runtime.drain();
    // Replay: same terminal version must not create a second notification or Turn.
    await h.bridge.observe();
    snap = await h.snapshot();
    assert.equal(snap.notifications.filter(n => n.taskId === taskId).length, 1, '重放不重复登记');
    assert.equal(snap.turns.filter(t => t.trigger === 'task-notification').length, 1, '重放不重复唤醒');
    // Restart: a fresh bridge over the same durable storage stays idempotent.
    const restarted = createWorkspaceAgentTasks({ storage: h.storage, owner: h.owner, registerNotification: (i, s, t, f) => h.runtime.registerNotification(i, s, t, f) });
    await restarted.scan();
    snap = await h.snapshot();
    assert.equal(snap.notifications.filter(n => n.taskId === taskId).length, 1, '重启不重复登记');
    restarted.closeDispatch();
  } finally { await h.close(); }
});

test('通知桥：同一 Turn 的两个后台任务各自一个稳定通知', async () => {
  const a = randomUUID(), b = randomUUID();
  const h = await harness([{ text: '启动两个', toolIntents: [
    { callId: 'c1', name: 'course_operation', arguments: { executionMode: 'background' } },
    { callId: 'c2', name: 'course_operation', arguments: { executionMode: 'background' } }] }, { text: '受理已知', toolIntents: [] }],
    { toolFactory: () => backgroundTools([a, b]) });
  try {
    const receipt = await h.runtime.submit(h.identity, h.input('启动两个实验'));
    await h.runtime.drain();
    await h.registerTask(a, receipt.turnId, { state: 'succeeded', confirmedSeq: 2 });
    await h.registerTask(b, receipt.turnId, { state: 'succeeded', confirmedSeq: 3 });
    await h.bridge.observe();
    const snap = await h.snapshot();
    for (const [taskId, version] of [[a, 2], [b, 3]]) {
      const notifications = snap.notifications.filter(n => n.taskId === taskId);
      assert.equal(notifications.length, 1, 'one notification per taskId/version');
      assert.equal(notifications[0].notificationId, operationId('agent-notification:' + taskId + ':' + version));
    }
    await h.bridge.observe();
    assert.equal((await h.snapshot()).notifications.length, 2, 'replay does not duplicate either notification');
  } finally { await h.close(); }
});

test('通知桥：运行中进度不触发模型，仅确认终态投递', async () => {
  const taskId = randomUUID();
  const h = await harness([{ text: '启动', toolIntents: [{ callId: 'c1', name: 'course_operation', arguments: { executionMode: 'background' } }] }, { text: '受理已知', toolIntents: [] }],
    { toolFactory: () => backgroundTools([taskId]) });
  try {
    const receipt = await h.runtime.submit(h.identity, h.input('启动实验'));
    await h.runtime.drain();
    await h.registerTask(taskId, receipt.turnId, { state: 'running', confirmedSeq: 2 });
    await h.bridge.observe();
    let snap = await h.snapshot();
    assert.equal(snap.notifications.length, 0, '运行中不登记通知');
    assert.equal(snap.turns.filter(t => t.trigger === 'task-notification').length, 0, '运行中不唤醒');
    // Unconfirmed terminal (unknown knowledge) is not delivered either.
    await h.taskStorage.request({ requestId: 'unk:' + taskId, fingerprint: 'unk' }, async tx => { await tx.query("UPDATE execution_commands SET state='succeeded', status_knowledge='unknown', confirmed_seq=3 WHERE request_id=$1", [taskId]); return null; });
    await h.bridge.observe();
    snap = await h.snapshot();
    assert.equal(snap.notifications.length, 0, '未确认终态不投递');
    await h.setTaskState(taskId, 'succeeded', 4);
    await h.bridge.observe();
    snap = await h.snapshot();
    assert.equal(snap.notifications.length, 1, '确认终态才投递');
  } finally { await h.close(); }
});

test('通知桥：来源 Turn 被 Stop → 不自动唤醒，接纳时 suppressed', async () => {
  const taskId = randomUUID();
  const b = blockingBackgroundTools([taskId]);
  const h = await harness([{ text: '启动并阻塞', toolIntents: [{ callId: 'c1', name: 'course_operation', arguments: { executionMode: 'background' } }, { callId: 'c2', name: 'block', arguments: {} }] }, { text: '继续', toolIntents: [] }],
    { toolFactory: () => b.tools });
  try {
    const receipt = await h.runtime.submit(h.identity, h.input('启动实验'));
    await waitFor(() => b.started.length === 1);
    await h.registerTask(taskId, receipt.turnId, { state: 'succeeded', confirmedSeq: 1 });
    await h.runtime.stop(h.identity, h.session.sessionId, receipt.turnId, randomUUID());
    b.release();
    await h.runtime.drain();
    await h.bridge.observe();
    let snap = await h.snapshot();
    assert.equal(snap.turns.filter(t => t.trigger === 'task-notification').length, 0, '来源 stopped 不自动唤醒');
    const notification = snap.notifications.find(n => n.taskId === taskId);
    assert.ok(notification, '终态仍登记为可查通知');
    assert.equal(notification.state, 'pending');
    // A later user Turn adopts inputs; the stopped-origin notification is suppressed, not injected.
    await h.runtime.submit(h.identity, h.input('新的问题'));
    await h.runtime.drain();
    snap = await h.snapshot();
    assert.equal(snap.notifications.find(n => n.taskId === taskId).state, 'suppressed', '接纳时复查来源并 suppressed');
    const userTurn = snap.turns.find(t => t.trigger === 'user' && t.turnId !== receipt.turnId);
    const step = snap.steps.find(s => s.turnId === userTurn.turnId);
    assert.ok(!step.snapshot.notificationIds.includes(notification.notificationId), '不塞入后来的用户 Turn');
  } finally { await h.close(); }
});

test('通知桥：busy 时入队下个 Step 接纳，不打断当前 Turn', async () => {
  const taskId = randomUUID();
  const b = blockingBackgroundTools([taskId]);
  // Turn 1 registers the background task and completes; Turn 2 holds open with a blocking tool.
  const h = await harness([
    { text: '启动', toolIntents: [{ callId: 'c1', name: 'course_operation', arguments: { executionMode: 'background' } }] },
    { text: '受理已知', toolIntents: [] },
    { text: '阻塞', toolIntents: [{ callId: 'c2', name: 'block', arguments: {} }] },
    { text: '看到通知', toolIntents: [] },
  ], { toolFactory: () => b.tools });
  try {
    const first = await h.runtime.submit(h.identity, h.input('启动实验'));
    await h.runtime.drain();
    await h.registerTask(taskId, first.turnId, { state: 'succeeded', confirmedSeq: 1 });
    const second = await h.runtime.submit(h.identity, h.input('做别的事'));
    await waitFor(() => b.started.length === 1);
    await h.bridge.observe();
    let snap = await h.snapshot();
    assert.equal(snap.turns.filter(t => t.trigger === 'task-notification').length, 0, 'busy 不另开 Turn');
    assert.equal(snap.notifications.find(n => n.taskId === taskId).state, 'pending', 'busy 时排队');
    b.release();
    await h.runtime.drain();
    snap = await h.snapshot();
    const notification = snap.notifications.find(n => n.taskId === taskId);
    assert.equal(notification.state, 'adopted', '下个 Step 边界接纳');
    assert.equal(notification.consumedByStepId, snap.steps.find(s => s.turnId === second.turnId && s.snapshot.notificationIds.includes(notification.notificationId))?.stepId);
  } finally { await h.close(); }
});

test('取消：仅取消当前 Turn 发起的非终态任务，先前 Turn 任务保留', async () => {
  const oldA = randomUUID(), oldB = randomUUID(), current = randomUUID();
  const b = blockingBackgroundTools([oldA, oldB, current]);
  const h = await harness([
    { text: '旧任务', toolIntents: [{ callId: 'a', name: 'course_operation', arguments: { executionMode: 'background' } }, { callId: 'b', name: 'course_operation', arguments: { executionMode: 'background' } }] },
    { text: '受理已知', toolIntents: [] },
    { text: '新任务', toolIntents: [{ callId: 'c', name: 'course_operation', arguments: { executionMode: 'background' } }, { callId: 'd', name: 'block', arguments: {} }] },
  ], { toolFactory: () => b.tools });
  try {
    const turn1 = await h.runtime.submit(h.identity, h.input('启动两个旧任务'));
    await h.runtime.drain();
    await h.registerTask(oldA, turn1.turnId, { state: 'running' });
    await h.registerTask(oldB, turn1.turnId, { state: 'running' });
    const turn2 = await h.runtime.submit(h.identity, h.input('启动新任务'));
    await waitFor(() => b.started.length === 1);
    await h.registerTask(current, turn2.turnId, { state: 'running' });
    // Enumerate at the public port: only the current, still-active Turn's non-terminal task.
    const listed = await h.bridge.taskCancellation.listNonTerminal(h.session.sessionId, turn2.turnId);
    assert.deepEqual(listed.map(t => t.taskId), [current], '仅当前 Turn 任务');
    await h.runtime.stop(h.identity, h.session.sessionId, turn2.turnId, randomUUID());
    b.release();
    await h.runtime.drain();
    await h.bridge.drain();
    const state = async id => (await h.taskStorage.read('SELECT state FROM execution_commands WHERE request_id=$1', [id])).rows[0].state;
    assert.equal(await state(current), 'cancelled', '当前 Turn 任务被取消');
    assert.equal(await state(oldA), 'running', '先前 Turn 任务不受影响');
    assert.equal(await state(oldB), 'running', '先前 Turn 任务不受影响');
    // Idempotent: a second cancellation delivery does not error or change facts.
    await h.bridge.taskCancellation.cancel(h.session.sessionId, current);
    assert.equal(await state(current), 'cancelled');
  } finally { await h.close(); }
});

test('取消：Stop 后进程重启继续投递持久取消意图', async () => {
  const taskId = randomUUID();
  const b = blockingBackgroundTools([taskId]);
  const h = await harness([
    { text: '新任务', toolIntents: [{ callId: 'c', name: 'course_operation', arguments: { executionMode: 'background' } }, { callId: 'd', name: 'block', arguments: {} }] },
    { text: '受理已知', toolIntents: [] },
  ], { toolFactory: () => b.tools, cancelFails: true });
  try {
    const turn = await h.runtime.submit(h.identity, h.input('启动任务'));
    await waitFor(() => b.started.length === 1);
    await h.registerTask(taskId, turn.turnId, { state: 'running' });
    const stopped = await h.runtime.stop(h.identity, h.session.sessionId, turn.turnId, randomUUID());
    assert.equal(stopped.state, 'stopped');
    b.release();
    await h.runtime.drain().catch(() => {}); // cancel delivery intentionally fails; drain surfaces it
    // The kernel recorded a pending cancel intent in the same transaction as stopped; delivery failed.
    const controls = await h.storage.read("SELECT body FROM agent_controls WHERE operation='cancel-turn'");
    assert.equal(controls.rows.length, 1);
    assert.equal(controls.rows[0].body.state, 'pending', '取消投递失败后意图仍为 pending');
    // Simulate restart: a fresh cancellation runner resumes the pending intent with a working owner.
    const { createCancellationRunner, createAgentStore } = await import('../../agent-runtime/dist/index.js');
    const store = createAgentStore(h.storage, { ownerInstanceId: 'restart' });
    const workingOwner = { listNonTerminal: async (s, t) => (await h.owner.listByOriginTurn(s, t)).map(r => ({ taskId: r.taskId })),
      async cancel(_s, t) { await h.taskStorage.request({ requestId: 'restart-cancel:' + t, fingerprint: t }, async tx => {
        await tx.query("UPDATE execution_commands SET state='cancelled', status_knowledge='confirmed', confirmed_seq=confirmed_seq+1 WHERE request_id=$1 AND state NOT IN ('succeeded','failed','cancelled')", [t]);
        return null; }); } };
    const runner = createCancellationRunner(store, workingOwner, { setTimeout: (cb, ms) => { const t = setTimeout(cb, ms); t.unref(); return t; }, clearTimeout: t => clearTimeout(t) });
    await runner.resumePending();
    await runner.drain();
    const state = (await h.taskStorage.read('SELECT state FROM execution_commands WHERE request_id=$1', [taskId])).rows[0].state;
    assert.equal(state, 'cancelled', '重启后继续投递取消');
    runner.close();
  } finally { await h.close(); }
});

test('任务事实：确定性筛选——显式引用/继续未解决效果，不灌整本台账', async () => {
  const referenced = randomUUID(), unresolved = randomUUID(), unrelated = randomUUID();
  const b = blockingBackgroundTools([unresolved]);
  const h = await harness([
    { text: '启动', toolIntents: [{ callId: 'c1', name: 'course_operation', arguments: { executionMode: 'background' } }, { callId: 'c2', name: 'block', arguments: {} }] },
    { text: '继续处理', toolIntents: [] },
  ], { toolFactory: () => b.tools, cancelFails: true });
  try {
    const turn1 = await h.runtime.submit(h.identity, h.input('启动实验'));
    await waitFor(() => b.started.length === 1);
    await h.registerTask(unresolved, turn1.turnId, { state: 'running' });
    await h.registerTask(referenced, turn1.turnId, { state: 'succeeded', confirmedSeq: 2 });
    await h.registerTask(unrelated, turn1.turnId, { state: 'succeeded', confirmedSeq: 1 });
    await h.runtime.stop(h.identity, h.session.sessionId, turn1.turnId, randomUUID());
    b.release();
    await h.runtime.drain().catch(() => {}); // cancel delivery intentionally fails; task stays unresolved
    // Cancel delivery failed, so the background task remains an unresolved effect of the stopped Turn.
    const continued = await h.runtime.continueSession(h.identity, h.session.sessionId, randomUUID());
    const facts = await h.bridge.taskFacts.relevant({ identity: h.identity, sessionId: h.session.sessionId, turnId: continued.turnId, stepId: randomUUID(), inputIds: [], sessionState: {} }, []);
    const ids = facts.map(f => f.taskId);
    assert.ok(ids.includes(unresolved), '继续时列出尚未确认效果的任务');
    assert.ok(!ids.includes(unrelated), '不自动追加无关旧任务');
    assert.equal(facts.find(f => f.taskId === unresolved).priority, 0, '未解决效果优先');
    // An explicit structured reference selects that task even without an unresolved effect.
    const refInput = { requestId: randomUUID(), sessionId: h.session.sessionId, text: '看看那个任务', context: { taskId: referenced } };
    const refReceipt = await h.runtime.submit(h.identity, refInput);
    const refFacts = await h.bridge.taskFacts.relevant({ identity: h.identity, sessionId: h.session.sessionId, turnId: refReceipt.turnId, stepId: randomUUID(), inputIds: [refReceipt.inputId], sessionState: {} }, []);
    assert.ok(refFacts.some(f => f.taskId === referenced), '显式引用选入对应任务事实');
  } finally { await h.close(); }
});