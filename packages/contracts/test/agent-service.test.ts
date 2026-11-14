import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentSessionCallSchema, agentSessionsCapability, agentConversationSchema } from '../dist/agent-service.js';
import { agentDependencyToolOutcomeSchema } from '../dist/agent-dependencies.js';

test('generic tool wire retains continuation authority and explicitly interruptible waits', () => {
  const outcome = { state: 'accepted', continuation: true,
    feedback: { outcome: 'success', text: 'accepted original command', images: [] }, result: {},
    wait: { kind: 'fixture', presentation: {}, deadline: null, interruptible: true } };
  assert.deepEqual(agentDependencyToolOutcomeSchema.parse(JSON.parse(JSON.stringify(outcome))), outcome);
});

const sessionId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const identity = { environmentId: '33333333-3333-4333-8333-333333333333',
  spaceId: '44444444-4444-4444-8444-444444444444', principalId: '55555555-5555-4555-8555-555555555555', kind: 'personal', name: '学生' };

test('session RPC admits only explicit v2 operations and one consistent session scope', () => {
  const call = { version: 2, operation: 'accept', identity, sessionId, args: { input: { sessionId, requestId, text: '解释递归' } } };
  assert.equal(agentSessionsCapability, 'agent.sessions.v2');
  assert.equal(agentSessionCallSchema.parse(JSON.parse(JSON.stringify(call))).args.input.mode, 'steering');
  for (const invalid of [
    { ...call, version: 1 }, { ...call, operation: 'conversation' }, { ...call, trusted: true },
    { ...call, args: { ...call.args, version: 1 } },
    { ...call, args: { input: { ...call.args.input, sessionId: requestId } } },
    { ...call, identity: { ...identity, activityId: requestId } },
  ]) assert.equal(agentSessionCallSchema.safeParse(invalid).success, false);
  const initialize = { ...call, operation: 'initialize', args: { session: { sessionId, identity,
    scenario: 'student-assistant', restartPolicy: 'explicit', createdAt: '2026-11-13T00:00:00.000Z' } } };
  assert.equal(agentSessionCallSchema.safeParse(initialize).success, true);
  assert.equal(agentSessionCallSchema.safeParse({ ...initialize,
    args: { session: { ...initialize.args.session, identity: { ...identity, principalId: requestId } } } }).success, false);
});


test('conversation is a strict browser projection with no old activity or native SDK shapes', () => {
  const runId = requestId, inputId = '66666666-6666-4666-8666-666666666666', operationId = '77777777-7777-4777-8777-777777777777';
  const createdAt = '2026-11-13T00:00:00.000Z';
  const run = { runId, sessionId, inputId, requestId, state: 'waiting', reason: '', generation: 1,
    stopRequested: false, needsContinue: false, previousRunId: null, createdAt, updatedAt: createdAt, completedAt: null };
  const conversation = { sessionId, lastSeq: 3,
    messages: [{ messageId: 'input:' + inputId, runId, inputId, role: 'user', text: '解释递归', createdAt, state: 'settled' }],
    runs: [run], inputs: [{ inputId, runId, version: 1, mode: 'steering', state: 'adopted', text: '解释递归', createdAt }],
    waits: [{ waitId: operationId, runId, operationId, version: 1, kind: 'user', state: 'pending',
      presentation: { question: '需要例子吗？' }, response: null, deadline: null }],
    tools: [{ operationId, runId, name: 'read_learning', state: 'completed', feedback: { outcome: 'success', text: '已有资料', images: [] } }],
    workspaces: [{ operationId, runId, workspace: { activityId: operationId, title: '递归练习' } }],
  };
  assert.deepEqual(agentConversationSchema.parse(JSON.parse(JSON.stringify(conversation))), conversation);
  for (const invalid of [
    { ...conversation, activityId: operationId },
    { ...conversation, messages: [{ ...conversation.messages[0], sdkResponse: {} }] },
    { ...conversation, runs: [{ ...run, sessionId: operationId }] },
    { ...conversation, waits: [{ ...conversation.waits[0], runId: operationId }] },
    { ...conversation, tools: [{ ...conversation.tools[0], feedback: { outcome: 'success', text: '', images: [{ native: true }] } }] },
    { ...conversation, workspaces: [{ operationId, runId, workspace: { native: new Date() } }] },
  ]) assert.equal(agentConversationSchema.safeParse(invalid).success, false);
});
