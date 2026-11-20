import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { createFileBackend, provisionStorage, openStorage } from '@xunjie/storage';
import { createAgentRuntime, agentRuntimeMigrations, validateAgentRuntime } from '@xunjie/agent-runtime';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { createAgentConversationProjection } from '../dist/agent-conversation.js';

test('v3 revision replaces the original bubble and answer, preserves its new timestamp after restart and retains original receipts', async t => {
  const pg = await nativeFixture();
  const owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
  const storage = await openStorage({ binding, migrations: agentRuntimeMigrations,
    backend: createFileBackend({ id: 'agent-ui', root: join(pg.root, 'agent-ui') }) });
  const segments = new Map(), attempts = new Map();
  const connection = { connectionId: randomUUID(), routeId: randomUUID(), version: 1, maxOutputTokens: 4096, contextWindow: 1000000,
    protocol: 'chat-completions', modelId: 'fixture', parameterMode: 'plain', capabilities: {}, hasCredential: true, adapterState: 'ready' };
  const choice = { choice: { connection }, source: { kind: 'personal', ownerScope: 'test', feeSource: 'test' } };
  const gateway = {
    selection: { read: async () => ({ selected: true, version: 1 }), snapshot: async () => choice, pin: async () => choice },
    segments: {
      create: async (_identity, input) => { const segment = { segmentId: input.segmentId, sequence: 0, closed: false, pending: false, pendingTools: [] }; segments.set(input.segmentId, segment); return segment; },
      read: async (_identity, id) => segments.get(id), close: async (_identity, id) => { segments.get(id).closed = true; return segments.get(id); },
    },
    checks: {
      receive: async (_identity, input) => { const attempt = { attemptId: input.attemptId, state: 'accepted', text: '', usage: { state: 'unknown' }, physicalRequestEnded: false, requestRef: randomUUID(), resultRef: null, segment: { segmentId: input.segmentId, sequence: 0 } }; attempts.set(input.attemptId, attempt); return attempt; },
      dispatch: async (_identity, id) => { const attempt = attempts.get(id); Object.assign(attempt, { state: 'completed', physicalRequestEnded: true, text: attempts.size === 1 ? 'old answer' : 'new answer', toolIntents: [], usage: { state: 'final', inputTokens: 10, outputTokens: 5 }, resultRef: randomUUID() }); return attempt; },
      read: async (_identity, id) => attempts.get(id), progress: async () => null, requestPayload: async () => ({}), cancel: async () => {},
    },
  };
  const scenario = { id: 'fixture', version: 1, context: async () => ({ system: 'Answer the latest question.', facts: {}, sources: [] }), tools: async () => [] };
  const options = { authorize: async () => {}, scenario, gateway };
  let runtime = createAgentRuntime(storage, options);
  t.after(async () => { await runtime.close(); await storage.close(); await pg.close(); });
  const identity = { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: 'student' };
  const sessionId = randomUUID();
  await runtime.initialize({ sessionId, identity, scenario: 'fixture', createdAt: new Date().toISOString() });
  const request = { sessionId, requestId: randomUUID(), text: 'original question', context: {} };
  const first = await runtime.submit(identity, request); await runtime.drain();
  let projection = createAgentConversationProjection(runtime);
  const before = await projection.conversation(identity, sessionId);
  assert.deepEqual(before.messages.map(item => item.text), ['original question', 'old answer']);
  const edit = { requestId: randomUUID(), expectedVersion: 1, operation: 'edit', text: 'revised question' };
  const receipt = await runtime.inputControl(identity, sessionId, first.inputId, edit);
  assert.equal(receipt.input.inputId, first.inputId); assert.notEqual(receipt.input.turnId, first.turnId);
  assert.deepEqual(await runtime.inputControl(identity, sessionId, first.inputId, edit), receipt);
  await runtime.drain();
  const result = await projection.conversation(identity, sessionId, before.lastSeq);
  assert.equal(result.reset, true);
  assert.deepEqual(result.messages.map(item => item.text), ['revised question', 'new answer']);
  assert.equal(result.messages[0].createdAt, before.messages[0].createdAt);
  assert.ok(result.messages[0].editedAt);
  assert.deepEqual(result.contextUsage, { model: { connectionId: connection.connectionId, version: 1 }, tokens: 10, lowerBound: false });
  const revisedAt = result.messages[0].editedAt;
  await runtime.close(); runtime = createAgentRuntime(storage, options);
  projection = createAgentConversationProjection(runtime);
  assert.equal((await projection.conversation(identity, sessionId)).messages[0].editedAt, revisedAt);
  assert.equal((await runtime.request(identity, sessionId, request.requestId)).input.text, request.text);
  await validateAgentRuntime(storage);
});

