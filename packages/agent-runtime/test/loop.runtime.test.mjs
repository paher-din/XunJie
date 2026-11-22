import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { join } from 'node:path';
import { createFileBackend, openStorage, provisionStorage } from '@xunjie/storage';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentRuntime, createAgentStore, agentRuntimeMigrations, validateAgentRuntime } from '../dist/index.js';

const connection = { connectionId: randomUUID(), name: '测试模型', routeId: randomUUID(), version: 1,
  maxOutputTokens: 4096, contextWindow: 1_000_000, protocol: 'chat-completions', baseUrl: 'https://example.test/v1',
  path: '/chat/completions', modelId: 'test-model', dialect: 'standard', parameterMode: 'plain', enabled: true,
  capabilities: { text: 'verified', images: 'unknown', tools: 'verified', strictSchema: 'unknown' },
  hasCredential: true, adapterState: 'ready' };
/** A scripted Gateway: each dispatch returns the next queued response. */
function mockGateway(responses, faults = {}) {
  const queue = [...responses];
  const segments = new Map();
  const attempts = new Map();
  const settles = [];
  const segmentConnections = [];
  const segmentInputs = [];
  const forcedClosed = new Set();
  let selected = connection;
  let sequence = 0;
  const segment = (segmentId, seq, projectionId = null) => ({ sessionId: undefined, segmentId, formatVersion: 1, sequence: seq,
    connection: selected, prefixDigest: '0'.repeat(64), projectionId, resultRef: null, pending: false, closed: false, pendingTools: [] });
  const receives = [];
  const calls = { dispatched: [] };
  return {
    calls, settles, segmentConnections, segmentInputs, receives, segments,
    setConnection(value) { selected = value; },
    selection: {
      read: async () => ({ selected: true, version: 1 }),
      snapshot: async () => ({ choice: { connection: selected }, source: { kind: 'personal', ownerScope: 's', feeSource: 'f' } }),
      pin: async () => ({ choice: { connection: selected }, source: { kind: 'personal', ownerScope: 's', feeSource: 'f' } }),
      pinSource: async () => ({}), pinned: async () => ({}), resolveChoice: async () => ({}),
    },
    segments: {
      create: async (_identity, input) => { const s = segment(input.segmentId, sequence, input.projectionId ?? null); segmentConnections.push(s.connection); segmentInputs.push(input); segments.set(input.segmentId, s); return s; },
      read: async (_identity, segmentId) => { const value = segments.get(segmentId);
        return value && forcedClosed.has(segmentId) ? { ...value, closed: true } : value; },
      settle: async (_identity, segmentId, input) => { settles.push(input); const s = segments.get(segmentId); s.sequence = input.expectedSequence + 1; s.pendingTools = []; return s; },
      close: async (_identity, segmentId) => { const s = segments.get(segmentId); s.closed = true; return { ...s, boundary: { owner: { environmentId: 'e', serviceId: 's' }, segmentId, sequence: s.sequence, routeId: connection.routeId, resultRef: null } }; },
    },
    checks: {
      receive: async (_identity, input) => { receives.push(input); const a = { attemptId: input.attemptId, state: 'accepted', physicalRequestEnded: false, dispatched: false, cancelRequested: false, text: '', usage: { state: 'unknown' }, requestRef: randomUUID(), resultRef: null, reason: '', upstreamStopped: 'unknown', createdAt: new Date().toISOString(), purpose: 'learning', connection, limits: input.limits, input: input.input }; attempts.set(input.attemptId, a); return a; },
      dispatch: async (_identity, attemptId) => { const a = attempts.get(attemptId);
        calls.dispatched.push({ attemptId, input: a.input });
        if (faults.dispatchFailures) { faults.dispatchFailures--; throw new Error('temporarily unavailable'); }
        const r = queue.shift() ?? { text: '完成', toolIntents: [] };
        await r.beforeReply?.();
        if (r.unknown) { Object.assign(a, { state: 'unknown', physicalRequestEnded: false, dispatched: true, text: '', toolIntents: [],
          usage: { state: 'unknown' }, resultRef: null }); return a; }
        Object.assign(a, { state: 'completed', physicalRequestEnded: true, dispatched: true, text: r.text, toolIntents: r.toolIntents ?? [], usage: { state: 'final', inputTokens: 10, outputTokens: 5 }, resultRef: randomUUID(), segment: { segmentId: r.segmentId ?? [...segments.keys()][0], sequence: 0 } });
        { const current = segments.get(a.segment.segmentId); if (current) { current.sequence += 1; current.headAttemptId = attemptId; } }
        return a; },
      read: async (_identity, attemptId) => attempts.get(attemptId),
      progress: async () => null, summary: async () => null, requestPayload: async () => ({}),
      ...(faults.capacity ? { capacity: async (_identity, attemptId, remaining) => faults.capacity(attemptId, remaining) } : {}),
      cancel: async (_identity, attemptId) => attempts.get(attemptId),
    },
    results: { retain: async () => null },
    forceCloseSegments() { for (const segmentId of segments.keys()) forcedClosed.add(segmentId); },
    images: { upload: async () => ({}), read: async () => ({}) },
  };
}
function echoTool(name = 'echo') {
  return { definition: { name, description: '回显', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
    supportsBackground: false,
    async execute(call) { return { kind: 'completed', outcome: 'success', summary: 'echo:' + (call.input.value ?? '') }; } };
}
function largeTool(name = 'large', readback = true) {
  return { definition: { name, description: '返回大结果', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
    supportsBackground: false,
    async execute(call) {
      return { kind: 'completed', outcome: 'success', summary: 'x'.repeat(3000) + String(call.input.value ?? ''),
        ...(readback ? { data: { source: { kind: 'work', objectId: randomUUID(), contentId: randomUUID() } } } : {}) };
    } };
}
function scenario(tools) {
  return { id: 'test', version: 1,
    async context() { return { system: '测试助手', facts: {}, sources: [] }; },
    async tools() { return tools; } };
}
async function harness(responses, tools = [echoTool()], faults = {}, budget = undefined, scenarioOverride = undefined) {
  const postgres = await nativeFixture();
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: postgres.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
  const backend = createFileBackend({ id: 'agent', root: join(postgres.root, 'res') });
  const storage = await openStorage({ binding, migrations: agentRuntimeMigrations, backend });
  const gateway = mockGateway(responses, faults);
  const runtime = createAgentRuntime(storage, { authorize: async () => {}, scenario: scenarioOverride ?? scenario(tools), gateway, ...(budget ? { budget } : {}) });
  const identity = { kind: 'personal', name: '学生', environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID() };
  const session = { sessionId: randomUUID(), identity, scenario: 'test', createdAt: new Date().toISOString() };
  await runtime.initialize(session);
  const settle = async () => { await runtime.drain(); };
  return { postgres, storage, runtime, gateway, identity, session, settle,
    async close() { await runtime.close(); await storage.close(); await postgres.close(); } };
}
const input = (sessionId, text) => ({ requestId: randomUUID(), sessionId, text, context: {} });

test('撤权切断旧原生段，移除旧工具正文并拒绝原调用 ID 的出处', async () => {
  let revoked = false;
  const source = { kind: 'work', objectId: randomUUID(), contentId: randomUUID() };
  const tool = { ...echoTool(), async execute() {
    return { kind: 'completed', outcome: 'success', summary: 'revoked-text-marker', data: { source } };
  } };
  const assistant = { ...scenario([tool]), async authorizeHistory(_input, history) {
    return revoked ? history.filter(entry => !entry.sources?.length) : [...history];
  } };
  const handle = await harness([
    { text: '', toolIntents: [{ callId: 'private-call', name: 'echo', arguments: {} }] },
    { text: 'revoked-answer-marker', toolIntents: [] },
    { text: '', toolIntents: [{ callId: 'cite-call', name: 'cite_source', arguments: { claim: '旧依据', toolCallId: 'private-call' } }] },
    { text: '来源不可用', toolIntents: [] },
  ], [tool], {}, undefined, assistant);
  try {
    const { runtime, identity, session, gateway } = handle;
    await runtime.submit(identity, input(session.sessionId, '读取原资料'));
    await handle.settle();
    const initialSegmentCount = gateway.segmentInputs.length;
    revoked = true;
    const next = await runtime.submit(identity, input(session.sessionId, '核对出处'));
    await handle.settle();
    assert.ok(gateway.segmentInputs.length > initialSegmentCount);
    const rebuilt = gateway.segmentInputs.slice(initialSegmentCount);
    assert.ok(rebuilt.every(segment => !JSON.stringify(segment.portable).includes('revoked-')));
    const snapshot = await runtime.sessionSnapshot(identity, session.sessionId);
    assert.equal(snapshot.turns.find(turn => turn.turnId === next.turnId)?.state, 'completed');
    assert.equal(snapshot.toolCalls.find(call => call.name === 'cite_source')?.result?.outcome, 'error');
  } finally { await handle.close(); }
});

test('派发前已提交的原生来源在下一 Turn 失效时触发重建并清空旧回执', async () => {
  const source = { kind: 'work', objectId: randomUUID(), contentId: randomUUID() };
  const material = { materialId: 'M-native', sourceId: 'native-source', kind: 'student-work', author: 'student',
    label: 'v7', version: 'v7', range: null, digest: 'digest', content: 'source-marker', readState: 'included',
    source, citationAllowed: true };
  let revoked = false;
  const assistant = { ...scenario([]),
    async context() { return { system: '测试助手', facts: {}, sources: [], materials: revoked ? [] : [material] }; },
    async authorizeHistory(_input, history) {
      return revoked ? history.filter(entry => !entry.sources?.length) : [...history];
    } };
  const h = await harness([{ unknown: true }, { text: '重建后回答', toolIntents: [] }], [], {}, undefined, assistant);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第一轮丢失回执'));
    await h.settle();
    let state = (await h.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1',
      [h.session.sessionId])).rows[0].state;
    assert.equal(state.nativeHistorySources.length, 1, '请求发出前先保存原生来源回执');
    const initialSegments = h.gateway.segmentInputs.length;
    revoked = true;
    await h.runtime.submit(h.identity, input(h.session.sessionId, '来源已撤回'));
    await h.settle();
    state = (await h.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1',
      [h.session.sessionId])).rows[0].state;
    assert.equal(state.nativeHistorySources.length, 0);
    assert.ok(h.gateway.segmentInputs.length > initialSegments, '撤权后必须新建原生段');
    const rebuilt = h.gateway.segmentInputs.at(-1);
    assert.ok(rebuilt.previousSegmentId);
    assert.equal(JSON.stringify(rebuilt.portable).includes('source-marker'), false);
  } finally { await h.close(); }
});

