import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createLearningTools } from '../dist/student-assistant/tools/learning-tools.js';

function makeHost(detail) {
  const identity = { kind: 'personal', name: '学生', environmentId: randomUUID(), spaceId: randomUUID(), principalId: randomUUID() };
  const target = { environmentId: identity.environmentId, serviceId: randomUUID(), version: 1 };
  const reference = { sourceId: 'course-source', identity: { ...identity, name: undefined },
    owner: target, kind: 'course-material', objectId: randomUUID(), version: 'a'.repeat(64), releaseId: randomUUID() };
  delete reference.identity.name;
  const host = {
    localPersonalIdentity: identity, localLearningTarget: target,
    query: { readLearning: async () => detail(reference), listLearningTasks: async () => { throw new Error('unused'); },
      searchLearning: async () => { throw new Error('unused'); } },
    projects: { create: async () => { throw new Error('unused'); }, receipt: async () => null },
    questions: { read: async () => null },
    workspaceSessions: { ensure: async () => { throw new Error('unused'); }, receipt: async () => null },
    materials: { adopt: async () => { throw new Error('unused'); }, receipt: async () => null },
  };
  return { host, identity, reference };
}

function context(identity) {
  return { identity, sessionId: randomUUID(), turnId: randomUUID(), stepId: randomUUID(), toolCallId: randomUUID(),
    signal: new AbortController().signal, inputIds: [], originInputId: null, visibleAnswerInputIds: [],
    assertActive: async () => {}, ask: async () => ({ kind: 'closed' }) };
}

test('read_learning 超长中文结果保留范围、nextOffset 和领域继续读取参数', async () => {
  const text = '中'.repeat(3000);
  const { host, identity, reference } = makeHost(ref => ({ reference: ref, text, missing: [], role: 'source-data',
    range: { offset: 0, length: 3000, total: 6000, nextOffset: 3000 } }));
  const tool = createLearningTools(host).find(item => item.definition.name === 'read_learning');
  assert.ok(tool);
  const result = await tool.execute({ toolCallId: randomUUID(), nativeCallId: 'read-learning', callIndex: 0,
    name: 'read_learning', input: { reference, range: { offset: 0, length: 3000 } }, executionMode: 'foreground' },
  context(identity));
  assert.equal(result.kind, 'completed');
  assert.equal(result.outcome, 'success');
  const summary = JSON.parse(result.summary);
  assert.ok(summary.text.length < 3000, '正文按工具边界缩短');
  assert.equal(summary.range.total, 6000);
  assert.ok(summary.range.nextOffset > 0 && summary.range.nextOffset < 6000);
  assert.equal(summary.readMore.tool, 'read_learning');
  assert.equal(summary.readMore.reference.sourceId, reference.sourceId);
  assert.equal(summary.readMore.range.offset, summary.range.nextOffset);
  assert.equal(summary.readMore.range.length > 0, true);
});

test('read_learning PDF 结果保留页码、固定 reading 身份和下一页继续读取范围', async () => {
  const text = '页'.repeat(3000);
  const { host, identity, reference } = makeHost(ref => ({ reference: ref, text, missing: [], role: 'source-data',
    pdf: { readingId: randomUUID(), documentId: ref.objectId, documentSha256: ref.version, page: 3,
      range: { offset: 0, length: 3000 } },
    range: { offset: 0, length: 3000, total: 6000, nextOffset: 3000 } }));
  const tool = createLearningTools(host).find(item => item.definition.name === 'read_learning');
  const result = await tool.execute({ toolCallId: randomUUID(), nativeCallId: 'read-pdf', callIndex: 0,
    name: 'read_learning', input: { reference, range: { offset: 0, length: 3000 }, page: 3 },
    executionMode: 'foreground' }, context(identity));
  assert.equal(result.kind, 'completed');
  const summary = JSON.parse(result.summary);
  assert.equal(summary.pdf.page, 3);
  assert.equal(summary.pdf.documentId, reference.objectId);
  assert.equal(summary.pdf.documentSha256, reference.version);
  assert.ok(summary.pdf.readingId);
  assert.equal(summary.readMore.page, 3);
  assert.equal(summary.readMore.range.offset, summary.range.nextOffset);
});
