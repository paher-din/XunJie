import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { materialScopeSchema } from '../dist/session-materials.js';
import { scopedPersonalMaterialSchema, scopedPersonalMaterialReferenceSourceSchema } from '../dist/personal-materials.js';
import { scopedPdfDocumentSchema, scopedPdfReferenceSourceSchema } from '../dist/pdf-materials.js';

test('material scope identifies exactly one real session or workspace', () => {
  const session = { kind: 'session', sessionId: randomUUID() };
  const workspace = { kind: 'workspace', activityId: session.sessionId };
  assert.deepEqual(materialScopeSchema.parse(session), session);
  assert.deepEqual(materialScopeSchema.parse(workspace), workspace);
  assert.equal(materialScopeSchema.safeParse({ ...session, activityId: workspace.activityId }).success, false);
  assert.equal(materialScopeSchema.safeParse({ kind: 'session', activityId: workspace.activityId }).success, false);
});

test('scoped return unions retain workspace wire and reject mixed session/workspace placement', () => {
  const activityId = randomUUID(), materialId = randomUUID(), requestId = randomUUID();
  const scope = { kind: 'session', sessionId: activityId };
  const version = { materialId, requestId, version: 1, name: 'notes.txt', mediaType: 'text/plain',
    sha256: 'a'.repeat(64), byteLength: 4, createdAt: '2026-11-13T00:00:00.000Z' };
  const text = { materialId, activityId, requestId, name: version.name, mediaType: version.mediaType,
    currentVersion: 1, createdAt: version.createdAt, removedAt: null, versions: [version] };
  assert.deepEqual(scopedPersonalMaterialSchema.parse(text), text);
  const { activityId: _, ...sessionText } = text;
  assert.deepEqual(scopedPersonalMaterialSchema.parse({ ...sessionText, scope }), { ...sessionText, scope });
  assert.equal(scopedPersonalMaterialSchema.safeParse({ ...text, scope }).success, false);
  const doc = { documentId: randomUUID(), activityId, requestId, name: 'paper.pdf', sha256: version.sha256,
    byteLength: 100, state: 'ready', pageCount: 1, pageLabels: ['1'] };
  assert.deepEqual(scopedPdfDocumentSchema.parse(doc), doc);
  const { activityId: __, ...sessionDoc } = doc;
  assert.deepEqual(scopedPdfDocumentSchema.parse({ ...sessionDoc, scope }), { ...sessionDoc, scope });
  assert.equal(scopedPdfDocumentSchema.safeParse({ ...doc, scope }).success, false);
  const source = { kind: 'personal-material', scope, materialId, version: 1, sha256: version.sha256 };
  assert.deepEqual(scopedPersonalMaterialReferenceSourceSchema.parse(source), source);
  assert.equal(scopedPersonalMaterialReferenceSourceSchema.safeParse({ ...source, activityId }).success, false);
  const pdfSource = { kind: 'pdf', scope, documentId: doc.documentId, documentSha256: doc.sha256, readingId: randomUUID() };
  assert.deepEqual(scopedPdfReferenceSourceSchema.parse(pdfSource), pdfSource);
  assert.equal(scopedPdfReferenceSourceSchema.safeParse({ ...pdfSource, activityId }).success, false);
});
