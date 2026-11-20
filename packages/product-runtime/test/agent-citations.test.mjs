import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createAgentConversationProjection } from '../dist/agent-conversation.js';

test('conversation projects cite_source results as opening citations without duplicating the tool row', async () => {
  const sessionId = randomUUID(), turnId = randomUUID(), stepId = randomUUID(), inputId = randomUUID();
  const now = new Date().toISOString();
  const identity = { kind: 'personal', name: '学生', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const citation = { citationId: randomUUID(), claim: 'v7 的进位来自第 5 位', label: '固定作品 v7',
    materialId: 'M-v7', source: { kind: 'work', objectId: randomUUID(), contentId: randomUUID() },
    range: null, version: 'v7', digest: 'digest' };
  const projection = createAgentConversationProjection({
    events: async () => [],
    sessionSnapshot: async () => ({
      session: { sessionId, identity, scenario: 'workspace-assistant', createdAt: now },
      automaticWakeBlocked: null,
      turns: [{ turnId, sessionId, requestId: randomUUID(), trigger: 'user', originNotificationId: null,
        state: 'completed', reason: '', ownerInstanceId: 'owner', createdAt: now, updatedAt: now, completedAt: now }],
      inputs: [{ inputId, turnId, version: 1, state: 'adopted', createdAt: now,
        input: { requestId: randomUUID(), sessionId, text: '请核对', context: {} } }],
      steps: [{ stepId, turnId, stepNo: 1, state: 'completed', snapshot: {}, createdAt: now, updatedAt: now, completedAt: now }],
      attempts: [],
      toolCalls: [{ toolCallId: randomUUID(), stepId, callIndex: 0, nativeCallId: 'call-1', name: 'cite_source',
        input: { materialId: 'M-v7' }, executionMode: 'foreground', state: 'closed',
        result: { kind: 'completed', outcome: 'success', summary: '已记录出处', data: { citation } },
        taskId: null, createdAt: now, updatedAt: now }],
      questions: [], notifications: [],
    }),
  });
  const value = await projection.conversation(identity, sessionId);
  assert.equal(value.citations?.length, 1);
  assert.equal(value.citations?.[0].citation.claim, 'v7 的进位来自第 5 位');
  assert.equal(value.tools.length, 0, 'cite_source 作为出处呈现，不再重复成工具行');
});

test('a completed home reply retains the verified experiment entry without a model citation', async () => {
  const sessionId = randomUUID(), turnId = randomUUID(), stepId = randomUUID(), attemptId = randomUUID();
  const executionRef = randomUUID(), inputId = randomUUID(), now = new Date().toISOString();
  const identity = { kind: 'personal', name: '学生', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const evidence = { kind: 'system-observation', readState: 'included', citationAllowed: true,
    source: { kind: 'experiment-reference', executionRef, statusOnly: false }, materialId: 'M-experiment',
    label: '工作区实验', range: null, version: executionRef, digest: 'digest' };
  const projection = createAgentConversationProjection({
    events: async () => [],
    sessionSnapshot: async () => ({
      session: { sessionId, identity, scenario: 'student-assistant', createdAt: now },
      turns: [{ turnId, sessionId, requestId: randomUUID(), trigger: 'user', originNotificationId: null,
        state: 'completed', reason: '', ownerInstanceId: 'owner', createdAt: now, updatedAt: now, completedAt: now }],
      inputs: [{ inputId, turnId, version: 1, state: 'adopted', createdAt: now,
        input: { requestId: randomUUID(), sessionId, text: '核对实验', context: {} } }],
      steps: [{ stepId, turnId, stepNo: 1, state: 'completed', createdAt: now, updatedAt: now, completedAt: now,
        snapshot: { attemptContexts: { [attemptId]: { materials: [evidence,
          { ...evidence, source: { ...evidence.source, executionRef: randomUUID(), statusOnly: true } },
          { ...evidence, source: { ...evidence.source, executionRef: randomUUID() }, readState: 'omitted' },
        ] } } } }],
      attempts: [{ attemptId, stepId, state: 'completed', responseRef: randomUUID() }],
      toolCalls: [], questions: [],
    }),
  });
  const value = await projection.conversation(identity, sessionId);
  assert.equal(value.citations?.length, 1);
  assert.equal(value.citations[0].citation.source.executionRef, executionRef);
  assert.equal(value.citations[0].toolCallId, undefined);
  assert.equal(value.citations[0].inputId, inputId);
});

test('retiring an edited Turn removes its message, tool citation, inline citation and experiment citation together', async () => {
  const sessionId = randomUUID(), turnId = randomUUID(), stepId = randomUUID(), inputId = randomUUID(), attemptId = randomUUID();
  const now = new Date().toISOString();
  const identity = { kind: 'personal', name: '学生', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const material = { materialId: 'M-inline', sourceId: 'experiment', kind: 'system-observation', author: 'system',
    label: '工作区实验', version: 'v1', range: null, digest: 'digest', readState: 'included', citationAllowed: true,
    source: { kind: 'experiment-reference', statusOnly: false, executionRef: randomUUID() } };
  const toolCitation = { citationId: randomUUID(), claim: '旧工具出处', label: '旧作品', materialId: 'M-tool',
    source: { kind: 'work', objectId: randomUUID(), contentId: randomUUID() }, range: null, version: 'v1', digest: 'digest' };
  const event = (seq, kind, body) => ({ sessionId, seq, eventId: randomUUID(), version: 1, kind, body, createdAt: now });
  const projection = createAgentConversationProjection({
    events: async () => [
      event(1, 'input-received', { inputId }),
      event(2, 'input-edited', { inputId, retiredTurnIds: [turnId] }),
      event(3, 'assistant', { turnId, stepId, attemptId, text: '旧回答' }),
      event(4, 'inline-citations', { turnId, stepId, attemptId, citations: [{ claim: '旧内联出处', materialId: 'M-inline' }] }),
    ],
    sessionSnapshot: async () => ({
      session: { sessionId, identity, scenario: 'student-assistant', createdAt: now },
      turns: [{ turnId, sessionId, requestId: randomUUID(), trigger: 'user', originNotificationId: null,
        state: 'completed', reason: '', ownerInstanceId: 'owner', createdAt: now, updatedAt: now, completedAt: now }],
      inputs: [{ inputId, turnId, version: 1, state: 'adopted', createdAt: now,
        input: { requestId: randomUUID(), sessionId, text: '旧问题', context: {} } }],
      steps: [{ stepId, turnId, stepNo: 1, state: 'completed', createdAt: now, updatedAt: now, completedAt: now,
        snapshot: { context: { materials: [material] }, attemptContexts: { [attemptId]: { materials: [material] } } } }],
      attempts: [{ attemptId, stepId, state: 'completed', responseRef: randomUUID() }],
      toolCalls: [{ toolCallId: randomUUID(), stepId, callIndex: 0, nativeCallId: 'call-old', name: 'cite_source',
        input: {}, executionMode: 'foreground', state: 'closed',
        result: { kind: 'completed', outcome: 'success', summary: '已记录出处', data: { citation: toolCitation } },
        taskId: null, createdAt: now, updatedAt: now }],
      questions: [], notifications: [],
    }),
  });
  const value = await projection.conversation(identity, sessionId);
  assert.equal(value.messages.filter(message => message.role === 'assistant').length, 0);
  assert.equal(value.citations?.length ?? 0, 0);
});

test('each assistant response keeps only the citations from its own Step and Attempt', async () => {
  const sessionId = randomUUID(), turnId = randomUUID(), inputId = randomUUID();
  const stepA = randomUUID(), stepB = randomUUID(), attemptA = randomUUID(), failedAttemptA = randomUUID(), attemptB = randomUUID();
  const now = new Date().toISOString();
  const identity = { kind: 'personal', name: '学生', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const material = id => ({ materialId: id, sourceId: 'experiment', kind: 'system-observation', author: 'system',
    label: '实验 ' + id, version: 'v1', range: null, digest: 'digest', readState: 'included', citationAllowed: true,
    source: { kind: 'experiment-reference', statusOnly: false, executionRef: randomUUID() } });
  const event = (seq, kind, body) => ({ sessionId, seq, eventId: randomUUID(), version: 1, kind, body, createdAt: now });
  const projection = createAgentConversationProjection({
    events: async () => [
      event(1, 'inline-citations', { turnId, stepId: stepA, attemptId: attemptA, citations: [{ claim: 'A 的出处', materialId: 'M-A' }] }),
      event(2, 'assistant', { turnId, stepId: stepA, attemptId: attemptA, text: 'A 的回答' }),
      event(3, 'assistant', { turnId, stepId: stepB, attemptId: attemptB, text: 'B 的回答' }),
      event(4, 'inline-citations', { turnId, stepId: stepB, attemptId: attemptB, citations: [{ claim: 'B 的出处', materialId: 'M-B' }] }),
      event(5, 'model-progress', { turnId, stepId: stepB, attemptId: failedAttemptA, revision: 1, text: '旧失败回答' }),
      event(6, 'inline-citations', { turnId, stepId: stepB, attemptId: failedAttemptA, citations: [{ claim: '旧失败出处', materialId: 'M-B' }] }),
    ],
    sessionSnapshot: async () => ({
      session: { sessionId, identity, scenario: 'student-assistant', createdAt: now },
      turns: [{ turnId, sessionId, requestId: randomUUID(), trigger: 'user', originNotificationId: null,
        state: 'completed', reason: '', ownerInstanceId: 'owner', createdAt: now, updatedAt: now, completedAt: now }],
      inputs: [{ inputId, turnId, version: 1, state: 'adopted', createdAt: now,
        input: { requestId: randomUUID(), sessionId, text: '多步问题', context: {} } }],
      steps: [
        { stepId: stepA, turnId, stepNo: 1, state: 'completed', createdAt: now, updatedAt: now, completedAt: now,
          snapshot: { context: { materials: [material('M-A')] } } },
        { stepId: stepB, turnId, stepNo: 2, state: 'completed', createdAt: now, updatedAt: now, completedAt: now,
          snapshot: { context: { materials: [material('M-B')] } } },
      ],
      attempts: [
        { attemptId: failedAttemptA, stepId: stepB, attemptNo: 1, state: 'failed', responseRef: null },
        { attemptId: attemptA, stepId: stepA, attemptNo: 1, state: 'completed', responseRef: randomUUID() },
        { attemptId: attemptB, stepId: stepB, attemptNo: 2, state: 'completed', responseRef: randomUUID() },
      ],
      toolCalls: [], questions: [], notifications: [],
    }),
  });
  const value = await projection.conversation(identity, sessionId);
  const assistants = value.messages.filter(message => message.role === 'assistant');
  const byAttempt = new Map(assistants.map(message => [message.attemptId, message]));
  assert.equal(byAttempt.get(attemptA)?.stepId, stepA);
  assert.equal(byAttempt.get(attemptB)?.stepId, stepB);
  const citations = value.citations ?? [];
  assert.deepEqual(citations.map(item => item.citation.claim).sort(), ['A 的出处', 'B 的出处', '旧失败出处']);
  for (const item of citations) {
    if (item.citation.claim === 'A 的出处') assert.equal(item.attemptId, attemptA);
    if (item.citation.claim === 'B 的出处') assert.equal(item.attemptId, attemptB);
    if (item.citation.claim === '旧失败出处') assert.equal(item.attemptId, failedAttemptA);
  }
});

test('inline citation markers remain structured evidence without becoming a second answer', async () => {
  const sessionId = randomUUID(), turnId = randomUUID(), stepId = randomUUID(), inputId = randomUUID();
  const executionRef = randomUUID(), now = new Date().toISOString();
  const identity = { kind: 'personal', name: '学生', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const material = { materialId: 'M-inline', sourceId: 'experiment', kind: 'system-observation', author: 'system',
    label: '工作区实验', version: executionRef, range: null, digest: 'digest', readState: 'included', citationAllowed: true,
    source: { kind: 'experiment-reference', statusOnly: false, executionRef } };
  const event = { sessionId, seq: 1, eventId: randomUUID(), version: 1, kind: 'inline-citations', createdAt: now,
    body: { turnId, stepId, attemptId: randomUUID(), citations: [{ claim: '实测 F=0001', materialId: 'M-inline' }] } };
  const projection = createAgentConversationProjection({
    events: async () => [event],
    sessionSnapshot: async () => ({
      session: { sessionId, identity, scenario: 'student-assistant', createdAt: now },
      turns: [{ turnId, sessionId, requestId: randomUUID(), trigger: 'user', originNotificationId: null,
        state: 'completed', reason: '', ownerInstanceId: 'owner', createdAt: now, updatedAt: now, completedAt: now }],
      inputs: [{ inputId, turnId, version: 1, state: 'adopted', createdAt: now,
        input: { requestId: randomUUID(), sessionId, text: '核对实验', context: {} } }],
      steps: [{ stepId, turnId, stepNo: 1, state: 'completed', createdAt: now, updatedAt: now, completedAt: now,
        snapshot: { context: { materials: [material] } } }],
      attempts: [], toolCalls: [], questions: [],
    }),
  });
  const value = await projection.conversation(identity, sessionId);
  assert.equal(value.citations?.length, 1);
  assert.equal(value.citations[0].citation.claim, '实测 F=0001');
  assert.equal(value.messages.filter(message => message.role === 'assistant').length, 0, '引用标记不生成额外的助手回答');
});

test('a tool-only citation attaches to the next saved answer to the same input', async () => {
  const sessionId = randomUUID(), turnId = randomUUID();
  const identity = { kind: 'personal', name: 'Student', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const at = second => new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString();
  const inputs = [0, 5].map(second => ({ inputId: randomUUID(), turnId, version: 1, state: 'adopted', createdAt: at(second),
    input: { requestId: randomUUID(), sessionId, text: 'Read the handout', context: {} } }));
  const steps = ['Earlier reply', '', 'Handout answer', '', 'Next topic'].map((text, index) => ({
    stepId: randomUUID(), turnId, stepNo: index + 1, state: 'completed', snapshot: {},
    createdAt: at(index + 1), updatedAt: at(index + 1), completedAt: at(index + 1),
    attemptId: randomUUID(), text,
  }));
  const attempts = steps.map(step => ({ attemptId: step.attemptId, stepId: step.stepId,
    state: 'completed', responseRef: randomUUID() }));
  const events = steps.map((step, index) => ({ sessionId, seq: index + 1, eventId: randomUUID(), version: 1,
    kind: 'assistant', createdAt: step.createdAt, body: { turnId, stepId: step.stepId, attemptId: step.attemptId, text: step.text } }));
  const [withText, toolOnly, answer, unanswered] = steps;
  const toolCalls = [withText, toolOnly, unanswered].map(step => {
    const citation = { citationId: randomUUID(), claim: 'Page 2', label: 'Handout',
      source: { kind: 'tool-call', toolCallId: randomUUID() }, range: null, version: 'v1', digest: 'digest' };
    return { toolCallId: randomUUID(), stepId: step.stepId, name: 'cite_source',
      result: { kind: 'completed', outcome: 'success', data: { citation } } };
  });
  const projection = createAgentConversationProjection({
    events: async (_identity, _sessionId, after = 0) => events.filter(event => event.seq > after),
    sessionSnapshot: async () => ({
      session: { sessionId, identity, scenario: 'student-assistant', createdAt: at(0) },
      turns: [{ turnId, sessionId, requestId: randomUUID(), trigger: 'user', originNotificationId: null,
        state: 'completed', reason: '', ownerInstanceId: 'owner', createdAt: at(0), updatedAt: at(5), completedAt: at(5) }],
      inputs, steps, attempts, toolCalls, questions: [], notifications: [],
    }),
  });
  const check = value => {
    const citations = new Map(value.citations.map(item => [item.toolCallId, item]));
    assert.equal(citations.get(toolCalls[0].toolCallId).attemptId, withText.attemptId);
    assert.equal(citations.get(toolCalls[1].toolCallId).stepId, answer.stepId);
    assert.equal(citations.get(toolCalls[1].toolCallId).attemptId, answer.attemptId);
    assert.equal(citations.get(toolCalls[2].toolCallId).attemptId, unanswered.attemptId);
  };
  check(await projection.conversation(identity, sessionId));
  const delta = await projection.conversation(identity, sessionId, 2);
  assert.equal(delta.reset, true);
  check(delta);
  assert.equal((await projection.conversation(identity, sessionId, 5)).citations, undefined);
});
