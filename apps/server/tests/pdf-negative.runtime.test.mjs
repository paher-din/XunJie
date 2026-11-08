import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDF_LIMITS, pdfReferenceCopy } from '@xunjie/contracts/pdf-materials';
import { pdfRuntime } from './fixtures/pdf-runtime.mjs';
import { fixedPdf } from './fixtures/pdf-material.mjs';
import { damagedPdf, encryptedPdf, fixturePassword, replacementPdf, rotatedCropPdf, rotatedRegion, scannedPdf } from './fixtures/pdf-edge-cases.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const uploadInput = (name, bytes) => ({ requestId: randomUUID(), documentId: randomUUID(), name, dataBase64: bytes.toString('base64') });
function referenceFor(reading) {
  const copy = pdfReferenceCopy(reading);
  return { referenceId: randomUUID(), source: { kind: 'pdf', activityId: reading.activityId,
    documentId: reading.documentId, documentSha256: reading.documentSha256, readingId: reading.readingId },
    range: { kind: 'semantic', formatVersion: 1, typeId: 'pdf-pages', version: 1,
      target: { pages: reading.requestedPages, region: reading.region, coordinates: reading.coordinates }, start: 0, end: copy.length },
    copy, sourceName: reading.documentName };
}
async function pixels(image, points) {
  assert.ok(image, 'A successful page must include its actual PNG');
  const bytes = Buffer.from(image.dataBase64, 'base64');
  assert.equal(sha256(bytes), image.sha256, 'PNG bytes must match the retained image identity');
  assert.ok(bytes.length <= PDF_LIMITS.imageBytes);
  assert.ok(image.width <= PDF_LIMITS.imageDimension && image.height <= PDF_LIMITS.imageDimension);
  const png = await loadImage(bytes), canvas = createCanvas(png.width, png.height), context = canvas.getContext('2d');
  try {
    assert.equal(png.width, image.width); assert.equal(png.height, image.height);
    context.drawImage(png, 0, 0);
    return points.map(([x, y]) => [...context.getImageData(Math.floor(x * png.width), Math.floor(y * png.height), 1, 1).data]);
  } finally { canvas.width = 1; canvas.height = 1; }
}
function rejected(response, status, code) {
  assert.equal(response.status, status, JSON.stringify(response.value));
  assert.deepEqual(response.value, { error: code });
}
async function saveReference(f, activityId, reference) {
  const draft = await f.api(`drafts/${activityId}`);
  return f.api(`drafts/${activityId}`, { requestId: randomUUID(), draftId: draft.draftId,
    baseRevision: draft.revision, question: 'Use this exact retained PDF reading.', references: [reference], bases: [] });
}

