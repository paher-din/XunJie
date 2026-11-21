import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { test } from 'node:test';
import { provisionStorage, openStorage, createFileBackend } from '@xunjie/storage';
import { canonicalDigest } from '@xunjie/storage/identity';
import { agentRuntimeMigrations, validateAgentRuntime, createAgentRuntime } from '@xunjie/agent-runtime';
import { nativeFixture } from '../../storage/test/native-fixture.mjs';
import { importLegacyAgentHistory } from '../dist/legacy-agent-history.js';
import { createAgentConversationProjection } from '../dist/agent-conversation.js';
import { legacyTeachingConversation } from '../../../scripts/lib/legacy-teaching-history.mjs';

test('legacy import preserves the visible branch and edit time, is idempotent, survives restart and never replays old tools', async t => {
  const pg = await nativeFixture(), owner = { environmentId: randomUUID(), serviceId: randomUUID() };
  const binding = await provisionStorage({ admin: pg.admin, owner, password: randomUUID(), migrations: agentRuntimeMigrations });
  const storage = await openStorage({ binding, migrations: agentRuntimeMigrations,
    backend: createFileBackend({ id: 'legacy-import', root: join(pg.root, 'legacy-import') }) });
  let runtime;
  t.after(async () => { await runtime?.close(); await storage.close(); await pg.close(); });
  const session = { sessionId: randomUUID(), scenario: 'student-assistant', createdAt: '2026-11-01T10:00:00.000Z',
    identity: { environmentId: owner.environmentId, spaceId: randomUUID(), principalId: randomUUID(), kind: 'personal', name: 'student' } };
  const runId = randomUUID(), inputId = randomUUID(), editedAt = '2026-11-02T10:00:00.000Z';
  const legacy = { runs: [{ runId, requestId: randomUUID(), state: 'waiting', createdAt: session.createdAt, updatedAt: editedAt, completedAt: null }],
    inputs: [{ inputId, adoptedRunId: runId, version: 2, createdAt: session.createdAt, input: { draft: { question: 'edited question' } } }],
    messages: [ { eventId: randomUUID(), inputId, runId, role: 'student', text: 'edited question', createdAt: session.createdAt, editedAt },
      { eventId: randomUUID(), runId, role: 'system', kind: 'native-summary', text: 'historical thinking', createdAt: editedAt },
      { eventId: randomUUID(), runId, role: 'assistant', text: 'historical answer', createdAt: editedAt } ],
    tools: [{ commandId: randomUUID(), runId, stepId: randomUUID(), name: 'old_side_effect', state: 'waiting', createdAt: editedAt, result: { note: 'original outcome' } }],
    questions: [{ questionId: randomUUID(), runId, question: 'Pick a topic', options: [{ id: 'a', label: 'Topic A' }], createdAt: editedAt }] };
  const conversation = legacyTeachingConversation(session.sessionId, legacy);
  const value = { session, conversation, source: { activityId: randomUUID(), digest: canonicalDigest(legacy) } };
  const receipt = await importLegacyAgentHistory(storage, value);
  assert.deepEqual(await importLegacyAgentHistory(storage, value), receipt);
  assert.equal((await storage.read('SELECT count(*) AS n FROM agent_turns')).rows[0].n, '0');
  await assert.rejects(importLegacyAgentHistory(storage, { ...value, source: { ...value.source, digest: 'f'.repeat(64) } }), { code: 'identity-conflict' });
  await assert.rejects(importLegacyAgentHistory(storage, { ...value, conversation: { ...conversation, sessionId: randomUUID() } }), { code: 'incompatible' });
  let modelCalls = 0, visibleHistory;
  const options = { authorize: async () => {}, scenario: { id: 'import-test', version: 1,
    context: async () => ({ system: 'fixture', facts: {}, sources: [] }), tools: async () => [],
    authorizeHistory: async (_input, history) => { visibleHistory = history; return history; } },
    gateway: { selection: { read: async () => { modelCalls++; return { selected: false, version: 0, options: [] }; } } } };
  runtime = createAgentRuntime(storage, options); await runtime.drain();
  assert.equal(modelCalls, 0);
  let projection = createAgentConversationProjection(runtime);
  const first = await projection.conversation(session.identity, session.sessionId);
  assert.equal(first.messages[0].editedAt, editedAt);
  assert.deepEqual(new Set(first.messages.map(message => message.text)), new Set(['edited question', 'historical answer', 'Pick a topic\nTopic A']));
  assert.equal(first.thinking[0].active, false); assert.equal(first.tools[0].state, 'closed');
  assert.equal(first.questions.length, 0); assert.equal(first.inputs[0].canEdit, false);
  assert.equal((await projection.conversation(session.identity, session.sessionId, first.lastSeq)).messages.length, 0);
  await runtime.close(); runtime = createAgentRuntime(storage, options);
  projection = createAgentConversationProjection(runtime);
  assert.deepEqual((await projection.conversation(session.identity, session.sessionId)).messages, first.messages);
  await runtime.submit(session.identity, { sessionId: session.sessionId, requestId: randomUUID(), text: 'new question', context: {} });
  await runtime.drain();
  assert.ok(visibleHistory.some(item => item.text === 'historical answer'));
  assert.equal(visibleHistory.some(item => item.text === 'historical thinking'), false);
  assert.equal((await storage.read('SELECT count(*) AS n FROM agent_tool_calls')).rows[0].n, '0');
  const busy = { ...session, sessionId: randomUUID() };
  await runtime.initialize(busy);
  await runtime.submit(busy.identity, { sessionId: busy.sessionId, requestId: randomUUID(), text: 'already active', context: {} });
  await runtime.drain();
  await assert.rejects(importLegacyAgentHistory(storage, { session: busy, conversation: { ...conversation, sessionId: busy.sessionId,
    turns: conversation.turns.map(turn => ({ ...turn, sessionId: busy.sessionId })) }, source: value.source }), { code: 'conflict' });
  await validateAgentRuntime(storage);
});

test('legacy continuation traces remain visible when the input was adopted by a later Run', async () => {
  const { importedAgentConversation } = await import('../dist/legacy-agent-history.js');
  const sessionId = randomUUID(), received = randomUUID(), adopted = randomUUID(), inputId = randomUUID();
  const at = '2026-11-01T10:00:00.000Z';
  const conversation = { sessionId, lastSeq: 0, messages: [{ messageId: 'legacy-user', turnId: received,
    inputId, role: 'user', text: 'question', createdAt: at, state: 'settled' }], turns: [], inputs: [],
    questions: [], workspaces: [], tools: [{ toolCallId: randomUUID(), stepId: randomUUID(), turnId: adopted,
      inputId, name: 'read_skill', state: 'closed', result: null }],
    thinking: [{ messageId: 'legacy-thinking', turnId: adopted, inputId, text: 'thinking', createdAt: at, active: false }] };
  const projected = importedAgentConversation(sessionId, { conversation });
  assert.equal(projected.thinking[0].inputId, undefined);
  assert.equal(projected.tools[0].inputId, undefined);
  assert.equal(conversation.thinking[0].inputId, inputId);
});
