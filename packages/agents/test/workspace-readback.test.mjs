import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { actionInputSchema } from '@xunjie/contracts/action-intents';
import { StorageError } from '@xunjie/storage';
import { createWorkspaceTools } from '../dist/workspace-assistant/index.js';

test('read_work 超长文本按工具自身的 offset/nextOffset 分页返回', async () => {
  const identity = { kind: 'personal', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), name: '学生' };
  const activityId = randomUUID(), target = { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 };
  const v7 = { objectId: randomUUID(), contentId: randomUUID(), name: 'long.c', kind: 'code', encoding: 'utf8',
    mediaType: 'text/plain', value: 'A'.repeat(300) + 'BOUNDARY_TAIL' };
  const scope = { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId };
  const reference = { referenceId: randomUUID(), source: { kind: 'work', objectId: v7.objectId, contentId: v7.contentId },
    sourceName: v7.name, range: { kind: 'code', start: 0, end: v7.value.length }, copy: 'A' };
  const action = actionInputSchema.parse({ requestId: randomUUID(), scope,
    receiver: { receiverId: 'browser-question', location: 'local', kind: 'question' },
    draft: { token: randomUUID(), question: '请分段读取', references: [reference], bases: [] }, works: [v7], evidence: [] });
  const activity = { activityId, identity, target, goal: '分段读取', question: '请分段读取', references: [],
    status: 'open', createdAt: new Date().toISOString() };
  const learning = {
    async open() { return activity; },
    works: {
      async content() { return v7; },
      async inspectVersion() { return { retained: true, isCurrent: true, everPublished: true }; },
    },
    drafts: { async verifyReferences() {} },
    executionRecords: { async read() { return null; } },
    executions: { async read() { return null; } },
  };
  const tools = await createWorkspaceTools({ workspace: async () => activity, learning }, {
    identity, sessionId: randomUUID(), turnId: randomUUID(), stepId: randomUUID(),
    inputIds: [], inputs: [], sessionState: { workspaceInputs: [{ inputId: randomUUID(), action }] },
  });
  const read = tools.find(tool => tool.definition.name === 'read_work');
  assert.ok(read);
  const run = input => read.execute({
    toolCallId: randomUUID(), nativeCallId: 'read-long', callIndex: 0, name: 'read_work', input, executionMode: 'foreground',
  }, { identity, sessionId: randomUUID(), turnId: randomUUID(), stepId: randomUUID(), toolCallId: randomUUID(),
    signal: new AbortController().signal, inputIds: [], originInputId: null, visibleAnswerInputIds: [],
    assertActive: async () => {}, ask: async () => ({ kind: 'closed' }) });
  const first = await run({ objectId: v7.objectId, contentId: v7.contentId, offset: 0, length: 100 });
  assert.equal(first.kind, 'completed');
  assert.equal(first.data.nextOffset, 100);
  assert.equal(first.data.length, 100);
  assert.equal(JSON.parse(first.summary).nextOffset, 100, '模型可见摘要保留该工具自己的 nextOffset');
  const second = await run({ objectId: v7.objectId, contentId: v7.contentId, offset: 100, length: 100 });
  assert.equal(second.data.nextOffset, 200);
});

test('read_work 可按同一 Session 已接纳的旧作品版本回读，而不是只看最新输入', async () => {
  const identity = { kind: 'personal', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID(), name: '学生' };
  const activityId = randomUUID(), target = { environmentId: randomUUID(), serviceId: randomUUID(), version: 1 };
  const v7 = { objectId: randomUUID(), contentId: randomUUID(), name: 'alu.sv', kind: 'code', encoding: 'utf8',
    mediaType: 'text/plain', value: 'module alu; // V7_MARKER\nendmodule' };
  const v8 = { ...v7, contentId: randomUUID(), value: 'module alu; // V8_MARKER\nendmodule' };
  const scope = { environmentId: identity.environmentId, spaceId: identity.spaceId, principalId: identity.principalId, activityId };
  const selected = 'V7_MARKER', start = v7.value.indexOf(selected);
  const reference = { referenceId: randomUUID(), source: { kind: 'work', objectId: v7.objectId, contentId: v7.contentId },
    sourceName: v7.name, range: { kind: 'code', start, end: start + selected.length }, copy: selected };
  const action = (file, question, references = []) => actionInputSchema.parse({ requestId: randomUUID(), scope,
    receiver: { receiverId: 'browser-question', location: 'local', kind: 'question' },
    draft: { token: randomUUID(), question, references, bases: [] }, works: [file], evidence: [] });
  const activity = { activityId, identity, target, goal: '比较版本', question: '请比较 v7 和 v8', references: [],
    status: 'open', createdAt: new Date().toISOString() };
  const calls = [];
  let revoked = false;
  const learning = {
    async open() { return activity; },
    works: {
      async content(_identity, _activityId, contentId) {
        calls.push(contentId);
        return contentId === v7.contentId ? v7 : v8;
      },
      async inspectVersion() { return { retained: true, isCurrent: false, everPublished: true }; },
    },
    drafts: { async verifyReferences(_actor, _activity, { references }) {
      if (revoked && references.some(item => item.referenceId === reference.referenceId)) throw new StorageError('forbidden');
    } },
    executionRecords: { async read() { return null; } },
    executions: { async read() { return null; } },
  };
  const workspaceInputs = [{ inputId: randomUUID(), action: action(v7, '先看 v7', [reference]) },
    { inputId: randomUUID(), action: action(v8, '再看 v8') }];
  const tools = await createWorkspaceTools({ workspace: async () => activity, learning }, {
    identity, sessionId: randomUUID(), turnId: randomUUID(), stepId: randomUUID(),
    inputIds: [], inputs: [], sessionState: { workspaceInputs },
  });
  const read = tools.find(tool => tool.definition.name === 'read_work');
  assert.ok(read);
  const run = (input = { objectId: v7.objectId, contentId: v7.contentId }) => read.execute({
    toolCallId: randomUUID(), nativeCallId: 'read-v7', callIndex: 0, name: 'read_work', input, executionMode: 'foreground',
  }, { identity, sessionId: randomUUID(), turnId: randomUUID(), stepId: randomUUID(), toolCallId: randomUUID(),
    signal: new AbortController().signal, inputIds: [], originInputId: null, visibleAnswerInputIds: [],
    assertActive: async () => {}, ask: async () => ({ kind: 'closed' }) });
  const result = await run();
  assert.equal(result.kind, 'completed');
  assert.equal(result.outcome, 'success', JSON.stringify(result));
  assert.equal(result.data.file.value, selected);
  assert.equal(result.data.nextOffset, null);
  assert.equal(calls.includes(v7.contentId), true);
  await assert.rejects(run({ objectId: v7.objectId, contentId: v7.contentId, offset: 0 }), { code: 'forbidden' });
  await assert.rejects(run({ objectId: v7.objectId, contentId: randomUUID() }), { code: 'forbidden' });
  revoked = true;
  await assert.rejects(run(), { code: 'forbidden' });
});