test('formal HTTP PDF edge cases preserve originals, fixed evidence and activity isolation', { timeout: 240000 }, async t => {
  const f = await pdfRuntime(() => { throw new Error('PDF HTTP tests must not call a model'); });
  const route = `pdf/${f.activity.activityId}`;
  try {
    await t.test('damaged PDF retains its original but cannot create a reading', async () => {
      const bytes = damagedPdf(), input = uploadInput('damaged.pdf', bytes);
      const document = await f.api(route, input);
      assert.equal(document.state, 'damaged'); assert.equal(document.pageCount, 0);
      assert.deepEqual(document.pageLabels, []); assert.match(document.detail, /damaged/i);
      assert.equal(document.sha256, sha256(bytes)); assert.equal(document.byteLength, bytes.length);
      const original = await f.api(`${route}/originals/${document.documentId}`);
      assert.deepEqual(original.document, document); assert.deepEqual(Buffer.from(original.dataBase64, 'base64'), bytes);
      assert.deepEqual(await f.api(route, input), document, 'replay must not invent another upload or change its terminal state');
      const requestId = randomUUID();
      rejected(await f.request(route + '/read', { requestId, documentId: document.documentId, pages: [1], region: null }), 400, 'invalid');
      assert.equal(await f.api(`${route}/reads/${requestId}`), null, 'rejection must not leave an apparently completed reading');
      t.diagnostic(`state=${document.state}; read=400 invalid; original sha256=${document.sha256}`);
    });

    await t.test('a genuinely password-encrypted PDF is classified as encrypted rather than damaged', async () => {
      const bytes = encryptedPdf();
      // Establish that the fixture is a valid encrypted document, not just an /Encrypt marker.
      const task = getDocument({ data: Uint8Array.from(bytes), password: fixturePassword, verbosity: 0 });
      try {
        const unlocked = await task.promise;
        assert.equal(unlocked.numPages, 1);
        const content = await (await unlocked.getPage(1)).getTextContent();
        assert.equal(content.items.filter(item => 'str' in item).map(item => item.str).join(''), 'Protected fixture content');
      } finally { await task.destroy(); }
      const input = uploadInput('encrypted.pdf', bytes), document = await f.api(route, input);
      assert.equal(document.state, 'encrypted'); assert.equal(document.pageCount, 0);
      assert.match(document.detail, /password/i);
      assert.deepEqual(Buffer.from((await f.api(`${route}/originals/${document.documentId}`)).dataBase64, 'base64'), bytes);
      assert.deepEqual(await f.api(route, input), document);
      rejected(await f.request(route + '/read', { requestId: randomUUID(), documentId: document.documentId, pages: [1], region: null }), 400, 'invalid');
      t.diagnostic('known-password fixture decrypts real text; formal upload=encrypted; read=400 invalid');
    });

    await t.test('rotated CropBox region uses normalized top-left viewport coordinates and retains whole-page native text', async () => {
      const document = await f.api(route, uploadInput('rotated-crop.pdf', rotatedCropPdf()));
      assert.equal(document.state, 'ready'); assert.equal(document.pageCount, 1);
      const full = await f.api(route + '/read', { requestId: randomUUID(), documentId: document.documentId, pages: [1], region: null });
      assert.equal(full.pages[0].state, 'ready');
      assert.deepEqual(full.pages[0].transform.cropBox, [40, 30, 240, 130]);
      assert.equal(full.pages[0].transform.rotation, 90);
      assert.deepEqual([full.pages[0].image.width, full.pages[0].image.height], [1024, 2048]);
      assert.deepEqual(await pixels(full.pages[0].image, [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]),
        [[255, 0, 0, 255], [0, 0, 255, 255], [0, 255, 0, 255], [255, 255, 0, 255]],
        'offset CropBox and rotation must both affect actual image pixels');
      const input = { requestId: randomUUID(), documentId: document.documentId, pages: [1], region: rotatedRegion };
      const cropped = await f.api(route + '/read', input), page = cropped.pages[0];
      assert.equal(cropped.coordinates, 'rotated-cropbox-top-left-normalized');
      assert.deepEqual(cropped.region, rotatedRegion); assert.deepEqual(page.transform.region, rotatedRegion);
      assert.deepEqual(page.transform.cropBox, [40, 30, 240, 130]); assert.equal(page.transform.rotation, 90);
      assert.deepEqual([page.image.width, page.image.height], [1536, 2048]);
      assert.deepEqual(await pixels(page.image, [[0.1, 0.1], [0.5, 0.5], [0.9, 0.9]]), Array.from({ length: 3 }, () => [255, 0, 0, 255]));
      assert.equal(page.text, 'Outside region: 42'); assert.equal(page.text, full.pages[0].text);
      assert.equal(page.textOrigin, 'native'); assert.equal(page.ocr, 'not-performed');
      assert.match(page.detail, /整页原生文字层/); assert.match(page.detail, /未按所选区域过滤/); assert.match(page.detail, /细节可能不足/);
      assert.deepEqual(await f.api(route + '/read', input), cropped, 'replaying the same read must retain exact pixels and identity');
      const saved = await saveReference(f, f.activity.activityId, referenceFor(cropped));
      assert.deepEqual(saved.references[0].range.target.region, rotatedRegion);
      assert.equal(saved.references[0].copy, pdfReferenceCopy(cropped));
      assert.deepEqual(await f.api(`${route}/reads/${cropped.readingId}`), cropped);
      t.diagnostic('rotation=90; CropBox=[40,30,240,130]; full=1024x2048; region=1536x2048; sampled pixels=red; native text remains whole-page');
    });

    await t.test('raster-only scan has visible image pixels but no invented text or OCR', async () => {
      const bytes = scannedPdf();
      assert.match(bytes.toString('latin1'), /\/Subtype \/Image/);
      const document = await f.api(route, uploadInput('scan.pdf', bytes));
      assert.equal(document.state, 'ready'); assert.equal(document.pageCount, 1);
      const reading = await f.api(route + '/read', { requestId: randomUUID(), documentId: document.documentId, pages: [1], region: null });
      const page = reading.pages[0];
      assert.equal(page.state, 'ready'); assert.equal(page.text, ''); assert.equal(page.textOrigin, 'native'); assert.equal(page.ocr, 'not-performed');
      assert.deepEqual(await pixels(page.image, [[2 / 96, 2 / 64], [14 / 96, 14 / 64], [76 / 96, 18 / 64]]),
        [[255, 255, 255, 255], [0, 0, 0, 255], [255, 0, 0, 255]], 'the scan must contain actual fixed raster content, not a blank PDF');
      const reference = referenceFor(reading);
      assert.match(reference.copy, /无原生文字层；未执行 OCR/);
      const saved = await saveReference(f, f.activity.activityId, reference);
      assert.equal(saved.references[0].copy, reference.copy); assert.equal(saved.references[0].source.readingId, reading.readingId);
      assert.deepEqual(await f.api(`${route}/reads/${reading.readingId}`), reading);
      t.diagnostic(`scan=ready; native text length=0; OCR=not-performed; visible white/black/red pixels; image sha256=${page.image.sha256}`);
    });

    await t.test('same-name upload creates a new document without replacing an old draft reference or fixed reading', async () => {
      const before = await saveReference(f, f.activity.activityId, f.reference);
      const input = uploadInput(f.document.name, replacementPdf()), updated = await f.api(route, input);
      assert.equal(updated.name, f.document.name); assert.notEqual(updated.documentId, f.document.documentId);
      assert.notEqual(updated.requestId, f.document.requestId); assert.notEqual(updated.sha256, f.document.sha256);
      const newer = await f.api(route + '/read', { requestId: randomUUID(), documentId: updated.documentId, pages: [1], region: null });
      assert.match(newer.pages[0].text, /Replacement evidence: 91 amps/);
      assert.deepEqual(await f.api(`drafts/${f.activity.activityId}`), before);
      assert.deepEqual(await f.api(`${route}/reads/${f.reading.readingId}`), f.reading);
      assert.deepEqual(Buffer.from((await f.api(`${route}/originals/${f.document.documentId}`)).dataBase64, 'base64'), fixedPdf());
      const sameNamed = (await f.api(route)).filter(item => item.name === f.document.name);
      assert.equal(sameNamed.length, 2); assert.deepEqual(new Set(sameNamed.map(item => item.documentId)), new Set([updated.documentId, f.document.documentId]));
      await f.restart();
      assert.deepEqual(await f.api(`drafts/${f.activity.activityId}`), before);
      assert.deepEqual(await f.api(`${route}/reads/${f.reading.readingId}`), f.reading);
      assert.deepEqual(await f.api(`${route}/reads/${newer.readingId}`), newer);
      t.diagnostic('same name: distinct document/request/digest; original 37 volts and replacement 91 amps both retained after host restart');
    });

    await t.test('one successful page survives an adjacent out-of-range page; an incomplete reference is rejected as invalid', async () => {
      const input = { requestId: randomUUID(), documentId: f.document.documentId, pages: [2, 3], region: null };
      const reading = await f.api(route + '/read', input);
      assert.deepEqual(reading.requestedPages, [2, 3]); assert.deepEqual(reading.pages.map(page => page.state), ['ready', 'out-of-range']);
      const [success, missing] = reading.pages;
      assert.equal(success.page, 2); assert.equal(success.label, '7'); assert.match(success.text, /37 volts/);
      assert.equal(success.image.sha256, f.reading.pages[0].image.sha256);
      assert.equal(missing.page, 3); assert.equal(missing.image, null); assert.equal(missing.text, '');
      assert.deepEqual(missing.transform.cropBox, []); assert.equal(missing.transform.scale, 0); assert.match(missing.detail, /geometry.*unavailable/i);
      assert.throws(() => pdfReferenceCopy(reading), /PDF pages unavailable/);
      assert.deepEqual(await f.api(`${route}/reads/${reading.readingId}`), reading);
      assert.deepEqual(await f.api(route + '/read', input), reading);
      const before = await f.api(`drafts/${f.activity.activityId}`), copy = 'Cannot cite an incomplete two-page reading.';
      const reference = { ...f.reference, referenceId: randomUUID(), source: { ...f.reference.source, readingId: reading.readingId }, copy,
        range: { ...f.reference.range, end: copy.length, target: { ...f.reference.range.target, pages: [2, 3] } } };
      const response = await f.request(`drafts/${f.activity.activityId}`, { requestId: randomUUID(), draftId: before.draftId,
        baseRevision: before.revision, question: 'Partial PDF reference', references: [reference], bases: [] });
      t.diagnostic(`partial states=ready,out-of-range; incomplete reference HTTP=${response.status} ${JSON.stringify(response.value)}`);
      rejected(response, 400, 'invalid');
      assert.deepEqual(await f.api(`drafts/${f.activity.activityId}`), before);
    });

    await t.test('20 MiB plus one byte is rejected before a document or original is retained', async () => {
      const bytes = Buffer.alloc(PDF_LIMITS.inputBytes + 1, 0x20); replacementPdf().copy(bytes);
      const input = uploadInput('too-large.pdf', bytes), before = await f.api(route);
      assert.equal(bytes.length, 20 * 1024 * 1024 + 1);
      // This exact boundary has the same base64 length as 20 MiB: the owner must check decoded bytes.
      assert.equal(input.dataBase64.length, Math.ceil(PDF_LIMITS.inputBytes / 3) * 4);
      rejected(await f.request(route, input), 400, 'invalid');
      assert.deepEqual(await f.api(route), before);
      rejected(await f.request(`${route}/documents/${input.documentId}`), 404, 'missing');
      rejected(await f.request(`${route}/originals/${input.documentId}`), 404, 'missing');
      t.diagnostic('20 MiB+1 decoded bytes (same base64-length bucket as limit): HTTP=400 invalid; no document/original visible');
    });

    await t.test('document, reading, original, upload identity and draft reference cannot cross activities or an expected subject', async () => {
      const activity = await f.api('activities', { requestId: randomUUID(), goal: 'Isolated PDF activity', question: '', references: [] });
      const other = `pdf/${activity.activityId}`, draft = await f.api(`drafts/${activity.activityId}`);
      assert.deepEqual(await f.api(other), []);
      rejected(await f.request(`${other}/documents/${f.document.documentId}`), 404, 'missing');
      rejected(await f.request(`${other}/originals/${f.document.documentId}`), 404, 'missing');
      assert.equal(await f.api(`${other}/reads/${f.reading.readingId}`), null, 'a foreign fixed reading must reveal no page bytes');
      const requestId = randomUUID();
      rejected(await f.request(other + '/read', { requestId, documentId: f.document.documentId, pages: [2], region: null }), 404, 'missing');
      assert.equal(await f.api(`${other}/reads/${requestId}`), null);
      rejected(await f.request(other, { requestId: f.document.requestId, documentId: f.document.documentId,
        name: f.document.name, dataBase64: fixedPdf().toString('base64') }), 409, 'identity-conflict');
      const input = { requestId: randomUUID(), draftId: draft.draftId, baseRevision: draft.revision,
        question: 'Foreign PDF', references: [f.reference], bases: [] };
      rejected(await f.request(`drafts/${activity.activityId}`, input), 400, 'invalid');
      const forged = { ...f.reference, source: { ...f.reference.source, activityId: activity.activityId } };
      rejected(await f.request(`drafts/${activity.activityId}`, { ...input, requestId: randomUUID(), references: [forged] }), 404, 'missing');
      assert.deepEqual(await f.api(`drafts/${activity.activityId}`), draft);
      const subject = [activity.identity.environmentId, activity.identity.spaceId, randomUUID()].join('.');
      rejected(await f.request(`${route}/reads/${f.reading.readingId}`, undefined, { 'x-xj-expected-subject': subject }), 403, 'forbidden');
      assert.deepEqual(await f.api(other), []); assert.deepEqual(await f.api(`${route}/reads/${f.reading.readingId}`), f.reading);
      t.diagnostic('foreign document/original/read=missing; foreign reference=invalid/missing; reused upload identity=409; wrong subject=403; original remains intact');
    });

    assert.equal(f.payloads.length, 0, 'no PDF owner or renderer may be replaced by a model response');
  } finally { await f.close(); }
});
