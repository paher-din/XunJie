import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentRuntime, createAgentStore, agentRuntimeMigrations, validateAgentRuntime } from '../dist/index.js';

const connection = { routeId: randomUUID(), version: 1, maxOutputTokens: 4096, contextWindow: 1_000_000,
  protocol: 'openai-chat', parameterMode: 'plain', capabilities: {}, hasCredential: true, adapterState: 'ready' };
/** A scripted Gateway: each dispatch returns the next queued response. */
function mockGateway(responses, faults = {}) {
  const queue = [...responses];
  const segments = new Map();
  const attempts = new Map();
  const settles = [];
  let sequence = 0;
  const segment = (segmentId, seq) => ({ sessionId: undefined, segmentId, formatVersion: 1, sequence: seq,
    connection, prefixDigest: '0'.repeat(64), resultRef: null, pending: false, closed: false, pendingTools: [] });
  return {
    calls: { dispatched: [] }, settles,
    selection: {
      read: async () => ({ selected: true, version: 1 }),
      snapshot: async () => ({ choice: { connection }, source: { kind: 'personal', ownerScope: 's', feeSource: 'f' } }),
      pin: async () => ({ choice: { connection }, source: { kind: 'personal', ownerScope: 's', feeSource: 'f' } }),
      pinSource: async () => ({}), pinned: async () => ({}), resolveChoice: async () => ({}),
    },
    segments: {
      create: async (_identity, input) => { const s = segment(input.segmentId, sequence); segments.set(input.segmentId, s); return s; },
      read: async (_identity, segmentId) => segments.get(segmentId),
      settle: async (_identity, segmentId, input) => { settles.push(input); const s = segments.get(segmentId); s.sequence = input.expectedSequence + 1; s.pendingTools = []; return s; },
      close: async (_identity, segmentId) => { const s = segments.get(segmentId); s.closed = true; return { ...s, boundary: { owner: { environmentId: 'e', serviceId: 's' }, segmentId, sequence: s.sequence, routeId: connection.routeId, resultRef: null } }; },
    },
    checks: {
      receive: async (_identity, input) => { const a = { attemptId: input.attemptId, state: 'accepted', physicalRequestEnded: false, dispatched: false, cancelRequested: false, text: '', usage: { state: 'unknown' }, requestRef: randomUUID(), resultRef: null, reason: '', upstreamStopped: 'unknown', createdAt: new Date().toISOString(), purpose: 'learning', connection, limits: input.limits }; attempts.set(input.attemptId, a); return a; },
      dispatch: async (_identity, attemptId) => { const a = attempts.get(attemptId);
        if (faults.dispatchFailures) { faults.dispatchFailures--; throw new Error('temporarily unavailable'); }
        const r = queue.shift() ?? { text: '完成', toolIntents: [] };
        if (r.unknown) { Object.assign(a, { state: 'unknown', physicalRequestEnded: false, dispatched: true, text: '', toolIntents: [],
          usage: { state: 'unknown' }, resultRef: null }); return a; }
        Object.assign(a, { state: 'completed', physicalRequestEnded: true, dispatched: true, text: r.text, toolIntents: r.toolIntents ?? [], usage: { state: 'final', inputTokens: 10, outputTokens: 5 }, resultRef: randomUUID(), segment: { segmentId: r.segmentId ?? [...segments.keys()][0], sequence: 0 } });
        return a; },
      read: async (_identity, attemptId) => attempts.get(attemptId),
      progress: async () => null, summary: async () => null, requestPayload: async () => ({}),
      cancel: async (_identity, attemptId) => attempts.get(attemptId),
    },
    results: { retain: async () => null },
    images: { upload: async () => ({}), read: async () => ({}) },
  };
}
function echoTool(name = 'echo') {
  return { definition: { name, description: '回显', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
    supportsBackground: false,
    async execute(call) { return { kind: 'completed', outcome: 'success', summary: 'echo:' + (call.input.value ?? '') }; } };
}
function scenario(tools) {
  return { id: 'test', version: 1,
    async context() { return { system: '测试助手', facts: {}, sources: [] }; },
    async tools() { return tools; } };
}
async function harness(responses, tools = [echoTool()], faults = {}, budget = undefined) {
  const postgres = await nativeFixture();
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: postgres.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
  const backend = createFileBackend({ id: 'agent', root: join(postgres.root, 'res') });
  const storage = await openStorage({ binding, migrations: agentRuntimeMigrations, backend });
  const gateway = mockGateway(responses, faults);
  const runtime = createAgentRuntime(storage, { authorize: async () => {}, scenario: scenario(tools), gateway, ...(budget ? { budget } : {}) });
  const identity = { kind: 'personal', name: '学生', environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID() };
  const session = { sessionId: randomUUID(), identity, scenario: 'test', createdAt: new Date().toISOString() };
  await runtime.initialize(session);
  const settle = async () => { await runtime.drain(); };
  return { postgres, storage, runtime, gateway, identity, session, settle,
    async close() { await runtime.close(); await storage.close(); await postgres.close(); } };
}
const input = (sessionId, text) => ({ requestId: randomUUID(), sessionId, text, context: {} });

test('一次响应含一个工具：1 Step 派发工具，结果后下一 Step 解释，Turn completed', async () => {
  const h = await harness([
    { text: '调用工具', toolIntents: [{ callId: 'c1', name: 'echo', arguments: { value: 'hi' } }] },
    { text: '工具已完成', toolIntents: [] },
  ]);
  try {
    const receipt = await h.runtime.submit(h.identity, input(h.session.sessionId, '请回显'));
    await h.settle();
    const snapshot = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    const turn = snapshot.turns.find(t => t.turnId === receipt.turnId);
    assert.equal(turn.state, 'completed');
    assert.equal(snapshot.steps.length, 2, '工具批次后需要第二个 Step 解释结果');
    assert.equal(snapshot.toolCalls.length, 1);
    assert.equal(snapshot.toolCalls[0].state, 'closed');
    assert.equal(snapshot.toolCalls[0].result.kind, 'completed');
    assert.equal(snapshot.toolCalls[0].result.summary, 'echo:hi');
    assert.ok(snapshot.steps.every(s => s.state === 'completed'));
  } finally { await h.close(); }
});

test('工具返回的图像引用随 settleTools 反馈给模型', async () => {
  const image = { imageId: randomUUID(), version: 1 };
  const see = { definition: { name: 'see', description: '读取页图', inputSchema: { type: 'object' } }, supportsBackground: false,
    async execute() { return { kind: 'completed', outcome: 'success', summary: '已保留页图', data: { visualPages: [1] }, images: [image] }; } };
  const h = await harness([
    { text: '读取页图', toolIntents: [{ callId: 'c1', name: 'see', arguments: {} }] },
    { text: '已看到页图', toolIntents: [] },
  ], [see]);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '请查看页图'));
    await h.settle();
    assert.deepEqual(h.gateway.settles.at(-1).results.at(-1).images, [image]);
  } finally { await h.close(); }
});

