import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createWorkspaceAssistant } from '../dist/index.js';

const identity = { kind: 'personal', name: '学生', environmentId: randomUUID(),
  spaceId: randomUUID(), principalId: randomUUID() };
const activityId = randomUUID();
const v7 = { objectId: randomUUID(), contentId: randomUUID(), name: 'alu.sv', kind: 'code',
  encoding: 'utf8', mediaType: 'text/plain', value: 'module alu; // v7' };
const v8 = { ...v7, objectId: randomUUID(), contentId: randomUUID(), value: 'module alu; // v8' };
const activity = { activityId, identity, target: { environmentId: identity.environmentId,
  serviceId: randomUUID(), version: 1 }, goal: '比较版本', question: '', references: [],
  status: 'open', createdAt: new Date().toISOString() };
const action = { requestId: randomUUID(), scope: { environmentId: identity.environmentId,
  spaceId: identity.spaceId, principalId: identity.principalId, activityId },
  receiver: { receiverId: 'teaching-agent', location: 'local', kind: 'question' },
  draft: { token: randomUUID(), question: '按 v7 回答', references: [], bases: [] },
  works: [v8], evidence: [] };
const input = { identity, sessionId: randomUUID(), turnId: randomUUID(), stepId: randomUUID(),
  inputIds: [], sessionState: { workspaceInputs: [{ inputId: randomUUID(), action }] } };
const history = [{ id: 'v7-question', version: 1, role: 'user', text: '按 v7 回答',
  sources: [{ sourceId: 'work:' + v7.objectId + ':' + v7.contentId, label: 'alu.sv v7',
    source: { kind: 'work', objectId: v7.objectId, contentId: v7.contentId } }] }];

function options(retained) {
  return {
    workspace: async () => activity,
    learning: {
      open: async () => activity,
      works: {
        content: async () => v8,
        inspectVersion: async (_identity, _activityId, fixed) => ({
          retained: retained && fixed.objectId === v7.objectId && fixed.contentId === v7.contentId,
        }),
      },
      drafts: { verifyReferences: async () => {} },
    },
  };
}

test('提交 v8 后，旧引用在当前版本仍保留时可按原 v7 身份重新授权回读', async () => {
  const scenario = createWorkspaceAssistant(options(true));
  const authorized = await scenario.authorizeHistory(input, history);
  assert.deepEqual(authorized, history);
});

test('旧版本不再保留时移除旧正文并留下可解释缺口', async () => {
  const scenario = createWorkspaceAssistant(options(false));
  const authorized = await scenario.authorizeHistory(input, history);
  assert.equal(authorized.some(entry => entry.id === 'v7-question'), false);
  assert.equal(authorized.length, 1);
  assert.match(authorized[0].text, /原来源当前不可访问或无法核验/);
  assert.equal(authorized[0].sources, undefined);
});
