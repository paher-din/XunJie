import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createAgentSessionClient, createBrowserAgentSessionCall } from '../dist/transport/session-service.js';

const identity = { environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: '学生' };
const sessionId = randomUUID(), requestId = randomUUID(), runId = randomUUID(), inputId = randomUUID(), waitId = randomUUID();
const createdAt = '2026-11-13T00:00:00.000Z';
const session = { sessionId, identity, scenario: 'student-assistant', restartPolicy: 'explicit', createdAt };
const input = { sessionId, requestId, text: '解释递归', mode: 'steering', context: {} };
const receipt = { sessionId, requestId, runId, inputId, inputDigest: 'a'.repeat(64) };
const run = { sessionId, requestId, runId, inputId, state: 'received', reason: '', generation: 0,
  stopRequested: false, needsContinue: false, previousRunId: null, createdAt, updatedAt: createdAt, completedAt: null };
const response = { requestId, waitId, expectedVersion: 1, answer: { text: '继续' } };
const snapshot = { session, run, revision: 0, state: {}, sessionState: {}, inputs: [], steps: [], waits: [] };
const conversation = { sessionId, lastSeq: 0, messages: [], runs: [run], inputs: [], waits: [], tools: [], workspaces: [] };

test('every v2 client result is validated and correlated before it reaches a consumer', async () => {
  const cases = [
    [client => client.initialize(session), { ...session, sessionId: randomUUID() }],
    [client => client.accept(identity, input), { ...receipt, requestId: randomUUID() }],
    [client => client.run(identity, sessionId, runId), { ...run, runId: randomUUID() }],
    [client => client.stop(identity, sessionId, runId, requestId), { ...run, sessionId: randomUUID() }],
    [client => client.continueRun(identity, sessionId, runId, requestId), { ...run, provider: { raw: true } }],
    [client => client.events(identity, sessionId), [{ sessionId: randomUUID(), seq: 1, eventId: randomUUID(), version: 1, kind: 'answer', body: {}, createdAt }]],
    [client => client.snapshot(identity, sessionId, runId), { ...snapshot, session: { ...session, identity: { ...identity, principalId: randomUUID() } } }],
    [client => client.respond(identity, sessionId, response), { runId, waitId: randomUUID() }],
    [client => client.resolveWait(identity, sessionId, { requestId, waitId, expectedVersion: 1, result: {} }), { runId, waitId, provider: {} }],
    [client => client.request(identity, sessionId, requestId), { receipt, input: { ...input, sessionId: randomUUID() } }],
    [client => client.conversation(identity, sessionId), { ...conversation, messages: [{ nativeCompletion: true }] }],
  ];
  for (const [invoke, output] of cases) {
    const client = createAgentSessionClient(async call => {
      assert.equal(JSON.parse(JSON.stringify(call)).version, 2);
      return output;
    });
    await assert.rejects(invoke(client), { code: 'incompatible' });
  }
  let calls = 0;
  const client = createAgentSessionClient(async () => { calls++; return receipt; });
  await assert.rejects(client.accept(identity, { ...input, identity }), { code: 'invalid' });
  assert.equal(calls, 0);
});

test('the browser helper uses host scope and cannot express host initialization or trusted wait results', () => {
  assert.deepEqual(createBrowserAgentSessionCall(identity, sessionId, 'accept', { input }),
    { version: 2, identity, sessionId, operation: 'accept', args: { input } });
  assert.deepEqual(createBrowserAgentSessionCall(identity, sessionId, 'conversation', {}),
    { version: 2, identity, sessionId, operation: 'conversation', args: { after: 0 } });
  assert.throws(() => createBrowserAgentSessionCall(identity, sessionId, 'initialize', { session }), { code: 'forbidden' });
  assert.throws(() => createBrowserAgentSessionCall(identity, sessionId, 'resolveWait', {
    resolution: { requestId, waitId, expectedVersion: 1, result: {} },
  }), { code: 'forbidden' });
  assert.throws(() => createBrowserAgentSessionCall(identity, sessionId, 'accept', { input: { ...input, sessionId: randomUUID() } }), { code: 'invalid' });
  assert.throws(() => createBrowserAgentSessionCall(identity, sessionId, 'events', { after: -1 }), { code: 'invalid' });
});

test('conversation is carried by the same client call type and rejects cross-session projection data', async () => {
  const client = createAgentSessionClient(async call => {
    assert.deepEqual(call, { version: 2, operation: 'conversation', identity, sessionId, args: { after: 4 } });
    return JSON.parse(JSON.stringify({ ...conversation, lastSeq: 4 }));
  });
  assert.deepEqual(await client.conversation(identity, sessionId, 4), { ...conversation, lastSeq: 4 });
  const wrong = createAgentSessionClient(async () => ({ ...conversation, sessionId: randomUUID() }));
  await assert.rejects(wrong.conversation(identity, sessionId), { code: 'incompatible' });
});