test('主模型暂时失败再成功：同一 Step 多 Attempt，工具只执行成功响应一次', async () => {
  const h = await harness([
    { text: '调用工具', toolIntents: [{ callId: 'c1', name: 'echo', arguments: { value: 'retry' } }] },
    { text: '工具已完成', toolIntents: [] },
  ], [echoTool()], { dispatchFailures: 1 }, { maxSteps: 16, maxToolCalls: 64, maxInputTokens: 2_200_000, maxOutputTokens: 65_536, maxCallMs: 600_000 });
  try {
    const receipt = await h.runtime.submit(h.identity, input(h.session.sessionId, '请回显'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.steps.length, 2);
    const attempts = snap.attempts.filter(a => a.stepId === snap.steps[0].stepId).sort((a, b) => a.attemptNo - b.attemptNo);
    assert.deepEqual(attempts.map(a => a.state), ['failed', 'completed']);
    assert.equal(snap.toolCalls.length, 1, '只有成功响应派发工具');
    assert.equal(snap.toolCalls[0].result.summary, 'echo:retry');
    assert.equal(snap.turns.find(t => t.turnId === receipt.turnId).state, 'completed');
  } finally { await h.close(); }
});

test('完整响应前断流：不派发工具、不伪造完成，Attempt 失败可查', async () => {
  const h = await harness([{ unknown: true }], [echoTool()]);
  try {
    const receipt = await h.runtime.submit(h.identity, input(h.session.sessionId, '开始生成'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.turns.find(t => t.turnId === receipt.turnId).state, 'failed');
    assert.equal(snap.steps.length, 1);
    assert.equal(snap.toolCalls.length, 0, '未形成完整有效响应，零派发');
    assert.equal(snap.attempts.length, 1);
    assert.equal(snap.attempts[0].state, 'failed');
    assert.equal(snap.attempts[0].error, 'result-unknown');
  } finally { await h.close(); }
});

test('两个后台调用：受理过程串行，两个稳定 taskId', async () => {
  const started = [];
  const job = { definition: { name: 'course_operation', description: '长任务', inputSchema: { type: 'object' } }, supportsBackground: true,
    async execute(call) { started.push(call.executionMode); return { kind: 'accepted', taskId: 'task-' + call.callIndex, summary: '已受理' }; } };
  const h = await harness([
    { text: '两个后台任务', toolIntents: [{ callId: 'c1', name: 'course_operation', arguments: { executionMode: 'background' } },
      { callId: 'c2', name: 'course_operation', arguments: { executionMode: 'background' } }] },
    { text: '受理已知', toolIntents: [] },
  ], [job]);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '两个实验'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.deepEqual(snap.toolCalls.map(c => c.result.taskId), ['task-0', 'task-1']);
    assert.deepEqual(started, ['background', 'background']);
    assert.equal(snap.steps.length, 2, '两个受理回执同属一个 Step');
  } finally { await h.close(); }
});

function blockingTool(name = 'block') {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const started = [];
  return { release, started, tool: { definition: { name, description: '阻塞', inputSchema: { type: 'object' } },
    supportsBackground: false, async execute(call) { started.push(call.toolCallId); await gate; return { kind: 'completed', outcome: 'success', summary: 'done' }; } } };
}
const waitFor = async (fn, timeout = 4000) => { const end = Date.now() + timeout; while (Date.now() < end) { const v = await fn(); if (v) return v; await new Promise(r => setTimeout(r, 20)); } throw new Error('waitFor timeout'); };

test('steering：批次中途的新消息在整个 Step 完成后才被下一 Step 接纳', async () => {
  const b = blockingTool();
  const h = await harness([
    { text: '调用阻塞工具', toolIntents: [{ callId: 'c1', name: 'block', arguments: {} }] },
    { text: '看到补充', toolIntents: [] },
  ], [b.tool]);
  try {
    const r1 = await h.runtime.submit(h.identity, input(h.session.sessionId, '第一条'));
    await waitFor(() => b.started.length === 1);
    const r2 = await h.runtime.submit(h.identity, input(h.session.sessionId, '补充消息'));
    assert.equal(r2.turnId, r1.turnId, '活跃 Turn 的新消息是 steering，不新建 Turn');
    let snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.inputs.find(i => i.inputId === r2.inputId).state, 'pending', '批次进行中仍 pending');
    b.release();
    await h.settle();
    snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.turns[0].state, 'completed');
    assert.equal(snap.inputs.find(i => i.inputId === r2.inputId).state, 'adopted');
    assert.equal(snap.steps.length, 2);
    assert.deepEqual(snap.steps[1].snapshot.inputIds, [r2.inputId], '第二 Step 才接纳 steering');
  } finally { await h.close(); }
});

