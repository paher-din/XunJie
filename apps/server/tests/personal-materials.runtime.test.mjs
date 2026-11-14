import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { learningOwner, learningHttp } from './support/learning-owner.mjs';

test('personal text materials retain immutable versions and serve fixed question references', { timeout: 180000 }, async t => {
  const f = await learningOwner(t);
  const http = () => learningHttp(t, { identity: f.identity, spaces: f.spaces, data: f.data, target: f.target });
  let current = await http();
  const api = (route, body) => current.api(route, body);
  const call = async (route, body) => { const result = await current.raw(route, body); return { status: result.status, value: result.body }; };
  const activity = await api('activities', { requestId: randomUUID(), goal: '整理我的电路笔记', question: '', references: [] });
  const route = `materials/${activity.activityId}`;
  const materialId = randomUUID();
  const text = '我的电路笔记\n\n我喜欢先把电压写成 37 V，再检查节点。\n第二行：并联电路总电流等于各支路电流之和。';
  const base = { requestId: randomUUID(), materialId, name: '电路笔记.md', mediaType: 'text/markdown',
    dataBase64: Buffer.from(text, 'utf8').toString('base64') };
  const first = await api(route, base);
  assert.equal(first.currentVersion, 1);
  assert.equal(first.versions[0].sha256, (await import('node:crypto')).createHash('sha256').update(text).digest('hex'));
  assert.deepEqual(await api(route, base), first, 'lost confirmation must reuse the exact original identity');
  assert.deepEqual(await api(route), [first]);

  // Same display name is not identity: a second material is a distinct object.
  const secondId = randomUUID();
  const second = await api(route, { requestId: randomUUID(), materialId: secondId, name: '电路笔记.md', mediaType: 'text/plain',
    dataBase64: Buffer.from('另一份同名笔记：串联电路电流处处相等。', 'utf8').toString('base64') });
  assert.equal(second.materialId, secondId);
  assert.equal((await api(route)).length, 2);

  const update = { requestId: randomUUID(), materialId, expectedVersion: 1, name: '电路笔记（修订）.md',
    dataBase64: Buffer.from('我的电路笔记（修订）\n\n请优先用节点电压法，不再先数电流。', 'utf8').toString('base64') };
  const revised = await api(`${route}/${materialId}`, update);
  assert.equal(revised.currentVersion, 2);
  assert.equal(revised.name, '电路笔记（修订）.md');
  assert.equal(revised.versions.length, 2);
  assert.notEqual(revised.versions[0].sha256, revised.versions[1].sha256);
  assert.equal((await call(`${route}/${materialId}`, { ...update, requestId: randomUUID() })).status, 409,
    'a stale expectedVersion cannot overwrite a newer original');

  const read = await api(`${route}/${materialId}/versions/1/read`, { start: 0, length: 20 });
  assert.equal(read.total, text.length);
  assert.equal(read.text, text.slice(0, 20));
  assert.equal(read.readMethod, 'stored-text-range');
  const content = await api(`${route}/${materialId}/versions/1`);
  assert.equal(content.text, text);

  // Question draft references pin the personal material version and exact UTF-16 selection.
  const range = { kind: 'text', start: text.indexOf('37 V'), end: text.indexOf('37 V') + 4 };
  const copy = text.slice(range.start, range.end);
  const draft = await api(`drafts/${activity.activityId}`);
  const reference = { referenceId: randomUUID(), source: { kind: 'personal-material', activityId: activity.activityId,
    materialId, version: 1, sha256: first.versions[0].sha256 }, range, copy, sourceName: '电路笔记.md' };
  const saved = await api(`drafts/${activity.activityId}`, { requestId: randomUUID(), draftId: draft.draftId,
    baseRevision: 0, question: '为什么这里写 37 V？', references: [reference], bases: [] });
  assert.equal(saved.references[0].source.kind, 'personal-material');
  assert.equal(saved.references[0].copy, copy);
  const forged = { ...reference, referenceId: randomUUID(), copy: '伪造文字' };
  assert.equal((await call(`drafts/${activity.activityId}`, { requestId: randomUUID(), draftId: draft.draftId,
    baseRevision: saved.revision, question: '伪造', references: [forged], bases: [] })).status, 400,
    'the server re-reads the fixed original and never trusts browser copy');

  const otherActivity = await api('activities', { requestId: randomUUID(), goal: '另一活动', question: '', references: [] });
  const foreignId = randomUUID(), foreignText = '另一活动中的个人笔记。';
  const foreign = await api(`materials/${otherActivity.activityId}`, { requestId: randomUUID(), materialId: foreignId,
    name: '另一活动.md', mediaType: 'text/plain', dataBase64: Buffer.from(foreignText, 'utf8').toString('base64') });
  const foreignReference = { referenceId: randomUUID(), source: { kind: 'personal-material', activityId: activity.activityId,
    materialId: foreignId, version: 1, sha256: foreign.versions[0].sha256 },
    range: { kind: 'text', start: 0, end: foreignText.length }, copy: foreignText, sourceName: '另一活动.md' };
  assert.equal((await call(`drafts/${activity.activityId}`, { requestId: randomUUID(), draftId: draft.draftId,
    baseRevision: saved.revision, question: '跨活动伪造引用', references: [foreignReference], bases: [] })).status, 400,
    'a personal material from another activity cannot be pinned into this draft');

  const removed = await api(`${route}/${materialId}/remove`, { requestId: randomUUID(), materialId, expectedVersion: 2 });
  assert.ok(removed.removedAt);
  assert.equal((await api(route)).length, 1, 'removed material disappears from the active list');
  assert.equal((await api(`${route}/${materialId}/versions/1`)).text, text, 'fixed references still read after removal');

  await f.reopen(); current = await http();
  assert.equal((await api(route)).length, 1);
});
