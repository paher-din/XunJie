import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { pdfRuntime, modelReply } from './fixtures/pdf-runtime.mjs';

for (const protocol of ['chat-completions', 'responses', 'messages']) test(`${protocol}: PDF fixed reference delivers its real page image and survives a later edit`, { timeout: 180000 }, async () => {
  let referenceId;
  const f = await pdfRuntime((_payload, index, protocol) => modelReply(protocol, index === 1
    ? { id: 'pdf-read-call', name: 'read_reference', arguments: { referenceId } } : null), protocol);
  referenceId = f.reference.referenceId;
  try {
    const runId = await f.send();
    const empty = await f.api(`drafts/${f.activity.activityId}`);
    await f.api(`drafts/${f.activity.activityId}`, { requestId: randomUUID(), draftId: empty.draftId, baseRevision: 0,
      question: '接着讨论其他问题', references: [], bases: [] });
    const conversation = await f.completed(runId);
    assert.equal(f.payloads.length, 2);
    const images = [];
    const visit = value => { if (value && typeof value === 'object') {
      if (['image_url', 'input_image', 'image'].includes(value.type)) images.push(value);
      else for (const child of Object.values(value)) visit(child);
    } };
    visit(f.payloads[1]);
    assert.equal(images.length, 1, 'PDF is not visually read unless the exact page PNG reaches the model');
    const png = Buffer.from(protocol === 'messages' ? images[0].source.data
      : (protocol === 'responses' ? images[0].image_url : images[0].image_url.url).split(',')[1], 'base64');
    assert.equal(createHash('sha256').update(png).digest('hex'), f.reading.pages[0].image.sha256);
    assert.equal(conversation.tools[0].result.reference.source.readingId, f.reading.readingId);
    const action = await f.api(`intents/${f.activity.activityId}/${f.input.requestId}`);
    assert.deepEqual(action.input.draft.references, [f.reference]);
    await f.restart();
    assert.deepEqual((await f.api(`agent/${f.activity.activityId}/conversation`)).tools, conversation.tools);
    assert.deepEqual(await f.api(`pdf/${f.activity.activityId}/reads/${f.reading.readingId}`), f.reading);
    assert.equal(f.payloads.length, 2, 'pure reads after restart do not generate or reconvert');
  } finally { await f.close(); }
});

test('Agent reads adjacent fixed PDF pages through the same Command identity', { timeout: 180000 }, async () => {
  let referenceId;
  const f = await pdfRuntime((_payload, index, protocol) => modelReply(protocol, index === 1
    ? { id: 'pdf-adjacent', name: 'read_pdf', arguments: { referenceId, pages: [1, 2], region: null } } : null));
  referenceId = f.reference.referenceId;
  try {
    const conversation = await f.completed(await f.send());
    const result = conversation.tools[0].result;
    assert.deepEqual(result.visualPages, [1, 2]);
    assert.deepEqual(result.reading.requestedPages, [1, 2]);
    assert.equal(result.source.documentSha256, f.document.sha256);
    const retained = await f.api(`pdf/${f.activity.activityId}/reads/${result.source.readingId}`);
    assert.equal(retained.readingId, conversation.tools[0].commandId);
    await f.restart();
    assert.deepEqual(await f.api(`pdf/${f.activity.activityId}/reads/${result.source.readingId}`), retained);
    assert.equal(f.payloads.length, 2);
  } finally { await f.close(); }
});

test('Agent finds text only within explicitly selected fixed PDF pages', { timeout: 180000 }, async () => {
  let referenceId;
  const f = await pdfRuntime((_payload, index, protocol) => modelReply(protocol, index === 1
    ? { id: 'pdf-find', name: 'find_pdf', arguments: { referenceId, pages: [1, 2], query: '37 volts' } } : null));
  referenceId = f.reference.referenceId;
  try {
    const conversation = await f.completed(await f.send());
    const result = conversation.tools[0].result;
    assert.deepEqual(result.searchedPages, [1, 2]);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].page, 2);
    assert.equal(result.textOrigin, 'native');
    assert.equal(result.ocr, 'not-performed');
    assert.equal(result.imagesSent, false);
    const retained = await f.api(`pdf/${f.activity.activityId}/reads/${result.source.readingId}`);
    const match = result.matches[0];
    assert.equal(retained.pages[1].text.slice(match.start, match.end), '37 volts');
    await f.restart();
    assert.deepEqual(await f.api(`pdf/${f.activity.activityId}/reads/${result.source.readingId}`), retained);
  } finally { await f.close(); }
});