test('Stop：停止当前 Turn，未启动工具 not_started，持久取消意图', async () => {
  const b = blockingTool();
  const h = await harness([
    { text: '两个工具', toolIntents: [{ callId: 'c1', name: 'block', arguments: {} }, { callId: 'c2', name: 'block', arguments: {} }] },
  ], [b.tool]);
  try {
    const r = await h.runtime.submit(h.identity, input(h.session.sessionId, '开始'));
    await waitFor(() => b.started.length === 1);
    const stopped = await h.runtime.stop(h.identity, h.session.sessionId, r.turnId, randomUUID());
    assert.equal(stopped.state, 'stopped');
    b.release();
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    const calls = snap.toolCalls.sort((a, b2) => a.callIndex - b2.callIndex);
    assert.equal(calls[1].result.kind, 'not_started', '第二个工具未启动');
    const controls = await h.storage.read("SELECT body FROM agent_controls WHERE operation='cancel-turn'");
    assert.equal(controls.rows.length, 1, '停止与取消意图同事务保存');
  } finally { await h.close(); }
});

test('提问：student_ask 等待真实回答，答案保存后继续同批', async () => {
  const askTool = { definition: { name: 'student_ask', description: '提问', inputSchema: { type: 'object' } }, supportsBackground: false,
    async execute(call, ctx) { const outcome = await ctx.ask({ presentation: { question: '同意吗？', options: [{ id: 'yes', label: '同意' }], allowText: false, skippable: false }, deadline: new Date(Date.now() + 60000).toISOString() });
      return { kind: 'completed', outcome: 'success', summary: outcome.kind === 'answered' ? 'answered:' + outcome.answer.optionId : outcome.kind }; } };
  const h = await harness([
    { text: '提问', toolIntents: [{ callId: 'c1', name: 'student_ask', arguments: {} }] },
    { text: '收到回答', toolIntents: [] },
  ], [askTool]);
  try {
    const r = await h.runtime.submit(h.identity, input(h.session.sessionId, '请问我'));
    const question = await waitFor(async () => (await h.runtime.sessionSnapshot(h.identity, h.session.sessionId)).questions.find(q => q.state === 'pending'));
    assert.ok(question, '问题已保存并等待');
    const receipt = await h.runtime.answerQuestion(h.identity, h.session.sessionId, { requestId: randomUUID(), questionId: question.questionId, expectedVersion: question.version, answer: { kind: 'choice', optionId: 'yes' } });
    assert.equal(receipt.status, 'accepted');
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.turns[0].state, 'completed');
    assert.equal(snap.toolCalls[0].result.summary, 'answered:yes');
    assert.equal(snap.questions[0].state, 'answered');
    // A real answer is a SessionInput with its own immutable receipt; the source closure must accept it.
    await validateAgentRuntime(h.storage);
    assert.ok(await h.storage.receipt('agent-answer:' + receipt.requestId), '回答回执存在');
    assert.equal(await h.storage.receipt('agent-input:' + receipt.requestId), null, '回答不伪造 agent-input 回执');
  } finally { await h.close(); }
});