test('上下文装配后撤权：派发前重新授权并重建，不发送已读材料正文', async () => {
  const source = { kind: 'work', objectId: randomUUID(), contentId: randomUUID() };
  const material = { materialId: 'M-dispatch-revoked', sourceId: 'dispatch-revoked', kind: 'student-work', author: 'student',
    label: 'alu.sv v7', version: 'v7', range: null, digest: 'dispatch-revoked-digest', content: 'DISPATCH_REVOKED_MARKER',
    readState: 'included', source, citationAllowed: true };
  let revoked = false, authorizationCalls = 0;
  const assistant = { ...scenario([]),
    async context() { return { system: '测试助手', facts: {}, sources: [], materials: revoked ? [] : [material] }; },
    async authorizeHistory(_input, history) {
      authorizationCalls++;
      // The first assembly is allowed; revoke immediately after it. The dispatch-time check
      // therefore observes a stale material set and must force a fresh assembly.
      if (authorizationCalls === 1) { revoked = true; return [...history]; }
      return revoked ? history.filter(entry => !entry.sources?.length) : [...history];
    } };
  const h = await harness([{ text: '撤权后回答', toolIntents: [] }], [], {}, undefined, assistant);
  try {
    const receipt = await h.runtime.submit(h.identity, input(h.session.sessionId, '读取这份作品'));
    await h.settle();
    const snapshot = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snapshot.turns.find(turn => turn.turnId === receipt.turnId)?.state, 'completed');
    assert.ok(authorizationCalls >= 3, '装配、派发前检查与重建都必须重新授权');
    assert.equal(h.gateway.receives[0].input.text.includes('DISPATCH_REVOKED_MARKER'), true,
      '首次装配确实读取过旧材料');
    assert.equal(h.gateway.calls.dispatched.length, 1);
    assert.equal(JSON.stringify(h.gateway.calls.dispatched[0].input).includes('DISPATCH_REVOKED_MARKER'), false,
      '撤权材料不得进入实际派发请求');
    assert.equal(JSON.stringify(h.gateway.segmentInputs.at(-1).portable).includes('DISPATCH_REVOKED_MARKER'), false);
  } finally { await h.close(); }
});

