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

function pageItem(reference, index, excerpt) {
  return { reference: { ...reference, sourceId: reference.sourceId + '-' + index }, title: '结果 ' + index,
    excerpt, provenance: undefined, dueAt: null, missing: [] };
}

async function runPageTool(name, host, identity, input) {
  const tool = createLearningTools(host).find(item => item.definition.name === name);
  assert.ok(tool);
  return tool.execute({ toolCallId: randomUUID(), nativeCallId: name, callIndex: 0, name, input, executionMode: 'foreground' }, context(identity));
}

test('search_learning 和 list_learning_tasks 用 UTF-8 字节分页并保留原查询条件', async () => {
  const { host, identity, reference } = makeHost(() => null);
  const items = Array.from({ length: 3 }, (_, index) => pageItem(reference, index, '中文🙂'.repeat(1800)));
  host.query.listLearningTasks = async () => ({ items, offset: 0, limit: 3, nextOffset: null, unavailable: [] });
  host.query.searchLearning = async () => ({ items, offset: 0, limit: 3, nextOffset: null, unavailable: [] });
  for (const [name, input] of [['list_learning_tasks', { offset: 0, limit: 3 }], ['search_learning', { query: '排序', kinds: ['work'], offset: 0, limit: 3 }]]) {
    const result = await runPageTool(name, host, identity, input);
    assert.equal(result.kind, 'completed');
    assert.ok(Buffer.byteLength(result.summary, 'utf8') <= 8192);
    assert.ok(result.summary.length <= 8192);
    const summary = JSON.parse(result.summary);
    assert.deepEqual(summary.query, input);
    assert.equal(summary.offset, 0);
    assert.ok(summary.items.length < items.length, `${name} must page multiple oversized results`);
    assert.equal(summary.nextOffset, summary.items.length);
    assert.equal(summary.items[0].reference.version, reference.version);
    assert.equal(result.data.items.length, items.length, 'complete page remains in the original tool data');
  }
});

test('单条超长学习结果在分页结束时明确不可完整读取，并不伪造 readMore', async () => {
  const { host, identity, reference } = makeHost(() => null);
  const item = pageItem(reference, 0, '中文内容'.repeat(4000));
  host.query.searchLearning = async () => ({ items: [item], offset: 0, limit: 1, nextOffset: null, unavailable: [] });
  const result = await runPageTool('search_learning', host, identity, { query: '超长', offset: 0, limit: 1 });
  const summary = JSON.parse(result.summary);
  assert.equal(summary.nextOffset, null);
  assert.equal(summary.items[0].reference.version, reference.version);
  assert.equal(summary.items[0].excerptTruncated, true);
  assert.match(summary.items[0].unreadable, /没有提供该条目的安全继续读取参数/);
  assert.equal(summary.readMore, undefined);
  assert.equal(result.data.items[0].excerpt, item.excerpt);
});

test('学习分页摘要恰好达到 8192 UTF-8 字节时仍满足字符和字节合同', async () => {
  const { host, identity, reference } = makeHost(() => null);
  const base = pageItem(reference, 0, '');
  const page = { items: [base], offset: 0, limit: 1, nextOffset: null, unavailable: [] };
  const query = { query: '边界', offset: 0, limit: 1 };
  const baseBytes = Buffer.byteLength(JSON.stringify({ ...page, query, items: [base], nextOffset: null }), 'utf8');
  base.excerpt = 'x'.repeat(8192 - baseBytes);
  host.query.searchLearning = async () => page;
  const result = await runPageTool('search_learning', host, identity, query);
  assert.equal(Buffer.byteLength(result.summary, 'utf8'), 8192);
  assert.ok(result.summary.length <= 8192);
});

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

test('read_learning 按合法 Unicode 边界分页，范围使用 UTF-16 单元且尾端不丢字符', async () => {
  const { host, identity, reference } = makeHost(() => null);
  const full = 'A😀中🙂Z'.repeat(2200);
  host.query.readLearning = async input => {
    const offset = input.range.offset;
    const end = Math.min(full.length, offset + input.range.length);
    const text = full.slice(offset, end);
    return { reference, text, missing: [], role: 'source-data', range: { offset, length: text.length, total: full.length,
      nextOffset: end < full.length ? end : null } };
  };
  let offset = 0;
  let reconstructed = '';
  for (let page = 0; page < 20; page++) {
    const result = await runPageTool('read_learning', host, identity,
      { reference, range: { offset, length: 3000 } });
    const summary = JSON.parse(result.summary);
    assert.equal(summary.range.length, summary.text.length);
    assert.equal(summary.range.offset, offset);
    for (let index = 0; index < summary.text.length; index++) {
      const code = summary.text.charCodeAt(index);
      if (code >= 0xD800 && code <= 0xDBFF) assert.ok(index + 1 < summary.text.length && summary.text.charCodeAt(index + 1) >= 0xDC00);
      if (code >= 0xDC00 && (index === 0 || summary.text.charCodeAt(index - 1) < 0xD800 || summary.text.charCodeAt(index - 1) > 0xDBFF))
        assert.fail('summary contains an unpaired low surrogate');
    }
    reconstructed += summary.text;
    if (summary.range.nextOffset === null) break;
    assert.equal(summary.readMore.range.offset, summary.range.nextOffset);
    offset = summary.range.nextOffset;
  }
  assert.equal(reconstructed, full);
});