test('后台：显式 background 返回 accepted 回执，Step 不等任务终态', async () => {
  const bgTool = { definition: { name: 'course_operation', description: '长任务', inputSchema: { type: 'object' } }, supportsBackground: true,
    async execute() { return { kind: 'accepted', taskId: 'task-1', summary: '已受理' }; } };
  const h = await harness([
    { text: '后台任务', toolIntents: [{ callId: 'c1', name: 'course_operation', arguments: { executionMode: 'background' } }] },
    { text: '受理已知', toolIntents: [] },
  ], [bgTool]);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '启动实验'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.turns[0].state, 'completed');
    assert.equal(snap.toolCalls[0].result.kind, 'accepted');
    assert.equal(snap.toolCalls[0].taskId, 'task-1');
    assert.equal(snap.toolCalls[0].executionMode, 'background');
  } finally { await h.close(); }
});

test('普通工具擅传 background：参数错误结果，不静默转后台', async () => {
  const h = await harness([
    { text: '误用后台', toolIntents: [{ callId: 'c1', name: 'echo', arguments: { value: 'x', executionMode: 'background' } }] },
    { text: '结束', toolIntents: [] },
  ], [echoTool()]);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, 'hi'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.toolCalls[0].executionMode, 'background');
    assert.equal(snap.toolCalls[0].result.kind, 'completed');
    assert.equal(snap.toolCalls[0].result.outcome, 'error');
  } finally { await h.close(); }
});

test('响应超过8项工具：整体协议错误，零派发', async () => {
  const intents = Array.from({ length: 9 }, (_, i) => ({ callId: 'c' + i, name: 'echo', arguments: { value: String(i) } }));
  const h = await harness([{ text: '过多工具', toolIntents: intents }], [echoTool()]);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, 'hi'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.turns[0].state, 'failed');
    assert.equal(snap.turns[0].reason, 'protocol-error');
    assert.equal(snap.toolCalls.length, 0, '不派发任何工具');
  } finally { await h.close(); }
});