test('压缩候选在最终请求容量核验失败时不采用、不派发', async () => {
  let capacityCalls = 0;
  const compact = {
    provider: { id: 'test-summary', version: 1, prompt: () => ({ system: '摘要', text: '摘要输入' }),
      parse: () => ({ facts: [] }) },
    maxPerTurn: 1,
    select(history) {
      const messages = history.slice(0, 1), remainder = history.slice(1);
      return { messages, remainder, sourceDigest: 'a'.repeat(64), retainedDigest: 'b'.repeat(64),
        sourceVersions: { retainedIds: ['context'] }, policy: { maxSummaryTokens: 64 } };
    },
  };
  const compactScenario = { ...scenario([]), compaction: compact };
  const h = await harness([{ text: '第一轮完成', toolIntents: [] }, { text: '摘要', toolIntents: [] }], [], {
    capacity: () => [2, 4, 5].includes(++capacityCalls)
      ? { dispatchable: false, reason: 'context-window', requestFingerprint: 'c'.repeat(64), bytes: 1000,
        inputEstimateTokens: 1000, outputReserveTokens: 64, safetyMarginTokens: 100, contextWindow: 100,
        transportLimitBytes: 1_000_000 }
      : { dispatchable: true, reason: 'ok', requestFingerprint: 'd'.repeat(64), bytes: 1000,
        inputEstimateTokens: 100, outputReserveTokens: 64, safetyMarginTokens: 100, contextWindow: 100_000,
        transportLimitBytes: 1_000_000 },
  }, undefined, compactScenario);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '产生历史' + '旧'.repeat(1024)));
    await h.settle();
    const before = h.gateway.segmentInputs.length;
    const priorAdoption = (await h.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1',
      [h.session.sessionId])).rows[0].state.compactionAdoption;
    const receipt = await h.runtime.submit(h.identity, input(h.session.sessionId, '触发压缩'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.turns.find(turn => turn.turnId === receipt.turnId).state, 'failed');
    assert.ok(h.gateway.segmentInputs.length > before);
    const attempts = snap.attempts.filter(item => item.stepId === snap.steps.find(step => step.turnId === receipt.turnId).stepId);
    assert.ok(attempts.some(item => item.error === 'context-window'));
    assert.equal(attempts.filter(item => item.attemptNo >= 100 && item.state === 'completed').length, 1);
    const state = (await h.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1',
      [h.session.sessionId])).rows[0].state;
    assert.equal(state.compactionAdoption, priorAdoption, '拒绝的候选不得成为会话历史');
  } finally { await h.close(); }
});

test('最终请求达到压缩阈值时先做一次同步压缩，压缩目标为最近 10% C-R', async () => {
  let capacityCalls = 0, selectionTarget;
  const compact = {
    provider: { id: 'pressure-summary', version: 1,
      prompt: () => ({ system: '摘要', text: '摘要输入' }),
      parse: () => ({ facts: [] }) },
    maxPerTurn: 1,
    select(history, _blocks, target) {
      selectionTarget = target;
      const messages = history.slice(0, 1), remainder = history.slice(1);
      if (!messages.length) return null;
      return { messages, remainder, sourceDigest: 'a'.repeat(64), retainedDigest: 'b'.repeat(64),
        sourceVersions: { retainedIds: ['context'] }, policy: { maxSummaryTokens: 64 } };
    },
  };
  const pressureScenario = { ...scenario([]), compaction: compact };
  const ok = reason => ({ dispatchable: true, reason, requestFingerprint: 'd'.repeat(64), bytes: capacityCalls > 2 ? 900 : 1000,
    inputEstimateTokens: 100, outputReserveTokens: 8_000, safetyMarginTokens: 3_200, pressure: 0.5,
    pressureState: 'ok', contextWindow: 64_000, transportLimitBytes: 1_000_000 });
  const h = await harness([
    { text: '产生历史', toolIntents: [] },
    { text: '摘要结果', toolIntents: [] },
    { text: '压缩后回答', toolIntents: [] },
  ], [], { capacity: () => {
    capacityCalls += 1;
    return capacityCalls === 2
      ? { ...ok('ok'), pressure: 0.8, pressureState: 'compact' }
      : ok('ok');
  } }, undefined, pressureScenario);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第一轮' + 'x'.repeat(2000)));
    await h.settle();
    const receipt = await h.runtime.submit(h.identity, input(h.session.sessionId, '触发压力'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.turns.find(turn => turn.turnId === receipt.turnId).state, 'completed');
    const mainAttempts = snap.attempts.filter(item => item.attemptNo < 100
      && item.stepId === snap.steps.find(step => step.turnId === receipt.turnId).stepId);
    assert.deepEqual(mainAttempts.map(item => item.error), ['context-pressure', null]);
    assert.ok(snap.attempts.some(item => item.attemptNo >= 100), '执行了一次真实摘要尝试');
    assert.equal(selectionTarget.recentTokens, 5_600, 'C=64,000, R=8,000: retainTokens = floor((64,000 - 8,000) * 10%) = 5,600');
    const { rows: [row] } = await h.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1',
      [h.session.sessionId]);
    assert.ok(row.state.compactionAdoption);
  } finally { await h.close(); }
});

