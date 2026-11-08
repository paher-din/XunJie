import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openProductRuntime } from '@xunjie/product-runtime';

import { fixedPdf } from './fixtures/pdf-material.mjs';

test('formal activity material upload retains a real PDF and its actual page order after restart', { timeout: 180000 }, async () => {
  assert.ok(process.env.XUNJIE_PRODUCT_POSTGRES_BIN, 'Requires native PostgreSQL 18.6');
  const root = await mkdtemp(join(tmpdir(), 'xj-wp08-218-'));
  const runtime = openProductRuntime({ root, resources: { nodePath: process.execPath, nodeVersion: '24.21.0',
    postgresBin: process.env.XUNJIE_PRODUCT_POSTGRES_BIN, postgresVersion: '18.6',
    webRoot: fileURLToPath(new URL('../../web/dist-runtime', import.meta.url)),
    windowsPrerequisitePath: fileURLToPath(new URL('../../../scripts/windows-prereq-prepare.ps1', import.meta.url)) } });
  try {
    await runtime.install({ profile: 'local' });
    let endpoint = (await runtime.start()).endpoint;
    const api = async (route, body) => {
      const response = await fetch(new URL('/api/learning/' + route, endpoint), { headers: {
        'content-type': 'application/json', 'x-xj-space': 'personal' },
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
      const value = await response.json();
      assert.equal(response.status, 200, route + ': ' + JSON.stringify(value)); return value;
    };
    const activity = await api('activities', { requestId: randomUUID(), goal: 'Read a PDF', question: '', references: [] });
    const route = `pdf/${activity.activityId}`;
    const input = { requestId: randomUUID(), documentId: randomUUID(), name: 'lesson.pdf', dataBase64: fixedPdf().toString('base64') };
    const document = await api(route, input);
    assert.equal(document.state, 'ready');
    assert.equal(document.pageCount, 2);
    assert.deepEqual(document.pageLabels, ['Cover', '7']);
    assert.deepEqual(await api(route, input), document, 'lost confirmation reuses the exact upload');
    const reading = await api(route + '/read', { requestId: randomUUID(), documentId: input.documentId, pages: [2], region: null });
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
    await runtime.stop(); endpoint = (await runtime.start()).endpoint;
    assert.deepEqual(await api(route + '/reads/' + reading.readingId), reading);
    assert.deepEqual(await api(route), [document]);
    assert.deepEqual(await api(`drafts/${activity.activityId}`), savedDraft);
  } finally { await runtime.stop(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
});