test('通知：空闲时来源正常完成的通知自动开启新 Turn', async () => {
  const h = await harness([{ text: '完成', toolIntents: [] }, { text: '通知已处理', toolIntents: [] }]);
  try {
    const r = await h.runtime.submit(h.identity, input(h.session.sessionId, 'hi'));
    await h.settle();
    assert.equal((await h.runtime.sessionSnapshot(h.identity, h.session.sessionId)).turns[0].state, 'completed');
    const result = await h.runtime.registerNotification(h.identity, h.session.sessionId, r.turnId, { taskId: 't1', taskVersion: 'v1', terminalStatus: 'success', summary: '实验完成', resultRef: null });
    assert.ok(result.turnId, '空闲+来源completed → 新 Turn');
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    const newTurn = snap.turns.find(t => t.turnId === result.turnId);
    assert.equal(newTurn.trigger, 'task-notification');
    assert.equal(newTurn.state, 'completed');
    assert.equal(snap.notifications[0].state, 'adopted');
  } finally { await h.close(); }
});

test('deferred：停止后未接纳消息保留，手动继续按序带入新 Turn', async () => {
  const b = blockingTool();
  const h = await harness([
    { text: '阻塞', toolIntents: [{ callId: 'c1', name: 'block', arguments: {} }] },
    { text: '继续处理', toolIntents: [] },
  ], [b.tool]);
  try {
    const r = await h.runtime.submit(h.identity, input(h.session.sessionId, '第一条'));
    await waitFor(() => b.started.length === 1);
    const r2 = await h.runtime.submit(h.identity, input(h.session.sessionId, '待处理消息'));
    await h.runtime.stop(h.identity, h.session.sessionId, r.turnId, randomUUID());
    b.release();
    await h.settle();
    let snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.inputs.find(i => i.inputId === r2.inputId).state, 'deferred');
    const continued = await h.runtime.continueSession(h.identity, h.session.sessionId, randomUUID());
    await h.settle();
    snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(continued.trigger, 'continue');
    assert.equal(snap.inputs.find(i => i.inputId === r2.inputId).state, 'adopted', '继续时带入 deferred');
    assert.equal(snap.inputs.find(i => i.inputId === r2.inputId).turnId, continued.turnId);
    // The move is recorded so content origin (input-received) and consumption Turn stay distinguishable.
    const adopted = (await h.storage.read("SELECT body FROM agent_events WHERE kind='input-adopted'")).rows.map(row => row.body);
    assert.equal(adopted.length, 1);
    assert.equal(adopted[0].inputId, r2.inputId);
    assert.equal(adopted[0].turnId, continued.turnId);
    await validateAgentRuntime(h.storage);
  } finally { await h.close(); }
});

test('串行时间线：A前台结束才提交B后台，B受理才开始C前台，Step不等B终态', async () => {
  const events = [];
  const fg = name => ({ definition: { name, description: name, inputSchema: { type: 'object' } }, supportsBackground: false,
    async execute() { events.push(name + ':start'); await Promise.resolve(); events.push(name + ':end'); return { kind: 'completed', outcome: 'success', summary: name }; } });
  const bg = { definition: { name: 'B', description: '长任务', inputSchema: { type: 'object' } }, supportsBackground: true,
    async execute() { events.push('B:start'); await Promise.resolve(); events.push('B:accepted'); return { kind: 'accepted', taskId: 'task-B', summary: '受理' }; } };
  const h = await harness([
    { text: '三项', toolIntents: [
      { callId: 'a', name: 'A', arguments: {} },
      { callId: 'b', name: 'B', arguments: { executionMode: 'background' } },
      { callId: 'c', name: 'C', arguments: {} }] },
    { text: '解释结果', toolIntents: [] },
  ], [fg('A'), bg, fg('C')]);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, 'hi'));
    await h.settle();
    assert.deepEqual(events, ['A:start', 'A:end', 'B:start', 'B:accepted', 'C:start', 'C:end']);
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.turns[0].state, 'completed');
    assert.equal(snap.toolCalls.length, 3);
    assert.equal(snap.toolCalls[1].result.kind, 'accepted');
    assert.equal(snap.steps.length, 2, '工具批次后下一 Step 解释');
  } finally { await h.close(); }
});