test('压缩采用记录能定位实际摘要 Attempt，且原始工具结果仍按 ToolCall 保留', async () => {
  let capacityCalls = 0, selectCount = 0;
  const compact = {
    provider: { id: 'trace-summary', version: 1, prompt: () => ({ system: '摘要', text: '摘要输入' }),
      parse: () => ({ facts: [] }) },
    maxPerTurn: 1,
    select(history) {
      selectCount++;
      if (history.length < 3) return null;
      return { messages: history.slice(0, 2), remainder: history.slice(2), sourceDigest: 'a'.repeat(64),
        retainedDigest: 'b'.repeat(64), sourceVersions: { retainedIds: ['context'] }, policy: { maxSummaryTokens: 64 } };
    },
  };
  const ok = () => ({ dispatchable: true, reason: 'ok', requestFingerprint: 'd'.repeat(64), bytes: capacityCalls > 3 ? 900 : 1000,
    inputEstimateTokens: 100, outputReserveTokens: 8_000, safetyMarginTokens: 3_200, pressure: 0.5,
    pressureState: 'ok', contextWindow: 64_000, transportLimitBytes: 1_000_000 });
  const h = await harness([
    { text: '调用工具', toolIntents: [{ callId: 'trace-call', name: 'large', arguments: { value: 'TOOL_ORIGINAL_MARKER' } }] },
    { text: '工具完成', toolIntents: [] },
    { text: '摘要结果', toolIntents: [] },
    { text: '压缩后回答', toolIntents: [] },
  ], [largeTool()], { capacity: () => (++capacityCalls === 3 ? { ...ok(), pressure: 0.8, pressureState: 'compact' } : ok()) },
  undefined, { ...scenario([largeTool()]), compaction: compact });
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第一轮'));
    await h.settle();
    const receipt = await h.runtime.submit(h.identity, input(h.session.sessionId, '触发压缩并保留原件'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.turns.find(turn => turn.turnId === receipt.turnId).state, 'completed');
    assert.ok(selectCount >= 1);
    const { rows: [row] } = await h.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1',
      [h.session.sessionId]);
    const adoption = row.state.compactionAdoption;
    assert.ok(adoption?.attemptId, '压缩采用必须记录实际摘要 Attempt');
    const summaryAttempt = snap.attempts.find(item => item.attemptId === adoption.attemptId);
    assert.ok(summaryAttempt && summaryAttempt.attemptNo >= 100);
    assert.equal(summaryAttempt.stepId, snap.steps.find(step => step.turnId === receipt.turnId).stepId);
    const { rows: [tool] } = await h.storage.read('SELECT result FROM agent_tool_calls WHERE tool_call_id=$1',
      [snap.toolCalls[0].toolCallId]);
    assert.equal(tool.result.kind, 'completed');
    assert.ok(tool.result.summary.includes('TOOL_ORIGINAL_MARKER'), '原始工具结果仍按 ToolCall 保留');
    assert.ok(row.state.history.some(entry => entry.text.startsWith('已核对来源的历史摘要')));
  } finally { await h.close(); }
});

test('摘要失败时保留原上下文，原请求仍可派发', async () => {
  let capacityCalls = 0;
  const compact = {
    provider: { id: 'failing-summary', version: 1, prompt: () => ({ system: '摘要', text: '摘要输入' }),
      parse() { throw new Error('invalid-summary'); } },
    maxPerTurn: 1,
    select(history) {
      if (history.length < 3) return null;
      return { messages: history.slice(0, 1), remainder: history.slice(1), sourceDigest: 'a'.repeat(64),
        retainedDigest: 'b'.repeat(64), sourceVersions: { retainedIds: ['context'] }, policy: { maxSummaryTokens: 64 } };
    },
  };
  const ok = () => ({ dispatchable: true, reason: 'ok', requestFingerprint: 'd'.repeat(64), bytes: 1000,
    inputEstimateTokens: 100, outputReserveTokens: 8_000, safetyMarginTokens: 3_200, pressure: 0.5,
    pressureState: 'ok', contextWindow: 64_000, transportLimitBytes: 1_000_000 });
  const h = await harness([
    { text: '第一轮完成', toolIntents: [] },
    { text: '摘要结果', toolIntents: [] },
    { text: '原上下文继续', toolIntents: [] },
  ], [], { capacity: () => (++capacityCalls === 2 ? { ...ok(), pressure: 0.8, pressureState: 'compact' } : ok()) },
  undefined, { ...scenario([]), compaction: compact });
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第一轮'));
    await h.settle();
    const receipt = await h.runtime.submit(h.identity, input(h.session.sessionId, '触发摘要失败'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.turns.find(turn => turn.turnId === receipt.turnId).state, 'completed');
    const { rows: [row] } = await h.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1',
      [h.session.sessionId]);
    assert.equal(row.state.compactionAdoption, undefined, '失败摘要不得采用');
    assert.ok(row.state.history.some(entry => entry.text === '第一轮完成'), '原上下文保持');
  } finally { await h.close(); }
});

test('压缩重试最多一次，仍达到阈值时返回容量缺口', async () => {
  let summaries = 0, capacityCalls = 0;
  const compact = {
    provider: { id: 'retry-summary', version: 1, prompt: () => ({ system: '摘要', text: '摘要输入' }),
      parse: () => { summaries += 1; return { facts: [] }; } },
    maxPerTurn: 2,
    select(history) {
      if (history.length < 2) return null;
      return { messages: history.slice(0, 1), remainder: history.slice(1), sourceDigest: 'a'.repeat(64),
        retainedDigest: 'b'.repeat(64), sourceVersions: { retainedIds: ['context'] }, policy: { maxSummaryTokens: 64 } };
    },
  };
  const base = { dispatchable: true, reason: 'ok', requestFingerprint: 'd'.repeat(64), bytes: 1000,
    inputEstimateTokens: 51_200, outputReserveTokens: 8_000, safetyMarginTokens: 3_200, pressure: 1.2,
    pressureState: 'compact', contextWindow: 64_000, transportLimitBytes: 1_000_000,
    compactionHeadroomTokens: 4_096, compactionHeadroomSource: 'estimated', pressureBudgetTokens: 51_904,
    thresholdTokens: 51_200, retainTokens: 5_600 };
  const capacity = () => {
    capacityCalls += 1;
    return [3, 5, 7].includes(capacityCalls) ? base : { ...base, pressure: 0.4, pressureState: 'ok' };
  };
  const h = await harness([{ text: '第一轮完成', toolIntents: [] }, { text: '第二轮完成', toolIntents: [] },
    { text: '第二段', toolIntents: [] }], [], { capacity }, undefined,
  { ...scenario([]), compaction: compact });
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '历史' + 'x'.repeat(20_000)));
    await h.settle();
    await h.runtime.submit(h.identity, input(h.session.sessionId, '中间轮'));
    await h.settle();
    const before = summaries;
    const receipt = await h.runtime.submit(h.identity, input(h.session.sessionId, '触发重试上限'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    const turn = snap.turns.find(item => item.turnId === receipt.turnId);
    assert.equal(turn.state, 'failed');
    assert.equal(turn.reason, 'context-capacity-gap');
    assert.equal(summaries - before, 2, '初始一次 + 最多一次重试');
    assert.equal(snap.attempts.filter(item => item.attemptNo >= 100).length, 2);
  } finally { await h.close(); }
});