test('conversation projection keeps Step order and tool timestamps for one chronological execution list', async () => {
  const sessionId = randomUUID(), turnId = randomUUID(), firstStep = randomUUID(), secondStep = randomUUID();
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: 'student' };
  const at = second => new Date(Date.UTC(2026, 10, 16, 0, 0, second)).toISOString();
  const turn = { turnId, sessionId, requestId: randomUUID(), trigger: 'user', originNotificationId: null, state: 'completed', reason: '',
    ownerInstanceId: 'fixture', createdAt: at(0), updatedAt: at(6), completedAt: at(6) };
  const step = (stepId, stepNo, createdAt) => ({ stepId, turnId, stepNo, state: 'completed', snapshot: {}, createdAt,
    updatedAt: createdAt, completedAt: createdAt });
  const call = (toolCallId, stepId, createdAt) => ({ toolCallId, stepId, callIndex: 1, nativeCallId: toolCallId, name: 'skill_load',
    input: {}, executionMode: 'foreground', state: 'closed', result: { kind: 'completed', summary: 'read', data: {} },
    taskId: null, createdAt, updatedAt: createdAt });
  const firstAttempt = randomUUID(), secondAttempt = randomUUID();
  const runtime = {
    events: async () => [
      { sessionId, seq: 1, eventId: randomUUID(), kind: 'model-progress', version: 1, createdAt: at(1),
        body: { turnId, stepId: firstStep, attemptId: firstAttempt, revision: 1, text: '', thinking: 'first thinking' } },
      { sessionId, seq: 2, eventId: randomUUID(), kind: 'model-progress', version: 1, createdAt: at(4),
        body: { turnId, stepId: secondStep, attemptId: secondAttempt, revision: 1, text: '', thinking: 'second thinking' } },
    ],
    sessionSnapshot: async () => ({ session: { sessionId, identity, scenario: 'fixture', createdAt: at(0) }, automaticWakeBlocked: null,
      turns: [turn], inputs: [], steps: [step(firstStep, 1, at(0)), step(secondStep, 2, at(3))], attempts: [],
      toolCalls: [call(randomUUID(), secondStep, at(5)), call(randomUUID(), firstStep, at(2))], questions: [], notifications: [] }),
  };
  const conversation = await createAgentConversationProjection(runtime).conversation(identity, sessionId);
  assert.deepEqual(conversation.thinking.map(item => ({ stepNo: item.stepNo, createdAt: item.createdAt })), [
    { stepNo: 1, createdAt: at(1) }, { stepNo: 2, createdAt: at(4) },
  ]);
  assert.deepEqual(conversation.tools.map(item => ({ stepNo: item.stepNo, createdAt: item.createdAt })), [
    { stepNo: 2, createdAt: at(5) }, { stepNo: 1, createdAt: at(2) },
  ]);
});

test('question answers stay in the question record and never become duplicate user bubbles', async () => {
  const sessionId = randomUUID(), turnId = randomUUID(), normalInput = randomUUID(), answerInput = randomUUID();
  const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: 'student' };
  const at = new Date().toISOString();
  const input = (inputId, text, context) => ({ inputId, turnId, version: 1, state: 'adopted', createdAt: at,
    input: { requestId: randomUUID(), sessionId, text, context } });
  const runtime = {
    events: async () => [],
    sessionSnapshot: async () => ({ session: { sessionId, identity, scenario: 'fixture', createdAt: at }, automaticWakeBlocked: null,
      turns: [{ turnId, sessionId, requestId: randomUUID(), trigger: 'user', originNotificationId: null, state: 'active', reason: '',
        ownerInstanceId: 'fixture', createdAt: at, updatedAt: at, completedAt: null }],
      inputs: [input(normalInput, 'normal question', {}), input(answerInput, 'selected answer', { questionId: randomUUID(), questionVersion: 2 })],
      steps: [], attempts: [], toolCalls: [], questions: [], notifications: [] }),
  };
  const conversation = await createAgentConversationProjection(runtime).conversation(identity, sessionId);
  assert.deepEqual(conversation.messages.map(message => message.text), ['normal question']);
  assert.ok(conversation.inputs.some(item => item.inputId === answerInput), 'the durable answer input remains available to replay');
});