test('通知：已入队通知的来源 Turn 随后被 Stop，接纳时复查并 suppressed，不进入后来 Turn', async () => {
  const b = blockingTool();
  const h = await harness([
    { text: '阻塞', toolIntents: [{ callId: 'c1', name: 'block', arguments: {} }] },
    { text: '结束', toolIntents: [] },
    { text: '结束', toolIntents: [] },
  ], [b.tool]);
  try {
    const r = await h.runtime.submit(h.identity, input(h.session.sessionId, '第一条'));
    await waitFor(() => b.started.length === 1);
    const note = await h.runtime.registerNotification(h.identity, h.session.sessionId, r.turnId,
      { taskId: 'task-1', taskVersion: 'v1', terminalStatus: 'success', summary: '完成', resultRef: null });
    assert.equal(note.turnId, null, '活跃会话先入队，不立即开 Turn');
    await h.runtime.stop(h.identity, h.session.sessionId, r.turnId, randomUUID());
    b.release();
    await h.settle();
    await h.runtime.continueSession(h.identity, h.session.sessionId, randomUUID());
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.notifications[0].state, 'suppressed');
  } finally { await h.close(); }
});


async function seedOpenCall(h, state) {
  const old = createAgentStore(h.storage, { ownerInstanceId: 'old-owner' });
  const receipt = await old.submitInput(input(h.session.sessionId, '原始请求'));
  const opened = await old.openStep(receipt.turnId, {}, true);
  const stepId = opened.step.stepId, attemptId = randomUUID(), toolCallId = randomUUID(), questionId = randomUUID();
  await old.saveAttempt(stepId, { attemptId, attemptNo: 1, requestRef: null, reserved: { inputTokens: 100, outputTokens: 100 } });
  await old.saveResponse(stepId, attemptId, { text: 'ask', toolIntents: [], resultRef: null },
    [{ toolCallId, nativeCallId: 'c1', name: 'student_ask', input: {}, executionMode: 'foreground' }]);
  await old.startToolCall(toolCallId);
  await old.saveQuestion({ questionId, sessionId: h.session.sessionId, turnId: receipt.turnId, stepId, toolCallId,
    presentation: { question: '确认？', options: [{ id: 'confirm', label: '确认' }], allowText: true, skippable: true }, deadline: null });
  if (state === 'answered') await old.answerQuestion(h.session.sessionId, { requestId: randomUUID(), questionId, expectedVersion: 1, answer: { kind: 'choice', optionId: 'confirm' } });
  return { old, receipt, stepId, attemptId, toolCallId, questionId };
}

test('K04/K05：重启修复对已回答的问题保留真实结果，未答的关闭，failed/Stop 闭合全部子记录', async () => {
  for (const state of ['pending', 'answered', 'failed', 'stopped']) {
    const h = await harness([]); await h.runtime.close();
    try {
      const seeded = await seedOpenCall(h, state === 'answered' ? 'answered' : 'pending');
      if (state === 'failed') await seeded.old.finishTurn(seeded.receipt.turnId, 'failed', 'internal-error');
      if (state === 'stopped') await seeded.old.stopTurn(h.session.sessionId, seeded.receipt.turnId, randomUUID());
      const next = createAgentStore(h.storage, { ownerInstanceId: 'new-owner' });
      await next.recoverInterrupted();
      const snap = await next.sessionSnapshot(h.session.sessionId);
      const call = snap.toolCalls[0], question = snap.questions[0];
      assert.equal(snap.turns[0].state === 'active', false);
      assert.equal(call.state, 'closed');
      if (state === 'answered') {
        assert.equal(call.result.kind, 'completed');
        assert.equal(call.result.data.answerState, 'answered');
        assert.equal(question.state, 'answered');
      } else if (state === 'pending') {
        assert.equal(call.result.kind, 'interrupted');
        assert.equal(question.state, 'closed');
      } else {
        assert.equal(snap.steps[0].state === 'generating' || snap.steps[0].state === 'executing', false);
        assert.equal(question.state === 'pending', false);
      }
      await validateAgentRuntime(next.storage);
    } finally { await h.storage.close(); await h.postgres.close(); }
  }
});

test('K03：Turn deadline 让阻塞工具终止，Turn 记录 deadline-exceeded，不伪造结果', async () => {
  const hang = { definition: { name: 'hang', description: '阻塞', inputSchema: { type: 'object' } },
    supportsBackground: false, async execute() { return new Promise(() => {}); } };
  const h = await harness([{ text: '调用', toolIntents: [{ callId: 'c1', name: 'hang', arguments: {} }] }], [hang], {}, { hardDeadlineMs: 700, maxCallMs: 5000 });
  try {
    const receipt = await h.runtime.submit(h.identity, input(h.session.sessionId, '开始'));
    await waitFor(async () => (await h.runtime.sessionSnapshot(h.identity, h.session.sessionId)).toolCalls.length === 1, 3000);
    await new Promise(r => setTimeout(r, 900));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    const turn = snap.turns.find(t => t.turnId === receipt.turnId);
    assert.equal(turn.state, 'failed');
    assert.equal(turn.reason, 'deadline-exceeded');
    assert.equal(snap.steps[0].state, 'failed');
    const call = snap.toolCalls[0];
    assert.equal(call.state, 'closed');
    assert.equal(call.result.kind, 'outcome_unknown');
    await validateAgentRuntime(h.storage);
  } finally { await h.close(); }
});