test('当前计量低于压缩阈值时旧历史正常派发且不调用摘要', async () => {
  let selections = 0;
  const compaction = { provider: { id: 'unexpected-summary', version: 1 },
    maxPerTurn: 2, select() { selections++; return null; } };
  const h = await harness([{ text: 'x'.repeat(70_000), toolIntents: [] }, { text: '继续回答', toolIntents: [] }],
    [], { capacity: () => ({ dispatchable: true, reason: 'ok', requestFingerprint: 'd'.repeat(64),
      bytes: 240_000, inputEstimateTokens: 80_000, outputReserveTokens: 64, safetyMarginTokens: 100_000,
      contextWindow: 1_000_000, pressureState: 'ok', pressure: 0.089, transportLimitBytes: 1_000_000 }) },
    undefined, { ...scenario([]), compaction });
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '建立历史'));
    await h.settle();
    const next = await h.runtime.submit(h.identity, input(h.session.sessionId, '继续'));
    await h.settle();
    const snapshot = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snapshot.turns.find(item => item.turnId === next.turnId).state, 'completed');
    assert.equal(selections, 0);
    assert.equal(snapshot.attempts.length, 2);
  } finally { await h.close(); }
});

test('旧工具反馈已缩短时，摘要仍按原始历史基线合法采用', async () => {
  let capacityCalls = 0;
  const compaction = {
    provider: { id: 'projection-summary', version: 1,
      prompt: () => ({ system: '摘要', text: '摘要输入' }),
      parse: () => ({ facts: [] }) },
    maxPerTurn: 1,
    select(history) {
      if (history.length < 2) return null;
      return { messages: history.slice(0, -1), remainder: history.slice(-1), sourceDigest: 'a'.repeat(64),
        retainedDigest: 'b'.repeat(64), sourceVersions: { retainedIds: ['context'] }, policy: { maxSummaryTokens: 64 } };
    },
  };
  const h = await harness([
    { text: '调用旧工具', toolIntents: [{ callId: 'compact-old', name: 'large', arguments: { value: 'OLD_TAIL' } }] },
    { text: '旧工具完成', toolIntents: [] },
    { text: '第二轮工具', toolIntents: [{ callId: 'compact-recent', name: 'large', arguments: { value: 'RECENT_TAIL' } }] },
    { text: '近期工具完成', toolIntents: [] },
    { text: '摘要结果', toolIntents: [] },
    { text: '摘要后回答', toolIntents: [] },
  ], [largeTool(), echoTool('read_work')], { capacity: () => {
    capacityCalls++;
    return { dispatchable: true, reason: 'ok', requestFingerprint: 'd'.repeat(64),
      bytes: capacityCalls === 5 ? 9000 : 2500, inputEstimateTokens: capacityCalls === 5 ? 3000 : 834,
      outputReserveTokens: 64, safetyMarginTokens: 400, pressure: capacityCalls === 5 ? 0.85 : 0.23,
      pressureState: capacityCalls === 5 ? 'compact' : 'ok', contextWindow: 4000, transportLimitBytes: 1_000_000 };
  } }, undefined,
  { ...scenario([largeTool(), echoTool('read_work')]), compaction });
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第一轮'));
    await h.settle();
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第二轮'));
    await h.settle();
    const receipt = await h.runtime.submit(h.identity, input(h.session.sessionId, '第三轮'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.turns.find(turn => turn.turnId === receipt.turnId).state, 'completed');
    const { rows: [row] } = await h.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1',
      [h.session.sessionId]);
    assert.ok(row.state.compactionAdoption, '合法摘要必须采用');
    assert.ok(row.state.history.some(entry => entry.text.startsWith('已核对来源的历史摘要')));
  } finally { await h.close(); }
});

for (const interruption of ['history-changed', 'stop']) {
  test(`压缩生成期间 ${interruption} 不采用摘要`, async () => {
    let entered, release, attempts = 0;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const compaction = {
      provider: { id: 'suspended-summary', version: 1, prompt: () => ({ system: '摘要', text: '摘要输入' }),
        parse: () => ({ facts: [] }) }, maxPerTurn: 1,
      select(history) {
        return { messages: history.slice(0, 1), remainder: history.slice(1), sourceDigest: 'a'.repeat(64),
          retainedDigest: 'b'.repeat(64), sourceVersions: { retainedIds: ['context'] }, policy: { maxSummaryTokens: 64 } };
      },
    };
    const h = await harness([{ text: '第一轮完成', toolIntents: [] },
      { text: '摘要完成', toolIntents: [], beforeReply: async () => { entered(); await held; } },
      { text: '按原记录回答', toolIntents: [] }], [], { capacity: () => {
      const pressure = ++attempts === 2 ? 0.8 : 0.25;
      return { dispatchable: true, reason: 'ok', requestFingerprint: 'd'.repeat(64), bytes: 5000,
        inputEstimateTokens: 1667, outputReserveTokens: 64, safetyMarginTokens: 3200, pressure,
        pressureState: pressure === 0.8 ? 'compact' : 'ok', contextWindow: 64_000, transportLimitBytes: 1_000_000 };
    } }, undefined, { ...scenario([]), compaction });
    try {
      await h.runtime.submit(h.identity, input(h.session.sessionId, '历史' + 'x'.repeat(2000)));
      await h.settle();
      const next = await h.runtime.submit(h.identity, input(h.session.sessionId, '整理历史'));
      await Promise.race([started, waitFor(() => false, 3500)]);
      if (interruption === 'stop') {
        await h.runtime.stop(h.identity, h.session.sessionId, next.turnId, randomUUID());
      } else {
        await h.storage.request({ requestId: randomUUID(), fingerprint: 'fixture-change-history' }, async tx => {
          await tx.query("UPDATE agent_runtime_sessions SET state=jsonb_set(state,'{history,0,text}',to_jsonb('edited-source'::text)) WHERE session_id=$1", [h.session.sessionId]);
          return null;
        });
      }
      release();
      await h.settle();
      const { rows: [row] } = await h.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1', [h.session.sessionId]);
      assert.equal(row.state.compactionAdoption, undefined);
      assert.ok(row.state.history.length > 0);
      if (interruption === 'history-changed') assert.equal(row.state.history[0].text, 'edited-source');
    } finally { release(); await h.close(); }
  });
}

