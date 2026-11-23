import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { portableHistory, toolFeedback } from '../dist/history.js';
import { createModelAdapter } from '../dist/model.js';

test('accepted 和 outcome_unknown 的规范化反馈保留状态与真实句柄，且受 UTF-8 上限约束', () => {
  const accepted = toolFeedback({ kind: 'accepted', taskId: 'task-1', summary: '已受理' }, 'course_operation');
  const unknown = toolFeedback({ kind: 'outcome_unknown', reason: '执行效果未知', taskId: 'task-2', requestRef: 'request-2' }, 'course_operation');
  assert.equal(accepted.outcome, 'success');
  assert.deepEqual(JSON.parse(accepted.text), { tool: 'course_operation', kind: 'accepted', state: 'accepted', summary: '已受理', taskId: 'task-1' });
  assert.equal(unknown.outcome, 'error');
  assert.deepEqual(JSON.parse(unknown.text), { tool: 'course_operation', kind: 'outcome_unknown', state: 'outcome-unknown', summary: '执行效果未知', reason: '执行效果未知', taskId: 'task-2', requestRef: 'request-2' });
  assert.ok(Buffer.byteLength(accepted.text, 'utf8') <= 8192);
  assert.ok(Buffer.byteLength(unknown.text, 'utf8') <= 8192);
});

test('旧版结构化工具历史仍按原文本读取，不重新执行旧工具', () => {
  const text = JSON.stringify({ tool: 'legacy_tool', kind: 'completed', outcome: 'success', summary: '旧结果', taskId: 'legacy-task' });
  const history = portableHistory([{ id: randomUUID(), version: 1, role: 'user', text, kind: 'tool-result', nativeCallId: 'legacy-call' }]);
  assert.deepEqual(history, [{ role: 'user', text, entryId: history[0].entryId }]);
});

test('重启恢复先 settlement 已持久化工具结果，并保留 accepted 与 unknown 句柄', async () => {
  const identity = { kind: 'personal', name: 'test', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const segmentId = randomUUID(), turnId = randomUUID(), stepId = randomUUID();
  const connection = { connectionId: randomUUID(), version: 1, routeId: randomUUID(), protocol: 'chat-completions', modelId: 'test',
    contextWindow: 100_000, maxOutputTokens: 100, capabilities: {} };
  let state = { segment: { segmentId, sequence: 0, closed: false } };
  let recoveredSettlement;
  const oldSegment = { segmentId, sequence: 0, closed: false, pendingTools: [{ callId: 'accepted-call' }, { callId: 'unknown-call' }] };
  const store = {
    turnRuntime: async () => ({ model: { connection, selectionVersion: 1, pinId: randomUUID(), source: {} } }),
    sessionState: async () => state,
    setSessionState: async (_id, next) => { state = next; },
    toolResultsByNative: async () => new Map([
      ['accepted-call', { kind: 'accepted', taskId: 'real-task', summary: '已受理' }],
      ['unknown-call', { kind: 'outcome_unknown', taskId: 'unknown-task', requestRef: 'unknown-request', reason: '执行效果未知' }],
    ]),
    budgetOf: async () => ({ budget: { maxInputTokens: 100_000, maxOutputTokens: 100, maxCallMs: 10_000,
      deadline: new Date(Date.now() + 60_000).toISOString() }, usage: { inputTokens: 0, outputTokens: 0 } }),
    attemptsOf: async () => [], saveAttempt: async () => {}, finishAttempt: async () => {}, recordRequestCapacity: async () => {},
  };
  const segment = { segmentId: randomUUID(), sequence: 0, closed: false, pendingTools: [] };
  const gateway = {
    segments: {
      read: async (_identity, id) => id === segmentId ? oldSegment : segment,
      settle: async (_identity, _id, input) => { recoveredSettlement = input; oldSegment.pendingTools = []; oldSegment.sequence += 1; return oldSegment; },
      close: async () => ({ ...oldSegment, closed: true }), create: async () => segment,
    },
    checks: {
      receive: async () => ({ state: 'accepted', physicalRequestEnded: false, dispatched: false, cancelRequested: false,
        text: '', usage: { state: 'unknown' }, requestRef: randomUUID(), resultRef: null, reason: '', upstreamStopped: 'unknown' }),
      requestPayload: async () => ({ messages: [] }),
      dispatch: async () => ({ state: 'completed', physicalRequestEnded: true, dispatched: true, text: '完成', toolIntents: [],
        usage: { state: 'final', inputTokens: 1, outputTokens: 1 }, requestRef: randomUUID(), resultRef: randomUUID() }),
    },
  };
  const adapter = createModelAdapter(gateway, store, { retryBackoffMs: [0, 0] });
  await adapter.generate({ identity, sessionId: randomUUID(), turnId, stepId, system: 'system', tools: [], history: [], text: '继续',
    images: [], toolResults: [], budget: { maxInputTokens: 100_000, maxOutputTokens: 100, maxCallMs: 10_000,
      deadline: new Date(Date.now() + 60_000).toISOString() }, spent: { inputTokens: 0, outputTokens: 0 }, signal: new AbortController().signal });
  const accepted = recoveredSettlement.results.find(result => result.callId === 'accepted-call');
  const unknown = recoveredSettlement.results.find(result => result.callId === 'unknown-call');
  assert.equal(JSON.parse(accepted.text).taskId, 'real-task');
  assert.equal(JSON.parse(unknown.text).requestRef, 'unknown-request');
  assert.equal(unknown.outcome, 'error');
});