test('K06：来源已正常完成的通知在 Stop 当前 Turn 后自动开启且只开启一个 task-notification Turn', async () => {
  const b = blockingTool();
  const h = await harness([{ text: '第一', toolIntents: [] },
    { text: '第二', toolIntents: [{ callId: 'c1', name: 'block', arguments: {} }] },
    { text: '通知结果', toolIntents: [] }], [b.tool]);
  try {
    const first = await h.runtime.submit(h.identity, input(h.session.sessionId, '第一条'));
    await h.settle();
    const second = await h.runtime.submit(h.identity, input(h.session.sessionId, '第二条'));
    await waitFor(() => b.started.length === 1);
    const note = await h.runtime.registerNotification(h.identity, h.session.sessionId, first.turnId,
      { taskId: 'earlier-task', taskVersion: 'v1', terminalStatus: 'success', summary: '完成', resultRef: null });
    assert.equal(note.turnId, null);
    await h.runtime.stop(h.identity, h.session.sessionId, second.turnId, randomUUID());
    b.release();
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    const notifications = snap.turns.filter(t => t.trigger === 'task-notification');
    assert.equal(notifications.length, 1);
    assert.equal(notifications[0].state, 'completed');
    assert.equal(snap.notifications[0].state, 'adopted');
    assert.equal(snap.notifications[0].consumedByStepId !== null, true);
    await validateAgentRuntime(h.storage);
  } finally { b.release(); await h.close(); }
});

test('K01：第二个宿主无法在同一 service 上取得锁，也不会开始 repair 或接纳', async () => {
  const h = await harness([{ text: '完成', toolIntents: [] }]);
  const second = createAgentRuntime(h.storage, { authorize: async () => {}, scenario: scenario([echoTool()]), gateway: mockGateway([]) });
  try {
    const other = { ...h.session, sessionId: randomUUID() };
    await assert.rejects(() => second.initialize(other), /maintenance/);
  } finally { await second.close(); await h.close(); }
});

test('T5：Stop 后迟到受理 accepted 重新打开持久取消意图，重启后仍可投递', async () => {
  const h = await harness([]); await h.runtime.close();
  try {
    const old = createAgentStore(h.storage, { ownerInstanceId: 'old-owner' });
    const receipt = await old.submitInput(input(h.session.sessionId, '创建任务'));
    const opened = await old.openStep(receipt.turnId, {}, true);
    const stepId = opened.step.stepId, attemptId = randomUUID(), toolCallId = randomUUID();
    await old.saveAttempt(stepId, { attemptId, attemptNo: 1, requestRef: null, reserved: { inputTokens: 10, outputTokens: 10 } });
    await old.saveResponse(stepId, attemptId, { text: '后台', toolIntents: [], resultRef: null },
      [{ toolCallId, nativeCallId: 'c1', name: 'task', input: {}, executionMode: 'background' }]);
    await old.startToolCall(toolCallId);
    await old.stopTurn(h.session.sessionId, receipt.turnId, randomUUID());
    let reopened;
    try { reopened = await old.saveToolResult(toolCallId, { kind: 'accepted', taskId: 'late-task', summary: '已受理' }, 'late-task'); }
    catch (e) { console.error('DEBUG-T5', e); throw e; }
    assert.equal(reopened, true);
    const pending = await old.pendingCancellations();
    assert.equal(pending.some(p => p.turnId === receipt.turnId), true);
    const next = createAgentStore(h.storage, { ownerInstanceId: 'new-owner' });
    const resumed = await next.pendingCancellations();
    assert.equal(resumed.some(p => p.turnId === receipt.turnId), true);
    await validateAgentRuntime(next.storage);
  } finally { await h.storage.close(); await h.postgres.close(); }
});