test('编辑提问前的消息会退休旧回应，不把旧回答重新带入新模型上下文', async () => {
  const ask = { definition: { name: 'ask', description: 'Ask the student', inputSchema: { type: 'object', properties: {} } },
    supportsBackground: false, async execute(_call, context) {
      await context.ask({ presentation: { question: 'Choose a direction' }, deadline: null });
      return { kind: 'completed', outcome: 'success', summary: 'Student responded' };
    } };
  const h = await harness([
    { text: '', toolIntents: [{ callId: 'ask-original', name: 'ask', arguments: {} }] },
    { text: 'old answer', toolIntents: [] }, { text: 'new answer', toolIntents: [] },
  ], [ask]);
  try {
    const submitted = await h.runtime.submit(h.identity, input(h.session.sessionId, 'original question'));
    let question;
    for (let attempt = 0; attempt < 200; attempt++) {
      question = (await h.runtime.sessionSnapshot(h.identity, h.session.sessionId)).questions.find(item => item.state === 'pending');
      if (question) break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.ok(question);
    await h.runtime.answerQuestion(h.identity, h.session.sessionId, { questionId: question.questionId,
      requestId: randomUUID(), expectedVersion: question.version, answer: { kind: 'text', text: 'old response' } });
    await h.settle();
    await h.runtime.inputControl(h.identity, h.session.sessionId, submitted.inputId,
      { requestId: randomUUID(), expectedVersion: 1, operation: 'edit', text: 'revised question' });
    await h.settle();
    const { rows: [row] } = await h.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1', [h.session.sessionId]);
    assert.ok(row.state.history.some(item => item.text === 'revised question'));
    assert.ok(!row.state.history.some(item => item.text === 'old response' || item.text === 'old answer'));
    await validateAgentRuntime(h.storage);
  } finally { await h.close(); }
});

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
    const readStore = createAgentStore(h.storage, { ownerInstanceId: 'recent-step-reader' });
    const recent = await readStore.recentCompletedSteps(h.session.sessionId, 2);
    assert.equal(recent.length, 2);
    assert.equal(new Set(recent.map(step => step.stepId)).size, 2, 'Attempt 重试不额外占用一个近期 Step');
    assert.deepEqual(new Set(recent.map(step => step.stepId)), new Set(snap.steps.map(step => step.stepId)));
  } finally { await h.close(); }
});

test('一个 Turn 的 Step 与工具后继续沿用开始时固定的模型；下一 Turn 才切换', async () => {
  const first = { ...connection, routeId: randomUUID() };
  const second = { ...connection, routeId: randomUUID() };
  let h;
  const switchTool = { ...echoTool(),
    async execute(call) {
      h.gateway.setConnection(second);
      return { kind: 'completed', outcome: 'success', summary: 'echo:' + call.input.value };
    } };
  h = await harness([
    { text: '调用工具', toolIntents: [{ callId: 'c1', name: 'echo', arguments: { value: 'one' } }] },
    { text: '同一模型收尾', toolIntents: [] },
    { text: '新 Turn 使用新模型', toolIntents: [] },
  ], [switchTool]);
  try {
    h.gateway.setConnection(first);
    const firstReceipt = await h.runtime.submit(h.identity, input(h.session.sessionId, '第一轮'));
    await h.settle();
    assert.deepEqual(h.gateway.segmentConnections.map(item => item.routeId), [first.routeId],
      '同一 Turn 的多个 Step 复用一个原生段，即便学生设置已经改变');
    const firstTurn = (await h.runtime.sessionSnapshot(h.identity, h.session.sessionId)).turns[0];
    assert.equal(firstTurn.state, 'completed');
    const secondReceipt = await h.runtime.submit(h.identity, input(h.session.sessionId, '第二轮'));
    await h.settle();
    const secondSnapshot = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.notEqual(secondReceipt.turnId, firstReceipt.turnId);
    assert.equal(secondSnapshot.turns.find(turn => turn.turnId === secondReceipt.turnId)?.state, 'completed',
      JSON.stringify(secondSnapshot.turns));
    assert.deepEqual(h.gateway.segmentConnections.map(item => item.routeId), [first.routeId, second.routeId],
      JSON.stringify(h.gateway.segmentConnections.map(item => item.routeId)));
  } finally { await h.close(); }
});

test('工具结果按工具边界形成的历史直接进入后续请求，不因 Step 年龄被二次摘要', async () => {
  const h = await harness([
    { text: '调用旧工具', toolIntents: [{ callId: 'old-call', name: 'large', arguments: { value: 'OLD_TAIL_MARKER' } }] },
    { text: '旧工具完成', toolIntents: [] },
    { text: '调用近期工具', toolIntents: [{ callId: 'recent-call', name: 'large', arguments: { value: 'RECENT_TAIL_MARKER' } }] },
    { text: '近期工具完成', toolIntents: [] },
    { text: '第三轮追问', toolIntents: [] },
  ], [largeTool(), echoTool('read_work')]);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第一轮'));
    await h.settle();
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第二轮'));
    await h.settle();
    const segmentsBefore = h.gateway.segmentInputs.length;
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第三轮'));
    await h.settle();

    assert.equal(h.gateway.segmentInputs.length, segmentsBefore, '普通历史不应改变原生段');
    const lastReceive = h.gateway.receives.at(-1);
    assert.match(lastReceive.input.text, /第三轮/);
    assert.equal(lastReceive.input.historyProjection, undefined,
      '内核不再按历史年龄生成工具反馈投影');

    const { rows: [row] } = await h.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1',
      [h.session.sessionId]);
    const old = row.state.history.find(item => item.nativeCallId === 'old-call');
    assert.ok(old, '旧工具结果仍在历史中');
    assert.ok(old.text.includes('OLD_TAIL_MARKER'), '工具边界形成的模型可见结果原样保留');
    assert.equal(old.feedbackCompressed, undefined);
    assert.equal(row.state.feedbackDigest ?? null, null);
    assert.equal(row.state.feedbackCompressedEntries?.length ?? 0, 0);
  } finally { await h.close(); }
});

