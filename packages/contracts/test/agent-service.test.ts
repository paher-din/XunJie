import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentSessionCallSchema, agentSessionsCapability, agentConversationSchema } from '../dist/agent-service.js';
import { agentDependencyToolOutcomeSchema } from '../dist/agent-dependencies.js';

test('dependency tool outcomes are the same five explicit kinds', () => {
  const accepted = { kind: 'accepted', taskId: 'task-1', summary: 'accepted' };
  assert.deepEqual(agentDependencyToolOutcomeSchema.parse(accepted), accepted);
  assert.deepEqual(agentDependencyToolOutcomeSchema.parse({ kind: 'not_started', reason: 'cancelled' }),
    { kind: 'not_started', reason: 'cancelled' });
  for (const invalid of [
    { state: 'accepted', continuation: true, feedback: { outcome: 'success', text: 'accepted original command', images: [] } },
    { kind: 'accepted', taskId: 'task-1', summary: 'accepted', wait: { kind: 'fixture', presentation: {}, interruptible: true } },
  ]) assert.equal(agentDependencyToolOutcomeSchema.safeParse(invalid).success, false);
});

const sessionId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const stepId = '33333333-3333-4333-8333-333333333333';
const operationId = '44444444-4444-4444-8444-444444444444';
const identity = { environmentId: '55555555-5555-4555-8555-555555555555',
  spaceId: '66666666-6666-4666-8666-666666666666', principalId: '77777777-7777-4777-8777-777777777777', kind: 'personal', name: '学生' };

test('session RPC admits only explicit v3 operations and one consistent session scope', () => {
  const call = { version: 3, operation: 'submit', identity, sessionId, args: { input: { sessionId, requestId, text: '解释递归' } } };
  assert.equal(agentSessionsCapability, 'agent.sessions.v3');
  const parsed = agentSessionCallSchema.parse(JSON.parse(JSON.stringify(call)));
  assert.equal(parsed.operation, 'submit');
  if (parsed.operation !== 'submit') return;
  assert.deepEqual(parsed.args.input.context, {});
  assert.equal('mode' in parsed.args.input, false);
  for (const invalid of [
    { ...call, version: 2 }, { ...call, operation: 'run' }, { ...call, operation: 'accept' },
    { ...call, trusted: true },
    { ...call, args: { input: { ...call.args.input, sessionId: requestId } } },
    { ...call, identity: { ...identity, activityId: requestId } },
  ]) assert.equal(agentSessionCallSchema.safeParse(invalid).success, false);
  const initialize = { ...call, operation: 'initialize', args: { session: { sessionId, identity,
    scenario: 'student-assistant', createdAt: '2026-11-13T00:00:00.000Z' } } };
  assert.equal(agentSessionCallSchema.safeParse(initialize).success, true);
  assert.equal(agentSessionCallSchema.safeParse({ ...initialize,
    args: { session: { ...initialize.args.session, identity: { ...identity, principalId: requestId } } } }).success, false);
  const permit = { sessionId, runId: requestId, stepId, operationId, generation: 1 };
  const assertCall = { ...call, operation: 'assertDispatch', args: { permit } };
  assert.equal(agentSessionCallSchema.safeParse(assertCall).success, true);
  assert.equal(agentSessionCallSchema.safeParse({ ...assertCall,
    args: { permit: { ...permit, sessionId: requestId } } }).success, false);
});

test('conversation is a strict browser projection with no old activity or native SDK shapes', () => {
  const turnId = requestId, inputId = '88888888-8888-4888-8888-888888888888';
  const toolCallId = '99999999-9999-4999-8999-999999999999', questionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const createdAt = '2026-11-13T00:00:00.000Z';
  const turn = { turnId, sessionId, requestId, trigger: 'user', originNotificationId: null, state: 'active',
    reason: '', ownerInstanceId: 'owner-1', createdAt, updatedAt: createdAt, completedAt: null };
  const question = { questionId, sessionId, turnId, stepId, toolCallId, version: 1, state: 'pending',
    presentation: { question: '需要例子吗？' }, answer: null, answerRequestId: null, deadline: null, createdAt, updatedAt: createdAt };
  const conversation = { sessionId, lastSeq: 3,
    messages: [{ messageId: 'input:' + inputId, turnId, inputId, role: 'user', text: '解释递归', createdAt, state: 'settled' }],
    turns: [turn],
    inputs: [{ inputId, turnId, version: 1, state: 'adopted', text: '解释递归', createdAt }],
    questions: [question],
    tools: [{ toolCallId, turnId, stepId, name: 'read_learning', state: 'closed',
      result: { kind: 'completed', outcome: 'success', summary: '已有资料' } }],
    workspaces: [{ toolCallId, turnId, workspace: { activityId: operationId, title: '递归练习' } }],
  };
  assert.deepEqual(agentConversationSchema.parse(JSON.parse(JSON.stringify(conversation))), conversation);
  for (const invalid of [
    { ...conversation, activityId: operationId },
    { ...conversation, messages: [{ ...conversation.messages[0], sdkResponse: {} }] },
    { ...conversation, runs: [] },
    { ...conversation, waits: [] },
    { ...conversation, tools: [{ ...conversation.tools[0], result: { native: new Date() } }] },
    { ...conversation, workspaces: [{ toolCallId, turnId, workspace: { native: new Date() } }] },
  ]) assert.equal(agentConversationSchema.safeParse(invalid).success, false);
});
