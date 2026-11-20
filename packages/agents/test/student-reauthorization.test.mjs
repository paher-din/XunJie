import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createStudentAssistant } from '../dist/index.js';

test('主页重新授权时，同一固定实验的状态回执不能授权旧结果正文', async () => {
  const identity = { kind: 'personal', name: '学生', environmentId: randomUUID(),
    spaceId: randomUUID(), principalId: randomUUID() };
  const scene = createStudentAssistant({ learning: { localPersonalIdentity: identity,
    localLearningTarget: { environmentId: identity.environmentId, serviceId: randomUUID(), version: 1 },
    async historySource(_identity, _sessionId, source) { return source.statusOnly === true; } } });
  const input = { identity, sessionId: randomUUID(), turnId: randomUUID(), stepId: randomUUID(),
    inputIds: [], inputs: [], sessionState: {} };
  const entry = (id, statusOnly) => ({ id, version: 1, role: 'user', text: id,
    sources: [{ sourceId: 'fixed-experiment', label: 'ALU', source: { kind: 'experiment-reference', statusOnly } }] });
  const projected = await scene.authorizeHistory(input, [entry('状态', true), entry('旧结果', false)]);
  assert.equal(projected.some(item => item.id === '状态'), true);
  assert.equal(projected.some(item => item.id === '旧结果'), false);
});