test('没有继续读取入口的超长工具结果仍保留工具真实输出，不静默改写历史', async () => {
  const h = await harness([
    { text: '调用旧工具', toolIntents: [{ callId: 'old-no-readback', name: 'large', arguments: { value: 'NO_READBACK_TAIL' } }] },
    { text: '旧工具完成', toolIntents: [] },
    { text: '第二轮工具', toolIntents: [{ callId: 'next-call', name: 'large', arguments: { value: 'RECENT' } }] },
    { text: '第二轮完成', toolIntents: [] },
    { text: '第三轮追问', toolIntents: [] },
  ], [largeTool('large', false)]);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第一轮'));
    await h.settle();
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第二轮'));
    await h.settle();
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第三轮'));
    await h.settle();
    assert.equal(h.gateway.receives.at(-1).input.historyProjection, undefined);
    const { rows: [row] } = await h.storage.read('SELECT state FROM agent_runtime_sessions WHERE session_id=$1',
      [h.session.sessionId]);
    assert.ok(row.state.history.find(item => item.nativeCallId === 'old-no-readback').text.includes('NO_READBACK_TAIL'));
    assert.equal(row.state.feedbackDigest ?? null, null);
  } finally { await h.close(); }
});

test('本步材料可由 cite_source 固定到具体判断和来源', async () => {
  const material = { materialId: 'M-test', sourceId: 'source-test', kind: 'student-reference', author: 'student',
    label: '固定作品 v7', version: 'v7', range: null, digest: 'digest-v7', content: 'module alu; endmodule',
    readState: 'included', source: { kind: 'work', objectId: randomUUID(), contentId: randomUUID() }, citationAllowed: true };
  const citeScenario = { id: 'test', version: 1,
    async context() { return { system: '测试助手', facts: {}, sources: [], materials: [material] }; },
    async tools() { return []; } };
  const cited = await harness([{ text: '', toolIntents: [{ callId: 'cite-1', name: 'cite_source',
    arguments: { materialId: 'M-test', claim: 'v7 的进位由第 5 位产生' } }] }, { text: '已记录出处', toolIntents: [] }],
  [], {}, undefined, citeScenario);
  try {
    const receipt = await cited.runtime.submit(cited.identity, input(cited.session.sessionId, '请核对'));
    await cited.settle();
    const snap = await cited.runtime.sessionSnapshot(cited.identity, cited.session.sessionId);
    assert.equal(snap.turns.find(turn => turn.turnId === receipt.turnId).state, 'completed');
    assert.equal(snap.toolCalls[0].name, 'cite_source');
    assert.equal(snap.toolCalls[0].result.kind, 'completed');
    assert.equal(snap.toolCalls[0].result.outcome, 'success', JSON.stringify(snap.toolCalls[0].result));
    assert.equal(snap.toolCalls[0].result.data.citation.claim, 'v7 的进位由第 5 位产生');
    assert.equal(snap.toolCalls[0].result.data.citation.label, '固定作品 v7');
  } finally { await cited.close(); }
});

test('模型写在正文里的引用标记会转成真实出处并从可见回答中移除', async () => {
  const material = { materialId: 'M-inline', sourceId: 'source-inline', kind: 'student-reference', author: 'student',
    label: '固定作品 v7', version: 'v7', range: null, digest: 'digest-inline', content: 'module alu; endmodule',
    readState: 'included', source: { kind: 'work', objectId: randomUUID(), contentId: randomUUID() }, citationAllowed: true };
  const inlineScenario = { id: 'test', version: 1,
    async context() { return { system: '测试助手', facts: {}, sources: [], materials: [material] }; },
    async tools() { return []; } };
  const h = await harness([{ text: '结论来自 <cite_source materialId="M-inline" claim="v7 的进位由第 5 位产生"/>',
    toolIntents: [] }], [], {}, undefined, inlineScenario);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '请核对'));
    await h.settle();
    const events = await h.runtime.events(h.identity, h.session.sessionId);
    const answer = events.filter(event => event.kind === 'assistant').at(-1);
    assert.doesNotMatch(answer.body.text, /cite_source/);
    assert.equal(answer.body.text, '结论来自');
    const inline = events.find(event => event.kind === 'inline-citations');
    assert.deepEqual(inline?.body.citations, [{ claim: 'v7 的进位由第 5 位产生', materialId: 'M-inline' }]);
  } finally { await h.close(); }
});

test('同一 Turn 已发送的固定材料只保留引用，且仍可作为出处', async () => {
  const material = { materialId: 'M-static-repeat', sourceId: 'source-static-repeat', kind: 'student-work',
    author: 'student', label: 'alu.sv v7', version: 'v7', range: { kind: 'work-file' }, digest: 'digest-repeat',
    content: 'MATERIAL_BODY_MARKER', readState: 'included',
    source: { kind: 'work', objectId: randomUUID(), contentId: randomUUID() }, citationAllowed: true };
  const repeatedScenario = { id: 'test', version: 1,
    async context() { return { system: '测试助手', facts: {}, sources: [], materials: [material] }; },
    async tools() { return [echoTool()]; } };
  const h = await harness([
    { text: '调用工具', toolIntents: [{ callId: 'c-repeat', name: 'echo', arguments: { value: 'one' } }] },
    { text: '', toolIntents: [{ callId: 'cite-repeat', name: 'cite_source',
      arguments: { materialId: 'M-static-repeat', claim: 'v7 的进位需要检查' } }] },
    { text: '已按固定版本回答', toolIntents: [] },
  ], [echoTool()], {}, undefined, repeatedScenario);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '连续核对同一版本'));
    await h.settle();
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.toolCalls.find(call => call.name === 'cite_source').result.outcome, 'success');
    const sends = h.gateway.receives.map(receive => receive.input.text);
    assert.ok(sends[0].includes('MATERIAL_BODY_MARKER'));
    assert.equal(sends[1].includes('MATERIAL_BODY_MARKER'), false);
    assert.match(sends[1], /正文未重复发出/);
  } finally { await h.close(); }
});

