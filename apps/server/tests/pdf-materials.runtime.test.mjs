import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { learningOwner, learningHttp } from './support/learning-owner.mjs';
import { fixedPdf } from './fixtures/pdf-material.mjs';

test('activity PDF removal survives restart and preserves the fixed reading and draft', { timeout: 180000 }, async t => {
  const f = await learningOwner(t);
  const http = () => learningHttp(t, { identity: f.identity, spaces: f.spaces, data: f.data, target: f.target });
  let current = await http();
  const api = (route, body) => current.api(route, body);
  const call = async (route, body) => { const result = await current.raw(route, body); return { status: result.status, value: result.body }; };
  const activity = await api('activities', { requestId: randomUUID(), goal: 'Read a PDF', question: '', references: [] });
  const route = `pdf/${activity.activityId}`;
  const input = { requestId: randomUUID(), documentId: randomUUID(), name: 'lesson.pdf', dataBase64: fixedPdf().toString('base64') };
  const document = await api(route, input);
  assert.equal(document.state, 'ready');
  assert.equal(document.pageCount, 2);
  assert.deepEqual(document.pageLabels, ['Cover', '7']);
  assert.deepEqual(await api(route, input), document, 'lost confirmation reuses the exact upload');
  const previewId = randomUUID();
  const preview = await api(route + '/read', { requestId: previewId, documentId: input.documentId, pages: [2], region: null, preview: true });
  assert.equal(preview.readingId, previewId);
  assert.equal(await api(route + '/reads/' + previewId), null, 'prefetch never creates a fixed reading');
  const reading = await api(route + '/read', { requestId: previewId, documentId: input.documentId, pages: [2], region: null });
  assert.deepEqual(reading.pages, preview.pages, 'an explicit reading can reuse the same rendered pages');
  assert.equal(reading.pages[0].page, 2);
  assert.match(reading.pages[0].text, /Fixed evidence: 37 volts/);
  assert.equal(reading.pages[0].textOrigin, 'native');
  assert.equal(reading.pages[0].image.mediaType, 'image/png');
  assert.ok(Buffer.from(reading.pages[0].image.dataBase64, 'base64').length <= 262144);
  const copy = 'lesson.pdf · PDF 第 2 页（标签 7）\n' + reading.pages[0].text;
  const reference = { referenceId: randomUUID(), source: { kind: 'pdf', activityId: activity.activityId,
    documentId: document.documentId, documentSha256: document.sha256, readingId: reading.readingId },
    range: { kind: 'semantic', formatVersion: 1, typeId: 'pdf-pages', version: 1,
      target: { pages: [2], region: null, coordinates: 'rotated-cropbox-top-left-normalized' }, start: 0, end: copy.length },
    copy, sourceName: 'lesson.pdf' };
  const draft = await api(`drafts/${activity.activityId}`);
  const savedDraft = await api(`drafts/${activity.activityId}`, { requestId: randomUUID(), draftId: draft.draftId,
    baseRevision: 0, question: '请看第 2 页电路', references: [reference], bases: [] });
  assert.equal(savedDraft.references[0].source.readingId, reading.readingId);
  await f.reopen(); current = await http();
  assert.deepEqual(await api(route + '/reads/' + reading.readingId), reading);
  assert.deepEqual(await api(route), [document]);
  assert.deepEqual(await api(`drafts/${activity.activityId}`), savedDraft);
  const other = await api('activities', { requestId: randomUUID(), goal: 'Another activity', question: '', references: [] });
  const removePath = '/documents/' + document.documentId + '/remove';
  const remove = { requestId: randomUUID() };
  assert.equal((await call('pdf/' + other.activityId + removePath, remove)).status, 404);
  const removed = await api(route + removePath, remove);
  assert.ok(removed.removedAt);
  assert.deepEqual(await api(route + removePath, remove), removed);
  assert.deepEqual(await api(route, input), removed, 'replaying the upload cannot restore a removed entry');
  await f.reopen(); current = await http();
  assert.deepEqual(await api(route), []);
  assert.deepEqual(await api(route + '/reads/' + reading.readingId), reading);
  assert.deepEqual(await api(route + '/originals/' + document.documentId), { document: removed, dataBase64: input.dataBase64 });
  assert.deepEqual(await api(`drafts/${activity.activityId}`), savedDraft);
});