test('同一原生段的新 Turn 也不重复装入已可见的固定作品正文', async () => {
  const material = { materialId: 'M-cross-turn', sourceId: 'source-cross-turn', kind: 'student-work',
    author: 'student', label: 'alu.sv v7', version: 'v7', range: { kind: 'work-file' }, digest: 'digest-cross-turn',
    content: 'CROSS_TURN_BODY_MARKER', readState: 'included',
    source: { kind: 'work', objectId: randomUUID(), contentId: randomUUID() }, citationAllowed: true };
  const repeatedScenario = { id: 'test', version: 1,
    async context() { return { system: '测试助手', facts: {}, sources: [], materials: [material] }; },
    async tools() { return []; } };
  const h = await harness([{ text: '第一轮完成', toolIntents: [] },
    { text: '第二轮完成', toolIntents: [] }], [], {}, undefined, repeatedScenario);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第一轮'));
    await h.settle();
    const secondStart = h.gateway.receives.length;
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第二轮'));
    await h.settle();
    assert.ok(h.gateway.receives[0].input.text.includes('CROSS_TURN_BODY_MARKER'));
    assert.equal(h.gateway.receives[secondStart].input.text.includes('CROSS_TURN_BODY_MARKER'), false);
    assert.match(h.gateway.receives[secondStart].input.text, /正文未重复发出/);
    assert.equal(h.gateway.segmentInputs.length, 1, '相同模型、规则和工具应继续复用原生段');
  } finally { await h.close(); }
});

test('压力预检关闭旧段后，新原生段重新内联固定选区正文', async () => {
  const material = { materialId: 'M-reselect', sourceId: 'source-reselect', kind: 'student-work',
    author: 'student', label: 'alu.sv v7', version: 'v7', range: { kind: 'work-file' }, digest: 'digest-reselect',
    content: 'RESELECT_BODY_MARKER', readState: 'included',
    source: { kind: 'work', objectId: randomUUID(), contentId: randomUUID() }, citationAllowed: true };
  const selectedScenario = { id: 'test', version: 1,
    async context() { return { system: '测试助手', facts: {}, sources: [], materials: [material] }; },
    async tools() { return [echoTool()]; } };
  let h, capacityCalls = 0, closeNext = false;
  const faults = { capacity: () => {
    capacityCalls++;
    if (closeNext) {
      closeNext = false;
      h.gateway.forceCloseSegments();
      return { dispatchable: true, reason: 'ok', requestFingerprint: 'd'.repeat(64), bytes: 1000,
        inputEstimateTokens: 100, outputReserveTokens: 64, safetyMarginTokens: 3200, pressure: 0.8,
        pressureState: 'compact', contextWindow: 64_000, transportLimitBytes: 1_000_000 };
    }
    return { dispatchable: true, reason: 'ok', requestFingerprint: 'd'.repeat(64), bytes: 1000,
      inputEstimateTokens: 100, outputReserveTokens: 64, safetyMarginTokens: 3200, pressure: 0.5,
      pressureState: 'ok', contextWindow: 64_000, transportLimitBytes: 1_000_000 };
  } };
  h = await harness([
    { text: '调用工具', toolIntents: [{ callId: 'keep-call', name: 'echo', arguments: { value: 'keep' } }] },
    { text: '第一轮完成', toolIntents: [] },
    { text: '重建后回答', toolIntents: [] },
  ], [echoTool()], faults, undefined, selectedScenario);
  try {
    await h.runtime.submit(h.identity, input(h.session.sessionId, '第一轮'));
    await h.settle();
    const segmentsBefore = h.gateway.segmentInputs.length;
    closeNext = true;
    const result = await h.runtime.submit(h.identity, input(h.session.sessionId, '按固定选区继续'));
    await h.settle();
    assert.equal(h.gateway.segmentInputs.length, segmentsBefore + 1, '关闭的旧段不能继续续接');
    const latest = h.gateway.receives.at(-1).input.text;
    assert.equal(latest.split('RESELECT_BODY_MARKER').length - 1, 1);
    assert.equal(latest.indexOf('按固定选区继续') < latest.indexOf('RESELECT_BODY_MARKER'), true);
    const snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.toolCalls.length, 1, '重建不会重新执行已完成工具');
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
  const base = scenario([b.tool]);
  const scene = { ...base, async context(input) {
    const prepared = await base.context(input);
    return { ...prepared, materials: input.inputs.filter(entry => entry.context.marker).map(entry => ({
      materialId: 'M-' + entry.inputId, sourceId: 'reference:' + entry.inputId, inputId: entry.inputId,
      kind: 'student-reference', author: 'student', label: '固定选区', version: 'v7', range: null,
      digest: entry.context.marker, content: entry.context.marker, readState: 'included', source: {}, citationAllowed: false,
    })) };
  } };
  const h = await harness([
    { text: '调用阻塞工具', toolIntents: [{ callId: 'c1', name: 'block', arguments: {} }] },
    { text: '看到补充', toolIntents: [] },
  ], [b.tool], {}, undefined, scene);
  try {
    const r1 = await h.runtime.submit(h.identity, input(h.session.sessionId, '第一条'));
    await waitFor(() => b.started.length === 1);
    const r2 = await h.runtime.submit(h.identity, { ...input(h.session.sessionId, '补充消息甲'), context: { marker: 'selection-marker-a' } });
    const r3 = await h.runtime.submit(h.identity, { ...input(h.session.sessionId, '补充消息乙'), context: { marker: 'selection-marker-b' } });
    assert.equal(r2.turnId, r1.turnId, '活跃 Turn 的新消息是 steering，不新建 Turn');
    let snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.inputs.find(i => i.inputId === r2.inputId).state, 'pending', '批次进行中仍 pending');
    b.release();
    await h.settle();
    snap = await h.runtime.sessionSnapshot(h.identity, h.session.sessionId);
    assert.equal(snap.turns[0].state, 'completed');
    assert.equal(snap.inputs.find(i => i.inputId === r2.inputId).state, 'adopted');
    assert.equal(snap.steps.length, 2);
    assert.deepEqual(snap.steps[1].snapshot.inputIds, [r2.inputId, r3.inputId], '第二 Step 按顺序接纳 steering');
    assert.match(h.gateway.receives.at(-1).input.text, /补充消息甲[\s\S]*selection-marker-a[\s\S]*补充消息乙[\s\S]*selection-marker-b/);
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
